// Universal RPC bridge for external coding agents (`Claude Code`, `Codex`, `OpenCode`, `Cursor`, `ACP`):
//
//   node sidecar/external-agent.mjs <json-config>
//
// Speaks Pi's exact JSONL RPC protocol on stdin/stdout (one JSON object per LF-terminated
// line, command responses correlated by `id`, `agent_settled` at turn end), so pipi's
// QuickJS `PiClient`, `Transcript`, streaming deltas, approvals, and session persistence
// work identically across every external coding agent!
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  acpCostPart,
  acpMetaSample,
  acpPromptPart,
  addInto,
  claudeAssistantSample,
  claudeResultParts,
  codexTurnPart,
  cursorResultPart,
  dropLegacyUsage,
  fromUsage,
  isBlank,
  openCodeStepPart,
  tally,
  tokensOf,
  toUsage,
  ZERO_USAGE,
} from "./agent-usage.mjs";
import { agentAuthEnv, childEnv, ensureDir, externalSessionsDir, resolveBinary, shellForCommand, spawnBinary } from "./env-paths.mjs";
import { titleWords } from "./session-index.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mcpStdioScript = path.join(__dirname, "pipi-mcp-stdio.mjs");

const config = JSON.parse(process.argv[2] || "{}");
const cwd = path.resolve(config.cwd || process.cwd());
const agentId = config.agentId || "claude";
const driver = config.driver || agentId;
let runtimeMode = config.runtimeMode || "full-access";
const isSubagent = !!config.isSubagent;
const orchestratorUrl = config.orchestratorUrl || process.env.PIPI_ORCHESTRATOR_URL || "";
const orchestratorToken = config.orchestratorToken || process.env.PIPI_ORCHESTRATOR_TOKEN || "";

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const zeroUsage = ZERO_USAGE;

const BUILTIN_ACP_PRESETS = {
  devin: { binary: "devin", args: ["acp"], envVar: "DEVIN_API_KEY" },
  gemini: { binary: "gemini", args: ["--experimental-acp"], envVar: "GEMINI_API_KEY" },
  copilot: { binary: "copilot", args: ["--acp"], envVar: "COPILOT_GITHUB_TOKEN" },
  grok: { binary: "grok", args: ["--no-auto-update", "agent", "--no-leader", "stdio"], envVar: "XAI_API_KEY" },
  goose: { binary: "goose", args: ["acp"] },
  kimi: { binary: "kimi", args: ["acp"], envVar: "MOONSHOT_API_KEY" },
  qwen: { binary: "qwen", args: ["--acp"], envVar: "DASHSCOPE_API_KEY" },
  dsh: { binary: "dsh", args: ["--profile", "acp"], envVar: "DEEPSEEK_API_KEY" },
  // Plain `acp`: --process-per-session wedged requests when the front exited and
  // a session worker inherited its pipes, and pipi already gives each session
  // its own agy process, so the extra isolation only added failure modes.
  antigravity: { binary: "agy", fallbackBinaries: ["agy_acp_server"], args: ["acp"] },
  hermes: { binary: "hermes", args: ["acp"] },
  kiro: { binary: "kiro-cli", fallbackBinaries: ["kiro"], args: ["acp"] },
  droid: { binary: "droid", args: ["acp"], envVar: "FACTORY_API_KEY" },
  amp: { binary: "amp-acp", args: [], envVar: "AMP_API_KEY" },
};

const BUILTIN_ENV_VARS = {
  claude: "ANTHROPIC_API_KEY",
  codex: "OPENAI_API_KEY",
  cursor: "CURSOR_API_KEY",
  opencode: "OPENCODE_API_KEY",
  ...Object.fromEntries(Object.entries(BUILTIN_ACP_PRESETS).filter(([, v]) => v.envVar).map(([k, v]) => [k, v.envVar])),
};

// Ambient Google/Gemini credentials would silently leak an account or profile
// into a session the user configured differently (as T3 Code's adapter does) —
// agy sessions run without them unless the key itself is pipi's configured one.
const AGY_AMBIENT_ENV = [
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GEMINI_HOME",
];

function agentRuntimeEnv(extra = {}) {
  const envVar = config.customAgent?.envVar || BUILTIN_ENV_VARS[agentId];
  const auth = agentAuthEnv(agentId, envVar);
  const env = childEnv({ ...auth, ...extra });
  if (agentId === "antigravity") {
    for (const key of AGY_AMBIENT_ENV) {
      if (key === envVar || auth[key] !== undefined) continue;
      delete env[key];
    }
  }
  return env;
}

const AGENT_NAMES = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  cursor: "Cursor",
  devin: "Devin",
  gemini: "Gemini CLI",
  copilot: "GitHub Copilot",
  grok: "Grok",
  goose: "Goose",
  kimi: "Kimi CLI",
  qwen: "Qwen Code",
  dsh: "DeepSeek Harness",
  antigravity: "Antigravity",
  hermes: "Hermes",
  kiro: "Kiro",
  droid: "Factory Droid",
  amp: "Amp",
};

/**
 * Drivers whose prompt transport carries image content blocks: ACP sends them
 * in `session/prompt`, Claude Code takes them in a stream-json user message on
 * stdin. Codex, OpenCode and Cursor still go out as a text-only CLI argument.
 */
const IMAGE_DRIVERS = new Set(["acp", "claude"]);

/**
 * The only honest pre-connect entry: "the engine's own configured default".
 * Real model catalogs are adopted at runtime — ACP agents advertise them on
 * `session/new` (`models.availableModels`, or Devin-style `configOptions` also
 * pushed live via `config_option_update`), and Claude Code is asked directly
 * through its stream-json `initialize` control request (probeClaude below).
 * No fabricated lists.
 */
function engineDefaultModel() {
  const name = config.customAgent?.name || AGENT_NAMES[agentId] || agentId;
  return {
    id: "default",
    name: `${name} Default`,
    api: driver === "acp" ? "acp" : agentId,
    provider: agentId,
    reasoning: false,
    input: IMAGE_DRIVERS.has(driver) ? ["text", "image"] : ["text"],
    cost: zeroCost,
  };
}

function initialModels() {
  if (driver === "acp" && config.customAgent) {
    const m = config.customAgent.defaultModel || "default";
    return [
      {
        id: m,
        name: config.customAgent.defaultModel || `${config.customAgent.name} Default`,
        api: "acp",
        provider: config.customAgent.id || "acp",
        reasoning: false,
        input: ["text", "image"],
        cost: zeroCost,
      },
    ];
  }
  return [engineDefaultModel()];
}

const availableModels = initialModels();
let currentModel = availableModels[0];
let thinkingLevel = "medium";
// False until the user (or a loaded session's header) picks a thinking depth:
// while unset, ACP sessions keep their own advertised effort instead of a pipi default.
let thinkingLevelSet = false;
let steeringMode = "one-at-a-time";
let followUpMode = "one-at-a-time";
let autoCompactionEnabled = true;

let sessionId = crypto.randomUUID();
let sessionName = undefined;
let sessionFile = undefined;
let nativeThreadId = undefined; // Claude session_id / Codex thread_id / ACP sessionId
let messages = [];
let isStreaming = false;
let turnPromise = undefined;
let activeSubTurn = undefined;
let sessionEpoch = 0;
let activeChild = undefined;
let abortRequested = false;
let queuedSteering = [];
let queuedFollowUp = [];
// A queued steering message interrupted the in-flight turn; it (not the abort)
// owns the next turn, so the drain below must run even though the turn ended
// aborted — steering by interrupt-restart for engines without native mid-turn
// injection.
let steerInterrupt = false;
// What the engine reported for this session (`agent-usage.mjs`): the sum of the
// usage on its assistant messages and of `sessionUsageEntries`, the Pi-format
// `usage` entries for work that left no message (a run cut short before any
// reply, a result that came after the turn's answer).
let sessionUsage = tally();
let sessionUsageEntries = [];
// The engine's own running total for `nativeThreadId` at the last reading — what
// the next reading is measured against (Claude's per-model session total, Codex's
// thread total, ACP's session cost). Saved with the session: the engine's total
// outlives this process.
let usageBaseline = undefined;
// What the last model request held in context, and the window an ACP agent
// reported with it (Claude's is adopted onto the model: `adoptClaudeModelUsage`).
let contextTokens = undefined;
let contextWindow = undefined;

function resetSessionUsage() {
  sessionUsage = tally();
  sessionUsageEntries = [];
  usageBaseline = undefined;
  contextTokens = undefined;
  contextWindow = undefined;
  acpUsage = undefined;
}

/** Usage that belongs to no message: kept as a Pi `usage` entry in the session file. */
function recordUsageEntry(usage, kind) {
  if (usage === ZERO_USAGE) return;
  sessionUsageEntries.push({ type: "usage", timestamp: new Date().toISOString(), kind, provider: currentModel.provider, model: currentModel.id, usage });
  addInto(sessionUsage, fromUsage(usage));
}

// Pending UI approval promises (for ACP `session/request_permission`)
const pendingUiRequests = new Map();

