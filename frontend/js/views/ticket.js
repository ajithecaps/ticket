import { api, auth } from "../api.js";
import { navigate } from "../app.js";
import { confirmIfOverlapping, fetchOverlaps, overlapCount } from "../overlaps.js";
import {
  PRIORITIES, STATUSES, TYPES, avatar, busy, clear, confirmDialog, copyText, field, markdownEditor, renderMarkdown, fmtBytes, fmtDate, fmtDateTime,
  fmtHours, formData, fromDateInput, fromStartInput, h, label, modal, priorityBadge, select, statusBadge, timeAgo,
  toDateInput, toast, typeBadge, userChip, userPicker,
} from "../ui.js";

// ----------------------------------------------------------------------------- create
/**
 * projects: [ProjectOut]; preselect: project id; ctx: {members, owner} when known.
 * Assignee can only be set by owners; for others the field is hidden.
 */
export function newTicketDialog(projects, preselect, ctx) {
  let assignee = null;
  const assigneeSlot = h("div");
  const startSlot = h("div");
  const overlapSlot = h("div");
  const startInput = h("input", { type: "date", name: "start_date", onchange: () => checkOverlap() });
  const dueInput = h("input", { type: "date", name: "due_date", onchange: () => checkOverlap() });
  let overlapReq = 0;
  async function checkOverlap() {
    const req = ++overlapReq;
    const ov = await fetchOverlaps(assignee, { start: fromStartInput(startInput.value), end: fromDateInput(dueInput.value) });
    if (req === overlapReq) overlapSlot.replaceChildren(...[overlapCount(ov)].filter(Boolean));
  }
  const projectSel = select("project", projects.map((p) => [String(p.id), `${p.key} · ${p.name}`]), preselect || projects[0]?.id, {
    onchange: () => drawAssignee(),
  });

  function drawAssignee() {
    assignee = null;
    const p = projects.find((x) => String(x.id) === projectSel.value);
    const isOwner = ctx ? ctx.owner : p && (p.my_role === "owner" || p.my_role === "admin");
    clear(assigneeSlot, isOwner && field("Assignee",
      userPicker((q) => api.get("/users/lookup", { q, project_id: p.id, limit: 10 }), (u) => { assignee = u; checkOverlap(); }, { allowNone: true, placeholder: "Unassigned" })));
    startInput.value = isOwner ? startInput.value : "";
    clear(startSlot, isOwner && field("Start date", startInput));
    checkOverlap();
  }

  const descEditor = markdownEditor({ rows: 7, label: "Description", placeholder: "Steps to reproduce, acceptance criteria, links… Markdown is supported." });
  const form = h("form.form",
    projects.length > 1 ? field("Project", projectSel) : null,
    field("Title", h("input", { name: "title", required: true, maxLength: 255, placeholder: "Short summary" })),
    h("div.field", h("span.field-label", "Description"), descEditor.el),
    h("div.grid-2.tight",
      field("Type", select("type", TYPES, "task")),
      field("Priority", select("priority", PRIORITIES, "medium"))),
    h("div.grid-3.tight",
      startSlot,
      field("Due date", dueInput),
      field("Estimate (hours)", h("input", { type: "number", name: "estimated_hours", min: 0, max: 10000, step: 0.5 }))),
    assigneeSlot,
    overlapSlot,
    h("div.form-actions", h("button.btn.primary", { type: "submit" }, "Create ticket")));
  drawAssignee();

  const m = modal("New ticket", form, { wide: true });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const d = formData(form);
    const body = {
      title: d.title, description: descEditor.value, type: d.type, priority: d.priority,
      due_date: fromDateInput(d.due_date),
      estimated_hours: d.estimated_hours === "" ? null : Number(d.estimated_hours),
    };
    if (startInput.value && startSlot.childElementCount) body.start_date = fromStartInput(startInput.value);
    if (assignee) body.assignee_id = assignee.id;
    busy(form.querySelector("[type=submit]"), async () => {
      const t = await api.post(`/projects/${projectSel.value}/tickets`, body);
      m.close();
      toast(`${t.key} created`);
      navigate(`/tickets/${t.key}`);
    });
  });
}

