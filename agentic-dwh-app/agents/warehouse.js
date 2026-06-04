"use strict";
/**
 * warehouse.js — in-memory engine modelling the GOPhER → Snowflake migration.
 *
 * Source:  GOPhER Data Mart on SAP IQ (Sybase) — extracted to data/sources/gopher/*.csv
 * Target:  Snowflake medallion — Bronze (RAW) → Silver (STAGING) → Gold (MARTS)
 *
 * It really reads the files, transforms them, computes real pharmacy KPIs,
 * runs a real DQ battery, and detects source schema drift. Nothing fabricated.
 */
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "data", "sources");
const UPLOAD_DIR = path.join(SRC, "_uploaded");      // user-uploaded overrides

/* ── delimited + JSON parsing (handles comma CSV, pipe .dat, and JSON) ── */
function splitLine(line, delim) {
  const out = []; let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') inQ = false; else cur += ch; }
    else if (ch === '"') inQ = true;
    else if (ch === delim) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur); return out;
}
function parseDelimited(text, delim) {
  const lines = text.trim().split(/\r?\n/);
  const cols = splitLine(lines[0], delim);
  return lines.slice(1).filter((l) => l.length).map((line) => {
    const vals = splitLine(line, delim);
    const row = {};
    cols.forEach((c, i) => { const v = vals[i]; row[c] = v !== undefined && v !== "" && !isNaN(Number(v)) ? Number(v) : v; });
    return row;
  });
}
function detectAndParse(text) {
  const t = text.replace(/^﻿/, "").trim();
  if (t[0] === "[" || t[0] === "{") return JSON.parse(t);             // JSON (cloud)
  const header = t.split(/\r?\n/)[0];
  const delim = header.split("|").length > header.split(",").length ? "|" : ",";  // pipe (mainframe) vs comma (directdb)
  return parseDelimited(t, delim);
}

/* per-object filename matchers (so an uploaded file lands on the right area) */
const MATCHERS = {
  pharmacy_claims: (s) => /claim/.test(s) && !/reject/.test(s),
  rejected_claims: (s) => /reject/.test(s),
  eligibility:     (s) => /eligib|member(?!_?group)/.test(s),
  rebate:          (s) => /rebate/.test(s),
  member_group:    (s) => /group|member_?group/.test(s),
  benefit:         (s) => /benefit|formular|plan/.test(s),
  drug_master:     (s) => /drug|ndc/.test(s),
};

/** Resolve a subject area to rows: uploaded override first, else bundled sample. */
function readObject(object) {
  const area = SUBJECT_AREAS.find((s) => s.object === object);
  if (!area) throw new Error(`unknown subject area: ${object}`);
  // 1. uploaded override (any file in the category folder matching this area)
  const upDir = path.join(UPLOAD_DIR, area.category);
  if (fs.existsSync(upDir)) {
    const stemMatch = (f) => MATCHERS[object] && MATCHERS[object](f.toLowerCase().replace(/\.[^.]+$/, ""));
    const hit = fs.readdirSync(upDir).find(stemMatch);
    if (hit) return detectAndParse(fs.readFileSync(path.join(upDir, hit), "utf8"));
  }
  // 2. bundled sample
  const sample = path.join(SRC, area.category, `${object}.${area.ext}`);
  if (fs.existsSync(sample)) return detectAndParse(fs.readFileSync(sample, "utf8"));
  throw new Error(`source not found for ${object} (no upload or sample present)`);
}

/** Source readiness for the upload UI. */
function sourcesStatus() {
  return SUBJECT_AREAS.map((a) => {
    const upDir = path.join(UPLOAD_DIR, a.category);
    let satisfiedBy = "missing", rows = 0;
    try { rows = readObject(a.object).length; satisfiedBy = "ok"; } catch { satisfiedBy = "missing"; }
    let uploaded = false;
    if (fs.existsSync(upDir)) uploaded = fs.readdirSync(upDir).some((f) => MATCHERS[a.object] && MATCHERS[a.object](f.toLowerCase().replace(/\.[^.]+$/, "")));
    return { object: a.object, label: a.label, category: a.category, rows, source: uploaded ? "uploaded" : satisfiedBy === "ok" ? "sample" : "missing" };
  });
}

