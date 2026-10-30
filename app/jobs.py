"""Background jobs: overdue alerts and the daily Slack summary.

The scheduler is a daemon thread started with the app. When several worker processes run on one host
(`uvicorn --workers N`, the Docker image), a file lock in UPLOAD_DIR makes exactly one of them the
scheduler; the others keep retrying, so another takes over if that process stops. Running the API on
several hosts? Set SCHEDULER_ENABLED=false on all but one.
"""
from __future__ import annotations

import json
import logging
import threading
from collections import Counter, defaultdict
from datetime import datetime, time as dtime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from . import slack
from .config import settings
from .database import SessionLocal
from .models import (
    CLOSED_STATUSES,
    Activity,
    NotificationType,
    Project,
    ProjectMember,
    Ticket,
    TicketStatus,
    User,
)
from .permissions import project_owner_ids
from .services import log_activity, notify
from .utils import utcnow

logger = logging.getLogger("tickets.jobs")

OVERDUE_ACTION = "overdue_alert"
DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
SUMMARY_GRACE = timedelta(hours=2)  # after a restart, still send a summary that is at most this late


def tz() -> ZoneInfo:
    try:
        return ZoneInfo(settings.TIMEZONE)
    except Exception:  # noqa: BLE001
        logger.warning("Unknown TIMEZONE %r, using UTC", settings.TIMEZONE)
        return ZoneInfo("UTC")


def _fmt_day(dt: datetime) -> str:
    local = dt.astimezone(tz())
    return f"{local:%a} {local.day} {local:%b}"


# --------------------------------------------------------------------------- #
# Overdue alerts
# --------------------------------------------------------------------------- #
def check_overdue(db: Session) -> list[Ticket]:
    """Alert once for every open ticket that has passed its due date.

    Each alert is recorded as an `overdue_alert` activity holding the due date it was raised for, so
    it is sent once per due date: changing the due date and missing it again raises a new alert. Assignee and project
    owners get an in-app notification; Slack gets one combined message per run.
    """
    now = utcnow()
    tickets = list(
        db.scalars(
            select(Ticket)
            .join(Project, Project.id == Ticket.project_id)
            .where(
                Ticket.due_date.is_not(None),
                Ticket.due_date < now,
                Ticket.status.not_in(CLOSED_STATUSES),
                Project.is_active.is_(True),
            )
            .order_by(Ticket.due_date)
        ).unique()
    )
    if not tickets:
        return []

    # The due date each ticket was last alerted for (stored on the overdue_alert activity).
    alerted_for: dict[int, str | None] = {}
    for ticket_id, due in db.execute(
        select(Activity.ticket_id, Activity.new_value)
        .where(Activity.action == OVERDUE_ACTION, Activity.ticket_id.in_([t.id for t in tickets]))
        .order_by(Activity.id)
    ):
        alerted_for[ticket_id] = due
    fresh = []
    for t in tickets:
        if alerted_for.get(t.id) == t.due_date.isoformat():
            continue  # already alerted for this due date
        fresh.append(t)
        who = ", ".join(u.name for u in t.assignees) or "nobody"
        log_activity(db, t, None, OVERDUE_ACTION, "due_date", None, t.due_date.isoformat())
        notify(
            db, [*t.assignee_ids, *project_owner_ids(db, t.project_id)], actor=None, type=NotificationType.OVERDUE,
            message=f"{t.key} {t.title} is overdue - it was due {_fmt_day(t.due_date)} (assigned to {who})",
            ticket=t, slack=False,
        )
    if not fresh:
        return []

    lines = [
        (t.key, t.title, t.due_date, t.priority.value, [(u.name, u.email) for u in t.assignees])
        for t in fresh
    ]
    db.commit()
    if slack.wants(NotificationType.OVERDUE):
        slack.enqueue(lambda: _overdue_message(lines))
    return fresh


def _overdue_message(lines) -> str:
    head = f":alarm_clock: *{len(lines)} ticket{'s are' if len(lines) != 1 else ' is'} now overdue*"
    rows = []
    for key, title, due, priority, assignees in lines[:25]:
        who = ", ".join(slack.person(*a) for a in assignees) or "_unassigned_"
        rows.append(f"• {slack.ticket_link(key, title)} - due {_fmt_day(due)} · {priority} · {who}")
    if len(lines) > 25:
        rows.append(f"…and {len(lines) - 25} more")
    return "\n".join([head, *rows])


# --------------------------------------------------------------------------- #
# Daily summary
# --------------------------------------------------------------------------- #
OPEN_ORDER = [TicketStatus.TODO, TicketStatus.IN_PROGRESS, TicketStatus.BLOCKED, TicketStatus.IN_REVIEW]
STATUS_LABEL = {
    TicketStatus.TODO: "to do", TicketStatus.IN_PROGRESS: "in progress",
    TicketStatus.BLOCKED: "blocked", TicketStatus.IN_REVIEW: "in review",
}


