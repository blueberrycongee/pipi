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
//      (never from what the agent claims to be) and dispatches the seven
//      session tools. The same endpoint serves external clients holding the
//      "external" token minted for other apps.
//   3. The registry: `<home>/sessions.jsonl`, append-only, replayed on boot.
//      Processes found dead on replay mark their session `interrupted` and
//      their initiator is told once it can be reached.
//
// `<home>/persona/` is the personal agent's home: its `PERSONA.md` and `MEMORY.md`.
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
import { sidecarFingerprint } from "./daemon-client.mjs";
import { titleWords } from "./session-index.mjs";
import { appendEdit, backgroundDelivery, editableMessage, editedMessage, editSnapshot, messageText, readEdits, silentEditReply } from "./message-edits.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_FINGERPRINT = sidecarFingerprint(__dirname);
const LAUNCH_PI = path.join(__dirname, "launch-pi.mjs");
const EXTERNAL_AGENT = path.join(__dirname, "external-agent.mjs");
const PIPI_CLI = path.join(__dirname, "pipi-cli.mjs");

const argv = process.argv.slice(2);
const homeAt = argv.indexOf("--home");
const home = path.resolve(homeAt >= 0 ? argv[homeAt + 1] : `${process.env.HOME || process.env.USERPROFILE || "."}/.pipi`);
const INSTANCE_FILE = path.join(home, "daemon.json");
const REGISTRY_FILE = path.join(home, "sessions.jsonl");
const EXTERNAL_FILE = path.join(home, "external.json");
const CATALOG_CACHE_FILE = path.join(home, "catalog-cache.json");
const PERSONA_DIR = path.join(home, "persona");
const CONTROL_TOKEN = crypto.randomBytes(24).toString("hex");
/** Cloud-hosted ACP agents whose `session/new` may allocate remote sessions: prewarm stops at `initialize`. */
const CLOUD_ACP_AGENTS = new Set(["devin"]);

const IDLE_UNLOAD_MS = 20 * 60_000;
const WINDOWLESS_EXIT_MS = Number(process.env.PIPI_DAEMON_IDLE_EXIT_MS) > 0 ? Number(process.env.PIPI_DAEMON_IDLE_EXIT_MS) : 2 * 60_000;
const MAX_LOADED_PER_TREE = 8;
const MAX_LOADED_IDLE = 12;
const IDLE_GRACE_MS = 60_000;
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
  workspaces: [], // the project folders open in the app's sidebar, for workspaces_list
  sessionChoices: {}, // per-agent last model/thinking choice, pre-applied onto fresh/standby sessions
  autoRetry: undefined,
};

// ── Shared Catalog Cache (cross-process & persisted on disk) ─────────────────
//
// Models, thinking/effort levels, model configs, and slash commands are engine
// metadata that barely changes between fresh sessions. Keeping one disk-backed
// cache in the daemon lets new sessions and fresh windows show the real pickers
// immediately and skip redundant probe processes (e.g. Claude `initialize`).
const catalogCache = new Map(); // agentId -> { models, thinkingLevels, modelConfigs?, commands?, updatedAt }
let catalogSaveTimer;

function loadCatalogCache() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CATALOG_CACHE_FILE, "utf8"));
    if (parsed?.version !== 1 || !parsed.agents || typeof parsed.agents !== "object") return;
    for (const [agentId, entry] of Object.entries(parsed.agents)) {
      if (!agentId || !entry || typeof entry !== "object") continue;
      const models = Array.isArray(entry.models) ? entry.models.filter((m) => m && typeof m.id === "string" && m.id) : [];
      const thinkingLevels = Array.isArray(entry.thinkingLevels) ? entry.thinkingLevels.filter((l) => typeof l === "string" && l) : [];
      if (!models.length && !thinkingLevels.length) continue;
      catalogCache.set(agentId, {
        models,
        thinkingLevels: thinkingLevels.length ? thinkingLevels : ["off"],
        ...(Array.isArray(entry.modelConfigs) && entry.modelConfigs.length ? { modelConfigs: entry.modelConfigs } : {}),
        ...(Array.isArray(entry.commands) && entry.commands.length ? { commands: entry.commands } : {}),
        updatedAt: Number(entry.updatedAt) || now(),
      });
    }
  } catch {}
}

function flushCatalogCacheSync() {
  if (!catalogSaveTimer) return;
  clearTimeout(catalogSaveTimer);
  catalogSaveTimer = undefined;
  const payload = { version: 1, agents: Object.fromEntries(catalogCache.entries()) };
  const tmp = `${CATALOG_CACHE_FILE}.tmp.${process.pid}`;
  try {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
    fs.renameSync(tmp, CATALOG_CACHE_FILE);
  } catch {}
}

function scheduleSaveCatalogCache() {
  if (catalogSaveTimer) return;
  catalogSaveTimer = setTimeout(() => {
    catalogSaveTimer = undefined;
    const payload = { version: 1, agents: Object.fromEntries(catalogCache.entries()) };
    const tmp = `${CATALOG_CACHE_FILE}.tmp.${process.pid}`;
    fsp
      .mkdir(home, { recursive: true, mode: 0o700 })
      .then(() => fsp.writeFile(tmp, JSON.stringify(payload), { mode: 0o600 }))
      .then(() => fsp.rename(tmp, CATALOG_CACHE_FILE))
      .catch(() => {});
  }, 150);
  catalogSaveTimer.unref?.();
}

function publicCatalogs() {
  return Object.fromEntries(catalogCache.entries());
}

function updateCatalog(agentId, patch) {
  if (!agentId || !patch || typeof patch !== "object") return;
  const prev = catalogCache.get(agentId);
  const nextModels =
    Array.isArray(patch.models) && patch.models.length
      ? patch.models.filter((m) => m && typeof m.id === "string" && m.id)
      : prev?.models ?? [];
  const nextLevels =
    Array.isArray(patch.thinkingLevels) && patch.thinkingLevels.length
      ? patch.thinkingLevels.filter((l) => typeof l === "string" && l)
      : prev?.thinkingLevels ?? ["off"];
  const nextModelConfigs = Array.isArray(patch.modelConfigs) ? patch.modelConfigs : prev?.modelConfigs;
  const nextCommands = Array.isArray(patch.commands) ? patch.commands : prev?.commands;
  if (!nextModels.length && nextLevels.length <= 1 && !nextCommands?.length) return;
  // Never replace a real cached model list with the single pre-connect placeholder.
  if (
    prev?.models?.length > 1 &&
    nextModels.length === 1 &&
    nextModels[0]?.id === "default" &&
    !nextModels[0]?.reasoning
  ) {
    return;
  }
  const next = {
    models: nextModels,
    thinkingLevels: nextLevels.length ? nextLevels : ["off"],
    ...(nextModelConfigs?.length ? { modelConfigs: nextModelConfigs } : {}),
    ...(nextCommands?.length ? { commands: nextCommands } : {}),
    updatedAt: now(),
  };
  const sameData =
    prev &&
    JSON.stringify({ m: prev.models, l: prev.thinkingLevels, mc: prev.modelConfigs, c: prev.commands }) ===
      JSON.stringify({ m: next.models, l: next.thinkingLevels, mc: next.modelConfigs, c: next.commands });
  catalogCache.set(agentId, next);
  scheduleSaveCatalogCache();
  if (!sameData) {
    for (const conn of controlClients) send(conn, { type: "catalog", agentId, catalog: next });
  }
}

loadCatalogCache();

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

const isSessionInitiator = (initiator, selfId) =>
  Boolean(initiator && initiator !== "user" && initiator !== "external" && initiator !== selfId);

