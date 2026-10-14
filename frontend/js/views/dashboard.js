import { api, auth } from "../api.js";
import { STATUSES, clear, h, label } from "../ui.js";
import { ticketTable } from "./ticketlist.js";

const OPEN = ["todo", "in_progress", "blocked", "in_review"];

function stat(value, text, { tone = "", href } = {}) {
  const inner = [h("span.stat-value", String(value)), h("span.stat-label", text)];
  return href ? h(`a.stat${tone ? "." + tone : ""}`, { href }, inner) : h(`div.stat${tone ? "." + tone : ""}`, inner);
}

/** Horizontal stacked bar of counts by status, with a legend. */
export function statusBar(byStatus) {
  const total = STATUSES.reduce((n, s) => n + (byStatus[s] || 0), 0);
  return h("div.status-bar-wrap",
    h("div.status-bar", { role: "img", "aria-label": STATUSES.map((s) => `${label(s)} ${byStatus[s] || 0}`).join(", ") },
      total ? STATUSES.filter((s) => byStatus[s]).map((s) => h(`span.seg.status-${s}`, { style: { flex: byStatus[s] }, title: `${label(s)}: ${byStatus[s]}` }))
        : h("span.seg.empty")),
    h("ul.legend", STATUSES.map((s) => h("li", h(`i.status-${s}`), label(s), h("strong", String(byStatus[s] || 0))))));
}

export async function renderDashboard(main) {
  const isAdmin = auth.user.role === "admin";
  const [summary, mine, projects, overview] = await Promise.all([
    api.get("/tickets/my/summary"),
    api.get("/tickets/my", { status: OPEN, sort: "due_date", order: "asc", limit: 10 }),
    api.get("/projects"),
    isAdmin ? api.get("/reports/overview") : null,
  ]);
  const owned = projects.filter((p) => p.my_role === "owner" || p.my_role === "admin");
  const ownedIds = new Set(owned.map((p) => p.id));
  const unassigned = owned.length
    ? await api.get("/tickets", { unassigned: true, status: ["todo", "blocked"], sort: "priority", limit: 20 })
    : null;

  const first = auth.user.name.split(/\s+/)[0];
  clear(main,
    h("div.page-head", h("div", h("h1", `Hello, ${first}`), h("p.muted", "Here's what's on your plate."))),

    h("section.stats",
      stat(summary.open, "My open tickets", { href: "#/tickets?assignee=me" }),
      stat(summary.by_status.in_progress || 0, "In progress", { href: "#/tickets?assignee=me&status=in_progress" }),
      stat(summary.by_status.in_review || 0, "In review", { href: "#/tickets?assignee=me&status=in_review" }),
      stat(summary.by_status.blocked || 0, "Blocked", { tone: summary.by_status.blocked ? "warn" : "", href: "#/tickets?assignee=me&status=blocked" }),
      stat(summary.overdue, "Overdue", { tone: summary.overdue ? "danger" : "", href: "#/tickets?assignee=me&overdue=1" }),
    ),

    h("div.grid-2",
      h("section.card.flush",
        h("div.card-head", h("h2", "My open work"), h("a.small", { href: "#/tickets?assignee=me" }, "See all")),
        ticketTable(mine.items, { showProject: true })),
      h("section.card",
        h("div.card-head", h("h2", "By project")),
        summary.by_project.length
          ? h("ul.project-sum", summary.by_project.map((p) => h("li",
            h("a", { href: `#/projects/${p.project.id}` }, h("span.key-pill", p.project.key), p.project.name),
            h("span.muted.small", `${p.open} open`, p.overdue ? h("span.danger-text", ` · ${p.overdue} overdue`) : ""))))
          : h("p.muted", "Nothing is assigned to you yet."))),

    unassigned && h("section.card.flush",
      h("div.card-head", h("h2", "Needs an assignee"), h("a.small", { href: "#/tickets?assignee=none" }, "See all")),
      ticketTable(unassigned.items.filter((t) => ownedIds.has(t.project.id)).slice(0, 8))),

    overview && h("section.card",
      h("div.card-head", h("h2", "Across all projects"), h("a.small", { href: "#/reports" }, "Efficiency report")),
      h("div.stats.compact",
        stat(overview.total_tickets, "Total"),
        stat(overview.open_tickets, "Open"),
        stat(overview.overdue_open, "Overdue", { tone: overview.overdue_open ? "danger" : "" }),
        stat(overview.unassigned_open, "Unassigned", { tone: overview.unassigned_open ? "warn" : "" }),
        stat(overview.created_last_7_days, "Created (7d)"),
        stat(overview.completed_last_7_days, "Completed (7d)")),
      statusBar(overview.by_status)),
  );
}
