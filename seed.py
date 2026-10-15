"""Load a small demo team so you can click around the API straight away.

    python seed.py            # uses the DATABASE_URL in your .env
    python seed.py --reset    # wipe the demo rows first

Everyone's password is Passw0rd!23 - the admin keeps the one from FIRST_ADMIN_PASSWORD.
"""
import argparse
import sys
from pathlib import Path
from datetime import timedelta

from alembic import command
from alembic.config import Config
from sqlalchemy import select

from app.database import SessionLocal
from app.models import (
    Project,
    ProjectMember,
    ProjectRole,
    Role,
    Ticket,
    TicketPriority,
    TicketStatus,
    TicketType,
    User,
)
from app.security import hash_password
from app.services import apply_status_change
from app.utils import utcnow

PASSWORD = "Passw0rd!23"

PEOPLE = [
    ("Ravi Menon", "ravi@example.com", "Tech Lead"),
    ("Asha Nair", "asha@example.com", "Senior Developer"),
    ("Kiran Das", "kiran@example.com", "Developer"),
    ("Neha Shah", "neha@example.com", "QA Engineer"),
]


def main(reset: bool) -> None:
    # Same schema path as production: apply the Alembic migrations.
    command.upgrade(Config(str(Path(__file__).resolve().parent / "alembic.ini")), "head")
    now = utcnow()

    with SessionLocal() as db:
        if reset:
            for email in [p[1] for p in PEOPLE]:
                user = db.scalar(select(User).where(User.email == email))
                if user:
                    db.delete(user)
            for key in ("PAY", "OPS"):
                project = db.scalar(select(Project).where(Project.key == key))
                if project:
                    db.delete(project)
            db.commit()

        if db.scalar(select(Project).where(Project.key == "PAY")):
            print("Demo data already present. Re-run with --reset to rebuild it.")
            return

        users = {}
        for name, email, designation in PEOPLE:
            user = db.scalar(select(User).where(User.email == email))
            if user is None:
                user = User(
                    name=name,
                    email=email,
                    hashed_password=hash_password(PASSWORD),
                    role=Role.USER,
                    designation=designation,
                )
                db.add(user)
            users[email] = user
        db.flush()

        pay = Project(name="Payments Platform", key="PAY", description="Wallet, UPI and settlement")
        ops = Project(name="Operations Portal", key="OPS", description="Internal back-office tools")
        pay.members = [
            ProjectMember(user_id=users["ravi@example.com"].id, role=ProjectRole.OWNER),
            ProjectMember(user_id=users["asha@example.com"].id, role=ProjectRole.DEVELOPER),
            ProjectMember(user_id=users["kiran@example.com"].id, role=ProjectRole.DEVELOPER),
        ]
        ops.members = [
            ProjectMember(user_id=users["asha@example.com"].id, role=ProjectRole.OWNER),
            ProjectMember(user_id=users["kiran@example.com"].id, role=ProjectRole.DEVELOPER),
            ProjectMember(user_id=users["neha@example.com"].id, role=ProjectRole.DEVELOPER),
        ]
        db.add_all([pay, ops])
        db.flush()

        plan = [
            # project, title, assignee, status, priority, type, due in days, est, spent
            (pay, "Wallet balance mismatch after refund", "kiran@example.com", TicketStatus.DONE, TicketPriority.CRITICAL, TicketType.BUG, -2, 8, 9),
            (pay, "Add UPI collect flow", "asha@example.com", TicketStatus.IN_PROGRESS, TicketPriority.HIGH, TicketType.FEATURE, 5, 24, 10),
            (pay, "Settlement report timing out", "kiran@example.com", TicketStatus.BLOCKED, TicketPriority.HIGH, TicketType.BUG, -1, 6, 4),
            (pay, "Mask card numbers in logs", None, TicketStatus.TODO, TicketPriority.MEDIUM, TicketType.IMPROVEMENT, 10, 3, 0),
            (ops, "Agent KYC upload fails on large files", "neha@example.com", TicketStatus.IN_REVIEW, TicketPriority.HIGH, TicketType.BUG, 2, 5, 6),
            (ops, "Bulk commission export", "kiran@example.com", TicketStatus.DONE, TicketPriority.MEDIUM, TicketType.FEATURE, 7, 12, 11),
            (ops, "Dark mode for the admin panel", None, TicketStatus.TODO, TicketPriority.LOW, TicketType.IMPROVEMENT, None, 8, 0),
        ]

        for project, title, assignee_email, status, priority, ttype, due_days, est, spent in plan:
            project.ticket_counter += 1
            assignee = users[assignee_email] if assignee_email else None
            ticket = Ticket(
                project_id=project.id,
                number=project.ticket_counter,
                title=title,
                description=f"Seeded demo ticket: {title}.",
                priority=priority,
                type=ttype,
                reporter_id=users["ravi@example.com"].id,
                assignee_id=assignee.id if assignee else None,
                assigned_at=now - timedelta(days=6) if assignee else None,
                due_date=now + timedelta(days=due_days) if due_days is not None else None,
                estimated_hours=est,
                spent_hours=spent,
            )
            if status != TicketStatus.TODO:
                ticket.started_at = now - timedelta(days=5)
                apply_status_change(ticket, status)
            db.add(ticket)

        db.commit()

    print(
        "Seeded 2 projects and 7 tickets.\n"
        f"  owner/lead : ravi@example.com  /  {PASSWORD}\n"
        f"  developers : asha@example.com, kiran@example.com, neha@example.com  /  {PASSWORD}\n"
        "  admin      : the FIRST_ADMIN_EMAIL from your .env"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reset", action="store_true", help="delete the demo users and projects first")
    sys.exit(main(parser.parse_args().reset))
