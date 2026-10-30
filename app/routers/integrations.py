import re
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from .. import runtime_config, slack
from ..config import settings
from ..deps import AdminUser, DbSession
from ..jobs import build_daily_summary, check_overdue, send_daily_summary
from ..models import NotificationType

router = APIRouter(prefix="/integrations", tags=["Integrations (admin)"])


NOTIFY_TYPES = [t.value for t in NotificationType if t != NotificationType.CHAT_MENTION]  # chat stays in the app
DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


class SlackStatus(BaseModel):
    enabled: bool  # switched on and has somewhere to post
    switched_on: bool
    configured: bool
    mode: str | None  # "webhook" | "bot"
    channel: str | None
    notify_types: list[str] | str
    daily_summary_time: str | None
    daily_summary_days: list[str]
    timezone: str
    overdue_check_minutes: int
    scheduler_enabled: bool
    app_base_url: str
    # editable configuration (secrets masked) and where each value comes from: "panel" or "env"
    webhook_url_masked: str | None
    bot_token_masked: str | None
    sources: dict[str, str]
    all_notify_types: list[str]


class SlackConfigIn(BaseModel):
    """Omitted fields are unchanged. Secrets: "" removes the saved value. `reset` lists keys to return to .env."""

    enabled: bool | None = None
    webhook_url: str | None = Field(None, max_length=500)
    bot_token: str | None = Field(None, max_length=300)
    channel: str | None = Field(None, max_length=100)
    notify_types: list[str] | None = None  # empty list = none; all types = every type
    daily_summary_time: str | None = Field(None, max_length=5)  # "" turns the summary off
    daily_summary_days: list[str] | None = None
    timezone: str | None = Field(None, max_length=64)
    app_base_url: str | None = Field(None, max_length=300)
    reset: list[str] = []


def _mask(value: str, keep: int = 4) -> str | None:
    if not value:
        return None
    if value.startswith("https://"):
        head = value.split("/services/")[0] + "/services/" if "/services/" in value else value[:24]
        return f"{head}…{value[-keep:]}"
    prefix = value.split("-")[0] + "-" if "-" in value[:6] else ""
    return f"{prefix}…{value[-keep:]}"


def _status() -> SlackStatus:
    types = settings.slack_notify_types
    bot = bool(settings.SLACK_BOT_TOKEN and settings.SLACK_CHANNEL)
    return SlackStatus(
        enabled=settings.slack_enabled,
        switched_on=settings.SLACK_ENABLED,
        configured=settings.slack_configured,
        mode=("bot" if bot else "webhook") if settings.slack_configured else None,
        channel=settings.SLACK_CHANNEL or None,
        notify_types="all" if types is None else sorted(types),
        daily_summary_time=settings.SLACK_DAILY_SUMMARY_TIME.strip() or None,
        daily_summary_days=[d.strip() for d in settings.SLACK_DAILY_SUMMARY_DAYS.split(",") if d.strip()],
        timezone=settings.TIMEZONE,
        overdue_check_minutes=settings.OVERDUE_CHECK_MINUTES,
        scheduler_enabled=settings.SCHEDULER_ENABLED,
        app_base_url=settings.APP_BASE_URL,
        webhook_url_masked=_mask(settings.SLACK_WEBHOOK_URL),
        bot_token_masked=_mask(settings.SLACK_BOT_TOKEN),
        sources=runtime_config.sources(),
        all_notify_types=NOTIFY_TYPES,
    )


def _require_slack() -> None:
    if not settings.slack_configured:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Slack is not connected yet. Add a webhook URL (or a bot token and channel) on this page and save.",
        )
    if not settings.SLACK_ENABLED:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Slack is switched off. Turn it on and save first.")


@router.get("/slack", response_model=SlackStatus, summary="How the Slack integration is configured")
def slack_status(_admin: AdminUser):
    runtime_config.refresh_if_stale(0)
    return _status()


