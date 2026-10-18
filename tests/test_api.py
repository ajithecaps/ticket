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


# --------------------------------------------------------------------------- #
# Owner verification after the developer marks a ticket done
# --------------------------------------------------------------------------- #
def test_owner_verifies_done_tickets(client, admin, world):
    ravi, ops = world["ravi"], world["ops"]
    dev = make_user(client, admin, "Vera Dev", "vera@example.com")
    r = client.post(f"{API}/projects/{ops['id']}/members", headers=ravi["headers"], json={"user_id": dev["id"]})
    assert r.status_code == 201, r.text

    t = raise_ticket(client, ravi["headers"], ops["id"], title="Needs a check", assignee_id=dev["id"],
                     due_date=iso(days=-1))
    set_status(client, dev["headers"], t["id"], "in_progress")

    # only a ticket in "done" can be verified, and only by an owner
    set_status(client, ravi["headers"], t["id"], "verified", expect=400)
    done = set_status(client, dev["headers"], t["id"], "done")
    assert done["can_verify"] is False and done["is_overdue"] is False
    set_status(client, dev["headers"], t["id"], "verified", expect=403)
    owner_view = client.get(f"{API}/tickets/{t['id']}", headers=ravi["headers"]).json()
    assert owner_view["can_verify"] is True
    n = client.get(f"{API}/notifications", headers=ravi["headers"]).json()["items"]
    assert "ready for verification" in n[0]["message"]

    # sending it back counts as a reopen; doing it again and verifying keeps the developer's completion time
    back = set_status(client, ravi["headers"], t["id"], "in_progress")
    assert back["reopen_count"] == 1 and back["completed_at"] is None
    done = set_status(client, dev["headers"], t["id"], "done")
    verified = set_status(client, ravi["headers"], t["id"], "verified")
    assert verified["status"] == "verified" and verified["completed_at"] == done["completed_at"]
    assert verified["reopen_count"] == 1 and verified["can_verify"] is False

    # a verified ticket is closed: developers cannot move it, it is not open or overdue, and cannot be reassigned
    set_status(client, dev["headers"], t["id"], "in_progress", expect=403)
    assign(client, ravi["headers"], t["id"], world["kiran"]["id"], expect=400)
    mine = client.get(f"{API}/tickets/my/summary", headers=dev["headers"]).json()
    assert mine["open"] == 0 and mine["overdue"] == 0 and mine["by_status"]["verified"] == 1
    overdue = client.get(f"{API}/tickets", headers=ravi["headers"], params={"overdue": True}).json()["items"]
    assert t["id"] not in [x["id"] for x in overdue]
    report = client.get(f"{API}/reports/efficiency/{dev['id']}", headers=admin).json()
    assert report["completed"] == 1 and report["open"] == 0

    # an owner can still reopen it
    reopened = set_status(client, ravi["headers"], t["id"], "in_progress")
    assert reopened["reopen_count"] == 2 and reopened["completed_at"] is None


# --------------------------------------------------------------------------- #
# Slack: mirrored notifications, overdue alerts, daily summary
# --------------------------------------------------------------------------- #
def test_slack_notifications_overdue_and_summary(client, admin, world, monkeypatch):
    import json as _json

    from app import slack

    sent = []

    def fake_request(url, *, data, headers):
        sent.append(_json.loads(data)["text"])
        return 200, "ok", {}

    monkeypatch.setattr(settings, "SLACK_WEBHOOK_URL", "https://hooks.slack.test/T000/B000/x")
    monkeypatch.setattr(settings, "APP_BASE_URL", "https://tickets.example.com")
    monkeypatch.setattr(slack, "_request", fake_request)

    ravi, kiran, ops = world["ravi"], world["kiran"], world["ops"]
    r = client.get(f"{API}/integrations/slack", headers=admin).json()
    assert r["enabled"] is True and r["mode"] == "webhook"
    assert client.get(f"{API}/integrations/slack", headers=kiran["headers"]).status_code == 403

    # an in-app notification is mirrored once, with a link to the ticket
    t = raise_ticket(client, ravi["headers"], ops["id"], title="Slack <check> & co", assignee_id=kiran["id"],
                     due_date=iso(hours=-2))
    slack.flush()
    assert len(sent) == 1  # one "created" message, not a second one for the assignment
    assert "Ravi Owner created" in sent[0] and "assignee: Kiran Dev" in sent[0]
    assert f"https://tickets.example.com/#/tickets/{t['key']}" in sent[0]
    assert "&lt;check&gt; &amp; co" in sent[0] and "*Kiran Dev*" in sent[0]

    # a comment that @mentions someone is one Slack message, not two
    sent.clear()
    r = client.post(f"{API}/tickets/{t['id']}/comments", headers=kiran["headers"],
                    json={"body": "Done soon @ravi@example.com"})
    assert r.status_code == 201
    slack.flush()
    assert len(sent) == 1 and "mentioned you" in sent[0]

    # a request that fails sends nothing
    sent.clear()
    set_status(client, world["asha"]["headers"], t["id"], "in_progress", expect=404)
    slack.flush()
    assert sent == []

    # overdue: alert once per due date (in-app for assignee + owners, one combined Slack message)
    r = client.post(f"{API}/integrations/overdue-check", headers=admin).json()
    assert t["key"] in r["alerted"]
    assert len(sent) == 1 and "now overdue" in sent[0] and t["key"] in sent[0]
    n = client.get(f"{API}/notifications", headers=kiran["headers"]).json()["items"]
    assert n[0]["type"] == "overdue" and n[0]["ticket_key"] == t["key"]
    sent.clear()
    assert client.post(f"{API}/integrations/overdue-check", headers=admin).json()["alerted"] == []
    assert sent == []
    # moving the due date and missing it again alerts again
    client.patch(f"{API}/tickets/{t['id']}", headers=ravi["headers"], json={"due_date": iso(minutes=-1)})
    sent.clear()
    assert t["key"] in client.post(f"{API}/integrations/overdue-check", headers=admin).json()["alerted"]

    # daily summary lists every team member with their pending counts
    sent.clear()
    r = client.post(f"{API}/integrations/slack/daily-summary", headers=admin).json()
    assert r["sent"] is True and len(sent) == 1
    text = sent[0]
    assert "Pending tickets" in text and "*Kiran Dev*" in text and "overdue" in text
    kiran_line = next(line for line in text.splitlines() if "*Kiran Dev*" in line)
    assert "pending" in kiran_line and ":warning:" in kiran_line

    # turning a type off stops it being mirrored
    monkeypatch.setattr(settings, "SLACK_NOTIFY_TYPES", "assigned")
    sent.clear()
    client.post(f"{API}/tickets/{t['id']}/comments", headers=kiran["headers"], json={"body": "no slack for this"})
    slack.flush()
    assert sent == []


def test_daily_summary_schedule(monkeypatch):
    from datetime import datetime
    from zoneinfo import ZoneInfo

    from app.jobs import Scheduler

    monkeypatch.setattr(settings, "SLACK_WEBHOOK_URL", "https://hooks.slack.test/x")
    monkeypatch.setattr(settings, "SLACK_DAILY_SUMMARY_TIME", "10:00")
    monkeypatch.setattr(settings, "SLACK_DAILY_SUMMARY_DAYS", "mon,tue,wed,thu,fri")
    s = Scheduler()
    ist = ZoneInfo("Asia/Kolkata")
    wed = lambda h, m: datetime(2026, 10, 14, h, m, tzinfo=ist)  # noqa: E731 - a Wednesday
    assert not s.summary_due(wed(9, 59), {})
    assert s.summary_due(wed(10, 0), {})
    assert s.summary_due(wed(11, 30), {})            # late after a restart, still inside the grace period
    assert not s.summary_due(wed(12, 30), {})        # too late - skip today
    assert not s.summary_due(wed(10, 5), {"summary_sent_on": "2026-10-14"})
    assert not s.summary_due(datetime(2026, 10, 17, 10, 0, tzinfo=ist), {})  # Saturday not configured


