import { batch, computed, signal, untracked, type Signal } from "nsh";
import { runtimeModeRank } from "../agents/catalog";
import { buildPortableHandoff } from "../agents/handoff";
import type { AgentHarnessStatus, RuntimeMode } from "../agents/types";
import { composeDocMessage } from "../lib/doc-wire";
import { activeLanguage, tr } from "../lib/i18n";
import type { Mood } from "../mascot/geometry";
import { PiClient } from "../pi/client";
import type { ExtensionUiAnswer, ExtensionUiDialog, Model, SessionEvent, SessionState, ThinkingLevel } from "../pi/protocol";
import { Transcript, type Row } from "../pi/transcript";
import {
  activeAgent,
  activeAgentId,
  attachInlineSession,
  availableAgents,
  availableModels as appAvailableModels,
  cacheAgentModels,
  cacheAgentThinkingLevels,
  cachedModelsForAgent,
  cachedThinkingLevelsForAgent,
  currentRuntimeCeiling,
  currentView,
  draftModel,
  draftThinkingLevel,
  onStoreTeardown,
  openDaemonSession,
  registerInlineDaemon,
  runtimeMode as appRuntimeMode,
  sessionState,
  setInlineDaemonRuntimeMode,
  showChat,
  showSettings,
  stopDaemonSession,
  thinkingLevels as appThinkingLevels,
  toast,
  unregisterInlineDaemon,
} from "./app";
import { docAt, docText, ensureDocOnDisk, flushDoc, onDocClosed, setDiskUpdateToastSuppressor, syncDoc } from "./docs";
import { storedSessionChoice } from "./prefs";

export type DocActivity =
  | { kind: "idle" }
  | { kind: "thinking" }
  | { kind: "tool"; name: string; args: Record<string, unknown> }
  | { kind: "writing" }
  | { kind: "compacting" }
  | { kind: "retrying"; attempt: number; maxAttempts: number; reason: string };

/** A captured text selection in a Markdown document (preserved across focus moves to the floating bar). */
export interface DocSelection {
  from: number;
  to: number;
  text: string;
  words: number;
}

export interface DocAssistant {
  path: string;
  draft: () => string;
  setDraft: (value: string) => void;
  rows: () => Row[];
  /** Optimistic user bubble shown immediately while a fresh daemon session connects. */
  pendingPrompt: () => { text: string; excerpt: boolean } | undefined;
  running: () => boolean;
  connecting: () => boolean;
  runStartedAt: () => number;
  activity: () => DocActivity;
  mood: () => Mood;
  agent: () => AgentHarnessStatus;
  agentId: () => string;
  agentName: () => string;
  availableModels: () => Model[];
  currentModel: () => Model | undefined;
  modelName: () => string | undefined;
  thinkingLevels: () => ThinkingLevel[];
  thinkingLevel: () => ThinkingLevel;
  runtimeMode: () => RuntimeMode;
  loadingCatalog: () => boolean;
  daemonId: () => string | undefined;
  pendingDialog: () => ExtensionUiDialog | undefined;
  replyOpen: () => boolean;
  setReplyOpen: (open: boolean) => void;
  unread: () => boolean;
  markRead: () => void;
  focusTick: () => number;
  requestFocus: (selection?: DocSelection) => void;
  pinnedSelection: () => DocSelection | undefined;
  setPinnedSelection: (sel: DocSelection | undefined) => void;
  lastPromptSelection: () => DocSelection | undefined;
  /** Row IDs of assistant replies whose turn directly modified the document file on disk. */
  docEditedRows: () => Record<string, boolean>;
  chooseAgent: (agentId: string) => Promise<void>;
  chooseModel: (model: Model) => Promise<void>;
  chooseThinkingLevel: (level: ThinkingLevel) => Promise<void>;
  chooseRuntimeMode: (mode: RuntimeMode) => Promise<void>;
  ensureCatalog: () => Promise<void>;
  send: (text?: string, selectionOverride?: DocSelection) => Promise<void>;
  stop: () => Promise<void>;
  answerDialog: (id: string, answer: ExtensionUiAnswer) => void;
  clear: () => void;
  openInFullChat: () => void;
}