function emit(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

/**
 * A write to a child that just died surfaces as an `error` event on its stdin
 * (EPIPE), not as a throw — and an unhandled one ends this bridge, taking the
 * session with it. The child's own `close`/`error` already says what happened.
 */
function guardStdin(child) {
  child.stdin?.on("error", () => {});
  return child;
}

// ── The agent's own slash commands ───────────────────────────────────────────────
// Only what the engine itself reports: ACP's `available_commands_update`
// (`{name, description, input: {hint}}`) and Claude Code's `initialize` answer
// (`commands: [{name, description, argumentHint}]`). Either is run the way the
// engine documents: `/name args` as the prompt's text. The other drivers report
// none, and get none — pipi's own commands (`/delegate`, `/parallel`, …) are
// the client's and never pass through here.
let agentCommands = [];

function adoptCommands(reported) {
  const next = [];
  for (const c of Array.isArray(reported) ? reported : []) {
    const name = String(c?.name ?? "").trim().replace(/^\//, "");
    if (!name || /\s/.test(name) || next.some((known) => known.name === name)) continue;
    // A skill's description can run to a page: the menu shows a line.
    const description = typeof c?.description === "string" ? c.description.trim().split("\n")[0].slice(0, 200) : "";
    const hint = typeof c?.argumentHint === "string" ? c.argumentHint.trim() : typeof c?.input?.hint === "string" ? c.input.hint.trim() : "";
    next.push({ name, ...(description ? { description } : {}), source: "agent", ...(hint ? { argumentHint: hint } : {}) });
  }
  if (JSON.stringify(next) === JSON.stringify(agentCommands)) return;
  agentCommands = next;
  emit({ type: "commands_changed" });
}

function normalizeToolName(raw) {
  const s = String(raw || "tool").trim();
  switch (s) {
    case "Bash":
    case "shell":
    case "command_execution":
    case "execute_command":
      return "bash";
    case "Read":
    case "read_file":
      return "read";
    case "Write":
    case "write_file":
      return "write";
    case "Edit":
    case "MultiEdit":
    case "file_change":
      return "edit";
    case "Grep":
      return "grep";
    case "Glob":
      return "find";
    case "LS":
      return "ls";
    default:
      return s.replace(/^mcp__(?:pipi|t3[-_]code)__/, "");
  }
}

// ── Session Persistence (compatible with list-sessions.mjs) ─────────────────
//
// The `.jsonl` is the header (line 0) plus one line per message and usage
// entry; saves append what is new instead of rewriting history. The header
// fields that change every turn — `context`, `usageBaseline`, `modified` —
// live in `<file>.state.json`, a few hundred bytes rewritten per save, and
// load merges them back over the header. A structural header change
// (name/model/driver/…) still rewrites the whole file; `flushed` tracks
// what is on disk so that stays rare.
let flushed = undefined; // {key, messages, usage, bytes} — what the .jsonl holds
let flushedState = undefined; // serialized .state.json contents last written
let messagesDirty = false; // an already-written message changed in place
let saveChain = Promise.resolve(); // saves never overlap

function saveExternalSession() {
  const run = saveChain.then(() => saveExternalSessionNow(), () => saveExternalSessionNow());
  saveChain = run.then(() => undefined, () => undefined);
  return run;
}

/** The header minus the volatile fields that live in the state file. */
function stableHeaderKey(header) {
  const { usageBaseline, context, modified, ...stable } = header;
  return JSON.stringify(stable);
}

async function writeSessionState(volatile) {
  const text = JSON.stringify(volatile);
  if (text === flushedState) return;
  const target = `${sessionFile}.state.json`;
  const tmp = `${target}.tmp.${process.pid}`;
  try {
    await fsp.writeFile(tmp, text, { mode: 0o600 });
    await fsp.rename(tmp, target);
    flushedState = text;
  } catch {}
}

async function saveExternalSessionNow() {
  if (messages.length === 0) return;
  const dir = externalSessionsDir(cwd);
  if (!sessionFile) {
    sessionFile = path.join(dir, `${sessionId}.pipi-agent.jsonl`);
  }
  await ensureDir(dir);
  const firstUser = messages.find((m) => m.role === "user");
  const firstText =
    typeof firstUser?.content === "string"
      ? firstUser.content
      : Array.isArray(firstUser?.content)
        ? firstUser.content.find((b) => b.type === "text")?.text || ""
        : "";
  const header = {
    type: "pipi_external_session",
    version: 2,
    id: sessionId,
    agentId,
    driver,
    nativeThreadId,
    cwd,
    name: sessionName,
    firstMessage: titleWords(firstText).slice(0, 240),
    model: currentModel,
    thinkingLevel,
    usageBaseline,
    context: { tokens: acpUsage?.used ?? contextTokens, window: acpUsage?.size || contextWindow },
    created: messages[0]?.timestamp || Date.now(),
    modified: Date.now(),
  };
  const key = stableHeaderKey(header);
  const stat = await fsp.stat(sessionFile).catch(() => undefined);
  const appendable =
    flushed && !messagesDirty && stat && stat.size === flushed.bytes && flushed.key === key;
  if (appendable) {
    const newMsgs = messages.slice(flushed.messages);
    const newUsage = sessionUsageEntries.slice(flushed.usage);
    const tail = [
      ...newMsgs.map((m) => JSON.stringify({ type: "message", message: m })),
      ...newUsage.map((entry) => JSON.stringify(entry)),
    ];
    if (tail.length) {
      const chunk = `${tail.join("\n")}\n`;
      await fsp.appendFile(sessionFile, chunk, "utf8");
      // Only the lines just written count as flushed — entries pushed while
      // the write was in flight flush on the next save.
      flushed.bytes += Buffer.byteLength(chunk);
      flushed.messages += newMsgs.length;
      flushed.usage += newUsage.length;
    }
  } else {
    const msgCount = messages.length;
    const usageCount = sessionUsageEntries.length;
    const lines = [
      JSON.stringify(header),
      ...messages.map((m) => JSON.stringify({ type: "message", message: m })),
      ...sessionUsageEntries.map((entry) => JSON.stringify(entry)),
    ];
    const body = `${lines.join("\n")}\n`;
    await fsp.writeFile(sessionFile, body, "utf8");
    flushed = { key, messages: msgCount, usage: usageCount, bytes: Buffer.byteLength(body) };
    messagesDirty = false;
  }
  await writeSessionState({ usageBaseline, context: header.context, modified: header.modified });
}

async function loadExternalSession(targetPath) {
  const raw = await fsp.readFile(targetPath, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  const loadedMessages = [];
  const loadedUsage = [];
  let header = undefined;
  for (const line of lines) {
    const parsed = JSON.parse(line);
    if (parsed.type === "pipi_external_session") {
      header = parsed;
    } else if (parsed.type === "message" && parsed.message) {
      loadedMessages.push(parsed.message);
    } else if (parsed.type === "usage" && parsed.usage) {
      loadedUsage.push(parsed);
    } else if (parsed.type === "session" && parsed.id) {
      // Standard Pi session file opened while an external agent is active!
      header = { id: parsed.id, name: undefined, nativeThreadId: undefined };
    }
  }
  sessionFile = targetPath;
  sessionId = header?.id || path.basename(targetPath, ".jsonl");
  sessionName = header?.name;
  nativeThreadId = header?.driver === driver ? header?.nativeThreadId : undefined;
  if (header?.model && typeof header.model.id === "string" && header.model.id) {
    // Claude's image reach is the transport's, not the model entry's — a file
    // saved before the stream-json prompt still reads as text-only.
    const restored = driver === "claude" ? { ...header.model, input: ["text", "image"] } : header.model;
    if (!availableModels.some((m) => m.id === restored.id && m.provider === restored.provider)) {
      availableModels.push(restored);
    }
    currentModel = restored;
  }
  if (typeof header?.thinkingLevel === "string" && header.thinkingLevel) {
    thinkingLevel = header.thinkingLevel;
    thinkingLevelSet = true;
  }
  if (header?.type === "pipi_external_session" && (header.version ?? 1) < 2) dropLegacyUsage(loadedMessages);
  resetSessionUsage();
  for (const m of loadedMessages) if (m.role === "assistant") addInto(sessionUsage, fromUsage(m.usage));
  for (const entry of loadedUsage) addInto(sessionUsage, fromUsage(entry.usage));
  sessionUsageEntries = loadedUsage;
  // The volatile header fields live in the state file once the session has
  // been saved incrementally; it wins over the (older) header copy.
  let savedState;
  try {
    savedState = JSON.parse(await fsp.readFile(`${targetPath}.state.json`, "utf8"));
  } catch {}
  if (header?.driver === driver) {
    const baseline = savedState?.usageBaseline ?? header.usageBaseline;
    usageBaseline = baseline && typeof baseline === "object" ? baseline : undefined;
    const ctx = savedState?.context ?? header.context;
    contextTokens = typeof ctx?.tokens === "number" ? ctx.tokens : undefined;
    contextWindow = typeof ctx?.window === "number" && ctx.window > 0 ? ctx.window : undefined;
    try {
      flushedState = savedState !== undefined ? JSON.stringify(savedState) : undefined;
    } catch {
      flushedState = undefined;
    }
  } else {
    flushedState = undefined;
  }
  messagesDirty = false;
  if (clearStaleBackgroundTools(loadedMessages)) messagesDirty = true;
  messages = loadedMessages;
  // The file already holds what was loaded: appends continue from there, and
  // the next structural header difference (a Pi header, a driver switch) falls
  // back to a rewrite.
  flushed = { key: stableHeaderKey(header || {}), messages: loadedMessages.length, usage: loadedUsage.length, bytes: Buffer.byteLength(raw) };
}

// ── Orchestration Guidance for External Coordinator Agents ──────────────────

const EXTERNAL_ORCHESTRATION_PROMPT = `
You are running inside pipi with session tools (via the \`pipi\` MCP server when available):
- Call \`agents_list\` to see the coding agents you can start sessions with and whether they can drive sessions themselves.
- Call \`session_start\` to open a child session on a task — it runs on its own and its answer is delivered back to you when it finishes. Never wait on it.
- Call \`sessions_list\`, \`session_read\`, \`session_send\`, and \`session_stop\` to inspect, message, or stop sessions in your tree.
`.trim();

// ── Streaming Turn Execution per Driver ─────────────────────────────────────

function resolveDriverBinary() {
  if (config.binaryPath) {
    return resolveBinary(config.binaryPath);
  }
  if (driver === "acp" && config.customAgent) {
    const dist = config.customAgent.distribution || "binary";
    const launcher = dist === "npx" ? "npx" : dist === "uvx" ? "uvx" : config.customAgent.command;
    return resolveBinary(launcher);
  }
  if (driver === "acp" && BUILTIN_ACP_PRESETS[agentId]) {
    const preset = BUILTIN_ACP_PRESETS[agentId];
    let found = resolveBinary(preset.binary);
    if (!found && Array.isArray(preset.fallbackBinaries)) {
      for (const alt of preset.fallbackBinaries) {
        found = resolveBinary(alt);
        if (found) break;
      }
    }
    return found;
  }
  const defaults = { claude: "claude", codex: "codex", opencode: "opencode", cursor: "cursor-agent" };
  return resolveBinary(defaults[driver] || driver);
}

/** pipi's `{type:"image",data,mimeType}` prompt images, normalized into ACP content blocks. */
function imageBlocks(images) {
  return (Array.isArray(images) ? images : [])
    .filter((i) => i && i.type === "image" && typeof i.data === "string" && i.data)
    .map((i) => ({ type: "image", data: i.data, mimeType: String(i.mimeType || "image/png") }));
}

// Signals the agent's whole process group (spawned `detached`): a CLI's own
// children — an in-flight build, a tool call — hold the stdio pipes open after
// the parent dies, and `close` would wait on them and stall the interrupt.
function signalAgent(signal) {
  const child = driver === "acp" ? acpChild : activeChild;
  if (!child) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
}

function interruptActiveTurn() {
  abortRequested = true;
  acpWakeSleepWake?.();
  bumpAcpDeferred();
  for (const [, resolve] of pendingUiRequests) resolve(false);
  pendingUiRequests.clear();
  if (driver === "acp") {
    // Antigravity's `session/cancel` kills running background commands and
    // subagents: when steering after the prompt already settled (held open on
    // background work or in a wake turn), leave the background work alive.
    const preserveAgyWork = steerInterrupt && isAntigravityAcp() && Boolean(acpDeferred?.promptSettled);
    // Politely interrupt the in-flight prompt; an agent that ignores
    // `session/cancel` is dropped by settleActiveTurn's stall timeout
    // (dropAcpPeer), and the next turn re-attaches via session/load.
    if (acpStream && !preserveAgyWork) acpNotify("session/cancel", { sessionId: acpSessionId });
  } else if (activeChild) {
    signalAgent("SIGTERM");
  }
}

async function waitWithStallTimeout(active, timeoutMs = 0) {
  if (!active) return;
  interruptActiveTurn();
  if (timeoutMs <= 0) {
    await active.catch(() => undefined);
    return;
  }
  let timer;
  const outcome = await Promise.race([
    active.then(() => "settled", () => "settled"),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve("stalled"), timeoutMs);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (outcome === "stalled") {
    if (driver === "acp") dropAcpPeer("ACP turn cancelled");
    else if (activeChild) signalAgent("SIGKILL");
    await active.catch(() => undefined);
  }
}

async function settleCurrentSubTurn(timeoutMs = 0) {
  await waitWithStallTimeout(activeSubTurn, timeoutMs);
}

async function settleActiveTurn(timeoutMs = 0) {
  await waitWithStallTimeout(turnPromise, timeoutMs);
}

// Drivers whose conversation survives a restart: a "steer" interrupts the
// in-flight turn now and re-runs on the resumed thread (ACP re-prompts on the
// same live session), instead of queueing behind the turn like a follow-up.
// Cursor's exec mode keeps no resumable thread here, so it stays queued.
const STEER_RESTART_DRIVERS = new Set(["claude", "codex", "opencode"]);

function canSteerRestart() {
  if (driver === "acp") return !!acpSessionId;
  return STEER_RESTART_DRIVERS.has(driver) && !!nativeThreadId;
}

function dequeueNextTurn() {
  if (queuedSteering.length > 0) {
    if (steeringMode === "all" && queuedSteering.length > 1) {
      const all = queuedSteering.splice(0);
      return { text: all.map((q) => q.text).join("\n\n"), images: all.flatMap((q) => q.images) };
    }
    return queuedSteering.shift();
  }
  if (queuedFollowUp.length > 0) {
    if (followUpMode === "all" && queuedFollowUp.length > 1) {
      const all = queuedFollowUp.splice(0);
      return { text: all.map((q) => q.text).join("\n\n"), images: all.flatMap((q) => q.images) };
    }
    return queuedFollowUp.shift();
  }
  return undefined;
}

function executeTurn(promptText, images = []) {
  isStreaming = true;
  const run = runTurnLoop(promptText, images);
  turnPromise = run.finally(() => {
    if (turnPromise === run) turnPromise = undefined;
  });
  return turnPromise;
}

async function runTurnLoop(initialText, initialImages = []) {
  const turnEpoch = sessionEpoch;
  const emitTurn = (record) => {
    if (sessionEpoch === turnEpoch) emit(record);
  };
  let next = { text: initialText, images: initialImages };
  let finalAborted = false;

  while (next && sessionEpoch === turnEpoch) {
    const sub = runSingleTurn(next.text, next.images, turnEpoch, emitTurn);
    activeSubTurn = sub.finally(() => {
      if (activeSubTurn === sub) activeSubTurn = undefined;
    });
    const result = await activeSubTurn;
    if (sessionEpoch !== turnEpoch) return;
    if (result === "no-binary") {
      if (queuedSteering.length > 0 || queuedFollowUp.length > 0) {
        queuedSteering = [];
        queuedFollowUp = [];
        emitTurn({ type: "queue_update", steering: [], followUp: [] });
      }
      finalAborted = false;
      break;
    }

    // Drain queued steering / follow-up messages BEFORE emitting `agent_settled`:
    // `agent_settled` means no queued or automatic work remains (`docs/pi/json.md`).
    const wasSteerInterrupt = steerInterrupt;
    const mayDrain = !abortRequested || wasSteerInterrupt;
    steerInterrupt = false;
    if (mayDrain && sessionEpoch === turnEpoch && (queuedSteering.length > 0 || queuedFollowUp.length > 0)) {
      next = dequeueNextTurn();
      emitTurn({
        type: "queue_update",
        steering: queuedSteering.map((q) => q.text),
        followUp: queuedFollowUp.map((q) => q.text),
      });
      if (next) continue;
    }
    finalAborted = abortRequested && !wasSteerInterrupt;
    break;
  }

  if (sessionEpoch === turnEpoch) {
    isStreaming = false;
    abortRequested = false;
    emitTurn({ type: "agent_settled", aborted: finalAborted });
  }
}

async function runSingleTurn(promptText, images, turnEpoch, emitTurn) {
  isStreaming = true;
  abortRequested = false;
  if (sessionEpoch !== turnEpoch) return "stale";
  if (abortRequested && !steerInterrupt) return "aborted";
  if (abortRequested && steerInterrupt) {
    // Steer arrived while waking before `promptText` even started: run `promptText` first,
    // and keep the queued steering message next in line right behind it.
    abortRequested = false;
    steerInterrupt = false;
  }

  const userMsg = { role: "user", content: [{ type: "text", text: promptText }, ...images], timestamp: Date.now() };
  messages.push(userMsg);
  // Assign `sessionFile` and write the session file BEFORE emitting `agent_start` / `message_end`,
  // so `get_state` and session scans immediately see `sessionFile` even if the user switches right away.
  if (sessionEpoch === turnEpoch) await saveExternalSession().catch(() => undefined);
  if (sessionEpoch !== turnEpoch) return "stale";

  emitTurn({ type: "agent_start" });
  emitTurn({ type: "turn_start" });
  emitTurn({ type: "message_start", message: userMsg });
  emitTurn({ type: "message_end", message: userMsg });

  const bin = resolveDriverBinary();
  if (!bin) {
    const errText = `Executable for ${agentId} was not found on PATH. Configure its path in Settings → Agents.`;
    const errMsg = {
      role: "assistant",
      content: [],
      provider: currentModel.provider,
      model: currentModel.id,
      usage: zeroUsage,
      stopReason: "error",
      errorMessage: errText,
      timestamp: Date.now(),
    };
    if (sessionEpoch === turnEpoch) messages.push(errMsg);
    if (sessionEpoch === turnEpoch) await saveExternalSession().catch(() => undefined);
    emitTurn({ type: "message_start", message: { ...errMsg, stopReason: "pending" } });
    emitTurn({ type: "message_end", message: errMsg });
    emitTurn({ type: "turn_end" });
    emitTurn({ type: "agent_end", willRetry: false });
    return "no-binary";
  }

  try {
    if (driver === "claude") {
      await runClaudeTurn(bin, promptText, images, turnEpoch);
    } else if (driver === "codex") {
      await runCodexTurn(bin, promptText, turnEpoch);
    } else if (driver === "opencode") {
      await runOpenCodeTurn(bin, promptText, turnEpoch);
    } else if (driver === "cursor") {
      await runCursorTurn(bin, promptText, turnEpoch);
    } else if (driver === "acp") {
      await runAcpTurn(bin, promptText, images, turnEpoch);
    } else {
      throw new Error(`Unsupported external driver: ${driver}`);
    }
  } catch (err) {
    if (!abortRequested) {
      const errMsg = {
        role: "assistant",
        content: [],
        provider: currentModel.provider,
        model: currentModel.id,
        usage: zeroUsage,
        stopReason: "error",
        errorMessage: err instanceof Error ? err.message : String(err),
        timestamp: Date.now(),
      };
      if (sessionEpoch === turnEpoch) messages.push(errMsg);
      emitTurn({ type: "message_start", message: { ...errMsg, stopReason: "pending" } });
      emitTurn({ type: "message_end", message: errMsg });
    }
    emitTurn({ type: "turn_end" });
  }

  if (sessionEpoch === turnEpoch) await saveExternalSession().catch(() => undefined);
  emitTurn({ type: "agent_end", willRetry: false });
  return "done";
}

function makeTurnStreamHelper(turnEpoch = sessionEpoch, { turnStart = false } = {}) {
  const emitTurn = (record) => {
    if (sessionEpoch === turnEpoch) emit(record);
  };
  let startTurn = !!turnStart;
  let msgOpen = false;
  let nextIdx = 0;
  let textIdx = undefined;
  let textBuf = "";
  let thinkIdx = undefined;
  let thinkBuf = "";
  const blocks = [];
  /** Each closed block's contentIndex — close order is not start order. */
  const blockIdx = [];
  const openTools = new Map();
  // What the engine reported for this turn: stamped on the turn's last
  // assistant message, the way Pi stamps each of its own.
  const usageParts = [];
  let sampled = false;
  const lastSample = new Set();
  let finished = false;
  // What this turn said and called, in full — `seen()` answers with it.
  let saidText = "";
  let trailingThoughts = "";
  const calledTools = new Set();
  // Active transient API retry reported by an ACP harness (e.g. Antigravity's
  // `⚠ API error (attempt N): ...` banner), held in status until life resumes or the turn ends.
  let retryState = undefined;

  const clearRetry = (success = true, finalError = undefined) => {
    if (!retryState) return;
    const { attempt } = retryState;
    retryState = undefined;
    emitTurn({ type: "auto_retry_end", success, attempt, ...(finalError ? { finalError } : {}) });
  };

  const openMsg = () => {
    if (msgOpen) return;
    msgOpen = true;
    finished = false; // more of the turn after an early end (Claude's `result` for a background wake)
    emitTurn({
      type: "message_start",
      message: {
        role: "assistant",
        content: [],
        provider: currentModel.provider,
        model: currentModel.id,
        usage: zeroUsage,
        stopReason: "pending",
        ...(startTurn ? { turnStart: true } : {}),
        timestamp: Date.now(),
      },
    });
  };

  const closeThink = () => {
    if (thinkIdx === undefined) return;
    const idx = thinkIdx;
    thinkIdx = undefined;
    blocks.push({ type: "thinking", thinking: thinkBuf });
    blockIdx.push(idx);
    emitTurn({ type: "message_update", usage: zeroUsage, assistantMessageEvent: { type: "thinking_end", contentIndex: idx, content: thinkBuf } });
  };

  const closeText = () => {
    if (textIdx === undefined) return;
    const idx = textIdx;
    textIdx = undefined;
    blocks.push({ type: "text", text: textBuf });
    blockIdx.push(idx);
    emitTurn({ type: "message_update", usage: zeroUsage, assistantMessageEvent: { type: "text_end", contentIndex: idx, content: textBuf } });
  };

  const api = {
    get textBuf() {
      return textBuf;
    },
    get thinkBuf() {
      return thinkBuf;
    },
    get hasBlocks() {
      return blocks.length > 0;
    },
    /**
     * The in-flight message as `get_messages` carries it (`stopReason:
     * "pending"`): what a (re)attached client rebuilds its live rows from, in
     * contentIndex order — blocks close out of order, so they are placed by the
     * index they opened at, not appended. The still-open block is marked
     * `streaming`, a call still running `background`.
     */
    pending() {
      if (sessionEpoch !== turnEpoch || !msgOpen || finished) return undefined;
      const content = new Array(nextIdx);
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        content[blockIdx[i]] = b.type === "toolCall" && openTools.has(b.id) ? { ...b, background: true } : b;
      }
      if (thinkIdx !== undefined) content[thinkIdx] = { type: "thinking", thinking: thinkBuf, streaming: true };
      if (textIdx !== undefined) content[textIdx] = { type: "text", text: textBuf, streaming: true };
      if (!content.length || content.some((b) => !b)) return undefined;
      return {
        role: "assistant",
        content,
        provider: currentModel.provider,
        model: currentModel.id,
        usage: zeroUsage,
        stopReason: "pending",
        ...(startTurn ? { turnStart: true } : {}),
        timestamp: Date.now(),
      };
    },
    /** Tokens or cost the engine reported for this turn. After the answer, it is the session's all the same. */
    usage(part) {
      if (!part || isBlank(part)) return;
      if (!finished) usageParts.push(part);
      else if (sessionEpoch === turnEpoch) recordUsageEntry(toUsage([part]), "late");
    },
    /** One model request, from an engine that reports each as it happens; a repeat is dropped. */
    usageSample(sample) {
      if (!sample || isBlank(sample)) return;
      if (sample.sig !== undefined) {
        if (lastSample.has(sample.sig)) return;
        lastSample.add(sample.sig);
        if (lastSample.size > 16) lastSample.delete(lastSample.values().next().value);
      }
      sampled = true;
      this.usage(sample);
    },
    /** The turn's usage as the engine sums it up — unless its requests were already counted one by one. */
    usageSummary(part) {
      if (!sampled) this.usage(part);
    },
    retry(attempt, maxAttempts = 0, errorMessage = "") {
      const clean = String(errorMessage || "").replace(/\s+/g, " ").trim();
      retryState = { attempt, maxAttempts: maxAttempts || 0, errorMessage: clean };
      emitTurn({
        type: "auto_retry_start",
        attempt: retryState.attempt,
        maxAttempts: retryState.maxAttempts,
        delayMs: 0,
        errorMessage: retryState.errorMessage,
      });
    },
    thinkDelta(delta) {
      if (!delta) return;
      clearRetry(true);
      openMsg();
      closeText();
      if (thinkIdx === undefined) {
        thinkIdx = nextIdx++;
        thinkBuf = "";
        emitTurn({ type: "message_update", usage: zeroUsage, assistantMessageEvent: { type: "thinking_start", contentIndex: thinkIdx } });
      }
      thinkBuf += delta;
      trailingThoughts += delta;
      emitTurn({ type: "message_update", usage: zeroUsage, assistantMessageEvent: { type: "thinking_delta", contentIndex: thinkIdx, delta } });
    },
    textDelta(delta) {
      if (!delta) return;
      clearRetry(true);
      openMsg();
      closeThink();
      if (textIdx === undefined) {
        textIdx = nextIdx++;
        textBuf = "";
        emitTurn({ type: "message_update", usage: zeroUsage, assistantMessageEvent: { type: "text_start", contentIndex: textIdx } });
      }
      textBuf += delta;
      saidText += delta;
      trailingThoughts = "";
      emitTurn({ type: "message_update", usage: zeroUsage, assistantMessageEvent: { type: "text_delta", contentIndex: textIdx, delta } });
    },
    toolStart(id, rawName, args, meta = undefined) {
      if (openTools.has(id)) {
        if (meta) api.toolMeta(id, meta);
        return;
      }
      clearRetry(true);
      openMsg();
      closeThink();
      closeText();
      trailingThoughts = "";
      const idx = nextIdx++;
      const name = normalizeToolName(rawName);
      const tc = { type: "toolCall", id, name, arguments: args || {} };
      blocks.push(tc);
      blockIdx.push(idx);
      calledTools.add(id);
      openTools.set(id, {
        name,
        startedAt: Date.now(),
        ...(meta
          ? {
              kind: meta.kind,
              title: meta.title,
              rawInput: meta.rawInput,
              startedAfterPromptSettled: !!meta.startedAfterPromptSettled,
            }
          : {}),
      });
      emitTurn({ type: "message_update", usage: zeroUsage, assistantMessageEvent: { type: "toolcall_start", contentIndex: idx, id, toolName: name } });
      emitTurn({ type: "message_update", usage: zeroUsage, assistantMessageEvent: { type: "toolcall_end", contentIndex: idx, toolCall: tc } });
      emitTurn({ type: "tool_execution_start", toolCallId: id, toolName: name, args: args || {} });
    },
    toolMeta(id, patch) {
      const info = openTools.get(id);
      if (!info || !patch) return;
      if (patch.kind !== undefined) info.kind = patch.kind;
      if (patch.title !== undefined) info.title = patch.title;
      if (patch.rawInput !== undefined) info.rawInput = patch.rawInput;
    },
    /** True when the open assistant message ends on non-empty prose (a completed reply before a wake). */
    hasTrailingText() {
      if (textIdx !== undefined && textBuf.trim().length > 0) return true;
      if (textIdx === undefined && blocks.length > 0) {
        const last = blocks[blocks.length - 1];
        return last?.type === "text" && typeof last.text === "string" && last.text.trim().length > 0;
      }
      return false;
    },
    /** `known`: the call's `{name, startedAt}` when an earlier turn started it (a background task finishing now). */
    toolEnd(id, outputText, isError, known = undefined) {
      const info = openTools.get(id) || known;
      const name = info?.name || "tool";
      const durationMs = info ? Math.max(1, Date.now() - info.startedAt) : 1;
      openTools.delete(id);
      const content = [{ type: "text", text: outputText || "" }];
      const toolMsg = { role: "toolResult", toolCallId: id, toolName: name, content, isError: !!isError, timestamp: Date.now() };
      if (sessionEpoch === turnEpoch) {
        clearStaleBackgroundTools(messages, id);
        messages.push(toolMsg);
      }
      emitTurn({ type: "tool_execution_end", toolCallId: id, toolName: name, result: { content }, isError: !!isError, durationMs });
      emitTurn({ type: "message_end", message: toolMsg });
    },
    /** What the turn said and called, and the calls still running when it ended (background tasks). */
    seen() {
      return { text: saidText, toolIds: [...calledTools], open: [...openTools], trailingThoughts };
    },
    /**
     * Closes the assistant message so far as a completed reply without ending
     * the turn or dropping open background tools — so a pre-wake reply stays
     * visible and distinct when background wakes follow in the same run.
     */
    checkpoint({ keepOpenTools = true, startNextTurn = true } = {}) {
      if (!msgOpen) {
        if (startNextTurn) startTurn = true;
        return false;
      }
      closeThink();
      closeText();
      const usage = toUsage(usageParts.splice(0));
      const content = blocks
        .splice(0)
        .map((b) => (keepOpenTools && b.type === "toolCall" && openTools.has(b.id) ? { ...b, background: true } : b));
      const assistantMsg = {
        role: "assistant",
        content,
        provider: currentModel.provider,
        model: currentModel.id,
        usage,
        stopReason: "stop",
        ...(startTurn ? { turnStart: true } : {}),
        timestamp: Date.now(),
      };
      if (sessionEpoch === turnEpoch) {
        messages.push(assistantMsg);
        addInto(sessionUsage, fromUsage(usage));
        void saveExternalSession().catch(() => undefined);
      }
      emitTurn({ type: "message_end", message: assistantMsg });
      msgOpen = false;
      nextIdx = 0;
      blockIdx.splice(0);
      startTurn = !!startNextTurn;
      return true;
    },
    /**
     * Ends the assistant message so far without ending the turn, and forgets it
     * as this turn's: Antigravity sends a turn it ran on its own while idle
     * ahead of the next prompt's echo — that is the turn before, not this one.
     */
    split() {
      if (msgOpen) {
        api.checkpoint({ keepOpenTools: true, startNextTurn: true });
      }
      saidText = "";
      trailingThoughts = "";
      calledTools.clear();
      retryState = undefined;
    },
    finish(stopReason = "stop", errorMessage = undefined, { keepOpenTools = false } = {}) {
      if (retryState) {
        if (stopReason === "aborted") {
          clearRetry(false);
        } else {
          const finalError = errorMessage || retryState.errorMessage;
          clearRetry(false, finalError);
          stopReason = "error";
          errorMessage = finalError;
        }
      }
      closeThink();
      closeText();
      const usage = toUsage(usageParts.splice(0));
      finished = true;
      if (liveTurnStream === api) liveTurnStream = undefined;
      const counted = sessionEpoch === turnEpoch;
      if (msgOpen || errorMessage || stopReason === "aborted") {
        openMsg();
        const content = blocks.map((b) => (keepOpenTools && b.type === "toolCall" && openTools.has(b.id) ? { ...b, background: true } : b));
        const assistantMsg = {
          role: "assistant",
          content,
          provider: currentModel.provider,
          model: currentModel.id,
          usage,
          stopReason,
          ...(errorMessage ? { errorMessage } : {}),
          ...(startTurn ? { turnStart: true } : {}),
          timestamp: Date.now(),
        };
        if (counted) {
          messages.push(assistantMsg);
          addInto(sessionUsage, fromUsage(usage));
        }
        emitTurn({ type: "message_end", message: assistantMsg });
      } else if (counted) {
        recordUsageEntry(usage, "turn");
      }
      startTurn = false;
      emitTurn({ type: "turn_end" });
    },
  };
  liveTurnStream = api;
  return api;
}

function spawnJsonlProcess(bin, args, extraEnv, onLine, stdinPayload) {
  return new Promise((resolve, reject) => {
    const child = spawnBinary(bin, args, {
      cwd,
      env: agentRuntimeEnv(extraEnv),
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    guardStdin(child);
    activeChild = child;
    if (stdinPayload !== undefined) {
      try {
        child.stdin.write(stdinPayload);
        child.stdin.end();
      } catch {}
    }
    let stdoutBuf = "";
    let stderrBuf = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk;
      let nl = stdoutBuf.indexOf("\n");
      while (nl !== -1) {
        const line = stdoutBuf.slice(0, nl).replace(/\r$/, "");
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (line.trim()) {
          try {
            onLine(JSON.parse(line));
          } catch {}
        }
        nl = stdoutBuf.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrBuf = (stderrBuf + chunk).slice(-8000);
    });
    child.on("error", (err) => {
      activeChild = undefined;
      reject(err);
    });
    child.on("close", (code) => {
      activeChild = undefined;
      if (stdoutBuf.trim()) {
        try {
          onLine(JSON.parse(stdoutBuf.trim()));
        } catch {}
      }
      resolve({ code, stderr: stderrBuf.trim() });
    });
  });
}

// ── Claude Code catalog probe (stream-json control protocol) ─────────────────
// Claude Code has no CLI flag to list models, but its SDK control protocol
// answers an `initialize` request with the models this install and account can
// actually run (aliases resolved through the user's own settings — a custom
// `ANTHROPIC_DEFAULT_*_MODEL` shows up as the real backend id). One throwaway
// `claude` process, no session persisted, no prompt ever sent.
const CLAUDE_PROBE_TIMEOUT_MS = 20_000;
const CLAUDE_CATALOG_TTL_MS = 60_000;
const CLAUDE_CATALOG_RETRY_MS = 15_000;
let claudeCatalogPromise = undefined;
let claudeCatalogCooldownUntil = 0;

function probeClaudeInitialization(bin) {
  return new Promise((resolve) => {
    const requestId = `probe_${crypto.randomUUID()}`;
    const child = spawnBinary(
      bin,
      [
        "--output-format", "stream-json",
        "--verbose",
        "--input-format", "stream-json",
        "--setting-sources", "user,project,local",
        "--strict-mcp-config",
        "--no-session-persistence",
        "--settings", JSON.stringify({ disableAllHooks: true }),
      ],
      {
        cwd,
        env: agentRuntimeEnv({
          ENABLE_CLAUDEAI_MCP_SERVERS: "false",
          CLAUDE_CODE_AUTO_CONNECT_IDE: "0",
          CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
          CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
        }),
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      },
    );
    guardStdin(child);
    const finish = (payload) => {
      clearTimeout(timer);
      try {
        if (process.platform === "win32") child.kill();
        else process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill();
        } catch {}
      }
      resolve(payload);
    };
    const timer = setTimeout(() => finish(undefined), CLAUDE_PROBE_TIMEOUT_MS);
    timer.unref?.();
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", () => {});
    let buf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) {
          try {
            const msg = JSON.parse(line);
            if (msg.type === "control_response" && msg.response?.request_id === requestId && msg.response?.subtype === "success") {
              finish(msg.response.response);
            }
          } catch {}
        }
        nl = buf.indexOf("\n");
      }
    });
    child.on("error", () => finish(undefined));
    child.on("close", () => finish(undefined));
    try {
      child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "initialize" } })}\n`);
    } catch {
      finish(undefined);
    }
  });
}

const CLAUDE_EFFORT_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);
const claudeEfforts = (info) =>
  (Array.isArray(info?.supportedEffortLevels) ? info.supportedEffortLevels : []).filter((e) => typeof e === "string" && CLAUDE_EFFORT_LEVELS.has(e));
// `resolvedModel` carries Claude's `[1m]` context-window suffix — only an
// estimate until a turn's `result.modelUsage` reports the real window
// (`adoptClaudeModelUsage`): aliases, Bedrock/Vertex ids and window sizes
// Anthropic adds later all resolve truthfully there, not here.
const claudeContextWindow = (info) => (typeof info?.resolvedModel === "string" && info.resolvedModel.endsWith("[1m]") ? 1_000_000 : 200_000);

/**
 * Adopts the window Claude Code actually ran at — `result.modelUsage` reports
 * `contextWindow`/`maxOutputTokens` per resolved model. The session's model may
 * sit behind an alias (`default`, `sonnet`, a settings id), so the entry that
 * did the most tokens stands for it when no key matches `currentModel.id`.
 */
function adoptClaudeModelUsage(modelUsage) {
  if (!modelUsage || typeof modelUsage !== "object" || !currentModel) return;
  const usageTotal = (u) =>
    Number(u?.inputTokens || 0) + Number(u?.outputTokens || 0) + Number(u?.cacheReadInputTokens || 0) + Number(u?.cacheCreationInputTokens || 0);
  const entries = Object.entries(modelUsage);
  if (!entries.length) return;
  const [, usage] = entries.find(([id]) => id === currentModel.id) ?? entries.reduce((a, b) => (usageTotal(b[1]) > usageTotal(a[1]) ? b : a));
  const win = Number(usage?.contextWindow);
  const maxOut = Number(usage?.maxOutputTokens);
  const listed = availableModels.find((m) => m === currentModel || (m.id === currentModel.id && m.provider === currentModel.provider));
  if (win > 0) {
    currentModel.contextWindow = win;
    if (listed && listed !== currentModel) listed.contextWindow = win;
  }
  if (maxOut > 0) {
    currentModel.maxTokens = maxOut;
    if (listed && listed !== currentModel) listed.maxTokens = maxOut;
  }
}

/** Adopts the catalog the probe reported; `default` stays the placeholder (it is a pointer, not a model). */
function adoptClaudeModels(init) {
  const reported = Array.isArray(init?.models) ? init.models : [];
  if (!reported.length) return;
  const reportedDefault = reported.find((m) => m?.value === "default");
  const discovered = [engineDefaultModel()];
  if (reportedDefault) {
    discovered[0].reasoning = reportedDefault.supportsEffort === true;
    discovered[0].effortLevels = claudeEfforts(reportedDefault);
    discovered[0].contextWindow = claudeContextWindow(reportedDefault);
  }
  for (const m of reported) {
    const id = String(m?.value ?? "").trim();
    if (!id || id === "default" || discovered.some((d) => d.id === id)) continue;
    discovered.push({
      id,
      name: String(m?.displayName || m?.resolvedModel || id).trim() || id,
      api: "claude",
      provider: "claude",
      reasoning: m?.supportsEffort === true,
      effortLevels: claudeEfforts(m),
      input: ["text", "image"],
      contextWindow: claudeContextWindow(m),
      maxTokens: 16384,
      cost: zeroCost,
    });
  }
  // A selection the probe no longer reports (a stale alias, a removed custom
  // model) stays listed rather than silently snapping the session to default.
  if (currentModel && currentModel.id !== "default" && !discovered.some((m) => m.id === currentModel.id)) {
    discovered.push({ ...currentModel, input: ["text", "image"] });
  }
  const sig = (m) => `${m.provider}/${m.id}:${m.name}:${m.reasoning}`;
  if (availableModels.length === discovered.length && availableModels.every((m, i) => sig(m) === sig(discovered[i]))) return;
  availableModels.splice(0, availableModels.length, ...discovered);
  currentModel = discovered.find((m) => m.id === currentModel?.id) || discovered[0];
  emit({ type: "models_changed" });
}

/**
 * Claude's catalog lives behind one short-lived probe process; concurrent
 * catalog reads share it, a fresh result holds for the TTL, and a failure
 * backs off so a dead CLI never stalls the picker on every open.
 */
function ensureClaudeCatalog() {
  if (driver !== "claude") return Promise.resolve();
  if (!claudeCatalogPromise && Date.now() >= claudeCatalogCooldownUntil) {
    const bin = resolveDriverBinary();
    if (!bin) return Promise.resolve();
    claudeCatalogPromise = probeClaudeInitialization(bin)
      .then((init) => {
        if (init && Array.isArray(init.commands)) adoptCommands(init.commands);
        if (init && Array.isArray(init.models) && init.models.length) {
          adoptClaudeModels(init);
          claudeCatalogCooldownUntil = Date.now() + CLAUDE_CATALOG_TTL_MS;
        } else {
          claudeCatalogCooldownUntil = Date.now() + CLAUDE_CATALOG_RETRY_MS;
        }
      })
      .catch(() => {
        claudeCatalogCooldownUntil = Date.now() + CLAUDE_CATALOG_RETRY_MS;
      })
      .finally(() => {
        claudeCatalogPromise = undefined;
      });
  }
  return claudeCatalogPromise ?? Promise.resolve();
}

async function runClaudeTurn(bin, promptText, images = [], turnEpoch = sessionEpoch) {
  const permMap = {
    "approval-required": "default",
    "auto-accept-edits": "acceptEdits",
    "full-access": "bypassPermissions",
  };
  const perm = permMap[runtimeMode] || "bypassPermissions";
  const args = [
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--include-partial-messages",
    "--permission-mode",
    perm,
  ];
  if (currentModel?.id && currentModel.id !== "default") args.push("--model", currentModel.id);
  // Only a level the user actually picked reaches the engine; while unset, the
  // session keeps Claude's own effort instead of a pipi default.
  if (thinkingLevelSet && thinkingLevel !== "off" && currentModel?.reasoning && (!currentModel.effortLevels?.length || currentModel.effortLevels.includes(thinkingLevel))) {
    args.push("--effort", thinkingLevel);
  }
  if (perm === "bypassPermissions") args.push("--allow-dangerously-skip-permissions");
  if (nativeThreadId) args.push("--resume", nativeThreadId);
  if (!isSubagent && orchestratorUrl && orchestratorToken && fs.existsSync(mcpStdioScript)) {
    const mcpJson = JSON.stringify({
      mcpServers: {
        pipi: {
          command: process.execPath,
          args: [mcpStdioScript],
          env: { PIPI_ORCHESTRATOR_URL: orchestratorUrl, PIPI_ORCHESTRATOR_TOKEN: orchestratorToken },
        },
      },
    });
    args.push("--mcp-config", mcpJson, "--append-system-prompt", EXTERNAL_ORCHESTRATION_PROMPT);
  }
  if (Array.isArray(config.extraArgs)) args.push(...config.extraArgs);
  // The prompt goes on stdin as one stream-json user message — the only way
  // image blocks reach the engine; a trailing CLI argument is text-only.
  const content = [
    ...(promptText ? [{ type: "text", text: promptText }] : []),
    ...imageBlocks(images).map((i) => ({ type: "image", source: { type: "base64", media_type: i.mimeType, data: i.data } })),
  ];
  const stdinPayload = `${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`;

  const stream = makeTurnStreamHelper(turnEpoch);
  let completed = false;
  // `modelUsage` is the session's running total, resumed turns included: a turn is
  // its growth since the last one. A resumed session with nothing to measure
  // against (saved before this was kept) has only this turn's own requests.
  let counted = !nativeThreadId ? {} : usageBaseline?.thread === nativeThreadId && usageBaseline.models ? structuredClone(usageBaseline.models) : undefined;
  const samples = new Map(); // message id → usage, should the run end without a `result`
  const { code, stderr } = await spawnJsonlProcess(bin, args, {}, (rec) => {
    if (sessionEpoch === turnEpoch && typeof rec.session_id === "string" && rec.session_id) nativeThreadId = rec.session_id;
    if (rec.type === "stream_event" && rec.event?.type === "content_block_delta") {
      const delta = rec.event.delta;
      if (delta?.type === "text_delta" && delta.text) stream.textDelta(delta.text);
      else if (delta?.type === "thinking_delta" && delta.thinking) stream.thinkDelta(delta.thinking);
    } else if (rec.type === "assistant" && Array.isArray(rec.message?.content)) {
      const sample = claudeAssistantSample(rec);
      if (sample) {
        samples.set(sample.id, sample);
        // The conversation's own request (a subagent's has a parent): what it held is the context.
        if (!rec.parent_tool_use_id && sessionEpoch === turnEpoch) contextTokens = tokensOf(sample);
      }
      for (const b of rec.message.content) {
        if (b.type === "thinking" && b.thinking && !stream.thinkBuf) stream.thinkDelta(b.thinking);
        else if (b.type === "text" && b.text && !stream.textBuf) stream.textDelta(b.text);
        else if (b.type === "tool_use" && b.id && b.name) stream.toolStart(b.id, b.name, b.input || {});
      }
    } else if (rec.type === "user" && Array.isArray(rec.message?.content)) {
      for (const b of rec.message.content) {
        if (b.type === "tool_result" && b.tool_use_id) {
          const txt = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map((p) => p?.text || "").join("\n") : "";
          stream.toolEnd(b.tool_use_id, txt, !!b.is_error);
        }
      }
    } else if (rec.type === "result") {
      completed = true;
      const total = counted ?? {};
      const parts = claudeResultParts(rec, total);
      for (const part of counted ? parts : samples.values()) stream.usage(part);
      counted = total;
      samples.clear();
      if (sessionEpoch === turnEpoch && nativeThreadId) usageBaseline = { thread: nativeThreadId, models: total };
      if (sessionEpoch === turnEpoch) adoptClaudeModelUsage(rec.modelUsage);
      const isErr = !!rec.is_error;
      if (!isErr && typeof rec.result === "string" && rec.result && !stream.hasBlocks && !stream.textBuf) {
        stream.textDelta(rec.result);
      }
      stream.finish(abortRequested ? "aborted" : isErr ? "error" : "stop", isErr ? String(rec.result || stderr || "Claude Code failed") : undefined);
    }
  }, stdinPayload);
  if (!completed) {
    // No `result` (interrupted, or the CLI died). Claude keeps the session's total
    // through it and the next turn's `result` carries what this one used, cost
    // included — so it is counted then, not here as well. Only a session with no
    // total to measure against counts the requests it saw.
    if (!counted) for (const sample of samples.values()) stream.usage(sample);
    else if (sessionEpoch === turnEpoch && nativeThreadId) usageBaseline = { thread: nativeThreadId, models: counted };
    stream.finish(abortRequested ? "aborted" : code === 0 ? "stop" : "error", code !== 0 && !abortRequested ? stderr || `Claude exited with code ${code}` : undefined);
  }
}

async function runCodexTurn(bin, promptText, turnEpoch = sessionEpoch) {
  const args = ["exec"];
  const resumed = !!nativeThreadId;
  if (nativeThreadId) {
    args.push("resume", nativeThreadId);
  }
  args.push("--json", "--skip-git-repo-check");
  if (currentModel?.id && currentModel.id !== "default") args.push("-m", currentModel.id);
  if (thinkingLevel && thinkingLevel !== "off") {
    const effort = thinkingLevel === "minimal" ? "low" : thinkingLevel === "max" || thinkingLevel === "xhigh" ? "high" : thinkingLevel;
    args.push("-c", `model_reasoning_effort=${JSON.stringify(effort)}`);
  }
  if (runtimeMode === "full-access") {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else if (runtimeMode === "auto-accept-edits") {
    args.push("-s", "workspace-write");
  } else {
    args.push("-s", "read-only");
  }
  if (!isSubagent && orchestratorUrl && orchestratorToken && fs.existsSync(mcpStdioScript)) {
    args.push(
      "-c",
      `mcp_servers.pipi.command=${JSON.stringify(process.execPath)}`,
      "-c",
      `mcp_servers.pipi.args=${JSON.stringify([mcpStdioScript])}`,
      "-c",
      `mcp_servers.pipi.env.PIPI_ORCHESTRATOR_URL=${JSON.stringify(orchestratorUrl)}`,
      "-c",
      `mcp_servers.pipi.env.PIPI_ORCHESTRATOR_TOKEN=${JSON.stringify(orchestratorToken)}`,
    );
  }
  if (Array.isArray(config.extraArgs)) args.push(...config.extraArgs);
  args.push(promptText);

  const stream = makeTurnStreamHelper(turnEpoch);
  let completed = false;
  const { code, stderr } = await spawnJsonlProcess(bin, args, {}, (rec) => {
    const t = String(rec.type || "");
    if (t === "thread.started" && rec.thread_id) {
      if (sessionEpoch === turnEpoch) {
        nativeThreadId = rec.thread_id;
        // A thread begun here starts from nothing: its total is all this session's.
        if (!resumed) usageBaseline = { thread: nativeThreadId, input: 0, cached: 0, output: 0 };
      }
    } else if ((t === "item.started" || t === "item.updated" || t === "item.completed") && rec.item) {
      const item = rec.item;
      const id = item.id || "item";
      if (item.type === "reasoning" && t === "item.completed" && item.text) {
        stream.thinkDelta(item.text);
      } else if (item.type === "agent_message" && typeof item.text === "string") {
        const delta = item.text.startsWith(stream.textBuf) ? item.text.slice(stream.textBuf.length) : item.text;
        stream.textDelta(delta);
      } else if (item.type === "command_execution") {
        stream.toolStart(id, "bash", { command: item.command || "" });
        if (t === "item.completed") stream.toolEnd(id, item.aggregated_output || "", (item.exit_code ?? 0) !== 0);
      } else if (item.type === "file_change") {
        const changes = Array.isArray(item.changes) ? item.changes : [];
        stream.toolStart(id, "edit", { path: changes.map((c) => c.path).join(", ") || "files" });
        if (t === "item.completed") stream.toolEnd(id, changes.map((c) => `${c.kind || "edit"}: ${c.path || ""}`).join("\n"), false);
      } else if (item.type === "mcp_tool_call") {
        stream.toolStart(id, item.tool || "mcp", item.arguments || {});
        if (t === "item.completed") stream.toolEnd(id, JSON.stringify(item.error || item.result || ""), !!item.error);
      }
    } else if (t === "turn.completed") {
      completed = true;
      if (sessionEpoch === turnEpoch) {
        // A turn interrupted before this record is not lost: the thread's total still holds it for the next reading.
        const known = usageBaseline?.thread === nativeThreadId ? usageBaseline : undefined;
        const read = codexTurnPart(rec.usage, known);
        if (read) {
          // A thread resumed with nothing to measure against (a session saved before
          // usage was read per turn): its total is mostly earlier turns, so this one
          // goes uncounted rather than counted many times over.
          if (known) stream.usage(read.part);
          usageBaseline = { thread: nativeThreadId, ...read.total };
        }
      }
      stream.finish(abortRequested ? "aborted" : "stop");
    } else if (t === "turn.failed" || t === "error") {
      completed = true;
      const msg = rec.error?.message || rec.message || stderr || "Codex turn failed";
      stream.finish("error", msg);
    }
  });
  if (!completed) {
    stream.finish(abortRequested ? "aborted" : code === 0 ? "stop" : "error", code !== 0 && !abortRequested ? stderr || `Codex exited with code ${code}` : undefined);
  }
}

async function runOpenCodeTurn(bin, promptText, turnEpoch = sessionEpoch) {
  const args = ["run", "--format", "json"];
  if (currentModel?.id && currentModel.id !== "default") args.push("-m", currentModel.id);
  if (nativeThreadId) args.push("-s", nativeThreadId);
  if (Array.isArray(config.extraArgs)) args.push(...config.extraArgs);
  args.push(promptText);

  const stream = makeTurnStreamHelper(turnEpoch);
  const { code, stderr } = await spawnJsonlProcess(bin, args, {}, (rec) => {
    if (sessionEpoch === turnEpoch && rec.sessionID) nativeThreadId = rec.sessionID;
    if (rec.type === "text" && rec.part?.text) stream.textDelta(rec.part.text);
    else if (rec.type === "reasoning" && rec.part?.text) stream.thinkDelta(rec.part.text);
    else if (rec.type === "step_finish" || rec.part?.type === "step-finish") {
      const part = openCodeStepPart(rec.part);
      if (part) {
        stream.usage(part);
        if (sessionEpoch === turnEpoch) contextTokens = tokensOf(part);
      }
    } else if (rec.type === "tool_use" && rec.part) {
      const id = rec.part.callID || rec.part.id || `oc_${Date.now()}`;
      stream.toolStart(id, rec.part.tool || "tool", rec.part.state?.input || {});
      if (rec.part.state?.status === "completed" || rec.part.state?.status === "error") {
        stream.toolEnd(id, rec.part.state?.output || rec.part.state?.error || "", rec.part.state?.status === "error");
      }
    }
  });
  stream.finish(abortRequested ? "aborted" : code === 0 ? "stop" : "error", code !== 0 && !abortRequested ? stderr || `OpenCode exited with code ${code}` : undefined);
}

async function runCursorTurn(bin, promptText, turnEpoch = sessionEpoch) {
  const args = ["-p", "--output-format", "stream-json"];
  if (currentModel?.id && currentModel.id !== "default") args.push("--model", currentModel.id);
  if (runtimeMode === "full-access") args.push("-f");
  if (Array.isArray(config.extraArgs)) args.push(...config.extraArgs);
  args.push(promptText);

  const stream = makeTurnStreamHelper(turnEpoch);
  const { code, stderr } = await spawnJsonlProcess(bin, args, {}, (rec) => {
    if (rec.type === "assistant" && rec.message?.content) {
      for (const b of rec.message.content) {
        if (b.type === "text" && b.text) stream.textDelta(b.text);
      }
    } else if (rec.type === "tool_call" && rec.call_id) {
      if (rec.subtype === "started") stream.toolStart(rec.call_id, rec.name || "tool", rec.args || {});
      else if (rec.subtype === "completed") stream.toolEnd(rec.call_id, rec.output || "", !!rec.is_error);
    } else if (rec.type === "result") {
      stream.usage(cursorResultPart(rec));
    }
  });
  stream.finish(abortRequested ? "aborted" : code === 0 ? "stop" : "error", code !== 0 && !abortRequested ? stderr || `Cursor agent exited with code ${code}` : undefined);
}

function resolveAcpArgs(bin) {
  const extra = Array.isArray(config.extraArgs) ? config.extraArgs : [];
  if (config.customAgent) {
    const dist = config.customAgent.distribution || "binary";
    const baseArgs = Array.isArray(config.customAgent.args) ? config.customAgent.args : [];
    const pkg = config.customAgent.packageName || config.customAgent.command;
    if (dist === "npx") return ["-y", pkg, ...baseArgs, ...extra];
    if (dist === "uvx") return [pkg, ...baseArgs, ...extra];
    return [...baseArgs, ...extra];
  }
  const preset = BUILTIN_ACP_PRESETS[agentId];
  if (preset) {
    // Antigravity's standalone CLI `agy` takes `acp`, whereas the retired `agy_acp_server` starts directly.
    if (agentId === "antigravity" && path.basename(bin).replace(/\.(exe|cmd|bat|ps1)$/i, "") === "agy_acp_server") {
      return [...extra];
    }
    return [...(preset.args || []), ...extra];
  }
  return extra;
}

function formatAcpToolContent(content, rawOutput) {
  if (typeof content === "string" && content) return content;
  if (content && typeof content === "object" && !Array.isArray(content)) {
    if (typeof content.text === "string") return content.text;
    if (content.content && typeof content.content.text === "string") return content.content.text;
  }
  if (Array.isArray(content)) {
    const parts = [];
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      if (item.type === "text" && typeof item.text === "string") {
        parts.push(item.text);
      } else if (item.type === "content" && item.content?.type === "text" && typeof item.content.text === "string") {
        parts.push(item.content.text);
      } else if (item.type === "diff") {
        const oldLines = typeof item.oldText === "string" && item.oldText ? item.oldText.split("\n") : [];
        const newLines = typeof item.newText === "string" && item.newText ? item.newText.split("\n") : [];
        const header = item.path ? `--- a/${item.path}\n+++ b/${item.path}` : "--- a/file\n+++ b/file";
        const body = [...oldLines.map((l) => `-${l}`), ...newLines.map((l) => `+${l}`)].slice(0, 400).join("\n");
        parts.push(`${header}\n${body}`);
      }
    }
    if (parts.length > 0) return parts.join("\n\n");
  }
  if (typeof rawOutput === "string") return rawOutput;
  if (rawOutput && typeof rawOutput === "object") return JSON.stringify(rawOutput, null, 2);
  return "";
}

// ── Persistent ACP session ──────────────────────────────────────────────────
// Unlike the CLI drivers (one process per turn, context via --resume), an ACP
// server is a long-lived JSON-RPC peer: one process, one loaded session, many
// prompts. Keeping the child and its sessionId across turns preserves
// conversation context, the negotiated model, and the mode. `session/load`
// re-attaches a persisted sessionId after a respawn or a switch back to a
// saved session.
let acpChild = undefined;
let acpSessionId = undefined;
let acpEnsurePromise = undefined; // one negotiation at a time: listing models and a prompt may race
let acpReset = true; // the pipi session changed: negotiate before the next prompt
let acpLoadSession = false;
let acpRpcId = 1;
const acpPending = new Map(); // rpc id → {resolve, reject}
let acpStream = undefined; // stream helper of the in-flight prompt
/** The turn stream accumulating right now, on any driver: its `pending()` is what `get_messages` adds so a (re)attached client sees the in-flight message. */
let liveTurnStream = undefined;
let acpOutBuf = "";
let acpErrBuf = "";
// Last byte the peer wrote — the liveness signal the prompt watchdog reads:
// a wedged worker (Antigravity's per-session process dying mid-dispatch) keeps
// the process and its pipes alive while producing nothing.
let acpLastOutAt = 0;
// Negotiated capabilities & catalogs, filled from initialize/session responses:
let acpSpecModels = false; // agent advertised `models.availableModels` (ACP spec)
let acpModelConfigId = undefined; // configOptions select carrying the model list (Devin dialect)
let acpModeConfigId = undefined; // configOptions select carrying modes
let acpModes = undefined; // {currentModeId, availableModes}
let acpSessionCaps = undefined; // agentCapabilities.sessionCapabilities ({resume, list, close})
let acpModelValues = undefined; // `${provider}/${modelId}` → opaque config-option value
let acpModelConfigCurrent = undefined; // last-known currentValue of the model select
let acpEffortConfig = undefined; // advertised `reasoning_effort` select {id, values, hasProviderDefault, currentValue}
let acpUsage = undefined; // last `usage_update` {used, size}
let acpAgentInfo = undefined; // initialize's agentInfo {name, title, version}
let acpAuthMethods = []; // initialize's authMethods — authenticate when required
const acpRecentTools = new Map(); // toolCallId → {title, kind, rawInput} for permission enrichment
// Last `session/update` the peer sent — the turn's own progress signal. Unlike
// `acpLastOutAt` (every byte, probes included), only the session's traffic
// resets the stall clock.
let acpLastEventAt = 0;

// ── Deferred finalization & autonomous wakes (Antigravity / ACP) ────────────
//
// An Antigravity `session/prompt` returns `end_turn` as soon as it pauses to
// wait on a background command (`run_command` past `WaitMsBeforeAsync`), a
// scheduled wake (`schedule`), or a detached subagent (`invoke_subagent`).
// Settling the turn right then makes the UI look stopped/idle and drops or
// fragments the wake reply when Gemini thinks or runs tools longer than a
// short quiet timeout. Instead — following T3 Code's Antigravity ACP adapter —
// the bridge holds the turn open while background work is still running:
//   - Non-daemon `execute` commands, `schedule` calls, pending permission /
//     question requests, active detached subagents, and unread high-priority
//     inbox wakes (`hasPendingReply`) all defer finalization.
//   - Pre-wake replies are checkpointed as completed visible messages before
//     waiting so they stay visible and distinct when wakes follow in the run.
//   - Every Antigravity reply ends with `usage_update`: while a wake reply is
//     open (`replyOpen`), the quiet limit is 2 minutes (never 6s); once
//     `usage_update` arrives and no background work remains, a 3s debounce
//     re-checks `hasPendingReply` before settling.
//   - Daemons (`IsDaemon: true`) settle immediately and still wake via
//     `ensureAcpWakeTurn` (using the same `usage_update` + 2-minute machinery)
//     if they ever exit later.
//   - Steering on agy >= 1.5.0 sends `session/prompt` without `session/cancel`
//     so running background commands and subagents are never killed; only Stop
//     (`abort`) sends `session/cancel`.
let acpWakeTurn = undefined; // {epoch, stream} while a post-settle wake turn is open
let acpDeferred = undefined; // active deferred-finalization / wake state for the live turn
let acpWakeSleepWake = undefined; // resolves an active sleep immediately on abort
let acpAttaching = false; // session/load|resume replay in flight: not live traffic
// Calls a turn left running (daemons, or tools surviving a steer), by id → {name, startedAt, ...}:
// a later turn or wake says when they end — wherever in the conversation.
const acpBackgroundTools = new Map();
// Post-`usage_update` debounce once no deferred background work remains.
const ACP_DEFERRED_FINALIZE_DEBOUNCE_MS = Number(process.env.PIPI_ACP_DEFERRED_FINALIZE_MS) || 3_000;
// Max silence while an open Antigravity wake reply has not yet emitted its closing `usage_update`.
const ACP_OPEN_REPLY_QUIET_LIMIT_MS = Number(process.env.PIPI_ACP_OPEN_REPLY_QUIET_MS) || 2 * 60_000;
// Poll cadence while waiting exclusively on detached subagents (which report via parent inbox).
const ACP_SUBAGENT_POLL_MS = Number(process.env.PIPI_ACP_SUBAGENT_POLL_MS) || 1_000;
// Quiet fallback for non-Antigravity post-settle wake turns.
const ACP_WAKE_QUIET_MS = Number(process.env.PIPI_ACP_WAKE_QUIET_MS) || 6_000;
const ACP_CONTENT_UPDATES = new Set(["user_message_chunk", "agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update"]);
const isFinalToolStatus = (status) => status === "completed" || status === "failed";

const ANTIGRAVITY_SCHEDULE_TITLES = new Set(["Run schedule", "Running schedule"]);
const ANTIGRAVITY_SUBAGENT_TITLES = new Set([
  "Running start_subagent",
  "Run start_subagent?",
  "Running invoke_subagent",
  "Run invoke_subagent?",
  "Run invoke_subagent",
]);
const AGY_NATIVE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const AGY_MAX_STEP_BYTES = 1024 * 1024;
const AGY_MAX_MESSAGE_FILES = 256;
const AGY_MAX_DETACHED_CHILDREN = 64;
const AGY_HIGH_PRIORITY = "MESSAGE_PRIORITY_HIGH";
const AGY_LOW_PRIORITY = "MESSAGE_PRIORITY_LOW";

function parseSemver(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version || "").trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

function cmpSemver(a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function isAntigravityAcp() {
  return driver === "acp" && (agentId === "antigravity" || /antigravity/i.test(String(acpAgentInfo?.name || "")));
}

/** `agy acp` >= 1.5.0 treats a `session/prompt` sent mid-turn as a steer without killing subagents/commands. */
function agySteersWithPrompt() {
  if (!isAntigravityAcp()) return false;
  const v = parseSemver(acpAgentInfo?.version);
  return v !== undefined && cmpSemver(v, [1, 5, 0]) >= 0;
}

/** Antigravity 1.4.2–1.4.5 scatter a run-workflow skill file into the workspace unless told not to. */
function agyWritesRunWorkflowSkill(version) {
  const v = parseSemver(version);
  return v !== undefined && cmpSemver(v, [1, 4, 2]) >= 0 && cmpSemver(v, [1, 4, 5]) <= 0;
}

function isDaemonToolInput(rawInput) {
  return Boolean(rawInput && typeof rawInput === "object" && rawInput.IsDaemon === true);
}

/**
 * Antigravity keeps non-daemon shell commands and scheduled wakes running after
 * `session/prompt` returns `end_turn`, replying by itself when they finish.
 * A daemon (`IsDaemon: true`) may run indefinitely, so it does not hold the turn.
 */
function antigravityToolOutlivesPrompt(info) {
  if (!info) return false;
  if (isDaemonToolInput(info.rawInput)) return false;
  if (info.startedAfterPromptSettled) return true;
  if (info.title && ANTIGRAVITY_SCHEDULE_TITLES.has(info.title)) return true;
  return info.kind === "execute";
}

function isAntigravitySubagentLaunch(u) {
  const title = typeof u?.title === "string" ? u.title : "";
  if (!ANTIGRAVITY_SUBAGENT_TITLES.has(title)) return false;
  if (u.kind !== undefined && u.kind !== "other") return false;
  return u._meta?.is_mcp_tool_call !== true;
}

function agyHomeRoot() {
  const raw = process.env.ANTIGRAVITY_CLI_HOME
    ? path.resolve(process.env.ANTIGRAVITY_CLI_HOME)
    : path.join(os.homedir(), ".gemini", "antigravity-cli");
  try {
    return fs.realpathSync(raw);
  } catch {
    return undefined;
  }
}

/** Verifies every path segment below `root` exists, has the expected type, and is not a symlink. */
function agyManagedPathSync(root, segments, kind) {
  let current = root;
  let info;
  try {
    for (let i = 0; i < segments.length; i++) {
      current = path.join(current, segments[i]);
      info = fs.lstatSync(current);
      const expectFile = kind === "file" && i === segments.length - 1;
      if (info.isSymbolicLink() || (expectFile ? !info.isFile() : !info.isDirectory())) return undefined;
    }
    if (!info) return undefined;
    return fs.realpathSync(current) === current ? { path: current, info } : undefined;
  } catch {
    return undefined;
  }
}

function agyHasUnreadHighPriorityInbox(root, acpId) {
  const dirSegs = ["brain", acpId, ".system_generated", "messages"];
  const inbox = agyManagedPathSync(root, dirSegs, "directory");
  if (!inbox) return false;
  let entries;
  try {
    entries = fs.readdirSync(inbox.path);
  } catch {
    return false;
  }
  const messageNames = entries.filter((name) => name.endsWith(".json") && name !== "read.json");
  if (!messageNames.length || messageNames.length > AGY_MAX_MESSAGE_FILES) return false;
  let readReceipts = {};
  if (entries.includes("read.json")) {
    const receiptFile = agyManagedPathSync(root, [...dirSegs, "read.json"], "file");
    if (!receiptFile || receiptFile.info.size > AGY_MAX_STEP_BYTES) return false;
    try {
      const parsed = JSON.parse(fs.readFileSync(receiptFile.path, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
      readReceipts = parsed;
    } catch {
      return false;
    }
  }
  for (const name of messageNames) {
    const fileId = name.slice(0, -5);
    if (readReceipts[fileId] === true) continue;
    const file = agyManagedPathSync(root, [...dirSegs, name], "file");
    if (!file || file.info.size > AGY_MAX_STEP_BYTES) continue;
    try {
      const msg = JSON.parse(fs.readFileSync(file.path, "utf8"));
      if (!msg || typeof msg !== "object") continue;
      if (typeof msg.id === "string" && readReceipts[msg.id] === true) continue;
      if (msg.priority === AGY_HIGH_PRIORITY) return true;
    } catch {}
  }
  return false;
}

function agyLastTranscriptStep(root, acpId) {
  const file = agyManagedPathSync(root, ["brain", acpId, ".system_generated", "logs", "transcript.jsonl"], "file");
  if (!file) return undefined;
  let fd;
  try {
    fd = fs.openSync(file.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0) return undefined;
    for (const byteCap of [64 * 1024, 256 * 1024]) {
      const start = Math.max(0, stat.size - byteCap);
      const buf = Buffer.allocUnsafe(stat.size - start);
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, start);
      let end = bytesRead;
      while (end > 0 && (buf[end - 1] === 0x0a || buf[end - 1] === 0x0d)) end -= 1;
      if (end === 0) {
        if (start === 0) return undefined;
        continue;
      }
      const trimmed = buf.subarray(0, end);
      const lastNl = trimmed.lastIndexOf(0x0a);
      if (lastNl === -1 && start > 0) continue;
      const line = trimmed.toString("utf8", lastNl + 1);
      const step = JSON.parse(line);
      return step && typeof step === "object" ? step : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

/**
 * True when `agy` has a high-priority wake queued in the session's inbox or
 * already dequeued as the trailing `SYSTEM_MESSAGE` step in `transcript.jsonl`
 * with no `PLANNER_RESPONSE` yet. Fails closed when records are missing,
 * symlinked, or unreadable.
 */
function agyHasPendingReply(acpId) {
  if (!acpId || !AGY_NATIVE_ID.test(acpId)) return false;
  const root = agyHomeRoot();
  if (!root) return false;
  if (agyHasUnreadHighPriorityInbox(root, acpId)) return true;
  const lastStep = agyLastTranscriptStep(root, acpId);
  if (!lastStep || lastStep.type !== "SYSTEM_MESSAGE") return false;
  const content = typeof lastStep.content === "string" ? lastStep.content : undefined;
  return content === undefined || content.includes(`priority=${AGY_HIGH_PRIORITY}`) || !content.includes(`priority=${AGY_LOW_PRIORITY}`);
}

function agyReadInboxSync(root, conversationId) {
  const dirSegs = ["brain", conversationId, ".system_generated", "messages"];
  const inbox = agyManagedPathSync(root, dirSegs, "directory");
  if (!inbox) return [];
  const names = fs.readdirSync(inbox.path).filter((n) => n.endsWith(".json") && n !== "read.json");
  if (names.length > AGY_MAX_MESSAGE_FILES) throw new Error("Too many messages");
  return names.map((name) => {
    const file = agyManagedPathSync(root, [...dirSegs, name], "file");
    if (!file || file.info.size > AGY_MAX_STEP_BYTES) throw new Error("Unreadable");
    return JSON.parse(fs.readFileSync(file.path, "utf8"));
  });
}

/**
 * agy 1.5 detached subagents outlive their `invoke_subagent` tool call (which
 * completes immediately on launch). A child is done once it sends a message to
 * the parent's inbox or its record is marked killed. Returns the launching tool
 * call ids of children still at work; fails closed (`[]`).
 */
function agyChildrenAtWork(acpId, toolCallIds) {
  if (!toolCallIds.length || !acpId || !AGY_NATIVE_ID.test(acpId)) return [];
  const root = agyHomeRoot();
  if (!root) return [];
  try {
    const subDir = agyManagedPathSync(root, ["brain", acpId, ".system_generated", "subagents"], "directory");
    if (!subDir) return [];
    const childIds = fs
      .readdirSync(subDir.path)
      .filter((n) => n.endsWith(".json") && AGY_NATIVE_ID.test(n.slice(0, -5)))
      .map((n) => n.slice(0, -5));
    if (!childIds.length || childIds.length > AGY_MAX_DETACHED_CHILDREN) return [];
    const wanted = new Set(toolCallIds);
    const reported = new Set(agyReadInboxSync(root, acpId).map((m) => m?.sender).filter(Boolean));
    const atWork = [];
    for (const childId of childIds) {
      if (reported.has(childId)) continue;
      const subFile = agyManagedPathSync(root, ["brain", acpId, ".system_generated", "subagents", `${childId}.json`], "file");
      if (subFile && subFile.info.size <= AGY_MAX_STEP_BYTES) {
        try {
          const rec = JSON.parse(fs.readFileSync(subFile.path, "utf8"));
          if (rec?.state === "SUBAGENT_STATE_KILLED") continue;
        } catch {}
      }
      for (const msg of agyReadInboxSync(root, childId)) {
        const tool = msg?.sourceMetadata?.tool;
        const call = tool?.toolCall;
        if (
          msg?.sender === acpId &&
          (tool?.conversationId === undefined || tool.conversationId === acpId) &&
          call?.name === "invoke_subagent" &&
          typeof call?.id === "string" &&
          wanted.has(call.id)
        ) {
          atWork.push(call.id);
        }
      }
    }
    return atWork;
  } catch {
    return [];
  }
}

/**
 * Reads Antigravity's local per-conversation `transcript.jsonl` tail when present
 * (`~/.gemini/antigravity-cli/brain/<acpId>/.system_generated/logs/transcript.jsonl`),
 * giving sub-second ground truth on whether a reactive wake turn is still mid-step
 * (`"working"`) or has finished its final planner response (`"settled"`), even when
 * two steps share the same 1-second RFC3339 `updatedAt` timestamp. Returns `undefined`
 * when no local transcript file exists (custom data dir, remote peer, or tests).
 */
function agyTranscriptState(acpId) {
  if (!acpId || !AGY_NATIVE_ID.test(acpId)) return undefined;
  const root = agyHomeRoot();
  if (!root) return undefined;
  const file = path.join(root, "brain", acpId, ".system_generated", "logs", "transcript.jsonl");
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const { size } = fs.fstatSync(fd);
    if (size <= 0) return undefined;
    const readLen = Math.min(size, 16_384);
    const offset = size - readLen;
    const buf = Buffer.allocUnsafe(readLen);
    const bytes = fs.readSync(fd, buf, 0, readLen, offset);
    const chunk = buf.toString("utf8", 0, bytes);
    if (!chunk.endsWith("\n")) return { state: "working", stepIndex: Number.MAX_SAFE_INTEGER };
    const lines = chunk.split("\n");
    if (offset > 0) lines.shift();
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const step = JSON.parse(line);
        const stepIndex = typeof step?.step_index === "number" ? step.step_index : 0;
        const done = step?.status === "DONE" || step?.status === "ERROR" || step?.status === "CANCELLED";
        if (!done) return { state: "working", stepIndex };
        const hasTools = Array.isArray(step?.tool_calls) && step.tool_calls.length > 0;
        if (step?.type === "PLANNER_RESPONSE" && !hasTools) return { state: "settled", stepIndex };
        return { state: "working", stepIndex };
      } catch {
        return { state: "working", stepIndex: Number.MAX_SAFE_INTEGER };
      }
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

function acpWakeSleep(ms) {
  if (abortRequested || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const wake = () => {
      clearTimeout(timer);
      if (acpWakeSleepWake === wake) acpWakeSleepWake = undefined;
      resolve();
    };
    const timer = setTimeout(wake, ms);
    timer.unref?.();
    acpWakeSleepWake = wake;
  });
}

function bumpAcpDeferred() {
  if (!acpDeferred) return;
  acpDeferred.generation += 1;
  acpDeferred.bump?.();
}

function acpDeferredSleep(ms, state) {
  if (abortRequested || steerInterrupt || state.peerDead || sessionEpoch !== state.epoch || !acpChild) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let timer;
    const wake = () => {
      if (timer) clearTimeout(timer);
      if (state.bump === wake) state.bump = undefined;
      resolve();
    };
    if (ms > 0) {
      timer = setTimeout(wake, ms);
      timer.unref?.();
    }
    state.bump = wake;
  });
}

function hasAcpOutlivingTools(state) {
  const check = (info) => (isAntigravityAcp() ? antigravityToolOutlivesPrompt(info) : !isDaemonToolInput(info?.rawInput));
  for (const [, info] of state.stream.seen().open) {
    if (check(info)) return true;
  }
  for (const info of acpBackgroundTools.values()) {
    if (check(info)) return true;
  }
  return false;
}

function hasAcpDeferredWork(state) {
  if (pendingUiRequests.size > 0) return true;
  if (hasAcpOutlivingTools(state)) return true;
  if (isAntigravityAcp() && state.subagentIds.size > 0 && agyChildrenAtWork(state.acpId, [...state.subagentIds]).length > 0) {
    return true;
  }
  return false;
}

/**
 * Holds a settled-prompt (or post-settle wake) turn open while background
 * commands, scheduled wakes, detached subagents, pending permission dialogs,
 * or in-flight wake replies (`replyOpen`, awaiting `usage_update`) are still
 * active. Mirrors T3 Code's `scheduleDeferredFinalize` + `hasPendingReply`.
 */
async function waitAcpDeferred(state) {
  for (;;) {
    if (abortRequested || steerInterrupt || sessionEpoch !== state.epoch) return;
    if (state.peerDead || !acpChild) {
      throw new Error(state.peerDeadMessage || "ACP agent exited while background work was running");
    }
    if (pendingUiRequests.size > 0 || hasAcpOutlivingTools(state)) {
      await acpDeferredSleep(0, state);
      continue;
    }
    if (isAntigravityAcp() && state.subagentIds.size > 0 && agyChildrenAtWork(state.acpId, [...state.subagentIds]).length > 0) {
      await acpDeferredSleep(ACP_SUBAGENT_POLL_MS, state);
      continue;
    }
    const agy = isAntigravityAcp();
    const replyOpen = agy ? state.replyOpen : false;
    const waitMs = agy
      ? replyOpen
        ? ACP_OPEN_REPLY_QUIET_LIMIT_MS
        : ACP_DEFERRED_FINALIZE_DEBOUNCE_MS
      : ACP_WAKE_QUIET_MS;
    const gen = state.generation;
    await acpDeferredSleep(waitMs, state);
    if (abortRequested || steerInterrupt || sessionEpoch !== state.epoch) return;
    if (state.peerDead || !acpChild) {
      throw new Error(state.peerDeadMessage || "ACP agent exited while background work was running");
    }
    if (state.generation !== gen) continue;
    if (hasAcpDeferredWork(state)) continue;
    if (agy && !replyOpen && agyHasPendingReply(state.acpId)) {
      // Another background command finished while reply 1 was streaming and its
      // wake sits unread in the inbox / trailing SYSTEM_MESSAGE: keep reply 1
      // visible and wait up to the open-reply quiet limit for reply 2.
      state.replyOpen = true;
      if (state.stream.hasTrailingText()) state.stream.checkpoint({ keepOpenTools: true });
      continue;
    }
    return;
  }
}

function clearStaleBackgroundTools(list = messages, onlyId = undefined) {
  let cleared = false;
  for (const msg of list) {
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block?.type === "toolCall" && block.background && (onlyId === undefined || block.id === onlyId)) {
        delete block.background;
        cleared = true;
      }
    }
  }
  // A line already on disk no longer matches memory — the next save rewrites.
  if (cleared && list === messages) messagesDirty = true;
  return cleared;
}

let reportedBackgroundWatch = false;
function syncBackgroundWatch() {
  if (!process.env.PIPI_SESSION_ID) return;
  const active = Boolean(acpWakeTurn || acpDeferred?.promptSettled || acpBackgroundTools.size > 0);
  if (active === reportedBackgroundWatch) return;
  reportedBackgroundWatch = active;
  emit({ type: "pipi_background_watch", active });
}

function clearAcpBackground() {
  acpBackgroundTools.clear();
  clearStaleBackgroundTools();
  syncBackgroundWatch();
}

/**
 * Opens a turn for updates the agent runs on its own while idle — or returns the
 * one already open. Registration as `turnPromise`/`activeSubTurn` mirrors a
 * prompted turn exactly, so abort, steer and `agent_settled` all come from the
 * machinery a prompt uses. The first content update of the burst lands right
 * after `acpStream` attaches, so it is never missed.
 */
function ensureAcpWakeTurn() {
  if (acpWakeTurn || isStreaming || acpStream || sessionChange || acpEnsurePromise || acpAttaching || !acpChild || !acpSessionId) return;
  isStreaming = true;
  const epoch = sessionEpoch;
  let drainNext;
  const wrapped = runAcpWakeTurn(epoch)
    .then((next) => (drainNext = next))
    .then(() => {
      if (drainNext && sessionEpoch === epoch) return runTurnLoop(drainNext.text, drainNext.images);
    })
    .finally(() => {
      if (turnPromise === wrapped) turnPromise = undefined;
    });
  turnPromise = wrapped;
  void wrapped.catch(() => undefined);
}

/** A post-settle wake turn's body (e.g. a daemon exiting or detached permission request). */
async function runAcpWakeTurn(epoch) {
  const emitTurn = (record) => {
    if (sessionEpoch === epoch) emit(record);
  };
  abortRequested = false;
  emitTurn({ type: "agent_start" });
  emitTurn({ type: "turn_start" });
  const stream = makeTurnStreamHelper(epoch, { turnStart: true });
  const deferred = {
    epoch,
    acpId: acpSessionId,
    stream,
    promptSettled: true,
    replyOpen: true,
    generation: 0,
    promptSeq: 0,
    subagentIds: new Set(),
    peerDead: false,
    peerDeadMessage: undefined,
    bump: undefined,
    onSteer: undefined,
  };
  acpWakeTurn = { epoch, stream };
  acpDeferred = deferred;
  acpStream = stream;
  syncBackgroundWatch();

  let wakeError;
  const sub = waitAcpDeferred(deferred).catch((err) => {
    wakeError = err;
  });
  activeSubTurn = sub.finally(() => {
    if (activeSubTurn === sub) activeSubTurn = undefined;
  });
  await activeSubTurn;

  const wasSteer = steerInterrupt;
  const aborted = abortRequested && !wasSteer;
  const errored = !aborted && !wasSteer && Boolean(wakeError);
  if (!aborted && !errored) {
    // Calls the wake left running keep their background mark; the next burst ends them.
    for (const [id, info] of stream.seen().open) acpBackgroundTools.set(String(id), info);
  }
  stream.finish(
    aborted ? "aborted" : errored ? "error" : "stop",
    errored ? (wakeError instanceof Error ? wakeError.message : String(wakeError)) : undefined,
    { keepOpenTools: !aborted && !errored },
  );
  if (aborted || errored) clearAcpBackground();
  acpWakeTurn = undefined;
  if (acpDeferred === deferred) acpDeferred = undefined;
  if (acpStream === stream) acpStream = undefined;
  emitTurn({ type: "agent_end", willRetry: false });
  syncBackgroundWatch();
  if (sessionEpoch === epoch) await saveExternalSession().catch(() => undefined);
  await pushAcpModel();
  await pushAcpMode();
  await pushAcpEffort();

  // Queued steering/follow-ups drain next — `agent_settled` means nothing waits.
  const mayDrain = !abortRequested || wasSteer;
  steerInterrupt = false;
  let drainNext;
  if (mayDrain && sessionEpoch === epoch && (queuedSteering.length > 0 || queuedFollowUp.length > 0)) {
    drainNext = dequeueNextTurn();
    emitTurn({
      type: "queue_update",
      steering: queuedSteering.map((q) => q.text),
      followUp: queuedFollowUp.map((q) => q.text),
    });
  }
  if (!drainNext && sessionEpoch === epoch) {
    isStreaming = false;
    abortRequested = false;
    emitTurn({ type: "agent_settled", aborted });
  }
  return drainNext;
}

/** The session's `updatedAt` as `session/list` reports it; `undefined` when it cannot say. */
async function acpUpdatedAt(acpId, timeoutMs = 5_000) {
  if (!acpChild) return undefined;
  let cursor = undefined;
  for (let page = 0; page < 5; page++) {
    const res = await acpRequest("session/list", cursor ? { cwd, cursor } : { cwd }, timeoutMs).catch(() => undefined);
    const list = Array.isArray(res?.sessions) ? res.sessions : [];
    const hit = list.find((s) => s?.sessionId === acpId);
    if (hit) return hit.updatedAt === undefined || hit.updatedAt === null ? undefined : String(hit.updatedAt);
    if (!res?.nextCursor) return undefined;
    cursor = res.nextCursor;
  }
  return undefined;
}



/** A tool call's arguments as the transcript takes them, from an ACP `tool_call`. */
function acpToolArgs(u) {
  const locPath = Array.isArray(u.locations) && u.locations[0]?.path ? u.locations[0].path : undefined;
  const rawArgs = u.rawInput && typeof u.rawInput === "object" ? { ...u.rawInput } : u.rawInput !== undefined ? { input: u.rawInput } : { description: u.title || "" };
  if (locPath && !rawArgs.path && !rawArgs.file_path) rawArgs.path = locPath;
  return rawArgs;
}

/** The pipi session tools, attached to every session this bridge opens or loads. */
function acpMcpServers() {
  return !isSubagent && orchestratorUrl && orchestratorToken && fs.existsSync(mcpStdioScript)
    ? [
        {
          name: "pipi",
          command: process.execPath,
          args: [mcpStdioScript],
          env: [
            { name: "PIPI_ORCHESTRATOR_URL", value: orchestratorUrl },
            { name: "PIPI_ORCHESTRATOR_TOKEN", value: orchestratorToken },
          ],
        },
      ]
    : [];
}

function acpWrite(payload) {
  try {
    acpChild?.stdin.write(`${JSON.stringify(payload)}\n`);
  } catch {}
}

/** What the peer last wrote to stderr — usually why it died. Snapped to a line start. */
function acpStderrTail() {
  const tail = acpErrBuf.trim();
  if (tail.length <= 2000) return tail;
  const cut = tail.slice(-2000);
  const nl = cut.indexOf("\n");
  return `…${nl === -1 ? cut : cut.slice(nl + 1)}`;
}

function acpRequest(method, params, timeoutMs = 60_000) {
  if (!acpChild) return Promise.reject(new Error("ACP agent is not running"));
  const id = acpRpcId++;
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject, timer: undefined };
    acpPending.set(id, waiter);
    if (timeoutMs > 0) {
      waiter.timer = setTimeout(() => {
        if (acpPending.delete(id)) {
          const err = new Error(`${method} timed out`);
          // A timeout is the only rejection that says the peer is gone — a
          // JSON-RPC error the peer sent proves it is still answering.
          err.acpTimeout = true;
          reject(err);
        }
      }, timeoutMs);
      waiter.timer.unref?.();
    }
    try {
      acpChild.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    } catch (err) {
      if (waiter.timer) clearTimeout(waiter.timer);
      acpPending.delete(id);
      reject(err);
    }
  });
}

const acpNotify = (method, params) => acpWrite({ jsonrpc: "2.0", method, params });

/** Replaces the picker's placeholder list with models the agent actually offers. */
function adoptModels(list, currentId) {
  const discovered = [];
  for (const m of list || []) {
    const id = m?.modelId ?? m?.id ?? m?.value;
    if (id === undefined || id === null || id === "") continue;
    const image = m?._meta?.["cognition.ai/supportsImages"] ?? m?.supportsImages ?? true;
    discovered.push({
      id: String(id),
      name: String(m?.name || m?.label || id),
      api: "acp",
      provider: agentId,
      reasoning: false,
      input: image === false ? ["text"] : ["text", "image"],
      // Only what the agent advertised; ACP's spec carries no window fields.
      ...(Number(m?.contextWindow) > 0 ? { contextWindow: Number(m.contextWindow) } : {}),
      ...(Number(m?.maxTokens) > 0 ? { maxTokens: Number(m.maxTokens) } : {}),
      cost: zeroCost,
    });
  }
  if (!discovered.length) return;
  const kept = currentModel && currentModel.id !== "default" ? discovered.find((m) => m.id === currentModel.id) : undefined;
  availableModels.splice(0, availableModels.length, ...discovered);
  currentModel = kept || discovered.find((m) => m.id === currentId) || discovered[0];
  emit({ type: "models_changed" });
}

/** ACP v1 allows config-option selects to be grouped: entries may carry `{group, name, options: [...]}`. */
function acpSelectChoices(option) {
  const out = [];
  for (const entry of option?.options || []) {
    if (Array.isArray(entry?.options)) {
      for (const o of entry.options) out.push({ ...o, group: entry.group });
    } else {
      out.push(entry);
    }
  }
  return out;
}

/** Model config values are opaque; DeepSeek Harness encodes `JSON.stringify([provider, model])`. */
function acpModelValueParts(value) {
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === "string" && typeof parsed[1] === "string") {
      return { provider: parsed[0], model: parsed[1] };
    }
  } catch {}
  return { provider: undefined, model: value };
}

/**
 * Adopts a `configOptions` model select — flat for Devin-style agents, provider-grouped
 * for DeepSeek Harness — and keeps the opaque option values for `set_config_option`.
 */
function adoptModelConfigOption(modelOpt) {
  acpModelConfigId = modelOpt.id || "model";
  const choices = acpSelectChoices(modelOpt);
  const discovered = [];
  const values = new Map();
  for (const choice of choices) {
    if (typeof choice?.value !== "string" || !choice.value) continue;
    const parts = acpModelValueParts(choice.value);
    const provider = String(choice.group || parts.provider || agentId);
    const id = String(parts.model);
    values.set(`${provider}/${id}`, choice.value);
    discovered.push({
      id,
      name: String(choice.name || id),
      api: "acp",
      provider,
      reasoning: false,
      input: ["text", "image"],
      cost: zeroCost,
    });
  }
  if (!discovered.length) return;
  acpModelValues = values;
  acpModelConfigCurrent = String(modelOpt.currentValue ?? "");
  const kept = currentModel && currentModel.id !== "default" ? discovered.find((m) => m.id === currentModel.id && m.provider === currentModel.provider) || discovered.find((m) => m.id === currentModel.id) : undefined;
  availableModels.splice(0, availableModels.length, ...discovered);
  const cur = acpModelValueParts(acpModelConfigCurrent);
  currentModel = kept || discovered.find((m) => m.id === cur.model && (!cur.provider || m.provider === cur.provider)) || discovered.find((m) => m.id === cur.model) || discovered[0];
  emit({ type: "models_changed" });
}

/** Devin's dialect / DeepSeek Harness: models, effort and modes are `configOptions` selects, not `models`/`modes`. */
function adoptConfigOptions(options) {
  if (!Array.isArray(options)) return;
  const modelOpt = options.find((o) => o && (o.category === "model" || o.id === "model") && Array.isArray(o.options) && o.options.length);
  if (modelOpt) adoptModelConfigOption(modelOpt);
  const effortOpt = options.find((o) => o && (o.id === "reasoning_effort" || o.category === "thought_level") && Array.isArray(o.options));
  if (effortOpt) {
    const choices = acpSelectChoices(effortOpt);
    acpEffortConfig = {
      id: effortOpt.id || "reasoning_effort",
      values: choices.map((c) => String(c?.value ?? "")).filter(Boolean),
      hasProviderDefault: choices.some((c) => String(c?.value ?? "") === ""),
      currentValue: String(effortOpt.currentValue ?? ""),
    };
    // No user pick on record: follow the session's own effort (the agent's
    // remembered default) rather than forcing pipi's initial "medium" onto it.
    if (!thinkingLevelSet && acpEffortConfig.currentValue) {
      thinkingLevel = acpEffortConfig.currentValue;
    }
    if (!modelOpt) emit({ type: "models_changed" });
  }
  const modeOpt = options.find((o) => o && o.category === "mode" && Array.isArray(o.options) && o.options.length);
  if (modeOpt) {
    acpModeConfigId = modeOpt.id || "mode";
    acpModes = {
      currentModeId: modeOpt.currentValue ?? acpModes?.currentModeId,
      availableModes: acpSelectChoices(modeOpt).map((o) => ({ id: String(o.value), name: String(o.name || o.value) })),
    };
  }
}

function adoptSessionInfo(sess) {
  if (!sess || typeof sess !== "object") return;
  if (Array.isArray(sess.modes?.availableModes) && sess.modes.availableModes.length) {
    acpModes = sess.modes;
  }
  if (Array.isArray(sess.configOptions)) adoptConfigOptions(sess.configOptions);
  const specList = Array.isArray(sess.models?.availableModels) ? sess.models.availableModels : Array.isArray(sess.models) ? sess.models : [];
  if (specList.length && !acpModelConfigId) {
    acpSpecModels = true;
    adoptModels(specList, sess.models?.currentModelId);
  }
}

/** Pushes the selected model through whichever channel the agent advertised. */
async function pushAcpModel() {
  // `acpReset` marks the session id as stale (new/switch/clone): the pick is
  // re-applied after the next negotiation, never on the session being left.
  if (!acpSessionId || acpReset || !currentModel || currentModel.id === "default") return;
  if (acpModelConfigId) {
    // DeepSeek validates the opaque `["provider","model"]` value strictly; a bare id is
    // only the right form for agents whose option values are bare ids (Devin dialect).
    const value = acpModelValues?.get(`${currentModel.provider}/${currentModel.id}`) ?? acpModelValues?.get(`${agentId}/${currentModel.id}`) ?? currentModel.id;
    if (value !== acpModelConfigCurrent) {
      const res = await acpRequest("session/set_config_option", { sessionId: acpSessionId, configId: acpModelConfigId, value }, 10_000).catch(() => undefined);
      if (res?.configOptions) adoptConfigOptions(res.configOptions);
    }
  } else if (acpSpecModels) {
    await acpRequest("session/set_model", { sessionId: acpSessionId, modelId: currentModel.id }, 10_000).catch(() => undefined);
  }
}

/** Maps a pipi thinking level onto the session's advertised `reasoning_effort` choices. */
function acpEffortValueFor(level) {
  const cfg = acpEffortConfig;
  if (!cfg) return undefined;
  if (cfg.values.includes(level)) return level;
  // "off" may be an explicit choice (DeepSeek) or the empty provider-default value.
  if (level === "off") return cfg.hasProviderDefault ? "" : undefined;
  if (level === "minimal") return cfg.values[0];
  if (level === "medium") return cfg.values.includes("medium") ? "medium" : cfg.values[Math.floor((cfg.values.length - 1) / 2)];
  if (level === "high" || level === "max" || level === "xhigh") return cfg.values[cfg.values.length - 1];
  return undefined;
}

async function pushAcpEffort() {
  const cfg = acpEffortConfig;
  if (!acpSessionId || acpReset || !cfg) return;
  const value = acpEffortValueFor(thinkingLevel);
  if (value === undefined || value === cfg.currentValue) return;
  const res = await acpRequest("session/set_config_option", { sessionId: acpSessionId, configId: cfg.id, value }, 10_000).catch(() => undefined);
  if (res?.configOptions) adoptConfigOptions(res.configOptions);
}

// Closest ACP mode ids per pipi runtime mode, in preference order.
// `approval-required` has no ACP equivalent ("ask"/"plan" forbid edits rather
// than prompting): leave the engine's own mode and rely on pipi's permission
// interception for whatever the agent does request.
const ACP_MODE_PREFERENCE = {
  "full-access": ["bypass", "full-access", "yolo", "bypassPermissions", "auto"],
  "auto-accept-edits": ["accept-edits", "acceptEdits", "auto-accept-edits", "smart"],
  "approval-required": ["approval-required", "default", "prompt", "manual"],
};

async function pushAcpMode() {
  const modes = acpModes?.availableModes;
  if (!acpSessionId || acpReset || !Array.isArray(modes) || !modes.length) return;
  const hit = (ACP_MODE_PREFERENCE[runtimeMode] || []).map((wanted) => modes.find((m) => m.id === wanted)).find(Boolean);
  if (!hit || acpModes.currentModeId === hit.id) return;
  if (acpModeConfigId) {
    await acpRequest("session/set_config_option", { sessionId: acpSessionId, configId: acpModeConfigId, value: hit.id }, 10_000).catch(() => undefined);
  } else {
    await acpRequest("session/set_mode", { sessionId: acpSessionId, modeId: hit.id }, 10_000).catch(() => undefined);
  }
  acpModes.currentModeId = hit.id;
}

/** Forwards an ACP `session/request_permission` to pipi's native confirm dialog (or auto-answers). */
async function handleAcpPermission(msg) {
  // A detached permission/question request after prompt settlement opens a wake
  // turn first (T3's `wakeOnDetachedRequest`) so the prompt and its reply run live.
  if (!acpAttaching && !acpStream && isAntigravityAcp()) ensureAcpWakeTurn();
  // Agents may send a partial `toolCall` — DeepSeek Harness only carries `toolCallId`,
  // so enrich from the `tool_call` update that preceded the request.
  const tc = msg.params?.toolCall || {};
  const known = tc.toolCallId !== undefined ? acpRecentTools.get(String(tc.toolCallId)) : undefined;
  const title = tc.title || known?.title || "Allow external agent action?";
  const rawInput = tc.rawInput !== undefined ? tc.rawInput : known?.rawInput;
  const toolKind = String(tc.kind || known?.kind || "").toLowerCase();
  const norm = normalizeToolName(title);
  const isEditOnly = ["edit", "write", "read", "search", "grep", "find", "ls"].includes(toolKind) || ["read", "write", "edit", "grep", "find", "ls"].includes(norm);
  const opts = msg.params?.options || [];
  const pick = (prefix) => opts.find((o) => o.kind === prefix) || opts.find((o) => o.kind?.startsWith(prefix));
  const resumeReplyAfterAnswer = () => {
    if (acpDeferred && isAntigravityAcp()) {
      acpDeferred.replyOpen = true;
      bumpAcpDeferred();
    }
  };
  // agy's fixed-choice questions ride the same channel with `interaction_*` ids:
  // not approvals, and an answer is required even in full-access. Ask the user —
  // never auto-pick an arbitrary option or fabricate an `allow` that is not there.
  if (String(tc.toolCallId || "").startsWith("interaction_")) {
    const uiId = `acp_ask_${msg.id}`;
    const answer = await new Promise((resolve) => {
      pendingUiRequests.set(uiId, resolve);
      bumpAcpDeferred();
      emit({ type: "extension_ui_request", id: uiId, method: "select", title, options: opts.map((o) => String(o.name || o.optionId)) });
    });
    const value = answer?.value;
    const chosen = value === undefined ? undefined : opts.find((o) => o.optionId === value) || opts.find((o) => String(o.name || o.optionId) === value);
    acpWrite({
      jsonrpc: "2.0",
      id: msg.id,
      result: { outcome: chosen ? { outcome: "selected", optionId: chosen.optionId } : { outcome: "cancelled" } },
    });
    resumeReplyAfterAnswer();
    return;
  }
  if (runtimeMode === "full-access" || (runtimeMode === "auto-accept-edits" && isEditOnly)) {
    const allowOpt = pick("allow_once") || pick("allow") || opts[0];
    acpWrite({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "selected", optionId: allowOpt?.optionId || "allow" } } });
    resumeReplyAfterAnswer();
    return;
  }
  const uiId = `acp_perm_${msg.id}`;
  const answer = await new Promise((resolve) => {
    pendingUiRequests.set(uiId, resolve);
    bumpAcpDeferred();
    emit({ type: "extension_ui_request", id: uiId, method: "confirm", title, message: JSON.stringify(rawInput ?? {}, null, 2).slice(0, 1200) });
  });
  const confirmed = answer === true || answer?.confirmed === true;
  const chosen = confirmed ? pick("allow_once") || pick("allow") || opts[0] : pick("reject_once") || pick("reject") || opts.at(-1);
  acpWrite({
    jsonrpc: "2.0",
    id: msg.id,
    result: { outcome: chosen ? { outcome: "selected", optionId: chosen.optionId } : { outcome: "cancelled" } },
  });
  resumeReplyAfterAnswer();
}

/**
 * Recognizes transient API retry banners that ACP agents (notably Antigravity)
 * emit inline as a standalone `agent_message_chunk`, e.g.:
 * `⚠ API error (attempt 1): request failed: Post "...": EOF`
 * so the bridge translates them into Pi's `auto_retry_start`/`auto_retry_end`
 * status events instead of polluting the transcript as permanent prose.
 */
const ACP_RETRY_NOTICE = /^⚠\uFE0F?\s*API error\s*\(attempt\s+(\d+)(?:\s*(?:\/|of)\s*(\d+))?\)\s*:\s*([\s\S]+)$/i;

function parseAcpRetryNotice(text) {
  if (typeof text !== "string" || !text.includes("⚠")) return undefined;
  const match = ACP_RETRY_NOTICE.exec(text.trim());
  if (!match) return undefined;
  const attempt = Number(match[1]);
  if (!Number.isFinite(attempt) || attempt < 1) return undefined;
  const maxAttempts = match[2] ? Number(match[2]) : 0;
  const errorMessage = match[3].replace(/\s+/g, " ").trim();
  if (!errorMessage) return undefined;
  return { attempt, maxAttempts: Number.isFinite(maxAttempts) && maxAttempts > 0 ? maxAttempts : 0, errorMessage };
}

function handleAcpUpdate(u, params = undefined) {
  const kind = u.sessionUpdate || u.type;
  const textOf = (c) => (typeof c === "string" ? c : c?.text || "");
  // A resume/load replay (or late frame carrying `_meta.isReplay: true`) is
  // history arriving at attach, not live traffic: never open a wake turn or
  // mutate live deferred state.
  const isReplay = acpAttaching || params?._meta?.isReplay === true || u?._meta?.isReplay === true;
  if (!isReplay) acpLastEventAt = Date.now();
  const replaying = isReplay && ACP_CONTENT_UPDATES.has(kind);
  // Content while no turn is open is the agent working on its own (agy wakes a
  // finished daemon/timer and streams it): open a wake turn for it.
  if (!replaying && !acpStream && ACP_CONTENT_UPDATES.has(kind)) ensureAcpWakeTurn();
  if (kind === "user_message_chunk") {
    // agy echoes the prompt as it takes it: what came before the echo is a turn it ran while idle.
    if (!replaying) acpStream?.split();
  } else if (kind === "agent_thought_chunk") {
    if (!replaying) {
      acpStream?.thinkDelta(textOf(u.content));
      if (acpDeferred) {
        acpDeferred.replyOpen = true;
        bumpAcpDeferred();
      }
    }
  } else if (kind === "agent_message_chunk") {
    if (!replaying) {
      const text = textOf(u.content);
      const retry = parseAcpRetryNotice(text);
      if (retry) acpStream?.retry(retry.attempt, retry.maxAttempts, retry.errorMessage);
      else acpStream?.textDelta(text);
      if (acpDeferred) {
        acpDeferred.replyOpen = true;
        bumpAcpDeferred();
      }
    }
  } else if (kind === "tool_call") {
    const id = String(u.toolCallId ?? `t_${Date.now()}`);
    acpRecentTools.set(id, { title: u.title || u.kind || "tool", kind: u.kind, rawInput: u.rawInput });
    if (!replaying) {
      acpStream?.toolStart(id, u.title || u.kind || "tool", acpToolArgs(u), {
        kind: u.kind,
        title: u.title,
        rawInput: u.rawInput,
        startedAfterPromptSettled: Boolean(acpDeferred?.promptSettled),
      });
      if (acpDeferred && isAntigravityAcp() && isAntigravitySubagentLaunch(u)) {
        acpDeferred.subagentIds.add(id);
      }
      if (isFinalToolStatus(u.status)) {
        acpStream?.toolEnd(id, formatAcpToolContent(u.content, u.rawOutput), u.status === "failed", acpBackgroundTools.get(id));
        if (acpStream) acpBackgroundTools.delete(id);
      }
      if (acpDeferred) {
        acpDeferred.replyOpen = true;
        bumpAcpDeferred();
      }
    }
  } else if (kind === "tool_call_update") {
    const id = String(u.toolCallId);
    const known = u.toolCallId !== undefined ? acpRecentTools.get(id) : undefined;
    if (known && (u.title || u.kind !== undefined || u.rawInput !== undefined)) {
      acpRecentTools.set(id, {
        title: u.title || known.title,
        kind: u.kind !== undefined ? u.kind : known.kind,
        rawInput: u.rawInput !== undefined ? u.rawInput : known.rawInput,
      });
    }
    if (!replaying) {
      acpStream?.toolMeta?.(id, {
        ...(u.kind !== undefined ? { kind: u.kind } : {}),
        ...(u.title !== undefined ? { title: u.title } : {}),
        ...(u.rawInput !== undefined ? { rawInput: u.rawInput } : {}),
      });
      if (acpDeferred && isAntigravityAcp() && isAntigravitySubagentLaunch({ ...known, ...u })) {
        acpDeferred.subagentIds.add(id);
      }
      if (isFinalToolStatus(u.status)) {
        acpStream?.toolEnd(u.toolCallId, formatAcpToolContent(u.content, u.rawOutput), u.status === "failed", acpBackgroundTools.get(id));
        if (acpStream) acpBackgroundTools.delete(id);
      }
      if (acpDeferred) {
        // A completed background tool wakes the model; hold the reply open until
        // the model streams its response and closes it with `usage_update`.
        acpDeferred.replyOpen = true;
        bumpAcpDeferred();
      }
    }
  } else if (kind === "usage_update") {
    acpUsage = { used: Number(u.used ?? 0), size: Number(u.size ?? 0) };
    // The session's running cost: what it grew by since the last reading. A session
    // resumed with nothing to measure against only sets the mark for the next one.
    const known = usageBaseline?.thread === acpSessionId ? usageBaseline : undefined;
    const cost = acpCostPart(u.cost, known);
    if (cost) usageBaseline = { thread: acpSessionId, ...cost.total };
    if (isReplay) {
      // A replay's usage is history, not new spend: refresh the marks, record nothing.
      return;
    }
    acpStream?.usageSample(acpMetaSample(u._meta));
    if (cost) {
      // Between prompts there is no turn to put it on: it is the session's all the same.
      if (known && acpStream) acpStream.usage(cost.part);
      else if (known && !isBlank(cost.part)) recordUsageEntry(toUsage([cost.part]), "late");
    }
    if (acpDeferred && isAntigravityAcp()) {
      acpDeferred.replyOpen = false;
      // When a reply finishes while another background tool is still running,
      // checkpoint the reply now so it stays visible as a distinct answer when
      // the later wake streams in the same run.
      if (acpDeferred.promptSettled && acpDeferred.stream.hasTrailingText() && hasAcpDeferredWork(acpDeferred)) {
        acpDeferred.stream.checkpoint({ keepOpenTools: true });
      }
      bumpAcpDeferred();
    }
  } else if (kind === "config_option_update") {
    adoptConfigOptions(u.configOptions);
  } else if (kind === "available_commands_update") {
    adoptCommands(u.availableCommands);
  } else if (kind === "current_mode_update" && acpModes) {
    acpModes.currentModeId = u.currentModeId;
  }
}

function spawnAcp(bin) {
  const child = spawnBinary(bin, resolveAcpArgs(bin), {
    cwd,
    env: agentRuntimeEnv(),
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  guardStdin(child);
  acpChild = child;
  activeChild = child;
  acpOutBuf = "";
  acpErrBuf = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => {
    acpErrBuf = (acpErrBuf + c).slice(-6000);
  });
  child.stdout.on("data", (chunk) => {
    acpLastOutAt = Date.now();
    acpOutBuf += chunk;
    let nl = acpOutBuf.indexOf("\n");
    while (nl !== -1) {
      const line = acpOutBuf.slice(0, nl).replace(/\r$/, "");
      acpOutBuf = acpOutBuf.slice(nl + 1);
      if (line.trim()) {
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
            const waiter = acpPending.get(msg.id);
            if (waiter) {
              acpPending.delete(msg.id);
              if (waiter.timer) clearTimeout(waiter.timer);
              if (msg.error) {
                const err = new Error(msg.error.message || "ACP error");
                err.acpCode = msg.error.code;
                waiter.reject(err);
              }
              else waiter.resolve(msg.result);
            }
          } else if (msg.method === "session/update" && msg.params?.update) {
            handleAcpUpdate(msg.params.update, msg.params);
          } else if (msg.method === "session/request_permission" && msg.id !== undefined) {
            void handleAcpPermission(msg);
          } else if (msg.id !== undefined && typeof msg.method === "string") {
            // Client-side methods we do not implement (fs/*, terminal/*, elicitation/*)
            // still get an answer — a silent drop would hang the agent's call forever.
            acpWrite({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not implemented: ${msg.method}` } });
          }
        } catch {}
      }
      nl = acpOutBuf.indexOf("\n");
    }
  });
  const drop = (cause, signal) => {
    if (acpChild !== child) return;
    acpChild = undefined;
    acpSessionId = undefined;
    acpStream = undefined;
    acpWakeTurn = undefined;
    if (activeChild === child) activeChild = undefined;
    const detail = cause instanceof Error ? cause.message : signal ? `killed with ${signal}` : `code ${cause}`;
    const stderr = acpStderrTail();
    const message = `ACP agent exited (${detail})${stderr ? `:\n${stderr}` : ""}`;
    if (acpDeferred) {
      acpDeferred.peerDead = true;
      acpDeferred.peerDeadMessage = message;
      bumpAcpDeferred();
    }
    clearAcpBackground();
    for (const [, w] of acpPending) {
      if (w.timer) clearTimeout(w.timer);
      w.reject(new Error(message));
    }
    acpPending.clear();
    for (const [, resolve] of pendingUiRequests) resolve(false);
    pendingUiRequests.clear();
  };
  child.on("error", drop);
  child.on("close", drop);
  // `exit` is the dead-peer signal `close` withholds: under Antigravity's
  // --process-per-session the front can exit while a session worker inherits the
  // pipes — stdio never reaches EOF, but a dead front answers nothing.
  child.on("exit", drop);
}

