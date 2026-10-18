import { api, auth, setUnauthorizedHandler } from "./api.js";
import { setProjectKeys } from "./markdown.js";
import { avatar, busy, clear, errorBox, field, h, label, modal, spinner, toast } from "./ui.js";
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

const root = document.getElementById("app");
const isAdmin = () => auth.user?.role === "admin";

// Ordered: first match wins. Each handler gets (container, params) and may return a cleanup function.
const routes = [
  [/^\/?$/, renderDashboard],
  [/^\/tickets$/, renderTickets],
  [/^\/tickets\/([A-Za-z][A-Za-z0-9]{1,9}-\d+)$/, (el, [key]) => renderTicket(el, key)],
  [/^\/projects$/, renderProjects],
  [/^\/projects\/(\d+)(?:\/(board|list|timeline|docs|upcoming|releases|members|settings))?$/, (el, [id, tab]) => renderProject(el, Number(id), tab || "board")],
  [/^\/notifications$/, renderNotifications],
  [/^\/users$/, renderUsers, true],
  [/^\/reports$/, renderReports, true],
  [/^\/reports\/(\d+)$/, (el, [id]) => renderDeveloperReport(el, Number(id)), true],
  [/^\/integrations$/, renderIntegrations, true],
  [/^\/upcoming$/, renderUpcomingPage],
  [/^\/upcoming\/(\d+)$/, (el, [id]) => renderUpcomingDetail(el, Number(id))],
  [/^\/releases$/, renderReleasesPage],
  [/^\/timeline$/, (el) => renderTimeline(el)],
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
    try {
      cleanup = await handler(main, m.slice(1));
    } catch (err) {
      clear(main, errorBox(err));
    }
    main.focus({ preventScroll: true });
    window.scrollTo(0, 0);
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
function renderShell() {
  const items = [
    ["/", "Dashboard", "M3 13h8V3H3zm10 8h8V11h-8zM3 21h8v-6H3zm10-18v6h8V3z"],
    ["/tickets", "Tickets", "M4 6h16M4 12h16M4 18h10"],
    ["/projects", "Projects", "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"],
    ["/docs", "Docs", "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h6M9 9h2"],
    ["/timeline", "Timeline", "M3 4h18v17H3zM3 9h18M8 2v4M16 2v4M7 13h5M10 17h7"],
    ["/releases", "Releases", "M4.5 16.5c-1.5 1.3-2 5-2 5s3.7-.5 5-2c.7-.8.7-2.1-.1-2.9a2.2 2.2 0 0 0-2.9-.1zM12 15l-3-3a22 22 0 0 1 2-3.9A12.9 12.9 0 0 1 22 2c0 2.7-.8 7.5-6 11a22.4 22.4 0 0 1-4 2zM9 12H4s.6-3 2-4c1.6-1.1 5 0 5 0m1 7v5s3-.6 4-2c1.1-1.6 0-5 0-5"],
    ["/upcoming", "Upcoming", "M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2m-6 9 2 2 4-4"],
    ["/notifications", "Notifications", "M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10 21h4"],
  ];
  if (isAdmin()) {
    items.push(["/users", "People", "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8m13 10v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"]);
    items.push(["/reports", "Reports", "M3 3v18h18M7 15l4-4 3 3 5-6"]);
    items.push(["/integrations", "Slack", "M14.5 10a1.5 1.5 0 1 1 0-3h5a1.5 1.5 0 0 1 0 3zM10 9.5a1.5 1.5 0 1 1-3 0v-5a1.5 1.5 0 0 1 3 0zM9.5 14a1.5 1.5 0 1 1 0 3h-5a1.5 1.5 0 0 1 0-3zM14 14.5a1.5 1.5 0 1 1 3 0v5a1.5 1.5 0 0 1-3 0z"]);
  }
  const icon = (d) => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.append(path);
    return svg;
  };

  bell = notificationBell();
  const search = h("input", {
    type: "search", placeholder: "Jump to ticket (PAY-12) or search…", "aria-label": "Search tickets",
    onkeydown: (e) => {
      if (e.key !== "Enter") return;
      const q = e.target.value.trim();
      if (!q) return;
      e.target.value = "";
      navigate(/^[A-Za-z][A-Za-z0-9]{1,9}-\d+$/.test(q) ? `/tickets/${q.toUpperCase()}` : `/tickets?q=${encodeURIComponent(q)}`);
    },
  });

  clear(root,
    h("div.shell",
      h("aside.sidebar",
        h("a.brand", { href: "#/" }, h("span.logo", "T"), h("span", "Tickets")),
        h("nav.nav", { "aria-label": "Main" }, items.map(([href, text, d]) => h("a", { href: `#${href}` }, icon(d), h("span", text)))),
        h("div.sidebar-foot", h("span.muted.small", isAdmin() ? "Signed in as admin" : "")),
      ),
      h("div.content",
        h("header.topbar",
          h("button.icon-btn.menu-btn", { "aria-label": "Menu", onclick: () => document.body.classList.toggle("nav-open") }, "☰"),
          h("div.search", search),
          bell.el,
          userMenu(),
        ),
        h("main#main", { tabindex: "-1" }),
      ),
      h("div.nav-scrim", { onclick: () => document.body.classList.remove("nav-open") }),
    ),
  );
}

function userMenu() {
  const u = auth.user;
  const menu = h("div.menu",
    h("div.menu-head", h("strong", u.name), h("span.muted.small", u.email), u.designation && h("span.muted.small", u.designation)),
    h("button", { onclick: () => { close(); changePassword(); } }, "Change password"),
    h("button", { onclick: logout }, "Log out"),
  );
  const wrap = h("div.dropdown",
    h("button.avatar-btn", { "aria-label": "Account menu", "aria-haspopup": "true", onclick: (e) => { e.stopPropagation(); wrap.classList.toggle("open"); } }, avatar(u)),
    menu);
  const close = () => wrap.classList.remove("open");
  document.addEventListener("click", (e) => { if (!wrap.contains(e.target)) close(); });
  return wrap;
}

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
  location.hash = "";
  renderLogin();
}

// ----------------------------------------------------------------------------- login
function renderLogin(message) {
  bell?.stop();
  const error = h("div.alert.error", { hidden: !message }, message || "");
  const form = h("form.form",
    field("E-mail", h("input", { type: "email", name: "email", required: true, autocomplete: "username", autofocus: true })),
    field("Password", h("input", { type: "password", name: "password", required: true, autocomplete: "current-password" })),
    error,
    h("button.btn.primary.block", { type: "submit" }, "Sign in"),
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const { email, password } = Object.fromEntries(new FormData(form));
    const btn = form.querySelector("button");
    btn.disabled = true;
    error.hidden = true;
    try {
      await api.login(email, password);
      loadProjectKeys();
      clear(root);
      route();
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });
  clear(root,
    h("div.login",
      h("div.login-card",
        h("div.brand.center", h("span.logo", "T"), h("span", "Developer Ticket System")),
        h("p.muted.center", "Sign in with your work e-mail."),
        form,
      )));
  form.querySelector("input").focus();
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
