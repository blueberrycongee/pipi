import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { connectDaemon } from "./daemon-client.mjs";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_SCRIPT = path.join(__dirname, "pipi-daemon.mjs");
const CLI_SCRIPT = path.join(__dirname, "pipi-cli.mjs");
const MCP_STDIO_SCRIPT = path.join(__dirname, "pipi-mcp-stdio.mjs");
const PI_EXT_SCRIPT = path.join(__dirname, "pipi-orchestrator-extension.mjs");
const BRIDGE_SCRIPT = path.join(__dirname, "external-agent.mjs");
const FAKE_ACP_SCRIPT = path.join(__dirname, "..", "dev", "fake-acp.mjs");

/** Creates an isolated fake agent script speaking Pi's JSONL RPC protocol. */
function writeMockAgent(dir) {
  const scriptPath = path.join(dir, "mock-pi.mjs");
  const sessionDir = path.join(dir, "sessions");
  fs.mkdirSync(sessionDir, { recursive: true });
  const code = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

if (process.argv[2] === "run" && process.argv[3] === "--format") {
  process.stdout.write(
    JSON.stringify({
      type: "text",
      part: {
        text: JSON.stringify({
          hasUrl: Boolean(process.env.PIPI_ORCHESTRATOR_URL),
          hasToken: Boolean(process.env.PIPI_ORCHESTRATOR_TOKEN),
        }),
      },
    }) + "\\n",
  );
  process.exit(0);
}

const SESSION_DIR = ${JSON.stringify(sessionDir)};
if (process.env.PIPI_MOCK_BOOTLOG) {
  try { fs.appendFileSync(process.env.PIPI_MOCK_BOOTLOG, String(process.pid) + "\\n"); } catch {}
}
let seq = 0;
let sessionFile = path.join(SESSION_DIR, \`sess-\${process.pid}-\${Date.now()}.jsonl\`);
let messages = [];
let isStreaming = false;
let runtimeMode = process.env.PIPI_RUNTIME_MODE || "full-access";
let currentAbort = null;
const pendingUi = new Map();
const queued = { steering: [], followUp: [] };

function saveMessages() {
  if (!sessionFile) {
    sessionFile = path.join(SESSION_DIR, \`sess-\${process.pid}-\${Date.now()}-\${++seq}.jsonl\`);
  }
  fs.writeFileSync(
    sessionFile,
    messages.map((m) => JSON.stringify({ type: "message", message: m })).join("\\n") + (messages.length ? "\\n" : ""),
  );
}

function loadMessages(targetPath) {
  sessionFile = targetPath;
  if (!fs.existsSync(targetPath)) {
    messages = [];
    return;
  }
  messages = fs
    .readFileSync(targetPath, "utf8")
    .split("\\n")
    .filter(Boolean)
    .map((line) => {
      const parsed = JSON.parse(line);
      return parsed?.type === "message" ? parsed.message : parsed;
    });
}
saveMessages();

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}

async function callMcp(name, args) {
  const res = await fetch(process.env.PIPI_ORCHESTRATOR_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: \`Bearer \${process.env.PIPI_ORCHESTRATOR_TOKEN}\`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method: "tools/call", params: { name, arguments: args } }),
  });
  return res.json();
}

async function runSingleTurn(promptText) {
  let aborted = false;
  let cancelWait = null;
  currentAbort = () => {
    aborted = true;
    if (cancelWait) cancelWait();
  };

  const userMsg = { role: "user", content: promptText, timestamp: Date.now() };
  messages.push(userMsg);
  saveMessages();

  emit({ type: "agent_start" });
  emit({ type: "turn_start" });
  emit({ type: "message_start", message: userMsg });
  emit({ type: "message_end", message: userMsg });

  let cmdText = promptText;
  if (cmdText.startsWith("<pipi-message") && cmdText.includes("</pipi-message>")) {
    const gt = cmdText.indexOf(">");
    const endTag = cmdText.lastIndexOf("</pipi-message>");
    if (gt >= 0 && endTag > gt) cmdText = cmdText.slice(gt + 1, endTag).trim();
  }

  if (cmdText.startsWith("/pipi-runtime-mode ")) {
    runtimeMode = cmdText.slice("/pipi-runtime-mode ".length).trim();
    const reply = \`mode:\${runtimeMode}\`;
    const asst = { role: "assistant", content: [{ type: "text", text: reply }], stopReason: "stop", timestamp: Date.now() };
    messages.push(asst);
    saveMessages();
    emit({ type: "message_start", message: asst });
    emit({ type: "message_end", message: asst });
    emit({ type: "turn_end" });
    emit({ type: "agent_end", willRetry: false });
    return false;
  }

  if (cmdText.startsWith("fail:")) {
    const reason = cmdText.slice(5);
    const asst = {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: reason,
      timestamp: Date.now(),
    };
    messages.push(asst);
    saveMessages();
    emit({ type: "message_start", message: asst });
    emit({ type: "message_end", message: asst });
    emit({ type: "turn_end" });
    emit({ type: "agent_end", willRetry: false });
    return false;
  }

  if (cmdText.startsWith("block:")) {
    const dialogId = \`dlg_\${++seq}\`;
    emit({
      type: "extension_ui_request",
      id: dialogId,
      method: "confirm",
      title: "Approve tool",
      message: cmdText.slice(6),
    });
    const ans = await new Promise((resolve) => {
      pendingUi.set(dialogId, resolve);
      cancelWait = () => {
        pendingUi.delete(dialogId);
        resolve({ confirmed: false, cancelled: true });
      };
    });
    const text = aborted ? "aborted" : ans?.confirmed ? "approved" : "denied";
    const asst = { role: "assistant", content: [{ type: "text", text }], stopReason: aborted ? "aborted" : "stop", timestamp: Date.now() };
    if (!aborted) {
      messages.push(asst);
      saveMessages();
    }
    emit({ type: "message_start", message: asst });
    emit({ type: "message_end", message: asst });
    emit({ type: "turn_end" });
    emit({ type: "agent_end", willRetry: false });
    return aborted;
  }

  if (cmdText.startsWith("wedge:")) {
    // The run starts and then dies silently: agent_start went out, and nothing
    // ever follows — abort is still answered, but no agent_end/agent_settled
    // comes behind it. What a wedged ACP worker reads as over the bridge.
    await new Promise(() => {});
  }

  if (cmdText.startsWith("die:")) {
    // Crash mid-run on its own: agent_start went out, then the process exits —
    // an exit the daemon never asked for.
    const ms = Number(cmdText.slice(4)) || 300;
    setTimeout(() => process.exit(1), ms);
    await new Promise(() => {});
  }

  if (cmdText.startsWith("slow:")) {
    const [, msStr, ...rest] = cmdText.split(":");
    const ms = Number(msStr) || 500;
    await new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      cancelWait = () => {
        clearTimeout(t);
        resolve();
      };
    });
    if (aborted) {
      emit({ type: "turn_end" });
      emit({ type: "agent_end", willRetry: false });
      return true;
    }
    const reply = rest.join(":") || "done-slow";
    const asst = { role: "assistant", content: [{ type: "text", text: reply }], stopReason: "stop", timestamp: Date.now() };
    messages.push(asst);
    saveMessages();
    emit({ type: "message_start", message: asst });
    emit({ type: "message_end", message: asst });
    emit({ type: "turn_end" });
    emit({ type: "agent_end", willRetry: false });
    return false;
  }

  let reply = \`echo:\${promptText}\`;
  if (promptText === "inspect-env") {
    reply = JSON.stringify({
      pid: process.pid,
      sessionId: process.env.PIPI_SESSION_ID,
      hasUrl: Boolean(process.env.PIPI_ORCHESTRATOR_URL),
      hasToken: Boolean(process.env.PIPI_ORCHESTRATOR_TOKEN),
      runtimeMode,
    });
  } else if (promptText.startsWith("spawn-child-mode:")) {
    const [, title, mode, ...rest] = promptText.split(":");
    const mcpRes = await callMcp("session_start", { agent: "pi", title, runtimeMode: mode, message: rest.join(":"), worktree: false });
    reply = JSON.stringify({ isError: Boolean(mcpRes?.result?.isError), text: mcpRes?.result?.content?.[0]?.text || "" });
  } else if (promptText.startsWith("spawn-child:")) {
    const [, title, ...rest] = promptText.split(":");
    const mcpRes = await callMcp("session_start", { agent: "pi", title, message: rest.join(":"), worktree: false });
    reply = mcpRes?.result?.content?.[0]?.text || JSON.stringify(mcpRes);
  } else if (promptText.includes("<pipi-message ") && messages.some((m) => m.role === "user" && String(m.content).includes("pingpong-mode"))) {
    const fromMatch = /from="([^"]+)"/.exec(promptText);
    if (fromMatch && !promptText.includes('status="blocked"')) {
      await callMcp("session_send", { session: fromMatch[1], message: "pong-back" });
    }
    reply = \`got-delivery:\${promptText.slice(0, 80)}\`;
  } else if (promptText.includes("pingpong-start:")) {
    const target = promptText.split("pingpong-start:")[1].trim();
    await callMcp("session_send", { session: target, message: "pingpong-mode first" });
    reply = "started-pingpong";
  } else if (promptText === "present-relative") {
    const mcpRes = await callMcp("present_files", {
      title: "Session outputs",
      files: [{ path: "preview.png", caption: "2x2 square" }, { path: "missing.mp4" }],
    });
    reply = JSON.stringify(mcpRes?.result?.structuredContent ?? mcpRes?.result ?? {});
  } else if (promptText.startsWith("watch:")) {
    const clearMs = Number(promptText.slice(6)) || 0;
    emit({ type: "pipi_background_watch", active: true });
    if (clearMs > 0) {
      setTimeout(() => emit({ type: "pipi_background_watch", active: false }), clearMs).unref?.();
    }
    reply = \`watch:\${clearMs}\`;
  }

  const asst = { role: "assistant", content: [{ type: "text", text: reply }], stopReason: "stop", timestamp: Date.now() };
  messages.push(asst);
  saveMessages();
  emit({ type: "message_start", message: asst });
  emit({ type: "message_end", message: asst });
  emit({ type: "turn_end" });
  emit({ type: "agent_end", willRetry: false });
  return false;
}

async function runTurn(initialPrompt) {
  isStreaming = true;
  let lastAborted = false;
  let next = initialPrompt;
  while (next !== undefined) {
    lastAborted = await runSingleTurn(next);
    if (lastAborted) {
      if (queued.steering.length || queued.followUp.length) {
        queued.steering.length = 0;
        queued.followUp.length = 0;
        emit({ type: "queue_update", steering: [], followUp: [] });
      }
      break;
    }
    next = queued.steering.shift() ?? queued.followUp.shift();
    if (next !== undefined) {
      emit({ type: "queue_update", steering: [...queued.steering], followUp: [...queued.followUp] });
    }
  }
  isStreaming = false;
  currentAbort = null;
  emit({ type: "agent_settled", aborted: Boolean(lastAborted) });
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let at = buf.indexOf("\\n");
  while (at !== -1) {
    const line = buf.slice(0, at).replace(/\\r$/, "");
    buf = buf.slice(at + 1);
    at = buf.indexOf("\\n");
    if (!line) continue;
    let cmd;
    try {
      cmd = JSON.parse(line);
    } catch {
      continue;
    }
    if (cmd.type === "extension_ui_response") {
      const fn = pendingUi.get(cmd.id);
      if (fn) {
        pendingUi.delete(cmd.id);
        fn(cmd);
      }
      continue;
    }
    if (cmd.type === "get_state") {
      emit({
        id: cmd.id,
        type: "response",
        command: "get_state",
        success: true,
        data: {
          sessionId: sessionFile ? path.basename(sessionFile, ".jsonl") : "unsaved",
          sessionFile,
          isStreaming,
          isCompacting: false,
          messageCount: messages.length,
          pendingMessageCount: queued.steering.length + queued.followUp.length,
          thinkingLevel: "medium",
          steeringMode: "one-at-a-time",
          followUpMode: "one-at-a-time",
          autoCompactionEnabled: true,
          model: { id: "mock-1", name: "Mock 1", api: "mock", provider: "mock", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
        },
      });
      continue;
    }
    if (cmd.type === "get_messages") {
      emit({ id: cmd.id, type: "response", command: "get_messages", success: true, data: { messages } });
      continue;
    }
    if (cmd.type === "new_session") {
      messages = [];
      queued.steering.length = 0;
      queued.followUp.length = 0;
      sessionFile = undefined;
      emit({ id: cmd.id, type: "response", command: "new_session", success: true, data: { cancelled: false } });
      continue;
    }
    if (cmd.type === "switch_session") {
      queued.steering.length = 0;
      queued.followUp.length = 0;
      loadMessages(cmd.sessionPath);
      emit({ id: cmd.id, type: "response", command: "switch_session", success: true, data: { cancelled: false } });
      continue;
    }
    if (cmd.type === "clear_queue") {
      const cleared = { steering: [...queued.steering], followUp: [...queued.followUp] };
      queued.steering.length = 0;
      queued.followUp.length = 0;
      emit({ type: "queue_update", steering: [], followUp: [] });
      emit({ id: cmd.id, type: "response", command: "clear_queue", success: true, data: cleared });
      continue;
    }
    if (cmd.type === "set_runtime_mode") {
      runtimeMode = cmd.mode;
      emit({ id: cmd.id, type: "response", command: "set_runtime_mode", success: true, data: { mode: runtimeMode } });
      continue;
    }
    if (cmd.type === "abort") {
      if (queued.steering.length || queued.followUp.length) {
        queued.steering.length = 0;
        queued.followUp.length = 0;
        emit({ type: "queue_update", steering: [], followUp: [] });
      }
      if (currentAbort) currentAbort();
      emit({ id: cmd.id, type: "response", command: "abort", success: true, data: {} });
      continue;
    }
    if (cmd.type === "prompt" || cmd.type === "steer" || cmd.type === "follow_up") {
      const msg = String(cmd.message ?? "");
      if (isStreaming) {
        const isSteer = cmd.type === "steer" || cmd.streamingBehavior === "steer";
        (isSteer ? queued.steering : queued.followUp).push(msg);
        emit({ type: "queue_update", steering: [...queued.steering], followUp: [...queued.followUp] });
        emit({ id: cmd.id, type: "response", command: cmd.type, success: true, data: { disposition: "queued" } });
      } else {
        emit({ id: cmd.id, type: "response", command: cmd.type, success: true, data: { disposition: "started" } });
        void runTurn(msg);
      }
      continue;
    }
    emit({ id: cmd.id, type: "response", command: cmd.type, success: true, data: {} });
  }
});
`;
  fs.writeFileSync(scriptPath, code, { mode: 0o755 });
  return scriptPath;
}

/** Opens a request/event helper around `connectDaemon`. */
async function openControl(homeDir, envOverrides) {
  const savedEnv = {};
  if (envOverrides) {
    for (const [k, v] of Object.entries(envOverrides)) {
      savedEnv[k] = process.env[k];
      process.env[k] = v;
    }
  }
  let client;
  try {
    client = await connectDaemon({ home: homeDir });
  } finally {
    if (envOverrides) {
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }
  let reqSeq = 0;
  const pending = new Map();
  const events = [];
  const sessions = new Map();
  let helloReady;
  const helloPromise = new Promise((resolve) => (helloReady = resolve));
  let greeted = false;

  client.onLine((msg) => {
    events.push(msg);
    if (msg.type === "hello" && !greeted) {
      greeted = true;
      if (Array.isArray(msg.sessions)) {
        for (const s of msg.sessions) sessions.set(s.id, s);
      }
      helloReady(msg);
      return;
    }
    if (msg.type === "session" && msg.session && !msg.id) {
      sessions.set(msg.session.id, msg.session);
      return;
    }
    if (msg.type === "session_removed" && msg.sessionId) {
      sessions.delete(msg.sessionId);
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.type === "error") reject(new Error(msg.error || "daemon error"));
      else resolve(msg);
    }
  });
  await helloPromise;

  const call = (type, args = {}) => {
    const id = `t_${++reqSeq}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      client.send({ id, type, ...args });
    });
  };

  const readMessages = async (sessionId) => {
    const res = await call("tool", { name: "session_read", args: { session: sessionId, verbose: true } });
    return res.result;
  };

  const waitUntil = async (pred, timeoutMs = 8000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const val = await pred();
      if (val) return val;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("Timed out waiting for condition");
  };

  return { client, call, readMessages, events, sessions, waitUntil };
}

async function configureMockAgents(ctrl, mockBin, extra = {}) {
  await ctrl.call("config", {
    agents: [
      {
        id: "pi",
        name: "Pi",
        driver: "pi",
        available: true,
        enabled: true,
        binaryPath: mockBin,
        models: [{ id: "mock-1", name: "Mock 1", provider: "mock" }],
        supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
        supportsWorktree: true,
      },
      {
        id: "opencode",
        name: "OpenCode",
        driver: "opencode",
        available: true,
        enabled: true,
        binaryPath: mockBin,
        models: [],
        supportedRuntimeModes: ["full-access"],
        supportsWorktree: true,
      },
    ],
    overrides: {
      pi: { binaryPath: mockBin },
      opencode: { binaryPath: mockBin },
    },
    allowAgentTools: true,
    sendScope: "all",
    maxDepth: 2,
    maxRunning: 8,
    worktreeDefault: false,
    linger: true,
    ...extra,
  });
}

test("1, 2 & 9: daemon owns sessions across detach/reattach, replays blocked dialogs, enforces strict MCP auth + 6 tools, and excludes non-MCP drivers", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-daemon-test-1-"));
  const homeDir = path.join(tmp, "home");
  const workDir = path.join(tmp, "work");
  fs.mkdirSync(workDir, { recursive: true });
  const mockBin = writeMockAgent(tmp);

  const ctrl1 = await openControl(homeDir, { HOME: tmp });
  t.after(async () => {
    ctrl1.client.close();
    try {
      const inst = JSON.parse(fs.readFileSync(path.join(homeDir, "daemon.json"), "utf8"));
      process.kill(inst.pid, "SIGTERM");
    } catch {}
  });

  await configureMockAgents(ctrl1, mockBin);

  // Attach session -> inspect pid -> detach -> reattach -> same pid!
  const attached1 = await ctrl1.call("attach", {
    session: {
      cwd: workDir,
      agentId: "pi",
      agentName: "Pi",
      driver: "pi",
      runtimeMode: "full-access",
    },
  });
  const sid = attached1.session.id;

  ctrl1.client.send({ type: "in", sessionId: sid, line: JSON.stringify({ id: "c1", type: "prompt", message: "inspect-env" }) });
  await ctrl1.waitUntil(() => ctrl1.sessions.get(sid)?.status === "idle" && ctrl1.events.some((e) => e.type === "out" && e.line?.includes("agent_settled")));
  const read1 = await ctrl1.readMessages(sid, 5);
  const env1 = JSON.parse(read1.messages.at(-1).text);
  assert.equal(env1.hasUrl, true);
  assert.equal(env1.hasToken, true);

  // Detach does NOT kill process; re-attach reuses exact same PID
  await ctrl1.call("detach", { sessionId: sid });
  assert.equal(ctrl1.sessions.get(sid)?.loaded, true);

  const attached2 = await ctrl1.call("attach", { session: { id: sid, cwd: workDir, agentId: "pi", driver: "pi" } });
  assert.equal(attached2.session.id, sid);
  ctrl1.events.length = 0;
  ctrl1.client.send({ type: "in", sessionId: sid, line: JSON.stringify({ id: "c2", type: "prompt", message: "inspect-env" }) });
  await ctrl1.waitUntil(() => ctrl1.events.some((e) => e.type === "out" && e.line?.includes("agent_settled")));
  const read2 = await ctrl1.readMessages(sid, 5);
  const env2 = JSON.parse(read2.messages.at(-1).text);
  assert.equal(env2.pid, env1.pid, "reattach must reuse warm agent process");

  // Start a blocking confirmation while detached, then re-attach on a second client: dialog replays!
  await ctrl1.call("detach", { sessionId: sid });
  await ctrl1.call("send", { sessionId: sid, message: "block:rm -rf dist" });
  await ctrl1.waitUntil(() => ctrl1.sessions.get(sid)?.status === "blocked");

  const ctrl2 = await openControl(homeDir, { HOME: tmp });
  t.after(() => ctrl2.client.close());
  await ctrl2.call("attach", { session: { id: sid, cwd: workDir, agentId: "pi", driver: "pi" } });
  const replayed = await ctrl2.waitUntil(() =>
    ctrl2.events.find((e) => e.type === "out" && e.sessionId === sid && e.line.includes('"extension_ui_request"')),
  );
  const dialog = JSON.parse(replayed.line.trim());
  ctrl2.client.send({
    type: "in",
    sessionId: sid,
    line: JSON.stringify({ type: "extension_ui_response", id: dialog.id, confirmed: true }),
  });
  await ctrl2.waitUntil(() => ctrl2.sessions.get(sid)?.status === "idle");
  await ctrl2.call("detach", { sessionId: sid });

  // Strict MCP token checks: missing bearer -> 401, invalid bearer -> 401 (never degrades to user)
  const extMcp = await ctrl1.call("external_token");
  const noAuth = await fetch(extMcp.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(noAuth.status, 401);

  const badAuth = await fetch(extMcp.url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer bogus_token" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  });
  assert.equal(badAuth.status, 401);

  // Valid token: notifications return 202 empty body, tools/list returns all 8 tools with standard inputSchema
  const notifRes = await fetch(extMcp.url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${extMcp.token}` },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  assert.equal(notifRes.status, 202);

  const toolsRes = await fetch(extMcp.url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${extMcp.token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
  });
  assert.equal(toolsRes.status, 200);
  const toolsJson = await toolsRes.json();
  const names = toolsJson.result.tools.map((tool) => tool.name);
  assert.deepEqual(names, ["agents_list", "workspaces_list", "sessions_list", "session_read", "session_send", "session_start", "session_stop", "present_files"]);
  for (const tool of toolsJson.result.tools) {
    assert.ok(tool.inputSchema && tool.inputSchema.type === "object", `${tool.name} must expose standard MCP inputSchema`);
  }

  // present_files resolves paths (both absolute on external token and relative against session caller cwd), reads PNG size/dimensions, and reports missing files cleanly
  const pngPath = path.join(workDir, "preview.png");
  const pngBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mP8z8BQz0AEwDiqAAAWBAQCAQIDAgAAAABJRU5ErkJggg==", "base64");
  fs.writeFileSync(pngPath, pngBytes);
  const presentRes = await fetch(extMcp.url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${extMcp.token}` },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "present_files",
        arguments: {
          title: "Rendered outputs",
          files: [{ path: pngPath, caption: "2x2 square" }, { path: path.join(workDir, "missing.mp4") }],
        },
      },
    }),
  });
  assert.equal(presentRes.status, 200);
  const presentJson = await presentRes.json();
  const presented = presentJson.result.structuredContent;
  assert.equal(presented.pipiMedia, true);
  assert.equal(presented.title, "Rendered outputs");
  assert.equal(presented.missingCount, 1);
  assert.equal(presented.items[0].kind, "image");
  assert.equal(presented.items[0].width, 2);
  assert.equal(presented.items[0].height, 2);
  assert.equal(presented.items[0].size, pngBytes.length);
  assert.equal(presented.items[0].exists, true);
  assert.equal(presented.items[1].kind, "video");
  assert.equal(presented.items[1].exists, false);

  await ctrl1.call("attach", { session: { id: sid, cwd: workDir, agentId: "pi", driver: "pi" } });
  ctrl1.events.length = 0;
  await ctrl1.call("send", { sessionId: sid, message: "present-relative" });
  await ctrl1.waitUntil(() => ctrl1.sessions.get(sid)?.status === "idle" && ctrl1.events.some((e) => e.type === "out" && e.line?.includes("agent_settled")));
  const relRead = await ctrl1.readMessages(sid, 2);
  const relPresented = JSON.parse(relRead.messages.at(-1).text);
  assert.equal(relPresented.pipiMedia, true);
  assert.equal(relPresented.missingCount, 1);
  assert.equal(relPresented.items[0].path, pngPath);
  assert.equal(relPresented.items[0].exists, true);
  assert.equal(relPresented.items[1].exists, false);
  await ctrl1.call("detach", { sessionId: sid });

  // Test stdio MCP proxy (`pipi-mcp-stdio.mjs`) & Pi extension (`pipi-orchestrator-extension.mjs`)
  const proxy = spawn(process.execPath, [MCP_STDIO_SCRIPT], {
    env: { ...process.env, PIPI_ORCHESTRATOR_URL: extMcp.url, PIPI_ORCHESTRATOR_TOKEN: extMcp.token },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => proxy.kill());
  const proxyLine = await new Promise((resolve) => {
    let b = "";
    proxy.stdout.setEncoding("utf8");
    proxy.stdout.on("data", (c) => {
      b += c;
      if (b.includes("\n")) resolve(JSON.parse(b.split("\n")[0]));
    });
    proxy.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "agents_list", arguments: {} } })}\n`);
  });
  proxy.stdin.end();
  const agentsPayload = JSON.parse(proxyLine.result.content[0].text);
  assert.ok(Array.isArray(agentsPayload.agents) && agentsPayload.agents.some((a) => a.id === "pi"));

  // Pi extension mirrors all 8 tools and wires `/pipi-runtime-mode`
  const registeredTools = [];
  const registeredCommands = new Map();
  process.env.PIPI_ORCHESTRATOR_URL = extMcp.url;
  process.env.PIPI_ORCHESTRATOR_TOKEN = extMcp.token;
  try {
    const extMod = await import(`${PI_EXT_SCRIPT}?t=${Date.now()}`);
    extMod.default({
      on() {},
      registerCommand(name, spec) {
        registeredCommands.set(name, spec);
      },
      registerTool(spec) {
        registeredTools.push(spec);
      },
    });
    await new Promise((r) => setTimeout(r, 150));
  } finally {
    delete process.env.PIPI_ORCHESTRATOR_URL;
    delete process.env.PIPI_ORCHESTRATOR_TOKEN;
  }
  assert.equal(registeredTools.length, 8);
  assert.ok(registeredCommands.has("pipi-runtime-mode"));

  // Focus 9: engines without MCP bridge (`opencode`) must NOT receive orchestrator credentials
  const ocRes = await ctrl1.call("start_session", {
    input: {
      title: "OpenCode Run",
      agentId: "opencode",
      cwd: workDir,
      message: "check-env",
    },
  });
  const ocId = ocRes.session.id;
  const ocWait = await ctrl1.call("wait", { sessionId: ocId });
  assert.equal(ocWait.status, "idle");
  const ocEnv = JSON.parse(ocWait.answer);
  assert.equal(ocEnv.hasUrl, false, "opencode must not receive PIPI_ORCHESTRATOR_URL");
  assert.equal(ocEnv.hasToken, false, "opencode must not receive PIPI_ORCHESTRATOR_TOKEN");
});

