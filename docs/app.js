"use strict";
/* app.js — GitHub Pages (static) UI. Same look/flow as the server app, but
 * sources, the run, and approvals are wired to the in-browser engine (DWH) +
 * simulator (runSimulation). No server, no API key. */

const AGENTS = {
  orchestrator:           { icon: "🎛", label: "Orchestrator" },
  schema_migration_agent: { icon: "🗂", label: "Schema Migration" },
  ingestion_agent:        { icon: "📥", label: "Ingestion" },
  transformation_agent:   { icon: "⚙",  label: "Transformation" },
  data_quality_agent:     { icon: "🔎", label: "Data Quality" },
  bi_insight_agent:       { icon: "📊", label: "BI Insight" },
};
const DEFAULT_GOAL = "Run the full GOPhER → Snowflake migration end to end: convert the Sybase DDL and check for schema drift, ingest the Mainframe, Cloud-native and Direct DB sources into Bronze, build Silver and Gold through the medallion, run the data quality battery, and generate BI insights. Use human approval gates before Gold promotion and before publishing BI.";

const $ = (id) => document.getElementById(id);
const landing = $("landing"), app = $("app");
const goalInput = $("goalInput"), btnRun = $("btnRun"), btnKill = $("btnKill"), btnSources = $("btnSources");
const btnLaunch = $("btnLaunch"), btnLoadSamples = $("btnLoadSamples"), landingStatus = $("landingStatus");
const activityFeed = $("activityFeed"), emptyState = $("emptyState");
const runTimer = $("runTimer"), timerVal = $("timerVal");
const reportBody = $("reportBody"), reportMeta = $("reportMeta"), tabReport = $("tabReport"), reportBadge = $("reportBadge");
const powerbiBar = $("powerbiBar");
const govAlerts = $("govAlerts"), govApprovals = $("govApprovals"), auditTable = $("auditTable"), govCount = $("govCount");

let agentCards = {}, globalTimer = null, globalStart = null, finalReport = "", auditCount = 0, govItems = 0;
let killedFlag = false, pendingApprovalResolve = null;

/* ════════ landing ════════ */
async function fetchSources() {
  landingStatus.textContent = "Loading sources…";
  try {
    await DWH.loadAll();
    const status = DWH.sourcesStatus();
    const byCat = {}; status.forEach((s) => (byCat[s.category] = byCat[s.category] || []).push(s));
    for (const cat of Object.keys(DWH.SOURCE_CLASSES)) {
      const el = $("areas-" + cat); if (!el) continue;
      el.innerHTML = (byCat[cat] || []).map((s) => `
        <div class="area-chip ${s.source}">
          <a class="area-dl" href="./data/sources/${cat}/${s.object}.${s.ext}" download title="Download sample">${s.label}</a>
          <span class="area-meta">${s.rows.toLocaleString()} · ${s.source}</span>
        </div>`).join("");
    }
    const ready = status.every((s) => s.source !== "missing");
    btnLaunch.disabled = !ready;
    const up = status.filter((s) => s.source === "uploaded").length;
    landingStatus.textContent = ready ? `${status.length} subject areas ready${up ? ` (${up} uploaded)` : " (sample data)"}.` : "Some sources missing.";
  } catch (e) { landingStatus.textContent = "Could not load sources: " + e.message; }
}
function wireUploads() {
  document.querySelectorAll(".upload-card").forEach((card) => {
    const input = card.querySelector('input[type="file"]'), drop = card.querySelector(".uc-drop");
    input.addEventListener("change", () => handleFiles(input.files));
    ["dragover", "dragenter"].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.add("dragover"); }));
    ["dragleave", "drop"].forEach((e) => drop.addEventListener(e, () => drop.classList.remove("dragover")));
    drop.addEventListener("drop", (ev) => { ev.preventDefault(); handleFiles(ev.dataTransfer.files); });
  });
}
async function handleFiles(fileList) {
  let n = 0;
  for (const f of fileList) {
    const obj = DWH.resolveUploadName(f.name);
    if (!obj) continue;
    DWH.setUpload(obj, await f.text()); n++;
  }
  landingStatus.textContent = n ? `Loaded ${n} uploaded file(s).` : "No files matched a subject area.";
  await fetchSources();
}
btnLoadSamples.addEventListener("click", async () => { DWH.resetUploads(); await fetchSources(); });
btnLaunch.addEventListener("click", () => { showApp(); runPipeline(DEFAULT_GOAL); });
btnSources.addEventListener("click", showLanding);
function showApp()     { landing.style.display = "none"; app.style.display = "flex"; }
function showLanding() { app.style.display = "none"; landing.style.display = "flex"; resetRun(); fetchSources(); }

