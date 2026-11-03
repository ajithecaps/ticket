// Daily challenge: one puzzle a day for everyone, timed by the server, with a leaderboard.
// The server checks every move (cards are revealed one flip at a time, answers never reach the
// page), so the times on the board are real.
import { api, auth } from "../api.js";
import { icon } from "../icons.js";
import { sounds } from "../sounds.js";
import { avatar, busy, clear, errorBox, h, toast } from "../ui.js";

const KIND = {
  match: { emoji: "🃏", blurb: "Memory" },
  slide: { emoji: "🔢", blurb: "Logic" },
  words: { emoji: "🔤", blurb: "Words" },
  math: { emoji: "➗", blurb: "Numbers" },
  wordle: { emoji: "🟩", blurb: "Words" },
  code: { emoji: "🔐", blurb: "Logic" },
  lights: { emoji: "💡", blurb: "Logic" },
  seq: { emoji: "🔢", blurb: "Patterns" },
  haunted: { emoji: "🎃", blurb: "Halloween special" },
};
const PERIODS = [["today", "Today"], ["week", "This week"], ["month", "This month"], ["all", "All time"]];
const MEDAL = ["🥇", "🥈", "🥉"];
const SOLVED = [1, 2, 3, 4, 5, 6, 7, 8, 0];

/** "1:23.4" */
export function fmtTime(ms) {
  if (ms == null) return "—";
  const t = Math.max(0, Math.floor(ms / 100));
  const m = Math.floor(t / 600);
  const s = Math.floor((t % 600) / 10);
  return `${m}:${String(s).padStart(2, "0")}.${t % 10}`;
}

/** "+12 s penalty" / "5 s bonus" for the time added (or taken off) on top of the clock. */
function penaltyText(ms) {
  return ms > 0 ? `+ ${Math.round(ms / 1000)} s penalty` : `− ${Math.round(-ms / 1000)} s bonus`;
}

