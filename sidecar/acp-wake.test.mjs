// Antigravity's deferred finalization and post-settle wakes, through the bridge
// on the scripted agent (`dev/fake-acp.mjs` with `FAKE_ACP_AGY=1`):
// - A non-daemon background command, scheduled wake, detached subagent, or
//   unread high-priority inbox wake holds the turn OPEN across `end_turn`
//   (`isStreaming: true`) while keeping the pre-wake reply visible, waiting
//   indefinitely for running tools and up to the open-reply quiet limit until
//   `usage_update` closes the wake reply.
// - A daemon (`IsDaemon: true`) settles immediately and wakes cleanly in its
//   own post-settle turn if it ever exits later.
// - Steering on agy >= 1.5.0 sends `session/prompt` without `session/cancel`
//   so running background commands survive; only explicit `abort` cancels.
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

// Shorten the post-`usage_update` debounce and open-reply quiet limit in tests
// so runs finish in milliseconds while still separating short debounce vs long reply waits.
const FAST_TIMINGS = {
  PIPI_ACP_DEFERRED_FINALIZE_MS: "150",
  PIPI_ACP_OPEN_REPLY_QUIET_MS: "4000",
  PIPI_ACP_SUBAGENT_POLL_MS: "100",
  PIPI_ACP_SWARM_WATCH_POLL_MS: "120",
  PIPI_ACP_WAKE_QUIET_MS: "500",
};

function startBridge(t, fakeEnv = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-acp-wake-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const agyHome = path.join(home, "agy-home");
  fs.mkdirSync(agyHome, { recursive: true });
  const acpLog = fakeEnv.FAKE_ACP_LOG || path.join(home, "fake.jsonl");
  const config = {
    cwd: home,
    agentId: "fake-agy",
    driver: "acp",
    runtimeMode: "full-access",
    customAgent: { id: "fake-agy", name: "Fake agy", command: process.execPath, args: [FAKE_ACP] },
  };
  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: path.join(home, "agent"),
    ANTIGRAVITY_CLI_HOME: agyHome,
    FAKE_ACP_AGY: "1",
    FAKE_ACP_LOG: acpLog,
    ...FAST_TIMINGS,
    ...fakeEnv,
  };
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
  const waitFor = (pred, ms = 8000, label = "condition") =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`waited ${ms}ms for ${label}: ${JSON.stringify(records.map((r) => r.type))}`)), ms);
      const check = () => {
        if (!pred()) return false;
        clearTimeout(timer);
        resolve();
        return true;
      };
      if (!check()) watchers.push(check);
    });
  /** Resolves once `count` settles have been seen in all, or rejects after `ms`. */
  const settles = (count, ms = 8000) =>
    waitFor(() => records.filter((r) => r.type === "agent_settled").length >= count, ms, `settle #${count}`);
  const write = (record) => child.stdin.write(`${JSON.stringify(record)}\n`);
  const methods = () =>
    fs
      .readFileSync(acpLog, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line).method);
  return { records, send, write, waitFor, settles, methods, agyHome, acpLog, prompt: (message) => send({ type: "prompt", message }) };
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
const assistantTexts = (run) =>
  run
    .filter((r) => r.type === "message_end" && r.message.role === "assistant")
    .map((r) => r.message.content.filter((b) => b.type === "text").map((b) => b.text).join(""));