/* ── GOPhER subject-area catalogue ── */
const SOURCE_SYSTEM = "GOPhER Data Mart — Mainframe + Cloud-native + Direct DB";
const SOURCE_CLASSES = {
  mainframe: { label: "Mainframe",    desc: "Legacy claims systems", format: "Pipe-delimited (.dat)" },
  cloud:     { label: "Cloud-native", desc: "API / cloud feeds",     format: "JSON" },
  directdb:  { label: "Direct DB",    desc: "Relational extracts",   format: "CSV" },
};
const SUBJECT_AREAS = [
  { object: "pharmacy_claims", label: "Pharmacy Claims",     category: "mainframe", ext: "dat",  sybase_table: "GOPHER.DBO.RX_CLAIMS" },
  { object: "rejected_claims", label: "Rejected Claims",     category: "mainframe", ext: "dat",  sybase_table: "GOPHER.DBO.RX_CLAIMS_REJECTED" },
  { object: "eligibility",     label: "Eligibility",         category: "cloud",     ext: "json", sybase_table: "GOPHER.DBO.ELIGIBILITY" },
  { object: "rebate",          label: "Rebate",              category: "cloud",     ext: "json", sybase_table: "GOPHER.DBO.REBATE" },
  { object: "member_group",    label: "Member / Group",      category: "directdb",  ext: "csv",  sybase_table: "GOPHER.DBO.MEMBER_GROUP" },
  { object: "benefit",         label: "Benefit / Formulary", category: "directdb",  ext: "csv",  sybase_table: "GOPHER.DBO.BENEFIT_PLAN" },
  { object: "drug_master",     label: "Drug Master (NDC)",   category: "directdb",  ext: "csv",  sybase_table: "GOPHER.DBO.DRUG_MASTER" },
];

/* Sybase (SAP IQ) → Snowflake type map for the DDL-conversion agent */
const SYBASE_TO_SNOWFLAKE = {
  "varchar": "VARCHAR", "char": "VARCHAR", "unichar": "VARCHAR", "univarchar": "VARCHAR",
  "int": "NUMBER(38,0)", "integer": "NUMBER(38,0)", "bigint": "NUMBER(38,0)", "smallint": "NUMBER(38,0)", "tinyint": "NUMBER(38,0)",
  "numeric": "NUMBER", "decimal": "NUMBER", "money": "NUMBER(19,4)", "smallmoney": "NUMBER(10,4)",
  "float": "FLOAT", "double": "FLOAT", "real": "FLOAT",
  "datetime": "TIMESTAMP_NTZ", "smalldatetime": "TIMESTAMP_NTZ", "date": "DATE", "time": "TIME",
  "bit": "BOOLEAN", "text": "VARCHAR", "image": "BINARY",
};

/* Baseline schema snapshot (what the migration was designed against). Used by
 * drift detection — note RX_CLAIMS baseline intentionally lacks two columns the
 * live source now has, so the agent surfaces a realistic drift alert. */
const SCHEMA_BASELINE = {
  pharmacy_claims: ["claim_id", "member_id", "ndc", "pharmacy_id", "fill_date", "line_of_business",
    "formulary_tier", "quantity_dispensed", "days_supply", "ingredient_cost", "dispensing_fee",
    "member_copay", "total_paid_amount", "claim_status"], // missing: is_generic, drug_class (added upstream)
};

/* infer a Sybase-ish source type from sampled values */
function inferType(values) {
  const v = values.find((x) => x !== "" && x !== null && x !== undefined);
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "numeric(18,2)";
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return "date";
  const maxLen = Math.max(10, ...values.map((x) => String(x ?? "").length));
  return `varchar(${Math.min(255, Math.ceil(maxLen / 10) * 10)})`;
}

class Warehouse {
  constructor() { this.tables = {}; }
  has(t) { return Array.isArray(this.tables[t]); }
  get(t) { return this.tables[t] || []; }
  set(t, rows) { this.tables[t] = rows; return rows.length; }
  list(prefix) {
    return Object.keys(this.tables).filter((t) => !prefix || t.startsWith(prefix))
      .map((t) => ({ table: t, rows: this.tables[t].length }));
  }

