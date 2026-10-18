// Small synthesised sounds (Web Audio - no audio files): message pings, mentions, ringtone,
// ringback and join/leave blips. Each can be switched off per viewer.
const PREFS_KEY = "chat.prefs";
const DEFAULTS = { sounds: true, ringtone: true, effects: true, volume: 0.8 };

export const prefs = (() => {
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}"); } catch { /* per-viewer only */ }
  const state = { ...DEFAULTS, ...stored };
  return {
    get: (k) => state[k],
    set(k, v) {
      state[k] = v;
      try { localStorage.setItem(PREFS_KEY, JSON.stringify(state)); } catch { /* per-viewer only */ }
    },
  };
})();

let ctx = null;
function audio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}
// Browsers only allow sound after the first click or key press.
const unlock = () => { audio(); window.removeEventListener("pointerdown", unlock); window.removeEventListener("keydown", unlock); };
window.addEventListener("pointerdown", unlock);
window.addEventListener("keydown", unlock);

function note(freq, at, dur, { type = "sine", gain = 0.18, attack = 0.008, release = null } = {}) {
  const ac = audio();
  if (!ac || ac.state !== "running") return;
  const t = ac.currentTime + at;
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  const peak = gain * prefs.get("volume");
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + (release ?? dur));
  osc.connect(g).connect(ac.destination);
  osc.start(t);
  osc.stop(t + (release ?? dur) + 0.05);
}

let lastPing = 0;
function throttled(fn) {
  const now = Date.now();
  if (now - lastPing < 900) return;
  lastPing = now;
  fn();
}

let ringTimer = null;
let ringbackTimer = null;

export const sounds = {
  /** New message from someone else. `soft` when you're already looking at the conversation. */
  message(soft = false) {
    if (!prefs.get("sounds")) return;
    throttled(() => {
      const g = soft ? 0.07 : 0.16;
      note(988, 0, 0.12, { gain: g, type: "triangle" });
      note(1319, 0.07, 0.22, { gain: g * 0.9, type: "triangle" });
    });
  },
  /** Direct message or @mention: a brighter three-note chime. */
  mention() {
    if (!prefs.get("sounds")) return;
    throttled(() => {
      note(784, 0, 0.14, { gain: 0.17, type: "triangle" });
      note(1047, 0.09, 0.14, { gain: 0.17, type: "triangle" });
      note(1568, 0.18, 0.32, { gain: 0.15, type: "triangle" });
    });
  },
  sent() {
    if (!prefs.get("sounds")) return;
    note(660, 0, 0.06, { gain: 0.05, type: "sine" });
    note(990, 0.03, 0.08, { gain: 0.04, type: "sine" });
  },
  /** Incoming call: a repeating marimba-like phrase until stopped. */
  ring() {
    sounds.stopRing();
    if (!prefs.get("ringtone")) return;
    const phrase = () => {
      [[659, 0], [784, 0.16], [988, 0.32], [784, 0.48], [659, 0.8], [784, 0.96], [988, 1.12], [1319, 1.28]].forEach(([f, at]) => {
        note(f, at, 0.3, { gain: 0.22, type: "sine", release: 0.42 });
        note(f * 2, at, 0.12, { gain: 0.04, type: "sine" });
      });
    };
    phrase();
    ringTimer = setInterval(phrase, 3000);
  },
  stopRing() { clearInterval(ringTimer); ringTimer = null; },
  /** Outgoing call: the classic "ring-ring … pause" while waiting for an answer. */
  ringback() {
    sounds.stopRingback();
    const burst = () => {
      for (let i = 0; i < 2; i++) {
        note(440, i * 0.5, 0.4, { gain: 0.06 });
        note(480, i * 0.5, 0.4, { gain: 0.06 });
      }
    };
    burst();
    ringbackTimer = setInterval(burst, 3500);
  },
  stopRingback() { clearInterval(ringbackTimer); ringbackTimer = null; },
  join() { note(523, 0, 0.12, { gain: 0.12 }); note(784, 0.1, 0.2, { gain: 0.12 }); },
  leave() { note(784, 0, 0.12, { gain: 0.1 }); note(523, 0.1, 0.22, { gain: 0.1 }); },
  end() { note(494, 0, 0.18, { gain: 0.12 }); note(392, 0.16, 0.3, { gain: 0.12 }); },
  test() { audio(); setTimeout(() => sounds.mention(), 60); },
};
