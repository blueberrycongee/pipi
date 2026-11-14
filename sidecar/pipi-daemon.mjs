// pipi Session Daemon (`sidecar/pipi-daemon.mjs`):
//
//   node sidecar/pipi-daemon.mjs --home <dir>
//
// The process supervisor pipi's control plane hangs on: every coding-agent
// session — the one on screen, parked-away ones, sessions agents started —
// is one record here and one child process this daemon owns. Three surfaces:
//
//   1. A localhost TCP control channel (NDJSON): the app talks to it through
//      `daemon-link.mjs`, the `pipi` CLI connects to it directly. Clients
//      attach to a session and get its stream forwarded (`out`/`err`/`exit`),
//      write into it (`in`), and watch the registry (`session` pushes).
//   2. A localhost HTTP MCP endpoint: every agent process gets a per-session
//      bearer token injected; `tools/call` resolves the caller FROM the token
//      (never from what the agent claims to be) and dispatches the six
//      session tools. The same endpoint serves external clients holding the
//      "external" token minted for other apps.
//   3. The registry: `<home>/sessions.jsonl`, append-only, replayed on boot.
//      Processes found dead on replay mark their session `interrupted` and
//      their initiator is told once it can be reached.
//
// `<home>/daemon.json` holds { pid, controlPort, mcpPort, token, started }.
// The control token guards the TCP channel; session tokens guard MCP calls.
// All listeners bind 127.0.0.1 only.
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { childEnv } from "./env-paths.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LAUNCH_PI = path.join(__dirname, "launch-pi.mjs");
const EXTERNAL_AGENT = path.join(__dirname, "external-agent.mjs");
const PIPI_CLI = path.join(__dirname, "pipi-cli.mjs");

const argv = process.argv.slice(2);
const homeAt = argv.indexOf("--home");
const home = path.resolve(homeAt >= 0 ? argv[homeAt + 1] : `${process.env.HOME || process.env.USERPROFILE || "."}/.pipi`);
const INSTANCE_FILE = path.join(home, "daemon.json");
const REGISTRY_FILE = path.join(home, "sessions.jsonl");
const EXTERNAL_FILE = path.join(home, "external.json");
const CONTROL_TOKEN = crypto.randomBytes(24).toString("hex");

const IDLE_UNLOAD_MS = 20 * 60_000;
const WINDOWLESS_EXIT_MS = Number(process.env.PIPI_DAEMON_IDLE_EXIT_MS) > 0 ? Number(process.env.PIPI_DAEMON_IDLE_EXIT_MS) : 2 * 60_000;
const MAX_LOADED_PER_TREE = 8;
const MAX_PAIR_DEPTH = 8;
const READ_BYTE_BUDGET = 24_000;
const INTERNAL_PREFIX = "d_";
// Engine ids whose driver is the id itself (no roster push needed — e.g. CLI before any app attaches).
const KNOWN_DRIVERS = new Set(["claude", "codex", "opencode", "cursor"]);

// ── Runtime config (pushed by the UI) ────────────────────────────────────────

const config = {
  agents: [], // AgentHarnessStatus[] for agents_list
  overrides: {},
  customAgents: [],
  allowAgentTools: true,
  sendScope: "all", // "all" | "children"
  maxDepth: 2,
  maxRunning: 8,
  worktreeDefault: false,
  linger: false, // default follows the last window: exit 2 min after windows close & runs finish
};

const RUNTIME_RANK = { "approval-required": 0, "auto-accept-edits": 1, "full-access": 2 };
const isRuntimeMode = (mode) => typeof mode === "string" && Object.prototype.hasOwnProperty.call(RUNTIME_RANK, mode);

/** Non-throwing clamp: caps `requested` under `ceiling`; unknown/missing values fall back to `ceiling`. */
const minMode = (ceiling, requested) => {
  const safeCeiling = isRuntimeMode(ceiling) ? ceiling : "approval-required";
  if (!requested || requested === "inherit" || !isRuntimeMode(requested)) return safeCeiling;
  return RUNTIME_RANK[requested] <= RUNTIME_RANK[safeCeiling] ? requested : safeCeiling;
};

/** Strict check: rejects unknown modes and rejects requests above `parent`. */
const clampMode = (parent, requested) => {
  const safeParent = isRuntimeMode(parent) ? parent : "approval-required";
  if (!requested || requested === "inherit") return safeParent;
  if (!isRuntimeMode(requested)) {
    throw new Error(`Unknown runtime mode "${requested}".`);
  }
  if (RUNTIME_RANK[requested] > RUNTIME_RANK[safeParent]) {
    throw new Error(`Child runtime mode "${requested}" cannot exceed parent mode "${safeParent}". Adjust permissions in pipi if needed.`);
  }
  return requested;
};

/** Fits a runtime mode into what a target agent actually supports without ever escalating above `mode`. */
const fitAgentModes = (mode, supportedModes) => {
  if (!Array.isArray(supportedModes) || supportedModes.length === 0) return mode;
  if (supportedModes.includes(mode)) return mode;
  const allowed = supportedModes.filter(isRuntimeMode).sort((a, b) => RUNTIME_RANK[b] - RUNTIME_RANK[a]);
  const under = allowed.find((m) => RUNTIME_RANK[m] <= RUNTIME_RANK[mode]);
  return under ?? allowed[allowed.length - 1] ?? mode;
};

function truncateUtf8(text, maxBytes = READ_BYTE_BUDGET) {
  if (typeof text !== "string" || !text) return { text: text ?? "", truncated: false };
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };
  const suffix = "\n… [truncated]";
  const target = Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8"));
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= target) lo = mid;
    else hi = mid - 1;
  }
  if (lo > 0 && lo < text.length) {
    const code = text.charCodeAt(lo - 1);
    if (code >= 0xd800 && code <= 0xdbff) lo--;
  }
  return { text: text.slice(0, lo) + suffix, truncated: true };
}

// ── Sessions ─────────────────────────────────────────────────────────────────

let seq = 0;
/** @type {Map<string, Session>} */
const sessions = new Map();
const sessionsByFile = new Map(); // file path -> session id
const pairCounts = new Map(); // "from->to" -> delivered messages since last user turn

const newToken = () => crypto.randomBytes(16).toString("hex");
const now = () => Date.now();
const clip = (text, at = 600) => (text.length > at ? `${text.slice(0, at)}…` : text);

function isDescendant(session, ancestorId) {
  const seen = new Set();
  let cur = session?.parentId;
  while (cur && !seen.has(cur)) {
    if (cur === ancestorId) return true;
    seen.add(cur);
    cur = sessions.get(cur)?.parentId;
  }
  return false;
}

function rootOf(session) {
  const seen = new Set([session?.id]);
  let cur = session;
  while (cur?.parentId && !seen.has(cur.parentId) && sessions.get(cur.parentId)) {
    seen.add(cur.parentId);
    cur = sessions.get(cur.parentId);
  }
  return cur ?? session;
}

function ancestorCeiling(session) {
  let ceiling = "full-access";
  const seen = new Set([session?.id]);
  let cur = session?.parentId ? sessions.get(session.parentId) : undefined;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    ceiling = minMode(ceiling, cur.runtimeMode);
    cur = cur.parentId ? sessions.get(cur.parentId) : undefined;
  }
  return ceiling;
}

function descendantsOf(session) {
  const out = [];
  const seen = new Set([session.id]);
  const walk = (s) => {
    for (const candidate of sessions.values()) {
      if (candidate.parentId === s.id && !seen.has(candidate.id)) {
        seen.add(candidate.id);
        out.push(candidate);
        walk(candidate);
      }
    }
  };
  walk(session);
  return out;
}

function sessionInfo(session) {
  return {
    id: session.id,
    title: session.title,
    cwd: session.cwd,
    file: session.file,
    agentId: session.agentId,
    agentName: session.agentName,
    driver: session.driver,
    parentId: session.parentId,
    initiator: session.initiator,
    upstreamInitiator: session.upstreamInitiator,
    runtimeMode: session.runtimeMode,
    worktree: session.worktree,
    status: session.status,
    unread: session.unread,
    loaded: session.loaded,
    depth: session.depth,
    createdAt: session.createdAt,
    lastActive: session.lastActive,
  };
}

const persistQueue = [];
let persistTimer;
function persist(record) {
  persistQueue.push(JSON.stringify(record));
  if (!persistTimer) {
    persistTimer = setTimeout(() => {
      persistTimer = undefined;
      const lines = `${persistQueue.splice(0).join("\n")}\n`;
      // The registry carries per-session bearer tokens: owner-read only.
      fsp.appendFile(REGISTRY_FILE, lines, { mode: 0o600 }).catch(() => {});
    }, 120);
    persistTimer.unref?.();
  }
}

/** Queued deliveries are registry state too: a restart hands them over, it does not lose them. */
function persistDeliveries(session) {
  persist({ type: "queue", to: session.id, items: session.deliverQueue.map((item) => ({ text: item.text, initiator: item.initiator })) });
}

function pushSession(session) {
  const info = sessionInfo(session);
  persist({ type: "session_update", id: session.id, info });
  for (const conn of controlClients) send(conn, { type: "session", session: info });
}

