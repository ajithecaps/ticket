// "Needs attention" pages: work waiting for an owner's check, overdue work, and unassigned work.
// Each is the full ticket table with its own filter fixed.
import { api } from "../api.js";
import { icon } from "../icons.js";
import { clear, h } from "../ui.js";
import { filteredTicketList } from "./ticketlist.js";

const OPEN = ["todo", "in_progress", "blocked", "in_review"];

export const ATTENTION = {
  verify: {
    title: "To verify", icon: "check-circle", ownerOnly: true,
    blurb: "Developers marked these done. Open each one, check the work, then verify it or send it back. Tip: select several and use Set status → Verified.",
    locked: { status: "done", owned: true, in_release: false },
    countParams: { status: "done", owned: true, in_release: false },
    group: "project",
  },
  overdue: {
    title: "Overdue", icon: "alert", ownerOnly: false,
    blurb: "Open tickets past their due date, grouped by who has them. Reassign, re-plan the due date, or chase them up.",
    locked: { overdue: true },
    countParams: { overdue: true },
    group: "assignee",
    statuses: OPEN, // closed tickets are never overdue
  },
  unassigned: {
    title: "Unassigned", icon: "user", ownerOnly: true,
    blurb: "Open tickets in your projects that nobody is working on. Select them and use Assign to… to hand them out.",
    locked: { unassigned: true, owned: true, status: OPEN },
    countParams: { unassigned: true, owned: true, status: OPEN },
    group: "priority",
  },
};

/** Total for each attention list (used for the sidebar badges). */
export async function attentionCounts(isOwner) {
  const entries = Object.entries(ATTENTION).filter(([, c]) => isOwner || !c.ownerOnly);
  const totals = await Promise.all(entries.map(([, c]) => api.get("/tickets", { ...c.countParams, limit: 1 }).then((p) => p.total).catch(() => null)));
  return Object.fromEntries(entries.map(([k], i) => [k, totals[i]]));
}

export async function renderAttention(main, kind) {
  const cfg = ATTENTION[kind];
  const people = await api.get("/users/lookup", { limit: 50 });
  clear(main,
    h("div.page-head",
      h("div.att-head", h(`span.att-icon.att-${kind}`, icon(cfg.icon, { size: 20 })),
        h("div", h("h1", cfg.title), h("p.muted", cfg.blurb)))),
    filteredTicketList({
      endpoint: "/tickets",
      prefsKey: `attention-${kind}`,
      assignees: people.map((u) => [String(u.id), u.name]),
      lockedParams: cfg.locked,
      defaultGroup: cfg.group,
      statusOptions: cfg.statuses,
    }));
}
