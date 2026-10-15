"""Upcoming tasks: per-project planning items (requirements, acceptance criteria, references, documents).

They are deliberately *not* tickets: no assignee, no status workflow, nothing in the efficiency
report. Admins create and edit them; project members can read them. When one is ready, an admin or a
project owner converts it into a normal ticket, which carries the requirements over and links back.
"""
import mimetypes
import re
import shutil
import uuid
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, File, HTTPException, Query, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import select

from ..config import settings
from ..deps import AdminUser, CurrentUser, DbSession
from ..models import (
    Attachment,
    NotificationType,
    Project,
    ProjectMember,
    Ticket,
    UpcomingDocument,
    UpcomingStatus,
    UpcomingTask,
)
from ..permissions import is_admin, is_project_owner, project_owner_ids, require_member
from ..schemas import (
    ConvertIn,
    TicketCreate,
    TicketDetail,
    TicketRef,
    UpcomingCreate,
    UpcomingDocumentOut,
    UpcomingOut,
    UpcomingUpdate,
)
from ..services import log_activity, notify, remove_file, ticket_upload_dir
from ..utils import ensure_utc, safe_filename
from .attachments import _save_upload
from .tickets import _detail, create_ticket

router = APIRouter(tags=["Upcoming tasks"])

_CHECKBOX = re.compile(r"^\s*[-*+]\s+\[( |x|X)\]", re.M)


def upcoming_dir(task_id: int) -> Path:
    return Path(settings.UPLOAD_DIR) / "upcoming" / str(task_id)


def _url(task: UpcomingTask) -> str:
    return f"{settings.APP_BASE_URL.rstrip('/')}/#/upcoming/{task.id}"


def _out(db, user, task: UpcomingTask) -> UpcomingOut:
    item = UpcomingOut.model_validate(task)
    boxes = _CHECKBOX.findall(task.acceptance_criteria or "")
    item.criteria_total = len(boxes)
    item.criteria_done = sum(1 for b in boxes if b.lower() == "x")
    item.ticket = TicketRef(id=task.ticket.id, key=task.ticket.key, status=task.ticket.status) if task.ticket else None
    item.can_edit = is_admin(user)
    item.can_convert = task.ticket_id is None and task.status != UpcomingStatus.DROPPED and (
        is_admin(user) or is_project_owner(db, user, task.project_id)
    )
    return item


def _get(db, user, task_id: int) -> UpcomingTask:
    task = db.get(UpcomingTask, task_id)
    if task is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Upcoming task not found")
    require_member(db, user, task.project_id)  # 404 for non-members, like tickets
    return task


# --------------------------------------------------------------------------- #
# Read (any project member)
# --------------------------------------------------------------------------- #
@router.get("/upcoming", response_model=list[UpcomingOut], summary="Upcoming tasks across my projects")
def list_upcoming(
    user: CurrentUser,
    db: DbSession,
    project_id: int | None = None,
    status_: Annotated[list[UpcomingStatus] | None, Query(alias="status")] = None,
    q: str | None = Query(None, max_length=100),
):
    stmt = select(UpcomingTask).join(Project, Project.id == UpcomingTask.project_id).where(Project.is_active.is_(True))
    if not is_admin(user):
        stmt = stmt.where(
            UpcomingTask.project_id.in_(select(ProjectMember.project_id).where(ProjectMember.user_id == user.id))
        )
    if project_id is not None:
        stmt = stmt.where(UpcomingTask.project_id == project_id)
    if status_:
        stmt = stmt.where(UpcomingTask.status.in_(status_))
    if q:
        stmt = stmt.where(UpcomingTask.title.ilike(f"%{q.strip()}%"))
    # Soonest target first; undated after; then newest.
    stmt = stmt.order_by(Project.name, UpcomingTask.target_date.is_(None), UpcomingTask.target_date, UpcomingTask.id.desc())
    return [_out(db, user, t) for t in db.scalars(stmt).unique()]


@router.get("/projects/{project_id}/upcoming", response_model=list[UpcomingOut], summary="One project's upcoming tasks")
def list_project_upcoming(project_id: int, user: CurrentUser, db: DbSession):
    require_member(db, user, project_id)
    stmt = (
        select(UpcomingTask)
        .where(UpcomingTask.project_id == project_id)
        .order_by(UpcomingTask.target_date.is_(None), UpcomingTask.target_date, UpcomingTask.id.desc())
    )
    return [_out(db, user, t) for t in db.scalars(stmt).unique()]


