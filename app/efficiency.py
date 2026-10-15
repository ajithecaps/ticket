"""Developer efficiency metrics.

Cohort: every ticket whose *current* assignee received it (`assigned_at`) inside the chosen period
(all time when no dates are given). Measured as of "now".

Metric definitions
------------------
completion_rate        completed / assigned
on_time_rate           completed on or before due date / completed tickets that had a due date
first_time_right_rate  1 - (tickets that were ever reopened / tickets that ever reached "done")
avg_resolution_hours   mean(completed_at - assigned_at) over completed tickets
avg_time_to_start_hours mean(started_at - assigned_at) over tickets that were started
estimate_accuracy      mean of 1 - |spent - estimated| / estimated per completed ticket that has
                       both an estimate and logged time (each clamped to 0..1, so a 2x overrun and a
                       2x underrun do not cancel out)

efficiency_score (0-100)
    40% completion_rate + 40% on_time_rate + 20% first_time_right_rate
    Components that cannot be computed yet (None) are dropped and the remaining weights are
    re-normalised, so someone with no due dates is judged on completion and quality only.
"""
from collections import defaultdict
from datetime import datetime

from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from .models import CLOSED_STATUSES, ProjectMember, ProjectRole, Role, Ticket, TicketStatus, User
from .schemas import (
    DeveloperEfficiency,
    DeveloperEfficiencyDetail,
    EfficiencyReport,
    ProjectBreakdown,
    ProjectBrief,
    TeamSummary,
    UserBrief,
)
from .utils import utcnow

WEIGHTS = {"completion": 0.4, "on_time": 0.4, "first_time_right": 0.2}


def _mean(values: list[float]) -> float | None:
    return round(sum(values) / len(values), 2) if values else None


def _ratio(num: int, den: int) -> float | None:
    return round(num / den, 4) if den else None


def _hours(delta) -> float:
    return delta.total_seconds() / 3600


def score(completion: float | None, on_time: float | None, first_time_right: float | None) -> float | None:
    parts = [
        (WEIGHTS["completion"], completion),
        (WEIGHTS["on_time"], on_time),
        (WEIGHTS["first_time_right"], first_time_right),
    ]
    parts = [(w, v) for w, v in parts if v is not None]
    if not parts:
        return None
    return round(100 * sum(w * v for w, v in parts) / sum(w for w, _ in parts), 1)


def _metrics(user: User, tickets: list[Ticket], now: datetime) -> DeveloperEfficiency:
    done = [t for t in tickets if t.status in CLOSED_STATUSES]
    open_ = [t for t in tickets if t.status not in CLOSED_STATUSES]

    with_due = [t for t in done if t.due_date is not None and t.completed_at is not None]
    on_time = sum(1 for t in with_due if t.completed_at <= t.due_date)
    late = len(with_due) - on_time

    reopened = sum(1 for t in tickets if t.reopen_count > 0)
    ever_done = sum(1 for t in tickets if t.status in CLOSED_STATUSES or t.reopen_count > 0)

    resolution = [
        _hours(t.completed_at - t.assigned_at) for t in done if t.completed_at and t.assigned_at
    ]
    to_start = [_hours(t.started_at - t.assigned_at) for t in tickets if t.started_at and t.assigned_at]

    # Per ticket, so that over- and under-estimates cannot cancel each other out.
    per_ticket_accuracy = [
        max(0.0, min(1.0, 1 - abs(t.spent_hours - t.estimated_hours) / t.estimated_hours))
        for t in done
        if t.estimated_hours and t.spent_hours
    ]
    accuracy = (
        round(sum(per_ticket_accuracy) / len(per_ticket_accuracy), 4) if per_ticket_accuracy else None
    )

    completion_rate = _ratio(len(done), len(tickets))
    on_time_rate = _ratio(on_time, len(with_due))
    ftr_rate = None if not ever_done else round(1 - reopened / ever_done, 4)

    return DeveloperEfficiency(
        user=UserBrief.model_validate(user),
        assigned=len(tickets),
        completed=len(done),
        open=len(open_),
        in_progress=sum(1 for t in tickets if t.status == TicketStatus.IN_PROGRESS),
        blocked=sum(1 for t in tickets if t.status == TicketStatus.BLOCKED),
        overdue_open=sum(1 for t in open_ if t.due_date is not None and t.due_date < now),
        completed_on_time=on_time,
        completed_late=late,
        tickets_reopened=reopened,
        completion_rate=completion_rate,
        on_time_rate=on_time_rate,
        first_time_right_rate=ftr_rate,
        avg_resolution_hours=_mean(resolution),
        avg_time_to_start_hours=_mean(to_start),
        estimated_hours=round(sum(t.estimated_hours or 0 for t in tickets), 2),
        spent_hours=round(sum(t.spent_hours or 0 for t in tickets), 2),
        estimate_accuracy=accuracy,
        efficiency_score=score(completion_rate, on_time_rate, ftr_rate),
    )


