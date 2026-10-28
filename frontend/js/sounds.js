// Small synthesised sounds (Web Audio - no audio files): message pings, mentions, ringtone,
// ringback and join/leave blips. Each can be switched off per viewer.
const PREFS_KEY = "chat.prefs";
const DEFAULTS = { sounds: true, ringtone: true, ringtoneStyle: "aurora", effects: true, volume: 0.8 };

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

// ----------------------------------------------------------------------------- ringtone engine
// Real instruments are synthesised: an FM bell, a two-partial marimba and a soft pad, through a
// gentle room reverb and a limiter, so the ringtone sounds full and warm instead of beepy.
let bus = null;
function master() {
  const ac = audio();
  if (!ac) return null;
  if (bus && bus.ac === ac) return bus;
  const out = ac.createDynamicsCompressor(); // keeps chords from clipping on laptop speakers
  out.threshold.value = -14; out.knee.value = 12; out.ratio.value = 4; out.attack.value = 0.003; out.release.value = 0.25;
  out.connect(ac.destination);
  const dry = ac.createGain();
  dry.connect(out);
  const reverb = ac.createConvolver();
  reverb.buffer = roomImpulse(ac, 1.9);
  const wet = ac.createGain();
  wet.gain.value = 0.32;
  reverb.connect(wet).connect(out);
  bus = { ac, dry, reverb, out };
  return bus;
}

/** A decaying stereo noise burst: a convincing small-hall reverb without any audio file. */
function roomImpulse(ac, seconds) {
  const len = Math.floor(ac.sampleRate * seconds);
  const buf = ac.createBuffer(2, len, ac.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3.2;
  }
  return buf;
}

/** One voice into the mix: panned, with a reverb send. Returns the gain node to shape. */
function voice(at, pan = 0, send = 1) {
  const b = master();
  const g = b.ac.createGain();
  g.gain.setValueAtTime(0.0001, at);
  const p = b.ac.createStereoPanner ? b.ac.createStereoPanner() : null;
  if (p) { p.pan.value = pan; g.connect(p); p.connect(b.dry); } else g.connect(b.dry);
  if (send) {
    const s = b.ac.createGain();
    s.gain.value = send;
    g.connect(s).connect(b.reverb);
  }
  return g;
}

