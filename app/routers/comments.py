from fastapi import APIRouter, HTTPException, status
from sqlalchemy import select

from ..deps import CurrentUser, DbSession
from ..models import Attachment, Comment, NotificationType
from ..permissions import get_ticket_for_user, is_project_owner
from ..schemas import CommentCreate, CommentOut, CommentUpdate
from ..services import (
    log_activity,
    notify,
    remove_file,
    resolve_mentions,
    ticket_upload_dir,
)
from ..utils import utcnow

router = APIRouter(tags=["Comments"])


def _get_comment(db, comment_id: int, user):
    comment = db.get(Comment, comment_id)
    if comment is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Comment not found")
    ticket = get_ticket_for_user(db, comment.ticket_id, user)  # 404 for non-members
    return comment, ticket


@router.get("/tickets/{ticket_id}/comments", response_model=list[CommentOut])
def list_comments(ticket_id: int, user: CurrentUser, db: DbSession):
    ticket = get_ticket_for_user(db, ticket_id, user)
    return db.scalars(
        select(Comment).where(Comment.ticket_id == ticket.id).order_by(Comment.id)
    ).unique().all()


@router.post(
    "/tickets/{ticket_id}/comments", response_model=CommentOut, status_code=status.HTTP_201_CREATED
)
def add_comment(ticket_id: int, payload: CommentCreate, user: CurrentUser, db: DbSession):
    """Comment on a ticket. Mention teammates with `mention_user_ids` or by typing `@their@email.com`."""
    ticket = get_ticket_for_user(db, ticket_id, user)
    mentions = resolve_mentions(db, ticket.project_id, payload.body, payload.mention_user_ids)

    comment = Comment(ticket_id=ticket.id, author_id=user.id, body=payload.body)
    comment.mentions = mentions
    db.add(comment)
    db.flush()
    log_activity(db, ticket, user, "commented")

    mentioned_ids = {u.id for u in mentions}
    notify(
        db, mentioned_ids, actor=user, type=NotificationType.MENTION,
        message=f"{user.name} mentioned you on {ticket.key}: {payload.body[:200]}", ticket=ticket,
    )
    notify(
        db, {ticket.assignee_id, ticket.reporter_id} - mentioned_ids, actor=user,
        type=NotificationType.COMMENT,
        message=f"{user.name} commented on {ticket.key} {ticket.title}", ticket=ticket,
    )
    db.commit()
    db.refresh(comment)
    return comment


@router.patch("/comments/{comment_id}", response_model=CommentOut)
def edit_comment(comment_id: int, payload: CommentUpdate, user: CurrentUser, db: DbSession):
    comment, ticket = _get_comment(db, comment_id, user)
    if comment.author_id != user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You can only edit your own comments")

    mentions = resolve_mentions(db, ticket.project_id, payload.body, payload.mention_user_ids)
    already_mentioned = {u.id for u in comment.mentions}
    comment.body = payload.body
    comment.mentions = mentions
    comment.edited_at = utcnow()

    notify(
        db, {u.id for u in mentions} - already_mentioned, actor=user, type=NotificationType.MENTION,
        message=f"{user.name} mentioned you on {ticket.key}: {payload.body[:200]}", ticket=ticket,
    )
    db.commit()
    db.refresh(comment)
    return comment


@router.delete("/comments/{comment_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_comment(comment_id: int, user: CurrentUser, db: DbSession):
    """Author, project owners and admins can delete a comment (its attachments go with it)."""
    comment, ticket = _get_comment(db, comment_id, user)
    if comment.author_id != user.id and not is_project_owner(db, user, ticket.project_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You can only delete your own comments")

    attachments = db.scalars(select(Attachment).where(Attachment.comment_id == comment.id)).unique().all()
    stored = [ticket_upload_dir(ticket.id) / a.stored_name for a in attachments]
    for a in attachments:
        db.delete(a)
    db.delete(comment)
    db.commit()
    for path in stored:
        remove_file(path)
