"""Releases: finished tickets grouped per project and shipped to production together.

* Admins and project owners create a release, move *done* / *verified* tickets into it, and finally
  mark it released. Project members can read releases.
* A ticket inside a release no longer shows on the board or in the default ticket lists
  (`in_release=false`); it still counts in the efficiency report.
* Releasing locks the release, verifies any ticket still waiting for verification (shipping is the
  owner's acceptance) and notifies the project's members in-app and on Slack.
"""
from collections import Counter

from fastapi import APIRouter, HTTPException, Query, status
from sqlalchemy import func, select

from ..config import settings
from ..deps import CurrentUser, DbSession
from ..models import (
    CLOSED_STATUSES,
    NotificationType,
    Project,
    ProjectMember,
    Release,
    ReleaseStatus,
    Ticket,
    TicketStatus,
    TicketType,
)
from ..permissions import is_admin, is_project_owner, require_member, require_owner
from ..schemas import ReleaseCreate, ReleaseDetail, ReleaseOut, ReleaseTicketsIn, ReleaseUpdate, TicketOut
from ..services import apply_status_change, log_activity, notify
from ..utils import ensure_utc, utcnow

router = APIRouter(tags=["Releases"])

TYPE_ORDER = [TicketType.FEATURE, TicketType.IMPROVEMENT, TicketType.BUG, TicketType.TASK]
TYPE_HEADING = {
    TicketType.FEATURE: "New features",
    TicketType.IMPROVEMENT: "Improvements",
    TicketType.BUG: "Bug fixes",
    TicketType.TASK: "Other changes",
}


def _url(release: Release) -> str:
    return f"{settings.APP_BASE_URL.rstrip('/')}/#/releases/{release.id}"


def _out(db, user, release: Release, *, detail: bool = False):
    tickets = list(release.tickets)
    data = (ReleaseDetail if detail else ReleaseOut).model_validate(release)
    data.ticket_count = len(tickets)
    data.by_type = dict(Counter(t.type.value for t in tickets))
    data.unverified_count = sum(1 for t in tickets if t.status == TicketStatus.DONE)
    data.can_edit = is_project_owner(db, user, release.project_id)
    data.can_manage = data.can_edit and release.status == ReleaseStatus.PLANNED
    if detail:
        data.tickets = [TicketOut.model_validate(t) for t in tickets]
    return data


def _get(db, user, release_id: int) -> Release:
    release = db.get(Release, release_id)
    if release is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Release not found")
    require_member(db, user, release.project_id)
    return release


def _manageable(db, user, release_id: int) -> Release:
    release = _get(db, user, release_id)
    require_owner(db, user, release.project_id)
    if release.status == ReleaseStatus.RELEASED:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"{release.name} is already released and can no longer change")
    return release


def _check_name(db, project_id: int, name: str, exclude_id: int | None = None) -> None:
    stmt = select(Release.id).where(Release.project_id == project_id, func.lower(Release.name) == name.lower())
    if exclude_id is not None:
        stmt = stmt.where(Release.id != exclude_id)
    if db.scalar(stmt):
        raise HTTPException(status.HTTP_409_CONFLICT, f"This project already has a release named '{name}'")


# --------------------------------------------------------------------------- #
# Read
# --------------------------------------------------------------------------- #
@router.get("/releases", response_model=list[ReleaseOut], summary="Releases across my projects")
def list_releases(
    user: CurrentUser,
    db: DbSession,
    project_id: int | None = None,
    status_: ReleaseStatus | None = Query(None, alias="status"),
):
    stmt = select(Release).join(Project, Project.id == Release.project_id).where(Project.is_active.is_(True))
    if not is_admin(user):
        stmt = stmt.where(Release.project_id.in_(select(ProjectMember.project_id).where(ProjectMember.user_id == user.id)))
    if project_id is not None:
        stmt = stmt.where(Release.project_id == project_id)
    if status_ is not None:
        stmt = stmt.where(Release.status == status_)
    # planned first (soonest date first), then released (newest first)
    stmt = stmt.order_by(
        Release.status != ReleaseStatus.PLANNED,
        Release.released_at.desc(),
        Release.planned_date.is_(None),
        Release.planned_date,
        Release.id.desc(),
    )
    return [_out(db, user, r) for r in db.scalars(stmt).unique()]


@router.get("/projects/{project_id}/releases", response_model=list[ReleaseOut])
def list_project_releases(project_id: int, user: CurrentUser, db: DbSession):
    require_member(db, user, project_id)
    return list_releases(user, db, project_id=project_id, status_=None)


@router.get("/releases/{release_id}", response_model=ReleaseDetail)
def get_release(release_id: int, user: CurrentUser, db: DbSession):
    return _out(db, user, _get(db, user, release_id), detail=True)


# --------------------------------------------------------------------------- #
# Manage (admin / project owner, while planned)
# --------------------------------------------------------------------------- #
@router.post("/projects/{project_id}/releases", response_model=ReleaseDetail, status_code=status.HTTP_201_CREATED)
def create_release(project_id: int, payload: ReleaseCreate, user: CurrentUser, db: DbSession):
    project = require_owner(db, user, project_id)
    _check_name(db, project.id, payload.name)
    release = Release(
        project_id=project.id, name=payload.name, notes=payload.notes,
        planned_date=ensure_utc(payload.planned_date), created_by=user.id,
    )
    db.add(release)
    db.commit()
    db.refresh(release)
    return _out(db, user, release, detail=True)


