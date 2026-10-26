"""Team chat: project channels, public/private channels, direct messages, threads, reactions, pins,
files, search, read state and a WebSocket for live updates (see app/chat_hub.py)."""
import asyncio
import json
import mimetypes
import re
import uuid
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile, WebSocket, WebSocketDisconnect, status
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import and_, exists, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from ..chat_hub import channel_audience, emit, hub, online_user_ids
from ..config import settings
from ..database import SessionLocal
from ..deps import AdminUser, CurrentUser, DbSession
from ..models import (
    ChatCall,
    ChatCallInvite,
    ChatCallParticipant,
    ChatChannel,
    ChatFile,
    ChatMember,
    ChatMessage,
    ChatReaction,
    ChatSaved,
    NotificationType,
    Project,
    ProjectMember,
    ProjectRole,
    User,
)
from ..permissions import is_admin
from ..security import decode_access_token
from ..services import notify, remove_file
from ..utils import escape_like, safe_filename, utcnow
from .attachments import _save_upload

router = APIRouter(prefix="/chat", tags=["Team chat"])

MAX_BODY = 10_000
MAX_GROUP_DM = 9
CALL_GRACE_SECONDS = 20  # a dropped socket gets this long to reconnect before its calls are hung up
_EMAIL_MENTION = re.compile(r"(?<![\w.])@([A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})")
_BROADCAST = re.compile(r"(?<![\w.])@(channel|here|everyone)\b")
_EMOJI = re.compile(r"^\S{1,32}$")


# --------------------------------------------------------------------------- #
# Access
# --------------------------------------------------------------------------- #
def _membership(db: Session, channel_id: int, user_id: int) -> ChatMember | None:
    return db.get(ChatMember, (channel_id, user_id))


def _in_project(db: Session, project_id: int, user_id: int) -> bool:
    return db.get(ProjectMember, (project_id, user_id)) is not None


def _can_read(db: Session, ch: ChatChannel, user: User) -> bool:
    if ch.kind == "project":
        return is_admin(user) or _in_project(db, ch.project_id, user.id)
    if ch.kind == "channel" and not ch.is_private:
        return True
    return _membership(db, ch.id, user.id) is not None


def _can_post(db: Session, ch: ChatChannel, user: User) -> bool:
    if ch.archived:
        return False
    if ch.kind == "project":
        return _can_read(db, ch, user)
    return _membership(db, ch.id, user.id) is not None


def _can_manage(db: Session, ch: ChatChannel, user: User) -> bool:
    if is_admin(user):
        return True
    if ch.kind == "project":
        m = db.get(ProjectMember, (ch.project_id, user.id))
        return m is not None and m.role == ProjectRole.OWNER
    return ch.kind == "channel" and ch.created_by == user.id


def _channel_or_404(db: Session, channel_id: int, user: User) -> ChatChannel:
    ch = db.get(ChatChannel, channel_id)
    if ch is None or not _can_read(db, ch, user):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Conversation not found")
    return ch


def _message_or_404(db: Session, message_id: int, user: User) -> tuple[ChatMessage, ChatChannel]:
    msg = db.get(ChatMessage, message_id)
    if msg is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Message not found")
    ch = db.get(ChatChannel, msg.channel_id)
    if ch is None or not _can_read(db, ch, user):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Message not found")
    return msg, ch


def _max_message_id(db: Session, channel_id: int) -> int:
    return db.scalar(select(func.max(ChatMessage.id)).where(ChatMessage.channel_id == channel_id)) or 0


def _initial_read_id(db: Session, ch: ChatChannel, user_id: int) -> int:
    """Where a new read marker starts: history from before you joined the project counts as read."""
    since = None
    if ch.kind == "project":
        pm = db.get(ProjectMember, (ch.project_id, user_id))
        since = pm.joined_at if pm else None
    stmt = select(func.max(ChatMessage.id)).where(ChatMessage.channel_id == ch.id)
    if since is not None:
        stmt = stmt.where(ChatMessage.created_at < since)
    return db.scalar(stmt) or 0


def _ensure_member(db: Session, ch: ChatChannel, user: User) -> ChatMember:
    """Project channels give access through the project; the member row (read position, mute) is lazy."""
    m = _membership(db, ch.id, user.id)
    if m is None:
        m = ChatMember(channel_id=ch.id, user_id=user.id, last_read_id=_initial_read_id(db, ch, user.id))
        db.add(m)
        db.flush()
    return m


def _ensure_project_channels(db: Session, user: User, *, all_projects: bool = False) -> None:
    """Every active project has a channel; its members see it in their sidebar without joining."""
    projects = select(Project.id).where(Project.is_active.is_(True))
    if not all_projects:
        projects = projects.where(Project.id.in_(select(ProjectMember.project_id).where(ProjectMember.user_id == user.id)))
    missing = db.scalars(
        select(Project).where(Project.id.in_(projects), ~exists().where(ChatChannel.project_id == Project.id))
    ).all()
    for p in missing:
        db.add(ChatChannel(kind="project", name=p.key.lower(), topic=p.name, project_id=p.id, created_by=None))
    if missing:
        try:
            db.commit()
        except IntegrityError:  # another request created it first
            db.rollback()
    if all_projects:
        return
    # read-position rows for project channels this person can see but has never opened
    unseen = db.scalars(
        select(ChatChannel).where(
            ChatChannel.kind == "project",
            ChatChannel.project_id.in_(select(ProjectMember.project_id).where(ProjectMember.user_id == user.id)),
            ~exists().where(and_(ChatMember.channel_id == ChatChannel.id, ChatMember.user_id == user.id)),
        )
    ).unique().all()
    for ch in unseen:
        db.add(ChatMember(channel_id=ch.id, user_id=user.id, last_read_id=_initial_read_id(db, ch, user.id)))
    if unseen:
        try:
            db.commit()
        except IntegrityError:
            db.rollback()


# --------------------------------------------------------------------------- #
# Serialisation
# --------------------------------------------------------------------------- #
def _brief(u: User | None) -> dict | None:
    return {"id": u.id, "name": u.name, "email": u.email} if u else None


def _call_out(call: ChatCall) -> dict:
    active = [p.user_id for p in call.participants if p.left_at is None] if call.ended_at is None else []
    end = call.ended_at
    duration = int((end - call.answered_at).total_seconds()) if end and call.answered_at else None
    return {
        "id": call.id, "channel_id": call.channel_id, "message_id": call.message_id, "video": call.video,
        "started_by": call.started_by, "started_at": call.started_at, "answered_at": call.answered_at, "ended_at": call.ended_at,
        "active": call.ended_at is None, "duration_seconds": duration,
        "participant_ids": active, "joined_ids": sorted({p.user_id for p in call.participants}),
        "invited_ids": sorted(i.user_id for i in call.invites),
    }


def _message_out(m: ChatMessage) -> dict:
    grouped: dict[str, list[int]] = {}
    for r in sorted(m.reactions, key=lambda r: r.created_at):
        grouped.setdefault(r.emoji, []).append(r.user_id)
    return {
        "id": m.id,
        "channel_id": m.channel_id,
        "parent_id": m.parent_id,
        "user": _brief(m.user),
        "body": "" if m.deleted else m.body,
        "deleted": m.deleted,
        "pinned": m.pinned,
        "reply_count": m.reply_count,
        "last_reply_at": m.last_reply_at,
        "edited_at": m.edited_at,
        "created_at": m.created_at,
        "reactions": [{"emoji": e, "count": len(ids), "user_ids": ids} for e, ids in grouped.items()],
        "call": _call_out(m.call) if m.call else None,
        "files": [] if m.deleted else [
            {"id": f.id, "filename": f.filename, "content_type": f.content_type, "size": f.size,
             "is_image": f.content_type.startswith("image/")}
            for f in m.files
        ],
    }


