import { api, auth, setUnauthorizedHandler } from "./api.js";
import { setProjectKeys } from "./markdown.js";
import { getTheme, onThemeChange, setTheme } from "./theme.js";
import { icon } from "./icons.js";
import { MOD, configurePalette, installShortcuts, openPalette, showShortcuts } from "./palette.js";
import { newTicketDialog } from "./views/ticket.js";
import { avatar, busy, clear, errorBox, field, h, label, modal, progress, spinner, toast } from "./ui.js";
import { renderDashboard } from "./views/dashboard.js";
import { renderTickets } from "./views/tickets.js";
import { renderProjects, renderProject } from "./views/projects.js";
import { renderTicket } from "./views/ticket.js";
import { renderNotifications, notificationBell } from "./views/notifications.js";
import { renderUsers } from "./views/users.js";
import { renderReports, renderDeveloperReport } from "./views/reports.js";
import { renderIntegrations } from "./views/integrations.js";
import { renderUpcomingDetail, renderUpcomingPage } from "./views/upcoming.js";
import { renderReleaseDetail, renderReleasesPage } from "./views/releases.js";
import { renderTimeline } from "./views/timeline.js";
import { renderDocEditor, renderDocHistory, renderDocPage, renderDocsHome } from "./views/docs.js";
import { ATTENTION, attentionCounts, renderAttention } from "./views/attention.js";
import { renderLoginPage } from "./views/login.js";
import { renderChat, startChat, stopChat } from "./views/chat.js";
import { desktopShell, renderDesktop } from "./views/desktop.js";
import { refreshChallengeDot, renderChallenge } from "./views/challenge.js";
import { renderPerson, renderProfile } from "./views/profile.js";
import { coachButton } from "./views/coach.js";

const root = document.getElementById("app");
const isAdmin = () => auth.user?.role === "admin";

// Ordered: first match wins. Each handler gets (container, params) and may return a cleanup function.
const routes = [
  [/^\/?$/, renderDashboard],
  [/^\/tickets$/, renderTickets],
  [/^\/tickets\/([A-Za-z][A-Za-z0-9]{1,9}-\d+)$/, (el, [key]) => renderTicket(el, key)],
  [/^\/projects$/, renderProjects],
  [/^\/projects\/(\d+)(?:\/(board|list|sprints|timeline|docs|upcoming|releases|members|settings))?$/, (el, [id, tab]) => renderProject(el, Number(id), tab || "board")],
  [/^\/notifications$/, renderNotifications],
  [/^\/desktop$/, renderDesktop],
  [/^\/challenge$/, renderChallenge],
  [/^\/profile$/, renderProfile],
  [/^\/people\/(\d+)$/, (el, [id]) => renderPerson(el, Number(id))],
  [/^\/chat(?:\/(\d+))?$/, (el, [id]) => renderChat(el, [id])],
  [/^\/users$/, renderUsers, true],
  [/^\/reports$/, renderReports, true],
  [/^\/reports\/(\d+)$/, (el, [id]) => renderDeveloperReport(el, Number(id)), true],
  [/^\/integrations$/, renderIntegrations, true],
  [/^\/upcoming$/, renderUpcomingPage],
  [/^\/upcoming\/(\d+)$/, (el, [id]) => renderUpcomingDetail(el, Number(id))],
  [/^\/releases$/, renderReleasesPage],
  [/^\/timeline$/, (el) => renderTimeline(el)],
  [/^\/(verify|overdue|unassigned)$/, (el, [kind]) => renderAttention(el, kind)],
  [/^\/docs$/, (el) => renderDocsHome(el)],
  [/^\/docs\/new$/, (el) => renderDocEditor(el, null)],
  [/^\/docs\/(\d+)$/, (el, [id]) => renderDocPage(el, Number(id))],
  [/^\/docs\/(\d+)\/edit$/, (el, [id]) => renderDocEditor(el, Number(id))],
  [/^\/docs\/(\d+)\/history$/, (el, [id]) => renderDocHistory(el, Number(id))],
  [/^\/releases\/(\d+)$/, (el, [id]) => renderReleaseDetail(el, Number(id))],
];

let cleanup = null;
let bell = null;

export function navigate(path) {
  if (location.hash.slice(1) === path) route();
  else location.hash = path;
}

function currentPath() {
  return decodeURIComponent(location.hash.slice(1).split("?")[0]) || "/";
}

export function currentQuery() {
  return new URLSearchParams(location.hash.split("?")[1] || "");
}

/** Replace the query part of the hash without re-rendering the view. */
export function setQuery(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length)) continue;
    (Array.isArray(v) ? v : [v]).forEach((x) => sp.append(k, x));
  }
  const s = sp.toString();
  history.replaceState(null, "", `#${currentPath()}${s ? "?" + s : ""}`);
}

