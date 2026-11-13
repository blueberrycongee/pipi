// The bridge end to end, against the scripted ACP agent (`dev/fake-acp.mjs`):
// what an engine reports for a turn lands in the session file in Pi's format,
// survives a restart, and is what `usage-stats.mjs` adds up — while an engine
// that reports nothing, and a file saved before usage was read, show none.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(__dirname, "external-agent.mjs");
const STATS = path.join(__dirname, "usage-stats.mjs");
const FAKE_ACP = path.join(__dirname, "..", "dev", "fake-acp.mjs");

/** The bridge on the scripted agent, speaking Pi's RPC over stdio. */
function startBridge(agentDir, cwd, reportsUsage) {
  const config = {
    cwd,
    agentId: reportsUsage ? "fake-acp" : "fake-silent",
    driver: "acp",
    runtimeMode: "full-access",
    customAgent: { id: reportsUsage ? "fake-acp" : "fake-silent", name: "Fake ACP", command: process.execPath, args: [FAKE_ACP] },
  };
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
  delete env.PI_CODING_AGENT_SESSION_DIR;
  delete env.FAKE_ACP_USAGE;
  if (reportsUsage) env.FAKE_ACP_USAGE = "1";
  const child = spawn(process.execPath, [BRIDGE, JSON.stringify(config)], { cwd, env, stdio: ["pipe", "pipe", "ignore"] });
  const waits = new Map();
  let ended;
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
      } else if (record.type === "agent_end") ended?.();
      else if (record.type === "extension_ui_request") child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: record.id, confirmed: true })}\n`);
    }
  });
  const send = (command) =>
    new Promise((resolve) => {
      const id = `t${++seq}`;
      waits.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
    });
  return {
    send,
    async turn(message) {
      const done = new Promise((resolve) => (ended = resolve));
      const started = await send({ type: "prompt", message });
      assert.equal(started.success, true, JSON.stringify(started));
      await done;
    },
    stats: async () => (await send({ type: "get_session_stats" })).data,
    stop: () => new Promise((resolve) => (child.once("exit", resolve), child.kill())),
  };
}

const scan = async (agentDir) => {
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
  delete env.PI_CODING_AGENT_SESSION_DIR;
  return JSON.parse((await execFileAsync(process.execPath, [STATS], { env })).stdout);
};

// One turn as the scripted agent reports it: 2100 in, 40 out, 8000 read from cache, no cost.
const TURN = { input: 2100, output: 40, cacheRead: 8000, cacheWrite: 0, total: 10140 };

test("a turn's reported usage is saved per turn, restored on reopen, and summed by the scanner", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-usage-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-usage-cwd-"));
  let bridge = startBridge(agentDir, cwd, true);
  try {
    await bridge.turn("list the files");
    let stats = await bridge.stats();
    assert.deepEqual(stats.tokens, TURN);
    assert.equal(stats.cost, 0);
    assert.equal(stats.costReported, false);

    await bridge.turn("list them again");
    stats = await bridge.stats();
    assert.deepEqual(stats.tokens, { input: 4200, output: 80, cacheRead: 16000, cacheWrite: 0, total: 20280 });

    // Each turn's own figure is on its assistant message, in Pi's shape — not a running total.
    const lines = fs.readFileSync(stats.sessionFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(lines[0].version, 2);
    const stamped = lines.filter((line) => line.type === "message" && line.message.role === "assistant").map((line) => line.message.usage);
    assert.equal(stamped.length, 2);
    for (const usage of stamped) {
      assert.deepEqual({ input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, total: usage.totalTokens }, TURN);
      assert.equal(usage.unpriced, true);
      assert.equal(usage.cost.total, 0);
    }

    // A new process on the saved file picks up where the session stood.
    await bridge.stop();
    bridge = startBridge(agentDir, cwd, true);
    await bridge.send({ type: "switch_session", sessionPath: stats.sessionFile });
    assert.deepEqual((await bridge.stats()).tokens, stats.tokens);

    const scanned = await scan(agentDir);
    assert.equal(scanned.totals.total, 20280);
    assert.equal(scanned.totals.cacheRead, 16000);
    assert.equal(scanned.totals.cost, 0);
    assert.equal(scanned.totals.unpriced, 20280);
    assert.deepEqual(
      scanned.agents.map((agent) => [agent.agentId, agent.sessions, agent.tokens.total, agent.unpriced]),
      [["fake-acp", 1, 20280, 20280]],
    );
  } finally {
    await bridge.stop();
    fs.rmSync(agentDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("an agent that reports nothing, and a session saved before usage was read, have sessions and no figures", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-usage-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-usage-cwd-"));
  const bridge = startBridge(agentDir, cwd, false);
  try {
    await bridge.turn("list the files");
    const stats = await bridge.stats();
    assert.deepEqual(stats.tokens, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
    // What is in context is still what the agent said it held.
    assert.deepEqual(stats.contextUsage, { tokens: 12500, contextWindow: 262144, percent: (12500 / 262144) * 100 });

    // A version-1 file: every assistant message stamped with the session's running total.
    const legacy = path.join(path.dirname(stats.sessionFile), "legacy.pipi-agent.jsonl");
    const running = (input, output) => ({ input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
    fs.writeFileSync(
      legacy,
      [
        { type: "pipi_external_session", version: 1, id: "legacy", agentId: "devin", driver: "acp", cwd },
        { type: "message", message: { role: "user", content: "hi", timestamp: 1 } },
        { type: "message", message: { role: "assistant", content: [], provider: "devin", model: "default", usage: running(900, 40), timestamp: 2 } },
        { type: "message", message: { role: "assistant", content: [], provider: "devin", model: "default", usage: running(2100, 95), timestamp: 3 } },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n"),
    );

    const scanned = await scan(agentDir);
    assert.equal(scanned.totals.total, 0);
    assert.equal(scanned.totals.sessions, 2);
    assert.deepEqual(scanned.agents.map((agent) => [agent.agentId, agent.sessions, agent.tokens.total]).sort(), [
      ["devin", 1, 0],
      ["fake-silent", 1, 0],
    ]);
    assert.deepEqual(scanned.models, []);
  } finally {
    await bridge.stop();
    fs.rmSync(agentDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
