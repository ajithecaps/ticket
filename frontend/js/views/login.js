// Sign-in page: animated brand panel + form (show password, remember e-mail, caps-lock hint,
// loading state, shake on error, smooth hand-off into the app).
import { api } from "../api.js";
import { icon } from "../icons.js";
import { clear, h } from "../ui.js";

const REMEMBER_KEY = "tickets.login.email";
const HEADLINES = [
  ["Plan the work.", "Ship it with confidence."],
  ["Every ticket.", "Every teammate."],
  ["Idea to release.", "Nothing slips."],
];
const FEATURES = [
  ["timeline", "Gantt timeline with overlap checks"],
  ["check-circle", "Owner verification before release"],
  ["rocket", "Releases & Slack notifications"],
  ["sparkles", "A personal coach that keeps you moving"],
];

function remembered() { try { return localStorage.getItem(REMEMBER_KEY) || ""; } catch { return ""; } }
function remember(email) { try { if (email) localStorage.setItem(REMEMBER_KEY, email); else localStorage.removeItem(REMEMBER_KEY); } catch { /* optional */ } }

/** A tiny animated board: cards drift between three columns on a loop. */
function boardPreview() {
  const cols = ["To do", "In progress", "Done"].map((name, i) => h(`div.lp-col.lp-col-${i}`, h("div.lp-col-head", h("i"), name)));
  const cards = [
    { key: "PAY-12", title: "Refund retries", tag: "feature", col: 0, row: 0 },
    { key: "OPS-4", title: "Audit log export", tag: "improvement", col: 0, row: 1 },
    { key: "PAY-9", title: "UPI autopay", tag: "feature", col: 1, row: 0 },
    { key: "PAY-3", title: "Settlement timeout", tag: "bug", col: 1, row: 1 },
    { key: "OPS-2", title: "Commission CSV", tag: "task", col: 2, row: 0 },
  ];
  const els = cards.map((c, i) => h(`div.lp-card.lp-tag-${c.tag}`, { style: { "--d": `${i * 0.15}s` } },
    h("div.lp-card-top", h("span", c.key), h("b", c.tag)), h("div.lp-card-title", c.title),
    h("div.lp-card-foot", h("span.lp-bar", h("i", { style: { width: `${30 + ((i * 23) % 60)}%` } })), h("span.lp-av", ["AN", "KD", "RM", "NS", "AN"][i]))));
  const board = h("div.lp-board", cols, els);
  const place = () => cards.forEach((c, i) => {
    els[i].style.setProperty("--x", `calc(${c.col} * (100% + 26px))`);
    els[i].style.setProperty("--y", `${c.row * 74}px`);
  });
  place();
  // Every few seconds one card moves one column to the right (and wraps), like real work flowing.
  let step = 0;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const timer = reduce ? null : setInterval(() => {
    if (!board.isConnected) { clearInterval(timer); return; }
    const c = cards[step % cards.length];
    c.col = (c.col + 1) % 3;
    const taken = new Set(cards.filter((x) => x !== c && x.col === c.col).map((x) => x.row));
    c.row = [0, 1, 2].find((r) => !taken.has(r)) ?? 0;
    els[step % cards.length].classList.add("lp-moving");
    setTimeout(() => els.forEach((e) => e.classList.remove("lp-moving")), 700);
    place();
    step += 1;
  }, 2200);
  return board;
}

