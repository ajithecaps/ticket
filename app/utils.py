import re
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path

from sqlalchemy import func, select


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def ensure_utc(value: datetime | None) -> datetime | None:
    """Treat naive datetimes as UTC and convert aware ones to UTC."""
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def day_start(d: date | None) -> datetime | None:
    return datetime.combine(d, time.min, tzinfo=timezone.utc) if d else None


def next_day_start(d: date | None) -> datetime | None:
    """Exclusive upper bound that includes the whole of day `d`."""
    return datetime.combine(d + timedelta(days=1), time.min, tzinfo=timezone.utc) if d else None


def paginate(db, stmt, limit: int, offset: int):
    """Run `stmt` with limit/offset and also return the unpaginated total."""
    total = db.scalar(select(func.count()).select_from(stmt.order_by(None).subquery())) or 0
    rows = db.scalars(stmt.limit(limit).offset(offset)).unique().all()
    return rows, total


_UNSAFE = re.compile(r"[^A-Za-z0-9._ \-()]")


def safe_filename(name: str | None) -> str:
    """Strip any directory part and unsafe characters from a client supplied file name."""
    base = Path((name or "file").replace("\\", "/")).name.strip()
    base = _UNSAFE.sub("_", base).strip(". ") or "file"
    if len(base) > 150:
        stem, dot, ext = base.rpartition(".")
        base = (stem[: 145 - len(ext)] + "." + ext) if dot else base[:150]
    return base


def escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