function touch(session) {
  session.lastActive = now();
}

function createSession(spec) {
  const parent = spec.parentId ? sessions.get(spec.parentId) : undefined;
  const rawMode = isRuntimeMode(spec.runtimeMode) ? spec.runtimeMode : parent?.runtimeMode || "full-access";
  const runtimeMode = parent ? minMode(minMode(ancestorCeiling({ parentId: parent.id }), parent.runtimeMode), rawMode) : rawMode;
  const session = {
    id: `s_${(++seq).toString(36)}${crypto.randomBytes(3).toString("hex")}`,
    token: newToken(),
    title: spec.title || "New session",
    cwd: spec.cwd || process.cwd(),
    file: spec.file,
    agentId: spec.agentId || "pi",
    agentName: spec.agentName || spec.agentId || "Pi",
    driver: spec.driver || (spec.agentId === "pi" || !spec.agentId ? "pi" : spec.agentId),
    parentId: parent?.id,
    initiator: spec.initiator ?? (parent ? parent.id : "user"),
    upstreamInitiator: spec.initiator ?? (parent ? parent.id : "user"),
    runtimeMode,
    worktree: spec.worktree,
    status: "idle",
    unread: false,
    loaded: false,
    depth: parent ? parent.depth + 1 : 0,
    createdAt: now(),
    lastActive: now(),
    launch: {
      binaryPath: spec.binaryPath,
      extraArgs: spec.extraArgs,
      customAgent: spec.customAgent,
    },
    attached: new Set(),
    proc: undefined,
    starting: undefined,
    internalPending: new Map(),
    pendingDialogs: new Map(),
    deliverQueue: [],
    lastAnswer: "",
    pendingAnswer: "",
    blockedNotified: false,
    suppressStopDelivery: false,
    exitExpected: false,
    waiters: [],
  };
  sessions.set(session.id, session);
  if (session.file) sessionsByFile.set(session.file, session.id);
  persist({ type: "session", info: { ...sessionInfo(session), token: session.token }, launch: session.launch });
  pushSession(session);
  return session;
}

function setFile(session, file) {
  if (!file || session.file === file) return;
  if (session.file && sessionsByFile.get(session.file) === session.id) sessionsByFile.delete(session.file);
  session.file = file;
  sessionsByFile.set(file, session.id);
  persist({ type: "session_update", id: session.id, info: { file } });
  pushSession(session);
}

function setStatus(session, status) {
  if (session.status === status) return;
  session.status = status;
  if (status !== "blocked") session.blockedNotified = false;
  pushSession(session);
  resolveWaiters(session);
  if (status !== "working" && status !== "blocked") checkWindowlessExit();
}

function resolveWaiters(session) {
  if (session.status === "working" || session.status === "blocked") return;
  const waiters = session.waiters.splice(0);
  for (const waiter of waiters) {
    try {
      waiter({ status: session.status, answer: session.lastAnswer });
    } catch {}
  }
}

// ── Process hosting ──────────────────────────────────────────────────────────

function launchArgs(session) {
  const mcpUrl = `http://127.0.0.1:${mcpPort}/mcp`;
  const tools = config.allowAgentTools && supportsTools(session.driver) ? { orchestratorUrl: mcpUrl, orchestratorToken: session.token } : {};
  const agentCfg = config.agents.find((a) => a.id === session.agentId);
  const binaryPath = session.launch.binaryPath ?? config.overrides?.[session.agentId]?.binaryPath ?? agentCfg?.binaryPath;
  const extraArgs = session.launch.extraArgs ?? config.overrides?.[session.agentId]?.extraArgs ?? agentCfg?.extraArgs;
  const customAgent = session.launch.customAgent ?? config.customAgents?.find((c) => c.id === session.agentId) ?? agentCfg?.customAgent;
  if (session.driver === "pi") {
    return {
      command: process.execPath,
      args: [
        LAUNCH_PI,
        JSON.stringify({
          binaryPath,
          runtimeMode: session.runtimeMode,
          extraArgs,
          ...tools,
        }),
      ],
      cwd: session.cwd,
    };
  }
  return {
    command: process.execPath,
    args: [
      EXTERNAL_AGENT,
      JSON.stringify({
        cwd: session.cwd,
        agentId: session.agentId,
        driver: session.driver,
        runtimeMode: session.runtimeMode,
        binaryPath,
        extraArgs,
        customAgent,
        ...tools,
      }),
    ],
    cwd: session.cwd,
  };
}

let internalSeq = 0;
function daemonCommand(session, type, data) {
  const id = `${INTERNAL_PREFIX}${++internalSeq}`;
  return new Promise((resolve) => {
    const proc = session.proc;
    if (!proc || proc.killed) {
      resolve(undefined);
      return;
    }
    const timer = setTimeout(() => {
      if (session.internalPending.delete(id)) resolve(undefined);
    }, 60_000);
    timer.unref?.();
    session.internalPending.set(id, { resolve, timer });
    try {
      proc.stdin.write(`${JSON.stringify({ id, type, ...data })}\n`);
    } catch {
      clearTimeout(timer);
      session.internalPending.delete(id);
      resolve(undefined);
    }
  });
}

/**
 * A line headed for the process is clamped to the session's own ceiling: nobody —
 * not a user-typed slash command, not a steering agent — raises it past what the
 * record says (the ceiling itself only moves through `set_runtime_mode`).
 */
function clampModeLine(session, line) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return line;
  }
  if (!record || typeof record !== "object") return line;
  const ceiling = minMode(ancestorCeiling(session), session.runtimeMode);
  if (record.type === "set_runtime_mode") {
    const clamped = minMode(ceiling, record.mode);
    return clamped === record.mode ? line : JSON.stringify({ ...record, mode: clamped });
  }
  if ((record.type === "prompt" || record.type === "steer" || record.type === "follow_up") && typeof record.message === "string") {
    const trimmed = record.message.trimStart();
    const match = trimmed.match(/^\/pipi-runtime-mode(?:\s+(\S+))?([\s\S]*)$/);
    if (match) {
      const clamped = minMode(ceiling, match[1]);
      return JSON.stringify({ ...record, message: `/pipi-runtime-mode ${clamped}` });
    }
  }
  return line;
}

function writeLine(session, rawLine) {
  const proc = session.proc;
  if (!proc || proc.killed) return false;
  const line = clampModeLine(session, rawLine);
  try {
    proc.stdin.write(`${line}\n`);
    return true;
  } catch {
    return false;
  }
}

function writePrompt(session, text, initiator) {
  session.initiator = initiator;
  session.turnAnswer = "";
  session.lastPromptText = text;
  session.turnFailed = false;
  const sent = writeLine(session, JSON.stringify({ id: `${INTERNAL_PREFIX}p${++internalSeq}`, type: "prompt", message: text }));
  if (sent) setStatus(session, "working");
  return sent;
}

/** Spawns (or revives) the session's agent process (single-flight across concurrent callers). */
async function startProcess(session) {
  if (session.proc && !session.proc.killed) return true;
  if (session.starting) return session.starting;
  const p = (async () => {
    const spec = launchArgs(session);
    const env = { ...childEnv(), PIPI_SESSION_ID: session.id };
    delete env.PIPI_ORCHESTRATOR_URL;
    delete env.PIPI_ORCHESTRATOR_TOKEN;
    delete env.PIPI_RUNTIME_MODE;
    delete env.PIPI_IS_SUBAGENT;
    let child;
    try {
      child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      failSession(session, `could not start ${session.agentName}: ${error.message}`);
      return false;
    }
    session.proc = child;
    session.loaded = true;
    session.internalPending = new Map();
    session.outBuf = "";
    session.errBuf = "";
    session.spawnError = "";
    session.lastError = "";
    session.exitExpected = false;
    touch(session);
    pushSession(session);

    child.stdin.on("error", () => {});
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      session.outBuf += chunk;
      let at = session.outBuf.indexOf("\n");
      while (at !== -1) {
        const line = session.outBuf.slice(0, at).replace(/\r$/, "");
        session.outBuf = session.outBuf.slice(at + 1);
        if (line) handleChildRecord(session, line);
        at = session.outBuf.indexOf("\n");
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      session.errBuf += chunk;
      if (session.errBuf.length > 200_000) session.errBuf = session.errBuf.slice(-100_000);
      session.lastError = session.errBuf.slice(-4_000);
      for (const conn of session.attached) send(conn, { type: "err", sessionId: session.id, text: chunk });
    });
    child.on("error", (error) => {
      session.lastError = error.message;
    });
    child.on("exit", (code, signal) => {
      if (session.proc === child) session.proc = undefined;
      session.loaded = false;
      session.pendingDialogs.clear();
      const expected = session.exitExpected;
      session.exitExpected = false;
      for (const entry of session.internalPending.values()) {
        clearTimeout(entry.timer);
        entry.resolve(undefined);
      }
      session.internalPending.clear();
      for (const conn of session.attached) send(conn, { type: "exit", sessionId: session.id, code, signal });
      onSessionExit(session, code, signal, expected);
    });

    // Reopen the session's file before it answers its first commands.
    if (session.file) {
      await daemonCommand(session, "switch_session", { sessionPath: session.file });
    }
    if (!session.proc || session.proc.killed) return false;
    void discoverFile(session);
    return true;
  })();
  session.starting = p;
  try {
    return await p;
  } finally {
    if (session.starting === p) session.starting = undefined;
  }
}

