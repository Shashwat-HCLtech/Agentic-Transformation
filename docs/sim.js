"use strict";
/* sim.js — client-side pipeline simulator for the GitHub Pages demo.
 * Drives orchestrator → 5 specialists with SCRIPTED reasoning, but every tool
 * call hits the REAL engine (DWH) so all numbers/DDL/DQ/KPIs/Power BI are real.
 * Emits the same event shapes as the live server so the UI is unchanged. */
window.runSimulation = async function (goal, emit, control) {
  const wh = DWH.wh;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const killed = () => control && control.isKilled && control.isKilled();
  async function tick(ms) { await sleep(ms); if (killed()) throw new Error("KILL"); }

  function table(rows, max = 6) {
    if (!rows.length) return "(0 rows)";
    const cols = Object.keys(rows[0]).filter((c) => !c.startsWith("_"));
    return [cols.join(" | "), cols.map(() => "---").join("-+-"),
      ...rows.slice(0, max).map((r) => cols.map((c) => String(r[c] ?? "")).join(" | ")), "", `(${rows.length} rows)`].join("\n");
  }

  // run one specialist: reasoning → tool calls (real engine) → done summary
  async function agent(name, task, reasoning, steps, summary) {
    emit({ type: "delegate", from: "orchestrator", to: name, task });
    await tick(450);
    emit({ type: "agent_start", agent: name, task });
    emit({ type: "text", agent: name, text: reasoning });
    await tick(500);
    for (const s of steps) {
      emit({ type: "tool_call", agent: name, tool: s.tool, input: s.input || {} });
      await tick(520);
      const result = s.run();
      emit({ type: "tool_result", agent: name, tool: s.tool, result });
      if (s.onResult) s.onResult(result);
      await tick(360);
    }
    emit({ type: "agent_done", agent: name, result: summary() });
    await tick(300);
  }

  async function gate(label, summary) {
    emit({ type: "text", agent: "orchestrator", text: `Governance gate reached: ${label}. Requesting human approval…` });
    await tick(300);
    const decision = control && control.requestApproval ? await control.requestApproval(label, summary) : "approved";
    if (decision !== "approved") { emit({ type: "text", agent: "orchestrator", text: `Gate "${label}" was REJECTED — halting and summarizing.` }); throw new Error("REJECTED:" + label); }
    return decision;
  }

  try {
    emit({ type: "start", goal, runId: "sim_" + Date.now().toString(36) });
    await DWH.loadAll();
    emit({ type: "text", agent: "orchestrator", text: "Decomposing the goal into the GOPhER→Snowflake migration plan: schema migration → ingestion → transformation → data quality → BI, with governance gates before Gold and BI publish." });
    await tick(500);

    /* ── Box 3: Schema Migration ── */
    let drift;
    await agent("schema_migration_agent",
      "Convert the Sybase GOPhER DDL for all subject areas to Snowflake and detect source schema drift vs the migration baseline.",
      "Inspecting the 7 GOPhER subject areas on SAP IQ, generating Snowflake DDL, and checking pharmacy_claims for drift.",
      [
        { tool: "list_sources", run: () => DWH.SUBJECT_AREAS.map((s) => `• ${s.label.padEnd(20)} ${DWH.wh.get("RAW." + s.object).length || "—"}  [${s.sybase_table}] → RAW.${s.object}`).join("\n") || DWH.SUBJECT_AREAS.map((s) => `• ${s.label} [${s.sybase_table}]`).join("\n") },
        { tool: "convert_ddl", input: { object: "pharmacy_claims" }, run: () => wh.generateSnowflakeDDL("pharmacy_claims").ddl },
        { tool: "detect_schema_drift", input: { object: "pharmacy_claims" }, run: () => { drift = wh.detectDrift("pharmacy_claims"); return drift.drift ? `⚠ SCHEMA DRIFT DETECTED on pharmacy_claims:\n  + columns added upstream: ${drift.added.join(", ")}` : "No drift."; },
          onResult: (r) => { if (/DRIFT/.test(r)) emit({ type: "governance", level: "drift", message: r.split("\n")[0] }); } },
      ],
      () => `7 tables converted to Snowflake DDL. Schema drift detected on RX_CLAIMS: +${(drift.added || []).join(", ")}. Recommend approval before propagating.`);

    await gate("Schema Drift — pharmacy_claims", `RX_CLAIMS gained 2 columns upstream (${(drift.added || []).join(", ")}). Approve to register them across RAW + downstream models.`);

    /* ── Box 4: Ingestion ── */
    await agent("ingestion_agent",
      "Generate ingestion configs and load all GOPhER subject areas from SAP IQ into Bronze/RAW.",
      "Auto-generating an Azure Data Factory copy pipeline, then loading all sources into Bronze with self-heal on failed slices.",
      [
        { tool: "generate_ingestion_config", input: { object: "pharmacy_claims", mode: "adf" }, run: () => `ADF pipeline pl_gopher_pharmacy_claims_to_snowflake: OdbcSource(SAP_IQ.GOPHER.RX_CLAIMS) → SnowflakeSink(RAW.PHARMACY_CLAIMS), retry=3, self-heal=rerunFailedSlices.` },
        { tool: "ingest_source", input: { object: "all" }, run: () => { const l = wh.ingestAll(); return l.map((x) => `  ✓ ${x.target.padEnd(26)} ${x.rows} rows`).join("\n") + `\n\nTotal: ${l.reduce((a, x) => a + x.rows, 0)} rows, 0 rejects.`; } },
      ],
      () => { const t = DWH.SUBJECT_AREAS.reduce((a, s) => a + wh.get("RAW." + s.object).length, 0); return `Loaded ${t} rows across 7 Bronze tables from SAP IQ. 0 rejects, self-heal not triggered.`; });

    /* ── Box 5: Transformation (Silver, then Gold after gate) ── */
    let staging;
    await agent("transformation_agent",
      "Generate dbt/Spark models and build the Silver (STAGING) layer from Bronze.",
      "Generating dbt models and materializing Silver: typecasting, deduplication, boolean flags, conformed keys.",
      [
        { tool: "generate_transform_code", input: { model: "stg_claims", engine: "dbt" }, run: () => "-- dbt model stg_claims: cast numerics, Y/N→boolean is_generic, dedupe claim_id, derive is_revenue flags." },
        { tool: "build", input: { select: "staging" }, run: () => { staging = wh.buildStaging(); return staging.map((b) => `  ✓ ${b.model.padEnd(26)} ${b.rows} rows`).join("\n"); } },
      ],
      () => `Silver built: ${staging.length} STAGING models, ${staging.reduce((a, b) => a + b.rows, 0)} rows. Awaiting approval to promote to Gold.`);

    await gate("Promote to Gold (MARTS)", `Silver validated (${staging.reduce((a, b) => a + b.rows, 0)} rows). Approve to build Gold dims/facts (dim_member, dim_drug, fct_pharmacy_claims, fct_rejected_claims, agg_drug_class).`);

    let marts;
    await agent("transformation_agent",
      "Promote Silver to Gold: build dimensions, facts and the drug-class aggregate.",
      "Approval granted. Building Gold: joining claims↔member↔drug↔rebate, deriving rebate_amount and net_cost, aggregating by therapeutic class.",
      [
        { tool: "build", input: { select: "marts" }, run: () => { marts = wh.buildMarts(); return marts.map((b) => `  ✓ ${b.model.padEnd(26)} ${b.rows} rows`).join("\n"); } },
        { tool: "show", input: { select: "agg_drug_class" }, run: () => table(wh.get("MARTS.agg_drug_class"), 5) },
      ],
      () => `Gold built: ${marts.length} MARTS models, ${marts.reduce((a, b) => a + b.rows, 0)} rows, 0 failures.`);

    /* ── Box 6: Data Quality ── */
    let dq;
    await agent("data_quality_agent",
      "Run the data-quality battery across Silver and Gold; pause the pipeline on anomalies.",
      "Running not-null, uniqueness, referential-integrity, accepted-values, range, freshness and reconciliation checks.",
      [
        { tool: "test", run: () => { dq = wh.runChecks(); return Object.entries(dq.byCategory).map(([c, v]) => `  ${c.padEnd(24)} ${v.pass}/${v.run} PASS`).join("\n") + `\n\nSTATUS: ${dq.failed === 0 ? "PASS" : "FAIL"} — ${dq.passed} passed, ${dq.failed} failed (${dq.total} total checks)`; } },
      ],
      () => `STATUS: ${dq.failed === 0 ? "PASS" : "FAIL"} — ${dq.passed} passed, ${dq.failed} failed (${dq.total} total checks). No anomalies — pipeline may proceed.`);

    /* ── Box 7: BI / Insight ── */
    let m, byClass;
    await agent("bi_insight_agent",
      "Generate the executive KPI summary and key breakdowns from the Gold layer.",
      "Querying the Gold marts: total paid, rebates, GDR, rejected-claim rate, and spend by therapeutic class.",
      [
        { tool: "get_metrics_summary", run: () => { m = wh.metrics(); return [`Total Paid ............ $${m.total_paid_amount.toLocaleString()}`, `Total Rebates ........ $${m.total_rebates.toLocaleString()}`, `Net Pharmacy Cost .... $${m.net_pharmacy_cost.toLocaleString()}`, `Total Claims ......... ${m.total_claims.toLocaleString()}`, `Generic Disp. Rate ... ${m.generic_dispensing_rate_pct}%`, `Rejected Claim Rate .. ${m.rejected_claim_rate_pct}%`].join("\n"); } },
        { tool: "query_metrics", input: { dimensions: "drug_class" }, run: () => { byClass = wh.groupBy("MARTS.fct_pharmacy_claims", "drug_class", "total_paid_amount"); return table(byClass, 8); } },
      ],
      () => `KPIs ready: $${m.total_paid_amount.toLocaleString()} paid, ${m.generic_dispensing_rate_pct}% GDR, ${m.rejected_claim_rate_pct}% rejected. Top class: ${byClass[0].drug_class}.`);

    await gate("Publish BI Report", `Executive KPIs computed ($${m.total_paid_amount.toLocaleString()} paid, ${m.generic_dispensing_rate_pct}% GDR). Approve to publish the report + Power BI dataset.`);

    /* ── Final report (real numbers) ── */
    const top = byClass.slice(0, 4).map((c) => `${c.drug_class} ($${c.total_paid_amount.toLocaleString()})`).join(" · ");
    const cats = Object.entries(dq.byCategory).map(([c, v]) => `| ${c} | ${v.pass} | ${v.run} | ✅ PASS |`).join("\n");
    const report = `# ✅ GOPhER → Snowflake Migration — End-to-End Pipeline Complete

Both governance gates cleared. Ground-truth pipeline record (all figures computed live, in-browser).

## 🗺️ What ran
| Stage | Agent | Outcome |
|---|---|---|
| Schema Migration | schema_migration_agent | 7 Sybase tables → Snowflake DDL; drift on RX_CLAIMS (+${(drift.added || []).join(", ")}) **approved** |
| Ingestion | ingestion_agent | ${DWH.SUBJECT_AREAS.reduce((a, s) => a + wh.get("RAW." + s.object).length, 0)} rows → Bronze (SAP IQ → Snowflake), 0 rejects |
| Transformation | transformation_agent | Silver ${staging.reduce((a, b) => a + b.rows, 0)} rows / ${staging.length} models → **Gold approved** → ${marts.reduce((a, b) => a + b.rows, 0)} rows / ${marts.length} models |
| Data Quality | data_quality_agent | **${dq.passed}/${dq.total} checks PASS** |
| BI Insight | bi_insight_agent | KPIs + breakdowns, **publish approved** |

## 🔎 Data Quality
| Category | Passed | Run | Status |
|---|---|---|---|
${cats}

**STATUS: ${dq.failed === 0 ? "PASS" : "FAIL"} — ${dq.passed} passed, ${dq.failed} failed (${dq.total} total)**

## 📊 Pharmacy KPIs (Gold)
| KPI | Value |
|---|---|
| Total Paid Amount | **$${m.total_paid_amount.toLocaleString()}** |
| Total Rebates | $${m.total_rebates.toLocaleString()} |
| Net Pharmacy Cost | $${m.net_pharmacy_cost.toLocaleString()} |
| Total Claims | ${m.total_claims.toLocaleString()} |
| Distinct Members | ${m.distinct_members.toLocaleString()} |
| Cost per Claim | $${m.cost_per_claim} |
| Generic Dispensing Rate | ${m.generic_dispensing_rate_pct}% |
| Rejected Claim Rate | ${m.rejected_claim_rate_pct}% (${m.rejected_claim_count} rejects) |

**Top therapeutic classes by spend:** ${top}

## 📦 Output
Power BI dataset generated (\`.xlsx\` + \`.pbids\`) — download from the bar above.

> ℹ️ This is the **GitHub Pages simulation build**: the data, transforms, DQ, KPIs and Power BI export are all real (computed in your browser), but the agent reasoning is scripted — it does not call a live model. Use the Render deployment for live Claude agents.`;

    emit({ type: "final", result: report });

    /* ── Power BI output (real, in-browser) ── */
    const pbi = DWH.exportPowerBI();
    emit({ type: "powerbi_output", xlsx: URL.createObjectURL(pbi.xlsxBlob), pbids: URL.createObjectURL(pbi.pbidsBlob), sheets: pbi.sheets, rows: pbi.rows });
  } catch (e) {
    if (String(e.message).startsWith("KILL")) emit({ type: "governance", level: "kill", message: "Pipeline halted by operator (kill switch)." });
    else if (String(e.message).startsWith("REJECTED")) emit({ type: "final", result: "# ⛔ Pipeline halted\n\nA governance gate was rejected — no Gold promotion / publish occurred." });
    else emit({ type: "error", message: e.message });
  }
};
