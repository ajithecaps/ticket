"""Daily challenge: one puzzle a day, the same for everyone, timed by the server.

The kind rotates daily (pair match, sliding tiles, developer words, math sprint). The server
generates the puzzle from the date, keeps the clock and the progress, and checks every move, so a
result can't be made up in the browser. Daily ranks give points (10, 8, 6, 5, 4, 3, 2, then 1 for
solving), which add up on the weekly, monthly and all-time leaderboards.
"""
import hashlib
import random
from collections import defaultdict
from datetime import date, datetime, timedelta

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from ..config import settings
from ..deps import CurrentUser, DbSession
from ..jobs import tz
from ..models import ChallengeAttempt, User
from ..utils import utcnow

router = APIRouter(prefix="/challenge", tags=["Daily challenge"])

KINDS = ["match", "slide", "words", "math"]
INFO = {
    "match": ("Pair Match", "Flip two cards at a time and find all 10 pairs. Each miss adds 1 second."),
    "slide": ("Slide", "Slide the tiles into order, 1 to 8, with the gap in the bottom-right corner."),
    "words": ("Dev Words", "Unscramble 5 developer words. Skipping a word adds 20 seconds."),
    "math": ("Math Sprint", "Answer 10 sums as fast as you can. A wrong answer adds 5 seconds."),
}
TIME_LIMIT = timedelta(minutes=15)
MISS_MS, SKIP_MS, WRONG_MS = 1_000, 20_000, 5_000
POINTS = [10, 8, 6, 5, 4, 3, 2]  # by daily rank; everyone else who solves it gets 1

CARD_SYMBOLS = ["🐛", "🚀", "🔥", "💾", "🧪", "📦", "🔒", "⚙️", "🧠", "☕", "🐳", "🌿", "🦀", "🐍", "🎯", "💡", "🛰️", "🧩"]
WORDS = [
    "DEPLOY", "BRANCH", "COMMIT", "MERGE", "DOCKER", "PYTHON", "SPRINT", "BACKLOG", "RELEASE", "TICKET", "BUGFIX",
    "REFACTOR", "PIPELINE", "DATABASE", "SERVER", "CLIENT", "BROWSER", "COMPILER", "VARIABLE", "FUNCTION", "PROMISE",
    "CALLBACK", "KERNEL", "CACHE", "QUERY", "SCHEMA", "INDEX", "TOKEN", "WEBHOOK", "ROUTER", "SOCKET", "THREAD",
    "BINARY", "SYNTAX", "DEBUGGER", "LINTER", "PACKAGE", "MODULE", "CONTAINER", "CLUSTER", "GATEWAY", "LATENCY",
    "STANDUP", "ROADMAP", "HOTFIX", "ROLLBACK", "STAGING", "MIGRATION", "ENDPOINT", "PAYLOAD", "FRONTEND", "BACKEND",
    "KEYBOARD", "MONITOR", "LAPTOP", "PRIORITY", "MILESTONE", "DEADLINE", "REVIEW", "TESTING", "CONSOLE", "TERMINAL",
    "SCRIPT", "LAMBDA", "OBJECT", "STRING", "INTEGER", "BOOLEAN", "ARRAY", "PIXEL", "VECTOR", "NETWORK", "FIREWALL",
    "STORAGE", "BACKUP", "LOGGING", "METRICS", "ALERT", "CLOUD", "COOKIE", "SESSION", "PATCH", "VERSION", "PLUGIN",
]
SOLVED_BOARD = [1, 2, 3, 4, 5, 6, 7, 8, 0]


# ----------------------------------------------------------------------------- the day's puzzle
def today() -> date:
    return datetime.now(tz()).date()


def kind_for(day: date) -> str:
    return KINDS[day.toordinal() % len(KINDS)]


def _rng(day: date) -> random.Random:
    # Seeded by the secret key too, so tomorrow's puzzle can't be worked out in advance.
    digest = hashlib.sha256(f"{settings.SECRET_KEY}:challenge:{day.isoformat()}".encode()).digest()
    return random.Random(int.from_bytes(digest[:8], "big"))