// ----------------------------------------------------------------------------- detail
export async function renderTicket(main, key) {
  let t = await api.get(`/tickets/by-key/${encodeURIComponent(key)}`);
  const isOwner = t.can_assign; // can_assign == project owner / admin

  const header = h("div");
  const sidebar = h("aside.ticket-side");
  const description = h("section.card");
  const tabsBody = h("div");
  let tab = "comments";

  const refresh = async () => {
    t = await api.get(`/tickets/${t.id}`);
    drawHeader(); drawSidebar(); drawDescription();
  };

  // ---- header: title + status actions
  function drawHeader() {
    const titleEl = h("h1.ticket-title", t.title);
    if (t.can_edit) {
      titleEl.classList.add("editable");
      titleEl.title = "Click to edit";
      titleEl.addEventListener("click", () => {
        const input = h("input.title-input", { value: t.title, maxLength: 255, "aria-label": "Title" });
        const save = async () => {
          const v = input.value.trim();
          if (v && v !== t.title) await busy(null, async () => { await api.patch(`/tickets/${t.id}`, { title: v }); await refresh(); });
          else drawHeader();
        };
        input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); if (e.key === "Escape") { input.value = t.title; input.blur(); } });
        input.addEventListener("blur", save);
        titleEl.replaceWith(input);
        input.focus();
        input.select();
      });
    }
    // Developers work up to "done"; only owners verify, and a verified ticket is locked for developers.
    const statusOptions = isOwner ? STATUSES : STATUSES.filter((s) => s !== "verified");
    const statusSel = t.can_change_status && (isOwner || t.status !== "verified")
      ? select("status", statusOptions, t.status, {
        class: `status-select status-${t.status}`, "aria-label": "Status",
        onchange: (e) => busy(e.target, async () => {
          try {
            await api.post(`/tickets/${t.id}/status`, { status: e.target.value });
            toast(`Moved to ${label(e.target.value)}`);
          } finally { await refresh(); loadTab(); }
        }),
      })
      : statusBadge(t.status);

    clear(header,
      h("div.crumbs",
        h("a", { href: `#/projects/${t.project.id}` }, t.project.name), " / ",
        h("span.key", t.key),
        h("button.icon-btn.copy", { title: "Copy link", "aria-label": "Copy link", onclick: () => copyText(ticketUrl(), "Link copied") }, "⧉"),
        h("button.btn.ghost.sm.copy-key", { title: "Copy key and title", onclick: () => copyText(`${t.key} ${t.title}`, `${t.key} copied`) }, "Copy key")),
      h("div.ticket-head",
        h("div.ticket-head-main", titleEl,
          h("div.row.wrap", typeBadge(t.type), priorityBadge(t.priority),
            t.is_overdue && h("span.badge.danger", "Overdue"),
            t.reopen_count > 0 && h("span.badge", { title: "Times moved out of Done" }, `Reopened ×${t.reopen_count}`))),
        h("div.ticket-head-actions", statusSel,
          t.can_delete && h("button.btn.ghost.danger.sm", { onclick: del }, "Delete"))),
      verificationBanner());
  }

  const ticketUrl = () => `${location.origin}${location.pathname}#/tickets/${t.key}`;

  function verificationBanner() {
    if (t.status === "verified") {
      return h("div.banner.verified", h("span.banner-icon", "✓"),
        h("div", h("strong", "Verified"), h("span.muted", " · checked and closed by the project owner")));
    }
    if (t.status !== "done") return null;
    if (!t.can_verify) {
      return h("div.banner.pending", h("span.banner-icon", "⏳"),
        h("div", h("strong", "Waiting for verification"), h("span.muted", " · a project owner will cross-check this work")));
    }
    return h("div.banner.pending",
      h("span.banner-icon", "⏳"),
      h("div.grow", h("strong", "Ready for verification"),
        h("div.muted", `${t.assignee ? t.assignee.name : "The assignee"} marked this done. Check the work, then verify it or send it back.`)),
      h("div.row.wrap",
        h("button.btn.sm", { onclick: sendBack }, "Send back"),
        h("button.btn.sm.success", {
          onclick: (e) => busy(e.currentTarget, async () => {
            await api.post(`/tickets/${t.id}/status`, { status: "verified" });
            toast(`${t.key} verified`);
            await refresh(); loadTab();
          }),
        }, "✓ Verify")));
  }

  function sendBack() {
    const reason = markdownEditor({ rows: 5, label: "Reason", placeholder: "What still needs to be fixed? (posted as a comment)", autofocus: true });
    const statusSel2 = select("status", [["in_progress", "In progress"], ["todo", "To do"], ["blocked", "Blocked"]], "in_progress");
    const form = h("form.form",
      h("p.muted", `${t.key} goes back to the assignee and counts as a reopen in the efficiency report.`),
      h("div.field", h("span.field-label", "What needs fixing"), reason.el),
      field("Move to", statusSel2),
      h("div.form-actions", h("button.btn.primary", { type: "submit" }, "Send back")));
    const m = modal("Send back for rework", form, { wide: true });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      busy(form.querySelector("[type=submit]"), async () => {
        if (reason.value.trim()) {
          await api.post(`/tickets/${t.id}/comments`, { body: `**Sent back for rework**\n\n${reason.value.trim()}`, mention_user_ids: t.assignee ? [t.assignee.id] : [] });
        }
        await api.post(`/tickets/${t.id}/status`, { status: statusSel2.value });
        m.close();
        toast(`${t.key} sent back`);
        await refresh(); loadTab();
      });
    });
  }

  async function del() {
    if (!(await confirmDialog("Delete ticket", `Delete ${t.key} permanently, including its comments and files?`))) return;
    await busy(null, async () => {
      await api.del(`/tickets/${t.id}`);
      toast(`${t.key} deleted`);
      navigate(`/projects/${t.project.id}`);
    });
  }

  // ---- description
  function drawDescription() {
    const view = () => clear(description,
      h("div.card-head", h("h2", "Description"), t.can_edit && h("button.btn.sm.ghost", { onclick: edit }, "Edit")),
      t.description ? renderMarkdown(t.description) : h("p.muted", t.can_edit ? "No description yet. Click Edit to add one." : "No description."));
    const edit = () => {
      const editor = markdownEditor({ value: t.description, rows: 12, label: "Description", autofocus: true });
      clear(description,
        h("div.card-head", h("h2", "Description")),
        editor.el,
        h("div.form-actions",
          h("button.btn", { onclick: view }, "Cancel"),
          h("button.btn.primary", {
            onclick: (e) => busy(e.currentTarget, async () => { await api.patch(`/tickets/${t.id}`, { description: editor.value }); await refresh(); }),
          }, "Save")));
    };
    view();
  }

  // ---- sidebar: people, dates, estimates (each editable per permission)
  function drawSidebar() {
    const canOwner = isOwner;
    const canEstimate = isOwner || t.assignee?.id === auth.user.id;

    const patch = (body) => busy(null, async () => { await api.patch(`/tickets/${t.id}`, body); await refresh(); loadTab(); });

    const assigneeCell = canOwner
      ? h("div.inline-edit",
        userPicker((q) => api.get("/users/lookup", { q, project_id: t.project.id, limit: 10 }), (u) => {
          if ((u?.id ?? null) === (t.assignee?.id ?? null)) return;
          busy(null, async () => {
            if (u && !(await confirmIfOverlapping(u, { start: t.start_date, end: t.due_date, excludeId: t.id }))) {
              drawSidebar(); // back to the current assignee
              return;
            }
            await api.post(`/tickets/${t.id}/assign`, { assignee_id: u ? u.id : null });
            toast(u ? `Assigned to ${u.name}` : "Unassigned");
            await refresh(); loadTab();
          });
        }, { allowNone: true, initial: t.assignee, placeholder: "Unassigned" }),
        t.status === "done" && h("span.hint", "Reopen the ticket before reassigning."))
      : userChip(t.assignee);

    const meAssign = canOwner && t.assignee?.id !== auth.user.id && t.status !== "done" &&
      h("button.link.small", {
        onclick: () => busy(null, async () => {
          if (!(await confirmIfOverlapping(auth.user, { start: t.start_date, end: t.due_date, excludeId: t.id }))) return;
          await api.post(`/tickets/${t.id}/assign`, { assignee_id: auth.user.id }); toast("Assigned to you"); await refresh(); loadTab();
        }),
      }, "Assign to me");

    const row = (name, value) => h("div.prop", h("span.prop-label", name), h("div.prop-value", value));

    // The current assignee's other work in the same days (owners, or the assignee looking at their own ticket).
    const clashSlot = h("div.clash-slot");
    if (t.assignee && t.due_date && !["done", "verified"].includes(t.status) && (canOwner || t.assignee.id === auth.user.id)) {
      fetchOverlaps(t.assignee, { start: t.start_date, end: t.due_date, excludeId: t.id })
        .then((ov) => clashSlot.replaceChildren(...[overlapCount(ov)].filter(Boolean)));
    }

    clear(sidebar, h("div.card.props",
      row("Assignee", [assigneeCell, meAssign, clashSlot]),
      row("Reporter", userChip(t.reporter)),
      t.release && row("Release", h("a.badge.rel-chip", { href: `#/releases/${t.release.id}` },
        t.release.status === "released" ? `🚀 ${t.release.name} · released ${fmtDate(t.release.released_at)}` : `${t.release.name} · planned`)),
      row("Type", t.can_edit ? select("type", TYPES, t.type, { "aria-label": "Type", onchange: (e) => patch({ type: e.target.value }) }) : label(t.type)),
      row("Priority", canOwner ? select("priority", PRIORITIES, t.priority, { "aria-label": "Priority", onchange: (e) => patch({ priority: e.target.value }) }) : priorityBadge(t.priority)),
      row("Start date", canOwner
        ? h("input", { type: "date", value: toDateInput(t.start_date), "aria-label": "Start date", onchange: (e) => patch({ start_date: fromStartInput(e.target.value) }) })
        : h("span", t.start_date ? fmtDate(t.start_date) : h("span.muted", "Not planned"))),
      row("Due date", canOwner
        ? h("input", { type: "date", value: toDateInput(t.due_date), "aria-label": "Due date", onchange: (e) => patch({ due_date: fromDateInput(e.target.value) }) })
        : h(`span${t.is_overdue ? ".danger-text" : ""}`, fmtDate(t.due_date))),
      row("Estimate", canEstimate
        ? h("input", {
          type: "number", min: 0, max: 10000, step: 0.5, value: t.estimated_hours ?? "", placeholder: "hours", "aria-label": "Estimated hours",
          onchange: (e) => patch({ estimated_hours: e.target.value === "" ? null : Number(e.target.value) }),
        })
        : fmtHours(t.estimated_hours)),
      row("Time spent", h("span", fmtHours(t.spent_hours),
        t.estimated_hours ? h("span.muted", ` of ${fmtHours(t.estimated_hours)}`) : null)),
      t.estimated_hours ? h("div.progress", { "aria-hidden": "true" }, h("span", { style: { width: `${Math.min(100, (t.spent_hours / t.estimated_hours) * 100)}%` }, class: t.spent_hours > t.estimated_hours ? "over" : "" })) : null,
    ),
    h("div.card.props.dates",
      row("Created", h("span", { title: fmtDateTime(t.created_at) }, timeAgo(t.created_at))),
      row("Updated", h("span", { title: fmtDateTime(t.updated_at) }, timeAgo(t.updated_at))),
      t.assigned_at && row("Assigned", fmtDateTime(t.assigned_at)),
      t.started_at && row("Started", fmtDateTime(t.started_at)),
      t.completed_at && row("Completed", fmtDateTime(t.completed_at))));
  }

  // ---- tabs: comments / files / work log / activity
  const tabNav = h("nav.tabs.small");
  function drawTabNav() {
    clear(tabNav, [["comments", `Comments (${t.comment_count})`], ["files", `Files (${t.attachment_count})`], ["worklog", "Work log"], ["activity", "History"]].map(([k, text]) =>
      h(`button${k === tab ? ".active" : ""}`, { type: "button", "aria-pressed": String(k === tab), onclick: () => { tab = k; loadTab(); } }, text)));
  }

  async function loadTab() {
    drawTabNav();
    try {
      if (tab === "comments") await comments(tabsBody, t, async () => { await refresh(); drawTabNav(); });
      else if (tab === "files") await files(tabsBody, t, async () => { await refresh(); drawTabNav(); });
      else if (tab === "worklog") await worklog(tabsBody, t, isOwner, refresh);
      else await activity(tabsBody, t);
    } catch (err) { toast(err.message, "error"); }
  }

  drawHeader(); drawSidebar(); drawDescription();
  clear(main, header, h("div.ticket-layout",
    h("div.ticket-main", description, h("section.card", tabNav, tabsBody)),
    sidebar));
  await loadTab();
}

