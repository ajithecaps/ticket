"""The personal motivator ("coach"): a small rule-based agent that looks at one person's open work and
says what to do next, why, and how the day is going.

* **Next task** - every open ticket gets a score: overdue and due-soon first, then priority, work
  already in progress (finish before starting), the active sprint; blocked / in-review work waits on
  somebody else so it sinks. The top one is the suggestion, with the reasons spelled out.
* **Daily goal and streak** - tickets finished today against the person's own goal, and how many days
  in a row they finished something (today counts once something is done; until then yesterday's run
  is still alive).
* **Tone** - the same facts in four voices (cheerful, calm, coach, witty), picked in the profile.
  Lines rotate by day so the coach doesn't repeat itself.

Everything is computed on request from the tickets themselves - nothing is stored except the
person's settings on `User`.
"""
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session

from .jobs import tz
from .models import (
    CLOSED_STATUSES,
    Project,
    SprintStatus,
    Ticket,
    TicketPriority,
    TicketStatus,
    User,
    assigned_to,
)
from .utils import ensure_utc, utcnow

PRIORITY_POINTS = {TicketPriority.CRITICAL: 45, TicketPriority.HIGH: 30, TicketPriority.MEDIUM: 12, TicketPriority.LOW: 0}
STALE_DAYS = 3

# Lines per tone and situation. {left} / {done} / {goal} / {streak} / {key} are filled in.
LINES = {
    "cheerful": {
        "empty": ["Your plate is clear - enjoy it, or grab something from the backlog!",
                  "Nothing assigned right now. A perfect moment to help a teammate?"],
        "fresh": ["A brand-new day! {goal} finished tickets and it's a win - start with {key}.",
                  "Let's get the first one over the line - {key} is a great place to begin.",
                  "Coffee, focus, {key}. You've got this!"],
        "started": ["{done} down, {left} to go - you're on a roll!",
                    "Nice momentum! Just {left} more to hit today's goal.",
                    "Look at you go - {done} done already. Keep it up!"],
        "goal": ["Goal smashed - {done} finished today! Anything extra is a bonus.",
                 "You did it! {done} tickets done. Take a bow (and some water).",
                 "Daily goal reached. The team is lucky to have you!"],
        "overdue": ["{key} is waiting for some love - let's clear it first, then the rest feels lighter.",
                    "A quick win first: {key} is past its date. You can do it!"],
    },
    "calm": {
        "empty": ["No open work. A good time to rest, learn or tidy the backlog.",
                  "All clear for now."],
        "fresh": ["One thing at a time. Begin with {key}.",
                  "Today's intention: {goal} finished tickets. {key} first.",
                  "Breathe, then start {key}. Steady wins."],
        "started": ["{done} finished. {left} left for today - no rush, keep a steady pace.",
                    "Good progress. Next, {key}."],
        "goal": ["Today's goal is complete. Well done - pace yourself.",
                 "{done} finished. That's enough to be proud of today."],
        "overdue": ["{key} is past its date. Settle it first, or ask to move the date - either is fine.",
                    "Start with {key}; it's overdue and will ease your mind once it's done."],
    },
    "coach": {
        "empty": ["Nothing assigned? Go find the next thing that moves the team forward.",
                  "Empty queue. Ask your owner what's next - don't wait for it."],
        "fresh": ["Zero done. Change that - {key}, now.",
                  "Goal is {goal}. Clock's running. Start {key}.",
                  "Champions start early. {key} is yours."],
        "started": ["{done} down. {left} to go. No coasting.",
                    "Good - now do it again. {key} is next.",
                    "Halfway thinking is how goals get missed. {left} more."],
        "goal": ["Goal hit. Now raise the bar tomorrow.",
                 "{done} done. That's the standard - keep it."],
        "overdue": ["{key} is overdue. Excuses don't ship - finish it.",
                    "Overdue work first. {key}. Go."],
    },
    "witty": {
        "empty": ["Your queue is emptier than the office fridge on Friday.",
                  "No tickets. Suspicious. Enjoy it before someone notices."],
        "fresh": ["{key} won't close itself. (We checked.)",
                  "Today's forecast: {goal} tickets with a strong chance of greatness. Start with {key}.",
                  "Plot twist: you finish {key} before lunch."],
        "started": ["{done} done, {left} to go. The tickets are getting nervous.",
                    "Halfway hero. {left} more and you can brag in chat.",
                    "{done} closed. The backlog fears you."],
        "goal": ["Goal achieved. You may now update your status to 'legend'.",
                 "{done} done! Somewhere a project manager just smiled and doesn't know why."],
        "overdue": ["{key} is overdue. It's been sending you passive-aggressive vibes.",
                    "{key}'s due date called. It wants to know where you are."],
    },
}

