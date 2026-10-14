from datetime import datetime, timedelta, timezone
from pathlib import Path

from app.config import settings

from conftest import API, PASSWORD, assign, login, make_user, raise_ticket, set_status


def iso(**delta) -> str:
    return (datetime.now(timezone.utc) + timedelta(**delta)).isoformat()


# --------------------------------------------------------------------------- #
# Auth & users
# --------------------------------------------------------------------------- #
def test_auth_and_user_management(client, admin, world):
    assert client.get(f"{API}/auth/me").status_code == 401
    bad = client.post(f"{API}/auth/login", data={"username": "ravi@example.com", "password": "nope"})
    assert bad.status_code == 401

    me = client.get(f"{API}/auth/me", headers=world["ravi"]["headers"]).json()
    assert me["email"] == "ravi@example.com" and me["role"] == "user"

    # only admins manage users
    r = client.post(
        f"{API}/users",
        headers=world["ravi"]["headers"],
        json={"name": "X", "email": "x@example.com", "password": PASSWORD},
    )
    assert r.status_code == 403
    assert client.get(f"{API}/users", headers=world["asha"]["headers"]).status_code == 403

    dup = client.post(
        f"{API}/users",
        headers=admin,
        json={"name": "Dup", "email": "RAVI@example.com", "password": PASSWORD},
    )
    assert dup.status_code == 409

    listed = client.get(f"{API}/users", headers=admin, params={"q": "dev"}).json()
    assert {u["email"] for u in listed["items"]} >= {"asha@example.com", "kiran@example.com"}

    # admin cannot lock themselves out
    admin_id = client.get(f"{API}/auth/me", headers=admin).json()["id"]
    assert client.patch(f"{API}/users/{admin_id}", headers=admin, json={"is_active": False}).status_code == 400
    assert client.patch(f"{API}/users/{admin_id}", headers=admin, json={"role": "user"}).status_code == 400


def test_password_change_and_deactivation(client, admin):
    u = make_user(client, admin, "Temp Dev", "temp@example.com")
    r = client.post(
        f"{API}/auth/change-password",
        headers=u["headers"],
        json={"current_password": "wrong-pass", "new_password": "BrandNew#123"},
    )
    assert r.status_code == 400
    r = client.post(
        f"{API}/auth/change-password",
        headers=u["headers"],
        json={"current_password": PASSWORD, "new_password": "BrandNew#123"},
    )
    assert r.status_code == 204
    login(client, "temp@example.com", "BrandNew#123")

    assert client.patch(f"{API}/users/{u['id']}", headers=admin, json={"is_active": False}).status_code == 200
    # old token stops working and a new login is refused
    assert client.get(f"{API}/auth/me", headers=u["headers"]).status_code == 401
    r = client.post(f"{API}/auth/login", data={"username": "temp@example.com", "password": "BrandNew#123"})
    assert r.status_code == 403


# --------------------------------------------------------------------------- #
# Projects & membership
# --------------------------------------------------------------------------- #
def test_project_visibility_and_roles(client, admin, world):
    pay, ops = world["pay"], world["ops"]
    assert pay["key"] == "PAY"  # lower-case input is normalised

    names = lambda h: {p["key"] for p in client.get(f"{API}/projects", headers=h).json()}
    assert names(admin) >= {"PAY", "OPS"}
    assert names(world["ravi"]["headers"]) == {"PAY", "OPS"}
    assert names(world["asha"]["headers"]) == {"PAY"}
    assert names(world["kiran"]["headers"]) == {"PAY", "OPS"}
    assert names(world["zed"]["headers"]) == set()

    # outsiders cannot even tell the project exists
    assert client.get(f"{API}/projects/{pay['id']}", headers=world["zed"]["headers"]).status_code == 404
    assert client.get(f"{API}/projects/{ops['id']}", headers=world["asha"]["headers"]).status_code == 404

    detail = client.get(f"{API}/projects/{pay['id']}", headers=world["ravi"]["headers"]).json()
    assert detail["my_role"] == "owner" and detail["member_count"] == 3
    assert [o["email"] for o in detail["owners"]] == ["ravi@example.com"]

    # developers cannot create projects, add members, or promote owners
    body = {"name": "Nope", "key": "NOPE", "owner_ids": [world["asha"]["id"]]}
    assert client.post(f"{API}/projects", headers=world["asha"]["headers"], json=body).status_code == 403
    r = client.post(
        f"{API}/projects/{pay['id']}/members",
        headers=world["asha"]["headers"],
        json={"user_id": world["zed"]["id"]},
    )
    assert r.status_code == 403
    r = client.post(
        f"{API}/projects/{pay['id']}/members",
        headers=world["ravi"]["headers"],
        json={"user_id": world["zed"]["id"], "role": "owner"},
    )
    assert r.status_code == 403  # owners cannot mint other owners
    r = client.post(
        f"{API}/projects/{pay['id']}/members",
        headers=world["ravi"]["headers"],
        json={"user_id": world["asha"]["id"]},
    )
    assert r.status_code == 409

    # duplicate key / bad key
    dup = {"name": "Other", "key": "PAY", "owner_ids": [world["ravi"]["id"]]}
    assert client.post(f"{API}/projects", headers=admin, json=dup).status_code == 409
    bad = {"name": "Other", "key": "1X", "owner_ids": [world["ravi"]["id"]]}
    assert client.post(f"{API}/projects", headers=admin, json=bad).status_code == 422

    # last owner is protected
    r = client.delete(f"{API}/projects/{pay['id']}/members/{world['ravi']['id']}", headers=admin)
    assert r.status_code == 400