// ----------------------------------------------------------------------------- comments
async function comments(el, t, onChange) {
  const list = await api.get(`/tickets/${t.id}/comments`);
  const canModerate = t.can_delete; // owners can delete anyone's comment

  const item = (c) => {
    const body = h("div.comment-body", renderMentions(c.body, c.mentions));

    const mine = c.author.id === auth.user.id;
    return h("article.comment",
      avatar(c.author),
      h("div.comment-main",
        h("div.comment-head",
          h("strong", c.author.name),
          h("span.muted.small", { title: fmtDateTime(c.created_at) }, timeAgo(c.created_at), c.edited_at ? " · edited" : ""),
          h("span.spacer"),
          mine && h("button.link.small", { onclick: () => editComment(c, body) }, "Edit"),
          (mine || canModerate) && h("button.link.small.danger-text", { onclick: () => deleteComment(c) }, "Delete")),
        body,
        c.attachments.length > 0 && h("div.files.inline", c.attachments.map((a) => fileChip(a)))));
  };

  function editComment(c, bodyEl) {
    const composer = mentionComposer(t, c.body, async (text, mentionIds) => {
      await api.patch(`/comments/${c.id}`, { body: text, mention_user_ids: mentionIds });
      await comments(el, t, onChange);
    }, { submitLabel: "Save", onCancel: () => comments(el, t, onChange) });
    bodyEl.replaceWith(composer);
    composer.querySelector("textarea.md-input").focus();
  }

  async function deleteComment(c) {
    if (!(await confirmDialog("Delete comment", "Delete this comment and any files attached to it?"))) return;
    await busy(null, async () => { await api.del(`/comments/${c.id}`); await onChange(); await comments(el, t, onChange); });
  }

  const composer = mentionComposer(t, "", async (text, mentionIds, fileList) => {
    const c = await api.post(`/tickets/${t.id}/comments`, { body: text, mention_user_ids: mentionIds });
    if (fileList.length) {
      const fd = new FormData();
      fileList.forEach((f) => fd.append("files", f));
      fd.append("comment_id", c.id);
      await api.upload(`/tickets/${t.id}/attachments`, fd);
    }
    await onChange();
    await comments(el, t, onChange);
  }, { withFiles: true });

  clear(el,
    list.length ? h("div.comments", list.map(item)) : h("p.muted.pad", "No comments yet. Start the conversation."),
    h("div.composer-wrap", avatar(auth.user), composer));
}