/** Asks the process which session file it is on — the way unattached sessions get theirs. */
async function discoverFile(session) {
  for (let attempt = 0; attempt < 6 && !session.file; attempt++) {
    const state = await daemonCommand(session, "get_state");
    if (state?.sessionFile) {
      setFile(session, state.sessionFile);
      return;
    }
    if (!session.proc || session.proc.killed) return;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

function killProcess(session) {
  const proc = session.proc;
  if (!proc) return;
  session.exitExpected = true;
  try {
    proc.stdin.end();
  } catch {}
  setTimeout(() => {
    try {
      proc.kill("SIGKILL");
    } catch {}
  }, 1500).unref?.();
}

function failSession(session, reason) {
  session.lastError = reason;
  const suppress = session.suppressStopDelivery;
  session.suppressStopDelivery = false;
  if (session.initiator && session.initiator !== "user" && session.initiator !== session.id) {
    if (!suppress) deliverToInitiator(session, `${session.title} (${session.agentName}) failed: ${clip(reason, 300)}`, "failed");
  } else if (session.attached.size === 0) {
    session.unread = true;
  }
  setStatus(session, "failed");
  pushSession(session);
}

function onSessionExit(session, code, signal, expected) {
  session.loaded = false;
  pushSession(session);
  if (session.status === "working" || session.status === "blocked") {
    const why = session.lastError || `exited (${code ?? signal ?? "?"})`;
    const suppress = session.suppressStopDelivery;
    session.suppressStopDelivery = false;
    const initiator = session.initiator;
    session.initiator = undefined;
    if (initiator && initiator !== "user" && initiator !== session.id) {
      if (!suppress) deliverToInitiator(session, `${session.title} (${session.agentName}) stopped mid-run: ${clip(why, 300)}`, "failed", initiator);
    } else if (session.attached.size === 0) {
      session.unread = true;
    }
    session.status = "failed";
    pushSession(session);
    resolveWaiters(session);
    checkWindowlessExit();
    return;
  }
  session.suppressStopDelivery = false;
  if (!expected && session.attached.size === 0) {
    // An idle process that died on its own: the session survives on its file;
    // the next message revives it.
    session.status = "interrupted";
    pushSession(session);
  }
  resolveWaiters(session);
  checkWindowlessExit();
}

// ── Wire-level routing ───────────────────────────────────────────────────────

function handleChildRecord(session, line) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    record = undefined;
  }
  if (record && typeof record.id === "string" && record.id.startsWith(INTERNAL_PREFIX) && record.type === "response") {
    const pending = session.internalPending?.get(record.id);
    if (pending) {
      session.internalPending.delete(record.id);
      clearTimeout(pending.timer);
      pending.resolve(record.success === false ? undefined : record.data);
    }
    return; // daemon-internal chatter never reaches clients
  }
  if (record) observeRecord(session, record);
  for (const conn of session.attached) send(conn, { type: "out", sessionId: session.id, line });
}

function observeRecord(session, record) {
  touch(session);
  switch (record.type) {
    case "agent_start":
      session.turnAnswer = "";
      session.pendingAnswer = "";
      session.turnFailed = false;
      session.pendingDialogs.clear();
      setStatus(session, "working");
      break;
    case "message_end": {
      const message = record.message;
      if (message?.role === "user") learnTitle(session, message);
      if (message?.role === "assistant") {
        session.turnFailed = message.stopReason === "error";
        if (message.stopReason === "error" && typeof message.errorMessage === "string" && message.errorMessage.trim()) {
          session.pendingAnswer = message.errorMessage.trim();
        }
      }
      if (message?.role === "assistant" && message.stopReason === "stop") {
        const text = Array.isArray(message.content)
          ? message.content
              .filter((block) => block?.type === "text" && typeof block.text === "string")
              .map((block) => block.text)
              .join("\n")
          : "";
        if (text.trim()) session.pendingAnswer = text;
      }
      break;
    }
    case "extension_ui_request":
      if (typeof record.id === "string") {
        if (record.method !== "notify" && record.method !== "setStatus" && record.method !== "setWidget" && record.method !== "setTitle" && record.method !== "set_editor_text") {
          session.pendingDialogs.set(record.id, record);
          setStatus(session, "blocked");
          notifyBlocked(session);
        }
      }
      break;
    case "agent_settled":
      onSettled(session, record);
      break;
    default:
      break;
  }
}

/** A session nobody named takes its title from its first user message — what the session list shows. */
function learnTitle(session, message) {
  if (session.title && session.title !== "New session") return;
  const text = Array.isArray(message?.content)
    ? message.content
        .filter((block) => block?.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join(" ")
    : typeof message?.content === "string"
      ? message.content
      : "";
  if (text.trimStart().startsWith("<pipi-message")) return;
  const title = clip(text.replace(/\s+/g, " ").trim(), 48);
  if (!title) return;
  session.title = title;
  persist({ type: "session_update", id: session.id, info: { title } });
  pushSession(session);
}

function observeWrite(session, line) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return;
  }
  touch(session);
  if (record.type === "extension_ui_response" && typeof record.id === "string") {
    session.pendingDialogs.delete(record.id);
    if (session.pendingDialogs.size === 0 && session.status === "blocked") setStatus(session, "working");
    return;
  }
  if (record.type === "prompt") {
    // A prompt written by an attached client (the UI) or the daemon itself.
    if (!String(record.id ?? "").startsWith(INTERNAL_PREFIX)) {
      session.initiator = "user";
      session.upstreamInitiator = "user";
      session.turnAnswer = "";
      pairCounts.forEach((_, key) => {
        if (key.endsWith(`->${session.id}`) || key.startsWith(`${session.id}->`)) pairCounts.delete(key);
      });
    }
  }
}

function onSettled(session, record) {
  session.pendingDialogs.clear();
  const aborted = record.aborted === true || record.outcome === "aborted";
  const failed = !aborted && (session.turnFailed === true || record.outcome === "error" || Boolean(record.errorMessage));
  session.turnFailed = false;
  const suppress = session.suppressStopDelivery;
  session.suppressStopDelivery = false;
  const answer = session.pendingAnswer || session.turnAnswer || (typeof record.errorMessage === "string" ? record.errorMessage : "") || "";
  session.lastAnswer = answer;
  session.pendingAnswer = "";
  if (!session.file) void discoverFile(session);
  const initiator = session.initiator;
  session.initiator = undefined;
  if (aborted) {
    setStatus(session, "idle");
    // A run stopped on purpose tells the session that asked for it — unless that ancestor was stopped too.
    if (!suppress && initiator && initiator !== "user" && initiator !== session.id) {
      deliverToInitiator(session, `${session.title} (${session.agentName}) was stopped.`, "failed", initiator);
    }
    flushDeliveries(session);
    return;
  }
  if (failed) {
    setStatus(session, "failed");
    if (initiator === "user" || initiator === undefined) {
      if (session.attached.size === 0) {
        session.unread = true;
        pushSession(session);
      }
    } else if (initiator !== session.id) {
      deliverToInitiator(session, answer || `${session.title} (${session.agentName}) failed.`, "failed", initiator);
    }
    flushDeliveries(session);
    return;
  }
  setStatus(session, "idle");
  if (initiator === "user" || initiator === undefined) {
    if (session.attached.size === 0) {
      session.unread = true;
      pushSession(session);
    }
  } else if (initiator !== session.id) {
    deliverToInitiator(session, answer || "(finished without a reply)", "idle", initiator);
  }
  flushDeliveries(session);
}

// ── Delivery ─────────────────────────────────────────────────────────────────

const ANSWER_BUDGET = 6000;
const envelope = (session, text, status) => {
  const body =
    text.length > ANSWER_BUDGET
      ? `${clip(text, ANSWER_BUDGET)}\n\n… (truncated — read the full reply with session_read, session "${session.id}")`
      : text;
  return `<pipi-message from="${session.id}" title="${xml(session.title)}" agent="${xml(session.agentName)}" status="${status}">\n${body}\n</pipi-message>`;
};
const xml = (text) => String(text).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]);

/**
 * When `from` hands a finished/blocked/interrupted report back to `target`, `target`'s
 * woken turn answers to `target`'s own upstream requester (the user or an ancestor
 * coordinator), never bouncing straight back to `from`. If `target` wants another
 * round with `from`, it calls `session_send`.
 */
function returnInitiatorFor(target, fromId) {
  const up = target.upstreamInitiator ?? target.parentId ?? "user";
  if (up === fromId) return target.parentId && target.parentId !== fromId ? target.parentId : "user";
  return up;
}