function fmtCountdown(sec) {
  const hh = Math.floor(sec / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  return hh ? `${hh}h ${mm}m` : `${mm}m`;
}

/** Sidebar dot: shown until you've played today's challenge. */
export async function refreshChallengeDot() {
  try {
    const t = await api.get("/challenge/today");
    document.querySelectorAll(".challenge-dot").forEach((el) => { el.hidden = Boolean(t.attempt); });
  } catch { /* not important */ }
}

export async function renderChallenge(main) {
  let info = await api.get("/challenge/today");
  let period = "today";
  let alive = true;
  let timerRaf = 0;
  let pollTimer = 0;

  const gameCard = h(`section.card.ch-game${info.halloween ? ".spooky" : ""}`);
  let lastAnswer = null;
  const boardBody = h("div.ch-board-body");
  const tabs = h("div.chips.seg.ch-tabs", PERIODS.map(([key, label]) => h("button.chip", {
    type: "button", "aria-pressed": String(key === period), dataset: { p: key },
    onclick: () => { period = key; tabs.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.p === key))); loadBoard(); },
  }, label)));
  const streakEl = h("div.ch-head-meta");

  clear(main,
    h("div.page-head",
      h("div", h("h1", "Daily challenge", info.halloween ? h("span.ch-halloween-tag", "🎃 Halloween fortnight") : null),
        h("p.muted", info.halloween
          ? "Spooky season! Until 7 November every day is a new haunted house - the same one for everyone. Fastest time wins."
          : "A new puzzle every day - the same one for everyone. Fastest time wins; points add up over the week.")),
      streakEl),
    h("div.ch-layout",
      gameCard,
      h("aside.card.ch-board", h("div.ch-board-head", h("strong", icon("trophy", { size: 16 }), "Leaderboard"), tabs), boardBody)));

  function paintMeta() {
    clear(streakEl,
      info.streak ? h("span.ch-pill.fire", { title: "Days in a row you've solved it" }, "🔥 ", h("strong", String(info.streak)), `-day streak`) : null,
      h("span.ch-pill", { title: "When tomorrow's puzzle appears" }, icon("clock", { size: 14 }), ` Next puzzle in ${fmtCountdown(info.next_in_s)}`));
  }

  // ------------------------------------------------------------------ leaderboard
  async function loadBoard() {
    let data;
    try { data = await api.get("/challenge/leaderboard", { period }); } catch (err) { clear(boardBody, errorBox(err)); return; }
    if (!alive) return;
    const meId = auth.user.id;
    const who = (u, extra) => h("div.ch-who", avatar(u), h("div.ch-who-text", h("strong", u.id === meId ? `${u.name} (you)` : u.name), extra));
    const rank = (n) => h("span.ch-rank", n <= 3 ? MEDAL[n - 1] : String(n));
    if (!data.rows.length) {
      clear(boardBody, h("div.ch-empty", h("span", "🏁"), h("p", period === "today" ? "Nobody has finished today's puzzle yet. Be the first!" : "No results yet for this period.")),
        playingNow(data));
      return;
    }
    clear(boardBody,
      h("ol.ch-rows", data.rows.map((r) => h(`li${r.user.id === meId ? ".me" : ""}${r.rank <= 3 ? ".podium" : ""}`,
        rank(r.rank),
        period === "today"
          ? [who(r.user, h("span.muted.small", r.penalty_ms ? `${fmtTime(r.duration_ms)} ${penaltyText(r.penalty_ms)}` : `${r.moves} moves`, r.streak > 1 ? ` · 🔥 ${r.streak}` : "")),
            h("div.ch-score", h("strong", fmtTime(r.score_ms)), h("span.ch-points", `+${r.points}`))]
          : [who(r.user, h("span.muted.small", `${r.solved} solved`, r.wins ? ` · 🏆 ${r.wins}` : "", r.bonus ? ` · 🎁 +${r.bonus}` : "", r.streak > 1 ? ` · 🔥 ${r.streak}` : "")),
            h("div.ch-score", h("strong", `${r.points}`), h("span.muted.small", "pts"))]))),
      playingNow(data));
  }
  const playingNow = (data) => (data.playing?.length
    ? h("div.ch-playing", h("span.ch-live"), h("span.muted.small", "Playing now:"), h("div.ch-avatars", data.playing.map((u) => avatar(u))))
    : null);

  // ------------------------------------------------------------------ game card
  function render() {
    paintMeta();
    cancelAnimationFrame(timerRaf);
    const k = KIND[info.kind];
    const a = info.attempt;
    if (!a) renderIntro(k);
    else if (a.status === "playing") renderPlaying(a);
    else renderResult(a);
    if (info.halloween && !gameCard.querySelector(".ch-bats")) gameCard.prepend(bats());
  }

  function renderIntro(k) {
    clear(gameCard,
      h("div.ch-intro",
        h("div.ch-emoji", k.emoji),
        h("span.ch-kicker", `Today's puzzle · ${k.blurb}`),
        h("h2", info.title),
        h("p.ch-rules", info.rules),
        h("div.ch-stats",
          h("span", h("strong", String(info.players)), info.players === 1 ? " player" : " players"),
          h("span", h("strong", String(info.solved)), " solved")),
        h("button.btn.primary.btn-lg.ch-start", {
          type: "button",
          onclick: (e) => busy(e.currentTarget, async () => {
            info.attempt = await api.post("/challenge/today/start");
            refreshChallengeDot();
            render();
          }),
        }, icon("flag", { size: 18 }), "Start - the clock starts now"),
        h("p.muted.small", `One try per day · ${Math.round(info.time_limit_s / 60)}-minute limit · the server keeps the time`),
        info.yesterday.length ? h("div.ch-yesterday", h("span.muted.small", "Yesterday's podium"),
          h("div.ch-podium", info.yesterday.map((r, i) => h("div.ch-pod", h("span", MEDAL[i]), avatar(r.user), h("strong", r.user.name.split(" ")[0]), h("span.muted.small", fmtTime(r.score_ms)))))) : null));
  }

  function renderPlaying(a) {
    const t0 = performance.now() - a.elapsed_ms;
    let penalty = a.penalty_ms;
    const clock = h("span.ch-clock", "0:00.0");
    const pen = h("span.ch-penalty");
    const tick = () => {
      clock.textContent = fmtTime(performance.now() - t0);
      pen.textContent = penalty ? `${penalty > 0 ? "+" : "−"}${Math.round(Math.abs(penalty) / 1000)} s` : "";
      pen.classList.toggle("bonus", penalty < 0);
      timerRaf = requestAnimationFrame(tick);
    };
    const area = h("div.ch-area");
    const done = (attempt) => {
      if (attempt.status !== "done") { penalty = attempt.penalty_ms; return false; }
      info.attempt = attempt;
      info.players = Math.max(info.players, 1);
      sounds.mention();
      render();
      loadBoard();
      return true;
    };
    clear(gameCard,
      h("div.ch-bar",
        h("div.ch-bar-title", h("span", KIND[info.kind].emoji), h("strong", info.title)),
        h("div.ch-timer", icon("clock", { size: 16 }), clock, pen),
        h("button.btn.ghost.sm", {
          type: "button",
          onclick: async () => {
            if (!confirm("Give up today's challenge? It won't count and you can't try again until tomorrow.")) return;
            const r = await api.post("/challenge/today/give-up");
            info.attempt = r.attempt;
            render();
            loadBoard();
          },
        }, "Give up")),
      h("p.ch-rules.small", info.rules),
      area);
    tick();
    ({ match: playMatch, slide: playSlide, words: playWords, math: playMath, wordle: playWordle, code: playCode, lights: playLights, seq: playSeq, haunted: playHaunted })[info.kind](area, a.puzzle, done, {
      reveal: (answer) => { lastAnswer = answer; },
    });
  }

  function renderResult(a) {
    const total = a.score_ms;
    clear(gameCard,
      a.solved
        ? h("div.ch-result",
          h("div.ch-emoji", a.rank && a.rank <= 3 ? MEDAL[a.rank - 1] : "🎉"),
          h("span.ch-kicker", `${info.title} · solved`),
          h("div.ch-big", fmtTime(total)),
          h("p.muted", a.penalty_ms ? `${fmtTime(a.duration_ms)} ${penaltyText(a.penalty_ms)}` : "No penalties - clean run!", ` · ${a.moves} moves`),
          a.rank ? h("p.ch-rank-line", `You're `, h("strong", `#${a.rank}`), ` today`, h("span.ch-points", `+${a.rank <= 7 ? [10, 8, 6, 5, 4, 3, 2][a.rank - 1] : 1} pts`)) : null,
          h("p.muted.small", `Come back tomorrow - next puzzle in ${fmtCountdown(info.next_in_s)}.`))
        : h("div.ch-result",
          h("div.ch-emoji", "⏱️"),
          h("span.ch-kicker", info.title),
          h("h2", "Not finished today"),
          lastAnswer ? h("p.ch-answer", "The answer was ", h("strong", lastAnswer)) : null,
          h("p.muted", "No points this time - a new puzzle arrives tomorrow."),
          h("p.muted.small", `Next puzzle in ${fmtCountdown(info.next_in_s)}.`)));
    if (a.solved && a.rank && a.rank <= 3) confetti(gameCard, info.halloween);
  }

  render();
  loadBoard();
  pollTimer = setInterval(() => { if (!document.hidden) loadBoard(); }, 15_000);
  return () => { alive = false; cancelAnimationFrame(timerRaf); clearInterval(pollTimer); };
}

