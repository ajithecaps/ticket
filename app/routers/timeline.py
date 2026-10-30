"""Timeline (Gantt) of planned work per person, and the overlap check used when assigning.

Who sees what:
* admin - everybody in every active project;
* project owner - the members of the projects they own, with those projects' tickets (plus their own row);
* developer - only their own tickets.
"""
from collections import defaultdict
from datetime import date, datetime, timedelta

from fastapi import APIRouter, HTTPException, Query, status
from sqlalchemy import select

from ..deps import CurrentUser, DbSession
from ..models import CLOSED_STATUSES, Project, ProjectMember, ProjectRole, Ticket, User, assigned_to_any
from ..permissions import is_admin
from ..schedule import intersects, overlap_map, window
from ..schemas import OverlapOut, TicketOut, TimelineOut, TimelineRow, TimelineTicket, UserBrief
from ..utils import day_start, ensure_utc, next_day_start, utcnow

router = APIRouter(prefix="/timeline", tags=["Timeline"])

MAX_DAYS = 370


def _timeline_ticket(t: Ticket, w, overlaps: list[str], can_reschedule: bool = False) -> TimelineTicket:
    return TimelineTicket.model_validate(
        {**TicketOut.model_validate(t).model_dump(), "window_start": w[0], "window_end": w[1],
         "start_planned": t.start_date is not None, "overlaps": overlaps, "can_reschedule": can_reschedule}
    )


def _member_projects(db, user_id: int) -> set[int]:
    return set(db.scalars(select(ProjectMember.project_id).where(ProjectMember.user_id == user_id)))


def _owned_projects(db, user_id: int) -> set[int]:
    return set(db.scalars(select(ProjectMember.project_id).where(
        ProjectMember.user_id == user_id, ProjectMember.role == ProjectRole.OWNER)))


def _open_assigned(db, *, project_ids: set[int] | None, assignee_ids: set[int] | None, include_done: bool):
    stmt = (
        select(Ticket)
        .join(Project, Project.id == Ticket.project_id)
        .where(Project.is_active.is_(True), Ticket.assignee_id.is_not(None), Ticket.release_id.is_(None))
    )
    if not include_done:
        stmt = stmt.where(Ticket.status.not_in(CLOSED_STATUSES))
    if project_ids is not None:
        stmt = stmt.where(Ticket.project_id.in_(project_ids or {0}))
    if assignee_ids is not None:
        stmt = stmt.where(assigned_to_any(assignee_ids))
    return list(db.scalars(stmt).unique())


