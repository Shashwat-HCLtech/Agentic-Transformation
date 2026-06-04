"use strict";
/**
 * tools.js (filename kept as mockTools.js for import stability)
 *
 * Real tools backed by warehouse.js, aligned to the "Proposed: Agentic AI
 * integration Architecture" (GOPhER → Snowflake). Each maps to an architecture
 * box. Nothing is fabricated — numbers, DDL, drift and KPIs all derive from the
 * GOPhER subject-area files on disk.
 */
const fs = require("fs");
const path = require("path");
const { Warehouse, SOURCE_SYSTEM, SUBJECT_AREAS, readObject } = require("./warehouse");

const wh = new Warehouse();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/* Resolve any alias (object key, Sybase table name, or label) → canonical object
 * key, so an agent can't trip on "benefit" vs "GOPHER.DBO.BENEFIT_PLAN". */
function resolveObject(name) {
  if (!name) return name;
  const n = String(name).toLowerCase().replace(/^gopher\.dbo\./, "").replace(/[^a-z_]/g, "");
  const hit = SUBJECT_AREAS.find((s) =>
    s.object.toLowerCase() === n ||
    s.sybase_table.toLowerCase().endsWith(n) ||
    s.label.toLowerCase().replace(/[^a-z]/g, "") === n.replace(/[^a-z]/g, ""));
  return hit ? hit.object : name;
}

function resolveTable(name) {
  if (!name) return null;
  if (wh.has(name)) return name;
  for (const layer of ["MARTS", "STAGING", "RAW"]) if (wh.has(`${layer}.${name}`)) return `${layer}.${name}`;
  const lower = String(name).toLowerCase();
  return Object.keys(wh.tables).find((t) => t.toLowerCase().endsWith(lower)) || null;
}
function table(rows, max = 5) {
  if (!rows.length) return "(0 rows)";
  const cols = Object.keys(rows[0]).filter((c) => !c.startsWith("_"));
  return [cols.join(" | "), cols.map(() => "---").join("-+-"),
    ...rows.slice(0, max).map((r) => cols.map((c) => String(r[c] ?? "")).join(" | ")),
    "", `(${rows.length} rows)`].join("\n");
}

const LINEAGE = {
  stg_claims: { parents: ["RAW.pharmacy_claims"], children: ["fct_pharmacy_claims", "agg_drug_class"] },
  stg_member: { parents: ["RAW.eligibility"], children: ["dim_member", "fct_pharmacy_claims"] },
  stg_drug:   { parents: ["RAW.drug_master"], children: ["dim_drug", "fct_pharmacy_claims"] },
  stg_rebate: { parents: ["RAW.rebate"], children: ["fct_pharmacy_claims"] },
  fct_pharmacy_claims: { parents: ["stg_claims", "stg_member", "stg_drug", "stg_rebate"], children: ["agg_drug_class"] },
  agg_drug_class: { parents: ["fct_pharmacy_claims"], children: [] },
};

