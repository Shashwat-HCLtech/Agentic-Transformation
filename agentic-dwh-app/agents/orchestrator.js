"use strict";
const BaseAgent = require("./base");
const {
  TransformationAgent, DataQualityAgent,
  SchemaMigrationAgent, IngestionAgent, BiInsightAgent,
} = require("./specialists");

const ORCHESTRATOR_SYSTEM = `You are the Claude Pipeline Orchestration Layer (Architecture Box 2) — the
central brain for the GOPhER → Snowflake migration (UHC Pharmacy / PharsOnline).

You decompose the goal, route to specialist agents via delegate_* tools, and you
BROKER HUMAN APPROVALS at governance gates. Pipeline order:

  schema_migration → ingestion → transformation → data_quality → bi_insight

Mandatory governance gates (call request_human_approval and wait for the verdict):
  • GATE 1 — before Gold promotion: after transformation builds Silver, request
    approval to promote to Gold (MARTS). Only proceed if APPROVED.
  • GATE 2 — before publishing BI: after BI insights are generated, request
    approval to publish the report. Only finalize if APPROVED.

Rules:
  - One delegation at a time. Read each agent's report before the next step.
  - If data_quality_agent reports FAIL, the pipeline is PAUSED — route the fix to
    transformation_agent, then re-run DQ once.
  - If bi_insight_agent reports a query failure, route it back to
    transformation_agent for auto-correction (Architecture Box 8 feedback loop).
  - If schema_migration_agent reports schema drift, surface it and request approval.
  - If an approval is REJECTED, stop and summarize what was held and why.

GROUND-TRUTH RULE (critical):
  - Every number/table/status in your final summary MUST come from an agent report.
    Never invent figures or claim deployment to a live cloud warehouse — this is an
    in-memory engine over synthetic GOPhER files; describe it accurately.
  - Do not hand-sum totals; quote each agent's reported totals verbatim.
  - For Data Quality, quote the DQ agent's category rollup and STATUS line exactly;
    never add categories or change counts.
  - Treat data as PHI-class; reference the HIPAA-audited governance layer.`;

function buildOrchestrator({ client, model, specialistModel, emit, control }) {
  // Specialists can run on a faster model (e.g. Haiku) while the orchestrator
  // keeps the stronger model for planning + the final report.
  const agentOpts = { client, model: specialistModel || model, emit, control };
  const specialists = {
    schema_migration: new SchemaMigrationAgent(agentOpts),
    ingestion:        new IngestionAgent(agentOpts),
    transformation:   new TransformationAgent(agentOpts),
    data_quality:     new DataQualityAgent(agentOpts),
    bi_insight:       new BiInsightAgent(agentOpts),
  };

  function makeDelegate(key) {
    return {
      schema: {
        description: `Delegate a sub-task to the ${key} specialist agent.`,
        input_schema: { type: "object", properties: { task: { type: "string", description: "Self-contained task." } }, required: ["task"] },
      },
      async handler({ task } = {}) {
        if (!task) return "[error] missing 'task'";
        const agent = specialists[key];
        emit({ type: "delegate", from: "orchestrator", to: agent.name, task });
        const result = await agent.run(task);
        return `[${agent.name} report]\n${result}`;
      },
    };
  }

  const localTools = {};
  for (const key of Object.keys(specialists)) localTools[`delegate_${key}`] = makeDelegate(key);

  /* Human-in-the-loop approval — brokered by the governance layer (server). */
  localTools.request_human_approval = {
    schema: {
      description: "Request human approval at a governance gate (e.g. Gold promotion, BI publish). Blocks until a human approves or rejects.",
      input_schema: {
        type: "object",
        properties: {
          gate: { type: "string", description: "Short gate name, e.g. 'Promote to Gold' or 'Publish BI report'." },
          summary: { type: "string", description: "What the human is approving and the key facts (row counts, KPIs)." },
        },
        required: ["gate", "summary"],
      },
    },
    async handler({ gate, summary } = {}) {
      if (!gate) return "[error] missing 'gate'";
      if (control && control.requestApproval) {
        const decision = await control.requestApproval(gate, summary || "");
        return `Governance gate "${gate}": ${decision.toUpperCase()}` +
          (decision === "approved" ? " — proceed." : " — do NOT proceed; halt and summarize.");
      }
      return `Governance gate "${gate}": APPROVED (no human reviewer attached) — proceed.`;
    },
  };

  const orch = new BaseAgent({ client, model, localTools, maxSteps: 14, maxTokens: 4096, emit, control });
  orch.name = "orchestrator";
  orch.system = ORCHESTRATOR_SYSTEM;
  return orch;
}

module.exports = { buildOrchestrator };