  /* ---- source inspection / DDL / drift ---- */
  sourceSchema(object) {
    const rows = readObject(object);
    const cols = Object.keys(rows[0] || {});
    return cols.map((c) => ({ column: c, type: inferType(rows.map((r) => r[c])) }));
  }

  generateSnowflakeDDL(object) {
    const meta = SUBJECT_AREAS.find((s) => s.object === object);
    const schema = this.sourceSchema(object);
    const lines = schema.map(({ column, type }) => {
      const base = type.replace(/\(.*\)/, "").toLowerCase();
      const sf = SYBASE_TO_SNOWFLAKE[base] || "VARCHAR";
      const sized = /varchar/.test(type) ? type.replace(/varchar/i, "VARCHAR") : sf;
      return `    ${column.toUpperCase().padEnd(22)} ${sized}`;
    });
    return { meta, ddl: `CREATE OR REPLACE TABLE RAW.${object.toUpperCase()} (\n${lines.join(",\n")}\n);`, columns: schema.length };
  }

  detectDrift(object) {
    const live = Object.keys(readObject(object)[0] || {});
    const baseline = SCHEMA_BASELINE[object];
    if (!baseline) return { object, drift: false, detail: "no baseline registered — treated as new table" };
    const added = live.filter((c) => !baseline.includes(c));
    const removed = baseline.filter((c) => !live.includes(c));
    return { object, drift: added.length > 0 || removed.length > 0, added, removed,
      detail: added.length || removed.length ? `+${added.length} added, -${removed.length} removed vs baseline` : "no drift" };
  }

  /* ---- ingest (Bronze / RAW) ---- */
  ingest(object) {
    const rows = readObject(object);
    const target = `RAW.${object}`;
    this.set(target, rows.map((r) => ({ ...r, _ingested_at: new Date().toISOString(), _source: "SAP_IQ.GOPHER", _batch: "adf_load_001" })));
    return { target, rows: rows.length, columns: Object.keys(rows[0] || {}) };
  }
  ingestAll() { return SUBJECT_AREAS.map((s) => this.ingest(s.object)); }

  /* ---- Silver (STAGING) ---- */
  buildStaging() {
    const built = [];
    const ensure = (o) => { if (!this.has(`RAW.${o}`)) this.ingest(o); return this.get(`RAW.${o}`); };
    const out = (name, rows) => built.push({ model: `STAGING.${name}`, rows: this.set(`STAGING.${name}`, rows) });
    const dedupe = (rows, pk) => { const seen = new Set(); return rows.filter((r) => (seen.has(r[pk]) ? false : seen.add(r[pk]))); };

    out("stg_group", dedupe(ensure("member_group"), "group_id").map((g) => ({
      group_id: g.group_id, group_name: g.group_name, line_of_business: g.line_of_business, region: g.region,
    })));
    out("stg_plan", dedupe(ensure("benefit"), "plan_id").map((p) => ({
      plan_id: p.plan_id, plan_name: p.plan_name, formulary_tier: Number(p.formulary_tier),
      tier_copay: Number(p.tier_copay), line_of_business: p.line_of_business,
    })));
    out("stg_drug", dedupe(ensure("drug_master"), "ndc").map((d) => ({
      ndc: d.ndc, drug_name: d.drug_name, drug_class: d.drug_class,
      is_generic: d.is_generic === "Y", manufacturer: d.manufacturer, awp_unit_cost: Number(d.awp_unit_cost),
    })));
    out("stg_member", dedupe(ensure("eligibility"), "member_id").map((m) => ({
      member_id: m.member_id, full_name: m.full_name, group_id: m.group_id, plan_id: m.plan_id,
      line_of_business: m.line_of_business, is_active: m.eligibility_status === "Active",
    })));
    out("stg_claims", ensure("pharmacy_claims").map((c) => ({
      claim_id: c.claim_id, member_id: c.member_id, ndc: c.ndc, pharmacy_id: c.pharmacy_id,
      fill_date: c.fill_date, line_of_business: c.line_of_business, formulary_tier: Number(c.formulary_tier),
      quantity_dispensed: Number(c.quantity_dispensed), days_supply: Number(c.days_supply),
      ingredient_cost: Number(c.ingredient_cost), total_paid_amount: Number(c.total_paid_amount),
      is_generic: c.is_generic === "Y", drug_class: c.drug_class, claim_status: c.claim_status,
    })));
    out("stg_rejected_claims", ensure("rejected_claims").map((r) => ({
      reject_id: r.reject_id, member_id: r.member_id, ndc: r.ndc, fill_date: r.fill_date,
      line_of_business: r.line_of_business, reject_code: String(r.reject_code), reject_reason: r.reject_reason,
    })));
    out("stg_rebate", ensure("rebate").map((r) => ({
      rebate_id: r.rebate_id, ndc: r.ndc, manufacturer: r.manufacturer, quarter: r.quarter,
      rebate_pct: Number(r.rebate_pct),
    })));
    return built;
  }