def test_create_and_update_always_notify(client, admin, world, monkeypatch):
    import json as _json

    from app import slack

    sent = []
    monkeypatch.setattr(settings, "SLACK_WEBHOOK_URL", "https://hooks.slack.test/x")
    monkeypatch.setattr(slack, "_request", lambda url, *, data, headers: (sent.append(_json.loads(data)["text"]), (200, "ok", {}))[1])

    ravi, asha, kiran, pay = world["ravi"], world["asha"], world["kiran"], world["pay"]

    def latest(user):
        return client.get(f"{API}/notifications", headers=user["headers"]).json()["items"][0]

    # an owner creating an unassigned ticket: nobody else to notify in-app, but Slack still hears about it
    t = raise_ticket(client, ravi["headers"], pay["id"], title="Owner-made ticket")
    slack.flush()
    assert len(sent) == 1 and "created" in sent[0] and "assignee: unassigned" in sent[0]

    # a developer raising one: owners get "ticket_created"
    sent.clear()
    t2 = raise_ticket(client, asha["headers"], pay["id"], title="Dev-made ticket", priority="high")
    n = latest(ravi)
    assert n["type"] == "ticket_created" and "Asha Dev created" in n["message"] and "high priority" in n["message"]
    slack.flush()
    assert len(sent) == 1

    # any field update notifies assignee + reporter, with what changed
    assign(client, ravi["headers"], t2["id"], kiran["id"])
    sent.clear()
    r = client.patch(f"{API}/tickets/{t2['id']}", headers=ravi["headers"],
                     json={"description": "More detail", "estimated_hours": 4, "priority": "critical"})
    assert r.status_code == 200
    for who in (kiran, asha):
        n = latest(who)
        assert n["type"] == "ticket_updated"
        assert "description edited" in n["message"] and "priority high → critical" in n["message"]
        assert "estimate none → 4h" in n["message"]
    slack.flush()
    assert len(sent) == 1 and "updated" in sent[0]

    # an edit by the assignee also tells the project owners
    client.patch(f"{API}/tickets/{t2['id']}", headers=kiran["headers"], json={"title": "Dev-made ticket v2"})
    n = latest(ravi)
    assert n["type"] == "ticket_updated" and 'title was "Dev-made ticket"' in n["message"]

    # saving without changes notifies nobody
    sent.clear()
    before = client.get(f"{API}/notifications", headers=kiran["headers"]).json()["total"]
    client.patch(f"{API}/tickets/{t2['id']}", headers=ravi["headers"], json={"priority": "critical"})
    slack.flush()
    assert client.get(f"{API}/notifications", headers=kiran["headers"]).json()["total"] == before and sent == []
    assert t["id"]


# --------------------------------------------------------------------------- #
# Upcoming tasks
# --------------------------------------------------------------------------- #
def test_upcoming_tasks(client, admin, world, tmp_path):
    ravi, asha, zed, pay = world["ravi"], world["asha"], world["zed"], world["pay"]
    body = {
        "title": "Recurring payments",
        "priority": "high",
        "target_date": iso(days=30),
        "requirements": "Users can schedule **monthly** payments.",
        "acceptance_criteria": "- [x] Schedule a payment\n- [ ] Cancel a schedule\n- [ ] Email receipt",
        "reference_links": [{"title": "Spec", "url": "https://example.com/spec"}],
    }

    # only admins create; owners and developers cannot
    assert client.post(f"{API}/projects/{pay['id']}/upcoming", headers=ravi["headers"], json=body).status_code == 403
    bad = {**body, "reference_links": [{"title": "x", "url": "javascript:alert(1)"}]}
    assert client.post(f"{API}/projects/{pay['id']}/upcoming", headers=admin, json=bad).status_code == 422
    r = client.post(f"{API}/projects/{pay['id']}/upcoming", headers=admin, json=body)
    assert r.status_code == 201, r.text
    task = r.json()
    assert task["status"] == "draft" and task["criteria_total"] == 3 and task["criteria_done"] == 1
    assert task["can_edit"] is True and task["ticket"] is None

    # owners are told about it
    n = client.get(f"{API}/notifications", headers=ravi["headers"]).json()["items"][0]
    assert n["type"] == "upcoming" and "Recurring payments" in n["message"]

    # members can read; non-members get 404; nobody but admin edits
    seen = client.get(f"{API}/upcoming/{task['id']}", headers=asha["headers"]).json()
    assert seen["title"] == "Recurring payments" and seen["can_edit"] is False and seen["can_convert"] is False
    assert client.get(f"{API}/upcoming/{task['id']}", headers=zed["headers"]).status_code == 404
    assert client.get(f"{API}/upcoming", headers=zed["headers"]).json() == []
    assert client.patch(f"{API}/upcoming/{task['id']}", headers=asha["headers"], json={"title": "x"}).status_code == 403
    assert [t["id"] for t in client.get(f"{API}/projects/{pay['id']}/upcoming", headers=asha["headers"]).json()] == [task["id"]]

    r = client.patch(f"{API}/upcoming/{task['id']}", headers=admin, json={"status": "ready", "reference_links": [
        {"title": "Spec", "url": "https://example.com/spec"}, {"title": "", "url": "https://example.com/figma"}]})
    assert r.status_code == 200 and r.json()["status"] == "ready" and len(r.json()["reference_links"]) == 2
    assert client.patch(f"{API}/upcoming/{task['id']}", headers=admin, json={"status": "converted"}).status_code == 400

    # documents: admin uploads, members download, only admin deletes
    files = {"files": ("brief.txt", b"requirements brief", "text/plain")}
    assert client.post(f"{API}/upcoming/{task['id']}/documents", headers=ravi["headers"], files=files).status_code == 403
    docs = client.post(f"{API}/upcoming/{task['id']}/documents", headers=admin, files=files).json()
    assert docs[0]["filename"] == "brief.txt"
    r = client.get(f"{API}/upcoming-documents/{docs[0]['id']}/download", headers=asha["headers"])
    assert r.status_code == 200 and r.content == b"requirements brief"
    assert client.get(f"{API}/upcoming-documents/{docs[0]['id']}/download", headers=zed["headers"]).status_code == 404
    assert client.delete(f"{API}/upcoming-documents/{docs[0]['id']}", headers=asha["headers"]).status_code == 403

    # conversion: developers cannot; an owner can, once
    owner_view = client.get(f"{API}/upcoming/{task['id']}", headers=ravi["headers"]).json()
    assert owner_view["can_convert"] is True
    assert client.post(f"{API}/upcoming/{task['id']}/convert", headers=asha["headers"], json={}).status_code == 403
    r = client.post(f"{API}/upcoming/{task['id']}/convert", headers=ravi["headers"],
                    json={"type": "feature", "assignee_id": asha["id"]})
    assert r.status_code == 200, r.text
    ticket = r.json()
    assert ticket["title"] == "Recurring payments" and ticket["priority"] == "high" and ticket["type"] == "feature"
    assert ticket["assignee"]["id"] == asha["id"] and ticket["due_date"] is not None
    assert "## Acceptance criteria" in ticket["description"] and "https://example.com/figma" in ticket["description"]
    assert ticket["attachment_count"] == 1
    att = client.get(f"{API}/tickets/{ticket['id']}/attachments", headers=asha["headers"]).json()[0]
    assert client.get(f"{API}/attachments/{att['id']}/download", headers=asha["headers"]).content == b"requirements brief"

    after = client.get(f"{API}/upcoming/{task['id']}", headers=admin).json()
    assert after["status"] == "converted" and after["ticket"]["key"] == ticket["key"] and after["can_convert"] is False
    assert client.post(f"{API}/upcoming/{task['id']}/convert", headers=admin, json={}).status_code == 409

    # deleting removes it (the ticket stays)
    assert client.delete(f"{API}/upcoming/{task['id']}", headers=ravi["headers"]).status_code == 403
    assert client.delete(f"{API}/upcoming/{task['id']}", headers=admin).status_code == 204
    assert client.get(f"{API}/upcoming/{task['id']}", headers=admin).status_code == 404
    assert client.get(f"{API}/tickets/{ticket['id']}", headers=admin).status_code == 200