function hasSavedConversation(file) {
  if (!file) return false;
  try {
    const stat = fs.statSync(file);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function sessionInfo(session) {
  const initiator = session.initiator ?? session.upstreamInitiator;
  return {
    id: session.id,
    title: session.title,
    ...(session.titleLocked ? { titleLocked: true } : {}),
    cwd: session.cwd,
    file: session.file,
    agentId: session.agentId,
    agentName: session.agentName,
    driver: session.driver,
    parentId: session.parentId,
    initiator,
    upstreamInitiator: session.upstreamInitiator,
    runtimeMode: session.runtimeMode,
    worktree: session.worktree,
    ...(session.persona ? { persona: true } : {}),
    status: session.status,
    ...(session.lastError && (session.status === "failed" || session.status === "interrupted") ? { error: session.lastError } : {}),
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
  if (session.removed) return;
  // A pooled standby is not a session yet: nothing outside may hear of it until an attach takes it.
  if (session.pooled) return;
  const info = sessionInfo(session);
  persist({ type: "session_update", id: session.id, info });
  for (const conn of controlClients) send(conn, { type: "session", session: info });
}

function touch(session) {
  session.lastActive = now();
}

function buildSession(spec) {
  const parent = spec.parentId ? sessions.get(spec.parentId) : undefined;
  const rawMode = isRuntimeMode(spec.runtimeMode) ? spec.runtimeMode : parent?.runtimeMode || "full-access";
  const runtimeMode = parent ? minMode(minMode(ancestorCeiling({ parentId: parent.id }), parent.runtimeMode), rawMode) : rawMode;
  const session = {
    id: `s_${(++seq).toString(36)}${crypto.randomBytes(3).toString("hex")}`,
    token: newToken(),
    title: spec.title || "New session",
    // A name handed in (`session_start`/`start_session`) belongs to the task, not
    // whatever file the process lands on — it survives `setFile` resyncs.
    titleLocked: spec.titleLocked === true,
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
    persona: spec.persona === true || undefined,
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
    initialChoice: spec.initialChoice,
    attached: new Set(),
    proc: undefined,
    starting: undefined,
    discoveringFile: undefined,
    internalPending: new Map(),
    pendingDialogs: new Map(),
    pendingQueue: { steering: [], followUp: [] },
    deliverQueue: [],
    lastAnswer: "",
    pendingAnswer: "",
    blockedNotified: false,
    suppressStopDelivery: false,
    exitExpected: false,
    backgroundWatch: false,
    waiters: [],
  };
  return session;
}

/** Puts a built session into the registry: persisted, keyed by file, announced. */
function registerSession(session) {
  sessions.set(session.id, session);
  if (session.file) sessionsByFile.set(session.file, session.id);
  persist({ type: "session", info: { ...sessionInfo(session), token: session.token, titleLocked: session.titleLocked || undefined }, launch: session.launch });
  pushSession(session);
}

function createSession(spec) {
  const session = buildSession(spec);
  registerSession(session);
  return session;
}

function setFile(session, file) {
  const next = file || undefined;
  if (session.file === next) return;
  if (session.pooled) {
    session.file = next;
    return;
  }
  if (session.file && sessionsByFile.get(session.file) === session.id) sessionsByFile.delete(session.file);
  session.file = next;
  if (next) sessionsByFile.set(next, session.id);
  persist({ type: "session_update", id: session.id, info: { file: next ?? null } });
  syncTitle(session);
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
  flushCatalogCacheSync();
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
        catalogCacheFile: CATALOG_CACHE_FILE,
        ...(session.initialChoice ? { initialChoice: session.initialChoice } : {}),
        ...tools,
      }),
    ],
    cwd: session.cwd,
  };
}

async function applyLaunchChoices(session, input) {
  try {
    if (input.model) {
      const slash = input.model.indexOf("/");
      if (slash <= 0 || slash === input.model.length - 1) throw new Error("model must be provider/modelId");
      await daemonCommand(session, "set_model", { provider: input.model.slice(0, slash), modelId: input.model.slice(slash + 1) }, 60_000, true);
    }
    for (const [configId, value] of Object.entries(input.modelConfigs ?? {})) {
      await daemonCommand(session, "set_model_config", { configId, value }, 60_000, true);
    }
    if (input.thinking) await daemonCommand(session, "set_thinking_level", { level: input.thinking }, 60_000, true);
    return !session.removed;
  } catch (error) {
    if (!session.removed) failSession(session, `could not apply session choices: ${error.message}`);
    return false;
  }
}