/** Render a comment as Markdown, then turn "@email" of resolved mentions into name pills. */
function renderMentions(body, mentions) {
  const el = renderMarkdown(body);
  const byEmail = new Map(mentions.map((m) => [m.email.toLowerCase(), m]));
  if (!byEmail.size) return el;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  // marked may autolink the e-mail part, so also look inside <a href="mailto:...">.
  el.querySelectorAll('a[href^="mailto:"]').forEach((a) => {
    const prev = a.previousSibling;
    const u = byEmail.get(a.textContent.toLowerCase());
    if (u && prev?.nodeType === 3 && prev.textContent.endsWith("@")) {
      prev.textContent = prev.textContent.slice(0, -1);
      a.replaceWith(h("span.mention", { title: u.email }, `@${u.name}`));
    }
  });
  for (const node of nodes) {
    if (!node.isConnected || node.parentElement?.closest("code, pre")) continue;
    const parts = node.textContent.split(/(@[\w.+-]+@[\w-]+(?:\.[\w-]+)+)/g);
    if (parts.length === 1) continue;
    node.replaceWith(...parts.map((p) => {
      const u = p.startsWith("@") && byEmail.get(p.slice(1).toLowerCase());
      return u ? h("span.mention", { title: u.email }, `@${u.name}`) : document.createTextNode(p);
    }));
  }
  return el;
}