# --------------------------------------------------------------------------- #
# Releases
# --------------------------------------------------------------------------- #
def test_releases(client, admin, world, monkeypatch):
    import json as _json

    from app import slack

    sent = []
    monkeypatch.setattr(settings, "SLACK_WEBHOOK_URL", "https://hooks.slack.test/x")
    monkeypatch.setattr(slack, "_request", lambda url, *, data, headers: (sent.append(_json.loads(data)["text"]), (200, "ok", {}))[1])

    ravi, asha, kiran, zed, ops = world["ravi"], world["asha"], world["kiran"], world["zed"], world["ops"]
    H = ravi["headers"]

    def finished(title, type_="feature", verify=True):
        t = raise_ticket(client, H, ops["id"], title=title, type=type_, assignee_id=kiran["id"])
        set_status(client, kiran["headers"], t["id"], "done")
        if verify:
            set_status(client, H, t["id"], "verified")
        return t

    feat, bug = finished("Export CSV"), finished("Fix totals", "bug", verify=False)
    open_t = raise_ticket(client, H, ops["id"], title="Still open", assignee_id=kiran["id"])

    # only owners/admin create; names are unique per project
    assert client.post(f"{API}/projects/{ops['id']}/releases", headers=kiran["headers"], json={"name": "v1.0"}).status_code == 403
    rel = client.post(f"{API}/projects/{ops['id']}/releases", headers=H, json={"name": " v1.0 ", "notes": "First cut"}).json()
    assert rel["name"] == "v1.0" and rel["status"] == "planned" and rel["can_manage"] is True
    assert client.post(f"{API}/projects/{ops['id']}/releases", headers=admin, json={"name": "V1.0"}).status_code == 409

    # only finished tickets of the same project can be added
    r = client.post(f"{API}/releases/{rel['id']}/tickets", headers=H, json={"ticket_ids": [feat["id"], open_t["id"]]})
    assert r.status_code == 400 and "not done yet" in r.json()["detail"]
    r = client.post(f"{API}/releases/{rel['id']}/tickets", headers=H, json={"ticket_ids": [feat["id"], bug["id"]]})
    assert r.status_code == 200
    body = r.json()
    assert body["ticket_count"] == 2 and body["unverified_count"] == 1 and body["by_type"] == {"feature": 1, "bug": 1}
    assert client.post(f"{API}/releases/{rel['id']}/tickets", headers=kiran["headers"], json={"ticket_ids": [feat["id"]]}).status_code == 403

    # tickets in a release leave the board / default lists (in_release=false) but can be listed by release
    board = client.get(f"{API}/projects/{ops['id']}/tickets", headers=H, params={"in_release": False, "limit": 200}).json()["items"]
    assert feat["id"] not in [t["id"] for t in board] and open_t["id"] in [t["id"] for t in board]
    by_rel = client.get(f"{API}/tickets", headers=H, params={"release_id": rel["id"]}).json()["items"]
    assert {t["id"] for t in by_rel} == {feat["id"], bug["id"]}
    assert client.get(f"{API}/tickets/{feat['id']}", headers=H).json()["release"]["name"] == "v1.0"

    # reopening a ticket in a planned release takes it out of the release
    extra = finished("Tweak copy", "improvement")
    client.post(f"{API}/releases/{rel['id']}/tickets", headers=H, json={"ticket_ids": [extra["id"]]})
    reopened = set_status(client, H, extra["id"], "in_progress")
    assert reopened["release"] is None
    assert client.get(f"{API}/releases/{rel['id']}", headers=H).json()["ticket_count"] == 2

    # members can read; outsiders cannot
    assert client.get(f"{API}/releases/{rel['id']}", headers=kiran["headers"]).json()["can_manage"] is False
    assert client.get(f"{API}/releases/{rel['id']}", headers=zed["headers"]).status_code == 404
    assert [x["id"] for x in client.get(f"{API}/projects/{ops['id']}/releases", headers=kiran["headers"]).json()] == [rel["id"]]

    # releasing: verifies remaining done tickets, locks the release, notifies members and Slack
    sent.clear()
    assert client.post(f"{API}/releases/{rel['id']}/release", headers=kiran["headers"]).status_code == 403
    r = client.post(f"{API}/releases/{rel['id']}/release", headers=H)
    assert r.status_code == 200, r.text
    shipped = r.json()
    assert shipped["status"] == "released" and shipped["released_at"] and shipped["releaser"]["id"] == ravi["id"]
    assert shipped["unverified_count"] == 0 and shipped["can_manage"] is False
    assert all(t["status"] == "verified" for t in shipped["tickets"])
    n = client.get(f"{API}/notifications", headers=kiran["headers"]).json()["items"][0]
    assert n["type"] == "release" and "v1.0 was released" in n["message"]
    slack.flush()
    assert len(sent) == 1 and "v1.0" in sent[0] and "*New features*" in sent[0] and "*Bug fixes*" in sent[0]

    # a released version is locked
    assert client.post(f"{API}/releases/{rel['id']}/release", headers=H).status_code == 400
    assert client.delete(f"{API}/releases/{rel['id']}/tickets/{feat['id']}", headers=H).status_code == 400
    assert client.delete(f"{API}/releases/{rel['id']}", headers=H).status_code == 400
    r = set_status(client, H, feat["id"], "in_progress", expect=400)
    assert "shipped in release v1.0" in r["detail"]
    # notes can still be corrected, the name cannot
    assert client.patch(f"{API}/releases/{rel['id']}", headers=H, json={"notes": "First cut (fixed)"}).status_code == 200
    assert client.patch(f"{API}/releases/{rel['id']}", headers=H, json={"name": "v1.0.1"}).status_code == 400

    # deleting a planned release puts its tickets back on the board
    rel2 = client.post(f"{API}/projects/{ops['id']}/releases", headers=H, json={"name": "v1.1"}).json()
    again = finished("Another feature")
    client.post(f"{API}/releases/{rel2['id']}/tickets", headers=H, json={"ticket_ids": [again["id"]]})
    assert client.delete(f"{API}/releases/{rel2['id']}", headers=H).status_code == 204
    assert client.get(f"{API}/tickets/{again['id']}", headers=H).json()["release"] is None
    # an empty release cannot be released
    rel3 = client.post(f"{API}/projects/{ops['id']}/releases", headers=H, json={"name": "v1.2"}).json()
    assert client.post(f"{API}/releases/{rel3['id']}/release", headers=H).status_code == 400

    # released tickets still count in the efficiency report
    rep = client.get(f"{API}/reports/efficiency/{kiran['id']}", headers=admin, params={"project_id": ops["id"]}).json()
    assert rep["completed"] >= 3


