import re
from collections import defaultdict
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import and_, case, func, not_, or_, select

from ..deps import CurrentUser, DbSession
from ..models import (
    CLOSED_STATUSES,
    ReleaseStatus,
    PRIORITY_RANK,
    Activity,
    Comment,
    Attachment,
    NotificationType,
    Project,
    ProjectMember,
    Ticket,
    TicketPriority,
    TicketStatus,
    TicketType,
    User,
    Worklog,
)
from ..permissions import (
    get_ticket_for_user,
    is_admin,
    is_project_member,
    is_project_owner,
    project_owner_ids,
    require_member,
    ticket_permissions,
)
from ..schemas import (
    ActivityOut,
    AssignIn,
    MyTicketSummary,
    Page,
    ProjectBrief,
    ProjectTicketSummary,
    StatusChange,
    TicketCreate,
    TicketDetail,
    TicketOut,
    TicketUpdate,
    WorklogCreate,
    WorklogOut,
)
from ..services import (
    apply_status_change,
    ensure_assignable,
    log_activity,
    next_ticket_number,
    notify,
    remove_ticket_files,
    reset_for_new_assignee,
)
from ..utils import ensure_utc, escape_like, paginate, utcnow

router = APIRouter(tags=["Tickets"])

_KEY_RE = re.compile(r"^([A-Za-z][A-Za-z0-9]{1,9})-(\d+)$")


# --------------------------------------------------------------------------- #
# Filtering helpers
# --------------------------------------------------------------------------- #
class TicketFilters:
    """Query parameters shared by every ticket list endpoint."""

    def __init__(
        self,
        status: Annotated[list[TicketStatus] | None, Query(description="Repeatable")] = None,
        priority: Annotated[list[TicketPriority] | None, Query(description="Repeatable")] = None,
        ticket_type: Annotated[list[TicketType] | None, Query(alias="type", description="Repeatable")] = None,
        assignee_id: int | None = None,
        reporter_id: int | None = None,
        unassigned: bool | None = None,
        overdue: bool | None = None,
        q: Annotated[str | None, Query(min_length=1, max_length=100, description="Title/description text or a key like PAY-12")] = None,
        due_before: datetime | None = None,
        due_after: datetime | None = None,
        release_id: Annotated[int | None, Query(description="Tickets in this release")] = None,
        in_release: Annotated[
            bool | None, Query(description="false: hide tickets moved into a release (the board does this)")
        ] = None,
        sort: Literal[
            "created_at", "updated_at", "due_date", "start_date", "priority", "status", "title", "key", "assignee"
        ] = "created_at",
        order: Literal["asc", "desc"] = "desc",
        limit: Annotated[int, Query(ge=1, le=200)] = 20,
        offset: Annotated[int, Query(ge=0)] = 0,
    ):
        self.status = status
        self.priority = priority
        self.ticket_type = ticket_type
        self.assignee_id = assignee_id
        self.reporter_id = reporter_id
        self.unassigned = unassigned
        self.overdue = overdue
        self.q = q
        self.due_before = ensure_utc(due_before)
        self.due_after = ensure_utc(due_after)
        self.release_id = release_id
        self.in_release = in_release
        self.sort = sort
        self.order = order
        self.limit = limit
        self.offset = offset


Filters = Annotated[TicketFilters, Depends()]


def _visible(user) -> "select":
    stmt = select(Ticket)
    if not is_admin(user):
        stmt = stmt.where(
            Ticket.project_id.in_(
                select(ProjectMember.project_id).where(ProjectMember.user_id == user.id)
            )
        )
    return stmt