def _neighbours(i: int) -> list[int]:
    r, c = divmod(i, 3)
    return [rr * 3 + cc for rr, cc in ((r - 1, c), (r + 1, c), (r, c - 1), (r, c + 1)) if 0 <= rr < 3 and 0 <= cc < 3]


def _distance(board: list[int]) -> int:
    return sum(abs(i // 3 - (t - 1) // 3) + abs(i % 3 - (t - 1) % 3) for i, t in enumerate(board) if t)


def puzzle(day: date) -> dict:
    """The full puzzle for a day, answers included - never sent to the browser as is."""
    rng = _rng(day)
    kind = kind_for(day)
    if kind == "match":
        cards = rng.sample(CARD_SYMBOLS, 10) * 2
        rng.shuffle(cards)
        return {"cards": cards}
    if kind == "slide":
        # A random walk from the solved board is always solvable; walk until it's properly mixed up.
        board, blank, prev = SOLVED_BOARD[:], 8, None
        steps = 0
        while steps < 60 or _distance(board) < 14:
            choices = [n for n in _neighbours(blank) if n != prev]
            nxt = rng.choice(choices)
            board[blank], board[nxt] = board[nxt], board[blank]
            prev, blank = blank, nxt
            steps += 1
        return {"board": board}
    if kind == "words":
        words = sorted(rng.sample(WORDS, 5), key=len)
        scrambled = []
        for w in words:
            letters = list(w)
            while "".join(letters) == w:
                rng.shuffle(letters)
            scrambled.append("".join(letters))
        return {"words": words, "scrambled": scrambled}
    questions = []
    for i in range(10):
        if i < 3:
            a, b = rng.randint(6, 49), rng.randint(3, 39)
            q, ans = (f"{a} + {b}", a + b) if rng.random() < 0.5 else (f"{max(a, b)} − {min(a, b)}", max(a, b) - min(a, b))
        elif i < 6:
            a, b = rng.randint(3, 12), rng.randint(3, 12)
            if rng.random() < 0.6:
                q, ans = f"{a} × {b}", a * b
            else:
                q, ans = f"{a * b} ÷ {b}", a
        else:
            a, b, c = rng.randint(3, 12), rng.randint(3, 12), rng.randint(5, 60)
            roll = rng.random()
            if roll < 0.4:
                q, ans = f"{a} × {b} + {c}", a * b + c
            elif roll < 0.7:
                q, ans = f"{a * b + c} − {c}", a * b
            else:
                k = rng.randint(2, 6)
                q, ans = f"({a} + {b}) × {k}", (a + b) * k
        questions.append({"q": q, "a": ans})
    return {"questions": questions}


def _initial_state(kind: str) -> dict:
    return {
        "match": {"open": [], "matched": []},
        "slide": {},
        "words": {"done": {}, "skipped": []},
        "math": {"current": 0, "wrong": 0},
    }[kind]


def _public(att: ChallengeAttempt) -> dict:
    """What the player may see: the puzzle without its answers, plus their progress."""
    p = puzzle(att.day)
    st = att.state or {}
    if att.kind == "match":
        shown = st.get("matched", []) + (st.get("open", []) if len(st.get("open", [])) == 1 else [])
        return {"count": len(p["cards"]), "faces": {str(i): p["cards"][i] for i in shown}, "matched": st.get("matched", [])}
    if att.kind == "slide":
        return {"board": p["board"]}
    if att.kind == "words":
        done = dict(st.get("done", {}))
        for i in st.get("skipped", []):
            done[str(i)] = p["words"][i]
        return {"scrambled": p["scrambled"], "done": done, "skipped": st.get("skipped", [])}
    return {"questions": [q["q"] for q in p["questions"]], "current": st.get("current", 0)}


# ----------------------------------------------------------------------------- attempts
def _finish(att: ChallengeAttempt, solved: bool = True) -> None:
    now = utcnow()
    att.finished_at = now
    att.solved = solved
    att.duration_ms = min(int((now - att.started_at).total_seconds() * 1000), int(TIME_LIMIT.total_seconds() * 1000))


def _expire(db: Session, att: ChallengeAttempt | None) -> None:
    """Over the time limit without solving it: it counts as not finished."""
    if att and att.finished_at is None and utcnow() - att.started_at > TIME_LIMIT:
        _finish(att, solved=False)
        db.commit()


def _mine(db: Session, user: User, day: date) -> ChallengeAttempt | None:
    att = db.scalar(select(ChallengeAttempt).where(ChallengeAttempt.user_id == user.id, ChallengeAttempt.day == day))
    _expire(db, att)
    return att


def _playing(db: Session, user: User, kind: str | None = None) -> ChallengeAttempt:
    att = _mine(db, user, today())
    if att is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Start today's challenge first")
    if att.finished_at is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "You've already finished today's challenge - come back tomorrow!")
    if kind and att.kind != kind:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "That move doesn't belong to today's puzzle")
    return att


