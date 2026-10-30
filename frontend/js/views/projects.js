import { api, auth } from "../api.js";
import { icon } from "../icons.js";
import { navigate } from "../app.js";
import {
  CLOSED, STATUSES, avatar, busy, clear, confirmDialog, emptyState, errorBox, field, fmtDate, formData, h, label,
  modal, priorityBadge, select, spinner, timeAgo, toast, typeBadge, userPicker, avatarStack,
} from "../ui.js";
import { cheerIfMine } from "./coach.js";
import { filteredTicketList } from "./ticketlist.js";
import { newTicketDialog } from "./ticket.js";
import { renderProjectUpcoming } from "./upcoming.js";
import { addToReleaseDialog, renderProjectReleases } from "./releases.js";
import { renderTimeline } from "./timeline.js";
import { renderDocsHome } from "./docs.js";
import { daysLeftPill, renderProjectSprints, sprintRange } from "./sprints.js";
import { currentQuery } from "../app.js";

const isAdmin = () => auth.user.role === "admin";

// ----------------------------------------------------------------------------- list
export async function renderProjects(main) {
  let includeArchived = false;
  const grid = h("div.project-grid");

  async function load() {
    clear(grid, spinner());
    const projects = await api.get("/projects", { include_archived: includeArchived || undefined });
    clear(grid, projects.length
      ? projects.map(projectCard)
      : emptyState("No projects yet", isAdmin() ? "Create the first project and name its owner." : "You haven't been added to a project yet."));
  }

  clear(main,
    h("div.page-head",
      h("h1", "Projects"),
      h("div.actions",
        isAdmin() && h("label.check", h("input", { type: "checkbox", onchange: (e) => { includeArchived = e.target.checked; load(); } }), "Show archived"),
        isAdmin() && h("button.btn.primary", { onclick: () => createProjectDialog() }, "New project"))),
    grid);
  await load();
}

function projectCard(p) {
  return h(`a.card.project-card${p.is_active ? "" : ".archived"}`, { href: `#/projects/${p.id}` },
    h("div.row", h("span.key-pill", p.key), h("strong", p.name), !p.is_active && h("span.badge", "Archived")),
    p.description && h("p.muted.clamp", p.description),
    h("div.project-meta",
      h("span", h("strong", String(p.open_ticket_count)), " open"),
      h("span", h("strong", String(p.ticket_count)), " total"),
      h("span", h("strong", String(p.member_count)), " members")),
    h("div.row.between",
      h("div.avatars", p.owners.slice(0, 4).map((o) => avatar(o, "sm"))),
      p.my_role && h("span.muted.small", label(p.my_role))));
}

function createProjectDialog() {
  const owners = new Map();
  const ownerList = h("div.tags");
  const renderOwners = () => clear(ownerList, [...owners.values()].map((u) =>
    h("span.tag", u.name, h("button", { type: "button", "aria-label": `Remove ${u.name}`, onclick: () => { owners.delete(u.id); renderOwners(); } }, "×"))));

  const form = h("form.form",
    h("div.grid-2.tight",
      field("Name", h("input", { name: "name", required: true, minLength: 2, maxLength: 150 })),
      field("Key", h("input", { name: "key", required: true, pattern: "[A-Za-z][A-Za-z0-9]{1,9}", maxLength: 10, placeholder: "PAY", style: { textTransform: "uppercase" } }), "Ticket prefix, e.g. PAY → PAY-12")),
    field("Description", h("textarea", { name: "description", rows: 3, maxLength: 5000 })),
    field("Owners", h("div",
      userPicker((q) => api.get("/users/lookup", { q, limit: 10 }), (u) => { if (u) { owners.set(u.id, u); renderOwners(); } }, { placeholder: "Add an owner…" }),
      ownerList), "Owners manage members and assign tickets."),
    h("div.form-actions", h("button.btn.primary", { type: "submit" }, "Create project")));

  const m = modal("New project", form);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!owners.size) return toast("Pick at least one owner", "error");
    const data = formData(form);
    busy(form.querySelector("[type=submit]"), async () => {
      const p = await api.post("/projects", { ...data, key: data.key.toUpperCase(), owner_ids: [...owners.keys()] });
      m.close();
      toast(`Project ${p.key} created`);
      navigate(`/projects/${p.id}`);
    });
  });
}