/** Sends `from`'s finished answer back to the session (or marks unread for the user). */
function deliverToInitiator(from, text, status, explicitTarget) {
  const targetId = explicitTarget ?? from.initiator;
  if (!targetId || targetId === "user") {
    if (!explicitTarget) {
      from.unread = true;
      pushSession(from);
    }
    return;
  }
  const target = sessions.get(targetId);
  persist({ type: "delivery", from: from.id, to: targetId, status, chars: text.length, at: now() });
  if (!target) return;

  const key = `${from.id}->${target.id}`;
  const depth = (pairCounts.get(key) ?? 0) + 1;
  pairCounts.set(key, depth);
  if (depth > MAX_PAIR_DEPTH) {
    // Ping-pong guard: hand the exchange to the person at the tree's root.
    const root = rootOf(from);
    root.unread = true;
    pushSession(root);
    return;
  }
  deliverMessage(target, envelope(from, text, status), returnInitiatorFor(target, from.id));
}

/** Puts a `<pipi-message>` into `target`: now if it can take it, queued otherwise. */
function deliverMessage(target, text, initiator) {
  if (target.status === "failed" || target.status === "interrupted") {
    target.deliverQueue.push({ text, initiator });
    persistDeliveries(target);
    void revive(target);
    return;
  }
  if (target.status === "working" || target.status === "blocked") {
    target.deliverQueue.push({ text, initiator });
    persistDeliveries(target);
    return;
  }
  if (!target.loaded) {
    target.deliverQueue.push({ text, initiator });
    persistDeliveries(target);
    void revive(target);
    return;
  }
  writePrompt(target, text, initiator);
}

async function revive(session) {
  const ok = await startProcess(session);
  if (!ok) {
    session.deliverQueue.length = 0;
    persistDeliveries(session);
    resolveWaiters(session);
    return;
  }
  flushDeliveries(session);
}

function flushDeliveries(session) {
  if (!session.loaded || session.status === "working" || session.status === "blocked") return;
  const queue = session.deliverQueue.splice(0);
  if (!queue.length) return;
  persistDeliveries(session);
  const explicit = [...queue].reverse().find((item) => item.initiator && item.initiator !== "user");
  const initiator = explicit ? explicit.initiator : queue[queue.length - 1].initiator;
  const text = queue.map((item) => item.text).join("\n\n");
  writePrompt(session, text, initiator);
}

function notifyBlocked(session) {
  if (session.blockedNotified) return;
  session.blockedNotified = true;
  const initiator = session.initiator;
  if (!initiator || initiator === "user" || initiator === session.id) {
    // Blocked turns for the user surface on the session row itself when unattached.
    if (session.attached.size === 0) {
      session.unread = true;
      pushSession(session);
    }
    return;
  }
  const target = sessions.get(initiator);
  if (target) {
    deliverMessage(
      target,
      envelope(session, `${session.title} (${session.agentName}) is waiting for approval — open the session in pipi to continue.`, "blocked"),
      returnInitiatorFor(target, session.id),
    );
  }
}

// ── The six session tools ────────────────────────────────────────────────────

const SESSION_TOOLS = [
  {
    name: "agents_list",
    description: "List the coding agents pipi can start, and which of them can themselves drive sessions.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "sessions_list",
    description: "List sessions: your own session tree by default; `scope` widens to your project or to everything.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["tree", "project", "all"], description: "tree (default): your session tree. project: sessions in your workspace. all: every session." },
      },
    },
  },
  {
    name: "session_read",
    description: "Read a session: its state, its last answer, and when it last worked. Worktree sessions include a diff stat; `verbose` returns recent messages, `cursor` pages back.",
    inputSchema: {
      type: "object",
      properties: {
        session: { type: "string", description: "Session id." },
        verbose: { type: "boolean", description: "Include the recent messages (user/assistant text), newest last." },
        cursor: { type: "number", description: "Page cursor from a previous read — returns messages older than it." },
      },
      required: ["session"],
    },
  },
  {
    name: "session_send",
    description: "Send a message to a session. A working session queues it; an idle one takes it as follow-up; a finished or interrupted one is revived and continues.",
    inputSchema: {
      type: "object",
      properties: {
        session: { type: "string" },
        message: { type: "string" },
        steer: { type: "boolean", description: "Deliver mid-run as steering instead of queuing for after the turn." },
      },
      required: ["session", "message"],
    },
  },
  {
    name: "session_start",
    description: "Start a new session under yours with a first task. It runs on its own; its answer is delivered back to you when it finishes. Never wait on it.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "What this session is for, in a few words." },
        agent: { type: "string", description: "Agent id from agents_list." },
        cwd: { type: "string", description: "Working directory (defaults to yours)." },
        model: { type: "string", description: "Model as provider/modelId (defaults to the agent's current)." },
        thinking: { type: "string", description: "Thinking level: off, minimal, low, medium, high, xhigh." },
        message: { type: "string", description: "The first task, self-contained." },
        worktree: { type: "boolean", description: "Give it an isolated git worktree." },
        runtimeMode: { type: "string", enum: ["inherit", "approval-required", "auto-accept-edits", "full-access"] },
        detached: { type: "boolean", description: "Start it without a parent: it answers to the user, not to you." },
      },
      required: ["title", "agent", "message"],
    },
  },
  {
    name: "session_stop",
    description: "Abort a session's current run, along with every session still working under it.",
    inputSchema: { type: "object", properties: { session: { type: "string", description: "Session id (yours or a descendant's)." } }, required: ["session"] },
  },
];

const supportsTools = (driver) => driver !== "opencode" && driver !== "cursor";

function findSession(ref) {
  if (!ref) return undefined;
  const direct = sessions.get(ref);
  if (direct) return direct;
  const byFile = sessionsByFile.get(String(ref));
  return byFile ? sessions.get(byFile) : undefined;
}

function checkScope(caller, target) {
  if (!target) return "no such session";
  if (!caller) return undefined; // user/external authority sees everything
  if (caller.id === target.id) return undefined;
  if (config.sendScope === "children" && !isDescendant(target, caller.id)) {
    return `session_send is limited to sessions you started (sendScope: children)`;
  }
  return undefined;
}

function budgetMessages(messages, maxBytes = READ_BYTE_BUDGET) {
  if (!Array.isArray(messages) || !messages.length) return { messages: [], truncated: false };
  const picked = [];
  let used = 0;
  let truncated = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const item = messages[i];
    const perMsgCap = Math.max(512, Math.min(8_000, maxBytes - used));
    const clipped = truncateUtf8(String(item?.text ?? ""), perMsgCap);
    const entry = { ...item, text: clipped.text };
    const bytes = Buffer.byteLength(JSON.stringify(entry), "utf8");
    if (used + bytes > maxBytes && picked.length > 0) {
      truncated = true;
      break;
    }
    if (clipped.truncated) truncated = true;
    used += bytes;
    picked.push(entry);
  }
  picked.reverse();
  return { messages: picked, truncated };
}

