from fastapi import APIRouter, HTTPException, Query, status
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError

from ..deps import AdminUser, CurrentUser, DbSession
from ..models import ProjectMember, Role, User
from ..permissions import is_admin
from ..schemas import Page, UserBrief, UserCreate, UserOut, UserUpdate
from ..security import hash_password
from ..utils import escape_like, paginate

router = APIRouter(prefix="/users", tags=["Users"])


@router.post("", response_model=UserOut, status_code=status.HTTP_201_CREATED)
def create_user(payload: UserCreate, _admin: AdminUser, db: DbSession):
    """Admin creates developer / owner / admin accounts. (Project ownership is per project.)"""
    email = payload.email.lower()
    if db.scalar(select(User.id).where(User.email == email)):
        raise HTTPException(status.HTTP_409_CONFLICT, "A user with this e-mail already exists")
    user = User(
        name=payload.name,
        email=email,
        hashed_password=hash_password(payload.password),
        role=payload.role,
        designation=payload.designation,
    )
    db.add(user)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "A user with this e-mail already exists")
    db.refresh(user)
    return user


@router.get("", response_model=Page[UserOut])
def list_users(
    _admin: AdminUser,
    db: DbSession,
    q: str | None = Query(None, min_length=1, max_length=100, description="Name or e-mail contains"),
    role: Role | None = None,
    is_active: bool | None = None,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    stmt = select(User).order_by(User.name, User.id)
    if q:
        like = f"%{escape_like(q)}%"
        stmt = stmt.where(or_(User.name.ilike(like, escape="\\"), User.email.ilike(like, escape="\\")))
    if role:
        stmt = stmt.where(User.role == role)
    if is_active is not None:
        stmt = stmt.where(User.is_active.is_(is_active))
    items, total = paginate(db, stmt, limit, offset)
    return Page[UserOut](items=items, total=total, limit=limit, offset=offset)


@router.get("/lookup", response_model=list[UserBrief], summary="Find users (e.g. for @mentions / assignee pickers)")
def lookup_users(
    user: CurrentUser,
    db: DbSession,
    q: str = Query("", max_length=100),
    project_id: int | None = Query(None, description="Restrict to members of this project"),
    limit: int = Query(20, ge=1, le=50),
):
    """Admins can search everyone; other users only see people they share a project with."""
    stmt = select(User).where(User.is_active.is_(True)).order_by(User.name).limit(limit)

    if project_id is not None:
        from ..permissions import require_member

        require_member(db, user, project_id)
        stmt = stmt.where(
            User.id.in_(select(ProjectMember.user_id).where(ProjectMember.project_id == project_id))
        )
    elif not is_admin(user):
        my_projects = select(ProjectMember.project_id).where(ProjectMember.user_id == user.id)
        stmt = stmt.where(
            User.id.in_(select(ProjectMember.user_id).where(ProjectMember.project_id.in_(my_projects)))
        )

    if q:
        like = f"%{escape_like(q)}%"
        stmt = stmt.where(or_(User.name.ilike(like, escape="\\"), User.email.ilike(like, escape="\\")))
    return db.scalars(stmt).all()


@router.get("/{user_id}", response_model=UserOut)
def get_user(user_id: int, _admin: AdminUser, db: DbSession):
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")
    return user


@router.patch("/{user_id}", response_model=UserOut)
def update_user(user_id: int, payload: UserUpdate, admin: AdminUser, db: DbSession):
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")

    data = payload.model_dump(exclude_unset=True)
    nulls = [f for f in ("name", "role", "is_active", "password") if f in data and data[f] is None]
    if nulls:
        raise HTTPException(422, f"These fields cannot be null: {', '.join(nulls)}")
    if user.id == admin.id:
        if data.get("is_active") is False:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "You cannot deactivate your own account")
        if "role" in data and data["role"] != Role.ADMIN:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "You cannot remove your own admin role")

    password = data.pop("password", None)
    for field, value in data.items():
        setattr(user, field, value)
    if password:
        user.hashed_password = hash_password(password)
    db.commit()
    db.refresh(user)
    return user