def _apply_filters(stmt, f: TicketFilters):
    now = utcnow()
    if f.status:
        stmt = stmt.where(Ticket.status.in_(f.status))
    if f.priority:
        stmt = stmt.where(Ticket.priority.in_(f.priority))
    if f.ticket_type:
        stmt = stmt.where(Ticket.type.in_(f.ticket_type))
    if f.assignee_id is not None:
        stmt = stmt.where(Ticket.assignee_id == f.assignee_id)
    if f.reporter_id is not None:
        stmt = stmt.where(Ticket.reporter_id == f.reporter_id)
    if f.unassigned is True:
        stmt = stmt.where(Ticket.assignee_id.is_(None))
    elif f.unassigned is False:
        stmt = stmt.where(Ticket.assignee_id.is_not(None))

    overdue_cond = and_(
        Ticket.due_date.is_not(None), Ticket.due_date < now, Ticket.status.not_in(CLOSED_STATUSES)
    )
    if f.overdue is True:
        stmt = stmt.where(overdue_cond)
    elif f.overdue is False:
        stmt = stmt.where(not_(overdue_cond))

    if f.release_id is not None:
        stmt = stmt.where(Ticket.release_id == f.release_id)
    if f.in_release is True:
        stmt = stmt.where(Ticket.release_id.is_not(None))
    elif f.in_release is False:
        stmt = stmt.where(Ticket.release_id.is_(None))

    if f.due_before:
        stmt = stmt.where(Ticket.due_date <= f.due_before)
    if f.due_after:
        stmt = stmt.where(Ticket.due_date >= f.due_after)

    if f.q:
        like = f"%{escape_like(f.q)}%"
        conditions = [Ticket.title.ilike(like, escape="\\"), Ticket.description.ilike(like, escape="\\")]
        m = _KEY_RE.match(f.q.strip())
        if m:
            conditions.append(
                and_(
                    Ticket.number == int(m.group(2)),
                    Ticket.project_id.in_(
                        select(Project.id).where(func.upper(Project.key) == m.group(1).upper())
                    ),
                )
            )
        stmt = stmt.where(or_(*conditions))

    direction = (lambda c: c.asc()) if f.order == "asc" else (lambda c: c.desc())
    if f.sort == "priority":
        rank = case(*[(Ticket.priority == p, r) for p, r in PRIORITY_RANK.items()], else_=0)
        stmt = stmt.order_by(direction(rank))
    elif f.sort == "due_date":
        # tickets without a due date always go last
        stmt = stmt.order_by(case((Ticket.due_date.is_(None), 1), else_=0), direction(Ticket.due_date))
    elif f.sort == "start_date":
        stmt = stmt.order_by(case((Ticket.start_date.is_(None), 1), else_=0), direction(Ticket.start_date))
    elif f.sort == "status":
        rank = case(*[(Ticket.status == s, i) for i, s in enumerate(TicketStatus)], else_=99)
        stmt = stmt.order_by(direction(rank))
    elif f.sort == "title":
        stmt = stmt.order_by(direction(func.lower(Ticket.title)))
    elif f.sort == "key":
        stmt = stmt.order_by(direction(Ticket.project_id), direction(Ticket.number))
    elif f.sort == "assignee":
        # unassigned last; by name otherwise
        name = select(User.name).where(User.id == Ticket.assignee_id).correlate(Ticket).scalar_subquery()
        stmt = stmt.order_by(case((Ticket.assignee_id.is_(None), 1), else_=0), direction(func.lower(name)))
    elif f.sort == "updated_at":
        stmt = stmt.order_by(direction(Ticket.updated_at))
    else:
        stmt = stmt.order_by(direction(Ticket.created_at))
    return stmt.order_by(Ticket.id.desc())


def _page(db, stmt, f: TicketFilters) -> Page[TicketOut]:
    rows, total = paginate(db, stmt, f.limit, f.offset)
    return Page[TicketOut](
        items=[TicketOut.model_validate(t) for t in rows], total=total, limit=f.limit, offset=f.offset
    )


def _detail(db, user, ticket: Ticket) -> TicketDetail:
    perms = ticket_permissions(db, user, ticket)
    detail = TicketDetail.model_validate(ticket)
    detail.can_edit = perms["can_edit"]
    detail.can_assign = perms["can_assign"]
    detail.can_change_status = perms["can_change_status"]
    detail.can_delete = perms["can_delete"]
    detail.can_verify = perms["owner"] and ticket.status == TicketStatus.DONE
    detail.comment_count = db.scalar(
        select(func.count()).select_from(Comment).where(Comment.ticket_id == ticket.id)
    ) or 0
    detail.attachment_count = db.scalar(
        select(func.count()).select_from(Attachment).where(Attachment.ticket_id == ticket.id)
    ) or 0
    return detail


def _label(ticket: Ticket) -> str:
    return f"{ticket.key} {ticket.title}"


def _check_window(start, due) -> None:
    if start is not None and due is not None and ensure_utc(start) > ensure_utc(due):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "The start date must be on or before the due date")