test("a non-daemon background command keeps the run open across end_turn and outlasts slow model thinking", async (t) => {
  // Model takes 600ms (> 150ms post-usage debounce) after job 1 finishes before emitting its first token.
  const bridge = startBridge(t, { FAKE_ACP_WAKE_MS: "400", FAKE_ACP_THINK_MS: "600" });
  assert.equal((await bridge.prompt("start a background job")).success, true);

  // Pre-wake reply is checkpointed as a visible message while the run stays streaming.
  await bridge.waitFor(
    () => bridge.records.some((r) => r.type === "message_end" && r.message.role === "assistant"),
    5000,
    "pre-wake message_end",
  );
  assert.equal(bridge.records.filter((r) => r.type === "agent_settled").length, 0, "run must NOT settle while background job runs");
  const { data: midState } = await bridge.send({ type: "get_state" });
  assert.equal(midState.isStreaming, true, "isStreaming stays true while waiting on background command");
  const preEnd = bridge.records.find((r) => r.type === "message_end" && r.message.role === "assistant");
  const bgCall = preEnd.message.content.find((b) => b.type === "toolCall" && b.name === "job 1");
  assert.equal(bgCall?.background, true, "open background tool stays marked running while held open");

  // `configOptions` model catalog wins over legacy `models.availableModels` when both are sent.
  const { data: catalog } = await bridge.send({ type: "get_available_models" });
  assert.ok(catalog.models.some((m) => m.id === "deepseek-v4-flash"));
  assert.ok(!catalog.models.some((m) => m.id === "legacy-agy-model"));

  // Once the background job finishes and its reply ends with usage_update, the single run settles.
  await bridge.settles(1, 10_000);
  const allRuns = runs(bridge.records);
  assert.equal(allRuns.length, 1, "pre-wake and post-wake work belong to one continuous run");
  const [run] = allRuns;
  assert.deepEqual(assistantTexts(run), ["Waiting for the job.", "Job 1 finished: all good."]);
  const assistantEnds = run.filter((r) => r.type === "message_end" && r.message.role === "assistant");
  assert.equal(assistantEnds[1]?.message.turnStart, true, "wake reply opens its own visual turn after checkpoint");
  assert.deepEqual(toolEnds(run), [["job 1", "job 1 done", false]]);
  assert.equal(run.find((r) => r.type === "tool_execution_end")?.toolCallId, bgCall.id);

  // Saved history keeps both visible replies and clears the background flag once toolEnd landed.
  const { data } = await bridge.send({ type: "get_messages" });
  const said = data.messages.filter((m) => m.role === "assistant").map((m) => m.content.filter((b) => b.type === "text").map((b) => b.text).join(""));
  assert.deepEqual(said, ["Waiting for the job.", "Job 1 finished: all good."]);
  const firstSavedBg = data.messages.find((m) => m.role === "assistant")?.content.find((b) => b.type === "toolCall" && b.id === bgCall.id);
  assert.equal(firstSavedBg?.background, undefined, "background flag clears once toolEnd lands");
});

test("a daemon (IsDaemon: true) settles on end_turn and wakes in its own turn if it exits later", async (t) => {
  const bridge = startBridge(t, { FAKE_ACP_WAKE_MS: "350", FAKE_ACP_THINK_MS: "500" });
  assert.equal((await bridge.prompt("start a background daemon")).success, true);
  // Daemons do not hold the initial turn open.
  await bridge.settles(1, 5000);
  const [firstRun] = runs(bridge.records);
  assert.equal(textOf(firstRun), "Waiting for the job.");
  const firstEnd = firstRun.find((r) => r.type === "message_end" && r.message.role === "assistant");
  const bgCall = firstEnd.message.content.find((b) => b.type === "toolCall" && b.name === "job 1");
  assert.equal(bgCall?.background, true);

  // When the daemon exits later, a post-settle wake turn opens and waits through the 500ms think gap.
  await bridge.settles(2, 8000);
  const [, wake] = runs(bridge.records);
  assert.equal(promptOf(wake), undefined, "no prompt opens a post-settle daemon wake");
  assert.equal(textOf(wake), "Job 1 finished: all good.");
  assert.deepEqual(toolEnds(wake), [["job 1", "job 1 done", false]]);

  // A subsequent prompt still runs cleanly as its own turn.
  await bridge.prompt("hello");
  await bridge.settles(3, 8000);
  assert.equal(textOf(runs(bridge.records)[2]), "I ran the tool — bash finished.");
});

test("two parallel background jobs stay in one open run and keep both wake replies visible", async (t) => {
  const bridge = startBridge(t, { FAKE_ACP_WAKE_MS: "350" });
  await bridge.prompt("start a background job, twice");
  await bridge.settles(1, 10_000);
  const allRuns = runs(bridge.records);
  assert.equal(allRuns.length, 1);
  const [run] = allRuns;
  assert.deepEqual(assistantTexts(run), [
    "Waiting for the job.",
    "Job 1 finished: all good.",
    "Job 2 finished: all good.",
  ]);
  assert.deepEqual(toolEnds(run), [
    ["job 1", "job 1 done", false],
    ["job 2", "job 2 done", false],
  ]);
});

