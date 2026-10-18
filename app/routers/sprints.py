"""Sprints: time-boxed iterations per project.

* Project owners / admins create sprints, plan tickets into them from the backlog, start one
  (one active sprint per project) and complete it - unfinished tickets go back to the backlog or
  into another sprint. Project members can read everything.
* A ticket's `sprint_id` is None while it sits in the backlog.
"""
from datetime import timedelta
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import func, select

from ..config import settings
from ..deps import CurrentUser, DbSession
from ..models import (
    CLOSED_STATUSES, NotificationType, ProjectMember, Sprint, SprintStatus, Ticket,
)
from ..permissions import is_project_owner, require_member, require_owner
from ..schemas import (
    BurndownPoint, SprintCompleteIn, SprintCreate, SprintMoveIn, SprintOut, SprintUpdate,
)
from ..services import log_activity, notify
from ..utils import ensure_utc, utcnow

router = APIRouter(tags=["Sprints"])

DEFAULT_LENGTH = timedelta(days=14)


def _tz():
    try:
        return ZoneInfo(settings.TIMEZONE)
    except Exception:  # noqa: BLE001
        return ZoneInfo("UTC")


def _local_date(dt):
    """Sprint days are counted in the team's time zone (TIMEZONE), not UTC."""
    return ensure_utc(dt).astimezone(_tz()).date()


def _days_between(a, b) -> int:
    return (_local_date(b) - _local_date(a)).days


def _out(db, user, sprint: Sprint) -> SprintOut:
    tickets = list(sprint.tickets)
    out = SprintOut.model_validate(sprint)
    out.ticket_count = len(tickets)
    out.done_count = sum(1 for t in tickets if t.status in CLOSED_STATUSES)
    out.open_count = out.ticket_count - out.done_count
    out.estimated_hours = round(sum(t.estimated_hours or 0 for t in tickets), 1)
    out.spent_hours = round(sum(t.spent_hours or 0 for t in tickets), 1)
    if sprint.start_date and sprint.end_date:
        out.days_total = _days_between(sprint.start_date, sprint.end_date) + 1
    if sprint.status == SprintStatus.ACTIVE and sprint.end_date:
        out.days_left = _days_between(utcnow(), sprint.end_date)
    out.can_manage = sprint.status != SprintStatus.COMPLETED and is_project_owner(db, user, sprint.project_id)
    return out


def _get(db, user, sprint_id: int) -> Sprint:
    sprint = db.get(Sprint, sprint_id)
    if sprint is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Sprint not found")
    require_member(db, user, sprint.project_id)
    return sprint


def _manageable(db, user, sprint_id: int) -> Sprint:
    sprint = _get(db, user, sprint_id)
    require_owner(db, user, sprint.project_id)
    if sprint.status == SprintStatus.COMPLETED:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"{sprint.name} is completed and can no longer change")
    return sprint


def _check_dates(start, end) -> None:
    if start and end and ensure_utc(start) > ensure_utc(end):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "The sprint must end on or after its start date")


def _members(db, project_id: int) -> list[int]:
    return list(db.scalars(select(ProjectMember.user_id).where(ProjectMember.project_id == project_id)))


# --------------------------------------------------------------------------- #
# Read
# --------------------------------------------------------------------------- #
@router.get("/projects/{project_id}/sprints", response_model=list[SprintOut], summary="A project's sprints")
def list_sprints(project_id: int, user: CurrentUser, db: DbSession):
    require_member(db, user, project_id)
    order = {SprintStatus.ACTIVE: 0, SprintStatus.PLANNED: 1, SprintStatus.COMPLETED: 2}
    sprints = list(db.scalars(select(Sprint).where(Sprint.project_id == project_id)).unique())
    sprints.sort(key=lambda s: (order[s.status], -(s.completed_at.timestamp()) if s.completed_at else 0,
                                s.start_date or s.created_at, s.id))
    return [_out(db, user, s) for s in sprints]


