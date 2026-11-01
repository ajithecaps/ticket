// Project files: a folder tree of shared documents per project, plus every ticket attachment in one
// "Ticket attachments" folder. Also the picker that attaches project files to a ticket.
import { api } from "../api.js";
import { icon } from "../icons.js";
import { currentQuery, setQuery } from "../app.js";
import { downloadFile, fileThumb, files as previewFiles, openPreview } from "../preview.js";
import { busy, clear, confirmDialog, emptyState, field, fmtBytes, h, modal, spinner, timeAgo, toast } from "../ui.js";

const TICKET_FOLDER = "tickets";

/** The Files tab of a project. `folder` in the URL query keeps your place on reload. */
export async function renderProjectFiles(container, project, { query = {}, fresh = false } = {}) {
  const q0 = fresh ? new URLSearchParams() : currentQuery();
  const state = { folder: q0.get("folder") || "", q: q0.get("q") || "" };
  const body = h("div.files-body");
  const input = h("input", { type: "file", multiple: true, hidden: true });
  let listing = null;
  let seq = 0;

  const search = h("input", {
    type: "search", value: state.q, placeholder: "Search files and folders", "aria-label": "Search files",
    oninput: debounce(() => { state.q = search.value.trim(); load(); }, 250),
  });
  const newFolderBtn = h("button.btn", { type: "button", onclick: () => newFolder() }, icon("folder-plus", { size: 15 }), "New folder");
  const uploadBtn = h("button.btn.primary", { type: "button", onclick: () => input.click() }, icon("upload", { size: 15 }), "Upload");
  input.addEventListener("change", () => { upload(input.files); input.value = ""; });

  // drop files anywhere on the section
  const zone = h("div.files-zone",
    h("div.row.wrap.files-toolbar", h("label.search-box", icon("search", { size: 15 }), search), h("div.row.files-actions", newFolderBtn, uploadBtn)),
    body, input,
    h("div.files-drop-hint", icon("upload", { size: 28 }), h("strong", "Drop to upload here")));
  let depth = 0;
  zone.addEventListener("dragenter", (e) => { if (canUpload() && hasFiles(e)) { depth++; zone.classList.add("dragging"); } });
  zone.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; zone.classList.remove("dragging"); } });
  zone.addEventListener("dragover", (e) => { if (canUpload() && hasFiles(e)) e.preventDefault(); });
  zone.addEventListener("drop", (e) => {
    depth = 0; zone.classList.remove("dragging");
    if (!canUpload() || !hasFiles(e)) return;
    e.preventDefault();
    upload(e.dataTransfer.files);
  });

  const canUpload = () => !state.q && state.folder !== TICKET_FOLDER;

  async function load() {
    const mine = ++seq;
    setQuery({ ...query, folder: state.folder, q: state.q });
    newFolderBtn.hidden = uploadBtn.hidden = !canUpload();
    clear(body, spinner(3));
    if (state.folder === TICKET_FOLDER && !state.q) {
      const items = await api.get(`/projects/${project.id}/ticket-attachments`);
      if (mine !== seq) return;
      return drawTicketFiles(items);
    }
    listing = await api.get(`/projects/${project.id}/files`, { folder_id: state.folder || undefined, q: state.q || undefined });
    if (mine !== seq) return;
    draw();
  }
  const open = (folder) => { state.folder = folder === null ? "" : String(folder); state.q = ""; search.value = ""; load(); };

  function crumbs(path, extra) {
    return h("nav.files-crumbs", { "aria-label": "Folder path" },
      h("button.link-btn", { type: "button", onclick: () => open(null) }, icon("folder", { size: 15 }), "Files"),
      path.map((c, i) => [h("span.sep", "/"), i === path.length - 1 && !extra
        ? h("strong", c.name) : h("button.link-btn", { type: "button", onclick: () => open(c.id) }, c.name)]),
      extra ? [h("span.sep", "/"), h("strong", extra)] : null);
  }

  function draw() {
    const { folders, files } = listing;
    const sources = files.map((f) => previewFiles.projectFile(f, `${f.uploader.name} · ${timeAgo(f.created_at)}`));
    const rows = [
      !state.q && !state.folder && listing.ticket_attachment_count > 0 && h("tr.files-row.folder.special", { onclick: () => open(TICKET_FOLDER) },
        h("td.files-name", h("span.files-ic.tickets", icon("paperclip", { size: 18 })), h("div", h("strong", "Ticket attachments"), h("span.muted.small", "Every file attached to this project's tickets"))),
        h("td.hide-sm.muted.small", `${listing.ticket_attachment_count} file${listing.ticket_attachment_count === 1 ? "" : "s"}`),
        h("td.hide-sm"), h("td.hide-sm"), h("td")),
      ...folders.map((f) => h("tr.files-row.folder", { onclick: (e) => { if (!e.target.closest("button")) open(f.id); } },
        h("td.files-name", h("span.files-ic", icon("folder", { size: 18 })), h("div", h("strong", f.name),
          state.q && f.parent_id ? h("span.muted.small", "in a subfolder") : null)),
        h("td.hide-sm.muted.small", countText(f)),
        h("td.hide-sm.muted.small", f.creator?.name || "—"),
        h("td.hide-sm.muted.small", timeAgo(f.created_at)),
        h("td.right.files-row-actions", f.can_edit && [
          iconBtn("edit", `Rename ${f.name}`, () => renameFolder(f)),
          iconBtn("folder-move", `Move ${f.name}`, () => moveDialog({ folder: f })),
          iconBtn("trash", `Delete ${f.name}`, () => deleteFolder(f), ".danger")]))),
      ...files.map((f, i) => h("tr.files-row", { onclick: (e) => { if (!e.target.closest("button")) openPreview(sources, i); } },
        h("td.files-name", fileThumb(sources[i], { size: 34 }), h("div",
          h("span.files-filename", f.filename),
          state.q && f.path.length ? h("button.link-btn.muted.small", { type: "button", onclick: (e) => { e.stopPropagation(); open(f.folder_id); } },
            `in ${f.path.map((c) => c.name).join(" / ")}`) : null)),
        h("td.hide-sm.muted.small", fmtBytes(f.size)),
        h("td.hide-sm.muted.small", f.uploader.name),
        h("td.hide-sm.muted.small", timeAgo(f.updated_at)),
        h("td.right.files-row-actions",
          iconBtn("download", `Download ${f.filename}`, () => downloadFile(sources[i])),
          f.can_edit && [
            iconBtn("edit", `Rename ${f.filename}`, () => renameFile(f)),
            iconBtn("folder-move", `Move ${f.filename}`, () => moveDialog({ file: f })),
            iconBtn("trash", `Delete ${f.filename}`, () => deleteFile(f), ".danger")]))),
    ].filter(Boolean);

    clear(body,
      state.q ? h("p.muted.small", `Results for “${state.q}” across the whole project`) : crumbs(listing.path),
      rows.length
        ? h("div.table-wrap.files-table", h("table.table",
          h("thead", h("tr", h("th", "Name"), h("th.hide-sm", state.q ? "" : "Size"), h("th.hide-sm", "Added by"), h("th.hide-sm", "Updated"), h("th"))),
          h("tbody", rows)))
        : state.q
          ? emptyState("Nothing found", "No file or folder name matches that search.", null, "search")
          : h("div.files-empty", { onclick: () => input.click(), role: "button", tabindex: 0 },
            icon("upload", { size: 26 }),
            h("strong", listing.folder ? "This folder is empty" : "No files yet"),
            h("span.muted.small", "Drop files here or click to upload. Use folders to keep specs, designs and documents tidy.")));
  }

  function drawTicketFiles(items) {
    const sources = items.map((a) => previewFiles.attachment(a, `${a.ticket_key} · ${a.uploader.name}`));
    clear(body,
      crumbs([], "Ticket attachments"),
      items.length
        ? h("div.table-wrap.files-table", h("table.table",
          h("thead", h("tr", h("th", "Name"), h("th.hide-sm", "Ticket"), h("th.hide-sm", "Added by"), h("th.hide-sm", "Added"), h("th"))),
          h("tbody", items.map((a, i) => h("tr.files-row", { onclick: (e) => { if (!e.target.closest("a,button")) openPreview(sources, i); } },
            h("td.files-name", fileThumb(sources[i], { size: 34 }), h("div", h("span.files-filename", a.filename), h("span.muted.small", fmtBytes(a.size)))),
            h("td.hide-sm", h("a.files-ticket", { href: `#/tickets/${a.ticket_key}` }, h("span.key", a.ticket_key), h("span.ellipsis", a.ticket_title))),
            h("td.hide-sm.muted.small", a.uploader.name),
            h("td.hide-sm.muted.small", timeAgo(a.created_at)),
            h("td.right.files-row-actions", iconBtn("download", `Download ${a.filename}`, () => downloadFile(sources[i]))))))))
        : emptyState("No ticket attachments", "Files attached to this project's tickets show up here.", null, "paperclip"));
  }

  // ---- actions
  async function upload(fileList) {
    const list = [...(fileList || [])];
    if (!list.length) return;
    const chunks = [];
    for (let i = 0; i < list.length; i += 10) chunks.push(list.slice(i, i + 10)); // server takes 10 per request
    await busy(uploadBtn, async () => {
      for (const chunk of chunks) {
        const fd = new FormData();
        chunk.forEach((f) => fd.append("files", f));
        if (state.folder) fd.append("folder_id", state.folder);
        await api.upload(`/projects/${project.id}/files`, fd);
      }
      toast(`Uploaded ${list.length} file${list.length > 1 ? "s" : ""}`);
      await load();
    });
  }

  function nameDialog(title, value, submitText, onSave) {
    const name = h("input", { value, required: true, maxLength: 120, autocomplete: "off" });
    const form = h("form.form", field("Name", name), h("div.form-actions", h("button.btn.primary", { type: "submit" }, submitText)));
    const m = modal(title, form);
    setTimeout(() => { name.focus(); const dot = value.lastIndexOf("."); name.setSelectionRange(0, dot > 0 ? dot : value.length); });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      busy(form.querySelector("[type=submit]"), async () => { await onSave(name.value.trim()); m.close(); await load(); });
    });
  }
  const newFolder = () => nameDialog("New folder", "", "Create", async (name) => {
    await api.post(`/projects/${project.id}/folders`, { name, parent_id: state.folder ? Number(state.folder) : null });
    toast(`Folder ${name} created`);
  });
  const renameFolder = (f) => nameDialog("Rename folder", f.name, "Rename", (name) => api.patch(`/folders/${f.id}`, { name }));
  const renameFile = (f) => nameDialog("Rename file", f.filename, "Rename", (filename) => api.patch(`/files/${f.id}`, { filename }));

  async function deleteFolder(f) {
    const inside = f.folder_count + f.file_count;
    if (!(await confirmDialog("Delete folder", `Delete ${f.name}${inside ? " and everything inside it" : ""}? This can't be undone.`))) return;
    await busy(null, async () => { await api.del(`/folders/${f.id}`); toast(`${f.name} deleted`); await load(); });
  }
  async function deleteFile(f) {
    if (!(await confirmDialog("Delete file", `Delete ${f.filename}? This can't be undone.`))) return;
    await busy(null, async () => { await api.del(`/files/${f.id}`); toast(`${f.filename} deleted`); await load(); });
  }

  async function moveDialog({ folder, file }) {
    const all = await api.get(`/projects/${project.id}/folders`);
    // a folder can't go inside itself or its own subfolders
    const blocked = new Set();
    if (folder) {
      blocked.add(folder.id);
      let grew = true;
      while (grew) { grew = false; all.forEach((x) => { if (blocked.has(x.parent_id) && !blocked.has(x.id)) { blocked.add(x.id); grew = true; } }); }
    }
    const byParent = new Map();
    all.forEach((x) => { const k = x.parent_id ?? 0; if (!byParent.has(k)) byParent.set(k, []); byParent.get(k).push(x); });
    const options = [["", "Files (top level)"]];
    const walk = (parent, depth) => (byParent.get(parent) || []).forEach((x) => {
      if (blocked.has(x.id)) return;
      options.push([String(x.id), `${"   ".repeat(depth + 1)}${x.name}`]);
      walk(x.id, depth + 1);
    });
    walk(0, 0);
    const current = String((folder ? folder.parent_id : file.folder_id) ?? "");
    const sel = h("select", { "aria-label": "Destination" }, options.map(([v, text]) => h("option", { value: v, selected: v === current }, text)));
    const form = h("form.form", field("Move to", sel), h("div.form-actions", h("button.btn.primary", { type: "submit" }, "Move")));
    const m = modal(`Move ${folder ? folder.name : file.filename}`, form);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const target = sel.value ? Number(sel.value) : null;
      busy(form.querySelector("[type=submit]"), async () => {
        if (folder) await api.patch(`/folders/${folder.id}`, { parent_id: target });
        else await api.patch(`/files/${file.id}`, { folder_id: target });
        m.close();
        toast("Moved");
        await load();
      });
    });
  }

  clear(container, zone);
  await load();
}