def _ranked(attempts: list[ChallengeAttempt]) -> list[ChallengeAttempt]:
    return sorted((a for a in attempts if a.solved), key=lambda a: (a.score_ms, a.finished_at))


def _day_rank(db: Session, att: ChallengeAttempt) -> int | None:
    if not att.solved:
        return None
    others = db.scalars(select(ChallengeAttempt).where(ChallengeAttempt.day == att.day, ChallengeAttempt.solved.is_(True))).all()
    return next((i + 1 for i, a in enumerate(_ranked(list(others))) if a.id == att.id), None)


def _attempt_out(db: Session, att: ChallengeAttempt | None, with_puzzle: bool = True) -> dict | None:
    if att is None:
        return None
    done = att.finished_at is not None
    return {
        "status": "done" if done else "playing",
        "kind": att.kind,
        "elapsed_ms": None if done else int((utcnow() - att.started_at).total_seconds() * 1000),
        "solved": att.solved,
        "duration_ms": att.duration_ms,
        "penalty_ms": att.penalty_ms,
        "score_ms": att.score_ms,
        "moves": att.moves,
        "rank": _day_rank(db, att) if done else None,
        "puzzle": _public(att) if with_puzzle else None,
    }


def _points(rank: int) -> int:
    return POINTS[rank - 1] if rank <= len(POINTS) else 1


def _streaks(db: Session, user_ids: set[int]) -> dict[int, int]:
    """Days in a row each person solved the challenge, counting back from today (or yesterday)."""
    if not user_ids:
        return {}
    rows = db.execute(select(ChallengeAttempt.user_id, ChallengeAttempt.day)
                      .where(ChallengeAttempt.user_id.in_(user_ids), ChallengeAttempt.solved.is_(True))).all()
    days = defaultdict(set)
    for uid, d in rows:
        days[uid].add(d)
    t = today()
    out = {}
    for uid in user_ids:
        d = t if t in days[uid] else t - timedelta(days=1)
        n = 0
        while d in days[uid]:
            n += 1
            d -= timedelta(days=1)
        out[uid] = n
    return out


def _user(u: User) -> dict:
    return {"id": u.id, "name": u.name, "email": u.email}


# ----------------------------------------------------------------------------- endpoints
@router.get("/today", summary="Today's challenge, your attempt and yesterday's podium")
def challenge_today(user: CurrentUser, db: DbSession):
    day = today()
    kind = kind_for(day)
    att = _mine(db, user, day)
    todays = db.scalars(select(ChallengeAttempt).where(ChallengeAttempt.day == day)).all()
    yday = db.scalars(select(ChallengeAttempt).where(ChallengeAttempt.day == day - timedelta(days=1), ChallengeAttempt.solved.is_(True))).all()
    now_local = datetime.now(tz())
    tomorrow = datetime.combine(day + timedelta(days=1), datetime.min.time(), tzinfo=now_local.tzinfo)
    return {
        "day": day.isoformat(),
        "kind": kind,
        "title": INFO[kind][0],
        "rules": INFO[kind][1],
        "time_limit_s": int(TIME_LIMIT.total_seconds()),
        "players": len(todays),
        "solved": sum(1 for a in todays if a.solved),
        "streak": _streaks(db, {user.id})[user.id],
        "next_in_s": int((tomorrow - now_local).total_seconds()),
        "attempt": _attempt_out(db, att, with_puzzle=att is not None and att.finished_at is None),
        "yesterday": [{"user": _user(a.user), "score_ms": a.score_ms, "kind": a.kind} for a in _ranked(list(yday))[:3]],
    }