def _describe_changes(changes: list[tuple[str, object, object]]) -> str:
    """'priority medium → high, due date 20 Oct 2026, description edited'."""
    def fmt(field, v):
        if v is None or v == "":
            return "none"
        if field in ("due_date", "start_date"):
            return f"{v:%d %b %Y}"
        if field == "estimated_hours":
            return f"{v:g}h"
        return str(getattr(v, "value", v))

    parts = []
    for field, old, new in changes:
        name = field.replace("_", " ").replace("estimated hours", "estimate")
        if field == "description":
            parts.append("description edited")
        elif field == "title":
            parts.append(f"title was \"{old}\"")
        else:
            parts.append(f"{name} {fmt(field, old)} → {fmt(field, new)}")
    return ", ".join(parts)


# --------------------------------------------------------------------------- #
# Lists  (static paths first so they are not captured by /tickets/{ticket_id})
# --------------------------------------------------------------------------- #
@router.get("/tickets", response_model=Page[TicketOut], summary="All tickets I am allowed to see")
def list_tickets(
    user: CurrentUser,
    db: DbSession,
    f: Filters,
    project_id: int | None = Query(None, description="Only this project"),
):
    """Admin: every ticket in the system. Others: tickets of the projects they belong to."""
    stmt = _visible(user)
    if project_id is not None:
        stmt = stmt.where(Ticket.project_id == project_id)
    return _page(db, _apply_filters(stmt, f), f)


@router.get("/tickets/my", response_model=Page[TicketOut], summary="Tickets assigned to me (all projects or one)")
def my_tickets(
    user: CurrentUser,
    db: DbSession,
    f: Filters,
    project_id: int | None = Query(None, description="Leave empty for all projects"),
):
    # _visible() matters: a finished ticket stays assigned to someone who has since left the project.
    stmt = _visible(user).where(Ticket.assignee_id == user.id)
    if project_id is not None:
        stmt = stmt.where(Ticket.project_id == project_id)
    f.assignee_id = None  # already restricted to me
    return _page(db, _apply_filters(stmt, f), f)


@router.get("/tickets/my/summary", response_model=MyTicketSummary, summary="My assigned work grouped by project")
def my_ticket_summary(user: CurrentUser, db: DbSession):
    now = utcnow()
    mine = [Ticket.assignee_id == user.id]
    if not is_admin(user):  # same rule as _visible(): only projects I still belong to
        mine.append(
            Ticket.project_id.in_(
                select(ProjectMember.project_id).where(ProjectMember.user_id == user.id)
            )
        )
    rows = db.execute(
        select(Ticket.project_id, Ticket.status, func.count())
        .where(*mine)
        .group_by(Ticket.project_id, Ticket.status)
    ).all()
    overdue_rows = dict(
        db.execute(
            select(Ticket.project_id, func.count())
            .where(
                *mine,
                Ticket.due_date.is_not(None),
                Ticket.due_date < now,
                Ticket.status.not_in(CLOSED_STATUSES),
            )
            .group_by(Ticket.project_id)
        ).all()
    )

    per_project: dict[int, dict[str, int]] = defaultdict(lambda: {s.value: 0 for s in TicketStatus})
    for pid, st, n in rows:
        per_project[pid][st.value] = n

    projects = {
        p.id: p
        for p in db.scalars(select(Project).where(Project.id.in_(list(per_project) or [0])))
    }
    totals = {s.value: 0 for s in TicketStatus}
    by_project = []
    for pid, counts in sorted(per_project.items(), key=lambda kv: projects[kv[0]].name):
        for k, v in counts.items():
            totals[k] += v
        total = sum(counts.values())
        by_project.append(
            ProjectTicketSummary(
                project=ProjectBrief.model_validate(projects[pid]),
                total=total,
                open=total - sum(counts[s.value] for s in CLOSED_STATUSES),
                overdue=overdue_rows.get(pid, 0),
                by_status=counts,
            )
        )
    grand = sum(totals.values())
    return MyTicketSummary(
        total=grand,
        open=grand - sum(totals[s.value] for s in CLOSED_STATUSES),
        overdue=sum(overdue_rows.values()),
        by_status=totals,
        by_project=by_project,
    )