def test_archived_project_and_member_removal(client, admin, world):
    ravi, temp_dev = world["ravi"], make_user(client, admin, "Leaver", "leaver@example.com")
    r = client.post(
        f"{API}/projects", headers=admin,
        json={"name": "Sandbox", "key": "SBX", "owner_ids": [ravi["id"]]},
    )
    pid = r.json()["id"]
    client.post(f"{API}/projects/{pid}/members", headers=ravi["headers"], json={"user_id": temp_dev["id"]})

    t = raise_ticket(client, ravi["headers"], pid, title="Leaver work", assignee_id=temp_dev["id"])
    set_status(client, temp_dev["headers"], t["id"], "in_progress")

    r = client.delete(f"{API}/projects/{pid}/members/{temp_dev['id']}", headers=ravi["headers"])
    assert r.json() == {"removed": True, "unassigned_tickets": 1}
    after = client.get(f"{API}/tickets/{t['id']}", headers=ravi["headers"]).json()
    assert after["assignee"] is None and after["status"] == "todo" and after["started_at"] is None
    assert client.get(f"{API}/projects/{pid}", headers=temp_dev["headers"]).status_code == 404

    # only admin archives; archived projects reject new tickets
    r = client.patch(f"{API}/projects/{pid}", headers=ravi["headers"], json={"is_active": False})
    assert r.status_code == 403
    r = client.patch(f"{API}/projects/{pid}", headers=admin, json={"is_active": False})
    assert r.status_code == 200 and r.json()["is_active"] is False
    r = client.post(f"{API}/projects/{pid}/tickets", headers=ravi["headers"], json={"title": "late"})
    assert r.status_code == 400
    assert pid not in {p["id"] for p in client.get(f"{API}/projects", headers=admin).json()}
    assert pid in {
        p["id"] for p in client.get(f"{API}/projects", headers=admin, params={"include_archived": True}).json()
    }


