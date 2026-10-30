import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from . import models  # noqa: F401  (registers tables on Base.metadata)
from .config import settings
from .database import Base, SessionLocal, engine
from .models import Role, User
from . import runtime_config
from .chat_hub import hub
from .jobs import scheduler
from starlette.concurrency import run_in_threadpool
from .routers import (
    attachments, auth, challenge, chat, comments, dashboard, desktop, docs, sprints, integrations, notifications, profile, projects, releases, reports, tickets, timeline,
    upcoming, users,
)
from .security import hash_password

logger = logging.getLogger("tickets")

def bootstrap_admin() -> None:
    """Create the first admin if no admin exists yet."""
    with SessionLocal() as db:
        email = settings.FIRST_ADMIN_EMAIL.strip().lower()

        admin_exists = db.scalar(
            select(User.id)
            .where(User.role == Role.ADMIN)
            .limit(1)
        )

        if admin_exists:
            return

        db.add(
            User(
                name=settings.FIRST_ADMIN_NAME,
                email=email,
                hashed_password=hash_password(
                    settings.FIRST_ADMIN_PASSWORD
                ),
                role=Role.ADMIN,
                designation="Administrator",
            )
        )
        try:
            db.commit()
        except IntegrityError:
            # Another worker process created it at the same moment (uvicorn --workers N).
            db.rollback()
            return

        logger.warning(
            "Created first admin %s - change its password now.",
            email,
        )


def _warn_if_schema_behind() -> None:
    """New features fail with 500s when the database misses their migration - say so loudly."""
    try:
        from alembic.config import Config
        from alembic.runtime.migration import MigrationContext
        from alembic.script import ScriptDirectory

        root = Path(__file__).resolve().parent.parent
        head = ScriptDirectory.from_config(Config(str(root / "alembic.ini"))).get_current_head()
        with engine.connect() as conn:
            current = MigrationContext.configure(conn).get_current_revision()
        if current != head:
            logger.error("Database schema is at %s but the code expects %s - run 'alembic upgrade head'.", current, head)
    except Exception as exc:  # noqa: BLE001 - only a diagnostic
        logger.warning("Could not check the database schema version: %s", exc)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    if settings.SECRET_KEY == "change-me":
        logger.warning(
            "SECRET_KEY is the default value - "
            "set a strong one before going to production."
        )

    # Database tables must already exist.
    # Run Alembic migrations before starting the API.
    Path(settings.UPLOAD_DIR).mkdir(
        parents=True,
        exist_ok=True,
    )

    _warn_if_schema_behind()
    bootstrap_admin()
    runtime_config.refresh_if_stale(0)  # settings saved from the admin panel
    scheduler.start()  # overdue alerts + daily Slack summary
    yield
    scheduler.stop()
    await hub.stop()


app = FastAPI(
    title=settings.APP_NAME,
    version="1.0.0",
    description=(
        "Ticket handling for development teams.\n\n"
        "**Roles** - *admin* sees everything and the efficiency reports; *project owners* assign work in "
        "their projects; *developers* work their assigned tickets, comment, mention and attach files."
    ),
    lifespan=lifespan,
)

@app.middleware("http")
async def _fresh_settings(request: Request, call_next):
    # Pick up admin-panel settings saved by another worker (cheap: at most one query every 15 s).
    await run_in_threadpool(runtime_config.refresh_if_stale)
    return await call_next(request)


app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials="*" not in settings.cors_origins_list,
    allow_methods=["*"],
    allow_headers=["*"],
)

for module in (
    auth, users, projects, tickets, comments, attachments, notifications, reports, integrations, upcoming, releases,
    timeline, docs, dashboard, sprints, chat, desktop, challenge, profile,
):
    app.include_router(module.router, prefix=settings.API_PREFIX)


@app.exception_handler(OverflowError)
async def _id_out_of_range(_request: Request, _exc: OverflowError):
    # e.g. GET /tickets/99999999999999999999 - SQLite cannot bind integers above 64 bits.
    # No row can have such an id, so this is simply "not found".
    return JSONResponse(status_code=404, content={"detail": "Not found"})


@app.get("/health", tags=["Health"])
def health():
    return {"status": "ok"}


# The single-page frontend (plain HTML/JS, no build step). Routing is hash-based, so only "/" is needed.
FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"


class _RevalidatedStatic(StaticFiles):
    """Browsers must check for a newer copy on every load (a cheap 304 when nothing changed), so a
    deploy shows up straight away instead of people running yesterday's JavaScript."""

    def file_response(self, *args, **kwargs):
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "no-cache"
        return response


if FRONTEND_DIR.is_dir():
    app.mount("/static", _RevalidatedStatic(directory=FRONTEND_DIR), name="frontend")

    @app.get("/", include_in_schema=False)
    def frontend_index():
        return FileResponse(FRONTEND_DIR / "index.html", headers={"Cache-Control": "no-cache"})
