"""Project files: a shared folder tree per project for documents that don't belong to one ticket
(specs, designs, contracts, exports...), plus a read-only view of every ticket attachment.

* Project members browse, upload, download and create folders.
* The uploader (or folder creator) can rename / move / delete their own items; project owners and
  admins can do it for anything. Deleting a folder deletes everything inside it.
* A project file can be copied onto a ticket as an attachment (`/tickets/{id}/attachments/from-files`).
"""
import mimetypes
import shutil
import uuid
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import func, or_, select

from ..config import settings
from ..deps import CurrentUser, DbSession
from ..models import Attachment, ProjectFile, ProjectFolder, Ticket, User
from ..permissions import get_ticket_for_user, is_project_owner, require_member
from ..schemas import (
    AttachFromFiles,
    AttachmentOut,
    FolderCreate,
    FolderCrumb,
    FolderListing,
    FolderOut,
    FolderUpdate,
    ProjectBrief,
    ProjectFileOut,
    ProjectFileUpdate,
    TicketAttachmentOut,
)
from ..services import log_activity, project_files_dir, remove_file, ticket_upload_dir
from ..utils import escape_like, safe_filename
from .attachments import _save_upload

router = APIRouter(tags=["Files"])


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def _folder(db, user: User, folder_id: int) -> ProjectFolder:
    folder = db.get(ProjectFolder, folder_id)
    if folder is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Folder not found")
    require_member(db, user, folder.project_id)
    return folder


def _file(db, user: User, file_id: int) -> ProjectFile:
    f = db.get(ProjectFile, file_id)
    if f is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found")
    require_member(db, user, f.project_id)
    return f


def _parent_in_project(db, project_id: int, folder_id: int | None) -> ProjectFolder | None:
    if folder_id is None:
        return None
    folder = db.get(ProjectFolder, folder_id)
    if folder is None or folder.project_id != project_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Folder not found")
    return folder


def _path(db, folder: ProjectFolder | None) -> list[FolderCrumb]:
    out = []
    while folder is not None:
        out.append(FolderCrumb(id=folder.id, name=folder.name))
        folder = db.get(ProjectFolder, folder.parent_id) if folder.parent_id else None
    return out[::-1]


def _check_name(db, project_id: int, parent_id: int | None, name: str, exclude: int | None = None) -> None:
    stmt = select(ProjectFolder.id).where(
        ProjectFolder.project_id == project_id,
        ProjectFolder.parent_id.is_(None) if parent_id is None else ProjectFolder.parent_id == parent_id,
        func.lower(ProjectFolder.name) == name.lower(),
    )
    if exclude is not None:
        stmt = stmt.where(ProjectFolder.id != exclude)
    if db.scalar(stmt):
        raise HTTPException(status.HTTP_409_CONFLICT, f"There is already a folder named '{name}' here")


def _subtree(db, folder: ProjectFolder) -> list[int]:
    """Ids of this folder and every folder below it."""
    ids, frontier = [folder.id], [folder.id]
    while frontier:
        frontier = list(db.scalars(select(ProjectFolder.id).where(ProjectFolder.parent_id.in_(frontier))))
        ids += frontier
    return ids


def _folder_out(db, user: User, folder: ProjectFolder, owner: bool) -> FolderOut:
    out = FolderOut.model_validate(folder)
    out.folder_count = db.scalar(select(func.count()).where(ProjectFolder.parent_id == folder.id)) or 0
    out.file_count = db.scalar(select(func.count()).where(ProjectFile.folder_id == folder.id)) or 0
    out.can_edit = owner or folder.created_by == user.id
    return out


def _file_out(user: User, f: ProjectFile, owner: bool, path: list[FolderCrumb] | None = None) -> ProjectFileOut:
    out = ProjectFileOut.model_validate(f)
    out.can_edit = owner or f.uploaded_by == user.id
    out.path = path or []
    return out


def _clean_name(name: str) -> str:
    name = " ".join(name.replace("/", " ").replace("\\", " ").split())
    if not name:
        raise HTTPException(422, "The name cannot be blank")
    return name


def _project_tickets(project_id: int):
    return select(Ticket.id).where(Ticket.project_id == project_id)