// ----------------------------------------------------------------------------- one project
export async function renderProject(main, id, tab) {
  const [project, members] = await Promise.all([api.get(`/projects/${id}`), api.get(`/projects/${id}/members`)]);
  const owner = project.my_role === "owner" || project.my_role === "admin";

  const tabs = [["board", "Board"], ["list", "List"], ["sprints", "Sprints"], ["timeline", "Timeline"], ["docs", "Docs"], ["upcoming", "Upcoming"], ["releases", "Releases"], ["members", `Members (${members.length})`]];
  if (owner) tabs.push(["settings", "Settings"]);

  const body = h("div.tab-body");
  clear(main,
    h("div.page-head",
      h("div",
        h("div.crumbs", h("a", { href: "#/projects" }, "Projects"), " / ", project.key),
        h("h1", project.name, !project.is_active && h("span.badge", "Archived")),
        project.description && h("p.muted", project.description)),
      h("div.actions",
        project.is_active && h("button.btn.primary", { onclick: () => newTicketDialog([project], project.id, { members, owner }) }, "New ticket"))),
    h("nav.tabs", { "aria-label": "Project sections" }, tabs.map(([key, text]) =>
      h(`a${key === tab ? ".active" : ""}`, { href: `#/projects/${id}${key === "board" ? "" : "/" + key}`, "aria-current": key === tab ? "page" : null }, text))),
    body);

  if (tab === "board") await renderBoard(body, project, owner);
  else if (tab === "list") {
    const sprints = await api.get(`/projects/${id}/sprints`).catch(() => []);
    clear(body, filteredTicketList({
      endpoint: `/projects/${id}/tickets`,
      showProject: false,
      assignees: members.map((m) => [String(m.user.id), m.user.name]),
      sprints,
    }));
  } else if (tab === "sprints") await renderProjectSprints(body, project, { owner });
  else if (tab === "timeline") await renderTimeline(body, { projectId: project.id });
  else if (tab === "docs") await renderDocsHome(body, { projectId: project.id });
  else if (tab === "upcoming") await renderProjectUpcoming(body, project);
  else if (tab === "releases") await renderProjectReleases(body, project);
  else if (tab === "members") renderMembers(body, project, members, owner);
  else if (tab === "settings" && owner) renderSettings(body, project);
}