let acpCatalogCooldownUntil = 0;
const ACP_DISCOVERY_WAIT_MS = agentId === "antigravity" ? 8000 : 3500;

function dropAcpPeer(reason = "ACP agent reset") {
  const child = acpChild;
  acpChild = undefined;
  acpSessionId = undefined;
  acpStream = undefined;
  acpWakeTurn = undefined;
  if (activeChild === child) activeChild = undefined;
  const stderr = acpStderrTail();
  const detail = stderr ? `${reason}:\n${stderr}` : reason;
  if (acpDeferred) {
    acpDeferred.peerDead = true;
    acpDeferred.peerDeadMessage = detail;
    bumpAcpDeferred();
  }
  clearAcpBackground();
  for (const [, w] of acpPending) {
    if (w.timer) clearTimeout(w.timer);
    w.reject(new Error(detail));
  }
  acpPending.clear();
  for (const [, resolve] of pendingUiRequests) resolve(false);
  pendingUiRequests.clear();
  if (child) {
    try {
      if (process.platform === "win32") child.kill();
      else process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill();
      } catch {}
    }
  }
}

/**
 * Guarantees a live ACP session: respawns the peer when dead (re-attaching the
 * persisted session via `session/load`), and negotiates a session whenever the
 * pipi session changed (`new_session`, `switch_session`, or a fresh spawn).
 * Concurrent callers share one negotiation — the model list and a first prompt
 * must never open two sessions on the same peer.
 */
