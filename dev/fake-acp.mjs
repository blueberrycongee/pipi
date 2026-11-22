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
// Prompts containing "wedge" start a turn (thought + tool call) and then die
// silently the way a wedged Antigravity worker does mid-dispatch: the prompt is
// never resolved, `session/cancel` is received but changes nothing, and the
// process stays alive. With `FAKE_ACP_WEDGE=full` the RPC loop itself stops
// answering too — every later request vanishes (a dead stdin path); otherwise
// `session/list` and friends keep answering while the turn engine is gone.
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
// "engine": the turn died, the RPC loop lives — list/cancel still answer, the
// prompt does not. "full": every later request vanishes.
let wedged = undefined;

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

const LEGACY_MODELS = {
  currentModelId: "legacy-agy-model",
  availableModels: [{ modelId: "legacy-agy-model", name: "Legacy Agy Model" }],
};

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
const sendUpdate = (sessionId, u) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });
const update = (sessionId, u) => {
  record(sessionId, u);
  sendUpdate(sessionId, u);
};

// ── Antigravity's idle wake (`FAKE_ACP_AGY=1`) ──────────────────────────────
// As agy 1.5.13 does over ACP: a prompt is echoed as `user_message_chunk`; a
// prompt containing "background" leaves a call running and answers "Waiting
// for the job." — when the job ends (`FAKE_ACP_WAKE_MS` later) the agent runs
// on by itself and STREAMS that work as ordinary `session/update`s: the
// completed `tool_call_update`, thoughts, and answer chunks all arrive on the
// live connection seconds after the prompt settled. "background twice" leaves
// two jobs, the second ending later.
const AGY = !!process.env.FAKE_ACP_AGY;
const WAKE_MS = Number(process.env.FAKE_ACP_WAKE_MS || 400);
const CONTENT = new Set(["user_message_chunk", "agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update"]);

/** Keeps a content update in the session's history the way agy replays it: a call as one `tool_call`, as it stands. */
function record(sessionId, u) {
  const s = sessions.get(sessionId);
  if (!AGY || !s || !CONTENT.has(u.sessionUpdate)) return;
  s.updatedAt = new Date().toISOString();
  if (u.sessionUpdate === "tool_call_update") {
    const call = s.history.find((h) => h.sessionUpdate === "tool_call" && h.toolCallId === u.toolCallId);
    if (call) Object.assign(call, { ...u, sessionUpdate: "tool_call" });
    return;
  }
  s.history.push({ ...u });
}

/**
 * What the agent does on its own while idle: pushed straight to the wire —
 * unless `FAKE_ACP_HOLD=1` models the frames agy still holds and flushes ahead
 * of the next prompt's echo.
 */
function idle(sessionId, u) {
  const s = sessions.get(sessionId);
  if (!s) return;
  if (process.env.FAKE_ACP_HOLD) {
    record(sessionId, u);
    s.backlog.push(u);
    return;
  }
  update(sessionId, u);
}