def build_daily_summary(db: Session) -> str:
    """Pending (not done / verified) tickets per team member, plus team totals."""
    now = utcnow()
    open_tickets = list(
        db.scalars(
            select(Ticket)
            .join(Project, Project.id == Ticket.project_id)
            .where(Ticket.status.not_in(CLOSED_STATUSES), Project.is_active.is_(True))
        ).unique()
    )
    awaiting = db.scalar(
        select(func.count()).select_from(Ticket).join(Project, Project.id == Ticket.project_id)
        .where(Ticket.status == TicketStatus.DONE, Project.is_active.is_(True))
    ) or 0

    # Team = every active user who belongs to an active project (people with nothing pending are listed too).
    team = list(
        db.scalars(
            select(User)
            .where(
                User.is_active.is_(True),
                User.id.in_(
                    select(ProjectMember.user_id)
                    .join(Project, Project.id == ProjectMember.project_id)
                    .where(Project.is_active.is_(True))
                ),
            )
            .order_by(User.name)
        ).unique()
    )
    per_user: dict[int, Counter] = defaultdict(Counter)
    overdue: Counter = Counter()
    unassigned = 0
    for t in open_tickets:
        if t.assignee_id is None:
            unassigned += 1
            continue
        for uid in t.assignee_ids:  # a shared ticket is on everyone's plate
            per_user[uid][t.status] += 1
            if t.due_date and t.due_date < now:
                overdue[uid] += 1

    rows = []
    for u in sorted(team, key=lambda u: (-sum(per_user[u.id].values()), u.name.lower())):
        counts = per_user[u.id]
        total = sum(counts.values())
        if not total:
            rows.append(f"• {slack.person(u.name, u.email)} - :white_check_mark: nothing pending")
            continue
        parts = " · ".join(f"{counts[s]} {STATUS_LABEL[s]}" for s in OPEN_ORDER if counts[s])
        line = f"• {slack.person(u.name, u.email)} - *{total}* pending ({parts})"
        if overdue[u.id]:
            line += f" · :warning: *{overdue[u.id]} overdue*"
        rows.append(line)

    total_open = len(open_tickets)
    total_overdue = sum(1 for t in open_tickets if t.due_date and t.due_date < now)
    head = f":sunrise: *Pending tickets - {_fmt_day(now)}*"
    footer = [f"*Team:* {total_open} pending · {total_overdue} overdue · {awaiting} waiting for verification"]
    if unassigned:
        footer[0] += f" · {unassigned} unassigned"
    footer.append(f"<{settings.APP_BASE_URL.rstrip('/')}/#/tickets?overdue=1|Open overdue tickets> · "
                  f"<{settings.APP_BASE_URL.rstrip('/')}/#/|Open dashboard>")
    return "\n".join([head, *(rows or ["_No team members yet._"]), "", *footer])


def send_daily_summary() -> str:
    """Build in a fresh session and queue for Slack; returns the text (used by the admin 'send now')."""
    with SessionLocal() as db:
        text = build_daily_summary(db)
    slack.enqueue(text)
    return text


# --------------------------------------------------------------------------- #
# Scheduler
# --------------------------------------------------------------------------- #
class Scheduler:
    TICK_SECONDS = 30

    def __init__(self) -> None:
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._lock_file = None
        state_dir = Path(settings.UPLOAD_DIR)
        self._lock_path = state_dir / ".scheduler.lock"
        self._state_path = state_dir / ".scheduler-state.json"
        self._next_overdue = datetime.min.replace(tzinfo=ZoneInfo("UTC"))

    # -- leadership -------------------------------------------------------- #
    def _acquire(self) -> bool:
        if self._lock_file is not None:
            return True
        try:
            import fcntl
        except ImportError:  # Windows: single process assumed
            self._lock_file = True
            return True
        try:
            self._lock_path.parent.mkdir(parents=True, exist_ok=True)
            f = open(self._lock_path, "a+")  # noqa: SIM115 - held for the life of the process
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            try:
                f.close()
            except Exception:  # noqa: BLE001
                pass
            return False
        self._lock_file = f
        logger.info("This process runs the background jobs")
        return True

    # -- persisted state ---------------------------------------------------- #
    def _load(self) -> dict:
        try:
            return json.loads(self._state_path.read_text())
        except (OSError, ValueError):
            return {}

    def _save(self, state: dict) -> None:
        try:
            self._state_path.write_text(json.dumps(state))
        except OSError:
            logger.warning("Could not write %s", self._state_path)

    # -- jobs ---------------------------------------------------------------- #
    def summary_due(self, now_local: datetime, state: dict) -> bool:
        raw = settings.SLACK_DAILY_SUMMARY_TIME.strip()
        if not raw or not settings.slack_enabled:
            return False
        days = {d.strip().lower()[:3] for d in settings.SLACK_DAILY_SUMMARY_DAYS.split(",")}
        if DAYS[now_local.weekday()] not in days:
            return False
        try:
            hh, mm = (int(x) for x in raw.split(":"))
        except ValueError:
            logger.warning("SLACK_DAILY_SUMMARY_TIME must look like 10:00, got %r", raw)
            return False
        at = datetime.combine(now_local.date(), dtime(hh, mm), tzinfo=now_local.tzinfo)
        today = now_local.date().isoformat()
        return at <= now_local < at + SUMMARY_GRACE and state.get("summary_sent_on") != today

    def tick(self) -> None:
        from . import runtime_config

        runtime_config.refresh_if_stale()
        now = utcnow()
        if now >= self._next_overdue:
            self._next_overdue = now + timedelta(minutes=max(1, settings.OVERDUE_CHECK_MINUTES))
            with SessionLocal() as db:
                alerted = [t.key for t in check_overdue(db)]
            if alerted:
                logger.info("Overdue alerts sent for %s", ", ".join(alerted))

        state = self._load()
        now_local = now.astimezone(tz())
        if self.summary_due(now_local, state):
            state["summary_sent_on"] = now_local.date().isoformat()
            self._save(state)  # record first, so a crash can never send it twice
            send_daily_summary()
            logger.info("Daily Slack summary sent")

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                if self._acquire():
                    self.tick()
            except Exception:  # noqa: BLE001 - keep the scheduler alive
                logger.exception("Background job failed")
            self._stop.wait(self.TICK_SECONDS)

    def start(self) -> None:
        if not settings.SCHEDULER_ENABLED or self._thread is not None:
            return
        self._thread = threading.Thread(target=self._run, name="scheduler", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()


scheduler = Scheduler()