# --------------------------------------------------------------------------- #
# Ticket lifecycle & permissions
# --------------------------------------------------------------------------- #
def test_ticket_lifecycle(client, world):
    ravi, asha, kiran, zed, pay = (world[k] for k in ("ravi", "asha", "kiran", "zed", "pay"))

    t = raise_ticket(client, asha["headers"], pay["id"], title="Wallet timeout", priority="high", type="bug")
    assert t["key"].startswith("PAY-") and t["status"] == "todo" and t["assignee"] is None
    assert t["reporter"]["email"] == "asha@example.com"
    assert t["can_assign"] is False and t["can_edit"] is True

    # a developer cannot pre-assign or assign
    r = client.post(
        f"{API}/projects/{pay['id']}/tickets", headers=asha["headers"],
        json={"title": "x", "assignee_id": kiran["id"]},
    )
    assert r.status_code == 403
    assign(client, asha["headers"], t["id"], kiran["id"], expect=403)

    # owner was told a ticket was raised
    notes = client.get(f"{API}/notifications", headers=ravi["headers"], params={"unread_only": True}).json()
    assert any(n["type"] == "ticket_created" and n["ticket_key"] == t["key"] for n in notes["items"])

    # outsiders / other-project members see nothing
    assert client.get(f"{API}/tickets/{t['id']}", headers=zed["headers"]).status_code == 404

    # assignee must be a project member
    assign(client, ravi["headers"], t["id"], zed["id"], expect=400)

    # unassigned tickets cannot move forward
    set_status(client, ravi["headers"], t["id"], "in_progress", expect=400)

    assigned = assign(client, ravi["headers"], t["id"], kiran["id"])
    assert assigned["assignee"]["email"] == "kiran@example.com" and assigned["assigned_at"]
    assign(client, ravi["headers"], t["id"], kiran["id"], expect=400)  # already assigned
    n = client.get(f"{API}/notifications", headers=kiran["headers"]).json()["items"]
    assert n[0]["type"] == "assigned" and t["key"] in n[0]["message"]

    # only the assignee (or an owner) moves it; reporter Asha cannot
    set_status(client, asha["headers"], t["id"], "in_progress", expect=403)
    s = set_status(client, kiran["headers"], t["id"], "in_progress")
    assert s["started_at"] and s["can_change_status"] is True
    set_status(client, kiran["headers"], t["id"], "in_progress", expect=400)  # no-op
    set_status(client, kiran["headers"], t["id"], "in_review")
    done = set_status(client, kiran["headers"], t["id"], "done")
    assert done["completed_at"] and done["reopen_count"] == 0

    # a finished ticket must be reopened before it can be reassigned
    assign(client, ravi["headers"], t["id"], asha["id"], expect=400)
    reopened = set_status(client, kiran["headers"], t["id"], "in_progress")
    assert reopened["reopen_count"] == 1 and reopened["completed_at"] is None

    # reassignment resets progress tracking
    moved = assign(client, ravi["headers"], t["id"], asha["id"])
    assert moved["status"] == "todo" and moved["started_at"] is None and moved["assignee"]["email"] == "asha@example.com"
    assert moved["reopen_count"] == 1  # history is kept

    # field level edit rules
    assert client.patch(f"{API}/tickets/{t['id']}", headers=asha["headers"], json={"priority": "low"}).status_code == 403
    assert client.patch(f"{API}/tickets/{t['id']}", headers=asha["headers"], json={"due_date": iso(days=3)}).status_code == 403
    r = client.patch(f"{API}/tickets/{t['id']}", headers=asha["headers"], json={"title": "Wallet timeout v2", "estimated_hours": 6})
    assert r.status_code == 200 and r.json()["title"] == "Wallet timeout v2"
    r = client.patch(f"{API}/tickets/{t['id']}", headers=ravi["headers"], json={"priority": "critical", "due_date": iso(days=3)})
    assert r.status_code == 200 and r.json()["priority"] == "critical" and r.json()["is_overdue"] is False
    assert client.patch(f"{API}/tickets/{t['id']}", headers=zed["headers"], json={"title": "hack"}).status_code == 404
    assert client.patch(f"{API}/tickets/{t['id']}", headers=ravi["headers"], json={}).status_code == 400
    r = client.patch(f"{API}/tickets/{t['id']}", headers=ravi["headers"], json={"due_date": None})
    assert r.status_code == 200 and r.json()["due_date"] is None

    # audit trail
    acts = client.get(f"{API}/tickets/{t['id']}/activity", headers=asha["headers"]).json()
    kinds = [a["action"] for a in acts]
    assert {"created", "assigned", "status_changed", "updated"} <= set(kinds)
    assert any(a["field"] == "status" and a["old_value"] == "in_review" and a["new_value"] == "done" for a in acts)

    # lookup by key
    r = client.get(f"{API}/tickets/by-key/{t['key'].lower()}", headers=ravi["headers"])
    assert r.status_code == 200 and r.json()["id"] == t["id"]
    assert client.get(f"{API}/tickets/by-key/{t['key']}", headers=zed["headers"]).status_code == 404
    assert client.get(f"{API}/tickets/by-key/nonsense", headers=ravi["headers"]).status_code == 400


