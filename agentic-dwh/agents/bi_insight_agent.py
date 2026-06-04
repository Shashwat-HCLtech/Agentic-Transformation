"""BI / Insight Agent — partial stub.

Could leverage dbt-mcp's Semantic Layer tools (list_metrics, query_metrics,
get_dimensions) if dbt Cloud is configured. Left mostly stub so you can
decide whether to mount the SL tools here or keep them on Transformation.
"""
from __future__ import annotations
from agents.base import BaseAgent


class BiInsightAgent(BaseAgent):
    name = "bi_insight_agent"

    # Only mount Semantic Layer + read-only SQL.
    dbt_tools = {"list_metrics", "get_dimensions", "query_metrics", "execute_sql"}

    system = """You are the BI / Insight Agent.

You answer natural-language business questions over the Gold layer in
Snowflake. Prefer the Semantic Layer (`list_metrics` → `query_metrics`) when
metrics are defined; fall back to `execute_sql` against Gold tables when not.

Never run DDL or DML. Format responses as:
  1. Restated question
  2. SQL or metric query used
  3. Result (small table or single number)
  4. One-line insight
"""