// ============================================================================ the four games
function shake(el) {
  el.classList.remove("shake");
  void el.offsetWidth;
  el.classList.add("shake");
}

/** Pair match: the server reveals each card, so a request per flip (one at a time). */
function playMatch(area, puzzle, done) {
  const faces = { ...puzzle.faces };
  const matched = new Set(puzzle.matched);
  let open = Object.keys(faces).map(Number).filter((i) => !matched.has(i)); // a lone card left face up
  let wrong = [];
  let hideTimer = 0;
  let pending = false;
  const grid = h("div.ch-cards");
  const cards = Array.from({ length: puzzle.count }, (_, i) => {
    const el = h("button.ch-card", { type: "button", "aria-label": `Card ${i + 1}`, onclick: () => flip(i) },
      h("span.ch-card-inner", h("span.ch-card-back"), h("span.ch-card-face")));
    grid.append(el);
    return el;
  });
  const paint = () => cards.forEach((el, i) => {
    const up = matched.has(i) || open.includes(i) || wrong.includes(i);
    el.classList.toggle("up", up);
    el.classList.toggle("matched", matched.has(i));
    el.classList.toggle("wrong", wrong.includes(i));
    el.querySelector(".ch-card-face").textContent = faces[i] || "";
    el.disabled = matched.has(i);
  });
  const hideWrong = () => { clearTimeout(hideTimer); wrong = []; paint(); };

  async function flip(i) {
    if (pending || matched.has(i) || open.includes(i)) return;
    if (wrong.length) hideWrong();
    pending = true;
    open.push(i);
    paint();
    try {
      const r = await api.post("/challenge/today/flip", { index: i });
      faces[i] = r.symbol;
      if (r.match === true) {
        r.pair.forEach((x) => matched.add(x));
        open = [];
        sounds.sent();
      } else if (r.match === false) {
        wrong = r.pair;
        open = [];
        hideTimer = setTimeout(hideWrong, 750);
      }
      paint();
      if (r.match === true) r.pair.forEach((x) => cards[x].classList.add("pop"));
      done(r.attempt);
    } catch (err) {
      open = open.filter((x) => x !== i);
      paint();
      toast(err.message, "error");
    } finally {
      pending = false;
    }
  }
  paint();
  area.append(grid, h("p.muted.small.ch-hint", "Tip: remember where you saw each card - every miss adds a second."));
}