# --------------------------------------------------------------------------- #
# browse
# --------------------------------------------------------------------------- #
@router.get("/projects/{project_id}/files", response_model=FolderListing, summary="One folder (or the top level), or a search")
def list_files(
    project_id: int,
    user: CurrentUser,
    db: DbSession,
    folder_id: int | None = None,
    q: Annotated[str | None, Query(max_length=100, description="Search names in the whole project")] = None,
):
    project = require_member(db, user, project_id)
    owner = is_project_owner(db, user, project_id)
    listing = FolderListing(project=ProjectBrief.model_validate(project), can_manage=owner)

    if q and q.strip():
        like = f"%{escape_like(q.strip())}%"
        folders = db.scalars(select(ProjectFolder).where(
            ProjectFolder.project_id == project_id, ProjectFolder.name.ilike(like, escape="\\")
        ).order_by(func.lower(ProjectFolder.name))).unique().all()
        found = db.scalars(select(ProjectFile).where(
            ProjectFile.project_id == project_id, ProjectFile.filename.ilike(like, escape="\\")
        ).order_by(ProjectFile.updated_at.desc()).limit(200)).unique().all()
        listing.folders = [_folder_out(db, user, f, owner) for f in folders]
        paths: dict[int | None, list[FolderCrumb]] = {}
        for f in found:
            if f.folder_id not in paths:
                paths[f.folder_id] = _path(db, db.get(ProjectFolder, f.folder_id)) if f.folder_id else []
            listing.files.append(_file_out(user, f, owner, paths[f.folder_id]))
        return listing

    folder = _parent_in_project(db, project_id, folder_id)
    if folder is not None:
        listing.folder = _folder_out(db, user, folder, owner)
        listing.path = _path(db, folder)
    parent_match = ProjectFolder.parent_id.is_(None) if folder is None else ProjectFolder.parent_id == folder.id
    file_match = ProjectFile.folder_id.is_(None) if folder is None else ProjectFile.folder_id == folder.id
    listing.folders = [_folder_out(db, user, f, owner) for f in db.scalars(
        select(ProjectFolder).where(ProjectFolder.project_id == project_id, parent_match).order_by(func.lower(ProjectFolder.name))
    ).unique()]
    listing.files = [_file_out(user, f, owner) for f in db.scalars(
        select(ProjectFile).where(ProjectFile.project_id == project_id, file_match).order_by(func.lower(ProjectFile.filename))
    ).unique()]
    if folder is None:
        listing.ticket_attachment_count = db.scalar(
            select(func.count()).select_from(Attachment).where(Attachment.ticket_id.in_(_project_tickets(project_id)))
        ) or 0
    return listing


@router.get("/projects/{project_id}/folders", response_model=list[FolderOut], summary="Every folder (for move pickers)")
def all_folders(project_id: int, user: CurrentUser, db: DbSession):
    require_member(db, user, project_id)
    owner = is_project_owner(db, user, project_id)
    return [_folder_out(db, user, f, owner) for f in db.scalars(
        select(ProjectFolder).where(ProjectFolder.project_id == project_id).order_by(func.lower(ProjectFolder.name))
    ).unique()]


@router.get("/projects/{project_id}/ticket-attachments", response_model=list[TicketAttachmentOut],
            summary="Every file attached to the project's tickets")
def ticket_attachments(
    project_id: int,
    user: CurrentUser,
    db: DbSession,
    q: Annotated[str | None, Query(max_length=100)] = None,
):
    require_member(db, user, project_id)
    stmt = (
        select(Attachment, Ticket).join(Ticket, Ticket.id == Attachment.ticket_id)
        .where(Ticket.project_id == project_id).order_by(Attachment.created_at.desc()).limit(500)
    )
    if q and q.strip():
        like = f"%{escape_like(q.strip())}%"
        stmt = stmt.where(or_(Attachment.filename.ilike(like, escape="\\"), Ticket.title.ilike(like, escape="\\")))
    out = []
    for a, t in db.execute(stmt).unique():
        item = TicketAttachmentOut.model_validate({**AttachmentOut.model_validate(a).model_dump(), "ticket_key": t.key, "ticket_title": t.title})
        out.append(item)
    return out