async function renderBoard(body, project, owner) {
  const board = h("div.board");
  const toolbar = h("div.board-toolbar");
  const sprintBanner = h("div");
  clear(body, toolbar, sprintBanner, board);

  // Sprint scope: defaults to the active sprint when there is one.
  const sprints = (await api.get(`/projects/${project.id}/sprints`)).filter((s) => s.status !== "completed");
  const activeSprint = sprints.find((s) => s.status === "active");
  const wanted = currentQuery().get("sprint");
  let sprintScope = wanted || (activeSprint ? "active" : "all");
  const scopeParams = () => (sprintScope === "all" ? {} : sprintScope === "backlog" ? { backlog: true }
    : sprintScope === "active" ? (activeSprint ? { sprint_id: activeSprint.id } : {}) : { sprint_id: Number(sprintScope) });
  const scopedSprint = () => (sprintScope === "active" ? activeSprint : sprints.find((s) => String(s.id) === sprintScope));
  function drawBanner() {
    const s = scopedSprint();
    if (!s) { clear(sprintBanner); return; }
    const pct = s.ticket_count ? Math.round((s.done_count / s.ticket_count) * 100) : 0;
    clear(sprintBanner, h("div.sprint-banner",
      h("div.row.wrap", h(`span.sprint-status.${s.status}`, h("i"), s.status === "active" ? "Active sprint" : "Planned"),
        h("strong", s.name), h("span.muted.small", sprintRange(s)), daysLeftPill(s)),
      s.goal && h("span.muted.small.ellipsis.sprint-banner-goal", s.goal),
      h("div.row.sprint-banner-progress", h("div.sp-bar.small", h("i.done", { style: { width: `${pct}%` } })), h("span.small", `${s.done_count}/${s.ticket_count} done`),
        h("a.small", { href: `#/projects/${project.id}/sprints` }, "Sprint plan"))));
  }

  const PRIORITY_RANK = { critical: 4, high: 3, medium: 2, low: 1 };
  const filter = { q: "", person: "", mine: false, priority: "" };
  let tickets = [];
  let totals = {};
  let dragging = null;

  async function load() {
    if (!tickets.length) clear(board, spinner());
    try {
      // One page per status; finished columns only need the most recent ones.
      const pages = await Promise.all(STATUSES.map((s) => api.get(`/projects/${project.id}/tickets`, {
        status: s, sort: CLOSED.includes(s) ? "updated_at" : "priority", limit: CLOSED.includes(s) ? 30 : 200,
        in_release: false, // tickets moved into a release leave the board
        ...scopeParams(),
      })));
      drawBanner();
      tickets = pages.flatMap((p) => p.items);
      totals = Object.fromEntries(STATUSES.map((s, i) => [s, pages[i].total]));
      drawToolbar();
      draw();
    } catch (err) { clear(board, errorBox(err)); }
  }

  const matches = (t) => {
    if (filter.mine && !t.assignees.some((u) => u.id === auth.user.id)) return false;
    if (filter.person === "none" ? t.assignees.length : filter.person && !t.assignees.some((u) => String(u.id) === filter.person)) return false;
    if (filter.priority && t.priority !== filter.priority) return false;
    if (filter.q) {
      const q = filter.q.toLowerCase();
      if (!t.key.toLowerCase().includes(q) && !t.title.toLowerCase().includes(q)) return false;
    }
    return true;
  };
  const filtering = () => Boolean(filter.q || filter.person || filter.mine || filter.priority);

  // ------------------------------------------------------------- toolbar
  let searchTimer;
  const search = h("input.board-search", {
    type: "search", placeholder: "Filter cards…", "aria-label": "Filter cards",
    oninput: (e) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { filter.q = e.target.value.trim(); draw(); }, 120); },
  });
  function drawToolbar() {
    const people = new Map();
    tickets.forEach((t) => t.assignees.forEach((u) => people.set(u.id, u)));
    const unassigned = tickets.some((t) => !t.assignees.length);
    const personBtn = (key, content, title) => h("button.person-filter", {
      type: "button", title, "aria-pressed": String(filter.person === key),
      onclick: () => { filter.person = filter.person === key ? "" : key; drawToolbar(); draw(); },
    }, content);
    clear(toolbar,
      sprints.length > 0 && select("sprint", [
        ...(activeSprint ? [["active", `Active: ${activeSprint.name}`]] : []),
        ["all", "All tickets"], ["backlog", "Backlog"],
        ...sprints.filter((x) => x.status === "planned").map((x) => [String(x.id), x.name]),
      ], sprintScope, { "aria-label": "Sprint", onchange: (e) => { sprintScope = e.target.value; tickets = []; load(); } }),
      search,
      h("div.person-filters", { role: "group", "aria-label": "Filter by assignee" },
        [...people.values()].sort((a, b) => a.name.localeCompare(b.name)).map((u) => personBtn(String(u.id), avatar(u, "sm"), u.name)),
        unassigned && personBtn("none", avatar(null, "sm"), "Unassigned")),
      select("priority", [["", "Any priority"], ["critical", "Critical"], ["high", "High"], ["medium", "Medium"], ["low", "Low"]], filter.priority,
        { "aria-label": "Priority", onchange: (e) => { filter.priority = e.target.value; draw(); } }),
      h("label.check", h("input", { type: "checkbox", checked: filter.mine, onchange: (e) => { filter.mine = e.target.checked; draw(); } }), "Only mine"),
      filtering() && h("button.btn.sm.ghost", { onclick: () => { Object.assign(filter, { q: "", person: "", mine: false, priority: "" }); search.value = ""; drawToolbar(); draw(); } }, "Clear"),
      h("span.board-hint.muted.small", owner ? "Drag cards between columns. Verify finished work, then ship it in a release." : "Drag cards between columns. Done goes to the owner for verification."));
  }

  // ------------------------------------------------------------- columns
  function draw() {
    const shown = tickets.filter(matches);
    clear(board, STATUSES.map((s) => {
      const items = shown.filter((t) => t.status === s)
        .sort((a, b) => CLOSED.includes(s) ? 0 : (PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority]) || dueOf(a) - dueOf(b));
      const all = tickets.filter((t) => t.status === s);
      const count = filtering() ? `${items.length}/${totals[s]}` : String(totals[s]);
      const hidden = totals[s] - all.length;

      const col = h(`section.column.col-${s}`, { dataset: { status: s }, "aria-label": label(s) },
        h("header.col-head",
          h(`i.status-dot.status-${s}`), h("span.col-name", label(s)), h("span.col-count", count),
          owner && CLOSED.includes(s) && all.length > 0 && h("button.icon-btn.col-release", {
            title: "Move these finished tickets into a release", "aria-label": "Move to release",
            onclick: () => addToReleaseDialog(project.id, { preselect: all.map((t) => t.id), onDone: () => load() }),
          }, icon("rocket", { size: 15 }))),
        h("div.col-body",
          items.map(card),
          !items.length && h("div.col-empty", filtering() ? "No matching cards" : s === "todo" ? "Nothing to do" : "Drop cards here"),
          hidden > 0 && !filtering() && h("a.col-more", { href: `#/projects/${project.id}/list?status=${s}` }, `+${hidden} more in the list`),
          s === "todo" && project.is_active && h("button.col-add", {
            type: "button", onclick: () => newTicketDialog([project], project.id, { owner }),
          }, "+ New ticket")));

      col.addEventListener("dragover", (e) => { if (dragging) { e.preventDefault(); col.classList.add("drop"); } });
      col.addEventListener("dragleave", (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove("drop"); });
      col.addEventListener("drop", (e) => {
        e.preventDefault();
        col.classList.remove("drop");
        const t = tickets.find((x) => String(x.id) === e.dataTransfer.getData("text/plain"));
        if (t && t.status !== s) move(t, s);
      });
      return col;
    }));
  }

  const dueOf = (t) => (t.due_date ? new Date(t.due_date).getTime() : Infinity);

  async function move(t, status) {
    const prev = t.status;
    t.status = status;
    totals[prev] -= 1;
    totals[status] += 1;
    draw();
    try {
      await api.post(`/tickets/${t.id}/status`, { status });
      toast(`${t.key} → ${label(status)}`);
      cheerIfMine(t, status);
    } catch (err) {
      t.status = prev;
      toast(err.message, "error");
    }
    load();
  }

  // ------------------------------------------------------------- card
  function dueChip(t) {
    if (!t.due_date) return null;
    const due = new Date(t.due_date);
    const days = Math.ceil((due - Date.now()) / 86400000);
    const finished = CLOSED.includes(t.status);
    const tone = finished ? "" : t.is_overdue ? ".overdue" : days <= 2 ? ".soon" : "";
    const text = finished ? fmtShort(due) : t.is_overdue ? `${fmtShort(due)} · ${-days || 1}d late` : days <= 1 ? (days <= 0 ? "Due today" : "Due tomorrow") : fmtShort(due);
    return h(`span.chip-due${tone}`, { title: `Due ${fmtDate(t.due_date)}` }, icon("calendar", { size: 12 }), " ", text);
  }
  const fmtShort = (d) => d.toLocaleDateString(undefined, { day: "numeric", month: "short" });

  function card(t) {
    const pct = t.estimated_hours ? Math.min(100, Math.round(((t.spent_hours || 0) / t.estimated_hours) * 100)) : null;
    const el = h(`a.ticket-card.prio-edge-${t.priority}`, {
      href: `#/tickets/${t.key}`, draggable: "true", title: t.title,
      ondragstart: (e) => {
        dragging = t;
        e.dataTransfer.setData("text/plain", String(t.id));
        e.dataTransfer.effectAllowed = "move";
        requestAnimationFrame(() => el.classList.add("is-dragging"));
      },
      ondragend: () => { dragging = null; el.classList.remove("is-dragging"); document.querySelectorAll(".column.drop").forEach((c) => c.classList.remove("drop")); },
    },
    h("div.tc-top",
      h("span.key", t.key),
      typeBadge(t.type),
      t.reopen_count > 0 && h("span.tc-flag", { title: `Reopened ${t.reopen_count}×` }, `↺${t.reopen_count}`),
      h("span.tc-prio", priorityBadge(t.priority))),
    h("p.tc-title", t.title),
    h("div.tc-foot",
      h("div.tc-meta",
        dueChip(t),
        pct !== null && h("span.tc-time", { title: `${t.spent_hours || 0}h logged of ${t.estimated_hours}h estimated` },
          h("span.tc-bar", h("i", { class: pct >= 100 ? "over" : "", style: { width: `${pct}%` } })),
          `${Math.round((t.spent_hours || 0) * 10) / 10}/${t.estimated_hours}h`)),
      avatarStack(t.assignees, "sm")));
    return el;
  }

  await load();
}

