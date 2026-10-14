import mimetypes
import uuid
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, File, Form, HTTPException, UploadFile, status
from fastapi.responses import FileResponse

from ..config import settings
from ..deps import CurrentUser, DbSession
from ..models import Attachment, Comment
from ..permissions import get_ticket_for_user, is_project_owner
from ..schemas import AttachmentOut
from ..services import log_activity, remove_file, ticket_upload_dir
from ..utils import safe_filename

router = APIRouter(tags=["Attachments"])

_CHUNK = 1024 * 1024


def _save_upload(upload: UploadFile, dest: Path) -> int:
    """Stream to disk, enforcing the size limit while reading. Returns the number of bytes written."""
    size = 0
    try:
        with dest.open("wb") as out:
            while chunk := upload.file.read(_CHUNK):
                size += len(chunk)
                if size > settings.max_upload_bytes:
                    raise HTTPException(
                        status.HTTP_413_CONTENT_TOO_LARGE
                        if hasattr(status, "HTTP_413_CONTENT_TOO_LARGE")
                        else 413,
                        f"'{upload.filename}' is larger than {settings.MAX_UPLOAD_MB} MB",
                    )
                out.write(chunk)
    except BaseException:
        remove_file(dest)
        raise
    return size


@router.post(
    "/tickets/{ticket_id}/attachments",
    response_model=list[AttachmentOut],
    status_code=status.HTTP_201_CREATED,
    summary="Upload one or more files (optionally attached to one of your comments)",
)
def upload_attachments(
    ticket_id: int,
    user: CurrentUser,
    db: DbSession,
    files: Annotated[list[UploadFile], File(description="One or more files")],
    comment_id: Annotated[int | None, Form(description="Attach to this comment (must be yours)")] = None,
):
    ticket = get_ticket_for_user(db, ticket_id, user)

    if len(files) > settings.MAX_FILES_PER_REQUEST:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, f"At most {settings.MAX_FILES_PER_REQUEST} files per request"
        )
    if comment_id is not None:
        comment = db.get(Comment, comment_id)
        if comment is None or comment.ticket_id != ticket.id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Comment not found on this ticket")
        if comment.author_id != user.id:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "You can only attach files to your own comments")

    prepared = []
    for upload in files:
        name = safe_filename(upload.filename)
        ext = Path(name).suffix.lower()
        if ext in settings.blocked_extensions:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Files of type '{ext}' are not allowed")
        prepared.append((upload, name, ext))

    directory = ticket_upload_dir(ticket.id)
    directory.mkdir(parents=True, exist_ok=True)

    saved: list[Path] = []
    created: list[Attachment] = []
    try:
        for upload, name, ext in prepared:
            stored_name = f"{uuid.uuid4().hex}{ext}"
            path = directory / stored_name
            size = _save_upload(upload, path)
            saved.append(path)
            attachment = Attachment(
                ticket_id=ticket.id,
                comment_id=comment_id,
                uploaded_by=user.id,
                filename=name,
                stored_name=stored_name,
                content_type=(upload.content_type or mimetypes.guess_type(name)[0] or "application/octet-stream")[:120],
                size=size,
            )
            db.add(attachment)
            created.append(attachment)
            log_activity(db, ticket, user, "attachment_added", "attachment", None, name)
        db.commit()
    except BaseException:
        db.rollback()
        for path in saved:
            remove_file(path)
        raise

    for a in created:
        db.refresh(a)
    return created


@router.get("/tickets/{ticket_id}/attachments", response_model=list[AttachmentOut])
def list_attachments(ticket_id: int, user: CurrentUser, db: DbSession):
    ticket = get_ticket_for_user(db, ticket_id, user)
    return ticket.attachments


def _get_attachment(db, attachment_id: int, user) -> tuple[Attachment, object]:
    attachment = db.get(Attachment, attachment_id)
    if attachment is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Attachment not found")
    ticket = get_ticket_for_user(db, attachment.ticket_id, user)
    return attachment, ticket


@router.get("/attachments/{attachment_id}/download", response_class=FileResponse)
def download_attachment(attachment_id: int, user: CurrentUser, db: DbSession):
    attachment, ticket = _get_attachment(db, attachment_id, user)
    path = ticket_upload_dir(ticket.id) / attachment.stored_name
    if not path.is_file():
        raise HTTPException(status.HTTP_410_GONE, "The file is no longer available on the server")
    return FileResponse(
        path,
        media_type=attachment.content_type,
        filename=attachment.filename,
        content_disposition_type="attachment",
        headers={"X-Content-Type-Options": "nosniff"},
    )


@router.delete("/attachments/{attachment_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_attachment(attachment_id: int, user: CurrentUser, db: DbSession):
    attachment, ticket = _get_attachment(db, attachment_id, user)
    if attachment.uploaded_by != user.id and not is_project_owner(db, user, ticket.project_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You can only delete files you uploaded")
    path = ticket_upload_dir(ticket.id) / attachment.stored_name
    name = attachment.filename
    db.delete(attachment)
    log_activity(db, ticket, user, "attachment_removed", "attachment", name, None)
    db.commit()
    remove_file(path)