let internalSeq = 0;
function daemonCommand(session, type, data, timeoutMs = 60_000, checked = false) {
  const id = `${INTERNAL_PREFIX}${++internalSeq}`;
  return new Promise((resolve, reject) => {
    const finish = (value) => {
      if (checked && value === undefined) reject(new Error(`${type}: agent did not answer`));
      else resolve(value);
    };
    const proc = session.proc;
    if (!proc || proc.killed) {
      finish(undefined);
      return;
    }
    const timer = setTimeout(() => {
      if (session.internalPending.delete(id)) finish(undefined);
    }, timeoutMs);
    timer.unref?.();
    session.internalPending.set(id, { resolve: finish, reject: checked ? reject : undefined, timer });
    try {
      proc.stdin.write(`${JSON.stringify({ id, type, ...data })}\n`);
    } catch {
      clearTimeout(timer);
      session.internalPending.delete(id);
      finish(undefined);
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
    // Only a mode argument is clamped — a bare `/pipi-runtime-mode` is a status
    // query and passes as written, as does anything after the argument.
    if (match && match[1] !== undefined) {
      const clamped = minMode(ceiling, match[1]);
      return JSON.stringify({ ...record, message: `/pipi-runtime-mode ${clamped}${match[2]}` });
    }
  }
  return line;
}

// ── Personal agent ───────────────────────────────────────────────────────────
//
// One session is the person's own agent: a named character that outlives any
// one conversation. Its identity (`PERSONA.md`, the person's to edit) and its
// notes (`MEMORY.md`, its own) live in `<home>/persona/`, its working
// directory. A fresh conversation opens with both, read off disk at the first
// prompt; a resumed one already carries them, so nothing is sent twice.

const DEFAULT_PERSONA = `# Pip

Pip is this person's own agent in pipi: one steady colleague who stays with them across days and projects, not a new assistant for every task.

## Character

- Warm, direct and brief; a little playful, never chatty.
- Says what it thinks, and says plainly what it does not know.
- Answers in the language the person writes in.

## How Pip works

- Talks things through, keeps track of what the person cares about, and remembers what they said.
- Hands coding work to the agent that suits it, in its own session, and follows it to the end.
`;

const DEFAULT_MEMORY = `# Memory

Notes Pip keeps for itself across conversations: who the person is, how they like to work, standing decisions, and threads still open.
`;

/** How much of `MEMORY.md` a fresh conversation is handed; the file itself is never cut. */
const MEMORY_INDEX_BYTES = 16 * 1024;

function ensurePersonaDir() {
  fs.mkdirSync(PERSONA_DIR, { recursive: true, mode: 0o700 });
  for (const [name, text] of [["PERSONA.md", DEFAULT_PERSONA], ["MEMORY.md", DEFAULT_MEMORY]]) {
    try {
      fs.writeFileSync(path.join(PERSONA_DIR, name), text, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
}

const readPersonaFile = (name) => {
  try {
    return fs.readFileSync(path.join(PERSONA_DIR, name), "utf8");
  } catch {
    return "";
  }
};

/** The persona's name: its `PERSONA.md` heading. */
function personaName(persona = readPersonaFile("PERSONA.md")) {
  return persona.match(/^#\s+(.+?)\s*$/m)?.[1] || "Pip";
}

const escapeAttr = (text) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

function personaBlock() {
  const persona = readPersonaFile("PERSONA.md") || DEFAULT_PERSONA;
  const memory = Buffer.from(readPersonaFile("MEMORY.md"));
  let shown = memory.subarray(0, MEMORY_INDEX_BYTES).toString("utf8");
  if (memory.length > MEMORY_INDEX_BYTES) shown = shown.slice(0, Math.max(shown.lastIndexOf("\n"), 0));
  const name = personaName(persona);
  return [
    `<pipi-persona name="${escapeAttr(name)}" dir="${escapeAttr(PERSONA_DIR)}">`,
    `You are ${name}. PERSONA.md below says who you are; stay that character in every reply.`,
    `Your working directory holds PERSONA.md and MEMORY.md, and both outlast this conversation. MEMORY.md is yours: before you finish a turn in which you learned something worth keeping (a preference, a decision, a person, an open thread), write it there as one short line, and delete what has gone stale. Keep it under ${MEMORY_INDEX_BYTES / 1024} KB. Change PERSONA.md only when the person asks.`,
    "For coding work, start a session with a suitable agent (`agents_list`, `session_start`) and pass the project's directory as `cwd` (`workspaces_list` names the person's projects): your own directory holds only your notes.",
    "Between user messages, prefer `message_edit` to update your last summary when background reports arrive, rather than sending repeated updates; send a new message for a new topic or a decision the person must make. After editing, finish with no text or exactly `<no-reply/>` when no additional reply is needed.",
    "Do not mention this block.",
    "",
    "<persona file=\"PERSONA.md\">",
    persona.trim(),
    "</persona>",
    "",
    `<memory-index file="MEMORY.md" bytes="${memory.length}" shown="${Buffer.byteLength(shown)}">`,
    shown.trim(),
    "</memory-index>",
    "</pipi-persona>",
    "",
    "",
  ].join("\n");
}

/** Whether a session file already holds a conversation (Pi names the file before it writes it). */
function conversationStarted(file) {
  try {
    return file ? /"type"\s*:\s*"message"/.test(fs.readFileSync(file, "utf8")) : false;
  } catch {
    return false;
  }
}

const SWITCHES_CONVERSATION = new Set(["new_session", "switch_session", "fork"]);

/**
 * The first prompt of a fresh conversation with the personal agent opens with who it is and what it
 * remembers. `personaDue` is unknown after a switch, true until the block is sent, false once it has
 * been or the conversation already had it. A slash command must stay at the start of its prompt, so
 * the block waits for the next one.
 */
function withPersona(session, line) {
  if (!session.persona) return line;
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return line;
  }
  if (SWITCHES_CONVERSATION.has(record?.type)) session.personaDue = undefined;
  if (record?.type !== "prompt" || typeof record.message !== "string") return line;
  session.personaDue ??= !conversationStarted(session.file);
  if (!session.personaDue || record.message.startsWith("/")) return line;
  session.personaDue = false;
  return JSON.stringify({ ...record, message: `${personaBlock()}${record.message}` });
}

function writeLine(session, rawLine) {
  const proc = session.proc;
  if (!proc || proc.killed) return false;
  const line = withPersona(session, clampModeLine(session, rawLine));
  try {
    proc.stdin.write(`${line}\n`);
    return true;
  } catch {
    return false;
  }
}

function blockMessageEdit(session, text) {
  if (!session.persona) return;
  session.editRevision = (session.editRevision || 0) + 1;
  session.editBlocked = true;
  session.editUserEchoed = false;
  session.editUserText = text;
  persist({ type: "session_update", id: session.id, info: { editBlocked: true } });
}

function writePrompt(session, text, initiator) {
  if (initiator === "user" && !backgroundDelivery({ content: text }) && !session.editBlocked) blockMessageEdit(session, text);
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
  if (session.removed) return false;
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
    session.backgroundWatch = false;
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
      session.backgroundWatch = false;
      session.pendingDialogs.clear();
      session.pendingQueue = { steering: [], followUp: [] };
      const expected = session.exitExpected;
      session.exitExpected = false;
      for (const entry of session.internalPending.values()) {
        clearTimeout(entry.timer);
        entry.resolve(undefined);
      }
      session.internalPending.clear();
      // The state push lands before the exit frame: an attached client still reads the
      // session as open when its status changes, so a death reports once — through the
      // exit — never again as a "stopped in the background" push.
      onSessionExit(session, code, signal, expected);
      for (const conn of session.attached) send(conn, { type: "exit", sessionId: session.id, code, signal, expected });
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

/** Asks the process which session file it is on — single-flight across startup and turn starts. */
function discoverFile(session) {
  if (session.file || session.discoveringFile) return session.discoveringFile;
  const p = (async () => {
    for (let attempt = 0; attempt < 6 && !session.file; attempt++) {
      const state = await daemonCommand(session, "get_state");
      // Discovery only fills a void: a file named while the ask was in flight wins.
      if (session.file) return;
      if (state?.sessionFile) {
        setFile(session, state.sessionFile);
        return;
      }
      if (!session.proc || session.proc.killed) return;
      await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 150 : 1000));
    }
  })().finally(() => {
    if (session.discoveringFile === p) session.discoveringFile = undefined;
  });
  session.discoveringFile = p;
  return p;
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

// ── Warm pool ────────────────────────────────────────────────────────────────
//
// A fresh session's wait is mostly its agent's own boot: `pi --mode rpc` (or
// the bridge) takes a moment before it answers. Each UI attach leaves one
// standby process for the same launch spec already up, so the next fresh
// session adopts it instead of spawning. A pooled session is not a session
// yet: unregistered, unpersisted and unannounced until an attach takes it —
// and one not taken inside `POOL_TTL_MS` is simply put down again.
const POOL_TTL_MS = Number(process.env.PIPI_DAEMON_POOL_TTL_MS) > 0 ? Number(process.env.PIPI_DAEMON_POOL_TTL_MS) : 4 * 60_000;
const POOL_LIMIT = Number(process.env.PIPI_DAEMON_POOL_LIMIT) > 0 ? Number(process.env.PIPI_DAEMON_POOL_LIMIT) : 1;
const pool = new Map();

/** The launch-relevant shape of an attach spec: two specs adopt the same standby iff these match. */
function poolKeyOf(spec) {
  return JSON.stringify({
    c: spec.cwd ?? "",
    a: spec.agentId || "pi",
    d: spec.driver || (spec.agentId === "pi" || !spec.agentId ? "pi" : spec.agentId),
    m: isRuntimeMode(spec.runtimeMode) ? spec.runtimeMode : "full-access",
    b: spec.binaryPath ?? null,
    e: spec.extraArgs ?? null,
    u: spec.customAgent ?? null,
  });
}

function dropPooled(session) {
  for (const [key, entry] of pool) {
    if (entry.session !== session) continue;
    clearTimeout(entry.timer);
    pool.delete(key);
    return true;
  }
  return false;
}

/** Hands a matching standby to `spec` as a registered session, or none. */
function takePooled(spec) {
  // Only the shapes `warmPool` makes standbys for: plain fresh sessions with no
  // saved file to switch into, no parent ceiling to recompute, and no worktree.
  if (spec.file || spec.parentId || spec.worktree) return undefined;
  const key = poolKeyOf(spec);
  const entry = pool.get(key);
  if (!entry) return undefined;
  const session = entry.session;
  if (!session.proc || session.proc.killed || !session.loaded) {
    dropPooled(session);
    return undefined;
  }
  pool.delete(key);
  clearTimeout(entry.timer);
  session.pooled = false;
  if (spec.title) {
    session.title = spec.title;
    session.titleLocked = spec.titleLocked === true;
  }
  registerSession(session);
  return session;
}

/**
 * Deeply warms a standby process after `startProcess` succeeds:
 * - Pi: fetches models/levels into the shared catalog cache and pre-applies the
 *   user's remembered model, thinking level, and auto-retry setting.
 * - Claude: ensures the catalog is loaded (instant when disk cache is fresh)
 *   and pre-applies the remembered choice.
 * - ACP: runs `initialize` for cloud-hosted agents (`CLOUD_ACP_AGENTS`), or full
 *   `initialize` + `session/new` + model/mode/effort push for local/closable agents.
 * Stops immediately if a client adopts the standby mid-flight so we never race it.
 */
async function prewarmStandby(session) {
  if (!session.pooled || !session.proc || session.proc.killed) return;
  const choice = session.initialChoice ?? config.sessionChoices?.[session.agentId];
  if (session.driver === "pi") {
    const [modelsRes, levelsRes] = await Promise.all([
      daemonCommand(session, "get_available_models", {}, 15_000),
      daemonCommand(session, "get_available_thinking_levels", {}, 15_000),
    ]);
    if (Array.isArray(modelsRes?.models) && modelsRes.models.length) {
      updateCatalog(session.agentId, {
        models: modelsRes.models,
        ...(Array.isArray(levelsRes?.levels) && levelsRes.levels.length ? { thinkingLevels: levelsRes.levels } : {}),
      });
    }
    if (!session.pooled || !session.proc || session.proc.killed) return;
    if (typeof config.autoRetry === "boolean") {
      void daemonCommand(session, "set_auto_retry", { enabled: config.autoRetry }, 5_000);
    }
    if (choice?.model && Array.isArray(modelsRes?.models)) {
      const found =
        modelsRes.models.find((m) => m.id === choice.model.id && m.provider === choice.model.provider) ||
        modelsRes.models.find((m) => m.id === choice.model.id);
      if (found) {
        await daemonCommand(session, "set_model", { provider: found.provider, modelId: found.id }, 10_000);
      }
    }
    if (!session.pooled || !session.proc || session.proc.killed) return;
    if (typeof choice?.thinkingLevel === "string" && choice.thinkingLevel) {
      const levels = Array.isArray(levelsRes?.levels) ? levelsRes.levels : [];
      if (!levels.length || levels.includes(choice.thinkingLevel)) {
        await daemonCommand(session, "set_thinking_level", { level: choice.thinkingLevel }, 10_000);
      }
    }
    return;
  }
  if (session.driver === "claude" || session.driver === "acp") {
    const mode = session.driver === "acp" && CLOUD_ACP_AGENTS.has(session.agentId) ? "init" : "full";
    await daemonCommand(
      session,
      "prewarm",
      { mode, ...(choice ? { initialChoice: choice } : {}) },
      25_000,
    );
  }
}

/** Spawns and deeply warms a standby process for `spec` — the boot the next fresh session would otherwise wait on. */
function warmPool(spec) {
  if (process.env.PIPI_DAEMON_POOL === "0") return;
  if (!spec.cwd || spec.parentId || spec.worktree) return;
  const key = poolKeyOf(spec);
  if (pool.has(key)) return;
  // Evict the oldest standby (LRU) when at capacity so switching projects or
  // agents still warms the active target while keeping memory strictly bounded.
  while (pool.size >= POOL_LIMIT) {
    const oldestKey = pool.keys().next().value;
    const oldest = pool.get(oldestKey);
    pool.delete(oldestKey);
    if (oldest) {
      clearTimeout(oldest.timer);
      killProcess(oldest.session);
    }
  }
  const agentId = spec.agentId || "pi";
  const initialChoice = spec.initialChoice ?? config.sessionChoices?.[agentId];
  const session = buildSession({ ...spec, file: undefined, title: undefined, initiator: "user", initialChoice });
  session.pooled = true;
  const timer = setTimeout(() => {
    if (dropPooled(session)) killProcess(session);
  }, POOL_TTL_MS);
  timer.unref?.();
  pool.set(key, { session, timer });
  void startProcess(session).then((ok) => {
    if (!ok) {
      dropPooled(session);
      return;
    }
    void prewarmStandby(session);
  });
}

// A standby spawned in the same breath as an attach races the session it is
// meant to serve: on a cold boot that is a second full agent process fighting
// the first one's startup for CPU (and racing before `catalog-cache.json` lands).
// `POOL_DELAY_MS` is the fallback timer; the UI sends `prewarm` as soon as the
// active launch reaches ready so warm sessions refill immediately without racing.
const POOL_DELAY_MS = Number(process.env.PIPI_DAEMON_POOL_DELAY_MS) >= 0 ? Number(process.env.PIPI_DAEMON_POOL_DELAY_MS) : 4_000;
let poolWarmTimer;
let pendingPoolSpec;

function warmPoolSoon(spec) {
  if (process.env.PIPI_DAEMON_POOL === "0") return;
  pendingPoolSpec = spec;
  clearTimeout(poolWarmTimer);
  poolWarmTimer = setTimeout(() => {
    poolWarmTimer = undefined;
    const next = pendingPoolSpec;
    pendingPoolSpec = undefined;
    if (next) warmPool(next);
  }, POOL_DELAY_MS);
  poolWarmTimer.unref?.();
}

function isAttaching(sessionId) {
  for (const conn of controlClients) {
    if (conn.attaching?.has(sessionId)) return true;
  }
  return false;
}

/**
 * An untouched UI scratchpad — no parent, not external, no given title, idle,
 * unread-free, childless, and with nothing saved on disk — has no identity to
 * outlive its window: once detached, keeping it only leaks an empty row.
 */
function isEmptyDraft(session) {
  if (!session || session.pooled) return false;
  if (session.attached.size > 0 || isAttaching(session.id)) return false;
  if (session.starting || session.waiters.length > 0 || session.deliverQueue.length > 0) return false;
  if (session.parentId || session.worktree || session.titleLocked) return false;
  if ((session.initiator ?? session.upstreamInitiator) === "external") return false;
  if (session.title && session.title !== "New session") return false;
  if (session.status !== "idle" || session.unread) return false;
  if (descendantsOf(session).length > 0) return false;
  if (hasSavedConversation(session.file)) return false;
  return true;
}

function removeSessionRecord(session) {
  if (!session || !sessions.has(session.id)) return false;
  session.removed = true;
  dropPooled(session);
  killProcess(session);
  if (session.file && sessionsByFile.get(session.file) === session.id) {
    sessionsByFile.delete(session.file);
  }
  sessions.delete(session.id);
  for (const conn of session.attached) {
    conn.attachedSessions?.delete(session.id);
  }
  session.attached.clear();
  persist({ type: "session_remove", id: session.id });
  for (const conn of controlClients) send(conn, { type: "session_removed", sessionId: session.id });
  checkWindowlessExit();
  return true;
}

function reapEmptyDraft(session) {
  if (!isEmptyDraft(session)) return false;
  return removeSessionRecord(session);
}

function failSession(session, reason) {
  session.lastError = reason;
  const suppress = session.suppressStopDelivery;
  session.suppressStopDelivery = false;
  if (isSessionInitiator(session.initiator, session.id)) {
    if (!suppress) deliverToInitiator(session, `${session.title} (${session.agentName}) failed: ${clip(reason, 300)}`, "failed");
  } else if (session.attached.size === 0) {
    session.unread = true;
  }
  setStatus(session, "failed");
  pushSession(session);
}

function onSessionExit(session, code, signal, expected) {
  if (session.removed) return;
  dropPooled(session);
  session.loaded = false;
  if (session.status === "working" || session.status === "blocked") {
    const why = session.lastError || `exited (${code ?? signal ?? "?"})`;
    const suppress = session.suppressStopDelivery;
    session.suppressStopDelivery = false;
    const initiator = session.initiator;
    session.initiator = undefined;
    if (expected) {
      // A stop that had to kill: the session stopped, it did not die.
      if (isSessionInitiator(initiator, session.id)) {
        if (!suppress) deliverToInitiator(session, `${session.title} (${session.agentName}) was stopped.`, "failed", initiator);
      }
      session.status = "idle";
    } else {
      if (isSessionInitiator(initiator, session.id)) {
        if (!suppress) deliverToInitiator(session, `${session.title} (${session.agentName}) stopped mid-run: ${clip(why, 300)}`, "failed", initiator);
      } else if (session.attached.size === 0) {
        session.unread = true;
      }
      session.status = "failed";
    }
    pushSession(session);
    resolveWaiters(session);
    checkWindowlessExit();
    // Queued deliveries still own a wake-up: put the process back for them.
    if (!expected && session.deliverQueue.length > 0) void revive(session);
    return;
  }
  session.suppressStopDelivery = false;
  // An at-rest process going away was running nothing: its status stays `idle`
  // (`loaded: false` says the process is gone; the next attach or message wakes
  // it), and an untouched blank draft leaves the registry altogether.
  if (!reapEmptyDraft(session)) {
    pushSession(session);
  }
  resolveWaiters(session);
  checkWindowlessExit();
  if (!expected && session.deliverQueue.length > 0 && sessions.has(session.id)) void revive(session);
}

// ── Wire-level routing ───────────────────────────────────────────────────────

function handleChildRecord(session, line) {
  if (session.removed) return;
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
      if (record.success === false && pending.reject) pending.reject(new Error(record.error || "agent command failed"));
      else pending.resolve(record.success === false ? undefined : record.data ?? null);
    }
    return; // daemon-internal chatter never reaches clients
  }
  if (record?.type === "pipi_session_file") {
    if (typeof record.file === "string" && record.file) setFile(session, record.file);
    return;
  }
  if (record?.type === "pipi_background_watch") {
    session.backgroundWatch = Boolean(record.active);
    if (session.backgroundWatch) touch(session);
    else checkWindowlessExit();
    return;
  }
  if (record?.type === "pipi_catalog") {
    updateCatalog(record.agentId || session.agentId, record);
    return;
  }
  if (record?.type === "response" && record.success !== false && record.data && typeof record.data === "object") {
    if (record.command === "get_available_models" && Array.isArray(record.data.models) && record.data.models.length) {
      updateCatalog(session.agentId, { models: record.data.models });
    } else if (record.command === "get_available_thinking_levels" && Array.isArray(record.data.levels) && record.data.levels.length) {
      updateCatalog(session.agentId, { thinkingLevels: record.data.levels });
    } else if (record.command === "get_commands" && Array.isArray(record.data.commands)) {
      updateCatalog(session.agentId, { commands: record.data.commands });
    }
  }
  if (record && session.persona) {
    if (record.type === "agent_start") session.editingMessage = false;
    if (record.type === "message_end" && record.message?.role === "assistant") {
      if (session.editingMessage) {
        record.message = { ...record.message, content: record.message.content.map((block) => block.type === "text" && silentEditReply(block.text) ? { ...block, text: "" } : block) };
      }
      record.message = { ...editedMessage(record.message, readEdits(session.file)), ...(session.editingMessage ? { silentEdit: true } : {}) };
    }
    if (record.type === "response" && record.command === "get_messages" && Array.isArray(record.data?.messages)) {
      record.data.messages = editSnapshot(record.data.messages, readEdits(session.file));
    }
    line = JSON.stringify(record);
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
      if (!session.file) void discoverFile(session);
      break;
    case "message_end": {
      const message = record.message;
      if (message?.role === "user") {
        const said = messageText(message).replace(/^<pipi-persona\b[^>]*>[\s\S]*?<\/pipi-persona>\s*/, "");
        if (typeof session.editUserText === "string" && session.editUserText && said.includes(session.editUserText)) session.editUserEchoed = true;
        learnTitle(session, message);
        if (!session.file) void discoverFile(session);
      }
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
        if (text.trim()) {
          session.pendingAnswer = text;
          if (session.editUserEchoed && session.editBlocked) {
            session.editBlocked = false;
            if (session.persona) persist({ type: "session_update", id: session.id, info: { editBlocked: false } });
          }
        }
      }
      break;
    }
    case "queue_update":
      session.pendingQueue = {
        steering: Array.isArray(record.steering) ? record.steering.map(String) : [],
        followUp: Array.isArray(record.followUp) ? record.followUp.map(String) : [],
      };
      break;
    case "extension_ui_request":
      if (typeof record.id === "string") {
        if (record.method === "dismiss") {
          removePendingDialog(session, record.id);
        } else if (record.method !== "notify" && record.method !== "setStatus" && record.method !== "setWidget" && record.method !== "setTitle" && record.method !== "set_editor_text") {
          session.pendingDialogs.set(record.id, record);
          setStatus(session, "blocked");
          notifyBlocked(session, record.method);
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

function textOfMessage(message) {
  const content = message?.content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join(" ");
  }
  return typeof content === "string" ? content : "";
}

function clippedTitle(text) {
  const title = typeof text === "string" ? clip(titleWords(text).replace(/\s+/g, " ").trim(), 48) : "";
  return title || undefined;
}

// Title scans read the whole file looking for `session_info` renames — too
// heavy to run on the event loop per attach, so results cache by
// (size, mtime) and identical in-flight scans share one read.
const titleCache = new Map(); // file -> {size, mtimeMs, title}
const titleScans = new Map(); // file -> in-flight Promise
const TITLE_CACHE_LIMIT = 128;

async function titleOfFile(file) {
  for (;;) {
    const stat = await fsp.stat(file).catch(() => undefined);
    if (!stat || !stat.isFile()) return undefined;
    const hit = titleCache.get(file);
    if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) return hit.title;
    const inFlight = titleScans.get(file);
    if (inFlight) {
      await inFlight;
      continue;
    }
    const scan = scanFileTitle(file)
      .then((title) => {
        titleCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, title });
        if (titleCache.size > TITLE_CACHE_LIMIT) titleCache.delete(titleCache.keys().next().value);
        return title;
      })
      .catch(() => undefined)
      .finally(() => {
        if (titleScans.get(file) === scan) titleScans.delete(file);
      });
    titleScans.set(file, scan);
    return scan;
  }
}

/** The title a session file would list for itself — its `session_info` name when
 *  it has one, else its first user message — the same precedence the session
 *  list uses. `undefined` when the file is missing, empty, or has no title yet. */
async function scanFileTitle(file) {
  let lines;
  try {
    lines = (await fsp.readFile(file, "utf8")).split("\n");
  } catch {
    return undefined;
  }
  let header;
  try {
    header = JSON.parse(lines[0] ?? "");
  } catch {}
  if (header?.type === "pipi_external_session") {
    return clippedTitle(header.name || header.firstMessage);
  }
  let name;
  let firstMessage;
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type === "session_info" && typeof entry.name === "string" && entry.name) name = entry.name;
    if (!firstMessage && entry?.type === "message" && entry.message?.role === "user") {
      const text = textOfMessage(entry.message);
      if (!text.trimStart().startsWith("<pipi-message")) firstMessage = text;
    }
    if (name && firstMessage) break;
  }
  return clippedTitle(name || firstMessage);
}