@router.put("/slack/config", response_model=SlackStatus, summary="Change the Slack connection from the admin panel")
def slack_config(payload: SlackConfigIn, admin: AdminUser, db: DbSession):
    changes: dict[str, object] = {}
    errors: list[str] = []

    if payload.enabled is not None:
        changes["slack_enabled"] = payload.enabled
    if payload.webhook_url is not None:
        url = payload.webhook_url.strip()
        if url and not re.match(r"^https://hooks\.slack(-gov)?\.com/\S+$", url):
            errors.append("Webhook URL must look like https://hooks.slack.com/services/…")
        changes["slack_webhook_url"] = url or None
    if payload.bot_token is not None:
        token = payload.bot_token.strip()
        if token and not re.match(r"^xox[bp]-[A-Za-z0-9-]+$", token):
            errors.append("Bot token must start with xoxb-")
        changes["slack_bot_token"] = token or None
    if payload.channel is not None:
        ch = payload.channel.strip()
        if ch and not re.match(r"^(#?[a-z0-9._-]{1,80}|[CGD][A-Z0-9]{6,15})$", ch):
            errors.append("Channel must be a channel ID like C0123ABCD or a name like #dev-tickets")
        changes["slack_channel"] = ch
    if payload.notify_types is not None:
        unknown = sorted(set(payload.notify_types) - set(NOTIFY_TYPES))
        if unknown:
            errors.append(f"Unknown notification types: {', '.join(unknown)}")
        chosen = [t for t in NOTIFY_TYPES if t in payload.notify_types]
        changes["slack_notify_types"] = "all" if len(chosen) == len(NOTIFY_TYPES) else ("none" if not chosen else ",".join(chosen))
    if payload.daily_summary_time is not None:
        t = payload.daily_summary_time.strip()
        if t and not re.match(r"^([01]\d|2[0-3]):[0-5]\d$", t):
            errors.append("Daily summary time must be HH:MM (24-hour)")
        changes["slack_daily_summary_time"] = t
    if payload.daily_summary_days is not None:
        days = [d.strip().lower()[:3] for d in payload.daily_summary_days]
        if set(days) - set(DAYS):
            errors.append("Days must be mon, tue, wed, thu, fri, sat or sun")
        changes["slack_daily_summary_days"] = ",".join(d for d in DAYS if d in days)
    if payload.timezone is not None:
        tz = payload.timezone.strip()
        try:
            ZoneInfo(tz)
        except Exception:  # noqa: BLE001
            errors.append(f"Unknown time zone '{tz}' (use a name like Asia/Kolkata)")
        changes["timezone"] = tz
    if payload.app_base_url is not None:
        base = payload.app_base_url.strip().rstrip("/")
        if not re.match(r"^https?://\S+$", base):
            errors.append("App address must start with http:// or https://")
        changes["app_base_url"] = base
    for key in payload.reset:
        if key not in runtime_config.EDITABLE:
            errors.append(f"Cannot reset '{key}'")
        changes[key] = None
    if errors:
        raise HTTPException(422, "; ".join(errors))
    runtime_config.save(db, changes, admin.id)
    return _status()


@router.delete("/slack/config", response_model=SlackStatus, summary="Forget panel settings and use .env again")
def slack_config_reset(_admin: AdminUser, db: DbSession):
    runtime_config.reset(db)
    return _status()


@router.get("/slack/channels", summary="Channels the bot can see (needs the channels:read scope)")
def slack_channels(_admin: AdminUser):
    if not settings.SLACK_BOT_TOKEN:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Save a bot token first")
    data = slack.api("conversations.list", {"types": "public_channel,private_channel", "exclude_archived": "true", "limit": "200"})
    if not data.get("ok"):
        hint = " - add the channels:read (and groups:read) scope to the Slack app" if data.get("error") == "missing_scope" else ""
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"Slack said: {data.get('error')}{hint}")
    return [{"id": c["id"], "name": c["name"], "is_member": c.get("is_member", False), "is_private": c.get("is_private", False)}
            for c in sorted(data.get("channels", []), key=lambda c: c["name"])]


@router.post("/slack/test", summary="Post a test message to the Slack channel")
def slack_test(admin: AdminUser):
    _require_slack()
    try:
        slack.post(f":wave: Test message from Grandesk, sent by {slack.person(admin.name, admin.email)}.")
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