def _display_name(ch: ChatChannel, members: list[User], me: User) -> str:
    if ch.kind == "project":
        return ch.project.name if ch.project else (ch.name or "project")
    if ch.kind == "channel":
        return ch.name or "channel"
    others = [u.name for u in members if u.id != me.id]
    return ", ".join(sorted(others)) if others else f"{me.name} (you)"


def _channel_out(db: Session, ch: ChatChannel, user: User, member: ChatMember | None, *, members: list[User] | None = None,
                 unread: int = 0, mentions: int = 0, member_count: int | None = None, last: ChatMessage | None = None) -> dict:
    if members is None and ch.kind == "dm":
        members = list(db.scalars(select(User).join(ChatMember, ChatMember.user_id == User.id).where(ChatMember.channel_id == ch.id)))
    return {
        "id": ch.id,
        "kind": ch.kind,
        "name": ch.name,
        "display_name": _display_name(ch, members or [], user),
        "topic": ch.topic,
        "is_private": ch.is_private or ch.kind == "dm",
        "archived": ch.archived,
        "project_id": ch.project_id,
        "project_key": ch.project.key if ch.project else None,
        "created_by": ch.created_by,
        "members": [_brief(u) for u in members] if ch.kind == "dm" else None,
        "member_count": member_count if member_count is not None else (len(members) if members is not None else None),
        "joined": member is not None,
        "muted": bool(member and member.muted),
        "last_read_id": member.last_read_id if member else 0,
        "unread": unread,
        "mentions": mentions,
        "last_message_at": ch.last_message_at,
        "last_message": ({"user_id": last.user_id, "body": last.body[:140], "has_files": bool(last.files)} if last and not last.deleted else None),
        "can_post": _can_post(db, ch, user),
        "can_manage": _can_manage(db, ch, user),
    }


def _mention_filter(user: User):
    return or_(
        ChatMessage.body.ilike(f"%@{escape_like(user.email)}%", escape="\\"),
        ChatMessage.body.like("%@channel%"),
        ChatMessage.body.like("%@here%"),
        ChatMessage.body.like("%@everyone%"),
    )


def _unread_counts(db: Session, user: User, channel_ids: list[int]) -> tuple[dict[int, int], dict[int, int]]:
    if not channel_ids:
        return {}, {}
    base = (
        select(ChatMessage.channel_id, func.count())
        .join(ChatMember, and_(ChatMember.channel_id == ChatMessage.channel_id, ChatMember.user_id == user.id))
        .where(
            ChatMessage.channel_id.in_(channel_ids),
            ChatMessage.id > ChatMember.last_read_id,
            ChatMessage.parent_id.is_(None),
            ChatMessage.deleted.is_(False),
            or_(ChatMessage.user_id.is_(None), ChatMessage.user_id != user.id),
        )
        .group_by(ChatMessage.channel_id)
    )
    unread = dict(db.execute(base).all())
    mentions = dict(db.execute(base.where(_mention_filter(user))).all())
    return unread, mentions


def _sidebar(db: Session, user: User) -> list[dict]:
    _ensure_project_channels(db, user)
    memberships = {m.channel_id: m for m in db.scalars(select(ChatMember).where(ChatMember.user_id == user.id))}
    channels = [
        c for c in db.scalars(select(ChatChannel).where(ChatChannel.id.in_(list(memberships)))).unique().all()
        if c.kind != "project" or _can_read(db, c, user)
    ]
    ids = [c.id for c in channels]
    unread, mentions = _unread_counts(db, user, ids)

    dm_ids = [c.id for c in channels if c.kind == "dm"]
    dm_members: dict[int, list[User]] = {}
    if dm_ids:
        for cid, u in db.execute(
            select(ChatMember.channel_id, User).join(User, User.id == ChatMember.user_id).where(ChatMember.channel_id.in_(dm_ids))
        ).all():
            dm_members.setdefault(cid, []).append(u)
    counts = dict(db.execute(
        select(ChatMember.channel_id, func.count()).where(ChatMember.channel_id.in_(ids)).group_by(ChatMember.channel_id)
    ).all()) if ids else {}
    project_counts = dict(db.execute(
        select(ProjectMember.project_id, func.count()).group_by(ProjectMember.project_id)
    ).all())

    last_ids = db.scalars(
        select(func.max(ChatMessage.id)).where(ChatMessage.channel_id.in_(ids), ChatMessage.parent_id.is_(None),
                                              ChatMessage.deleted.is_(False)).group_by(ChatMessage.channel_id)
    ).all() if ids else []
    last = {m.channel_id: m for m in db.scalars(select(ChatMessage).where(ChatMessage.id.in_(last_ids))).unique().all()} if last_ids else {}

    out = []
    for c in channels:
        is_dm = c.kind == "dm"
        n = unread.get(c.id, 0)
        out.append(_channel_out(
            db, c, user, memberships[c.id], members=dm_members.get(c.id, []) if is_dm else [],
            unread=n, mentions=n if is_dm else mentions.get(c.id, 0),
            member_count=project_counts.get(c.project_id, 0) if c.kind == "project" else counts.get(c.id, 0),
            last=last.get(c.id),
        ))
    return out


# --------------------------------------------------------------------------- #
# Channels
# --------------------------------------------------------------------------- #
class ChannelIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    topic: str = Field("", max_length=300)
    is_private: bool = False
    member_ids: list[int] = []


class ChannelPatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=80)
    topic: str | None = Field(None, max_length=300)
    archived: bool | None = None


class IdsIn(BaseModel):
    user_ids: list[int] = Field(default_factory=list, max_length=50)


class ReadIn(BaseModel):
    message_id: int
    unread: bool = False  # True: "mark unread from here"


class MuteIn(BaseModel):
    muted: bool


class BodyIn(BaseModel):
    body: str = Field(min_length=1, max_length=MAX_BODY)


class ReactionIn(BaseModel):
    emoji: str = Field(min_length=1, max_length=32)


def _slug(name: str) -> str:
    slug = re.sub(r"[^a-z0-9_-]+", "-", name.strip().lower().lstrip("#")).strip("-")[:60]
    if not slug:
        raise HTTPException(422, "Channel names can use letters, numbers, - and _")
    return slug


def _active_users(db: Session, ids) -> list[User]:
    ids = set(ids)
    users = list(db.scalars(select(User).where(User.id.in_(ids), User.is_active.is_(True)))) if ids else []
    if len(users) != len(ids):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Some of those people do not exist or are deactivated")
    return users


def _channel_changed(db: Session, ch: ChatChannel, extra_user_ids=()) -> None:
    """Tell everyone who can see the channel (and anyone just removed) to refresh it."""
    people = channel_audience(db, ch) | set(extra_user_ids)
    if people:
        emit(db, "channels", {}, channel_id=ch.id, user_ids=people)


@router.get("/channels", summary="My conversations with unread counts")
def list_channels(user: CurrentUser, db: DbSession):
    return _sidebar(db, user)


