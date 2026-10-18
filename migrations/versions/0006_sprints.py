"""Sprints: time-boxed iterations per project; tickets get a sprint_id (None = backlog).

Revision ID: 0006
Revises: 0005
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0006"
down_revision: str | None = "0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TS = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.create_table(
        "sprints",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("goal", sa.Text(), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("start_date", TS, nullable=True),
        sa.Column("end_date", TS, nullable=True),
        sa.Column("started_at", TS, nullable=True),
        sa.Column("completed_at", TS, nullable=True),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("created_at", TS, nullable=False),
        sa.Column("updated_at", TS, nullable=False),
    )
    op.create_index("ix_sprints_project_id", "sprints", ["project_id"])
    op.create_index("ix_sprints_status", "sprints", ["status"])
    with op.batch_alter_table("tickets") as batch:
        batch.add_column(sa.Column("sprint_id", sa.Integer(), nullable=True))
        batch.create_foreign_key("fk_tickets_sprint_id", "sprints", ["sprint_id"], ["id"], ondelete="SET NULL")
        batch.create_index("ix_tickets_sprint_id", ["sprint_id"])


def downgrade() -> None:
    with op.batch_alter_table("tickets") as batch:
        batch.drop_index("ix_tickets_sprint_id")
        batch.drop_constraint("fk_tickets_sprint_id", type_="foreignkey")
        batch.drop_column("sprint_id")
    op.drop_table("sprints")
