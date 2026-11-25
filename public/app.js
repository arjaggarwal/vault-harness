// Dashboard: polls the JSON API every few seconds. No framework, no build.

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const when = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : "—");
const badge = (status) => `<span class="badge s-${esc(status)}">${esc(status)}</span>`;

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...opts });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

const openRuns = new Set();

async function refresh() {
  try {
    const [jobs, runs, asks] = await Promise.all([api("/api/jobs"), api("/api/runs?limit=30"), api("/api/asks")]);
    renderJobs(jobs);
    renderRuns(runs);
    renderAsks(asks);
  } catch (err) {
    console.error(err);
  }
}

function renderJobs(jobs) {
  $("#jobs tbody").innerHTML = jobs
    .map((j) => {
      const manualOnly = j.id === "ask-vault" || j.id === "code-task";
      const last = j.lastRun ? `${badge(j.lastRun.status)} <span class="muted small">${when(j.lastRun.startedAt)}</span>` : "—";
      return `<tr>
        <td><strong>${esc(j.title)}</strong><br><code class="muted">${esc(j.id)}</code></td>
        <td>${esc(j.type)}${j.provider ? ` <span class="muted small">${esc(j.provider)}</span>` : ""}</td>
        <td><code>${esc(j.schedule ?? "manual")}</code></td>
        <td>${when(j.nextRunAt)}</td>
        <td>${j.running ? badge("running") : last}</td>
        <td>${manualOnly ? "" : `<button data-run="${esc(j.id)}" ${j.running ? "disabled" : ""}>Run now</button>`}</td>
      </tr>`;
    })
    .join("");
}

function renderRuns(runs) {
  $("#runs").innerHTML =
    runs
      .map((r) => {
        const open = openRuns.has(r.id);
        const body = open
          ? `${r.error ? `<pre class="s-failed">${esc(r.error)}</pre>` : ""}
             ${r.writes?.length ? `<div class="small">Wrote: ${r.writes.map((w) => `<code>${esc(w)}</code>`).join(", ")}</div>` : ""}
             ${r.output ? `<pre>${esc(r.output)}</pre>` : ""}`
          : "";
        return `<li data-run-id="${esc(r.id)}">
          <div class="head">${badge(r.status)} <strong>${esc(r.jobId)}</strong>
            <span class="muted small">${esc(r.trigger)} · ${when(r.startedAt)}</span></div>
          <div>${esc(r.summary ?? "")}</div>${body}
        </li>`;
      })
      .join("") || `<li class="muted">No runs yet. Press Run now on a job.</li>`;
}

function renderAsks(asks) {
  $("#ask-count").textContent = asks.length ? `(${asks.length})` : "";
  $("#asks").innerHTML =
    asks
      .map(
        (a) => `<div class="ask">
          <div><strong>${esc(a.question)}</strong></div>
          <div class="muted small">${esc(a.jobId)} · ${when(a.createdAt)}</div>
          ${a.detail ? `<pre>${esc(a.detail)}</pre>` : ""}
          <div class="actions">
            <button class="primary" data-ask="${esc(a.id)}" data-decision="approve">Approve</button>
            <button data-ask="${esc(a.id)}" data-decision="decline">Decline</button>
          </div>
        </div>`,
      )
      .join("") || `<p class="muted">Nothing waiting.</p>`;
}

document.addEventListener("click", async (e) => {
  const run = e.target.closest("[data-run]");
  if (run) {
    run.disabled = true;
    await api(`/api/jobs/${run.dataset.run}/run`, { method: "POST" }).catch((err) => alert(err.message));
    return refresh();
  }
  const ask = e.target.closest("[data-ask]");
  if (ask) {
    ask.parentElement.querySelectorAll("button").forEach((b) => (b.disabled = true));
    await api(`/api/asks/${ask.dataset.ask}/${ask.dataset.decision}`, { method: "POST" }).catch((err) => alert(err.message));
    return refresh();
  }
  const li = e.target.closest("[data-run-id]");
  if (li) {
    const id = li.dataset.runId;
    openRuns.has(id) ? openRuns.delete(id) : openRuns.add(id);
    refresh();
  }
});

$("#ask-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const question = $("#question").value.trim();
  if (!question) return;
  $("#answer").innerHTML = `<p class="muted">Searching the vault…</p>`;
  try {
    const res = await api("/api/ask-vault", { method: "POST", body: JSON.stringify({ question }) });
    const cites = res.citations
      .map(
        (c) => `<div class="cite ${c.verified ? "ok" : "bad"}"><code>${esc(c.path)}:${c.line}</code>
          ${c.verified ? `<span class="muted">${esc(c.text)}</span>` : `<span class="s-failed">${esc(c.reason)}</span>`}</div>`,
      )
      .join("");
    $("#answer").innerHTML = `<pre>${esc(res.answer)}</pre>
      <div class="small ${res.grounded ? "s-succeeded" : "s-failed"}">${res.grounded ? "Every citation checked out." : "Some citations could not be verified."}</div>
      ${cites}`;
  } catch (err) {
    $("#answer").innerHTML = `<p class="s-failed">${esc(err.message)}</p>`;
  }
  refresh();
});

$("#code-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const task = $("#task").value.trim();
  if (!task) return;
  await api("/api/code-task", { method: "POST", body: JSON.stringify({ repo: $("#repo").value, task }) }).catch((err) =>
    alert(err.message),
  );
  $("#task").value = "";
  refresh();
});

(async function init() {
  const health = await api("/api/health").catch(() => null);
  if (health) $("#vault").textContent = health.vault;
  const repos = await api("/api/repos").catch(() => []);
  $("#repo").innerHTML = repos.map((r) => `<option>${esc(r)}</option>`).join("");
  refresh();
  setInterval(refresh, 3000);
})();