interface AssistantState {
  path: string;
  transcript: Transcript;
  rows: Signal<Row[]>;
  pendingPrompt: Signal<{ text: string; excerpt: boolean } | undefined>;
  draft: Signal<string>;
  running: Signal<boolean>;
  connecting: Signal<boolean>;
  runStartedAt: Signal<number>;
  activity: Signal<DocActivity>;
  cheer: Signal<boolean>;
  failedFlash: Signal<boolean>;
  selectedAgentId: Signal<string | undefined>;
  attachedAgentName: Signal<string | undefined>;
  models: Signal<Model[] | undefined>;
  model: Signal<Model | undefined>;
  thinkingLevels: Signal<ThinkingLevel[] | undefined>;
  thinkingLevel: Signal<ThinkingLevel | undefined>;
  runtimeMode: Signal<RuntimeMode | undefined>;
  loadingCatalog: Signal<boolean>;
  daemonId: Signal<string | undefined>;
  dialogs: Signal<ExtensionUiDialog[]>;
  replyOpen: Signal<boolean>;
  unread: Signal<boolean>;
  focusTick: Signal<number>;
  pinnedSelection: Signal<DocSelection | undefined>;
  lastPromptSelection: Signal<DocSelection | undefined>;
  docEditedRows: Signal<Record<string, boolean>>;
  preferredModelOverride: { provider: string; id: string } | undefined;
  preferredThinkingOverride: ThinkingLevel | undefined;
  pendingHandoff: { fromAgent: string; toAgent: string; context: string } | undefined;
  catalogLoadedForAgent: string | undefined;
  client: PiClient | undefined;
  connectingPromise: Promise<PiClient | undefined> | undefined;
  flushFrame: number | undefined;
  syncTimer: ReturnType<typeof setInterval> | undefined;
  cheerTimer: ReturnType<typeof setTimeout> | undefined;
  errorTimer: ReturnType<typeof setTimeout> | undefined;
  turnStartUpdateSeq: number;
  /** Monotonic generation incremented on `clear()`, `chooseAgent()`, or `dispose()` to cancel stale async work. */
  gen: number;
  disposed: boolean;
}

const assistants = new Map<string, DocAssistant>();
const states = new Map<string, AssistantState>();

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

function isPlaceholderCatalog(list: readonly Model[]): boolean {
  return list.length === 0 || (list.length === 1 && list[0]!.id === "default" && !list[0]!.reasoning);
}

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

function effectiveAgentId(s: AssistantState): string {
  return s.selectedAgentId() ?? activeAgentId();
}

function effectiveRuntimeMode(s: AssistantState): RuntimeMode {
  const agent = resolveAgent(effectiveAgentId(s));
  return clampModeForAgent(s.runtimeMode() ?? appRuntimeMode(), agent);
}