@router.post("/today/start", summary="Start the clock (once per day)")
def start(user: CurrentUser, db: DbSession):
    day = today()
    att = _mine(db, user, day)
    if att is None:
        kind = kind_for(day)
        att = ChallengeAttempt(user_id=user.id, day=day, kind=kind, state=_initial_state(kind), started_at=utcnow())
        db.add(att)
        try:
            db.commit()
        except IntegrityError:  # a double click: the other request created it
            db.rollback()
            att = _mine(db, user, day)
    return _attempt_out(db, att, with_puzzle=att.finished_at is None)


class FlipIn(BaseModel):
    index: int = Field(ge=0, le=99)


@router.post("/today/flip", summary="Pair match: turn a card over")
def flip(payload: FlipIn, user: CurrentUser, db: DbSession):
    att = _playing(db, user, "match")
    cards = puzzle(att.day)["cards"]
    st = att.state
    i = payload.index
    if i >= len(cards) or i in st["matched"]:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "That card can't be turned")
    if len(st["open"]) == 2:  # the previous two didn't match: they turn back now
        st["open"] = []
    if i in st["open"]:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "That card is already face up")
    st["open"].append(i)
    out = {"index": i, "symbol": cards[i], "match": None}
    if len(st["open"]) == 2:
        att.moves += 1
        a, b = st["open"]
        out["match"] = cards[a] == cards[b]
        if out["match"]:
            st["matched"] += [a, b]
            st["open"] = []
        else:
            att.penalty_ms += MISS_MS
        out["pair"] = [a, b]
    if len(st["matched"]) == len(cards):
        _finish(att)
    flag_modified(att, "state")
    db.commit()
    out["attempt"] = _attempt_out(db, att, with_puzzle=False)
    return out


class AnswerIn(BaseModel):
    item: int = Field(ge=0, le=20)
    answer: str = Field(max_length=40)


@router.post("/today/answer", summary="Dev words / math sprint: check one answer")
def answer(payload: AnswerIn, user: CurrentUser, db: DbSession):
    att = _playing(db, user)
    p = puzzle(att.day)
    st = att.state
    if att.kind == "words":
        if payload.item >= len(p["words"]) or str(payload.item) in st["done"] or payload.item in st["skipped"]:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "That word is already done")
        correct = payload.answer.strip().upper() == p["words"][payload.item]
        if correct:
            st["done"][str(payload.item)] = p["words"][payload.item]
        finished = len(st["done"]) + len(st["skipped"]) == len(p["words"])
    elif att.kind == "math":
        if payload.item != st["current"]:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Answer the current question")
        try:
            correct = int(payload.answer.strip().replace("−", "-")) == p["questions"][payload.item]["a"]
        except ValueError:
            correct = False
        if correct:
            st["current"] += 1
        else:
            st["wrong"] += 1
            att.penalty_ms += WRONG_MS
        finished = st["current"] == len(p["questions"])
    else:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Today's puzzle doesn't take typed answers")
    att.moves += 1
    if finished:
        _finish(att)
    flag_modified(att, "state")
    db.commit()
    return {"correct": correct, "attempt": _attempt_out(db, att, with_puzzle=False)}


class SkipIn(BaseModel):
    item: int = Field(ge=0, le=20)