@router.get("/tickets/by-key/{key}", response_model=TicketDetail, summary="Open a ticket by its key, e.g. PAY-12")
def get_ticket_by_key(key: str, user: CurrentUser, db: DbSession):
    m = _KEY_RE.match(key.strip())
    if not m:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Ticket key must look like PAY-12")
    ticket = db.scalar(
        select(Ticket)
        .join(Project, Project.id == Ticket.project_id)
        .where(func.upper(Project.key) == m.group(1).upper(), Ticket.number == int(m.group(2)))
    )
    if ticket is None or not is_project_member(db, user, ticket.project_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Ticket not found")
    return _detail(db, user, ticket)


@router.get("/projects/{project_id}/tickets", response_model=Page[TicketOut], summary="Tickets of one project")
def list_project_tickets(project_id: int, user: CurrentUser, db: DbSession, f: Filters):
    require_member(db, user, project_id)
    stmt = select(Ticket).where(Ticket.project_id == project_id)
    return _page(db, _apply_filters(stmt, f), f)


# --------------------------------------------------------------------------- #
# Create / read / update / delete
# --------------------------------------------------------------------------- #
@router.post(
    "/projects/{project_id}/tickets",
    response_model=TicketDetail,
    status_code=status.HTTP_201_CREATED,
    summary="Raise a ticket",
)
def create_ticket(project_id: int, payload: TicketCreate, user: CurrentUser, db: DbSession):
    """Any project member can raise a ticket. Only owners (or admin) can set the assignee up front."""
    project = require_member(db, user, project_id)
    if not project.is_active:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "This project is archived")

    owner = is_project_owner(db, user, project_id)
    if payload.start_date is not None and not owner:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only project owners can plan the start date")
    _check_window(payload.start_date, payload.due_date)
    if payload.assignee_id is not None:
        if not owner:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Only project owners can assign tickets")
        ensure_assignable(db, project_id, payload.assignee_id)

    ticket = Ticket(
        project_id=project_id,
        number=next_ticket_number(db, project),
        title=payload.title,
        description=payload.description,
        priority=payload.priority,
        type=payload.type,
        reporter_id=user.id,
        assignee_id=payload.assignee_id,
        assigned_at=utcnow() if payload.assignee_id else None,
        start_date=ensure_utc(payload.start_date),
        due_date=ensure_utc(payload.due_date),
        estimated_hours=payload.estimated_hours,
    )
    db.add(ticket)
    db.flush()
    log_activity(db, ticket, user, "created")

    # In-app: the assignee hears they were assigned; every project owner hears a ticket was created.
    # Slack: one "created" message covering both (the assigned one is not posted separately).
    if payload.assignee_id:
        log_activity(db, ticket, user, "assigned", "assignee", None, payload.assignee_id)
        notify(
            db, [payload.assignee_id], actor=user, type=NotificationType.ASSIGNED,
            message=f"{user.name} assigned you {_label(ticket)}", ticket=ticket, slack=False,
        )
    assignee_name = db.get(User, payload.assignee_id).name if payload.assignee_id else "unassigned"
    details = [ticket.type.value, f"{ticket.priority.value} priority", f"assignee: {assignee_name}"]
    if ticket.due_date:
        details.append(f"due {ticket.due_date:%d %b %Y}")
    notify(
        db, [*project_owner_ids(db, project_id), payload.assignee_id], actor=user, type=NotificationType.TICKET_CREATED,
        message=f"{user.name} created {_label(ticket)} ({', '.join(details)})", ticket=ticket,
    )
    db.commit()
    db.refresh(ticket)
    return _detail(db, user, ticket)


@router.get("/tickets/{ticket_id}", response_model=TicketDetail)
def get_ticket(ticket_id: int, user: CurrentUser, db: DbSession):
    return _detail(db, user, get_ticket_for_user(db, ticket_id, user))


