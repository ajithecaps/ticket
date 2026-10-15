"""Post messages to a Slack channel.

Two ways to connect (see README):

* ``SLACK_WEBHOOK_URL`` - an Incoming Webhook; posts to the channel it was created for.
* ``SLACK_BOT_TOKEN`` + ``SLACK_CHANNEL`` - a bot (``chat:write``, plus ``users:read.email`` to turn
  people into real @mentions by matching their e-mail address).

Notifications are queued on the database session and only sent once that transaction commits, so a
rolled-back request never reaches Slack. Sending happens on one background thread so a slow or
unreachable Slack never delays an API response; failures are logged, not raised.
"""
from __future__ import annotations

import json
import logging
import queue
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass

from sqlalchemy import event
from sqlalchemy.orm import Session

from .config import settings
from .models import NotificationType

logger = logging.getLogger("tickets.slack")

EMOJI = {
    NotificationType.TICKET_CREATED: ":new:",
    NotificationType.ASSIGNED: ":bust_in_silhouette:",
    NotificationType.UNASSIGNED: ":wave:",
    NotificationType.STATUS_CHANGED: ":arrows_counterclockwise:",
    NotificationType.TICKET_UPDATED: ":pencil2:",
    NotificationType.COMMENT: ":speech_balloon:",
    NotificationType.MENTION: ":speech_balloon:",
    NotificationType.PROJECT_MEMBER: ":busts_in_silhouette:",
    NotificationType.OVERDUE: ":alarm_clock:",
    NotificationType.UPCOMING: ":clipboard:",
}


class SlackError(RuntimeError):
    pass


# --------------------------------------------------------------------------- #
# Transport
# --------------------------------------------------------------------------- #
def _request(url: str, *, data: bytes | None, headers: dict[str, str]) -> tuple[int, str, dict]:
    req = urllib.request.Request(url, data=data, headers=headers, method="POST" if data is not None else "GET")
    try:
        with urllib.request.urlopen(req, timeout=10) as res:  # noqa: S310 - fixed Slack URLs
            return res.status, res.read().decode("utf-8", "replace"), dict(res.headers)
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace"), dict(exc.headers or {})


def api(method: str, params: dict) -> dict:
    """Call a Slack Web API method with the bot token."""
    headers = {"Authorization": f"Bearer {settings.SLACK_BOT_TOKEN}"}
    if method.startswith("users."):
        url = f"https://slack.com/api/{method}?{urllib.parse.urlencode(params)}"
        _, body, _ = _request(url, data=None, headers=headers)
    else:
        headers["Content-Type"] = "application/json; charset=utf-8"
        _, body, _ = _request(f"https://slack.com/api/{method}", data=json.dumps(params).encode(), headers=headers)
    return json.loads(body)


def post(text: str) -> None:
    """Post one message to the configured channel, retrying on rate limits. Raises SlackError."""
    if not settings.slack_enabled:
        raise SlackError("Slack is not configured (set SLACK_WEBHOOK_URL, or SLACK_BOT_TOKEN and SLACK_CHANNEL)")
    payload = {"text": text, "unfurl_links": False, "unfurl_media": False}
    for attempt in range(3):
        if settings.SLACK_BOT_TOKEN and settings.SLACK_CHANNEL:
            headers = {"Authorization": f"Bearer {settings.SLACK_BOT_TOKEN}", "Content-Type": "application/json; charset=utf-8"}
            status, body, resp_headers = _request(
                "https://slack.com/api/chat.postMessage",
                data=json.dumps({**payload, "channel": settings.SLACK_CHANNEL}).encode(), headers=headers,
            )
            if status == 200:
                data = json.loads(body)
                if data.get("ok"):
                    return
                if data.get("error") != "ratelimited":
                    raise SlackError(f"Slack rejected the message: {data.get('error')}")
        else:
            status, body, resp_headers = _request(
                settings.SLACK_WEBHOOK_URL, data=json.dumps(payload).encode(),
                headers={"Content-Type": "application/json"},
            )
            if status == 200:
                return
            if status != 429:
                raise SlackError(f"Slack webhook returned {status}: {body[:200]}")
        time.sleep(min(30, int(resp_headers.get("Retry-After", 2 ** attempt))))
    raise SlackError("Slack kept rate-limiting the message")


# --------------------------------------------------------------------------- #
# Formatting
# --------------------------------------------------------------------------- #
def escape(text: str) -> str:
    """Slack mrkdwn needs &, < and > escaped; everything else is literal."""
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def ticket_url(key: str) -> str:
    return f"{settings.APP_BASE_URL.rstrip('/')}/#/tickets/{key}"


def ticket_link(key: str, title: str | None = None) -> str:
    label = f"{key} {title}" if title else key
    if len(label) > 90:
        label = label[:87] + "..."
    return f"<{ticket_url(key)}|{escape(label)}>"