function backgroundTurn(sessionId, text) {
  if (/crash/i.test(text)) {
    const job1 = `bg_${seq++}`;
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: job1, title: "job 1", kind: "execute", status: "in_progress", rawInput: { CommandLine: "job 1", WaitMsBeforeAsync: 10000 } });
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Waiting for the job." } });
    update(sessionId, { sessionUpdate: "usage_update", used: 9000, size: 1048576 });
    setTimeout(() => process.exit(1), WAKE_MS);
    return "end_turn";
  }
  if (/schedule/i.test(text)) {
    const sched = `sched_${seq++}`;
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: sched, title: "Run schedule", kind: "other", status: "in_progress", rawInput: { DurationSeconds: 30, Prompt: "Continue." } });
    setTimeout(() => {
      idle(sessionId, { sessionUpdate: "tool_call_update", toolCallId: sched, status: "completed", content: [{ type: "content", content: { type: "text", text: "timer fired" } }] });
      idle(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Schedule fired: DONE." } });
      idle(sessionId, { sessionUpdate: "usage_update", used: 9400, size: 1048576 });
    }, WAKE_MS);
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Waiting for the schedule." } });
    update(sessionId, { sessionUpdate: "usage_update", used: 9000, size: 1048576 });
    return "end_turn";
  }
  if (/subagent/i.test(text)) {
    const callId = `call_sub_${seq++}`;
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: callId, title: "Run invoke_subagent", kind: "other", status: "completed", rawInput: { TypeName: "research", Role: "Researcher", Prompt: "Check files" } });
    const home = process.env.ANTIGRAVITY_CLI_HOME;
    if (home) {
      const childId = `child-${seq++}`;
      const subDir = `${home}/brain/${sessionId}/.system_generated/subagents`;
      const childInbox = `${home}/brain/${childId}/.system_generated/messages`;
      const parentInbox = `${home}/brain/${sessionId}/.system_generated/messages`;
      fs.mkdirSync(subDir, { recursive: true });
      fs.mkdirSync(childInbox, { recursive: true });
      fs.writeFileSync(`${subDir}/${childId}.json`, JSON.stringify({ conversationId: childId, state: "SUBAGENT_STATE_RUNNING" }));
      fs.writeFileSync(`${childInbox}/launch.json`, JSON.stringify({ sender: sessionId, sourceMetadata: { tool: { toolCall: { id: callId, name: "invoke_subagent" } } } }));
      setTimeout(() => {
        fs.mkdirSync(parentInbox, { recursive: true });
        fs.writeFileSync(`${parentInbox}/report.json`, JSON.stringify({ id: "report", sender: childId, priority: "MESSAGE_PRIORITY_HIGH" }));
        fs.writeFileSync(`${parentInbox}/read.json`, JSON.stringify({ report: true }));
        idle(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Subagent finished." } });
        idle(sessionId, { sessionUpdate: "usage_update", used: 9500, size: 1048576 });
      }, WAKE_MS);
    }
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Subagent launched; waiting." } });
    update(sessionId, { sessionUpdate: "usage_update", used: 9000, size: 1048576 });
    return "end_turn";
  }
  if (/swarm-wait/i.test(text)) {
    const postId = `call_post_${seq++}`;
    const waitId = `call_swait_${seq++}`;
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: postId, title: "Run post_message", kind: "other", status: "in_progress", rawInput: { text: "@fixer go" } });
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: waitId, title: "Run swarm_wait", kind: "other", status: "in_progress", rawInput: { since: 5 } });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: postId, status: "completed", content: [{ type: "content", content: { type: "text", text: "" } }] });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: waitId, status: "completed", content: [{ type: "content", content: { type: "text", text: "" } }] });
    update(sessionId, { sessionUpdate: "usage_update", used: 9100, size: 1048576 });
    if (/chain/i.test(text)) {
      setTimeout(() => {
        const readId = `call_read_${seq++}`;
        const wait2 = `call_swait_${seq++}`;
        idle(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Worker 1 done; dispatching verifier." } });
        idle(sessionId, { sessionUpdate: "tool_call", toolCallId: readId, title: "Run read_board", kind: "other", status: "completed", rawInput: { since: 5 } });
        idle(sessionId, { sessionUpdate: "tool_call", toolCallId: wait2, title: "Run swarm_wait", kind: "other", status: "completed", rawInput: { since: 6 } });
        idle(sessionId, { sessionUpdate: "usage_update", used: 9300, size: 1048576 });
      }, WAKE_MS);
      setTimeout(() => {
        idle(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Verifier passed." } });
        idle(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Swarm chain finished: verified." } });
        idle(sessionId, { sessionUpdate: "usage_update", used: 9600, size: 1048576 });
      }, WAKE_MS * 2 + 250);
    } else if (!/never/i.test(text)) {
      setTimeout(() => {
        const readId = `call_read_${seq++}`;
        idle(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Reading board result." } });
        idle(sessionId, { sessionUpdate: "tool_call", toolCallId: readId, title: "Run read_board", kind: "other", status: "completed", rawInput: { since: 5 } });
        idle(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Swarm finished: all tests green." } });
        idle(sessionId, { sessionUpdate: "usage_update", used: 9500, size: 1048576 });
      }, WAKE_MS);
    }
    return "end_turn";
  }
  if (/swarm-immediate/i.test(text)) {
    const waitId = `call_swait_${seq++}`;
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: waitId, title: "Run swarm_wait", kind: "other", status: "completed", rawInput: { since: 5 } });
    update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Board already has a new post." } });
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Board already updated." } });
    update(sessionId, { sessionUpdate: "usage_update", used: 9200, size: 1048576 });
    return "end_turn";
  }
  if (/swarm-killed/i.test(text)) {
    const waitId = `call_swait_${seq++}`;
    const home = process.env.ANTIGRAVITY_CLI_HOME;
    if (home) {
      const workerId = `worker-${seq++}`;
      const subDir = `${home}/brain/${sessionId}/.system_generated/subagents`;
      fs.mkdirSync(subDir, { recursive: true });
      const workerFile = `${subDir}/${workerId}.json`;
      fs.writeFileSync(
        workerFile,
        JSON.stringify({ conversationId: workerId, subagentDescriptor: { typeName: "worker", role: "Swarm Worker (fixer)" }, state: "SUBAGENT_STATE_ALIVE" }),
      );
      setTimeout(() => {
        fs.writeFileSync(
          workerFile,
          JSON.stringify({ conversationId: workerId, subagentDescriptor: { typeName: "worker", role: "Swarm Worker (fixer)" }, state: "SUBAGENT_STATE_KILLED" }),
        );
      }, WAKE_MS);
    }
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: waitId, title: "Run swarm_wait", kind: "other", status: "completed", rawInput: { since: 5 } });
    update(sessionId, { sessionUpdate: "usage_update", used: 9100, size: 1048576 });
    return "end_turn";
  }
  if (/swarm-async/i.test(text)) {
    const addId = `call_swarm_${seq++}`;
    const home = process.env.ANTIGRAVITY_CLI_HOME;
    if (home) {
      const workerId = `worker-${seq++}`;
      const monitorId = `monitor-${seq++}`;
      const subDir = `${home}/brain/${sessionId}/.system_generated/subagents`;
      const workerLogs = `${home}/brain/${workerId}/.system_generated/logs`;
      const monitorLogs = `${home}/brain/${monitorId}/.system_generated/logs`;
      fs.mkdirSync(subDir, { recursive: true });
      fs.mkdirSync(workerLogs, { recursive: true });
      fs.mkdirSync(monitorLogs, { recursive: true });
      const workerFile = `${subDir}/${workerId}.json`;
      fs.writeFileSync(
        workerFile,
        JSON.stringify({ conversationId: workerId, subagentDescriptor: { typeName: "worker", role: "Swarm Worker (fixer)" }, state: "SUBAGENT_STATE_ALIVE" }),
      );
      fs.writeFileSync(
        `${subDir}/${monitorId}.json`,
        JSON.stringify({ conversationId: monitorId, subagentDescriptor: { typeName: "worker", role: "Swarm Worker (monitor)" }, state: "SUBAGENT_STATE_ALIVE" }),
      );
      // Monitor is parked in swarm_wait; fixer is actively mid-turn.
      fs.writeFileSync(`${monitorLogs}/transcript.jsonl`, `${JSON.stringify({ step_index: 1, type: "GENERIC", status: "DONE", content: "Waiting for a message that calls on you by name." })}\n`);
      fs.writeFileSync(`${workerLogs}/transcript.jsonl`, `${JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", tool_calls: [{ name: "run_command" }] })}\n`);
      setTimeout(() => {
        fs.writeFileSync(`${workerLogs}/transcript.jsonl`, `${JSON.stringify({ step_index: 2, type: "GENERIC", status: "DONE", content: "Waiting for a message that calls on you by name." })}\n`);
      }, WAKE_MS);
    }
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: addId, title: "Run swarm", kind: "other", status: "completed", rawInput: { action: "add", name: "fixer", brief: "Fix it" } });
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Swarm started." } });
    update(sessionId, { sessionUpdate: "usage_update", used: 9100, size: 1048576 });
    return "end_turn";
  }
  if (/pending-inbox/i.test(text)) {
    const job1 = `bg_${seq++}`;
    const home = process.env.ANTIGRAVITY_CLI_HOME;
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: job1, title: "job 1", kind: "execute", status: "in_progress", rawInput: { CommandLine: "job 1", WaitMsBeforeAsync: 10000 } });
    // Command finishes BEFORE end_turn, leaving an unread high-priority wake in the inbox.
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: job1, status: "completed", content: [{ type: "content", content: { type: "text", text: "job 1 done" } }] });
    if (home) {
      const inbox = `${home}/brain/${sessionId}/.system_generated/messages`;
      const logs = `${home}/brain/${sessionId}/.system_generated/logs`;
      fs.mkdirSync(inbox, { recursive: true });
      fs.mkdirSync(logs, { recursive: true });
      fs.writeFileSync(`${inbox}/msg-1.json`, JSON.stringify({ id: "msg-1", priority: "MESSAGE_PRIORITY_HIGH", sender: `${sessionId}/task-1` }));
      setTimeout(() => {
        fs.writeFileSync(`${inbox}/read.json`, JSON.stringify({ "msg-1": true }));
        fs.writeFileSync(`${logs}/transcript.jsonl`, `${JSON.stringify({ step_index: 2, type: "PLANNER_RESPONSE", status: "DONE", content: "Mix finished." })}\n`);
        idle(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Mix finished." } });
        idle(sessionId, { sessionUpdate: "usage_update", used: 9600, size: 1048576 });
      }, WAKE_MS);
    }
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Waiting for the job." } });
    update(sessionId, { sessionUpdate: "usage_update", used: 9000, size: 1048576 });
    return "end_turn";
  }
  if (/multistep/i.test(text)) {
    const job1 = `bg_${seq++}`;
    const step2 = `bg_${seq++}`;
    const step3 = `bg_${seq++}`;
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: job1, title: "job 1", kind: "execute", status: "in_progress", rawInput: { command: "job 1" } });
    setTimeout(() => {
      idle(sessionId, { sessionUpdate: "tool_call_update", toolCallId: job1, status: "completed", content: [{ type: "content", content: { type: "text", text: "job 1 done" } }] });
      idle(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Step 1 back." } });
      idle(sessionId, { sessionUpdate: "tool_call", toolCallId: step2, title: "edit", kind: "edit", status: "in_progress", rawInput: { path: "app.ts" } });
    }, WAKE_MS);
    setTimeout(() => {
      idle(sessionId, { sessionUpdate: "tool_call_update", toolCallId: step2, status: "completed", content: [{ type: "content", content: { type: "text", text: "edited app.ts" } }] });
      idle(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Step 2 back." } });
      idle(sessionId, { sessionUpdate: "tool_call", toolCallId: step3, title: "bash", kind: "execute", status: "in_progress", rawInput: { command: "git status" } });
    }, WAKE_MS * 2);
    setTimeout(() => {
      idle(sessionId, { sessionUpdate: "tool_call_update", toolCallId: step3, status: "completed", content: [{ type: "content", content: { type: "text", text: "clean" } }] });
      idle(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Multi-step wake complete." } });
      idle(sessionId, { sessionUpdate: "usage_update", used: 9800, size: 1048576 });
    }, WAKE_MS * 3);
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Waiting for " } });
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "the job." } });
    update(sessionId, { sessionUpdate: "usage_update", used: 9000, size: 1048576 });
    return "end_turn";
  }
  const isDaemon = /daemon/i.test(text);
  const jobs = /twice/i.test(text) ? 2 : 1;
  const thinkDelay = Number(process.env.FAKE_ACP_THINK_MS || 0);
  for (let job = 1; job <= jobs; job++) {
    const toolCallId = `bg_${seq++}`;
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId,
      title: `job ${job}`,
      kind: "execute",
      status: "in_progress",
      rawInput: isDaemon ? { CommandLine: `serve ${job}`, IsDaemon: true } : { command: `job ${job}` },
    });
    setTimeout(() => {
      idle(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "completed", content: [{ type: "content", content: { type: "text", text: `job ${job} done` } }] });
      const emitReply = () => {
        idle(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: `Job ${job} is back.` } });
        idle(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Job ${job} finished: ` } });
        idle(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "all good." } });
        if (/trail/i.test(text) && job === 1) {
          idle(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Trailing idle thought." } });
        }
        idle(sessionId, { sessionUpdate: "usage_update", used: 9200 + job * 100, size: 1048576 });
      };
      if (thinkDelay > 0) setTimeout(emitReply, thinkDelay);
      else emitReply();
    }, WAKE_MS * job);
  }
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Waiting for " } });
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "the job." } });
  update(sessionId, { sessionUpdate: "usage_update", used: 9000, size: 1048576 });
  return "end_turn";
}

function requestPermission(sessionId, toolCallId, options) {
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
        options: options || [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      },
    });
  });
}

async function runTurn(sessionId, text) {
  update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: `Thinking about: ${text.slice(0, 40)}` } });
  if (/wedge/i.test(text)) {
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: `tc_${seq++}`, title: "bash", kind: "other", status: "in_progress", rawInput: { command: "nsh test ." } });
    wedged = process.env.FAKE_ACP_WEDGE === "full" ? "full" : "engine";
    return new Promise(() => {}); // mid-turn silent death: never resolved, never cancelled
  }
  if (/cancel/i.test(text)) return "wait-for-cancel";
  if (/tick/i.test(text)) {
    // Slow steady work: a heartbeat of thoughts until cancelled — the watchdog's
    // proof that a turn producing output is never mistaken for a wedge.
    let ticks = 0;
    const timer = setInterval(() => {
      update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: `tick ${++ticks}. ` } });
      if (inflightPrompt === undefined) clearInterval(timer);
    }, Number(process.env.FAKE_ACP_TICK_MS || 100));
    timer.unref?.();
    return "wait-for-cancel";
  }
  if (/retry-ok/i.test(text)) {
    const first = `tc_${seq++}`;
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: first, title: "read", kind: "read", status: "in_progress", rawInput: { path: "DocLook.test.tsx" } });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: first, status: "completed", content: [{ type: "content", content: { type: "text", text: "ok" } }] });
    update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: '⚠ API error (attempt 1): request failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse": EOF\n',
      },
    });
    const second = `tc_${seq++}`;
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: second, title: "bash", kind: "execute", status: "in_progress", rawInput: { command: "nsh test DocLook.test.tsx --target macos" } });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: second, status: "completed", content: [{ type: "content", content: { type: "text", text: "pass" } }] });
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Recovered after retry." } });
    return "end_turn";
  }
  if (/retry-fail/i.test(text)) {
    update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: '⚠ API error (attempt 1): request failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse": EOF' },
    });
    update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: '⚠ API error (attempt 2): request failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse": EOF' },
    });
    return "end_turn";
  }
  if (/retry-abort/i.test(text)) {
    update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: '⚠ API error (attempt 1): request failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse": EOF' },
    });
    return "wait-for-cancel";
  }
  if (/retry-quote/i.test(text)) {
    update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: 'The log showed ⚠ API error (attempt 1): EOF during the outage.' },
    });
    return "end_turn";
  }
  if (AGY && /background/i.test(text)) return backgroundTurn(sessionId, text);
  if (AGY && /ask me/i.test(text)) {
    // agy's fixed-choice questions arrive as a permission request whose
    // toolCallId starts `interaction_` — options are answers, not approvals.
    const perm = await requestPermission(sessionId, `interaction_${seq++}`, [
      { optionId: "opt_a", name: "Option A", kind: "other" },
      { optionId: "opt_b", name: "Option B", kind: "other" },
    ]);
    const picked = perm?.outcome?.outcome === "selected" ? perm.outcome.optionId : "nothing (cancelled)";
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `You picked ${picked}.` } });
    return "end_turn";
  }
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
  if (wedged === "full") return; // dead stdin path: nothing is ever answered
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
      // A wedged engine takes the cancel and still never resolves the prompt.
      if (inflightPrompt && !wedged) {
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
        protocolVersion: Math.min(Number(msg.params?.protocolVersion) || 1, AGY ? 2 : 1),
        agentCapabilities: { loadSession: AGY, sessionCapabilities: { resume: {}, list: {}, close: {}, ...(AGY ? { load: {} } : {}) } },
        agentInfo: AGY ? { name: "Antigravity ACP Server", title: "Fake agy", version: process.env.FAKE_ACP_VERSION || "1.5.14" } : { name: "fake-dsh", title: "Fake DSH", version: "0.0.0" },
      });
      return;
    case "session/new": {
      const sessionId = `fake-sess-${++seq}`;
      const s = { cwd: p.cwd, model: JSON.stringify(["deepseek-official", "deepseek-v4-flash"]), effort: "medium", history: [], backlog: [], updatedAt: new Date().toISOString() };
      sessions.set(sessionId, s);
      reply(msg.id, { sessionId, configOptions: configOptions(s), ...(AGY ? { models: LEGACY_MODELS } : {}) });
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
      reply(msg.id, { sessionId: p.sessionId, configOptions: configOptions(s), ...(AGY ? { models: LEGACY_MODELS } : {}) });
      return;
    }
    case "session/list": {
      reply(msg.id, {
        sessions: [...sessions.keys()].map((sessionId) => ({ sessionId, cwd: sessions.get(sessionId).cwd, title: "fake", updatedAt: AGY ? sessions.get(sessionId).updatedAt : Date.now() })),
        nextCursor: null,
      });
      return;
    }
    case "session/load": {
      const s = sessions.get(p.sessionId);
      if (!AGY || !s) return replyErr(msg.id, -32602, "unknown session");
      // agy replays the whole conversation on attach.
      for (const u of s.history) sendUpdate(p.sessionId, u);
      reply(msg.id, { sessionId: p.sessionId, configOptions: configOptions(s), models: LEGACY_MODELS });
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
      const text = (p.prompt || []).map((c) => c?.text || "").join("\n");
      if (inflightPrompt) {
        if (AGY) {
          // agy >= 1.5.0 treats a prompt arriving mid-turn as a steer: resolve the
          // earlier prompt `end_turn` and continue under the new one without cancelling.
          reply(inflightPrompt.id, { stopReason: "end_turn" });
          inflightPrompt = undefined;
        } else {
          return replyErr(msg.id, -32602, "prompt already in flight");
        }
      }
      if (AGY) {
        // Frames agy still holds go out ahead of the prompt's echo.
        for (const u of s.backlog.splice(0)) sendUpdate(p.sessionId, u);
        update(p.sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text } });
      }
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
