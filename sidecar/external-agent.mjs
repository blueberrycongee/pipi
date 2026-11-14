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
  antigravity: { binary: "agy", fallbackBinaries: ["agy_acp_server"], args: ["acp", "--process-per-session"] },
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

function agentRuntimeEnv(extra = {}) {
  const envVar = config.customAgent?.envVar || BUILTIN_ENV_VARS[agentId];
  return childEnv({
    ...agentAuthEnv(agentId, envVar),
    ...extra,
  });
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

async function saveExternalSession() {
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
    firstMessage: firstText.slice(0, 240),
    model: currentModel,
    thinkingLevel,
    usageBaseline,
    context: { tokens: acpUsage?.used ?? contextTokens, window: acpUsage?.size || contextWindow },
    created: messages[0]?.timestamp || Date.now(),
    modified: Date.now(),
  };
  const lines = [JSON.stringify(header), ...messages.map((m) => JSON.stringify({ type: "message", message: m })), ...sessionUsageEntries.map((entry) => JSON.stringify(entry))];
  await fsp.writeFile(sessionFile, `${lines.join("\n")}\n`, "utf8");
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
  if (header?.driver === driver) {
    usageBaseline = header.usageBaseline && typeof header.usageBaseline === "object" ? header.usageBaseline : undefined;
    contextTokens = typeof header.context?.tokens === "number" ? header.context.tokens : undefined;
    contextWindow = typeof header.context?.window === "number" && header.context.window > 0 ? header.context.window : undefined;
  }
  clearStaleBackgroundTools(loadedMessages);
  messages = loadedMessages;
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
  for (const [, resolve] of pendingUiRequests) resolve(false);
  pendingUiRequests.clear();
  if (driver === "acp") {
    // Politely interrupt the in-flight prompt; an agent that ignores
    // `session/cancel` is dropped by settleActiveTurn's stall timeout
    // (dropAcpPeer), and the next turn re-attaches via session/load.
    if (acpStream || acpWakeActive) acpNotify("session/cancel", { sessionId: acpSessionId });
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
  // What the agent did on its own since its last answer goes on screen ahead of
  // this prompt — Antigravity would otherwise hand it over as this prompt's start.
  if (driver === "acp") await acpWakeBeforePrompt();
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
  const openTools = new Map();
  // What the engine reported for this turn: stamped on the turn's last
  // assistant message, the way Pi stamps each of its own.
  const usageParts = [];
  let sampled = false;
  let lastSample = undefined;
  let finished = false;
  // What this turn said and called, in full: what a replay of it is measured against (`acpWokenSince`).
  let saidText = "";
  let trailingThoughts = "";
  const calledTools = new Set();

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
    emitTurn({ type: "message_update", usage: zeroUsage, assistantMessageEvent: { type: "thinking_end", contentIndex: idx, content: thinkBuf } });
  };

  const closeText = () => {
    if (textIdx === undefined) return;
    const idx = textIdx;
    textIdx = undefined;
    blocks.push({ type: "text", text: textBuf });
    emitTurn({ type: "message_update", usage: zeroUsage, assistantMessageEvent: { type: "text_end", contentIndex: idx, content: textBuf } });
  };

  return {
    get textBuf() {
      return textBuf;
    },
    get thinkBuf() {
      return thinkBuf;
    },
    get hasBlocks() {
      return blocks.length > 0;
    },
    /** Tokens or cost the engine reported for this turn. After the answer, it is the session's all the same. */
    usage(part) {
      if (!part || isBlank(part)) return;
      if (!finished) usageParts.push(part);
      else if (sessionEpoch === turnEpoch) recordUsageEntry(toUsage([part]), "late");
    },
    /** One model request, from an engine that reports each as it happens; a repeat is dropped. */
    usageSample(sample) {
      if (!sample || sample.sig === lastSample) return;
      lastSample = sample.sig;
      sampled = true;
      this.usage(sample);
    },
    /** The turn's usage as the engine sums it up — unless its requests were already counted one by one. */
    usageSummary(part) {
      if (!sampled) this.usage(part);
    },
    thinkDelta(delta) {
      if (!delta) return;
      openMsg();
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
    toolStart(id, rawName, args) {
      if (openTools.has(id)) return;
      openMsg();
      closeThink();
      closeText();
      trailingThoughts = "";
      const idx = nextIdx++;
      const name = normalizeToolName(rawName);
      const tc = { type: "toolCall", id, name, arguments: args || {} };
      blocks.push(tc);
      calledTools.add(id);
      openTools.set(id, { name, startedAt: Date.now() });
      emitTurn({ type: "message_update", usage: zeroUsage, assistantMessageEvent: { type: "toolcall_start", contentIndex: idx, id, toolName: name } });
      emitTurn({ type: "message_update", usage: zeroUsage, assistantMessageEvent: { type: "toolcall_end", contentIndex: idx, toolCall: tc } });
      emitTurn({ type: "tool_execution_start", toolCallId: id, toolName: name, args: args || {} });
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
     * Ends the assistant message so far without ending the turn, and forgets it
     * as this turn's: Antigravity sends a turn it ran on its own while idle
     * ahead of the next prompt's echo — that is the turn before, not this one.
     */
    split() {
      if (msgOpen) {
        closeThink();
        closeText();
        const assistantMsg = {
          role: "assistant",
          content: blocks.splice(0),
          provider: currentModel.provider,
          model: currentModel.id,
          usage: zeroUsage,
          stopReason: "stop",
          ...(startTurn ? { turnStart: true } : {}),
          timestamp: Date.now(),
        };
        if (sessionEpoch === turnEpoch) messages.push(assistantMsg);
        emitTurn({ type: "message_end", message: assistantMsg });
        msgOpen = false;
        nextIdx = 0;
        startTurn = true;
      }
      saidText = "";
      trailingThoughts = "";
      calledTools.clear();
    },
    finish(stopReason = "stop", errorMessage = undefined, { keepOpenTools = false } = {}) {
      closeThink();
      closeText();
      const usage = toUsage(usageParts.splice(0));
      finished = true;
      const counted = sessionEpoch === turnEpoch;
      if (msgOpen || errorMessage) {
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
let acpOutBuf = "";
let acpErrBuf = "";
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
const acpRecentTools = new Map(); // toolCallId → {title, kind, rawInput} for permission enrichment

// ── Turns an agent runs on its own between prompts (Antigravity) ────────────
//
// An Antigravity turn can end on "waiting for" a background task or subagent.
// When that finishes, agy wakes the agent and runs the rest of the work at once
// — but sends none of it over ACP until the next `session/prompt`, where it
// arrives ahead of that prompt's `user_message_chunk` echo (agy 1.5.9, with or
// without `--process-per-session`). Left alone, the reader sees a turn that
// stopped on "Waiting for …", and the next message they send opens with all of
// it. Two things agy does do: `session/list` moves the session's `updatedAt`
// when the woken turn runs, and `session/load` on the live peer replays the
// whole conversation, the woken turn included, and drops what it was holding.
// So between prompts the bridge watches the list (`acpWakePoll`) and, when the
// session moves, replays it and brings in what is new as a turn of its own
// (`acpCatchUp`) — before the next prompt, too (`acpWakeBeforePrompt`). What
// still slips through ahead of an echo ends as its own message (`split`).
let acpLazyWake = false; // the peer holds woken turns back until a prompt (Antigravity)
// The watch after a turn: {epoch, acpId, text, toolIds, baseline, baselineStep, armedAt, timer}.
// `text`/`toolIds` are what the turn since the last prompt is known to have said
// and called — what a replay of it is measured against.
let acpWake = undefined;
let acpWakeRun = undefined; // a catch-up in flight: a prompt waits for it to land
let acpWakeActive = false; // a live multi-step wake run is actively streaming
let acpWakeSleepWake = undefined; // resolves the live wake loop's sleep immediately on abort/steer
let acpReplay = undefined; // collects the replayed conversation during a catch-up's `session/load`
// Calls a turn left running (background tasks), by id → {name, startedAt}: a
// later turn, or a replay, says when they end — wherever in the conversation.
const acpBackgroundTools = new Map();
const ACP_WAKE_BG_MS = 1_000;
const ACP_WAKE_FAST_MS = 2_000;
const ACP_WAKE_SLOW_MS = 10_000;
const ACP_WAKE_FAST_FOR_MS = 2 * 60_000;
// With no call left running, a subagent's report or a timer can still wake it for a while.
const ACP_WAKE_WATCH_MS = 30 * 60_000;
const ACP_WAKE_SETTLE_MS = 280;
const ACP_WAKE_BG_SETTLE_MS = 700;
const ACP_WAKE_STREAM_POLL_MS = 450;
const ACP_WAKE_STEP_WAIT_MS = 12_000;
const ACP_WAKE_TX_WAIT_MS = 90_000;
const ACP_WAKE_TOOL_WAIT_MS = 15 * 60_000;
const ACP_CONTENT_UPDATES = new Set(["user_message_chunk", "agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update"]);
const isFinalToolStatus = (status) => status === "completed" || status === "failed";

/**
 * Reads Antigravity's local per-conversation `transcript.jsonl` tail when present
 * (`~/.gemini/antigravity-cli/brain/<acpId>/.system_generated/logs/transcript.jsonl`),
 * giving sub-second ground truth on whether a reactive wake turn is still mid-step
 * (`"working"`) or has finished its final planner response (`"settled"`), even when
 * two steps share the same 1-second RFC3339 `updatedAt` timestamp. Returns `undefined`
 * when no local transcript file exists (custom data dir, remote peer, or tests).
 */
function agyTranscriptState(acpId) {
  if (!acpLazyWake || !acpId || !/^[A-Za-z0-9_-]+$/.test(acpId)) return undefined;
  const root = process.env.ANTIGRAVITY_CLI_HOME
    ? path.resolve(process.env.ANTIGRAVITY_CLI_HOME)
    : path.join(os.homedir(), ".gemini", "antigravity-cli");
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

function clearStaleBackgroundTools(list = messages, onlyId = undefined) {
  for (const msg of list) {
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block?.type === "toolCall" && block.background && (onlyId === undefined || block.id === onlyId)) {
        delete block.background;
      }
    }
  }
}

function forgetAcpWake() {
  if (acpWake?.timer) clearTimeout(acpWake.timer);
  acpWake = undefined;
  acpWakeSleepWake?.();
  acpBackgroundTools.clear();
  clearStaleBackgroundTools();
}

/** Starts watching the session after a turn that ended well (`stream` is that turn's). */
function armAcpWake(stream, acpId, epoch) {
  if (acpWake?.timer) clearTimeout(acpWake.timer);
  acpWake = undefined;
  if (!acpLazyWake || sessionEpoch !== epoch) return;
  const seen = stream.seen();
  for (const [id, info] of seen.open) acpBackgroundTools.set(String(id), info);
  const tx = agyTranscriptState(acpId);
  const watch = {
    epoch,
    acpId,
    text: seen.text,
    toolIds: new Set(seen.toolIds.map(String)),
    trailingThoughts: seen.trailingThoughts || "",
    baseline: undefined,
    baselineStep: tx?.stepIndex,
    armedAt: Date.now(),
    timer: undefined,
  };
  acpWake = watch;
  // Read where the session stands now, as close to the answer as can be: a move past it is a wake.
  void acpUpdatedAt(acpId).then((at) => {
    if (acpWake === watch && watch.baseline === undefined) watch.baseline = at;
  });
  scheduleAcpWakePoll(watch);
}

function scheduleAcpWakePoll(watch) {
  if (acpWake !== watch) return;
  if (watch.timer) clearTimeout(watch.timer);
  const age = Date.now() - watch.armedAt;
  if (age > ACP_WAKE_WATCH_MS && acpBackgroundTools.size === 0) {
    acpWake = undefined;
    return;
  }
  const delay = acpBackgroundTools.size > 0 ? ACP_WAKE_BG_MS : age < ACP_WAKE_FAST_FOR_MS ? ACP_WAKE_FAST_MS : ACP_WAKE_SLOW_MS;
  watch.timer = setTimeout(() => void acpWakePoll(watch), delay);
  watch.timer.unref?.();
}

const acpWakeStale = (watch) => acpWake !== watch || sessionEpoch !== watch.epoch || !acpChild || acpSessionId !== watch.acpId || acpReset;

function acpHasMoved(watch, at, tx) {
  if (tx && watch.baselineStep !== undefined && tx.stepIndex > watch.baselineStep) return true;
  if (tx?.state === "working") return true;
  return watch.baseline !== undefined && at !== undefined && at !== watch.baseline;
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

async function acpWakePoll(watch) {
  if (acpWake !== watch) return;
  watch.timer = undefined;
  if (acpWakeStale(watch)) {
    if (acpWake === watch) acpWake = undefined;
    return;
  }
  // A turn, a catch-up, or a handshake is the agent's business now: look again later.
  if (!isStreaming && !acpWakeRun && !sessionChange && !acpEnsurePromise) {
    const tx = agyTranscriptState(watch.acpId);
    const at = await acpUpdatedAt(watch.acpId);
    if (acpWake !== watch) return;
    if (watch.baseline === undefined) watch.baseline = at;
    if (watch.baselineStep === undefined && tx) watch.baselineStep = tx.stepIndex;
    if (!isStreaming && acpHasMoved(watch, at, tx)) await acpCatchUp();
  }
  scheduleAcpWakePoll(watch);
}

/** Before a prompt: a session that moved since its last answer is caught up first. */
async function acpWakeBeforePrompt() {
  if (acpWakeRun) await acpWakeRun.catch(() => undefined);
  const watch = acpWake;
  if (!watch || acpWakeStale(watch)) return;
  const tx = agyTranscriptState(watch.acpId);
  if (watch.baseline === undefined && !tx) return;
  const at = await acpUpdatedAt(watch.acpId, 2_000);
  if (acpWake === watch && acpHasMoved(watch, at, tx)) await acpCatchUp();
}

function acpCatchUp() {
  if (!acpWakeRun) {
    acpWakeRun = catchUpAcpWake()
      .catch(() => undefined)
      .finally(() => {
        acpWakeRun = undefined;
      });
  }
  return acpWakeRun;
}

async function loadWakeSlice(watch, epoch, pushConfig = false) {
  if (acpWakeStale(watch) || sessionEpoch !== epoch) return undefined;
  const replay = [];
  acpReplay = replay;
  let sess;
  try {
    sess = await acpRequest("session/load", { sessionId: watch.acpId, cwd, mcpServers: acpMcpServers() }, 30_000);
  } catch {
    if (acpWake === watch) forgetAcpWake();
    return undefined;
  } finally {
    if (acpReplay === replay) acpReplay = undefined;
  }
  if (sessionEpoch !== epoch || acpWake !== watch) return undefined;
  const woke = acpWokenSince(replay, watch);
  adoptSessionInfo(sess);
  if (pushConfig) {
    await pushAcpModel();
    await pushAcpMode();
    await pushAcpEffort();
  }
  return woke;
}

function applyAcpWokeSlice(woke, stream, watch, wakeOpenTools = undefined) {
  let hasAnswerText = undefined;
  for (const u of woke.ended) {
    const id = String(u.toolCallId);
    const known = wakeOpenTools?.get(id) || acpBackgroundTools.get(id);
    stream.toolEnd(id, formatAcpToolContent(u.content, u.rawOutput), u.status === "failed", known);
    wakeOpenTools?.delete(id);
    acpBackgroundTools.delete(id);
    hasAnswerText = false;
  }
  for (const item of woke.items) {
    if (item.kind === "thinking") {
      stream.thinkDelta(item.text);
      watch.trailingThoughts = `${watch.trailingThoughts || ""}${item.text}`;
    } else if (item.kind === "text") {
      stream.textDelta(item.text);
      watch.text += item.text;
      watch.trailingThoughts = "";
      hasAnswerText = true;
    } else {
      const u = item.update;
      const name = u.title || u.kind || "tool";
      stream.toolStart(item.id, name, acpToolArgs(u));
      watch.toolIds.add(item.id);
      watch.trailingThoughts = "";
      hasAnswerText = false;
      if (isFinalToolStatus(u.status)) {
        stream.toolEnd(item.id, formatAcpToolContent(u.content, u.rawOutput), u.status === "failed");
      } else {
        const info = { name: normalizeToolName(name), startedAt: Date.now() };
        wakeOpenTools?.set(item.id, info);
        acpBackgroundTools.set(item.id, info);
      }
    }
  }
  return hasAnswerText;
}

async function catchUpAcpWake() {
  const watch = acpWake;
  if (!watch || acpWakeStale(watch)) return;
  const epoch = sessionEpoch;
  const woke = await loadWakeSlice(watch, epoch, true);
  if (!woke || sessionEpoch !== epoch || acpWake !== watch) return;
  const tx = agyTranscriptState(watch.acpId);
  const at = await acpUpdatedAt(watch.acpId);
  if (acpWake !== watch || sessionEpoch !== epoch) return;

  if (!woke.items.length && !woke.ended.length) {
    if (tx?.state !== "working") {
      if (at !== undefined) watch.baseline = at;
      if (tx) watch.baselineStep = tx.stepIndex;
    }
    return;
  }

  // When called synchronously inside `acpWakeBeforePrompt` (`isStreaming` is already owned
  // by `runTurnLoop`), flush the pre-prompt wake as a single finished turn and hand control
  // right back to the outgoing prompt.
  if (isStreaming) {
    emitAcpWakeSnapshot(woke, watch, epoch);
    if (at !== undefined) watch.baseline = at;
    if (tx) watch.baselineStep = tx.stepIndex;
    return;
  }

  // Otherwise we caught an autonomous wake while idle: keep ONE continuous live run open
  // (`isStreaming = true`) across all tool calls, thoughts, and answers until the wake settles,
  // so the sidebar, stop button, and daemon status stay `"working"` and steps never fragment
  // into separate `turnStart` headers.
  await runLiveAcpWake(woke, at, tx, watch, epoch);
}

/** Emits a completed wake snapshot ahead of an outgoing prompt (`isStreaming` stays owned by caller). */
function emitAcpWakeSnapshot(woke, watch, epoch) {
  const emitTurn = (record) => {
    if (sessionEpoch === epoch) emit(record);
  };
  emitTurn({ type: "agent_start" });
  emitTurn({ type: "turn_start" });
  const stream = makeTurnStreamHelper(epoch, { turnStart: true });
  applyAcpWokeSlice(woke, stream, watch);
  stream.finish("stop", undefined, { keepOpenTools: true });
  emitTurn({ type: "agent_end", willRetry: false });
  emitTurn({ type: "agent_settled", aborted: false });
  if (sessionEpoch === epoch) void saveExternalSession().catch(() => undefined);
}

/** Streams a live multi-step reactive wake as a single active run until settled or interrupted. */
async function runLiveAcpWake(firstWoke, initialAt, initialTx, watch, epoch) {
  isStreaming = true;
  abortRequested = false;
  acpWakeActive = true;
  const emitTurn = (record) => {
    if (sessionEpoch === epoch) emit(record);
  };

  let drainNext = undefined;
  const run = (async () => {
    const wakeOpenTools = new Map();
    let hasAnswerText = false;
    let lastAt = initialAt;
    let lastStep = initialTx?.stepIndex;
    let lastActivityAt = Date.now();
    let lastLoadAt = Date.now();

    const sub = (async () => {
      emitTurn({ type: "agent_start" });
      emitTurn({ type: "turn_start" });
      const stream = makeTurnStreamHelper(epoch, { turnStart: true });
      const firstText = applyAcpWokeSlice(firstWoke, stream, watch, wakeOpenTools);
      if (firstText !== undefined) hasAnswerText = firstText;

      while (!abortRequested && sessionEpoch === epoch && !acpWakeStale(watch)) {
        // When prose text has landed after all wake tools finished, pause briefly and verify
        // via one final `session/load` so same-second RFC3339 chunks are never missed while
        // fast single-step wakes still settle in ~280ms.
        if (hasAnswerText && wakeOpenTools.size === 0) {
          await acpWakeSleep(ACP_WAKE_SETTLE_MS);
          if (abortRequested || sessionEpoch !== epoch || acpWakeStale(watch)) break;
          const verify = await loadWakeSlice(watch, epoch, false);
          lastLoadAt = Date.now();
          if (!verify) break;
          if (verify.items.length || verify.ended.length) {
            const nextText = applyAcpWokeSlice(verify, stream, watch, wakeOpenTools);
            if (nextText !== undefined) hasAnswerText = nextText;
            lastActivityAt = Date.now();
            lastAt = await acpUpdatedAt(watch.acpId);
            lastStep = agyTranscriptState(watch.acpId)?.stepIndex ?? lastStep;
            continue;
          }
          const txNow = agyTranscriptState(watch.acpId);
          if (txNow?.state !== "working") break;
        }

        // If the wake turn itself started a new background tool and already wrote its "Waiting for…"
        // prose, verify once after a short beat and settle with `keepOpenTools: true`.
        if (hasAnswerText && wakeOpenTools.size > 0) {
          await acpWakeSleep(ACP_WAKE_BG_SETTLE_MS);
          if (abortRequested || sessionEpoch !== epoch || acpWakeStale(watch)) break;
          const verify = await loadWakeSlice(watch, epoch, false);
          lastLoadAt = Date.now();
          if (!verify) break;
          if (verify.items.length || verify.ended.length) {
            const nextText = applyAcpWokeSlice(verify, stream, watch, wakeOpenTools);
            if (nextText !== undefined) hasAnswerText = nextText;
            lastActivityAt = Date.now();
            continue;
          }
          const txNow = agyTranscriptState(watch.acpId);
          if (txNow?.state !== "working") break;
        }

        // Mid-turn (`!hasAnswerText`): a tool is running or the model is planning the next step.
        await acpWakeSleep(ACP_WAKE_STREAM_POLL_MS);
        if (abortRequested || sessionEpoch !== epoch || acpWakeStale(watch)) break;

        const txNow = agyTranscriptState(watch.acpId);
        const atNow = await acpUpdatedAt(watch.acpId);
        if (abortRequested || sessionEpoch !== epoch || acpWakeStale(watch)) break;

        const moved =
          (atNow !== undefined && atNow !== lastAt) ||
          (txNow !== undefined && txNow.stepIndex !== lastStep) ||
          Date.now() - lastLoadAt >= 1_200;

        if (moved || txNow?.state === "settled") {
          const nextWoke = await loadWakeSlice(watch, epoch, false);
          lastLoadAt = Date.now();
          lastAt = atNow ?? lastAt;
          lastStep = txNow?.stepIndex ?? lastStep;
          if (!nextWoke) break;
          if (nextWoke.items.length || nextWoke.ended.length) {
            const nextText = applyAcpWokeSlice(nextWoke, stream, watch, wakeOpenTools);
            if (nextText !== undefined) hasAnswerText = nextText;
            lastActivityAt = Date.now();
            continue;
          }
          if (txNow?.state === "settled" && wakeOpenTools.size === 0) break;
        }

        const idleMs = Date.now() - lastActivityAt;
        const limitMs =
          wakeOpenTools.size > 0
            ? ACP_WAKE_TOOL_WAIT_MS
            : txNow?.state === "working"
              ? ACP_WAKE_TX_WAIT_MS
              : ACP_WAKE_STEP_WAIT_MS;
        if (idleMs >= limitMs) break;
      }

      const wasSteer = steerInterrupt;
      const aborted = abortRequested && !wasSteer;
      stream.finish(aborted ? "aborted" : "stop", undefined, { keepOpenTools: !aborted });
      if (aborted) clearStaleBackgroundTools();
      emitTurn({ type: "agent_end", willRetry: false });
      if (sessionEpoch === epoch) await saveExternalSession().catch(() => undefined);
      await pushAcpModel();
      await pushAcpMode();
      await pushAcpEffort();
      const settledAt = await acpUpdatedAt(watch.acpId);
      const settledTx = agyTranscriptState(watch.acpId);
      if (acpWake === watch) {
        if (settledAt !== undefined) watch.baseline = settledAt;
        if (settledTx) watch.baselineStep = settledTx.stepIndex;
      }
    })();

    activeSubTurn = sub.finally(() => {
      if (activeSubTurn === sub) activeSubTurn = undefined;
    });
    try {
      await activeSubTurn;
    } finally {
      acpWakeActive = false;
    }

    const wasSteerInterrupt = steerInterrupt;
    const finalAborted = abortRequested && !wasSteerInterrupt;
    const mayDrain = !abortRequested || wasSteerInterrupt;
    steerInterrupt = false;
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
      emitTurn({ type: "agent_settled", aborted: finalAborted });
    }
  })();

  const wrapped = run
    .then(() => {
      if (drainNext && sessionEpoch === epoch) return runTurnLoop(drainNext.text, drainNext.images);
    })
    .finally(() => {
      if (turnPromise === wrapped) turnPromise = undefined;
    });
  turnPromise = wrapped;
  await wrapped;
}

/**
 * What a replay holds that the bridge has not shown: the calls left running
 * that it shows ended (anywhere in it), and what comes after everything the
 * turn since the last prompt is known to have said and called. Text is matched
 * by length, not letter by letter: agy replays a message whole where it
 * streamed it in pieces. Thoughts before that point are not compared (a replay
 * may word them anew) and are left out; thoughts already emitted right after
 * the last text/tool are deduplicated via `trailingThoughts`.
 */
function acpWokenSince(replay, known, running = acpBackgroundTools) {
  const ended = new Map();
  let start = 0;
  replay.forEach((u, at) => {
    const kind = u?.sessionUpdate;
    if (kind === "user_message_chunk") start = at + 1;
    if ((kind === "tool_call" || kind === "tool_call_update") && running.has(String(u.toolCallId)) && isFinalToolStatus(u.status)) {
      ended.set(String(u.toolCallId), u);
    }
  });
  const textOf = (c) => (typeof c === "string" ? c : c?.text || "");
  const items = [];
  const newTools = new Map(); // id → its item
  const seenTools = new Set();
  const knownThoughts = known.trailingThoughts || "";
  let said = 0;
  let skippedThoughts = 0;
  const past = () => said >= known.text.length && [...known.toolIds].every((id) => seenTools.has(id));
  for (const u of replay.slice(start)) {
    const kind = u?.sessionUpdate;
    if (kind === "agent_message_chunk") {
      const text = textOf(u.content);
      if (past()) {
        if (text) items.push({ kind: "text", text });
        continue;
      }
      const over = said + text.length - known.text.length;
      said += text.length;
      if (over > 0 && [...known.toolIds].every((id) => seenTools.has(id))) items.push({ kind: "text", text: text.slice(text.length - over) });
    } else if (kind === "agent_thought_chunk") {
      const text = textOf(u.content);
      if (!text || !past()) continue;
      if (skippedThoughts >= knownThoughts.length) {
        items.push({ kind: "thinking", text });
        continue;
      }
      const over = skippedThoughts + text.length - knownThoughts.length;
      skippedThoughts += text.length;
      if (over > 0) items.push({ kind: "thinking", text: text.slice(text.length - over) });
    } else if (kind === "tool_call" || kind === "tool_call_update") {
      const id = String(u.toolCallId ?? "");
      if (!id) continue;
      if (known.toolIds.has(id)) {
        seenTools.add(id);
        continue;
      }
      const item = newTools.get(id);
      if (item) {
        Object.assign(item.update, Object.fromEntries(Object.entries(u).filter(([, v]) => v !== undefined)));
      } else if (kind === "tool_call") {
        const fresh = { kind: "tool", id, update: { ...u } };
        newTools.set(id, fresh);
        items.push(fresh);
        ended.delete(id);
      }
    }
  }
  return { items, ended: [...ended.values()] };
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
        if (acpPending.delete(id)) reject(new Error(`${method} timed out`));
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
  if (runtimeMode === "full-access" || (runtimeMode === "auto-accept-edits" && isEditOnly)) {
    const allowOpt = pick("allow_once") || pick("allow") || opts[0];
    acpWrite({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "selected", optionId: allowOpt?.optionId || "allow" } } });
    return;
  }
  const uiId = `acp_perm_${msg.id}`;
  const confirmed = await new Promise((resolve) => {
    pendingUiRequests.set(uiId, resolve);
    emit({ type: "extension_ui_request", id: uiId, method: "confirm", title, message: JSON.stringify(rawInput ?? {}, null, 2).slice(0, 1200) });
  });
  const chosen = confirmed ? pick("allow_once") || pick("allow") || opts[0] : pick("reject_once") || pick("reject") || opts.at(-1);
  acpWrite({
    jsonrpc: "2.0",
    id: msg.id,
    result: { outcome: chosen ? { outcome: "selected", optionId: chosen.optionId } : { outcome: "cancelled" } },
  });
}

function handleAcpUpdate(u) {
  const kind = u.sessionUpdate || u.type;
  const textOf = (c) => (typeof c === "string" ? c : c?.text || "");
  // A catch-up's replay is read as a whole once the load answers (`acpWokenSince`).
  if (acpReplay && ACP_CONTENT_UPDATES.has(kind)) {
    acpReplay.push(u);
    return;
  }
  if (kind === "user_message_chunk") {
    // agy echoes the prompt as it takes it: what came before the echo is a turn it ran while idle.
    if (acpLazyWake) acpStream?.split();
  } else if (kind === "agent_thought_chunk") acpStream?.thinkDelta(textOf(u.content));
  else if (kind === "agent_message_chunk") acpStream?.textDelta(textOf(u.content));
  else if (kind === "tool_call") {
    const id = String(u.toolCallId ?? `t_${Date.now()}`);
    acpRecentTools.set(id, { title: u.title || u.kind || "tool", kind: u.kind, rawInput: u.rawInput });
    acpStream?.toolStart(id, u.title || u.kind || "tool", acpToolArgs(u));
  } else if (kind === "tool_call_update") {
    const known = u.toolCallId !== undefined ? acpRecentTools.get(String(u.toolCallId)) : undefined;
    if (known && (u.title || u.rawInput !== undefined)) {
      acpRecentTools.set(String(u.toolCallId), { title: u.title || known.title, kind: u.kind || known.kind, rawInput: u.rawInput !== undefined ? u.rawInput : known.rawInput });
    }
    if (isFinalToolStatus(u.status)) {
      const id = String(u.toolCallId);
      acpStream?.toolEnd(u.toolCallId, formatAcpToolContent(u.content, u.rawOutput), u.status === "failed", acpBackgroundTools.get(id));
      if (acpStream) acpBackgroundTools.delete(id);
    }
  } else if (kind === "usage_update") {
    acpUsage = { used: Number(u.used ?? 0), size: Number(u.size ?? 0) };
    acpStream?.usageSample(acpMetaSample(u._meta));
    // The session's running cost: what it grew by since the last reading. A session
    // resumed with nothing to measure against only sets the mark for the next one.
    const known = usageBaseline?.thread === acpSessionId ? usageBaseline : undefined;
    const cost = acpCostPart(u.cost, known);
    if (cost) {
      usageBaseline = { thread: acpSessionId, ...cost.total };
      // Between prompts there is no turn to put it on: it is the session's all the same.
      if (known && acpStream) acpStream.usage(cost.part);
      else if (known && !isBlank(cost.part)) recordUsageEntry(toUsage([cost.part]), "late");
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
              if (msg.error) waiter.reject(new Error(msg.error.message || "ACP error"));
              else waiter.resolve(msg.result);
            }
          } else if (msg.method === "session/update" && msg.params?.update) {
            handleAcpUpdate(msg.params.update);
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
    forgetAcpWake();
    if (activeChild === child) activeChild = undefined;
    const detail = cause instanceof Error ? cause.message : signal ? `killed with ${signal}` : `code ${cause}`;
    const stderr = acpStderrTail();
    const message = `ACP agent exited (${detail})${stderr ? `:\n${stderr}` : ""}`;
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
}

let acpCatalogCooldownUntil = 0;
const ACP_DISCOVERY_WAIT_MS = agentId === "antigravity" ? 8000 : 3500;

function dropAcpPeer(reason = "ACP agent reset") {
  const child = acpChild;
  acpChild = undefined;
  acpSessionId = undefined;
  acpStream = undefined;
  forgetAcpWake();
  if (activeChild === child) activeChild = undefined;
  const stderr = acpStderrTail();
  const detail = stderr ? `${reason}:\n${stderr}` : reason;
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
      init = await acpRequest(
        "initialize",
        { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "pipi", version: "0.1.0" } },
        30_000,
      );
    } catch (err) {
      dropAcpPeer("ACP initialize failed");
      throw err;
    }
    acpLoadSession = !!init?.agentCapabilities?.loadSession;
    acpSessionCaps = init?.agentCapabilities?.sessionCapabilities || undefined;
    // Antigravity holds a turn it runs while idle back until the next prompt; a
    // live `session/load` and `session/list` are what bring it in sooner.
    acpLazyWake = (agentId === "antigravity" || /antigravity/i.test(String(init?.agentInfo?.name || ""))) && acpLoadSession && acpSessionCaps?.list !== undefined;
    acpModes = undefined;
    acpModelConfigId = undefined;
    acpModeConfigId = undefined;
    acpSpecModels = false;
    acpReset = true;
  }
  if (acpReset || !acpSessionId) {
    // Release the previous session on this peer when the agent supports it —
    // DeepSeek Harness keeps every session resident until `session/close`.
    if (acpReset && acpSessionId && acpSessionCaps?.close !== undefined) {
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
    forgetAcpWake();
    const mcpServers = acpMcpServers();
    const stale = () => sessionEpoch !== epoch;
    try {
      let sess;
      if (nativeThreadId) {
        // ACP v1 `session/resume` (sessionCapabilities.resume) for DeepSeek Harness and
        // newer agents; the older `loadSession`/`session/load` draft for Devin & co.
        if (acpSessionCaps?.resume !== undefined) {
          sess = await acpRequest("session/resume", { sessionId: nativeThreadId, cwd, mcpServers }, 30_000).catch(() => undefined);
        } else if (acpLoadSession) {
          sess = await acpRequest("session/load", { sessionId: nativeThreadId, cwd, mcpServers }, 30_000).catch(() => undefined);
        }
      }
      let begun = false;
      if (!sess && !stale()) {
        sess = await acpRequest("session/new", { cwd, mcpServers }, 30_000);
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

// ACP (Agent Client Protocol) JSON-RPC 2.0 over stdio — one prompt per call on
// the persistent session; peer lifetime managed by ensureAcp/spawnAcp above.
async function runAcpTurn(bin, promptText, images = [], turnEpoch = sessionEpoch) {
  const acpId = await ensureAcp(bin);
  // `session/cancel` only applies to a prompt already in flight — one sent
  // after the cancel starts fresh, so a turn aborted during negotiation must
  // never reach session/prompt.
  if (sessionEpoch !== turnEpoch || abortRequested) return;
  const stream = makeTurnStreamHelper(turnEpoch);
  acpStream = stream;
  try {
    const res = await acpRequest("session/prompt", { sessionId: acpId, prompt: [{ type: "text", text: promptText }, ...images] }, 0);
    const stopReason = abortRequested ? "aborted" : ACP_STOP_REASONS[res?.stopReason] || "stop";
    const mayWake = acpLazyWake && !abortRequested && res?.stopReason === "end_turn";
    stream.usageSummary(acpPromptPart(res?.usage));
    stream.finish(stopReason, undefined, { keepOpenTools: mayWake });
    // The answer may be "waiting for" work still going on: watch for the agent to wake.
    if (mayWake) armAcpWake(stream, acpId, turnEpoch);
  } catch (err) {
    stream.finish(abortRequested ? "aborted" : "error", !abortRequested ? (err instanceof Error ? err.message : String(err)) || acpStderrTail() : undefined);
  } finally {
    if (acpStream === stream) acpStream = undefined;
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
 * Runs a session-changing command without waiting on the engine: the turn is
 * interrupted, a handshake in flight is left stale (`ensureAcpSession` runs it
 * again for the new session), and one still stalled after a brief window has
 * its peer dropped in the background so it never holds up the next prompt.
 */
async function changeSession(apply) {
  sessionEpoch++;
  const changedAt = sessionEpoch;
  queuedSteering = [];
  queuedFollowUp = [];
  steerInterrupt = false;
  acpReset = true;
  let done;
  const mine = new Promise((resolve) => {
    done = resolve;
  });
  sessionChange = mine;
  try {
    if (acpRoundEpoch !== undefined) {
      const timer = setTimeout(() => {
        if (acpRoundEpoch !== undefined && acpRoundEpoch < changedAt) dropAcpPeer("ACP negotiation cancelled for session change");
      }, 1500);
      timer.unref?.();
    }
    acpCatalogCooldownUntil = 0;
    await settleActiveTurn(2500);
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
    case "get_messages":
      return { messages };
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
        costReported: sessionUsage.priced || total === 0,
        contextUsage: {
          tokens: used,
          contextWindow: win,
          percent: win && used !== null ? Math.min(100, (used / win) * 100) : null,
        },
      };
    }
    case "prompt": {
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
        // The clone starts a fresh native thread: the engine's context is the
        // next prompt alone, so the last fill no longer stands for it.
        contextTokens = undefined;
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
      return undefined;
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
            waiter(!!parsed.confirmed);
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