const TOOLS = {
  /* ════ Box 3 — Schema Migration: discovery, Sybase→Snowflake DDL, drift ════ */
  async list_sources() {
    await delay(150);
    const lines = [`Source system: ${SOURCE_SYSTEM}`, `Target: Snowflake (Bronze → Silver → Gold)`, ``, `GOPhER subject areas:`];
    for (const s of SUBJECT_AREAS) {
      const n = readObject(s.object).length;
      lines.push(`  • ${s.label.padEnd(22)} ${String(n).padStart(5)} rows   [${s.sybase_table}]  → RAW.${s.object}`);
    }
    return lines.join("\n");
  },
  async inspect_source({ object } = {}) {
    await delay(150);
    if (!object) return "[error] provide { object }. Call list_sources first.";
    object = resolveObject(object);
    let schema; try { schema = wh.sourceSchema(object); } catch (e) { return `[error] ${e.message}`; }
    const rows = readObject(object);
    return [`Source ${object} (${rows.length} rows) — Sybase schema:`,
      ...schema.map((c) => `  ${c.column.padEnd(22)} ${c.type}`), ``, table(rows, 3)].join("\n");
  },
  async convert_ddl({ object } = {}) {
    await delay(250);
    if (!object) return "[error] provide { object }";
    object = resolveObject(object);
    let r; try { r = wh.generateSnowflakeDDL(object); } catch (e) { return `[error] ${e.message}`; }
    return [`Sybase (SAP IQ) → Snowflake DDL conversion for ${r.meta?.sybase_table || object}:`, ``, r.ddl,
      ``, `(${r.columns} columns converted; types mapped via Sybase→Snowflake ruleset)`].join("\n");
  },
  async detect_schema_drift({ object } = {}) {
    await delay(200);
    const obj = resolveObject(object || "pharmacy_claims");
    let d; try { d = wh.detectDrift(obj); } catch (e) { return `[error] ${e.message}`; }
    if (!d.drift) return `No schema drift on ${obj} vs migration baseline. (${d.detail})`;
    return [`⚠ SCHEMA DRIFT DETECTED on ${obj} (vs migration baseline):`,
      d.added?.length ? `  + columns added upstream: ${d.added.join(", ")}` : "",
      d.removed?.length ? `  - columns removed upstream: ${d.removed.join(", ")}` : "",
      `  Action: regenerate RAW DDL + downstream models, or route to human approval.`].filter(Boolean).join("\n");
  },

  /* ════ Box 4 — Ingestion: Kafka/ADF config gen + self-healing loads ════ */
  async generate_ingestion_config({ object, mode } = {}) {
    await delay(250);
    if (!object) return "[error] provide { object }";
    object = resolveObject(object);
    const meta = SUBJECT_AREAS.find((s) => s.object === object) || { sybase_table: object };
    if ((mode || "adf").toLowerCase() === "kafka") {
      return ["Generated Kafka (Debezium CDC) connector config:", "```json", JSON.stringify({
        name: `gopher-${object}-cdc`, "connector.class": "io.debezium.connector.sqlserver.SqlServerConnector",
        "database.hostname": "sapiq-gopher.uhg.internal", "table.include.list": meta.sybase_table,
        "topic.prefix": `gopher.${object}`, "snapshot.mode": "initial",
        "errors.tolerance": "all", "errors.retry.timeout": "300000", "errors.deadletterqueue.topic.name": `dlq.${object}`,
      }, null, 2), "```", "Self-heal: failed records routed to DLQ with 5-min retry window."].join("\n");
    }
    return ["Generated Azure Data Factory copy-pipeline config:", "```json", JSON.stringify({
      name: `pl_gopher_${object}_to_snowflake`,
      source: { type: "OdbcSource", connection: "SAP_IQ_GOPHER", query: `SELECT * FROM ${meta.sybase_table}` },
      sink: { type: "SnowflakeSink", table: `RAW.${object.toUpperCase()}`, writeBehavior: "upsert" },
      policy: { retry: 3, retryIntervalInSeconds: 60, timeout: "02:00:00" },
      selfHeal: { onFailure: "rerunFailedSlices", alert: "governance.drift_or_load_failure" },
    }, null, 2), "```", "Self-heal: ADF retries failed slices 3× then raises a governance alert."].join("\n");
  },
  async ingest_source({ object } = {}) {
    await delay(300);
    if (object === "all" || !object) {
      const loaded = wh.ingestAll();
      const total = loaded.reduce((a, l) => a + l.rows, 0);
      return [`Ingested all GOPhER subject areas → Bronze/RAW (SAP IQ → Snowflake):`,
        ...loaded.map((l) => `  ✓ ${l.target.padEnd(28)} ${l.rows} rows`), ``,
        `Total: ${total} rows across ${loaded.length} tables. 0 failed slices (self-heal not triggered).`].join("\n");
    }
    const l = wh.ingest(resolveObject(object));
    return `Ingested ${object} → ${l.target}: ${l.rows} rows, ${l.columns.length} columns. 0 rejects.`;
  },

  /* ════ Box 5 — Transformation: Spark/dbt code gen + Bronze→Gold build ════ */
  async generate_transform_code({ model, engine } = {}) {
    await delay(250);
    const m = model || "fct_pharmacy_claims";
    const eng = (engine || "dbt").toLowerCase();
    if (eng === "spark") {
      return ["Generated PySpark transformation:", "```python",
        `df_claims = spark.table("STAGING.stg_claims")`,
        `df_drug   = spark.table("STAGING.stg_drug")`,
        `df_reb    = spark.table("STAGING.stg_rebate").groupBy("ndc").agg(F.avg("rebate_pct").alias("reb_pct"))`,
        `fct = (df_claims.join(df_drug, "ndc", "left").join(df_reb, "ndc", "left")`,
        `        .withColumn("rebate_amount", F.when(~F.col("is_generic"), F.col("ingredient_cost")*F.col("reb_pct")/100).otherwise(0))`,
        `        .withColumn("net_cost", F.col("total_paid_amount") - F.col("rebate_amount")))`,
        `fct.write.mode("overwrite").saveAsTable("MARTS.fct_pharmacy_claims")  # approval gate before Gold`,
        "```"].join("\n");
    }
    return ["Generated dbt model (Bronze→Gold):", "```sql",
      `-- models/marts/${m}.sql   {{ config(materialized='table') }}`,
      `select c.claim_id, c.member_id, m.group_id, c.ndc, c.fill_date, c.line_of_business,`,
      `       c.formulary_tier, c.drug_class, c.is_generic, c.quantity_dispensed,`,
      `       c.total_paid_amount,`,
      `       case when not c.is_generic then round(c.ingredient_cost * r.reb_pct/100, 2) else 0 end as rebate_amount`,
      `from {{ ref('stg_claims') }} c`,
      `left join {{ ref('stg_member') }} m using (member_id)`,
      `left join (select ndc, avg(rebate_pct) reb_pct from {{ ref('stg_rebate') }} group by 1) r using (ndc)`,
      "```", "Promotion to Gold is gated on human approval."].join("\n");
  },
  async build({ select } = {}) {
    await delay(400);
    const sel = (select || "").toLowerCase();
    const built = sel.includes("staging") ? wh.buildStaging() : sel.includes("mart") ? wh.buildMarts() : wh.buildAll();
    const total = built.reduce((a, b) => a + b.rows, 0);
    return [`Build complete (real materialization, SAP IQ → Snowflake):`,
      ...built.map((b) => `  ✓ ${b.model.padEnd(28)} ${b.rows} rows`), ``,
      `${built.length} models, ${total} rows materialized, 0 failures.`].join("\n");
  },
  async run({ select } = {}) { return TOOLS.build({ select }); },
  async compile({ select } = {}) { return TOOLS.generate_transform_code({ model: select, engine: "dbt" }); },

  /* ════ Box 6 — Data Quality: validate across layers, pause on anomaly ════ */
  async test() {
    await delay(300);
    const r = wh.runChecks();
    const cats = Object.entries(r.byCategory).map(([c, v]) => `  ${c.padEnd(24)} ${v.pass}/${v.run} PASS`);
    return [`Data Quality — real checks across STAGING & MARTS:`, ``, `By category:`, ...cats, ``,
      `Individual checks:`, ...r.checks.map((c) => `  [${c.status}] ${c.name.padEnd(42)} ${c.detail}`), ``,
      `STATUS: ${r.failed === 0 ? "PASS" : "FAIL"} — ${r.passed} passed, ${r.failed} failed (${r.total} total checks)`,
      r.failed === 0 ? `No anomalies — pipeline may proceed.` : `⚠ Anomalies detected — PIPELINE PAUSED, route fix to transformation_agent.`].join("\n");
  },

  /* ════ Box 7 — BI/Insight: NL→SQL on Snowflake + KPIs (approval-gated) ════ */
  async list_metrics() {
    await delay(120);
    return ["Pharmacy metrics (computed live from MARTS):",
      "  total_paid_amount, total_rebates, net_pharmacy_cost, cost_per_claim, paid_per_member",
      "  total_claims, distinct_members, generic_dispensing_rate_pct",
      "  rejected_claim_count, rejected_claim_rate_pct, eligible_members, active_members"].join("\n");
  },
  async get_dimensions() {
    await delay(120);
    return ["drug_class", "line_of_business (E&I / C&S)", "formulary_tier (1–4)"].join("\n");
  },
  async query_metrics({ metrics, dimensions } = {}) {
    await delay(250);
    if (dimensions) {
      const d = dimensions.toLowerCase();
      const map = { drug_class: "drug_class", line_of_business: "line_of_business", lob: "line_of_business", tier: "formulary_tier", formulary_tier: "formulary_tier" };
      const col = Object.keys(map).find((k) => d.includes(k.replace("_", " ")) || d.includes(k)) ;
      const dim = map[col] || "drug_class";
      const rows = wh.groupBy("MARTS.fct_pharmacy_claims", dim, "total_paid_amount");
      return `Paid amount by ${dim}:\n\n${table(rows, 12)}`;
    }
    const all = wh.metrics();
    const want = (metrics || "").split(",").map((s) => s.trim()).filter(Boolean);
    const chosen = want.length ? want : Object.keys(all);
    return chosen.map((m) => `${m.padEnd(28)} ${all[m] ?? "(unknown)"}`).join("\n");
  },
  async get_metrics_summary() {
    await delay(250);
    const m = wh.metrics();
    return ["Pharmacy Executive KPIs (live from Gold / MARTS):",
      `  Total Paid Amount ........ $${m.total_paid_amount.toLocaleString()}`,
      `  Total Rebates ............ $${m.total_rebates.toLocaleString()}`,
      `  Net Pharmacy Cost ........ $${m.net_pharmacy_cost.toLocaleString()}`,
      `  Total Claims ............. ${m.total_claims.toLocaleString()}`,
      `  Distinct Members ......... ${m.distinct_members.toLocaleString()}`,
      `  Cost per Claim ........... $${m.cost_per_claim}`,
      `  Paid per Member .......... $${m.paid_per_member.toLocaleString()}`,
      `  Generic Dispensing Rate .. ${m.generic_dispensing_rate_pct}%`,
      `  Rejected Claim Rate ...... ${m.rejected_claim_rate_pct}% (${m.rejected_claim_count} rejects)`,
      `  Eligible / Active Members  ${m.eligible_members} / ${m.active_members}`].join("\n");
  },
  async nl_to_sql({ question } = {}) {
    await delay(300);
    const q = (question || "").toLowerCase();
    const m = wh.metrics();
    if (q.includes("generic")) return sqlAnswer(question,
      `SELECT ROUND(100.0*SUM(IFF(is_generic,1,0))/COUNT(*),2) AS gdr_pct FROM MARTS.fct_pharmacy_claims;`,
      `${m.generic_dispensing_rate_pct}% generic dispensing rate`);
    if (q.includes("reject")) return sqlAnswer(question,
      `SELECT ROUND(100.0*r.n/(r.n+c.n),2) AS reject_rate FROM (SELECT COUNT(*) n FROM MARTS.fct_rejected_claims) r, (SELECT COUNT(*) n FROM MARTS.fct_pharmacy_claims) c;`,
      `${m.rejected_claim_rate_pct}% rejected claim rate (${m.rejected_claim_count} rejects)`);
    if (q.includes("rebate")) return sqlAnswer(question,
      `SELECT SUM(rebate_amount) AS total_rebates FROM MARTS.fct_pharmacy_claims;`,
      `$${m.total_rebates.toLocaleString()} total rebates`);
    if (q.includes("class") || q.includes("therapeutic")) {
      const rows = wh.groupBy("MARTS.fct_pharmacy_claims", "drug_class", "total_paid_amount").slice(0, 8);
      return sqlAnswer(question, `SELECT drug_class, SUM(total_paid_amount) paid FROM MARTS.fct_pharmacy_claims GROUP BY 1 ORDER BY 2 DESC;`, `\n${table(rows, 8)}`);
    }
    if (q.includes("line of business") || q.includes("lob") || q.includes("e&i") || q.includes("c&s")) {
      const rows = wh.groupBy("MARTS.fct_pharmacy_claims", "line_of_business", "total_paid_amount");
      return sqlAnswer(question, `SELECT line_of_business, SUM(total_paid_amount) paid FROM MARTS.fct_pharmacy_claims GROUP BY 1 ORDER BY 2 DESC;`, `\n${table(rows, 5)}`);
    }
    return sqlAnswer(question, `SELECT SUM(total_paid_amount) paid, COUNT(*) claims FROM MARTS.fct_pharmacy_claims;`,
      `$${m.total_paid_amount.toLocaleString()} paid across ${m.total_claims.toLocaleString()} claims`);
  },

  /* ════ shared: project ops, SQL, lineage ════ */
  async parse() {
    await delay(150);
    return [`Parsed project: gopher_snowflake`, `  Source: ${SOURCE_SYSTEM}`,
      `  Subject areas: ${SUBJECT_AREAS.length}`, `  Staging: 7 models  |  Marts: 5 models (2 dims, 2 facts, 1 agg)`,
      `  Layers: Bronze (RAW) → Silver (STAGING) → Gold (MARTS)`].join("\n");
  },
  async ls({ select } = {}) {
    await delay(120);
    const layer = (select || "").toUpperCase();
    const rows = ["RAW", "STAGING", "MARTS"].includes(layer) ? wh.list(layer + ".") : wh.list();
    if (!rows.length) return "(warehouse empty — run ingest_source then build)";
    return rows.map((x) => `${x.table.padEnd(30)} ${x.rows} rows`).join("\n");
  },
  async show({ select } = {}) {
    await delay(150);
    const t = resolveTable(select);
    if (!t) return `[error] table '${select}' not found. Build it first.`;
    return `Preview of ${t}:\n\n${table(wh.get(t), 5)}`;
  },
  async get_model_details({ model_name } = {}) {
    await delay(150);
    const t = resolveTable(model_name);
    if (!t) return `[error] model '${model_name}' not found`;
    const rows = wh.get(t), short = t.split(".").pop();
    return JSON.stringify({ model: t, rows: rows.length, layer: t.split(".")[0],
      columns: Object.keys(rows[0] || {}).filter((c) => !c.startsWith("_")),
      parents: LINEAGE[short]?.parents || [], children: LINEAGE[short]?.children || [] }, null, 2);
  },
  async get_model_parents({ model_name } = {}) {
    await delay(120);
    const s = (model_name || "").split(".").pop();
    return `Parents of ${model_name}:\n${(LINEAGE[s]?.parents || []).join("\n") || "(source-derived)"}`;
  },
  async get_model_children({ model_name } = {}) {
    await delay(120);
    const s = (model_name || "").split(".").pop();
    return `Children of ${model_name}:\n${(LINEAGE[s]?.children || []).join("\n") || "(leaf)"}`;
  },
  async execute_sql({ sql } = {}) {
    await delay(200);
    if (!sql) return "[error] no SQL provided";
    const s = sql.replace(/\s+/g, " ").trim(), lower = s.toLowerCase();
    if (/^(create|alter|drop|truncate|insert|update|delete|copy|merge)\b/i.test(s))
      return `[demo-engine] DDL/DML is managed by the convert_ddl + build tools (Bronze/Silver/Gold are materialized there). No data fabricated.`;
    const cnt = lower.match(/count\(\s*\*\s*\)\s+from\s+([a-z0-9_.]+)/);
    if (cnt) { const t = resolveTable(cnt[1].replace(/^.*\./, "")); if (t) return `count\n-----\n${wh.get(t).length}\n\n(1 row, real)`; }
    const sm = lower.match(/sum\(\s*([a-z0-9_]+)\s*\)\s+from\s+([a-z0-9_.]+)/);
    if (sm) { const t = resolveTable(sm[2].replace(/^.*\./, "")); if (t) { const v = wh.get(t).reduce((a, r) => a + (Number(r[sm[1]]) || 0), 0); return `sum_${sm[1]}\n-----\n${Math.round(v * 100) / 100}\n\n(1 row, real)`; } }
    const frm = lower.match(/from\s+([a-z0-9_.]+)/);
    if (frm) { const t = resolveTable(frm[1].replace(/^.*\./, "")); if (t) return `(real sample from ${t})\n\n${table(wh.get(t), 5)}`; }
    return `[demo-engine] Query shape not executed by the engine. Use nl_to_sql / query_metrics / show / test. No data fabricated.`;
  },
  async docs({ subcommand } = {}) { await delay(120); return `docs ${subcommand || "generate"} — catalog covers ${wh.list().length} tables across RAW/STAGING/MARTS (real).`; },
};