/**
 * Textarea with @-autocomplete over project members. Selected people are inserted as
 * "@email" (which the API also detects) and sent as mention_user_ids.
 */
function mentionComposer(t, initial, onSubmit, { withFiles = false, submitLabel = "Comment", onCancel } = {}) {
  const editor = markdownEditor({ value: initial, rows: 4, label: "Comment", placeholder: "Write a comment… Markdown supported, type @ to mention someone" });
  const ta = editor.textarea;
  ta.maxLength = 10000;
  const pop = h("ul.picker-list.mention-pop", { role: "listbox" });
  const chosen = new Map();
  let pending = [];
  const fileInput = withFiles && h("input", { type: "file", multiple: true, hidden: true, onchange: () => { pending = [...fileInput.files]; drawFiles(); } });
  const fileList = h("div.tags");
  const drawFiles = () => clear(fileList, pending.map((f, i) =>
    h("span.tag", `📎 ${f.name}`, h("button", { type: "button", "aria-label": `Remove ${f.name}`, onclick: () => { pending.splice(i, 1); drawFiles(); } }, "×"))));

  let items = [];
  let active = 0;
  let range = null;
  let timer;

  const closePop = () => { pop.classList.remove("open"); range = null; };
  const drawPop = () => clear(pop, items.length
    ? items.map((u, i) => h(`li${i === active ? ".active" : ""}`, { onmousedown: (e) => { e.preventDefault(); insert(u); } }, avatar(u, "sm"), h("span", u.name), h("span.muted", u.email)))
    : h("li.muted.none", "No matching members"));

  function insert(u) {
    const before = ta.value.slice(0, range.start);
    const after = ta.value.slice(range.end);
    const token = `@${u.email} `;
    ta.value = before + token + after;
    const pos = before.length + token.length;
    ta.setSelectionRange(pos, pos);
    chosen.set(u.id, u);
    closePop();
    ta.focus();
  }

  ta.addEventListener("input", () => {
    const pos = ta.selectionStart;
    const m = ta.value.slice(0, pos).match(/(^|\s)@([^\s@]{0,40})$/);
    if (!m) return closePop();
    range = { start: pos - m[2].length - 1, end: pos };
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        items = await api.get("/users/lookup", { q: m[2], project_id: t.project.id, limit: 8 });
        active = 0;
        drawPop();
        pop.classList.add("open");
      } catch { closePop(); }
    }, 120);
  });
  // Capture phase so the mention popup gets Enter/arrows before the editor's list handling.
  ta.addEventListener("keydown", (e) => {
    if (pop.classList.contains("open") && items.length) {
      const handled = ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(e.key);
      if (e.key === "ArrowDown") { active = (active + 1) % items.length; drawPop(); }
      if (e.key === "ArrowUp") { active = (active - 1 + items.length) % items.length; drawPop(); }
      if (e.key === "Enter" || e.key === "Tab") insert(items[active]);
      if (e.key === "Escape") closePop();
      if (handled) { e.preventDefault(); e.stopImmediatePropagation(); return; }
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopImmediatePropagation(); form.requestSubmit(); }
  }, true);
  ta.addEventListener("blur", () => setTimeout(closePop, 120));

  const form = h("form.composer",
    h("div.composer-input", editor.el, pop),
    withFiles && fileList,
    h("div.row.between",
      h("div.row",
        withFiles && fileInput,
        withFiles && h("button.btn.sm.ghost", { type: "button", onclick: () => fileInput.click() }, "📎 Attach"),
        h("span.muted.small.hide-sm", "⌘/Ctrl + Enter to send")),
      h("div.row",
        onCancel && h("button.btn.sm", { type: "button", onclick: onCancel }, "Cancel"),
        h("button.btn.sm.primary", { type: "submit" }, submitLabel))));

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = ta.value.trim();
    if (!text) return;
    // Only keep picked users whose @email is still in the text.
    const ids = [...chosen.values()].filter((u) => text.includes(`@${u.email}`)).map((u) => u.id);
    busy(form.querySelector("[type=submit]"), async () => {
      await onSubmit(text, ids, pending);
      editor.value = "";
      pending = [];
      chosen.clear();
      if (withFiles) drawFiles();
    });
  });
  return form;
}

