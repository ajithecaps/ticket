"""One request for the dashboard: KPIs, created-vs-completed trend, workload, due soon, activity, releases.

Scope: admin - every active project; everyone else - the projects they belong to (optionally one).
Workload rows: admin - everyone in scope; project owner - the members of projects they own; developer - self.
"""
from collections import Counter, defaultdict
from datetime import timedelta

from fastapi import APIRouter, HTTPException, Query, status
from sqlalchemy import select

from ..deps import CurrentUser, DbSession
from ..models import (
    CLOSED_STATUSES, Activity, Project, ProjectMember, ProjectRole, Release, ReleaseStatus, Ticket, TicketStatus, User,
)
from ..permissions import is_admin
from ..schemas import (
    ActivityFeedItem, DashboardOut, ProjectBrief, ReleaseLine, TicketOut, TicketRef, TrendPoint, UserBrief, WorkloadRow,
)
from ..utils import ensure_utc, utcnow

router = APIRouter(tags=["Dashboard"])

OPEN_STATUSES = [TicketStatus.TODO, TicketStatus.IN_PROGRESS, TicketStatus.BLOCKED, TicketStatus.IN_REVIEW]


def _days(a, b) -> float:
    return (ensure_utc(b) - ensure_utc(a)).total_seconds() / 86400


@router.get("/dashboard", response_model=DashboardOut)
def dashboard(
    user: CurrentUser,
    db: DbSession,
    days: int = Query(30, ge=7, le=180),
    project_id: int | None = None,
):
    now = utcnow()
    today = now.date()
    start_day = today - timedelta(days=days - 1)
    since = ensure_utc(now.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=days - 1))
    prev_since = since - timedelta(days=days)

    # ---- scope
    active = select(Project.id).where(Project.is_active.is_(True))
    if is_admin(user):
        scope_ids = set(db.scalars(active))
        scope = "all"
    else:
        scope_ids = set(db.scalars(select(ProjectMember.project_id).where(
            ProjectMember.user_id == user.id, ProjectMember.project_id.in_(active))))
        scope = "member"
    if project_id is not None:
        if project_id not in scope_ids:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
        scope_ids = {project_id}

    if scope == "all":
        people_ids = set(db.scalars(select(ProjectMember.user_id).where(ProjectMember.project_id.in_(scope_ids or {0}))))
    else:
        owned = set(db.scalars(select(ProjectMember.project_id).where(
            ProjectMember.user_id == user.id, ProjectMember.role == ProjectRole.OWNER))) & scope_ids
        if owned:
            scope = "owned"
            people_ids = set(db.scalars(select(ProjectMember.user_id).where(ProjectMember.project_id.in_(owned))))
        else:
            people_ids = {user.id}

    tickets = list(db.scalars(select(Ticket).where(Ticket.project_id.in_(scope_ids or {0}))).unique())
    open_t = [t for t in tickets if t.status not in CLOSED_STATUSES]

    # ---- trend + KPIs
    created = Counter(ensure_utc(t.created_at).date() for t in tickets if ensure_utc(t.created_at) >= since)
    completed_t = [t for t in tickets if t.completed_at and ensure_utc(t.completed_at) >= since]
    completed = Counter(ensure_utc(t.completed_at).date() for t in completed_t)
    trend = [TrendPoint(date=(d := start_day + timedelta(days=i)).isoformat(), created=created[d], completed=completed[d])
             for i in range(days)]
    prev_created = sum(1 for t in tickets if prev_since <= ensure_utc(t.created_at) < since)
    prev_completed = sum(1 for t in tickets if t.completed_at and prev_since <= ensure_utc(t.completed_at) < since)
    cycle = [_days(t.started_at or t.assigned_at or t.created_at, t.completed_at) for t in completed_t]
    week_end = now + timedelta(days=7)
    kpis = {
        "open": len(open_t),
        "in_progress": sum(1 for t in open_t if t.status == TicketStatus.IN_PROGRESS),
        "blocked": sum(1 for t in open_t if t.status == TicketStatus.BLOCKED),
        "overdue": sum(1 for t in open_t if t.is_overdue),
        "due_week": sum(1 for t in open_t if t.due_date and now <= ensure_utc(t.due_date) <= week_end),
        "unassigned": sum(1 for t in open_t if t.assignee_id is None),
        "awaiting_verification": sum(1 for t in tickets if t.status == TicketStatus.DONE),
        "created": sum(created.values()),
        "created_prev": prev_created,
        "completed": len(completed_t),
        "completed_prev": prev_completed,
        "avg_cycle_days": round(sum(cycle) / len(cycle), 1) if cycle else None,
    }

    by_status = {s.value: 0 for s in [*OPEN_STATUSES, TicketStatus.DONE]}
    for t in tickets:
        if t.status.value in by_status and (t.status != TicketStatus.DONE or t.release_id is None):
            by_status[t.status.value] += 1
    by_priority = Counter(t.priority.value for t in open_t)

    # ---- workload
    per: dict[int, list[Ticket]] = defaultdict(list)
    for t in open_t:
        if t.assignee_id in people_ids:
            per[t.assignee_id].append(t)
    users = {u.id: u for u in db.scalars(select(User).where(User.id.in_(people_ids or {0}), User.is_active.is_(True)))}
    workload = []
    for uid, u in users.items():
        items = per.get(uid, [])
        counts = Counter(t.status.value for t in items)
        workload.append(WorkloadRow(
            user=UserBrief.model_validate(u),
            by_status={s.value: counts.get(s.value, 0) for s in OPEN_STATUSES},
            open=len(items),
            overdue=sum(1 for t in items if t.is_overdue),
            remaining_hours=round(sum(max(0.0, (t.estimated_hours or 0) - (t.spent_hours or 0)) for t in items), 1),
        ))
    workload.sort(key=lambda r: (-r.open, r.user.name.lower()))

    # ---- lists
    due_pool = [t for t in open_t if t.due_date and ensure_utc(t.due_date) <= week_end]
    if scope != "all" and scope != "owned":
        due_pool = [t for t in due_pool if t.assignee_id == user.id]
    due_soon = [TicketOut.model_validate(t) for t in sorted(due_pool, key=lambda t: ensure_utc(t.due_date))[:10]]

    acts = db.execute(
        select(Activity, Ticket).join(Ticket, Ticket.id == Activity.ticket_id)
        .where(Ticket.project_id.in_(scope_ids or {0}), Activity.action != "overdue_alert")
        .order_by(Activity.id.desc()).limit(20)
    ).unique().all()
    activity = [ActivityFeedItem(
        id=a.id, actor=UserBrief.model_validate(a.actor) if a.actor else None, action=a.action, field=a.field,
        old_value=a.old_value, new_value=a.new_value, created_at=a.created_at,
        ticket=TicketRef(id=t.id, key=t.key, status=t.status), ticket_title=t.title,
    ) for a, t in acts]

    rels = db.scalars(select(Release).where(Release.project_id.in_(scope_ids or {0}), Release.status == ReleaseStatus.PLANNED)
                      .order_by(Release.planned_date.is_(None), Release.planned_date).limit(5)).unique()
    releases = [ReleaseLine(id=r.id, project=ProjectBrief.model_validate(r.project), name=r.name,
                            planned_date=r.planned_date, ticket_count=len(r.tickets)) for r in rels]

    return DashboardOut(scope=scope, days=days, kpis=kpis, trend=trend, by_status=by_status,
                        by_priority={p: by_priority.get(p, 0) for p in ("critical", "high", "medium", "low")},
                        workload=workload, due_soon=due_soon, activity=activity, releases=releases)
