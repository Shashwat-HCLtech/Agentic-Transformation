"""Schema & Migration Agent — STUB.

Out of scope for dbt-mcp. Real implementation should hook into a Snowflake
SQL executor (snowflake-connector-python) + Sybase/SAP IQ/DB2 source readers
to generate target DDL and detect drift. Left as a stub so the orchestrator
can route to it.
"""
from __future__ import annotations
from agents.base import BaseAgent


class SchemaMigrationAgent(BaseAgent):
    name = "schema_migration_agent"
    dbt_tools = None  # does not use dbt-mcp
    system = """You are the Schema & Migration Agent.

You are currently a STUB. When asked to act, respond with a JSON plan of:
  - source_system
  - target_snowflake_ddl
  - drift_detected: bool
  - migration_steps: [string]

Do not attempt to execute migrations until the orchestrator wires you to a
Snowflake executor tool.
"""
