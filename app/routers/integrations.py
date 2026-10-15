from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

from .. import slack
from ..config import settings
from ..deps import AdminUser, DbSession
from ..jobs import build_daily_summary, check_overdue, send_daily_summary

router = APIRouter(prefix="/integrations", tags=["Integrations (admin)"])


class SlackStatus(BaseModel):
    enabled: bool
    mode: str | None  # "webhook" | "bot"
    channel: str | None
    notify_types: list[str] | str
    daily_summary_time: str | None
    daily_summary_days: list[str]
    timezone: str
    overdue_check_minutes: int
    scheduler_enabled: bool
    app_base_url: str


def _require_slack() -> None:
    if not settings.slack_enabled:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Slack is not configured. Set SLACK_WEBHOOK_URL (or SLACK_BOT_TOKEN and SLACK_CHANNEL) in .env and restart.",
        )


@router.get("/slack", response_model=SlackStatus, summary="How the Slack integration is configured")
def slack_status(_admin: AdminUser):
    types = settings.slack_notify_types
    bot = bool(settings.SLACK_BOT_TOKEN and settings.SLACK_CHANNEL)
    return SlackStatus(
        enabled=settings.slack_enabled,
        mode=("bot" if bot else "webhook") if settings.slack_enabled else None,
        channel=settings.SLACK_CHANNEL or None if bot else None,
        notify_types="all" if types is None else sorted(types),
        daily_summary_time=settings.SLACK_DAILY_SUMMARY_TIME.strip() or None,
        daily_summary_days=[d.strip() for d in settings.SLACK_DAILY_SUMMARY_DAYS.split(",") if d.strip()],
        timezone=settings.TIMEZONE,
        overdue_check_minutes=settings.OVERDUE_CHECK_MINUTES,
        scheduler_enabled=settings.SCHEDULER_ENABLED,
        app_base_url=settings.APP_BASE_URL,
    )


@router.post("/slack/test", summary="Post a test message to the Slack channel")
def slack_test(admin: AdminUser):
    _require_slack()
    try:
        slack.post(f":wave: Test message from the ticket system, sent by {slack.person(admin.name, admin.email)}.")
    except slack.SlackError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc))
    return {"sent": True}


@router.get("/slack/daily-summary", summary="Preview today's summary without sending it")
def slack_summary_preview(_admin: AdminUser, db: DbSession):
    return {"text": build_daily_summary(db)}


@router.post("/slack/daily-summary", summary="Send the daily pending-tickets summary now")
def slack_summary_send(_admin: AdminUser):
    _require_slack()
    text = send_daily_summary()
    slack.flush()
    return {"sent": True, "text": text}


@router.post("/overdue-check", summary="Run the overdue check now (in-app + Slack alerts)")
def run_overdue_check(_admin: AdminUser, db: DbSession):
    alerted = check_overdue(db)
    slack.flush()
    return {"alerted": [t.key for t in alerted]}
