import { api, auth } from "../api.js";
import {
  avatar, busy, clear, emptyState, errorBox, field, fmtDate, formData, h, label, modal, select, spinner, toast,
} from "../ui.js";

export async function renderUsers(main) {
  const PAGE = 50;
  const state = { q: "", role: "", active: "true", offset: 0 };
  const results = h("div.card.flush");
  const pager = h("div.pager");

  async function load() {
    clear(results, spinner());
    try {
      const page = await api.get("/users", {
        q: state.q || undefined, role: state.role || undefined,
        is_active: state.active === "" ? undefined : state.active, limit: PAGE, offset: state.offset,
      });
      clear(results, page.items.length ? table(page.items) : emptyState("No people found", "Try a different search."));
      clear(pager,
        h("span.muted.small", page.total ? `${state.offset + 1}–${Math.min(state.offset + PAGE, page.total)} of ${page.total}` : ""),
        h("button.btn.sm", { disabled: state.offset === 0, onclick: () => { state.offset -= PAGE; load(); } }, "Previous"),
        h("button.btn.sm", { disabled: state.offset + PAGE >= page.total, onclick: () => { state.offset += PAGE; load(); } }, "Next"));
    } catch (err) { clear(results, errorBox(err)); }
  }

  const table = (users) => h("div.table-wrap", h("table.table",
    h("thead", h("tr", h("th", "Name"), h("th.hide-sm", "Designation"), h("th", "Role"), h("th.hide-sm", "Status"), h("th.hide-md", "Joined"), h("th"))),
    h("tbody", users.map((u) => h(`tr${u.is_active ? "" : ".inactive"}`,
      h("td", h("div.user-chip", avatar(u, "sm"), h("div", h("div", u.name), h("div.muted.small", u.email)))),
      h("td.hide-sm.muted", u.designation || "—"),
      h("td", h(`span.badge${u.role === "admin" ? ".accent" : ""}`, label(u.role))),
      h("td.hide-sm", u.is_active ? h("span.badge.ok", "Active") : h("span.badge", "Deactivated")),
      h("td.hide-md.muted", fmtDate(u.created_at)),
      h("td.right",
        h("a.btn.sm.ghost", { href: `#/reports/${u.id}` }, "Report"),
        h("button.btn.sm", { onclick: () => userDialog(u, load) }, "Edit")))))));

  let timer;
  clear(main,
    h("div.page-head",
      h("h1", "People"),
      h("div.actions", h("button.btn.primary", { onclick: () => userDialog(null, load) }, "Add person"))),
    h("div.card.filters-card", h("div.filters",
      h("input", { type: "search", placeholder: "Search name or e-mail", "aria-label": "Search", oninput: (e) => { clearTimeout(timer); timer = setTimeout(() => { state.q = e.target.value.trim(); state.offset = 0; load(); }, 250); } }),
      select("role", [["", "Any role"], ["admin", "Admin"], ["user", "User"]], "", { "aria-label": "Role", onchange: (e) => { state.role = e.target.value; state.offset = 0; load(); } }),
      select("active", [["true", "Active"], ["false", "Deactivated"], ["", "Everyone"]], "true", { "aria-label": "Status", onchange: (e) => { state.active = e.target.value; state.offset = 0; load(); } }))),
    results, pager);
  await load();
}

function userDialog(user, onSaved) {
  const editing = Boolean(user);
  const self = editing && user.id === auth.user.id;
  const form = h("form.form",
    h("div.grid-2.tight",
      field("Name", h("input", { name: "name", required: true, maxLength: 120, value: user?.name || "" })),
      field("E-mail", h("input", { name: "email", type: "email", required: !editing, disabled: editing, value: user?.email || "" }))),
    field("Designation", h("input", { name: "designation", maxLength: 120, value: user?.designation || "", placeholder: "e.g. Senior Developer" })),
    h("div.grid-2.tight",
      field("Global role", select("role", [["user", "User"], ["admin", "Admin"]], user?.role || "user", { disabled: self }),
        "Admins see everything. Project roles are set per project."),
      field(editing ? "Reset password" : "Password",
        h("input", { name: "password", type: "password", minLength: 8, maxLength: 72, required: !editing, autocomplete: "new-password", placeholder: editing ? "Leave blank to keep" : "" }),
        "8–72 characters")),
    editing && !self && h("label.check", h("input", { type: "checkbox", name: "is_active", checked: user.is_active }), "Account active"),
    h("div.form-actions", h("button.btn.primary", { type: "submit" }, editing ? "Save" : "Create")));

  const m = modal(editing ? `Edit ${user.name}` : "Add person", form);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const d = formData(form);
    const body = { name: d.name, designation: d.designation || null };
    if (!self) body.role = d.role;
    if (d.password) body.password = d.password;
    if (editing && !self) body.is_active = d.is_active;
    if (!editing) body.email = d.email;
    busy(form.querySelector("[type=submit]"), async () => {
      if (editing) await api.patch(`/users/${user.id}`, body);
      else await api.post("/users", body);
      m.close();
      toast(editing ? "Saved" : `${d.name} can now sign in`);
      onSaved();
    });
  });
}