async function callSessionTool(caller, name, args = {}) {
  switch (name) {
    case "agents_list": {
      const agents = config.agents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        available: agent.available !== false,
        enabled: agent.enabled !== false,
        driver: agent.driver,
        statusText: agent.statusText,
        supportsTools: supportsTools(agent.driver),
        models: agent.models,
      }));
      return {
        agents,
        runtimeModes: ["approval-required", "auto-accept-edits", "full-access"],
        caller: caller
          ? {
              id: caller.id,
              title: caller.title,
              agent: caller.agentName,
              cwd: caller.cwd,
              file: caller.file,
              parentId: caller.parentId,
              runtimeMode: caller.runtimeMode,
              depth: caller.depth,
            }
          : { authority: "user" },
      };
    }
    case "sessions_list": {
      // Default is the caller's own tree; "project" widens to its workspace, "all" to every session.
      const scope = args.scope === "project" ? "project" : args.scope === "all" ? "all" : "tree";
      const visible = !caller
        ? [...sessions.values()]
        : scope === "all"
          ? [...sessions.values()]
          : scope === "project"
            ? [...sessions.values()].filter((s) => s.cwd === caller.cwd || rootOf(s).cwd === caller.cwd)
            : sessionsInTree(caller);
      return {
        sessions: visible.map((s) => sessionInfo(s)),
        self: caller?.id,
        scope,
      };
    }
    case "session_read": {
      const target = findSession(args.session);
      // Reads are unrestricted: a session may look at any session's state.
      if (!target) throw new Error("no such session");
      const info = sessionInfo(target);
      const extra = {};
      let anyTruncated = false;
      if (target.worktree?.path) {
        const diff = await worktreeDiff(target.worktree.path).catch(() => undefined);
        if (diff) extra.diff = diff;
      }
      if (args.verbose || args.cursor !== undefined) {
        const page = await readSessionFile(target.file, { limit: 20, before: args.cursor }).catch(() => undefined);
        if (page) {
          const budgeted = budgetMessages(page.messages, READ_BYTE_BUDGET);
          extra.messages = budgeted.messages;
          if (budgeted.truncated) anyTruncated = true;
          if (page.nextCursor !== undefined) extra.cursor = page.nextCursor;
        }
      }
      if (!target.loaded && target.file) {
        const last = await readSessionFile(target.file).catch(() => undefined);
        const answer = truncateUtf8(target.lastAnswer || last?.answer || "", READ_BYTE_BUDGET);
        if (answer.truncated) anyTruncated = true;
        return {
          ...info,
          ...extra,
          lastAnswer: answer.text,
          summary: last?.summary,
          messageCount: last?.count,
          ...(anyTruncated ? { truncated: true } : {}),
        };
      }
      const answer = truncateUtf8(target.lastAnswer || "", READ_BYTE_BUDGET);
      if (answer.truncated) anyTruncated = true;
      return { ...info, ...extra, lastAnswer: answer.text, ...(anyTruncated ? { truncated: true } : {}) };
    }
    case "session_send": {
      const target = findSession(args.session);
      const scoped = checkScope(caller, target);
      if (scoped) throw new Error(scoped);
      if (!args.message?.trim()) throw new Error("message is empty");
      if (caller) {
        const key = `${caller.id}->${target.id}`;
        const depth = (pairCounts.get(key) ?? 0) + 1;
        pairCounts.set(key, depth);
        if (depth > MAX_PAIR_DEPTH) {
          const root = rootOf(caller);
          root.unread = true;
          pushSession(root);
          throw new Error("exchange limit reached between these two sessions — ask the user to continue");
        }
      }
      const sender = caller?.id ?? "user";
      target.upstreamInitiator = sender;
      const text = envelope(caller ?? { id: "user", title: "you", agentName: "you" }, args.message, caller?.status ?? "idle");
      if (args.steer && (target.status === "working" || target.status === "blocked")) {
        const sent = writeLine(
          target,
          JSON.stringify({ id: `${INTERNAL_PREFIX}p${++internalSeq}`, type: "prompt", message: text, streamingBehavior: "steer" }),
        );
        if (!sent) throw new Error(`${target.title} is not loaded`);
        // The steered turn answers to whoever steered it.
        target.initiator = sender;
        return { id: target.id, steered: true };
      }
      const queued = target.status === "working" || target.status === "blocked";
      deliverMessage(target, text, sender);
      return { id: target.id, queued };
    }
    case "session_start": {
      const agent = config.agents.find((a) => a.id === args.agent) ?? config.agents.find((a) => a.name === args.agent);
      if (!agent) throw new Error(`unknown agent "${args.agent}" — call agents_list`);
      if (agent.available === false || agent.enabled === false) throw new Error(`${agent.name} is not available`);
      const detached = args.detached === true || !caller;
      if (caller && !detached && caller.depth + 1 > config.maxDepth) {
        throw new Error(`child session depth ${caller.depth + 1} exceeds the limit (${config.maxDepth})`);
      }
      const root = caller ? rootOf(caller) : undefined;
      const running = root ? [root, ...descendantsOf(root)].filter((s) => s.status === "working" || s.status === "blocked").length : 0;
      if (root && running >= config.maxRunning) {
        throw new Error(`session tree already runs ${running} sessions (limit ${config.maxRunning})`);
      }
      const callerCeiling = caller ? minMode(ancestorCeiling(caller), caller.runtimeMode) : undefined;
      const rawMode = caller
        ? clampMode(callerCeiling, args.runtimeMode)
        : !args.runtimeMode || args.runtimeMode === "inherit"
          ? "full-access"
          : clampMode("full-access", args.runtimeMode);
      const mode = fitAgentModes(rawMode, agent.supportedRuntimeModes);
      const cwd = args.cwd || caller?.cwd || process.cwd();
      const wantWorktree = args.worktree === true || (args.worktree === undefined && config.worktreeDefault === true);
      const session = createSession({
        title: args.title,
        agentId: agent.id,
        agentName: agent.name,
        driver: agent.driver,
        cwd,
        parentId: detached ? undefined : caller?.id,
        initiator: detached ? "user" : caller?.id ?? "user",
        runtimeMode: mode,
        binaryPath: agent.binaryPath ?? config.overrides?.[agent.id]?.binaryPath,
        extraArgs: agent.extraArgs ?? config.overrides?.[agent.id]?.extraArgs,
        customAgent: agent.customAgent ?? config.customAgents?.find((c) => c.id === agent.id),
      });
      if (args.message) setStatus(session, "working");
      // The id answers at once; spawning, model picks and the first prompt run in the
      // background — a failed start lands on the session (and its initiator), not here.
      void (async () => {
        if (wantWorktree) {
          try {
            const worktree = await createWorktree(cwd, args.title);
            session.cwd = worktree.path;
            session.worktree = worktree;
            pushSession(session);
          } catch (error) {
            failSession(session, `could not create a worktree: ${error.message}`);
            return;
          }
        }
        const ok = await startProcess(session);
        if (!ok) return;
        if (session.status !== "working" && args.message) return;
        if (typeof args.model === "string" && args.model.includes("/")) {
          const slash = args.model.indexOf("/");
          void daemonCommand(session, "set_model", { provider: args.model.slice(0, slash), modelId: args.model.slice(slash + 1) });
        }
        if (typeof args.thinking === "string" && args.thinking) {
          void daemonCommand(session, "set_thinking_level", { level: args.thinking });
        }
        const text = envelope(caller ?? { id: "user", title: "you", agentName: "you" }, args.message, "idle");
        writePrompt(session, text, caller?.id ?? "user");
      })();
      return { id: session.id };
    }
    case "session_stop": {
      const target = findSession(args.session);
      if (!target) throw new Error("no such session");
      if (caller && target.id !== caller.id && !isDescendant(target, caller.id)) {
        throw new Error("session_stop only reaches your own subtree");
      }
      await stopTree(target);
      return { id: target.id, stopped: true };
    }
    default:
      throw new Error(`unknown tool "${name}"`);
  }
}

function sessionsInTree(caller) {
  const root = rootOf(caller);
  return [root, ...descendantsOf(root)];
}

async function stopTree(session) {
  const targets = [session, ...descendantsOf(session)];
  const targetIds = new Set(targets.map((t) => t.id));
  for (const target of targets) {
    if (target.deliverQueue.length) {
      target.deliverQueue.length = 0;
      persistDeliveries(target);
    }
    if (target.initiator && targetIds.has(target.initiator)) {
      // Stopping a tree together must not wake an ancestor in that same stopped tree.
      target.suppressStopDelivery = true;
    }
  }
  await Promise.all(
    targets.map(async (target) => {
      if (target.status !== "working" && target.status !== "blocked") return;
      if (!target.proc || target.proc.killed) {
        const suppress = target.suppressStopDelivery;
        target.suppressStopDelivery = false;
        const initiator = target.initiator;
        target.initiator = undefined;
        setStatus(target, "idle");
        if (!suppress && initiator && initiator !== "user" && initiator !== target.id) {
          deliverToInitiator(target, `${target.title} (${target.agentName}) was stopped.`, "failed", initiator);
        }
        return;
      }
      for (const dialogId of [...target.pendingDialogs.keys()]) {
        writeLine(target, JSON.stringify({ type: "extension_ui_response", id: dialogId, cancelled: true }));
      }
      target.pendingDialogs.clear();
      await daemonCommand(target, "abort", {});
    }),
  );
}

// ── Session-file reading (for `session_read` on unloaded sessions) ───────────

async function readSessionFile(file, page) {
  const raw = await fsp.readFile(file ?? "", "utf8").catch(() => "");
  const lines = raw.split("\n").filter(Boolean);
  let answer;
  let firstUser;
  let count = 0;
  const messages = [];
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== "message") continue;
    count++;
    const message = entry.message;
    if (message?.role === "user" && !firstUser) {
      firstUser = typeof message.content === "string" ? message.content : message.content?.find?.((b) => b?.type === "text")?.text;
    }
    if (message?.role === "assistant" && Array.isArray(message.content)) {
      const text = message.content
        .filter((b) => b?.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("\n");
      if (text.trim()) {
        answer = text;
        messages.push({ role: "assistant", text: clip(text, 4000) });
      }
    } else if (page && message?.role === "user") {
      const text = typeof message.content === "string" ? message.content : message.content?.find?.((b) => b?.type === "text")?.text;
      if (typeof text === "string" && text.trim() && !text.startsWith("<pipi-message")) {
        messages.push({ role: "user", text: clip(text, 1000) });
      }
    }
  }
  if (!page) return { answer, summary: clip(firstUser ?? "", 120), count };
  const end = typeof page.before === "number" ? Math.min(page.before, messages.length) : messages.length;
  const start = Math.max(0, end - (page.limit ?? 20));
  return {
    answer,
    summary: clip(firstUser ?? "", 120),
    count,
    messages: messages.slice(start, end),
    nextCursor: start > 0 ? start : undefined,
  };
}

async function worktreeDiff(wtPath) {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) =>
    execFile(process.execPath, [path.join(__dirname, "worktree.mjs"), "diff", wtPath], { env: childEnv() }, (err, stdout) => {
      if (err) resolve(undefined);
      else {
        try {
          resolve(JSON.parse(stdout));
        } catch {
          resolve(undefined);
        }
      }
    }),
  );
}

async function createWorktree(cwd, label) {
  const { execFile } = await import("node:child_process");
  const run = (args) =>
    new Promise((resolve, reject) =>
      execFile("node", [path.join(__dirname, "worktree.mjs"), ...args], { env: childEnv() }, (err, stdout, stderr) =>
        err ? reject(new Error(stderr.trim() || err.message)) : resolve(JSON.parse(stdout)),
      ),
    );
  return run(["create", cwd, label]);
}

// ── Control channel (TCP NDJSON) ─────────────────────────────────────────────

