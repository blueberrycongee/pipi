import * as fs from "fs/promises";
import { batch, computed, signal, untracked, type Signal } from "nsh";
import { runtimeModeRank } from "../agents/catalog";
import type { AgentHarnessStatus, RuntimeMode } from "../agents/types";
import { composeDocMessage, plainMarkdown } from "../lib/doc-wire";
import { basename } from "../lib/format";
import { activeLanguage, tr } from "../lib/i18n";
import { classifyMediaKind, composeFileMessage, mimeTypeForPath, type FileAttachment } from "../lib/media";
import type { ComposerCommand } from "../lib/slash";
import { markPacersSeeded } from "../lib/stream-pacer";
import { markVeilsSeeded } from "../lib/veil";
import type { Mood } from "../mascot/geometry";
import { PiClient } from "../pi/client";
import type {
  AgentMessage,
  ExtensionUiAnswer,
  ExtensionUiDialog,
  ImageContent,
  Model,
  SessionEvent,
  SessionState,
  SessionStats,
  SlashCommand,
  ThinkingLevel,
} from "../pi/protocol";
import { sessionTitle } from "../pi/sessions";
import { Transcript, type Row } from "../pi/transcript";
import { displayRowIds } from "../pi/turns";
import { markRowsSeen } from "../ui/motion";
import {
  activeAgent,
  activeAgentId,
  activeProjectPath,
  attachInlineSession,
  availableAgents,
  availableModels as appAvailableModels,
  cacheAgentModels,
  cacheAgentThinkingLevels,
  cachedModelsForAgent,
  cachedThinkingLevelsForAgent,
  currentRuntimeCeiling,
  daemonSessionByFile,
  daemonSessionOfId,
  daemonSessionTitle,
  docRefText,
  draftModel,
  draftThinkingLevel,
  findKnownSessionSummary,
  onStoreTeardown,
  registerInlineDaemon,
  runtimeMode as appRuntimeMode,
  sessionState,
  setInlineDaemonRuntimeMode,
  thinkingLevels as appThinkingLevels,
  toast,
  unregisterInlineDaemon,
  workspacePath,
  type Attachment,
  type DocRef,
} from "./app";
import { backend, NoPickerError } from "./backend";
import { docAt, docTabTitle, docText, flushDoc } from "./docs";
import { sendMode, storedSessionChoice } from "./prefs";
import { isSplitOpen, type SplitTarget } from "./split";

const IMAGE_WIRE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_WIRE_IMAGE_BYTES = 20 * 1024 * 1024;

export type SplitChatActivity =
  | { kind: "idle" }
  | { kind: "thinking" }
  | { kind: "tool"; name: string; args: Record<string, unknown> }
  | { kind: "writing" }
  | { kind: "compacting" }
  | { kind: "retrying"; attempt: number; maxAttempts: number; reason: string };

export interface SplitChatController {
  key: string;
  title: () => string;
  cwd: () => string;
  rows: () => Row[];
  loading: () => boolean;
  running: () => boolean;
  runStartedAt: () => number;
  activity: () => SplitChatActivity;
  mood: () => Mood;
  draft: () => string;
  setDraft: (value: string) => void;
  attachments: () => Attachment[];
  addAttachment: (att: Attachment) => void;
  removeAttachment: (index: number) => void;
  files: () => FileAttachment[];
  attachLocalPath: (path: string) => Promise<boolean>;
  removeFileAttachment: (path: string) => void;
  pickFile: () => Promise<void>;
  docs: () => DocRef[];
  attachDocPath: (path: string) => Promise<void>;
  detachDoc: (path: string) => void;
  focusTick: () => number;
  requestFocus: () => void;
  slashCommands: () => ComposerCommand[];
  sessionStats: () => SessionStats | undefined;
  agent: () => AgentHarnessStatus;
  agentId: () => string;
  agentName: () => string;
  availableModels: () => Model[];
  currentModel: () => Model | undefined;
  thinkingLevels: () => ThinkingLevel[];
  thinkingLevel: () => ThinkingLevel;
  runtimeMode: () => RuntimeMode;
  daemonId: () => string | undefined;
  sessionFile: () => string | undefined;
  pendingDialog: () => ExtensionUiDialog | undefined;
  error: () => string | undefined;
  send: (modeOrText?: "steer" | "followUp", textOverride?: string) => Promise<void>;
  stop: () => Promise<void>;
  chooseAgent: (agentId: string) => Promise<void>;
  chooseModel: (model: Model) => Promise<void>;
  chooseThinkingLevel: (level: ThinkingLevel) => Promise<void>;
  chooseRuntimeMode: (mode: RuntimeMode) => Promise<void>;
  answerDialog: (id: string, answer: ExtensionUiAnswer) => void;
  dispose: () => void;
}

