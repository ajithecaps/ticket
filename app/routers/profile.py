"""Profiles and the personal coach.

* `/profile` - your own profile: name, title, bio, contact details, skills, time zone, photo, and the
  coach's settings (on/off, name, tone, daily goal).
* `/people/{id}` - someone else's profile, for anyone who shares a project with them (admins: everyone).
* `/avatars/{key}` - profile photos. Public on purpose (an <img> can't send the login token); the key
  is random and changes with every upload, so photos can't be guessed and cache forever.
* `/coach` - what the coach says right now: the next task and why, today's goal and streak, nudges.
"""
import secrets
from datetime import timedelta
from typing import Annotated
from zoneinfo import ZoneInfo

from fastapi import APIRouter, File, HTTPException, Query, Response, UploadFile, status
from sqlalchemy import select

from .. import coach
from ..deps import CurrentUser, DbSession
from ..models import Project, ProjectMember, TicketStatus, User, UserAvatar
from ..permissions import is_admin
from ..schemas import PersonProfile, PersonStats, ProfileOut, ProfileUpdate, ProjectBrief, TicketOut
from ..utils import utcnow

router = APIRouter(tags=["Profile & coach"])

MAX_AVATAR_BYTES = 1024 * 1024
# magic bytes -> mime type; only plain raster images (no SVG: it can carry scripts)
_IMAGE_SIGNATURES = [
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
]


def _sniff(data: bytes) -> str | None:
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return next((mime for sig, mime in _IMAGE_SIGNATURES if data.startswith(sig)), None)


def _clean(value: str | None) -> str | None:
    value = (value or "").strip()
    return value or None


# --------------------------------------------------------------------------- #
# My profile
# --------------------------------------------------------------------------- #
@router.get("/profile", response_model=ProfileOut, summary="My profile and coach settings")
def my_profile(user: CurrentUser):
    return user


@router.patch("/profile", response_model=ProfileOut)
def update_profile(payload: ProfileUpdate, user: CurrentUser, db: DbSession):
    data = payload.model_dump(exclude_unset=True)
    for field in ("name", "coach_name", "coach_enabled", "coach_tone", "daily_goal"):
        if field in data and data[field] is None:
            raise HTTPException(422, f"{field} cannot be empty")
    if "name" in data:
        name = data["name"].strip()
        if not name:
            raise HTTPException(422, "Name cannot be blank")
        user.name = name
    if "coach_name" in data:
        user.coach_name = data["coach_name"].strip() or "Spark"
    for field in ("designation", "phone", "location"):
        if field in data:
            setattr(user, field, _clean(data[field]))
    if "bio" in data:
        user.bio = (data["bio"] or "").strip()
    if "timezone" in data:
        zone = _clean(data["timezone"])
        if zone:
            try:
                ZoneInfo(zone)
            except Exception:  # noqa: BLE001
                raise HTTPException(422, f"Unknown time zone '{zone}'")
        user.timezone = zone
    if "skills" in data:
        seen, skills = set(), []
        for s in data["skills"] or []:
            s = s.strip()
            if s and s.lower() not in seen:
                seen.add(s.lower())
                skills.append(s)
        user.skills = skills
    for field in ("coach_enabled", "coach_tone", "daily_goal"):
        if field in data:
            setattr(user, field, data[field])
    db.commit()
    db.refresh(user)
    return user


@router.put("/profile/avatar", response_model=ProfileOut, summary="Upload a profile photo (PNG, JPEG, WebP or GIF, max 1 MB)")
def upload_avatar(user: CurrentUser, db: DbSession, file: Annotated[UploadFile, File()]):
    data = file.file.read(MAX_AVATAR_BYTES + 1)
    if len(data) > MAX_AVATAR_BYTES:
        raise HTTPException(413, "The photo is larger than 1 MB")
    mime = _sniff(data)
    if mime is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Use a PNG, JPEG, WebP or GIF image")
    row = db.get(UserAvatar, user.id) or UserAvatar(user_id=user.id)
    row.key = secrets.token_urlsafe(18)
    row.mime = mime
    row.data = data
    db.add(row)
    user.avatar_key = row.key
    db.commit()
    db.refresh(user)
    return user


@router.delete("/profile/avatar", response_model=ProfileOut)
def delete_avatar(user: CurrentUser, db: DbSession):
    row = db.get(UserAvatar, user.id)
    if row is not None:
        db.delete(row)
    user.avatar_key = None
    db.commit()
    db.refresh(user)
    return user


@router.get("/avatars/{key}", include_in_schema=False)
def get_avatar(key: str, db: DbSession):
    row = db.scalar(select(UserAvatar).where(UserAvatar.key == key))
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    return Response(row.data, media_type=row.mime, headers={
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
    })


# --------------------------------------------------------------------------- #
# Someone's profile
# --------------------------------------------------------------------------- #
@router.get("/people/{user_id}", response_model=PersonProfile, summary="A teammate's profile")
def person(user_id: int, user: CurrentUser, db: DbSession):
    other = db.get(User, user_id)
    if other is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Person not found")
    mine = select(ProjectMember.project_id).where(ProjectMember.user_id == user.id)
    shared = db.scalars(
        select(Project).join(ProjectMember, ProjectMember.project_id == Project.id)
        .where(ProjectMember.user_id == other.id, Project.id.in_(mine), Project.is_active.is_(True))
        .order_by(Project.name)
    ).all()
    if other.id != user.id and not is_admin(user) and not shared:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Person not found")

    tickets = coach.open_tickets(db, other.id)
    zone = coach.local_zone(other)
    days = coach.done_days(db, other.id, zone, utcnow() - timedelta(days=366))
    today = utcnow().astimezone(zone).date()
    out = PersonProfile.model_validate({
        **ProfileOut.model_validate(other).model_dump(),
        "stats": PersonStats(
            open=len(tickets),
            in_progress=sum(1 for t in tickets if t.status == TicketStatus.IN_PROGRESS),
            done_30d=sum(1 for d in days if (today - d).days < 30),
            streak=coach.streak_from(set(days), today),
        ),
        "shared_projects": [ProjectBrief.model_validate(p) for p in shared],
    })
    if other.id != user.id:  # the coach is personal
        out.coach_enabled, out.coach_name, out.coach_tone, out.daily_goal = True, "Spark", "cheerful", 2
    return out


# --------------------------------------------------------------------------- #
# Coach
# --------------------------------------------------------------------------- #
@router.get("/coach", summary="My coach: the next task, today's goal and streak, nudges")
def my_coach(
    user: CurrentUser,
    db: DbSession,
    event: Annotated[str | None, Query(pattern="^done$", description="'done' right after finishing a ticket: adds a cheer")] = None,
    key: Annotated[str | None, Query(max_length=20)] = None,
):
    data = coach.build(db, user, event=event, key=key)
    data["queue"] = [{**item, "ticket": TicketOut.model_validate(item["ticket"])} for item in data["queue"]]
    return data