def test_views_filters_and_sorting(client, world):
    ravi, asha, kiran, pay, ops = (world[k] for k in ("ravi", "asha", "kiran", "pay", "ops"))

    a = raise_ticket(client, ravi["headers"], pay["id"], title="Alpha login bug", priority="low", assignee_id=kiran["id"], due_date=iso(days=-1))
    b = raise_ticket(client, ravi["headers"], pay["id"], title="Beta report", priority="critical", assignee_id=kiran["id"], due_date=iso(days=5))
    c = raise_ticket(client, ravi["headers"], ops["id"], title="Gamma deploy", priority="medium", assignee_id=kiran["id"])
    d = raise_ticket(client, ravi["headers"], pay["id"], title="Delta unassigned", priority="high")

    # my work: all projects vs one project
    mine = client.get(f"{API}/tickets/my", headers=kiran["headers"], params={"limit": 200}).json()
    ids = {t["id"] for t in mine["items"]}
    assert {a["id"], b["id"], c["id"]} <= ids and d["id"] not in ids
    only_ops = client.get(f"{API}/tickets/my", headers=kiran["headers"], params={"project_id": ops["id"], "limit": 200}).json()
    assert {t["project"]["key"] for t in only_ops["items"]} == {"OPS"}

    summary = client.get(f"{API}/tickets/my/summary", headers=kiran["headers"]).json()
    by_key = {p["project"]["key"]: p for p in summary["by_project"]}
    assert {"PAY", "OPS"} <= set(by_key)
    assert by_key["OPS"]["by_status"]["todo"] >= 1 and by_key["PAY"]["overdue"] >= 1
    assert summary["total"] == sum(p["total"] for p in summary["by_project"])

    # Asha only sees PAY tickets, never OPS ones
    all_asha = client.get(f"{API}/tickets", headers=asha["headers"], params={"limit": 200}).json()
    assert c["id"] not in {t["id"] for t in all_asha["items"]} and b["id"] in {t["id"] for t in all_asha["items"]}
    assert client.get(f"{API}/projects/{ops['id']}/tickets", headers=asha["headers"]).status_code == 404

    def ids_for(params, headers=ravi["headers"], path="/tickets"):
        r = client.get(f"{API}{path}", headers=headers, params={"limit": 200, **params})
        assert r.status_code == 200, r.text
        return [t["id"] for t in r.json()["items"]]

    assert ids_for({"overdue": True, "project_id": pay["id"]}) and a["id"] in ids_for({"overdue": True})
    assert b["id"] not in ids_for({"overdue": True})
    assert d["id"] in ids_for({"unassigned": True}) and a["id"] not in ids_for({"unassigned": True})
    assert ids_for({"q": "alpha"}) == [a["id"]]
    assert ids_for({"q": a["key"]}) == [a["id"]]
    assert ids_for({"q": "100%"}) == []  # LIKE wildcards are escaped
    assert set(ids_for({"priority": ["critical", "high"], "project_id": pay["id"]})) >= {b["id"], d["id"]}
    assert a["id"] not in ids_for({"priority": ["critical", "high"]})

    ranked = ids_for({"sort": "priority", "order": "desc", "project_id": pay["id"]})
    assert ranked.index(b["id"]) < ranked.index(d["id"]) < ranked.index(a["id"])
    by_due = ids_for({"sort": "due_date", "order": "asc", "project_id": pay["id"]})
    assert by_due.index(a["id"]) < by_due.index(b["id"]) < by_due.index(d["id"])  # no due date goes last

    page1 = client.get(f"{API}/tickets", headers=ravi["headers"], params={"limit": 2, "offset": 0}).json()
    page2 = client.get(f"{API}/tickets", headers=ravi["headers"], params={"limit": 2, "offset": 2}).json()
    assert page1["total"] == page2["total"] >= 4 and len(page1["items"]) == 2
    assert not {t["id"] for t in page1["items"]} & {t["id"] for t in page2["items"]}


