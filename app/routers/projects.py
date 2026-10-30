from collections import defaultdict

from fastapi import APIRouter, HTTPException, Query, status
from sqlalchemy import case, func, select
from sqlalchemy.exc import IntegrityError

from ..deps import AdminUser, CurrentUser, DbSession
from ..models import (
    assigned_to,
    CLOSED_STATUSES,
    NotificationType,
    Project,
    ProjectMember,
    ProjectRole,
    Ticket,
    TicketStatus,
    User,
)
from ..permissions import (
    get_membership,
    is_admin,
    require_member,
    require_owner,
)
from ..schemas import (
    MemberAdd,
    MemberOut,
    MemberRoleUpdate,
    ProjectCreate,
    ProjectOut,
    ProjectUpdate,
)
from ..services import log_activity, notify, set_assignees

router = APIRouter(prefix="/projects", tags=["Projects"])


def _serialize(db, projects: list[Project], user: User) -> list[ProjectOut]:
    """Attach owners, counts and the caller's role to each project with a handful of grouped queries."""
    ids = [p.id for p in projects]
    if not ids:
        return []

    member_counts = dict(
        db.execute(
            select(ProjectMember.project_id, func.count())
            .where(ProjectMember.project_id.in_(ids))
            .group_by(ProjectMember.project_id)
        ).all()
    )
    ticket_counts = {
        pid: (total, open_)
        for pid, total, open_ in db.execute(
            select(
                Ticket.project_id,
                func.count(),
                func.coalesce(func.sum(case((Ticket.status.not_in(CLOSED_STATUSES), 1), else_=0)), 0),
            )
            .where(Ticket.project_id.in_(ids))
            .group_by(Ticket.project_id)
        ).all()
    }
    owners: dict[int, list[User]] = defaultdict(list)
    for pid, owner in db.execute(
        select(ProjectMember.project_id, User)
        .join(User, User.id == ProjectMember.user_id)
        .where(ProjectMember.project_id.in_(ids), ProjectMember.role == ProjectRole.OWNER)
        .order_by(User.name)
    ).all():
        owners[pid].append(owner)
    my_roles = {
        pid: role.value
        for pid, role in db.execute(
            select(ProjectMember.project_id, ProjectMember.role).where(
                ProjectMember.project_id.in_(ids), ProjectMember.user_id == user.id
            )
        ).all()
    }

    out = []
    for p in projects:
        item = ProjectOut.model_validate(p)
        item.owners = owners.get(p.id, [])  # type: ignore[assignment]
        item.member_count = member_counts.get(p.id, 0)
        total, open_ = ticket_counts.get(p.id, (0, 0))
        item.ticket_count = int(total)
        item.open_ticket_count = int(open_)
        item.my_role = my_roles.get(p.id) or ("admin" if is_admin(user) else None)
        out.append(item)
    return out


def _active_user_or_400(db, user_id: int) -> User:
    user = db.get(User, user_id)
    if user is None or not user.is_active:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"User {user_id} does not exist or is inactive")
    return user


@router.post("", response_model=ProjectOut, status_code=status.HTTP_201_CREATED)
def create_project(payload: ProjectCreate, admin: AdminUser, db: DbSession):
    """Admin creates a project and names its owner(s). Owners then add developers and assign work."""
    if db.scalar(select(Project.id).where(Project.key == payload.key)):
        raise HTTPException(status.HTTP_409_CONFLICT, f"Project key '{payload.key}' is already used")
    if db.scalar(select(Project.id).where(func.lower(Project.name) == payload.name.lower())):
        raise HTTPException(status.HTTP_409_CONFLICT, "A project with this name already exists")

    owner_ids = list(dict.fromkeys(payload.owner_ids))
    owners = [_active_user_or_400(db, uid) for uid in owner_ids]

    project = Project(
        name=payload.name, key=payload.key, description=payload.description, created_by=admin.id
    )
    project.members = [ProjectMember(user_id=o.id, role=ProjectRole.OWNER) for o in owners]
    db.add(project)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "Project name or key already exists")

    notify(
        db,
        owner_ids,
        actor=admin,
        type=NotificationType.PROJECT_MEMBER,
        message=f"You were made an owner of project {project.key} - {project.name}",
    )
    db.commit()
    db.refresh(project)
    return _serialize(db, [project], admin)[0]


@router.get("", response_model=list[ProjectOut])
def list_projects(
    user: CurrentUser,
    db: DbSession,
    include_archived: bool = False,
    q: str | None = Query(None, min_length=1, max_length=100),
):
    """Admin: every project. Everyone else: projects they belong to."""
    stmt = select(Project).order_by(Project.name)
    if not is_admin(user):
        stmt = stmt.where(
            Project.id.in_(select(ProjectMember.project_id).where(ProjectMember.user_id == user.id))
        )
    if not include_archived:
        stmt = stmt.where(Project.is_active.is_(True))
    if q:
        stmt = stmt.where(Project.name.ilike(f"%{q}%") | Project.key.ilike(f"%{q}%"))
    return _serialize(db, list(db.scalars(stmt).all()), user)


