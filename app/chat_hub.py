"""Real-time delivery for team chat.

Every change that people should see live (new message, edit, reaction, typing, presence…) is written
as a row in `chat_events` inside the same transaction as the change itself. Each API worker runs one
`Hub` that tails that table and pushes new rows to the WebSockets it holds. That keeps several
workers (or machines) in sync through the database alone - no Redis needed - and an event is only
ever delivered once its transaction has committed.

Within a worker, a commit that added events wakes the hub straight away, so local delivery is
instant; other workers pick events up on their next poll (POLL_SECONDS).
"""
import asyncio
import json
import logging
import time
from collections import defaultdict
from datetime import timedelta

from sqlalchemy import delete, event, func, select, update
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool
from starlette.websockets import WebSocket, WebSocketState

from .database import SessionLocal
from .models import ChatChannel, ChatEvent, ChatMember, ChatPresence, ProjectMember, Role, User
from .utils import utcnow

logger = logging.getLogger("tickets.chat")

POLL_SECONDS = 0.4
HEARTBEAT_SECONDS = 25
ONLINE_WINDOW = timedelta(seconds=70)  # seen this recently = online
EVENT_TTL = timedelta(hours=1)
AUDIENCE_TTL = 5.0


# --------------------------------------------------------------------------- #
# Emitting (called from request handlers, inside their transaction)
# --------------------------------------------------------------------------- #
def emit(db: Session, type_: str, payload: dict, *, channel_id: int | None = None, user_ids=None) -> None:
    """Queue a real-time event. `user_ids` limits it to those people; otherwise the channel's audience
    gets it (or everybody, when there is no channel either)."""
    db.add(ChatEvent(
        channel_id=channel_id,
        user_ids=",".join(str(u) for u in sorted(set(user_ids))) if user_ids else "",
        type=type_,
        payload=json.dumps(payload, default=str),
    ))
    db.info["chat_events"] = True


@event.listens_for(Session, "after_commit")
def _wake_after_commit(session: Session) -> None:
    if session.info.pop("chat_events", False):
        hub.wake_soon()


@event.listens_for(Session, "after_rollback")
def _forget_after_rollback(session: Session) -> None:
    session.info.pop("chat_events", None)


# --------------------------------------------------------------------------- #
# Who may see a channel
# --------------------------------------------------------------------------- #
def channel_audience(db: Session, channel: ChatChannel) -> set[int]:
    """People who can read the channel. Project channels follow project membership (plus admins who
    joined); public channels are readable by all, but only members get their live events."""
    members = set(db.scalars(select(ChatMember.user_id).where(ChatMember.channel_id == channel.id)))
    if channel.project_id is None:
        return members
    team = set(db.scalars(select(ProjectMember.user_id).where(ProjectMember.project_id == channel.project_id)))
    admins = set(db.scalars(select(User.id).where(User.role == Role.ADMIN, User.id.in_(members)))) if members else set()
    return team | admins


def online_user_ids(db: Session) -> set[int]:
    since = utcnow() - ONLINE_WINDOW
    return set(db.scalars(select(ChatPresence.user_id).where(ChatPresence.last_seen >= since)))