@router.patch("/tickets/{ticket_id}", response_model=TicketDetail)
def update_ticket(ticket_id: int, payload: TicketUpdate, user: CurrentUser, db: DbSession):
    """Field level rules:

    * `priority`, `due_date` - project owners / admin
    * `estimated_hours` - owners or the assignee
    * `title`, `description`, `type` - owners, the reporter or the assignee
    """
    ticket = get_ticket_for_user(db, ticket_id, user)
    perms = ticket_permissions(db, user, ticket)
    data = payload.model_dump(exclude_unset=True)
    if not data:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Nothing to update")

    allowed = {
        "title": perms["can_edit"],
        "description": perms["can_edit"],
        "type": perms["can_edit"],
        "priority": perms["owner"],
        "start_date": perms["owner"],
        "due_date": perms["owner"],
        "estimated_hours": perms["owner"] or perms["assignee"],
    }
    denied = [f for f in data if not allowed[f]]
    if denied:
        raise HTTPException(status.HTTP_403_FORBIDDEN, f"You are not allowed to change: {', '.join(denied)}")
    for required in ("title", "priority", "type"):
        if required in data and data[required] is None:
            raise HTTPException(422, f"{required} cannot be null")
    if "description" in data and data["description"] is None:
        data["description"] = ""
    for key in ("start_date", "due_date"):
        if key in data:
            data[key] = ensure_utc(data[key])
    _check_window(data.get("start_date", ticket.start_date), data.get("due_date", ticket.due_date))

    changed: list[str] = []
    changes: list[tuple[str, object, object]] = []
    for field, value in data.items():
        old = getattr(ticket, field)
        if old != value:
            log_activity(db, ticket, user, "updated", field, old, value)
            setattr(ticket, field, value)
            changed.append(field)
            changes.append((field, old, value))

    if changed:
        # Assignee and reporter always; owners too when someone else (developer/reporter) made the edit.
        recipients = [ticket.assignee_id, ticket.reporter_id]
        if not perms["owner"]:
            recipients += project_owner_ids(db, ticket.project_id)
        notify(
            db, recipients, actor=user, type=NotificationType.TICKET_UPDATED,
            message=f"{user.name} updated {_label(ticket)}: {_describe_changes(changes)}", ticket=ticket,
        )
    db.commit()
    db.refresh(ticket)
    return _detail(db, user, ticket)


@router.post("/tickets/{ticket_id}/assign", response_model=TicketDetail, summary="Assign / reassign / unassign (owners)")
def assign_ticket(ticket_id: int, payload: AssignIn, user: CurrentUser, db: DbSession):
    """Reassigning resets progress tracking (status back to *todo*, start time cleared) so the new assignee
    is not credited for earlier work. A finished ticket must be reopened before it can be reassigned."""
    ticket = get_ticket_for_user(db, ticket_id, user)
    if not ticket_permissions(db, user, ticket)["can_assign"]:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only project owners can assign tickets")
    if ticket.status in CLOSED_STATUSES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Reopen the ticket before reassigning it")

    new_id, old_id = payload.assignee_id, ticket.assignee_id
    if new_id == old_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Ticket is already assigned to this user")
    if new_id is not None:
        ensure_assignable(db, ticket.project_id, new_id)

    old_status = ticket.status
    reset_for_new_assignee(ticket, new_id)
    log_activity(db, ticket, user, "assigned" if new_id else "unassigned", "assignee", old_id, new_id)
    if old_status != ticket.status:
        log_activity(db, ticket, user, "updated", "status", old_status, ticket.status)

    if new_id:
        notify(
            db, [new_id], actor=user, type=NotificationType.ASSIGNED,
            message=f"{user.name} assigned you {_label(ticket)}", ticket=ticket,
        )
    if old_id:
        notify(
            db, [old_id], actor=user, type=NotificationType.UNASSIGNED,
            message=f"{_label(ticket)} was taken off you by {user.name}", ticket=ticket,
        )
    db.commit()
    db.refresh(ticket)
    return _detail(db, user, ticket)


