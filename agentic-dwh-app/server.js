"use strict";
const path = require("path");
const fs   = require("fs");
const https = require("https");

require("dotenv").config({ path: path.join(__dirname, ".env"), override: true });

// Corporate SSL inspection uses a custom root CA that Node.js doesn't trust by
// default. Build an agent that trusts the exported Windows root store so all
// outbound HTTPS (including the Anthropic SDK) goes through correctly.
const caPath = path.join(__dirname, "windows-ca.pem");
const httpsAgent = fs.existsSync(caPath)
  ? new https.Agent({ ca: fs.readFileSync(caPath), keepAlive: true })
  : undefined;

const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");
const { buildOrchestrator } = require("./agents/orchestrator");
const { exportPowerBI, resetWarehouse } = require("./agents/mockTools");
const { sourcesStatus, SOURCE_CLASSES, SUBJECT_AREAS, UPLOAD_DIR } = require("./agents/warehouse");

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json({ limit: "25mb" }));               // uploaded source files arrive as text
app.use(express.static(path.join(__dirname, "public")));
app.use("/samples", express.static(path.join(__dirname, "data", "sources")));   // sample-file downloads
app.use("/output",  express.static(path.join(__dirname, "data", "output")));    // generated Power BI files

const SOURCES_ROOT = path.join(__dirname, "data", "sources");

/* ───────────── Governance layer (Architecture Box 1) ─────────────
 * Monitors all agent actions with HIPAA-style audit logging, drift alerts,
 * human-approval brokering, and a kill switch. In-memory + append to file. */
const AUDIT_DIR = path.join(__dirname, "data", "audit");
fs.mkdirSync(AUDIT_DIR, { recursive: true });
const activeRuns = new Map();

const auditFile = () => path.join(AUDIT_DIR, `audit-${new Date().toISOString().slice(0, 10)}.jsonl`);
function writeAudit(entry) { try { fs.appendFileSync(auditFile(), JSON.stringify(entry) + "\n"); } catch { /* non-fatal */ } }
function shortDetail(ev) {
  if (ev.type === "tool_call") return `${ev.tool}(${JSON.stringify(ev.input || {}).slice(0, 120)})`;
  if (ev.type === "tool_result") return `${ev.tool} → ${String(ev.result || "").slice(0, 120)}`;
  if (ev.type === "delegate") return `→ ${ev.to}: ${String(ev.task || "").slice(0, 120)}`;
  if (ev.type === "text") return String(ev.text || "").slice(0, 120);
  if (ev.type === "approval_request") return `GATE ${ev.gate}`;
  if (ev.type === "approval_resolved") return `GATE ${ev.gate} → ${ev.decision}`;
  return ev.message || ev.result || "";
}

app.get("/api/health", (req, res) => {
  const key = process.env.ANTHROPIC_API_KEY || "";
  res.json({ status: "ok", hasApiKey: key.startsWith("sk-ant"), model: process.env.MODEL || "claude-sonnet-4-6" });
});

/* ───────────── Source landing: catalogue, upload, reset ───────────── */
const VALID_CATEGORIES = Object.keys(SOURCE_CLASSES);

app.get("/api/sources", (req, res) => {
  res.json({
    sourceClasses: SOURCE_CLASSES,
    subjectAreas: SUBJECT_AREAS.map((a) => ({ object: a.object, label: a.label, category: a.category, ext: a.ext })),
    status: sourcesStatus(),
  });
});

// Upload source files for a category (sent as text in JSON: {category, files:[{name, content}]}).
app.post("/api/upload", (req, res) => {
  const { category, files } = req.body || {};
  if (!VALID_CATEGORIES.includes(category)) return res.status(400).json({ error: "invalid category" });
  if (!Array.isArray(files) || !files.length) return res.status(400).json({ error: "no files" });
  const dir = path.join(UPLOAD_DIR, category);
  fs.mkdirSync(dir, { recursive: true });
  const saved = [];
  for (const f of files) {
    if (!f || !f.name) continue;
    const safe = path.basename(String(f.name));
    fs.writeFileSync(path.join(dir, safe), String(f.content ?? ""));
    saved.push(safe);
  }
  res.json({ ok: true, category, saved, status: sourcesStatus() });
});

// Reset to bundled sample data (clear all uploads).
app.post("/api/reset-sources", (req, res) => {
  try { fs.rmSync(UPLOAD_DIR, { recursive: true, force: true }); } catch {}
  res.json({ ok: true, status: sourcesStatus() });
});

/* Governance audit trail (latest run or a specific runId). */
app.get("/api/audit", (req, res) => {
  const runId = req.query.runId;
  const run = runId ? activeRuns.get(runId) : [...activeRuns.values()].pop();
  res.json({ runId: run?.runId || null, audit: run ? run.audit : [] });
});

/* Human approval decision for a governance gate. */
app.post("/api/decision", (req, res) => {
  const { runId, decision } = req.body || {};
  const run = activeRuns.get(runId);
  if (!run || !run.pendingApproval) return res.status(404).json({ error: "no pending approval for this run" });
  const verdict = decision === "approved" ? "approved" : "rejected";
  run.pendingApproval(verdict);
  run.pendingApproval = null;
  res.json({ ok: true, decision: verdict });
});