# --------------------------------------------------------------------------- #
# Start dates, overlap check and the timeline
# --------------------------------------------------------------------------- #
def test_start_date_overlaps_and_timeline(client, admin, world):
    from datetime import date as _date

    owner = make_user(client, admin, "Olga Owner", "olga@example.com")
    dev = make_user(client, admin, "Dev Dan", "dan@example.com")
    other = make_user(client, admin, "Other Owen", "owen@example.com")
    lead = make_user(client, admin, "Lead Lia", "lia@example.com")

    def project(name, key, owner_id):
        r = client.post(f"{API}/projects", headers=admin, json={"name": name, "key": key, "owner_ids": [owner_id]})
        assert r.status_code == 201, r.text
        return r.json()

    tl, side = project("Timeline", "TL", owner["id"]), project("Side work", "SIDE", other["id"])
    for p, h in ((tl, owner["headers"]), (side, other["headers"])):
        assert client.post(f"{API}/projects/{p['id']}/members", headers=h, json={"user_id": dev["id"]}).status_code == 201

    day = lambda n: iso(days=n)  # noqa: E731
    # start after due is rejected; developers cannot plan the start
    r = client.post(f"{API}/projects/{tl['id']}/tickets", headers=owner["headers"],
                    json={"title": "bad", "start_date": day(5), "due_date": day(2)})
    assert r.status_code == 400
    r = client.post(f"{API}/projects/{tl['id']}/tickets", headers=dev["headers"], json={"title": "x", "start_date": day(1)})
    assert r.status_code == 403

    a = raise_ticket(client, owner["headers"], tl["id"], title="A", assignee_id=dev["id"], start_date=day(1), due_date=day(4))
    b = raise_ticket(client, owner["headers"], tl["id"], title="B", assignee_id=dev["id"], start_date=day(3), due_date=day(6))
    c = raise_ticket(client, owner["headers"], tl["id"], title="C", assignee_id=dev["id"], start_date=day(10), due_date=day(12))
    hidden = raise_ticket(client, other["headers"], side["id"], title="Secret", assignee_id=dev["id"],
                          start_date=day(2), due_date=day(3))
    nodue = raise_ticket(client, owner["headers"], tl["id"], title="Someday", assignee_id=dev["id"])
    assert a["start_date"] is not None

    # overlap check for a new piece of work on days 2..5: A and B visible, the other project's one only counted
    r = client.get(f"{API}/timeline/overlaps", headers=owner["headers"],
                   params={"user_id": dev["id"], "start": day(2), "end": day(5)})
    assert r.status_code == 200, r.text
    ov = r.json()
    assert [t["key"] for t in ov["tickets"]] == [a["key"], b["key"]] and ov["hidden_count"] == 1
    # the admin sees all three; the ticket being reassigned is excluded
    ov = client.get(f"{API}/timeline/overlaps", headers=admin,
                    params={"user_id": dev["id"], "start": day(2), "end": day(5), "exclude_ticket_id": a["id"]}).json()
    assert {t["key"] for t in ov["tickets"]} == {b["key"], hidden["key"]} and ov["hidden_count"] == 0
    # no clash on free days; developers cannot probe other people
    assert client.get(f"{API}/timeline/overlaps", headers=owner["headers"],
                      params={"user_id": dev["id"], "start": day(7), "end": day(9)}).json()["tickets"] == []
    assert client.get(f"{API}/timeline/overlaps", headers=dev["headers"],
                      params={"user_id": owner["id"], "end": day(3)}).status_code == 403
    assert client.get(f"{API}/timeline/overlaps", headers=lead["headers"],
                      params={"user_id": dev["id"], "end": day(3)}).status_code == 403

    start = _date.today().isoformat()
    # owner: the people of their projects, only those projects' tickets
    tlo = client.get(f"{API}/timeline", headers=owner["headers"], params={"start": start}).json()
    assert tlo["scope"] == "owned"
    row = next(r for r in tlo["rows"] if r["user"]["id"] == dev["id"])
    keys = [t["key"] for t in row["tickets"]]
    assert keys == [a["key"], b["key"], c["key"]] and hidden["key"] not in keys
    by_key = {t["key"]: t for t in row["tickets"]}
    assert by_key[a["key"]]["overlaps"] == [b["key"]] and by_key[c["key"]]["overlaps"] == []
    assert row["overlap_count"] == 2 and [t["key"] for t in row["unscheduled"]] == [nodue["key"]]
    assert by_key[a["key"]]["start_planned"] is True

    # admin: everyone, every project; the other project's ticket now overlaps A and B
    tla = client.get(f"{API}/timeline", headers=admin, params={"start": start, "user_id": dev["id"]}).json()
    assert tla["scope"] == "all"
    keys = {t["key"]: t for t in tla["rows"][0]["tickets"]}
    assert hidden["key"] in keys and set(keys[a["key"]]["overlaps"]) == {b["key"], hidden["key"]}
    # filtered to one project
    tlp = client.get(f"{API}/timeline", headers=admin, params={"start": start, "project_id": side["id"]}).json()
    assert {t["key"] for r in tlp["rows"] for t in r["tickets"]} == {hidden["key"]}

    # developer: only their own row
    tld = client.get(f"{API}/timeline", headers=dev["headers"], params={"start": start}).json()
    assert tld["scope"] == "self" and [r["user"]["id"] for r in tld["rows"]] == [dev["id"]]
    assert client.get(f"{API}/timeline", headers=dev["headers"], params={"user_id": owner["id"]}).status_code == 404

    # a range that misses everything; finished tickets drop off unless asked for
    far = client.get(f"{API}/timeline", headers=owner["headers"],
                     params={"start": "2030-01-01", "end": "2030-01-31", "user_id": dev["id"]}).json()
    assert far["rows"][0]["tickets"] == []
    set_status(client, dev["headers"], c["id"], "in_progress")
    set_status(client, dev["headers"], c["id"], "done")
    row = client.get(f"{API}/timeline", headers=owner["headers"], params={"start": start, "user_id": dev["id"]}).json()["rows"][0]
    assert c["key"] not in [t["key"] for t in row["tickets"]]
    row = client.get(f"{API}/timeline", headers=owner["headers"],
                     params={"start": start, "user_id": dev["id"], "include_done": True}).json()["rows"][0]
    assert c["key"] in [t["key"] for t in row["tickets"]]
    assert client.get(f"{API}/timeline", headers=owner["headers"], params={"start": "2026-01-10", "end": "2026-01-01"}).status_code == 400

    # the start date is editable by owners only, and validated against the due date
    assert client.patch(f"{API}/tickets/{a['id']}", headers=dev["headers"], json={"start_date": day(0)}).status_code == 403
    assert client.patch(f"{API}/tickets/{a['id']}", headers=owner["headers"], json={"start_date": day(9)}).status_code == 400
    assert client.patch(f"{API}/tickets/{a['id']}", headers=owner["headers"], json={"start_date": day(0)}).status_code == 200