function renderMembers(body, project, members, owner) {
  const list = h("div.card.flush");

  function draw() {
    clear(list, h("div.table-wrap", h("table.table",
      h("thead", h("tr", h("th", "Person"), h("th", "Role"), h("th.hide-sm", "Joined"), owner && h("th"))),
      h("tbody", members.map((m) => h("tr",
        h("td", h("a.user-chip", { href: `#/people/${m.user.id}` }, avatar(m.user, "sm"), h("div", h("div", m.user.name), h("div.muted.small", m.user.email)))),
        h("td", isAdmin()
          ? select("role", ["owner", "developer"], m.role, { "aria-label": `Role of ${m.user.name}`, onchange: (e) => changeRole(m, e.target) })
          : h(`span.badge${m.role === "owner" ? ".accent" : ""}`, label(m.role))),
        h("td.hide-sm.muted", fmtDate(m.joined_at)),
        owner && h("td.right", (m.role !== "owner" || isAdmin()) &&
          h("button.btn.sm.ghost.danger", { onclick: (e) => remove(m, e.currentTarget) }, "Remove"))))),
    )));
  }

  async function changeRole(m, sel) {
    await busy(sel, async () => {
      const updated = await api.patch(`/projects/${project.id}/members/${m.user.id}`, { role: sel.value });
      Object.assign(m, updated);
      toast(`${m.user.name} is now ${label(m.role).toLowerCase()}`);
    });
    sel.value = m.role;
  }

  async function remove(m, btn) {
    if (!(await confirmDialog("Remove member", `Remove ${m.user.name} from ${project.name}? Their unfinished tickets here will become unassigned.`, "Remove"))) return;
    busy(btn, async () => {
      const res = await api.del(`/projects/${project.id}/members/${m.user.id}`);
      members.splice(members.indexOf(m), 1);
      draw();
      toast(`Removed ${m.user.name}${res.unassigned_tickets ? ` · ${res.unassigned_tickets} ticket(s) unassigned` : ""}`);
    });
  }

  let picked = null;
  const roleSel = select("role", isAdmin() ? ["developer", "owner"] : ["developer"], "developer", { "aria-label": "Role" });
  const adder = owner && h("form.card.add-member", { onsubmit: (e) => {
      e.preventDefault();
      if (!picked) return toast("Pick a person first", "error");
      busy(e.target.querySelector("[type=submit]"), async () => {
        const m = await api.post(`/projects/${project.id}/members`, { user_id: picked.id, role: roleSel.value });
        members.push(m);
        draw();
        toast(`${m.user.name} added`);
        e.target.querySelector("input").value = "";
        picked = null;
      });
    } },
    h("h2", "Add a member"),
    h("div.row.wrap",
      // Admins can search everyone; owners can find people they already share a project with.
      userPicker((q) => api.get("/users/lookup", { q, limit: 10 }).then((users) => users.filter((u) => !members.some((m) => m.user.id === u.id))),
        (u) => { picked = u; }, { placeholder: "Search by name or e-mail" }),
      roleSel,
      h("button.btn.primary", { type: "submit" }, "Add")),
    !isAdmin() && h("p.muted.small", "You can add people you already share a project with. Ask an admin to add anyone else."));

  draw();
  clear(body, adder, list);
}