// ----------------------------------------------------------------------------- files
function fileChip(a, onDelete) {
  return h("div.file",
    h("button.link", { onclick: () => api.download(a).catch((err) => toast(err.message, "error")), title: "Download" }, `📄 ${a.filename}`),
    h("span.muted.small", `${fmtBytes(a.size)} · ${a.uploader.name} · ${timeAgo(a.created_at)}`),
    onDelete && h("button.icon-btn.small", { "aria-label": `Delete ${a.filename}`, onclick: () => onDelete(a) }, "✕"));
}

async function files(el, t, onChange) {
  const list = await api.get(`/tickets/${t.id}/attachments`);
  const input = h("input", { type: "file", multiple: true, hidden: true });
  const drop = h("div.dropzone", { tabindex: 0, role: "button", onclick: () => input.click(), onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") input.click(); } },
    h("strong", "Drop files here or click to upload"),
    h("span.muted.small", "Up to 10 files per upload, 10 MB each (server limits apply)."));

  async function upload(fileList) {
    if (!fileList.length) return;
    const fd = new FormData();
    [...fileList].forEach((f) => fd.append("files", f));
    drop.classList.add("busy");
    try {
      await api.upload(`/tickets/${t.id}/attachments`, fd);
      toast(`Uploaded ${fileList.length} file${fileList.length > 1 ? "s" : ""}`);
      await onChange();
      await files(el, t, onChange);
    } catch (err) { toast(err.message, "error"); } finally { drop.classList.remove("busy"); }
  }
  input.addEventListener("change", () => upload(input.files));
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); upload(e.dataTransfer.files); });

  const remove = async (a) => {
    if (!(await confirmDialog("Delete file", `Delete ${a.filename}?`))) return;
    await busy(null, async () => { await api.del(`/attachments/${a.id}`); await onChange(); await files(el, t, onChange); });
  };

  clear(el, drop, input,
    list.length
      ? h("div.files", list.map((a) => fileChip(a, a.uploader.id === auth.user.id || t.can_delete ? remove : null)))
      : h("p.muted.pad", "No files attached."));
}