# --------------------------------------------------------------------------- #
# folders
# --------------------------------------------------------------------------- #
@router.post("/projects/{project_id}/folders", response_model=FolderOut, status_code=status.HTTP_201_CREATED)
def create_folder(project_id: int, payload: FolderCreate, user: CurrentUser, db: DbSession):
    require_member(db, user, project_id)
    _parent_in_project(db, project_id, payload.parent_id)
    name = _clean_name(payload.name)
    _check_name(db, project_id, payload.parent_id, name)
    folder = ProjectFolder(project_id=project_id, parent_id=payload.parent_id, name=name, created_by=user.id)
    db.add(folder)
    db.commit()
    db.refresh(folder)
    return _folder_out(db, user, folder, is_project_owner(db, user, project_id))


@router.patch("/folders/{folder_id}", response_model=FolderOut, summary="Rename or move a folder")
def update_folder(folder_id: int, payload: FolderUpdate, user: CurrentUser, db: DbSession):
    folder = _folder(db, user, folder_id)
    owner = is_project_owner(db, user, folder.project_id)
    if not (owner or folder.created_by == user.id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the person who made this folder or a project owner can change it")
    data = payload.model_dump(exclude_unset=True)
    parent_id = data.get("parent_id", folder.parent_id)
    if "parent_id" in data:
        _parent_in_project(db, folder.project_id, parent_id)
        if parent_id is not None and parent_id in _subtree(db, folder):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "A folder can't be moved into itself")
    name = _clean_name(data["name"]) if data.get("name") else folder.name
    _check_name(db, folder.project_id, parent_id, name, exclude=folder.id)
    folder.name, folder.parent_id = name, parent_id
    db.commit()
    db.refresh(folder)
    return _folder_out(db, user, folder, owner)


@router.delete("/folders/{folder_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Delete a folder and everything in it")
def delete_folder(folder_id: int, user: CurrentUser, db: DbSession):
    folder = _folder(db, user, folder_id)
    owner = is_project_owner(db, user, folder.project_id)
    ids = _subtree(db, folder)
    files = db.scalars(select(ProjectFile).where(ProjectFile.folder_id.in_(ids))).unique().all()
    if not owner:
        if folder.created_by != user.id:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the person who made this folder or a project owner can delete it")
        if any(f.uploaded_by != user.id for f in files) or len(ids) > 1 and db.scalar(
            select(func.count()).where(ProjectFolder.id.in_(ids[1:]), ProjectFolder.created_by != user.id)
        ):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "This folder holds other people's files - ask a project owner to delete it")
    paths = [project_files_dir(folder.project_id) / f.stored_name for f in files]
    for f in files:
        db.delete(f)
    db.flush()
    for fid in reversed(ids):  # children first
        db.delete(db.get(ProjectFolder, fid))
    db.commit()
    for p in paths:
        remove_file(p)


# --------------------------------------------------------------------------- #
# files
# --------------------------------------------------------------------------- #
@router.post("/projects/{project_id}/files", response_model=list[ProjectFileOut], status_code=status.HTTP_201_CREATED,
             summary="Upload one or more files (into a folder, or the top level)")
def upload_files(
    project_id: int,
    user: CurrentUser,
    db: DbSession,
    files: Annotated[list[UploadFile], File(description="One or more files")],
    folder_id: Annotated[int | None, Form()] = None,
):
    require_member(db, user, project_id)
    _parent_in_project(db, project_id, folder_id)
    if len(files) > settings.MAX_FILES_PER_REQUEST:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"At most {settings.MAX_FILES_PER_REQUEST} files per request")
    prepared = []
    for upload in files:
        name = safe_filename(upload.filename)
        ext = Path(name).suffix.lower()
        if ext in settings.blocked_extensions:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Files of type '{ext}' are not allowed")
        prepared.append((upload, name, ext))

    directory = project_files_dir(project_id)
    directory.mkdir(parents=True, exist_ok=True)
    saved: list[Path] = []
    created: list[ProjectFile] = []
    try:
        for upload, name, ext in prepared:
            stored = f"{uuid.uuid4().hex}{ext}"
            path = directory / stored
            size = _save_upload(upload, path)
            saved.append(path)
            f = ProjectFile(
                project_id=project_id, folder_id=folder_id, filename=name, stored_name=stored, size=size,
                content_type=(upload.content_type or mimetypes.guess_type(name)[0] or "application/octet-stream")[:120],
                uploaded_by=user.id,
            )
            db.add(f)
            created.append(f)
        db.commit()
    except BaseException:
        db.rollback()
        for p in saved:
            remove_file(p)
        raise
    owner = is_project_owner(db, user, project_id)
    for f in created:
        db.refresh(f)
    return [_file_out(user, f, owner) for f in created]