function stopTimers(s: AssistantState) {
  if (s.flushFrame !== undefined) {
    cancelAnimationFrame(s.flushFrame);
    s.flushFrame = undefined;
  }
  if (s.syncTimer !== undefined) {
    clearInterval(s.syncTimer);
    s.syncTimer = undefined;
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

function flushNow(s: AssistantState) {
  if (s.flushFrame !== undefined) {
    cancelAnimationFrame(s.flushFrame);
    s.flushFrame = undefined;
  }
  const next = s.transcript.rows();
  if (next !== untracked(s.rows)) s.rows.set(next);
}

function flushSoon(s: AssistantState) {
  if (s.flushFrame !== undefined) return;
  s.flushFrame = requestAnimationFrame(() => {
    s.flushFrame = undefined;
    const next = s.transcript.rows();
    if (next !== untracked(s.rows)) s.rows.set(next);
  });
}

function detachClient(s: AssistantState) {
  const prevId = untracked(s.daemonId);
  if (prevId) unregisterInlineDaemon(prevId);
  const c = s.client;
  s.client = undefined;
  s.connectingPromise = undefined;
  if (c) c.close(0);
}

function startDocSyncLoop(s: AssistantState) {
  if (s.syncTimer !== undefined) return;
  s.syncTimer = setInterval(() => {
    void syncDoc(s.path);
  }, 450);
}

function stopDocSyncLoop(s: AssistantState) {
  if (s.syncTimer !== undefined) {
    clearInterval(s.syncTimer);
    s.syncTimer = undefined;
  }
}

function endedInError(rows: readonly Row[]) {
  const last = rows.at(-1);
  return last?.kind === "notice" && last.tone === "error";
}

function triggerCheer(s: AssistantState) {
  if (s.cheerTimer !== undefined) clearTimeout(s.cheerTimer);
  s.cheer.set(true);
  s.cheerTimer = setTimeout(() => {
    s.cheerTimer = undefined;
    s.cheer.set(false);
  }, 1100);
}

function triggerErrorFlash(s: AssistantState) {
  if (s.errorTimer !== undefined) clearTimeout(s.errorTimer);
  s.failedFlash.set(true);
  s.errorTimer = setTimeout(() => {
    s.errorTimer = undefined;
    s.failedFlash.set(false);
  }, 1400);
}

function isDocFront(path: string) {
  const v = currentView();
  return v.name === "doc" && v.docId === path;
}

/** Syncs the live client's models, thinking levels, and current model/thinking state. */
async function syncCatalogFromClient(
  s: AssistantState,
  client: PiClient,
  agentId: string,
  mine: number,
  options: { applyPreferences: boolean; preferredModel?: { provider: string; id: string }; preferredThinking?: ThinkingLevel },
) {
  const [st, modelsRes, levelsRes] = await Promise.all([
    client.request("get_state").catch(() => undefined) as Promise<SessionState | undefined>,
    client.request("get_available_models").catch(() => undefined),
    client.request("get_available_thinking_levels").catch(() => undefined),
  ]);
  if (s.disposed || s.gen !== mine || client !== s.client) return;

  const list = modelsRes?.models ?? [];
  let levels: ThinkingLevel[] = levelsRes?.levels?.length ? levelsRes.levels : ["off"];
  if (list.length > 0) cacheAgentModels(agentId, list);
  cacheAgentThinkingLevels(agentId, levels);

  let currentModel = st?.model;
  let currentThinking: ThinkingLevel | undefined = st?.thinkingLevel;

  if (options.applyPreferences) {
    const wantedModel = s.preferredModelOverride ?? options.preferredModel;
    if (wantedModel) {
      const found =
        list.find((m) => m.id === wantedModel.id && m.provider === wantedModel.provider) ??
        list.find((m) => m.id === wantedModel.id);
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

    const wantedThinking = s.preferredThinkingOverride ?? options.preferredThinking;
    if (wantedThinking && levels.includes(wantedThinking) && currentThinking !== wantedThinking) {
      const ok = await client
        .request("set_thinking_level", { level: wantedThinking })
        .then(() => true)
        .catch(() => false);
      if (s.disposed || s.gen !== mine || client !== s.client) return;
      if (ok) currentThinking = wantedThinking;
    }
  }

  s.catalogLoadedForAgent = agentId;
  batch(() => {
    s.models.set(list);
    s.thinkingLevels.set(levels);
    if (currentModel && currentModel.provider !== "unknown") s.model.set(currentModel);
    else if (list.length === 0) s.model.set(undefined);
    if (currentThinking) s.thinkingLevel.set(currentThinking);
    else if (!currentModel?.reasoning) s.thinkingLevel.set("off");
  });
}

function handleEvent(s: AssistantState, source: PiClient, event: SessionEvent) {
  if (s.disposed || source !== s.client) return;
  if (event.type === "models_changed") {
    const mine = s.gen;
    const agentId = untracked(() => effectiveAgentId(s));
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
        s.connecting.set(false);
        if (!untracked(s.running)) s.runStartedAt.set(Date.now());
        s.running.set(true);
        s.activity.set({ kind: "thinking" });
      });
      startDocSyncLoop(s);
      flushNow(s);
      return;
    case "message_start":
      if (event.message?.role === "user" && untracked(s.pendingPrompt)) {
        s.pendingPrompt.set(undefined);
      }
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
      // An agent edit lands on disk as soon as the tool finishes: pull it into the open editor immediately.
      void syncDoc(s.path);
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
      stopDocSyncLoop(s);
      flushNow(s);
      const mine = s.gen;
      const startSeq = s.turnStartUpdateSeq;
      const allRows = untracked(s.rows);
      let lastUserId: string | undefined;
      let lastAnswerId: string | undefined;
      for (let i = allRows.length - 1; i >= 0; i--) {
        const r = allRows[i]!;
        if (!lastAnswerId && r.kind === "text") lastAnswerId = r.id;
        if (r.kind === "user") {
          lastUserId = r.id;
          break;
        }
      }
      const hadError = endedInError(allRows);
      const syncedAlready = (docAt(s.path)?.updateSeq() ?? 0) > startSeq;
      batch(() => {
        s.pendingPrompt.set(undefined);
        s.connecting.set(false);
        s.running.set(false);
        s.activity.set({ kind: "idle" });
        s.dialogs.set([]);
        if (syncedAlready && (lastAnswerId || lastUserId)) {
          s.docEditedRows.update((prev) => ({
            ...prev,
            ...(lastAnswerId ? { [lastAnswerId]: true } : {}),
            ...(lastUserId ? { [lastUserId]: true } : {}),
          }));
        }
      });
      if (!event.aborted) {
        if (hadError) triggerErrorFlash(s);
        else triggerCheer(s);
        if (!untracked(s.replyOpen) || !isDocFront(s.path)) {
          s.unread.set(true);
        }
      }
      void syncDoc(s.path).then(() => {
        if (s.disposed || s.gen !== mine) return;
        const nowSeq = docAt(s.path)?.updateSeq() ?? 0;
        if (nowSeq > startSeq && (lastAnswerId || lastUserId)) {
          s.docEditedRows.update((prev) => ({
            ...prev,
            ...(lastAnswerId ? { [lastAnswerId]: true } : {}),
            ...(lastUserId ? { [lastUserId]: true } : {}),
          }));
        }
      });
      return;
    }
  }
  flushSoon(s);
}