_slack_ids: dict[str, tuple[str | None, float]] = {}
_SLACK_ID_TTL = 6 * 3600


def person(name: str, email: str | None) -> str:
    """A real @mention when a bot token can find the user by e-mail, otherwise the bold name."""
    if email and settings.SLACK_BOT_TOKEN:
        cached = _slack_ids.get(email)
        if cached is None or cached[1] < time.time():
            slack_id = None
            try:
                data = api("users.lookupByEmail", {"email": email})
                slack_id = data["user"]["id"] if data.get("ok") else None
            except Exception:  # noqa: BLE001 - lookups are best effort
                logger.debug("Slack lookup failed for %s", email, exc_info=True)
            cached = (slack_id, time.time() + _SLACK_ID_TTL)
            _slack_ids[email] = cached
        if cached[0]:
            return f"<@{cached[0]}>"
    return f"*{escape(name)}*"


# --------------------------------------------------------------------------- #
# Background sender
# --------------------------------------------------------------------------- #
_queue: queue.Queue = queue.Queue()  # str, or a callable that returns the text
_worker: threading.Thread | None = None
_worker_lock = threading.Lock()


def _run() -> None:
    while True:
        item = _queue.get()
        try:
            if callable(item):
                item = item()  # build the text on this thread (may call Slack for @mention lookups)
            if item:
                post(item)
        except Exception:  # noqa: BLE001 - never let one message kill the sender
            logger.exception("Could not send a Slack message")
        finally:
            _queue.task_done()


def enqueue(message) -> None:
    """Send `message` (text, or a zero-arg callable returning text) in the background."""
    global _worker
    if not settings.slack_enabled:
        return
    with _worker_lock:
        if _worker is None or not _worker.is_alive():
            _worker = threading.Thread(target=_run, name="slack-sender", daemon=True)
            _worker.start()
    _queue.put(message)


def flush(timeout: float = 10.0) -> None:
    """Wait until queued messages have been handled (used by tests and the admin 'send now' actions)."""
    deadline = time.time() + timeout
    while _queue.unfinished_tasks and time.time() < deadline:
        time.sleep(0.02)


# --------------------------------------------------------------------------- #
# Mirroring in-app notifications
# --------------------------------------------------------------------------- #
@dataclass
class _Event:
    type: NotificationType
    message: str
    ticket_key: str | None
    ticket_title: str | None
    recipients: list[tuple[str, str]]  # (name, email)
    link: tuple[str, str] | None = None  # (url, label) for events that are not about a ticket


def wants(type_: NotificationType) -> bool:
    allowed = settings.slack_notify_types
    return settings.slack_enabled and (allowed is None or type_.value in allowed)


def queue_notification(db: Session, *, type: NotificationType, message: str, ticket, recipients, link=None) -> None:
    """Called by services.notify(); held on the session until it commits."""
    if not wants(type):
        return
    key = title = None
    if ticket is not None:
        try:
            key, title = ticket.key, ticket.title
        except Exception:  # noqa: BLE001 - a missing project relation must not break the request
            key = None
    db.info.setdefault("slack_events", []).append(
        _Event(type, message, key, title, [(u.name, u.email) for u in recipients], link)
    )


def _merge(events: list[_Event]) -> list[_Event]:
    """A comment that @mentions someone produces a 'mention' and a 'comment' notification; post it once."""
    mentions = {e.ticket_key: e for e in events if e.type == NotificationType.MENTION}
    out: list[_Event] = []
    for e in events:
        target = mentions.get(e.ticket_key) if e.type == NotificationType.COMMENT else None
        if target is not None:
            target.recipients += [r for r in e.recipients if r not in target.recipients]
            continue
        out.append(e)
    return out


def _render(e: _Event) -> str:
    text = escape(e.message)
    if e.ticket_key and e.ticket_title:
        # Swap the plain "KEY title" in the message for a link to the ticket.
        plain = escape(f"{e.ticket_key} {e.ticket_title}")
        text = text.replace(plain, ticket_link(e.ticket_key, e.ticket_title), 1) if plain in text else (
            f"{text} - {ticket_link(e.ticket_key)}"
        )
    if e.link:
        text += f" - <{e.link[0]}|{escape(e.link[1])}>"
    line = f"{EMOJI.get(e.type, ':bell:')} {text}"
    if e.recipients:
        line += "\n> For " + ", ".join(person(n, m) for n, m in e.recipients)
    return line


@event.listens_for(Session, "after_commit")
def _send_after_commit(session: Session) -> None:
    events = session.info.pop("slack_events", None)
    for e in _merge(events or []):
        enqueue(lambda e=e: _render(e))


@event.listens_for(Session, "after_soft_rollback")
def _drop_on_rollback(session: Session, _previous_transaction) -> None:
    session.info.pop("slack_events", None)
