const q = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const showError = (text) => { $("error").textContent = text; $("error").hidden = !text; };

$("server").value = q.get("server") || "";
if (q.get("error")) {
  $("title").textContent = "Can't connect";
  $("lead").textContent = "The app couldn't load your Tickets server.";
  showError(q.get("error"));
  if (q.get("server")) $("retry").hidden = false;
}
$("retry").addEventListener("click", () => window.desktop.retry());
$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const go = $("go");
  go.disabled = true;
  go.textContent = "Connecting…";
  showError("");
  const res = await window.desktop.connect($("server").value).catch((err) => ({ ok: false, error: err.message }));
  if (!res.ok) {
    showError(res.error);
    go.disabled = false;
    go.textContent = "Connect";
  }
});
$("server").focus();