def _cohort(
    db: Session,
    date_from: datetime | None,
    date_to: datetime | None,
    project_id: int | None,
    user_id: int | None,
) -> dict[int, list[Ticket]]:
    stmt = select(Ticket).where(Ticket.assignee_id.is_not(None))
    if project_id is not None:
        stmt = stmt.where(Ticket.project_id == project_id)
    if user_id is not None:
        stmt = stmt.where(Ticket.assignee_id == user_id)
    if date_from is not None:
        stmt = stmt.where(Ticket.assigned_at >= date_from)
    if date_to is not None:
        stmt = stmt.where(Ticket.assigned_at < date_to)  # exclusive upper bound
    by_user: dict[int, list[Ticket]] = defaultdict(list)
    for ticket in db.scalars(stmt).unique():
        by_user[ticket.assignee_id].append(ticket)
    return by_user


def build_report(
    db: Session,
    *,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    project_id: int | None = None,
) -> EfficiencyReport:
    now = utcnow()
    cohort = _cohort(db, date_from, date_to, project_id, None)

    # Roster: active people who are *developers* in a project (owner-only managers are left out), plus
    # anybody who actually holds tickets in the period, so idle developers show up with 0 assigned.
    developer_ids = select(ProjectMember.user_id).where(ProjectMember.role == ProjectRole.DEVELOPER)
    if project_id is not None:
        developer_ids = developer_ids.where(ProjectMember.project_id == project_id)
    roster = and_(User.is_active.is_(True), User.role == Role.USER, User.id.in_(developer_ids))
    condition = or_(roster, User.id.in_(list(cohort))) if cohort else roster
    users = db.scalars(select(User).where(condition)).all()

    developers = [_metrics(u, cohort.get(u.id, []), now) for u in users]
    # best first; people without a score (nothing assigned yet) at the bottom
    developers.sort(key=lambda d: (d.efficiency_score is None, -(d.efficiency_score or 0), d.user.name.lower()))

    scored = [d.efficiency_score for d in developers if d.efficiency_score is not None]
    team = TeamSummary(
        developers=len(developers),
        assigned=sum(d.assigned for d in developers),
        completed=sum(d.completed for d in developers),
        overdue_open=sum(d.overdue_open for d in developers),
        avg_efficiency_score=round(sum(scored) / len(scored), 1) if scored else None,
    )
    return EfficiencyReport(
        date_from=date_from,
        date_to=date_to,
        project_id=project_id,
        generated_at=now,
        team=team,
        developers=developers,
    )


def build_detail(
    db: Session,
    user: User,
    *,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    project_id: int | None = None,
) -> DeveloperEfficiencyDetail:
    now = utcnow()
    tickets = _cohort(db, date_from, date_to, project_id, user.id).get(user.id, [])
    base = _metrics(user, tickets, now)

    per_project: dict[int, list[Ticket]] = defaultdict(list)
    for t in tickets:
        per_project[t.project_id].append(t)
    breakdown = []
    for pid, items in sorted(per_project.items(), key=lambda kv: items_name(kv[1])):
        done = sum(1 for t in items if t.status in CLOSED_STATUSES)
        breakdown.append(
            ProjectBreakdown(
                project=ProjectBrief.model_validate(items[0].project),
                assigned=len(items),
                completed=done,
                open=len(items) - done,
                overdue_open=sum(
                    1 for t in items if t.status not in CLOSED_STATUSES and t.due_date and t.due_date < now
                ),
            )
        )
    by_status = {s.value: 0 for s in TicketStatus}
    for t in tickets:
        by_status[t.status.value] += 1
    return DeveloperEfficiencyDetail(**base.model_dump(), by_project=breakdown, by_status=by_status)


def items_name(tickets: list[Ticket]) -> str:
    return tickets[0].project.name.lower()