async function ensureClient(s: AssistantState): Promise<PiClient | undefined> {
  if (s.client && !s.client.closed) return s.client;
  if (s.connectingPromise) return s.connectingPromise;
  const mine = s.gen;
  const work = (async (): Promise<PiClient | undefined> => {
    const wantedAgentId = untracked(() => effectiveAgentId(s));
    const wantedMode = untracked(() => effectiveRuntimeMode(s));
    const attached = await attachInlineSession({
      id: untracked(s.daemonId),
      agentId: wantedAgentId,
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
        if (ui.method === "confirm" || ui.method === "select" || ui.method === "input") {
          s.dialogs.update((list) => [...list, ui]);
          s.replyOpen.set(true);
        } else if (ui.method === "notify") {
          toast(ui.notifyType ?? "info", ui.message);
        }
      },
      onExit: (exit, stderr) => {
        if (started !== s.client) return;
        s.client = undefined;
        stopDocSyncLoop(s);
        const wasRunning = untracked(s.running);
        batch(() => {
          s.pendingPrompt.set(undefined);
          s.connecting.set(false);
          s.running.set(false);
          s.activity.set({ kind: "idle" });
          s.dialogs.set([]);
        });
        if (!exit.expected && wasRunning) {
          const detail = stderr || exit.error || tr("The agent exited mid-run.", "智能体在运行中途退出。");
          s.transcript.note("error", tr("Assistant stopped", "助手已停止"), detail);
          flushNow(s);
          triggerErrorFlash(s);
          toast("warning", detail);
        }
      },
    });
    s.client = started;
    batch(() => {
      s.daemonId.set(attached.session.id);
      s.selectedAgentId.set(attached.agentId);
      s.attachedAgentName.set(attached.agentName);
    });
    registerInlineDaemon(attached.session.id, () => isDocFront(s.path) && untracked(s.replyOpen));

    const sameAsMain = attached.agentId === activeAgentId();
    const mainModel = sameAsMain ? (untracked(draftModel) ?? untracked(sessionState)?.model) : undefined;
    const mainThinking = sameAsMain ? (untracked(draftThinkingLevel) ?? untracked(sessionState)?.thinkingLevel) : undefined;

    await syncCatalogFromClient(s, started, attached.agentId, mine, {
      applyPreferences: true,
      preferredModel: mainModel && mainModel.provider !== "unknown" ? { provider: mainModel.provider, id: mainModel.id } : attached.preferredModel,
      preferredThinking: mainThinking ?? attached.preferredThinking,
    });
    if (s.disposed || s.gen !== mine || started !== s.client) return undefined;
    return started;
  })().finally(() => {
    if (s.connectingPromise === work) s.connectingPromise = undefined;
  });
  s.connectingPromise = work;
  return work;
}

async function warmCatalog(s: AssistantState): Promise<void> {
  if (s.disposed) return;
  const mine = s.gen;
  s.loadingCatalog.set(true);
  try {
    await ensureClient(s);
  } catch (error) {
    if (!s.disposed && s.gen === mine) {
      toast("warning", `${tr("Could not load agent models", "无法加载智能体模型")}: ${errorMessage(error)}`);
    }
  } finally {
    if (!s.disposed && s.gen === mine) s.loadingCatalog.set(false);
  }
}

