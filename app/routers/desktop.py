"""Desktop app downloads: the installers built from desktop/ are dropped into DESKTOP_DIR and offered
to signed-in people on the "Desktop app" page."""
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException, status
from fastapi.responses import FileResponse

from ..config import settings
from ..deps import CurrentUser, DbSession
from ..models import User
from ..security import create_link_token, decode_link_token

router = APIRouter(prefix="/desktop", tags=["Desktop app"])

# file extension -> (os, package kind); longest suffixes first
_KINDS = [
    (".dmg", "mac", "dmg"), ("-mac.zip", "mac", "zip"),
    (".exe", "windows", "installer"), (".msi", "windows", "msi"),
    (".appimage", "linux", "AppImage"), (".deb", "linux", "deb"), (".rpm", "linux", "rpm"),
]
_ARCH = re.compile(r"(?:^|[-_.])(arm64|aarch64|x64|x86_64|amd64|universal|ia32)(?=[-_.]|$)", re.I)
_VERSION = re.compile(r"(\d+)\.(\d+)\.(\d+)")
_ARCH_NAMES = {"aarch64": "arm64", "x86_64": "x64", "amd64": "x64"}
_PURPOSE = "desktop-download"


def _builds() -> list[dict]:
    root = Path(settings.DESKTOP_DIR)
    if not root.is_dir():
        return []
    out = []
    for f in root.iterdir():
        if not f.is_file() or f.name.startswith("."):
            continue
        lower = f.name.lower()
        kind = next((k for k in _KINDS if lower.endswith(k[0])), None)
        version = _VERSION.search(f.name)
        if not kind or not version:
            continue
        arch = _ARCH.search(f.name)
        out.append({
            "file": f.name,
            "os": kind[1],
            "kind": kind[2],
            "arch": _ARCH_NAMES.get(arch.group(1).lower(), arch.group(1).lower()) if arch else "x64",
            "version": ".".join(version.groups()),
            "_v": tuple(int(x) for x in version.groups()),
            "size": f.stat().st_size,
        })
    return out


def _latest() -> tuple[str | None, list[dict]]:
    builds = _builds()
    if not builds:
        return None, []
    newest = max(b["_v"] for b in builds)
    latest = [{k: v for k, v in b.items() if k != "_v"} for b in builds if b["_v"] == newest]
    latest.sort(key=lambda b: (b["os"], b["kind"], b["arch"]))
    return latest[0]["version"], latest


@router.get("/info")
def desktop_info():
    """Public on purpose: the desktop app calls it to find out whether an update is available."""
    version, _ = _latest()
    return {"app": settings.APP_NAME, "version": version}


@router.get("/downloads")
def list_downloads(_user: CurrentUser):
    version, builds = _latest()
    return {"version": version, "builds": builds}


@router.post("/downloads/{filename}/link")
def download_link(filename: str, user: CurrentUser):
    """A short-lived URL the browser can download directly (installers are too big to fetch into memory)."""
    if filename not in {b["file"] for b in _latest()[1]}:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "That download is not available")
    token = create_link_token(user.id, _PURPOSE, filename)
    return {"url": f"{settings.API_PREFIX}/desktop/file/{filename}?t={token}"}


@router.get("/file/{filename}", include_in_schema=False)
def download_file(filename: str, t: str, db: DbSession):
    user_id = decode_link_token(t, _PURPOSE, filename)
    user = db.get(User, user_id) if user_id else None
    if user is None or not user.is_active:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "This download link has expired - start the download again")
    # Only names we list ourselves are served, so no path tricks are possible.
    if filename not in {b["file"] for b in _builds()}:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "That download is not available")
    return FileResponse(Path(settings.DESKTOP_DIR) / filename, filename=filename, media_type="application/octet-stream")
