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
  routers/timeline.py  timeline (gantt) and overlap check; schedule.py has the window logic
migrations/        Alembic environment and versions (0001 baseline … 0006 sprints)
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

## Ticket list and themes

The Tickets page and each project's **List** tab share one table: filters bound to the URL (search,
priority, type, assignee, status chips, overdue, show released), **sortable column headers** (key, title,
status, priority, assignee, start, due, created, updated), a **column picker** (project, type, reporter,
start, time logged vs estimate, release, created…), comfortable/compact density, 25/50/100 rows,
**group by** status / priority / assignee / project / type, **row selection with bulk actions** (status,
priority, assignee, delete - each ticket keeps its normal permission checks), click a status badge to
change it in place, **saved views** and **CSV export** of everything that matches. Layout and saved views
are remembered per browser. API sort keys: `created_at, updated_at, due_date, start_date, priority,
status, title, key, assignee` with `order=asc|desc`.

**Needs attention** (sidebar, with live counts): **To verify** - tickets marked done and waiting for an
owner's check; **Overdue** - open tickets past their due date, grouped by assignee; **Unassigned** - open
tickets nobody has. Each is the full ticket table with that filter fixed. To verify and Unassigned are for
project owners and admins (scoped with `GET /tickets?owned=true`); Overdue is for everyone.