@router.get("/upcoming/{task_id}", response_model=UpcomingOut)
def get_upcoming(task_id: int, user: CurrentUser, db: DbSession):
    return _out(db, user, _get(db, user, task_id))


# --------------------------------------------------------------------------- #
# Write (admin)
# --------------------------------------------------------------------------- #
@router.post("/projects/{project_id}/upcoming", response_model=UpcomingOut, status_code=status.HTTP_201_CREATED)
def create_upcoming(project_id: int, payload: UpcomingCreate, admin: AdminUser, db: DbSession):
    project = require_member(db, admin, project_id)
    if payload.status == UpcomingStatus.CONVERTED:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Use 'Convert to ticket' to mark a task converted")
    task = UpcomingTask(
        project_id=project.id,
        title=payload.title,
        status=payload.status,
        priority=payload.priority,
        target_date=ensure_utc(payload.target_date),
        requirements=payload.requirements,
        acceptance_criteria=payload.acceptance_criteria,
        reference_links=[r.model_dump() for r in payload.reference_links],
        created_by=admin.id,
    )
    db.add(task)
    db.flush()
    notify(
        db, project_owner_ids(db, project.id), actor=admin, type=NotificationType.UPCOMING,
        message=f"{admin.name} added an upcoming task to {project.key}: {task.title}",
        link=(_url(task), "Open"),
    )
    db.commit()
    db.refresh(task)
    return _out(db, admin, task)


@router.patch("/upcoming/{task_id}", response_model=UpcomingOut)
def update_upcoming(task_id: int, payload: UpcomingUpdate, admin: AdminUser, db: DbSession):
    task = _get(db, admin, task_id)
    data = payload.model_dump(exclude_unset=True)
    for required in ("title", "status", "priority"):
        if required in data and data[required] is None:
            raise HTTPException(422, f"{required} cannot be null")
    if data.get("status") == UpcomingStatus.CONVERTED and task.ticket_id is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Use 'Convert to ticket' to mark a task converted")
    if "title" in data:
        data["title"] = data["title"].strip()
    if "target_date" in data:
        data["target_date"] = ensure_utc(data["target_date"])
    if "reference_links" in data:
        data["reference_links"] = [r.model_dump() for r in payload.reference_links or []]
    for key in ("requirements", "acceptance_criteria"):
        if key in data and data[key] is None:
            data[key] = ""

    became_ready = data.get("status") == UpcomingStatus.READY and task.status != UpcomingStatus.READY
    for field, value in data.items():
        setattr(task, field, value)
    if became_ready:
        notify(
            db, project_owner_ids(db, task.project_id), actor=admin, type=NotificationType.UPCOMING,
            message=f"{admin.name} marked an upcoming task in {task.project.key} ready: {task.title}",
            link=(_url(task), "Open"),
        )
    db.commit()
    db.refresh(task)
    return _out(db, admin, task)


@router.delete("/upcoming/{task_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_upcoming(task_id: int, admin: AdminUser, db: DbSession):
    task = _get(db, admin, task_id)
    db.delete(task)
    db.commit()
    shutil.rmtree(upcoming_dir(task_id), ignore_errors=True)


# --------------------------------------------------------------------------- #
# Documents
# --------------------------------------------------------------------------- #
@router.post(
    "/upcoming/{task_id}/documents", response_model=list[UpcomingDocumentOut], status_code=status.HTTP_201_CREATED
)
def upload_documents(
    task_id: int,
    admin: AdminUser,
    db: DbSession,
    files: Annotated[list[UploadFile], File(description="One or more files")],
):
    task = _get(db, admin, task_id)
    if len(files) > settings.MAX_FILES_PER_REQUEST:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"At most {settings.MAX_FILES_PER_REQUEST} files per request")
    prepared = []
    for upload in files:
        name = safe_filename(upload.filename)
        ext = Path(name).suffix.lower()
        if ext in settings.blocked_extensions:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Files of type '{ext}' are not allowed")
        prepared.append((upload, name, ext))

    directory = upcoming_dir(task.id)
    directory.mkdir(parents=True, exist_ok=True)
    saved: list[Path] = []
    created: list[UpcomingDocument] = []
    try:
        for upload, name, ext in prepared:
            stored_name = f"{uuid.uuid4().hex}{ext}"
            path = directory / stored_name
            size = _save_upload(upload, path)
            saved.append(path)
            doc = UpcomingDocument(
                task_id=task.id, uploaded_by=admin.id, filename=name, stored_name=stored_name,
                content_type=(upload.content_type or mimetypes.guess_type(name)[0] or "application/octet-stream")[:120],
                size=size,
            )
            db.add(doc)
            created.append(doc)
        db.commit()
    except BaseException:
        db.rollback()
        for path in saved:
            remove_file(path)
        raise
    for d in created:
        db.refresh(d)
    return created