/** Ensures a per-document inline AI assistant exists for `path`. Lazily spawns no agent process until the first send or explicit engine discovery. */
export function ensureDocAssistant(path: string): DocAssistant {
  const existing = assistants.get(path);
  if (existing) return existing;

  const s: AssistantState = {
    path,
    transcript: new Transcript(() => activeLanguage()),
    rows: signal<Row[]>([]),
    pendingPrompt: signal<{ text: string; excerpt: boolean } | undefined>(undefined),
    draft: signal(""),
    running: signal(false),
    connecting: signal(false),
    runStartedAt: signal(0),
    activity: signal<DocActivity>({ kind: "idle" }),
    cheer: signal(false),
    failedFlash: signal(false),
    selectedAgentId: signal<string | undefined>(undefined),
    attachedAgentName: signal<string | undefined>(undefined),
    models: signal<Model[] | undefined>(undefined),
    model: signal<Model | undefined>(undefined),
    thinkingLevels: signal<ThinkingLevel[] | undefined>(undefined),
    thinkingLevel: signal<ThinkingLevel | undefined>(undefined),
    runtimeMode: signal<RuntimeMode | undefined>(undefined),
    loadingCatalog: signal(false),
    daemonId: signal<string | undefined>(undefined),
    dialogs: signal<ExtensionUiDialog[]>([]),
    replyOpen: signal(false),
    unread: signal(false),
    focusTick: signal(0, { equals: false }),
    pinnedSelection: signal<DocSelection | undefined>(undefined),
    lastPromptSelection: signal<DocSelection | undefined>(undefined),
    docEditedRows: signal<Record<string, boolean>>({}),
    preferredModelOverride: undefined,
    preferredThinkingOverride: undefined,
    pendingHandoff: undefined,
    catalogLoadedForAgent: undefined,
    client: undefined,
    connectingPromise: undefined,
    flushFrame: undefined,
    syncTimer: undefined,
    cheerTimer: undefined,
    errorTimer: undefined,
    turnStartUpdateSeq: 0,
    gen: 0,
    disposed: false,
  };

  const agentId = computed(() => effectiveAgentId(s));
  const agent = computed(() => resolveAgent(agentId()));
  const agentName = computed(() => s.attachedAgentName() ?? agent().name);

  const modelsList = computed<Model[]>(() => {
    const local = s.models();
    if (local !== undefined) return local;
    const id = agentId();
    if (id === activeAgentId()) {
      const live = appAvailableModels();
      if (live.length > 0) return live;
    }
    return cachedModelsForAgent(id);
  });

  const currentModel = computed<Model | undefined>(() => {
    const explicit = s.model();
    if (explicit && explicit.provider !== "unknown") return explicit;
    const list = modelsList();
    const id = agentId();
    if (id === activeAgentId()) {
      const main = draftModel() ?? sessionState()?.model;
      if (main && main.provider !== "unknown") return main;
    }
    const wanted = s.preferredModelOverride ?? storedSessionChoice(id)?.model;
    if (wanted) {
      const match =
        list.find((m) => m.id === wanted.id && m.provider === wanted.provider) ??
        list.find((m) => m.id === wanted.id);
      if (match) return match;
    }
    const first = list[0];
    return first && first.provider !== "unknown" ? first : undefined;
  });

  const modelName = computed<string | undefined>(() => {
    const m = currentModel();
    return m && m.provider !== "unknown" ? m.name || m.id : undefined;
  });

  const levelsList = computed<ThinkingLevel[]>(() => {
    const local = s.thinkingLevels();
    if (local !== undefined) return local;
    const m = currentModel();
    if (m && !m.reasoning) return ["off"];
    if (m?.effortLevels && m.effortLevels.length > 0) {
      return [...new Set(["off", ...m.effortLevels])] as ThinkingLevel[];
    }
    const id = agentId();
    if (id === activeAgentId()) return appThinkingLevels();
    return cachedThinkingLevelsForAgent(id);
  });

  const currentThinkingLevel = computed<ThinkingLevel>(() => {
    const available = levelsList();
    if (available.length <= 1) return available[0] ?? "off";
    const explicit = s.thinkingLevel();
    if (explicit && available.includes(explicit)) return explicit;
    const id = agentId();
    const fallback =
      id === activeAgentId()
        ? (draftThinkingLevel() ?? sessionState()?.thinkingLevel ?? storedSessionChoice(id)?.thinkingLevel)
        : storedSessionChoice(id)?.thinkingLevel;
    if (fallback && available.includes(fallback)) return fallback;
    return explicit ?? fallback ?? "off";
  });

  const currentMode = computed<RuntimeMode>(() => effectiveRuntimeMode(s));

  const mood = computed<Mood>(() => {
    if (s.failedFlash()) return "error";
    if (s.running() || s.connecting()) {
      const act = s.activity();
      if (act.kind === "writing") return "write";
      if (act.kind === "tool" || act.kind === "compacting" || act.kind === "retrying") return "work";
      return "think";
    }
    if (s.cheer()) return "happy";
    return "idle";
  });

  const api: DocAssistant = {
    path,
    draft: () => s.draft(),
    setDraft: (value) => s.draft.set(value),
    rows: () => s.rows(),
    pendingPrompt: () => s.pendingPrompt(),
    running: () => s.running(),
    connecting: () => s.connecting(),
    runStartedAt: () => s.runStartedAt(),
    activity: () => s.activity(),
    mood: () => mood(),
    agent: () => agent(),
    agentId: () => agentId(),
    agentName: () => agentName(),
    availableModels: () => modelsList(),
    currentModel: () => currentModel(),
    modelName: () => modelName(),
    thinkingLevels: () => levelsList(),
    thinkingLevel: () => currentThinkingLevel(),
    runtimeMode: () => currentMode(),
    loadingCatalog: () => s.loadingCatalog(),
    daemonId: () => s.daemonId(),
    pendingDialog: () => s.dialogs()[0],
    replyOpen: () => s.replyOpen(),
    setReplyOpen: (open) => {
      s.replyOpen.set(open);
      if (open) s.unread.set(false);
    },
    unread: () => s.unread(),
    markRead: () => s.unread.set(false),
    focusTick: () => s.focusTick(),
    requestFocus: (selection) => {
      if (selection) s.pinnedSelection.set(selection);
      s.focusTick.update((n) => n + 1);
    },
    pinnedSelection: () => s.pinnedSelection(),
    setPinnedSelection: (sel) => s.pinnedSelection.set(sel),
    lastPromptSelection: () => s.lastPromptSelection(),
    docEditedRows: () => s.docEditedRows(),

    async chooseAgent(nextAgentId) {
      if (s.disposed) return;
      const target = availableAgents().find((a) => a.id === nextAgentId);
      if (!target) return;
      if (!target.available) {
        toast(
          "warning",
          tr(
            `${target.name} is not installed yet. Configure it in Settings → Agents.`,
            `${target.name} 尚未安装，请在「设置 → 智能体」中查看配置。`,
          ),
        );
        showSettings("agents");
        return;
      }

      const prevId = untracked(agentId);
      const prevName = untracked(agentName);
      if (nextAgentId === prevId) {
        await api.ensureCatalog();
        return;
      }

      if (untracked(s.running)) {
        await api.stop();
        if (s.disposed) return;
      }

      const currentRows = untracked(s.rows);
      const hasConversation = currentRows.some((r) => r.kind === "user" || r.kind === "text");
      if (hasConversation) {
        const handoff = buildPortableHandoff({
          rows: currentRows,
          fromAgentName: prevName,
          toAgentName: target.name,
        });
        s.pendingHandoff = handoff.formattedContext
          ? { fromAgent: prevName, toAgent: target.name, context: handoff.formattedContext }
          : undefined;
        s.transcript.note(
          "info",
          tr(`Switched to ${target.name}`, `已切换至 ${target.name}`),
          handoff.items.length
            ? tr("Previous context carries over on your next message.", "上下文将在下一次发送时自动交接。")
            : undefined,
        );
        flushNow(s);
      } else {
        s.pendingHandoff = undefined;
      }

      s.gen++;
      stopTimers(s);
      detachClient(s);
      s.preferredModelOverride = undefined;
      s.preferredThinkingOverride = undefined;
      s.catalogLoadedForAgent = undefined;

      const clampedMode = clampModeForAgent(untracked(currentMode), target);
      batch(() => {
        s.daemonId.set(undefined);
        s.dialogs.set([]);
        s.selectedAgentId.set(target.id);
        s.attachedAgentName.set(target.name);
        s.models.set(undefined);
        s.model.set(undefined);
        s.thinkingLevels.set(undefined);
        s.thinkingLevel.set(undefined);
        s.runtimeMode.set(clampedMode);
        s.loadingCatalog.set(false);
      });

      const known = cachedModelsForAgent(target.id);
      if (target.id !== activeAgentId() || isPlaceholderCatalog(known)) {
        void warmCatalog(s);
      }
    },

    async chooseModel(model) {
      if (s.disposed) return;
      const prevModel = untracked(s.model);
      const prevLevels = untracked(s.thinkingLevels);
      const prevThinking = untracked(s.thinkingLevel);
      const prevOverride = s.preferredModelOverride;
      const id = untracked(agentId);

      s.preferredModelOverride = { provider: model.provider, id: model.id };
      const estimatedLevels: ThinkingLevel[] | undefined = !model.reasoning
        ? ["off"]
        : model.effortLevels?.length
          ? ([...new Set(["off", ...model.effortLevels])] as ThinkingLevel[])
          : id === activeAgentId() && untracked(appThinkingLevels).length > 1
            ? untracked(appThinkingLevels)
            : cachedThinkingLevelsForAgent(id).length > 1
              ? cachedThinkingLevelsForAgent(id)
              : undefined;

      batch(() => {
        s.model.set(model);
        if (estimatedLevels !== undefined) s.thinkingLevels.set(estimatedLevels);
        if (!model.reasoning) {
          s.thinkingLevel.set("off");
        } else if (estimatedLevels && estimatedLevels.length > 1) {
          const desired =
            s.preferredThinkingOverride ??
            (prevThinking && prevThinking !== "off" ? prevThinking : undefined) ??
            storedSessionChoice(id)?.thinkingLevel;
          if (desired && estimatedLevels.includes(desired)) s.thinkingLevel.set(desired);
        }
      });

      const activeClient = s.client;
      if (activeClient && !activeClient.closed) {
        const mine = s.gen;
        try {
          const chosen = await activeClient.request("set_model", { provider: model.provider, modelId: model.id });
          if (s.disposed || s.gen !== mine || activeClient !== s.client) return;
          const [levelsRes, st] = await Promise.all([
            activeClient.request("get_available_thinking_levels").catch(() => undefined),
            activeClient.request("get_state").catch(() => undefined),
          ]);
          if (s.disposed || s.gen !== mine || activeClient !== s.client) return;
          const nextLevels: ThinkingLevel[] = levelsRes?.levels?.length
            ? levelsRes.levels
            : chosen.reasoning
              ? ["off", "low", "medium", "high"]
              : ["off"];
          cacheAgentThinkingLevels(id, nextLevels);
          let nextThinking: ThinkingLevel = st?.thinkingLevel ?? (chosen.reasoning ? untracked(currentThinkingLevel) : "off");
          if (chosen.reasoning && s.preferredThinkingOverride && nextLevels.includes(s.preferredThinkingOverride) && nextThinking !== s.preferredThinkingOverride) {
            const ok = await activeClient
              .request("set_thinking_level", { level: s.preferredThinkingOverride })
              .then(() => true)
              .catch(() => false);
            if (ok) nextThinking = s.preferredThinkingOverride;
          }
          if (s.disposed || s.gen !== mine || activeClient !== s.client) return;
          batch(() => {
            s.model.set(chosen);
            s.thinkingLevels.set(nextLevels);
            s.thinkingLevel.set(nextLevels.includes(nextThinking) ? nextThinking : (nextLevels[0] ?? "off"));
          });
        } catch (error) {
          if (s.disposed || s.gen !== mine) return;
          s.preferredModelOverride = prevOverride;
          batch(() => {
            s.model.set(prevModel);
            s.thinkingLevels.set(prevLevels);
            s.thinkingLevel.set(prevThinking);
          });
          toast("error", `${tr("Could not switch model", "无法切换模型")}: ${errorMessage(error)}`);
        }
      }
    },

    async chooseThinkingLevel(level) {
      if (s.disposed) return;
      const prevThinking = untracked(s.thinkingLevel);
      const prevOverride = s.preferredThinkingOverride;
      s.preferredThinkingOverride = level;
      s.thinkingLevel.set(level);

      const activeClient = s.client;
      if (activeClient && !activeClient.closed) {
        const mine = s.gen;
        try {
          await activeClient.request("set_thinking_level", { level });
        } catch (error) {
          if (s.disposed || s.gen !== mine) return;
          s.preferredThinkingOverride = prevOverride;
          s.thinkingLevel.set(prevThinking);
          toast("error", `${tr("Could not change thinking", "无法更改思考深度")}: ${errorMessage(error)}`);
        }
      }
    },

    async chooseRuntimeMode(mode) {
      if (s.disposed) return;
      const currentAgent = untracked(agent);
      const effective = clampModeForAgent(mode, currentAgent);
      const prev = untracked(s.runtimeMode);
      s.runtimeMode.set(effective);

      const did = untracked(s.daemonId);
      if (did) setInlineDaemonRuntimeMode(did, effective);

      const activeClient = s.client;
      if (activeClient && !activeClient.closed) {
        const mine = s.gen;
        try {
          if (currentAgent.id === "pi") {
            await activeClient.request("prompt", { message: `/pipi-runtime-mode ${effective}` });
          } else {
            await (activeClient as unknown as { request(t: string, a: Record<string, unknown>): Promise<unknown> }).request(
              "set_runtime_mode",
              { mode: effective },
            );
          }
        } catch (error) {
          if (s.disposed || s.gen !== mine) return;
          s.runtimeMode.set(prev);
          toast("error", `${tr("Could not change the permission mode", "无法更改权限模式")}: ${errorMessage(error)}`);
        }
      }
    },

    async ensureCatalog() {
      if (s.disposed) return;
      const id = untracked(agentId);
      if (s.client && !s.client.closed) return;
      if (s.catalogLoadedForAgent === id) return;
      if (id === activeAgentId() && !isPlaceholderCatalog(untracked(appAvailableModels))) return;
      if (!isPlaceholderCatalog(cachedModelsForAgent(id))) return;
      await warmCatalog(s);
    },

    async send(rawText, selectionOverride) {
      const text = (rawText ?? untracked(s.draft)).trim();
      if (!text || s.disposed) return;
      const sel = selectionOverride ?? untracked(s.pinnedSelection);
      const mine = s.gen;
      const alreadyRunning = untracked(s.running);

      batch(() => {
        s.draft.set("");
        s.unread.set(false);
        s.replyOpen.set(true);
        s.failedFlash.set(false);
        s.cheer.set(false);
        s.lastPromptSelection.set(sel);
        if (!alreadyRunning) {
          s.pendingPrompt.set({ text, excerpt: Boolean(sel?.text) });
          s.connecting.set(true);
          s.running.set(true);
          s.runStartedAt.set(Date.now());
          s.activity.set({ kind: "thinking" });
        }
      });

      try {
        const readOnly = docAt(path)?.readOnly() === true;
        if (readOnly) await flushDoc(path);
        else await ensureDocOnDisk(path);
        if (s.disposed || s.gen !== mine) return;
        s.turnStartUpdateSeq = docAt(path)?.updateSeq() ?? 0;
        const body = sel?.text ? sel.text : (docText(path) ?? "");
        const baseWire = composeDocMessage(
          text,
          [{ path, text: body, ...(sel?.text ? { excerpt: true } : {}) }],
          { path, editable: !readOnly, scope: sel?.text ? "selection" : "document" },
        );
        const handoff = s.pendingHandoff;
        const wire = handoff ? `${handoff.context}\n\n${baseWire}` : baseWire;
        const activeClient = await ensureClient(s);
        if (!activeClient || s.disposed || s.gen !== mine) return;
        if (handoff && s.pendingHandoff === handoff) s.pendingHandoff = undefined;
        await activeClient.request("prompt", {
          message: wire,
          ...(alreadyRunning ? { streamingBehavior: "steer" as const } : {}),
        });
      } catch (error) {
        if (s.disposed || s.gen !== mine) return;
        const msg = errorMessage(error);
        s.transcript.note("error", tr("Could not send", "无法发送"), msg);
        flushNow(s);
        batch(() => {
          s.pendingPrompt.set(undefined);
          s.connecting.set(false);
          s.running.set(false);
          s.activity.set({ kind: "idle" });
        });
        triggerErrorFlash(s);
        toast("error", `${tr("Document assistant error", "文档助手出错")}: ${msg}`);
      }
    },

    async stop() {
      const c = s.client;
      const did = untracked(s.daemonId);
      stopDocSyncLoop(s);
      if (c && !c.closed) {
        try {
          await c.request("abort");
        } catch {}
      }
      if (did) {
        await stopDaemonSession(did).catch(() => undefined);
      }
      batch(() => {
        s.pendingPrompt.set(undefined);
        s.connecting.set(false);
        s.running.set(false);
        s.activity.set({ kind: "idle" });
        s.dialogs.set([]);
      });
    },

    answerDialog(id, answer) {
      s.client?.respond(id, answer);
      s.dialogs.update((list) => list.filter((d) => d.id !== id));
    },

    clear() {
      s.gen++;
      stopTimers(s);
      detachClient(s);
      s.pendingHandoff = undefined;
      s.transcript = new Transcript(() => activeLanguage());
      batch(() => {
        s.rows.set([]);
        s.pendingPrompt.set(undefined);
        s.running.set(false);
        s.connecting.set(false);
        s.activity.set({ kind: "idle" });
        s.cheer.set(false);
        s.failedFlash.set(false);
        s.daemonId.set(undefined);
        s.dialogs.set([]);
        s.replyOpen.set(false);
        s.unread.set(false);
        s.lastPromptSelection.set(undefined);
        s.docEditedRows.set({});
      });
    },

    openInFullChat() {
      const did = untracked(s.daemonId);
      if (!did) return;
      s.gen++;
      stopTimers(s);
      detachClient(s);
      s.pendingHandoff = undefined;
      s.transcript = new Transcript(() => activeLanguage());
      batch(() => {
        s.rows.set([]);
        s.pendingPrompt.set(undefined);
        s.running.set(false);
        s.connecting.set(false);
        s.activity.set({ kind: "idle" });
        s.daemonId.set(undefined);
        s.dialogs.set([]);
        s.replyOpen.set(false);
        s.unread.set(false);
        s.docEditedRows.set({});
      });
      openDaemonSession(did);
      showChat();
    },
  };

  assistants.set(path, api);
  states.set(path, s);
  return api;
}

export function docAssistantAt(path: string): DocAssistant | undefined {
  return assistants.get(path);
}

export function disposeDocAssistant(path: string) {
  const s = states.get(path);
  if (!s) return;
  s.disposed = true;
  s.gen++;
  stopTimers(s);
  detachClient(s);
  states.delete(path);
  assistants.delete(path);
}

// Keep assistant lifecycles tied cleanly to document closes and hot-reload teardowns.
onDocClosed((path) => disposeDocAssistant(path));
setDiskUpdateToastSuppressor((path) => {
  const s = states.get(path);
  return Boolean(s && (untracked(s.running) || untracked(s.replyOpen)));
});
onStoreTeardown(() => {
  for (const path of [...states.keys()]) disposeDocAssistant(path);
});