const controlClients = new Set();
let controlPort = 0;

function send(conn, record) {
  if (conn.destroyed) return;
  try {
    conn.write(`${JSON.stringify(record)}\n`);
  } catch {}
}

function respond(conn, id, type, data) {
  send(conn, { id, type, ...data });
}

function respondError(conn, id, message) {
  send(conn, { id, type: "error", error: String(message) });
}

async function controlOp(conn, msg) {
  const id = msg.id;
  switch (msg.type) {
    case "attach": {
      const spec = msg.session ?? {};
      let session;
      let created = false;
      if (spec.id && sessions.has(spec.id)) {
        session = sessions.get(spec.id);
      } else if (spec.file && sessionsByFile.has(spec.file)) {
        session = sessions.get(sessionsByFile.get(spec.file));
      } else {
        session = createSession({ ...spec, initiator: "user" });
        created = true;
      }
      // Re-key fileless sessions the moment a file is named for them.
      if (spec.file && !session.file) setFile(session, spec.file);
      let metaChanged = false;
      if (spec.title && session.title === "New session" && spec.title !== session.title) {
        session.title = spec.title;
        metaChanged = true;
      }
      // An attach re-points the launch spec (agent override etc. may have moved) —
      // fields it does not name stay as they were.
      session.launch = {
        binaryPath: spec.binaryPath ?? session.launch.binaryPath,
        extraArgs: spec.extraArgs ?? session.launch.extraArgs,
        customAgent: spec.customAgent ?? session.launch.customAgent,
      };
      // Keep the session's own mode intact when joining an existing session (only clamp under ancestors);
      // explicit mode changes go through `set_runtime_mode`.
      const ceiling = ancestorCeiling(session);
      const enforcedMode = minMode(ceiling, session.runtimeMode);
      if (enforcedMode !== session.runtimeMode) {
        session.runtimeMode = enforcedMode;
        metaChanged = true;
      }
      if (!created && !session.loaded && spec.agentId) {
        if (session.agentId !== spec.agentId || (spec.agentName && session.agentName !== spec.agentName) || (spec.driver && session.driver !== spec.driver)) {
          session.agentId = spec.agentId;
          session.agentName = spec.agentName || session.agentName;
          session.driver = spec.driver || session.driver;
          metaChanged = true;
        }
      }
      if (session.unread) {
        session.unread = false;
        metaChanged = true;
      }
      persist({ type: "session_update", id: session.id, info: sessionInfo(session), launch: session.launch });
      if (metaChanged) pushSession(session);
      const fresh = !session.loaded;
      if (fresh) {
        const ok = await startProcess(session);
        if (!ok) {
          respondError(conn, id, session.lastError || `${session.agentName} could not start`);
          return;
        }
      }
      session.attached.add(conn);
      conn.attachedSessions.add(session.id);
      respond(conn, id, "attached", { session: sessionInfo(session) });
      // Replay dialogs still waiting on an answer — a session blocked in the
      // background hands its question to whoever attaches.
      for (const dialog of session.pendingDialogs.values()) {
        send(conn, { type: "out", sessionId: session.id, line: JSON.stringify(dialog) });
      }
      return;
    }
    case "detach": {
      const session = sessions.get(msg.sessionId);
      if (session) {
        session.attached.delete(conn);
        conn.attachedSessions.delete(session.id);
        send(conn, { type: "detached", sessionId: session.id });
      }
      respond(conn, id, "detached", {});
      return;
    }
    case "in": {
      const session = sessions.get(msg.sessionId);
      if (session && typeof msg.line === "string") {
        const line = clampModeLine(session, msg.line);
        observeWrite(session, line);
        writeLine(session, line);
      }
      return;
    }
    case "file": {
      const session = sessions.get(msg.sessionId);
      if (session && typeof msg.file === "string") setFile(session, msg.file);
      return;
    }
    case "mark_read": {
      const session = sessions.get(msg.sessionId);
      if (session) {
        session.unread = false;
        pushSession(session);
      }
      if (id) respond(conn, id, "ok", {});
      return;
    }
    case "kill": {
      const session = sessions.get(msg.sessionId);
      if (session) killProcess(session);
      respond(conn, id, "ok", {});
      return;
    }
    case "stop": {
      const session = sessions.get(msg.sessionId);
      if (session) await stopTree(session);
      respond(conn, id, "ok", {});
      return;
    }
    case "stop_all": {
      const roots = [...new Set([...sessions.values()].map((s) => rootOf(s).id))]
        .map((rid) => sessions.get(rid))
        .filter(Boolean);
      await Promise.all(roots.map((r) => stopTree(r)));
      respond(conn, id, "ok", {});
      return;
    }
    case "set_runtime_mode": {
      // User authority: the session chip sets this session's ceiling (clamped under any ancestor).
      const session = sessions.get(msg.sessionId);
      if (session && isRuntimeMode(msg.mode)) {
        session.runtimeMode = minMode(ancestorCeiling(session), msg.mode);
        persist({ type: "session_update", id: session.id, info: { runtimeMode: session.runtimeMode } });
        pushSession(session);
        // Propagate ceiling downward if any descendant now sits above its parent.
        for (const desc of descendantsOf(session)) {
          const capped = minMode(ancestorCeiling(desc), desc.runtimeMode);
          if (capped !== desc.runtimeMode) {
            desc.runtimeMode = capped;
            persist({ type: "session_update", id: desc.id, info: { runtimeMode: desc.runtimeMode } });
            pushSession(desc);
          }
        }
      }
      if (id) respond(conn, id, "ok", {});
      return;
    }
    case "list": {
      respond(conn, id, "sessions", { sessions: [...sessions.values()].map(sessionInfo) });
      return;
    }
    case "list_agents": {
      respond(conn, id, "agents", { agents: config.agents });
      return;
    }
    case "start_session": {
      try {
        const input = msg.input ?? {};
        const parent = input.parentId ? sessions.get(input.parentId) : undefined;
        const agentId = input.agentId ?? parent?.agentId ?? "pi";
        let agent = config.agents.find((a) => a.id === agentId);
        // Without a UI-pushed roster (CLI before any app attached) a known id still
        // starts: `pi` always; anything else tries the external bridge as itself.
        if (!agent) {
          agent = {
            id: agentId,
            name: agentId,
            driver: agentId === "pi" ? "pi" : (KNOWN_DRIVERS.has(agentId) ? agentId : "acp"),
            binaryPath: input.binaryPath,
          };
        }
        const cwd = input.cwd || parent?.cwd || process.cwd();
        // A child's mode never exceeds its parent's — the same clamp agents get.
        const parentCeiling = parent ? minMode(ancestorCeiling(parent), parent.runtimeMode) : undefined;
        const rawMode = parent
          ? clampMode(parentCeiling, input.runtimeMode)
          : !input.runtimeMode || input.runtimeMode === "inherit"
            ? "full-access"
            : clampMode("full-access", input.runtimeMode);
        const runtimeMode = fitAgentModes(rawMode, agent.supportedRuntimeModes);
        const session = createSession({
          title: input.title,
          agentId: agent.id,
          agentName: agent.name,
          driver: agent.driver,
          cwd,
          parentId: parent?.id,
          initiator: "user",
          runtimeMode,
          binaryPath: agent.binaryPath ?? config.overrides?.[agent.id]?.binaryPath ?? input.binaryPath,
          extraArgs: agent.extraArgs ?? config.overrides?.[agent.id]?.extraArgs ?? input.extraArgs,
          customAgent: agent.customAgent ?? config.customAgents?.find((c) => c.id === agent.id) ?? input.customAgent,
        });
        if (input.message) setStatus(session, "working");
        // Answer at once; worktree, spawn, model picks and the first prompt run in the background.
        respond(conn, id, "session", { session: sessionInfo(session) });
        void (async () => {
          if (input.worktree) {
            try {
              const worktree = await createWorktree(cwd, input.title || agent.id);
              session.cwd = worktree.path;
              session.worktree = worktree;
              pushSession(session);
            } catch (error) {
              failSession(session, `could not create a worktree: ${error.message}`);
              return;
            }
          }
          if (!(await startProcess(session))) return;
          if (input.message && session.status !== "working") return;
          if (typeof input.model === "string" && input.model.includes("/")) {
            const slash = input.model.indexOf("/");
            void daemonCommand(session, "set_model", { provider: input.model.slice(0, slash), modelId: input.model.slice(slash + 1) });
          }
          if (typeof input.thinking === "string" && input.thinking) {
            void daemonCommand(session, "set_thinking_level", { level: input.thinking });
          }
          if (input.message) writePrompt(session, input.message, "user");
        })();
      } catch (error) {
        respondError(conn, id, error.message);
      }
      return;
    }
    case "send": {
      const session = sessions.get(msg.sessionId) ?? findSession(msg.sessionId);
      if (!session) {
        respondError(conn, id, "no such session");
        return;
      }
      // A message from the person resets the ping-pong guard for this session.
      session.upstreamInitiator = "user";
      pairCounts.forEach((_, key) => {
        if (key.endsWith(`->${session.id}`) || key.startsWith(`${session.id}->`)) pairCounts.delete(key);
      });
      deliverMessage(session, String(msg.message ?? ""), "user");
      if (id) respond(conn, id, "ok", {});
      return;
    }
    case "read": {
      const session = findSession(msg.sessionId);
      if (!session) {
        respondError(conn, id, "no such session");
        return;
      }
      const info = sessionInfo(session);
      if (!session.loaded && session.file) {
        const last = await readSessionFile(session.file).catch(() => undefined);
        const answer = truncateUtf8(session.lastAnswer || last?.answer || "", READ_BYTE_BUDGET);
        respond(conn, id, "read", { session: { ...info, lastAnswer: answer.text, summary: last?.summary } });
      } else {
        const answer = truncateUtf8(session.lastAnswer || "", READ_BYTE_BUDGET);
        respond(conn, id, "read", { session: { ...info, lastAnswer: answer.text } });
      }
      return;
    }
    case "wait": {
      const session = findSession(msg.sessionId);
      if (!session) {
        respondError(conn, id, "no such session");
        return;
      }
      const busy =
        session.status === "working" ||
        session.status === "blocked" ||
        Boolean(session.starting) ||
        (!session.loaded && session.deliverQueue.length > 0);
      if (!busy) {
        respond(conn, id, "wait_result", { sessionId: session.id, status: session.status, answer: session.lastAnswer });
        return;
      }
      const entry = {
        session,
        waiter: (result) => {
          conn.waiters?.delete(entry);
          respond(conn, id, "wait_result", { sessionId: session.id, ...result });
        },
      };
      conn.waiters?.add(entry);
      session.waiters.push(entry.waiter);
      return;
    }
    case "config": {
      const { agents, overrides, customAgents, allowAgentTools, sendScope, maxDepth, maxRunning, worktreeDefault } = msg;
      if (Array.isArray(agents)) config.agents = agents;
      if (overrides) config.overrides = overrides;
      if (Array.isArray(customAgents)) config.customAgents = customAgents;
      if (typeof allowAgentTools === "boolean") config.allowAgentTools = allowAgentTools;
      if (sendScope === "all" || sendScope === "children") config.sendScope = sendScope;
      if (typeof maxDepth === "number") config.maxDepth = maxDepth;
      if (typeof maxRunning === "number") config.maxRunning = maxRunning;
      if (typeof worktreeDefault === "boolean") config.worktreeDefault = worktreeDefault;
      if (typeof msg.linger === "boolean") {
        config.linger = msg.linger;
        checkWindowlessExit();
      }
      respond(conn, id, "ok", {});
      return;
    }
    case "external_token": {
      const external = await externalToken();
      respond(conn, id, "external", { token: external.token, url: `http://127.0.0.1:${mcpPort}/mcp` });
      return;
    }
    case "install_cli": {
      try {
        const target = await installCli();
        respond(conn, id, "installed", { path: target });
      } catch (error) {
        respondError(conn, id, error.message);
      }
      return;
    }
    case "tool": {
      try {
        // Control channel carries user authority; session identity only ever comes from MCP bearer tokens.
        const result = await callSessionTool(undefined, msg.name, msg.args);
        respond(conn, id, "tool_result", { result });
      } catch (error) {
        respondError(conn, id, error.message);
      }
      return;
    }
    case "ping": {
      respond(conn, id, "pong", {});
      return;
    }
    default:
      if (id) respondError(conn, id, `unknown op "${msg.type}"`);
  }
}