# --------------------------------------------------------------------------- #
# Documentation
# --------------------------------------------------------------------------- #
def test_docs(client, admin, world):
    ravi, asha, kiran, zed, pay = world["ravi"], world["asha"], world["kiran"], world["zed"], world["pay"]

    # members write (wiki style); outsiders cannot
    r = client.post(f"{API}/projects/{pay['id']}/docs", headers=asha["headers"],
                    json={"title": " Architecture ", "content": "# Overview\nPayments flow through the **gateway**."})
    assert r.status_code == 201, r.text
    root = r.json()
    assert root["title"] == "Architecture" and root["can_edit"] is True and root["can_delete"] is False
    assert client.post(f"{API}/projects/{pay['id']}/docs", headers=zed["headers"], json={"title": "x"}).status_code == 404
    child = client.post(f"{API}/projects/{pay['id']}/docs", headers=kiran["headers"],
                        json={"title": "Refund service", "content": "Retries with backoff", "parent_id": root["id"]}).json()
    grandchild = client.post(f"{API}/projects/{pay['id']}/docs", headers=kiran["headers"],
                             json={"title": "Runbook", "parent_id": child["id"]}).json()
    assert [b["title"] for b in grandchild["breadcrumbs"]] == ["Architecture", "Refund service"]
    assert [c["title"] for c in client.get(f"{API}/docs/{root['id']}", headers=ravi["headers"]).json()["children"]] == ["Refund service"]

    # parent must be in the same project; no cycles
    other = client.post(f"{API}/projects/{world['ops']['id']}/docs", headers=kiran["headers"], json={"title": "Ops"}).json()
    assert client.post(f"{API}/projects/{pay['id']}/docs", headers=kiran["headers"],
                       json={"title": "bad", "parent_id": other["id"]}).status_code == 400
    assert client.patch(f"{API}/docs/{root['id']}", headers=ravi["headers"], json={"parent_id": grandchild["id"]}).status_code == 400

    # listing and search are scoped to the caller's projects
    assert {d["title"] for d in client.get(f"{API}/docs", headers=asha["headers"]).json()} == {"Architecture", "Refund service", "Runbook"}
    assert client.get(f"{API}/docs", headers=zed["headers"]).json() == []
    hits = client.get(f"{API}/docs", headers=asha["headers"], params={"q": "backoff"}).json()
    assert [h["title"] for h in hits] == ["Refund service"] and "backoff" in hits[0]["snippet"]
    assert client.get(f"{API}/docs/{root['id']}", headers=zed["headers"]).status_code == 404

    # edits keep revisions; restoring brings the old text back (and is itself revisioned)
    client.patch(f"{API}/docs/{root['id']}", headers=kiran["headers"], json={"content": "v2"})
    client.patch(f"{API}/docs/{root['id']}", headers=ravi["headers"], json={"title": "Architecture v3", "content": "v3"})
    page = client.get(f"{API}/docs/{root['id']}", headers=asha["headers"]).json()
    assert page["revision_count"] == 2 and page["editor"]["id"] == ravi["id"]
    revs = client.get(f"{API}/docs/{root['id']}/revisions", headers=asha["headers"]).json()
    assert [r["title"] for r in revs] == ["Architecture", "Architecture"]
    first = client.get(f"{API}/docs/{root['id']}/revisions/{revs[-1]['id']}", headers=asha["headers"]).json()
    assert first["content"].startswith("# Overview") and first["author"]["id"] == asha["id"]
    restored = client.post(f"{API}/docs/{root['id']}/revisions/{revs[-1]['id']}/restore", headers=asha["headers"]).json()
    assert restored["title"] == "Architecture" and restored["content"].startswith("# Overview") and restored["revision_count"] == 3
    # a no-op save does not add a revision
    client.patch(f"{API}/docs/{root['id']}", headers=asha["headers"], json={"title": "Architecture"})
    assert client.get(f"{API}/docs/{root['id']}", headers=asha["headers"]).json()["revision_count"] == 3

    # only owners delete; children move up a level
    assert client.delete(f"{API}/docs/{child['id']}", headers=kiran["headers"]).status_code == 403
    assert client.delete(f"{API}/docs/{child['id']}", headers=ravi["headers"]).status_code == 204
    assert client.get(f"{API}/docs/{grandchild['id']}", headers=asha["headers"]).json()["parent_id"] == root["id"]


def test_dashboard(client, admin, world):
    ravi, kiran, zed, pay = world["ravi"], world["kiran"], world["zed"], world["pay"]
    t = raise_ticket(client, ravi["headers"], pay["id"], title="Dash", assignee_id=kiran["id"], due_date=iso(days=2), estimated_hours=5)
    set_status(client, kiran["headers"], t["id"], "in_progress")

    d = client.get(f"{API}/dashboard", headers=admin, params={"days": 7}).json()
    assert d["scope"] == "all" and len(d["trend"]) == 7 and d["trend"][-1]["created"] >= 1
    assert d["kpis"]["open"] >= 1 and d["kpis"]["due_week"] >= 1 and "avg_cycle_days" in d["kpis"]
    row = next(r for r in d["workload"] if r["user"]["id"] == kiran["id"])
    assert row["by_status"]["in_progress"] >= 1 and row["remaining_hours"] >= 5
    assert any(a["ticket"]["key"] == t["key"] for a in d["activity"])

    owner = client.get(f"{API}/dashboard", headers=ravi["headers"]).json()
    assert owner["scope"] == "owned" and {r["user"]["id"] for r in owner["workload"]} >= {kiran["id"]}
    dev = client.get(f"{API}/dashboard", headers=kiran["headers"], params={"project_id": pay["id"]}).json()
    assert [r["user"]["id"] for r in dev["workload"]] == [kiran["id"]] or dev["scope"] == "owned"
    assert client.get(f"{API}/dashboard", headers=zed["headers"], params={"project_id": pay["id"]}).status_code == 404
    empty = client.get(f"{API}/dashboard", headers=zed["headers"]).json()
    assert empty["kpis"]["open"] == 0 and empty["workload"][0]["user"]["id"] == zed["id"]


def test_ticket_sorting_options(client, world):
    ravi, pay = world["ravi"], world["pay"]
    for sort in ("title", "status", "key", "assignee", "start_date", "priority", "due_date", "updated_at"):
        for order in ("asc", "desc"):
            r = client.get(f"{API}/projects/{pay['id']}/tickets", headers=ravi["headers"], params={"sort": sort, "order": order, "limit": 50})
            assert r.status_code == 200, (sort, r.text)
    titles = [t["title"].lower() for t in client.get(f"{API}/projects/{pay['id']}/tickets", headers=ravi["headers"],
                                                      params={"sort": "title", "order": "asc", "limit": 200}).json()["items"]]
    assert titles == sorted(titles)
    rows = client.get(f"{API}/projects/{pay['id']}/tickets", headers=ravi["headers"], params={"sort": "assignee", "order": "asc", "limit": 200}).json()["items"]
    names = [t["assignee"]["name"].lower() for t in rows if t["assignee"]]
    assert names == sorted(names) and all(t["assignee"] is None for t in rows[len(names):])


def test_owned_ticket_filter(client, admin, world):
    ravi, kiran, pay, ops = world["ravi"], world["kiran"], world["pay"], world["ops"]
    # Kiran owns nothing: "owned" returns nothing for him, while normal lists still show his projects
    assert client.get(f"{API}/tickets", headers=kiran["headers"], params={"owned": True}).json()["total"] == 0
    # Ravi owns PAY and OPS; admin sees everything
    mine = {p["id"] for p in client.get(f"{API}/projects", headers=ravi["headers"], params={"include_archived": True}).json()
            if p["my_role"] == "owner"}
    owned = client.get(f"{API}/tickets", headers=ravi["headers"], params={"owned": True, "limit": 200}).json()
    assert {t["project"]["id"] for t in owned["items"]} <= mine and owned["total"] > 0
    # a project where he is only a developer is left out
    assert client.get(f"{API}/tickets", headers=kiran["headers"], params={"owned": True, "project_id": pay["id"]}).json()["total"] == 0
    assert client.get(f"{API}/tickets", headers=admin, params={"owned": True}).json()["total"] >= owned["total"]


