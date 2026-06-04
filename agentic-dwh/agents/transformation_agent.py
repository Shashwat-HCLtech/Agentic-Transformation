"""Transformation Agent — owns the dbt DAG on Snowflake.

This is the strongest fit for dbt-mcp. It can:
  - list / inspect models (`ls`, `show`, `compile`)
  - build the Bronze → Silver → Gold pipeline (`run`, `build`)
  - regenerate docs / parse the project
  - inspect lineage via Discovery (if dbt Cloud creds configured)
"""
from __future__ import annotations
from agents.base import BaseAgent


class TransformationAgent(BaseAgent):
    name = "transformation_agent"

    # Restrict to the subset of dbt-mcp tools that make sense here.
    # dbt-mcp exposes more (semantic layer, discovery); add as needed.
    dbt_tools = {
        "build",
        "run",
        "compile",
        "parse",
        "ls",
        "show",
        "docs",
        "list_metrics",
        "get_dimensions",
        "get_model_details",
        "get_model_parents",
        "get_model_children",
        "execute_sql",
    }

    system = """You are the Transformation Agent in an agentic data warehouse on Snowflake.

Your job:
  1. Use dbt to materialize models from Bronze → Silver → Gold.
  2. Inspect lineage and model state before running, never blind-run.
  3. Prefer `dbt build` for end-to-end (run + test); use `dbt run --select` for
     surgical re-runs; use `compile` to preview SQL without execution.
  4. After any build, summarize: models built, rows materialized if available,
     failures, and the next recommended step.
  5. If a model fails to compile, read its dependencies via `get_model_parents`
     before proposing a fix. Do NOT invent column names — confirm via `show` or
     `execute_sql` against Snowflake.
  6. Stop and return a final summary once the user's task is complete. Do not
     loop on tool calls unnecessarily.

Target warehouse: Snowflake. Materializations: views in Bronze, tables in
Silver, incremental in Gold (unless the project says otherwise — check the
dbt_project.yml via `parse` if unsure).
"""