# --------------------------------------------------------------------------- #
# The per-worker hub
# --------------------------------------------------------------------------- #
class Hub:
    def __init__(self) -> None:
        self.conns: dict[int, set[WebSocket]] = defaultdict(set)
        self.last_id: int | None = None
        self.loop: asyncio.AbstractEventLoop | None = None
        self.wake: asyncio.Event | None = None
        self.task: asyncio.Task | None = None
        self._audience: dict[int, tuple[float, set[int]]] = {}
        self._last_heartbeat = 0.0
        self._last_purge = 0.0

    # ---- lifecycle -------------------------------------------------------- #
    def ensure_started(self) -> None:
        if self.task is not None and not self.task.done():
            return
        self.loop = asyncio.get_running_loop()
        self.wake = asyncio.Event()
        self.task = self.loop.create_task(self._run())

    async def stop(self) -> None:
        if self.task:
            self.task.cancel()
            try:
                await self.task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        self.task = None

    def wake_soon(self) -> None:
        """Thread-safe: deliver freshly committed events now instead of on the next poll."""
        loop, wake = self.loop, self.wake
        if loop is None or wake is None or loop.is_closed():
            return
        try:
            loop.call_soon_threadsafe(wake.set)
        except RuntimeError:
            pass

    # ---- connections ------------------------------------------------------ #
    async def connect(self, ws: WebSocket, user_id: int) -> None:
        self.ensure_started()
        first = not self.conns.get(user_id)
        self.conns[user_id].add(ws)
        await run_in_threadpool(_touch_presence, [user_id], first)

    async def disconnect(self, ws: WebSocket, user_id: int) -> None:
        sockets = self.conns.get(user_id)
        if sockets is None:
            return
        sockets.discard(ws)
        if not sockets:
            self.conns.pop(user_id, None)
            await run_in_threadpool(_mark_offline, user_id)

    def is_connected(self, user_id: int) -> bool:
        return bool(self.conns.get(user_id))

    # ---- loop ------------------------------------------------------------- #
    async def _run(self) -> None:
        while True:
            try:
                if self.last_id is None:
                    self.last_id = await run_in_threadpool(_max_event_id)
                try:
                    await asyncio.wait_for(self.wake.wait(), POLL_SECONDS)
                except asyncio.TimeoutError:
                    pass
                self.wake.clear()
                if self.conns:
                    batch = await run_in_threadpool(self._collect, self.last_id, set(self.conns))
                    for event_id, recipients, message in batch:
                        self.last_id = event_id
                        await self._send(recipients, message)
                else:
                    self.last_id = await run_in_threadpool(_max_event_id)
                await self._housekeeping()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - keep delivering whatever happens
                logger.exception("chat hub loop failed; retrying")
                await asyncio.sleep(1)

    def _collect(self, after_id: int, connected: set[int]) -> list[tuple[int, set[int], str]]:
        out = []
        with SessionLocal() as db:
            rows = db.scalars(select(ChatEvent).where(ChatEvent.id > after_id).order_by(ChatEvent.id).limit(500)).all()
            for ev in rows:
                if ev.user_ids:
                    recipients = {int(x) for x in ev.user_ids.split(",") if x}
                elif ev.channel_id is not None:
                    recipients = self._channel_audience(db, ev.channel_id)
                else:
                    recipients = set(connected)
                recipients &= connected
                if ev.type == "channels" and ev.channel_id is not None:
                    self._audience.pop(ev.channel_id, None)
                message = json.dumps({"type": ev.type, "channel_id": ev.channel_id, **json.loads(ev.payload or "{}")})
                out.append((ev.id, recipients, message))
        return out

    def _channel_audience(self, db: Session, channel_id: int) -> set[int]:
        hit = self._audience.get(channel_id)
        now = time.monotonic()
        if hit and now - hit[0] < AUDIENCE_TTL:
            return set(hit[1])
        channel = db.get(ChatChannel, channel_id)
        people = channel_audience(db, channel) if channel else set()
        self._audience[channel_id] = (now, people)
        return set(people)

    async def _send(self, recipients: set[int], message: str) -> None:
        for uid in recipients:
            for ws in list(self.conns.get(uid, ())):
                if ws.application_state != WebSocketState.CONNECTED:
                    continue
                try:
                    await ws.send_text(message)
                except Exception:  # noqa: BLE001 - a dead socket is cleaned up by its own handler
                    pass

    async def _housekeeping(self) -> None:
        now = time.monotonic()
        if self.conns and now - self._last_heartbeat > HEARTBEAT_SECONDS:
            self._last_heartbeat = now
            await run_in_threadpool(_touch_presence, list(self.conns), False)
        if now - self._last_purge > 600:
            self._last_purge = now
            await run_in_threadpool(_purge_old_events)


def _max_event_id() -> int:
    with SessionLocal() as db:
        return db.scalar(select(func.max(ChatEvent.id))) or 0


def _touch_presence(user_ids: list[int], announce: bool) -> None:
    now = utcnow()
    with SessionLocal() as db:
        for uid in user_ids:
            row = db.get(ChatPresence, uid)
            was_online = row is not None and row.last_seen >= now - ONLINE_WINDOW
            if row is None:
                db.add(ChatPresence(user_id=uid, last_seen=now))
            else:
                row.last_seen = now
            if announce and not was_online:
                emit(db, "presence", {"user_id": uid, "online": True})
        db.commit()


def _mark_offline(user_id: int) -> None:
    with SessionLocal() as db:
        db.execute(update(ChatPresence).where(ChatPresence.user_id == user_id).values(last_seen=utcnow() - ONLINE_WINDOW * 2))
        emit(db, "presence", {"user_id": user_id, "online": False})
        db.commit()


def _purge_old_events() -> None:
    with SessionLocal() as db:
        db.execute(delete(ChatEvent).where(ChatEvent.created_at < utcnow() - EVENT_TTL))
        db.commit()


hub = Hub()