test("3, 4 & 5: <pipi-message> auto-delivery, ping-pong limit + user reset, 5 runtimeMode clamp paths, error->failed, and subtree stop", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-daemon-test-2-"));
  const homeDir = path.join(tmp, "home");
  const workDir = path.join(tmp, "work");
  fs.mkdirSync(workDir, { recursive: true });
  const mockBin = writeMockAgent(tmp);

  const ctrl = await openControl(homeDir, { HOME: tmp });
  t.after(async () => {
    ctrl.client.close();
    try {
      const inst = JSON.parse(fs.readFileSync(path.join(homeDir, "daemon.json"), "utf8"));
      process.kill(inst.pid, "SIGTERM");
    } catch {}
  });
  await configureMockAgents(ctrl, mockBin);

  // Create supervised parent session ("approval-required")
  const parentAttach = await ctrl.call("attach", {
    session: {
      cwd: workDir,
      agentId: "pi",
      agentName: "Pi",
      driver: "pi",
      runtimeMode: "approval-required",
    },
  });
  const parentId = parentAttach.session.id;
  assert.equal(parentAttach.session.runtimeMode, "approval-required");

  // Path 1: `start_session` control op escalating above parent MUST be rejected
  await assert.rejects(
    () =>
      ctrl.call("start_session", {
        input: {
          title: "escalate",
          agentId: "pi",
          cwd: workDir,
          parentId,
          runtimeMode: "full-access",
        },
      }),
    /cannot exceed parent mode/,
  );

  // Create valid child session inheriting "approval-required"
  const childRes = await ctrl.call("start_session", {
    input: {
      title: "Child Worker",
      agentId: "pi",
      cwd: workDir,
      parentId,
    },
  });
  const child = childRes.session;
  assert.equal(child.runtimeMode, "approval-required");

  // Path 2: `session_start` MCP tool from supervised parent trying to escalate MUST return isError: true
  ctrl.events.length = 0;
  ctrl.client.send({
    type: "in",
    sessionId: parentId,
    line: JSON.stringify({ id: "p_esc", type: "prompt", message: "spawn-child-mode:EscalateChild:full-access:nope" }),
  });
  await ctrl.waitUntil(() => ctrl.events.some((e) => e.type === "out" && e.sessionId === parentId && e.line.includes("agent_settled")));
  const escRead = await ctrl.readMessages(parentId, 3);
  const escResult = JSON.parse(escRead.messages.at(-1).text);
  assert.equal(escResult.isError, true, "MCP session_start escalating above caller ceiling must fail");
  assert.match(escResult.text, /cannot exceed parent mode/);

  // Valid MCP `session_start` auto-delivers `<pipi-message>` back to parent
  ctrl.client.send({
    type: "in",
    sessionId: parentId,
    line: JSON.stringify({ id: "p1", type: "prompt", message: "spawn-child:SubChild:echo:hello-from-subchild" }),
  });
  await ctrl.waitUntil(() => {
    const all = [...ctrl.sessions.values()];
    const sub = all.find((s) => s.title === "SubChild");
    return sub && sub.status === "idle" && ctrl.sessions.get(parentId)?.status === "idle";
  });
  await ctrl.waitUntil(async () => {
    const r = await ctrl.readMessages(parentId);
    return r.lastAnswer?.includes("<pipi-message") && r.lastAnswer?.includes("hello-from-subchild");
  });

  // Path 3: `attach` on child requesting `runtimeMode: "full-access"` MUST NOT escalate child above parent!
  const childAttached = await ctrl.call("attach", {
    session: {
      id: child.id,
      cwd: workDir,
      agentId: "pi",
      driver: "pi",
      runtimeMode: "full-access",
    },
  });
  assert.equal(childAttached.session.runtimeMode, "approval-required");

  // Path 4 & 5: raw `set_runtime_mode` and `/pipi-runtime-mode full-access` written to child stdin MUST clamp to "approval-required"!
  ctrl.events.length = 0;
  ctrl.client.send({
    type: "in",
    sessionId: child.id,
    line: JSON.stringify({ id: "m1", type: "set_runtime_mode", mode: "full-access" }),
  });
  ctrl.client.send({
    type: "in",
    sessionId: child.id,
    line: JSON.stringify({ id: "m2", type: "prompt", message: "/pipi-runtime-mode full-access" }),
  });
  await ctrl.waitUntil(() => ctrl.events.some((e) => e.type === "out" && e.sessionId === child.id && e.line.includes("agent_settled")));
  const clampedRead = await ctrl.readMessages(child.id, 4);
  assert.ok(clampedRead.messages.some((m) => m.text === "mode:approval-required"), "prompt /pipi-runtime-mode must clamp to ancestor ceiling");

  // Error settle -> status becomes `failed` (NOT `idle`)
  await ctrl.call("detach", { sessionId: child.id });
  await ctrl.call("send", { sessionId: child.id, message: "fail:provider 503 overload" });
  await ctrl.waitUntil(() => ctrl.sessions.get(child.id)?.status === "failed");
  assert.equal(ctrl.sessions.get(child.id)?.status, "failed");

  // Stopping the parent tree (`stop`) does NOT re-wake the stopped parent with child stop delivery!
  const slowRes = await ctrl.call("start_session", {
    input: {
      title: "SlowWorker",
      agentId: "pi",
      cwd: workDir,
      parentId,
      message: "slow:10000:finish",
    },
  });
  const slowChild = slowRes.session;
  await ctrl.waitUntil(() => ctrl.sessions.get(slowChild.id)?.status === "working");
  await ctrl.call("stop", { sessionId: parentId });
  await ctrl.waitUntil(() => ctrl.sessions.get(slowChild.id)?.status === "idle");
  await new Promise((r) => setTimeout(r, 150));
  const parentMsgsAfterTreeStop = await ctrl.readMessages(parentId, 10);
  assert.equal(
    parentMsgsAfterTreeStop.messages.some((m) => m.text.includes("SlowWorker") && m.text.includes("was stopped")),
    false,
    "stopping parent tree must not re-wake parent with child stop delivery",
  );

  // Ping-pong limit (`MAX_PAIR_DEPTH = 8`) stops infinite A <-> B loop cleanly and marks root unread,
  // and a user message (`send`) resets the pair counter so another exchange is permitted.
  const pingARes = await ctrl.call("start_session", { input: { title: "PingA", agentId: "pi", cwd: workDir, message: "echo:ready-a" } });
  const pingBRes = await ctrl.call("start_session", { input: { title: "PingB", agentId: "pi", cwd: workDir, message: "echo:ready-b" } });
  const pingA = pingARes.session;
  const pingB = pingBRes.session;
  await ctrl.call("wait", { sessionId: pingA.id });
  await ctrl.call("wait", { sessionId: pingB.id });

  await ctrl.call("send", { sessionId: pingA.id, message: `pingpong-start:${pingB.id}` });
  const countLines = (sid) => {
    const f = ctrl.sessions.get(sid)?.file;
    return f && fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).length : 0;
  };
  await ctrl.waitUntil(() => {
    const aIdle = ctrl.sessions.get(pingA.id)?.status === "idle";
    const bIdle = ctrl.sessions.get(pingB.id)?.status === "idle";
    return aIdle && bIdle && countLines(pingA.id) >= 16 && (ctrl.sessions.get(pingA.id)?.unread || ctrl.sessions.get(pingB.id)?.unread);
  }, 15_000);
  const beforeResetLines = countLines(pingA.id);

  // User sends to PingA -> resets pair counter so PingA <-> PingB exchange runs again!
  await ctrl.call("send", { sessionId: pingA.id, message: `pingpong-start:${pingB.id}` });
  await ctrl.waitUntil(() => {
    return countLines(pingA.id) > beforeResetLines + 4 && ctrl.sessions.get(pingA.id)?.status === "idle" && ctrl.sessions.get(pingB.id)?.status === "idle";
  }, 10_000);
});

