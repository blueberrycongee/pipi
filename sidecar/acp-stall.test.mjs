// A turn whose ACP stream dies silently mid-flight (fake-acp "wedge"): the
// prompt is never resolved and the process never exits — the way an
// Antigravity session worker wedges while its front holds the pipes. The
// bridge's prompt watchdog must end it as an error in bounded time: a probe
// the peer cannot answer drops it at once; one it answers without any turn
// progress is declared stalled. Queued work then drains onto a fresh peer.
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

// Watchdog windows scaled down so a wedge is judged in seconds, not minutes.
const WATCHDOG_ENV = {
  PIPI_ACP_TURN_SILENCE_MS: "400",
  PIPI_ACP_TURN_PROBE_MS: "500",
  PIPI_ACP_TURN_STALL_MS: "1500",
};

function startBridge(t, fakeEnv) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-acp-stall-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const config = {
    cwd: home,
    agentId: "fake-agy",
    driver: "acp",
    runtimeMode: "full-access",
    customAgent: { id: "fake-agy", name: "Fake agy", command: process.execPath, args: [FAKE_ACP] },
  };
  const env = { ...process.env, PI_CODING_AGENT_DIR: path.join(home, "agent"), FAKE_ACP_AGY: "1", FAKE_ACP_LOG: path.join(home, "fake.jsonl"), ...WATCHDOG_ENV, ...fakeEnv };
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
  /** Resolves once `count` settles have been seen in all, or rejects after `ms`. */
  const settles = (count, ms = 15000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`waited ${ms}ms for settle #${count}: ${JSON.stringify(records.map((r) => r.type))}`)), ms);
      const check = () => {
        if (records.filter((r) => r.type === "agent_settled").length < count) return false;
        clearTimeout(timer);
        resolve();
        return true;
      };
      if (!check()) watchers.push(check);
    });
  return { records, send, settles, prompt: (message) => send({ type: "prompt", message }) };
}

/** The records of each run, from its `agent_start` to its `agent_settled`. */
function runs(records) {
  const out = [];
  let run;
  for (const r of records) {
    if (r.type === "agent_start") out.push((run = []));
    run?.push(r);
    if (r.type === "agent_settled") run = undefined;
  }
  return out;
}
const textOf = (run) =>
  run
    .filter((r) => r.type === "message_update" && r.assistantMessageEvent?.type === "text_delta")
    .map((r) => r.assistantMessageEvent.delta)
    .join("");
const errorsOf = (run) => run.filter((r) => r.type === "message_end" && r.message?.role === "assistant" && r.message.stopReason === "error").map((r) => r.message.errorMessage);

test("a peer that answers nothing is dropped and the turn ends as an error", async (t) => {
  const bridge = startBridge(t, { FAKE_ACP_WEDGE: "full" });
  assert.equal((await bridge.prompt("wedge")).success, true);
  await bridge.settles(1);
  const [run] = runs(bridge.records);
  assert.ok(run.some((r) => r.type === "tool_execution_start"), "the wedge streamed its first events before dying");
  assert.deepEqual(errorsOf(run), ["ACP agent stopped responding mid-turn"]);
});

test("a peer that answers but makes no progress is declared stalled in bounded time", async (t) => {
  // The turn engine is gone but the RPC loop still answers `session/list` —
  // exactly what a wedged worker leaves behind.
  const bridge = startBridge(t, { FAKE_ACP_WEDGE: "engine" });
  assert.equal((await bridge.prompt("wedge")).success, true);
  await bridge.settles(1);
  const [run] = runs(bridge.records);
  const errors = errorsOf(run);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /no progress/);
});

test("a queued message drains onto a fresh peer once the dead run is judged", async (t) => {
  const bridge = startBridge(t, { FAKE_ACP_WEDGE: "engine" });
  assert.equal((await bridge.prompt("wedge")).success, true);
  const queued = await bridge.prompt("hello again");
  assert.equal(queued.data?.disposition, "queued", "the message waits behind the dead run instead of being lost");
  await bridge.settles(1);
  const all = runs(bridge.records);
  assert.equal(all.length, 2, "the dead turn and its drained follow-up share one settle");
  assert.equal(textOf(all[1]), "I ran the tool — bash finished.", "the queued prompt ran to completion on the respawned peer");
});

test("a turn that keeps producing output is never judged dead", async (t) => {
  const bridge = startBridge(t, { FAKE_ACP_TICK_MS: "80" });
  assert.equal((await bridge.prompt("tick")).success, true);
  // Past the silence + stall windows with output flowing, nothing fires.
  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.equal(bridge.records.filter((r) => r.type === "agent_settled").length, 0, "an active turn is left alone");
  assert.equal(errorsOf(runs(bridge.records)[0] ?? []).length, 0);
  // And the user's own interrupt still lands: cancel resolves the prompt.
  await bridge.send({ type: "abort" });
  await bridge.settles(1);
  const [run] = runs(bridge.records);
  assert.ok(run.some((r) => r.type === "message_end" && r.message?.role === "assistant" && r.message.stopReason === "aborted"));
});