// ----------------------------------------------------------------------------- work log
async function worklog(el, t, isOwner, onChange) {
  const logs = await api.get(`/tickets/${t.id}/worklogs`);
  const form = h("form.row.wrap.worklog-form",
    h("input", { type: "number", name: "hours", min: 0.25, max: 24, step: 0.25, required: true, placeholder: "Hours", "aria-label": "Hours" }),
    h("input.grow", { name: "note", maxLength: 500, placeholder: "What did you work on?", "aria-label": "Note" }),
    h("button.btn.primary.sm", { type: "submit" }, "Log time"));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const d = formData(form);
    busy(form.querySelector("[type=submit]"), async () => {
      await api.post(`/tickets/${t.id}/worklogs`, { hours: Number(d.hours), note: d.note });
      toast("Time logged");
      await onChange();
      await worklog(el, t, isOwner, onChange);
    });
  });

  const del = (w) => busy(null, async () => {
    await api.del(`/worklogs/${w.id}`);
    await onChange();
    await worklog(el, t, isOwner, onChange);
  });

  clear(el, form,
    logs.length
      ? h("ul.worklogs", logs.map((w) => h("li",
        avatar(w.user, "sm"),
        h("div.grow", h("strong", fmtHours(w.hours)), " ", h("span", w.user.name), w.note && h("div.muted", w.note)),
        h("span.muted.small", { title: fmtDateTime(w.logged_at) }, timeAgo(w.logged_at)),
        (w.user.id === auth.user.id || isOwner) && h("button.icon-btn.small", { "aria-label": "Delete entry", onclick: () => del(w) }, "✕"))))
      : h("p.muted.pad", "No time logged yet."));
}

