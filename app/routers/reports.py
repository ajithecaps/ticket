from datetime import date, timedelta

from fastapi import APIRouter, HTTPException, Query, status
from sqlalchemy import case, func, select

from ..deps import AdminUser, DbSession
from ..efficiency import build_detail, build_report
from ..models import CLOSED_STATUSES, Project, Ticket, TicketPriority, TicketStatus, User
from ..schemas import (
    DeveloperEfficiencyDetail,
    EfficiencyReport,
    OverviewReport,
    ProjectBrief,
    ProjectOverview,
)
from ..utils import day_start, next_day_start, utcnow

router = APIRouter(prefix="/reports", tags=["Reports (admin)"])


def _range(date_from: date | None, date_to: date | None):
    if date_from and date_to and date_from > date_to:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "'from' must not be after 'to'")
    return day_start(date_from), next_day_start(date_to)


@router.get("/overview", response_model=OverviewReport, summary="Company-wide ticket dashboard numbers")
def overview(
    _admin: AdminUser,
    db: DbSession,
    project_id: int | None = Query(None, description="Limit to one project"),
):
    now = utcnow()
    week_ago = now - timedelta(days=7)
    scope = [Ticket.project_id == project_id] if project_id is not None else []
    not_done = Ticket.status.not_in(CLOSED_STATUSES)
    overdue = (Ticket.due_date.is_not(None)) & (Ticket.due_date < now) & not_done

    def count(*conditions) -> int:
        return db.scalar(select(func.count()).select_from(Ticket).where(*scope, *conditions)) or 0

    by_status = {s.value: 0 for s in TicketStatus}
    for st, n in db.execute(select(Ticket.status, func.count()).where(*scope).group_by(Ticket.status)):
        by_status[st.value] = n
    by_priority = {p.value: 0 for p in TicketPriority}
    for pr, n in db.execute(select(Ticket.priority, func.count()).where(*scope).group_by(Ticket.priority)):
        by_priority[pr.value] = n

    rows = db.execute(
        select(
            Project,
            func.count(Ticket.id),
            func.coalesce(func.sum(case((not_done, 1), else_=0)), 0),
            func.coalesce(func.sum(case((overdue, 1), else_=0)), 0),
        )
        .join(Ticket, Ticket.project_id == Project.id, isouter=True)
        .where(Project.id == project_id if project_id is not None else True)
        .group_by(Project.id)
        .order_by(Project.name)
    ).all()

    return OverviewReport(
        total_tickets=sum(by_status.values()),
        open_tickets=sum(v for k, v in by_status.items() if k not in {s.value for s in CLOSED_STATUSES}),
        overdue_open=count(overdue),
        unassigned_open=count(Ticket.assignee_id.is_(None), not_done),
        created_last_7_days=count(Ticket.created_at >= week_ago),
        completed_last_7_days=count(Ticket.completed_at.is_not(None), Ticket.completed_at >= week_ago),
        by_status=by_status,
        by_priority=by_priority,
        by_project=[
            ProjectOverview(
                project=ProjectBrief.model_validate(p), total=int(t), open=int(o), overdue=int(od)
            )
            for p, t, o, od in rows
        ],
    )


@router.get("/efficiency", response_model=EfficiencyReport, summary="Efficiency of every developer")
def efficiency(
    _admin: AdminUser,
    db: DbSession,
    date_from: date | None = Query(None, alias="from", description="Tickets assigned on/after this day (UTC)"),
    date_to: date | None = Query(None, alias="to", description="Tickets assigned on/before this day (UTC)"),
    project_id: int | None = Query(None, description="Only tickets / members of this project"),
):
    """Score formula and metric definitions are documented in `app/efficiency.py` and the README."""
    start, end = _range(date_from, date_to)
    return build_report(db, date_from=start, date_to=end, project_id=project_id)


@router.get(
    "/efficiency/{user_id}", response_model=DeveloperEfficiencyDetail, summary="One developer, with per-project breakdown"
)
def efficiency_for_user(
    user_id: int,
    _admin: AdminUser,
    db: DbSession,
    date_from: date | None = Query(None, alias="from"),
    date_to: date | None = Query(None, alias="to"),
    project_id: int | None = None,
):
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")
    start, end = _range(date_from, date_to)
    return build_detail(db, user, date_from=start, date_to=end, project_id=project_id)