function ensureAcp(bin) {
  if (!acpEnsurePromise) {
    acpEnsurePromise = ensureAcpSession(bin)
      .then((id) => {
        acpCatalogCooldownUntil = 0;
        return id;
      })
      .catch((err) => {
        acpCatalogCooldownUntil = Date.now() + 15_000;
        throw err;
      })
      .finally(() => {
        acpEnsurePromise = undefined;
      });
  }
  return acpEnsurePromise;
}

async function ensureAcpSession(bin) {
  // A session change (`sessionEpoch`) mid-handshake does not wait for it: the
  // round in flight is left stale and negotiation runs again for the session
  // now open — a stale round's failure (its peer dropped) is not the caller's.
  for (;;) {
    while (sessionChange) await sessionChange;
    const epoch = sessionEpoch;
    acpRoundEpoch = epoch;
    try {
      const id = await negotiateAcpRound(bin, epoch);
      if (id !== undefined) return id;
    } catch (err) {
      if (sessionEpoch === epoch) throw err;
    } finally {
      acpRoundEpoch = undefined;
    }
  }
}

/** The pipi session epoch the ACP negotiation round in flight was started for. */
let acpRoundEpoch = undefined;

/** One handshake for the session open at `epoch`; `undefined` when a session change made it stale. */
async function negotiateAcpRound(bin, epoch) {
  if (!acpChild) {
    spawnAcp(bin);
    let init;
    try {
      // ACP v2: the agent answers the highest version it supports. Capabilities
      // are honest — no client fs/terminal handlers exist, and `session.notices`
      // is what v2 agents like agy push post-settle session updates through.
      init = await acpRequest(
        "initialize",
        {
          protocolVersion: 2,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
            session: { notices: {} },
          },
          clientInfo: { name: "pipi", version: "0.1.0" },
        },
        30_000,
      );
    } catch (err) {
      dropAcpPeer("ACP initialize failed");
      throw err;
    }
    acpLoadSession = !!init?.agentCapabilities?.loadSession;
    acpSessionCaps = init?.agentCapabilities?.sessionCapabilities || undefined;
    acpAgentInfo = init?.agentInfo || undefined;
    acpAuthMethods = Array.isArray(init?.authMethods) ? init.authMethods : [];
    acpModes = undefined;
    acpModelConfigId = undefined;
    acpModeConfigId = undefined;
    acpSpecModels = false;
    acpReset = true;
  }
  if (acpReset || !acpSessionId) {
    // Release the previous session on this peer when the agent supports it —
    // DeepSeek Harness keeps every session resident until `session/close`.
    // Antigravity is the exception: closing tears the session down server-side
    // (background tasks, resumability), and its sessions end with the process.
    const agy = /antigravity/i.test(String(acpAgentInfo?.name || ""));
    if (acpReset && acpSessionId && acpSessionCaps?.close !== undefined && !agy) {
      await acpRequest("session/close", { sessionId: acpSessionId }, 5_000).catch(() => undefined);
      acpSessionId = undefined;
    }
    acpUsage = undefined;
    acpEffortConfig = undefined;
    acpModelValues = undefined;
    acpModelConfigCurrent = undefined;
    acpModelConfigId = undefined;
    acpModeConfigId = undefined;
    acpSpecModels = false;
    acpRecentTools.clear();
    clearAcpBackground();
    const mcpServers = acpMcpServers();
    const stale = () => sessionEpoch !== epoch;
    try {
      let sess;
      if (nativeThreadId) {
        // ACP v1 `session/resume` (sessionCapabilities.resume) for DeepSeek Harness and
        // newer agents; the older `loadSession`/`session/load` draft for Devin & co.
        // A replayed conversation during attach is history, not live traffic.
        acpAttaching = true;
        try {
          if (acpSessionCaps?.resume !== undefined) {
            sess = await acpRequest("session/resume", { sessionId: nativeThreadId, cwd, mcpServers }, 30_000).catch(() => undefined);
          } else if (acpLoadSession) {
            sess = await acpRequest("session/load", { sessionId: nativeThreadId, cwd, mcpServers }, 30_000).catch(() => undefined);
          }
        } finally {
          acpAttaching = false;
        }
      }
      let begun = false;
      if (!sess && !stale()) {
        const newParams = { cwd, mcpServers };
        // Antigravity's session `_meta`: 1.4.2–1.4.5 scatter a run-workflow skill
        // file into the workspace unless the tool is disabled up front.
        if (/antigravity/i.test(String(acpAgentInfo?.name || ""))) {
          newParams._meta = { antigravity: { disabledTools: agyWritesRunWorkflowSkill(acpAgentInfo?.version) ? ["run_workflow"] : [] } };
        }
        sess = await acpRequest("session/new", newParams, 30_000).catch(async (err) => {
          // AUTH_REQUIRED (-32000) or a text match: authenticate once, then retry.
          if (!acpAuthMethods.length || !(err?.acpCode === -32000 || /auth/i.test(String(err?.message || "")))) throw err;
          await acpRequest("authenticate", { methodId: acpAuthMethods[0].id }, 60_000);
          return acpRequest("session/new", newParams, 30_000);
        });
        begun = true;
      }
      if (stale()) {
        // Opened for the session the user left: keep its id only so the next round closes it.
        if (sess?.sessionId) acpSessionId = sess.sessionId;
        acpReset = true;
        return undefined;
      }
      acpSessionId = sess?.sessionId || nativeThreadId || sessionId;
      // A session begun here starts from nothing: its running cost is all this session's.
      if (begun) usageBaseline = { thread: acpSessionId, cost: 0 };
      const learnedNativeId = nativeThreadId !== acpSessionId;
      nativeThreadId = acpSessionId;
      acpReset = false;
      adoptSessionInfo(sess);
      if (learnedNativeId && sessionFile) {
        await saveExternalSession().catch(() => undefined);
      }
      await pushAcpModel();
      await pushAcpMode();
      await pushAcpEffort();
      if (stale()) return undefined;
    } catch (err) {
      // Do not retain a half-negotiated peer. A failed session/new or config
      // update used to leave acpChild alive with acpReset=true, so every
      // catalog read or next prompt retried the same broken handshake.
      dropAcpPeer("ACP session negotiation failed");
      throw err;
    }
  }
  return acpSessionId;
}