test("a scheduled wake (Run schedule) holds the run open until it fires", async (t) => {
  const bridge = startBridge(t, { FAKE_ACP_WAKE_MS: "350" });
  await bridge.prompt("start a background schedule");
  await bridge.waitFor(() => bridge.records.some((r) => r.type === "message_end" && r.message.role === "assistant"));
  assert.equal(bridge.records.filter((r) => r.type === "agent_settled").length, 0, "schedule must hold the run open");
  await bridge.settles(1, 8000);
  const [run] = runs(bridge.records);
  assert.deepEqual(assistantTexts(run), ["Waiting for the schedule.", "Schedule fired: DONE."]);
  assert.deepEqual(toolEnds(run), [["Run schedule", "timer fired", false]]);
});

test("a detached invoke_subagent holds the run open until the child reports to the parent inbox", async (t) => {
  const bridge = startBridge(t, { FAKE_ACP_WAKE_MS: "450" });
  await bridge.prompt("start a background subagent");
  await bridge.waitFor(() => bridge.records.some((r) => r.type === "message_end" && r.message.role === "assistant"));
  assert.equal(bridge.records.filter((r) => r.type === "agent_settled").length, 0, "active detached subagent must hold the run open");
  await bridge.settles(1, 8000);
  const [run] = runs(bridge.records);
  assert.deepEqual(assistantTexts(run), ["Subagent launched; waiting.", "Subagent finished."]);
});

test("an unread high-priority wake in the inbox holds the run open even when the tool already completed before end_turn", async (t) => {
  const bridge = startBridge(t, { FAKE_ACP_WAKE_MS: "400" });
  await bridge.prompt("start a background pending-inbox");
  await bridge.waitFor(() => bridge.records.some((r) => r.type === "message_end" && r.message.role === "assistant"));
  assert.equal(bridge.records.filter((r) => r.type === "agent_settled").length, 0, "unread high-priority inbox wake must hold the run open");
  await bridge.settles(1, 8000);
  const [run] = runs(bridge.records);
  assert.deepEqual(assistantTexts(run), ["Waiting for the job.", "Mix finished."]);
});

test("multi-step reactive wake streams as one continuous live run with isStreaming true", async (t) => {
  const bridge = startBridge(t, { FAKE_ACP_WAKE_MS: "350" });
  await bridge.prompt("start a background multistep job");
  await bridge.waitFor(() => bridge.records.some((r) => r.type === "tool_execution_end"));
  const { data: midState } = await bridge.send({ type: "get_state" });
  assert.equal(midState.isStreaming, true, "bridge reports isStreaming=true throughout multi-step wake");

  await bridge.settles(1, 10_000);
  const allRuns = runs(bridge.records);
  assert.equal(allRuns.length, 1, "initial prompt and all 3 wake steps stream inside a single continuous run");
  const [run] = allRuns;
  assert.deepEqual(assistantTexts(run), ["Waiting for the job.", "Multi-step wake complete."]);
  assert.equal(thoughtsOf(run), "Thinking about: start a background multistep jobStep 1 back.Step 2 back.");
  assert.deepEqual(toolEnds(run), [
    ["job 1", "job 1 done", false],
    ["edit", "edited app.ts", false],
    ["bash", "clean", false],
  ]);
});

test("steering a held-open background run preserves the command without session/cancel, while Stop (abort) cancels it", async (t) => {
  const bridge = startBridge(t, { FAKE_ACP_WAKE_MS: "500" });
  await bridge.prompt("start a background job");
  await bridge.waitFor(() => bridge.records.some((r) => r.type === "message_end" && r.message.role === "assistant"));
  assert.equal(bridge.records.filter((r) => r.type === "agent_settled").length, 0);

  // Steering while held open sends the new prompt WITHOUT session/cancel, so the
  // background command keeps running and completes in the same overall run.
  const steered = await bridge.prompt("hello");
  assert.equal(steered.data?.disposition, "queued");
  await bridge.settles(1, 8000);
  assert.equal(bridge.methods().includes("session/cancel"), false, "steering a held-open run must not cancel running commands");
  const allText = runs(bridge.records).map(textOf).join("\n");
  assert.ok(allText.includes("I ran the tool — bash finished."), "steered prompt reply must land");
  assert.ok(allText.includes("Job 1 finished: all good."), "preserved background job wake must still complete");

  // Explicit Stop (abort) on a held-open run DOES send session/cancel and settles immediately as aborted.
  const stopBridge = startBridge(t, { FAKE_ACP_WAKE_MS: "60000" });
  await stopBridge.prompt("start a background job");
  await stopBridge.waitFor(() => stopBridge.records.some((r) => r.type === "message_end" && r.message.role === "assistant"));
  assert.equal(stopBridge.records.filter((r) => r.type === "agent_settled").length, 0);
  await stopBridge.send({ type: "abort" });
  await stopBridge.settles(1, 8000);
  assert.equal(stopBridge.methods().includes("session/cancel"), true, "Stop must send session/cancel to end background commands");
  assert.equal(stopBridge.records.filter((r) => r.type === "agent_settled").at(-1)?.aborted, true);
});