@router.patch("/releases/{release_id}", response_model=ReleaseDetail)
def update_release(release_id: int, payload: ReleaseUpdate, user: CurrentUser, db: DbSession):
    release = _get(db, user, release_id)
    require_owner(db, user, release.project_id)
    data = payload.model_dump(exclude_unset=True)
    if "name" in data:
        if not data["name"] or not data["name"].strip():
            raise HTTPException(422, "name cannot be empty")
        data["name"] = data["name"].strip()
        if release.status == ReleaseStatus.RELEASED and data["name"] != release.name:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "A released version cannot be renamed")
        _check_name(db, release.project_id, data["name"], exclude_id=release.id)
    if "notes" in data and data["notes"] is None:
        data["notes"] = ""
    if "planned_date" in data:
        data["planned_date"] = ensure_utc(data["planned_date"])
    for field, value in data.items():
        setattr(release, field, value)  # notes stay editable after release, e.g. to fix a typo
    db.commit()
    db.refresh(release)
    return _out(db, user, release, detail=True)


@router.delete("/releases/{release_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_release(release_id: int, user: CurrentUser, db: DbSession):
    """Only a planned release can be deleted; its tickets go back to the board."""
    release = _manageable(db, user, release_id)
    for t in list(release.tickets):
        log_activity(db, t, user, "release_removed", "release", release.name, None)
        t.release_id = None
    db.delete(release)
    db.commit()


@router.post("/releases/{release_id}/tickets", response_model=ReleaseDetail, summary="Move finished tickets into a release")
def add_tickets(release_id: int, payload: ReleaseTicketsIn, user: CurrentUser, db: DbSession):
    release = _manageable(db, user, release_id)
    ids = list(dict.fromkeys(payload.ticket_ids))
    tickets = {t.id: t for t in db.scalars(select(Ticket).where(Ticket.id.in_(ids))).unique()}
    problems = []
    for tid in ids:
        t = tickets.get(tid)
        if t is None or t.project_id != release.project_id:
            problems.append(f"#{tid} is not a ticket of {release.project.key}")
        elif t.status not in CLOSED_STATUSES:
            problems.append(f"{t.key} is not done yet")
        elif t.release_id not in (None, release.id) and t.release.status == ReleaseStatus.RELEASED:
            problems.append(f"{t.key} already shipped in {t.release.name}")
    if problems:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "; ".join(problems))
    for tid in ids:
        t = tickets[tid]
        if t.release_id != release.id:
            log_activity(db, t, user, "release_added", "release", t.release.name if t.release else None, release.name)
            t.release_id = release.id
    db.commit()
    db.refresh(release)
    return _out(db, user, release, detail=True)


@router.delete("/releases/{release_id}/tickets/{ticket_id}", response_model=ReleaseDetail)
def remove_ticket(release_id: int, ticket_id: int, user: CurrentUser, db: DbSession):
    release = _manageable(db, user, release_id)
    t = db.get(Ticket, ticket_id)
    if t is None or t.release_id != release.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "That ticket is not in this release")
    log_activity(db, t, user, "release_removed", "release", release.name, None)
    t.release_id = None
    db.commit()
    db.refresh(release)
    return _out(db, user, release, detail=True)


@router.post("/releases/{release_id}/release", response_model=ReleaseDetail, summary="Mark as released to production")
def publish_release(release_id: int, user: CurrentUser, db: DbSession):
    release = _manageable(db, user, release_id)
    tickets = list(release.tickets)
    if not tickets:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Add at least one finished ticket before releasing")

    for t in tickets:
        if t.status == TicketStatus.DONE:  # shipping is the owner's acceptance
            apply_status_change(t, TicketStatus.VERIFIED)
            log_activity(db, t, user, "status_changed", "status", TicketStatus.DONE, TicketStatus.VERIFIED)
        log_activity(db, t, user, "released", "release", None, release.name)
    release.status = ReleaseStatus.RELEASED
    release.released_at = utcnow()
    release.released_by = user.id

    members = list(db.scalars(select(ProjectMember.user_id).where(ProjectMember.project_id == release.project_id)))
    counts = Counter(t.type for t in tickets)
    summary = ", ".join(f"{counts[k]} {TYPE_HEADING[k].lower()}" for k in TYPE_ORDER if counts[k])
    notify(
        db, members, actor=user, type=NotificationType.RELEASE,
        message=f"{release.project.key} {release.name} was released to production ({summary})",
        slack=False,
    )
    db.commit()
    db.refresh(release)
    _post_to_slack(release, tickets, user.name)
    return _out(db, user, release, detail=True)


def _post_to_slack(release: Release, tickets: list[Ticket], who: str) -> None:
    from .. import slack

    if not slack.wants(NotificationType.RELEASE):
        return
    lines = [f":rocket: *{slack.escape(release.project.name)} {slack.escape(release.name)}* is live in production "
             f"- released by {slack.escape(who)} · <{_url(release)}|Release notes>"]
    by_type: dict[TicketType, list[Ticket]] = {}
    for t in tickets:
        by_type.setdefault(t.type, []).append(t)
    for kind in TYPE_ORDER:
        items = by_type.get(kind)
        if not items:
            continue
        lines.append(f"*{TYPE_HEADING[kind]}*")
        lines += [f"• {slack.ticket_link(t.key, t.title)}" for t in items[:30]]
        if len(items) > 30:
            lines.append(f"…and {len(items) - 30} more")
    text = "\n".join(lines)
    slack.enqueue(text)