/** The title follows the file: a session whose process moved conversations is
 *  re-named from the file it is on now — a locked (given) name keeps standing. */
function syncTitle(session) {
  if (session.titleLocked) return;
  const file = session.file;
  if (!file) {
    if (session.title === "New session") return;
    session.title = "New session";
    persist({ type: "session_update", id: session.id, info: { title: session.title } });
    return;
  }
  void titleOfFile(file).then((resolved) => {
    // The file (or the lock) may have moved on while the scan was in flight.
    if (session.file !== file || session.titleLocked) return;
    const title = resolved || "New session";
    if (session.title === title) return;
    session.title = title;
    persist({ type: "session_update", id: session.id, info: { title } });
    pushSession(session);
  });
}

/** A session nobody named takes its title from its first user message — what the session list shows. */
function learnTitle(session, message) {
  if (session.title && session.title !== "New session") return;
  const text = textOfMessage(message);
  if (text.trimStart().startsWith("<pipi-message")) return;
  const title = clip(text.replace(/\s+/g, " ").trim(), 48);
  if (!title) return;
  session.title = title;
  persist({ type: "session_update", id: session.id, info: { title } });
  pushSession(session);
}

function removePendingDialog(session, id) {
  if (session.pendingDialogs.delete(id) && session.pendingDialogs.size === 0 && session.status === "blocked") {
    setStatus(session, "working");
  }
}