@router.get("/{project_id}", response_model=ProjectOut)
def get_project(project_id: int, user: CurrentUser, db: DbSession):
    project = require_member(db, user, project_id)
    return _serialize(db, [project], user)[0]


@router.patch("/{project_id}", response_model=ProjectOut)
def update_project(project_id: int, payload: ProjectUpdate, user: CurrentUser, db: DbSession):
    project = require_owner(db, user, project_id)
    data = payload.model_dump(exclude_unset=True)
    if "is_active" in data and not is_admin(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only an admin can archive or restore a project")
    if "name" in data and data["name"]:
        data["name"] = data["name"].strip()
        clash = db.scalar(
            select(Project.id).where(
                func.lower(Project.name) == data["name"].lower(), Project.id != project.id
            )
        )
        if clash:
            raise HTTPException(status.HTTP_409_CONFLICT, "A project with this name already exists")
    for field, value in data.items():
        if value is not None:
            setattr(project, field, value)
    db.commit()
    db.refresh(project)
    return _serialize(db, [project], user)[0]


# --------------------------------------------------------------------------- #
# Members
# --------------------------------------------------------------------------- #
@router.get("/{project_id}/members", response_model=list[MemberOut])
def list_members(project_id: int, user: CurrentUser, db: DbSession):
    require_member(db, user, project_id)
    return db.scalars(
        select(ProjectMember)
        .join(User, User.id == ProjectMember.user_id)
        .where(ProjectMember.project_id == project_id)
        .order_by(ProjectMember.role.desc(), User.name)
    ).all()


@router.post("/{project_id}/members", response_model=MemberOut, status_code=status.HTTP_201_CREATED)
def add_member(project_id: int, payload: MemberAdd, user: CurrentUser, db: DbSession):
    """Owners add developers. Making someone an *owner* needs an admin."""
    project = require_owner(db, user, project_id)
    if payload.role == ProjectRole.OWNER and not is_admin(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only an admin can add project owners")
    target = _active_user_or_400(db, payload.user_id)
    if get_membership(db, project_id, target.id):
        raise HTTPException(status.HTTP_409_CONFLICT, "User is already a member of this project")

    member = ProjectMember(project_id=project_id, user_id=target.id, role=payload.role)
    db.add(member)
    notify(
        db,
        [target.id],
        actor=user,
        type=NotificationType.PROJECT_MEMBER,
        message=f"You were added to project {project.key} - {project.name} as {payload.role.value}",
    )
    db.commit()
    db.refresh(member)
    return member


def _owner_count(db, project_id: int) -> int:
    return db.scalar(
        select(func.count()).where(
            ProjectMember.project_id == project_id, ProjectMember.role == ProjectRole.OWNER
        )
    ) or 0


@router.patch("/{project_id}/members/{user_id}", response_model=MemberOut)
def change_member_role(
    project_id: int, user_id: int, payload: MemberRoleUpdate, _admin: AdminUser, db: DbSession
):
    """Admin only: promote a developer to owner or demote an owner."""
    get_project = require_member(db, _admin, project_id)  # 404 if project missing
    member = get_membership(db, get_project.id, user_id)
    if member is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Member not found")
    if (
        member.role == ProjectRole.OWNER
        and payload.role != ProjectRole.OWNER
        and _owner_count(db, project_id) <= 1
    ):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "A project must keep at least one owner")
    member.role = payload.role
    db.commit()
    db.refresh(member)
    return member


@router.delete("/{project_id}/members/{user_id}")
def remove_member(project_id: int, user_id: int, user: CurrentUser, db: DbSession):
    """Remove a member. Their unfinished tickets in this project go back to *unassigned / todo*."""
    require_owner(db, user, project_id)
    member = get_membership(db, project_id, user_id)
    if member is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Member not found")
    if member.role == ProjectRole.OWNER:
        if not is_admin(user):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Only an admin can remove a project owner")
        if _owner_count(db, project_id) <= 1:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "A project must keep at least one owner")

    open_tickets = db.scalars(
        select(Ticket).where(
            Ticket.project_id == project_id,
            assigned_to(user_id),
            Ticket.status.not_in(CLOSED_STATUSES),
        )
    ).unique().all()
    for ticket in open_tickets:
        # Shared tickets just lose this person (the others carry on); solo tickets become unassigned.
        log_activity(db, ticket, user, "unassigned", "assignee", user_id, None)
        set_assignees(ticket, [uid for uid in ticket.assignee_ids if uid != user_id])

    db.delete(member)
    db.commit()
    return {"removed": True, "unassigned_tickets": len(open_tickets)}
