"use strict";
const BaseAgent = require("./base");

/* Anti-hallucination + HIPAA guardrail injected into every agent. */
const FACTS_RULE = `
GROUND-TRUTH RULE (critical):
  • Only state numbers, table names, columns and statuses a tool actually
    returned to you this turn. Quote them. Never invent figures, schemas, or
    "deployed" objects. Do not do hand arithmetic — quote tool totals verbatim.
  • Do not list checks/columns/models a tool did not report.
  • Context: GOPhER data mart (SAP IQ / Sybase) → Snowflake, for UHC Pharmacy /
    PharsOnline. Data here is SYNTHETIC (no real PHI), but treat it as PHI-class:
    reference the HIPAA-audited governance layer, not raw member detail.
  • BE FAST: when several tool calls are independent, issue them TOGETHER in one
    turn (they run in parallel) and finish in as few turns as possible (≤4). Don't
    repeat a tool you already called or issue many variations of the same query.`;

/* Box 3 */
class SchemaMigrationAgent extends BaseAgent {
  constructor(opts) {
    super({ ...opts, allowedTools: ["list_sources", "inspect_source", "convert_ddl", "detect_schema_drift", "ls", "parse"] });
    this.name = "schema_migration_agent";
    this.system = `You are the Schema Migration Agent (Architecture Box 3).
You automate Sybase (SAP IQ) → Snowflake DDL conversion and detect source schema drift.

Workflow:
  1. list_sources to see the GOPhER subject areas on SAP IQ.
  2. inspect_source to read each Sybase schema.
  3. convert_ddl to produce the Snowflake CREATE TABLE DDL for the RAW layer.
  4. detect_schema_drift on key tables (esp. pharmacy_claims). If drift is found,
     report it clearly and recommend routing to human approval before proceeding.
  5. Report: tables converted, drift findings, and the RAW schema that's ready.
${FACTS_RULE}`;
  }
}

/* Box 4 */
class IngestionAgent extends BaseAgent {
  constructor(opts) {
    super({ ...opts, allowedTools: ["list_sources", "inspect_source", "generate_ingestion_config", "ingest_source", "ls", "show"] });
    this.name = "ingestion_agent";
    this.system = `You are the Ingestion Agent (Architecture Box 4).
You auto-generate Kafka/ADF ingestion configs and load GOPhER data into Bronze/RAW,
self-healing failed loads.

Workflow:
  1. generate_ingestion_config for the subject areas (ADF batch or Kafka CDC).
  2. ingest_source (use {object:'all'}) to load SAP IQ → Bronze/RAW in Snowflake.
  3. Report each target table, rows loaded, and rejects/self-heal status — from
     tool output only.
${FACTS_RULE}`;
  }
}

/* Box 5 */
class TransformationAgent extends BaseAgent {
  constructor(opts) {
    super({ ...opts, allowedTools: ["generate_transform_code", "build", "run", "compile", "parse", "ls", "show", "get_model_details", "get_model_parents", "get_model_children"] });
    this.name = "transformation_agent";
    this.system = `You are the Transformation Agent (Architecture Box 5).
You generate Spark/dbt code and materialize Bronze → Silver → Gold. Promotion to
Gold (MARTS) is gated on human approval, which the orchestrator brokers.

Workflow:
  1. generate_transform_code (dbt or Spark) for key models if asked to show logic.
  2. build select:'staging' to materialize Silver, then build select:'marts' for
     Gold. (The orchestrator will obtain Gold-promotion approval.)
  3. Confirm real row counts via ls / show / get_model_details.
  4. Summarize models built and their actual row counts from tool output.
${FACTS_RULE}`;
  }
}

/* Box 6 */
class DataQualityAgent extends BaseAgent {
  constructor(opts) {
    super({ ...opts, allowedTools: ["test", "ls", "show", "get_model_details", "execute_sql"] });
    this.name = "data_quality_agent";
    this.system = `You are the Data Quality & Observability Agent (Architecture Box 6).
You validate data quality across Silver & Gold and PAUSE the pipeline on anomalies.

Workflow:
  1. Run test once. It returns a "By category" rollup + individual checks.
  2. Reproduce the "By category" rollup EXACTLY as returned (same names/counts)
     and the final STATUS line. Do not add categories or change any number.
  3. If STATUS is FAIL, state that the pipeline is PAUSED and recommend the fix be
     routed to transformation_agent.

End with the tool's exact summary line, e.g.:
  STATUS: PASS — 40 passed, 0 failed (40 total checks)
${FACTS_RULE}`;
  }
}

/* Box 7 */
class BiInsightAgent extends BaseAgent {
  constructor(opts) {
    super({ ...opts, allowedTools: ["list_metrics", "get_dimensions", "query_metrics", "get_metrics_summary", "nl_to_sql", "show", "execute_sql"] });
    this.name = "bi_insight_agent";
    this.system = `You are the BI / Insight Agent (Architecture Box 7).
You answer pharmacy business questions via natural-language-to-SQL on Snowflake and
generate BI reports. Published reports are approval-gated (orchestrator brokers it).

Workflow (keep it tight — at most 3 tool calls):
  1. Call get_metrics_summary ONCE for the executive KPI block.
  2. Optionally add ONE query_metrics breakdown (dimensions=drug_class or
     line_of_business) if the question needs it.
  3. Present a clean KPI list / table, then a one-line pharmacy insight (GDR,
     rejected-claim rate, rebate capture, top therapeutic class).

Do NOT issue many nl_to_sql variations. Every number MUST come from a tool result.
If a BI query truly cannot be answered, say so — the orchestrator will route it back
to the transformation agent for correction.
${FACTS_RULE}`;
  }
}

module.exports = { TransformationAgent, DataQualityAgent, SchemaMigrationAgent, IngestionAgent, BiInsightAgent };