function countText(f) {
  const parts = [];
  if (f.folder_count) parts.push(`${f.folder_count} folder${f.folder_count === 1 ? "" : "s"}`);
  if (f.file_count) parts.push(`${f.file_count} file${f.file_count === 1 ? "" : "s"}`);
  return parts.join(", ") || "Empty";
}

const iconBtn = (ic, label, onclick, cls = "") => h(`button.icon-btn.sm${cls}`, { type: "button", title: label, "aria-label": label, onclick }, icon(ic, { size: 15 }));
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// ----------------------------------------------------------------------------- pick for a ticket
/** Browse the project's files and attach copies of the picked ones to a ticket. */
export function attachFromFilesDialog(ticket, onDone) {
  const picked = new Map();
  const list = h("div.pick-list.files-pick");
  const crumbsEl = h("div.files-crumbs");
  const count = h("span.muted.small");
  const submit = h("button.btn.primary", { type: "submit", disabled: true }, "Attach");
  let folder = null;
  const search = h("input", { type: "search", placeholder: "Search the project's files", "aria-label": "Search files",
    oninput: debounce(() => load(), 250) });

  async function load() {
    clear(list, spinner(3));
    const q = search.value.trim();
    const l = await api.get(`/projects/${ticket.project.id}/files`, { folder_id: q ? undefined : folder || undefined, q: q || undefined });
    clear(crumbsEl, q ? h("span.muted.small", "Search results") : [
      h("button.link-btn", { type: "button", onclick: () => { folder = null; load(); } }, icon("folder", { size: 14 }), "Files"),
      l.path.map((c) => [h("span.sep", "/"), h("button.link-btn", { type: "button", onclick: () => { folder = c.id; load(); } }, c.name)])]);
    const rows = [
      ...l.folders.map((f) => h("button.pick-row.folder-pick", { type: "button", onclick: () => { folder = f.id; search.value = ""; load(); } },
        h("span.files-ic", icon("folder", { size: 16 })), h("span.grow", f.name), h("span.muted.small", countText(f)), icon("chevron-right", { size: 14 }))),
      ...l.files.map((f) => {
        const box = h("input", { type: "checkbox", checked: picked.has(f.id),
          onchange: () => { if (box.checked) picked.set(f.id, f); else picked.delete(f.id); sync(); } });
        return h("label.check.pick-row", box, fileThumb(previewFiles.projectFile(f), { size: 28 }),
          h("span.grow.ellipsis", f.filename), h("span.muted.small", fmtBytes(f.size)));
      }),
    ];
    clear(list, rows.length ? rows : h("p.muted.pad", q ? "No files match." : "No files here yet - add them in the project's Files tab."));
  }
  const sync = () => {
    submit.disabled = !picked.size;
    count.textContent = picked.size ? `${picked.size} selected` : "";
  };

  const form = h("form.form", h("label.search-box", icon("search", { size: 15 }), search), crumbsEl, list,
    h("div.form-actions.between", count, submit));
  const m = modal("Attach from project files", form, { wide: true });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    busy(submit, async () => {
      await api.post(`/tickets/${ticket.id}/attachments/from-files`, { file_ids: [...picked.keys()] });
      m.close();
      toast(`Attached ${picked.size} file${picked.size > 1 ? "s" : ""}`);
      await onDone?.();
    });
  });
  load();
}

// ----------------------------------------------------------------------------- sidebar page
/** "Files" in the sidebar: pick a project, then its files (same view as the project tab). */
export async function renderFilesPage(main) {
  const projects = (await api.get("/projects")).filter((p) => p.is_active);
  if (!projects.length) { clear(main, h("h1", "Files"), emptyState("No projects yet", "Files live inside projects - join one to share documents.", null, "folder")); return; }
  const want = currentQuery().get("project");
  let project = projects.find((p) => String(p.id) === want) || projects[0];
  const body = h("div");
  const sel = h("select", { "aria-label": "Project", onchange: () => {
    project = projects.find((p) => String(p.id) === sel.value);
    renderProjectFiles(body, project, { query: { project: project.id }, fresh: true });
  } }, projects.map((p) => h("option", { value: p.id, selected: p === project }, `${p.key} · ${p.name}`)));
  clear(main,
    h("div.page-head", h("div", h("h1", "Files"), h("p.muted", "Shared folders and documents for each project, plus every file attached to its tickets.")),
      h("div.actions", projects.length > 1 ? sel : null)),
    body);
  await renderProjectFiles(body, project, { query: { project: project.id }, fresh: String(project.id) !== want });
}
