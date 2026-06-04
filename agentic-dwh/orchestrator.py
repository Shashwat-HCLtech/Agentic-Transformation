"""Claude Pipeline Orchestration Layer (#2 in the diagram).

Top-level controller. Decomposes a user goal into a sequence of agent
invocations and dispatches them. Uses Claude as the planner; each delegate_*
local tool routes to a specialist agent.

Run:
    python orchestrator.py "Build silver+gold for orders, then run DQ checks"
"""
from __future__ import annotations
import asyncio
import sys

from anthropic import Anthropic

from config import load_config
from mcp_bridge import DbtMcpBridge
from agents.base import BaseAgent
from agents import (
    TransformationAgent,
    DataQualityAgent,
    SchemaMigrationAgent,
    IngestionAgent,
    BiInsightAgent,
)


ORCHESTRATOR_SYSTEM = """You are the Claude Pipeline Orchestration Layer for an
agentic data warehouse on Snowflake.

You do NOT execute dbt or SQL directly. You decompose the user's goal and
delegate to specialist agents via the `delegate_*` tools below. Typical flow:

  schema_migration → ingestion → transformation → data_quality → bi_insight

Rules:
  - One delegation at a time. Read each agent's report before deciding the
    next step.
  - If data_quality_agent reports FAIL, route the recommended fix to the
    correct agent (usually transformation) and re-run DQ.
  - Stop when the user's goal is met. Produce a final summary with: what ran,
    what passed/failed, what's deployed in Snowflake, recommended next steps.
  - Never invent results. Quote agent outputs verbatim where it matters.
"""


def build_orchestrator(client: Anthropic, cfg, dbt: DbtMcpBridge) -> BaseAgent:
    # Instantiate specialists once; reuse across delegations.
    specialists = {
        "transformation": TransformationAgent(client, cfg.model, dbt=dbt),
        "data_quality":   DataQualityAgent(client, cfg.model, dbt=dbt),
        "schema_migration": SchemaMigrationAgent(client, cfg.model),
        "ingestion":      IngestionAgent(client, cfg.model),
        "bi_insight":     BiInsightAgent(client, cfg.model, dbt=dbt),
    }

    def make_delegate(key: str):
        async def _delegate(args: dict) -> str:
            task = args.get("task", "")
            if not task:
                return "[error] missing 'task'"
            agent = specialists[key]
            print(f"\n=== Delegating to {agent.name} ===\n{task}\n")
            result = await agent.run(task)
            print(f"\n=== {agent.name} returned ===\n{result}\n")
            return f"[{agent.name} report]\n{result}"
        return _delegate

    schema = {
        "description": "Delegate a sub-task to a specialist agent.",
        "input_schema": {
            "type": "object",
            "properties": {
                "task": {
                    "type": "string",
                    "description": "Self-contained task description for the specialist.",
                }
            },
            "required": ["task"],
        },
    }

    local_tools = {
        f"delegate_{key}": (schema, make_delegate(key))
        for key in specialists
    }

    orchestrator = BaseAgent(
        client=client,
        model=cfg.model,
        dbt=None,                # orchestrator does not call dbt directly
        local_tools=local_tools,
        max_steps=20,
    )
    orchestrator.name = "orchestrator"
    orchestrator.system = ORCHESTRATOR_SYSTEM
    return orchestrator


async def amain(goal: str) -> int:
    cfg = load_config()
    if not cfg.anthropic_api_key:
        print("ERROR: ANTHROPIC_API_KEY not set", file=sys.stderr)
        return 2

    client = Anthropic(api_key=cfg.anthropic_api_key)

    async with DbtMcpBridge(cfg) as dbt:
        print(f"[bootstrap] dbt-mcp tools available: "
              f"{[t['name'] for t in dbt.anthropic_tools()]}")
        orch = build_orchestrator(client, cfg, dbt)
        final = await orch.run(goal)
        print("\n=========== FINAL ===========")
        print(final)
    return 0


def main():
    if len(sys.argv) < 2:
        print('Usage: python orchestrator.py "<goal>"', file=sys.stderr)
        sys.exit(2)
    goal = " ".join(sys.argv[1:])
    sys.exit(asyncio.run(amain(goal)))


if __name__ == "__main__":
    main()
