from datetime import datetime
from typing import Generic, TypeVar

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

from .models import (
    NotificationType,
    ProjectRole,
    Role,
    TicketPriority,
    TicketStatus,
    TicketType,
    UpcomingStatus,
)

T = TypeVar("T")


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class Page(BaseModel, Generic[T]):
    items: list[T]
    total: int
    limit: int
    offset: int


# --------------------------------------------------------------------------- #
# Users / auth
# --------------------------------------------------------------------------- #
class UserBrief(ORMModel):
    id: int
    name: str
    email: str


class UserOut(UserBrief):
    role: Role
    designation: str | None = None
    is_active: bool
    created_at: datetime


class UserCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    email: EmailStr
    password: str = Field(min_length=8, max_length=72)
    role: Role = Role.USER
    designation: str | None = Field(None, max_length=120)

    @field_validator("name")
    @classmethod
    def _strip_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("name must not be blank")
        return v


class UserUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=120)
    designation: str | None = Field(None, max_length=120)
    role: Role | None = None
    is_active: bool | None = None
    password: str | None = Field(None, min_length=8, max_length=72)


class PasswordChange(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8, max_length=72)


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut


# --------------------------------------------------------------------------- #
# Projects
# --------------------------------------------------------------------------- #
class ProjectBrief(ORMModel):
    id: int
    name: str
    key: str


class ProjectCreate(BaseModel):
    name: str = Field(min_length=2, max_length=150)
    key: str = Field(pattern=r"^[A-Z][A-Z0-9]{1,9}$", description="Short prefix for ticket keys, e.g. PAY")
    description: str = Field("", max_length=5000)
    owner_ids: list[int] = Field(min_length=1, description="Users who will own (manage) the project")

    @field_validator("key", mode="before")
    @classmethod
    def _upper_key(cls, v):
        return v.strip().upper() if isinstance(v, str) else v

    @field_validator("name")
    @classmethod
    def _strip_name(cls, v: str) -> str:
        return v.strip()


class ProjectUpdate(BaseModel):
    name: str | None = Field(None, min_length=2, max_length=150)
    description: str | None = Field(None, max_length=5000)
    is_active: bool | None = Field(None, description="Archive / unarchive (admin only)")


class ProjectOut(ORMModel):
    id: int
    name: str
    key: str
    description: str
    is_active: bool
    created_at: datetime
    my_role: str | None = None
    owners: list[UserBrief] = []
    member_count: int = 0
    ticket_count: int = 0
    open_ticket_count: int = 0


class MemberAdd(BaseModel):
    user_id: int
    role: ProjectRole = ProjectRole.DEVELOPER


class MemberRoleUpdate(BaseModel):
    role: ProjectRole


class MemberOut(ORMModel):
    user: UserBrief
    role: ProjectRole
    joined_at: datetime