CHEERS = {
    "cheerful": ["Boom! {key} is done 🎉", "Yes! {key} finished - high five! ✋", "Another one bites the dust: {key} 🎉"],
    "calm": ["{key} is done. Nicely handled.", "{key} finished. One less thing to hold."],
    "coach": ["{key} done. Next.", "That's how it's done. {key} closed."],
    "witty": ["{key}: closed. Mic: dropped. 🎤", "{key} has left the building. 🕺", "{key} done. Your keyboard deserves a raise."],
}


def local_zone(user: User) -> ZoneInfo:
    if user.timezone:
        try:
            return ZoneInfo(user.timezone)
        except Exception:  # noqa: BLE001 - a stale/unknown zone falls back to the server's
            pass
    return tz()


def _pick(options: list[str], user: User, day: date, salt: int = 0) -> str:
    return options[(day.toordinal() + user.id + salt) % len(options)]


def _score(t: Ticket, now: datetime, today: date, zone: ZoneInfo) -> tuple[int, list[str], str]:
    score, reasons = 0, []
    due = ensure_utc(t.due_date)
    if due:
        days = (due.astimezone(zone).date() - today).days
        if due < now:
            late = max((today - due.astimezone(zone).date()).days, 0)
            score += 100 + min(late, 10) * 3
            reasons.append("Overdue" + (f" by {late} day{'s' if late != 1 else ''}" if late else ""))
        elif days == 0:
            score += 80
            reasons.append("Due today")
        elif days == 1:
            score += 60
            reasons.append("Due tomorrow")
        elif days <= 3:
            score += 40
            reasons.append(f"Due in {days} days")
        elif days <= 7:
            score += 15
            reasons.append(f"Due in {days} days")
    if t.priority in (TicketPriority.CRITICAL, TicketPriority.HIGH):
        reasons.append(f"{t.priority.value.capitalize()} priority")
    score += PRIORITY_POINTS[t.priority]

    action = "start"
    if t.status == TicketStatus.IN_PROGRESS:
        score += 30
        action = "continue"
        reasons.append("Already started - finish before starting more")
        idle = (now - ensure_utc(t.updated_at)).days
        if idle >= STALE_DAYS:
            score += 10
            reasons.append(f"No update for {idle} days")
    elif t.status == TicketStatus.BLOCKED:
        score -= 60
        action = "unblock"
        reasons.append("Blocked - needs someone else first")
    elif t.status == TicketStatus.IN_REVIEW:
        score -= 40
        action = "follow_up"
        reasons.append("Waiting for review")
    if t.sprint is not None and t.sprint.status == SprintStatus.ACTIVE:
        score += 15
        reasons.append(f"In the current sprint ({t.sprint.name})")
    return score, reasons or ["Next in your queue"], action


def streak_from(done_days: set[date], today: date) -> int:
    day = today if today in done_days else today - timedelta(days=1)
    n = 0
    while day in done_days:
        n += 1
        day -= timedelta(days=1)
    return n


def done_days(db: Session, user_id: int, zone: ZoneInfo, since: datetime) -> list[date]:
    """Local day of every ticket this person finished since `since` (one entry per ticket)."""
    rows = db.scalars(
        select(Ticket.completed_at).where(
            assigned_to(user_id), Ticket.status.in_(CLOSED_STATUSES), Ticket.completed_at >= since
        )
    ).all()
    return [ensure_utc(c).astimezone(zone).date() for c in rows if c]