/** Sliding tiles: played in the page, the move list is replayed and checked on the server. */
function playSlide(area, puzzle, done) {
  const board = puzzle.board.slice();
  const moves = [];
  const counter = h("span.ch-moves", "0 moves");
  const grid = h("div.ch-slide", { tabindex: "0", "aria-label": "Sliding puzzle. Use arrow keys or click a tile next to the gap." });
  const tiles = new Map();
  for (let n = 1; n <= 8; n++) {
    const t = h("button.ch-tile", { type: "button", onclick: () => move(n), "aria-label": `Tile ${n}` }, String(n));
    tiles.set(n, t);
    grid.append(t);
  }
  const adjacent = (a, b) => Math.abs((a % 3) - (b % 3)) + Math.abs(Math.floor(a / 3) - Math.floor(b / 3)) === 1;
  const paint = () => {
    board.forEach((n, i) => {
      if (!n) return;
      const t = tiles.get(n);
      t.style.setProperty("--x", i % 3);
      t.style.setProperty("--y", Math.floor(i / 3));
      t.classList.toggle("home", n === i + 1);
      t.classList.toggle("movable", adjacent(i, board.indexOf(0)));
    });
    counter.textContent = `${moves.length} move${moves.length === 1 ? "" : "s"}`;
  };
  let sending = false;
  async function move(n) {
    if (sending) return;
    const i = board.indexOf(n);
    const blank = board.indexOf(0);
    if (!adjacent(i, blank)) { shake(tiles.get(n)); return; }
    board[blank] = n;
    board[i] = 0;
    moves.push(n);
    paint();
    if (board.every((v, k) => v === SOLVED[k])) {
      sending = true;
      try {
        const r = await api.post("/challenge/today/slide", { moves });
        done(r.attempt);
      } catch (err) {
        toast(err.message, "error");
        sending = false;
      }
    }
  }
  // arrow keys move the tile *into* the gap from that direction
  grid.addEventListener("keydown", (e) => {
    const blank = board.indexOf(0);
    const from = { ArrowUp: blank + 3, ArrowDown: blank - 3, ArrowLeft: blank + 1, ArrowRight: blank - 1 }[e.key];
    if (from === undefined) return;
    e.preventDefault();
    if (from >= 0 && from < 9 && adjacent(from, blank)) move(board[from]);
  });
  paint();
  area.append(h("div.ch-slide-wrap", grid, h("div.ch-slide-side", counter, h("p.muted.small", "Put the tiles in order, 1 to 8, with the gap in the bottom-right corner. Click a tile next to the gap, or use the arrow keys."))));
  setTimeout(() => grid.focus(), 0);
}

/** Developer words: each guess is checked by the server (the answers never reach the page). */
function playWords(area, puzzle, done) {
  const rows = puzzle.scrambled.map((s, i) => {
    const solved = puzzle.done[String(i)];
    const input = h("input.ch-word-input", {
      type: "text", maxLength: s.length + 2, placeholder: `${s.length} letters`, autocomplete: "off", autocapitalize: "characters", spellcheck: false,
      "aria-label": `Unscramble ${s}`,
    });
    const skipBtn = h("button.btn.ghost.sm", { type: "button", title: "Show the word (+20 s)" }, "Skip +20 s");
    const row = h(`form.ch-word${solved ? ".ok" : ""}`,
      h("div.ch-letters", [...(solved || s)].map((c) => h("span", c))),
      solved ? h("span.ch-word-done", puzzle.skipped.includes(i) ? "skipped" : "✓") : [input, h("button.btn.sm.primary", { type: "submit" }, "Check"), skipBtn]);
    const finish = (word, skipped) => {
      clear(row, h("div.ch-letters", [...word].map((c) => h("span", c))), h("span.ch-word-done", skipped ? "skipped" : "✓"));
      row.classList.add("ok", "pop");
      const next = area.querySelector(".ch-word:not(.ok) input");
      next?.focus();
    };
    row.addEventListener("submit", async (e) => {
      e.preventDefault();
      const guess = input.value.trim();
      if (!guess) return;
      try {
        const r = await api.post("/challenge/today/answer", { item: i, answer: guess });
        if (r.correct) { sounds.sent(); finish(guess.toUpperCase(), false); } else { shake(row); input.select(); }
        done(r.attempt);
      } catch (err) { toast(err.message, "error"); }
    });
    skipBtn.addEventListener("click", async () => {
      try {
        const r = await api.post("/challenge/today/skip", { item: i });
        finish(r.word, true);
        done(r.attempt);
      } catch (err) { toast(err.message, "error"); }
    });
    return row;
  });
  area.append(h("div.ch-words", rows));
  setTimeout(() => area.querySelector(".ch-word:not(.ok) input")?.focus(), 0);
}

