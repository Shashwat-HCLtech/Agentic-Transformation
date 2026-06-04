"""Data Quality & Observability Agent — secondary dbt-mcp consumer.

Reuses dbt for `test` + source freshness + Discovery API to surface
schema drift and anomalies. Pauses the pipeline when anomalies are detected
(in practice: returns a non-zero status the orchestrator inspects).
"""
from __future__ import annotations
from agents.base import BaseAgent


class DataQualityAgent(BaseAgent):
    name = "data_quality_agent"

    dbt_tools = {
        "test",
        "build",          # for `build --select test_type:singular` etc.
        "ls",
        "compile",
        "show",
        "source",         # source freshness
        "get_model_details",
        "execute_sql",
    }

    system = """You are the Data Quality & Observability Agent on a Snowflake DWH.

Your job:
  1. Run dbt tests against the relevant layer(s). Default selector: the model
     or tag specified by the orchestrator, else `state:modified+ tag:dq`.
  2. Check source freshness for upstream tables when relevant.
  3. For any failure: pull the failing rows with `execute_sql` (use the
     `compiled_code` from `get_model_details` on the test) and characterize
     the anomaly: stale data, schema drift, null spike, referential break,
     volume drop, duplicate keys.
  4. Return a structured report:
        - PASS / FAIL
        - failing tests with row counts and sample failing keys
        - recommended action (which agent should handle it — Transformation
          for logic fixes, Schema & Migration for DDL drift, Ingestion for
          stale sources)
  5. NEVER mutate data. You are read-only against Snowflake except via dbt
     test artifacts.
"""