export function renderLoginPage(root, { message, onSuccess }) {
  // --- brand panel
  let hi = 0;
  const headline = h("h2.lp-headline", h("span", HEADLINES[0][0]), h("span.lp-grad", HEADLINES[0][1]));
  const dots = h("div.lp-dots", HEADLINES.map((_, i) => h(`button${i === 0 ? ".on" : ""}`, { type: "button", "aria-label": `Show message ${i + 1}`, onclick: () => showHeadline(i) })));
  function showHeadline(i) {
    hi = i;
    headline.classList.add("out");
    setTimeout(() => {
      clear(headline, h("span", HEADLINES[i][0]), h("span.lp-grad", HEADLINES[i][1]));
      headline.classList.remove("out");
    }, 280);
    dots.querySelectorAll("button").forEach((b, k) => b.classList.toggle("on", k === i));
  }
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const rotate = reduce ? null : setInterval(() => { if (!headline.isConnected) { clearInterval(rotate); return; } showHeadline((hi + 1) % HEADLINES.length); }, 5200);

  const brand = h("section.lp-brand", { "aria-hidden": "false" },
    h("div.lp-aurora", h("i.a1"), h("i.a2"), h("i.a3")),
    h("div.lp-grid-bg"),
    h("div.lp-brand-inner",
      h("div.lp-logo", h("span.logo", icon("grandesk", { size: 21 })), h("span", "Grandesk")),
      h("div.lp-copy", headline, h("p.lp-sub", "Grandesk is where development teams work - tickets, boards, timelines, releases and docs, in one fast workspace."), dots),
      boardPreview(),
      h("ul.lp-features", FEATURES.map(([ic, text], i) => h("li", { style: { "--i": i } }, h("span.lp-fi", icon(ic, { size: 15 })), text)))));

  // --- form
  const saved = remembered();
  const email = h("input", { type: "email", name: "email", required: true, autocomplete: "username", placeholder: "you@company.com", value: saved });
  const password = h("input", { type: "password", name: "password", required: true, autocomplete: "current-password", placeholder: "••••••••" });
  const eye = h("button.lp-eye", {
    type: "button", "aria-label": "Show password", title: "Show password",
    onclick: () => {
      const show = password.type === "password";
      password.type = show ? "text" : "password";
      eye.replaceChildren(icon(show ? "eye-off" : "eye", { size: 16 }));
      eye.setAttribute("aria-label", show ? "Hide password" : "Show password");
      eye.title = eye.getAttribute("aria-label");
      password.focus();
    },
  }, icon("eye", { size: 16 }));
  const caps = h("div.lp-caps", { hidden: true }, icon("alert", { size: 13 }), "Caps Lock is on");
  const capsCheck = (e) => { if (e.getModifierState) caps.hidden = !e.getModifierState("CapsLock"); };
  password.addEventListener("keydown", capsCheck);
  password.addEventListener("keyup", capsCheck);
  password.addEventListener("blur", () => { caps.hidden = true; });
  const rememberBox = h("input", { type: "checkbox", checked: Boolean(saved) });
  const error = h("div.lp-error", { hidden: !message, role: "alert" }, icon("x-circle", { size: 16 }), h("span", message || ""));
  const submit = h("button.btn.primary.block.lp-submit", { type: "submit" },
    h("span.lp-submit-text", "Sign in"), icon("arrow", { size: 16, cls: "lp-arrow" }), h("span.lp-spinner", { "aria-hidden": "true" }));

  const card = h("div.lp-card-form");
  const form = h("form.lp-form", { novalidate: true },
    h("label.lp-field", h("span", "Work e-mail"), h("div.lp-input", icon("user", { size: 16 }), email)),
    h("label.lp-field", h("span", "Password"), h("div.lp-input", icon("key", { size: 16 }), password, eye), caps),
    h("div.lp-row", h("label.check", rememberBox, "Remember my e-mail"), h("span.lp-hint", "Forgot it? Ask your admin to reset it.")),
    error,
    submit);

  const fail = (text) => {
    error.querySelector("span").textContent = text;
    error.hidden = false;
    card.classList.remove("shake");
    void card.offsetWidth; // restart the animation
    card.classList.add("shake");
  };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!email.value.trim() || !password.value) { fail("Enter your e-mail and password."); (email.value.trim() ? password : email).focus(); return; }
    submit.disabled = true;
    submit.classList.add("loading");
    error.hidden = true;
    try {
      await api.login(email.value.trim(), password.value);
      remember(rememberBox.checked ? email.value.trim() : "");
      submit.classList.remove("loading");
      submit.classList.add("done");
      root.querySelector(".lp")?.classList.add("leaving");
      setTimeout(onSuccess, reduce ? 0 : 420);
    } catch (err) {
      submit.disabled = false;
      submit.classList.remove("loading");
      fail(err.message || "Could not sign in");
      password.select();
    }
  });

  clear(card,
    h("div.lp-form-head",
      h("div.lp-mobile-logo", h("span.logo", icon("grandesk", { size: 19 })), h("strong", "Grandesk")),
      h("h1", saved ? "Welcome back" : "Sign in to Grandesk"),
      h("p.muted", saved ? `Signing in as ${saved}` : "Use your work e-mail to continue.")),
    form,
    h("p.lp-foot.muted", icon("lock", { size: 13 }), "Your session is private to this browser."));

  clear(root, h("div.lp", brand, h("section.lp-side", card)));
  (saved ? password : email).focus();
}