let sawUiClient = false;
let windowlessTimer;
let shutdownDaemon = () => process.exit(0);

function hasActiveRuns() {
  for (const s of sessions.values()) {
    if (s.status === "working" || s.status === "blocked" || s.deliverQueue.length > 0 || s.starting) return true;
  }
  return false;
}

function checkWindowlessExit() {
  const hasUi = [...controlClients].some((c) => c.kind === "ui");
  if (!sawUiClient || hasUi || config.linger) {
    if (windowlessTimer) {
      clearTimeout(windowlessTimer);
      windowlessTimer = undefined;
    }
    return;
  }
  if (hasActiveRuns()) {
    if (windowlessTimer) {
      clearTimeout(windowlessTimer);
      windowlessTimer = undefined;
    }
    return;
  }
  if (!windowlessTimer) {
    windowlessTimer = setTimeout(() => {
      windowlessTimer = undefined;
      const stillUi = [...controlClients].some((c) => c.kind === "ui");
      if (!stillUi && !config.linger && !hasActiveRuns()) {
        shutdownDaemon();
      }
    }, WINDOWLESS_EXIT_MS);
    windowlessTimer.unref?.();
  }
}

async function controlConnection(conn) {
  conn.setEncoding("utf8");
  let buf = "";
  let greeted = false;
  conn.attachedSessions = new Set();
  conn.waiters = new Set();
  conn.on("data", (chunk) => {
    buf += chunk;
    let at = buf.indexOf("\n");
    while (at !== -1) {
      const line = buf.slice(0, at).replace(/\r$/, "");
      buf = buf.slice(at + 1);
      at = buf.indexOf("\n");
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (!greeted) {
        if (msg.type !== "hello" || msg.token !== CONTROL_TOKEN) {
          send(conn, { type: "error", error: "unauthorized" });
          conn.destroy();
          return;
        }
        greeted = true;
        conn.kind = msg.kind === "cli" ? "cli" : "ui";
        if (conn.kind === "ui") sawUiClient = true;
        controlClients.add(conn);
        checkWindowlessExit();
        send(conn, { type: "hello", sessions: [...sessions.values()].map(sessionInfo), config: publicConfig() });
        continue;
      }
      void controlOp(conn, msg).catch((error) => {
        if (msg.id) respondError(conn, msg.id, error instanceof Error ? error.message : error);
      });
    }
  });
  let dropped = false;
  const drop = () => {
    if (dropped) return;
    dropped = true;
    for (const sessionId of conn.attachedSessions ?? []) {
      sessions.get(sessionId)?.attached.delete(conn);
    }
    for (const entry of conn.waiters ?? []) {
      const idx = entry.session.waiters.indexOf(entry.waiter);
      if (idx >= 0) entry.session.waiters.splice(idx, 1);
    }
    conn.waiters?.clear();
    controlClients.delete(conn);
    checkWindowlessExit();
  };
  conn.on("close", drop);
  conn.on("error", drop);
}

function publicConfig() {
  return {
    allowAgentTools: config.allowAgentTools,
    sendScope: config.sendScope,
    maxDepth: config.maxDepth,
    maxRunning: config.maxRunning,
  };
}

// ── External token (agents not launched by pipi, other apps) ─────────────────

let externalCache;

async function externalToken() {
  if (externalCache?.token) return externalCache;
  try {
    const stored = JSON.parse(await fsp.readFile(EXTERNAL_FILE, "utf8"));
    if (stored?.token) {
      externalCache = stored;
      await fsp.chmod(EXTERNAL_FILE, 0o600).catch(() => {});
      return stored;
    }
  } catch {}
  const created = { token: newToken(), created: now() };
  externalCache = created;
  await fsp.writeFile(EXTERNAL_FILE, JSON.stringify(created, null, 2), { mode: 0o600 }).catch(() => {});
  await fsp.chmod(EXTERNAL_FILE, 0o600).catch(() => {});
  return created;
}

async function installCli() {
  const homeDir = process.env.HOME || process.env.USERPROFILE || home;
  const binDir = path.join(homeDir, ".local", "bin");
  // The shim names THIS daemon's home: `pipi` talks to the same registry the app does.
  if (process.platform === "win32") {
    // A `pipi` file with no extension is not executable on Windows — the shim is
    // a .cmd, and it runs the CLI on the daemon's own node (`process.execPath`)
    // so it does not depend on `node` being on PATH.
    const target = path.join(binDir, "pipi.cmd");
    const script = `@echo off\r\n"${process.execPath}" "${PIPI_CLI}" --home "${home}" %*\r\nexit /b %ERRORLEVEL%\r\n`;
    await fsp.mkdir(binDir, { recursive: true });
    await fsp.writeFile(target, script);
    return target;
  }
  const target = path.join(binDir, "pipi");
  const script = `#!/bin/sh\nexec node ${JSON.stringify(PIPI_CLI)} --home ${JSON.stringify(home)} "$@"\n`;
  await fsp.mkdir(binDir, { recursive: true });
  await fsp.writeFile(target, script, { mode: 0o755 });
  await fsp.chmod(target, 0o755).catch(() => {});
  return target;
}

// ── MCP endpoint ─────────────────────────────────────────────────────────────

let mcpPort = 0;

async function mcpCaller(req) {
  const auth = String(req.headers.authorization ?? "").trim();
  const match = auth.match(/^Bearer\s+(\S+)$/i);
  const token = match ? match[1] : "";
  if (!token) return { error: "missing bearer token" };
  for (const session of sessions.values()) {
    if (session.token === token) return { session };
  }
  const external = await externalToken();
  if (token === external.token) return { external: true };
  return { error: "unknown bearer token" };
}