# --------------------------------------------------------------------------- #
# Sprints
# --------------------------------------------------------------------------- #
def test_sprints(client, admin, world):
    owner = make_user(client, admin, "Sam Scrum", "sam@example.com")
    dev = make_user(client, admin, "Devi Dev", "devi@example.com")
    outsider = make_user(client, admin, "Oscar Out", "oscar@example.com")
    proj = client.post(f"{API}/projects", headers=admin, json={"name": "Sprinty", "key": "SPR", "owner_ids": [owner["id"]]}).json()
    client.post(f"{API}/projects/{proj['id']}/members", headers=owner["headers"], json={"user_id": dev["id"]})
    H = owner["headers"]

    # only owners create; default names; dates validated
    assert client.post(f"{API}/projects/{proj['id']}/sprints", headers=dev["headers"], json={}).status_code == 403
    assert client.post(f"{API}/projects/{proj['id']}/sprints", headers=H, json={"start_date": iso(days=5), "end_date": iso(days=1)}).status_code == 400
    s1 = client.post(f"{API}/projects/{proj['id']}/sprints", headers=H, json={"goal": "Ship login"}).json()
    s2 = client.post(f"{API}/projects/{proj['id']}/sprints", headers=H, json={"name": "Hardening", "start_date": iso(days=14), "end_date": iso(days=27)}).json()
    assert s1["name"] == "Sprint 1" and s1["status"] == "planned" and s1["can_manage"] is True
    assert s2["days_total"] == 14

    a = raise_ticket(client, H, proj["id"], title="Login form", assignee_id=dev["id"], estimated_hours=5)
    b = raise_ticket(client, H, proj["id"], title="Password reset", assignee_id=dev["id"], sprint_id=s1["id"])
    c = raise_ticket(client, H, proj["id"], title="Remember me", assignee_id=dev["id"])
    assert b["sprint"]["name"] == "Sprint 1" and a["sprint"] is None
    # developers cannot plan sprints
    r = client.post(f"{API}/projects/{proj['id']}/tickets", headers=dev["headers"], json={"title": "x", "sprint_id": s1["id"]})
    assert r.status_code == 403
    assert client.patch(f"{API}/tickets/{c['id']}", headers=dev["headers"], json={"sprint_id": s1["id"]}).status_code == 403

    # move tickets in (and back to the backlog)
    r = client.post(f"{API}/projects/{proj['id']}/sprint-moves", headers=H, json={"ticket_ids": [a["id"], c["id"]], "sprint_id": s1["id"]})
    assert r.json()["moved"] == 2
    client.post(f"{API}/projects/{proj['id']}/sprint-moves", headers=H, json={"ticket_ids": [c["id"]], "sprint_id": None})
    backlog = client.get(f"{API}/projects/{proj['id']}/tickets", headers=H, params={"backlog": True}).json()["items"]
    assert [t["id"] for t in backlog] == [c["id"]]
    in_s1 = client.get(f"{API}/projects/{proj['id']}/tickets", headers=H, params={"sprint_id": s1["id"]}).json()["items"]
    assert {t["id"] for t in in_s1} == {a["id"], b["id"]}
    acts = client.get(f"{API}/tickets/{c['id']}/activity", headers=H).json()
    assert any(x["action"] == "sprint_moved" and x["old_value"] == "Sprint 1" for x in acts)

    # start: defaults the dates, one active sprint at a time, members told
    started = client.post(f"{API}/sprints/{s1['id']}/start", headers=H).json()
    assert started["status"] == "active" and started["start_date"] and started["end_date"] and started["days_left"] == 13
    assert client.post(f"{API}/sprints/{s2['id']}/start", headers=H).status_code == 409
    n = client.get(f"{API}/notifications", headers=dev["headers"]).json()["items"][0]
    assert n["type"] == "sprint" and "Sprint 1 started" in n["message"]
    active = client.get(f"{API}/projects/{proj['id']}/tickets", headers=H, params={"active_sprint": True}).json()["items"]
    assert {t["id"] for t in active} == {a["id"], b["id"]}
    assert s1["id"] in [s["id"] for s in client.get(f"{API}/sprints/active", headers=dev["headers"]).json()]
    assert client.get(f"{API}/sprints/{s1['id']}", headers=outsider["headers"]).status_code == 404

    # finish one ticket, check the burndown, then complete: the open one moves to the next sprint
    set_status(client, dev["headers"], b["id"], "in_progress")
    set_status(client, dev["headers"], b["id"], "done")
    bd = client.get(f"{API}/sprints/{s1['id']}/burndown", headers=dev["headers"]).json()
    assert bd[0]["remaining"] == 1 and bd[0]["ideal"] == 2 and bd[-1]["remaining"] is None and bd[-1]["ideal"] == 0
    assert client.post(f"{API}/sprints/{s1['id']}/complete", headers=dev["headers"], json={}).status_code == 403
    done = client.post(f"{API}/sprints/{s1['id']}/complete", headers=H, json={"move_open_to": s2["id"]}).json()
    assert done["status"] == "completed" and done["done_count"] == 1 and done["ticket_count"] == 1 and done["can_manage"] is False
    assert client.get(f"{API}/tickets/{a['id']}", headers=H).json()["sprint"]["name"] == "Hardening"
    n = client.get(f"{API}/notifications", headers=dev["headers"]).json()["items"][0]
    assert "1 of 2 tickets done" in n["message"] and "moved to Hardening" in n["message"]

    # completed sprints are locked
    assert client.patch(f"{API}/sprints/{s1['id']}", headers=H, json={"name": "x"}).status_code == 400
    assert client.post(f"{API}/projects/{proj['id']}/sprint-moves", headers=H, json={"ticket_ids": [c["id"]], "sprint_id": s1["id"]}).status_code == 400
    assert client.post(f"{API}/projects/{proj['id']}/sprint-moves", headers=H, json={"ticket_ids": [b["id"]], "sprint_id": None}).status_code == 400
    # deleting a planned sprint sends its tickets to the backlog
    assert client.delete(f"{API}/sprints/{s2['id']}", headers=H).status_code == 204
    assert client.get(f"{API}/tickets/{a['id']}", headers=H).json()["sprint"] is None
    order = [s["status"] for s in client.get(f"{API}/projects/{proj['id']}/sprints", headers=dev["headers"]).json()]
    assert order == ["completed"]


