# Agentic DWH Orchestrator (Snowflake + dbt-mcp)

A reference implementation of the "Proposed: Agentic AI integration Architecture"
diagram, scoped for **Cursor + Snowflake**. The **Claude Pipeline Orchestration
Layer** is a Python orchestrator that routes high-level goals to specialist
agents. The **Transformation Agent** and **Data Quality & Observability Agent**
are wired to [`dbt-mcp`](https://github.com/dbt-labs/dbt-mcp); the other three
are stubs you can extend.

## Why Transformation Agent is the primary dbt-mcp consumer

`dbt-mcp` exposes:

- **CLI tools**: `build`, `run`, `test`, `compile`, `parse`, `ls`, `show`, `docs`
- **Semantic Layer**: query metrics, list dimensions
- **Discovery API**: model metadata, lineage, sources, exposures
- **SQL execution** against the connected warehouse

That maps directly onto building/running/materializing models — i.e. the
Transformation Agent. `test` + Discovery also lets the Data Quality Agent reuse
the same MCP. Schema-migration, ingestion, and BI agents either have weak
overlap (BI: semantic layer is upstream of BI, not BI itself) or no overlap.

## Layout

```
agentic-dwh/
├── orchestrator.py              # Claude Pipeline Orchestration Layer (#2)
├── mcp_bridge.py                # stdio MCP client → Anthropic tool_use bridge
├── config.py                    # env loading
├── agents/
│   ├── base.py                  # BaseAgent (Claude loop with tools)
│   ├── transformation_agent.py  # #5 — primary dbt-mcp consumer
│   ├── data_quality_agent.py    # #6 — secondary dbt-mcp consumer
│   ├── schema_migration_agent.py# #3 — stub (Snowflake DDL via SQL)
│   ├── ingestion_agent.py       # #4 — stub
│   └── bi_insight_agent.py      # #7 — stub (NL→SQL on Snowflake)
├── dbt_project_snowflake/       # minimal dbt project targeting Snowflake
├── .cursor/mcp.json             # so Cursor itself can call dbt-mcp directly
├── .env.example
└── requirements.txt
```

## Setup

```bash
# 1. Python deps
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# 2. Install dbt-mcp + dbt-snowflake
uv tool install dbt-mcp           # or: pipx install dbt-mcp
pip install dbt-snowflake

# 3. Configure Snowflake + dbt profile
cp .env.example .env              # fill in ANTHROPIC_API_KEY + SNOWFLAKE_*
# edit ~/.dbt/profiles.yml to point at your Snowflake account (see below)

# 4. Smoke-test the dbt project
cd dbt_project_snowflake && dbt debug && dbt parse && cd ..

# 5. Run the orchestrator
python orchestrator.py "Build the bronze→silver→gold pipeline for raw_orders, then run all tests"
```

### `~/.dbt/profiles.yml`

```yaml
agentic_dwh:
  target: dev
  outputs:
    dev:
      type: snowflake
      account: "{{ env_var('SNOWFLAKE_ACCOUNT') }}"
      user: "{{ env_var('SNOWFLAKE_USER') }}"
      password: "{{ env_var('SNOWFLAKE_PASSWORD') }}"
      role: "{{ env_var('SNOWFLAKE_ROLE') }}"
      warehouse: "{{ env_var('SNOWFLAKE_WAREHOUSE') }}"
      database: "{{ env_var('SNOWFLAKE_DATABASE') }}"
      schema: "{{ env_var('SNOWFLAKE_SCHEMA') }}"
      threads: 4
```

## Using from Cursor directly

`.cursor/mcp.json` is included — once you open this folder in Cursor, the
dbt-mcp server is available to Cursor's own agent too. You can either:

- Drive everything through `orchestrator.py` (programmatic, reproducible), or
- Chat with Cursor and let it call dbt-mcp tools ad-hoc.

The orchestrator is the "Claude Pipeline Orchestration Layer" from your
diagram; Cursor-direct is fine for exploration.
