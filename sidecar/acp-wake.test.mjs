// Antigravity's idle wake, through the bridge on the scripted agent
// (`dev/fake-acp.mjs` with `FAKE_ACP_AGY=1`, which does over ACP what agy 1.5.9
// does): a turn that ends "waiting for" a background job is woken when the job
// ends, and agy runs the rest at once but sends it only ahead of the next
// prompt. The bridge brings it in as a turn of its own — while idle, or before
// the next prompt — once, and never inside the next prompt's answer.
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

function startBridge(t, fakeEnv) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-acp-wake-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const config = {
    cwd: home,
    agentId: "fake-agy",
    driver: "acp",
    runtimeMode: "full-access",
    customAgent: { id: "fake-agy", name: "Fake agy", command: process.execPath, args: [FAKE_ACP] },
  };
  const env = { ...process.env, PI_CODING_AGENT_DIR: path.join(home, "agent"), FAKE_ACP_AGY: "1", FAKE_ACP_LOG: path.join(home, "fake.jsonl"), ...fakeEnv };
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
  const settles = (count, ms = 8000) =>
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
const thoughtsOf = (run) =>
  run
    .filter((r) => r.type === "message_update" && r.assistantMessageEvent?.type === "thinking_delta")
    .map((r) => r.assistantMessageEvent.delta)
    .join("");
const promptOf = (run) => run.find((r) => r.type === "message_start" && r.message.role === "user")?.message.content[0].text;
const toolEnds = (run) => run.filter((r) => r.type === "tool_execution_end").map((r) => [r.toolName, r.result.content[0].text, r.isError]);

test("a turn agy runs while idle comes in on its own, once, as a turn no prompt opened", async (t) => {
  const bridge = startBridge(t, { FAKE_ACP_WAKE_MS: "300" });
  assert.equal((await bridge.prompt("start a background job")).success, true);
  await bridge.settles(1);
  const firstRun = runs(bridge.records)[0];
  assert.equal(textOf(firstRun), "Waiting for the job.");
  const firstEnd = firstRun.find((r) => r.type === "message_end" && r.message.role === "assistant");
  const bgCall = firstEnd.message.content.find((b) => b.type === "toolCall" && b.name === "job 1");
  assert.equal(bgCall?.background, true, "open background tool stays marked running across end_turn");

  // `configOptions` model catalog wins over legacy `models.availableModels` when both are sent.
  const { data: catalog } = await bridge.send({ type: "get_available_models" });
  assert.ok(catalog.models.some((m) => m.id === "deepseek-v4-flash"));
  assert.ok(!catalog.models.some((m) => m.id === "legacy-agy-model"));

  // Nothing is sent: the watch sees the session move and brings the woken turn in.
  await bridge.settles(2);
  const wake = runs(bridge.records)[1];
  assert.equal(promptOf(wake), undefined, "no prompt opens it");
  const wakeStart = wake.find((r) => r.type === "message_start" && r.message.role === "assistant");
  const wakeEnd = wake.find((r) => r.type === "message_end" && r.message.role === "assistant");
  assert.equal(wakeStart?.message.turnStart, true, "wake turn opens its own visual turn");
  assert.equal(wakeEnd?.message.turnStart, true, "saved wake message carries turnStart");
  assert.deepEqual(toolEnds(wake), [["job 1", "job 1 done", false]], "the job the first turn left running ends here");
  assert.equal(wake.find((r) => r.type === "tool_execution_end")?.toolCallId, bgCall.id);
  assert.equal(textOf(wake), "Job 1 finished: all good.");
  assert.ok(wake.some((r) => r.assistantMessageEvent?.type === "thinking_delta" && r.assistantMessageEvent.delta === "Job 1 is back."));

  // The next prompt's answer is its own: agy has nothing left to hand over.
  await bridge.prompt("hello");
  await bridge.settles(3);
  const next = runs(bridge.records)[2];
  assert.equal(promptOf(next), "hello");
  assert.equal(textOf(next), "I ran the tool — bash finished.");

  const { data } = await bridge.send({ type: "get_messages" });
  const said = data.messages.filter((m) => m.role === "assistant").map((m) => m.content.filter((b) => b.type === "text").map((b) => b.text).join(""));
  assert.deepEqual(said, ["Waiting for the job.", "Job 1 finished: all good.", "I ran the tool — bash finished."]);
  assert.equal(data.messages.filter((m) => m.role === "toolResult" && m.toolName === "job 1").length, 1);
  const firstSavedBg = data.messages.find((m) => m.role === "assistant")?.content.find((b) => b.type === "toolCall" && b.id === bgCall.id);
  assert.equal(firstSavedBg?.background, undefined, "background flag clears once toolEnd lands");
});

test("a prompt sent before the watch looks catches the woken turn up first", async (t) => {
  const bridge = startBridge(t, { FAKE_ACP_WAKE_MS: "100" });
  await bridge.prompt("start a background job");
  await bridge.settles(1);
  // The job has ended, the first look is still seconds away.
  await new Promise((resolve) => setTimeout(resolve, 400));
  await bridge.prompt("hello");
  await bridge.settles(3);
  const [, wake, next] = runs(bridge.records);
  assert.equal(promptOf(wake), undefined);
  assert.equal(textOf(wake), "Job 1 finished: all good.");
  assert.equal(promptOf(next), "hello");
  assert.equal(textOf(next), "I ran the tool — bash finished.");
});

