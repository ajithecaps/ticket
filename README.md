# Developer Ticket System

FastAPI backend for a dev-team ticket tracker: multiple projects, project owners who assign work,
developers who work their queue across projects, and an admin who sees everything plus per-developer
efficiency.

## Roles

| | admin | project owner | developer |
|---|---|---|---|
| See all projects & tickets | ✅ | own projects | own projects |
| Create projects, name owners | ✅ | ❌ | ❌ |
| Create user accounts | ✅ | ❌ | ❌ |
| Add / remove developers | ✅ | ✅ | ❌ |
| Assign & reassign tickets | ✅ | ✅ | ❌ |
| Raise tickets | ✅ | ✅ | ✅ |
| Change status of own tickets | ✅ | ✅ | ✅ (assignee) |
| Comment, @mention, attach | ✅ | ✅ | ✅ |
| Efficiency reports | ✅ | ❌ | ❌ |

There are two role layers: a **global** role (`admin` / `user`) on the account, and a **per-project**
role (`owner` / `developer`) on the membership. The same person can own one project and be a plain
developer on another. An admin is implicitly an owner of every project.

Non-members get **404** rather than 403 for a project or ticket, so the system never leaks that it
exists.

## Run it

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env
python -c "import secrets; print(secrets.token_urlsafe(48))"   # paste into SECRET_KEY
# edit FIRST_ADMIN_EMAIL / FIRST_ADMIN_PASSWORD too

alembic upgrade head        # create / update the database tables
uvicorn app.main:app --reload
```

Web app: <http://localhost:8000/> — sign in with the admin e-mail and password from `.env`.
Swagger UI: <http://localhost:8000/docs> — click **Authorize**, log in with the e-mail as `username`.

Optional demo data (2 projects, 4 people, 7 tickets):

```bash
python seed.py          # --reset to rebuild
```

Tests:

```bash
pip install -r requirements-dev.txt
pytest -q               # 14 end-to-end tests over the real API
```

With Docker (PostgreSQL included):

```bash
cp .env.example .env    # set SECRET_KEY; DATABASE_URL is overridden by compose
docker compose up --build
```

On first start the app creates its tables and, if no admin exists yet, one admin from the
`FIRST_ADMIN_*` values. **Change that password immediately** (`POST /auth/change-password`).

## Configuration (`.env`)

| Key | Default | Notes |
|---|---|---|
| `DATABASE_URL` | `sqlite:///./tickets.db` | `postgresql+psycopg2://user:pass@host:5432/db` in production |
| `SECRET_KEY` | `change-me` | JWT signing key — must be changed |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | `720` | |
| `UPLOAD_DIR` | `uploads` | Use a mounted volume, or swap in S3 (see below) |
| `MAX_UPLOAD_MB` / `MAX_FILES_PER_REQUEST` | `10` / `10` | Enforced while streaming, not after |
| `BLOCKED_EXTENSIONS` | `.exe,.bat,…` | Rejected on upload |
| `CORS_ORIGINS` | `*` | Comma-separated list; credentials are only allowed when it is not `*` |

## API

All routes are under `/api/v1`. Auth is `Authorization: Bearer <jwt>`.

**Auth** `POST /auth/login` · `GET /auth/me` · `POST /auth/change-password`

**Users** (admin) `POST /users` · `GET /users` · `GET|PATCH /users/{id}`
`GET /users/lookup?q=&project_id=` — for assignee pickers and @mention autocomplete; a developer
only ever sees people they share a project with.

**Projects** `POST /projects` (admin) · `GET /projects` · `GET|PATCH /projects/{id}`
`GET|POST /projects/{id}/members` · `PATCH /projects/{id}/members/{user_id}` (admin, promote/demote)
· `DELETE /projects/{id}/members/{user_id}`

**Tickets**
- `POST /projects/{id}/tickets` — raise one (any member; only owners may set `assignee_id` here)
- `GET /tickets` — everything you may see, filterable; `?project_id=` to narrow
- `GET /projects/{id}/tickets` — one project's board
- `GET /tickets/my` — **assigned to me, all projects or one** (`?project_id=`)
- `GET /tickets/my/summary` — my counts grouped by project and status
- `GET /tickets/{id}` · `GET /tickets/by-key/PAY-12`
- `PATCH /tickets/{id}` · `POST /tickets/{id}/assign` · `POST /tickets/{id}/status`
- `DELETE /tickets/{id}` (owners) · `GET /tickets/{id}/activity`
- `GET|POST /tickets/{id}/worklogs` · `DELETE /worklogs/{id}`

