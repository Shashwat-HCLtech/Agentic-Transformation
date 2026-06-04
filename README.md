# Agentic DWH — GOPhER → Snowflake

An agentic data-warehouse migration demo: a **Claude pipeline orchestrator** that
decomposes a goal and dispatches specialist agents to move the **GOPhER** data
mart (Mainframe · Cloud-native · Direct DB sources) through a **Snowflake
medallion** (Bronze → Silver → Gold), under a **HIPAA-style governance layer**
with **human approval gates**, and finally emits a **Power BI dataset**.

Built for the UHC Pharmacy / PharsOnline migration context. All data here is
**synthetic** — no real PHI.

> ⚠️ This repo intentionally excludes secrets (`.env`), the corporate CA bundle
> (`windows-ca.pem`), confidential client docs (`_docs_extracted/`), and runtime
> output. See `.gitignore`.

## Repo layout

| Path | What |
|---|---|
| `agentic-dwh-app/` | **The working app** — Node/Express + browser UI (run this) |
| `agentic-dwh/` | Original Python reference implementation (dbt-mcp + Snowflake) |

## The 8-box architecture

| # | Component | Implemented as |
|---|---|---|
| 1 | Governance / Observability — HIPAA audit, drift alerts, kill switch | server + UI Governance tab |
| 2 | Orchestrator — decompose, route, broker human approvals | `agents/orchestrator.js` |
| 3 | Schema Migration — Sybase→Snowflake DDL + drift detection | `agents/specialists.js` |
| 4 | Ingestion — Kafka/ADF config gen + self-heal | `agents/specialists.js` |
| 5 | Transformation — Spark/dbt, Bronze→Gold (approval-gated) | `agents/specialists.js` |
| 6 | Data Quality — 40-check battery, pause on anomaly | `agents/specialists.js` |
| 7 | BI / Insight — NL→SQL on Snowflake, KPIs (approval-gated) | `agents/specialists.js` |
| 8 | Feedback loop — BI / DQ failures route back to Transformation | orchestrator prompt |

The medallion transforms run on a real in-memory engine (`agents/warehouse.js`)
over the synthetic GOPhER files in `agentic-dwh-app/data/sources/` — so every
row count and KPI is real, not fabricated.

## Run it

```bash
cd agentic-dwh-app
npm install
cp .env.example .env          # add your ANTHROPIC_API_KEY
node server.js                # → http://localhost:3000
```

Then on the landing page: drop in (or **Use sample data**) the three source
buckets → **Run pipeline** → approve the governance gates → download the
**`.xlsx` + `.pbids`** Power BI dataset from the Report tab.

### Speed

The runtime is dominated by sequential live Claude calls (~40 per run). To speed
up, point the specialist agents at a faster model — set `SPECIALIST_MODEL` (e.g.
a Haiku id) in `.env`; the orchestrator keeps `MODEL` for planning + the report.

## Tech

Node.js · Express · `@anthropic-ai/sdk` · SheetJS (xlsx) · vanilla JS UI (SSE
streaming). No database required — the warehouse engine is in-memory.

🤖 Built with [Claude Code](https://claude.com/claude-code)
