"""Authorisation rules.

Global role  : admin | user
Project role : owner | developer   (admin acts as owner of every project)

* Non-members get a 404 for a project / ticket so its existence is not leaked.
* Members who lack a specific right get a 403.
"""
from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import Project, ProjectMember, ProjectRole, Role, Ticket, User


def is_admin(user: User) -> bool:
    return user.role == Role.ADMIN


def get_membership(db: Session, project_id: int, user_id: int) -> ProjectMember | None:
    return db.get(ProjectMember, (project_id, user_id))


def is_project_member(db: Session, user: User, project_id: int) -> bool:
    return is_admin(user) or get_membership(db, project_id, user.id) is not None


def is_project_owner(db: Session, user: User, project_id: int) -> bool:
    if is_admin(user):
        return True
    membership = get_membership(db, project_id, user.id)
    return membership is not None and membership.role == ProjectRole.OWNER


def project_owner_ids(db: Session, project_id: int) -> list[int]:
    return list(
        db.scalars(
            select(ProjectMember.user_id).where(
                ProjectMember.project_id == project_id,
                ProjectMember.role == ProjectRole.OWNER,
            )
        )
    )


def get_project_or_404(db: Session, project_id: int) -> Project:
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
    return project


def require_member(db: Session, user: User, project_id: int) -> Project:
    project = get_project_or_404(db, project_id)
    if not is_project_member(db, user, project_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
    return project


def require_owner(db: Session, user: User, project_id: int) -> Project:
    project = require_member(db, user, project_id)
    if not is_project_owner(db, user, project_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only project owners can do this")
    return project


def get_ticket_for_user(db: Session, ticket_id: int, user: User) -> Ticket:
    ticket = db.get(Ticket, ticket_id)
    if ticket is None or not is_project_member(db, user, ticket.project_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Ticket not found")
    return ticket


def ticket_permissions(db: Session, user: User, ticket: Ticket) -> dict[str, bool]:
    owner = is_project_owner(db, user, ticket.project_id)
    assignee = ticket.assignee_id == user.id
    reporter = ticket.reporter_id == user.id
    return {
        "owner": owner,
        "assignee": assignee,
        "reporter": reporter,
        "can_edit": owner or assignee or reporter,
        "can_assign": owner,
        "can_change_status": owner or assignee,
        "can_delete": owner,
    }