// ----------------------------------------------------------------------------- activity
const ACTIONS = {
  created: () => "created the ticket",
  updated: (a) => `changed ${a.field?.replace("_", " ")}`,
  status_changed: () => "changed status",
  assigned: () => "assigned",
  unassigned: () => "unassigned",
  reassigned: () => "reassigned",
  commented: () => "commented",
  attachment_added: () => "attached",
  attachment_removed: () => "removed attachment",
  time_logged: (a) => `logged ${fmtHours(Number(a.new_value))}`,
  overdue_alert: () => "flagged the ticket as overdue",
  converted: (a) => `created this ticket from the upcoming task "${a.new_value}"`,
  release_added: (a) => `moved it into release ${a.new_value}`,
  release_removed: (a) => `took it out of release ${a.old_value}`,
  released: (a) => `released it to production in ${a.new_value}`,
};

function prettyValue(field, v, people) {
  if (v === null || v === undefined || v === "") return h("span.muted", "none");
  if (field === "assignee") return people.get(Number(v)) || `user #${v}`;
  if (field === "status") return statusBadge(v);
  if (field === "priority") return priorityBadge(v);
  if (field === "due_date") return fmtDate(v);
  if (field === "description") return v.length > 60 ? `${v.slice(0, 60)}…` : v;
  return label(v);
}

async function activity(el, t) {
  const [items, members] = await Promise.all([
    api.get(`/tickets/${t.id}/activity`),
    api.get("/users/lookup", { project_id: t.project.id, limit: 50 }),
  ]);
  const people = new Map(members.map((u) => [u.id, u.name]));
  [t.reporter, t.assignee].forEach((u) => u && people.set(u.id, u.name));
  const shown = (a) => !["time_logged", "overdue_alert", "converted", "release_added", "release_removed", "released"].includes(a.action)
    && (a.old_value || a.new_value);
  clear(el, items.length
    ? h("ol.timeline", items.map((a) => h("li",
      avatar(a.actor, "sm"),
      h("div",
        h("strong", a.actor?.name || "System"), " ",
        (ACTIONS[a.action] || (() => a.action.replace(/_/g, " ")))(a),
        shown(a) && h("span.change", " ", a.old_value ? prettyValue(a.field, a.old_value, people) : null, a.old_value ? " → " : null, prettyValue(a.field, a.new_value, people)),
        h("div.muted.small", { title: fmtDateTime(a.created_at) }, timeAgo(a.created_at))))))
    : h("p.muted.pad", "No history yet."));
}
