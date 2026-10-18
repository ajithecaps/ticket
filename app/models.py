import enum
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Enum as SAEnum,
    Float,
    ForeignKey,
    Index,
    JSON,
    String,
    Table,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.types import TypeDecorator

from .database import Base
from .utils import utcnow


# --------------------------------------------------------------------------- #
# Enums
# --------------------------------------------------------------------------- #
class Role(str, enum.Enum):
    ADMIN = "admin"
    USER = "user"


class ProjectRole(str, enum.Enum):
    OWNER = "owner"
    DEVELOPER = "developer"


class TicketStatus(str, enum.Enum):
    TODO = "todo"
    IN_PROGRESS = "in_progress"
    BLOCKED = "blocked"
    IN_REVIEW = "in_review"
    DONE = "done"  # finished by the developer, waiting for a project owner to cross-check it
    VERIFIED = "verified"  # checked and accepted by a project owner - the ticket is closed


# Both count as "finished" for open/overdue counts and the efficiency metrics.
CLOSED_STATUSES = (TicketStatus.DONE, TicketStatus.VERIFIED)


class TicketPriority(str, enum.Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class TicketType(str, enum.Enum):
    BUG = "bug"
    FEATURE = "feature"
    TASK = "task"
    IMPROVEMENT = "improvement"


class NotificationType(str, enum.Enum):
    TICKET_CREATED = "ticket_created"
    ASSIGNED = "assigned"
    UNASSIGNED = "unassigned"
    STATUS_CHANGED = "status_changed"
    TICKET_UPDATED = "ticket_updated"
    COMMENT = "comment"
    MENTION = "mention"
    PROJECT_MEMBER = "project_member"
    OVERDUE = "overdue"
    UPCOMING = "upcoming"
    RELEASE = "release"
    SPRINT = "sprint"
    CHAT_MENTION = "chat_mention"


class SprintStatus(str, enum.Enum):
    PLANNED = "planned"
    ACTIVE = "active"  # at most one per project
    COMPLETED = "completed"


class ReleaseStatus(str, enum.Enum):
    PLANNED = "planned"  # collecting finished tickets
    RELEASED = "released"  # shipped to production - locked


class UpcomingStatus(str, enum.Enum):
    """Planning stages of an upcoming task (requirements gathered before any ticket exists)."""

    DRAFT = "draft"  # still collecting requirements
    READY = "ready"  # requirements and acceptance criteria agreed
    CONVERTED = "converted"  # turned into a ticket
    DROPPED = "dropped"  # will not be done


PRIORITY_RANK = {
    TicketPriority.LOW: 1,
    TicketPriority.MEDIUM: 2,
    TicketPriority.HIGH: 3,
    TicketPriority.CRITICAL: 4,
}


class UTCDateTime(TypeDecorator):
    """Always store UTC and always return timezone-aware datetimes (SQLite drops tzinfo)."""

    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)

    def process_result_value(self, value, dialect):
        if value is None:
            return None
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)


def enum_column(enum_cls, **kwargs):
    """Store enum *values* (e.g. 'in_progress') as plain VARCHAR - portable and migration friendly."""
    return mapped_column(
        SAEnum(
            enum_cls,
            native_enum=False,
            length=20,
            values_callable=lambda e: [m.value for m in e],
        ),
        **kwargs,
    )


