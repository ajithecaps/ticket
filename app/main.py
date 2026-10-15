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
from .jobs import scheduler
from .routers import (
    attachments, auth, comments, integrations, notifications, projects, reports, tickets, upcoming, users,
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

    bootstrap_admin()
    scheduler.start()  # overdue alerts + daily Slack summary
    yield
    scheduler.stop()


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

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials="*" not in settings.cors_origins_list,
    allow_methods=["*"],
    allow_headers=["*"],
)

for module in (auth, users, projects, tickets, comments, attachments, notifications, reports, integrations, upcoming):
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
if FRONTEND_DIR.is_dir():
    app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="frontend")

    @app.get("/", include_in_schema=False)
    def frontend_index():
        return FileResponse(FRONTEND_DIR / "index.html")
