// Devin's ACP model dialect through the bridge: model values are family/default
// carriers, thought_level is the effective per-model ladder (with `none` read as
// pipi's off), speed is a model_config selector, and a user's abstract effort
// pick is restored after Devin resets it on a model switch.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(__dirname, "external-agent.mjs");
const FAKE = path.join(__dirname, "..", "dev", "fake-devin-acp.mjs");

function startBridge(t, extraEnv = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-devin-acp-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const config = {
    cwd: home,
    agentId: "devin",
    driver: "acp",
    runtimeMode: "full-access",
    customAgent: { id: "devin", name: "Devin", command: process.execPath, args: [FAKE] },
  };
  const env = { ...process.env, PI_CODING_AGENT_DIR: path.join(home, "agent"), FAKE_DEVIN_ACP_LOG: path.join(home, "fake.jsonl"), ...extraEnv };
  delete env.PI_CODING_AGENT_SESSION_DIR;
  const child = spawn(process.execPath, [BRIDGE, JSON.stringify(config)], { cwd: home, env, stdio: ["pipe", "pipe", "ignore"] });
  t.after(() => child.kill());
  const waits = new Map();
  let seq = 0;
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record.type === "response" && waits.has(record.id)) {
        waits.get(record.id)(record);
        waits.delete(record.id);
      }
    }
  });
  const send = (command) => new Promise((resolve, reject) => {
    const id = `t${++seq}`;
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${command.type}`)), 8000);
    waits.set(id, (record) => {
      clearTimeout(timer);
      resolve(record);
    });
    child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
  });
  const ok = async (command) => {
    const res = await send(command);
    assert.equal(res.success, true, res.error);
    return res.data;
  };
  return { ok, send };
}

test("Devin's model catalog is shown as model families, with image reach and fusion grouping honest", async (t) => {
  const bridge = startBridge(t);
  const { models } = await bridge.ok({ type: "get_available_models" });
  const byId = new Map(models.map((m) => [m.id, m]));

  assert.equal(byId.get("swe-2-1-medium")?.name, "SWE-2.1");
  assert.equal(byId.get("swe-2-1-low-lightning")?.name, "SWE-2.1 Ultrafast");
  assert.equal(byId.get("fusion-claude-opus-5-5-medium-sidekick-swe-2-high")?.name, "Fusion (Claude Opus 5.5 + SWE-2)");
  assert.equal(byId.get("fusion-claude-opus-5-5-medium-sidekick-swe-2-high")?.group, "Fusion");
  assert.deepEqual(byId.get("swe-2-flash-medium")?.input, ["text"]);
  assert.deepEqual(byId.get("swe-2-1-medium")?.input, ["text", "image"]);
  assert.ok(!models.some((m) => /^(SWE-2\.1|SWE-2) (Medium|High|Max)$/.test(m.name)));

  const state = await bridge.ok({ type: "get_state" });
  assert.equal(state.model.id, "swe-2-1-medium");
  assert.equal(state.model.name, "SWE-2.1");
  assert.equal(state.model.reasoning, true);
  assert.equal(state.thinkingLevel, "medium");
  const { levels } = await bridge.ok({ type: "get_available_thinking_levels" });
  assert.deepEqual(levels, ["low", "medium", "high", "xhigh", "max"]);
});

test("a picked effort is clamped truthfully per model and restored when the model supports it again", async (t) => {
  const bridge = startBridge(t);
  await bridge.ok({ type: "get_available_models" });
  await bridge.ok({ type: "set_thinking_level", level: "max" });
  assert.equal((await bridge.ok({ type: "get_state" })).thinkingLevel, "max");

  await bridge.ok({ type: "set_model", provider: "devin", modelId: "gemini-4-carbon-medium" });
  let state = await bridge.ok({ type: "get_state" });
  assert.equal(state.thinkingLevel, "high", "gemini tops out at high; state must not keep claiming max");
  assert.deepEqual((await bridge.ok({ type: "get_available_thinking_levels" })).levels, ["low", "medium", "high"]);

  await bridge.ok({ type: "set_model", provider: "devin", modelId: "swe-2-1-medium" });
  state = await bridge.ok({ type: "get_state" });
  assert.equal(state.thinkingLevel, "max", "the abstract max pick survives the clamped detour");
});

test("Devin's none rung is pipi's off, and speed is a settable model_config", async (t) => {
  const bridge = startBridge(t);
  await bridge.ok({ type: "get_available_models" });
  await bridge.ok({ type: "set_model", provider: "devin", modelId: "gpt-6-sol-medium" });

  assert.deepEqual((await bridge.ok({ type: "get_available_thinking_levels" })).levels, ["off", "low", "medium", "high", "xhigh", "max"]);
  await bridge.ok({ type: "set_thinking_level", level: "off" });
  let state = await bridge.ok({ type: "get_state" });
  assert.equal(state.thinkingLevel, "off");

  assert.deepEqual(
    state.modelConfigs.map((cfg) => [cfg.id, cfg.currentValue, cfg.options?.map((o) => o.value)]),
    [["speed", "standard", ["standard", "fast"]]],
  );
  await bridge.ok({ type: "set_model_config", configId: "speed", value: "fast" });
  state = await bridge.ok({ type: "get_state" });
  assert.equal(state.modelConfigs[0]?.currentValue, "fast");

  await bridge.ok({ type: "set_model", provider: "devin", modelId: "adaptive" });
  state = await bridge.ok({ type: "get_state" });
  assert.equal(state.model.reasoning, false);
  assert.deepEqual(state.modelConfigs, [], "speed disappears with the models that do not advertise it");
  assert.deepEqual((await bridge.ok({ type: "get_available_thinking_levels" })).levels, ["off"]);
});

test("set_model negotiates before the first catalog read, resolves Devin's max alias, and rejects unknown models", async (t) => {
  const bridge = startBridge(t, { FAKE_DEVIN_DEFAULT_MODEL: "adaptive" });
  const chosen = await bridge.ok({ type: "set_model", provider: "devin", modelId: "swe-2-1-max" });
  assert.equal(chosen.id, "swe-2-1-medium");
  let state = await bridge.ok({ type: "get_state" });
  assert.equal(state.model.id, "swe-2-1-medium");
  assert.equal(state.thinkingLevel, "max");
  assert.ok(!state.model.id.includes("lightning"));
  await bridge.ok({ type: "set_thinking_level", level: "high" });
  assert.equal((await bridge.ok({ type: "get_state" })).thinkingLevel, "high");
  const failure = await bridge.send({ type: "set_model", provider: "devin", modelId: "not-a-model" });
  assert.equal(failure.success, false);
  assert.match(failure.error, /Model not found/);
  state = await bridge.ok({ type: "get_state" });
  assert.equal(state.model.id, "swe-2-1-medium");
});
