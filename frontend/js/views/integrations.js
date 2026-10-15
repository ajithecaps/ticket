import { api } from "../api.js";
import { busy, clear, h, toast } from "../ui.js";

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

export async function renderIntegrations(main) {
  const status = await api.get("/integrations/slack");
  const previewBox = h("div");

  const row = (k, v) => [h("dt", k), h("dd", v)];
  const summaryWhen = status.daily_summary_time
    ? `${status.daily_summary_time} (${status.timezone}) · ${status.daily_summary_days.join(", ")}`
    : "Off";

  const setup = h("section.card",
    h("h2", "Connect a Slack channel"),
    h("ol.steps",
      h("li", "In Slack, create an app at ", h("a", { href: "https://api.slack.com/apps", target: "_blank", rel: "noopener" }, "api.slack.com/apps"),
        " → From scratch → pick your workspace."),
      h("li", h("strong", "Simplest:"), " Incoming Webhooks → turn on → Add New Webhook → choose the channel. Copy the URL into ",
        h("code", "SLACK_WEBHOOK_URL"), " in ", h("code", ".env"), "."),
      h("li", h("strong", "Or, for real @mentions:"), " OAuth & Permissions → add bot scopes ", h("code", "chat:write"), " and ",
        h("code", "users:read.email"), " → Install → copy the Bot token into ", h("code", "SLACK_BOT_TOKEN"),
        ", set ", h("code", "SLACK_CHANNEL"), " to the channel ID, and invite the bot to the channel (", h("code", "/invite @YourApp"), ")."),
      h("li", "Set ", h("code", "APP_BASE_URL"), " to the address people open the app at, so ticket links work, then restart the server.")));

  clear(main,
    h("div.page-head", h("div", h("h1", "Slack"), h("p.muted", "Notifications, overdue alerts and the daily pending-tickets summary."))),
    h("section.card",
      h("div.card-head",
        h("h2", "Status"),
        status.enabled ? h("span.badge.ok", `Connected · ${status.mode === "bot" ? "bot" : "webhook"}`) : h("span.badge.danger", "Not connected")),
      h("dl.metrics.left",
        row("Notifications mirrored", Array.isArray(status.notify_types) ? (status.notify_types.join(", ") || "none") : "all"),
        row("Daily summary", summaryWhen),
        row("Overdue check", status.scheduler_enabled ? `every ${status.overdue_check_minutes} min` : "off (SCHEDULER_ENABLED=false)"),
        status.channel && row("Channel", status.channel),
        row("Ticket links", status.app_base_url)),
      h("div.row.wrap.actions-row",
        h("button.btn", {
          disabled: !status.enabled,
          onclick: (e) => busy(e.currentTarget, async () => { await api.post("/integrations/slack/test"); toast("Test message sent to Slack"); }),
        }, "Send test message"),
        h("button.btn", {
          onclick: (e) => busy(e.currentTarget, async () => {
            const { text } = await api.get("/integrations/slack/daily-summary");
            clear(previewBox, h("section.card", h("div.card-head", h("h2", "Today's summary (preview)")), slackPreview(text)));
          }),
        }, "Preview daily summary"),
        h("button.btn", {
          disabled: !status.enabled,
          onclick: (e) => busy(e.currentTarget, async () => { await api.post("/integrations/slack/daily-summary"); toast("Daily summary sent"); }),
        }, "Send summary now"),
        h("button.btn", {
          onclick: (e) => busy(e.currentTarget, async () => {
            const { alerted } = await api.post("/integrations/overdue-check");
            toast(alerted.length ? `Overdue alerts sent for ${alerted.join(", ")}` : "No newly overdue tickets");
          }),
        }, "Run overdue check now"))),
    previewBox,
    !status.enabled && setup,
    h("p.muted.small", "Settings live in the server's .env file (SLACK_*, TIMEZONE, APP_BASE_URL); restart the server after changing them."),
  );
}