test("jobs that end apart wake it apart, and each wake is shown once", async (t) => {
  const bridge = startBridge(t, { FAKE_ACP_WAKE_MS: "1500" });
  await bridge.prompt("start a background job, twice");
  await bridge.settles(1);
  await bridge.settles(3, 12_000);
  const [, first, second] = runs(bridge.records);
  assert.equal(textOf(first), "Job 1 finished: all good.");
  assert.deepEqual(toolEnds(first), [["job 1", "job 1 done", false]]);
  assert.equal(textOf(second), "Job 2 finished: all good.");
  assert.deepEqual(toolEnds(second), [["job 2", "job 2 done", false]]);
});

test("trailing thoughts at the end of a wake turn are not re-emitted on the next wake", async (t) => {
  const bridge = startBridge(t, { FAKE_ACP_WAKE_MS: "1500" });
  await bridge.prompt("start a background job, twice, trail");
  await bridge.settles(1);
  await bridge.settles(3, 12_000);
  const [, first, second] = runs(bridge.records);
  assert.ok(thoughtsOf(first).includes("Trailing idle thought."));
  assert.equal(thoughtsOf(second).includes("Trailing idle thought."), false);
  assert.equal(thoughtsOf(second), "Job 2 is back.");
});

test("what still arrives ahead of a prompt's echo is kept out of its answer", async (t) => {
  // The list never moves, so only the next prompt hands the woken turn over.
  const bridge = startBridge(t, { FAKE_ACP_WAKE_MS: "100", FAKE_ACP_QUIET_LIST: "1" });
  await bridge.prompt("start a background job");
  await bridge.settles(1);
  await new Promise((resolve) => setTimeout(resolve, 400));
  await bridge.prompt("hello");
  await bridge.settles(2);
  const next = runs(bridge.records)[1];
  const assistantEnds = next.filter((r) => r.type === "message_end" && r.message.role === "assistant");
  const ends = assistantEnds.map((r) => r.message.content.filter((b) => b.type === "text").map((b) => b.text).join(""));
  assert.deepEqual(ends, ["Job 1 finished: all good.", "I ran the tool — bash finished."]);
  assert.equal(assistantEnds[0].message.turnStart, undefined);
  assert.equal(assistantEnds[1].message.turnStart, true, "reply after split begins a new visual turn");
  const assistantStarts = next.filter((r) => r.type === "message_start" && r.message.role === "assistant");
  assert.equal(assistantStarts[1]?.message.turnStart, true);
  assert.deepEqual(toolEnds(next)[0], ["job 1", "job 1 done", false], "the job keeps its name");
});

test("multi-step reactive wake streams as one continuous live run with isStreaming true", async (t) => {
  const bridge = startBridge(t, { FAKE_ACP_WAKE_MS: "900" });
  await bridge.prompt("start a background multistep job");
  await bridge.settles(1);

  // Wait until the live wake run begins (`agent_start` #2) and verify `isStreaming` stays true mid-wake.
  const deadline = Date.now() + 5000;
  while (bridge.records.filter((r) => r.type === "agent_start").length < 2) {
    if (Date.now() > deadline) throw new Error("timed out waiting for live wake agent_start");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const { data: midState } = await bridge.send({ type: "get_state" });
  assert.equal(midState.isStreaming, true, "bridge reports isStreaming=true while multi-step wake is working");

  await bridge.settles(2, 12_000);
  const allRuns = runs(bridge.records);
  assert.equal(allRuns.length, 2, "all 3 wake steps stream inside a single continuous wake run");
  const [, wake] = allRuns;
  assert.equal(textOf(wake), "Multi-step wake complete.");
  assert.equal(thoughtsOf(wake), "Step 1 back.Step 2 back.");
  assert.deepEqual(toolEnds(wake), [
    ["job 1", "job 1 done", false],
    ["edit", "edited app.ts", false],
    ["bash", "clean", false],
  ]);
  const turnStarts = wake.filter((r) => r.type === "message_start" && r.message.role === "assistant" && r.message.turnStart);
  assert.equal(turnStarts.length, 1, "only the first assistant message of the wake begins a new visual turn");
});

test("switching back to a saved session strips stale background flags", async (t) => {
  const bridge = startBridge(t, { FAKE_ACP_WAKE_MS: "60000" });
  await bridge.prompt("start a background job");
  await bridge.settles(1);
  const { data: state } = await bridge.send({ type: "get_state" });
  assert.ok(state.sessionFile);
  await bridge.send({ type: "new_session" });
  await bridge.send({ type: "switch_session", sessionPath: state.sessionFile });
  const { data } = await bridge.send({ type: "get_messages" });
  const call = data.messages.find((m) => m.role === "assistant")?.content.find((b) => b.type === "toolCall");
  assert.equal(call?.name, "job 1");
  assert.equal(call?.background, undefined);
});