test("6 & 8: persistence (0600, compaction, interrupted replay on SIGTERM) and CLI commands (start/send/read/stop/wait/mcp-config/install)", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-daemon-test-3-"));
  const homeDir = path.join(tmp, "home");
  const binDir = path.join(tmp, "bin");
  const workDir = path.join(tmp, "work");
  fs.mkdirSync(workDir, { recursive: true });
  const mockBin = writeMockAgent(tmp);

  const ctrl = await openControl(homeDir, { HOME: tmp });
  await configureMockAgents(ctrl, mockBin);

  // CLI: agents, start, wait, sessions, read, send, stop, mcp-config, install
  const runCli = async (args) => {
    const { stdout } = await execFileAsync(process.execPath, [CLI_SCRIPT, "--home", homeDir, ...args], {
      env: { ...process.env, HOME: tmp, PATH: `${binDir}:${process.env.PATH}` },
    });
    return stdout.trim();
  };

  const agentsOut = await runCli(["agents"]);
  assert.match(agentsOut, /^pi\tPi\tready/m);

  const startedId = await runCli(["start", "--cwd", workDir, "--agent", "pi", "--title", "CLI Job", "--no-worktree", "echo:from-cli"]);
  assert.match(startedId, /^s_/);

  const waitedOut = await runCli(["wait", startedId]);
  assert.ok(waitedOut.includes("from-cli"));

  const sessionsOut = await runCli(["sessions"]);
  assert.ok(sessionsOut.includes(startedId));

  const readOut = JSON.parse(await runCli(["read", startedId]));
  assert.ok(readOut.lastAnswer.includes("from-cli"));

  assert.equal(await runCli(["send", startedId, "slow:10000:cli-slow"]), "sent");
  await ctrl.waitUntil(() => ctrl.sessions.get(startedId)?.status === "working");
  assert.equal(await runCli(["stop", startedId]), "stopped");
  await ctrl.waitUntil(() => ctrl.sessions.get(startedId)?.status === "idle");

  const mcpSnippet = JSON.parse(await runCli(["mcp-config"]));
  assert.ok(mcpSnippet.mcpServers?.pipi?.url.endsWith("/mcp"));

  // Verify CLI `install` writes `<HOME>/.local/bin/pipi` embedding `--home <homeDir>`
  const installOut = await runCli(["install"]);
  assert.match(installOut, /^installed: /);
  const shimPath = installOut.slice("installed: ".length).trim();
  assert.ok(shimPath.startsWith(tmp), `shim path ${shimPath} must stay inside isolated HOME`);
  const shimContent = fs.readFileSync(shimPath, "utf8");
  assert.ok(shimContent.includes("--home") && shimContent.includes(homeDir), `shim (${shimPath}) must embed --home`);

  // Check sessions.jsonl mode is 0600
  const registryPath = path.join(homeDir, "sessions.jsonl");
  await ctrl.waitUntil(() => fs.existsSync(registryPath));
  const mode = fs.statSync(registryPath).mode & 0o777;
  assert.equal(mode, 0o600, "sessions.jsonl must have 0600 permissions");

  // Start a parent and a long-running child initiated by parent, then SIGTERM the daemon:
  // restarting the daemon must mark child `interrupted` AND deliver `<pipi-message status="interrupted">` to parent!
  const parentRes = await ctrl.call("start_session", { input: { title: "WatcherParent", agentId: "pi", cwd: workDir, message: "echo:ready" } });
  const parent = parentRes.session;
  await ctrl.waitUntil(() => ctrl.sessions.get(parent.id)?.status === "idle");

  // Have parent start a slow child via MCP so child.initiator === parent.id
  await ctrl.call("send", { sessionId: parent.id, message: "spawn-child:LongTask:slow:30000:never" });
  const longChild = await ctrl.waitUntil(() => [...ctrl.sessions.values()].find((s) => s.title === "LongTask" && s.status === "working"));

  const inst1 = JSON.parse(fs.readFileSync(path.join(homeDir, "daemon.json"), "utf8"));
  const waitDead = async (pid) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        return;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`daemon pid ${pid} did not exit after SIGTERM`);
  };
  ctrl.client.close();
  process.kill(inst1.pid, "SIGTERM");
  await waitDead(inst1.pid);

  // Connect again -> spawns fresh daemon that replays compacted sessions.jsonl and revives WatcherParent with interrupted notice!
  const ctrlAfter = await openControl(homeDir, { HOME: tmp });
  const inst2 = JSON.parse(fs.readFileSync(path.join(homeDir, "daemon.json"), "utf8"));
  assert.notEqual(inst2.pid, inst1.pid, "must connect to newly restarted daemon");
  t.after(async () => {
    ctrlAfter.client.close();
    try {
      process.kill(inst2.pid, "SIGTERM");
    } catch {}
  });

  assert.equal(ctrlAfter.sessions.get(longChild.id)?.status, "interrupted");
  await ctrlAfter.waitUntil(async () => {
    const r = await ctrlAfter.readMessages(parent.id);
    return r.lastAnswer?.includes('status="failed"') && r.lastAnswer?.includes("daemon restarted");
  }, 10_000);
});