Filters on every list: `status`, `priority`, `type` (repeatable), `assignee_id`, `reporter_id`,
`unassigned`, `overdue`, `due_before`, `due_after`, `q` (title/description text, or a key like
`PAY-12`), `sort` (`created_at|updated_at|due_date|priority`), `order`, `limit`, `offset`.

**Comments** `GET|POST /tickets/{id}/comments` · `PATCH|DELETE /comments/{id}`

**Attachments** `POST /tickets/{id}/attachments` (multipart, optional `comment_id`) ·
`GET /tickets/{id}/attachments` · `GET /attachments/{id}/download` · `DELETE /attachments/{id}`

**Notifications** `GET /notifications` · `GET /notifications/unread-count` ·
`POST /notifications/{id}/read` · `POST /notifications/read-all`

**Reports** (admin) `GET /reports/overview` · `GET /reports/efficiency` ·
`GET /reports/efficiency/{user_id}`

### Ticket keys and status flow

Each ticket gets a per-project number, so keys read `PAY-1`, `PAY-2`, `OPS-1`. Statuses are
`todo → in_progress → in_review → done → verified`, plus `blocked`.

**Verification.** Developers move their own tickets up to `done`. A project owner then cross-checks the
work and either moves it to `verified` (closed) or sends it back to an earlier status, which counts as a
reopen. Only owners/admins can set `verified`, only from `done`, and a verified ticket can only be
reopened by an owner. Both `done` and `verified` count as finished for open/overdue counts and the
efficiency report, and verifying keeps the developer's original `completed_at`.

Any other transition is allowed except:

- a ticket with no assignee cannot move to `in_progress`, `in_review` or `done`;
- a `done` or `verified` ticket must be reopened before it can be reassigned.

Moving out of `done` increments `reopen_count` (this is what the first-time-right metric reads).
Reassigning clears `started_at` and sends the ticket back to `todo`, so the new assignee is not
credited with the previous person's work — `reopen_count` is kept as history.

### Mentions

Two ways, both resolved server-side against project membership:

```jsonc
POST /tickets/12/comments
{ "body": "@ravi@example.com please review", "mention_user_ids": [4] }
```

Typing `@someone@example.com` in the body is detected automatically. Mentioning a non-member is a
400; an unknown `@handle` in the text is simply left as plain text. Mentioned users get a `mention`
notification; the assignee and reporter get a plain `comment` one. Nobody is ever notified about
their own action.

### Notification events

`ticket_created` (to owners, when a developer raises one) · `assigned` / `unassigned` ·
`status_changed` (reporter, assignee, and owners for `blocked`/`in_review`/`done`/reopen) ·
`ticket_updated` (priority or due date changed) · `comment` · `mention` · `project_member`.

## Efficiency metrics

`GET /reports/efficiency?from=2026-10-01&to=2026-10-31&project_id=3`

The cohort is every ticket whose **current assignee received it** (`assigned_at`) inside the chosen
period — all time when no dates are given — measured as of now. Dates are UTC days and `to` is
inclusive.

| Metric | Definition |
|---|---|
| `completion_rate` | completed / assigned |
| `on_time_rate` | completed by their due date / completed tickets **that had a due date** |
| `first_time_right_rate` | 1 − (ever-reopened / ever-reached-done) |
| `avg_resolution_hours` | mean(`completed_at` − `assigned_at`) over completed |
| `avg_time_to_start_hours` | mean(`started_at` − `assigned_at`) — pickup latency |
| `estimate_accuracy` | mean per-ticket 1 − \|spent − estimated\| / estimated, clamped 0–1 |
| `efficiency_score` | **40%** completion + **40%** on-time + **20%** first-time-right, ×100 |

A metric that cannot be computed yet is `null`, not `0` — and `efficiency_score` drops those
components and re-normalises the remaining weights, so a developer whose tickets carry no due dates
is judged on completion and quality alone rather than being penalised. Someone with nothing assigned
appears in the list with `assigned: 0` and a `null` score, and sorts to the bottom.

The weights live in `WEIGHTS` at the top of `app/efficiency.py`; the formula is in `score()`.

