"""Releases: finished tickets grouped into production releases per project.

Revision ID: 0003
Revises: 0002
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TS = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.create_table(
        "releases",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("notes", sa.Text(), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("planned_date", TS, nullable=True),
        sa.Column("released_at", TS, nullable=True),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("released_by", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("created_at", TS, nullable=False),
        sa.Column("updated_at", TS, nullable=False),
        sa.UniqueConstraint("project_id", "name", name="uq_release_project_name"),
    )
    op.create_index("ix_releases_project_id", "releases", ["project_id"])
    op.create_index("ix_releases_status", "releases", ["status"])

    # batch mode so SQLite can add a column with a foreign key
    with op.batch_alter_table("tickets") as batch:
        batch.add_column(sa.Column("release_id", sa.Integer(), nullable=True))
        batch.create_foreign_key("fk_tickets_release_id", "releases", ["release_id"], ["id"], ondelete="SET NULL")
        batch.create_index("ix_tickets_release_id", ["release_id"])


def downgrade() -> None:
    with op.batch_alter_table("tickets") as batch:
        batch.drop_index("ix_tickets_release_id")
        batch.drop_constraint("fk_tickets_release_id", type_="foreignkey")
        batch.drop_column("release_id")
    op.drop_table("releases")
