from datetime import timedelta

import bcrypt
import jwt

from .config import settings
from .utils import utcnow


def hash_password(password: str) -> str:
    # bcrypt only looks at the first 72 bytes
    return bcrypt.hashpw(password.encode("utf-8")[:72], bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8")[:72], hashed.encode("utf-8"))
    except ValueError:
        return False


# Used to keep login timing similar for unknown e-mails
DUMMY_HASH = hash_password("not-a-real-password")


def create_access_token(user_id: int, expires_minutes: int | None = None) -> str:
    expire = utcnow() + timedelta(minutes=expires_minutes or settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    payload = {"sub": str(user_id), "exp": expire, "iat": utcnow()}
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.JWT_ALGORITHM)


def decode_access_token(token: str) -> int | None:
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.JWT_ALGORITHM])
        return int(payload["sub"])
    except (jwt.PyJWTError, KeyError, ValueError):
        return None