A caveat worth knowing before you show these numbers to a team: they measure throughput against
estimates and dates that the owners themselves set, so they reward a developer with well-scoped,
generously-dated tickets and penalise one who is handed the gnarly work. Use the per-developer
drill-down (`/reports/efficiency/{user_id}`, which breaks the same figures down per project) rather
than the single score when the answer actually matters.

## Project layout

```
app/
  main.py          app factory, CORS, table creation, first-admin bootstrap
  config.py        settings from .env          database.py   engine & session
  models.py        SQLAlchemy models + enums   schemas.py    Pydantic request/response models
  security.py      bcrypt + JWT                deps.py       auth dependencies
  permissions.py   role and membership rules   services.py   shared business logic
  efficiency.py    the metric calculations
  slack.py         Slack client + mirroring notifications after commit
  jobs.py          overdue alerts, daily summary, scheduler thread
  routers/upcoming.py  upcoming tasks (requirements before tickets)
  routers/releases.py  releases: finished tickets shipped to production
migrations/        Alembic environment and versions (0001 baseline, 0002 upcoming tasks, 0003 releases)
  routers/         auth, users, projects, tickets, comments, attachments, notifications, reports
frontend/          single-page web UI (plain HTML/CSS/JS modules, no build step), served at /
tests/             14 end-to-end tests against the real API
seed.py            demo data
```

## Frontend

`frontend/` is a dependency-free single-page app that FastAPI serves at `/` (assets under `/static`).
There is nothing to install or build: edit a file and reload the page. Routing is hash-based
(`#/projects/3`, `#/tickets/PAY-12`), so deep links work without server rewrites.

| Page | Who | What |
|---|---|---|
| Dashboard | everyone | my open work, blocked/overdue counts, per-project summary; owners see tickets waiting for verification, overdue tickets filterable by person and unassigned tickets; admins see company-wide numbers |
| Tickets | everyone | every visible ticket with search, status/priority/type/assignee/overdue filters and sorting |
| Projects → Board | members | Kanban by status; drag a card to change status |
| Projects → List / Members / Settings | members / owners | filtered list; add, remove, promote members; rename, archive |
| Ticket | members | inline edits (per permission), assign, status, comments with `@` autocomplete, file upload/download, work log, history |
| Notifications | everyone | bell with unread count (polled every 30 s) and a full list |
| People, Reports | admin | user accounts; efficiency table with date/project filters and per-developer drill-down |

Descriptions and comments are Markdown (GFM) with a Write / Preview editor; rendering uses
`frontend/vendor/marked.min.js` and `purify.min.js` (DOMPurify sanitises every rendered note), both
committed so the app works offline.

The JWT is kept in `localStorage`. The UI hides actions the API would refuse, but the API remains
the source of truth for every permission.

## Database migrations

The schema is managed by Alembic; `DATABASE_URL` comes from `.env`.

```bash
alembic upgrade head                                   # apply everything pending
alembic current                                        # which revision this database is on
alembic revision --autogenerate -m "add x to tickets"  # after changing app/models.py - review the file!
alembic check                                          # fails if models and migrations disagree
```

`0001_baseline` creates only the tables that are missing, so databases created before migrations
existed (by the old `create_all()` or `seed.py`) upgrade without a manual `alembic stamp`. The Docker
image runs `alembic upgrade head` before starting uvicorn, and the tests build their database through
the same migrations.

## Upcoming tasks

Planned work per project that is **not a ticket yet** - a place to collect requirements (Markdown),
acceptance criteria (a checklist with a progress meter), reference links and documents.

- **Admins** create, edit, upload documents and delete. **Project members** can read them (non-members
  get 404, like tickets). Statuses: `draft → ready`, or `dropped`.
- Project owners are notified (in-app and Slack) when one is added and when it is marked ready.
- **Convert to ticket** (admin or project owner) creates a normal ticket with the same title and
  priority, the target date as due date, and the requirements, acceptance criteria and references in
  its description; documents are copied as ticket attachments. The upcoming task is marked
  `converted` and links to the ticket.
- UI: **Upcoming** in the sidebar (all projects, grouped) and an **Upcoming** tab on each project.
- API: `GET /upcoming` · `GET|POST /projects/{id}/upcoming` · `GET|PATCH|DELETE /upcoming/{id}` ·
  `POST /upcoming/{id}/documents` · `GET /upcoming-documents/{id}/download` ·
  `DELETE /upcoming-documents/{id}` · `POST /upcoming/{id}/convert`

