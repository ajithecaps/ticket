// Shared ticket table + filter bar used by the Tickets page, project list view and dashboard.
import { api, auth } from "../api.js";
import { currentQuery, setQuery } from "../app.js";
import {
  PRIORITIES, STATUSES, TYPES, clear, emptyState, errorBox, fmtDate, h, label, priorityBadge, select,
  spinner, statusBadge, timeAgo, typeBadge, userChip,
} from "../ui.js";

export function ticketTable(tickets, { showProject = true } = {}) {
  if (!tickets.length) return emptyState("No tickets", "Nothing matches these filters.");
  return h("div.table-wrap",
    h("table.table.tickets",
      h("thead", h("tr",
        h("th", "Key"), h("th", "Title"), showProject && h("th.hide-sm", "Project"),
        h("th", "Status"), h("th.hide-sm", "Priority"), h("th.hide-sm", "Assignee"), h("th", "Due"), h("th.hide-md", "Updated"))),
      h("tbody", tickets.map((t) => h("tr", { onclick: (e) => { if (!e.target.closest("a")) location.hash = `/tickets/${t.key}`; } },
        h("td.key", h("a", { href: `#/tickets/${t.key}` }, t.key)),
        h("td", h("div.title-cell", typeBadge(t.type), h("span", t.title))),
        showProject && h("td.hide-sm.muted", t.project.name),
        h("td", statusBadge(t.status)),
        h("td.hide-sm", priorityBadge(t.priority)),
        h("td.hide-sm", userChip(t.assignee)),
        h(`td.nowrap${t.is_overdue ? ".overdue" : ""}`, t.due_date ? fmtDate(t.due_date) : h("span.muted", "—")),
        h("td.hide-md.muted", timeAgo(t.updated_at)),
      ))),
    ));
}

/**
 * Filterable, paginated ticket list bound to the URL query string.
 * opts.endpoint: API path; opts.assignees: [[value, text]] for the assignee filter; opts.extraParams.
 */
export function filteredTicketList(opts) {
  const PAGE = 25;
  const q0 = currentQuery();
  const state = {
    q: q0.get("q") || "",
    status: q0.getAll("status"),
    priority: q0.get("priority") || "",
    type: q0.get("type") || "",
    assignee: q0.get("assignee") || "",
    overdue: q0.get("overdue") === "1",
    sort: q0.get("sort") || "updated_at",
    offset: Number(q0.get("offset")) || 0,
  };

  const results = h("div");
  const pager = h("div.pager");

  const statusChips = h("div.chips", { role: "group", "aria-label": "Status" },
    STATUSES.map((s) => h("button.chip", {
      type: "button", "aria-pressed": String(state.status.includes(s)),
      onclick: (e) => {
        state.status = state.status.includes(s) ? state.status.filter((x) => x !== s) : [...state.status, s];
        e.currentTarget.setAttribute("aria-pressed", String(state.status.includes(s)));
        state.offset = 0; load();
      },
    }, label(s))));

  const onChange = (key) => (e) => {
    state[key] = e.target.type === "checkbox" ? e.target.checked : e.target.value;
    state.offset = 0; load();
  };
  let timer;
  const bar = h("div.filters",
    h("input", {
      type: "search", placeholder: "Search title, description or key", value: state.q, "aria-label": "Search",
      oninput: (e) => { clearTimeout(timer); timer = setTimeout(() => { state.q = e.target.value.trim(); state.offset = 0; load(); }, 250); },
    }),
    select("priority", [["", "Any priority"], ...PRIORITIES.map((p) => [p, label(p)])], state.priority, { onchange: onChange("priority"), "aria-label": "Priority" }),
    select("type", [["", "Any type"], ...TYPES.map((t) => [t, label(t)])], state.type, { onchange: onChange("type"), "aria-label": "Type" }),
    select("assignee", [["", "Any assignee"], ["me", "Assigned to me"], ["none", "Unassigned"],
      ...(opts.assignees?.length ? [["-", "──────────", { disabled: true }]] : []), ...(opts.assignees || [])],
    state.assignee, { onchange: onChange("assignee"), "aria-label": "Assignee" }),
    select("sort", [["updated_at", "Recently updated"], ["created_at", "Newest"], ["priority", "Priority"], ["due_date", "Due date"]], state.sort, { onchange: onChange("sort"), "aria-label": "Sort" }),
    h("label.check", h("input", { type: "checkbox", checked: state.overdue, onchange: onChange("overdue") }), "Overdue"),
  );

  async function load() {
    setQuery({
      q: state.q, status: state.status, priority: state.priority, type: state.type, assignee: state.assignee,
      overdue: state.overdue ? "1" : "", sort: state.sort !== "updated_at" ? state.sort : "", offset: state.offset || "",
    });
    const params = {
      ...opts.extraParams,
      q: state.q || undefined,
      status: state.status,
      priority: state.priority || undefined,
      type: state.type || undefined,
      overdue: state.overdue || undefined,
      sort: state.sort,
      order: state.sort === "due_date" ? "asc" : "desc",
      limit: PAGE,
      offset: state.offset,
    };
    if (state.assignee === "me") params.assignee_id = auth.user.id;
    else if (state.assignee === "none") params.unassigned = true;
    else if (state.assignee) params.assignee_id = state.assignee;

    clear(results, spinner());
    try {
      const page = await api.get(opts.endpoint, params);
      clear(results, ticketTable(page.items, opts));
      clear(pager,
        h("span.muted.small", page.total ? `${state.offset + 1}–${Math.min(state.offset + PAGE, page.total)} of ${page.total}` : ""),
        h("button.btn.sm", { disabled: state.offset === 0, onclick: () => { state.offset = Math.max(0, state.offset - PAGE); load(); } }, "Previous"),
        h("button.btn.sm", { disabled: state.offset + PAGE >= page.total, onclick: () => { state.offset += PAGE; load(); } }, "Next"));
    } catch (err) {
      clear(results, errorBox(err));
      clear(pager);
    }
  }

  load();
  return h("div.ticket-list", h("div.card.filters-card", bar, statusChips), h("div.card.flush", results), pager);
}