/** Math sprint: one question at a time; a wrong answer costs 5 s and stays until it's right. */
function playMath(area, puzzle, done) {
  let current = puzzle.current;
  const q = h("div.ch-q");
  const progress = h("div.ch-progress");
  const input = h("input.ch-answer", { type: "text", inputmode: "numeric", autocomplete: "off", "aria-label": "Your answer", placeholder: "?" });
  const form = h("form.ch-math", q, h("span.ch-eq", "="), input);
  const paint = () => {
    q.textContent = puzzle.questions[current] || "";
    clear(progress, puzzle.questions.map((_, i) => h(`span${i < current ? ".done" : i === current ? ".now" : ""}`)));
  };
  let sending = false;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (sending || !input.value.trim()) return;
    sending = true;
    try {
      const r = await api.post("/challenge/today/answer", { item: current, answer: input.value });
      if (r.correct) {
        current += 1;
        input.value = "";
        form.classList.remove("pop");
        void form.offsetWidth;
        form.classList.add("pop");
      } else {
        shake(form);
        input.select();
      }
      if (!done(r.attempt)) paint();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      sending = false;
    }
  });
  paint();
  area.append(progress, form, h("p.muted.small.ch-hint", "Type the answer and press Enter."));
  setTimeout(() => input.focus(), 0);
}

/** Dev wordle: guesses are checked (and coloured) by the server; on-screen or physical keyboard. */
function playWordle(area, puzzle, done, { reveal }) {
  const n = puzzle.length;
  const guesses = puzzle.guesses.slice();
  let typed = "";
  let sending = false;
  const grid = h("div.ch-wordle", { style: { "--n": n } });
  const keyState = {};
  const RANK = { miss: 1, near: 2, hit: 3 };
  const keys = h("div.ch-keys");
  const rowsEl = Array.from({ length: puzzle.tries }, () => {
    const row = h("div.ch-wrow", Array.from({ length: n }, () => h("span.ch-wtile")));
    grid.append(row);
    return row;
  });
  const paint = () => {
    rowsEl.forEach((row, r) => {
      const g = guesses[r];
      [...row.children].forEach((tile, i) => {
        tile.className = "ch-wtile";
        if (g) { tile.textContent = g.word[i]; tile.classList.add(g.marks[i]); }
        else if (r === guesses.length) { tile.textContent = typed[i] || ""; if (typed[i]) tile.classList.add("typed"); }
        else tile.textContent = "";
      });
    });
    guesses.forEach((g) => [...g.word].forEach((c, i) => { if ((RANK[g.marks[i]] || 0) > (RANK[keyState[c]] || 0)) keyState[c] = g.marks[i]; }));
    keys.querySelectorAll("[data-k]").forEach((b) => { b.className = `ch-key ${keyState[b.dataset.k] || ""}`; });
  };
  async function submit() {
    if (sending) return;
    if (typed.length !== n) { shake(rowsEl[guesses.length]); return; }
    sending = true;
    try {
      const r = await api.post("/challenge/today/guess", { guess: typed });
      guesses.push(r.entry);
      typed = "";
      paint();
      rowsEl[guesses.length - 1].classList.add("flip");
      if (r.answer) reveal(r.answer);
      if (r.solved) sounds.sent();
      setTimeout(() => done(r.attempt), r.attempt.status === "done" ? 900 : 0);
    } catch (err) { shake(rowsEl[guesses.length]); toast(err.message, "error"); } finally { sending = false; }
  }
  const press = (k) => {
    if (k === "ENTER") submit();
    else if (k === "⌫") { typed = typed.slice(0, -1); paint(); }
    else if (/^[A-Z]$/.test(k) && typed.length < n) { typed += k; paint(); }
  };
  ["QWERTYUIOP", "ASDFGHJKL", "↵ZXCVBNM⌫"].forEach((line) => keys.append(h("div.ch-krow", [...line].map((c) => {
    const k = c === "↵" ? "ENTER" : c;
    return h("button.ch-key", { type: "button", dataset: /^[A-Z]$/.test(k) ? { k } : {}, class: k.length > 1 || c === "⌫" ? "wide" : "", onclick: () => press(k) }, c === "↵" ? "Enter" : c);
  }))));
  const onKey = (e) => {
    if (!area.isConnected) { document.removeEventListener("keydown", onKey); return; }
    if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest?.("input, textarea")) return;
    const k = e.key === "Enter" ? "ENTER" : e.key === "Backspace" ? "⌫" : e.key.toUpperCase();
    if (k === "ENTER" || k === "⌫" || /^[A-Z]$/.test(k)) { e.preventDefault(); press(k); }
  };
  document.addEventListener("keydown", onKey);
  paint();
  area.append(grid, keys, h("p.muted.small.ch-hint", "Type on your keyboard or tap the letters. 🟩 right spot · 🟨 in the word · ⬜ not in it."));
}