## Releases

Finished work is grouped per project and shipped to production together.

1. An admin or project owner creates a release (e.g. `v1.4.0`, optional planned date and Markdown notes),
   or uses **🚀 Move to release** on the board's Done / Verified columns.
2. Only `done` / `verified` tickets of the same project can be added. **A ticket in a release leaves the
   board and the default ticket lists** (`in_release=false`); tick *Show released* to see them again.
   Reopening a ticket that is in a planned release takes it back out of the release.
3. **Release to production** locks the release, records who released it and when, marks any ticket
   still in `done` as `verified` (shipping is the owner's acceptance), and notifies the project's
   members in-app plus one Slack message with the tickets grouped as features / improvements / bug fixes.
4. A released ticket cannot be reopened - raise a new ticket for follow-up work. Release notes stay
   editable; the name does not. Released tickets still count in the efficiency report.

API: `GET /releases` · `GET|POST /projects/{id}/releases` · `GET|PATCH|DELETE /releases/{id}` ·
`POST /releases/{id}/tickets` · `DELETE /releases/{id}/tickets/{ticket_id}` · `POST /releases/{id}/release`;
ticket lists accept `release_id=` and `in_release=true|false`.

## Slack

Every in-app notification is also posted to one Slack channel (after the change is saved, from a
background thread, so Slack never slows the API). On top of that:

- **Overdue alerts** - every `OVERDUE_CHECK_MINUTES` (15) the app finds open tickets past their due
  date, notifies the assignee and project owners in-app, and posts one combined Slack message. Each
  ticket is alerted once per due date (recorded as an `overdue_alert` in its history); changing the due
  date and missing it again alerts again.
- **Daily summary** - at `SLACK_DAILY_SUMMARY_TIME` (10:00) in `TIMEZONE` (Asia/Kolkata) on
  `SLACK_DAILY_SUMMARY_DAYS`, a message lists every team member's pending tickets (to do / in progress /
  blocked / in review), their overdue count, and team totals including tickets waiting for verification.
  If the server was down at 10:00 it is still sent when it comes back within two hours, never twice a day.

**Connect a channel**

1. Create a Slack app at <https://api.slack.com/apps> → *From scratch*.
2. Either
   - **Incoming Webhooks** → on → *Add New Webhook* → pick the channel → put the URL in
     `SLACK_WEBHOOK_URL`, or
   - **OAuth & Permissions** → bot scopes `chat:write` and `users:read.email` → install → put the
     `xoxb-…` token in `SLACK_BOT_TOKEN` and the channel ID in `SLACK_CHANNEL`, then `/invite` the app
     into the channel. With a bot, people whose Slack e-mail matches their ticket-system e-mail are
     real @mentions; with a webhook they appear as bold names.
3. Set `APP_BASE_URL` to the address people open the app at, restart, and use **Slack** in the admin
   menu to send a test message, preview or send the summary, or run the overdue check.

All settings are in `.env.example`. The jobs run in one process per host (a file lock in `UPLOAD_DIR`
picks it); if you run the API on several hosts, set `SCHEDULER_ENABLED=false` on all but one.

## Notes before production

- **Migrations** are Alembic (`migrations/versions/`). Run `alembic upgrade head` before starting the
  API - the Docker image does this on every start. The app itself never creates tables.
- **Files.** Attachments are stored on local disk under `UPLOAD_DIR/<ticket_id>/` with randomised
  names, served only through the authenticated download endpoint. For more than one API instance,
  use a shared volume or replace the two helpers in `app/services.py` (`ticket_upload_dir`,
  `remove_file`) plus `_save_upload` in `routers/attachments.py` with S3.
- **Tokens** are stateless, so logout is client-side; deactivating a user does invalidate their
  tokens immediately. Add a refresh-token table if you need revocation.
- **Rate limiting** is not included — put `slowapi` or your gateway in front of `/auth/login`.
- **Notifications** are in-table only. The `notify()` helper in `app/services.py` is the single
  place to hook e-mail (SES) or push.
- PostgreSQL is recommended: `next_ticket_number()` takes a row lock (`SELECT … FOR UPDATE`) so two
  people raising tickets at the same moment cannot collide. SQLite serialises writes anyway.