# --------------------------------------------------------------------------- #
# Slack settings from the admin panel
# --------------------------------------------------------------------------- #
def test_slack_config_from_panel(client, admin, world, monkeypatch):
    import json as _json

    from app import runtime_config, slack
    from app.models import AppSetting
    from app.database import SessionLocal

    sent = []
    monkeypatch.setattr(slack, "_request", lambda url, *, data, headers: (sent.append((url, _json.loads(data) if data else None)), (200, "ok", {}))[1])
    kiran = world["kiran"]
    assert client.put(f"{API}/integrations/slack/config", headers=kiran["headers"], json={"enabled": True}).status_code == 403

    # validation
    bad = client.put(f"{API}/integrations/slack/config", headers=admin, json={
        "webhook_url": "http://evil.example.com/x", "daily_summary_time": "25:00", "timezone": "Mars/Base", "notify_types": ["nope"]})
    assert bad.status_code == 422
    for part in ("Webhook URL", "HH:MM", "time zone", "Unknown notification types"):
        assert part in bad.json()["detail"]

    hook = "https://hooks.slack.com/services/T000/B000/abcdefSECRET1234"
    r = client.put(f"{API}/integrations/slack/config", headers=admin, json={
        "enabled": True, "webhook_url": hook, "notify_types": ["assigned", "overdue"], "daily_summary_time": "09:30",
        "daily_summary_days": ["fri", "mon"], "timezone": "Europe/London", "app_base_url": "https://tickets.acme.dev/"})
    assert r.status_code == 200, r.text
    st = r.json()
    assert st["enabled"] and st["mode"] == "webhook" and st["webhook_url_masked"].endswith("1234") and "SECRET" not in st["webhook_url_masked"]
    assert st["notify_types"] == ["assigned", "overdue"] and st["daily_summary_time"] == "09:30" and st["daily_summary_days"] == ["mon", "fri"]
    assert st["timezone"] == "Europe/London" and st["app_base_url"] == "https://tickets.acme.dev"
    assert st["sources"]["slack_webhook_url"] == "panel" and st["sources"]["slack_channel"] == "env"
    # the secret is encrypted at rest
    with SessionLocal() as db:
        row = db.get(AppSetting, "slack_webhook_url")
        assert row.is_secret and hook not in row.value and runtime_config.decrypt(row.value) == hook
    # it is used right away (no restart): test message goes to the saved webhook
    assert client.post(f"{API}/integrations/slack/test", headers=admin).status_code == 200
    assert sent[-1][0] == hook
    # only the chosen types are mirrored: "assigned" is, "ticket_created" is not
    sent.clear()
    t = raise_ticket(client, world["ravi"]["headers"], world["pay"]["id"], title="Panel config", assignee_id=kiran["id"])
    slack.flush()
    assert len(sent) == 0  # ticket creation is a "ticket_created" event, not selected
    assign(client, world["ravi"]["headers"], t["id"], world["asha"]["id"])
    slack.flush()
    assert any("assigned you" in body["text"] for _, body in sent)

    # switch off without losing the secret
    st = client.put(f"{API}/integrations/slack/config", headers=admin, json={"enabled": False}).json()
    assert st["enabled"] is False and st["configured"] is True
    assert client.post(f"{API}/integrations/slack/test", headers=admin).status_code == 400
    # a secret left out is kept; "" removes it
    st = client.put(f"{API}/integrations/slack/config", headers=admin, json={"enabled": True, "channel": "#dev-tickets"}).json()
    assert st["webhook_url_masked"] and st["channel"] == "#dev-tickets"
    st = client.put(f"{API}/integrations/slack/config", headers=admin, json={"webhook_url": ""}).json()
    assert st["webhook_url_masked"] is None and st["sources"]["slack_webhook_url"] == "env"
    # reset everything back to .env
    st = client.delete(f"{API}/integrations/slack/config", headers=admin).json()
    assert all(v == "env" for v in st["sources"].values()) and st["timezone"] == runtime_config.ENV_DEFAULTS["TIMEZONE"]