  /* ---- Gold (MARTS) ---- */
  buildMarts() {
    if (!this.has("STAGING.stg_claims")) this.buildStaging();
    const built = [];
    const out = (name, rows) => built.push({ model: `MARTS.${name}`, rows: this.set(`MARTS.${name}`, rows) });

    const members = this.get("STAGING.stg_member");
    const drugs   = this.get("STAGING.stg_drug");
    const claims  = this.get("STAGING.stg_claims");
    const rejected= this.get("STAGING.stg_rejected_claims");
    const rebates = this.get("STAGING.stg_rebate");

    const memById = Object.fromEntries(members.map((m) => [m.member_id, m]));
    const drugByNdc = Object.fromEntries(drugs.map((d) => [d.ndc, d]));
    // average rebate pct per ndc
    const rebByNdc = {};
    for (const r of rebates) { (rebByNdc[r.ndc] = rebByNdc[r.ndc] || []).push(r.rebate_pct); }
    const avgReb = (ndc) => { const a = rebByNdc[ndc]; return a ? a.reduce((x, y) => x + y, 0) / a.length : 0; };

    out("dim_member", members.map((m) => ({ ...m })));
    out("dim_drug", drugs.map((d) => ({ ...d })));

    // fct_pharmacy_claims — claim grain, enriched with rebate $
    const fct = claims.map((c) => {
      const m = memById[c.member_id];
      const rebatePct = c.is_generic ? 0 : avgReb(c.ndc);
      const rebate = round2(c.ingredient_cost * rebatePct / 100);
      return {
        claim_id: c.claim_id, member_id: c.member_id, group_id: m?.group_id, ndc: c.ndc,
        fill_date: c.fill_date, line_of_business: c.line_of_business, formulary_tier: c.formulary_tier,
        drug_class: c.drug_class, is_generic: c.is_generic, quantity_dispensed: c.quantity_dispensed,
        ingredient_cost: c.ingredient_cost, total_paid_amount: c.total_paid_amount,
        rebate_amount: rebate, net_cost: round2(c.total_paid_amount - rebate),
      };
    });
    out("fct_pharmacy_claims", fct);
    out("fct_rejected_claims", rejected.map((r) => ({ ...r })));

    // agg_drug_class — spend rollup by therapeutic class
    const byClass = {};
    for (const c of fct) {
      const k = c.drug_class || "(unknown)";
      byClass[k] = byClass[k] || { drug_class: k, claims: 0, paid: 0, rebate: 0 };
      byClass[k].claims++; byClass[k].paid += c.total_paid_amount; byClass[k].rebate += c.rebate_amount;
    }
    out("agg_drug_class", Object.values(byClass).map((r) => ({
      drug_class: r.drug_class, claims: r.claims, paid_amount: round2(r.paid),
      rebate_amount: round2(r.rebate), net_cost: round2(r.paid - r.rebate),
    })).sort((a, b) => b.paid_amount - a.paid_amount));

    return built;
  }

  buildAll() { this.ingestAll(); return [...this.buildStaging(), ...this.buildMarts()]; }