# --------------------------------------------------------------------------- #
# Tables
# --------------------------------------------------------------------------- #
class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    hashed_password: Mapped[str] = mapped_column(String(255))
    role: Mapped[Role] = enum_column(Role, default=Role.USER)
    designation: Mapped[str | None] = mapped_column(String(120), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(150), unique=True)
    key: Mapped[str] = mapped_column(String(10), unique=True, index=True)
    description: Mapped[str] = mapped_column(Text, default="")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    ticket_counter: Mapped[int] = mapped_column(default=0)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)

    members: Mapped[list["ProjectMember"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    tickets: Mapped[list["Ticket"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )


class ProjectMember(Base):
    __tablename__ = "project_members"

    project_id: Mapped[int] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True, index=True
    )
    role: Mapped[ProjectRole] = enum_column(ProjectRole, default=ProjectRole.DEVELOPER)
    joined_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)

    project: Mapped[Project] = relationship(back_populates="members")
    user: Mapped[User] = relationship(lazy="joined")


class Ticket(Base):
    __tablename__ = "tickets"
    __table_args__ = (
        UniqueConstraint("project_id", "number", name="uq_ticket_project_number"),
        Index("ix_tickets_assignee_status", "assignee_id", "status"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    number: Mapped[int] = mapped_column()  # per-project sequence -> "PAY-12"
    title: Mapped[str] = mapped_column(String(255))
    description: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[TicketStatus] = enum_column(TicketStatus, default=TicketStatus.TODO, index=True)
    priority: Mapped[TicketPriority] = enum_column(TicketPriority, default=TicketPriority.MEDIUM)
    type: Mapped[TicketType] = enum_column(TicketType, default=TicketType.TASK)

    reporter_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    assignee_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)

    # Planned window for the timeline / overlap checks: start_date -> due_date (both optional).
    start_date: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    due_date: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    estimated_hours: Mapped[float | None] = mapped_column(Float, nullable=True)
    spent_hours: Mapped[float] = mapped_column(Float, default=0.0)

    # Timestamps that drive the efficiency report
    assigned_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    reopen_count: Mapped[int] = mapped_column(default=0)
    # Finished tickets are moved into a release; they then leave the board and default lists.
    release_id: Mapped[int | None] = mapped_column(
        ForeignKey("releases.id", ondelete="SET NULL"), nullable=True, index=True
    )
    # The sprint the ticket is planned into; None = backlog.
    sprint_id: Mapped[int | None] = mapped_column(
        ForeignKey("sprints.id", ondelete="SET NULL"), nullable=True, index=True
    )

    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, onupdate=utcnow)

    project: Mapped[Project] = relationship(back_populates="tickets", lazy="joined")
    release: Mapped["Release | None"] = relationship(back_populates="tickets", lazy="joined")
    sprint: Mapped["Sprint | None"] = relationship(back_populates="tickets", lazy="joined")
    reporter: Mapped[User] = relationship(foreign_keys=[reporter_id], lazy="joined")
    assignee: Mapped[User | None] = relationship(foreign_keys=[assignee_id], lazy="joined")

    comments: Mapped[list["Comment"]] = relationship(
        back_populates="ticket", cascade="all, delete-orphan", order_by="Comment.id"
    )
    attachments: Mapped[list["Attachment"]] = relationship(
        back_populates="ticket", cascade="all, delete-orphan", order_by="Attachment.id"
    )
    worklogs: Mapped[list["Worklog"]] = relationship(
        back_populates="ticket", cascade="all, delete-orphan", order_by="Worklog.id"
    )
    activities: Mapped[list["Activity"]] = relationship(
        back_populates="ticket", cascade="all, delete-orphan", order_by="Activity.id"
    )

    @property
    def key(self) -> str:
        return f"{self.project.key}-{self.number}"

    @property
    def is_overdue(self) -> bool:
        return (
            self.due_date is not None
            and self.status not in CLOSED_STATUSES
            and self.due_date < utcnow()
        )


comment_mentions = Table(
    "comment_mentions",
    Base.metadata,
    Column("comment_id", ForeignKey("comments.id", ondelete="CASCADE"), primary_key=True),
    Column("user_id", ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
)


class Comment(Base):
    __tablename__ = "comments"

    id: Mapped[int] = mapped_column(primary_key=True)
    ticket_id: Mapped[int] = mapped_column(
        ForeignKey("tickets.id", ondelete="CASCADE"), index=True
    )
    author_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    body: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    edited_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)

    ticket: Mapped[Ticket] = relationship(back_populates="comments")
    author: Mapped[User] = relationship(lazy="joined")
    mentions: Mapped[list[User]] = relationship(secondary=comment_mentions, lazy="selectin")
    # Read-only on purpose: attachments are owned by the ticket; comment deletion removes them explicitly.
    attachments: Mapped[list["Attachment"]] = relationship(
        viewonly=True, foreign_keys="Attachment.comment_id", lazy="selectin"
    )


class Attachment(Base):
    __tablename__ = "attachments"

    id: Mapped[int] = mapped_column(primary_key=True)
    ticket_id: Mapped[int] = mapped_column(
        ForeignKey("tickets.id", ondelete="CASCADE"), index=True
    )
    comment_id: Mapped[int | None] = mapped_column(
        ForeignKey("comments.id", ondelete="CASCADE"), nullable=True, index=True
    )
    uploaded_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    filename: Mapped[str] = mapped_column(String(255))  # original, sanitised
    stored_name: Mapped[str] = mapped_column(String(255))  # random name on disk
    content_type: Mapped[str] = mapped_column(String(120), default="application/octet-stream")
    size: Mapped[int] = mapped_column(default=0)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)

    ticket: Mapped[Ticket] = relationship(back_populates="attachments")
    uploader: Mapped[User] = relationship(lazy="joined", foreign_keys=[uploaded_by])