/* ════════ tabs ════════ */
window.switchTab = function (tab) {
  for (const t of ["activity", "governance", "report"]) {
    $("view" + cap(t)).style.display = t === tab ? "flex" : "none";
    $("tab" + cap(t)).classList.toggle("active", t === tab);
  }
  if (tab === "report") reportBadge.style.display = "none";
};
const cap = (s) => s[0].toUpperCase() + s.slice(1);

/* ════════ run lifecycle ════════ */
function resetRun() {
  activityFeed.innerHTML = ""; activityFeed.appendChild(emptyState); emptyState.style.display = "";
  agentCards = {}; finalReport = ""; auditCount = 0; govItems = 0; killedFlag = false; pendingApprovalResolve = null;
  reportBody.innerHTML = `<div class="empty-state"><div class="empty-icon">📋</div><div class="empty-title">Report not yet available</div><div class="empty-sub">The final summary + Power BI dataset will appear here.</div></div>`;
  reportMeta.textContent = ""; tabReport.style.display = "none"; reportBadge.style.display = "none";
  powerbiBar.style.display = "none"; powerbiBar.innerHTML = "";
  govAlerts.innerHTML = `<div class="gov-empty">No alerts.</div>`;
  govApprovals.innerHTML = `<div class="gov-empty">No approvals requested yet.</div>`;
  auditTable.innerHTML = `<div class="gov-empty">Audit entries will stream here as the pipeline runs.</div>`;
  govCount.style.display = "none"; govCount.textContent = "0";
  stopTimer(); resetSidebar(); btnKill.style.display = "none"; switchTab("activity");
}
function resetSidebar() {
  for (const k of Object.keys(AGENTS)) {
    const it = $(`step-${k}`); if (it) it.className = "step-item";
    const b = $(`badge-${k}`); if (b) { b.className = "step-badge"; b.innerHTML = ""; }
    const s = $(`status-${k}`); if (s) s.textContent = k === "orchestrator" ? "Idle" : "Waiting";
  }
}
function sidebar(agent, state) {
  const it = $(`step-${agent}`), b = $(`badge-${agent}`), s = $(`status-${agent}`); if (!it) return;
  if (state === "running") { it.className = "step-item running"; if (b) { b.className = "step-badge running"; b.innerHTML = '<span class="spinner"></span>'; } if (s) s.textContent = "Running…"; }
  else if (state === "done") { it.className = "step-item done"; if (b) { b.className = "step-badge done"; b.innerHTML = "✓"; } if (s) s.textContent = "Done"; }
}
function startTimer() { globalStart = Date.now(); runTimer.style.display = "flex"; globalTimer = setInterval(() => { const s = Math.floor((Date.now() - globalStart) / 1000); timerVal.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }, 1000); }
function stopTimer() { clearInterval(globalTimer); globalTimer = null; runTimer.style.display = "none"; }

btnRun.addEventListener("click", () => runPipeline());
goalInput.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) runPipeline(); });
btnKill.addEventListener("click", () => { killedFlag = true; btnKill.disabled = true; btnKill.textContent = "⛔ Killing…"; if (pendingApprovalResolve) pendingApprovalResolve("rejected"); });

