import { api } from "../api.js";
import { clear, h } from "../ui.js";
import { filteredTicketList } from "./ticketlist.js";
import { newTicketDialog } from "./ticket.js";

export async function renderTickets(main) {
  const projects = await api.get("/projects");
  const projectFilter = new URLSearchParams(location.hash.split("?")[1] || "").get("project") || "";

  const body = h("div");
  const mount = (projectId) => clear(body, filteredTicketList({
    endpoint: "/tickets",
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
        projectSelect,
        projects.length > 0 && h("button.btn.primary", { onclick: () => newTicketDialog(projects, projectSelect.value) }, "New ticket"))),
    body);
  mount(projectFilter);
}