# --------------------------------------------------------------------------- #
# Tickets
# --------------------------------------------------------------------------- #
class TicketCreate(BaseModel):
    title: str = Field(min_length=1, max_length=255)
    description: str = Field("", max_length=20000)
    priority: TicketPriority = TicketPriority.MEDIUM
    type: TicketType = TicketType.TASK
    assignee_id: int | None = Field(None, description="Project owners / admin only")
    due_date: datetime | None = None
    estimated_hours: float | None = Field(None, ge=0, le=10000)

    @field_validator("title")
    @classmethod
    def _strip_title(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("title must not be blank")
        return v


class TicketUpdate(BaseModel):
    title: str | None = Field(None, min_length=1, max_length=255)
    description: str | None = Field(None, max_length=20000)
    priority: TicketPriority | None = None
    type: TicketType | None = None
    due_date: datetime | None = None
    estimated_hours: float | None = Field(None, ge=0, le=10000)


class AssignIn(BaseModel):
    assignee_id: int | None = Field(None, description="null to unassign")


class StatusChange(BaseModel):
    status: TicketStatus


class TicketOut(ORMModel):
    id: int
    key: str
    number: int
    project: ProjectBrief
    title: str
    description: str
    status: TicketStatus
    priority: TicketPriority
    type: TicketType
    reporter: UserBrief
    assignee: UserBrief | None = None
    due_date: datetime | None = None
    is_overdue: bool
    estimated_hours: float | None = None
    spent_hours: float
    assigned_at: datetime | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None
    reopen_count: int
    created_at: datetime
    updated_at: datetime


class TicketDetail(TicketOut):
    comment_count: int = 0
    attachment_count: int = 0
    can_edit: bool = False
    can_assign: bool = False
    can_change_status: bool = False
    can_verify: bool = False  # owner looking at a ticket the developer marked done
    can_delete: bool = False


class ProjectTicketSummary(BaseModel):
    project: ProjectBrief
    total: int
    open: int
    overdue: int
    by_status: dict[str, int]


class MyTicketSummary(BaseModel):
    total: int
    open: int
    overdue: int
    by_status: dict[str, int]
    by_project: list[ProjectTicketSummary]


class ActivityOut(ORMModel):
    id: int
    ticket_id: int
    actor: UserBrief | None = None
    action: str
    field: str | None = None
    old_value: str | None = None
    new_value: str | None = None
    created_at: datetime


class WorklogCreate(BaseModel):
    hours: float = Field(gt=0, le=24)
    note: str = Field("", max_length=500)


class WorklogOut(ORMModel):
    id: int
    ticket_id: int
    user: UserBrief
    hours: float
    note: str
    logged_at: datetime


# --------------------------------------------------------------------------- #
# Comments / attachments / notifications
# --------------------------------------------------------------------------- #
class AttachmentOut(ORMModel):
    id: int
    ticket_id: int
    comment_id: int | None = None
    filename: str
    content_type: str
    size: int
    uploader: UserBrief
    created_at: datetime


class CommentCreate(BaseModel):
    body: str = Field(min_length=1, max_length=10000)
    mention_user_ids: list[int] = Field(
        default_factory=list,
        description="Explicit mentions. '@user@example.com' written in the body is also detected.",
    )

    @field_validator("body")
    @classmethod
    def _strip_body(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("comment must not be blank")
        return v


class CommentUpdate(CommentCreate):
    pass


class CommentOut(ORMModel):
    id: int
    ticket_id: int
    author: UserBrief
    body: str
    mentions: list[UserBrief] = []
    attachments: list[AttachmentOut] = []
    created_at: datetime
    edited_at: datetime | None = None


class NotificationOut(ORMModel):
    id: int
    type: NotificationType
    message: str
    ticket_id: int | None = None
    ticket_key: str | None = None
    actor: UserBrief | None = None
    is_read: bool
    created_at: datetime


# --------------------------------------------------------------------------- #
# Reports
# --------------------------------------------------------------------------- #
class DeveloperEfficiency(BaseModel):
    user: UserBrief
    assigned: int
    completed: int
    open: int
    in_progress: int
    blocked: int
    overdue_open: int
    completed_on_time: int
    completed_late: int
    tickets_reopened: int
    completion_rate: float | None = None
    on_time_rate: float | None = None
    first_time_right_rate: float | None = None
    avg_resolution_hours: float | None = None
    avg_time_to_start_hours: float | None = None
    estimated_hours: float = 0.0
    spent_hours: float = 0.0
    estimate_accuracy: float | None = None
    efficiency_score: float | None = None


class TeamSummary(BaseModel):
    developers: int
    assigned: int
    completed: int
    overdue_open: int
    avg_efficiency_score: float | None = None


class EfficiencyReport(BaseModel):
    date_from: datetime | None = None
    date_to: datetime | None = None
    project_id: int | None = None
    generated_at: datetime
    team: TeamSummary
    developers: list[DeveloperEfficiency]


class ProjectBreakdown(BaseModel):
    project: ProjectBrief
    assigned: int
    completed: int
    open: int
    overdue_open: int


class DeveloperEfficiencyDetail(DeveloperEfficiency):
    by_project: list[ProjectBreakdown]
    by_status: dict[str, int]


class ProjectOverview(BaseModel):
    project: ProjectBrief
    total: int
    open: int
    overdue: int


class OverviewReport(BaseModel):
    total_tickets: int
    open_tickets: int
    overdue_open: int
    unassigned_open: int
    created_last_7_days: int
    completed_last_7_days: int
    by_status: dict[str, int]
    by_priority: dict[str, int]
    by_project: list[ProjectOverview]


# --------------------------------------------------------------------------- #
# Upcoming tasks (requirements gathered before a ticket exists)
# --------------------------------------------------------------------------- #
class ReferenceLink(BaseModel):
    title: str = Field("", max_length=200)
    url: str = Field(min_length=1, max_length=2000)

    @field_validator("url")
    @classmethod
    def _http_only(cls, v: str) -> str:
        v = v.strip()
        if not (v.startswith("http://") or v.startswith("https://")):
            raise ValueError("must start with http:// or https://")
        return v

    @field_validator("title")
    @classmethod
    def _strip(cls, v: str) -> str:
        return v.strip()


class UpcomingCreate(BaseModel):
    title: str = Field(min_length=1, max_length=255)
    status: UpcomingStatus = UpcomingStatus.DRAFT
    priority: TicketPriority = TicketPriority.MEDIUM
    target_date: datetime | None = None
    requirements: str = Field("", max_length=50000)
    acceptance_criteria: str = Field("", max_length=20000)
    reference_links: list[ReferenceLink] = Field(default_factory=list, max_length=50)

    @field_validator("title")
    @classmethod
    def _strip_title(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("title must not be blank")
        return v


class UpcomingUpdate(BaseModel):
    title: str | None = Field(None, min_length=1, max_length=255)
    status: UpcomingStatus | None = None
    priority: TicketPriority | None = None
    target_date: datetime | None = None
    requirements: str | None = Field(None, max_length=50000)
    acceptance_criteria: str | None = Field(None, max_length=20000)
    reference_links: list[ReferenceLink] | None = Field(None, max_length=50)


class UpcomingDocumentOut(ORMModel):
    id: int
    task_id: int
    filename: str
    content_type: str
    size: int
    uploader: UserBrief
    created_at: datetime


class TicketRef(ORMModel):
    id: int
    key: str
    status: TicketStatus


class UpcomingOut(ORMModel):
    id: int
    project: ProjectBrief
    title: str
    status: UpcomingStatus
    priority: TicketPriority
    target_date: datetime | None = None
    requirements: str
    acceptance_criteria: str
    reference_links: list[ReferenceLink] = []
    creator: UserBrief | None = None
    ticket: TicketRef | None = None
    documents: list[UpcomingDocumentOut] = []
    criteria_total: int = 0  # "- [ ]" / "- [x]" items in the acceptance criteria
    criteria_done: int = 0
    can_edit: bool = False  # admins only
    can_convert: bool = False  # admins and project owners, until it has a ticket
    created_at: datetime
    updated_at: datetime


class ConvertIn(BaseModel):
    """Optional overrides when an upcoming task becomes a ticket."""

    type: TicketType = TicketType.FEATURE
    assignee_id: int | None = None
    due_date: datetime | None = None
    estimated_hours: float | None = Field(None, ge=0, le=10000)
    copy_documents: bool = True
