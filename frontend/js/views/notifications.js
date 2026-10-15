import { api } from "../api.js";
import { navigate } from "../app.js";
import { avatar, busy, clear, emptyState, h, spinner, timeAgo, toast } from "../ui.js";

const POLL_MS = 30_000;
const listeners = new Set();
const changed = () => listeners.forEach((fn) => fn());

function item(n, onOpen) {
  return h(`li.notif${n.is_read ? "" : ".unread"}`,
    h("button", { onclick: () => onOpen(n) },
      avatar(n.actor, "sm"),
      h("div.notif-body",
        h("span", n.message),
        h("span.muted.small", n.ticket_key ? `${n.ticket_key} · ` : "", timeAgo(n.created_at))),
      !n.is_read && h("span.dot", { "aria-label": "Unread" })));
}

async function open(n) {
  if (!n.is_read) {
    try { await api.post(`/notifications/${n.id}/read`); changed(); } catch { /* not fatal */ }
  }
  if (n.ticket_key) navigate(`/tickets/${n.ticket_key}`);
  else if (n.type === "upcoming") navigate("/upcoming");
}

/** Topbar bell: unread badge (polled) plus a dropdown with the latest few. */
export function notificationBell() {
  const badge = h("span.count", { hidden: true });
  const list = h("ul.notif-list");
  const panel = h("div.menu.notif-menu",
    h("div.menu-head.row",
      h("strong", "Notifications"),
      h("button.link", { onclick: async () => { await api.post("/notifications/read-all"); changed(); loadList(); } }, "Mark all read")),
    list,
    h("a.menu-foot", { href: "#/notifications", onclick: () => wrap.classList.remove("open") }, "View all"));
  const wrap = h("div.dropdown",
    h("button.icon-btn.bell", {
      "aria-label": "Notifications",
      onclick: (e) => { e.stopPropagation(); wrap.classList.toggle("open"); if (wrap.classList.contains("open")) loadList(); },
    }, "🔔", badge),
    panel);
  document.addEventListener("click", (e) => { if (!wrap.contains(e.target)) wrap.classList.remove("open"); });

  async function loadCount() {
    try {
      const { unread } = await api.get("/notifications/unread-count");
      badge.hidden = !unread;
      badge.textContent = unread > 99 ? "99+" : unread;
    } catch { /* offline or logged out: try again next tick */ }
  }
  async function loadList() {
    clear(list, h("li", spinner()));
    try {
      const page = await api.get("/notifications", { limit: 8 });
      clear(list, page.items.length
        ? page.items.map((n) => item(n, (x) => { wrap.classList.remove("open"); open(x); }))
        : h("li.muted.none", "You're all caught up."));
    } catch (err) { clear(list, h("li.muted.none", err.message)); }
  }

  listeners.add(loadCount);
  loadCount();
  const timer = setInterval(loadCount, POLL_MS);
  return { el: wrap, stop: () => { clearInterval(timer); listeners.delete(loadCount); } };
}

export async function renderNotifications(main) {
  const PAGE = 25;
  let offset = 0;
  let unreadOnly = false;
  const list = h("ul.notif-list.page-list");
  const pager = h("div.pager");

  async function load() {
    clear(list, h("li", spinner()));
    const page = await api.get("/notifications", { limit: PAGE, offset, unread_only: unreadOnly });
    clear(list, page.items.length ? page.items.map((n) => item(n, open)) : h("li", emptyState("Nothing here", unreadOnly ? "No unread notifications." : "Notifications about your tickets will show up here.")));
    clear(pager,
      h("span.muted.small", page.total ? `${offset + 1}–${Math.min(offset + PAGE, page.total)} of ${page.total}` : ""),
      h("button.btn.sm", { disabled: offset === 0, onclick: () => { offset -= PAGE; load(); } }, "Previous"),
      h("button.btn.sm", { disabled: offset + PAGE >= page.total, onclick: () => { offset += PAGE; load(); } }, "Next"));
  }
  const reload = () => load().catch((e) => toast(e.message, "error"));
  listeners.add(reload);

  clear(main,
    h("div.page-head",
      h("h1", "Notifications"),
      h("div.actions",
        h("label.check", h("input", { type: "checkbox", onchange: (e) => { unreadOnly = e.target.checked; offset = 0; reload(); } }), "Unread only"),
        h("button.btn", { onclick: (e) => busy(e.currentTarget, async () => { await api.post("/notifications/read-all"); changed(); }) }, "Mark all read"))),
    h("div.card.flush", list),
    pager);
  await load();
  return () => listeners.delete(reload);
}