@router.get("/sprints/active", response_model=list[SprintOut], summary="Active sprints in my projects")
def active_sprints(user: CurrentUser, db: DbSession):
    from ..permissions import is_admin

    stmt = select(Sprint).where(Sprint.status == SprintStatus.ACTIVE)
    if not is_admin(user):
        stmt = stmt.where(Sprint.project_id.in_(select(ProjectMember.project_id).where(ProjectMember.user_id == user.id)))
    return [_out(db, user, s) for s in db.scalars(stmt.order_by(Sprint.end_date)).unique()]


@router.get("/sprints/{sprint_id}", response_model=SprintOut)
def get_sprint(sprint_id: int, user: CurrentUser, db: DbSession):
    return _out(db, user, _get(db, user, sprint_id))


@router.get("/sprints/{sprint_id}/burndown", response_model=list[BurndownPoint],
            summary="Open tickets left per day vs. an ideal straight line")
def burndown(sprint_id: int, user: CurrentUser, db: DbSession):
    """Built from the sprint's current tickets and their completion times (tickets moved out are not counted)."""
    sprint = _get(db, user, sprint_id)
    if not (sprint.start_date and sprint.end_date):
        return []
    start, end = _local_date(sprint.start_date), _local_date(sprint.end_date)
    today = _local_date(utcnow())
    tickets = list(sprint.tickets)
    total = len(tickets)
    days = (end - start).days
    out = []
    for i in range(days + 1):
        day = start + timedelta(days=i)
        remaining = None
        if day <= today or sprint.status == SprintStatus.COMPLETED:
            done = sum(1 for t in tickets if t.status in CLOSED_STATUSES and t.completed_at
                       and _local_date(t.completed_at) <= day)
            remaining = total - done
        out.append(BurndownPoint(date=day.isoformat(), remaining=remaining,
                                 ideal=round(total * (1 - i / days), 2) if days else 0))
    return out


# --------------------------------------------------------------------------- #
# Manage (project owners / admins)
# --------------------------------------------------------------------------- #
@router.post("/projects/{project_id}/sprints", response_model=SprintOut, status_code=status.HTTP_201_CREATED)
def create_sprint(project_id: int, payload: SprintCreate, user: CurrentUser, db: DbSession):
    require_owner(db, user, project_id)
    _check_dates(payload.start_date, payload.end_date)
    count = db.scalar(select(func.count()).select_from(Sprint).where(Sprint.project_id == project_id)) or 0
    name = (payload.name or "").strip() or f"Sprint {count + 1}"
    sprint = Sprint(project_id=project_id, name=name, goal=payload.goal, start_date=ensure_utc(payload.start_date),
                    end_date=ensure_utc(payload.end_date), created_by=user.id)
    db.add(sprint)
    db.commit()
    db.refresh(sprint)
    return _out(db, user, sprint)


@router.patch("/sprints/{sprint_id}", response_model=SprintOut)
def update_sprint(sprint_id: int, payload: SprintUpdate, user: CurrentUser, db: DbSession):
    sprint = _manageable(db, user, sprint_id)
    data = payload.model_dump(exclude_unset=True)
    if "name" in data:
        if not (data["name"] or "").strip():
            raise HTTPException(422, "name cannot be empty")
        data["name"] = data["name"].strip()
    for key in ("start_date", "end_date"):
        if key in data:
            data[key] = ensure_utc(data[key])
    _check_dates(data.get("start_date", sprint.start_date), data.get("end_date", sprint.end_date))
    if "goal" in data and data["goal"] is None:
        data["goal"] = ""
    for key, value in data.items():
        setattr(sprint, key, value)
    db.commit()
    db.refresh(sprint)
    return _out(db, user, sprint)