function renderSettings(body, project) {
  const form = h("form.card.form",
    h("h2", "Project details"),
    field("Name", h("input", { name: "name", value: project.name, required: true, minLength: 2, maxLength: 150 })),
    field("Description", h("textarea", { name: "description", rows: 4, maxLength: 5000 }, project.description)),
    h("div.form-actions", h("button.btn.primary", { type: "submit" }, "Save")));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    busy(form.querySelector("[type=submit]"), async () => {
      await api.patch(`/projects/${project.id}`, formData(form));
      toast("Project saved");
      navigate(`/projects/${project.id}/settings`);
    });
  });

  clear(body, form,
    isAdmin() && h("div.card.danger-zone",
      h("h2", project.is_active ? "Archive project" : "Restore project"),
      h("p.muted", project.is_active
        ? "Archived projects are hidden from lists and can't receive new tickets. Nothing is deleted."
        : "Bring this project back into everyone's lists."),
      h(`button.btn${project.is_active ? ".danger" : ""}`, {
        onclick: (e) => busy(e.currentTarget, async () => {
          await api.patch(`/projects/${project.id}`, { is_active: !project.is_active });
          toast(project.is_active ? "Project archived" : "Project restored");
          navigate(`/projects/${project.id}/settings`);
        }),
      }, project.is_active ? "Archive" : "Restore")),
    h("p.muted.small", `Created ${timeAgo(project.created_at)}`));
}
