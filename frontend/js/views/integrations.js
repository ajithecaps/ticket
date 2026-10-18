import { api } from "../api.js";
import { busy, clear, confirmDialog, h, toast } from "../ui.js";
import { icon } from "../icons.js";

/** Turn Slack mrkdwn (*bold*, _italic_, <url|text>, emoji codes) into readable DOM for the preview. */
function slackPreview(text) {
  const EMOJI = {
    ":sunrise:": "🌅", ":white_check_mark:": "✅", ":warning:": "⚠️", ":alarm_clock:": "⏰", ":wave:": "👋",
  };
  const unescape = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const inline = (line) => {
    const out = [];
    const re = /<([^|>]+)\|([^>]+)>|\*([^*]+)\*|_([^_]+)_|(:[a-z0-9_+-]+:)/g;
    let last = 0;
    let m;
    while ((m = re.exec(line))) {
      if (m.index > last) out.push(unescape(line.slice(last, m.index)));
      if (m[1]) out.push(h("a", { href: m[1], target: "_blank", rel: "noopener" }, unescape(m[2])));
      else if (m[3]) out.push(h("strong", unescape(m[3])));
      else if (m[4]) out.push(h("em", unescape(m[4])));
      else out.push(EMOJI[m[5]] || m[5]);
      last = re.lastIndex;
    }
    if (last < line.length) out.push(unescape(line.slice(last)));
    return out;
  };
  return h("div.slack-preview", text.split("\n").map((line) => h("div", line ? inline(line) : " ")));
}

const TYPE_LABELS = {
  ticket_created: ["Ticket created", "A ticket is raised in a project"],
  assigned: ["Assigned", "Someone is given a ticket"],
  unassigned: ["Unassigned", "A ticket is taken off someone"],
  status_changed: ["Status changed", "Moves, including done / verified"],
  ticket_updated: ["Ticket updated", "Title, priority, dates, estimate…"],
  comment: ["Comments", "New comments on a ticket"],
  mention: ["Mentions", "Someone is @mentioned"],
  project_member: ["Project members", "People added to projects"],
  overdue: ["Overdue alerts", "Tickets that pass their due date"],
  upcoming: ["Upcoming tasks", "Planned work added or marked ready"],
  release: ["Releases", "A release goes to production"],
  sprint: ["Sprints", "A sprint starts or completes"],
};
const DAYS = [["mon", "Mon"], ["tue", "Tue"], ["wed", "Wed"], ["thu", "Thu"], ["fri", "Fri"], ["sat", "Sat"], ["sun", "Sun"]];
const ZONES = ["Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Asia/Tokyo", "Europe/London", "Europe/Berlin", "America/New_York", "America/Chicago", "America/Los_Angeles", "Australia/Sydney", "UTC"];

function sourceTag(status, key) {
  const src = status.sources?.[key];
  return src === "panel"
    ? h("span.src-tag.panel", { title: "Saved on this page" }, "Saved here")
    : h("span.src-tag", { title: "Comes from the server's .env file (or the default)" }, ".env");
}