test("external-agent bridge saves sessionFile up front and drains queued steering/follow-up turns before a single agent_settled", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-bridge-queue-"));
  const agentDir = path.join(tmp, "agent");
  const workDir = path.join(tmp, "work");
  fs.mkdirSync(workDir, { recursive: true });
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const config = {
    cwd: workDir,
    agentId: "fake-acp",
    driver: "acp",
    runtimeMode: "approval-required",
    customAgent: { id: "fake-acp", name: "Fake ACP", command: process.execPath, args: [FAKE_ACP_SCRIPT] },
  };
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
  delete env.PI_CODING_AGENT_SESSION_DIR;
  delete env.FAKE_ACP_USAGE;

  const child = spawn(process.execPath, [BRIDGE_SCRIPT, JSON.stringify(config)], {
    cwd: workDir,
    env,
    stdio: ["pipe", "pipe", "ignore"],
  });
  t.after(() => child.kill());

  const records = [];
  const waits = new Map();
  let autoApprove = false;
  let buf = "";
  let seq = 0;

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    for (let at = buf.indexOf("\n"); at >= 0; at = buf.indexOf("\n")) {
      const line = buf.slice(0, at);
      buf = buf.slice(at + 1);
      if (!line) continue;
      const rec = JSON.parse(line);
      records.push(rec);
      if (rec.type === "response" && waits.has(rec.id)) {
        waits.get(rec.id)(rec);
        waits.delete(rec.id);
      } else if (rec.type === "extension_ui_request" && autoApprove) {
        child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: rec.id, confirmed: true })}\n`);
      }
    }
  });

  const rpc = (command) =>
    new Promise((resolve) => {
      const id = `b_${++seq}`;
      waits.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
    });

  const waitRecord = async (pred, timeoutMs = 8000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = records.find(pred);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("Timed out waiting for bridge record");
  };

  // Start Turn 1: pauses at tool permission dialog.
  const started = await rpc({ type: "prompt", message: "first turn" });
  assert.equal(started.data.disposition, "started");
  const firstDialog = await waitRecord((r) => r.type === "extension_ui_request");

  // `sessionFile` must already be assigned and persisted on disk BEFORE Turn 1 completes.
  const midState = (await rpc({ type: "get_state" })).data;
  assert.equal(midState.isStreaming, true);
  assert.ok(midState.sessionFile && fs.existsSync(midState.sessionFile), "sessionFile must exist on disk mid-turn");

  // Queue two follow-up turns and a steer turn while Turn 1 is paused on permission.
  // First approve Turn 1 only after queueing follow-ups (without steer-interrupting Turn 1) to test normal multi-turn drain:
  const qFollow1 = await rpc({ type: "prompt", message: "follow one", streamingBehavior: "followUp" });
  const qFollow2 = await rpc({ type: "prompt", message: "follow two", streamingBehavior: "followUp" });
  assert.equal(qFollow1.data.disposition, "queued");
  assert.equal(qFollow2.data.disposition, "queued");

  const stateWhileQueued = (await rpc({ type: "get_state" })).data;
  assert.equal(stateWhileQueued.pendingMessageCount, 2);

  // Auto-approve subsequent tool calls and approve Turn 1's dialog so all 3 turns drain back-to-back.
  autoApprove = true;
  child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: firstDialog.id, confirmed: true })}\n`);

  const settled = await waitRecord((r) => r.type === "agent_settled");
  assert.equal(settled.aborted, false);

  // Must have emitted `agent_end` once per turn (3 total), and `agent_settled` strictly once at the end!
  const agentEnds = records.filter((r) => r.type === "agent_end");
  const agentSettleds = records.filter((r) => r.type === "agent_settled");
  assert.equal(agentEnds.length, 3, "each drained turn must emit agent_end");
  assert.equal(agentSettleds.length, 1, "agent_settled must fire only once after queue drains");

  const history = (await rpc({ type: "get_messages" })).data.messages;
  const userTexts = history
    .filter((m) => m.role === "user")
    .map((m) => (Array.isArray(m.content) ? m.content.find((b) => b.type === "text")?.text : m.content));
  assert.deepEqual(userTexts, ["first turn", "follow one", "follow two"]);
  assert.equal(history.filter((m) => m.role === "assistant").length, 3);
});

test("daemon replays queue_update across detach/reattach, drains queued turns before idle, and clears stale file on new_session", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-daemon-queue-"));
  const homeDir = path.join(tmp, "home");
  const workDir = path.join(tmp, "work");
  fs.mkdirSync(workDir, { recursive: true });
  const mockBin = writeMockAgent(tmp);

  const ctrl1 = await openControl(homeDir, { HOME: tmp });
  t.after(async () => {
    ctrl1.client.close();
    try {
      const inst = JSON.parse(fs.readFileSync(path.join(homeDir, "daemon.json"), "utf8"));
      process.kill(inst.pid, "SIGTERM");
    } catch {}
  });
  await configureMockAgents(ctrl1, mockBin);

  const attached = await ctrl1.call("attach", {
    session: { cwd: workDir, agentId: "pi", agentName: "Pi", driver: "pi", runtimeMode: "full-access" },
  });
  const sid = attached.session.id;

  // Start a slow turn, then queue both a steer and a followUp message while it streams.
  ctrl1.client.send({ type: "in", sessionId: sid, line: JSON.stringify({ id: "q1", type: "prompt", message: "slow:500:turn-one" }) });
  await ctrl1.waitUntil(() => ctrl1.sessions.get(sid)?.status === "working");
  ctrl1.client.send({
    type: "in",
    sessionId: sid,
    line: JSON.stringify({ id: "q2", type: "prompt", message: "follow-msg", streamingBehavior: "followUp" }),
  });
  ctrl1.client.send({
    type: "in",
    sessionId: sid,
    line: JSON.stringify({ id: "q3", type: "prompt", message: "steer-msg", streamingBehavior: "steer" }),
  });
  await ctrl1.waitUntil(() =>
    ctrl1.events.some(
      (e) =>
        e.type === "out" &&
        e.sessionId === sid &&
        e.line.includes('"queue_update"') &&
        e.line.includes("steer-msg") &&
        e.line.includes("follow-msg"),
    ),
  );

  // Detach while Turn 1 is still running and messages are queued.
  await ctrl1.call("detach", { sessionId: sid });

  // Reattach on a second client: daemon immediately replays `queue_update` with both queued messages.
  const ctrl2 = await openControl(homeDir, { HOME: tmp });
  t.after(() => ctrl2.client.close());
  await ctrl2.call("attach", { session: { id: sid, cwd: workDir, agentId: "pi", driver: "pi" } });
  const replayedQueue = await ctrl2.waitUntil(() =>
    ctrl2.events.find((e) => e.type === "out" && e.sessionId === sid && e.line.includes('"queue_update"')),
  );
  assert.deepEqual(JSON.parse(replayedQueue.line.trim()), {
    type: "queue_update",
    steering: ["steer-msg"],
    followUp: ["follow-msg"],
  });

  // Detach again and let all 3 turns finish in the background: steer runs before followUp, then session settles idle.
  await ctrl2.call("detach", { sessionId: sid });
  await ctrl1.waitUntil(() => ctrl1.sessions.get(sid)?.status === "idle");
  assert.equal(ctrl1.sessions.get(sid)?.unread, true);
  const finished = await ctrl1.readMessages(sid);
  assert.deepEqual(
    finished.messages.map((m) => `${m.role}:${m.text}`),
    [
      "user:slow:500:turn-one",
      "assistant:turn-one",
      "user:steer-msg",
      "assistant:echo:steer-msg",
      "user:follow-msg",
      "assistant:echo:follow-msg",
    ],
  );

  const firstFile = ctrl1.sessions.get(sid)?.file;
  assert.ok(firstFile, "first conversation must have discovered its session file");

  // Reattach and send `new_session`: daemon clears stale `file` and resets title, then discovers the new file on `agent_start`.
  await ctrl1.call("attach", { session: { id: sid, cwd: workDir, agentId: "pi", driver: "pi" } });
  ctrl1.client.send({ type: "in", sessionId: sid, line: JSON.stringify({ id: "ns1", type: "new_session" }) });
  await ctrl1.waitUntil(() => !ctrl1.sessions.get(sid)?.file && ctrl1.sessions.get(sid)?.title === "New session");

  ctrl1.client.send({ type: "in", sessionId: sid, line: JSON.stringify({ id: "ns2", type: "prompt", message: "fresh-start" }) });
  await ctrl1.waitUntil(() => Boolean(ctrl1.sessions.get(sid)?.file) && ctrl1.sessions.get(sid)?.status === "idle");
  const secondFile = ctrl1.sessions.get(sid)?.file;
  assert.notEqual(secondFile, firstFile, "new_session turn must discover its own fresh sessionFile");

  // Reattaching by `file: secondFile` (without `id`) must find `sid` rather than spawning a second process!
  await ctrl1.call("detach", { sessionId: sid });
  const byFile = await ctrl1.call("attach", { session: { file: secondFile, cwd: workDir, agentId: "pi", driver: "pi" } });
  assert.equal(byFile.session.id, sid, "attach by discovered sessionFile must reuse the existing daemon session");
});