def _get_document(db, user, document_id: int) -> UpcomingDocument:
    doc = db.get(UpcomingDocument, document_id)
    if doc is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Document not found")
    _get(db, user, doc.task_id)
    return doc


@router.get("/upcoming-documents/{document_id}/download", response_class=FileResponse)
def download_document(document_id: int, user: CurrentUser, db: DbSession):
    doc = _get_document(db, user, document_id)
    path = upcoming_dir(doc.task_id) / doc.stored_name
    if not path.is_file():
        raise HTTPException(status.HTTP_410_GONE, "The file is no longer available on the server")
    return FileResponse(
        path, media_type=doc.content_type, filename=doc.filename, content_disposition_type="attachment",
        headers={"X-Content-Type-Options": "nosniff"},
    )


@router.delete("/upcoming-documents/{document_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_document(document_id: int, admin: AdminUser, db: DbSession):
    doc = _get_document(db, admin, document_id)
    path = upcoming_dir(doc.task_id) / doc.stored_name
    db.delete(doc)
    db.commit()
    remove_file(path)


# --------------------------------------------------------------------------- #
# Convert to a ticket (admin or project owner)
# --------------------------------------------------------------------------- #
def _ticket_description(task: UpcomingTask) -> str:
    parts = []
    if task.requirements.strip():
        parts.append(f"## Requirements\n\n{task.requirements.strip()}")
    if task.acceptance_criteria.strip():
        parts.append(f"## Acceptance criteria\n\n{task.acceptance_criteria.strip()}")
    if task.reference_links:
        links = "\n".join(f"- [{r.get('title') or r['url']}]({r['url']})" for r in task.reference_links)
        parts.append(f"## References\n\n{links}")
    parts.append(f"_Planned as upcoming task: [{task.title}]({_url(task)})_")
    return "\n\n".join(parts)[:20000]


@router.post("/upcoming/{task_id}/convert", response_model=TicketDetail, summary="Create a ticket from an upcoming task")
def convert_upcoming(task_id: int, payload: ConvertIn, user: CurrentUser, db: DbSession):
    task = _get(db, user, task_id)
    if not (is_admin(user) or is_project_owner(db, user, task.project_id)):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only an admin or a project owner can convert this task")
    if task.ticket_id is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, f"Already converted to {task.ticket.key}")
    if task.status == UpcomingStatus.DROPPED:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "This task was dropped; restore it before converting")

    # Reuses the normal ticket endpoint so permissions, numbering and notifications stay identical.
    ticket_out = create_ticket(
        task.project_id,
        TicketCreate(
            title=task.title[:255],
            description=_ticket_description(task),
            priority=task.priority,
            type=payload.type,
            assignee_id=payload.assignee_id,
            due_date=payload.due_date or task.target_date,
            estimated_hours=payload.estimated_hours,
        ),
        user,
        db,
    )
    ticket = db.get(Ticket, ticket_out.id)

    copied: list[Path] = []
    if payload.copy_documents and task.documents:
        target = ticket_upload_dir(ticket.id)
        target.mkdir(parents=True, exist_ok=True)
        for doc in task.documents:
            src = upcoming_dir(task.id) / doc.stored_name
            if not src.is_file():
                continue
            stored_name = f"{uuid.uuid4().hex}{Path(doc.stored_name).suffix}"
            shutil.copyfile(src, target / stored_name)
            copied.append(target / stored_name)
            db.add(Attachment(
                ticket_id=ticket.id, uploaded_by=user.id, filename=doc.filename, stored_name=stored_name,
                content_type=doc.content_type, size=doc.size,
            ))
            log_activity(db, ticket, user, "attachment_added", "attachment", None, doc.filename)

    task.ticket_id = ticket.id
    task.status = UpcomingStatus.CONVERTED
    log_activity(db, ticket, user, "converted", "upcoming_task", None, task.title)
    try:
        db.commit()
    except BaseException:
        db.rollback()
        for path in copied:
            remove_file(path)
        raise
    db.refresh(ticket)
    return _detail(db, user, ticket)