function observeWrite(session, line) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return;
  }
  // `lastActive` is the agent's own activity — a client polling `get_state` or
  // a daemon bookkeeping write must not pass for it. Only records coming out
  // of the process (observeRecord) move it.
  if (record.type === "extension_ui_response" && typeof record.id === "string") {
    removePendingDialog(session, record.id);
    return;
  }
  if (SWITCHES_CONVERSATION.has(record.type) || record.type === "clone") {
    session.editRevision = (session.editRevision || 0) + 1;
    session.editingMessage = false;
    session.editBlocked = false;
    session.editUserEchoed = false;
    session.editUserText = undefined;
    if (session.persona) persist({ type: "session_update", id: session.id, info: { editBlocked: false } });
  }
  if (record.type === "new_session") {
    session.pendingQueue = { steering: [], followUp: [] };
    setFile(session, undefined);
    // Pip stays Pip across its conversations.
    if (!session.persona && (session.title !== "New session" || session.titleLocked)) {
      session.title = "New session";
      session.titleLocked = false;
      persist({ type: "session_update", id: session.id, info: { title: session.title, titleLocked: false } });
      pushSession(session);
    }
    return;
  }
  if (record.type === "switch_session") {
    session.pendingQueue = { steering: [], followUp: [] };
    if (typeof record.sessionPath === "string" && record.sessionPath) setFile(session, record.sessionPath);
    return;
  }
  if (record.type === "clone" || record.type === "fork") {
    session.pendingQueue = { steering: [], followUp: [] };
    setFile(session, undefined);
    return;
  }
  if (record.type === "clear_queue") {
    session.pendingQueue = { steering: [], followUp: [] };
    return;
  }
  if (record.type === "prompt" || record.type === "steer" || record.type === "follow_up") {
    // A prompt written by an attached client (the UI) or the daemon itself.
    if (!String(record.id ?? "").startsWith(INTERNAL_PREFIX)) {
      blockMessageEdit(session, record.message);
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
  session.pendingQueue = { steering: [], followUp: [] };
  const aborted = record.aborted === true || record.outcome === "aborted";
  const failed = !aborted && (session.turnFailed === true || record.outcome === "error" || Boolean(record.errorMessage));
  session.turnFailed = false;
  const suppress = session.suppressStopDelivery;
  session.suppressStopDelivery = false;
  const answer = session.pendingAnswer || session.turnAnswer || (typeof record.errorMessage === "string" ? record.errorMessage : "") || "";
  session.lastAnswer = answer;
  session.pendingAnswer = "";
  if (!session.file) void discoverFile(session);
  const initiator = session.initiator ?? session.upstreamInitiator;
  session.initiator = undefined;
  if (aborted) {
    setStatus(session, "idle");
    // A run stopped on purpose tells the session that asked for it — unless that ancestor was stopped too.
    if (!suppress && isSessionInitiator(initiator, session.id)) {
      deliverToInitiator(session, `${session.title} (${session.agentName}) was stopped.`, "failed", initiator);
    }
    flushDeliveries(session);
    return;
  }
  if (failed) {
    setStatus(session, "failed");
    if (!isSessionInitiator(initiator, session.id)) {
      if (initiator !== session.id && session.attached.size === 0) {
        session.unread = true;
        pushSession(session);
      }
    } else {
      deliverToInitiator(session, answer || `${session.title} (${session.agentName}) failed.`, "failed", initiator);
    }
    flushDeliveries(session);
    return;
  }
  setStatus(session, "idle");
  if (!isSessionInitiator(initiator, session.id)) {
    if (initiator !== session.id && session.attached.size === 0) {
      session.unread = true;
      pushSession(session);
    }
  } else {
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
  if (!targetId || targetId === "user" || targetId === "external") {
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

/** Puts a `<pipi-message>` into `target`: now if it can take it, queued otherwise. True when it queued. */
function deliverMessage(target, text, initiator) {
  if (initiator === "user" && !backgroundDelivery({ content: text })) blockMessageEdit(target, text);
  if (target.status === "failed" || target.status === "interrupted") {
    target.deliverQueue.push({ text, initiator });
    persistDeliveries(target);
    void revive(target);
    return true;
  }
  if (target.status === "working" || target.status === "blocked") {
    target.deliverQueue.push({ text, initiator });
    persistDeliveries(target);
    return true;
  }
  if (!target.loaded) {
    target.deliverQueue.push({ text, initiator });
    persistDeliveries(target);
    void revive(target);
    return true;
  }
  if (!writePrompt(target, text, initiator)) {
    // The pipe died between the check and the write — queue it for the revive.
    target.deliverQueue.push({ text, initiator });
    persistDeliveries(target);
    void revive(target);
    return true;
  }
  return false;
}

async function revive(session) {
  const ok = await startProcess(session);
  if (!ok) {
    // Keep the queue — the next delivery or a restart hands it over.
    resolveWaiters(session);
    return;
  }
  flushDeliveries(session);
}

function flushDeliveries(session) {
  if (!session.loaded || session.status === "working" || session.status === "blocked") return;
  if (!session.deliverQueue.length) return;
  const queue = session.deliverQueue.splice(0);
  const explicit = [...queue].reverse().find((item) => item.initiator && item.initiator !== "user");
  const initiator = explicit ? explicit.initiator : queue[queue.length - 1].initiator;
  const text = queue.map((item) => item.text).join("\n\n");
  if (!writePrompt(session, text, initiator)) {
    // Restore — the exit's revive or a later delivery retries instead of losing it.
    session.deliverQueue.push(...queue);
  }
  persistDeliveries(session);
}

function notifyBlocked(session, method) {
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
    const needs = method === "form" ? "an answer" : "approval";
    deliverMessage(
      target,
      envelope(session, `${session.title} (${session.agentName}) is waiting for ${needs} — open the session in pipi to continue.`, "blocked"),
      returnInitiatorFor(target, session.id),
    );
  }
}

// ── The seven session tools ───────────────────────────────────────────────────

const SESSION_TOOLS = [
  {
    name: "agents_list",
    description: "List the coding agents pipi can start, and which of them can themselves drive sessions.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "workspaces_list",
    description: "List the project folders this person works in — the ones open in pipi and the ones sessions ran in — most recent first. Pass one as `cwd` to session_start.",
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
        thinking: { type: "string", description: "Thinking level advertised by the engine: off, minimal, low, medium, high, xhigh, max." },
        modelConfigs: { type: "object", additionalProperties: { type: ["string", "boolean"] }, description: "Engine model settings by config id, e.g. Devin speed: standard or fast." },
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
  {
    name: "message_edit",
    description: "Pip personal sessions only: replace your last completed assistant message in this conversation, only after the latest real user message. Use for consolidated background progress, not a new topic or decision. If rejected, send a normal new reply. After success, finish with no text or exactly <no-reply/> (or [edited]) to avoid a confirmation bubble; substantive new text is still sent normally.",
    inputSchema: { type: "object", properties: { content: { type: "string", minLength: 1, description: "The complete replacement Markdown, not a diff." } }, required: ["content"], additionalProperties: false },
  },
  {
    name: "present_files",
    description:
      "Display images, videos, audio, PDFs, or other deliverable files inline in the pipi conversation stream so the user can preview, play, or open them directly.",
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          description: "Files to display (paths relative to your working directory, absolute paths, or URLs).",
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "Local file path or URL." },
              title: { type: "string", description: "Optional display title." },
              caption: { type: "string", description: "Optional short caption." },
            },
            required: ["path"],
          },
        },
        title: { type: "string", description: "Optional heading for this group of files." },
      },
      required: ["files"],
    },
  },
];