const PEG = ["", "#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#a855f7", "#ec4899"];

/** Code breaker: four coloured digits; the server answers with ● (right place) and ○ (wrong place). */
function playCode(area, puzzle, done, { reveal }) {
  const guesses = puzzle.guesses.slice();
  let typed = "";
  let sending = false;
  const peg = (d) => h(`span.ch-peg${d ? "" : ".blank"}`, { style: d ? { "--c": PEG[d] } : {} }, d || "");
  const board = h("div.ch-code");
  const left = h("span.muted.small");
  const paint = () => {
    clear(board,
      guesses.map((g, i) => h("div.ch-crow", h("span.ch-cnum", String(i + 1)), [...g.code].map((d) => peg(Number(d))),
        h("span.ch-fb", { title: `${g.exact} right place, ${g.near} wrong place` },
          Array.from({ length: g.exact }, () => h("i.exact")), Array.from({ length: g.near }, () => h("i.near")),
          Array.from({ length: 4 - g.exact - g.near }, () => h("i"))))),
      guesses.length < puzzle.tries ? h("div.ch-crow.current", h("span.ch-cnum", String(guesses.length + 1)),
        Array.from({ length: 4 }, (_, i) => peg(Number(typed[i]) || 0))) : null);
    left.textContent = `${puzzle.tries - guesses.length} tries left`;
  };
  async function submit() {
    if (sending) return;
    if (typed.length !== 4) { shake(board); return; }
    sending = true;
    try {
      const r = await api.post("/challenge/today/guess", { guess: typed });
      guesses.push(r.entry);
      typed = "";
      paint();
      if (r.answer) reveal([...r.answer].join(" "));
      if (r.solved) sounds.sent();
      done(r.attempt);
    } catch (err) { toast(err.message, "error"); } finally { sending = false; }
  }
  const add = (d) => { if (typed.length < 4) { typed += d; paint(); } };
  const pad = h("div.ch-pad",
    [1, 2, 3, 4, 5, 6].map((d) => h("button.ch-pad-btn", { type: "button", style: { "--c": PEG[d] }, onclick: () => add(String(d)), "aria-label": `Digit ${d}` }, String(d))),
    h("button.btn.sm", { type: "button", onclick: () => { typed = typed.slice(0, -1); paint(); } }, "⌫"),
    h("button.btn.sm.primary", { type: "button", onclick: submit }, "Guess"));
  const onKey = (e) => {
    if (!area.isConnected) { document.removeEventListener("keydown", onKey); return; }
    if (e.target.closest?.("input, textarea")) return;
    if (/^[1-6]$/.test(e.key)) add(e.key);
    else if (e.key === "Backspace") { typed = typed.slice(0, -1); paint(); }
    else if (e.key === "Enter") { e.preventDefault(); submit(); }
  };
  document.addEventListener("keydown", onKey);
  paint();
  area.append(h("div.ch-code-wrap", board, h("div.ch-code-side", pad, left,
    h("p.muted.small", "● right digit, right place  ·  ○ right digit, wrong place. Keys 1-6, Backspace and Enter work too."))));
}