# --------------------------------------------------------------------------- #
# Comments, mentions, notifications
# --------------------------------------------------------------------------- #
def test_comments_mentions_and_notifications(client, world):
    ravi, asha, kiran, zed, pay = (world[k] for k in ("ravi", "asha", "kiran", "zed", "pay"))
    t = raise_ticket(client, asha["headers"], pay["id"], title="Needs discussion")
    assign(client, ravi["headers"], t["id"], kiran["id"])

    # '@email' in the text and explicit ids both work
    r = client.post(
        f"{API}/tickets/{t['id']}/comments", headers=asha["headers"],
        json={"body": "Hey @ravi@example.com can you look? cc team", "mention_user_ids": [kiran["id"]]},
    )
    assert r.status_code == 201, r.text
    comment = r.json()
    assert {m["email"] for m in comment["mentions"]} == {"ravi@example.com", "kiran@example.com"}

    for person in (ravi, kiran):
        notes = client.get(f"{API}/notifications", headers=person["headers"]).json()["items"]
        assert any(n["type"] == "mention" and n["ticket_id"] == t["id"] for n in notes)
    # author never notifies themselves
    notes = client.get(f"{API}/notifications", headers=asha["headers"]).json()["items"]
    assert not any(n["ticket_id"] == t["id"] and n["type"] in ("mention", "comment") for n in notes)

    # non-members cannot be mentioned or comment
    r = client.post(
        f"{API}/tickets/{t['id']}/comments", headers=asha["headers"],
        json={"body": "psst", "mention_user_ids": [zed["id"]]},
    )
    assert r.status_code == 400
    r = client.post(f"{API}/tickets/{t['id']}/comments", headers=zed["headers"], json={"body": "hi"})
    assert r.status_code == 404
    # unknown @handles in text stay plain text
    r = client.post(f"{API}/tickets/{t['id']}/comments", headers=kiran["headers"], json={"body": "ping @zed@example.com"})
    assert r.status_code == 201 and r.json()["mentions"] == []
    # that comment notifies the reporter (Asha) but not the author
    notes = client.get(f"{API}/notifications", headers=asha["headers"]).json()["items"]
    assert any(n["type"] == "comment" and n["ticket_id"] == t["id"] for n in notes)

    listed = client.get(f"{API}/tickets/{t['id']}/comments", headers=ravi["headers"]).json()
    assert [c["id"] for c in listed][0] == comment["id"] and len(listed) == 2
    assert client.get(f"{API}/tickets/{t['id']}", headers=ravi["headers"]).json()["comment_count"] == 2

    # edit rules
    r = client.patch(f"{API}/comments/{comment['id']}", headers=kiran["headers"], json={"body": "hijack"})
    assert r.status_code == 403
    r = client.patch(f"{API}/comments/{comment['id']}", headers=asha["headers"], json={"body": "edited", "mention_user_ids": []})
    assert r.status_code == 200 and r.json()["edited_at"] and r.json()["mentions"] == []

    # notification inbox
    before = client.get(f"{API}/notifications/unread-count", headers=ravi["headers"]).json()["unread"]
    assert before >= 2
    first = client.get(f"{API}/notifications", headers=ravi["headers"]).json()["items"][0]
    assert client.post(f"{API}/notifications/{first['id']}/read", headers=asha["headers"]).status_code == 404
    assert client.post(f"{API}/notifications/{first['id']}/read", headers=ravi["headers"]).json()["is_read"] is True
    assert client.get(f"{API}/notifications/unread-count", headers=ravi["headers"]).json()["unread"] == before - 1
    assert client.post(f"{API}/notifications/read-all", headers=ravi["headers"]).json()["marked_read"] == before - 1
    assert client.get(f"{API}/notifications/unread-count", headers=ravi["headers"]).json()["unread"] == 0

    # owner may delete someone else's comment, a bystander may not
    assert client.delete(f"{API}/comments/{comment['id']}", headers=kiran["headers"]).status_code == 403
    assert client.delete(f"{API}/comments/{comment['id']}", headers=ravi["headers"]).status_code == 204

    # mention picker only offers people you share a project with
    found = client.get(f"{API}/users/lookup", headers=asha["headers"], params={"q": "o"}).json()
    assert "zed@example.com" not in {u["email"] for u in found}
    found = client.get(f"{API}/users/lookup", headers=asha["headers"], params={"project_id": pay["id"]}).json()
    assert {u["email"] for u in found} >= {"ravi@example.com", "kiran@example.com"}