**Navigation & shortcuts:** the sidebar groups Work / Plan & ship / Admin and collapses to icons; the
command palette (**⌘K / Ctrl+K**, or **/**) finds tickets, docs, projects and people and runs actions.
Shortcuts: **C** new ticket, **G** then **D/T/P/L/O/R/U/N** to jump, **?** for the list.
UI building blocks live in `frontend/js/icons.js` (line icons), `palette.js`, `theme.js`, `ui.js`; the type
face is Inter, bundled in `frontend/vendor/inter/`.

**Theme:** the ☀️ / 🌙 / 🖥 button in the top bar (or the account menu) switches Light / Dark / System;
the choice is stored per browser and applied before the page paints.

## Documentation

Every project has **Docs**: Markdown pages that nest into a tree (sidebar **Docs**, or the project's
**Docs** tab). Pages show breadcrumbs, a table of contents and their sub-pages; search covers titles and
content. Any project member can create and edit pages (wiki-style); project owners and admins can delete
them (sub-pages move up a level). **Every save keeps the previous version** - *History* shows each one
and can restore it. API: `GET /docs?project_id=&q=` · `POST /projects/{id}/docs` · `GET|PATCH|DELETE /docs/{id}` ·
`GET /docs/{id}/revisions` · `GET /docs/{id}/revisions/{rev}` · `POST /docs/{id}/revisions/{rev}/restore`.

## Markdown

Descriptions, comments, docs, requirements and release notes all use the same Markdown, rendered by
[frontend/js/markdown.js](frontend/js/markdown.js): GitHub-flavoured Markdown (tables, task lists,
strikethrough, autolinks) plus footnotes, `==highlight==`, `$math$` / `$$math$$` (KaTeX), ```` ```mermaid ````
diagrams, syntax-highlighted code with a copy button, `> [!NOTE]` / `[!TIP]` / `[!WARNING]` /
`[!IMPORTANT]` / `[!CAUTION]` callouts, `<details>` sections, `:emoji:` shortcodes, heading anchors, and
ticket keys (`PAY-12`) as links. Checklists in ticket descriptions, docs and upcoming tasks can be ticked
straight from the page. Output is sanitised with DOMPurify. The editor has Write / Split / Preview, full
screen, a `/` insert menu, list continuation, Tab indenting and Ctrl/⌘ shortcuts.
highlight.js, KaTeX and Mermaid live in `frontend/vendor/` and load only when a note uses them.

## Dashboard

`GET /dashboard?days=7|30|90&project_id=` returns everything the dashboard shows in one call: KPI tiles
(open, in progress, overdue, due in 7 days, completed and created with the change vs the previous period,
average cycle time, awaiting verification), a created-vs-completed trend, open work by status and priority,
team workload per person (open tickets by status, overdue, hours left), tickets due this week, upcoming
releases and recent activity. Scope: admin - everything; project owners - their projects and team;
developers - their projects and their own workload.

## Timeline and overlap checks

Tickets have an optional **start date** next to the due date (both set by project owners); the start
date may not be after the due date. A ticket's planned window is *start date → due date*; without a start
date it runs from when work started / it was assigned / it was created. Tickets without a due date are
"unscheduled" and never clash.

- **Overlap check when assigning** - picking an assignee (new ticket, the ticket sidebar, "Assign to me",
  converting an upcoming task) looks up that person's other open tickets in the same days and shows them;
  in the sidebar it asks *Assign anyway / Pick someone else*. Clashes in projects the caller cannot see are
  counted but not shown. The ticket page also warns when its current assignee is double-booked.
- **Timeline** (sidebar, and a tab on each project) - a Gantt chart: a task list (key, title, start, due,
  days) next to one bar per ticket, grouped by person or by project in collapsible groups. Day / Week /
  Month zoom with a two-level calendar header, weekends shaded, a today line, and releases shown as ◆
  milestones. Bars fill with progress (status, or time spent vs. estimate); overlapping tickets are outlined
  red and each group has a workload heat strip (1 / 2 / 3+ tickets a day). Hover a bar for details.
  **Project owners and admins can drag a bar to move it, or drag either end to change the start or due
  date** - saved immediately, overlaps are recalculated.
  Scope: **admin** - everyone; **project owner** - the people and tickets of the projects they own (plus
  their own work); **developer** - their own tickets. Released tickets are left out; *Show finished*
  adds done / verified ones.

API: `GET /timeline?start=&end=&project_id=&user_id=&include_done=` ·
`GET /timeline/overlaps?user_id=&start=&end=&exclude_ticket_id=`

## Sprints

Each project can plan its work in **sprints** (project tab **Sprints**). Owners create a sprint (name,
dates - 1/2/3-week presets - and a goal), plan tickets into it from the **backlog** by selecting rows
or dragging them between sections, and **start** it - one active sprint per project. **Completing**
it records the result and moves unfinished tickets to the backlog or to a planned sprint. Members
are notified when a sprint starts or completes (in-app and Slack).

Sprint time is visible everywhere: the active sprint card (dates, days left, progress, hours, time
used, burndown), the board (defaults to the active sprint, with a banner; switch to all tickets,
backlog or a planned sprint), the ticket sidebar (owners change the sprint there), a Sprint column and
filter in ticket lists, and an **Active sprints** card on the dashboard. Days are counted in `TIMEZONE`.

API: `GET|POST /projects/{id}/sprints` · `GET /sprints/active` · `GET|PATCH|DELETE /sprints/{id}` ·
`POST /sprints/{id}/start` · `POST /sprints/{id}/complete` (`move_open_to`) · `GET /sprints/{id}/burndown` ·
`POST /projects/{id}/sprint-moves` (`ticket_ids`, `sprint_id` or null for backlog); tickets accept
`sprint_id` on create/update and lists filter by `sprint_id`, `backlog=true`, `active_sprint=true`.

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

Admins can also do all of this from **Slack** in the admin menu without touching `.env`: switch it on
or off, paste the webhook or bot token (stored encrypted, shown masked), pick the channel, choose which
events to send, and set the summary time, days and time zone. Values saved there override `.env`;
*Reset to .env* removes them. Changes reach every worker within 15 seconds.

All settings are in `.env.example`. The jobs run in one process per host (a file lock in `UPLOAD_DIR`
picks it); if you run the API on several hosts, set `SCHEDULER_ENABLED=false` on all but one.

## Team chat and calls

**Chat** in the sidebar (`G M`) is real-time team chat:

- **Conversations** - every project gets a channel its members see automatically. Only admins create
  projects and public or private channels, and only admins add or remove channel members; everyone
  can join public channels and start direct messages (1:1 or up to 8 people).
- **Messages** - Markdown, `@mentions` (`@channel` / `@here` for everyone), emoji picker and
  `:shortcode:` autocomplete, threads, reactions, edit (↑ edits your last message), delete, pin, copy
  link, "mark unread from here", files and images by picking, dragging or pasting, and search.
- **Code** - the *Code snippet* button opens an editor with language detection and Tab indenting.
  Pasting something that looks like code offers to format it as a code block. Every code block has
  syntax highlighting and a **Copy** button; long ones fold.
- **Live** - typing indicators, online dots, unread and mention badges (sidebar and nav), a "New"
  divider, jump to latest, desktop notifications for DMs and mentions, and an Inbox notification
  when someone mentions you, replies to your message, or messages you while you're away.
- **Fun** - emoji sent on their own are shown big and animated (laughing shakes, hearts beat, rockets
  launch …), 🎉 🚀 ❤️ 🔥 etc. set off a shower of emoji across the conversation, and reactions pop.
- **Sounds** - a soft ping for new messages, a brighter chime for DMs and mentions, a ringtone for
  incoming calls and a ringback while you're calling. All of them can be switched off per person from
  the ⚙ menu in the chat sidebar (along with the animations).

**My space** (top of the chat sidebar) is just for you:

- **Notes to self** - a private conversation with only you in it. Jot notes, paste links, drop
  documents, pin what matters; its **Links**, **Files** and **Pinned** panels (top right) list them.
- **Saved items** - press the bookmark on any message in any conversation (or ⋯ › *Save for later*).
  Saved items can be filtered to links or files and searched; each opens back in its conversation.
- Every conversation also has a **Links** panel listing every link shared in it.

**File preview** - attachments on tickets, documents on upcoming tasks and files in chat open in a
previewer: images (zoom), PDF, video and audio, Word (.docx), Excel/ODS/CSV (with sheet tabs),
Markdown and code or text files with highlighting, line numbers and Copy. ← → move between the
files, Esc closes. Other types show a download card. Files are fetched with the viewer's own login;
HTML and SVG are never opened as pages.

**Audio and video calls** - the 📞 / 🎥 buttons in any conversation ring the other person (DM) or
everyone in the channel (group call, up to `CHAT_MAX_CALL_PEOPLE` = 8). People answer with audio or
video, or join later from the call card in the conversation. **Add people** in the call window rings
more people straight away - also people outside the conversation, so a 1:1 call can become a group
call (they can join the call, not read the DM). **React** sends animated emoji (👍 ❤️ 😂 🎉 👏 🔥 🚀 …)
that float up from your tile for everyone, party ones shower the whole screen, and **Raise hand**
puts a ✋ on your tile and tells the others. In a call: mute (Ctrl+D), camera
(Ctrl+E), screen sharing (tuned for sharp text), grid or spotlight layout (double-click a tile),
full screen, a minimised draggable window that keeps going while you use the rest of the app, live
speaking highlights, connection-quality bars and a settings panel for microphone, camera and speaker,
video quality (360p / 720p / 1080p) and noise suppression. The call log (missed / duration) stays in
the conversation.

Calls are peer-to-peer WebRTC: the server only relays the connection setup over the chat WebSocket,
so it adds no load for audio or video. Two things matter in production:

1. **HTTPS is required.** Browsers only allow the microphone and camera on `https://` (or
   `localhost`). Chat works over plain http on a LAN, calls do not.
2. **Add a TURN server for people behind strict firewalls or on mobile data.** STUN (Google's public
   servers by default, `CHAT_STUN_URLS`) is enough on most office and home networks. For the rest,
   run [coturn](https://github.com/coturn/coturn) and set `CHAT_TURN_URL` (e.g.
   `turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349`), `CHAT_TURN_USERNAME`
   and `CHAT_TURN_CREDENTIAL`.

How the real-time part works: each change is written to a `chat_events` table in the same transaction,
and every API worker tails that table and pushes new rows to its WebSockets. Several workers (or
hosts) stay in sync through the database alone, without Redis. If you put a proxy in front, it must
pass WebSocket upgrades for `/api/v1/chat/ws` (nginx: `proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";`).


**Weak connections.** Calls measure each connection every 2 seconds (packet loss, delay, bandwidth). Video then steps down smoothly: lower resolution and frame rate first, then lower bitrate. On a very bad line it pauses so the voice stays clear, and it comes back by itself once the line recovers. Both sides see a "weak connection" indicator. Voice carries redundant packets (RED), plus Opus FEC, and sends nothing during silence (DTX). In group calls your upload is shared fairly between everyone. For people behind strict office or mobile networks, add a TURN server that also listens on TCP/TLS port 443, for example `CHAT_TURN_URL=turn:turn.example.com:3478,turns:turn.example.com:443?transport=tcp`.

**Ringtones.** Chat settings › Call ringtone offers Aurora (default), Sunrise, Breeze, Classic phone, or Silent, each with a preview. They are synthesised in the browser (no audio files) and start softly, growing a little louder until you answer.
## Desktop app

People can install Tickets as a desktop app for **macOS, Windows and Linux**. After signing in on the web, they open
**account menu › Get the desktop app** (or `#/desktop`). The page picks the right installer for their computer, including Apple silicon vs Intel. Download links only work for signed-in people and expire after 10 minutes.

What the app adds over a browser tab:
- **Badges and attention:** unread and mention counts on the dock or taskbar. The dock bounces or the taskbar flashes for mentions and DMs, and keeps going for incoming calls.
- **Stays running:** closing the window keeps it in the macOS dock or the Windows tray, so messages and calls still arrive.
- **Notifications and media:** native notifications that bring the window back when clicked. Microphone and camera prompts work properly, and there is a screen-share picker for a whole screen or a single window.
- **Updates:** a notification when a newer version is published on the server, and **Check for updates** in the menu.
- **Locked to your server:** it only loads your server. Other links open in the normal browser, and pages get no Node or file-system access.

The app is a thin [Electron](https://www.electronjs.org/) shell (`desktop/`) around the web app. Every web deploy shows up in it straight away; you only rebuild the installers to change the shell itself.

**Build the installers** (Node 20+):

```bash
cd desktop
npm install
TICKETS_SERVER_URL=https://tickets.example.com npm run dist:mac    # .dmg for Apple silicon + Intel
TICKETS_SERVER_URL=https://tickets.example.com npm run dist:win    # Windows setup .exe (works from a Mac too)
TICKETS_SERVER_URL=https://tickets.example.com npm run dist:linux  # .AppImage + .deb (.deb needs Linux)
```

`TICKETS_SERVER_URL` is baked in, so the app opens straight on your login page. Without it, the app asks for the address on first launch; it can be changed later from **menu › Change server…**.

The simplest route is the **Desktop app** GitHub workflow (Actions › Desktop app › Run workflow). It builds all three platforms; you then download the artifacts.

**Publish them:** copy the files from `desktop/dist/` (`Tickets-<version>-*.dmg / .exe / .AppImage / .deb`) into `desktop-builds/` next to `docker-compose.yml`. That folder is mounted into the container (`DESKTOP_DIR`). The page offers the newest version found there and needs no restart. To release an update, bump `"version"` in `desktop/package.json`, rebuild and copy the new files in. Running apps will announce it.

**Signing:** builds are unsigned unless you add certificates, so people see a one-time warning.
- macOS: right-click the app › Open (the Mac build is ad-hoc signed, so it never says "damaged").
- Windows: SmartScreen › More info › Run anyway.
- To remove the warnings, add an Apple Developer ID and/or a Windows code-signing certificate as `CSC_LINK` / `CSC_KEY_PASSWORD` secrets (plus `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` for notarisation). The workflow uses them automatically.

Calls in the app need the server on **HTTPS**, the same as in a browser.

## Daily challenge

Sidebar › **Daily challenge** (or `G C`) has one puzzle a day, the same for everyone. The fastest time wins. Four kinds rotate day by day:

| Puzzle | How it works | Penalty |
|---|---|---|
| Pair Match | Flip cards to find 10 pairs of dev icons | +1 s per miss |
| Slide | Order the tiles 1–8 (click or arrow keys) | none |
| Dev Words | Unscramble 5 developer words | +20 s per skipped word |
| Math Sprint | 10 sums, getting harder | +5 s per wrong answer |

- **One try a day:** you get one attempt, with a 15-minute limit. The new puzzle arrives at midnight in `TIMEZONE`.
- **Fair play:** the server keeps the clock and checks every move. Cards are revealed one flip at a time, word and math answers never reach the browser, and slide moves are replayed on the server. A result can't be typed in from the browser console.
- **Leaderboards:**
  - **Today** ranks by time plus penalties. It also shows who is playing right now and is refreshed every 15 seconds.
  - **This week / This month / All time** add up points. Daily places 1–7 earn 10, 8, 6, 5, 4, 3 and 2 points, and anyone else who solves the puzzle gets 1. Ties are broken by wins.
  - 🔥 **streaks** count days in a row solved.
- **Reminder:** a dot on the sidebar item shows until you've played today.

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