const ACP_STOP_REASONS = { end_turn: "stop", max_tokens: "length", cancelled: "aborted", refusal: "stop", max_turn_requests: "stop" };

// ── The prompt watchdog ──────────────────────────────────────────────────────
// `session/prompt` is the one request with no deadline: its notification stream
// is the turn's heartbeat, and a peer can keep the process and its pipes alive
// while the turn dies silently — an Antigravity session worker wedged
// mid-dispatch under `--process-per-session`, or a front whose stdin no longer
// reaches the worker. `close` never fires either while grandchildren hold the
// pipes. So silence past SILENCE_MS probes the peer on the same connection —
// any answer, even a JSON-RPC error, is life; a probe that times out means the
// request path is dead and the peer is dropped, ending the turn as an error
// instead of hanging forever. A peer that still answers but reports no turn
// progress for STALL_MS — no `session/update`, no move of the session's
// `updatedAt` or Antigravity's transcript step — is judged stalled the same
// way. A turn waiting on the user's own permission answer is never a wedge.
const ACP_TURN_SILENCE_MS = Number(process.env.PIPI_ACP_TURN_SILENCE_MS) || 90_000;
const ACP_TURN_PROBE_MS = Number(process.env.PIPI_ACP_TURN_PROBE_MS) || 20_000;
const ACP_TURN_STALL_MS = Number(process.env.PIPI_ACP_TURN_STALL_MS) || 20 * 60_000;