@router.delete("/sprints/{sprint_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_sprint(sprint_id: int, user: CurrentUser, db: DbSession):
    """Only a planned sprint can be deleted; its tickets go back to the backlog."""
    sprint = _manageable(db, user, sprint_id)
    if sprint.status != SprintStatus.PLANNED:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Only a planned sprint can be deleted - complete an active one instead")
    for t in list(sprint.tickets):
        log_activity(db, t, user, "sprint_moved", "sprint", sprint.name, None)
        t.sprint_id = None
    db.delete(sprint)
    db.commit()


@router.post("/sprints/{sprint_id}/start", response_model=SprintOut)
def start_sprint(sprint_id: int, user: CurrentUser, db: DbSession):
    sprint = _manageable(db, user, sprint_id)
    if sprint.status != SprintStatus.PLANNED:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"{sprint.name} is already active")
    running = db.scalar(select(Sprint).where(Sprint.project_id == sprint.project_id, Sprint.status == SprintStatus.ACTIVE))
    if running:
        raise HTTPException(status.HTTP_409_CONFLICT, f"{running.name} is still active - complete it first")
    now = utcnow()
    # default start: midnight today in the team's time zone
    sprint.start_date = sprint.start_date or now.astimezone(_tz()).replace(hour=0, minute=0, second=0, microsecond=0)
    sprint.end_date = sprint.end_date or (sprint.start_date + DEFAULT_LENGTH - timedelta(seconds=1))
    sprint.status = SprintStatus.ACTIVE
    sprint.started_at = now
    days = _days_between(sprint.start_date, sprint.end_date) + 1
    notify(db, _members(db, sprint.project_id), actor=user, type=NotificationType.SPRINT,
           message=f"{sprint.project.key} {sprint.name} started - {len(sprint.tickets)} tickets over {days} days"
                   + (f". Goal: {sprint.goal[:120]}" if sprint.goal else ""))
    db.commit()
    db.refresh(sprint)
    return _out(db, user, sprint)


@router.post("/sprints/{sprint_id}/complete", response_model=SprintOut)
def complete_sprint(sprint_id: int, payload: SprintCompleteIn, user: CurrentUser, db: DbSession):
    sprint = _manageable(db, user, sprint_id)
    if sprint.status != SprintStatus.ACTIVE:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Only the active sprint can be completed")
    target = None
    if payload.move_open_to is not None:
        target = db.get(Sprint, payload.move_open_to)
        if target is None or target.project_id != sprint.project_id or target.status != SprintStatus.PLANNED:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unfinished tickets can only move to a planned sprint of this project")
    tickets = list(sprint.tickets)
    done = [t for t in tickets if t.status in CLOSED_STATUSES]
    unfinished = [t for t in tickets if t.status not in CLOSED_STATUSES]
    for t in unfinished:
        log_activity(db, t, user, "sprint_moved", "sprint", sprint.name, target.name if target else None)
        t.sprint_id = target.id if target else None
    sprint.status = SprintStatus.COMPLETED
    sprint.completed_at = utcnow()
    where = target.name if target else "the backlog"
    notify(db, _members(db, sprint.project_id), actor=user, type=NotificationType.SPRINT,
           message=f"{sprint.project.key} {sprint.name} completed - {len(done)} of {len(tickets)} tickets done"
                   + (f", {len(unfinished)} moved to {where}" if unfinished else ""))
    db.commit()
    db.refresh(sprint)
    return _out(db, user, sprint)


@router.post("/projects/{project_id}/sprint-moves", summary="Move tickets into a sprint, or back to the backlog")
def move_tickets(project_id: int, payload: SprintMoveIn, user: CurrentUser, db: DbSession):
    require_owner(db, user, project_id)
    target = None
    if payload.sprint_id is not None:
        target = db.get(Sprint, payload.sprint_id)
        if target is None or target.project_id != project_id:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "That sprint is not part of this project")
        if target.status == SprintStatus.COMPLETED:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"{target.name} is completed")
    ids = list(dict.fromkeys(payload.ticket_ids))
    tickets = {t.id: t for t in db.scalars(select(Ticket).where(Ticket.id.in_(ids))).unique()}
    bad = [str(i) for i in ids if i not in tickets or tickets[i].project_id != project_id]
    if bad:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Not tickets of this project: {', '.join(bad)}")
    locked = [t.key for t in tickets.values() if t.sprint and t.sprint.status == SprintStatus.COMPLETED and t.status in CLOSED_STATUSES]
    if locked:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Finished in a completed sprint: {', '.join(locked)}")
    moved = 0
    for t in tickets.values():
        if t.sprint_id == (target.id if target else None):
            continue
        log_activity(db, t, user, "sprint_moved", "sprint", t.sprint.name if t.sprint else None, target.name if target else None)
        t.sprint_id = target.id if target else None
        moved += 1
    db.commit()
    return {"moved": moved, "sprint_id": target.id if target else None}
