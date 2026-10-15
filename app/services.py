"""Business helpers shared by several routers."""
import re
import shutil
from pathlib import Path
from typing import Iterable

from fastapi import HTTPException, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from .config import settings
from .slack import queue_notification as slack_queue_notification
from .models import (
    CLOSED_STATUSES,
    Activity,
    Notification,
    NotificationType,
    Project,
    ProjectMember,
    Role,
    Ticket,
    TicketStatus,
    User,
)
from .utils import utcnow


# --------------------------------------------------------------------------- #
# Activity log & notifications
# --------------------------------------------------------------------------- #
def log_activity(
    db: Session,
    ticket: Ticket,
    actor: User | None,
    action: str,
    field: str | None = None,
    old: object = None,
    new: object = None,
) -> None:
    def fmt(v):
        if v is None:
            return None
        return str(getattr(v, "value", v))

    db.add(
        Activity(
            ticket_id=ticket.id,
            actor_id=actor.id if actor else None,
            action=action,
            field=field,
            old_value=fmt(old),
            new_value=fmt(new),
        )
    )


def notify(
    db: Session,
    recipients: Iterable[int | None],
    *,
    actor: User | None,
    type: NotificationType,
    message: str,
    ticket: Ticket | None = None,
    slack: bool = True,
) -> None:
    """Create one notification per recipient (never for the actor, never twice, only active users).

    The same event is also posted once to the Slack channel (after the transaction commits) unless
    `slack=False` - the overdue job sends its own combined message instead.
    """
    ids = {r for r in recipients if r is not None}
    if actor is not None:
        ids.discard(actor.id)
    users = list(db.scalars(select(User).where(User.id.in_(ids), User.is_active.is_(True))).unique()) if ids else []
    active_ids = {u.id for u in users}
    # Ticket events always reach the Slack channel, even when nobody gets an in-app notification
    # (e.g. an owner creating an unassigned ticket in a project they own alone).
    if slack and (users or ticket is not None):
        slack_queue_notification(db, type=type, message=message, ticket=ticket, recipients=sorted(users, key=lambda u: u.name))
    for uid in active_ids:
        db.add(
            Notification(
                user_id=uid,
                actor_id=actor.id if actor else None,
                type=type,
                message=message[:500],
                ticket_id=ticket.id if ticket else None,
            )
        )


# --------------------------------------------------------------------------- #
# Tickets
# --------------------------------------------------------------------------- #
def next_ticket_number(db: Session, project: Project) -> int:
    """Atomically hand out the next per-project number (row lock on PostgreSQL)."""
    db.refresh(project, with_for_update=True)
    project.ticket_counter += 1
    db.flush()
    return project.ticket_counter


def apply_status_change(ticket: Ticket, new_status: TicketStatus) -> None:
    """Move a ticket to `new_status` and maintain the timestamps the efficiency report relies on."""
    now = utcnow()
    old_status = ticket.status
    was_closed = old_status in CLOSED_STATUSES
    if was_closed and new_status not in CLOSED_STATUSES:
        ticket.reopen_count += 1
        ticket.completed_at = None
    if new_status == TicketStatus.IN_PROGRESS and ticket.started_at is None:
        ticket.started_at = now
    if new_status == TicketStatus.DONE and not was_closed:
        ticket.completed_at = now  # verifying later keeps the developer's completion time
    ticket.status = new_status


def reset_for_new_assignee(ticket: Ticket, assignee_id: int | None) -> None:
    """Reassigning restarts progress tracking so the new assignee is not credited with earlier work."""
    ticket.assignee_id = assignee_id
    ticket.assigned_at = utcnow() if assignee_id else None
    ticket.started_at = None
    if ticket.status not in CLOSED_STATUSES:
        ticket.status = TicketStatus.TODO


def ensure_assignable(db: Session, project_id: int, user_id: int) -> User:
    """The assignee must be an active member of the project."""
    member = db.get(ProjectMember, (project_id, user_id))
    user = db.get(User, user_id)
    if member is None or user is None or not user.is_active:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"User {user_id} is not an active member of this project",
        )
    return user


# --------------------------------------------------------------------------- #
# Mentions
# --------------------------------------------------------------------------- #
_EMAIL_MENTION = re.compile(r"(?<![\w.])@([A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})")


def resolve_mentions(
    db: Session, project_id: int, body: str, explicit_ids: Iterable[int] | None
) -> list[User]:
    """Users mentioned either via `mention_user_ids` or by writing `@their.email@domain.com`.

    Only active project members (and admins) can be mentioned. Unknown explicit ids are rejected;
    unknown e-mail handles in the text are simply left as plain text.
    """
    explicit = set(explicit_ids or [])
    emails = {m.lower() for m in _EMAIL_MENTION.findall(body)}
    if not explicit and not emails:
        return []

    member_ids = select(ProjectMember.user_id).where(ProjectMember.project_id == project_id)
    conditions = []
    if explicit:
        conditions.append(User.id.in_(explicit))
    if emails:
        conditions.append(func.lower(User.email).in_(emails))

    users = db.scalars(
        select(User).where(
            User.is_active.is_(True),
            or_(User.id.in_(member_ids), User.role == Role.ADMIN),
            or_(*conditions),
        )
    ).all()

    missing = explicit - {u.id for u in users}
    if missing:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Cannot mention user(s) {sorted(missing)}: not active members of this project",
        )
    return list(users)


# --------------------------------------------------------------------------- #
# Files
# --------------------------------------------------------------------------- #
def ticket_upload_dir(ticket_id: int) -> Path:
    return Path(settings.UPLOAD_DIR) / str(ticket_id)


def remove_file(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass


def remove_ticket_files(ticket_id: int) -> None:
    shutil.rmtree(ticket_upload_dir(ticket_id), ignore_errors=True)