class Worklog(Base):
    __tablename__ = "worklogs"

    id: Mapped[int] = mapped_column(primary_key=True)
    ticket_id: Mapped[int] = mapped_column(
        ForeignKey("tickets.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    hours: Mapped[float] = mapped_column(Float)
    note: Mapped[str] = mapped_column(String(500), default="")
    logged_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)

    ticket: Mapped[Ticket] = relationship(back_populates="worklogs")
    user: Mapped[User] = relationship(lazy="joined")


class Activity(Base):
    __tablename__ = "activities"

    id: Mapped[int] = mapped_column(primary_key=True)
    ticket_id: Mapped[int] = mapped_column(
        ForeignKey("tickets.id", ondelete="CASCADE"), index=True
    )
    actor_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    action: Mapped[str] = mapped_column(String(50))
    field: Mapped[str | None] = mapped_column(String(50), nullable=True)
    old_value: Mapped[str | None] = mapped_column(Text, nullable=True)
    new_value: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)

    ticket: Mapped[Ticket] = relationship(back_populates="activities")
    actor: Mapped[User | None] = relationship(lazy="joined")


class Notification(Base):
    __tablename__ = "notifications"
    __table_args__ = (Index("ix_notifications_user_read", "user_id", "is_read"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    actor_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    type: Mapped[NotificationType] = enum_column(NotificationType)
    message: Mapped[str] = mapped_column(String(500))
    ticket_id: Mapped[int | None] = mapped_column(
        ForeignKey("tickets.id", ondelete="CASCADE"), nullable=True
    )
    is_read: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)

    actor: Mapped[User | None] = relationship(foreign_keys=[actor_id], lazy="joined")
    ticket: Mapped[Ticket | None] = relationship(lazy="joined")


class UpcomingTask(Base):
    """Planned work for a project, kept apart from tickets until it is ready to be worked on.

    Only admins create and edit these; project members can read them. Converting one creates a normal
    ticket and links it back here.
    """

    __tablename__ = "upcoming_tasks"

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(255))
    status: Mapped[UpcomingStatus] = enum_column(UpcomingStatus, default=UpcomingStatus.DRAFT, index=True)
    priority: Mapped[TicketPriority] = enum_column(TicketPriority, default=TicketPriority.MEDIUM)
    target_date: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    requirements: Mapped[str] = mapped_column(Text, default="")  # Markdown
    acceptance_criteria: Mapped[str] = mapped_column(Text, default="")  # Markdown, usually a checklist
    reference_links: Mapped[list] = mapped_column(JSON, default=list)  # [{"title": str, "url": str}]
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    ticket_id: Mapped[int | None] = mapped_column(
        ForeignKey("tickets.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, onupdate=utcnow)

    project: Mapped[Project] = relationship(lazy="joined")
    creator: Mapped[User | None] = relationship(lazy="joined", foreign_keys=[created_by])
    ticket: Mapped[Ticket | None] = relationship(lazy="joined", foreign_keys=[ticket_id])
    documents: Mapped[list["UpcomingDocument"]] = relationship(
        back_populates="task", cascade="all, delete-orphan", order_by="UpcomingDocument.id"
    )


class UpcomingDocument(Base):
    __tablename__ = "upcoming_documents"

    id: Mapped[int] = mapped_column(primary_key=True)
    task_id: Mapped[int] = mapped_column(ForeignKey("upcoming_tasks.id", ondelete="CASCADE"), index=True)
    uploaded_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    filename: Mapped[str] = mapped_column(String(255))
    stored_name: Mapped[str] = mapped_column(String(255))
    content_type: Mapped[str] = mapped_column(String(120), default="application/octet-stream")
    size: Mapped[int] = mapped_column(default=0)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)

    task: Mapped[UpcomingTask] = relationship(back_populates="documents")
    uploader: Mapped[User] = relationship(lazy="joined", foreign_keys=[uploaded_by])


class Release(Base):
    """A production release of one project: finished tickets grouped under a version name."""

    __tablename__ = "releases"
    __table_args__ = (UniqueConstraint("project_id", "name", name="uq_release_project_name"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(100))  # e.g. "v1.4.0" or "Sprint 12"
    notes: Mapped[str] = mapped_column(Text, default="")  # Markdown release notes
    status: Mapped[ReleaseStatus] = enum_column(ReleaseStatus, default=ReleaseStatus.PLANNED, index=True)
    planned_date: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    released_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    released_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, onupdate=utcnow)

    project: Mapped[Project] = relationship(lazy="joined")
    creator: Mapped[User | None] = relationship(lazy="joined", foreign_keys=[created_by])
    releaser: Mapped[User | None] = relationship(lazy="joined", foreign_keys=[released_by])
    tickets: Mapped[list[Ticket]] = relationship(back_populates="release", order_by="Ticket.number")


class DocPage(Base):
    """A documentation page of a project (Markdown). Pages nest via parent_id; every save keeps a revision."""

    __tablename__ = "doc_pages"

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    parent_id: Mapped[int | None] = mapped_column(ForeignKey("doc_pages.id", ondelete="SET NULL"), nullable=True, index=True)
    title: Mapped[str] = mapped_column(String(200))
    content: Mapped[str] = mapped_column(Text, default="")
    position: Mapped[int] = mapped_column(default=0)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    updated_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, onupdate=utcnow)

    project: Mapped[Project] = relationship(lazy="joined")
    creator: Mapped[User | None] = relationship(lazy="joined", foreign_keys=[created_by])
    editor: Mapped[User | None] = relationship(lazy="joined", foreign_keys=[updated_by])
    revisions: Mapped[list["DocRevision"]] = relationship(
        back_populates="page", cascade="all, delete-orphan", order_by="DocRevision.id.desc()"
    )