  /* ---- pharmacy KPIs (real) ---- */
  metrics() {
    if (!this.has("MARTS.fct_pharmacy_claims")) this.buildAll();
    const fct = this.get("MARTS.fct_pharmacy_claims");
    const rejected = this.get("MARTS.fct_rejected_claims");
    const members = this.get("MARTS.dim_member");

    const totalPaid = round2(sum(fct, "total_paid_amount"));
    const totalRebate = round2(sum(fct, "rebate_amount"));
    const totalClaims = fct.length;
    const genericClaims = fct.filter((c) => c.is_generic).length;
    const distinctMembers = new Set(fct.map((c) => c.member_id)).size;
    const rejCount = rejected.length;

    return {
      total_paid_amount: totalPaid,
      total_rebates: totalRebate,
      net_pharmacy_cost: round2(totalPaid - totalRebate),
      total_claims: totalClaims,
      distinct_members: distinctMembers,
      paid_per_member: distinctMembers ? round2(totalPaid / distinctMembers) : 0,
      cost_per_claim: totalClaims ? round2(totalPaid / totalClaims) : 0,
      generic_dispensing_rate_pct: totalClaims ? round2((genericClaims / totalClaims) * 100) : 0,
      rejected_claim_count: rejCount,
      rejected_claim_rate_pct: round2((rejCount / (totalClaims + rejCount)) * 100),
      eligible_members: members.length,
      active_members: members.filter((m) => m.is_active).length,
    };
  }

  groupBy(table, dim, measure) {
    if (!this.has(table)) this.buildAll();
    const agg = {};
    for (const r of this.get(table)) {
      const k = r[dim] ?? "(null)";
      agg[k] = (agg[k] || 0) + (Number(r[measure]) || 0);
    }
    return Object.entries(agg).map(([k, v]) => ({ [dim]: k, [measure]: round2(v) })).sort((a, b) => b[measure] - a[measure]);
  }