test("daemon retitles a session from the file it lands on, but keeps a given name", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-daemon-title-"));
  const homeDir = path.join(tmp, "home");
  const workDir = path.join(tmp, "work");
  fs.mkdirSync(workDir, { recursive: true });
  const mockBin = writeMockAgent(tmp);

  const ctrl = await openControl(homeDir, { HOME: tmp });
  t.after(async () => {
    ctrl.client.close();
    try {
      const inst = JSON.parse(fs.readFileSync(path.join(homeDir, "daemon.json"), "utf8"));
      process.kill(inst.pid, "SIGTERM");
    } catch {}
  });
  await configureMockAgents(ctrl, mockBin);

  const writePiFile = (name, lines) => {
    const file = path.join(workDir, name);
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: "session", version: 3, id: name, timestamp: new Date().toISOString(), cwd: workDir }),
        ...lines,
        "",
      ].join("\n"),
    );
    return file;
  };
  const userLine = (text) => JSON.stringify({ type: "message", message: { role: "user", content: text, timestamp: Date.now() } });

  // A session that learned its title from its first prompt.
  const attached = await ctrl.call("attach", {
    session: { cwd: workDir, agentId: "pi", agentName: "Pi", driver: "pi", runtimeMode: "full-access" },
  });
  const sid = attached.session.id;
  ctrl.client.send({ type: "in", sessionId: sid, line: JSON.stringify({ id: "t1", type: "prompt", message: "first conversation" }) });
  await ctrl.waitUntil(() => ctrl.sessions.get(sid)?.title === "first conversation" && ctrl.sessions.get(sid)?.status === "idle");

  // Re-keying onto another file retitles to that file's first message — no stale name.
  const otherFile = writePiFile("other.jsonl", [userLine("the other conversation")]);
  ctrl.client.send({ type: "file", sessionId: sid, file: otherFile });
  await ctrl.waitUntil(() => ctrl.sessions.get(sid)?.title === "the other conversation");

  // A `session_info` name on the file wins over the first message.
  const namedFile = writePiFile("named.jsonl", [
    userLine("some chat"),
    JSON.stringify({ type: "session_info", name: "Named on disk" }),
  ]);
  ctrl.client.send({ type: "file", sessionId: sid, file: namedFile });
  await ctrl.waitUntil(() => ctrl.sessions.get(sid)?.title === "Named on disk");

  // A file that does not exist yet (a minted file that was never written) is no title.
  ctrl.client.send({ type: "file", sessionId: sid, file: path.join(workDir, "ghost.jsonl") });
  await ctrl.waitUntil(() => ctrl.sessions.get(sid)?.title === "New session");

  // A title handed in via `start_session` is the task's name and survives file moves.
  const started = await ctrl.call("start_session", { input: { title: "Named job", agentId: "pi", cwd: workDir } });
  const namedId = started.session.id;
  ctrl.client.send({ type: "file", sessionId: namedId, file: namedFile });
  await ctrl.waitUntil(() => ctrl.sessions.get(namedId)?.file === namedFile);
  assert.equal(ctrl.sessions.get(namedId)?.title, "Named job");

  // `new_session` hands the name back: the next conversation tracks its file again.
  ctrl.client.send({ type: "in", sessionId: namedId, line: JSON.stringify({ id: "ns", type: "new_session" }) });
  await ctrl.waitUntil(() => ctrl.sessions.get(namedId)?.title === "New session");
  ctrl.client.send({ type: "file", sessionId: namedId, file: namedFile });
  await ctrl.waitUntil(() => ctrl.sessions.get(namedId)?.title === "Named on disk");
});


test("stop puts down a bridge that answers abort but never settles its run", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-daemon-wedge-"));
  const homeDir = path.join(tmp, "home");
  const workDir = path.join(tmp, "work");
  fs.mkdirSync(workDir, { recursive: true });
  const mockBin = writeMockAgent(tmp);

  const ctrl = await openControl(homeDir, { HOME: tmp });
  t.after(async () => {
    ctrl.client.close();
    try {
      const inst = JSON.parse(fs.readFileSync(path.join(homeDir, "daemon.json"), "utf8"));
      process.kill(inst.pid, "SIGTERM");
    } catch {}
  });
  await configureMockAgents(ctrl, mockBin);

  const attached = await ctrl.call("attach", {
    session: { cwd: workDir, agentId: "pi", agentName: "Pi", driver: "pi", runtimeMode: "full-access" },
  });
  const sid = attached.session.id;
  ctrl.client.send({ type: "in", sessionId: sid, line: JSON.stringify({ id: "w1", type: "prompt", message: "wedge:now" }) });
  await ctrl.waitUntil(() => ctrl.sessions.get(sid)?.status === "working");

  // The abort is answered but the run never settles — stop must kill, not report.
  await ctrl.call("stop", { sessionId: sid });
  await ctrl.waitUntil(() => ctrl.sessions.get(sid)?.status === "idle", 6000);
  assert.equal(ctrl.sessions.get(sid)?.loaded, false, "the wedged process is gone");

  // The session still works afterwards: a message revives it on a fresh process.
  await ctrl.call("send", { sessionId: sid, message: "back from the dead" });
  const read = await ctrl.waitUntil(async () => {
    const got = await ctrl.readMessages(sid);
    return got.messages.at(-1)?.text === "echo:back from the dead" ? got : undefined;
  }, 10000);
  assert.equal(read.messages.at(-1).text, "echo:back from the dead");
});

test("a mid-run crash delivers what was queued, and session_send says queued honestly", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-daemon-crash-"));
  const homeDir = path.join(tmp, "home");
  const workDir = path.join(tmp, "work");
  fs.mkdirSync(workDir, { recursive: true });
  const mockBin = writeMockAgent(tmp);

  const ctrl = await openControl(homeDir, { HOME: tmp });
  t.after(async () => {
    ctrl.client.close();
    try {
      const inst = JSON.parse(fs.readFileSync(path.join(homeDir, "daemon.json"), "utf8"));
      process.kill(inst.pid, "SIGTERM");
    } catch {}
  });
  await configureMockAgents(ctrl, mockBin);

  // The run dies on its own while a delivery sits in the queue: the exit must
  // put the process back and hand the queued message over — not strand it.
  const crashRes = await ctrl.call("start_session", {
    input: { title: "Crashy", agentId: "pi", cwd: workDir, message: "die:400" },
  });
  const crashy = crashRes.session;
  await ctrl.waitUntil(() => ctrl.sessions.get(crashy.id)?.status === "working");
  const sendRes = await ctrl.call("tool", { name: "session_send", args: { session: crashy.id, message: "land-after-crash" } });
  assert.equal(sendRes.result.queued, true);
  await ctrl.waitUntil(async () => {
    const r = await ctrl.readMessages(crashy.id);
    return r.lastAnswer?.includes("land-after-crash") && ctrl.sessions.get(crashy.id)?.status === "idle";
  }, 15_000);

  // A killed/unloaded target queues behind a revive — the receipt says so.
  const idleRes = await ctrl.call("start_session", {
    input: { title: "IdleOne", agentId: "pi", cwd: workDir, message: "echo:hi" },
  });
  const idleOne = idleRes.session;
  await ctrl.call("wait", { sessionId: idleOne.id });
  await ctrl.call("kill", { sessionId: idleOne.id });
  await ctrl.waitUntil(() => ctrl.sessions.get(idleOne.id)?.loaded === false);
  const sendDead = await ctrl.call("tool", { name: "session_send", args: { session: idleOne.id, message: "to-the-dead" } });
  assert.equal(sendDead.result.queued, true, "a dead target is queued behind its revive, not sent");
  await ctrl.waitUntil(async () => (await ctrl.readMessages(idleOne.id)).lastAnswer?.includes("to-the-dead"));

  // And an idle+loaded target is sent at once — the receipt says that too.
  const sendLive = await ctrl.call("tool", { name: "session_send", args: { session: idleOne.id, message: "to-the-living" } });
  assert.equal(sendLive.result.queued, false);
  await ctrl.waitUntil(async () => (await ctrl.readMessages(idleOne.id)).lastAnswer?.includes("to-the-living"));
});

test("a fresh attach adopts the standby the last attach warmed — invisibly, and only within its TTL", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-daemon-pool-"));
  const homeDir = path.join(tmp, "home");
  const workDir = path.join(tmp, "work");
  fs.mkdirSync(workDir, { recursive: true });
  const mockBin = writeMockAgent(tmp);
  const bootlog = path.join(tmp, "boot.log");
  const POOL_TTL = 1200;

  const ctrl = await openControl(homeDir, { HOME: tmp, PIPI_MOCK_BOOTLOG: bootlog, PIPI_DAEMON_POOL_TTL_MS: String(POOL_TTL) });
  t.after(async () => {
    ctrl.client.close();
    try {
      const inst = JSON.parse(fs.readFileSync(path.join(homeDir, "daemon.json"), "utf8"));
      process.kill(inst.pid, "SIGTERM");
    } catch {}
  });
  await configureMockAgents(ctrl, mockBin);

  const spec = { cwd: workDir, agentId: "pi", agentName: "Pi", driver: "pi", runtimeMode: "full-access" };
  const first = await ctrl.call("attach", { session: spec });
  const sid1 = first.session.id;

  // The attach warms a standby for the same spec in the background: the second
  // mock agent boots without ever being announced as a session. The session's
  // own process and the standby boot together, so the log's order is not the
  // spawn's — sid1's own prompt says which pid is the session's.
  const boots = await ctrl.waitUntil(() => {
    try {
      const lines = fs.readFileSync(bootlog, "utf8").trim().split("\n").filter(Boolean).map(Number);
      return lines.length >= 2 ? lines : undefined;
    } catch {
      return undefined;
    }
  });
  assert.equal(ctrl.sessions.size, 1, "the pooled standby is never pushed as a session");

  ctrl.client.send({ type: "in", sessionId: sid1, line: JSON.stringify({ id: "p0", type: "prompt", message: "inspect-env" }) });
  await ctrl.waitUntil(() => ctrl.events.some((e) => e.type === "out" && e.line?.includes("agent_settled")));
  const read1 = await ctrl.readMessages(sid1);
  const env1 = JSON.parse(read1.messages.at(-1).text);
  const standby = boots.find((pid) => pid !== env1.pid);
  assert.ok(standby, "the standby is the second booted process");

  const second = await ctrl.call("attach", { session: spec });
  const sid2 = second.session.id;
  assert.notEqual(sid2, sid1);
  assert.equal(ctrl.sessions.size, 2);

  // The adopted session runs on the standby's already-booted process, and the
  // process's own session id is the adopted session's.
  ctrl.events.length = 0;
  ctrl.client.send({ type: "in", sessionId: sid2, line: JSON.stringify({ id: "p1", type: "prompt", message: "inspect-env" }) });
  await ctrl.waitUntil(() => ctrl.events.some((e) => e.type === "out" && e.line?.includes("agent_settled")));
  const read2 = await ctrl.readMessages(sid2);
  const env2 = JSON.parse(read2.messages.at(-1).text);
  assert.equal(env2.pid, standby, "the fresh session adopted the standby process");
  assert.equal(env2.sessionId, sid2);

  // The adoption refills the pool once; that standby too stays invisible and
  // expires with the TTL — the next fresh attach after it spawns on its own.
  const boots3 = await ctrl.waitUntil(() => {
    const lines = fs.readFileSync(bootlog, "utf8").trim().split("\n").filter(Boolean).map(Number);
    return lines.length >= 3 ? lines : undefined;
  });
  await new Promise((resolve) => setTimeout(resolve, POOL_TTL + 800));
  assert.equal(ctrl.sessions.size, 2, "an expired standby leaves no session behind");
  const third = await ctrl.call("attach", { session: spec });
  const sid3 = third.session.id;
  ctrl.client.send({ type: "in", sessionId: sid3, line: JSON.stringify({ id: "p2", type: "prompt", message: "inspect-env" }) });
  await ctrl.waitUntil(() => ctrl.events.filter((e) => e.type === "out" && e.line?.includes("agent_settled")).length >= 2);
  const read3 = await ctrl.readMessages(sid3);
  const env3 = JSON.parse(read3.messages.at(-1).text);
  assert.ok(!boots3.includes(env3.pid), "an expired standby is not adopted — a fresh process took it");
});