const control = {
  isKilled: () => killedFlag,
  requestApproval: (gate, summary) => new Promise((resolve) => {
    let settled = false, timer = null;
    const finish = (decision, note) => {
      if (settled) return; settled = true;
      if (timer) clearTimeout(timer);          // clear THIS gate's timer (no stale cross-gate firing)
      pendingApprovalResolve = null;
      handleEvent({ type: "approval_resolved", gate, decision, ...(note ? { note } : {}), ts: new Date().toISOString() });
      resolve(decision);
    };
    pendingApprovalResolve = (decision) => finish(decision);   // invoked by decide() on click
    handleEvent({ type: "approval_request", gate, summary, ts: new Date().toISOString() });
    timer = setTimeout(() => finish("approved", "auto-approved (timeout)"), 30000);
  }),
};

async function runPipeline(goalArg) {
  const goal = (goalArg || goalInput.value || "").trim(); if (!goal) return;
  goalInput.value = goal;
  resetRun(); emptyState.style.display = "none";
  btnRun.disabled = true; btnRun.innerHTML = '<span class="spinner"></span>';
  startTimer(); createAgentCard("orchestrator", goal); sidebar("orchestrator", "running");
  btnKill.style.display = ""; btnKill.disabled = false; btnKill.textContent = "⛔ Kill";
  try {
    await runSimulation(goal, handleEvent, control);
  } catch (err) { showError(err.message); }
  finally { btnRun.disabled = false; btnRun.innerHTML = "▶ Re-run"; stopTimer(); sidebar("orchestrator", "done"); updateAgentCard("orchestrator", null, "done"); btnKill.style.display = "none"; }
}

/* ════════ event router (identical contract to the live server) ════════ */
function handleEvent(ev) {
  audit(ev);
  switch (ev.type) {
    case "delegate": createAgentCard(ev.to, ev.task); sidebar(ev.to, "running"); break;
    case "agent_done": if (ev.agent !== "orchestrator") { updateAgentCard(ev.agent, ev.result, "done"); sidebar(ev.agent, "done"); } break;
    case "approval_request": renderApproval(ev); break;
    case "approval_resolved": resolveApproval(ev); break;
    case "governance": renderGovAlert(ev); break;
    case "powerbi_output": renderPowerBI(ev); break;
    case "final": finalReport = ev.result; updateAgentCard("orchestrator", ev.result, "done"); renderReport(ev.result); break;
    case "error": showError(ev.message); break;
  }
}