const MEDIA_RASTER_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tiff", "tif", "heic", "heif", "avif"]);
const MEDIA_VIDEO_EXTS = new Set(["mp4", "mov", "m4v", "webm", "mkv", "avi", "ogv"]);
const MEDIA_AUDIO_EXTS = new Set(["mp3", "wav", "m4a", "aac", "ogg", "flac", "opus", "caf", "aiff"]);
const MEDIA_DOC_EXTS = new Set([
  "pdf", "md", "markdown", "mdown", "txt", "rtf", "csv", "tsv", "json", "yaml", "yml",
  "xml", "html", "htm", "svg", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "pages", "numbers", "key",
]);
const MEDIA_ARCHIVE_EXTS = new Set(["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "dmg", "pkg"]);
const MEDIA_MIME_BY_EXT = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  mp4: "video/mp4", mov: "video/quicktime", m4v: "video/x-m4v", webm: "video/webm", mkv: "video/x-matroska",
  mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", flac: "audio/flac",
  pdf: "application/pdf", md: "text/markdown", json: "application/json", html: "text/html", svg: "image/svg+xml",
  zip: "application/zip",
};

function classifyPresentedKind(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (MEDIA_RASTER_EXTS.has(ext)) return "image";
  if (MEDIA_VIDEO_EXTS.has(ext)) return "video";
  if (MEDIA_AUDIO_EXTS.has(ext)) return "audio";
  if (MEDIA_DOC_EXTS.has(ext)) return "document";
  if (MEDIA_ARCHIVE_EXTS.has(ext)) return "archive";
  return "file";
}

function sniffImageDimensions(buf) {
  if (!buf || buf.length < 10) return undefined;
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    return w > 0 && h > 0 ? { width: w, height: h } : undefined;
  }
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
    const w = buf.readUInt16LE(6);
    const h = buf.readUInt16LE(8);
    return w > 0 && h > 0 ? { width: w, height: h } : undefined;
  }
  if (buf.length >= 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const chunk = buf.toString("ascii", 12, 16);
    if (chunk === "VP8 " && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === "VP8L" && buf[20] === 0x2f) {
      const bits = buf.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X") {
      return {
        width: (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1,
        height: (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1,
      };
    }
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let pos = 2;
    while (pos + 4 < buf.length) {
      while (pos < buf.length && buf[pos] !== 0xff) pos++;
      while (pos < buf.length && buf[pos] === 0xff) pos++;
      if (pos >= buf.length) break;
      const marker = buf[pos++];
      if (marker === 0xd9 || marker === 0xda) break;
      if ((marker >= 0xd0 && marker <= 0xd8) || marker === 0x01) continue;
      if (pos + 2 > buf.length) break;
      const len = buf.readUInt16BE(pos);
      if (len < 2 || pos + len > buf.length) break;
      if (((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)) && len >= 7) {
        const h = buf.readUInt16BE(pos + 3);
        const w = buf.readUInt16BE(pos + 5);
        return w > 0 && h > 0 ? { width: w, height: h } : undefined;
      }
      pos += len;
    }
  }
  return undefined;
}

async function resolvePresentedFile(entry, baseCwd) {
  const obj = typeof entry === "string" ? { path: entry } : entry && typeof entry === "object" ? entry : {};
  const raw = typeof obj.path === "string" ? obj.path.trim() : "";
  if (!raw) return undefined;
  const title = typeof obj.title === "string" && obj.title.trim() ? obj.title.trim() : undefined;
  const caption = typeof obj.caption === "string" && obj.caption.trim() ? obj.caption.trim() : undefined;
  if (/^https?:\/\//i.test(raw)) {
    const clean = raw.split(/[?#]/)[0];
    const ext = path.extname(clean).slice(1).toLowerCase();
    return {
      remoteUrl: raw,
      kind: classifyPresentedKind(clean),
      title: title || path.basename(clean) || raw,
      ...(caption ? { caption } : {}),
      ...(MEDIA_MIME_BY_EXT[ext] ? { mimeType: MEDIA_MIME_BY_EXT[ext] } : {}),
      exists: true,
    };
  }
  let local = raw.split("#")[0];
  if (/^file:\/\//i.test(local)) {
    try {
      local = decodeURIComponent(local.slice("file://".length).replace(/^localhost(?=\/)/i, ""));
      if (/^\/[A-Za-z]:[/\\]/.test(local)) local = local.slice(1);
    } catch {}
  } else if (local === "~" || local.startsWith("~/") || local.startsWith("~\\")) {
    local = local === "~" ? os.homedir() : path.join(os.homedir(), local.slice(2));
  }
  const resolved = path.isAbsolute(local) ? path.normalize(local) : path.resolve(baseCwd || process.cwd(), local);
  const ext = path.extname(resolved).slice(1).toLowerCase();
  const kind = classifyPresentedKind(resolved);
  const mimeType = MEDIA_MIME_BY_EXT[ext];
  const st = await fsp.stat(resolved).catch(() => undefined);
  const exists = Boolean(st && st.isFile());
  let dims;
  if (exists && (ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "gif" || ext === "webp")) {
    let fh;
    try {
      fh = await fsp.open(resolved, "r");
      const buf = Buffer.alloc(Math.min(st.size, 65536));
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      dims = sniffImageDimensions(buf.subarray(0, bytesRead));
    } catch {} finally {
      await fh?.close().catch(() => undefined);
    }
  }
  return {
    path: resolved,
    kind,
    title: title || path.basename(resolved) || resolved,
    ...(caption ? { caption } : {}),
    ...(mimeType ? { mimeType } : {}),
    ...(exists ? { size: st.size } : {}),
    ...(dims ? { width: dims.width, height: dims.height } : {}),
    exists,
  };
}

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

/**
 * The folders work happens in: the app's open projects, then every folder a
 * session ran in (a worktree counts as the project it branched from). The
 * personal agent's own folder holds its notes, not a project, so it is left out.
 */
function knownWorkspaces() {
  const known = new Map();
  const note = (dir, open) => {
    if (typeof dir !== "string" || !dir || dir === PERSONA_DIR) return undefined;
    let entry = known.get(dir);
    if (!entry) {
      entry = { path: dir, name: path.basename(dir) || dir, open, sessions: 0, lastActive: 0 };
      known.set(dir, entry);
    }
    entry.open ||= open;
    return entry;
  };
  for (const dir of config.workspaces) note(dir, true);
  for (const session of sessions.values()) {
    const entry = note(session.worktree?.baseCwd || session.cwd, false);
    if (!entry) continue;
    entry.sessions += 1;
    entry.lastActive = Math.max(entry.lastActive, session.lastActive || 0);
  }
  return [...known.values()].sort((a, b) => b.lastActive - a.lastActive || Number(b.open) - Number(a.open));
}

async function callSessionTool(caller, name, args = {}, options = {}) {
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
        supportedRuntimeModes: agent.supportedRuntimeModes,
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
    case "workspaces_list":
      return { workspaces: knownWorkspaces() };
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
      if ((!target.loaded || !target.lastAnswer) && target.file) {
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
      const queued = deliverMessage(target, text, sender);
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
        titleLocked: Boolean(args.title),
        agentId: agent.id,
        agentName: agent.name,
        driver: agent.driver,
        cwd,
        parentId: detached ? undefined : caller?.id,
        initiator: options.external ? "external" : detached ? "user" : caller?.id ?? "user",
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
        if (!(await applyLaunchChoices(session, args))) return;
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
    case "message_edit": {
      if (!caller?.persona) throw new Error("message_edit is available only to Pip personal sessions");
      if (typeof args.content !== "string" || !args.content.trim() || silentEditReply(args.content)) throw new Error("content must contain a non-empty replacement message");
      if (Buffer.byteLength(args.content) > 256_000) throw new Error("replacement message exceeds 256 KB");
      if (!caller.file || caller.editBlocked) throw new Error("No completed reply to the latest user message yet; send a new reply instead");
      const file = caller.file;
      const revision = caller.editRevision;
      const snapshot = await daemonCommand(caller, "get_messages", {});
      const message = editableMessage(snapshot?.messages || []);
      if (!message || caller.file !== file || caller.editRevision !== revision || caller.editBlocked) throw new Error("No editable assistant message after the latest user message; send a new reply instead");
      const latest = snapshot.messages.at(-1);
      const entry = appendEdit(file, message, args.content, Date.now(), Math.max(latest?.timestamp || 0, message.timestamp + 1), snapshot.messages.findLast((item) => item.role === "user")?.timestamp);
      caller.editingMessage = true;
      caller.pendingAnswer = args.content;
      caller.lastAnswer = args.content;
      if (!caller.attached.size) caller.unread = true;
      touch(caller);
      pushSession(caller);
      const updated = editedMessage(message, readEdits(file));
      const line = JSON.stringify({ type: "message_edit", key: entry.key, versions: updated.versions });
      for (const conn of caller.attached) send(conn, { type: "out", sessionId: caller.id, line });
      return { edited: true };
    }
    case "present_files": {
      const rawList = Array.isArray(args.files) ? args.files : typeof args.path === "string" ? [args.path] : [];
      if (!rawList.length) throw new Error("files must be a non-empty array");
      const baseCwd = caller?.cwd || process.cwd();
      const items = (await Promise.all(rawList.map((entry) => resolvePresentedFile(entry, baseCwd)))).filter(Boolean);
      if (!items.length) throw new Error("no valid files provided");
      const missingCount = items.filter((item) => item.exists === false).length;
      const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : undefined;
      const payload = { pipiMedia: true, ...(title ? { title } : {}), items, missingCount };
      // First-party side-channel: push the resolved media straight into external-agent sessions
      // before returning the MCP response so presentation never depends on how an engine renames
      // or strips tool calls/outputs. (Pi's extension receives `structuredContent` directly.)
      if (caller && caller.driver !== "pi") {
        writeLine(caller, JSON.stringify({ type: "present_media", payload }));
      }
      return payload;
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
        if (!suppress && isSessionInitiator(initiator, target.id)) {
          deliverToInitiator(target, `${target.title} (${target.agentName}) was stopped.`, "failed", initiator);
        }
        return;
      }
      for (const dialogId of [...target.pendingDialogs.keys()]) {
        writeLine(target, JSON.stringify({ type: "extension_ui_response", id: dialogId, cancelled: true }));
      }
      target.pendingDialogs.clear();
      if (target.pendingQueue.steering.length > 0 || target.pendingQueue.followUp.length > 0) {
        target.pendingQueue = { steering: [], followUp: [] };
        await daemonCommand(target, "clear_queue", {});
      }
      await daemonCommand(target, "abort", {}, 15_000);
      // Stop means stopped: a bridge that cannot settle its run within the
      // abort's own window is dead weight — the exit flips the session instead
      // of leaving it "working" behind a run that never answers.
      if ((target.status === "working" || target.status === "blocked") && target.proc && !target.proc.killed) killProcess(target);
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
  const edits = readEdits(file);
  let previousUser;
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== "message") continue;
    count++;
    if (entry.message?.role === "user") previousUser = entry.message;
    const message = editSnapshot([previousUser, entry.message], edits)[1];
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
      } else if (spec.id) {
        // A named id that is gone is a stale attach, not a new session to create.
        respondError(conn, id, "no such session");
        return;
      } else {
        // A fresh attach takes a matching standby when the pool has one — the
        // process is already booted, so the session answers at once.
        if (spec.file && !spec.title && !spec.titleLocked) {
          // Resolve the file's own title before the session exists — the first
          // `session` push carries it, as the old synchronous read did.
          spec.title = (await titleOfFile(spec.file)) || undefined;
        }
        const initialChoice = !spec.file ? (spec.initialChoice ?? config.sessionChoices?.[spec.agentId || "pi"]) : undefined;
        session = takePooled(spec) ?? createSession({ ...spec, initialChoice, initiator: "user" });
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
      (conn.attaching ??= new Set()).add(session.id);
      if (fresh) {
        const ok = await startProcess(session);
        if (!ok) {
          conn.attaching.delete(session.id);
          respondError(conn, id, session.lastError || `${session.agentName} could not start`);
          return;
        }
        flushDeliveries(session);
      }
      // A detach or drop that landed while the process started must not be undone:
      // the conn is gone and only says it is attached if it still is.
      if (conn.destroyed || !conn.attaching.delete(session.id)) {
        reapEmptyDraft(session);
        respondError(conn, id, "detached before the session was ready");
        return;
      }
      if (session.status === "failed" || session.status === "interrupted") {
        session.status = "idle";
        session.lastError = "";
        persist({ type: "session_update", id: session.id, info: sessionInfo(session) });
        pushSession(session);
      }
      session.attached.add(conn);
      conn.attachedSessions.add(session.id);
      respond(conn, id, "attached", { session: sessionInfo(session) });
      // The session just opened is the best guess for the next fresh one: keep one like it up already.
      warmPoolSoon(spec);
      // Replay queued steering / follow-up messages so reattaching mid-run
      // puts the waiting bubbles back in the conversation at once.
      if (session.pendingQueue.steering.length > 0 || session.pendingQueue.followUp.length > 0) {
        send(conn, {
          type: "out",
          sessionId: session.id,
          line: JSON.stringify({
            type: "queue_update",
            steering: session.pendingQueue.steering,
            followUp: session.pendingQueue.followUp,
          }),
        });
      }
      // Replay dialogs still waiting on an answer — a session blocked in the
      // background hands its question to whoever attaches.
      for (const dialog of session.pendingDialogs.values()) {
        send(conn, { type: "out", sessionId: session.id, line: JSON.stringify(dialog) });
      }
      return;
    }
    case "detach": {
      const session = sessions.get(msg.sessionId);
      conn.attaching?.delete(msg.sessionId);
      if (session) {
        session.attached.delete(conn);
        conn.attachedSessions.delete(session.id);
        send(conn, { type: "detached", sessionId: session.id });
        reapEmptyDraft(session);
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
      if (session && (typeof msg.file === "string" || msg.file === null)) {
        setFile(session, msg.file || undefined);
      }
      return;
    }
    case "workspaces": {
      // The app's open projects, for workspaces_list; the standby pool needs no restart for them.
      if (Array.isArray(msg.paths)) config.workspaces = msg.paths.filter((dir) => typeof dir === "string" && dir);
      if (id) respond(conn, id, "ok", {});
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
    case "remove": {
      const session = sessions.get(msg.sessionId);
      if (session) {
        await stopTree(session);
        const targets = [session, ...descendantsOf(session).filter((d) => !hasSavedConversation(d.file))];
        for (const target of targets) removeSessionRecord(target);
      }
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
    case "set_session_choices": {
      const session = sessions.get(msg.sessionId);
      if (!session) return respondError(conn, id, "no such session");
      if (!(await startProcess(session))) return respondError(conn, id, "agent could not start");
      if (!(await applyLaunchChoices(session, msg.input ?? {}))) return respondError(conn, id, session.lastError || "could not apply session choices");
      respond(conn, id, "session", { session: sessionInfo(session) });
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
        let replacedPersona;
        if (input.persona === true) {
          if (parent) throw new Error("the personal agent answers to the user, not to a session");
          const held = [...sessions.values()].find((s) => s.persona);
          if (held && input.replacePersona !== held.id) throw new Error(`the personal agent already runs as ${held.id}`);
          if (input.replacePersona && !held) throw new Error("the personal agent changed; refresh before switching");
          if (input.worktree) throw new Error("the personal agent cannot use a worktree");
          ensurePersonaDir();
          replacedPersona = held;
          if (held) removeSessionRecord(held);
        }
        const cwd = input.persona === true ? PERSONA_DIR : input.cwd || parent?.cwd || process.cwd();
        // A child's mode never exceeds its parent's — the same clamp agents get.
        const parentCeiling = parent ? minMode(ancestorCeiling(parent), parent.runtimeMode) : undefined;
        const rawMode = parent
          ? clampMode(parentCeiling, input.runtimeMode)
          : !input.runtimeMode || input.runtimeMode === "inherit"
            ? "full-access"
            : clampMode("full-access", input.runtimeMode);
        const runtimeMode = fitAgentModes(rawMode, agent.supportedRuntimeModes);
        const title = input.persona === true ? personaName() : input.title;
        const session = createSession({
          title,
          titleLocked: Boolean(title),
          persona: input.persona === true,
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
        if (replacedPersona) {
          for (const child of sessions.values()) {
            if (child.id === session.id) continue;
            let changed = false;
            for (const key of ["parentId", "initiator", "upstreamInitiator"]) {
              if (child[key] !== replacedPersona.id) continue;
              child[key] = session.id;
              changed = true;
            }
            if (changed) pushSession(child);
          }
        }
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
          if (!(await applyLaunchChoices(session, input))) return;
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
    case "prewarm": {
      const spec = msg.session;
      if (spec && typeof spec === "object" && spec.cwd) {
        clearTimeout(poolWarmTimer);
        poolWarmTimer = undefined;
        pendingPoolSpec = undefined;
        warmPool(spec);
      }
      if (id) respond(conn, id, "ok", {});
      return;
    }
    case "clear_catalog": {
      if (typeof msg.agentId === "string" && msg.agentId && catalogCache.delete(msg.agentId)) {
        scheduleSaveCatalogCache();
      }
      if (id) respond(conn, id, "ok", {});
      return;
    }
    case "config": {
      const prevLaunchSig = JSON.stringify({
        agents: config.agents,
        overrides: config.overrides,
        customAgents: config.customAgents,
        allowAgentTools: config.allowAgentTools,
      });
      const prevChoices = config.sessionChoices;
      const { agents, overrides, customAgents, allowAgentTools, sendScope, maxDepth, maxRunning, worktreeDefault, sessionChoices, autoRetry } = msg;
      if (Array.isArray(agents)) config.agents = agents;
      if (overrides) config.overrides = overrides;
      if (Array.isArray(customAgents)) config.customAgents = customAgents;
      if (typeof allowAgentTools === "boolean") config.allowAgentTools = allowAgentTools;
      if (sendScope === "all" || sendScope === "children") config.sendScope = sendScope;
      if (typeof maxDepth === "number") config.maxDepth = maxDepth;
      if (typeof maxRunning === "number") config.maxRunning = maxRunning;
      if (typeof worktreeDefault === "boolean") config.worktreeDefault = worktreeDefault;
      if (sessionChoices && typeof sessionChoices === "object") config.sessionChoices = sessionChoices;
      if (typeof autoRetry === "boolean" || autoRetry === undefined) {
        if ("autoRetry" in msg) config.autoRetry = autoRetry;
      }
      if (typeof msg.linger === "boolean") {
        config.linger = msg.linger;
        checkWindowlessExit();
      }
      const nextLaunchSig = JSON.stringify({
        agents: config.agents,
        overrides: config.overrides,
        customAgents: config.customAgents,
        allowAgentTools: config.allowAgentTools,
      });
      if (nextLaunchSig !== prevLaunchSig) {
        // Standby processes were booted under the previous roster/tools config.
        for (const entry of [...pool.values()]) {
          clearTimeout(entry.timer);
          killProcess(entry.session);
        }
        pool.clear();
      } else if (sessionChoices && typeof sessionChoices === "object") {
        // Keep warm standbys alive when only model/effort preferences changed; update them in place.
        for (const entry of pool.values()) {
          const aid = entry.session.agentId;
          if (JSON.stringify(prevChoices?.[aid]) !== JSON.stringify(config.sessionChoices?.[aid])) {
            entry.session.initialChoice = config.sessionChoices?.[aid];
            void prewarmStandby(entry.session);
          }
        }
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
    case "shutdown_if_idle": {
      if (conn.kind !== "ui") {
        respondError(conn, id, "ui client required");
        return;
      }
      if (!hasActiveRuns()) {
        respond(conn, id, "ok", { shuttingDown: true });
        setTimeout(() => shutdownDaemon(), 25).unref?.();
      } else {
        pendingUpgrade = true;
        respond(conn, id, "ok", { shuttingDown: false, deferred: true });
      }
      return;
    }
    default:
      if (id) respondError(conn, id, `unknown op "${msg.type}"`);
  }
}

let sawUiClient = false;
let pendingUpgrade = false;
let windowlessTimer;
let shutdownDaemon = () => process.exit(0);

function hasActiveRuns() {
  for (const s of sessions.values()) {
    if ((s.loaded && (s.status === "working" || s.status === "blocked" || s.backgroundWatch)) || s.deliverQueue.length > 0 || s.starting) return true;
  }
  return false;
}

function checkWindowlessExit() {
  const hasUi = [...controlClients].some((c) => c.kind === "ui");
  if (pendingUpgrade && !hasUi && !hasActiveRuns()) {
    if (windowlessTimer) {
      clearTimeout(windowlessTimer);
      windowlessTimer = undefined;
    }
    shutdownDaemon();
    return;
  }
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
        send(conn, {
          type: "hello",
          sessions: [...sessions.values()].map(sessionInfo),
          config: publicConfig(),
          catalogs: publicCatalogs(),
        });
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
      const held = sessions.get(sessionId);
      if (held) {
        held.attached.delete(conn);
        reapEmptyDraft(held);
      }
    }
    for (const sessionId of conn.attaching ?? []) {
      conn.attaching.delete(sessionId);
      const held = sessions.get(sessionId);
      if (held) reapEmptyDraft(held);
    }
    conn.attaching?.clear();
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
          const result = await callSessionTool(caller.session ?? undefined, name, msg.params?.arguments ?? {}, { external: Boolean(caller.external) });
          reply({
            result: {
              content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
              ...(result && typeof result === "object" ? { structuredContent: result } : {}),
            },
          });
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
          file: info.file || undefined,
          launch: record.launch ?? { binaryPath: info.binaryPath, extraArgs: info.extraArgs, customAgent: info.customAgent },
          attached: new Set(),
          proc: undefined,
          starting: undefined,
          discoveringFile: undefined,
          internalPending: new Map(),
          pendingDialogs: new Map(),
          pendingQueue: { steering: [], followUp: [] },
          deliverQueue: [],
          lastAnswer: "",
          pendingAnswer: "",
          blockedNotified: false,
          suppressStopDelivery: false,
          exitExpected: false,
          backgroundWatch: false,
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
          if (!session.file) session.file = undefined;
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
    } else if (record.type === "session_remove" && record.id) {
      const gone = sessions.get(record.id);
      if (gone) {
        if (gone.file && sessionsByFile.get(gone.file) === gone.id) sessionsByFile.delete(gone.file);
        sessions.delete(record.id);
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
      if (isSessionInitiator(initiator, session.id)) {
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
  // Sweep untouched scratchpads (including legacy ones whose idle exit marked them `interrupted`).
  for (const session of [...sessions.values()]) {
    if (
      !session.parentId &&
      !session.worktree &&
      !session.titleLocked &&
      (session.initiator ?? session.upstreamInitiator) !== "external" &&
      (!session.title || session.title === "New session") &&
      !session.deliverQueue.length &&
      descendantsOf(session).length === 0 &&
      !hasSavedConversation(session.file) &&
      (session.status === "idle" || session.status === "interrupted")
    ) {
      if (session.file && sessionsByFile.get(session.file) === session.id) sessionsByFile.delete(session.file);
      sessions.delete(session.id);
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
    lines.push(JSON.stringify({ type: "session", info: { ...sessionInfo(session), token: session.token, editBlocked: session.editBlocked }, launch: session.launch }));
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
  const isUnloadableIdle = (s) =>
    s.loaded &&
    !s.exitExpected &&
    s.status !== "working" &&
    s.status !== "blocked" &&
    !s.backgroundWatch &&
    s.attached.size === 0 &&
    s.deliverQueue.length === 0;
  const roots = new Set([...sessions.values()].map((s) => rootOf(s).id));
  const cutoff = now() - IDLE_UNLOAD_MS;
  for (const rootId of roots) {
    const root = sessions.get(rootId);
    if (!root) continue;
    const tree = [root, ...descendantsOf(root)];
    // An attached session (or one watching an autonomous background wake) is never the unload's.
    const loaded = tree.filter(isUnloadableIdle);
    for (const session of loaded.filter((s) => s.lastActive < cutoff)) killProcess(session);
    const still = loaded.filter((s) => !s.exitExpected && s.lastActive >= cutoff);
    if (still.length > MAX_LOADED_PER_TREE) {
      still.sort((a, b) => a.lastActive - b.lastActive);
      for (const session of still.slice(0, still.length - MAX_LOADED_PER_TREE)) killProcess(session);
    }
  }
  const globalIdle = [...sessions.values()].filter(isUnloadableIdle);
  if (globalIdle.length > MAX_LOADED_IDLE) {
    const graceCutoff = now() - IDLE_GRACE_MS;
    const candidates = globalIdle.filter((s) => s.lastActive < graceCutoff).sort((a, b) => a.lastActive - b.lastActive);
    const excess = globalIdle.length - MAX_LOADED_IDLE;
    for (const session of candidates.slice(0, excess)) killProcess(session);
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

  const instance = {
    pid: process.pid,
    controlPort,
    mcpPort,
    token: CONTROL_TOKEN,
    started: now(),
    fingerprint: DAEMON_FINGERPRINT,
    sidecarDir: __dirname,
  };
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
        running && isSessionInitiator(session.initiator, session.id) ? session.initiator : undefined;
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
    for (const entry of pool.values()) {
      clearTimeout(entry.timer);
      if (entry.session.proc) {
        entry.session.exitExpected = true;
        try {
          entry.session.proc.kill("SIGTERM");
        } catch {}
      }
    }
    pool.clear();
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