test("untouched blank drafts reap on detach, idle exits stay idle, attach clears failed/interrupted, and remove retires fileless sessions", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-daemon-lifecycle-"));
  const homeDir = path.join(tmp, "home");
  const workDir = path.join(tmp, "work");
  fs.mkdirSync(workDir, { recursive: true });
  const mockBin = writeMockAgent(tmp);

  const ctrl = await openControl(homeDir, { HOME: tmp, PIPI_DAEMON_POOL: "0" });
  t.after(async () => {
    ctrl.client.close();
    try {
      const inst = JSON.parse(fs.readFileSync(path.join(homeDir, "daemon.json"), "utf8"));
      process.kill(inst.pid, "SIGTERM");
    } catch {}
  });
  await configureMockAgents(ctrl, mockBin);

  // 1. Detaching from an untouched blank UI draft reaps it cleanly (`session_removed`).
  const blank = await ctrl.call("attach", {
    session: { cwd: workDir, agentId: "pi", agentName: "Pi", driver: "pi", runtimeMode: "full-access" },
  });
  const blankId = blank.session.id;
  assert.equal(ctrl.sessions.has(blankId), true);
  await ctrl.call("detach", { sessionId: blankId });
  await ctrl.waitUntil(() => !ctrl.sessions.has(blankId));

  // 2. A session that saved a conversation stays `idle` (never `interrupted`) if its idle process exits on its own.
  const saved = await ctrl.call("attach", {
    session: { cwd: workDir, agentId: "pi", agentName: "Pi", driver: "pi", runtimeMode: "full-access" },
  });
  const savedId = saved.session.id;
  ctrl.client.send({ type: "in", sessionId: savedId, line: JSON.stringify({ id: "m1", type: "prompt", message: "inspect-env" }) });
  await ctrl.waitUntil(() => ctrl.sessions.get(savedId)?.status === "idle" && ctrl.sessions.get(savedId)?.title === "inspect-env");
  const readEnv = JSON.parse((await ctrl.readMessages(savedId)).messages.at(-1).text);
  await ctrl.call("detach", { sessionId: savedId });
  process.kill(readEnv.pid, "SIGKILL");
  await ctrl.waitUntil(() => ctrl.sessions.get(savedId)?.loaded === false);
  assert.equal(ctrl.sessions.get(savedId)?.status, "idle", "an unexpected exit while idle must not mark the session interrupted");

  // 3. Attaching to a failed session spawns a fresh process and clears its failed status back to `idle`.
  const failedJob = await ctrl.call("start_session", {
    input: { title: "Crashy Job", agentId: "pi", cwd: workDir, message: "die:150" },
  });
  const failedId = failedJob.session.id;
  await ctrl.waitUntil(() => ctrl.sessions.get(failedId)?.status === "failed");
  const reattached = await ctrl.call("attach", {
    session: { id: failedId, cwd: workDir, agentId: "pi", agentName: "Pi", driver: "pi" },
  });
  assert.equal(reattached.session.status, "idle");
  assert.equal(ctrl.sessions.get(failedId)?.status, "idle");
  await ctrl.call("detach", { sessionId: failedId });

  // 4. `remove` retires a fileless failed daemon session from the registry altogether.
  const brokenSpawn = await ctrl.call("start_session", {
    input: { title: "Broken Worktree", agentId: "pi", cwd: workDir, worktree: true, message: "echo:nope" },
  });
  const brokenId = brokenSpawn.session.id;
  await ctrl.waitUntil(() => ctrl.sessions.get(brokenId)?.status === "failed" && !ctrl.sessions.get(brokenId)?.file);
  await ctrl.call("remove", { sessionId: brokenId });
  await ctrl.waitUntil(() => !ctrl.sessions.has(brokenId));
});

test("attaching a saved session file never adopts a blank pooled standby without switching into the file", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-daemon-pool-file-"));
  const homeDir = path.join(tmp, "home");
  const workDir = path.join(tmp, "work");
  fs.mkdirSync(workDir, { recursive: true });
  const mockBin = writeMockAgent(tmp);
  const bootlog = path.join(tmp, "boot.log");

  const savedFile = path.join(workDir, "saved.jsonl");
  fs.writeFileSync(
    savedFile,
    [
      JSON.stringify({ type: "message", message: { role: "user", content: "saved prompt", timestamp: 1 } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "saved reply" }], stopReason: "stop", timestamp: 2 } }),
    ].join("\n") + "\n",
  );

  const ctrl = await openControl(homeDir, { HOME: tmp, PIPI_MOCK_BOOTLOG: bootlog, PIPI_DAEMON_POOL_DELAY_MS: "10" });
  t.after(async () => {
    ctrl.client.close();
    try {
      const inst = JSON.parse(fs.readFileSync(path.join(homeDir, "daemon.json"), "utf8"));
      process.kill(inst.pid, "SIGTERM");
    } catch {}
  });
  await configureMockAgents(ctrl, mockBin);

  const spec = { cwd: workDir, agentId: "pi", agentName: "Pi", driver: "pi", runtimeMode: "full-access" };
  const first = await ctrl.call("attach", { session: spec });
  const sid1 = first.session.id;

  // Wait for the background standby to boot.
  const boots = await ctrl.waitUntil(() => {
    try {
      const lines = fs.readFileSync(bootlog, "utf8").trim().split("\n").filter(Boolean).map(Number);
      return lines.length >= 2 ? lines : undefined;
    } catch {
      return undefined;
    }
  });
  ctrl.client.send({ type: "in", sessionId: sid1, line: JSON.stringify({ id: "p0", type: "prompt", message: "inspect-env" }) });
  await ctrl.waitUntil(() => ctrl.events.some((e) => e.type === "out" && e.line?.includes("agent_settled")));
  const env1 = JSON.parse((await ctrl.readMessages(sid1)).messages.at(-1).text);
  const standbyPid = boots.find((pid) => pid !== env1.pid);
  assert.ok(standbyPid, "the standby is the second booted process");

  // Attaching to a saved file must NOT take the blank standby without switch_session.
  const reopened = await ctrl.call("attach", { session: { ...spec, file: savedFile } });
  const sidSaved = reopened.session.id;
  assert.equal(reopened.session.file, savedFile);
  assert.equal(reopened.session.title, "saved prompt");
  ctrl.client.send({ type: "in", sessionId: sidSaved, line: JSON.stringify({ id: "gm1", type: "get_messages" }) });
  const gmOut = await ctrl.waitUntil(() =>
    ctrl.events.find((e) => e.type === "out" && e.sessionId === sidSaved && e.line?.includes('"id":"gm1"')),
  );
  const gmRecord = JSON.parse(gmOut.line);
  assert.equal(gmRecord.data.messages.length, 2);
  assert.equal(gmRecord.data.messages[0].content, "saved prompt");

  // And the blank standby is still intact for the next fresh session.
  ctrl.events.length = 0;
  const fresh = await ctrl.call("attach", { session: spec });
  ctrl.client.send({ type: "in", sessionId: fresh.session.id, line: JSON.stringify({ id: "p2", type: "prompt", message: "inspect-env" }) });
  await ctrl.waitUntil(() => ctrl.events.some((e) => e.type === "out" && e.sessionId === fresh.session.id && e.line?.includes("agent_settled")));
  const envFresh = JSON.parse((await ctrl.readMessages(fresh.session.id)).messages.at(-1).text);
  assert.equal(envFresh.pid, standbyPid, "saved-file attach left the blank standby for the next fresh session");
});

test("pipi_background_watch stays hidden from UI clients and keeps daemon alive across windowless idle until cleared", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-daemon-watch-"));
  const homeDir = path.join(tmp, "home");
  const workDir = path.join(tmp, "work");
  fs.mkdirSync(workDir, { recursive: true });
  const mockBin = writeMockAgent(tmp);

  const ctrl = await openControl(homeDir, { HOME: tmp, PIPI_DAEMON_POOL: "0", PIPI_DAEMON_IDLE_EXIT_MS: "250" });
  const daemonPid = JSON.parse(fs.readFileSync(path.join(homeDir, "daemon.json"), "utf8")).pid;
  t.after(() => {
    ctrl.client.close();
    try {
      process.kill(daemonPid, "SIGTERM");
    } catch {}
  });
  await configureMockAgents(ctrl, mockBin);
  await ctrl.call("config", { linger: false });

  const attached = await ctrl.call("attach", {
    session: { cwd: workDir, agentId: "pi", agentName: "Pi", driver: "pi", runtimeMode: "full-access" },
  });
  const sid = attached.session.id;

  ctrl.client.send({ type: "in", sessionId: sid, line: JSON.stringify({ id: "w1", type: "prompt", message: "watch:700" }) });
  await ctrl.waitUntil(() => ctrl.events.some((e) => e.type === "out" && e.sessionId === sid && e.line?.includes("agent_settled")));
  assert.equal(
    ctrl.events.some((e) => e.type === "out" && e.line?.includes("pipi_background_watch")),
    false,
    "pipi_background_watch is internal to daemon and never forwarded to clients",
  );

  // Close the UI client while the background watch is active (~700ms window):
  // the daemon must stay alive past WINDOWLESS_EXIT_MS (250ms), then exit once cleared.
  ctrl.client.close();
  await new Promise((r) => setTimeout(r, 400));
  assert.doesNotThrow(() => process.kill(daemonPid, 0), "daemon stays alive while backgroundWatch is active");

  const deadline = Date.now() + 5000;
  let alive = true;
  while (Date.now() < deadline && alive) {
    await new Promise((r) => setTimeout(r, 50));
    try {
      process.kill(daemonPid, 0);
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, "daemon exits once backgroundWatch clears");
});