@router.get("", response_model=TimelineOut, summary="Planned tickets per person between two dates")
def timeline(
    user: CurrentUser,
    db: DbSession,
    start: date | None = Query(None, description="First day (UTC); default: this week's Monday"),
    end: date | None = Query(None, description="Last day, inclusive; default: start + 4 weeks"),
    project_id: int | None = None,
    user_id: int | None = Query(None, description="Only this person"),
    include_done: bool = Query(False, description="Also show finished tickets that are not released yet"),
):
    today = utcnow().date()
    start = start or (today - timedelta(days=today.weekday()))
    end = end or (start + timedelta(days=27))
    if end < start:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "'end' must not be before 'start'")
    if (end - start).days > MAX_DAYS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Pick a range of at most {MAX_DAYS} days")
    rng = (day_start(start), next_day_start(end) - timedelta(microseconds=1))

    # --- scope: which projects' tickets and which people this caller may see
    if is_admin(user):
        scope, project_ids = "all", None
        people_ids = set(db.scalars(
            select(ProjectMember.user_id).join(Project, Project.id == ProjectMember.project_id)
            .where(Project.is_active.is_(True))))
    else:
        owned = _owned_projects(db, user.id)
        if owned:
            scope, project_ids = "owned", owned
            people_ids = set(db.scalars(select(ProjectMember.user_id).where(ProjectMember.project_id.in_(owned))))
        else:
            scope, project_ids, people_ids = "self", _member_projects(db, user.id), {user.id}
    if project_id is not None:
        if project_ids is not None and project_id not in project_ids:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
        project_ids = {project_id}
        people_ids &= set(db.scalars(select(ProjectMember.user_id).where(ProjectMember.project_id == project_id)))
    if user_id is not None:
        if user_id not in people_ids:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Person not found in your projects")
        people_ids = {user_id}

    tickets = _open_assigned(db, project_ids=project_ids, assignee_ids=people_ids, include_done=include_done)
    if scope == "owned" and user.id in people_ids and project_id is None:
        # an owner's own row also shows their work in projects they do not own
        mine = _open_assigned(db, project_ids=_member_projects(db, user.id), assignee_ids={user.id}, include_done=include_done)
        tickets = list({t.id: t for t in [*tickets, *mine]}.values())

    owns = (lambda pid: True) if is_admin(user) else (lambda pid, _o=_owned_projects(db, user.id): pid in _o)
    per_person: dict[int, list[Ticket]] = defaultdict(list)
    for t in tickets:
        for uid in t.assignee_ids:  # a shared ticket shows on every assignee's row
            per_person[uid].append(t)

    users = {u.id: u for u in db.scalars(select(User).where(User.id.in_(people_ids or {0}), User.is_active.is_(True)))}
    rows = []
    for uid, u in users.items():
        items = per_person.get(uid, [])
        open_items = [t for t in items if t.status not in CLOSED_STATUSES]
        overlaps = overlap_map(open_items)  # finished tickets never count as a clash
        scheduled = []
        for t in items:
            w = window(t)
            if w is not None and intersects(w, rng):
                scheduled.append(_timeline_ticket(t, w, overlaps.get(t.id, []), owns(t.project_id)))
        scheduled.sort(key=lambda x: (x.window_start, x.window_end))
        unscheduled = [TicketOut.model_validate(t) for t in open_items if t.due_date is None][:25]
        rows.append(TimelineRow(
            user=UserBrief.model_validate(u), tickets=scheduled, unscheduled=unscheduled,
            overlap_count=sum(1 for x in scheduled if x.overlaps),
        ))
    rows.sort(key=lambda r: (r.user.id != user.id, r.user.name.lower()))
    return TimelineOut(start=rng[0], end=rng[1], scope=scope, rows=rows)


@router.get("/overlaps", response_model=OverlapOut, summary="A person's open tickets that clash with a date range")
def overlaps(
    user: CurrentUser,
    db: DbSession,
    user_id: int,
    end: datetime = Query(..., description="Due date of the ticket being assigned"),
    start: datetime | None = Query(None, description="Planned start; default: now"),
    exclude_ticket_id: int | None = Query(None, description="The ticket being (re)assigned"),
):
    """Called before assigning so the owner can see what else that person has in those days.

    Tickets in projects the caller cannot see are counted (`hidden_count`) but not shown.
    """
    target = db.get(User, user_id)
    if target is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")
    mine = _member_projects(db, user.id)
    if not is_admin(user) and user.id != user_id:
        owned = _owned_projects(db, user.id)
        shares = db.scalar(select(ProjectMember.user_id).where(
            ProjectMember.user_id == user_id, ProjectMember.project_id.in_(owned or {0})).limit(1))
        if not shares:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "You can only check people in projects you own")

    end = ensure_utc(end)
    start = ensure_utc(start) if start else min(utcnow(), end)
    rng = (min(start, end), end)
    candidates = [
        t for t in _open_assigned(db, project_ids=None, assignee_ids={user_id}, include_done=False)
        if t.id != exclude_ticket_id
    ]
    clashing = [(t, w) for t in candidates if (w := window(t)) is not None and intersects(w, rng)]
    visible = [(t, w) for t, w in clashing if is_admin(user) or t.project_id in mine]
    return OverlapOut(
        user=UserBrief.model_validate(target),
        start=rng[0], end=rng[1],
        tickets=[_timeline_ticket(t, w, []) for t, w in sorted(visible, key=lambda x: x[1][0])],
        hidden_count=len(clashing) - len(visible),
    )