async function route() {
  if (!auth.user) return renderLogin();
  if (typeof cleanup === "function") cleanup();
  cleanup = null;

  const path = currentPath();
  const main = document.getElementById("main");
  if (!main) { renderShell(); return route(); }
  highlightNav(path);

  for (const [pattern, handler, adminOnly] of routes) {
    const m = path.match(pattern);
    if (!m) continue;
    if (adminOnly && !isAdmin()) break;
    clear(main, spinner());
    progress.start();
    try {
      cleanup = await handler(main, m.slice(1));
    } catch (err) {
      clear(main, errorBox(err));
    }
    progress.done();
    // replay the entrance animation for the new page
    main.classList.remove("page-enter");
    void main.offsetWidth;
    main.classList.add("page-enter");
    main.focus({ preventScroll: true });
    window.scrollTo(0, 0);
    refreshAttention().catch(() => {});
    return;
  }
  clear(main, h("div.empty", h("strong", "Page not found"), h("p", h("a", { href: "#/" }, "Back to dashboard"))));
}

function highlightNav(path) {
  document.querySelectorAll(".nav a").forEach((a) => {
    const target = a.getAttribute("href").slice(1);
    const active = target === "/" ? path === "/" : path === target || path.startsWith(target + "/");
    a.classList.toggle("active", active);
    if (active) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  document.body.classList.remove("nav-open");
}

// ----------------------------------------------------------------------------- shell
const SIDEBAR_KEY = "tickets.sidebar.collapsed";
const isCollapsed = () => { try { return localStorage.getItem(SIDEBAR_KEY) === "1"; } catch { return false; } };

function navSections() {
  const sections = [
    ["", [
      { href: "/", label: "Dashboard", icon: "dashboard", keys: "G D" },
      { href: "/tickets", label: "Tickets", icon: "tickets", keys: "G T" },
      { href: "/projects", label: "Projects", icon: "folder", keys: "G P" },
      { href: "/timeline", label: "Timeline", icon: "timeline", keys: "G L" },
      { href: "/chat", label: "Chat", icon: "message", keys: "G M", chat: true },
      { href: "/notifications", label: "Inbox", icon: "inbox", keys: "G N", badge: true },
      { href: "/challenge", label: "Daily challenge", icon: "trophy", keys: "G C", challenge: true },
    ]],
    ["Needs attention", Object.entries(ATTENTION).map(([key, c]) => ({
      href: `/${key}`, label: c.title, icon: c.icon, attention: key, ownerOnly: c.ownerOnly,
    }))],
    ["Plan & ship", [
      { href: "/upcoming", label: "Upcoming", icon: "clipboard", keys: "G U" },
      { href: "/releases", label: "Releases", icon: "rocket", keys: "G R" },
      { href: "/docs", label: "Docs", icon: "docs", keys: "G O" },
    ]],
  ];
  if (isAdmin()) {
    sections.push(["Admin", [
      { href: "/users", label: "People", icon: "users" },
      { href: "/reports", label: "Reports", icon: "chart" },
      { href: "/integrations", label: "Slack", icon: "hash" },
    ]]);
  }
  return sections;
}

async function newTicketAnywhere() {
  try {
    const projects = (await api.get("/projects")).filter((p) => p.is_active);
    if (!projects.length) { toast("You are not in any active project yet", "error"); return; }
    const m = location.hash.match(/#\/projects\/(\d+)/);
    newTicketDialog(projects, m ? Number(m[1]) : undefined);
  } catch (err) { toast(err.message, "error"); }
}

function renderShell() {
  const sections = navSections();
  configurePalette({
    nav: sections.flatMap(([, items]) => items), newTicket: newTicketAnywhere, changePassword, logout, navigate,
  });
  bell = notificationBell();
  startChat();
  if (isCollapsed()) document.body.classList.add("nav-collapsed");

  const u = auth.user;
  const accountMenu = h("div.menu.account-menu",
    h("div.menu-head", h("strong", u.name), h("span.muted.small", u.email), u.designation && h("span.muted.small", u.designation)),
    h("div.menu-theme", h("span.muted.small", "Theme"),
      h("div.chips.seg", [["system", "System", "monitor"], ["light", "Light", "sun"], ["dark", "Dark", "moon"]].map(([v, text, ic]) => h("button.chip", {
        type: "button", "aria-pressed": String(getTheme() === v), dataset: { theme: v }, title: text,
        onclick: (e) => { e.stopPropagation(); setTheme(v); },
      }, icon(ic, { size: 14 }), text)))),
    h("button", { onclick: () => { closeAccount(); navigate("/profile"); } }, icon("user"), "Your profile"),
    h("button", { onclick: () => { closeAccount(); showShortcuts(); } }, icon("keyboard"), "Keyboard shortcuts", h("kbd.menu-kbd", "?")),
    h("button", { onclick: () => { closeAccount(); changePassword(); } }, icon("key"), "Change password"),
    h("button", { onclick: () => { closeAccount(); navigate("/desktop"); } }, icon("download"), desktopShell() ? `Desktop app ${desktopShell().version}` : "Get the desktop app"),
    h("button", { onclick: logout }, icon("logout"), "Log out"));
  const account = h("div.dropdown.account",
    h("button.account-btn", {
      type: "button", "aria-haspopup": "true", "aria-label": "Account menu",
      onclick: (e) => { e.stopPropagation(); account.classList.toggle("open"); },
    }, avatar(u), h("span.account-text", h("strong", u.name), h("span", isAdmin() ? "Administrator" : u.designation || "Member")), icon("chevron-down", { size: 14, cls: "account-caret" })),
    accountMenu);
  const closeAccount = () => account.classList.remove("open");
  window.addEventListener("profile-changed", () => {
    const btn = account.querySelector(".account-btn");
    btn.querySelector(".avatar").replaceWith(avatar(auth.user));
    btn.querySelector(".account-text strong").textContent = auth.user.name;
    accountMenu.querySelector(".menu-head strong").textContent = auth.user.name;
  });
  document.addEventListener("click", (e) => { if (!account.contains(e.target)) closeAccount(); });

  const collapseBtn = h("button.icon-btn.collapse-btn", {
    type: "button", title: "Collapse sidebar", "aria-label": "Collapse sidebar",
    onclick: () => {
      const on = !document.body.classList.contains("nav-collapsed");
      document.body.classList.toggle("nav-collapsed", on);
      try { localStorage.setItem(SIDEBAR_KEY, on ? "1" : "0"); } catch { /* per-viewer only */ }
    },
  }, icon("chevrons-left"));

  const navLink = (it) => h("a.nav-link", {
    href: `#${it.href}`, title: it.label, dataset: { href: it.href, attention: it.attention || "" }, hidden: Boolean(it.ownerOnly),
  },
  icon(it.icon, { size: 18 }), h("span.nav-text", it.label),
  it.badge ? h("span.nav-badge.inbox-count", { hidden: true }) : null,
  it.chat ? h("span.nav-badge.chat-count", { hidden: true }) : null,
  it.challenge ? h("span.nav-badge.dot-only.challenge-dot", { hidden: true, title: "You haven't played today's challenge yet" }) : null,
  it.attention ? h(`span.nav-count.att-${it.attention}`, { hidden: true }) : null);

  clear(root,
    h("div.shell",
      h("aside.sidebar",
        h("div.sidebar-top",
          h("a.brand", { href: "#/" }, h("span.logo", icon("grandesk", { size: 17 })), h("span.brand-text", "Grandesk")),
          collapseBtn),
        h("button.sidebar-search", { type: "button", onclick: () => openPalette() },
          icon("search", { size: 16 }), h("span.nav-text", "Search"), h("span.nav-text.kbd-hint", h("kbd", MOD), h("kbd", "K"))),
        h("nav.nav", { "aria-label": "Main" }, sections.map(([title, items]) => h("div.nav-section",
          title ? h("div.nav-title", title) : null, items.map(navLink)))),
        h("div.sidebar-foot", account)),
      h("div.content",
        h("header.topbar",
          h("button.icon-btn.menu-btn", { "aria-label": "Menu", onclick: () => document.body.classList.toggle("nav-open") }, icon("menu", { size: 18 })),
          h("button.top-search", { type: "button", onclick: () => openPalette() },
            icon("search", { size: 16 }), h("span", "Search or jump to…"), h("span.kbd-hint", h("kbd", MOD), h("kbd", "K"))),
          h("div.topbar-actions",
            h("button.btn.primary.sm.new-btn", { type: "button", onclick: newTicketAnywhere, title: "Create ticket (C)" }, icon("plus", { size: 15 }), h("span", "New ticket")),
            coachButton(),
            h("button.icon-btn", { type: "button", title: "Keyboard shortcuts (?)", "aria-label": "Keyboard shortcuts", onclick: showShortcuts }, icon("keyboard", { size: 18 })),
            themeButton(),
            bell.el)),
        h("main#main", { tabindex: "-1" })),
      h("div.nav-scrim", { onclick: () => document.body.classList.remove("nav-open") })));

  // Owners/admins also get "To verify" and "Unassigned"; then fill in the attention counts.
  (async () => {
    try {
      const projects = await api.get("/projects");
      attentionOwner = isAdmin() || projects.some((p) => p.my_role === "owner");
    } catch { attentionOwner = isAdmin(); }
    root.querySelectorAll(".nav-link[data-attention]").forEach((a) => {
      if (a.dataset.attention && ATTENTION[a.dataset.attention].ownerOnly) a.hidden = !attentionOwner;
    });
    configurePalette({
      nav: sections.flatMap(([, items]) => items).filter((it) => !it.ownerOnly || attentionOwner),
      newTicket: newTicketAnywhere, changePassword, logout, navigate,
    });
    refreshAttention();
  })();

  refreshChallengeDot();

  // Mirror the unread count onto the sidebar "Inbox" item.
  const badge = root.querySelector(".inbox-count");
  const count = bell.el.querySelector(".count");
  if (badge && count) {
    const sync = () => { badge.hidden = count.hidden; badge.textContent = count.textContent; };
    new MutationObserver(sync).observe(count, { attributes: true, childList: true, characterData: true, subtree: true });
    sync();
  }
}

let attentionOwner = false;
let attentionTimer = null;
/** Update the "Needs attention" counts in the sidebar (on navigation and every minute). */
async function refreshAttention() {
  clearTimeout(attentionTimer);
  if (!auth.user) return;
  const counts = await attentionCounts(attentionOwner);
  Object.entries(counts).forEach(([key, n]) => {
    const el = document.querySelector(`.nav-count.att-${key}`);
    if (!el) return;
    el.hidden = !n;
    el.textContent = n > 99 ? "99+" : String(n ?? "");
  });
  attentionTimer = setTimeout(refreshAttention, 60_000);
}

const THEME_CYCLE = { system: "light", light: "dark", dark: "system" };
const THEME_ICON = { system: "monitor", light: "sun", dark: "moon" };
function themeButton() {
  const btn = h("button.icon-btn.theme-btn", { type: "button", onclick: () => setTheme(THEME_CYCLE[getTheme()]) });
  const sync = () => {
    const t = getTheme();
    btn.replaceChildren(icon(THEME_ICON[t], { size: 18 }));
    btn.title = `Theme: ${t} (click for ${THEME_CYCLE[t]})`;
    btn.setAttribute("aria-label", btn.title);
    document.querySelectorAll(".menu-theme .chip").forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.theme === t)));
  };
  sync();
  onThemeChange(sync);
  return btn;
}
// Redraw the current page so charts, diagrams and code colours follow the new theme.
onThemeChange(() => { if (auth.user && document.getElementById("main")) route(); });