# --------------------------------------------------------------------------- #
# Attachments
# --------------------------------------------------------------------------- #
def test_attachments(client, world):
    ravi, asha, kiran, zed, pay = (world[k] for k in ("ravi", "asha", "kiran", "zed", "pay"))
    t = raise_ticket(client, asha["headers"], pay["id"], title="With files")
    url = f"{API}/tickets/{t['id']}/attachments"

    r = client.post(
        url, headers=asha["headers"],
        files=[
            ("files", ("../../etc/passwd.txt", b"hello world", "text/plain")),
            ("files", ("trace.log", b"line1\nline2\n", "text/plain")),
        ],
    )
    assert r.status_code == 201, r.text
    first, second = r.json()
    assert first["filename"] == "passwd.txt" and first["size"] == 11  # path stripped
    assert second["uploader"]["email"] == "asha@example.com"

    dl = client.get(f"{API}/attachments/{first['id']}/download", headers=kiran["headers"])
    assert dl.status_code == 200 and dl.content == b"hello world"
    assert "attachment" in dl.headers["content-disposition"]
    assert client.get(f"{API}/attachments/{first['id']}/download", headers=zed["headers"]).status_code == 404

    # blocked type, oversized file (limit is 1 MB in tests), too many files
    r = client.post(url, headers=asha["headers"], files=[("files", ("setup.exe", b"MZ", "application/octet-stream"))])
    assert r.status_code == 400
    r = client.post(url, headers=asha["headers"], files=[("files", ("big.bin", b"x" * (1024 * 1024 + 1), "application/octet-stream"))])
    assert r.status_code == 413
    r = client.post(url, headers=asha["headers"], files=[("files", (f"f{i}.txt", b"x", "text/plain")) for i in range(11)])
    assert r.status_code == 400
    assert len(client.get(url, headers=ravi["headers"]).json()) == 2  # failed uploads left nothing behind
    on_disk = list((Path(settings.UPLOAD_DIR) / str(t["id"])).iterdir())
    assert len(on_disk) == 2

    # attach to a comment; only to your own
    c = client.post(f"{API}/tickets/{t['id']}/comments", headers=asha["headers"], json={"body": "see screenshot"}).json()
    r = client.post(url, headers=kiran["headers"], data={"comment_id": c["id"]}, files=[("files", ("a.png", b"png", "image/png"))])
    assert r.status_code == 403
    r = client.post(url, headers=asha["headers"], data={"comment_id": c["id"]}, files=[("files", ("a.png", b"png", "image/png"))])
    assert r.status_code == 201 and r.json()[0]["comment_id"] == c["id"]
    shown = client.get(f"{API}/tickets/{t['id']}/comments", headers=ravi["headers"]).json()[0]
    assert [a["filename"] for a in shown["attachments"]] == ["a.png"]
    assert client.get(f"{API}/tickets/{t['id']}", headers=ravi["headers"]).json()["attachment_count"] == 3

    # deleting a file: uploader or owner only
    assert client.delete(f"{API}/attachments/{first['id']}", headers=kiran["headers"]).status_code == 403
    assert client.delete(f"{API}/attachments/{first['id']}", headers=asha["headers"]).status_code == 204
    # deleting the comment removes its files from disk
    assert client.delete(f"{API}/comments/{c['id']}", headers=asha["headers"]).status_code == 204
    assert len(list((Path(settings.UPLOAD_DIR) / str(t["id"])).iterdir())) == 1

    # deleting the ticket removes everything
    assert client.delete(f"{API}/tickets/{t['id']}", headers=asha["headers"]).status_code == 403
    assert client.delete(f"{API}/tickets/{t['id']}", headers=ravi["headers"]).status_code == 204
    assert not (Path(settings.UPLOAD_DIR) / str(t["id"])).exists()
    assert client.get(f"{API}/tickets/{t['id']}", headers=ravi["headers"]).status_code == 404


def test_worklogs(client, world):
    ravi, asha, kiran, pay = (world[k] for k in ("ravi", "asha", "kiran", "pay"))
    t = raise_ticket(client, ravi["headers"], pay["id"], title="Timed", assignee_id=kiran["id"], estimated_hours=8)
    url = f"{API}/tickets/{t['id']}/worklogs"
    assert client.post(url, headers=asha["headers"], json={"hours": 1}).status_code == 403
    assert client.post(url, headers=kiran["headers"], json={"hours": 0}).status_code == 422
    w1 = client.post(url, headers=kiran["headers"], json={"hours": 2.5, "note": "investigation"}).json()
    client.post(url, headers=kiran["headers"], json={"hours": 1.5})
    assert client.get(f"{API}/tickets/{t['id']}", headers=ravi["headers"]).json()["spent_hours"] == 4.0
    assert client.delete(f"{API}/worklogs/{w1['id']}", headers=asha["headers"]).status_code == 403
    assert client.delete(f"{API}/worklogs/{w1['id']}", headers=kiran["headers"]).status_code == 204
    assert client.get(f"{API}/tickets/{t['id']}", headers=ravi["headers"]).json()["spent_hours"] == 1.5
    assert len(client.get(url, headers=ravi["headers"]).json()) == 1