@router.get("/unread", summary="Unread totals for the navigation badge")
def unread_totals(user: CurrentUser, db: DbSession):
    items = _sidebar(db, user)
    return {
        "unread": sum(c["unread"] for c in items if not c["muted"]),
        "mentions": sum(c["mentions"] for c in items),
        "channels": sum(1 for c in items if c["unread"] and not c["muted"]),
    }


@router.get("/channels/browse", summary="Channels you can join")
def browse_channels(user: CurrentUser, db: DbSession):
    if is_admin(user):
        _ensure_project_channels(db, user, all_projects=True)
    joined = set(db.scalars(select(ChatMember.channel_id).where(ChatMember.user_id == user.id)))
    conds = [and_(ChatChannel.kind == "channel", ChatChannel.is_private.is_(False))]
    if is_admin(user):
        conds.append(ChatChannel.kind == "project")
    rows = db.scalars(select(ChatChannel).where(or_(*conds)).order_by(ChatChannel.archived, ChatChannel.name)).unique().all()
    counts = dict(db.execute(select(ChatMember.channel_id, func.count()).group_by(ChatMember.channel_id)).all())
    project_counts = dict(db.execute(select(ProjectMember.project_id, func.count()).group_by(ProjectMember.project_id)).all())
    return [
        {**_channel_out(db, c, user, _membership(db, c.id, user.id) if c.id in joined else None, members=[],
                        member_count=project_counts.get(c.project_id, 0) if c.kind == "project" else counts.get(c.id, 0))}
        for c in rows
    ]


@router.post("/channels", status_code=status.HTTP_201_CREATED, summary="Create a channel")
def create_channel(payload: ChannelIn, user: AdminUser, db: DbSession):
    """Only admins create channels (project channels are created automatically with each project)."""
    name = _slug(payload.name)
    if db.scalar(select(ChatChannel.id).where(ChatChannel.kind == "channel", ChatChannel.name == name)):
        raise HTTPException(status.HTTP_409_CONFLICT, f"#{name} already exists")
    people = _active_users(db, set(payload.member_ids) - {user.id})
    ch = ChatChannel(kind="channel", name=name, topic=payload.topic.strip(), is_private=payload.is_private, created_by=user.id)
    db.add(ch)
    db.flush()
    db.add(ChatMember(channel_id=ch.id, user_id=user.id))
    for u in people:
        db.add(ChatMember(channel_id=ch.id, user_id=u.id))
    db.flush()
    _channel_changed(db, ch)
    db.commit()
    return _channel_out(db, ch, user, _membership(db, ch.id, user.id), members=[], member_count=len(people) + 1)


@router.get("/channels/{channel_id}", summary="One conversation")
def get_channel(channel_id: int, user: CurrentUser, db: DbSession):
    ch = _channel_or_404(db, channel_id, user)
    member = _membership(db, ch.id, user.id)
    if member is None and ch.kind == "project":
        member = _ensure_member(db, ch, user)
        db.commit()
    count = (db.scalar(select(func.count()).select_from(ProjectMember).where(ProjectMember.project_id == ch.project_id))
             if ch.kind == "project" else
             db.scalar(select(func.count()).select_from(ChatMember).where(ChatMember.channel_id == ch.id)))
    return _channel_out(db, ch, user, member, member_count=count)


@router.patch("/channels/{channel_id}", summary="Rename, set the topic, archive")
def update_channel(channel_id: int, payload: ChannelPatch, user: CurrentUser, db: DbSession):
    ch = _channel_or_404(db, channel_id, user)
    manage = _can_manage(db, ch, user)
    if payload.topic is not None:
        if not (manage or _can_post(db, ch, user)):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Join the conversation to change its topic")
        ch.topic = payload.topic.strip()
    if payload.name is not None:
        if ch.kind != "channel" or not manage:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the channel's creator or an admin can rename it")
        name = _slug(payload.name)
        if name != ch.name and db.scalar(select(ChatChannel.id).where(ChatChannel.kind == "channel", ChatChannel.name == name)):
            raise HTTPException(status.HTTP_409_CONFLICT, f"#{name} already exists")
        ch.name = name
    if payload.archived is not None:
        if ch.kind == "dm" or not manage:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the channel's creator, a project owner or an admin can archive it")
        ch.archived = payload.archived
    _channel_changed(db, ch)
    db.commit()
    return get_channel(channel_id, user, db)


@router.post("/channels/{channel_id}/join", summary="Join a public channel")
def join_channel(channel_id: int, user: CurrentUser, db: DbSession):
    ch = _channel_or_404(db, channel_id, user)
    if ch.kind == "dm" or (ch.kind == "channel" and ch.is_private):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You need an invitation to join this conversation")
    _ensure_member(db, ch, user)
    _channel_changed(db, ch, [user.id])
    db.commit()
    return get_channel(channel_id, user, db)


@router.post("/channels/{channel_id}/leave", status_code=status.HTTP_204_NO_CONTENT, summary="Leave a channel")
def leave_channel(channel_id: int, user: CurrentUser, db: DbSession):
    ch = _channel_or_404(db, channel_id, user)
    if ch.kind == "project" and _in_project(db, ch.project_id, user.id):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Project channels follow project membership - mute it instead")
    member = _membership(db, ch.id, user.id)
    if member is not None:
        _channel_changed(db, ch, [user.id])
        db.delete(member)
        db.commit()


@router.get("/channels/{channel_id}/members", summary="People in a conversation")
def channel_members(channel_id: int, user: CurrentUser, db: DbSession):
    ch = _channel_or_404(db, channel_id, user)
    ids = channel_audience(db, ch)
    online = online_user_ids(db)
    owners = set()
    if ch.kind == "project":
        owners = set(db.scalars(select(ProjectMember.user_id).where(
            ProjectMember.project_id == ch.project_id, ProjectMember.role == ProjectRole.OWNER)))
    elif ch.created_by:
        owners = {ch.created_by}
    people = db.scalars(select(User).where(User.id.in_(ids)).order_by(User.name)).all() if ids else []
    return [
        {**_brief(u), "designation": u.designation, "online": u.id in online, "is_active": u.is_active,
         "role": "admin" if is_admin(u) else ("owner" if u.id in owners else "member")}
        for u in people
    ]