const INSTRUMENTS = {
  /** FM bell: bright strike that mellows as it rings. */
  bell(f, t, dur, vol, pan) {
    const ac = bus.ac;
    const g = voice(t, pan, 1.1);
    const car = ac.createOscillator();
    const mod = ac.createOscillator();
    const depth = ac.createGain();
    car.frequency.value = f;
    mod.frequency.value = f * 3.5;
    depth.gain.setValueAtTime(f * 2.2, t);
    depth.gain.exponentialRampToValueAtTime(f * 0.08, t + dur * 0.8);
    mod.connect(depth).connect(car.frequency);
    car.connect(g);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    [car, mod].forEach((o) => { o.start(t); o.stop(t + dur + 0.05); });
  },
  /** Marimba: woody fundamental plus the bar's 4th partial, with a short mallet knock. */
  marimba(f, t, dur, vol, pan) {
    const ac = bus.ac;
    const g = voice(t, pan, 0.55);
    [[1, 1, dur], [3.93, 0.28, dur * 0.35], [9.2, 0.06, 0.05]].forEach(([ratio, level, d]) => {
      const o = ac.createOscillator();
      const og = ac.createGain();
      o.frequency.value = f * ratio;
      og.gain.setValueAtTime(level, t);
      og.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(og).connect(g);
      o.start(t);
      o.stop(t + d + 0.05);
    });
    g.gain.exponentialRampToValueAtTime(vol, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  },
  /** Warm pad: detuned triangles through a low-pass filter, slow swell. */
  pad(f, t, dur, vol, pan) {
    const ac = bus.ac;
    const g = voice(t, pan, 0.9);
    const lp = ac.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 1400;
    lp.connect(g);
    [-7, 7].forEach((cents) => {
      const o = ac.createOscillator();
      o.type = "triangle";
      o.frequency.value = f;
      o.detune.value = cents;
      o.connect(lp);
      o.start(t);
      o.stop(t + dur + 0.1);
    });
    g.gain.exponentialRampToValueAtTime(vol, t + Math.min(0.35, dur / 3));
    g.gain.setValueAtTime(vol, t + dur * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  },
  /** Telephone bell: two tones trembling at 20 Hz, like a real ringer. */
  trill(f, t, dur, vol, pan) {
    const ac = bus.ac;
    const g = voice(t, pan, 0.25);
    const am = ac.createGain();
    am.gain.value = 0.5;
    const lfo = ac.createOscillator();
    const lfoDepth = ac.createGain();
    lfo.frequency.value = 20;
    lfoDepth.gain.value = 0.5;
    lfo.connect(lfoDepth).connect(am.gain);
    am.connect(g);
    [f, f * 1.25].forEach((fr) => {
      const o = ac.createOscillator();
      o.frequency.value = fr;
      o.connect(am);
      o.start(t);
      o.stop(t + dur + 0.05);
    });
    lfo.start(t);
    lfo.stop(t + dur + 0.05);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.setValueAtTime(vol, t + dur - 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  },
};

// Note names -> Hz (A4 = 440)
const NOTE = (n) => {
  const m = /^([A-G])(#|b)?(\d)$/.exec(n);
  const semis = { C: -9, D: -7, E: -5, F: -4, G: -2, A: 0, B: 2 }[m[1]] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0) + (Number(m[3]) - 4) * 12;
  return 440 * 2 ** (semis / 12);
};

// Each ringtone: one phrase of [instrument, note, start, length, level, pan], repeated every `every` s.
export const RINGTONES = {
  aurora: {
    label: "Aurora", hint: "Soft bells over a warm chord", every: 3.4,
    phrase: [
      ["pad", "E3", 0, 2.9, 0.07, -0.2], ["pad", "B3", 0, 2.9, 0.05, 0.2], ["pad", "G#3", 0, 2.9, 0.045, 0],
      ["bell", "E5", 0, 1.6, 0.16, -0.35], ["bell", "G#5", 0.22, 1.5, 0.15, -0.1], ["bell", "B5", 0.44, 1.5, 0.15, 0.15],
      ["bell", "E6", 0.66, 1.9, 0.13, 0.35], ["bell", "D#6", 1.2, 1.2, 0.11, 0.25], ["bell", "B5", 1.42, 1.4, 0.12, 0],
      ["bell", "C#6", 1.64, 1.9, 0.13, -0.2],
    ],
  },
  sunrise: {
    label: "Sunrise", hint: "Bright, upbeat marimba", every: 2.6,
    phrase: [
      ["marimba", "A4", 0, 0.5, 0.22, -0.3], ["marimba", "C#5", 0.15, 0.5, 0.2, -0.1], ["marimba", "E5", 0.3, 0.5, 0.2, 0.1],
      ["marimba", "A5", 0.45, 0.6, 0.22, 0.3], ["marimba", "E5", 0.75, 0.45, 0.18, 0.1], ["marimba", "F#5", 0.9, 0.5, 0.2, -0.1],
      ["marimba", "E5", 1.05, 0.45, 0.18, 0], ["marimba", "C#5", 1.2, 0.8, 0.2, -0.25],
      ["marimba", "A3", 0, 0.8, 0.12, 0], ["marimba", "E3", 0.75, 0.8, 0.1, 0],
    ],
  },
  breeze: {
    label: "Breeze", hint: "Calm, falling chimes", every: 3.8,
    phrase: [
      ["bell", "C#6", 0, 2.2, 0.12, 0.4], ["bell", "A5", 0.3, 2.2, 0.12, 0.15], ["bell", "F#5", 0.6, 2.2, 0.12, -0.1],
      ["bell", "E5", 0.9, 2.4, 0.12, -0.35], ["bell", "B5", 1.5, 2.0, 0.1, 0.25], ["bell", "F#5", 1.8, 2.6, 0.11, -0.15],
      ["pad", "F#3", 0, 3.2, 0.05, 0], ["pad", "C#4", 0, 3.2, 0.035, 0],
    ],
  },
  classic: {
    label: "Classic phone", hint: "The old desk-phone bell", every: 3,
    phrase: [["trill", "A5", 0, 0.42, 0.11, 0], ["trill", "A5", 0.6, 0.42, 0.11, 0]],
  },
};

function playPhrase(name, at, loudness) {
  const b = master();
  if (!b || b.ac.state !== "running") return;
  const tone = RINGTONES[name] || RINGTONES.aurora;
  const base = b.ac.currentTime + at;
  const vol = prefs.get("volume") * loudness * 1.6; // the limiter keeps the loudest chords clean
  for (const [inst, n, start, dur, level, pan] of tone.phrase) INSTRUMENTS[inst](NOTE(n), base + start, dur, Math.max(0.0002, level * vol), pan);
}

/** Wait (briefly) for the audio engine to be allowed to play. */
async function ready() {
  const ac = audio();
  if (!ac) return false;
  if (ac.state !== "running") { try { await Promise.race([ac.resume(), new Promise((r) => setTimeout(r, 400))]); } catch { /* blocked */ } }
  return ac.state === "running";
}

let ringTimer = null;
let ringSession = 0;
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
  /** Incoming call: the chosen ringtone, starting gently and growing a little louder (like a phone). */
  async ring() {
    sounds.stopRing();
    if (!prefs.get("ringtone")) return;
    const session = ++ringSession;
    if (!(await ready()) || session !== ringSession) return;
    const name = prefs.get("ringtoneStyle");
    const every = (RINGTONES[name] || RINGTONES.aurora).every * 1000;
    let n = 0;
    const tick = () => { playPhrase(name, 0.02, Math.min(1, 0.55 + n * 0.15)); n++; };
    tick();
    ringTimer = setInterval(tick, every);
  },
  /** Play one phrase of a ringtone (settings preview). */
  async previewRing(name) {
    sounds.stopRing();
    if (await ready()) playPhrase(name, 0.02, 1);
  },
  stopRing() {
    ringSession++;
    clearInterval(ringTimer);
    ringTimer = null;
    if (bus) { bus.out.disconnect(); bus = null; } // cut ringing notes immediately
  },
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