test("steering a live in-flight prompt on agy >= 1.5.0 sends session/prompt without session/cancel", async (t) => {
  const bridge = startBridge(t, { FAKE_ACP_TICK_MS: "50" });
  await bridge.prompt("tick for me");
  await bridge.waitFor(() => bridge.records.some((r) => r.type === "message_update" && r.assistantMessageEvent?.type === "thinking_delta"));

  const steered = await bridge.prompt("hello");
  assert.equal(steered.data?.disposition, "queued");
  await bridge.settles(1, 8000);
  assert.equal(bridge.methods().includes("session/cancel"), false, "live prompt-steering on agy >= 1.5.0 must not send session/cancel");
  assert.ok(textOf(runs(bridge.records)[0]).includes("I ran the tool — bash finished."));
});

test("an agy process exiting while a turn is held open fails the run cleanly instead of hanging", async (t) => {
  const bridge = startBridge(t, { FAKE_ACP_WAKE_MS: "250" });
  await bridge.prompt("start a background crash");
  await bridge.settles(1, 8000);
  const [run] = runs(bridge.records);
  const errEnd = run.find((r) => r.type === "message_end" && r.message.role === "assistant" && r.message.stopReason === "error");
  assert.ok(errEnd, "peer exit during deferred wait must end the turn with an error");
});