@router.post("/tickets/{ticket_id}/status", response_model=TicketDetail, summary="Change status (assignee / owners)")
def change_status(ticket_id: int, payload: StatusChange, user: CurrentUser, db: DbSession):
    """Developers move their tickets up to *done*; a project owner then cross-checks the work and either
    moves it to *verified* (closed) or sends it back (any other status, which counts as a reopen)."""
    ticket = get_ticket_for_user(db, ticket_id, user)
    perms = ticket_permissions(db, user, ticket)
    if not perms["can_change_status"]:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the assignee or a project owner can change the status")

    new, old = payload.status, ticket.status
    if new == old:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Ticket is already {old.value}")
    if new == TicketStatus.VERIFIED:
        if not perms["owner"]:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Only a project owner can verify a ticket")
        if old != TicketStatus.DONE:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Only a ticket marked done can be verified")
    if old == TicketStatus.VERIFIED and not perms["owner"]:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "This ticket has been verified - ask a project owner to reopen it"
        )
    if ticket.release is not None and new not in CLOSED_STATUSES:
        if ticket.release.status == ReleaseStatus.RELEASED:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"This ticket shipped in release {ticket.release.name} - raise a new ticket for follow-up work",
            )
        # Reopening a ticket takes it back out of the planned release (and back onto the board).
        log_activity(db, ticket, user, "release_removed", "release", ticket.release.name, None)
        ticket.release_id = None
    if ticket.assignee_id is None and new in (
        TicketStatus.IN_PROGRESS, TicketStatus.IN_REVIEW, TicketStatus.DONE
    ):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Assign the ticket before moving it forward")

    apply_status_change(ticket, new)
    log_activity(db, ticket, user, "status_changed", "status", old, new)

    recipients = [ticket.reporter_id, ticket.assignee_id]
    if new in (TicketStatus.BLOCKED, TicketStatus.IN_REVIEW, TicketStatus.DONE) or old in CLOSED_STATUSES:
        recipients += project_owner_ids(db, ticket.project_id)
    if new == TicketStatus.DONE:
        message = f"{user.name} marked {_label(ticket)} done - ready for verification"
    elif new == TicketStatus.VERIFIED:
        message = f"{user.name} verified {_label(ticket)}"
    elif old == TicketStatus.DONE:
        message = f"{user.name} sent {_label(ticket)} back to {new.value} after review"
    else:
        message = f"{user.name} moved {_label(ticket)} from {old.value} to {new.value}"
    notify(db, recipients, actor=user, type=NotificationType.STATUS_CHANGED, message=message, ticket=ticket)
    db.commit()
    db.refresh(ticket)
    return _detail(db, user, ticket)


@router.delete("/tickets/{ticket_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_ticket(ticket_id: int, user: CurrentUser, db: DbSession):
    ticket = get_ticket_for_user(db, ticket_id, user)
    if not ticket_permissions(db, user, ticket)["can_delete"]:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only project owners can delete tickets")
    tid = ticket.id
    db.delete(ticket)
    db.commit()
    remove_ticket_files(tid)


@router.get("/tickets/{ticket_id}/activity", response_model=list[ActivityOut])
def ticket_activity(ticket_id: int, user: CurrentUser, db: DbSession):
    ticket = get_ticket_for_user(db, ticket_id, user)
    return db.scalars(
        select(Activity).where(Activity.ticket_id == ticket.id).order_by(Activity.id.desc())
    ).unique().all()


# --------------------------------------------------------------------------- #
# Work logs (time spent) - feed the estimate-accuracy metric
# --------------------------------------------------------------------------- #
@router.get("/tickets/{ticket_id}/worklogs", response_model=list[WorklogOut])
def list_worklogs(ticket_id: int, user: CurrentUser, db: DbSession):
    ticket = get_ticket_for_user(db, ticket_id, user)
    return ticket.worklogs


@router.post(
    "/tickets/{ticket_id}/worklogs", response_model=WorklogOut, status_code=status.HTTP_201_CREATED
)
def add_worklog(ticket_id: int, payload: WorklogCreate, user: CurrentUser, db: DbSession):
    ticket = get_ticket_for_user(db, ticket_id, user)
    if not ticket_permissions(db, user, ticket)["can_change_status"]:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the assignee or a project owner can log time")
    log = Worklog(ticket_id=ticket.id, user_id=user.id, hours=payload.hours, note=payload.note)
    db.add(log)
    ticket.spent_hours = round((ticket.spent_hours or 0) + payload.hours, 2)
    log_activity(db, ticket, user, "time_logged", "spent_hours", None, payload.hours)
    db.commit()
    db.refresh(log)
    return log


@router.delete("/worklogs/{worklog_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_worklog(worklog_id: int, user: CurrentUser, db: DbSession):
    log = db.get(Worklog, worklog_id)
    if log is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Work log not found")
    ticket = get_ticket_for_user(db, log.ticket_id, user)
    if log.user_id != user.id and not ticket_permissions(db, user, ticket)["owner"]:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You can only delete your own work logs")
    ticket.spent_hours = max(0.0, round((ticket.spent_hours or 0) - log.hours, 2))
    db.delete(log)
    db.commit()