/** `session/list` as a liveness probe: any answer is life; only a timeout is a dead path. */
async function acpProbeAlive() {
  if (!acpChild) return false;
  try {
    await acpRequest("session/list", { cwd }, ACP_TURN_PROBE_MS);
  } catch (err) {
    return !err?.acpTimeout;
  }
  return true;
}

/** Awaits a `session/prompt`, dropping a peer that goes silent or stops making progress. */
async function acpPromptWatched(acpId, params, isSuperseded = () => false) {
  const prompt = acpRequest("session/prompt", params, 0);
  let markAt = undefined; // the session's `updatedAt` as session/list last reported it
  let markStep = undefined; // Antigravity's transcript step at the last look
  let markEvent = acpLastEventAt; // session traffic the turn has produced so far
  let quietSince = Date.now();
  for (;;) {
    let timer;
    const outcome = await Promise.race([
      prompt.then(() => "done", () => "done"),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve("waited"), ACP_TURN_SILENCE_MS);
        timer.unref?.();
        const prev = acpWakeSleepWake;
        const wake = () => {
          clearTimeout(timer);
          if (acpWakeSleepWake === wake) acpWakeSleepWake = prev;
          resolve("woken");
        };
        acpWakeSleepWake = wake;
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (outcome === "done" || abortRequested || isSuperseded()) return prompt;
    if (pendingUiRequests.size > 0 || Date.now() - acpLastOutAt < ACP_TURN_SILENCE_MS) continue;
    if (!(await acpProbeAlive())) {
      dropAcpPeer("ACP agent stopped responding mid-turn");
      return prompt;
    }
    if (abortRequested || isSuperseded()) return prompt;
    const at = await acpUpdatedAt(acpId, ACP_TURN_PROBE_MS);
    const step = agyTranscriptState(acpId)?.stepIndex;
    if (at !== markAt || step !== markStep || acpLastEventAt !== markEvent) {
      markAt = at;
      markStep = step;
      markEvent = acpLastEventAt;
      quietSince = Date.now();
      continue;
    }
    if (Date.now() - quietSince >= ACP_TURN_STALL_MS) {
      dropAcpPeer("ACP turn stalled — the agent answers but its session made no progress");
      return prompt;
    }
  }
}

// ACP (Agent Client Protocol) JSON-RPC 2.0 over stdio — one prompt per call on
// the persistent session; peer lifetime managed by ensureAcp/spawnAcp above.
async function runAcpTurn(bin, promptText, images = [], turnEpoch = sessionEpoch) {
  const acpId = await ensureAcp(bin);
  // `session/cancel` only applies to a prompt already in flight — one sent
  // after the cancel starts fresh, so a turn aborted during negotiation must
  // never reach session/prompt.
  if (sessionEpoch !== turnEpoch || abortRequested) {
    if (abortRequested && sessionEpoch === turnEpoch) {
      const stream = makeTurnStreamHelper(turnEpoch);
      stream.finish("aborted");
    }
    return;
  }
  const emitTurn = (record) => {
    if (sessionEpoch === turnEpoch) emit(record);
  };
  const stream = makeTurnStreamHelper(turnEpoch);
  const deferred = {
    epoch: turnEpoch,
    acpId,
    stream,
    promptSettled: false,
    replyOpen: false,
    generation: 0,
    promptSeq: 0,
    subagentIds: new Set(),
    peerDead: false,
    peerDeadMessage: undefined,
    bump: undefined,
    onSteer: undefined,
  };
  acpDeferred = deferred;
  acpStream = stream;
  try {
    let res;
    let activeSeq = ++deferred.promptSeq;
    let currentPrompt = acpPromptWatched(
      acpId,
      { sessionId: acpId, prompt: [{ type: "text", text: promptText }, ...images] },
      () => deferred.promptSeq !== activeSeq,
    );
    let steerWake;
    let steerPromise = new Promise((resolve) => {
      steerWake = resolve;
    });
    const notifySteer = () => {
      const wake = steerWake;
      steerPromise = new Promise((resolve) => {
        steerWake = resolve;
      });
      wake?.();
    };
    if (agySteersWithPrompt()) {
      deferred.onSteer = notifySteer;
    }
    for (;;) {
      const step = await Promise.race([
        currentPrompt.then(
          (result) => ({ kind: "done", result }),
          (err) => ({ kind: "err", err }),
        ),
        steerPromise.then(() => ({ kind: "steer" })),
      ]);
      if (step.kind === "steer") {
        if (abortRequested || sessionEpoch !== turnEpoch || !acpChild) continue;
        const nextSteer = dequeueNextTurn();
        if (!nextSteer) continue;
        emitTurn({
          type: "queue_update",
          steering: queuedSteering.map((q) => q.text),
          followUp: queuedFollowUp.map((q) => q.text),
        });
        const supersededPrompt = currentPrompt;
        void supersededPrompt.then(
          (r) => {
            if (sessionEpoch === turnEpoch) stream.usageSummary(acpPromptPart(r?.usage));
          },
          () => undefined,
        );
        stream.checkpoint({ keepOpenTools: true, startNextTurn: true });
        const steerUserMsg = {
          role: "user",
          content: [{ type: "text", text: nextSteer.text }, ...nextSteer.images],
          timestamp: Date.now(),
        };
        if (sessionEpoch === turnEpoch) {
          messages.push(steerUserMsg);
          void saveExternalSession().catch(() => undefined);
        }
        emitTurn({ type: "message_start", message: steerUserMsg });
        emitTurn({ type: "message_end", message: steerUserMsg });
        activeSeq = ++deferred.promptSeq;
        deferred.replyOpen = true;
        currentPrompt = acpPromptWatched(
          acpId,
          { sessionId: acpId, prompt: [{ type: "text", text: nextSteer.text }, ...nextSteer.images] },
          () => deferred.promptSeq !== activeSeq,
        );
        continue;
      }
      if (step.kind === "err") throw step.err;
      res = step.result;
      break;
    }
    deferred.onSteer = undefined;
    const stopReason = abortRequested ? "aborted" : ACP_STOP_REASONS[res?.stopReason] || "stop";
    stream.usageSummary(acpPromptPart(res?.usage));

    // Antigravity returns `end_turn` while background commands, scheduled wakes,
    // detached subagents, or unread inbox wakes are still pending. Hold the turn
    // open until they finish and their follow-up replies settle.
    if (isAntigravityAcp() && !abortRequested && stopReason === "stop") {
      deferred.promptSettled = true;
      const deferredWork = hasAcpDeferredWork(deferred);
      const pendingReply = !deferredWork && agyHasPendingReply(acpId);
      if (deferredWork || pendingReply) {
        if (stream.hasTrailingText()) {
          stream.checkpoint({ keepOpenTools: true, startNextTurn: true });
        }
        if (pendingReply) deferred.replyOpen = true;
        syncBackgroundWatch();
        await waitAcpDeferred(deferred);
      }
    }

    const wasSteer = steerInterrupt;
    const aborted = abortRequested && !wasSteer;
    const finalStop = aborted ? "aborted" : stopReason;
    // Calls still open at the answer (daemons, or commands surviving a steer)
    // stay tracked so a later wake or turn can finish them by id.
    const keepOpenTools = !aborted && stream.seen().open.length > 0;
    if (keepOpenTools) for (const [id, info] of stream.seen().open) acpBackgroundTools.set(String(id), info);
    stream.finish(finalStop, undefined, { keepOpenTools });
    if (aborted) clearAcpBackground();
    syncBackgroundWatch();
  } catch (err) {
    const aborted = abortRequested && !steerInterrupt;
    clearAcpBackground();
    stream.finish(aborted ? "aborted" : "error", !aborted ? (err instanceof Error ? err.message : String(err)) || acpStderrTail() : undefined);
  } finally {
    if (acpDeferred === deferred) acpDeferred = undefined;
    if (acpStream === stream) acpStream = undefined;
    syncBackgroundWatch();
  }
}

// ── RPC Command Loop (stdin → stdout) ───────────────────────────────────────

/**
 * ACP agents advertise their models/thinking levels only during session
 * negotiation, which used to happen on the first prompt — leaving the picker
 * on the pre-connect "Default" placeholder until then. Listing a catalog is a
 * read: negotiate the session now (the promise guard dedupes racing callers),
 * but bound how long read-only queries block so slow/offline servers never
 * freeze waking or opening a session; if negotiation finishes later in the
 * background, `models_changed` updates the client live.
 */
async function discoverAcpCatalog() {
  // A stale id (acpReset after new/switch/clone) is not a negotiated session:
  // reading the catalog re-negotiates now so pickers and restored choices
  // reflect the fresh session, not the one being replaced.
  if (driver !== "acp" || (acpSessionId && !acpReset)) return;
  if (!acpEnsurePromise && Date.now() < acpCatalogCooldownUntil) return;
  const bin = resolveDriverBinary();
  if (!bin) return;
  const negotiation = ensureAcp(bin).catch(() => undefined);
  let timer;
  await Promise.race([
    negotiation,
    new Promise((resolve) => {
      timer = setTimeout(resolve, ACP_DISCOVERY_WAIT_MS);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
}

/**
 * Reads the engine's real catalog for whichever driver is active: ACP session
 * negotiation, or Claude's initialize probe. Reads block at most
 * ACP_DISCOVERY_WAIT_MS; a late answer still lands via `models_changed`.
 */
async function discoverCatalog() {
  if (driver === "claude") {
    const probe = ensureClaudeCatalog();
    let timer;
    await Promise.race([
      probe,
      new Promise((resolve) => {
        timer = setTimeout(resolve, ACP_DISCOVERY_WAIT_MS);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
    return;
  }
  await discoverAcpCatalog();
}

/** A session change under way: the next ACP negotiation round waits for its state. */
let sessionChange = undefined;

/**
 * Runs a session-changing command without waiting on the engine: any active
 * turn settles first while `sessionEpoch` still matches so its aborted record
 * flushes to disk and emits `agent_settled`, a handshake in flight is left
 * stale (`ensureAcpSession` runs it again for the new session), and one still
 * stalled after a brief window has its peer dropped in the background.
 */
async function changeSession(apply) {
  const prev = sessionChange;
  let done;
  const mine = new Promise((resolve) => {
    done = resolve;
  });
  sessionChange = mine;
  try {
    if (prev) await prev;
    if (queuedSteering.length > 0 || queuedFollowUp.length > 0) {
      queuedSteering = [];
      queuedFollowUp = [];
      emit({ type: "queue_update", steering: [], followUp: [] });
    }
    steerInterrupt = false;
    if (turnPromise) {
      await settleActiveTurn(2500);
    }
    if (acpWakeTurn || acpBackgroundTools.size > 0) {
      acpWakeTurn = undefined;
      clearAcpBackground();
      if (messagesDirty && sessionFile) {
        await saveExternalSession().catch(() => undefined);
      }
    }
    sessionEpoch++;
    const changedAt = sessionEpoch;
    acpReset = true;
    if (acpRoundEpoch !== undefined) {
      const timer = setTimeout(() => {
        if (acpRoundEpoch !== undefined && acpRoundEpoch < changedAt) dropAcpPeer("ACP negotiation cancelled for session change");
      }, 1500);
      timer.unref?.();
    }
    acpCatalogCooldownUntil = 0;
    isStreaming = false;
    abortRequested = false;
    await apply();
    acpReset = true;
  } finally {
    if (sessionChange === mine) sessionChange = undefined;
    done();
  }
}

async function handleCommand(cmd) {
  switch (cmd.type) {
    case "get_state":
      return {
        model: currentModel,
        thinkingLevel,
        isStreaming,
        isCompacting: false,
        steeringMode,
        followUpMode,
        sessionFile,
        sessionId,
        sessionName,
        autoCompactionEnabled,
        messageCount: messages.length,
        pendingMessageCount: queuedSteering.length + queuedFollowUp.length,
      };
    case "get_available_models":
      await discoverCatalog();
      return { models: availableModels };
    case "get_available_thinking_levels":
      await discoverCatalog();
      if (driver === "acp" && acpEffortConfig?.values?.length) return { levels: [...new Set(["off", ...acpEffortConfig.values])] };
      if (driver === "claude" && currentModel?.reasoning) {
        const efforts = Array.isArray(currentModel.effortLevels) && currentModel.effortLevels.length ? currentModel.effortLevels : ["low", "medium", "high"];
        return { levels: [...new Set(["off", ...efforts])] };
      }
      return { levels: currentModel?.reasoning ? ["off", "low", "medium", "high"] : ["off"] };
    case "get_messages": {
      // The in-flight turn's message so far: a reattached client rebuilds its
      // live rows from it instead of losing them to a history that holds a
      // turn's tool results ahead of the one message calling them.
      const pending = liveTurnStream?.pending();
      return { messages: pending ? [...messages, pending] : messages };
    }
    case "get_commands":
      return { commands: agentCommands };
    case "get_session_stats": {
      const userCount = messages.filter((m) => m.role === "user").length;
      const assistantCount = messages.filter((m) => m.role === "assistant").length;
      const toolResults = messages.filter((m) => m.role === "toolResult").length;
      // What is in context is what the engine said the last request held — never
      // the session's running total, which only grows. An engine that says
      // neither (Codex) gets no figure rather than a wrong one.
      const used = acpUsage ? acpUsage.used : contextTokens ?? null;
      // The window is only what the engine reported (`usage_update.size`, a Claude
      // `result.modelUsage` window) or advertised per model — never assumed. No
      // percent without it.
      const win = acpUsage?.size || contextWindow || currentModel?.contextWindow || null;
      const total = tokensOf(sessionUsage);
      return {
        sessionFile,
        sessionId,
        userMessages: userCount,
        assistantMessages: assistantCount,
        toolCalls: toolResults,
        toolResults,
        totalMessages: messages.length,
        tokens: { input: sessionUsage.input, output: sessionUsage.output, cacheRead: sessionUsage.cacheRead, cacheWrite: sessionUsage.cacheWrite, total },
        cost: sessionUsage.cost,
        // Tokens without a cost: the engine names none, so there is none to show.
        costReported: sessionUsage.priced,
        contextUsage: {
          tokens: used,
          contextWindow: win,
          percent: win && used !== null ? Math.min(100, (used / win) * 100) : null,
        },
      };
    }
    case "prompt": {
      while (sessionChange) await sessionChange;
      const text = String(cmd.message || "");
      const images = imageBlocks(cmd.images);
      if (isStreaming) {
        if (cmd.streamingBehavior === "followUp") {
          queuedFollowUp.push({ text, images });
        } else {
          queuedSteering.push({ text, images });
          // Where the conversation survives a restart, a steer interrupts the
          // in-flight turn now and re-runs on the resumed thread — instead of
          // waiting for the turn to end like a prioritized follow-up.
          // On Antigravity >= 1.5.0, steering sends `session/prompt` directly
          // without `session/cancel` so running commands/subagents stay alive.
          if (acpDeferred?.onSteer) {
            emit({ type: "queue_update", steering: queuedSteering.map((q) => q.text), followUp: queuedFollowUp.map((q) => q.text) });
            acpDeferred.onSteer();
            return { disposition: "queued" };
          }
          if (canSteerRestart()) {
            steerInterrupt = true;
            void settleCurrentSubTurn(10_000);
          }
        }
        emit({ type: "queue_update", steering: queuedSteering.map((q) => q.text), followUp: queuedFollowUp.map((q) => q.text) });
        return { disposition: "queued" };
      }
      void executeTurn(text, images);
      return { disposition: "started" };
    }
    case "steer":
      return handleCommand({ ...cmd, type: "prompt", streamingBehavior: "steer" });
    case "follow_up":
      return handleCommand({ ...cmd, type: "prompt", streamingBehavior: "followUp" });
    case "abort":
      steerInterrupt = false;
      if (queuedSteering.length > 0 || queuedFollowUp.length > 0) {
        queuedSteering = [];
        queuedFollowUp = [];
        emit({ type: "queue_update", steering: [], followUp: [] });
      }
      await settleActiveTurn(10_000);
      return undefined;
    case "clear_queue": {
      const cleared = { steering: queuedSteering.map((q) => q.text), followUp: queuedFollowUp.map((q) => q.text) };
      queuedSteering = [];
      queuedFollowUp = [];
      emit({ type: "queue_update", steering: [], followUp: [] });
      return cleared;
    }
    case "new_session":
      await changeSession(async () => {
        messages = [];
        sessionId = crypto.randomUUID();
        sessionFile = undefined;
        sessionName = undefined;
        nativeThreadId = undefined;
        flushed = undefined;
        flushedState = undefined;
        messagesDirty = false;
        resetSessionUsage();
      });
      return { cancelled: false };
    case "switch_session":
      await changeSession(() => loadExternalSession(String(cmd.sessionPath)));
      return { cancelled: false };
    case "clone":
      await changeSession(async () => {
        sessionId = crypto.randomUUID();
        sessionFile = undefined;
        nativeThreadId = undefined;
        flushed = undefined;
        flushedState = undefined;
        messagesDirty = false;
        // The clone starts a fresh native thread: the engine's context is the
        // next prompt alone, so the last fill no longer stands for it.
        contextTokens = undefined;
        resetSessionUsage();
        await saveExternalSession();
      });
      return { cancelled: false };
    case "set_model": {
      const found = availableModels.find((m) => m.id === cmd.modelId && m.provider === cmd.provider) || availableModels.find((m) => m.id === cmd.modelId);
      if (!found) throw new Error(`Model not found: ${cmd.provider}/${cmd.modelId}`);
      currentModel = found;
      if (driver === "acp") void pushAcpModel();
      return found;
    }
    case "set_thinking_level":
      thinkingLevel = cmd.level || "medium";
      thinkingLevelSet = true;
      if (driver === "acp") void pushAcpEffort();
      emit({ type: "thinking_level_changed", level: thinkingLevel });
      return undefined;
    case "set_session_name":
      sessionName = String(cmd.name || "").trim() || undefined;
      await saveExternalSession().catch(() => undefined);
      emit({ type: "session_info_changed", name: sessionName });
      return undefined;
    case "set_steering_mode":
      steeringMode = cmd.mode || "one-at-a-time";
      return undefined;
    case "set_follow_up_mode":
      followUpMode = cmd.mode || "one-at-a-time";
      return undefined;
    case "set_auto_compaction":
      autoCompactionEnabled = !!cmd.enabled;
      return undefined;
    case "set_auto_retry":
    case "abort_retry":
      return undefined;
    case "set_runtime_mode":
      runtimeMode = cmd.mode || runtimeMode;
      if (driver === "acp") void pushAcpMode();
      return { mode: runtimeMode };
    case "get_last_assistant_text": {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "assistant" && Array.isArray(messages[i].content)) {
          const text = messages[i].content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("\n");
          if (text) return { text };
        }
      }
      return { text: null };
    }
    case "bash": {
      return await new Promise((resolve) => {
        const sh = shellForCommand(String(cmd.command || ""));
        const child = spawnBinary(sh.file, sh.args, { cwd, env: childEnv() });
        let out = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        const push = (d) => {
          out += d;
          emit({ type: "bash_execution_update", id: cmd.id, delta: d });
        };
        child.stdout.on("data", push);
        child.stderr.on("data", push);
        // A shell that could not start (the folder is gone, no shell on PATH) is the command's answer, not the bridge's end.
        child.on("error", (err) => {
          resolve({ output: `${out}${err.message}\n`, exitCode: 127, cancelled: false, truncated: false });
        });
        child.on("close", (code) => {
          const bashMsg = { role: "bashExecution", command: String(cmd.command || ""), output: out, exitCode: code ?? 0, cancelled: false, truncated: false, timestamp: Date.now() };
          if (!cmd.excludeFromContext) messages.push(bashMsg);
          resolve({ output: out, exitCode: code ?? 0, cancelled: false, truncated: false });
        });
      });
    }
    default:
      // An honest no: a command this driver does not have fails like it does not
      // have it — answering success would be work reported as done that never was.
      throw new Error(`unsupported command "${cmd.type}"`);
  }
}

let stdinBuf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdinBuf += chunk;
  let nl = stdinBuf.indexOf("\n");
  while (nl !== -1) {
    const line = stdinBuf.slice(0, nl).replace(/\r$/, "");
    stdinBuf = stdinBuf.slice(nl + 1);
    if (line.trim()) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === "extension_ui_response" && parsed.id) {
          const waiter = pendingUiRequests.get(parsed.id);
          if (waiter) {
            pendingUiRequests.delete(parsed.id);
            waiter(parsed);
          }
        } else {
          Promise.resolve(handleCommand(parsed))
            .then((data) => emit({ id: parsed.id, type: "response", command: parsed.type, success: true, data }))
            .catch((err) => emit({ id: parsed.id, type: "response", command: parsed.type, success: false, error: err instanceof Error ? err.message : String(err) }));
        }
      } catch {}
    }
    nl = stdinBuf.indexOf("\n");
  }
});
// Warm Claude's catalog now so the model picker is populated before its first
// open; the picker reads it again through get_available_models either way.
if (driver === "claude") void ensureClaudeCatalog();

function shutdownBridge() {
  try {
    acpChild?.kill();
  } catch {}
  try {
    activeChild?.kill();
  } catch {}
}

// Report the cause before dying: the app's dead-agent screen surfaces this
// stderr tail, and the 128+signum code keeps a signal from reading as a clean exit.
for (const sig of ["SIGHUP", "SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    shutdownBridge();
    process.stderr.write(`external-agent[${process.pid}]: received ${sig}; shutting down\n`);
    process.exit(128 + { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }[sig]);
  });
}
process.stdin.on("end", () => {
  shutdownBridge();
  process.stderr.write(`external-agent[${process.pid}]: stdin closed; shutting down\n`);
  process.exit(0);
});
process.on("exit", shutdownBridge);