class DocRevision(Base):
    """The previous version of a page, saved each time it is edited."""

    __tablename__ = "doc_revisions"

    id: Mapped[int] = mapped_column(primary_key=True)
    page_id: Mapped[int] = mapped_column(ForeignKey("doc_pages.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(200))
    content: Mapped[str] = mapped_column(Text, default="")
    edited_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)

    page: Mapped[DocPage] = relationship(back_populates="revisions")
    author: Mapped[User | None] = relationship(lazy="joined", foreign_keys=[edited_by])


class Sprint(Base):
    """A time-boxed iteration of one project. Tickets are planned into it from the backlog."""

    __tablename__ = "sprints"

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(100))
    goal: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[SprintStatus] = enum_column(SprintStatus, default=SprintStatus.PLANNED, index=True)
    start_date: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    end_date: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, onupdate=utcnow)

    project: Mapped[Project] = relationship(lazy="joined")
    tickets: Mapped[list[Ticket]] = relationship(back_populates="sprint", order_by="Ticket.number")


class AppSetting(Base):
    """A setting saved from the admin panel. Overrides the matching .env value; secrets are encrypted."""

    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[str] = mapped_column(Text, default="")
    is_secret: Mapped[bool] = mapped_column(Boolean, default=False)
    updated_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, onupdate=utcnow)


# --------------------------------------------------------------------------- #
# Team chat
# --------------------------------------------------------------------------- #
class ChatChannel(Base):
    """A conversation. kind: "project" (everyone in the project), "channel" (public or private), "dm"."""

    __tablename__ = "chat_channels"

    id: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[str] = mapped_column(String(16), index=True)
    name: Mapped[str | None] = mapped_column(String(80), nullable=True)
    topic: Mapped[str] = mapped_column(String(300), default="")
    project_id: Mapped[int | None] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), nullable=True, unique=True)
    is_private: Mapped[bool] = mapped_column(Boolean, default=False)
    archived: Mapped[bool] = mapped_column(Boolean, default=False)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    last_message_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)

    project: Mapped[Project | None] = relationship(lazy="joined")