export async function renderIntegrations(main) {
  let status = await api.get("/integrations/slack");
  const previewBox = h("div");
  const form = h("div.slack-settings");
  let dirty = false;

  function drawForm() {
    const st = status;
    const mode = st.bot_token_masked || (st.sources.slack_bot_token === "panel") ? "bot" : "webhook";
    const state = {
      enabled: st.switched_on, mode,
      notify: new Set(st.notify_types === "all" ? st.all_notify_types : st.notify_types),
      days: new Set(st.daily_summary_days),
    };
    const markDirty = () => { dirty = true; saveBtn.disabled = false; };

    // --- connection
    const enabled = h("input", { type: "checkbox", checked: state.enabled, onchange: (e) => { state.enabled = e.target.checked; markDirty(); } });
    const webhook = h("input", { type: "password", autocomplete: "off", spellcheck: false, placeholder: st.webhook_url_masked ? "Saved - leave empty to keep it" : "https://hooks.slack.com/services/T…/B…/…", oninput: markDirty });
    const token = h("input", { type: "password", autocomplete: "off", spellcheck: false, placeholder: st.bot_token_masked ? "Saved - leave empty to keep it" : "xoxb-…", oninput: markDirty });
    const channel = h("input", { value: st.channel || "", placeholder: "C0123ABCD or #dev-tickets", oninput: markDirty });
    let removeWebhook = false;
    let removeToken = false;
    const savedSecret = (masked, onRemove, key) => masked && h("div.secret-saved",
      icon("lock", { size: 13 }), h("code", masked), sourceTag(st, key),
      st.sources[key] === "panel" && h("button.link.small.danger-text", { type: "button", onclick: (e) => { onRemove(); e.currentTarget.closest(".secret-saved").classList.add("removing"); markDirty(); } }, "Remove"));
    const channelList = h("div.channel-list");
    const findChannels = h("button.btn.sm", {
      type: "button",
      onclick: (e) => busy(e.currentTarget, async () => {
        const list = await api.get("/integrations/slack/channels");
        clear(channelList, list.length ? list.map((c) => h("button.chip", {
          type: "button", title: c.is_member ? "The bot is in this channel" : "Invite the bot first: /invite @YourApp",
          onclick: () => { channel.value = c.id; markDirty(); clear(channelList); },
        }, c.is_private ? icon("lock", { size: 12 }) : icon("hash", { size: 12 }), c.name, c.is_member ? icon("check", { size: 12 }) : null))
          : h("span.muted.small", "No channels found."));
      }),
    }, icon("search", { size: 14 }), "Find channels");

    const modeTabs = h("div.chips.seg", [["webhook", "Incoming webhook", "Simplest - posts to one channel"], ["bot", "Bot token", "Real @mentions of people"]].map(([v, text, hint]) => h("button.chip", {
      type: "button", "aria-pressed": String(state.mode === v), title: hint,
      onclick: () => { state.mode = v; modeTabs.querySelectorAll(".chip").forEach((c, i) => c.setAttribute("aria-pressed", String(["webhook", "bot"][i] === v))); webhookBox.hidden = v !== "webhook"; botBox.hidden = v !== "bot"; },
    }, text)));
    const webhookBox = h("div.form", { hidden: state.mode !== "webhook" },
      h("label.field", h("span.field-label", "Webhook URL"), webhook,
        h("span.hint", "Slack app → Incoming Webhooks → Add New Webhook → pick the channel → copy the URL.")),
      savedSecret(st.webhook_url_masked, () => { removeWebhook = true; }, "slack_webhook_url"));
    const botBox = h("div.form", { hidden: state.mode !== "bot" },
      h("label.field", h("span.field-label", "Bot token"), token,
        h("span.hint", "OAuth & Permissions → bot scopes chat:write and users:read.email (channels:read to use Find channels) → Install → copy the Bot User OAuth Token.")),
      savedSecret(st.bot_token_masked, () => { removeToken = true; }, "slack_bot_token"),
      h("label.field", h("span.field-label", h("span", "Channel"), sourceTag(st, "slack_channel")), h("div.row", channel, findChannels),
        h("span.hint", "Invite the bot to the channel first: /invite @YourApp")),
      channelList);

    // --- what to send
    const typeGrid = h("div.type-grid", st.all_notify_types.map((t) => h("label.type-option",
      h("input", { type: "checkbox", checked: state.notify.has(t), onchange: (e) => { if (e.target.checked) state.notify.add(t); else state.notify.delete(t); markDirty(); } }),
      h("span", h("strong", TYPE_LABELS[t]?.[0] || t), h("span.muted.small", TYPE_LABELS[t]?.[1] || "")))));
    const allNone = h("div.row", h("button.link.small", { type: "button", onclick: () => { typeGrid.querySelectorAll("input").forEach((i) => { i.checked = true; }); st.all_notify_types.forEach((t) => state.notify.add(t)); markDirty(); } }, "Select all"),
      h("button.link.small", { type: "button", onclick: () => { typeGrid.querySelectorAll("input").forEach((i) => { i.checked = false; }); state.notify.clear(); markDirty(); } }, "None"));

    // --- schedule + general
    const time = h("input", { type: "time", value: st.daily_summary_time || "", oninput: markDirty });
    const summaryOn = h("input", { type: "checkbox", checked: Boolean(st.daily_summary_time), onchange: (e) => { time.disabled = !e.target.checked; if (e.target.checked && !time.value) time.value = "10:00"; markDirty(); } });
    time.disabled = !st.daily_summary_time;
    const dayChips = h("div.chips", DAYS.map(([v, text]) => h("button.chip", {
      type: "button", "aria-pressed": String(state.days.has(v)),
      onclick: (e) => { if (state.days.has(v)) state.days.delete(v); else state.days.add(v); e.currentTarget.setAttribute("aria-pressed", String(state.days.has(v))); markDirty(); },
    }, text)));
    const tzList = h("datalist#tz-list", ZONES.map((z) => h("option", { value: z })));
    const tz = h("input", { value: st.timezone, list: "tz-list", placeholder: "Asia/Kolkata", oninput: markDirty });
    const base = h("input", { value: st.app_base_url, placeholder: "https://tickets.example.com", oninput: markDirty });

    const saveBtn = h("button.btn.primary", {
      type: "button", disabled: true,
      onclick: (e) => busy(e.currentTarget, async () => {
        const body = {
          enabled: state.enabled,
          notify_types: [...state.notify],
          daily_summary_time: summaryOn.checked ? time.value : "",
          daily_summary_days: [...state.days],
          timezone: tz.value.trim(),
          app_base_url: base.value.trim(),
        };
        if (state.mode === "webhook") {
          if (webhook.value.trim()) body.webhook_url = webhook.value.trim();
          else if (removeWebhook) body.webhook_url = "";
        } else {
          if (token.value.trim()) body.bot_token = token.value.trim();
          else if (removeToken) body.bot_token = "";
          body.channel = channel.value.trim();
        }
        if (removeWebhook && state.mode === "bot") body.webhook_url = "";
        status = await api.put("/integrations/slack/config", body);
        dirty = false;
        toast("Slack settings saved - active immediately");
        draw();
      }),
    }, icon("check", { size: 15 }), "Save changes");

    clear(form,
      h("section.card.settings-card",
        h("div.settings-row",
          h("div.settings-label", h("h2", "Slack notifications"), h("p.muted.small", "Turn everything off without losing the connection.")),
          h("label.switch", enabled, h("span.slider"), h("span", state.enabled ? "On" : "Off")))),
      h("section.card.settings-card",
        h("div.settings-row",
          h("div.settings-label", h("h2", "Connection"), h("p.muted.small", "Where messages are posted. Secrets are encrypted and never shown again in full.")),
          h("div.settings-body", modeTabs, webhookBox, botBox))),
      h("section.card.settings-card",
        h("div.settings-row",
          h("div.settings-label", h("h2", "What to send"), h("p.muted.small", "In-app notifications that are also posted to the channel."), allNone, sourceTag(st, "slack_notify_types")),
          h("div.settings-body", typeGrid))),
      h("section.card.settings-card",
        h("div.settings-row",
          h("div.settings-label", h("h2", "Daily summary"), h("p.muted.small", "Pending tickets per team member, posted every morning."), sourceTag(st, "slack_daily_summary_time")),
          h("div.settings-body",
            h("label.check", summaryOn, "Post a daily summary at"), time,
            h("span.field-label.mt", "On these days"), dayChips))),
      h("section.card.settings-card",
        h("div.settings-row",
          h("div.settings-label", h("h2", "General"), h("p.muted.small", "Used for links in messages and for the summary schedule.")),
          h("div.settings-body",
            h("label.field", h("span.field-label", h("span", "Time zone"), sourceTag(st, "timezone")), tz, tzList),
            h("label.field", h("span.field-label", h("span", "App address"), sourceTag(st, "app_base_url")),
              h("div.row", base, h("button.btn.sm", { type: "button", onclick: () => { base.value = location.origin; markDirty(); } }, "Use this address")),
              h("span.hint", "Ticket links in Slack open this address."))))),
      h("div.settings-actions",
        h("button.btn.ghost", {
          type: "button",
          onclick: async () => {
            if (!(await confirmDialog("Reset to .env", "Forget everything saved on this page and use the server's .env values again?", "Reset"))) return;
            await busy(null, async () => {
              await api.del("/integrations/slack/config");
              status = await api.get("/integrations/slack");
              dirty = false;
              toast("Back to the .env settings");
              draw();
            });
          },
        }, icon("refresh", { size: 14 }), "Reset to .env"),
        h("div.row", saveBtn)));
  }

  const statusBar = () => h("section.card.slack-status",
    h("div.row.wrap",
      status.enabled ? h("span.badge.ok", icon("check-circle", { size: 13 }), `Connected · ${status.mode === "bot" ? "bot" : "webhook"}`)
        : status.configured ? h("span.badge", "Switched off") : h("span.badge.danger", "Not connected"),
      h("span.muted.small", status.enabled
        ? `Overdue checks every ${status.overdue_check_minutes} min · ${status.daily_summary_time ? `summary at ${status.daily_summary_time} (${status.timezone})` : "no daily summary"}`
        : "Add a webhook or bot below and save.")),
    h("div.row.wrap.actions-row",
      h("button.btn.sm", {
        disabled: !status.enabled,
        onclick: (e) => busy(e.currentTarget, async () => { await api.post("/integrations/slack/test"); toast("Test message sent to Slack"); }),
      }, icon("arrow", { size: 14 }), "Send test message"),
      h("button.btn.sm", {
        onclick: (e) => busy(e.currentTarget, async () => {
          const { text } = await api.get("/integrations/slack/daily-summary");
          clear(previewBox, h("section.card", h("div.card-head", h("h2", "Today's summary (preview)")), slackPreview(text)));
        }),
      }, "Preview daily summary"),
      h("button.btn.sm", {
        disabled: !status.enabled,
        onclick: (e) => busy(e.currentTarget, async () => { await api.post("/integrations/slack/daily-summary"); toast("Daily summary sent"); }),
      }, "Send summary now"),
      h("button.btn.sm", {
        onclick: (e) => busy(e.currentTarget, async () => {
          const { alerted } = await api.post("/integrations/overdue-check");
          toast(alerted.length ? `Overdue alerts sent for ${alerted.join(", ")}` : "No newly overdue tickets");
        }),
      }, "Run overdue check now")));

  const statusSlot = h("div");
  function draw() { drawForm(); clear(statusSlot, statusBar()); }

  clear(main,
    h("div.page-head", h("div", h("h1", "Slack"), h("p.muted", "Connect a channel and choose what gets posted - no server restart needed."))),
    statusSlot, previewBox, form);
  draw();
  const beforeUnload = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } };
  window.addEventListener("beforeunload", beforeUnload);
  return () => window.removeEventListener("beforeunload", beforeUnload);
}
