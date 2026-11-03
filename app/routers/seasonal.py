"""Seasonal greetings with a gift - right now, Halloween.

During the Halloween fortnight (the same dates as the haunted-house challenge) everyone who opens
Grandesk gets a Halloween message in their inbox and a gift box. Opening it reveals a treat worth
bonus daily-challenge points (counted on the week / month / all-time leaderboards on the day it was
opened) and puts a "Halloween <year>" badge on their profile. Each person gets one gift per year;
the treat is picked per person from the secret key, so it can't be re-rolled.

Nothing is sent to Slack - this is an in-app greeting.
"""
import hashlib
import random
from datetime import date

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..config import settings
from ..deps import CurrentUser, DbSession
from ..models import Notification, NotificationType, SeasonalGift, User
from ..utils import utcnow
from .challenge import is_halloween, today

router = APIRouter(prefix="/seasonal", tags=["Seasonal"])

# (key, emoji, name, points, weight) - golden pumpkins are rare
TREATS = [
    ("candy", "🍬", "Bag of candy", 5, 30),
    ("chocolate", "🍫", "Chocolate bar", 5, 25),
    ("potion", "🧪", "Lucky potion", 7, 20),
    ("ghost", "👻", "Friendly ghost", 8, 15),
    ("pumpkin", "🎃", "Golden pumpkin", 15, 10),
]
TREAT = {t[0]: t for t in TREATS}
MESSAGE = ("Happy Halloween from all of us at Grandesk! 🎃 Thank you for every ticket you've slayed, every bug "
           "you've banished and every release you've shipped. A little treat is waiting for you - open your gift!")


def event_id(day: date) -> str:
    # 24 Oct - 7 Nov belongs to that year's Halloween
    return f"halloween-{day.year}"


def _pick(user_id: int, event: str) -> tuple:
    digest = hashlib.sha256(f"{settings.SECRET_KEY}:gift:{event}:{user_id}".encode()).digest()
    rng = random.Random(int.from_bytes(digest[:8], "big"))
    return rng.choices(TREATS, weights=[t[4] for t in TREATS])[0]


def _ensure_gift(db: Session, user: User, day: date) -> SeasonalGift:
    """Everyone gets one: created (with the inbox greeting) the first time they come by."""
    event = event_id(day)
    gift = db.scalar(select(SeasonalGift).where(SeasonalGift.user_id == user.id, SeasonalGift.event == event))
    if gift is not None:
        return gift
    key, _, _, points, _ = _pick(user.id, event)
    gift = SeasonalGift(user_id=user.id, event=event, treat=key, points=points)
    db.add(gift)
    db.add(Notification(user_id=user.id, actor_id=None, type=NotificationType.ANNOUNCEMENT, message=MESSAGE))
    try:
        db.commit()
    except IntegrityError:  # two tabs at once: the other request made it
        db.rollback()
        gift = db.scalar(select(SeasonalGift).where(SeasonalGift.user_id == user.id, SeasonalGift.event == event))
    return gift


def _gift_out(gift: SeasonalGift) -> dict:
    out = {"opened": gift.opened_at is not None}
    if gift.opened_at is not None:
        _, emoji, name, points, _ = TREAT[gift.treat]
        out.update(treat={"key": gift.treat, "emoji": emoji, "name": name}, points=points)
    return out


def badges_for(db: Session, user_id: int) -> list[dict]:
    """Profile badges earned from opened seasonal gifts."""
    events = db.scalars(select(SeasonalGift.event).where(
        SeasonalGift.user_id == user_id, SeasonalGift.opened_at.is_not(None)).order_by(SeasonalGift.event)).all()
    return [{"emoji": "🎃", "label": f"Halloween {e.split('-')[-1]}"} for e in events if e.startswith("halloween-")]


@router.get("", summary="The current seasonal greeting and your gift (if a season is on)")
def current(user: CurrentUser, db: DbSession):
    day = today()
    if not is_halloween(day):
        return {"event": None}
    gift = _ensure_gift(db, user, day)
    event = event_id(day)
    opened = db.scalar(select(func.count()).select_from(SeasonalGift).where(
        SeasonalGift.event == event, SeasonalGift.opened_at.is_not(None))) or 0
    return {
        "event": {"id": event, "kind": "halloween", "title": "Happy Halloween!", "message": MESSAGE, "from": "The Grandesk team"},
        "gift": _gift_out(gift),
        "opened_count": opened,
    }


@router.post("/open", summary="Open your gift (once)")
def open_gift(user: CurrentUser, db: DbSession):
    day = today()
    if not is_halloween(day):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "There's no gift to open right now")
    gift = _ensure_gift(db, user, day)
    if gift.opened_at is None:
        gift.opened_at = utcnow()
        gift.opened_day = day
        db.commit()
    return {"gift": _gift_out(gift), "badge": {"emoji": "🎃", "label": f"Halloween {day.year}"}}