@router.post("/channels/{channel_id}/members", summary="Add people to a channel")
def add_members(channel_id: int, payload: IdsIn, user: CurrentUser, db: DbSession):
    ch = _channel_or_404(db, channel_id, user)
    if ch.kind != "channel":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "People are added to project channels through the project, and to direct messages by starting a new one")
    if not is_admin(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only an admin can add people to a channel")
    added = []
    for u in _active_users(db, payload.user_ids):
        if _membership(db, ch.id, u.id) is None:
            db.add(ChatMember(channel_id=ch.id, user_id=u.id, last_read_id=0))
            added.append(u.id)
    db.flush()
    _channel_changed(db, ch)
    db.commit()
    return channel_members(channel_id, user, db)


@router.delete("/channels/{channel_id}/members/{user_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Remove someone")
def remove_member(channel_id: int, user_id: int, user: CurrentUser, db: DbSession):
    ch = _channel_or_404(db, channel_id, user)
    if ch.kind != "channel" or not is_admin(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only an admin can remove people from a channel")
    member = _membership(db, ch.id, user_id)
    if member is not None:
        _channel_changed(db, ch, [user_id])
        db.delete(member)
        db.commit()


@router.post("/dm", summary="Open (or create) a direct conversation with one or more people")
def open_dm(payload: IdsIn, user: CurrentUser, db: DbSession):
    wanted = set(payload.user_ids) | {user.id}
    if len(wanted) > MAX_GROUP_DM:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Group messages can have at most {MAX_GROUP_DM} people - create a channel instead")
    _active_users(db, wanted - {user.id})
    mine = select(ChatMember.channel_id).where(ChatMember.user_id == user.id)
    sets: dict[int, set[int]] = {}
    for cid, uid in db.execute(
        select(ChatMember.channel_id, ChatMember.user_id).join(ChatChannel, ChatChannel.id == ChatMember.channel_id)
        .where(ChatChannel.kind == "dm", ChatMember.channel_id.in_(mine))
    ).all():
        sets.setdefault(cid, set()).add(uid)
    found = next((cid for cid, s in sets.items() if s == wanted), None)
    if found is None:
        ch = ChatChannel(kind="dm", is_private=True, created_by=user.id)
        db.add(ch)
        db.flush()
        for uid in wanted:
            db.add(ChatMember(channel_id=ch.id, user_id=uid))
        db.commit()
        found = ch.id
    return get_channel(found, user, db)


@router.post("/channels/{channel_id}/read", summary="Move my read marker")
def mark_read(channel_id: int, payload: ReadIn, user: CurrentUser, db: DbSession):
    ch = _channel_or_404(db, channel_id, user)
    member = _membership(db, ch.id, user.id)
    if member is None:
        if ch.kind != "project":
            return {"last_read_id": 0}
        member = _ensure_member(db, ch, user)
    target = payload.message_id - 1 if payload.unread else payload.message_id
    if payload.unread or target > member.last_read_id:
        member.last_read_id = max(0, target)
        emit(db, "read", {"last_read_id": member.last_read_id}, channel_id=ch.id, user_ids=[user.id])
        db.commit()
    return {"last_read_id": member.last_read_id}


@router.post("/channels/{channel_id}/mute", summary="Mute or unmute a conversation")
def mute_channel(channel_id: int, payload: MuteIn, user: CurrentUser, db: DbSession):
    ch = _channel_or_404(db, channel_id, user)
    member = _ensure_member(db, ch, user) if ch.kind == "project" else _membership(db, ch.id, user.id)
    if member is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Join the conversation first")
    member.muted = payload.muted
    emit(db, "channels", {}, channel_id=ch.id, user_ids=[user.id])
    db.commit()
    return {"muted": member.muted}


# --------------------------------------------------------------------------- #
# Messages
# --------------------------------------------------------------------------- #
def _visible(stmt):
    # deleted messages stay only as placeholders for threads that still have replies
    return stmt.where(or_(ChatMessage.deleted.is_(False), ChatMessage.reply_count > 0))


@router.get("/channels/{channel_id}/messages", summary="Messages, newest page first (use before/after to page)")
def list_messages(
    channel_id: int, user: CurrentUser, db: DbSession,
    before: int | None = None, after: int | None = None, around: int | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
):
    ch = _channel_or_404(db, channel_id, user)
    base = _visible(select(ChatMessage).where(ChatMessage.channel_id == ch.id, ChatMessage.parent_id.is_(None)))
    if around is not None:
        older = db.scalars(base.where(ChatMessage.id <= around).order_by(ChatMessage.id.desc()).limit(limit // 2 + 1)).unique().all()
        newer = db.scalars(base.where(ChatMessage.id > around).order_by(ChatMessage.id).limit(limit // 2 + 1)).unique().all()
        has_more = len(older) > limit // 2
        has_newer = len(newer) > limit // 2
        rows = list(reversed(older[: limit // 2])) + list(newer[: limit // 2])
        return {"messages": [_message_out(m) for m in rows], "has_more": has_more, "has_newer": has_newer}
    if after is not None:
        rows = db.scalars(base.where(ChatMessage.id > after).order_by(ChatMessage.id).limit(limit + 1)).unique().all()
        return {"messages": [_message_out(m) for m in rows[:limit]], "has_more": False, "has_newer": len(rows) > limit}
    if before is not None:
        base = base.where(ChatMessage.id < before)
    rows = db.scalars(base.order_by(ChatMessage.id.desc()).limit(limit + 1)).unique().all()
    return {"messages": [_message_out(m) for m in reversed(rows[:limit])], "has_more": len(rows) > limit, "has_newer": False}


@router.get("/messages/{message_id}/thread", summary="A message and its replies")
def get_thread(message_id: int, user: CurrentUser, db: DbSession):
    msg, _ch = _message_or_404(db, message_id, user)
    if msg.parent_id is not None:
        msg, _ch = _message_or_404(db, msg.parent_id, user)
    replies = db.scalars(select(ChatMessage).where(ChatMessage.parent_id == msg.id, ChatMessage.deleted.is_(False))
                         .order_by(ChatMessage.id)).unique().all()
    return {"parent": _message_out(msg), "replies": [_message_out(r) for r in replies]}


@router.get("/channels/{channel_id}/pins", summary="Pinned messages")
def list_pins(channel_id: int, user: CurrentUser, db: DbSession):
    ch = _channel_or_404(db, channel_id, user)
    rows = db.scalars(select(ChatMessage).where(ChatMessage.channel_id == ch.id, ChatMessage.pinned.is_(True),
                                                ChatMessage.deleted.is_(False)).order_by(ChatMessage.id.desc())).unique().all()
    return [_message_out(m) for m in rows]


@router.get("/channels/{channel_id}/files", summary="Files shared in a conversation")
def list_files(channel_id: int, user: CurrentUser, db: DbSession):
    ch = _channel_or_404(db, channel_id, user)
    rows = db.execute(
        select(ChatFile, ChatMessage).join(ChatMessage, ChatMessage.id == ChatFile.message_id)
        .where(ChatMessage.channel_id == ch.id, ChatMessage.deleted.is_(False)).order_by(ChatFile.id.desc()).limit(200)
    ).unique().all()
    return [
        {"id": f.id, "filename": f.filename, "content_type": f.content_type, "size": f.size,
         "is_image": f.content_type.startswith("image/"), "message_id": m.id, "user": _brief(m.user), "created_at": m.created_at}
        for f, m in rows
    ]


def _chat_dir(channel_id: int) -> Path:
    return Path(settings.UPLOAD_DIR) / "chat" / str(channel_id)


def _notify_people(db: Session, ch: ChatChannel, msg: ChatMessage, author: User, parent: ChatMessage | None) -> None:
    """Inbox notifications: @mentions, replies to your message, and direct messages while you're away."""
    where = "a direct message" if ch.kind == "dm" else f"#{ch.name}"
    snippet = re.sub(r"\s+", " ", msg.body).strip()[:160] or "(file)"
    audience = channel_audience(db, ch)
    emails = {e.lower() for e in _EMAIL_MENTION.findall(msg.body)}
    mentioned = set(db.scalars(select(User.id).where(func.lower(User.email).in_(emails), User.id.in_(audience)))) if emails else set()
    if mentioned:
        notify(db, mentioned, actor=author, type=NotificationType.CHAT_MENTION, slack=False,
               message=f"{author.name} mentioned you in {where}: {snippet}")
    done = mentioned | {author.id}
    if parent is not None and parent.user_id and parent.user_id not in done and parent.user_id in audience:
        notify(db, [parent.user_id], actor=author, type=NotificationType.CHAT_MENTION, slack=False,
               message=f"{author.name} replied to your message in {where}: {snippet}")
        done.add(parent.user_id)
    if ch.kind == "dm":
        away = audience - done - online_user_ids(db)
        muted = set(db.scalars(select(ChatMember.user_id).where(ChatMember.channel_id == ch.id, ChatMember.muted.is_(True))))
        if away - muted:
            notify(db, away - muted, actor=author, type=NotificationType.CHAT_MENTION, slack=False,
                   message=f"{author.name} sent you a message: {snippet}")


@router.post("/channels/{channel_id}/messages", status_code=status.HTTP_201_CREATED, summary="Send a message (optionally with files)")
def send_message(
    channel_id: int, user: CurrentUser, db: DbSession,
    body: Annotated[str, Form(max_length=MAX_BODY)] = "",
    parent_id: Annotated[int | None, Form()] = None,
    files: Annotated[list[UploadFile] | None, File()] = None,
):
    ch = _channel_or_404(db, channel_id, user)
    if not _can_post(db, ch, user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "This conversation is archived" if ch.archived else "Join the channel to send messages")
    files = [f for f in (files or []) if f.filename]
    body = body.strip()
    if not body and not files:
        raise HTTPException(422, "Write a message or attach a file")
    if len(files) > settings.MAX_FILES_PER_REQUEST:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"At most {settings.MAX_FILES_PER_REQUEST} files per message")
    for f in files:
        ext = Path(safe_filename(f.filename)).suffix.lower()
        if ext in settings.blocked_extensions:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Files of type '{ext}' are not allowed")

    parent = None
    if parent_id is not None:
        parent = db.get(ChatMessage, parent_id)
        if parent is None or parent.channel_id != ch.id or parent.parent_id is not None or parent.deleted:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Thread not found")

    now = utcnow()
    msg = ChatMessage(channel_id=ch.id, user_id=user.id, parent_id=parent_id, body=body, created_at=now)
    db.add(msg)
    db.flush()

    saved: list[Path] = []
    try:
        if files:
            directory = _chat_dir(ch.id)
            directory.mkdir(parents=True, exist_ok=True)
            for f in files:
                name = safe_filename(f.filename)
                stored = f"{uuid.uuid4().hex}{Path(name).suffix.lower()}"
                dest = directory / stored
                size = _save_upload(f, dest)
                saved.append(dest)
                ctype = f.content_type or mimetypes.guess_type(name)[0] or "application/octet-stream"
                db.add(ChatFile(message_id=msg.id, filename=name, stored_name=stored, content_type=ctype[:120], size=size))
        if parent is not None:
            parent.reply_count += 1
            parent.last_reply_at = now
        else:
            ch.last_message_at = now
        member = _ensure_member(db, ch, user)
        if parent is None:
            member.last_read_id = max(member.last_read_id, msg.id)
        db.flush()
        db.refresh(msg)
        emit(db, "message.new", {"message": _message_out(msg)}, channel_id=ch.id)
        if parent is not None:
            db.refresh(parent)
            emit(db, "message.update", {"message": _message_out(parent)}, channel_id=ch.id)
        _notify_people(db, ch, msg, user, parent)
        db.commit()
    except BaseException:
        db.rollback()
        for p in saved:
            remove_file(p)
        raise
    return _message_out(msg)


@router.patch("/messages/{message_id}", summary="Edit your message")
def edit_message(message_id: int, payload: BodyIn, user: CurrentUser, db: DbSession):
    msg, ch = _message_or_404(db, message_id, user)
    if msg.user_id != user.id or msg.deleted:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You can only edit your own messages")
    if ch.archived:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "This conversation is archived")
    body = payload.body.strip()
    if not body:
        raise HTTPException(422, "A message cannot be empty")
    if body != msg.body:
        msg.body = body
        msg.edited_at = utcnow()
        db.flush()
        emit(db, "message.update", {"message": _message_out(msg)}, channel_id=ch.id)
        db.commit()
    return _message_out(msg)


@router.delete("/messages/{message_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Delete a message")
def delete_message(message_id: int, user: CurrentUser, db: DbSession):
    msg, ch = _message_or_404(db, message_id, user)
    if msg.user_id != user.id and not _can_manage(db, ch, user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You can only delete your own messages")
    paths = [_chat_dir(ch.id) / f.stored_name for f in msg.files]
    parent = db.get(ChatMessage, msg.parent_id) if msg.parent_id else None
    payload = {"id": msg.id, "parent_id": msg.parent_id}
    if msg.reply_count > 0:
        msg.deleted = True
        msg.body = ""
        msg.pinned = False
        msg.files.clear()
        db.flush()
        emit(db, "message.update", {"message": _message_out(msg)}, channel_id=ch.id)
    else:
        db.delete(msg)
        db.flush()
        emit(db, "message.delete", payload, channel_id=ch.id)
    if parent is not None:
        parent.reply_count = max(0, parent.reply_count - 1)
        if parent.deleted and parent.reply_count == 0:
            db.delete(parent)
            emit(db, "message.delete", {"id": parent.id, "parent_id": None}, channel_id=ch.id)
        else:
            db.flush()
            emit(db, "message.update", {"message": _message_out(parent)}, channel_id=ch.id)
    db.commit()
    for p in paths:
        remove_file(p)


@router.post("/messages/{message_id}/reactions", summary="Add or remove an emoji reaction")
def toggle_reaction(message_id: int, payload: ReactionIn, user: CurrentUser, db: DbSession):
    msg, ch = _message_or_404(db, message_id, user)
    if not _can_post(db, ch, user) or msg.deleted:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You cannot react here")
    emoji = payload.emoji.strip()
    if not _EMOJI.match(emoji):
        raise HTTPException(422, "Not a valid emoji")
    existing = db.get(ChatReaction, (msg.id, user.id, emoji))
    if existing:
        msg.reactions.remove(existing)
    else:
        if len({r.emoji for r in msg.reactions} | {emoji}) > 30:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Too many different reactions")
        msg.reactions.append(ChatReaction(message_id=msg.id, user_id=user.id, emoji=emoji, created_at=utcnow()))
    db.flush()
    emit(db, "message.update", {"message": _message_out(msg)}, channel_id=ch.id)
    db.commit()
    return _message_out(msg)


@router.post("/messages/{message_id}/pin", summary="Pin or unpin a message")
def toggle_pin(message_id: int, user: CurrentUser, db: DbSession):
    msg, ch = _message_or_404(db, message_id, user)
    if not _can_post(db, ch, user) or msg.deleted:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You cannot pin here")
    msg.pinned = not msg.pinned
    db.flush()
    emit(db, "message.update", {"message": _message_out(msg)}, channel_id=ch.id)
    db.commit()
    return _message_out(msg)


@router.get("/files/{file_id}", summary="Download a shared file")
def download_file(file_id: int, user: CurrentUser, db: DbSession, inline: bool = False):
    f = db.get(ChatFile, file_id)
    if f is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found")
    msg, ch = _message_or_404(db, f.message_id, user)
    path = _chat_dir(ch.id) / f.stored_name
    if not path.is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File is missing on the server")
    # Only images are ever shown inline; anything else downloads (no HTML/SVG rendering in our origin).
    show = inline and f.content_type in ("image/png", "image/jpeg", "image/gif", "image/webp")
    return FileResponse(path, media_type=f.content_type if show else "application/octet-stream", filename=f.filename,
                        content_disposition_type="inline" if show else "attachment",
                        headers={"X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=86400"})


# --------------------------------------------------------------------------- #
# Personal space: notes to self, saved items, links
# --------------------------------------------------------------------------- #
_URL = re.compile(r"https?://[^\s<>()\[\]\"'`]+[^\s<>()\[\]\"'`.,;:!?]")
_MD_LINK = re.compile(r"\[([^\]\n]{1,200})\]\((https?://[^)\s]+)\)")


def _links_in(body: str) -> list[tuple[str, str | None]]:
    """[(url, link text or None)] in order, without duplicates; code is ignored."""
    text = re.sub(r"```.*?```|`[^`\n]*`", " ", body or "", flags=re.S)
    out: dict[str, str | None] = {}
    for label, url in _MD_LINK.findall(text):
        out.setdefault(url, label.strip())
    for url in _URL.findall(_MD_LINK.sub(" ", text)):
        out.setdefault(url, None)
    return list(out.items())


def _self_dm(db: Session, user: User) -> ChatChannel:
    mine = select(ChatMember.channel_id).where(ChatMember.user_id == user.id)
    counts = (
        select(ChatMember.channel_id).join(ChatChannel, ChatChannel.id == ChatMember.channel_id)
        .where(ChatChannel.kind == "dm", ChatMember.channel_id.in_(mine))
        .group_by(ChatMember.channel_id).having(func.count() == 1)
    )
    cid = db.scalar(counts)
    if cid is not None:
        return db.get(ChatChannel, cid)
    ch = ChatChannel(kind="dm", is_private=True, created_by=user.id, topic="Notes, links and files just for you")
    db.add(ch)
    db.flush()
    db.add(ChatMember(channel_id=ch.id, user_id=user.id))
    db.commit()
    return ch


@router.post("/self", summary="My own space (notes to self) - created on first use")
def notes_to_self(user: CurrentUser, db: DbSession):
    return get_channel(_self_dm(db, user).id, user, db)


@router.post("/messages/{message_id}/save", summary="Save or unsave a message for yourself")
def toggle_saved(message_id: int, user: CurrentUser, db: DbSession):
    msg, _ch = _message_or_404(db, message_id, user)
    row = db.get(ChatSaved, (user.id, msg.id))
    if row:
        db.delete(row)
    else:
        if msg.deleted:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "This message was deleted")
        db.add(ChatSaved(user_id=user.id, message_id=msg.id))
    emit(db, "saved", {"message_id": msg.id, "saved": row is None}, user_ids=[user.id])
    db.commit()
    return {"message_id": msg.id, "saved": row is None}


@router.get("/saved/ids", summary="Ids of messages I saved")
def saved_ids(user: CurrentUser, db: DbSession):
    return list(db.scalars(select(ChatSaved.message_id).where(ChatSaved.user_id == user.id)))


def _where(db: Session, ch: ChatChannel, user: User) -> dict:
    members = list(db.scalars(select(User).join(ChatMember, ChatMember.user_id == User.id).where(ChatMember.channel_id == ch.id))) if ch.kind == "dm" else []
    return {"id": ch.id, "kind": ch.kind, "display_name": _display_name(ch, members, user)}


@router.get("/saved", summary="My saved items (messages, files and links), newest first")
def saved_items(
    user: CurrentUser, db: DbSession,
    kind: Annotated[str, Query(pattern="^(all|links|files)$")] = "all",
    q: str = "",
):
    rows = db.execute(
        select(ChatSaved, ChatMessage).join(ChatMessage, ChatMessage.id == ChatSaved.message_id)
        .where(ChatSaved.user_id == user.id, ChatMessage.deleted.is_(False)).order_by(ChatSaved.created_at.desc()).limit(500)
    ).unique().all()
    out, cache = [], {}
    for saved, m in rows:
        if m.channel_id not in cache:
            ch = db.get(ChatChannel, m.channel_id)
            cache[m.channel_id] = _where(db, ch, user) if ch and _can_read(db, ch, user) else None
        where = cache[m.channel_id]
        if where is None:
            continue  # lost access to that conversation
        links = _links_in(m.body)
        if kind == "links" and not links:
            continue
        if kind == "files" and not m.files:
            continue
        if q and q.lower() not in (m.body or "").lower() and not any(q.lower() in f.filename.lower() for f in m.files):
            continue
        out.append({**_message_out(m), "saved_at": saved.created_at, "channel": where,
                    "links": [{"url": u, "text": t} for u, t in links]})
    return out


@router.get("/channels/{channel_id}/links", summary="Links shared in a conversation")
def channel_links(channel_id: int, user: CurrentUser, db: DbSession):
    ch = _channel_or_404(db, channel_id, user)
    rows = db.scalars(
        select(ChatMessage).where(ChatMessage.channel_id == ch.id, ChatMessage.deleted.is_(False),
                                  or_(ChatMessage.body.like("%http://%"), ChatMessage.body.like("%https://%")))
        .order_by(ChatMessage.id.desc()).limit(1000)
    ).unique().all()
    out, seen = [], set()
    for m in rows:
        for url, text in _links_in(m.body):
            if url in seen:
                continue
            seen.add(url)
            out.append({"url": url, "text": text, "message_id": m.id, "parent_id": m.parent_id,
                        "user": _brief(m.user), "created_at": m.created_at, "pinned": m.pinned})
    return out


# --------------------------------------------------------------------------- #
# People, presence and search
# --------------------------------------------------------------------------- #
@router.get("/users", summary="People you can message, with who is online")
def chat_users(user: CurrentUser, db: DbSession):
    online = online_user_ids(db)
    rows = db.scalars(select(User).where(User.is_active.is_(True)).order_by(User.name)).all()
    return [{**_brief(u), "designation": u.designation, "role": u.role.value if hasattr(u.role, "value") else u.role,
             "online": u.id in online} for u in rows]


@router.get("/presence", summary="Who is online right now")
def presence(user: CurrentUser, db: DbSession):
    return {"online": sorted(online_user_ids(db))}


@router.get("/search", summary="Search messages in conversations you can read")
def search_messages(
    user: CurrentUser, db: DbSession,
    q: Annotated[str, Query(min_length=1, max_length=200)],
    channel_id: int | None = None, from_user: int | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
):
    readable = or_(
        ChatChannel.id.in_(select(ChatMember.channel_id).where(ChatMember.user_id == user.id)),
        and_(ChatChannel.kind == "channel", ChatChannel.is_private.is_(False)),
        and_(ChatChannel.kind == "project", True if is_admin(user) else
             ChatChannel.project_id.in_(select(ProjectMember.project_id).where(ProjectMember.user_id == user.id))),
    )
    stmt = (
        select(ChatMessage, ChatChannel).join(ChatChannel, ChatChannel.id == ChatMessage.channel_id)
        .where(readable, ChatMessage.deleted.is_(False))
    )
    for word in q.split()[:6]:
        stmt = stmt.where(ChatMessage.body.ilike(f"%{escape_like(word)}%", escape="\\"))
    if channel_id is not None:
        stmt = stmt.where(ChatMessage.channel_id == channel_id)
    if from_user is not None:
        stmt = stmt.where(ChatMessage.user_id == from_user)
    rows = db.execute(stmt.order_by(ChatMessage.id.desc()).limit(limit)).unique().all()
    out = []
    for m, ch in rows:
        members = list(db.scalars(select(User).join(ChatMember, ChatMember.user_id == User.id).where(ChatMember.channel_id == ch.id))) if ch.kind == "dm" else []
        out.append({**_message_out(m), "channel": {"id": ch.id, "kind": ch.kind, "display_name": _display_name(ch, members, user)}})
    return out


# --------------------------------------------------------------------------- #
# Audio / video calls (WebRTC; the server relays signalling only)
# --------------------------------------------------------------------------- #
class CallIn(BaseModel):
    video: bool = False


@router.get("/rtc-config", summary="ICE servers for WebRTC calls")
def rtc_config(_user: CurrentUser):
    servers = [{"urls": [u.strip() for u in settings.CHAT_STUN_URLS.split(",") if u.strip()]}]
    if settings.CHAT_TURN_URL:
        servers.append({"urls": [u.strip() for u in settings.CHAT_TURN_URL.split(",") if u.strip()],
                        "username": settings.CHAT_TURN_USERNAME, "credential": settings.CHAT_TURN_CREDENTIAL})
    return {"iceServers": [s for s in servers if s["urls"]], "maxPeople": settings.CHAT_MAX_CALL_PEOPLE}


def _active_call(db: Session, channel_id: int) -> ChatCall | None:
    call = db.scalar(select(ChatCall).where(ChatCall.channel_id == channel_id, ChatCall.ended_at.is_(None)).order_by(ChatCall.id.desc()))
    if call is not None and _close_if_empty(db, call):
        return None
    return call


def _close_if_empty(db: Session, call: ChatCall) -> bool:
    """Safety net: a call nobody is in any more is over (e.g. everyone's browser crashed)."""
    if call.ended_at is not None or any(p.left_at is None for p in call.participants):
        return False
    ch = db.get(ChatChannel, call.channel_id)
    if ch is not None:
        _end_call(db, call, ch)
        db.commit()
    return True


def _call_or_404(db: Session, call_id: int, user: User) -> tuple[ChatCall, ChatChannel]:
    call = db.get(ChatCall, call_id)
    ch = db.get(ChatChannel, call.channel_id) if call else None
    if call is None or ch is None or not (_can_read(db, ch, user) or _invited(call, user.id)):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Call not found")
    return call, ch


def _invited(call: ChatCall, user_id: int) -> bool:
    return any(i.user_id == user_id for i in call.invites)


def _call_people(db: Session, call: ChatCall, ch: ChatChannel) -> set[int]:
    """Everyone who should hear about the call: the conversation, plus anyone added to the call."""
    return channel_audience(db, ch) | {i.user_id for i in call.invites} | {p.user_id for p in call.participants}


def _participant(call: ChatCall, user_id: int) -> ChatCallParticipant | None:
    return next((p for p in call.participants if p.user_id == user_id), None)


def _call_changed(db: Session, call: ChatCall, ch: ChatChannel, type_: str = "call.update", **extra) -> None:
    db.flush()
    emit(db, type_, {"call": _call_out(call), **extra}, channel_id=ch.id, user_ids=_call_people(db, call, ch))
    if call.message_id:
        msg = db.get(ChatMessage, call.message_id)
        if msg is not None:
            db.expire(msg, ["call"])
            emit(db, "message.update", {"message": _message_out(msg)}, channel_id=ch.id)


def _end_call(db: Session, call: ChatCall, ch: ChatChannel) -> None:
    now = utcnow()
    call.ended_at = now
    for p in call.participants:
        if p.left_at is None:
            p.left_at = now
    _call_changed(db, call, ch, "call.ended")


def _channel_label(ch: ChatChannel, viewer: User | None = None) -> str:
    if ch.kind == "project":
        return ch.project.name if ch.project else (ch.name or "project")
    return f"#{ch.name}" if ch.kind == "channel" else "Direct message"


def _call_label(db: Session, call: ChatCall, ch: ChatChannel, viewer: User) -> str:
    if ch.kind != "dm":
        return _channel_label(ch)
    ids = {p.user_id for p in call.participants if p.left_at is None} | ({call.started_by} if call.started_by else set())
    names = sorted(db.scalars(select(User.name).where(User.id.in_(ids - {viewer.id})))) if ids - {viewer.id} else []
    return f"Call with {', '.join(names)}" if names else "Call"


@router.get("/calls/active", summary="Calls going on in conversations you can see")
def active_calls(user: CurrentUser, db: DbSession):
    out = []
    for call in db.scalars(select(ChatCall).where(ChatCall.ended_at.is_(None))).all():
        if _close_if_empty(db, call):
            continue
        ch = db.get(ChatChannel, call.channel_id)
        if ch and (_can_read(db, ch, user) or _invited(call, user.id)):
            out.append({**_call_out(call), "channel_label": _call_label(db, call, ch, user)})
    return out


@router.post("/channels/{channel_id}/calls", status_code=status.HTTP_201_CREATED, summary="Start a call (or join the one in progress)")
def start_call(channel_id: int, payload: CallIn, user: CurrentUser, db: DbSession):
    ch = _channel_or_404(db, channel_id, user)
    if not _can_post(db, ch, user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Join the conversation to call")
    existing = _active_call(db, ch.id)
    if existing is not None:
        return join_call(existing.id, user, db)
    now = utcnow()
    msg = ChatMessage(channel_id=ch.id, user_id=user.id, body="", created_at=now)
    db.add(msg)
    db.flush()
    call = ChatCall(channel_id=ch.id, message_id=msg.id, started_by=user.id, video=payload.video, started_at=now)
    call.participants.append(ChatCallParticipant(user_id=user.id, joined_at=now))
    db.add(call)
    ch.last_message_at = now
    _ensure_member(db, ch, user).last_read_id = msg.id
    db.flush()
    db.expire(msg, ["call"])
    emit(db, "message.new", {"message": _message_out(msg)}, channel_id=ch.id)
    ring_to = channel_audience(db, ch) - {user.id}
    if ring_to:
        muted = set(db.scalars(select(ChatMember.user_id).where(ChatMember.channel_id == ch.id, ChatMember.muted.is_(True))))
        emit(db, "call.ring", {"call": _call_out(call), "from": _brief(user), "channel_label": _channel_label(ch),
                               "channel_kind": ch.kind}, channel_id=ch.id, user_ids=ring_to - muted if ch.kind != "dm" else ring_to)
    db.commit()
    return {**_call_out(call), "channel_label": _channel_label(ch)}


@router.post("/calls/{call_id}/join", summary="Join a call")
def join_call(call_id: int, user: CurrentUser, db: DbSession):
    call, ch = _call_or_404(db, call_id, user)
    if call.ended_at is not None:
        raise HTTPException(status.HTTP_410_GONE, "This call has ended")
    if not (_can_post(db, ch, user) or _invited(call, user.id)):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Join the conversation to take part in the call")
    me_in = _participant(call, user.id)
    active = [p for p in call.participants if p.left_at is None and p.user_id != user.id]
    if len(active) >= settings.CHAT_MAX_CALL_PEOPLE:
        raise HTTPException(status.HTTP_409_CONFLICT, f"Calls are limited to {settings.CHAT_MAX_CALL_PEOPLE} people")
    now = utcnow()
    if me_in is None:
        call.participants.append(ChatCallParticipant(user_id=user.id, joined_at=now))
    else:
        me_in.left_at = None
        me_in.joined_at = now
    if call.answered_at is None and user.id != call.started_by:
        call.answered_at = now
    _call_changed(db, call, ch, joined=user.id)
    db.commit()
    return {**_call_out(call), "channel_label": _call_label(db, call, ch, user)}


def _lock_call(db: Session, call: ChatCall) -> None:
    """Re-read the call under a row lock so people hanging up at the same moment see each other."""
    db.refresh(call, with_for_update=True)
    db.expire(call, ["participants", "invites"])


def _leave(db: Session, call: ChatCall, ch: ChatChannel, user_id: int) -> None:
    _lock_call(db, call)
    p = _participant(call, user_id)
    if p is None or p.left_at is not None or call.ended_at is not None:
        return
    p.left_at = utcnow()
    db.flush()
    db.expire(call, ["participants"])  # pick up anyone else who left meanwhile
    still = [x for x in call.participants if x.left_at is None]
    # a 1:1 call ends when either side hangs up; group calls end when the last person leaves
    one_to_one = ch.kind == "dm" and len(channel_audience(db, ch)) <= 2 and not call.invites
    if not still or (one_to_one and call.answered_at is not None) or (len(still) == 1 and call.answered_at is None and still[0].user_id != call.started_by):
        _end_call(db, call, ch)
    else:
        _call_changed(db, call, ch, left=user_id)


@router.post("/calls/{call_id}/leave", summary="Hang up")
def leave_call(call_id: int, user: CurrentUser, db: DbSession):
    call, ch = _call_or_404(db, call_id, user)
    _leave(db, call, ch, user.id)
    db.commit()
    return _call_out(call)


@router.post("/calls/{call_id}/decline", summary="Decline a ringing call")
def decline_call(call_id: int, user: CurrentUser, db: DbSession):
    call, ch = _call_or_404(db, call_id, user)
    if call.ended_at is None:
        active = [p.user_id for p in call.participants if p.left_at is None]
        emit(db, "call.declined", {"call_id": call.id, "user": _brief(user)}, channel_id=ch.id, user_ids=active + [user.id])
        if ch.kind == "dm" and len(channel_audience(db, ch)) <= 2 and call.answered_at is None and not call.invites:
            _end_call(db, call, ch)
        db.commit()
    return _call_out(call)


class InviteIn(BaseModel):
    user_ids: list[int] = Field(min_length=1, max_length=20)


@router.post("/calls/{call_id}/invite", summary="Add people to a call that's already going (they get rung)")
def invite_to_call(call_id: int, payload: InviteIn, user: CurrentUser, db: DbSession):
    call, ch = _call_or_404(db, call_id, user)
    if call.ended_at is not None:
        raise HTTPException(status.HTTP_410_GONE, "This call has ended")
    me_in = _participant(call, user.id)
    if me_in is None or me_in.left_at is not None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Join the call to add people")
    people = _active_users(db, set(payload.user_ids) - {user.id})
    active = {p.user_id for p in call.participants if p.left_at is None}
    new = [u for u in people if u.id not in active]
    if not new:
        return {**_call_out(call), "channel_label": _call_label(db, call, ch, user)}
    if len(active) + len(new) > settings.CHAT_MAX_CALL_PEOPLE:
        raise HTTPException(status.HTTP_409_CONFLICT, f"Calls are limited to {settings.CHAT_MAX_CALL_PEOPLE} people")
    now = utcnow()
    for u in new:
        if not _invited(call, u.id):
            call.invites.append(ChatCallInvite(user_id=u.id, invited_by=user.id, invited_at=now))
    db.flush()
    for u in new:
        emit(db, "call.ring", {"call": _call_out(call), "from": _brief(user), "channel_label": _call_label(db, call, ch, u),
                               "channel_kind": "invite" if ch.kind == "dm" else ch.kind, "added": True},
             channel_id=ch.id, user_ids=[u.id])
    _call_changed(db, call, ch, invited=[u.id for u in new], by=user.id)
    db.commit()
    return {**_call_out(call), "channel_label": _call_label(db, call, ch, user)}


def _relay_signal(user: User, call_id: int, to: int, data: dict) -> None:
    with SessionLocal() as db:
        call = db.get(ChatCall, call_id)
        if call is None or call.ended_at is not None:
            return
        active = {p.user_id for p in call.participants if p.left_at is None}
        if user.id not in active or to not in active or to == user.id:
            return
        emit(db, "call.signal", {"call_id": call_id, "from": user.id, "data": data}, channel_id=call.channel_id, user_ids=[to])
        db.commit()


def _leave_calls_if_gone(user_id: int) -> None:
    """The socket dropped for good (tab closed, laptop asleep): hang up their calls."""
    with SessionLocal() as db:
        if user_id in online_user_ids(db):
            return
        rows = db.scalars(
            select(ChatCall).join(ChatCallParticipant, ChatCallParticipant.call_id == ChatCall.id)
            .where(ChatCall.ended_at.is_(None), ChatCallParticipant.user_id == user_id, ChatCallParticipant.left_at.is_(None))
        ).all()
        for call in rows:
            ch = db.get(ChatChannel, call.channel_id)
            if ch is not None:
                _leave(db, call, ch, user_id)
        db.commit()


# --------------------------------------------------------------------------- #
# WebSocket
# --------------------------------------------------------------------------- #
def _socket_user(token: str) -> User | None:
    uid = decode_access_token(token) if token else None
    if uid is None:
        return None
    with SessionLocal() as db:
        u = db.get(User, uid)
        if u is None or not u.is_active:
            return None
        db.expunge(u)
        return u


def _typing(user: User, channel_id: int, parent_id: int | None) -> bool:
    with SessionLocal() as db:
        ch = db.get(ChatChannel, channel_id)
        if ch is None or not _can_post(db, ch, user):
            return False
        emit(db, "typing", {"user_id": user.id, "name": user.name, "parent_id": parent_id}, channel_id=ch.id)
        db.commit()
        return True


@router.websocket("/ws")
async def chat_socket(ws: WebSocket, token: str = ""):
    """Live events for the signed-in person. Send {"type":"typing","channel_id":1} while typing and
    {"type":"ping"} to keep the connection alive; receive message.new / message.update /
    message.delete / typing / read / channels / presence."""
    user = await run_in_threadpool(_socket_user, token)
    if user is None:
        await ws.close(code=4401)
        return
    await ws.accept()
    await hub.connect(ws, user.id)
    try:
        await ws.send_json({"type": "hello", "user_id": user.id})
        while True:
            raw = await ws.receive_text()
            try:
                data = json.loads(raw)
            except ValueError:
                continue
            kind = data.get("type") if isinstance(data, dict) else None
            if kind == "ping":
                await ws.send_json({"type": "pong"})
            elif kind == "call.signal" and isinstance(data.get("call_id"), int) and isinstance(data.get("to"), int) \
                    and isinstance(data.get("data"), dict) and len(raw) < 64_000:
                await run_in_threadpool(_relay_signal, user, data["call_id"], data["to"], data["data"])
            elif kind == "typing" and isinstance(data.get("channel_id"), int):
                parent = data.get("parent_id") if isinstance(data.get("parent_id"), int) else None
                await run_in_threadpool(_typing, user, data["channel_id"], parent)
    except WebSocketDisconnect:
        pass
    except RuntimeError:  # socket closed under us
        pass
    finally:
        await hub.disconnect(ws, user.id)
        if not hub.is_connected(user.id):
            asyncio.get_running_loop().create_task(_hang_up_later(user.id))


async def _hang_up_later(user_id: int, delay: float = CALL_GRACE_SECONDS) -> None:
    await asyncio.sleep(delay)
    if not hub.is_connected(user_id):
        try:
            await run_in_threadpool(_leave_calls_if_gone, user_id)
        except Exception:  # noqa: BLE001
            pass