function changePassword() {
  const form = h("form.form",
    field("Current password", h("input", { type: "password", name: "current_password", required: true, autocomplete: "current-password" })),
    field("New password", h("input", { type: "password", name: "new_password", required: true, minLength: 8, maxLength: 72, autocomplete: "new-password" }), "8–72 characters"),
    field("Repeat new password", h("input", { type: "password", name: "repeat", required: true, autocomplete: "new-password" })),
    h("div.form-actions", h("button.btn.primary", { type: "submit" }, "Update password")),
  );
  const m = modal("Change password", form);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const { current_password, new_password, repeat } = Object.fromEntries(new FormData(form));
    if (new_password !== repeat) return toast("The new passwords do not match", "error");
    busy(form.querySelector("button[type=submit]"), async () => {
      await api.post("/auth/change-password", { current_password, new_password });
      m.close();
      toast("Password updated");
    });
  });
}

function logout() {
  auth.token = null;
  auth.user = null;
  bell?.stop();
  stopChat();
  location.hash = "";
  renderLogin();
}

// ----------------------------------------------------------------------------- login
function renderLogin(message) {
  bell?.stop();
  stopChat();
  renderLoginPage(root, {
    message,
    onSuccess: () => {
      loadProjectKeys();
      clear(root);
      document.body.classList.add("app-enter");
      setTimeout(() => document.body.classList.remove("app-enter"), 900);
      route();
    },
  });
}

// Markdown turns "PAY-12" into a link only for projects the viewer can see.
function loadProjectKeys() {
  api.get("/projects", { include_archived: true }).then((ps) => setProjectKeys(ps.map((p) => p.key))).catch(() => {});
}

// ----------------------------------------------------------------------------- boot
setUnauthorizedHandler(() => {
  if (!auth.user) return;
  auth.token = null;
  auth.user = null;
  renderLogin("Your session has expired. Please sign in again.");
});

window.addEventListener("hashchange", route);
installShortcuts();

window.__appStarted = true;

(async function boot() {
  if (!auth.token) return renderLogin();
  clear(root, spinner());
  try {
    auth.user = await api.get("/auth/me");
    loadProjectKeys();
    route();
  } catch {
    auth.token = null;
    renderLogin();
  }
})();

export { isAdmin, label };
