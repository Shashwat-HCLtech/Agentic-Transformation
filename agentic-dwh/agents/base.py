"""BaseAgent — generic Claude tool-use loop.

Each concrete agent supplies:
  - system prompt
  - the tools it's allowed to call (subset of dbt-mcp tools, plus optional
    local tools handed in as callables).

The loop terminates when Claude stops requesting tools or after max_steps.
"""
from __future__ import annotations
import json
from typing import Any, Awaitable, Callable

from anthropic import Anthropic

from mcp_bridge import DbtMcpBridge

ToolHandler = Callable[[dict], Awaitable[str]]


class BaseAgent:
    name: str = "base"
    system: str = "You are a helpful agent."
    dbt_tools: set[str] | None = None  # None => no dbt-mcp tools

    def __init__(
        self,
        client: Anthropic,
        model: str,
        dbt: DbtMcpBridge | None = None,
        local_tools: dict[str, tuple[dict, ToolHandler]] | None = None,
        max_steps: int = 12,
    ):
        self.client = client
        self.model = model
        self.dbt = dbt
        self.local_tools = local_tools or {}
        self.max_steps = max_steps

    def _tool_defs(self) -> list[dict]:
        defs: list[dict] = []
        if self.dbt and self.dbt_tools:
            defs.extend(self.dbt.anthropic_tools(allow=self.dbt_tools))
        for name, (schema, _) in self.local_tools.items():
            defs.append({"name": name, **schema})
        return defs

    async def _dispatch(self, name: str, args: dict) -> str:
        if name in self.local_tools:
            _, handler = self.local_tools[name]
            return await handler(args)
        if self.dbt:
            return await self.dbt.call(name, args)
        return f"[no handler for tool {name}]"

    async def run(self, task: str) -> str:
        messages: list[dict] = [{"role": "user", "content": task}]
        tools = self._tool_defs()
        trace: list[str] = []

        for step in range(self.max_steps):
            resp = self.client.messages.create(
                model=self.model,
                max_tokens=4096,
                system=self.system,
                tools=tools or None,
                messages=messages,
            )

            # Collect assistant content for the next turn
            assistant_blocks: list[dict] = []
            tool_uses: list[dict] = []
            for block in resp.content:
                if block.type == "text":
                    assistant_blocks.append({"type": "text", "text": block.text})
                    trace.append(f"[{self.name}] {block.text}")
                elif block.type == "tool_use":
                    tu = {
                        "type": "tool_use",
                        "id": block.id,
                        "name": block.name,
                        "input": block.input,
                    }
                    assistant_blocks.append(tu)
                    tool_uses.append(tu)

            messages.append({"role": "assistant", "content": assistant_blocks})

            if resp.stop_reason != "tool_use" or not tool_uses:
                # Done
                final_text = "\n".join(
                    b["text"] for b in assistant_blocks if b["type"] == "text"
                )
                return final_text or "(no final text)"

            # Run all tool calls in this turn, then feed results back
            tool_results: list[dict] = []
            for tu in tool_uses:
                args = tu["input"] if isinstance(tu["input"], dict) else {}
                trace.append(f"[{self.name}] → {tu['name']}({json.dumps(args)[:200]})")
                try:
                    out = await self._dispatch(tu["name"], args)
                except Exception as e:  # noqa: BLE001
                    out = f"[exception] {type(e).__name__}: {e}"
                trace.append(f"[{self.name}] ← {out[:400]}")
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": tu["id"],
                    "content": out,
                })
            messages.append({"role": "user", "content": tool_results})

        return "\n".join(trace[-20:]) + "\n[max_steps reached]"
