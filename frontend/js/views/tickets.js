import { api } from "../api.js";
import { clear, h } from "../ui.js";
import { filteredTicketList } from "./ticketlist.js";

export async function renderTickets(main) {
  // Everyone the caller may see: admins get all active users, others the people they share a project with.
  const [projects, people] = await Promise.all([api.get("/projects"), api.get("/users/lookup", { limit: 50 })]);
  const projectFilter = new URLSearchParams(location.hash.split("?")[1] || "").get("project") || "";

  const body = h("div");
  const mount = (projectId) => clear(body, filteredTicketList({
    endpoint: "/tickets",
    assignees: people.map((u) => [String(u.id), u.name]),
    extraParams: { project_id: projectId || undefined },
  }));

  const projectSelect = h("select", {
    "aria-label": "Project",
    onchange: (e) => mount(e.target.value),
  }, h("option", { value: "" }, "All projects"),
  projects.map((p) => h("option", { value: p.id, selected: String(p.id) === projectFilter }, `${p.key} · ${p.name}`)));

  clear(main,
    h("div.page-head",
      h("h1", "Tickets"),
      h("div.actions",
        projectSelect)),
    body);
  mount(projectFilter);
}