class ChatMember(Base):
    """Membership + read position. Project channels get rows lazily (access comes from the project)."""

    __tablename__ = "chat_members"

    channel_id: Mapped[int] = mapped_column(ForeignKey("chat_channels.id", ondelete="CASCADE"), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True, index=True)
    last_read_id: Mapped[int] = mapped_column(default=0)
    muted: Mapped[bool] = mapped_column(Boolean, default=False)
    joined_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)


class ChatMessage(Base):
    __tablename__ = "chat_messages"
    __table_args__ = (Index("ix_chat_messages_channel_parent", "channel_id", "parent_id", "id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    channel_id: Mapped[int] = mapped_column(ForeignKey("chat_channels.id", ondelete="CASCADE"))
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    parent_id: Mapped[int | None] = mapped_column(ForeignKey("chat_messages.id", ondelete="CASCADE"), nullable=True)
    body: Mapped[str] = mapped_column(Text, default="")
    reply_count: Mapped[int] = mapped_column(default=0)
    last_reply_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    pinned: Mapped[bool] = mapped_column(Boolean, default=False)
    deleted: Mapped[bool] = mapped_column(Boolean, default=False)
    edited_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)

    user: Mapped[User | None] = relationship(lazy="joined")
    reactions: Mapped[list["ChatReaction"]] = relationship(cascade="all, delete-orphan", lazy="selectin")
    files: Mapped[list["ChatFile"]] = relationship(cascade="all, delete-orphan", lazy="selectin")
    call: Mapped["ChatCall | None"] = relationship(
        primaryjoin="ChatCall.message_id == ChatMessage.id", foreign_keys="ChatCall.message_id", uselist=False, viewonly=True, lazy="selectin"
    )


class ChatReaction(Base):
    __tablename__ = "chat_reactions"

    message_id: Mapped[int] = mapped_column(ForeignKey("chat_messages.id", ondelete="CASCADE"), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    emoji: Mapped[str] = mapped_column(String(32), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)


class ChatFile(Base):
    __tablename__ = "chat_files"

    id: Mapped[int] = mapped_column(primary_key=True)
    message_id: Mapped[int] = mapped_column(ForeignKey("chat_messages.id", ondelete="CASCADE"), index=True)
    filename: Mapped[str] = mapped_column(String(255))
    stored_name: Mapped[str] = mapped_column(String(255))
    content_type: Mapped[str] = mapped_column(String(120), default="application/octet-stream")
    size: Mapped[int] = mapped_column(default=0)


class ChatEvent(Base):
    """Outbox of real-time events. Every worker tails it and pushes new rows to its WebSocket clients."""

    __tablename__ = "chat_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    channel_id: Mapped[int | None] = mapped_column(nullable=True)
    user_ids: Mapped[str] = mapped_column(Text, default="")  # explicit recipients ("1,5,9"); empty = channel audience
    type: Mapped[str] = mapped_column(String(32))
    payload: Mapped[str] = mapped_column(Text, default="{}")
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, index=True)


class ChatPresence(Base):
    __tablename__ = "chat_presence"

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    last_seen: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)


class ChatCall(Base):
    """An audio/video call in a conversation. Media flows peer-to-peer (WebRTC); the server only
    relays signalling and keeps the call log shown in the chat."""

    __tablename__ = "chat_calls"

    id: Mapped[int] = mapped_column(primary_key=True)
    channel_id: Mapped[int] = mapped_column(ForeignKey("chat_channels.id", ondelete="CASCADE"), index=True)
    message_id: Mapped[int | None] = mapped_column(ForeignKey("chat_messages.id", ondelete="SET NULL"), nullable=True, unique=True)
    started_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    video: Mapped[bool] = mapped_column(Boolean, default=False)
    started_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    answered_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    ended_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)

    participants: Mapped[list["ChatCallParticipant"]] = relationship(cascade="all, delete-orphan", lazy="selectin")


class ChatCallParticipant(Base):
    __tablename__ = "chat_call_participants"

    call_id: Mapped[int] = mapped_column(ForeignKey("chat_calls.id", ondelete="CASCADE"), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    joined_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    left_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
