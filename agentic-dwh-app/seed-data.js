"use strict";
/**
 * seed-data.js — generates the GOPhER data-mart subject areas as they would be
 * extracted from SAP IQ (Sybase). These feed the agentic GOPhER → Snowflake
 * migration demo (PharsOnline / UHC Pharmacy context).
 *
 * Run once:  node seed-data.js   →   data/sources/gopher/<object>.csv
 *
 * Deterministic (seeded) so every KPI the agents compute is stable.
 * Subject areas: member_group, eligibility, benefit, drug_master,
 *                pharmacy_claims, rejected_claims, rebate
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "data", "sources");

/* Each GOPhER subject area arrives from one of three source classes, in a
 * format typical of that class:
 *   mainframe  → pipe-delimited extracts (.dat)  — legacy claims systems
 *   cloud      → JSON (.json)                     — cloud-native / API feeds
 *   directdb   → comma CSV (.csv)                 — relational DB extracts     */
const ROUTING = {
  pharmacy_claims:  { category: "mainframe", format: "pipe" },
  rejected_claims:  { category: "mainframe", format: "pipe" },
  eligibility:      { category: "cloud",     format: "json" },
  rebate:           { category: "cloud",     format: "json" },
  member_group:     { category: "directdb",  format: "csv" },
  benefit:          { category: "directdb",  format: "csv" },
  drug_master:      { category: "directdb",  format: "csv" },
};

/* ── seeded PRNG ── */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(42);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const wpick = (a) => a[Math.floor(rnd() * rnd() * a.length)]; // skew to front
const int = (lo, hi) => Math.floor(rnd() * (hi - lo + 1)) + lo;
const money = (lo, hi) => Math.round((rnd() * (hi - lo) + lo) * 100) / 100;
const pad = (n, w) => String(n).padStart(w, "0");
const date = (y0, m0, days) => { const d = new Date(Date.UTC(y0, m0, 1)); d.setUTCDate(d.getUTCDate() + int(0, days)); return d.toISOString().slice(0, 10); };

function toDelimited(rows, delim) {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const esc = (v) => { const s = String(v ?? ""); return new RegExp(`["${delim}\\n]`).test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.join(delim), ...rows.map((r) => cols.map((c) => esc(r[c])).join(delim))].join("\n") + "\n";
}
/** write a subject area into its source-class folder, in that class's format */
function write(object, rows) {
  const route = ROUTING[object];
  const dir = path.join(ROOT, route.category);
  fs.mkdirSync(dir, { recursive: true });
  let body, ext;
  if (route.format === "json") { body = JSON.stringify(rows, null, 2); ext = "json"; }
  else if (route.format === "pipe") { body = toDelimited(rows, "|"); ext = "dat"; }
  else { body = toDelimited(rows, ","); ext = "csv"; }
  fs.writeFileSync(path.join(dir, `${object}.${ext}`), body);
  console.log(`  ✓ ${route.category}/${(object + "." + ext).padEnd(26)} ${rows.length} rows`);
}

/* ── reference pools ── */
const LOB = ["E&I", "E&I", "E&I", "C&S"];                       // Enterprise&Individual vs Community&State
const REGIONS = ["Northeast", "Southeast", "Midwest", "West", "Southwest"];
const DRUG_CLASSES = ["Statins", "Proton Pump Inhibitors", "SSRIs", "Antidiabetics", "Antihypertensives", "Anticoagulants", "Biologics", "Opioid Analgesics", "Inhaled Corticosteroids", "ADHD Stimulants"];
const REJECT = [
  ["75", "Prior Authorization Required"],
  ["70", "Product/Service Not Covered"],
  ["79", "Refill Too Soon"],
  ["88", "DUR Reject Error"],
  ["76", "Plan Limitations Exceeded"],
  ["A1", "Quantity Limit Exceeded"],
];
const MANUFACTURERS = ["Pfizer", "Merck", "Novartis", "AbbVie", "Lilly", "AstraZeneca", "Teva", "Sandoz", "Viatris", "Amgen"];
const FIRST = ["Alice", "Bob", "Carol", "David", "Eve", "Frank", "Grace", "Hank", "Ivy", "Jack", "Kara", "Leo", "Mona", "Nora", "Omar", "Pia", "Quinn", "Ray", "Sue", "Tom"];
const LAST = ["Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Lopez", "Wilson", "Khan", "Patel", "Nguyen", "Kim"];
const name = () => `${pick(FIRST)} ${pick(LAST)}`;

