#!/usr/bin/env node
// Devin-shaped ACP fixture: `model` values carry each family/default variant,
// `thought_level` is the effective per-model ladder and resets on model change,
// and `speed` appears only for models whose engine advertises it.
import fs from "node:fs";

const LOG_FILE = process.env.FAKE_DEVIN_ACP_LOG || "/tmp/fake-devin-acp-log.jsonl";
try { fs.writeFileSync(LOG_FILE, ""); } catch {}
const log = (msg) => { try { fs.appendFileSync(LOG_FILE, `${JSON.stringify(msg)}\n`); } catch {} };
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const replyErr = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

const MODELS = [
  { value: "swe-2-1-medium", name: "SWE-2.1 Medium", images: true, efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" },
  { value: "swe-2-1-low-lightning", name: "SWE-2.1 Ultrafast Low", images: true, efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "low" },
  { value: "swe-2-flash-medium", name: "SWE-2 Flash Medium", images: false, efforts: ["medium", "high", "max"], defaultEffort: "medium" },
  { value: "claude-fable-5-2-medium", name: "Claude Fable 5.2", images: true, efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium", speed: true },
  { value: "gpt-6-sol-medium", name: "GPT-6 Sol", images: true, efforts: ["none", "low", "medium", "high", "xhigh", "max"], defaultEffort: "medium", speed: true },
  { value: "gemini-4-carbon-medium", name: "Gemini 4 Carbon", images: true, efforts: ["low", "medium", "high"], defaultEffort: "medium" },
  { value: "adaptive", name: "Adaptive", images: true, efforts: [] },
  { value: "fusion-claude-opus-5-5-medium-sidekick-swe-2-high", name: "Fusion (Claude Opus 5.5 Medium + SWE-2 High)", images: true, efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium", speed: true },
];
const byValue = new Map(MODELS.map((m) => [m.value, m]));
const sessions = new Map();
let seq = 0;

function configOptions(s) {
  const model = byValue.get(s.model);
  const out = [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: s.model,
      options: MODELS.map((m) => ({ value: m.value, name: m.name, _meta: { "cognition.ai/supportsImages": m.images } })),
    },
  ];
  if (model?.efforts.length) {
    out.push({ id: "thought_level", name: "Thinking", category: "thought_level", type: "select", currentValue: s.effort, options: model.efforts.map((value) => ({ value, name: value[0].toUpperCase() + value.slice(1) })) });
  }
  if (model?.speed) {
    out.push({ id: "speed", name: "Speed", category: "model_config", type: "select", currentValue: s.speed, options: [{ value: "standard", name: "Standard" }, { value: "fast", name: "Fast" }] });
  }
  return out;
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  for (let at = buf.indexOf("\n"); at >= 0; at = buf.indexOf("\n")) {
    const line = buf.slice(0, at);
    buf = buf.slice(at + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined) continue;
    const p = msg.params || {};
    log({ method: msg.method, params: p });
    if (msg.method === "initialize") {
      reply(msg.id, { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } }, agentInfo: { name: "affogato", title: "Devin Agent", version: "3000.14.30821" } });
    } else if (msg.method === "session/new") {
      const sessionId = `devin-fake-${++seq}`;
      sessions.set(sessionId, { model: process.env.FAKE_DEVIN_DEFAULT_MODEL || "swe-2-1-medium", effort: "medium", speed: "standard" });
      reply(msg.id, { sessionId, configOptions: configOptions(sessions.get(sessionId)) });
    } else if (msg.method === "session/set_config_option") {
      const s = sessions.get(p.sessionId);
      if (!s) replyErr(msg.id, -32602, "unknown session");
      else if (p.configId === "model") {
        const model = byValue.get(p.value);
        if (!model) replyErr(msg.id, -32602, "unknown model");
        else {
          s.model = p.value;
          s.effort = model.defaultEffort;
          s.speed = "standard";
          reply(msg.id, { configOptions: configOptions(s) });
        }
      } else if (p.configId === "thought_level") {
        const model = byValue.get(s.model);
        if (!model?.efforts.includes(p.value)) replyErr(msg.id, -32602, "Invalid params");
        else {
          s.effort = p.value;
          reply(msg.id, { configOptions: configOptions(s) });
        }
      } else if (p.configId === "speed") {
        if (!byValue.get(s.model)?.speed || !["standard", "fast"].includes(p.value)) replyErr(msg.id, -32602, "Invalid params");
        else {
          s.speed = p.value;
          reply(msg.id, { configOptions: configOptions(s) });
        }
      } else replyErr(msg.id, -32602, "unknown config");
    } else if (msg.method === "session/prompt") {
      const s = sessions.get(p.sessionId);
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: p.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify({ ...s, prompt: p.prompt }) } } } });
      reply(msg.id, { stopReason: "end_turn" });
    } else if (msg.method === "session/close" || msg.method === "session/delete") {
      reply(msg.id, {});
    } else {
      replyErr(msg.id, -32601, `unknown method ${msg.method}`);
    }
  }
});