test("what still arrives ahead of a prompt's echo is kept out of its answer", async (t) => {
  // agy can still hold a daemon wake's frames and flush them when the next prompt lands.
  const bridge = startBridge(t, { FAKE_ACP_WAKE_MS: "100", FAKE_ACP_HOLD: "1" });
  await bridge.prompt("start a background daemon");
  await bridge.settles(1);
  await new Promise((resolve) => setTimeout(resolve, 300));
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

test("switching back to a saved session strips stale background flags", async (t) => {
  const bridge = startBridge(t, { FAKE_ACP_WAKE_MS: "60000" });
  await bridge.prompt("start a background daemon");
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

test("an interaction_ question reaches the user as a select, and the picked answer goes back", async (t) => {
  const bridge = startBridge(t, {});
  await bridge.prompt("ask me something");
  await bridge.waitFor(() => bridge.records.some((r) => r.type === "extension_ui_request"));
  const req = bridge.records.find((r) => r.type === "extension_ui_request");
  assert.equal(req.method, "select", "an interaction_ id is a question, never an auto-approval");
  assert.deepEqual(req.options, ["Option A", "Option B"]);
  bridge.write({ type: "extension_ui_response", id: req.id, value: "Option B" });
  await bridge.settles(1);
  const [run] = runs(bridge.records);
  assert.equal(textOf(run), "You picked opt_b.", "the picked option's own id is what the agent gets");
});

test("changing sessions on Antigravity never sends session/close to tear down the worker", async (t) => {
  const bridge = startBridge(t, { FAKE_ACP_WAKE_MS: "60000" });
  await bridge.prompt("start a background daemon");
  await bridge.settles(1);

  await bridge.send({ type: "new_session" });
  await bridge.send({ type: "get_available_models" });
  await bridge.prompt("hello");
  await bridge.settles(2);

  const methods = bridge.methods();
  assert.ok(methods.filter((m) => m === "session/new").length >= 2);
  assert.equal(methods.includes("session/close"), false, "agy session worker must not receive session/close");
});

test("new_session mid-turn settles the interrupted turn as aborted and saves the aborted record to disk", async (t) => {
  const bridge = startBridge(t, { FAKE_ACP_TICK_MS: "40" });
  void bridge.prompt("tick for me");
  await bridge.waitFor(() => bridge.records.some((r) => r.type === "message_update" && r.assistantMessageEvent?.type === "thinking_delta"));
  const { data: stateBefore } = await bridge.send({ type: "get_state" });
  assert.ok(stateBefore.sessionFile);

  await bridge.send({ type: "new_session" });

  const abortedEnd = bridge.records.find(
    (r) => r.type === "message_end" && r.message?.role === "assistant" && r.message.stopReason === "aborted",
  );
  assert.ok(abortedEnd, "interrupted turn must emit message_end with stopReason=aborted");
  const settled = bridge.records.find((r) => r.type === "agent_settled");
  assert.equal(settled?.aborted, true, "interrupted turn must emit agent_settled(aborted=true)");

  const savedMsgs = fs
    .readFileSync(stateBefore.sessionFile, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message);
  assert.ok(
    savedMsgs.some((m) => m.role === "assistant" && m.stopReason === "aborted"),
    "outgoing session file must persist the aborted assistant record",
  );
});

test("Run swarm_wait holds the run open across end_turn with no reply text until the swarm wakes", async (t) => {
  const bridge = startBridge(t, { FAKE_ACP_WAKE_MS: "450", PIPI_SESSION_ID: "s_swarm_wait" });
  assert.equal((await bridge.prompt("start a background swarm-wait")).success, true);

  await bridge.waitFor(
    () => bridge.records.some((r) => r.type === "pipi_background_watch" && r.active === true),
    5000,
    "pipi_background_watch active while parked in swarm_wait",
  );
  assert.equal(bridge.records.filter((r) => r.type === "agent_settled").length, 0, "swarm_wait must hold the run open");
  const { data: midState } = await bridge.send({ type: "get_state" });
  assert.equal(midState.isStreaming, true, "isStreaming stays true while waiting on swarm_wait");

  await bridge.settles(1, 8000);
  const allRuns = runs(bridge.records);
  assert.equal(allRuns.length, 1, "swarm_wait and its wake reply belong to one continuous run");
  assert.deepEqual(assistantTexts(allRuns[0]), ["Swarm finished: all tests green."]);
  const lastWatch = bridge.records.filter((r) => r.type === "pipi_background_watch").at(-1);
  assert.equal(lastWatch?.active, false, "background watch clears once the swarm run settles");
});

test("chained swarm_wait wakes keep one continuous run open until a non-wait reply finishes", async (t) => {
  const bridge = startBridge(t, { FAKE_ACP_WAKE_MS: "350" });
  await bridge.prompt("start a background swarm-wait chain");

  await bridge.waitFor(() => bridge.records.some((r) => r.type === "tool_execution_end" && r.toolName === "Run read_board"));
  assert.equal(bridge.records.filter((r) => r.type === "agent_settled").length, 0, "second swarm_wait must keep the run open");

  await bridge.settles(1, 8000);
  const allRuns = runs(bridge.records);
  assert.equal(allRuns.length, 1);
  assert.deepEqual(assistantTexts(allRuns[0]), ["Swarm chain finished: verified."]);
});

test("swarm_wait followed immediately by a reply in the same turn settles without hanging", async (t) => {
  const bridge = startBridge(t, {});
  await bridge.prompt("start a background swarm-immediate");
  await bridge.settles(1, 5000);
  const allRuns = runs(bridge.records);
  assert.equal(allRuns.length, 1);
  assert.deepEqual(assistantTexts(allRuns[0]), ["Board already updated."]);
});

test("swarm_wait settles once every swarm worker on disk is killed", async (t) => {
  const bridge = startBridge(t, { FAKE_ACP_WAKE_MS: "350" });
  await bridge.prompt("start a background swarm-killed");
  await bridge.waitFor(() => bridge.records.some((r) => r.type === "tool_execution_end" && r.toolName === "Run swarm_wait"));
  assert.equal(bridge.records.filter((r) => r.type === "agent_settled").length, 0, "run stays open while worker is alive");
  await bridge.settles(1, 8000);
  assert.equal(runs(bridge.records).length, 1);
});

test("steering during swarm_wait preserves the swarm without session/cancel, while Stop cancels it", async (t) => {
  const bridge = startBridge(t, { FAKE_ACP_WAKE_MS: "60000" });
  await bridge.prompt("start a background swarm-wait never");
  await bridge.waitFor(() => bridge.records.some((r) => r.type === "tool_execution_end" && r.toolName === "Run swarm_wait"));
  assert.equal(bridge.records.filter((r) => r.type === "agent_settled").length, 0);

  const steered = await bridge.prompt("hello");
  assert.equal(steered.data?.disposition, "queued");
  await bridge.settles(1, 8000);
  assert.equal(bridge.methods().includes("session/cancel"), false, "steering during swarm_wait must not send session/cancel");
  assert.ok(runs(bridge.records).map(textOf).join("\n").includes("I ran the tool — bash finished."));

  const stopBridge = startBridge(t, { FAKE_ACP_WAKE_MS: "60000" });
  await stopBridge.prompt("start a background swarm-wait never");
  await stopBridge.waitFor(() => stopBridge.records.some((r) => r.type === "tool_execution_end" && r.toolName === "Run swarm_wait"));
  await stopBridge.send({ type: "abort" });
  await stopBridge.settles(1, 8000);
  assert.equal(stopBridge.methods().includes("session/cancel"), true, "Stop during swarm_wait must send session/cancel");
  assert.equal(stopBridge.records.filter((r) => r.type === "agent_settled").at(-1)?.aborted, true);
});

test("reply-and-park swarm turn settles cleanly while keeping daemon backgroundWatch alive until workers park", async (t) => {
  const bridge = startBridge(t, { FAKE_ACP_WAKE_MS: "450", PIPI_SESSION_ID: "s_swarm_async" });
  await bridge.prompt("start a background swarm-async");
  await bridge.settles(1, 5000);
  assert.deepEqual(assistantTexts(runs(bridge.records)[0]), ["Swarm started."]);

  const watchesAfterSettle = bridge.records.filter((r) => r.type === "pipi_background_watch");
  assert.equal(watchesAfterSettle.at(-1)?.active, true, "daemon backgroundWatch stays active while swarm worker is working");

  await bridge.waitFor(
    () => bridge.records.filter((r) => r.type === "pipi_background_watch").at(-1)?.active === false,
    5000,
    "backgroundWatch releases once active swarm worker parks (ignoring passive monitor)",
  );
});

test("reloading an Antigravity session backfills replies finished while disconnected without duplicating", async (t) => {
  const bridge = startBridge(t, { FAKE_ACP_WAKE_MS: "60000" });
  await bridge.prompt("start a background swarm-async");
  await bridge.settles(1, 5000);
  const { data: state } = await bridge.send({ type: "get_state" });
  assert.ok(state.sessionFile);

  const header = JSON.parse(fs.readFileSync(state.sessionFile, "utf8").split("\n")[0]);
  const nativeId = header.nativeThreadId;
  assert.ok(nativeId);

  // Simulate Antigravity finishing a final swarm summary in transcript_full.jsonl
  // while pipi's bridge was detached/restarted.
  const logsDir = path.join(bridge.agyHome, "brain", nativeId, ".system_generated", "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const t0 = new Date(Date.now() - 5000).toISOString();
  const t1 = new Date(Date.now() + 5000).toISOString();
  fs.writeFileSync(
    path.join(logsDir, "transcript_full.jsonl"),
    [
      JSON.stringify({ step_index: 0, type: "USER_INPUT", status: "DONE", created_at: t0, content: "<USER_REQUEST>\nstart a background swarm-async\n</USER_REQUEST>" }),
      JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", created_at: t0, content: "Swarm started." }),
      JSON.stringify({ step_index: 2, type: "PLANNER_RESPONSE", status: "DONE", created_at: t1, tool_calls: [{ name: "read_board" }] }),
      JSON.stringify({ step_index: 3, type: "PLANNER_RESPONSE", status: "DONE", created_at: t1, thinking: "Wrapping up.", content: "Swarm completed while disconnected: all 53 tests pass." }),
    ].join("\n") + "\n",
  );

  await bridge.send({ type: "new_session" });
  await bridge.send({ type: "switch_session", sessionPath: state.sessionFile });
  const { data: firstLoad } = await bridge.send({ type: "get_messages" });
  const firstTexts = firstLoad.messages
    .filter((m) => m.role === "assistant")
    .map((m) => m.content.filter((b) => b.type === "text").map((b) => b.text).join(""));
  assert.deepEqual(firstTexts, ["Swarm started.", "Swarm completed while disconnected: all 53 tests pass."]);

  // Reloading a second time must be idempotent (no duplicated backfill).
  await bridge.send({ type: "new_session" });
  await bridge.send({ type: "switch_session", sessionPath: state.sessionFile });
  const { data: secondLoad } = await bridge.send({ type: "get_messages" });
  const secondTexts = secondLoad.messages
    .filter((m) => m.role === "assistant")
    .map((m) => m.content.filter((b) => b.type === "text").map((b) => b.text).join(""));
  assert.deepEqual(secondTexts, ["Swarm started.", "Swarm completed while disconnected: all 53 tests pass."]);
});