console.log("\nSeeding GOPhER subject areas (SAP IQ extract) → data/sources/gopher/\n");

/* ── 1. member_group (clients/groups) ── */
const N_GROUP = 15;
const groups = [];
for (let i = 1; i <= N_GROUP; i++) {
  groups.push({
    group_id: `GRP${pad(i, 4)}`,
    group_name: `${pick(["Atlas", "Summit", "Horizon", "Beacon", "Liberty", "Cardinal", "Pioneer", "Evergreen"])} ${pick(["Manufacturing", "Health System", "School District", "County", "Logistics", "Retail Group", "University"])}`,
    line_of_business: pick(LOB),
    region: pick(REGIONS),
    contract_effective: date(2020, int(0, 11), 200),
  });
}
write("member_group", groups);

/* ── 2. benefit / formulary (plans) ── */
const N_PLAN = 12;
const plans = [];
for (let i = 1; i <= N_PLAN; i++) {
  const tier = int(1, 4);
  plans.push({
    plan_id: `PLN${pad(i, 4)}`,
    plan_name: `${pick(["Standard", "Premium", "Value", "HDHP", "Select"])} Rx ${pick(["Gold", "Silver", "Bronze"])}`,
    formulary_tier: tier,
    tier_copay: [0, 10, 35, 75, 150][tier],
    deductible: pick([0, 0, 150, 250, 500]),
    line_of_business: pick(LOB),
  });
}
write("benefit", plans);

/* ── 3. drug_master (NDC reference) ── */
const N_DRUG = 60;
const drugs = [];
for (let i = 1; i <= N_DRUG; i++) {
  const cls = pick(DRUG_CLASSES);
  const generic = rnd() > 0.45;
  const awp = money(generic ? 5 : 80, generic ? 120 : 2200);
  drugs.push({
    ndc: `${pad(int(10000, 99999), 5)}-${pad(int(100, 999), 3)}-${pad(int(10, 99), 2)}`,
    drug_name: `${generic ? pick(["Atorva", "Omepra", "Sertra", "Metfor", "Lisino", "Warfar", "Budeso", "Methylph"]) : pick(["Lipitor", "Nexium", "Zoloft", "Jardiance", "Eliquis", "Humira", "Symbicort", "Vyvanse"]) }${generic ? "statin" : ""} ${int(10, 80)}mg`,
    drug_class: cls,
    is_generic: generic ? "Y" : "N",
    manufacturer: pick(MANUFACTURERS),
    awp_unit_cost: awp,
  });
}
write("drug_master", drugs);

/* ── 4. eligibility (members) ── */
const N_MEMBER = 500;
const members = [];
for (let i = 1; i <= N_MEMBER; i++) {
  const g = pick(groups);
  members.push({
    member_id: `MBR${pad(i, 6)}`,
    full_name: name(),
    group_id: g.group_id,
    plan_id: pick(plans).plan_id,
    line_of_business: g.line_of_business,
    effective_date: date(2022, int(0, 11), 300),
    term_date: rnd() > 0.85 ? date(2025, int(0, 6), 120) : "",
    eligibility_status: rnd() > 0.1 ? "Active" : "Termed",
  });
}
write("eligibility", members);