@router.get("/files/{file_id}/download", response_class=FileResponse)
def download_file(file_id: int, user: CurrentUser, db: DbSession):
    f = _file(db, user, file_id)
    path = project_files_dir(f.project_id) / f.stored_name
    if not path.is_file():
        raise HTTPException(status.HTTP_410_GONE, "The file is no longer available on the server")
    return FileResponse(path, media_type=f.content_type, filename=f.filename, content_disposition_type="attachment",
                        headers={"X-Content-Type-Options": "nosniff"})


@router.patch("/files/{file_id}", response_model=ProjectFileOut, summary="Rename or move a file")
def update_file(file_id: int, payload: ProjectFileUpdate, user: CurrentUser, db: DbSession):
    f = _file(db, user, file_id)
    owner = is_project_owner(db, user, f.project_id)
    if not (owner or f.uploaded_by == user.id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the uploader or a project owner can change this file")
    data = payload.model_dump(exclude_unset=True)
    if data.get("filename"):
        name = safe_filename(_clean_name(data["filename"]))
        if Path(name).suffix.lower() in settings.blocked_extensions:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Files of type '{Path(name).suffix}' are not allowed")
        f.filename = name
    if "folder_id" in data:
        _parent_in_project(db, f.project_id, data["folder_id"])
        f.folder_id = data["folder_id"]
    db.commit()
    db.refresh(f)
    return _file_out(user, f, owner)


@router.delete("/files/{file_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_file(file_id: int, user: CurrentUser, db: DbSession):
    f = _file(db, user, file_id)
    if not (is_project_owner(db, user, f.project_id) or f.uploaded_by == user.id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the uploader or a project owner can delete this file")
    path = project_files_dir(f.project_id) / f.stored_name
    db.delete(f)
    db.commit()
    remove_file(path)


@router.post("/tickets/{ticket_id}/attachments/from-files", response_model=list[AttachmentOut],
             status_code=status.HTTP_201_CREATED, summary="Attach copies of project files to a ticket")
def attach_from_files(ticket_id: int, payload: AttachFromFiles, user: CurrentUser, db: DbSession):
    ticket = get_ticket_for_user(db, ticket_id, user)
    picked = db.scalars(select(ProjectFile).where(ProjectFile.id.in_(payload.file_ids))).unique().all()
    if len(picked) != len(set(payload.file_ids)) or any(f.project_id != ticket.project_id for f in picked):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found in this ticket's project")
    directory = ticket_upload_dir(ticket.id)
    directory.mkdir(parents=True, exist_ok=True)
    copied: list[Path] = []
    created: list[Attachment] = []
    try:
        for f in picked:
            src = project_files_dir(f.project_id) / f.stored_name
            if not src.is_file():
                raise HTTPException(status.HTTP_410_GONE, f"'{f.filename}' is no longer available on the server")
            stored = f"{uuid.uuid4().hex}{Path(f.stored_name).suffix}"
            shutil.copyfile(src, directory / stored)
            copied.append(directory / stored)
            a = Attachment(ticket_id=ticket.id, uploaded_by=user.id, filename=f.filename, stored_name=stored,
                           content_type=f.content_type, size=f.size)
            db.add(a)
            created.append(a)
            log_activity(db, ticket, user, "attachment_added", "attachment", None, f.filename)
        db.commit()
    except BaseException:
        db.rollback()
        for p in copied:
            remove_file(p)
        raise
    for a in created:
        db.refresh(a)
    return created