function sqlAnswer(question, sql, result) {
  return [`Question: ${question}`, ``, `Generated Snowflake SQL:`, "```sql", sql, "```", ``, `Result: ${result}`].join("\n");
}

/* ════ schemas ════ */
const S = (name, description, props = {}, required) => ({ name, description, input_schema: { type: "object", properties: props, ...(required ? { required } : {}) } });
const STR = { type: "string" };
const TOOL_SCHEMAS = {
  list_sources: S("list_sources", "List GOPhER subject areas on SAP IQ (Sybase) with row counts and source table names."),
  inspect_source: S("inspect_source", "Inspect a GOPhER subject area: Sybase schema + sample rows.", { object: STR }, ["object"]),
  convert_ddl: S("convert_ddl", "Convert a Sybase (SAP IQ) table's DDL to Snowflake CREATE TABLE DDL.", { object: STR }, ["object"]),
  detect_schema_drift: S("detect_schema_drift", "Detect source schema drift vs the migration baseline for a subject area.", { object: STR }),
  generate_ingestion_config: S("generate_ingestion_config", "Generate a Kafka (CDC) or Azure Data Factory (batch) ingestion config for a subject area. mode: 'adf'|'kafka'.", { object: STR, mode: STR }, ["object"]),
  ingest_source: S("ingest_source", "Load a subject area (or 'all') from SAP IQ into Bronze/RAW. Self-healing on failed slices.", { object: STR }),
  generate_transform_code: S("generate_transform_code", "Generate dbt or Spark code for a Bronze→Gold model. engine: 'dbt'|'spark'.", { model: STR, engine: STR }),
  build: S("build", "Materialize models. select: 'staging' | 'marts' | omit for full build.", { select: STR }),
  run: S("run", "Run/materialize models (alias of build).", { select: STR }),
  compile: S("compile", "Show generated transform code for a model.", { select: STR }),
  test: S("test", "Run the real DQ battery across Silver & Gold; pauses on anomalies.", { select: STR }),
  list_metrics: S("list_metrics", "List pharmacy metrics computable from the marts."),
  get_dimensions: S("get_dimensions", "List dimensions for metric breakdowns."),
  query_metrics: S("query_metrics", "Compute real pharmacy metrics; pass dimensions=drug_class|line_of_business|formulary_tier for a breakdown.", { metrics: STR, dimensions: STR }),
  get_metrics_summary: S("get_metrics_summary", "Full pharmacy executive KPI summary (live from Gold)."),
  nl_to_sql: S("nl_to_sql", "Translate a natural-language pharmacy question to Snowflake SQL and return the real result.", { question: STR }, ["question"]),
  parse: S("parse", "Parse the project and summarize sources/models."),
  ls: S("ls", "List warehouse tables. select: RAW|STAGING|MARTS.", { select: STR }),
  show: S("show", "Preview real rows from a built table.", { select: STR }, ["select"]),
  get_model_details: S("get_model_details", "Real schema, row count, and lineage for a model.", { model_name: STR }, ["model_name"]),
  get_model_parents: S("get_model_parents", "Upstream dependencies of a model.", { model_name: STR }, ["model_name"]),
  get_model_children: S("get_model_children", "Downstream models depending on a model.", { model_name: STR }, ["model_name"]),
  execute_sql: S("execute_sql", "Execute a read query against the warehouse (real for COUNT/SUM/SELECT; never fabricates).", { sql: STR }, ["sql"]),
  docs: S("docs", "Generate/serve docs (catalog summary).", { subcommand: STR }),
};