# --------------------------------------------------------------------------- #
# Admin reports
# --------------------------------------------------------------------------- #
def test_efficiency_report(client, admin, world):
    ravi = world["ravi"]
    dev_a = make_user(client, admin, "Dev Alpha", "alpha@example.com")
    dev_b = make_user(client, admin, "Dev Bravo", "bravo@example.com")
    dev_idle = make_user(client, admin, "Dev Idle", "idle@example.com")
    r = client.post(f"{API}/projects", headers=admin, json={"name": "Reporting", "key": "RPT", "owner_ids": [ravi["id"]]})
    pid = r.json()["id"]
    for d in (dev_a, dev_b, dev_idle):
        client.post(f"{API}/projects/{pid}/members", headers=ravi["headers"], json={"user_id": d["id"]})

    # dev_a: 3 tickets -> one on time (reopened once, estimate 4h / spent 5h), one late, one open+overdue
    t1 = raise_ticket(client, ravi["headers"], pid, title="A1", assignee_id=dev_a["id"], due_date=iso(days=2), estimated_hours=4)
    t2 = raise_ticket(client, ravi["headers"], pid, title="A2", assignee_id=dev_a["id"], due_date=iso(days=-2))
    raise_ticket(client, ravi["headers"], pid, title="A3", assignee_id=dev_a["id"], due_date=iso(days=-1))
    h = dev_a["headers"]
    set_status(client, h, t1["id"], "in_progress")
    client.post(f"{API}/tickets/{t1['id']}/worklogs", headers=h, json={"hours": 5})
    set_status(client, h, t1["id"], "done")
    set_status(client, h, t1["id"], "in_progress")  # reopened
    set_status(client, h, t1["id"], "done")
    set_status(client, h, t2["id"], "done")  # finished after its due date

    # dev_b: two tickets, both on time, no rework
    for i in range(2):
        t = raise_ticket(client, ravi["headers"], pid, title=f"B{i}", assignee_id=dev_b["id"], due_date=iso(days=3))
        set_status(client, dev_b["headers"], t["id"], "in_progress")
        set_status(client, dev_b["headers"], t["id"], "done")

    # access control
    assert client.get(f"{API}/reports/efficiency", headers=ravi["headers"]).status_code == 403
    assert client.get(f"{API}/reports/overview", headers=dev_a["headers"]).status_code == 403

    rep = client.get(f"{API}/reports/efficiency", headers=admin, params={"project_id": pid}).json()
    rows = {d["user"]["email"]: d for d in rep["developers"]}
    assert set(rows) == {"alpha@example.com", "bravo@example.com", "idle@example.com"}  # members only

    a, b, idle = rows["alpha@example.com"], rows["bravo@example.com"], rows["idle@example.com"]
    assert (a["assigned"], a["completed"], a["open"], a["overdue_open"]) == (3, 2, 1, 1)
    assert (a["completed_on_time"], a["completed_late"], a["tickets_reopened"]) == (1, 1, 1)
    assert a["completion_rate"] == 0.6667 and a["on_time_rate"] == 0.5 and a["first_time_right_rate"] == 0.5
    assert a["efficiency_score"] == 56.7  # 100 * (0.4*0.6667 + 0.4*0.5 + 0.2*0.5)
    assert a["estimate_accuracy"] == 0.75 and a["spent_hours"] == 5.0 and a["estimated_hours"] == 4.0
    assert a["avg_resolution_hours"] is not None and a["avg_time_to_start_hours"] is not None

    assert (b["assigned"], b["completed"]) == (2, 2)
    assert b["efficiency_score"] == 100.0 and b["on_time_rate"] == 1.0 and b["first_time_right_rate"] == 1.0
    assert idle["assigned"] == 0 and idle["efficiency_score"] is None  # visible, but not scored

    order = [d["user"]["email"] for d in rep["developers"]]
    assert order == ["bravo@example.com", "alpha@example.com", "idle@example.com"]
    assert rep["team"]["assigned"] == 5 and rep["team"]["completed"] == 4 and rep["team"]["developers"] == 3
    assert abs(rep["team"]["avg_efficiency_score"] - 78.35) <= 0.06  # mean of 56.7 and 100.0

    # period filter: nothing was assigned tomorrow or later, everything was assigned today
    tomorrow = (datetime.now(timezone.utc) + timedelta(days=1)).date().isoformat()
    today = datetime.now(timezone.utc).date().isoformat()
    empty = client.get(f"{API}/reports/efficiency", headers=admin, params={"project_id": pid, "from": tomorrow}).json()
    assert empty["team"]["assigned"] == 0
    full = client.get(f"{API}/reports/efficiency", headers=admin, params={"project_id": pid, "from": today, "to": today}).json()
    assert full["team"]["assigned"] == 5
    assert client.get(f"{API}/reports/efficiency", headers=admin, params={"from": tomorrow, "to": today}).status_code == 400

    # single developer drill-down
    one = client.get(f"{API}/reports/efficiency/{dev_a['id']}", headers=admin).json()
    assert one["efficiency_score"] == 56.7 and one["by_status"]["done"] == 2
    assert [p["project"]["key"] for p in one["by_project"]] == ["RPT"] and one["by_project"][0]["overdue_open"] == 1
    assert client.get(f"{API}/reports/efficiency/99999", headers=admin).status_code == 404


