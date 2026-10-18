"""Settings that admins change from the panel instead of .env (Slack connection, links, time zone).

Values saved in the `app_settings` table override the .env value of the same setting and are applied
to the shared `settings` object, so the rest of the code keeps reading `settings.SLACK_WEBHOOK_URL` etc.
Every worker process re-reads the table at most every REFRESH_SECONDS, so a change made in one process
reaches the others without a restart. Secrets are encrypted with a key derived from SECRET_KEY
(Fernet: AES-128-CBC + HMAC-SHA256); if SECRET_KEY changes, saved secrets can no longer be read and
fall back to .env until they are entered again.
"""
from __future__ import annotations

import base64
import hashlib
import logging
import threading
import time

from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import settings
from .database import SessionLocal
from .models import AppSetting

logger = logging.getLogger("tickets.config")

REFRESH_SECONDS = 15

# key in the table -> (attribute on `settings`, kind)
EDITABLE: dict[str, tuple[str, str]] = {
    "slack_enabled": ("SLACK_ENABLED", "bool"),
    "slack_webhook_url": ("SLACK_WEBHOOK_URL", "secret"),
    "slack_bot_token": ("SLACK_BOT_TOKEN", "secret"),
    "slack_channel": ("SLACK_CHANNEL", "str"),
    "slack_notify_types": ("SLACK_NOTIFY_TYPES", "str"),
    "slack_daily_summary_time": ("SLACK_DAILY_SUMMARY_TIME", "str"),
    "slack_daily_summary_days": ("SLACK_DAILY_SUMMARY_DAYS", "str"),
    "timezone": ("TIMEZONE", "str"),
    "app_base_url": ("APP_BASE_URL", "str"),
}

# What .env (or the built-in default) says, captured before any override is applied.
ENV_DEFAULTS = {attr: getattr(settings, attr) for attr, _ in EDITABLE.values()}

_lock = threading.Lock()
_applied = dict(ENV_DEFAULTS)  # the value this module last put on `settings`, per attribute
_loaded_at = 0.0
_sources: dict[str, str] = {}  # key -> "panel" | "env"
_listeners: list = []


def on_change(fn) -> None:
    """Called after new values are applied (e.g. to drop caches built from the old ones)."""
    _listeners.append(fn)


def _fernet() -> Fernet:
    digest = hashlib.sha256(f"app-settings:{settings.SECRET_KEY}".encode()).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def encrypt(value: str) -> str:
    return _fernet().encrypt(value.encode()).decode()


def decrypt(token: str) -> str | None:
    try:
        return _fernet().decrypt(token.encode()).decode()
    except (InvalidToken, ValueError):
        return None


def _parse(kind: str, raw: str):
    return raw.strip().lower() in ("1", "true", "yes", "on") if kind == "bool" else raw


def apply(db: Session) -> None:
    """Load the table and apply it on top of the .env values."""
    global _loaded_at
    rows = {r.key: r for r in db.scalars(select(AppSetting))}
    changed = False
    with _lock:
        for key, (attr, kind) in EDITABLE.items():
            row = rows.get(key)
            value, source = ENV_DEFAULTS[attr], "env"
            if row is not None:
                raw = decrypt(row.value) if row.is_secret else row.value
                if raw is None:
                    logger.warning("Saved %s cannot be decrypted (SECRET_KEY changed?) - using .env instead", key)
                else:
                    value, source = _parse(kind, raw), "panel"
            # Only touch the attribute when the effective value changed, so values set some other way
            # (e.g. tests) are not overwritten by a periodic refresh.
            if _applied.get(attr) != value:
                setattr(settings, attr, value)
                _applied[attr] = value
                changed = True
            _sources[key] = source
        _loaded_at = time.monotonic()
    if changed:
        for fn in _listeners:
            try:
                fn()
            except Exception:  # noqa: BLE001
                logger.exception("Config listener failed")


def refresh_if_stale(max_age: float = REFRESH_SECONDS) -> None:
    global _loaded_at
    if time.monotonic() - _loaded_at < max_age:
        return
    try:
        with SessionLocal() as db:
            apply(db)
    except Exception:  # noqa: BLE001 - e.g. the table does not exist yet (migrations not run)
        logger.debug("Could not load app settings", exc_info=True)
        _loaded_at = time.monotonic()


def sources() -> dict[str, str]:
    return dict(_sources)


def save(db: Session, changes: dict[str, object], user_id: int | None) -> None:
    """Store changes. A value of None removes the override (back to .env)."""
    for key, value in changes.items():
        attr, kind = EDITABLE[key]
        row = db.get(AppSetting, key)
        if value is None:
            if row is not None:
                db.delete(row)
            continue
        raw = ("true" if value else "false") if kind == "bool" else str(value)
        stored = encrypt(raw) if kind == "secret" else raw
        if row is None:
            db.add(AppSetting(key=key, value=stored, is_secret=kind == "secret", updated_by=user_id))
        else:
            row.value, row.is_secret, row.updated_by = stored, kind == "secret", user_id
    db.commit()
    apply(db)


def reset(db: Session) -> None:
    for row in db.scalars(select(AppSetting).where(AppSetting.key.in_(EDITABLE))):
        db.delete(row)
    db.commit()
    apply(db)
