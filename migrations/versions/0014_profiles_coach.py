"""Profiles (bio, photo, skills...) and each person's motivator ("coach") settings.

Revision ID: 0014
Revises: 0013
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0014"
down_revision: str | None = "0013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("users") as batch:
        batch.add_column(sa.Column("bio", sa.Text(), nullable=False, server_default=""))
        batch.add_column(sa.Column("phone", sa.String(40), nullable=True))
        batch.add_column(sa.Column("location", sa.String(120), nullable=True))
        batch.add_column(sa.Column("timezone", sa.String(64), nullable=True))
        batch.add_column(sa.Column("skills", sa.JSON(), nullable=True))
        batch.add_column(sa.Column("avatar_key", sa.String(40), nullable=True))
        batch.add_column(sa.Column("coach_enabled", sa.Boolean(), nullable=False, server_default=sa.true()))
        batch.add_column(sa.Column("coach_name", sa.String(30), nullable=False, server_default="Spark"))
        batch.add_column(sa.Column("coach_tone", sa.String(20), nullable=False, server_default="cheerful"))
        batch.add_column(sa.Column("daily_goal", sa.Integer(), nullable=False, server_default="2"))
    op.create_table(
        "user_avatars",
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("key", sa.String(40), nullable=False, unique=True),
        sa.Column("mime", sa.String(40), nullable=False),
        sa.Column("data", sa.LargeBinary(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("user_avatars")
    with op.batch_alter_table("users") as batch:
        for col in ("daily_goal", "coach_tone", "coach_name", "coach_enabled", "avatar_key",
                    "skills", "timezone", "location", "phone", "bio"):
            batch.drop_column(col)