# --------------------------------------------------------------------------- #
# Team chat
# --------------------------------------------------------------------------- #
def test_chat_channels_messages_and_realtime(client, admin, world):
    ravi, asha, kiran, zed, pay = world["ravi"], world["asha"], world["kiran"], world["zed"], world["pay"]
    C = f"{API}/chat"

    # every project gets a channel its members see without joining; outsiders don't
    side = client.get(f"{C}/channels", headers=asha["headers"]).json()
    pay_ch = next(c for c in side if c["kind"] == "project" and c["project_id"] == pay["id"])
    assert pay_ch["display_name"] == "Payments" and pay_ch["can_post"] and pay_ch["unread"] == 0
    assert not any(c["project_id"] == pay["id"] for c in client.get(f"{C}/channels", headers=zed["headers"]).json())
    assert client.get(f"{C}/channels/{pay_ch['id']}/messages", headers=zed["headers"]).status_code == 404

    with client.websocket_connect(f"{C}/ws?token={kiran['headers']['Authorization'][7:]}") as ws:
        assert ws.receive_json()["type"] == "hello"
        # a message with a mention and a file reaches Kiran live, unread + mention counted
        r = client.post(f"{C}/channels/{pay_ch['id']}/messages", headers=asha["headers"],
                        data={"body": "Deploy at 5? @kiran@example.com"}, files={"files": ("plan.txt", b"steps", "text/plain")})
        assert r.status_code == 201, r.text
        msg = r.json()
        assert msg["files"][0]["filename"] == "plan.txt"
        ev = ws.receive_json()
        while ev["type"] != "message.new":
            ev = ws.receive_json()
        assert ev["message"]["id"] == msg["id"] and ev["channel_id"] == pay_ch["id"]

        k = next(c for c in client.get(f"{C}/channels", headers=kiran["headers"]).json() if c["id"] == pay_ch["id"])
        assert k["unread"] == 1 and k["mentions"] == 1
        inbox = client.get(f"{API}/notifications", headers=kiran["headers"]).json()["items"]
        assert inbox[0]["type"] == "chat_mention" and "mentioned you in #pay" in inbox[0]["message"]

        # typing is relayed
        ws.send_json({"type": "typing", "channel_id": pay_ch["id"]})
        ev = ws.receive_json()
        while ev["type"] != "typing":
            ev = ws.receive_json()
        assert ev["user_id"] == kiran["id"]

    # thread reply, reactions, pin, edit
    reply = client.post(f"{C}/channels/{pay_ch['id']}/messages", headers=kiran["headers"], data={"body": "Yes", "parent_id": msg["id"]}).json()
    thread = client.get(f"{C}/messages/{msg['id']}/thread", headers=asha["headers"]).json()
    assert thread["parent"]["reply_count"] == 1 and [m["id"] for m in thread["replies"]] == [reply["id"]]
    top = client.get(f"{C}/channels/{pay_ch['id']}/messages", headers=asha["headers"]).json()["messages"]
    assert [m["id"] for m in top] == [msg["id"]]  # replies stay in the thread
    r = client.post(f"{C}/messages/{msg['id']}/reactions", headers=kiran["headers"], json={"emoji": "👍"}).json()
    assert r["reactions"] == [{"emoji": "👍", "count": 1, "user_ids": [kiran["id"]]}]
    assert client.post(f"{C}/messages/{msg['id']}/reactions", headers=kiran["headers"], json={"emoji": "👍"}).json()["reactions"] == []
    assert client.post(f"{C}/messages/{msg['id']}/pin", headers=kiran["headers"]).json()["pinned"] is True
    assert len(client.get(f"{C}/channels/{pay_ch['id']}/pins", headers=asha["headers"]).json()) == 1
    assert client.patch(f"{C}/messages/{msg['id']}", headers=kiran["headers"], json={"body": "hack"}).status_code == 403
    edited = client.patch(f"{C}/messages/{msg['id']}", headers=asha["headers"], json={"body": "Deploy at 6?"}).json()
    assert edited["edited_at"] and edited["body"] == "Deploy at 6?"

    # read marker and "mark unread"
    client.post(f"{C}/channels/{pay_ch['id']}/read", headers=kiran["headers"], json={"message_id": msg["id"]})
    assert next(c for c in client.get(f"{C}/channels", headers=kiran["headers"]).json() if c["id"] == pay_ch["id"])["unread"] == 0
    client.post(f"{C}/channels/{pay_ch['id']}/read", headers=kiran["headers"], json={"message_id": msg["id"], "unread": True})
    assert client.get(f"{C}/unread", headers=kiran["headers"]).json()["unread"] >= 1

    # files are private to the conversation
    fid = msg["files"][0]["id"]
    assert client.get(f"{C}/files/{fid}", headers=kiran["headers"]).content == b"steps"
    assert client.get(f"{C}/files/{fid}", headers=zed["headers"]).status_code == 404

    # deleting a message with replies leaves a placeholder; deleting the last reply removes it
    assert client.delete(f"{C}/messages/{msg['id']}", headers=kiran["headers"]).status_code == 403
    assert client.delete(f"{C}/messages/{msg['id']}", headers=asha["headers"]).status_code == 204
    top = client.get(f"{C}/channels/{pay_ch['id']}/messages", headers=asha["headers"]).json()["messages"]
    assert top[0]["deleted"] and top[0]["body"] == "" and top[0]["files"] == []
    client.delete(f"{C}/messages/{reply['id']}", headers=kiran["headers"])
    assert client.get(f"{C}/channels/{pay_ch['id']}/messages", headers=asha["headers"]).json()["messages"] == []

    # public / private channels
    # only admins create channels and manage who is in them
    assert client.post(f"{C}/channels", headers=ravi["headers"], json={"name": "Random Talk"}).status_code == 403
    pub = client.post(f"{C}/channels", headers=admin, json={"name": "Random Talk", "topic": "Anything"}).json()
    assert pub["name"] == "random-talk"
    assert client.post(f"{C}/channels", headers=admin, json={"name": "random-talk"}).status_code == 409
    assert any(c["id"] == pub["id"] and not c["joined"] for c in client.get(f"{C}/channels/browse", headers=zed["headers"]).json())
    assert client.post(f"{C}/channels/{pub['id']}/messages", headers=zed["headers"], data={"body": "hi"}).status_code == 403
    client.post(f"{C}/channels/{pub['id']}/join", headers=zed["headers"])
    assert client.post(f"{C}/channels/{pub['id']}/messages", headers=zed["headers"], data={"body": "hi"}).status_code == 201
    priv = client.post(f"{C}/channels", headers=admin, json={"name": "leads", "is_private": True, "member_ids": [ravi["id"], kiran["id"]]}).json()
    assert client.post(f"{C}/channels/{priv['id']}/members", headers=kiran["headers"], json={"user_ids": [asha["id"]]}).status_code == 403
    assert client.delete(f"{C}/channels/{priv['id']}/members/{kiran['id']}", headers=ravi["headers"]).status_code == 403
    assert client.get(f"{C}/channels/{priv['id']}", headers=asha["headers"]).status_code == 404
    assert client.post(f"{C}/channels/{priv['id']}/join", headers=asha["headers"]).status_code == 404
    assert {m["id"] for m in client.get(f"{C}/channels/{priv['id']}/members", headers=kiran["headers"]).json()} >= {ravi["id"], kiran["id"]}
    assert client.patch(f"{C}/channels/{priv['id']}", headers=kiran["headers"], json={"name": "x"}).status_code == 403
    assert client.patch(f"{C}/channels/{priv['id']}", headers=admin, json={"archived": True}).json()["archived"]
    assert client.post(f"{C}/channels/{priv['id']}/messages", headers=kiran["headers"], data={"body": "late"}).status_code == 403

    # direct messages are reused, private, and notify people who are away
    dm = client.post(f"{C}/dm", headers=asha["headers"], json={"user_ids": [zed["id"]]}).json()
    assert dm["kind"] == "dm" and dm["display_name"] == "Zed Outsider"
    assert client.post(f"{C}/dm", headers=zed["headers"], json={"user_ids": [asha["id"]]}).json()["id"] == dm["id"]
    client.post(f"{C}/channels/{dm['id']}/messages", headers=asha["headers"], data={"body": "psst"})
    assert client.get(f"{C}/channels/{dm['id']}/messages", headers=kiran["headers"]).status_code == 404
    z = next(c for c in client.get(f"{C}/channels", headers=zed["headers"]).json() if c["id"] == dm["id"])
    assert z["unread"] == 1 and z["mentions"] == 1 and z["last_message"]["body"] == "psst"
    assert "sent you a message" in client.get(f"{API}/notifications", headers=zed["headers"]).json()["items"][0]["message"]

    # search only covers conversations you can read
    assert [m["body"] for m in client.get(f"{C}/search", headers=zed["headers"], params={"q": "psst"}).json()] == ["psst"]
    assert client.get(f"{C}/search", headers=kiran["headers"], params={"q": "psst"}).json() == []

    # bad socket token is refused
    import pytest
    from starlette.websockets import WebSocketDisconnect
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(f"{C}/ws?token=nope") as bad:
            bad.receive_json()


def test_chat_calls(client, admin, world):
    asha, kiran, zed = world["asha"], world["kiran"], world["zed"]
    C = f"{API}/chat"
    assert client.get(f"{C}/rtc-config", headers=asha["headers"]).json()["iceServers"][0]["urls"]
    dm = client.post(f"{C}/dm", headers=asha["headers"], json={"user_ids": [kiran["id"]]}).json()

    with client.websocket_connect(f"{C}/ws?token={kiran['headers']['Authorization'][7:]}") as ws:
        assert ws.receive_json()["type"] == "hello"
        call = client.post(f"{C}/channels/{dm['id']}/calls", headers=asha["headers"], json={"video": True}).json()
        assert call["active"] and call["participant_ids"] == [asha["id"]] and call["video"]
        ev = ws.receive_json()
        while ev["type"] != "call.ring":
            ev = ws.receive_json()
        assert ev["from"]["id"] == asha["id"] and ev["call"]["id"] == call["id"]

        # the call shows up in the conversation as a message
        msgs = client.get(f"{C}/channels/{dm['id']}/messages", headers=kiran["headers"]).json()["messages"]
        assert msgs[-1]["call"]["id"] == call["id"]
        # starting again joins the same call; outsiders can't touch it
        assert client.post(f"{C}/calls/{call['id']}/join", headers=zed["headers"]).status_code == 404
        joined = client.post(f"{C}/channels/{dm['id']}/calls", headers=kiran["headers"], json={}).json()
        assert joined["id"] == call["id"] and set(joined["participant_ids"]) == {asha["id"], kiran["id"]} and joined["answered_at"]

        # signalling is relayed only between participants
        with client.websocket_connect(f"{C}/ws?token={asha['headers']['Authorization'][7:]}") as ws2:
            assert ws2.receive_json()["type"] == "hello"
            ws2.send_json({"type": "call.signal", "call_id": call["id"], "to": kiran["id"], "data": {"description": {"type": "offer", "sdp": "v=0"}}})
            ev = ws.receive_json()
            while ev["type"] != "call.signal":
                ev = ws.receive_json()
            assert ev["from"] == asha["id"] and ev["data"]["description"]["type"] == "offer"

        # hanging up a 1:1 call ends it for both and logs the duration
        ended = client.post(f"{C}/calls/{call['id']}/leave", headers=kiran["headers"]).json()
        assert not ended["active"] and ended["duration_seconds"] is not None
    assert client.get(f"{C}/calls/active", headers=asha["headers"]).json() == []

    # a declined 1:1 call ends as missed
    call = client.post(f"{C}/channels/{dm['id']}/calls", headers=asha["headers"], json={}).json()
    out = client.post(f"{C}/calls/{call['id']}/decline", headers=kiran["headers"]).json()
    assert not out["active"] and out["answered_at"] is None