/** Lights out: played in the page; the list of presses is replayed on the server. */
function playLights(area, puzzle, done) {
  let board = puzzle.board.slice();
  let presses = [];
  let sending = false;
  const counter = h("span.ch-moves.ch-lights-count");
  const grid = h("div.ch-lights");
  const cells = board.map((_, i) => {
    const b = h("button.ch-light", { type: "button", "aria-label": `Light ${i + 1}`, onclick: () => press(i) });
    grid.append(b);
    return b;
  });
  const group = (i) => {
    const r = Math.floor(i / 5), c = i % 5;
    return [[r, c], [r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]].filter(([y, x]) => y >= 0 && y < 5 && x >= 0 && x < 5).map(([y, x]) => y * 5 + x);
  };
  const paint = () => {
    cells.forEach((b, i) => { b.classList.toggle("on", Boolean(board[i])); b.setAttribute("aria-pressed", String(Boolean(board[i]))); });
    const lit = board.filter(Boolean).length;
    counter.textContent = `${presses.length} press${presses.length === 1 ? "" : "es"} · ${lit} light${lit === 1 ? "" : "s"} on`;
  };
  async function press(i) {
    if (sending) return;
    group(i).forEach((j) => { board[j] ^= 1; });
    presses.push(i);
    paint();
    if (board.every((v) => !v)) {
      sending = true;
      try { done((await api.post("/challenge/today/lights", { moves: presses })).attempt); } catch (err) { toast(err.message, "error"); sending = false; }
    }
  }
  const reset = h("button.btn.ghost.sm", { type: "button", onclick: () => { board = puzzle.board.slice(); presses = []; paint(); } }, "Start over");
  paint();
  area.append(h("div.ch-slide-wrap", grid, h("div.ch-slide-side", counter, reset,
    h("p.muted.small", "Turn every light off. Pressing a light flips it and the lights above, below, left and right of it. Starting over keeps the clock running."))));
}

/** Number sequences: like the math sprint, one sequence at a time. */
function playSeq(area, puzzle, done) {
  let current = puzzle.current;
  const q = h("div.ch-q.ch-seq");
  const progress = h("div.ch-progress");
  const input = h("input.ch-answer", { type: "text", inputmode: "numeric", autocomplete: "off", "aria-label": "Next number", placeholder: "?" });
  const form = h("form.ch-math.ch-seq-form", q, h("span.ch-eq", "→"), input);
  const paint = () => {
    clear(q, (puzzle.questions[current] || "").split(", ").map((t) => h(`span${t === "?" ? ".ask" : ""}`, t)));
    clear(progress, puzzle.questions.map((_, i) => h(`span${i < current ? ".done" : i === current ? ".now" : ""}`)));
  };
  let sending = false;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (sending || !input.value.trim()) return;
    sending = true;
    try {
      const r = await api.post("/challenge/today/answer", { item: current, answer: input.value });
      if (r.correct) { current += 1; input.value = ""; form.classList.remove("pop"); void form.offsetWidth; form.classList.add("pop"); sounds.sent(); }
      else { shake(form); input.select(); }
      if (!done(r.attempt)) paint();
    } catch (err) { toast(err.message, "error"); } finally { sending = false; }
  });
  paint();
  area.append(progress, form, h("p.muted.small.ch-hint", "What comes next? Type the number and press Enter. Look at the gaps between numbers."));
  setTimeout(() => input.focus(), 0);
}

