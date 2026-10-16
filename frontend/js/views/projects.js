import { api, auth } from "../api.js";
import { navigate } from "../app.js";
import {
  CLOSED, STATUSES, avatar, busy, clear, confirmDialog, emptyState, errorBox, field, fmtDate, formData, h, label,
  modal, priorityBadge, select, spinner, timeAgo, toast, typeBadge, userPicker,
} from "../ui.js";
import { filteredTicketList } from "./ticketlist.js";
import { newTicketDialog } from "./ticket.js";
import { renderProjectUpcoming } from "./upcoming.js";
import { addToReleaseDialog, renderProjectReleases } from "./releases.js";
import { renderTimeline } from "./timeline.js";

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

  const tabs = [["board", "Board"], ["list", "List"], ["timeline", "Timeline"], ["upcoming", "Upcoming"], ["releases", "Releases"], ["members", `Members (${members.length})`]];
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
    clear(body, filteredTicketList({
      endpoint: `/projects/${id}/tickets`,
      showProject: false,
      assignees: members.map((m) => [String(m.user.id), m.user.name]),
    }));
  } else if (tab === "timeline") await renderTimeline(body, { projectId: project.id });
  else if (tab === "upcoming") await renderProjectUpcoming(body, project);
  else if (tab === "releases") await renderProjectReleases(body, project);
  else if (tab === "members") renderMembers(body, project, members, owner);
  else if (tab === "settings" && owner) renderSettings(body, project);
}

async function renderBoard(body, project, owner) {
  const filterBar = h("div.board-filters");
  const board = h("div.board");
  clear(body, filterBar, board);

  let mineOnly = false;
  let tickets = [];

  async function load() {
    clear(board, spinner());
    try {
      // One page of up to 200 per status keeps "done" from crowding out active work.
      const pages = await Promise.all(STATUSES.map((s) => api.get(`/projects/${project.id}/tickets`, {
        status: s, sort: CLOSED.includes(s) ? "updated_at" : "priority", limit: CLOSED.includes(s) ? 30 : 200,
        assignee_id: mineOnly ? auth.user.id : undefined,
        in_release: false, // tickets moved into a release leave the board
      })));
      tickets = pages.flatMap((p) => p.items);
      draw(pages.map((p) => p.total));
    } catch (err) { clear(board, errorBox(err)); }
  }

  function draw(totals) {
    clear(board, STATUSES.map((s, i) => {
      const items = tickets.filter((t) => t.status === s);
      const col = h(`section.column.col-${s}`, { dataset: { status: s } },
        h("header", h(`i.status-dot.status-${s}`), h("span", label(s)), h("span.muted", String(totals[i]))),
        owner && CLOSED.includes(s) && items.length > 0 && h("button.btn.sm.col-action", {
          title: "Move these finished tickets into a release",
          onclick: () => addToReleaseDialog(project.id, { preselect: items.map((t) => t.id), onDone: () => load() }),
        }, "🚀 Move to release"),
        h("div.cards", items.map(card), !items.length && h("p.muted.small.center", "No tickets"),
          totals[i] > items.length && h("a.small.center.more", { href: `#/projects/${project.id}/list?status=${s}` }, `+${totals[i] - items.length} more`)));
      col.addEventListener("dragover", (e) => { e.preventDefault(); col.classList.add("drop"); });
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

  async function move(t, status) {
    const prev = t.status;
    t.status = status;
    draw(STATUSES.map((s) => tickets.filter((x) => x.status === s).length));
    try {
      await api.post(`/tickets/${t.id}/status`, { status });
      toast(`${t.key} → ${label(status)}`);
    } catch (err) {
      t.status = prev;
      toast(err.message, "error");
    }
    load();
  }

  function card(t) {
    return h("a.ticket-card", {
      href: `#/tickets/${t.key}`, draggable: "true",
      ondragstart: (e) => { e.dataTransfer.setData("text/plain", String(t.id)); e.dataTransfer.effectAllowed = "move"; },
    },
    h("div.row.between", h("span.key", t.key), typeBadge(t.type)),
    h("p", t.title),
    h("div.row.between",
      priorityBadge(t.priority),
      h("div.row",
        t.due_date && h(`span.small${t.is_overdue ? ".danger-text" : ".muted"}`, fmtDate(t.due_date)),
        avatar(t.assignee, "sm"))));
  }

  clear(filterBar,
    h("label.check", h("input", { type: "checkbox", onchange: (e) => { mineOnly = e.target.checked; load(); } }), "Only my tickets"),
    h("span.muted.small", owner
      ? "Drag a card to change its status. Review tickets in Done, then move them to Verified."
      : "Drag a card to change its status. Move finished work to Done for the owner to verify."));
  await load();
}

function renderMembers(body, project, members, owner) {
  const list = h("div.card.flush");

  function draw() {
    clear(list, h("div.table-wrap", h("table.table",
      h("thead", h("tr", h("th", "Person"), h("th", "Role"), h("th.hide-sm", "Joined"), owner && h("th"))),
      h("tbody", members.map((m) => h("tr",
        h("td", h("div.user-chip", avatar(m.user, "sm"), h("div", h("div", m.user.name), h("div.muted.small", m.user.email)))),
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