test("connectDaemon upgrades a stale idle daemon on UI connect, preserves running ones, and ignores CLI connects", async (t) => {
  const { connectDaemon, sidecarFingerprint } = await import("./daemon-client.mjs");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-daemon-upgrade-"));
  const homeDir = path.join(tmp, "home");
  const workDir = path.join(tmp, "work");
  fs.mkdirSync(workDir, { recursive: true });
  const mockBin = writeMockAgent(tmp);

  // 1. Start a daemon with a stale fingerprint (simulating an older app install).
  const staleEnv = { ...process.env, HOME: tmp, PIPI_DAEMON_POOL: "0", PIPI_DAEMON_FINGERPRINT: "stale-v0-2-21" };
  const staleChild = spawn(process.execPath, [DAEMON_SCRIPT, "--home", homeDir], { env: staleEnv, stdio: "ignore" });
  t.after(() => {
    try {
      staleChild.kill("SIGTERM");
    } catch {}
    try {
      const info = JSON.parse(fs.readFileSync(path.join(homeDir, "daemon.json"), "utf8"));
      if (info?.pid) process.kill(info.pid, "SIGTERM");
    } catch {}
  });
  const instPath = path.join(homeDir, "daemon.json");
  for (let i = 0; i < 100 && !fs.existsSync(instPath); i++) await new Promise((r) => setTimeout(r, 40));
  const staleInfo = JSON.parse(fs.readFileSync(instPath, "utf8"));
  assert.equal(staleInfo.fingerprint, "stale-v0-2-21");

  // 2. A CLI connection must NOT recycle the stale daemon.
  const cli = await connectDaemon({ home: homeDir, kind: "cli", timeoutMs: 8000 });
  const cliHello = await new Promise((resolve) => cli.onLine((m) => m.type === "hello" && resolve(m)));
  assert.equal(cliHello.type, "hello");
  cli.close();
  assert.equal(JSON.parse(fs.readFileSync(instPath, "utf8")).pid, staleInfo.pid, "CLI connect keeps existing daemon");

  // 3. A UI connection to an idle stale daemon cleanly replaces it with the current fingerprint.
  const ui = await connectDaemon({ home: homeDir, kind: "ui", timeoutMs: 8000 });
  const uiHello = await new Promise((resolve) => ui.onLine((m) => m.type === "hello" && resolve(m)));
  assert.equal(uiHello.type, "hello");
  const freshInfo = JSON.parse(fs.readFileSync(instPath, "utf8"));
  assert.notEqual(freshInfo.pid, staleInfo.pid, "stale idle daemon was replaced");
  assert.equal(freshInfo.fingerprint, sidecarFingerprint(), "replacement daemon reports current fingerprint");

  // 4. Start an actively working session, then spoof daemon.json with a stale fingerprint:
  // a new UI connection must NOT kill the running session.
  const req = (channel, msg) =>
    new Promise((resolve) => {
      const id = `r_${Math.random().toString(36).slice(2)}`;
      const fn = (m) => {
        if (m.id === id) {
          channel._handlers.splice(channel._handlers.indexOf(fn), 1);
          resolve(m);
        }
      };
      channel._handlers.push(fn);
      channel.send({ ...msg, id });
    });
  await req(ui, {
    type: "config",
    agents: [{ id: "pi", name: "Pi", driver: "pi", binaryPath: mockBin }],
    allowAgentTools: true,
    linger: false,
  });
  const attached = await req(ui, {
    type: "attach",
    session: { cwd: workDir, agentId: "pi", agentName: "Pi", driver: "pi", runtimeMode: "full-access" },
  });
  const sid = attached.session.id;
  const workingReady = new Promise((resolve) => {
    const fn = (m) => {
      if (m.type === "session" && m.session?.id === sid && m.session.status === "working") {
        ui._handlers.splice(ui._handlers.indexOf(fn), 1);
        resolve();
      }
    };
    ui._handlers.push(fn);
  });
  ui.send({ type: "in", sessionId: sid, line: JSON.stringify({ id: "slow1", type: "prompt", message: "slow:1500" }) });
  await workingReady;

  fs.writeFileSync(instPath, JSON.stringify({ ...freshInfo, fingerprint: "older-build" }, null, 2));
  const ui2 = await connectDaemon({ home: homeDir, kind: "ui", timeoutMs: 8000 });
  const ui2Hello = await new Promise((resolve) => ui2.onLine((m) => m.type === "hello" && resolve(m)));
  assert.equal(ui2Hello.type, "hello");
  assert.equal(
    ui2Hello.sessions.find((s) => s.id === sid)?.status,
    "working",
    "running session was preserved without killing the daemon",
  );
  assert.doesNotThrow(() => process.kill(freshInfo.pid, 0), "daemon stayed alive while session was working");

  ui2.close();
  ui.close();
});

test("the personal agent: one per home, opens each fresh conversation with PERSONA.md and MEMORY.md, and survives a restart", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-daemon-persona-"));
  const homeDir = path.join(tmp, "home");
  const personaDir = path.join(homeDir, "persona");
  const mockBin = writeMockAgent(tmp);
  const ctrl = await openControl(homeDir, { HOME: tmp });
  let after;
  t.after(() => {
    ctrl.client.close();
    after?.client.close();
    try {
      process.kill(JSON.parse(fs.readFileSync(path.join(homeDir, "daemon.json"), "utf8")).pid, "SIGTERM");
    } catch {}
  });
  await configureMockAgents(ctrl, mockBin);
  const runCli = async (args) => {
    const { stdout } = await execFileAsync(process.execPath, [CLI_SCRIPT, "--home", homeDir, ...args], { env: { ...process.env, HOME: tmp } });
    return stdout.trim();
  };
  const lastAnswer = async (id) => (await ctrl.readMessages(id)).lastAnswer ?? "";

  // First use seeds the persona's home (private to the person) and starts it there, named by its PERSONA.md.
  const id = await runCli(["pip"]);
  assert.match(id, /^s_/);
  const info = ctrl.sessions.get(id) ?? (await ctrl.waitUntil(() => ctrl.sessions.get(id)));
  assert.equal(info.persona, true);
  assert.equal(info.cwd, personaDir);
  assert.equal(info.title, "Pip");
  assert.equal(info.parentId, undefined);
  const persona = fs.readFileSync(path.join(personaDir, "PERSONA.md"), "utf8");
  assert.match(persona, /^# Pip$/m);
  assert.ok(fs.existsSync(path.join(personaDir, "MEMORY.md")));
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(personaDir, "MEMORY.md")).mode & 0o077, 0);

  // Pi names its file before the conversation exists: that is still a fresh conversation.
  await ctrl.waitUntil(() => ctrl.sessions.get(id)?.file);
  // A slash command keeps the start of its prompt; the block waits for the next one.
  await runCli(["pip", "/skill:recall"]);
  await ctrl.waitUntil(async () => (await lastAnswer(id)) === "echo:/skill:recall");
  await runCli(["pip", "echo:hello"]);
  await ctrl.waitUntil(async () => (await lastAnswer(id)).endsWith("echo:hello"));
  const first = await lastAnswer(id);
  assert.ok(first.startsWith("echo:<pipi-persona"), "the first chat prompt opens with the persona block");
  assert.ok(first.includes("<persona file=\"PERSONA.md\">") && first.includes("<memory-index file=\"MEMORY.md\""));
  assert.ok(first.endsWith("</pipi-persona>\n\necho:hello"), "the person's words follow the block unchanged");

  // The same conversation goes on without it; a second persona is refused.
  assert.equal(await runCli(["pip", "echo:again"]), id);
  await ctrl.waitUntil(async () => (await lastAnswer(id)).includes("echo:again"));
  assert.equal(await lastAnswer(id), "echo:echo:again");
  await assert.rejects(ctrl.call("start_session", { input: { persona: true, agentId: "pi" } }), /already runs as/);

  // A fresh conversation reads the files again: what the person renamed and what Pip noted.
  fs.writeFileSync(path.join(personaDir, "PERSONA.md"), "# Mochi\n\nMochi is calm.\n");
  const memory = `# Memory\n\n- Jiahe prefers Chinese.\n${"- filler line for the cap\n".repeat(1000)}- the newest line\n`;
  fs.writeFileSync(path.join(personaDir, "MEMORY.md"), memory);
  ctrl.client.send({ type: "in", sessionId: id, line: JSON.stringify({ id: "n1", type: "new_session" }) });
  await ctrl.waitUntil(() => !ctrl.sessions.get(id)?.file);
  ctrl.client.send({ type: "in", sessionId: id, line: JSON.stringify({ id: "p1", type: "prompt", message: "echo:fresh" }) });
  await ctrl.waitUntil(async () => (await lastAnswer(id)).endsWith("echo:fresh"));
  await ctrl.waitUntil(() => ctrl.sessions.get(id)?.file);
  const saved = fs.readFileSync(ctrl.sessions.get(id).file, "utf8");
  assert.ok(saved.includes('name=\\"Mochi\\"') && saved.includes("You are Mochi.") && saved.includes("Mochi is calm."));
  assert.ok(saved.includes("Jiahe prefers Chinese."));
  assert.ok(saved.includes(`bytes=\\"${Buffer.byteLength(memory)}\\"`), "the index says how big the file is");
  assert.ok(!saved.includes("the newest line"), "only the head of a long MEMORY.md is handed over");
  assert.equal(fs.readFileSync(path.join(personaDir, "MEMORY.md"), "utf8"), memory, "the file itself is never cut");

  // The registry keeps who the personal agent is across a daemon restart.
  const inst1 = JSON.parse(fs.readFileSync(path.join(homeDir, "daemon.json"), "utf8"));
  ctrl.client.close();
  process.kill(inst1.pid, "SIGTERM");
  await new Promise((resolve) => {
    const poll = setInterval(() => {
      try {
        process.kill(inst1.pid, 0);
      } catch {
        clearInterval(poll);
        resolve();
      }
    }, 25);
  });
  after = await openControl(homeDir, { HOME: tmp });
  assert.equal(after.sessions.get(id)?.persona, true);
  assert.match(await runCli(["pip"]), new RegExp(`^${id}\\t`));
});

test("workspaces_list names the app's open projects and the folders sessions ran in, never the personal agent's notes", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-daemon-workspaces-"));
  const homeDir = path.join(tmp, "home");
  const openProject = path.join(tmp, "open-project");
  const ranIn = path.join(tmp, "ran-in");
  for (const dir of [openProject, ranIn]) fs.mkdirSync(dir, { recursive: true });
  const mockBin = writeMockAgent(tmp);
  const ctrl = await openControl(homeDir, { HOME: tmp });
  t.after(() => {
    ctrl.client.close();
    try {
      process.kill(JSON.parse(fs.readFileSync(path.join(homeDir, "daemon.json"), "utf8")).pid, "SIGTERM");
    } catch {}
  });
  await configureMockAgents(ctrl, mockBin);
  await ctrl.call("workspaces", { paths: [openProject, ranIn] });
  const { session: worker } = await ctrl.call("start_session", { input: { title: "work", agentId: "pi", cwd: ranIn } });
  const { session: pip } = await ctrl.call("start_session", { input: { persona: true, agentId: "pi" } });
  await ctrl.waitUntil(() => ctrl.sessions.get(pip.id));

  const ext = await ctrl.call("external_token");
  const res = await fetch(ext.url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ext.token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "workspaces_list", arguments: {} } }),
  });
  const { workspaces } = JSON.parse((await res.json()).result.content[0].text);
  assert.deepEqual(
    workspaces.map((w) => [w.path, w.name, w.open, w.sessions]),
    [
      [ranIn, "ran-in", true, 1],
      [openProject, "open-project", true, 0],
    ],
  );
  assert.ok(workspaces[0].lastActive >= worker.createdAt);
  assert.ok(!workspaces.some((w) => w.path === pip.cwd), "the personal agent's folder is not a project");
});