/** Haunted house (Halloween): rooms are opened one by one by the server - ghosts never reach the page early. */
function playHaunted(area, puzzle, done) {
  const size = puzzle.size;
  const cells = { ...puzzle.cells };
  const marks = new Set();
  let markMode = false;
  let pending = false;
  const grid = h("div.ch-haunt", { style: { "--size": size } });
  const ghostsLeft = h("span.ch-haunt-stat");
  const pumpkinsEl = h("span.ch-haunt-stat");
  const modeBtn = h("button.btn.sm", { type: "button", "aria-pressed": "false", onclick: () => { markMode = !markMode; modeBtn.setAttribute("aria-pressed", String(markMode)); modeBtn.textContent = markMode ? "🕯️ Mark mode: on" : "🕯️ Mark mode: off"; } }, "🕯️ Mark mode: off");
  const rooms = Array.from({ length: size * size }, (_, i) => {
    const b = h("button.ch-room", {
      type: "button", "aria-label": `Room ${Math.floor(i / size) + 1}-${(i % size) + 1}`,
      onclick: () => (markMode ? toggleMark(i) : open(i)),
      oncontextmenu: (e) => { e.preventDefault(); toggleMark(i); },
    });
    grid.append(b);
    return b;
  });
  const NUM = ["", "#7dd3fc", "#86efac", "#fcd34d", "#fdba74", "#f87171", "#e879f9", "#f472b6", "#fff"];
  const paint = () => {
    rooms.forEach((b, i) => {
      const c = cells[String(i)];
      b.className = "ch-room";
      b.textContent = "";
      b.style.removeProperty("--num");
      if (c?.ghost) { b.classList.add("ghost"); b.textContent = "👻"; }
      else if (c) {
        b.classList.add("open");
        if (c.pumpkin) { b.classList.add("pumpkin"); b.append(h("span", "🎃"), c.n ? h("sup", String(c.n)) : null); }
        else if (c.n) { b.textContent = String(c.n); b.style.setProperty("--num", NUM[c.n]); }
      } else if (marks.has(i)) { b.classList.add("marked"); b.textContent = "🕯️"; }
      b.disabled = Boolean(c);
    });
    const found = Object.values(cells).filter((c) => c.ghost).length;
    ghostsLeft.textContent = `👻 ${Math.max(puzzle.ghosts - found - marks.size, 0)} ghosts unmarked`;
    const pumpkins = Object.values(cells).filter((c) => c.pumpkin).length;
    pumpkinsEl.textContent = `🎃 ${pumpkins} / ${puzzle.pumpkins} pumpkins`;
  };
  const toggleMark = (i) => { if (cells[String(i)]) return; if (marks.has(i)) marks.delete(i); else marks.add(i); paint(); };
  async function open(i) {
    if (pending || cells[String(i)] || marks.has(i)) return;
    pending = true;
    try {
      const r = await api.post("/challenge/today/reveal", { index: i });
      Object.assign(cells, r.cells);
      paint();
      if (r.boo) boo(area);
      if (r.pumpkins) floatText(rooms[Object.keys(r.cells).map(Number).find((k) => r.cells[k].pumpkin)] || rooms[i], `🎃 −${5 * r.pumpkins} s`);
      if (r.all_ghosts) r.all_ghosts.forEach((g) => { if (!cells[String(g)]) { cells[String(g)] = { ghost: true }; } });
      if (r.all_ghosts) paint();
      setTimeout(() => done(r.attempt), r.attempt.status === "done" ? 800 : 0);
    } catch (err) { toast(err.message, "error"); } finally { pending = false; }
  }
  paint();
  area.append(
    h("div.ch-haunt-bar", ghostsLeft, pumpkinsEl, modeBtn),
    h("div.ch-haunt-wrap", grid),
    h("p.muted.small.ch-hint", "A number = ghosts in the 8 rooms around it. Right-click (or Mark mode) to put a candle on a haunted room. Open every safe room to escape!"));
}

function boo(host) {
  sounds.mention?.();
  const el = h("div.ch-boo", { "aria-hidden": "true" }, h("span", "👻"), h("strong", "BOO!"), h("small", "+15 s"));
  host.append(el);
  setTimeout(() => el.remove(), 1400);
}

function floatText(anchor, text) {
  const r = anchor.getBoundingClientRect();
  const el = h("div.ch-float", { style: { left: `${r.left + r.width / 2}px`, top: `${r.top}px` } }, text);
  document.body.append(el);
  setTimeout(() => el.remove(), 1300);
}

/** Bats flapping across the Halloween card. */
function bats() {
  return h("div.ch-bats", { "aria-hidden": "true" }, Array.from({ length: 5 }, (_, i) => h("span", { style: { "--i": i } }, "🦇")));
}

// ============================================================================ confetti
function confetti(host, spooky = false) {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  const layer = h("div.ch-confetti", { "aria-hidden": "true" });
  const colors = spooky ? ["#f97316", "#a855f7", "#fbbf24", "#16a34a", "#f97316", "#1f2937"] : ["#6366f1", "#f59e0b", "#10b981", "#ef4444", "#3b82f6", "#ec4899"];
  for (let i = 0; i < 70; i++) {
    const p = h("i");
    p.style.cssText = `left:${Math.random() * 100}%;background:${colors[i % colors.length]};--dx:${(Math.random() - 0.5) * 160}px;--r:${Math.random() * 720 - 360}deg;animation-delay:${Math.random() * 0.4}s;animation-duration:${1.6 + Math.random() * 1.2}s`;
    layer.append(p);
  }
  host.append(layer);
  setTimeout(() => layer.remove(), 3500);
}