async function mcpHandle(req, res) {
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }
  const caller = await mcpCaller(req);
  if (caller.error) {
    res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: caller.error }));
    return;
  }
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", async () => {
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid JSON" }));
      return;
    }
    if (!msg || typeof msg !== "object") {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid JSON-RPC message" }));
      return;
    }
    // JSON-RPC 2.0 notifications carry no `id` and expect HTTP 202 with no body.
    if (msg.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    const reply = (result) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...result }));
    };
    try {
      if (msg.method === "initialize") {
        reply({ result: { protocolVersion: "2024-11-05", serverInfo: { name: "pipi", version: "1" }, capabilities: { tools: {} } } });
      } else if (msg.method === "tools/list") {
        reply({ result: { tools: config.allowAgentTools ? SESSION_TOOLS : [] } });
      } else if (msg.method === "tools/call") {
        try {
          const name = msg.params?.name;
          if (!config.allowAgentTools) throw new Error("session tools are disabled in Settings → Sessions");
          // Identity comes strictly from the bearer token, never from request arguments.
          const result = await callSessionTool(caller.session ?? undefined, name, msg.params?.arguments ?? {});
          reply({ result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] } });
        } catch (toolError) {
          reply({
            result: {
              content: [{ type: "text", text: toolError instanceof Error ? toolError.message : String(toolError) }],
              isError: true,
            },
          });
        }
      } else {
        reply({ error: { code: -32601, message: `unknown method ${msg.method}` } });
      }
    } catch (error) {
      reply({ error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
    }
  });
}

// ── Registry persistence (boot replay) ───────────────────────────────────────

async function loadRegistry() {
  const raw = await fsp.readFile(REGISTRY_FILE, "utf8").catch(() => "");
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type === "session" && record.info?.id) {
      const info = record.info;
      if (!sessions.has(info.id)) {
        const session = {
          ...info,
          launch: record.launch ?? { binaryPath: info.binaryPath, extraArgs: info.extraArgs, customAgent: info.customAgent },
          attached: new Set(),
          proc: undefined,
          starting: undefined,
          internalPending: new Map(),
          pendingDialogs: new Map(),
          deliverQueue: [],
          lastAnswer: "",
          pendingAnswer: "",
          blockedNotified: false,
          suppressStopDelivery: false,
          exitExpected: false,
          waiters: [],
          loaded: false,
        };
        sessions.set(info.id, session);
        if (session.file) sessionsByFile.set(session.file, session.id);
      }
    } else if (record.type === "session_update" && (record.id || record.info?.id)) {
      const targetId = record.id ?? record.info?.id;
      const session = sessions.get(targetId);
      if (session) {
        if (record.info && typeof record.info === "object") {
          const prevFile = session.file;
          const { id: _ignored, ...rest } = record.info;
          Object.assign(session, rest);
          if (prevFile && prevFile !== session.file && sessionsByFile.get(prevFile) === session.id) {
            sessionsByFile.delete(prevFile);
          }
        }
        if (record.launch && typeof record.launch === "object") {
          session.launch = { ...session.launch, ...record.launch };
        }
        session.loaded = false;
        session.proc = undefined;
        if (session.file) sessionsByFile.set(session.file, session.id);
      }
    } else if (record.type === "queue" && record.to) {
      // The latest queue record is the session's pending deliveries.
      const session = sessions.get(record.to);
      if (session && Array.isArray(record.items)) {
        session.deliverQueue = record.items.map((item) => ({ text: String(item.text ?? ""), initiator: item.initiator }));
      }
    }
  }
  seq = Math.max(seq, sessions.size);
  // Everything the registry says was running (or interrupted during daemon shutdown) has no process now;
  // an agent-started session's initiator hears about the interruption once the daemon is ready.
  for (const session of sessions.values()) {
    const wasRunning = session.status === "working" || session.status === "blocked";
    const pendingNotify = session.interruptedInitiator;
    delete session.interruptedInitiator;
    if (wasRunning || pendingNotify) {
      session.status = "interrupted";
      const initiator = pendingNotify ?? session.initiator;
      session.initiator = undefined;
      if (initiator && initiator !== "user" && initiator !== session.id) {
        const target = sessions.get(initiator);
        if (target) {
          target.deliverQueue.push({
            text: envelope(session, `${session.title} (${session.agentName}) was interrupted when the session daemon restarted.`, "failed"),
            initiator: returnInitiatorFor(target, session.id),
          });
        }
      }
    }
  }
  // Cancel any timer before rewriting the compacted registry snapshot at boot.
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = undefined;
  }
  persistQueue.length = 0;
  const lines = [];
  for (const session of sessions.values()) {
    lines.push(JSON.stringify({ type: "session", info: { ...sessionInfo(session), token: session.token }, launch: session.launch }));
    if (session.deliverQueue.length) {
      lines.push(JSON.stringify({ type: "queue", to: session.id, items: session.deliverQueue }));
    }
  }
  const tmpRegistry = `${REGISTRY_FILE}.tmp.${process.pid}`;
  await fsp.writeFile(tmpRegistry, lines.length ? `${lines.join("\n")}\n` : "", { mode: 0o600 }).catch(() => {});
  await fsp.chmod(tmpRegistry, 0o600).catch(() => {});
  await fsp.rename(tmpRegistry, REGISTRY_FILE).catch(() => {});
}

// ── Idle unload ──────────────────────────────────────────────────────────────

setInterval(() => {
  const roots = new Set([...sessions.values()].map((s) => rootOf(s).id));
  for (const rootId of roots) {
    const root = sessions.get(rootId);
    if (!root) continue;
    const tree = [root, ...descendantsOf(root)];
    // An attached session is somebody's open window — it is never the unload's.
    const loaded = tree.filter((s) => s.loaded && s.status !== "working" && s.status !== "blocked" && s.attached.size === 0);
    const cutoff = now() - IDLE_UNLOAD_MS;
    for (const session of loaded.filter((s) => s.lastActive < cutoff)) killProcess(session);
    const still = loaded.filter((s) => s.loaded !== false && s.lastActive >= cutoff);
    if (still.length > MAX_LOADED_PER_TREE) {
      still.sort((a, b) => a.lastActive - b.lastActive);
      for (const session of still.slice(0, still.length - MAX_LOADED_PER_TREE)) killProcess(session);
    }
  }
}, 60_000).unref();

// ── Boot ─────────────────────────────────────────────────────────────────────

async function main() {
  await fsp.mkdir(home, { recursive: true });
  await loadRegistry();

  const control = net.createServer((conn) => void controlConnection(conn));
  await new Promise((resolve, reject) => {
    control.once("error", reject);
    control.listen(0, "127.0.0.1", resolve);
  });
  controlPort = control.address().port;

  const mcp = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname === "/mcp") void mcpHandle(req, res);
    else res.writeHead(404).end();
  });
  await new Promise((resolve, reject) => {
    mcp.once("error", reject);
    mcp.listen(0, "127.0.0.1", resolve);
  });
  mcpPort = mcp.address().port;

  const instance = { pid: process.pid, controlPort, mcpPort, token: CONTROL_TOKEN, started: now() };
  // daemon.json carries the control token — full session authority; owner-read only.
  await fsp.writeFile(INSTANCE_FILE, JSON.stringify(instance, null, 2), { mode: 0o600 });
  await fsp.chmod(INSTANCE_FILE, 0o600).catch(() => {});
  fs.writeSync(2, `pipi-daemon[${process.pid}] listening control=${controlPort} mcp=${mcpPort}\n`);

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = undefined;
    }
    if (windowlessTimer) {
      clearTimeout(windowlessTimer);
      windowlessTimer = undefined;
    }
    const snapshotLines = [];
    for (const session of sessions.values()) {
      const running = session.status === "working" || session.status === "blocked";
      const interruptedInitiator =
        running && session.initiator && session.initiator !== "user" && session.initiator !== session.id ? session.initiator : undefined;
      const info = {
        ...sessionInfo(session),
        token: session.token,
        ...(running ? { status: "interrupted" } : {}),
        ...(interruptedInitiator ? { interruptedInitiator } : {}),
      };
      snapshotLines.push(JSON.stringify({ type: "session", info, launch: session.launch }));
      if (session.deliverQueue.length) {
        snapshotLines.push(JSON.stringify({ type: "queue", to: session.id, items: session.deliverQueue }));
      }
      if (session.proc) {
        session.exitExpected = true;
        try {
          session.proc.kill("SIGTERM");
        } catch {}
      }
    }
    persistQueue.length = 0;
    try {
      const tmpRegistry = `${REGISTRY_FILE}.tmp.${process.pid}`;
      fs.writeFileSync(tmpRegistry, snapshotLines.length ? `${snapshotLines.join("\n")}\n` : "", { mode: 0o600 });
      fs.chmodSync(tmpRegistry, 0o600);
      fs.renameSync(tmpRegistry, REGISTRY_FILE);
    } catch {}
    try {
      fs.rmSync(INSTANCE_FILE, { force: true });
    } catch {}
    process.exit(0);
  };
  shutdownDaemon = shutdown;
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Wake any sessions holding queued deliveries from before or across the restart.
  for (const session of sessions.values()) {
    if (session.deliverQueue.length > 0 && session.status !== "working" && session.status !== "blocked") {
      void revive(session);
    }
  }
}

main().catch((error) => {
  fs.writeSync(2, `pipi-daemon: ${error instanceof Error ? error.stack : error}\n`);
  process.exit(1);
});