@router.post("/today/skip", summary="Dev words: reveal a word (+20 s)")
def skip(payload: SkipIn, user: CurrentUser, db: DbSession):
    att = _playing(db, user, "words")
    words = puzzle(att.day)["words"]
    st = att.state
    if payload.item >= len(words) or str(payload.item) in st["done"] or payload.item in st["skipped"]:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "That word is already done")
    st["skipped"].append(payload.item)
    att.penalty_ms += SKIP_MS
    if len(st["done"]) + len(st["skipped"]) == len(words):
        _finish(att)
    flag_modified(att, "state")
    db.commit()
    return {"word": words[payload.item], "attempt": _attempt_out(db, att, with_puzzle=False)}


class SlideIn(BaseModel):
    moves: list[int] = Field(max_length=5000)


@router.post("/today/slide", summary="Sliding tiles: submit your moves (checked on the server)")
def slide(payload: SlideIn, user: CurrentUser, db: DbSession):
    att = _playing(db, user, "slide")
    board = puzzle(att.day)["board"][:]
    for tile in payload.moves:
        if tile not in board or tile == 0:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Those moves aren't possible")
        t, blank = board.index(tile), board.index(0)
        if t not in _neighbours(blank):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Those moves aren't possible")
        board[t], board[blank] = 0, tile
    if board != SOLVED_BOARD:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Not solved yet")
    att.moves = len(payload.moves)
    _finish(att)
    db.commit()
    return {"attempt": _attempt_out(db, att, with_puzzle=False)}


@router.post("/today/give-up", summary="Stop today's attempt (it won't score)")
def give_up(user: CurrentUser, db: DbSession):
    att = _playing(db, user)
    _finish(att, solved=False)
    db.commit()
    return {"attempt": _attempt_out(db, att, with_puzzle=False)}


@router.get("/leaderboard", summary="Today's times, or points for the week / month / all time")
def leaderboard(user: CurrentUser, db: DbSession, period: str = Query("today", pattern="^(today|week|month|all)$")):
    t = today()
    if period == "today":
        todays = db.scalars(select(ChallengeAttempt).where(ChallengeAttempt.day == t)).all()
        for a in todays:
            _expire(db, a)
        ranked = _ranked(list(todays))
        streaks = _streaks(db, {a.user_id for a in todays})
        rows = [{
            "rank": i + 1, "user": _user(a.user), "score_ms": a.score_ms, "duration_ms": a.duration_ms,
            "penalty_ms": a.penalty_ms, "moves": a.moves, "points": _points(i + 1), "streak": streaks.get(a.user_id, 0),
        } for i, a in enumerate(ranked)]
        playing = [_user(a.user) for a in todays if a.finished_at is None]
        return {"period": period, "kind": kind_for(t), "rows": rows, "playing": playing,
                "unfinished": sum(1 for a in todays if a.finished_at is not None and not a.solved)}

    start_day = {"week": t - timedelta(days=t.weekday()), "month": t.replace(day=1), "all": date.min}[period]
    attempts = db.scalars(select(ChallengeAttempt).where(
        ChallengeAttempt.day >= start_day, ChallengeAttempt.day <= t, ChallengeAttempt.solved.is_(True))).all()
    by_day = defaultdict(list)
    for a in attempts:
        by_day[a.day].append(a)
    stats: dict[int, dict] = {}
    for day_attempts in by_day.values():
        for i, a in enumerate(_ranked(day_attempts)):
            s = stats.setdefault(a.user_id, {"user": _user(a.user), "points": 0, "solved": 0, "wins": 0, "podiums": 0})
            s["points"] += _points(i + 1)
            s["solved"] += 1
            s["wins"] += i == 0
            s["podiums"] += i < 3
    streaks = _streaks(db, set(stats))
    rows = sorted(stats.values(), key=lambda s: (-s["points"], -s["wins"], -s["solved"], s["user"]["name"].lower()))
    for i, s in enumerate(rows):
        s["rank"] = i + 1
        s["streak"] = streaks.get(s["user"]["id"], 0)
    return {"period": period, "rows": rows, "days": len(by_day)}
