// Profiles: "#/profile" edits your own (photo, about, contact, skills, time zone, coach settings);
// "#/people/:id" shows a teammate's.
import { api, auth, request } from "../api.js";
import { icon } from "../icons.js";
import { navigate } from "../app.js";
import { avatar, busy, clear, field, h, toast } from "../ui.js";
import { COACH_TONES, refreshCoach } from "./coach.js";

const MAX_SKILLS = 15;

/** Centre-crop and shrink a picked image to a 256px square JPEG (keeps uploads tiny). */
async function squarePhoto(file) {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = Object.assign(document.createElement("canvas"), { width: 256, height: 256 });
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, 256, 256);
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 256, 256);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88));
}

function localTime(zone) {
  try {
    return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone: zone || undefined }).format(new Date());
  } catch { return null; }
}

function zoneOptions(current) {
  let zones = [];
  try { zones = Intl.supportedValuesOf("timeZone"); } catch { /* old browser: free text below */ }
  if (current && !zones.includes(current)) zones.unshift(current);
  return zones;
}

/** Type a skill and press Enter or comma; × removes one. */
function skillsInput(initial) {
  let skills = [...initial];
  const chips = h("div.skill-chips");
  const input = h("input", { placeholder: "Add a skill and press Enter", maxLength: 30 });
  const paint = () => {
    clear(chips, skills.map((s, i) => h("span.skill", s,
      h("button.chip-btn", { type: "button", "aria-label": `Remove ${s}`, onclick: () => { skills.splice(i, 1); paint(); } }, icon("x", { size: 12 })))));
    input.disabled = skills.length >= MAX_SKILLS;
  };
  const add = () => {
    const v = input.value.replace(/,/g, "").trim();
    input.value = "";
    if (v && !skills.some((s) => s.toLowerCase() === v.toLowerCase()) && skills.length < MAX_SKILLS) { skills.push(v); paint(); }
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); }
    else if (e.key === "Backspace" && !input.value && skills.length) { skills.pop(); paint(); }
  });
  input.addEventListener("blur", add);
  paint();
  return { el: h("div.skills-input", chips, input), get value() { add(); return skills.slice(); } };
}

function profileCard(p, { me = false } = {}) {
  const time = localTime(p.timezone);
  return h("div.profile-card",
    h("div.profile-cover"),
    h("div.profile-id",
      avatar(p, "xl"),
      h("div.profile-names",
        h("h2", p.name),
        p.designation ? h("span.muted", p.designation) : me ? h("span.muted.small", "Add your title") : null)),
    p.bio ? h("p.profile-bio", p.bio) : me ? h("p.profile-bio.muted", "Tell your team a little about yourself.") : null,
    p.skills?.length ? h("div.skill-chips.view", p.skills.map((s) => h("span.skill", s))) : null,
    h("ul.profile-facts",
      h("li", icon("mail", { size: 15 }), h("a", { href: `mailto:${p.email}` }, p.email)),
      p.phone && h("li", icon("phone", { size: 15 }), h("a", { href: `tel:${p.phone.replace(/[^+\d]/g, "")}` }, p.phone)),
      p.location && h("li", icon("map-pin", { size: 15 }), p.location),
      time && h("li", icon("clock", { size: 15 }), `${time} local time`, p.timezone ? h("span.muted.small", ` · ${p.timezone.replace(/_/g, " ")}`) : null)));
}

