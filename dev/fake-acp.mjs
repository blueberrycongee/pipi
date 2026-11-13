#!/usr/bin/env node
// Fake ACP server speaking the DeepSeek Harness wire contract, for driving
// `sidecar/external-agent.mjs` end-to-end without a real `dsh` binary or API key.
//
//   node dev/fake-acp.mjs
//
// Emulates the parts of the DSH contract pipi relies on:
// - `initialize` → ACP v1 `sessionCapabilities` ({resume, list, close})
// - `session/new` → `configOptions` with PROVIDER-GROUPED model select whose
//   values are opaque `JSON.stringify([provider, model])`, plus `reasoning_effort`
// - `session/set_config_option` (strict value validation, like DSH)
// - `available_commands_update` after `session/new`: the agent's slash commands
// - `session/resume` / `session/close` / `session/list`
// - `session/prompt` → scripted updates: thought chunk, `tool_call`, a
//   permission request carrying ONLY `toolCallId` (DSH's partial shape),
//   `tool_call_update`, message chunks, `usage_update`
// - `session/cancel` notification resolves the in-flight prompt `cancelled`
// Prompts containing "cancel" hang until cancelled. Diagnostics go to stderr
// as `LOG {...}` lines so a driver can assert what the client sent.
//
// DSH reports no token usage, and neither does this by default. With
// `FAKE_ACP_USAGE=1` a finished prompt carries the protocol's per-turn `usage`,
// as an agent that reports one does (cached tokens counted on top of the input).

import fs from "node:fs";

const sessions = new Map(); // sessionId → { cwd, model, effort }
let seq = 0;
let clientReqId = 1000;
const clientPending = new Map(); // our outgoing request id → resolve
let inflightPrompt = undefined; // { id, sessionId, cancelled }

const MODEL_OPTIONS = [
  {
    group: "deepseek-official",
    name: "DeepSeek Official",
    options: [
      { value: JSON.stringify(["deepseek-official", "deepseek-v4-flash"]), name: "deepseek-v4-flash" },
      { value: JSON.stringify(["deepseek-official", "deepseek-v4-pro"]), name: "deepseek-v4-pro" },
    ],
  },
  {
    group: "openrouter",
    name: "OpenRouter",
    options: [{ value: JSON.stringify(["openrouter", "deepseek/deepseek-v4"]), name: "deepseek/deepseek-v4" }],
  },
];
const EFFORT_OPTIONS = [
  { value: "", name: "Provider default" },
  { value: "low", name: "Low" },
  { value: "medium", name: "Medium" },
  { value: "high", name: "High" },
];
const modelValues = new Set();
for (const g of MODEL_OPTIONS) for (const o of g.options) modelValues.add(o.value);
const effortValues = new Set(EFFORT_OPTIONS.map((o) => o.value));

function configOptions(s) {
  return [
    { id: "model", name: "Model", category: "model", type: "select", currentValue: s.model, options: MODEL_OPTIONS },
    { id: "reasoning_effort", name: "Reasoning Effort", category: "thought_level", type: "select", currentValue: s.effort, options: EFFORT_OPTIONS },
  ];
}

const LOG_FILE = process.env.FAKE_ACP_LOG || "/tmp/fake-acp-log.jsonl";
try {
  fs.writeFileSync(LOG_FILE, "");
} catch {}

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const log = (msg) => {
  try {
    fs.appendFileSync(LOG_FILE, `${JSON.stringify(msg)}\n`);
  } catch {}
};
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const replyErr = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });
const update = (sessionId, u) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });

function requestPermission(sessionId, toolCallId) {
  const id = clientReqId++;
  return new Promise((resolve) => {
    clientPending.set(id, resolve);
    send({
      jsonrpc: "2.0",
      id,
      method: "session/request_permission",
      params: {
        sessionId,
        toolCall: { toolCallId },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      },
    });
  });
}

