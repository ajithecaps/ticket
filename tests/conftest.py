import os
import sys
import tempfile
from pathlib import Path

# Isolated database + upload folder, configured *before* the app is imported.
_tmp = tempfile.mkdtemp(prefix="tickets-test-")
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp}/test.db"
os.environ["UPLOAD_DIR"] = f"{_tmp}/uploads"
os.environ["MAX_UPLOAD_MB"] = "1"
os.environ["SECRET_KEY"] = "test-secret-key-test-secret-key-0123456789"
os.environ["FIRST_ADMIN_EMAIL"] = "admin@example.com"
os.environ["FIRST_ADMIN_PASSWORD"] = "AdminPass123!"
os.environ["SCHEDULER_ENABLED"] = "false"  # jobs are triggered explicitly in tests
os.environ["SLACK_WEBHOOK_URL"] = ""
os.environ["SLACK_BOT_TOKEN"] = ""

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402

API = "/api/v1"
PASSWORD = "Passw0rd!23"


@pytest.fixture(scope="session")
def client():
    with TestClient(app) as c:
        yield c


def login(client, email, password=PASSWORD) -> dict:
    r = client.post(f"{API}/auth/login", data={"username": email, "password": password})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture(scope="session")
def admin(client):
    return login(client, "admin@example.com", "AdminPass123!")


def make_user(client, admin, name, email, role="user"):
    r = client.post(
        f"{API}/users",
        headers=admin,
        json={"name": name, "email": email, "password": PASSWORD, "role": role, "designation": "Engineer"},
    )
    assert r.status_code == 201, r.text
    return {"id": r.json()["id"], "email": email, "headers": login(client, email)}


@pytest.fixture(scope="session")
def world(client, admin):
    """Ravi owns projects PAY and OPS; Asha is in PAY; Kiran is in PAY and OPS; Zed is in nothing."""
    ravi = make_user(client, admin, "Ravi Owner", "ravi@example.com")
    asha = make_user(client, admin, "Asha Dev", "asha@example.com")
    kiran = make_user(client, admin, "Kiran Dev", "kiran@example.com")
    zed = make_user(client, admin, "Zed Outsider", "zed@example.com")

    def project(name, key):
        r = client.post(
            f"{API}/projects",
            headers=admin,
            json={"name": name, "key": key, "description": name, "owner_ids": [ravi["id"]]},
        )
        assert r.status_code == 201, r.text
        return r.json()

    pay, ops = project("Payments", "pay"), project("Operations", "OPS")
    for proj, users in ((pay, (asha, kiran)), (ops, (kiran,))):
        for u in users:
            r = client.post(
                f"{API}/projects/{proj['id']}/members",
                headers=ravi["headers"],
                json={"user_id": u["id"], "role": "developer"},
            )
            assert r.status_code == 201, r.text
    return dict(ravi=ravi, asha=asha, kiran=kiran, zed=zed, pay=pay, ops=ops)


def raise_ticket(client, headers, project_id, **fields):
    payload = {"title": "A ticket", **fields}
    r = client.post(f"{API}/projects/{project_id}/tickets", headers=headers, json=payload)
    assert r.status_code == 201, r.text
    return r.json()


def set_status(client, headers, ticket_id, status_value, expect=200):
    r = client.post(f"{API}/tickets/{ticket_id}/status", headers=headers, json={"status": status_value})
    assert r.status_code == expect, r.text
    return r.json()


def assign(client, headers, ticket_id, assignee_id, expect=200):
    r = client.post(f"{API}/tickets/{ticket_id}/assign", headers=headers, json={"assignee_id": assignee_id})
    assert r.status_code == expect, r.text
    return r.json()