// ----------------------------------------------------------------------------- my profile
export async function renderProfile(main) {
  let p = await api.get("/profile");
  const preview = h("div.profile-preview");
  const paintPreview = () => clear(preview, profileCard({ ...p, ...current() }, { me: true }), h("p.hint.center", "This is how teammates see you."));

  const name = h("input", { value: p.name, required: true, maxLength: 120 });
  const designation = h("input", { value: p.designation || "", maxLength: 120, placeholder: "e.g. Backend developer" });
  const bio = h("textarea", { rows: 4, maxLength: 1000, placeholder: "What you work on, what you're good at, how you like to collaborate…" }, p.bio || "");
  const phone = h("input", { value: p.phone || "", maxLength: 40, type: "tel", placeholder: "+91 98765 43210" });
  const location = h("input", { value: p.location || "", maxLength: 120, placeholder: "City, country" });
  const zones = zoneOptions(p.timezone);
  const zone = zones.length
    ? h("select", h("option", { value: "" }, "Same as the team (default)"), zones.map((z) => h("option", { value: z, selected: z === p.timezone }, z.replace(/_/g, " "))))
    : h("input", { value: p.timezone || "", placeholder: "Asia/Kolkata" });
  const skills = skillsInput(p.skills || []);

  const coachOn = h("input", { type: "checkbox", checked: p.coach_enabled });
  const coachName = h("input", { value: p.coach_name, maxLength: 30, required: true });
  const goal = h("input", { type: "number", min: 1, max: 20, value: p.daily_goal, required: true });
  let tone = p.coach_tone;
  const toneCards = h("div.tone-grid", { role: "radiogroup", "aria-label": "Coach tone" });
  const paintTones = () => clear(toneCards, COACH_TONES.map((t) => h("button.tone-card", {
    type: "button", role: "radio", "aria-checked": String(t.id === tone),
    onclick: () => { tone = t.id; paintTones(); },
  }, h("span.tone-emoji", t.emoji), h("strong", t.name), h("span.muted.small", `“${t.sample}”`))));
  paintTones();

  const current = () => ({
    name: name.value.trim() || p.name, designation: designation.value.trim() || null, bio: bio.value.trim(),
    phone: phone.value.trim() || null, location: location.value.trim() || null, timezone: zone.value || null,
    skills: skills.value,
  });
  [name, designation, bio, phone, location, zone].forEach((el) => el.addEventListener("input", paintPreview));
  skills.el.addEventListener("keyup", paintPreview);

  // --- photo
  const fileInput = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", hidden: true });
  const photoBox = h("div.photo-row");
  const paintPhoto = () => clear(photoBox,
    avatar(p, "xl"),
    h("div.photo-actions",
      h("button.btn", { type: "button", onclick: () => fileInput.click() }, icon("camera", { size: 15 }), p.avatar_url ? "Change photo" : "Upload photo"),
      p.avatar_url && h("button.btn.ghost", { type: "button", onclick: removePhoto }, "Remove"),
      h("span.hint", "A square crop is made for you. PNG, JPEG, WebP or GIF.")));
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    fileInput.value = "";
    if (!file) return;
    await busy(null, async () => {
      const blob = file.type === "image/gif" ? file : await squarePhoto(file);
      const form = new FormData();
      form.append("file", blob, "avatar.jpg");
      p = await request("PUT", "/profile/avatar", { form });
      afterSave("Photo updated");
    });
  });
  async function removePhoto() {
    await busy(null, async () => { p = await api.del("/profile/avatar"); afterSave("Photo removed"); });
  }
  function afterSave(message) {
    auth.user = { ...auth.user, name: p.name, designation: p.designation, avatar_url: p.avatar_url };
    window.dispatchEvent(new CustomEvent("profile-changed"));
    paintPhoto();
    paintPreview();
    toast(message);
  }

  const form = h("form.form.profile-form",
    h("section.card",
      h("div.card-head", h("h2", "Photo")),
      photoBox, fileInput),
    h("section.card",
      h("div.card-head", h("h2", "About you")),
      h("div.grid-2.tight", field("Name", name), field("Title", designation)),
      field("Bio", bio, "Up to 1000 characters"),
      h("div.field", h("span.field-label", "Skills"), skills.el, h("span.hint", `Up to ${MAX_SKILLS} - press Enter after each`))),
    h("section.card",
      h("div.card-head", h("h2", "Contact & time")),
      h("div.grid-2.tight", field("Phone", phone), field("Location", location)),
      field("Time zone", zone, "Teammates see your local time; your coach counts your day in it.")),
    h("section.card.coach-settings",
      h("div.card-head", h("h2", icon("sparkles", { size: 18 }), " Your coach"),
        h("label.switch", coachOn, h("span.slider"), h("span.small", "On"))),
      h("p.muted.small", "Your coach picks your next task, keeps track of your daily goal and streak, nudges you about stuck work and cheers when you finish something."),
      h("div.grid-2.tight", field("Coach name", coachName), field("Daily goal", goal, "Tickets to finish per day")),
      h("div.field", h("span.field-label", "Tone"), toneCards)),
    h("div.form-actions.sticky-actions", h("button.btn.primary", { type: "submit" }, "Save profile")));

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    busy(form.querySelector("[type=submit]"), async () => {
      p = await api.patch("/profile", {
        ...current(), coach_enabled: coachOn.checked, coach_name: coachName.value.trim(), coach_tone: tone, daily_goal: Number(goal.value),
      });
      afterSave("Profile saved");
      refreshCoach();
    });
  });

  paintPhoto();
  paintPreview();
  clear(main,
    h("div.page-head",
      h("div", h("h1", "Your profile"), h("p.muted", "Help your team know who you are - and set up the coach that keeps you going.")),
      h("div.actions", h("a.btn", { href: `#/people/${p.id}` }, "View as teammate"))),
    h("div.profile-layout", form, preview));
}

// ----------------------------------------------------------------------------- someone's profile
export async function renderPerson(main, id) {
  const p = await api.get(`/people/${id}`);
  const me = p.id === auth.user.id;
  const s = p.stats;
  const tile = (value, text, ic) => h("div.person-stat", icon(ic, { size: 16 }), h("strong", String(value)), h("span.muted.small", text));

  async function message() {
    await busy(null, async () => { const ch = await api.post("/chat/dm", { user_ids: [p.id] }); navigate(`/chat/${ch.id}`); });
  }

  clear(main,
    h("div.crumbs", h("a", { href: "#/" }, "Dashboard"), " / ", "People"),
    h("div.person-layout",
      h("div",
        profileCard(p, { me }),
        h("div.row.wrap.person-actions",
          me ? h("a.btn.primary", { href: "#/profile" }, icon("edit", { size: 15 }), "Edit profile")
            : h("button.btn.primary", { onclick: message }, icon("message", { size: 15 }), "Message"),
          h("a.btn", { href: me ? "#/tickets?assignee=me" : `#/tickets?assignee=${p.id}` }, icon("tickets", { size: 15 }), me ? "My tickets" : "Their tickets"))),
      h("div.person-side",
        h("section.card",
          h("div.card-head", h("h2", "Right now")),
          h("div.person-stats",
            tile(s.open, "open tickets", "tickets"),
            tile(s.in_progress, "in progress", "play"),
            tile(s.done_30d, "finished in 30 days", "check-circle"),
            tile(s.streak ? `${s.streak} 🔥` : "0", "day streak", "flame"))),
        p.shared_projects.length ? h("section.card",
          h("div.card-head", h("h2", me ? "Your projects" : "Projects together")),
          h("div.chips", p.shared_projects.map((pr) => h("a.chip", { href: `#/projects/${pr.id}` }, h("span.key-pill", pr.key), pr.name)))) : null)));
}