/* ════════ agent cards ════════ */
function createAgentCard(agent, task) {
  const m = AGENTS[agent] || { icon: "🤖", label: agent };
  emptyState.style.display = "none";
  const card = document.createElement("div");
  card.className = "agent-card running"; card.dataset.agent = agent;
  card.innerHTML = `<div class="ac-header"><span class="ac-icon">${m.icon}</span><span class="ac-agent-name">${m.label}</span><span class="ac-timer">0:00</span><div class="ac-status-dot"></div></div>
    <div class="ac-body"><div class="ac-task">${esc((task || "").slice(0, 220))}</div><div class="ac-result"></div><div class="ac-progress"><div class="ac-progress-bar"></div></div></div>`;
  const start = Date.now(); agentCards[agent] = { el: card, start };
  const timerEl = card.querySelector(".ac-timer");
  const iv = setInterval(() => { const s = Math.floor((Date.now() - start) / 1000); timerEl.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; if (!card.classList.contains("running")) clearInterval(iv); }, 1000);
  activityFeed.appendChild(card); activityFeed.scrollTop = activityFeed.scrollHeight;
}
function updateAgentCard(agent, result, state) {
  const e = agentCards[agent]; if (!e) return;
  const card = e.el, resEl = card.querySelector(".ac-result"), tEl = card.querySelector(".ac-timer");
  const s = Math.floor((Date.now() - e.start) / 1000); tEl.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  card.classList.remove("running"); card.classList.add(state === "error" ? "error" : "done");
  if (result) resEl.innerHTML = buildSummary(result);
  activityFeed.scrollTop = activityFeed.scrollHeight;
}
function buildSummary(raw) {
  const t = raw.slice(0, 900), pills = [];
  const st = t.match(/STATUS:\s*(PASS|FAIL)/i); if (st) pills.push(pill(st[1], st[1] === "PASS" ? "pass" : "fail"));
  const ck = t.match(/(\d+)\s+passed/i); if (ck) pills.push(pill(`${ck[1]} checks`, "pass"));
  const md = t.match(/(\d+)\s+(?:STAGING|MARTS)?\s*models/i); if (md) pills.push(pill(`${md[1]} models`, "info"));
  const rw = t.match(/([\d,]+)\s+rows/i); if (rw) pills.push(pill(`${rw[1]} rows`, "info"));
  if (/drift/i.test(t)) pills.push(pill("schema drift", "warn"));
  const first = raw.replace(/[#*`]/g, "").split(/\n/).find((l) => l.trim().length > 12) || "";
  return (pills.length ? `<div class="ac-summary">${pills.join("")}</div>` : "") + `<p class="ac-first">${esc(first.slice(0, 180))}</p>`;
}
const pill = (txt, cls) => `<span class="ac-pill pill-${cls}">${esc(txt)}</span>`;

/* ════════ approvals ════════ */
function renderApproval(ev) {
  emptyState.style.display = "none";
  const card = document.createElement("div");
  card.className = "approval-card"; card.dataset.gate = ev.gate;
  card.innerHTML = `<div class="appr-head">✋ Human approval required — <b>${esc(ev.gate)}</b></div>
    <div class="appr-summary">${esc((ev.summary || "").slice(0, 600))}</div>
    <div class="appr-actions"><button class="btn-approve">✓ Approve</button><button class="btn-reject">✕ Reject</button></div>`;
  card.querySelector(".btn-approve").addEventListener("click", () => decide(card, "approved"));
  card.querySelector(".btn-reject").addEventListener("click", () => decide(card, "rejected"));
  activityFeed.appendChild(card); activityFeed.scrollTop = activityFeed.scrollHeight;
  addGovApproval(ev.gate, "PENDING"); flashGov();
}
function decide(card, decision) {
  card.querySelectorAll("button").forEach((b) => (b.disabled = true));
  if (pendingApprovalResolve) pendingApprovalResolve(decision);   // finish() emits approval_resolved + clears timer
}
function resolveApproval(ev) {
  const cards = [...document.querySelectorAll(".approval-card")].filter((c) => c.dataset.gate === ev.gate && !c.classList.contains("resolved"));
  const card = cards[cards.length - 1];
  if (card) { card.classList.add("resolved", ev.decision); card.querySelector(".appr-actions").innerHTML = `<span class="appr-verdict ${ev.decision}">${ev.decision === "approved" ? "✓ APPROVED" : "✕ REJECTED"}${ev.note ? " · " + esc(ev.note) : ""}</span>`; }
  updateGovApproval(ev.gate, ev.decision.toUpperCase());
}

/* ════════ governance ════════ */
function renderGovAlert(ev) {
  const empty = govAlerts.querySelector(".gov-empty"); if (empty) empty.remove();
  const div = document.createElement("div"); div.className = "gov-alert " + (ev.level === "kill" ? "kill" : "drift");
  div.innerHTML = `<span class="ga-tag">${ev.level === "kill" ? "⛔ KILL" : "⚠ DRIFT"}</span> <span>${esc(ev.message || "")}</span><span class="ga-ts">${tm(ev.ts)}</span>`;
  govAlerts.appendChild(div); flashGov();
  if (ev.level === "kill") { const c = agentCards["orchestrator"]; if (c) c.el.classList.add("error"); }
}
function addGovApproval(gate, state) {
  const empty = govApprovals.querySelector(".gov-empty"); if (empty) empty.remove();
  const div = document.createElement("div"); div.className = "gov-appr"; div.dataset.gate = gate;
  div.innerHTML = `<span>✋ ${esc(gate)}</span><span class="appr-state pending">${state}</span>`;
  govApprovals.appendChild(div);
}
function updateGovApproval(gate, state) {
  const rows = [...govApprovals.querySelectorAll(".gov-appr")].filter((r) => r.dataset.gate === gate);
  const row = rows[rows.length - 1]; if (!row) return;
  const s = row.querySelector(".appr-state"); s.textContent = state; s.className = "appr-state " + state.toLowerCase();
}
function flashGov() { govItems++; govCount.style.display = ""; govCount.textContent = String(govItems); }
function audit(ev) {
  if (["start", "done"].includes(ev.type)) return;
  const empty = auditTable.querySelector(".gov-empty"); if (empty) empty.remove();
  const actor = ev.agent || "governance";
  const detail = ev.type === "tool_call" ? `${ev.tool}(${JSON.stringify(ev.input || {}).slice(0, 80)})`
    : ev.type === "tool_result" ? `${ev.tool} → ${String(ev.result || "").replace(/\n/g, " ").slice(0, 90)}`
    : ev.type === "delegate" ? `→ ${ev.to}` : ev.type === "text" ? String(ev.text || "").slice(0, 90)
    : ev.type === "approval_request" ? `GATE: ${ev.gate}` : ev.type === "approval_resolved" ? `GATE ${ev.gate} → ${ev.decision}`
    : ev.type === "powerbi_output" ? `Power BI dataset generated (${(ev.sheets || []).length} sheets)`
    : ev.type === "governance" ? ev.message : ev.message || "";
  if (!detail) return;
  const row = document.createElement("div"); row.className = "audit-row" + (ev.type === "governance" || ev.type.startsWith("approval") || ev.type === "powerbi_output" ? " gov" : "");
  row.innerHTML = `<span class="au-ts">${tm(ev.ts)}</span><span class="au-actor">${esc(actor)}</span><span class="au-ev">${esc(ev.type)}</span><span class="au-detail">${esc(detail)}</span>`;
  auditTable.appendChild(row); auditTable.scrollTop = auditTable.scrollHeight; auditCount++;
}

/* ════════ Power BI + report ════════ */
function renderPowerBI(ev) {
  powerbiBar.style.display = "";
  powerbiBar.innerHTML = `
    <div class="pbi-title">📊 Power BI dataset generated from Gold</div>
    <div class="pbi-links">
      ${ev.xlsx ? `<a class="pbi-dl primary" href="${ev.xlsx}" download="gopher_gold_dataset.xlsx">⬇ Excel dataset (.xlsx)</a>` : ""}
      <a class="pbi-dl" href="${ev.pbids}" download="gopher_powerbi.pbids">⬇ Power BI connector (.pbids)</a>
      <span class="pbi-meta">${(ev.sheets || []).length} sheets · ${((ev.rows && ev.rows.claims) || 0).toLocaleString()} claims · ${(ev.rows && ev.rows.members) || 0} members</span>
    </div>`;
  tabReport.style.display = ""; reportBadge.style.display = "";
}
function renderReport(md) {
  if (!md) return;
  const el = Math.floor((Date.now() - globalStart) / 1000);
  reportMeta.textContent = `Generated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · runtime ${Math.floor(el / 60)}m ${el % 60}s · ${auditCount} audited actions`;
  reportBody.innerHTML = `<div class="md">${typeof marked !== "undefined" ? marked.parse(md) : esc(md)}</div>`;
  tabReport.style.display = ""; reportBadge.style.display = ""; switchTab("report");
}
window.copyReport = async () => { if (finalReport) { await navigator.clipboard.writeText(finalReport).catch(() => {}); toast("✓ Report copied"); } };
window.downloadReport = () => { if (!finalReport) return; const b = new Blob([finalReport], { type: "text/markdown" }); const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = "gopher-migration-report.md"; a.click(); URL.revokeObjectURL(a.href); };

/* ════════ misc ════════ */
function showError(msg) {
  emptyState.style.display = "none";
  const d = document.createElement("div"); d.className = "agent-card error";
  d.innerHTML = `<div class="ac-header"><span class="ac-icon">⚠</span><span class="ac-agent-name">Error</span><div class="ac-status-dot"></div></div><div class="ac-body"><div class="ac-result" style="display:block;color:var(--red)">${esc(msg)}</div></div>`;
  activityFeed.appendChild(d); activityFeed.scrollTop = activityFeed.scrollHeight;
}
function toast(t) { const e = document.createElement("div"); e.className = "copied-toast"; e.textContent = t; document.body.appendChild(e); setTimeout(() => e.remove(), 2000); }
function tm(ts) { return ts ? new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : ""; }
function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

/* ════════ init ════════ */
wireUploads();
fetchSources();
