"use strict";
const { callTool, TOOL_SCHEMAS } = require("./mockTools");

/**
 * BaseAgent — async Claude tool-use loop, ported from base.py.
 * Emits structured events via an optional `emit` callback so the server
 * can stream them to the browser over SSE.
 */
class BaseAgent {
  constructor({ client, model, allowedTools = [], localTools = {}, maxSteps = 5, maxTokens = 2000, emit, control }) {
    this.client = client;
    this.model = model;
    this.allowedTools = allowedTools; // subset of TOOL_SCHEMAS keys
    this.localTools = localTools;     // { name: { schema, handler } }
    this.maxSteps = maxSteps;
    this.maxTokens = maxTokens;
    this.emit = emit || (() => {});
    this.control = control || null;   // governance kill-switch hook
    this.name = "base";
    this.system = "You are a helpful agent.";
  }

  _toolDefs() {
    const defs = [];
    for (const name of this.allowedTools) {
      if (TOOL_SCHEMAS[name]) defs.push(TOOL_SCHEMAS[name]);
    }
    for (const [name, { schema }] of Object.entries(this.localTools)) {
      defs.push({ name, ...schema });
    }
    return defs;
  }

  async _dispatch(name, args) {
    if (this.localTools[name]) {
      return await this.localTools[name].handler(args);
    }
    if (this.allowedTools.includes(name)) {
      return await callTool(name, args);
    }
    return `[no handler for tool ${name}]`;
  }

  async run(task) {
    const messages = [{ role: "user", content: task }];
    const tools = this._toolDefs();
    const trace = [];

    this.emit({ type: "agent_start", agent: this.name, task });

    for (let step = 0; step < this.maxSteps; step++) {
      if (this.control && this.control.isKilled && this.control.isKilled()) {
        const msg = "[KILL SWITCH] Pipeline halted by governance operator.";
        this.emit({ type: "agent_done", agent: this.name, result: msg });
        return msg;
      }
      const resp = await this.client.messages.create({
        model: this.model,
        max_tokens: this.maxTokens,
        system: this.system,
        tools: tools.length ? tools : undefined,
        messages,
      });

      const assistantBlocks = [];
      const toolUses = [];

      for (const block of resp.content) {
        if (block.type === "text") {
          assistantBlocks.push({ type: "text", text: block.text });
          trace.push(block.text);
          this.emit({ type: "text", agent: this.name, text: block.text });
        } else if (block.type === "tool_use") {
          const tu = { type: "tool_use", id: block.id, name: block.name, input: block.input };
          assistantBlocks.push(tu);
          toolUses.push(tu);
          this.emit({ type: "tool_call", agent: this.name, tool: block.name, input: block.input });
        }
      }

      messages.push({ role: "assistant", content: assistantBlocks });

      if (resp.stop_reason !== "tool_use" || toolUses.length === 0) {
        const finalText = assistantBlocks
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n");
        this.emit({ type: "agent_done", agent: this.name, result: finalText });
        return finalText || "(no final text)";
      }

      const toolResults = [];
      for (const tu of toolUses) {
        const args = typeof tu.input === "object" ? tu.input : {};
        let out;
        try {
          out = await this._dispatch(tu.name, args);
        } catch (e) {
          out = `[exception] ${e.message}`;
        }
        this.emit({ type: "tool_result", agent: this.name, tool: tu.name, result: out });
        toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: out });
      }
      messages.push({ role: "user", content: toolResults });
    }

    const fallback = trace.slice(-20).join("\n") + "\n[max_steps reached]";
    this.emit({ type: "agent_done", agent: this.name, result: fallback });
    return fallback;
  }
}

module.exports = BaseAgent;