/* Kill switch — halts the run at the next agent step. */
app.post("/api/kill", (req, res) => {
  const { runId } = req.body || {};
  const run = activeRuns.get(runId);
  if (!run) return res.status(404).json({ error: "run not found" });
  run.killed = true;
  if (run.pendingApproval) { run.pendingApproval("rejected"); run.pendingApproval = null; }
  run.emit({ type: "governance", level: "kill", message: "KILL SWITCH activated by operator — halting pipeline." });
  res.json({ ok: true });
});

/* ───────────── Orchestration (SSE) ───────────── */
app.post("/api/orchestrate", async (req, res) => {
  const goal = (req.body.goal || "").trim();
  if (!goal) return res.status(400).json({ error: "goal is required" });

  const apiKey = process.env.ANTHROPIC_API_KEY || "";
  if (!apiKey.startsWith("sk-ant")) return res.status(400).json({ error: "ANTHROPIC_API_KEY not configured. Add it to .env" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const runId = "run_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
  const run = { runId, audit: [], killed: false, pendingApproval: null, emit: null };
  activeRuns.set(runId, run);

  const emit = (ev) => {
    const stamped = { ...ev, runId, ts: new Date().toISOString() };
    send(stamped);
    const entry = { ts: stamped.ts, runId, actor: ev.agent || "governance", event: ev.type, detail: shortDetail(ev) };
    run.audit.push(entry);
    writeAudit(entry);
    if (ev.type === "tool_result" && ev.tool === "detect_schema_drift" && /DRIFT DETECTED/i.test(ev.result || "")) {
      const msg = ev.result.split("\n")[0];
      const ts = new Date().toISOString();
      send({ type: "governance", level: "drift", message: msg, runId, ts });
      run.audit.push({ ts, runId, actor: "governance", event: "drift_alert", detail: msg });
      writeAudit({ ts, runId, actor: "governance", event: "drift_alert", detail: msg });
    }
  };
  run.emit = emit;

  const control = {
    isKilled: () => run.killed,
    requestApproval: (gate, summary) => new Promise((resolve) => {
      emit({ type: "approval_request", gate, summary });
      let settled = false;
      const finish = (decision, note) => {
        if (settled) return; settled = true;
        run.pendingApproval = null;
        emit({ type: "approval_resolved", gate, decision, ...(note ? { note } : {}) });
        resolve(decision);
      };
      run.pendingApproval = (decision) => finish(decision);
      // auto-approve fallback so an unattended demo keeps moving (60s)
      setTimeout(() => finish("approved", "auto-approved (timeout)"), 20000);
    }),
  };

  // SSE heartbeat keeps the connection alive during approval waits (prevents
  // the browser from suspending an idle stream).
  const heartbeat = setInterval(() => { try { res.write(`: ping\n\n`); } catch {} }, 15000);

  const clientOpts = { apiKey };
  if (httpsAgent) clientOpts.httpAgent = httpsAgent;
  const client = new Anthropic.default(clientOpts);
  const model = process.env.MODEL || "claude-sonnet-4-6";
  // Optional faster model for the 5 specialist agents (set SPECIALIST_MODEL in .env).
  const specialistModel = process.env.SPECIALIST_MODEL || model;

  try {
    resetWarehouse();                       // re-read current uploaded/sources
    send({ type: "start", goal, runId });
    const orchestrator = buildOrchestrator({ client, model, specialistModel, emit, control });
    const result = await orchestrator.run(goal);
    emit({ type: "final", result });

    // Generate the Power BI deliverables from the Gold marts (unless killed).
    if (!run.killed) {
      try {
        const outDir = path.join(__dirname, "data", "output", runId);
        const pbi = exportPowerBI(outDir);
        emit({
          type: "powerbi_output", runId,
          xlsx:  pbi.xlsx ? `/output/${runId}/${pbi.xlsx}` : null,
          pbids: `/output/${runId}/${pbi.pbids}`,
          csvDir: `/output/${runId}/csv/`,
          sheets: pbi.sheets, rows: pbi.rows,
        });
      } catch (e) { emit({ type: "governance", level: "warn", message: "Power BI export failed: " + e.message }); }
    }
  } catch (err) {
    console.error("[orchestrate error]", err.constructor.name, err.message);
    emit({ type: "error", message: err.message });
  } finally {
    clearInterval(heartbeat);
    send({ type: "done", runId });
    res.end();
    setTimeout(() => activeRuns.delete(runId), 5 * 60 * 1000);
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀  Agentic DWH (GOPhER → Snowflake) running at http://localhost:${PORT}\n`);
  const key = process.env.ANTHROPIC_API_KEY || "";
  console.log(key.startsWith("sk-ant") ? "✓  API key loaded" : "⚠   ANTHROPIC_API_KEY not set — add it to .env");
  console.log("✓  Governance: HIPAA audit log →", auditFile(), "\n");
});