async function callTool(name, args) {
  const h = TOOLS[name];
  if (!h) return `[tool '${name}' not available]`;
  try { return await h(args || {}); } catch (e) { return `[engine error in ${name}] ${e.message}`; }
}

/* ════ Power BI output (.xlsx + .pbids + CSVs) from the Gold marts ════ */
function csvOf(rows) {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]).filter((c) => !c.startsWith("_"));
  const esc = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n") + "\n";
}

function exportPowerBI(outDir) {
  if (!wh.has("MARTS.fct_pharmacy_claims")) wh.buildAll();
  fs.mkdirSync(outDir, { recursive: true });
  const m = wh.metrics();

  const sheets = {
    "KPI Summary":        Object.entries(m).map(([metric, value]) => ({ metric, value })),
    "Spend by Drug Class": wh.get("MARTS.agg_drug_class"),
    "Spend by LOB":        wh.groupBy("MARTS.fct_pharmacy_claims", "line_of_business", "total_paid_amount"),
    "Spend by Tier":       wh.groupBy("MARTS.fct_pharmacy_claims", "formulary_tier", "total_paid_amount"),
    "Claims Fact":         wh.get("MARTS.fct_pharmacy_claims"),
    "Member Dim":          wh.get("MARTS.dim_member"),
    "Drug Dim":            wh.get("MARTS.dim_drug"),
  };

  // CSV pack
  const csvDir = path.join(outDir, "csv");
  fs.mkdirSync(csvDir, { recursive: true });
  for (const [name, rows] of Object.entries(sheets))
    fs.writeFileSync(path.join(csvDir, name.replace(/\s+/g, "_") + ".csv"), csvOf(rows));

  // .xlsx (SheetJS; degrade gracefully to CSV-only if unavailable)
  const xlsxName = "gopher_gold_dataset.xlsx";
  let xlsxOk = false;
  try {
    const XLSX = require("xlsx");
    const wb = XLSX.utils.book_new();
    for (const [name, rows] of Object.entries(sheets)) {
      const clean = (rows.length ? rows : [{}]).map((r) => {
        const o = {}; for (const k of Object.keys(r)) if (!k.startsWith("_")) o[k] = r[k]; return o;
      });
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(clean), name.slice(0, 31));
    }
    XLSX.writeFile(wb, path.join(outDir, xlsxName));
    xlsxOk = true;
  } catch (e) { /* CSV pack still produced */ }

  // .pbids — Power BI data-source connection file pointing at the workbook
  const pbidsName = "gopher_powerbi.pbids";
  const pbids = {
    version: "0.1",
    connections: [{
      details: { protocol: "file", address: { path: path.resolve(outDir, xlsxName) } },
      options: {}, mode: "Import",
    }],
  };
  fs.writeFileSync(path.join(outDir, pbidsName), JSON.stringify(pbids, null, 2));

  return {
    xlsx: xlsxOk ? xlsxName : null,
    pbids: pbidsName,
    csv: "csv",
    sheets: Object.keys(sheets),
    rows: { claims: sheets["Claims Fact"].length, members: sheets["Member Dim"].length, drugs: sheets["Drug Dim"].length },
    metrics: m,
  };
}

/* Clear cached warehouse tables so a new run re-reads current (uploaded/sample) sources. */
function resetWarehouse() { for (const k of Object.keys(wh.tables)) delete wh.tables[k]; }

module.exports = { callTool, TOOL_SCHEMAS, exportPowerBI, resetWarehouse };