test("present_files pushes a direct side-channel presented_media block into external sessions regardless of engine tool echoing", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-daemon-sidechannel-"));
  const homeDir = path.join(tmp, "home");
  const workDir = path.join(tmp, "work");
  fs.mkdirSync(workDir, { recursive: true });

  const pngPath = path.join(workDir, "shot.png");
  const pngBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mP8z8BQz0AEwDiqAAAWBAQCAQIDAgAAAABJRU5ErkJggg==", "base64");
  fs.writeFileSync(pngPath, pngBytes);

  // Mock ACP engine that calls pipi's real stdio MCP proxy for `present_files`
  // and emits ZERO tool_call / tool_call_update frames — proving presentation
  // rides pipi's own daemon side-channel, completely decoupled from engine echoing.
  const acpBin = path.join(tmp, "mock-acp-silent-mcp.mjs");
  fs.writeFileSync(
    acpBin,
    `#!/usr/bin/env node
import { spawn } from "node:child_process";
import readline from "node:readline";

let mcpSpec = undefined;
const rl = readline.createInterface({ input: process.stdin });

function callPipiMcp(name, args) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const pair of mcpSpec?.env || []) env[pair.name] = pair.value;
    const child = spawn(mcpSpec.command, mcpSpec.args || [], { env, stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      const nl = buf.indexOf("\\n");
      if (nl !== -1) {
        const line = buf.slice(0, nl);
        child.kill();
        resolve(JSON.parse(line));
      }
    });
    child.on("error", reject);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) + "\\n");
  });
}

rl.on("line", async (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } }));
  } else if (msg.method === "session/new") {
    mcpSpec = (msg.params?.mcpServers || []).find((s) => s.name === "pipi");
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "acp-sc-1" } }));
  } else if (msg.method === "session/prompt") {
    await callPipiMcp("present_files", {
      title: "Side-channel gallery",
      files: [
        { path: "shot.png", title: "Captured", caption: "2x2 PNG" },
        { path: "gone.mp4" }
      ]
    });
    console.log(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "acp-sc-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Previews ready." } } }
    }));
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } }));
  }
});
`,
    { mode: 0o755 },
  );

  const ctrl = await openControl(homeDir, { HOME: tmp, PI_CODING_AGENT_DIR: path.join(tmp, "agent") });
  t.after(() => {
    ctrl.client.close();
    try {
      process.kill(JSON.parse(fs.readFileSync(path.join(homeDir, "daemon.json"), "utf8")).pid, "SIGTERM");
    } catch {}
  });
  await ctrl.call("config", {
    allowAgentTools: true,
    agents: [
      {
        id: "silent-acp",
        name: "SilentACP",
        driver: "acp",
        binaryPath: acpBin,
        available: true,
        enabled: true,
        supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
      },
    ],
  });

  const attached = await ctrl.call("attach", {
    session: { cwd: workDir, agentId: "silent-acp", agentName: "SilentACP", driver: "acp", runtimeMode: "full-access", binaryPath: acpBin },
  });
  const sid = attached.session.id;
  ctrl.events.length = 0;
  ctrl.client.send({ type: "in", sessionId: sid, line: JSON.stringify({ id: "p1", type: "prompt", message: "show me" }) });
  await ctrl.waitUntil(() => ctrl.sessions.get(sid)?.status === "idle" && ctrl.events.some((e) => e.type === "out" && e.line?.includes("agent_settled")));

  const records = ctrl.events
    .filter((e) => e.type === "out" && e.sessionId === sid && typeof e.line === "string")
    .map((e) => {
      try {
        return JSON.parse(e.line);
      } catch {
        return undefined;
      }
    })
    .filter(Boolean);

  // 1. Live stream received the first-class `presented_media` block directly from the daemon.
  const mediaUpdate = records.find(
    (r) => r.type === "message_update" && r.assistantMessageEvent?.type === "media_block" && r.assistantMessageEvent.block?.type === "presented_media",
  );
  assert.ok(mediaUpdate, "live stream must receive presented_media directly from daemon side-channel");
  const liveBlock = mediaUpdate.assistantMessageEvent.block;
  assert.equal(liveBlock.title, "Side-channel gallery");
  assert.equal(liveBlock.items.length, 2);
  assert.equal(liveBlock.items[0].path, pngPath);
  assert.equal(liveBlock.items[0].width, 2);
  assert.equal(liveBlock.items[0].height, 2);
  assert.equal(liveBlock.items[0].size, pngBytes.length);
  assert.equal(liveBlock.items[0].exists, true);
  assert.equal(liveBlock.items[0].caption, "2x2 PNG");
  assert.equal(liveBlock.items[1].exists, false);

  // 2. Final assistant message and persisted session JSONL both keep the exact `presented_media` block.
  const assistantEnd = records.find((r) => r.type === "message_end" && r.message?.role === "assistant");
  assert.ok(assistantEnd?.message?.content?.some((b) => b.type === "presented_media" && b.title === "Side-channel gallery"));
  const sessionFile = ctrl.sessions.get(sid)?.file;
  assert.ok(sessionFile && fs.existsSync(sessionFile), "external session file should be written");
  const persisted = fs.readFileSync(sessionFile, "utf8");
  assert.ok(persisted.includes('"type":"presented_media"'), "persisted JSONL must retain presented_media across reloads");
  assert.ok(persisted.includes('"title":"Side-channel gallery"'));
});

test("deep prewarm negotiates ACP standby with preferred model/effort, caches catalog on disk, and guards cloud ACPs", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-daemon-deep-prewarm-"));
  const homeDir = path.join(tmp, "home");
  const workDir = path.join(tmp, "work");
  const workDir2 = path.join(tmp, "work-other");
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(workDir2, { recursive: true });
  const acpLog = path.join(tmp, "acp-events.jsonl");
  const devinLog = path.join(tmp, "devin-events.jsonl");

  const writeAcpFixture = (name, logFile) => {
    const file = path.join(tmp, name);
    const code = `#!/usr/bin/env node
import fs from "node:fs";
const LOG = ${JSON.stringify(logFile)};
const record = (m) => fs.appendFileSync(LOG, JSON.stringify(m) + "\\n");
let seq = 0;
const sessions = new Map();
const MODELS = [{ group: "acme", name: "Acme", options: [
  { value: JSON.stringify(["acme", "fast-1"]), name: "Fast 1" },
  { value: JSON.stringify(["acme", "pro-2"]), name: "Pro 2" },
]}];
const EFFORTS = [
  { value: "low", name: "Low" },
  { value: "medium", name: "Medium" },
  { value: "high", name: "High" },
];
const cfg = (s) => [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: s.model, options: MODELS },
  { id: "reasoning_effort", name: "Reasoning Effort", category: "thought_level", type: "select", currentValue: s.effort, options: EFFORTS },
];
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  buf += c;
  let nl = buf.indexOf("\\n");
  while (nl !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) {
      const msg = JSON.parse(line);
      record({ pid: process.pid, method: msg.method });
      if (msg.method === "initialize") {
        send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 2, agentInfo: { name: "TestACP", version: "1.0" }, agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } } } });
      } else if (msg.method === "session/new") {
        const sid = "acp_" + (++seq);
        const s = { model: JSON.stringify(["acme", "fast-1"]), effort: "medium" };
        sessions.set(sid, s);
        send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: sid, configOptions: cfg(s) } });
      } else if (msg.method === "session/set_config_option") {
        const s = sessions.get(msg.params.sessionId);
        if (s) {
          if (msg.params.configId === "model") s.model = msg.params.value;
          if (msg.params.configId === "reasoning_effort") s.effort = msg.params.value;
        }
        send({ jsonrpc: "2.0", id: msg.id, result: { configOptions: s ? cfg(s) : [] } });
      } else if (msg.id !== undefined) {
        send({ jsonrpc: "2.0", id: msg.id, result: {} });
      }
    }
    nl = buf.indexOf("\\n");
  }
});
`;
    fs.writeFileSync(file, code, { mode: 0o755 });
    return file;
  };

  const localAcpBin = writeAcpFixture("local-acp.mjs", acpLog);
  const devinAcpBin = writeAcpFixture("devin-acp.mjs", devinLog);

  const ctrl = await openControl(homeDir, { HOME: tmp, PIPI_DAEMON_POOL_DELAY_MS: "60000" });
  t.after(() => {
    ctrl.client.close();
    try {
      process.kill(JSON.parse(fs.readFileSync(path.join(homeDir, "daemon.json"), "utf8")).pid, "SIGTERM");
    } catch {}
  });

  await ctrl.call("config", {
    agents: [
      { id: "local-acp", name: "LocalACP", driver: "acp", binaryPath: localAcpBin, available: true },
      { id: "devin", name: "Devin", driver: "acp", binaryPath: devinAcpBin, available: true },
    ],
    sessionChoices: {
      "local-acp": { model: { provider: "acme", id: "pro-2" }, thinkingLevel: "high" },
    },
  });

  const localSpec = {
    cwd: workDir,
    agentId: "local-acp",
    agentName: "LocalACP",
    driver: "acp",
    runtimeMode: "full-access",
    binaryPath: localAcpBin,
  };

  // 1. Explicit `prewarm` deeply negotiates local ACP (initialize + session/new + preferred model/effort)
  // and caches the real catalog on disk + pushes `catalog` to UI clients without announcing a session.
  await ctrl.call("prewarm", { session: localSpec });
  await ctrl.waitUntil(() => {
    const cat = ctrl.events.find((e) => e.type === "catalog" && e.agentId === "local-acp");
    if (!cat) return undefined;
    try {
      const lines = fs.readFileSync(acpLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      return lines.some((l) => l.method === "session/set_config_option") ? cat : undefined;
    } catch {
      return undefined;
    }
  });
  assert.equal(ctrl.sessions.size, 0, "prewarmed standby must remain invisible in session list");

  // 2. Attaching adopts the deeply prewarmed standby: `get_state` ALREADY has preferred model & effort!
  const attached = await ctrl.call("attach", { session: localSpec });
  const sid = attached.session.id;
  ctrl.client.send({ type: "in", sessionId: sid, line: JSON.stringify({ id: "gs1", type: "get_state" }) });
  const gsOut = await ctrl.waitUntil(() => ctrl.events.find((e) => e.type === "out" && e.sessionId === sid && e.line?.includes('"id":"gs1"')));
  const state = JSON.parse(gsOut.line).data;
  assert.equal(state.model?.id, "pro-2", "standby already pre-applied preferred model before attach");
  assert.equal(state.thinkingLevel, "high", "standby already pre-applied preferred thinking level before attach");
  assert.equal(
    ctrl.events.some((e) => e.type === "out" && e.line?.includes("pipi_catalog")),
    false,
    "internal pipi_catalog frames must never leak onto UI out streams",
  );

  // 3. A brand-new cold session in ANOTHER workspace (pool miss) hydrates immediately from `catalog-cache.json`.
  const other = await ctrl.call("attach", { session: { ...localSpec, cwd: workDir2 } });
  const sid2 = other.session.id;
  ctrl.client.send({ type: "in", sessionId: sid2, line: JSON.stringify({ id: "gm2", type: "get_available_models" }) });
  const gmOut = await ctrl.waitUntil(() => ctrl.events.find((e) => e.type === "out" && e.sessionId === sid2 && e.line?.includes('"id":"gm2"')));
  const gmModels = JSON.parse(gmOut.line).data.models;
  assert.ok(gmModels.some((m) => m.id === "pro-2"), "cold cross-workspace session hydrated models from shared disk cache");

  // 4. Cloud ACP (`devin`) prewarm stops at `initialize` — never calls `session/new` until attached.
  await ctrl.call("prewarm", {
    session: {
      cwd: workDir,
      agentId: "devin",
      agentName: "Devin",
      driver: "acp",
      runtimeMode: "full-access",
      binaryPath: devinAcpBin,
    },
  });
  await ctrl.waitUntil(() => {
    try {
      const lines = fs.readFileSync(devinLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      return lines.some((l) => l.method === "initialize") ? lines : undefined;
    } catch {
      return undefined;
    }
  });
  await new Promise((r) => setTimeout(r, 200));
  const devinMethods = fs
    .readFileSync(devinLog, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l).method);
  assert.ok(devinMethods.includes("initialize"), "cloud ACP standby ran initialize");
  assert.equal(devinMethods.includes("session/new"), false, "cloud ACP standby must not create a remote session before attach");

  // 5. A newly connected UI client receives persisted catalogs in `hello`.
  const conn2 = await connectDaemon({ home: homeDir, kind: "ui" });
  t.after(() => conn2.close());
  const hello = await new Promise((resolve) => {
    conn2.onLine((msg) => {
      if (msg.type === "hello") resolve(msg);
    });
  });
  assert.ok(hello.catalogs?.["local-acp"]?.models?.some((m) => m.id === "pro-2"), "hello carries cached agent catalogs");
});
