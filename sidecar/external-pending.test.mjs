// `get_messages` mid-turn, through the bridge on the scripted agent
// (`dev/fake-acp.mjs`): a client that attaches while a turn is in flight gets
// the in-flight message as a `stopReason: "pending"` snapshot — open blocks
// marked `streaming`, calls still running marked `background` — so its live
// rows survive a reattach instead of vanishing until `message_end`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(__dirname, "external-agent.mjs");
const FAKE_ACP = path.join(__dirname, "..", "dev", "fake-acp.mjs");

function startBridge(t, runtimeMode) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-pending-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const config = {
    cwd: home,
    agentId: "fake-acp",
    driver: "acp",
    runtimeMode,
    customAgent: { id: "fake-acp", name: "Fake ACP", command: process.execPath, args: [FAKE_ACP] },
  };
  const env = { ...process.env, PI_CODING_AGENT_DIR: path.join(home, "agent"), FAKE_ACP_TICK_MS: "40" };
  delete env.PI_CODING_AGENT_SESSION_DIR;
  const child = spawn(process.execPath, [BRIDGE, JSON.stringify(config)], { cwd: home, env, stdio: ["pipe", "pipe", "ignore"] });
  t.after(() => child.kill());
  const records = [];
  const waits = new Map();
  let watchers = [];
  let buffer = "";
  let seq = 0;
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record.type === "response" && waits.has(record.id)) {
        waits.get(record.id)(record);
        waits.delete(record.id);
        continue;
      }
      records.push(record);
      watchers = watchers.filter((w) => !w());
    }
  });
  const send = (command) =>
    new Promise((resolve) => {
      const id = `t${++seq}`;
      waits.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
    });
  /** Resolves once a record matching `match` has been seen, or rejects after `ms`. */
  const waitFor = (match, ms = 8000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`waited ${ms}ms for record: ${JSON.stringify(records.map((r) => r.type))}`)), ms);
      const check = () => {
        const hit = records.find(match);
        if (!hit) return false;
        clearTimeout(timer);
        resolve(hit);
        return true;
      };
      if (!check()) watchers.push(check);
    });
  const write = (record) => child.stdin.write(`${JSON.stringify(record)}\n`);
  return { records, send, waitFor, write };
}

test("a turn in flight answers get_messages with a pending assistant message", async (t) => {
  const bridge = startBridge(t, "full-access");
  void bridge.send({ type: "prompt", message: "tick for me" });
  // "tick" streams a thought heartbeat until cancelled: a turn that stays open.
  await bridge.waitFor((r) => r.type === "message_update" && r.assistantMessageEvent?.type === "thinking_delta");

  const { data } = await bridge.send({ type: "get_messages" });
  const last = data.messages.at(-1);
  assert.equal(last.role, "assistant");
  assert.equal(last.stopReason, "pending");
  const think = last.content.filter((b) => b.type === "thinking").at(-1);
  assert.ok(think, `no thinking block in ${JSON.stringify(last.content)}`);
  assert.equal(think.streaming, true, JSON.stringify(last));
  assert.ok(think.thinking.includes("tick"), JSON.stringify(think));

  await bridge.send({ type: "abort" });
  await bridge.waitFor((r) => r.type === "agent_settled");
  const settled = (await bridge.send({ type: "get_messages" })).data;
  assert.ok(settled.messages.every((m) => m.stopReason !== "pending"), JSON.stringify(settled.messages.at(-1)));
});

test("a call still running at reattach is marked background in the pending snapshot", async (t) => {
  const bridge = startBridge(t, "approval-required");
  void bridge.send({ type: "prompt", message: "run a command" });
  // The permission request holds the turn open with the call mid-flight.
  const ask = await bridge.waitFor((r) => r.type === "extension_ui_request");

  const { data } = await bridge.send({ type: "get_messages" });
  const last = data.messages.at(-1);
  assert.equal(last.role, "assistant");
  assert.equal(last.stopReason, "pending");
  const call = last.content.find((b) => b.type === "toolCall");
  assert.ok(call, `no toolCall block in ${JSON.stringify(last.content)}`);
  assert.equal(call.background, true);

  // Answered, the turn settles and the pending snapshot is gone with it.
  bridge.write({ type: "extension_ui_response", id: ask.id, confirmed: true });
  await bridge.waitFor((r) => r.type === "agent_settled");
  const settled = (await bridge.send({ type: "get_messages" })).data;
  assert.ok(settled.messages.every((m) => m.stopReason !== "pending"));
  const done = settled.messages.filter((m) => m.role === "assistant").at(-1);
  assert.equal(done.stopReason, "stop");
});
