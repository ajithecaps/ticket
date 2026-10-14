import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select

from . import models  # noqa: F401  (registers tables on Base.metadata)
from .config import settings
from .database import Base, SessionLocal, engine
from .models import Role, User
from .routers import attachments, auth, comments, notifications, projects, reports, tickets, users
from .security import hash_password

logger = logging.getLogger("tickets")


def bootstrap_admin() -> None:
    """Create the first admin from FIRST_ADMIN_* when the system has no admin yet."""
    with SessionLocal() as db:
        if db.scalar(select(User.id).where(User.role == Role.ADMIN).limit(1)):
            return
        db.add(
            User(
                name=settings.FIRST_ADMIN_NAME,
                email=settings.FIRST_ADMIN_EMAIL.strip().lower(),
                hashed_password=hash_password(settings.FIRST_ADMIN_PASSWORD),
                role=Role.ADMIN,
                designation="Administrator",
            )
        )
        db.commit()
        logger.warning("Created first admin %s - change its password now.", settings.FIRST_ADMIN_EMAIL)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    if settings.SECRET_KEY == "change-me":
        logger.warning("SECRET_KEY is the default value - set a strong one before going to production.")
    Base.metadata.create_all(bind=engine)  # use Alembic migrations once the schema starts changing
    Path(settings.UPLOAD_DIR).mkdir(parents=True, exist_ok=True)
    bootstrap_admin()
    yield


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

for module in (auth, users, projects, tickets, comments, attachments, notifications, reports):
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