def test_overview_report(client, admin, world):
    ov = client.get(f"{API}/reports/overview", headers=admin).json()
    assert ov["total_tickets"] == sum(ov["by_status"].values()) == sum(ov["by_priority"].values())
    assert ov["total_tickets"] == sum(p["total"] for p in ov["by_project"])
    assert ov["open_tickets"] == ov["total_tickets"] - ov["by_status"]["done"]
    assert ov["overdue_open"] >= 1 and ov["unassigned_open"] >= 1 and ov["created_last_7_days"] >= 1
    assert ov["completed_last_7_days"] >= 1

    one = client.get(f"{API}/reports/overview", headers=admin, params={"project_id": world["ops"]["id"]}).json()
    assert [p["project"]["key"] for p in one["by_project"]] == ["OPS"]
    assert one["total_tickets"] == one["by_project"][0]["total"]

    # every ticket is visible to the admin, however it is filtered
    everything = client.get(f"{API}/tickets", headers=admin, params={"limit": 200}).json()
    assert everything["total"] == ov["total_tickets"]


# --------------------------------------------------------------------------- #
# Regressions found in review
# --------------------------------------------------------------------------- #
def test_removed_member_loses_my_ticket_view(client, admin, world):
    ravi = world["ravi"]
    leaver = make_user(client, admin, "Former Dev", "former@example.com")
    pid = client.post(
        f"{API}/projects", headers=admin, json={"name": "Secret", "key": "SEC", "owner_ids": [ravi["id"]]}
    ).json()["id"]
    client.post(f"{API}/projects/{pid}/members", headers=ravi["headers"], json={"user_id": leaver["id"]})
    t = raise_ticket(client, ravi["headers"], pid, title="Roadmap item", assignee_id=leaver["id"])
    set_status(client, leaver["headers"], t["id"], "done")  # done tickets are not unassigned on removal

    r = client.delete(f"{API}/projects/{pid}/members/{leaver['id']}", headers=ravi["headers"])
    assert r.json()["unassigned_tickets"] == 0
    client.patch(f"{API}/tickets/{t['id']}", headers=ravi["headers"], json={"description": "after they left"})

    mine = client.get(f"{API}/tickets/my", headers=leaver["headers"]).json()
    assert mine["total"] == 0 and mine["items"] == []
    summary = client.get(f"{API}/tickets/my/summary", headers=leaver["headers"]).json()
    assert summary["total"] == 0 and summary["by_project"] == []
    # ...while the admin's report still credits the work they did
    one = client.get(f"{API}/reports/efficiency/{leaver['id']}", headers=admin).json()
    assert one["completed"] == 1


def test_null_user_fields_rejected(client, admin, world):
    uid = world["zed"]["id"]
    for field in ("name", "role", "is_active", "password"):
        r = client.patch(f"{API}/users/{uid}", headers=admin, json={field: None})
        assert r.status_code == 422, (field, r.text)
    r = client.patch(f"{API}/users/{uid}", headers=admin, json={"designation": None})
    assert r.status_code == 200 and r.json()["designation"] is None


def test_huge_ids_are_not_found(client, admin, world):
    big = "99999999999999999999"
    h = world["ravi"]["headers"]
    for path in (
        f"/tickets/{big}", f"/projects/{big}", f"/tickets/by-key/PAY-{big}", f"/comments/{big}",
    ):
        method = client.patch if path.startswith("/comments") else client.get
        kwargs = {"json": {"body": "x"}} if path.startswith("/comments") else {}
        assert method(f"{API}{path}", headers=h, **kwargs).status_code == 404, path
    assert client.get(f"{API}/users/{big}", headers=admin).status_code == 404
    assert client.get(f"{API}/tickets", headers=h, params={"assignee_id": big}).status_code == 404