async function runTurn(sessionId, text) {
  update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: `Thinking about: ${text.slice(0, 40)}` } });
  if (/cancel/i.test(text)) return "wait-for-cancel";
  const toolCallId = `tc_${seq++}`;
  const editTool = /edit/i.test(text);
  const toolName = editTool ? "edit" : "bash";
  const rawInput = editTool ? { path: "fake.txt", oldText: "a", newText: "b" } : { command: "ls -la", description: "List files" };
  update(sessionId, { sessionUpdate: "tool_call", toolCallId, title: toolName, kind: "other", status: "in_progress", rawInput, locations: [] });
  const perm = await requestPermission(sessionId, toolCallId);
  const selected = perm?.outcome?.outcome === "selected" ? perm.outcome.optionId : undefined;
  if (selected !== "allow") {
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "failed", content: [{ type: "content", content: { type: "text", text: "permission denied" } }] });
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The user declined the action." } });
    update(sessionId, { sessionUpdate: "usage_update", used: 12500, size: 262144 });
    return "end_turn";
  }
  const out = editTool ? "fake.txt patched" : "total 12\n-rw-r--r--  fake.txt";
  update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "completed", content: [{ type: "content", content: { type: "text", text: out } }], rawOutput: out });
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "I ran the tool — " } });
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${toolName} finished.` } });
  update(sessionId, { sessionUpdate: "usage_update", used: 12500, size: 262144 });
  return "end_turn";
}

async function handle(msg) {
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    const waiter = clientPending.get(msg.id);
    if (waiter) {
      clientPending.delete(msg.id);
      waiter(msg.error ? { error: msg.error } : msg.result);
    }
    return;
  }
  if (typeof msg.method !== "string") return;
  log({ method: msg.method, params: msg.params, id: msg.id });
  const p = msg.params || {};
  switch (msg.method) {
    case "session/cancel":
      if (inflightPrompt) {
        reply(inflightPrompt.id, { stopReason: "cancelled" });
        inflightPrompt = undefined;
      }
      return;
    case "session/update":
      return;
  }
  if (msg.id === undefined) return;
  switch (msg.method) {
    case "initialize":
      reply(msg.id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: false, sessionCapabilities: { resume: {}, list: {}, close: {} } },
        agentInfo: { name: "fake-dsh", title: "Fake DSH", version: "0.0.0" },
      });
      return;
    case "session/new": {
      const sessionId = `fake-sess-${++seq}`;
      const s = { cwd: p.cwd, model: JSON.stringify(["deepseek-official", "deepseek-v4-flash"]), effort: "medium" };
      sessions.set(sessionId, s);
      reply(msg.id, { sessionId, configOptions: configOptions(s) });
      update(sessionId, {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          { name: "web", description: "Search the web for information", input: { hint: "query to search for" } },
          { name: "plan", description: "Create a detailed implementation plan\nwith steps on later lines the menu does not show" },
        ],
      });
      return;
    }
    case "session/resume": {
      const s = sessions.get(p.sessionId);
      if (!s || (p.cwd && s.cwd && p.cwd !== s.cwd)) return replyErr(msg.id, -32602, "unknown or mismatched session");
      s.closed = false; // like DSH: close detaches the live session, the record stays resumable
      reply(msg.id, { sessionId: p.sessionId, configOptions: configOptions(s) });
      return;
    }
    case "session/list": {
      reply(msg.id, { sessions: [...sessions.keys()].map((sessionId) => ({ sessionId, cwd: sessions.get(sessionId).cwd, title: "fake", updatedAt: Date.now() })), nextCursor: null });
      return;
    }
    case "session/close":
      if (sessions.has(p.sessionId)) sessions.get(p.sessionId).closed = true;
      reply(msg.id, {});
      return;
    case "session/set_config_option": {
      const s = sessions.get(p.sessionId);
      if (!s) return replyErr(msg.id, -32602, "unknown session");
      if (p.configId === "model") {
        if (!modelValues.has(p.value)) return replyErr(msg.id, -32602, `unknown model option: ${String(p.value).slice(0, 80)}`);
        s.model = p.value;
      } else if (p.configId === "reasoning_effort") {
        if (!effortValues.has(p.value)) return replyErr(msg.id, -32602, `unknown effort option: ${p.value}`);
        s.effort = p.value;
      } else {
        return replyErr(msg.id, -32602, `unknown config option: ${p.configId}`);
      }
      reply(msg.id, { configOptions: configOptions(s) });
      return;
    }
    case "session/prompt": {
      const s = sessions.get(p.sessionId);
      if (!s) return replyErr(msg.id, -32602, "unknown session");
      if (inflightPrompt) return replyErr(msg.id, -32602, "prompt already in flight");
      const text = (p.prompt || []).map((c) => c?.text || "").join("\n");
      const result = runTurn(p.sessionId, text);
      inflightPrompt = { id: msg.id, sessionId: p.sessionId };
      const outcome = await result;
      if (outcome !== "wait-for-cancel") {
        if (inflightPrompt?.id === msg.id) {
          inflightPrompt = undefined;
          const usage = { inputTokens: 2100, outputTokens: 40, cachedReadTokens: 8000, cachedWriteTokens: 0, thoughtTokens: 12, totalTokens: 10140 };
          reply(msg.id, process.env.FAKE_ACP_USAGE ? { stopReason: outcome, usage } : { stopReason: outcome });
        }
      }
      return;
    }
    default:
      replyErr(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl = buf.indexOf("\n");
  while (nl !== -1) {
    const line = buf.slice(0, nl).replace(/\r$/, "");
    buf = buf.slice(nl + 1);
    if (line.trim()) {
      try {
        void handle(JSON.parse(line));
      } catch {}
    }
    nl = buf.indexOf("\n");
  }
});
process.stdin.on("end", () => process.exit(0));
