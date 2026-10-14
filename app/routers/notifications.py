from fastapi import APIRouter, HTTPException, Query, status
from sqlalchemy import func, select, update

from ..deps import CurrentUser, DbSession
from ..models import Notification
from ..schemas import NotificationOut, Page
from ..utils import paginate

router = APIRouter(prefix="/notifications", tags=["Notifications"])


def _out(n: Notification) -> NotificationOut:
    item = NotificationOut.model_validate(n)
    item.ticket_key = n.ticket.key if n.ticket else None
    return item


@router.get("", response_model=Page[NotificationOut])
def list_notifications(
    user: CurrentUser,
    db: DbSession,
    unread_only: bool = False,
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
):
    stmt = select(Notification).where(Notification.user_id == user.id)
    if unread_only:
        stmt = stmt.where(Notification.is_read.is_(False))
    stmt = stmt.order_by(Notification.id.desc())
    rows, total = paginate(db, stmt, limit, offset)
    return Page[NotificationOut](items=[_out(n) for n in rows], total=total, limit=limit, offset=offset)


@router.get("/unread-count")
def unread_count(user: CurrentUser, db: DbSession):
    count = db.scalar(
        select(func.count()).where(Notification.user_id == user.id, Notification.is_read.is_(False))
    )
    return {"unread": count or 0}


@router.post("/read-all")
def mark_all_read(user: CurrentUser, db: DbSession):
    result = db.execute(
        update(Notification)
        .where(Notification.user_id == user.id, Notification.is_read.is_(False))
        .values(is_read=True)
    )
    db.commit()
    return {"marked_read": result.rowcount}


@router.post("/{notification_id}/read", response_model=NotificationOut)
def mark_read(notification_id: int, user: CurrentUser, db: DbSession):
    n = db.get(Notification, notification_id)
    if n is None or n.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Notification not found")
    n.is_read = True
    db.commit()
    db.refresh(n)
    return _out(n)
