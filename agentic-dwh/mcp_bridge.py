"""
Bridge between an MCP stdio server (dbt-mcp) and the Anthropic Messages API.

Responsibilities:
  - Spawn `uvx dbt-mcp` as a subprocess and speak MCP over stdio.
  - Expose its tools in Anthropic's `tools=[...]` shape.
  - Forward Anthropic `tool_use` blocks to MCP `call_tool` and stream results
    back as `tool_result` blocks.

Usage:
    async with DbtMcpBridge(config) as bridge:
        tools = bridge.anthropic_tools()
        result = await bridge.call("list", {})
"""
from __future__ import annotations
import asyncio
from contextlib import AsyncExitStack
from typing import Any

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from config import Config


class DbtMcpBridge:
    def __init__(self, cfg: Config, command: str = "uvx", args: list[str] | None = None):
        self.cfg = cfg
        self._command = command
        self._args = args or ["dbt-mcp"]
        self._stack: AsyncExitStack | None = None
        self.session: ClientSession | None = None
        self._tools: list[Any] = []

    async def __aenter__(self) -> "DbtMcpBridge":
        self._stack = AsyncExitStack()
        params = StdioServerParameters(
            command=self._command,
            args=self._args,
            env=self.cfg.dbt_mcp_env(),
        )
        read, write = await self._stack.enter_async_context(stdio_client(params))
        self.session = await self._stack.enter_async_context(ClientSession(read, write))
        await self.session.initialize()
        listed = await self.session.list_tools()
        self._tools = listed.tools
        return self

    async def __aexit__(self, *exc):
        if self._stack:
            await self._stack.aclose()
        self.session = None

    # ---- Anthropic-side surface ----

    def anthropic_tools(self, allow: set[str] | None = None) -> list[dict]:
        """Return tool defs in Anthropic Messages API format.

        Pass `allow` to filter dbt-mcp tools to a relevant subset per agent
        (e.g. {"build","run","test","compile","ls","show"} for transformation).
        """
        out = []
        for t in self._tools:
            if allow is not None and t.name not in allow:
                continue
            out.append({
                "name": t.name,
                "description": (t.description or "").strip(),
                "input_schema": t.inputSchema or {"type": "object", "properties": {}},
            })
        return out

    async def call(self, name: str, arguments: dict) -> str:
        assert self.session, "Bridge not entered"
        res = await self.session.call_tool(name, arguments or {})
        # Flatten content into a single string for tool_result
        parts: list[str] = []
        for block in res.content:
            text = getattr(block, "text", None)
            if text is not None:
                parts.append(text)
            else:
                parts.append(str(block))
        body = "\n".join(parts) if parts else "(no output)"
        if res.isError:
            body = f"[tool error]\n{body}"
        return body


def run(coro):
    """Helper for sync entry points."""
    return asyncio.run(coro)