/* ── 5. pharmacy_claims (paid) ── */
const N_CLAIM = 3000;
const claims = [];
for (let i = 1; i <= N_CLAIM; i++) {
  const m = pick(members);
  const d = pick(drugs);
  const plan = plans.find((p) => p.plan_id === m.plan_id) || plans[0];
  const qty = int(30, 90);
  const days = pick([30, 30, 30, 60, 90]);
  const ingredientCost = Math.round(d.awp_unit_cost * (qty / 30) * (0.82 + rnd() * 0.1) * 100) / 100;
  const dispensingFee = money(1, 3.5);
  const copay = plan.tier_copay;
  const totalPaid = Math.max(0, Math.round((ingredientCost + dispensingFee - copay) * 100) / 100);
  claims.push({
    claim_id: `CLM${pad(i, 8)}`,
    member_id: m.member_id,
    ndc: d.ndc,
    pharmacy_id: `PHM${pad(int(1, 120), 4)}`,
    fill_date: date(2025, int(0, 5), 150),
    line_of_business: m.line_of_business,
    formulary_tier: plan.formulary_tier,
    quantity_dispensed: qty,
    days_supply: days,
    ingredient_cost: ingredientCost,
    dispensing_fee: dispensingFee,
    member_copay: copay,
    total_paid_amount: totalPaid,
    is_generic: d.is_generic,
    drug_class: d.drug_class,
    claim_status: "Paid",
  });
}
write("pharmacy_claims", claims);

/* ── 6. rejected_claims ── */
const N_REJECT = 400;
const rejected = [];
for (let i = 1; i <= N_REJECT; i++) {
  const m = pick(members);
  const d = pick(drugs);
  const [code, reason] = pick(REJECT);
  rejected.push({
    reject_id: `REJ${pad(i, 7)}`,
    member_id: m.member_id,
    ndc: d.ndc,
    fill_date: date(2025, int(0, 5), 150),
    line_of_business: m.line_of_business,
    reject_code: code,
    reject_reason: reason,
    claim_status: "Rejected",
  });
}
write("rejected_claims", rejected);

/* ── 7. rebate (manufacturer rebates by NDC) ── */
const rebates = [];
let rid = 1;
for (const d of drugs) {
  if (d.is_generic === "Y") continue;          // rebates on brand drugs
  for (const q of ["2025Q1", "2025Q2"]) {
    rebates.push({
      rebate_id: `RBT${pad(rid++, 6)}`,
      ndc: d.ndc,
      manufacturer: d.manufacturer,
      contract_id: `CNT${pad(int(1, 30), 4)}`,
      quarter: q,
      rebate_pct: Math.round((10 + rnd() * 25) * 10) / 10,   // 10.0–35.0% of ingredient cost
    });
  }
}
write("rebate", rebates);

/* ── manifest ── */
const counts = {
  member_group: groups.length, benefit: plans.length, drug_master: drugs.length,
  eligibility: members.length, pharmacy_claims: claims.length,
  rejected_claims: rejected.length, rebate: rebates.length,
};
const manifest = {
  generated_at: new Date().toISOString(), seed: 42,
  source_system: "GOPhER Data Mart — Mainframe + Cloud-native + Direct DB",
  target: "Snowflake (Bronze → Silver → Gold)",
  business_context: "UHC Pharmacy — PharsOnline analytic sandbox",
  source_classes: {
    mainframe: Object.keys(ROUTING).filter((o) => ROUTING[o].category === "mainframe"),
    cloud:     Object.keys(ROUTING).filter((o) => ROUTING[o].category === "cloud"),
    directdb:  Object.keys(ROUTING).filter((o) => ROUTING[o].category === "directdb"),
  },
  record_counts: counts,
};
fs.writeFileSync(path.join(ROOT, "_manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`  ✓ _manifest.json`);
console.log(`\nDone. ${Object.values(counts).reduce((a, b) => a + b, 0)} rows across ${Object.keys(counts).length} subject areas (mainframe / cloud / directdb).\n`);