interface SplitChatInternal {
  key: string;
  transcript: Transcript;
  rows: Signal<Row[]>;
  loading: Signal<boolean>;
  running: Signal<boolean>;
  runStartedAt: Signal<number>;
  activity: Signal<SplitChatActivity>;
  cheer: Signal<boolean>;
  failedFlash: Signal<boolean>;
  draft: Signal<string>;
  attachments: Signal<Attachment[]>;
  files: Signal<FileAttachment[]>;
  docs: Signal<DocRef[]>;
  focusTick: Signal<number>;
  commands: Signal<SlashCommand[]>;
  stats: Signal<SessionStats | undefined>;
  title: Signal<string>;
  cwd: Signal<string>;
  selectedAgentId: Signal<string>;
  attachedAgentName: Signal<string | undefined>;
  models: Signal<Model[] | undefined>;
  model: Signal<Model | undefined>;
  thinkingLevels: Signal<ThinkingLevel[] | undefined>;
  thinkingLevel: Signal<ThinkingLevel | undefined>;
  runtimeMode: Signal<RuntimeMode | undefined>;
  daemonId: Signal<string | undefined>;
  sessionFile: Signal<string | undefined>;
  dialogs: Signal<ExtensionUiDialog[]>;
  error: Signal<string | undefined>;
  client: PiClient | undefined;
  connectingPromise: Promise<PiClient | undefined> | undefined;
  flushFrame: number | undefined;
  cheerTimer: ReturnType<typeof setTimeout> | undefined;
  errorTimer: ReturnType<typeof setTimeout> | undefined;
  gen: number;
  disposed: boolean;
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

function resolveAgent(id: string): AgentHarnessStatus {
  return availableAgents().find((a) => a.id === id) ?? activeAgent();
}

function clampModeForAgent(mode: RuntimeMode, agent: AgentHarnessStatus): RuntimeMode {
  const ceiling = currentRuntimeCeiling();
  let effective = runtimeModeRank(mode) > runtimeModeRank(ceiling) ? ceiling : mode;
  const supported = agent.supportedRuntimeModes;
  if (supported.length > 0 && !supported.includes(effective)) {
    const allowed = supported.filter((m) => runtimeModeRank(m) <= runtimeModeRank(ceiling));
    effective = allowed.at(-1) ?? supported[0] ?? effective;
  }
  return effective;
}

function isPlaceholderCatalog(list: readonly Model[]): boolean {
  return list.length === 0 || (list.length === 1 && list[0]!.id === "default" && !list[0]!.reasoning);
}

function endedInError(rows: readonly Row[]) {
  const last = rows.at(-1);
  return last?.kind === "notice" && last.tone === "error";
}

function stopTimers(s: SplitChatInternal) {
  if (s.flushFrame !== undefined) {
    cancelAnimationFrame(s.flushFrame);
    s.flushFrame = undefined;
  }
  if (s.cheerTimer !== undefined) {
    clearTimeout(s.cheerTimer);
    s.cheerTimer = undefined;
  }
  if (s.errorTimer !== undefined) {
    clearTimeout(s.errorTimer);
    s.errorTimer = undefined;
  }
}

function flushNow(s: SplitChatInternal) {
  if (s.flushFrame !== undefined) {
    cancelAnimationFrame(s.flushFrame);
    s.flushFrame = undefined;
  }
  const next = s.transcript.rows();
  if (next !== untracked(s.rows)) s.rows.set(next);
}

function flushSoon(s: SplitChatInternal) {
  if (s.flushFrame !== undefined) return;
  s.flushFrame = requestAnimationFrame(() => {
    s.flushFrame = undefined;
    const next = s.transcript.rows();
    if (next !== untracked(s.rows)) s.rows.set(next);
  });
}

function triggerCheer(s: SplitChatInternal) {
  if (s.cheerTimer !== undefined) clearTimeout(s.cheerTimer);
  s.cheer.set(true);
  s.cheerTimer = setTimeout(() => {
    s.cheerTimer = undefined;
    s.cheer.set(false);
  }, 1100);
}

function triggerErrorFlash(s: SplitChatInternal) {
  if (s.errorTimer !== undefined) clearTimeout(s.errorTimer);
  s.failedFlash.set(true);
  s.errorTimer = setTimeout(() => {
    s.errorTimer = undefined;
    s.failedFlash.set(false);
  }, 1400);
}

function detachClient(s: SplitChatInternal) {
  const prevId = untracked(s.daemonId);
  if (prevId) unregisterInlineDaemon(prevId);
  const c = s.client;
  s.client = undefined;
  s.connectingPromise = undefined;
  if (c) c.close(0);
}

async function syncCatalogFromClient(
  s: SplitChatInternal,
  client: PiClient,
  agentId: string,
  mine: number,
  options: { applyPreferences: boolean; preferredModel?: { provider: string; id: string }; preferredThinking?: ThinkingLevel },
) {
  const [st, modelsRes, levelsRes, commandsRes, statsRes] = await Promise.all([
    client.request("get_state").catch(() => undefined) as Promise<SessionState | undefined>,
    client.request("get_available_models").catch(() => undefined),
    client.request("get_available_thinking_levels").catch(() => undefined),
    client.request("get_commands").catch(() => undefined),
    client.request("get_session_stats").catch(() => undefined),
  ]);
  if (s.disposed || s.gen !== mine || client !== s.client) return;

  const list = modelsRes?.models ?? [];
  let levels: ThinkingLevel[] = levelsRes?.levels?.length ? levelsRes.levels : ["off"];
  if (list.length > 0) cacheAgentModels(agentId, list);
  cacheAgentThinkingLevels(agentId, levels);
  if (commandsRes?.commands) s.commands.set(commandsRes.commands);
  if (statsRes) s.stats.set(statsRes);

  let currentModel = st?.model;
  let currentThinking: ThinkingLevel | undefined = st?.thinkingLevel;

  if (options.applyPreferences) {
    if (options.preferredModel) {
      const found =
        list.find((m) => m.id === options.preferredModel!.id && m.provider === options.preferredModel!.provider) ??
        list.find((m) => m.id === options.preferredModel!.id);
      if (found && (currentModel?.id !== found.id || currentModel?.provider !== found.provider)) {
        const chosen = await client
          .request("set_model", { provider: found.provider, modelId: found.id })
          .catch(() => undefined);
        if (s.disposed || s.gen !== mine || client !== s.client) return;
        if (chosen) {
          currentModel = chosen;
          const [refreshedLevels, refreshedState] = await Promise.all([
            client.request("get_available_thinking_levels").catch(() => undefined),
            client.request("get_state").catch(() => undefined),
          ]);
          if (s.disposed || s.gen !== mine || client !== s.client) return;
          if (refreshedLevels?.levels?.length) {
            levels = refreshedLevels.levels;
            cacheAgentThinkingLevels(agentId, levels);
          }
          if (refreshedState?.thinkingLevel) currentThinking = refreshedState.thinkingLevel;
        }
      }
    }
    if (options.preferredThinking && levels.includes(options.preferredThinking) && currentThinking !== options.preferredThinking) {
      const ok = await client
        .request("set_thinking_level", { level: options.preferredThinking })
        .then(() => true)
        .catch(() => false);
      if (s.disposed || s.gen !== mine || client !== s.client) return;
      if (ok) currentThinking = options.preferredThinking;
    }
  }

  batch(() => {
    if (st?.sessionFile) s.sessionFile.set(st.sessionFile);
    if (st?.sessionName) s.title.set(st.sessionName);
    if (st?.isStreaming) {
      s.running.set(true);
      if (!untracked(s.runStartedAt)) s.runStartedAt.set(Date.now());
      if (untracked(s.activity).kind === "idle") s.activity.set({ kind: "thinking" });
    }
    s.models.set(list);
    s.thinkingLevels.set(levels);
    if (currentModel && currentModel.provider !== "unknown") s.model.set(currentModel);
    else if (list.length === 0) s.model.set(undefined);
    if (currentThinking) s.thinkingLevel.set(currentThinking);
    else if (!currentModel?.reasoning) s.thinkingLevel.set("off");
  });
}

function handleEvent(s: SplitChatInternal, source: PiClient, event: SessionEvent) {
  if (s.disposed || source !== s.client) return;
  if (event.type === "models_changed") {
    const mine = s.gen;
    const agentId = untracked(s.selectedAgentId);
    const idleEmpty = !untracked(s.running) && untracked(s.rows).length === 0;
    const choice = storedSessionChoice(agentId);
    void syncCatalogFromClient(s, source, agentId, mine, {
      applyPreferences: idleEmpty,
      preferredModel: choice?.model,
      preferredThinking: choice?.thinkingLevel,
    });
    return;
  }
  if (event.type === "thinking_level_changed") {
    s.thinkingLevel.set(event.level);
    return;
  }

  s.transcript.apply(event);

  switch (event.type) {
    case "agent_start":
      batch(() => {
        s.loading.set(false);
        if (!untracked(s.running)) s.runStartedAt.set(Date.now());
        s.running.set(true);
        s.activity.set({ kind: "thinking" });
      });
      flushNow(s);
      return;
    case "message_start":
      flushNow(s);
      return;
    case "message_update": {
      const kind = event.assistantMessageEvent?.type;
      if (kind === "text_delta" || kind === "text_start") {
        if (untracked(s.activity).kind !== "writing") s.activity.set({ kind: "writing" });
      } else if (kind === "thinking_delta" || kind === "thinking_start") {
        if (untracked(s.activity).kind !== "thinking") s.activity.set({ kind: "thinking" });
      }
      flushSoon(s);
      return;
    }
    case "tool_execution_start":
      s.activity.set({ kind: "tool", name: event.toolName, args: event.args ?? {} });
      flushNow(s);
      return;
    case "tool_execution_end":
      if (untracked(s.running)) s.activity.set({ kind: "thinking" });
      flushNow(s);
      return;
    case "auto_retry_start":
      s.activity.set({ kind: "retrying", attempt: event.attempt, maxAttempts: event.maxAttempts, reason: event.errorMessage });
      flushNow(s);
      return;
    case "auto_retry_end":
      if (untracked(s.running)) s.activity.set({ kind: "thinking" });
      flushNow(s);
      return;
    case "compaction_start":
      s.activity.set({ kind: "compacting" });
      flushNow(s);
      return;
    case "compaction_end":
      s.activity.set(untracked(s.running) ? { kind: "thinking" } : { kind: "idle" });
      flushNow(s);
      return;
    case "message_end":
    case "turn_end":
      flushNow(s);
      return;
    case "agent_settled": {
      flushNow(s);
      const hadError = endedInError(untracked(s.rows));
      batch(() => {
        s.loading.set(false);
        s.running.set(false);
        s.activity.set({ kind: "idle" });
        s.dialogs.set([]);
      });
      if (!event.aborted) {
        if (hadError) triggerErrorFlash(s);
        else triggerCheer(s);
      }
      void source
        .request("get_session_stats")
        .then((res) => {
          if (!s.disposed && source === s.client && res) s.stats.set(res);
        })
        .catch(() => undefined);
      return;
    }
  }
  flushSoon(s);
}

const activeControllers = new Set<SplitChatInternal>();

/**
 * Creates a live, independent chat controller for a chat `SplitTarget`.
 * Attaches immediately to the daemon session (reusing any live session matching
 * `daemonId` or `file`, or starting a fresh session when neither is set) and
 * loads existing history into its own `Transcript`.
 */
export function createSplitChatController(target: Extract<SplitTarget, { kind: "chat" }>): SplitChatController {
  const heldById = target.daemonId ? daemonSessionOfId(target.daemonId) : undefined;
  const heldByFile = target.file ? daemonSessionByFile(target.file) : undefined;
  const held = heldById ?? heldByFile;
  const summary = target.file ? findKnownSessionSummary(target.file) : undefined;
  const initialAgentId =
    held?.agentId ?? target.agentId ?? summary?.agentId ?? untracked(activeAgentId);
  const initialCwd =
    held?.cwd ?? target.cwd ?? (untracked(activeProjectPath) || untracked(workspacePath));
  const initialTitle =
    target.title ||
    (held ? daemonSessionTitle(held, "") : "") ||
    (summary ? sessionTitle(summary, "") : "") ||
    "";

  const s: SplitChatInternal = {
    key: target.file || target.ref,
    transcript: new Transcript(() => activeLanguage()),
    rows: signal<Row[]>([]),
    loading: signal(Boolean(target.file || target.daemonId)),
    running: signal(false),
    runStartedAt: signal(0),
    activity: signal<SplitChatActivity>({ kind: "idle" }),
    cheer: signal(false),
    failedFlash: signal(false),
    draft: signal(""),
    attachments: signal<Attachment[]>([]),
    files: signal<FileAttachment[]>([]),
    docs: signal<DocRef[]>([]),
    focusTick: signal(0, { equals: false }),
    commands: signal<SlashCommand[]>([]),
    stats: signal<SessionStats | undefined>(undefined),
    title: signal(initialTitle),
    cwd: signal(initialCwd),
    selectedAgentId: signal(initialAgentId),
    attachedAgentName: signal<string | undefined>(held?.agentName),
    models: signal<Model[] | undefined>(undefined),
    model: signal<Model | undefined>(undefined),
    thinkingLevels: signal<ThinkingLevel[] | undefined>(undefined),
    thinkingLevel: signal<ThinkingLevel | undefined>(undefined),
    runtimeMode: signal<RuntimeMode | undefined>(held?.runtimeMode),
    daemonId: signal<string | undefined>(held?.id ?? target.daemonId),
    sessionFile: signal<string | undefined>(held?.file ?? target.file),
    dialogs: signal<ExtensionUiDialog[]>([]),
    error: signal<string | undefined>(undefined),
    client: undefined,
    connectingPromise: undefined,
    flushFrame: undefined,
    cheerTimer: undefined,
    errorTimer: undefined,
    gen: 0,
    disposed: false,
  };
  activeControllers.add(s);

  const effectiveRuntimeMode = () => {
    const ag = resolveAgent(s.selectedAgentId());
    return clampModeForAgent(s.runtimeMode() ?? appRuntimeMode(), ag);
  };

  async function ensureClient(loadHistory: boolean): Promise<PiClient | undefined> {
    if (s.client && !s.client.closed) return s.client;
    if (s.connectingPromise) return s.connectingPromise;
    const mine = s.gen;
    const work = (async (): Promise<PiClient | undefined> => {
      const wantedAgentId = untracked(s.selectedAgentId);
      const wantedMode = untracked(effectiveRuntimeMode);
      const file = untracked(s.sessionFile);
      const id = untracked(s.daemonId);
      const attached = await attachInlineSession({
        id,
        file,
        cwd: untracked(s.cwd),
        agentId: wantedAgentId,
        title: untracked(s.title) || undefined,
        runtimeMode: wantedMode,
      });
      if (s.disposed || s.gen !== mine) {
        attached.transport.end();
        return undefined;
      }
      let started: PiClient | undefined;
      started = new PiClient(attached.transport, {
        onEvent: (event) => started && handleEvent(s, started, event),
        onUiRequest: (ui) => {
          if (s.disposed || started !== s.client) return;
          if (ui.method === "confirm" || ui.method === "select" || ui.method === "input" || ui.method === "form") {
            s.dialogs.update((list) => (list.some((d) => d.id === ui.id) ? list : [...list, ui]));
          } else if (ui.method === "dismiss") {
            s.dialogs.update((list) => list.filter((d) => d.id !== ui.id));
          } else if (ui.method === "notify") {
            toast(ui.notifyType ?? "info", ui.message);
          }
        },
        onExit: (exit, stderr) => {
          if (started !== s.client) return;
          s.client = undefined;
          const wasRunning = untracked(s.running);
          batch(() => {
            s.loading.set(false);
            s.running.set(false);
            s.activity.set({ kind: "idle" });
            s.dialogs.set([]);
          });
          if (!exit.expected && wasRunning) {
            const detail = stderr || exit.error || tr("The agent exited mid-run.", "智能体在运行中途退出。");
            s.transcript.note("error", tr("Agent stopped", "智能体已停止"), detail);
            flushNow(s);
            triggerErrorFlash(s);
            toast("warning", detail);
          }
        },
      });
      s.client = started;
      batch(() => {
        s.daemonId.set(attached.session.id);
        if (attached.session.file) s.sessionFile.set(attached.session.file);
        s.selectedAgentId.set(attached.agentId);
        s.attachedAgentName.set(attached.agentName);
        s.error.set(undefined);
      });
      registerInlineDaemon(attached.session.id, () => isSplitOpen());

      const hasExisting = Boolean(file || id);
      const sameAsMain = attached.agentId === activeAgentId();
      const mainModel = sameAsMain ? (untracked(draftModel) ?? untracked(sessionState)?.model) : undefined;
      const mainThinking = sameAsMain ? (untracked(draftThinkingLevel) ?? untracked(sessionState)?.thinkingLevel) : undefined;

      await Promise.all([
        syncCatalogFromClient(s, started, attached.agentId, mine, {
          applyPreferences: !hasExisting,
          preferredModel:
            mainModel && mainModel.provider !== "unknown"
              ? { provider: mainModel.provider, id: mainModel.id }
              : attached.preferredModel,
          preferredThinking: mainThinking ?? attached.preferredThinking,
        }),
        loadHistory
          ? started
              .request("get_messages")
              .then((res) => {
                if (s.disposed || s.gen !== mine || started !== s.client) return;
                const messages = (res as { messages?: AgentMessage[] } | undefined)?.messages ?? [];
                if (messages.length > 0) {
                  s.transcript.load(messages);
                  const loaded = s.transcript.rows();
                  const ids = displayRowIds(loaded);
                  markRowsSeen(ids);
                  markVeilsSeeded(ids);
                  markPacersSeeded(ids);
                  flushNow(s);
                }
              })
              .catch(() => undefined)
          : Promise.resolve(),
      ]);
      if (s.disposed || s.gen !== mine || started !== s.client) return undefined;
      s.loading.set(false);
      return started;
    })()
      .catch((error) => {
        if (!s.disposed && s.gen === mine) {
          s.loading.set(false);
          s.error.set(errorMessage(error));
        }
        return undefined;
      })
      .finally(() => {
        if (s.connectingPromise === work) s.connectingPromise = undefined;
      });
    s.connectingPromise = work;
    return work;
  }

  // Eagerly attach so history, models, and live stream appear immediately.
  void ensureClient(true);

  const agent = computed(() => resolveAgent(s.selectedAgentId()));
  const agentName = computed(() => s.attachedAgentName() ?? agent().name);
  const modelsList = computed<Model[]>(() => {
    const own = s.models();
    if (own !== undefined) return own;
    const id = s.selectedAgentId();
    const cached = cachedModelsForAgent(id);
    if (cached.length > 0 && !isPlaceholderCatalog(cached)) return cached;
    if (id === activeAgentId()) {
      const main = appAvailableModels();
      if (main.length > 0) return main;
    }
    return cached;
  });
  const currentModel = computed<Model | undefined>(() => {
    const own = s.model();
    if (own && own.provider !== "unknown") return own;
    const list = modelsList();
    const choice = storedSessionChoice(s.selectedAgentId())?.model;
    if (choice) {
      const found = list.find((m) => m.id === choice.id && m.provider === choice.provider) ?? list.find((m) => m.id === choice.id);
      if (found) return found;
    }
    return list[0];
  });
  const levelsList = computed<ThinkingLevel[]>(() => {
    const own = s.thinkingLevels();
    if (own?.length) return own;
    const id = s.selectedAgentId();
    const cached = cachedThinkingLevelsForAgent(id);
    if (cached.length > 1) return cached;
    if (id === activeAgentId()) {
      const main = appThinkingLevels();
      if (main.length > 0) return main;
    }
    return cached;
  });
  const currentThinking = computed<ThinkingLevel>(() => {
    const own = s.thinkingLevel();
    if (own) return own;
    const levels = levelsList();
    const choice = storedSessionChoice(s.selectedAgentId())?.thinkingLevel;
    if (choice && levels.includes(choice)) return choice;
    return currentModel()?.reasoning ? (levels.includes("medium") ? "medium" : levels[0] ?? "off") : "off";
  });
  const mood = computed<Mood>(() => {
    if (s.failedFlash()) return "error";
    if (s.cheer()) return "happy";
    if (s.loading()) return "sleep";
    if (!s.running()) return "idle";
    const act = s.activity();
    if (act.kind === "tool") return "work";
    if (act.kind === "writing") return "write";
    return "think";
  });

  const slashCommandsList = computed<ComposerCommand[]>(() =>
    s.commands().map((cmd) => ({
      name: cmd.name,
      description: cmd.description,
      source: cmd.source === "prompt" || cmd.source === "skill" || cmd.source === "extension" ? cmd.source : "agent",
    })),
  );

  function addAttachment(att: Attachment) {
    s.attachments.update((list) => [...list, att]);
  }

  function removeAttachment(index: number) {
    s.attachments.update((list) => list.filter((_, i) => i !== index));
  }

  function removeFileAttachment(path: string) {
    s.files.update((list) => list.filter((f) => f.path !== path));
  }

  async function attachLocalPath(filePath: string): Promise<boolean> {
    if (!filePath) return false;
    const st = await fs.stat(filePath).catch(() => undefined);
    if (!st) {
      toast("warning", tr("That file could not be read.", "无法读取该文件。"));
      return false;
    }
    if (st.isDirectory()) {
      toast("warning", tr("Folders cannot be attached directly.", "无法直接将文件夹作为附件。"));
      return false;
    }
    const kind = classifyMediaKind(filePath);
    const name = basename(filePath);
    const mimeType = mimeTypeForPath(filePath);
    const vision = Boolean(untracked(currentModel)?.input?.includes("image"));
    if (kind === "image" && mimeType && IMAGE_WIRE_MIMES.has(mimeType) && vision && st.size <= MAX_WIRE_IMAGE_BYTES) {
      try {
        const bytes = await fs.readFile(filePath);
        addAttachment({ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType, name });
        return true;
      } catch {}
    }
    s.files.update((list) =>
      list.some((f) => f.path === filePath)
        ? list
        : [...list, { path: filePath, name, kind, ...(mimeType ? { mimeType } : {}), size: st.size }],
    );
    return true;
  }

  async function pickFile() {
    const pick = backend().pickFile;
    if (!pick) return;
    try {
      const picked = await pick(tr("Attach file", "添加文件"));
      if (picked) await attachLocalPath(picked);
    } catch (error) {
      if (error instanceof NoPickerError) {
        toast("warning", tr("No file picker found — install zenity or kdialog to choose files.", "找不到文件选择器——请安装 zenity 或 kdialog。"));
      } else {
        toast("error", `${tr("Could not attach file", "无法添加文件")}: ${errorMessage(error)}`);
      }
    }
  }

  async function attachDocPath(path: string) {
    if (!path) return;
    const title = docTabTitle(path);
    let text = docText(path);
    if (text === undefined) {
      try {
        text = await fs.readFile(path, "utf8");
      } catch {
        toast("warning", tr("Could not read that document.", "无法读取该文档。"));
        return;
      }
    }
    const ref: DocRef = { path, title, text };
    s.docs.update((list) => (list.some((held) => held.path === path) ? list.map((held) => (held.path === path ? ref : held)) : [...list, ref]));
  }

  function detachDoc(path: string) {
    s.docs.update((list) => list.filter((held) => held.path !== path));
  }

  async function send(modeOverride?: "steer" | "followUp", textOverride?: string) {
    if (s.disposed) return;
    const raw = (textOverride ?? untracked(s.draft)).trim();
    const heldDocs = untracked(s.docs);
    const heldFiles = untracked(s.files);
    const heldImages = untracked(s.attachments);
    if (!raw && heldDocs.length === 0 && heldFiles.length === 0 && heldImages.length === 0) return;

    const mine = s.gen;
    if (textOverride === undefined) {
      batch(() => {
        s.draft.set("");
        s.docs.set([]);
        s.files.set([]);
        s.attachments.set([]);
      });
    }

    // Flush open attached documents before handing them to the agent.
    for (const ref of heldDocs) {
      if (docAt(ref.path)) await flushDoc(ref.path).catch(() => undefined);
    }
    const docParts = heldDocs.map((ref) => ({
      path: ref.path,
      title: ref.title,
      text: plainMarkdown(docRefText.read(ref)),
      excerpt: ref.excerpt,
    }));
    const withDocs = docParts.length > 0 ? composeDocMessage(raw, docParts) : raw;
    const wire = heldFiles.length > 0 ? composeFileMessage(withDocs, heldFiles) : withDocs;
    const images: ImageContent[] = heldImages.map(({ type, data, mimeType }) => ({ type, data, mimeType }));

    if (!untracked(s.title)) {
      const label = raw || heldDocs[0]?.title || heldFiles[0]?.name || tr("Image", "图片");
      s.title.set(label.replace(/\s+/g, " ").slice(0, 60));
    }

    const client = await ensureClient(false);
    if (!client || s.disposed || s.gen !== mine) {
      if (textOverride === undefined) {
        batch(() => {
          s.draft.set(raw);
          s.docs.set(heldDocs);
          s.files.set(heldFiles);
          s.attachments.set(heldImages);
        });
      }
      return;
    }
    try {
      if (untracked(s.running)) {
        const mode = modeOverride ?? (untracked(sendMode) === "queue" ? "followUp" : "steer");
        if (mode === "steer") await client.request("steer", { message: wire, ...(images.length ? { images } : {}) });
        else await client.request("follow_up", { message: wire, ...(images.length ? { images } : {}) });
      } else {
        s.transcript.stageUser(wire, images);
        flushNow(s);
        batch(() => {
          s.runStartedAt.set(Date.now());
          s.running.set(true);
          s.activity.set({ kind: "thinking" });
        });
        await client.request("prompt", { message: wire, ...(images.length ? { images } : {}) });
      }
    } catch (error) {
      if (s.disposed || s.gen !== mine) return;
      const detail = errorMessage(error);
      s.transcript.note("error", tr("Could not send message", "无法发送消息"), detail);
      flushNow(s);
      batch(() => {
        s.running.set(false);
        s.activity.set({ kind: "idle" });
      });
      triggerErrorFlash(s);
      toast("error", detail);
    }
  }

  async function stop() {
    if (s.disposed) return;
    const client = s.client;
    if (!client || client.closed) return;
    try {
      await client.request("abort");
    } catch {}
  }

  async function chooseAgent(agentId: string) {
    if (s.disposed || agentId === untracked(s.selectedAgentId)) return;
    s.gen++;
    detachClient(s);
    batch(() => {
      s.selectedAgentId.set(agentId);
      s.attachedAgentName.set(resolveAgent(agentId).name);
      s.daemonId.set(undefined);
      s.sessionFile.set(undefined);
      s.models.set(undefined);
      s.model.set(undefined);
      s.thinkingLevels.set(undefined);
      s.thinkingLevel.set(undefined);
      s.running.set(false);
      s.activity.set({ kind: "idle" });
      s.dialogs.set([]);
      s.loading.set(false);
    });
    await ensureClient(false);
  }

  async function chooseModel(model: Model) {
    if (s.disposed) return;
    s.model.set(model);
    const client = await ensureClient(false);
    if (!client || s.disposed) return;
    try {
      const chosen = await client.request("set_model", { provider: model.provider, modelId: model.id });
      if (chosen) s.model.set(chosen);
      const levelsRes = await client.request("get_available_thinking_levels").catch(() => undefined);
      if (levelsRes?.levels?.length) s.thinkingLevels.set(levelsRes.levels);
    } catch (error) {
      toast("warning", errorMessage(error));
    }
  }

  async function chooseThinkingLevel(level: ThinkingLevel) {
    if (s.disposed) return;
    s.thinkingLevel.set(level);
    const client = await ensureClient(false);
    if (!client || s.disposed) return;
    try {
      await client.request("set_thinking_level", { level });
    } catch (error) {
      toast("warning", errorMessage(error));
    }
  }

  async function chooseRuntimeMode(mode: RuntimeMode) {
    if (s.disposed) return;
    const clamped = clampModeForAgent(mode, untracked(agent));
    s.runtimeMode.set(clamped);
    const id = untracked(s.daemonId);
    if (id) setInlineDaemonRuntimeMode(id, clamped);
  }

  function answerDialog(id: string, answer: ExtensionUiAnswer) {
    if (s.disposed) return;
    s.dialogs.update((list) => list.filter((d) => d.id !== id));
    s.client?.respond(id, answer);
  }

  function dispose() {
    if (s.disposed) return;
    s.disposed = true;
    s.gen++;
    stopTimers(s);
    detachClient(s);
    activeControllers.delete(s);
  }

  return {
    key: s.key,
    title: () => s.title() || tr("New session", "新会话"),
    cwd: () => s.cwd(),
    rows: () => s.rows(),
    loading: () => s.loading(),
    running: () => s.running(),
    runStartedAt: () => s.runStartedAt(),
    activity: () => s.activity(),
    mood: () => mood(),
    draft: () => s.draft(),
    setDraft: (value) => s.draft.set(value),
    attachments: () => s.attachments(),
    addAttachment,
    removeAttachment,
    files: () => s.files(),
    attachLocalPath,
    removeFileAttachment,
    pickFile,
    docs: () => s.docs(),
    attachDocPath,
    detachDoc,
    focusTick: () => s.focusTick(),
    requestFocus: () => s.focusTick.update((n) => n + 1),
    slashCommands: () => slashCommandsList(),
    sessionStats: () => s.stats(),
    agent: () => agent(),
    agentId: () => s.selectedAgentId(),
    agentName: () => agentName(),
    availableModels: () => modelsList(),
    currentModel: () => currentModel(),
    thinkingLevels: () => levelsList(),
    thinkingLevel: () => currentThinking(),
    runtimeMode: () => effectiveRuntimeMode(),
    daemonId: () => s.daemonId(),
    sessionFile: () => s.sessionFile(),
    pendingDialog: () => s.dialogs()[0],
    error: () => s.error(),
    send,
    stop,
    chooseAgent,
    chooseModel,
    chooseThinkingLevel,
    chooseRuntimeMode,
    answerDialog,
    dispose,
  };
}

onStoreTeardown(() => {
  for (const s of [...activeControllers]) {
    s.disposed = true;
    s.gen++;
    stopTimers(s);
    detachClient(s);
  }
  activeControllers.clear();
});