  /* ---- DQ battery (real) ---- */
  runChecks() {
    if (!this.has("MARTS.fct_pharmacy_claims")) this.buildAll();
    const checks = [];
    const add = (category, name, ok, detail) => checks.push({ category, name, status: ok ? "PASS" : "FAIL", detail });
    const g = (t) => this.get(t);

    const notNull = {
      "STAGING.stg_member": ["member_id", "group_id", "plan_id"],
      "STAGING.stg_drug": ["ndc", "drug_class"],
      "STAGING.stg_plan": ["plan_id", "formulary_tier"],
      "STAGING.stg_claims": ["claim_id", "member_id", "ndc", "total_paid_amount"],
      "STAGING.stg_rejected_claims": ["reject_id", "member_id", "reject_code"],
      "STAGING.stg_rebate": ["rebate_id", "ndc", "rebate_pct"],
    };
    for (const [t, cols] of Object.entries(notNull)) {
      const rows = g(t), short = t.split(".").pop();
      for (const c of cols) {
        const n = rows.filter((r) => r[c] === null || r[c] === undefined || r[c] === "").length;
        add("Not-Null", `not_null.${short}.${c}`, n === 0, `${n} nulls / ${rows.length}`);
      }
    }
    const pk = { "STAGING.stg_member": "member_id", "STAGING.stg_drug": "ndc", "STAGING.stg_plan": "plan_id",
      "STAGING.stg_group": "group_id", "STAGING.stg_claims": "claim_id", "STAGING.stg_rejected_claims": "reject_id" };
    for (const [t, k] of Object.entries(pk)) {
      const rows = g(t), short = t.split(".").pop();
      const d = new Set(rows.map((r) => r[k])).size;
      add("Uniqueness", `unique.${short}.${k}`, d === rows.length, `${d}/${rows.length} distinct`);
    }
    const memIds = new Set(g("STAGING.stg_member").map((m) => m.member_id));
    const ndcIds = new Set(g("STAGING.stg_drug").map((d) => d.ndc));
    const planIds = new Set(g("STAGING.stg_plan").map((p) => p.plan_id));
    const grpIds = new Set(g("STAGING.stg_group").map((x) => x.group_id));
    const claims = g("STAGING.stg_claims");
    add("Referential Integrity", "fk.claims.member_id→eligibility", claims.every((c) => memIds.has(c.member_id)), `${claims.filter((c) => !memIds.has(c.member_id)).length} orphans`);
    add("Referential Integrity", "fk.claims.ndc→drug_master", claims.every((c) => ndcIds.has(c.ndc)), `${claims.filter((c) => !ndcIds.has(c.ndc)).length} orphans`);
    add("Referential Integrity", "fk.member.plan_id→benefit", g("STAGING.stg_member").every((m) => planIds.has(m.plan_id)), `${g("STAGING.stg_member").filter((m) => !planIds.has(m.plan_id)).length} orphans`);
    add("Referential Integrity", "fk.member.group_id→member_group", g("STAGING.stg_member").every((m) => grpIds.has(m.group_id)), `${g("STAGING.stg_member").filter((m) => !grpIds.has(m.group_id)).length} orphans`);

    const lobOk = new Set(["E&I", "C&S"]);
    add("Accepted Values", "accepted_values.claims.line_of_business", claims.every((c) => lobOk.has(c.line_of_business)), `validated vs {E&I, C&S}`);
    add("Accepted Values", "accepted_values.claims.formulary_tier", claims.every((c) => c.formulary_tier >= 1 && c.formulary_tier <= 4), `tiers within 1–4`);
    add("Accepted Values", "accepted_values.claims.claim_status", claims.every((c) => c.claim_status === "Paid"), `all 'Paid'`);

    const ranges = [
      ["range.claims.total_paid_amount>=0", claims, (r) => r.total_paid_amount >= 0],
      ["range.claims.quantity_dispensed>0", claims, (r) => r.quantity_dispensed > 0],
      ["range.claims.days_supply>0", claims, (r) => r.days_supply > 0],
      ["range.claims.ingredient_cost>=0", claims, (r) => r.ingredient_cost >= 0],
      ["range.drug.awp_unit_cost>0", g("STAGING.stg_drug"), (r) => r.awp_unit_cost > 0],
      ["range.rebate.rebate_pct(0-100)", g("STAGING.stg_rebate"), (r) => r.rebate_pct >= 0 && r.rebate_pct <= 100],
    ];
    for (const [n, rows, ok] of ranges) add("Numeric Range", n, rows.every(ok), `${rows.filter((r) => !ok(r)).length} out-of-range / ${rows.length}`);

    const today = new Date().toISOString().slice(0, 10);
    add("Date Validity", "freshness.claims.fill_date<=today", claims.every((c) => c.fill_date <= today), `${claims.filter((c) => c.fill_date > today).length} future-dated`);

    add("Reconciliation", "recon.fct_claims=stg_claims", g("MARTS.fct_pharmacy_claims").length === claims.length, `${g("MARTS.fct_pharmacy_claims").length} vs ${claims.length}`);
    add("Reconciliation", "recon.dim_member=stg_member", g("MARTS.dim_member").length === g("STAGING.stg_member").length, `${g("MARTS.dim_member").length} vs ${g("STAGING.stg_member").length}`);
    add("Reconciliation", "recon.dim_drug=stg_drug", g("MARTS.dim_drug").length === g("STAGING.stg_drug").length, `${g("MARTS.dim_drug").length} vs ${g("STAGING.stg_drug").length}`);

    const passed = checks.filter((c) => c.status === "PASS").length;
    const byCategory = {};
    for (const c of checks) { byCategory[c.category] = byCategory[c.category] || { run: 0, pass: 0 }; byCategory[c.category].run++; if (c.status === "PASS") byCategory[c.category].pass++; }
    return { checks, passed, failed: checks.length - passed, total: checks.length, byCategory };
  }
}

function sum(rows, k) { return rows.reduce((a, r) => a + (Number(r[k]) || 0), 0); }
function round2(n) { return Math.round(n * 100) / 100; }

module.exports = { Warehouse, SOURCE_SYSTEM, SOURCE_CLASSES, SUBJECT_AREAS, SYBASE_TO_SNOWFLAKE, readObject, sourcesStatus, UPLOAD_DIR };