def open_tickets(db: Session, user_id: int) -> list[Ticket]:
    return list(db.scalars(
        select(Ticket).join(Project, Project.id == Ticket.project_id).where(
            assigned_to(user_id),
            Ticket.status.not_in(CLOSED_STATUSES),
            Ticket.release_id.is_(None),
            Project.is_active.is_(True),
        )
    ).unique())


def build(db: Session, user: User, *, event: str | None = None, key: str | None = None) -> dict:
    zone = local_zone(user)
    now = utcnow()
    local_now = now.astimezone(zone)
    today = local_now.date()

    tickets = open_tickets(db, user.id)
    scored = sorted(
        ((t, *_score(t, now, today, zone)) for t in tickets),
        key=lambda x: (-x[1], ensure_utc(x[0].due_date) or datetime.max.replace(tzinfo=now.tzinfo), x[0].id),
    )
    days = done_days(db, user.id, zone, now - timedelta(days=366))
    done_today = sum(1 for d in days if d == today)
    done_week = sum(1 for d in days if (today - d).days < 7)
    streak = streak_from(set(days), today)
    goal = user.daily_goal or 2

    overdue = [t for t in tickets if t.due_date and ensure_utc(t.due_date) < now]
    due_today = [t for t in tickets if t.due_date and ensure_utc(t.due_date) >= now
                 and ensure_utc(t.due_date).astimezone(zone).date() == today]
    in_progress = [t for t in tickets if t.status == TicketStatus.IN_PROGRESS]
    blocked = [t for t in tickets if t.status == TicketStatus.BLOCKED]

    next_t = scored[0][0] if scored else None
    if not tickets:
        mood = "empty"
    elif done_today >= goal:
        mood = "goal"
    elif overdue and next_t in overdue:
        mood = "overdue"
    elif done_today:
        mood = "started"
    else:
        mood = "fresh"
    tone = user.coach_tone if user.coach_tone in LINES else "cheerful"
    fill = {"left": max(goal - done_today, 0), "done": done_today, "goal": goal, "streak": streak,
            "key": next_t.key if next_t else ""}
    message = _pick(LINES[tone][mood], user, today).format(**fill)

    hour = local_now.hour
    part = "morning" if hour < 12 else "afternoon" if hour < 17 else "evening"
    greeting = f"Good {part}, {user.name.split()[0]}"

    nudges = []
    for t in overdue[:3]:
        nudges.append({"kind": "overdue", "key": t.key,
                       "text": f"{t.key} is past its due date - finish it, or ask an owner to move the date."})
    for t in in_progress:
        idle = (now - ensure_utc(t.updated_at)).days
        if idle >= STALE_DAYS:
            nudges.append({"kind": "stale", "key": t.key,
                           "text": f"{t.key} has had no update for {idle} days - a short comment keeps everyone in the loop."})
    for t in blocked[:2]:
        nudges.append({"kind": "blocked", "key": t.key,
                       "text": f"{t.key} is blocked - @mention whoever can unblock it."})
    if len(in_progress) >= 3:
        nudges.append({"kind": "wip", "key": None,
                       "text": f"{len(in_progress)} tickets in progress at once - finishing one beats starting another."})

    cheer = None
    if event == "done":
        cheer = _pick(CHEERS[tone], user, today, salt=done_today).format(key=key or "That one")
        if done_today == goal:
            cheer += " Daily goal reached!"
        elif done_today < goal:
            cheer += f" {goal - done_today} more for today's goal."

    return {
        "enabled": user.coach_enabled,
        "name": user.coach_name or "Spark",
        "tone": tone,
        "greeting": greeting,
        "message": message,
        "mood": mood,
        "cheer": cheer,
        "stats": {
            "done_today": done_today, "goal": goal, "streak": streak, "done_week": done_week,
            "open": len(tickets), "overdue": len(overdue), "due_today": len(due_today),
            "in_progress": len(in_progress), "blocked": len(blocked),
        },
        "queue": [{"ticket": t, "reasons": reasons, "action": action} for t, _, reasons, action in scored[:5]],
        "nudges": nudges[:5],
    }
