// Seasonal greeting with a gift (Halloween): a spooky card with the message and a gift box to open.
// Shown once when the gift is still wrapped; the inbox message reopens it any time.
import { api } from "../api.js";
import { navigate } from "../app.js";
import { h, toast } from "../ui.js";

let showing = false;

/** After sign-in: pop the greeting up if there's an unopened gift. */
export async function checkSeasonalGift() {
  try {
    const s = await api.get("/seasonal");
    if (s.event && !s.gift.opened) showGift(s);
  } catch { /* a greeting is never worth an error */ }
}

/** Open the greeting (also from the inbox message), wrapped or already opened. */
export async function openSeasonal() {
  try {
    const s = await api.get("/seasonal");
    if (!s.event) { toast("Halloween is over for this year - see you next October! 🎃"); return; }
    showGift(s);
  } catch (err) { toast(err.message, "error"); }
}

function showGift(s) {
  if (showing) return;
  showing = true;
  const close = () => { root.classList.add("leaving"); setTimeout(() => root.remove(), 250); document.removeEventListener("keydown", onKey); showing = false; };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);

  const stage = h("div.gift-stage");
  const card = h("div.gift-card", { role: "dialog", "aria-modal": "true", "aria-label": s.event.title },
    h("div.gift-bats", { "aria-hidden": "true" }, ["🦇", "🦇", "🦇"].map((b, i) => h("span", { style: { "--i": i } }, b))),
    h("button.gift-x", { type: "button", "aria-label": "Close", onclick: close }, "×"),
    h("div.gift-moon", { "aria-hidden": "true" }),
    h("h2.gift-title", "🎃 ", s.event.title),
    h("p.gift-msg", s.event.message),
    h("p.gift-from", `— ${s.event.from}`),
    stage);
  const root = h("div.gift-backdrop", { onclick: (e) => { if (e.target === root) close(); } }, card);

  const reveal = (gift, animate) => {
    stage.replaceChildren(
      h(`div.gift-treat${animate ? ".pop" : ""}`, h("span.gift-treat-emoji", gift.treat.emoji)),
      h("strong.gift-treat-name", gift.treat.name),
      h("p.gift-points", `+${gift.points} daily-challenge points`),
      h("p.gift-badge", "🎃 Halloween badge added to your profile"),
      h("div.gift-actions",
        h("button.gift-btn", { type: "button", onclick: () => { close(); navigate("/challenge"); } }, "Play the Haunted House"),
        h("button.gift-btn.ghost", { type: "button", onclick: close }, "Close")));
    if (animate) candy(card);
  };

  if (s.gift.opened) reveal(s.gift, false);
  else {
    const box = h("button.gift-box", {
      type: "button", "aria-label": "Open your gift",
      onclick: async () => {
        box.disabled = true;
        box.classList.add("opening");
        try {
          const [r] = await Promise.all([api.post("/seasonal/open"), new Promise((res) => setTimeout(res, 900))]);
          reveal(r.gift, true);
        } catch (err) { box.disabled = false; box.classList.remove("opening"); toast(err.message, "error"); }
      },
    }, h("span.gift-lid", "🎀"), h("span.gift-body", "🎁"));
    stage.replaceChildren(...[box, h("p.gift-hint", "Tap the gift to open it"),
      s.opened_count ? h("p.gift-count", `${s.opened_count} teammate${s.opened_count === 1 ? " has" : "s have"} opened theirs`) : null].filter(Boolean));
  }
  document.body.append(root);
}

function candy(host) {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  const layer = h("div.gift-candy", { "aria-hidden": "true" });
  const bits = ["🍬", "🍭", "🍫", "🎃", "👻", "🦇", "⭐"];
  for (let i = 0; i < 28; i++) {
    layer.append(h("i", { style: {
      left: `${50 + (Math.random() - 0.5) * 20}%`, "--dx": `${(Math.random() - 0.5) * 520}px`, "--dy": `${-120 - Math.random() * 220}px`,
      "--r": `${Math.random() * 720 - 360}deg`, animationDelay: `${Math.random() * 150}ms`,
    } }, bits[i % bits.length]));
  }
  host.append(layer);
  setTimeout(() => layer.remove(), 2200);
}
