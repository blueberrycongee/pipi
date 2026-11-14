import { batch, Clipboard, computed, signal } from "nsh";
import { Window } from "nsh/desktop";
import * as fs from "fs/promises";
import { defaultAgentStatuses, runtimeModeRank } from "../agents/catalog";
import { buildPortableHandoff, prependHandoffToPrompt } from "../agents/handoff";
import type {
  AgentHarnessStatus,
  AgentOverride,
  CustomAgentConfig,
  RuntimeMode,
  WorkspaceIsolation,
  WorktreeInfo,
} from "../agents/types";
import { activeLanguage, tr } from "../lib/i18n";
import { answersTo, type ComposerCommand, parseSlashLine } from "../lib/slash";
import {
  chooseRandomWallpaperCandidate,
  DEFAULT_WALLPAPER_ADJUSTMENT,
  inspectImageBytes,
  isSupportedWallpaperPath,
  type WallpaperAdjustment,
  type WallpaperEffect,
} from "../lib/wallpaper";
import type { Mood } from "../mascot/geometry";
import { type Exit, PiClient, PiError } from "../pi/client";
import type { CredentialKind } from "../pi/credentials";
import { DaemonClient, type DaemonSession } from "../pi/daemon";
import type {
  Commands,
  AgentMessage,
  CommandType,
  ExtensionUiAnswer,
  ExtensionUiDialog,
  ExtensionUiRequest,
  ImageContent,
  Model,
  QueueMode,
  SessionEvent,
  SessionState,
  SessionStats,
  SlashCommand,
  ThinkingLevel,
} from "../pi/protocol";
import { type SessionSummary, sessionTitle } from "../pi/sessions";
import { EMPTY_USAGE, type UsageStats } from "../pi/usage";
import { killAllSidecars, SidecarError } from "../pi/sidecar";
import { type Row, Transcript, withoutImageNotes } from "../pi/transcript";
import { displayRowIds } from "../pi/turns";
import type { IconName } from "../ui/Icon";
import { enableLiveRowEntrance, markRowsSeen } from "../ui/motion";
import { backend, NoPickerError } from "./backend";
import { startAppUpdateChecks, stopAppUpdateChecks } from "./update";
import {
  addCustomAgentPref,
  agentSendScope,
  agentSessionTools,
  archivedSessions,
  archiveSessionsBatch,
  type AutoArchiveDays,
  autoArchiveDays,
  autoRetryChoice,
  clearArchivedSessionPref,
  ensureWorkspaceListed,
  forgetWorkspace,
  isSessionArchived,
  isWorkspaceCollapsed,
  lastActiveWorkspace,
  loadPrefs,
  onDaemonPrefsChange,
  preferredAgentId,
  preferredRuntimeMode,
  recentWorkspaces,
  rememberAutoRetry,
  rememberSessionChoice,
  rememberWorkspace,
  removeCustomAgentPref,
  runInBackground,
  setAgentOverride,
  setAutoArchiveDays,
  setGroupCollapsed,
  setPreferredAgentId,
  setPreferredRuntimeMode,
  sessionTreeDepth,
  sessionTreeMax,
  setSessionArchived,
  setWallpaperAdjustmentPref,
  setWallpaperEffectPref,
  setWallpaperFolderPref,
  setWallpaperPref,
  setWallpaperThemeColorsPref,
  setWorkspaceCollapsed,
  storedAgentOverrides,
  storedCustomAgents,
  storedSessionChoice,
  wallpaper,
  wallpaperEffect,
  wallpaperFolder,
  wallpaperHistory,
  wallpaperSource,
  wallpaperThemeColors,
  worktreeIsolationDefault,
} from "./prefs";

/**
 * The app's state: the active coding agent harness (Pi, Claude Code, Codex,
 * OpenCode, Cursor, or custom ACP), its session, portable context handoff,
 * git worktree isolation, and the session daemon's registry of every session
 * it keeps alive — the app's own one included.
 *
 * The signals are private; screens read the accessors and call the actions below.
 */

// ── State ───────────────────────────────────────────────────────────────────

/** Where the active agent process is in its life. */
export type Phase = { name: "starting" } | { name: "ready" } | { name: "failed"; title: string; detail: string };

/** What a run is doing right now, for the activity line and Pip. */
export type Activity =
  | { kind: "idle" }
  | { kind: "thinking" }
  | { kind: "writing" }
  | { kind: "tool"; name: string }
  | { kind: "compacting" }
  | { kind: "retrying"; attempt: number; maxAttempts: number; reason: string };

export interface ToastAction {
  label: string;
  onPress: () => void;
}

export interface Toast {
  id: number;
  tone: "info" | "warning" | "error" | "success";
  text: string;
  icon?: IconName;
  action?: ToastAction;
}

export interface Attachment extends ImageContent {
  name: string;
}

/** Settings on `section`; `agent` names the agent whose configuration is open inside Agents. */
export type View = { name: "chat" } | { name: "settings"; section: SettingsSection; agent?: string };
export type SettingsSection = "general" | "agents" | "sessions" | "archive" | "usage" | "about";

const phase = signal<Phase>({ name: "starting" });
const workspace = signal("");
const state = signal<SessionState | undefined>(undefined);
const models = signal<Model[]>([]);
const levels = signal<ThinkingLevel[]>(["off"]);
const stats = signal<SessionStats | undefined>(undefined);
const usage = signal<UsageStats>(EMPTY_USAGE);
const commands = signal<SlashCommand[]>([]);
const sessions = signal<SessionSummary[]>([]);
const sessionsByWorkspace = signal<Record<string, SessionSummary[]>>({});
const sessionsLoaded = signal(false);
const rows = signal<Row[]>([]);
const running = signal(false);
/** Stream deltas push the same activity dozens of times a second; only a real change broadcasts. */
const sameActivity = (a: Activity, b: Activity): boolean => {
  if (a.kind !== b.kind) return false;
  if (a.kind === "tool" && b.kind === "tool") return a.name === b.name;
  if (a.kind === "retrying" && b.kind === "retrying") return a.attempt === b.attempt && a.maxAttempts === b.maxAttempts && a.reason === b.reason;
  return true;
};
const activity = signal<Activity>({ kind: "idle" }, { equals: sameActivity });
const runStartedAt = signal(0);
const cheer = signal(false);
const queue = signal<{ steering: string[]; followUp: string[] }>({ steering: [], followUp: [] });
const bashRunning = signal(false);
const dialogs = signal<ExtensionUiDialog[]>([]);
const statuses = signal<Record<string, string>>({});
const widgets = signal<Record<string, { lines: string[]; below: boolean }>>({});
const toasts = signal<Toast[]>([]);
const credentials = signal<Record<string, CredentialKind>>({});
const view = signal<View>({ name: "chat" });
const draft = signal("");
const attachments = signal<Attachment[]>([]);
const composerFocus = signal(0, { equals: false });
/** Ticks when something outside the model chip (`/model`) asks for its list. */
const modelPickerAsk = signal(0, { equals: false });
const scrollToEnd = signal(0, { equals: false });
const landed = signal(0);
const paletteOpen = signal(false);
const compareOpen = signal(false);
const renaming = signal(false);
const busy = signal(false);
/** Where a session change under way is heading: a saved file, or no file for a fresh draft. */
const heading = signal<Heading | undefined>(undefined);
/**
 * The change under way has nothing of its destination to show yet: what was
 * on screen is on its way out, and the chat waits. Never on at a cold start
 * (there is nothing to leave), nor when the destination is already on screen.
 */
const leaving = signal(false);
/** Ticks when a session change puts its destination on screen: with the click when it can, else as it lands. */
const arrived = signal(0);
/** Session files whose background run settled (or a new answer landed) since the user last opened them. */
const unreadSessions = signal<string[]>([]);

// External Agent Harnesses & Session Daemon state
const agents = signal<AgentHarnessStatus[]>(defaultAgentStatuses());
const currentAgentId = signal<string>("pi");
const currentRuntimeMode = signal<RuntimeMode>("full-access");
const pendingHandoff = signal<{ fromAgent: string; toAgent: string; context: string } | undefined>(undefined);
const gitInfo = signal<{ isGitRepo: boolean; root?: string; branch?: string; dirty?: boolean; worktrees?: WorktreeInfo[] }>({ isGitRepo: false });
/** Every session the daemon has told the app about, pushed whole on each registry change. */
const daemonSessionList = signal<DaemonSession[]>([]);
/** The daemon session the open conversation is attached to. */
const openDaemonId = signal<string | undefined>(undefined);

export const sidecarPhase = () => phase();
export const workspacePath = () => workspace();
export const sessionState = () => state();
export const availableModels = () => models();
export const thinkingLevels = () => levels();
export const sessionStats = () => stats();
/** Token use and cost across every saved session on this machine (`sidecar/usage-stats.mjs`). */
export const usageStats = () => usage();
export interface ArchivedSessionItem {
  id: string;
  session: SessionSummary;
  cwd: string;
  archivedAt: number;
}

export const savedSessions = computed<SessionSummary[]>(() => sessions().filter((s) => !isSessionArchived(s.path)));
export const workspaceSessions = computed<Record<string, SessionSummary[]>>(() => {
  const raw = sessionsByWorkspace();
  const out: Record<string, SessionSummary[]> = {};
  for (const [cwd, list] of Object.entries(raw)) {
    out[cwd] = list.filter((s) => !isSessionArchived(s.path));
  }
  return out;
});
export const archivedSessionItems = computed<ArchivedSessionItem[]>(() => {
  const map = archivedSessions();
  const activeCwd = workspace();
  const byCwd = sessionsByWorkspace();
  const seen = new Set<string>();
  const out: ArchivedSessionItem[] = [];
  const collect = (cwd: string, list: readonly SessionSummary[]) => {
    for (const session of list) {
      const meta = map[session.path];
      if (!meta || seen.has(session.path)) continue;
      seen.add(session.path);
      out.push({
        id: `archived:${session.path}`,
        session,
        cwd: meta.cwd || cwd,
        archivedAt: meta.archivedAt || session.modified,
      });
    }
  };
  if (activeCwd) collect(activeCwd, sessions());
  for (const [cwd, list] of Object.entries(byCwd)) {
    if (cwd === activeCwd) continue;
    collect(cwd, list);
  }
  out.sort((a, b) => b.archivedAt - a.archivedAt || b.session.modified - a.session.modified);
  return out;
});
export const isCurrentSessionArchived = computed(() => isSessionArchived(state()?.sessionFile));
export const canArchiveCurrentSession = computed(() => {
  const file = state()?.sessionFile;
  if (!file) return false;
  if (isSessionArchived(file)) return true;
  return (state()?.messageCount ?? 0) > 0 || sessions().some((s) => s.path === file);
});
export const sessionsReady = () => sessionsLoaded();
export const isRunning = () => running();
export const currentActivity = () => activity();
export const runStart = () => runStartedAt();
export const messageQueue = () => queue();
export const isBashRunning = () => bashRunning();
export const pendingDialog = () => dialogs()[0];
export const pendingDialogCount = () => dialogs().length;
export const extensionStatuses = () => statuses();
export const extensionWidgets = () => widgets();
export const activeToasts = () => toasts();
export const storedProviders = () => credentials();
export const currentView = () => view();
export const composerDraft = () => draft();
export const composerAttachments = () => attachments();
export const composerFocusTick = () => composerFocus();
export const modelPickerTick = () => modelPickerAsk();
export const scrollToEndTick = () => scrollToEnd();
export const isPaletteOpen = () => paletteOpen();
export const isCompareOpen = () => compareOpen();
export const isRenaming = () => renaming();
/** A session change (new, switch, restart) is under way: the chat waits rather than showing a half-loaded session. */
export const isSwitching = () => busy() || heading() !== undefined;
/** Ticks each time a session's conversation is put on screen whole, so the chat can settle it in once. */
export const sessionLandedTick = () => landed();
/**
 * The session a change under way will land on, so the sidebar can show where it
 * is going instead of the half-started states in between (a fresh process
 * reports a new session before it switches to the requested one).
 */
export const pendingSession = () => heading();
/** The open conversation is on its way out and its successor has not landed: the chat dims it and waits. */
export const isLeavingSession = () => leaving();
/** Ticks each time a session change shows its destination, so the chat settles it in once. */
export const sessionArrivedTick = () => arrived();
/** The change under way is heading for a fresh session, whose empty chat is already on screen. */
export const isDraftAhead = () => heading()?.welcome === true;

type Heading = {
  cwd: string;
  file?: string;
  daemonId?: string;
  keepTitle?: boolean;
  /** A fresh session's empty chat is shown ahead of the agent. */
  welcome?: boolean;
};

/**
 * Marks a session change as heading for `target` until `work` ends.
 *
 * A change answers the click, not the agent: a conversation seen before goes
 * on screen at once from `visited` (the agent's own history confirms or
 * replaces it as it lands), and so does a fresh session's empty chat. Only a
 * destination with nothing to show yet leaves the screen waiting (`leaving`).
 */
async function headFor<T>(goal: Heading, work: () => Promise<T>): Promise<T> {
  let target = goal;
  let shown = false;
  if (!goal.keepTitle) {
    const warm = phase().name === "ready";
    const welcome = !goal.file && !goal.daemonId && warm && hasModel();
    stashTranscript();
    const seen = goal.file ? visited.get(goal.file) : undefined;
    if (seen && goal.file) {
      visited.delete(goal.file);
      transcript = seen;
      ahead = { transcript: seen, file: goal.file };
      shown = true;
    } else if (welcome) {
      if (transcript.rows().length) transcript.load([]);
      target = { ...goal, welcome: true };
      shown = true;
    }
    if (shown) {
      early = true;
      shownVersion = -1;
      markTranscriptSeen();
    }
    // Only dim out the old content when there is actual content to leave behind.
    // A welcome/empty screen has nothing to fade — the new session's loading state
    // shows immediately instead, preventing a confusing blank white flash that
    // looks like a new session was created.
    const hadContent = rows().length > 0;
    batch(() => {
      heading.set(target);
      leaving.set(!shown && hadContent && (leaving() || warm));
      if (shown) {
        flush();
        landed.update((n) => n + 1);
        scrollToEnd.set(0);
        arrived.update((n) => n + 1);
      }
    });
  } else {
    heading.set(target);
  }
  const run = work();
  arrival = run.then(
    () => undefined,
    () => undefined,
  );
  try {
    return await run;
  } finally {
    if (heading() === target) {
      early = false;
      batch(() => {
        heading.set(undefined);
        if (leaving()) {
          leaving.set(false);
          arrived.update((n) => n + 1);
        }
      });
    }
  }
}

/** Whether a session is working, on screen or in the background (the daemon says so, not the screen). */
export function isSessionRunning(path: string) {
  if (path === state()?.sessionFile) return running() || bashRunning();
  const known = daemonSessionByFile(path);
  return known?.status === "working" || known?.status === "blocked";
}

/** Whether a background run finished with something the user has not seen yet. */
export function isSessionUnread(path: string) {
  return daemonSessionByFile(path)?.unread === true || unreadSessions().includes(path);
}

function markSessionUnread(path: string) {
  if (!unreadSessions().includes(path)) unreadSessions.set([...unreadSessions(), path]);
}

function markSessionRead(path: string | undefined) {
  if (path && unreadSessions().includes(path)) unreadSessions.set(unreadSessions().filter((p) => p !== path));
}

// ── Session daemon accessors ────────────────────────────────────────────────

/** Every session in the daemon's registry: the app's own, agent-started children, compare runs. */
export const daemonSessions = () => daemonSessionList();

/** A daemon session by its daemon id. */
export function daemonSessionOfId(id: string | undefined) {
  return id ? daemonSessionList().find((session) => session.id === id) : undefined;
}

/** A daemon session by the session file it holds. */
export function daemonSessionByFile(path: string | undefined) {
  return path ? daemonSessionList().find((session) => session.file === path) : undefined;
}

/** Cycle-safe depth-first walk of every descendant session under `rootId`. */
function descendantSessionsOf(rootId: string | undefined, all = daemonSessionList()): DaemonSession[] {
  if (!rootId) return [];
  const out: DaemonSession[] = [];
  const seen = new Set<string>([rootId]);
  const visit = (pid: string) => {
    for (const s of all) {
      if (s.parentId === pid && !seen.has(s.id)) {
        seen.add(s.id);
        out.push(s);
        visit(s.id);
      }
    }
  };
  visit(rootId);
  return out;
}

/** Sessions started under `sessionId` (every nested generation in tree order). */
export function childSessionsOfDaemon(sessionId: string | undefined): DaemonSession[] {
  return descendantSessionsOf(sessionId);
}

/** Sessions started under the session whose file is `path`, nested in the sidebar under it. */
export function childSessionsOf(path: string | undefined): DaemonSession[] {
  if (!path) return [];
  const own = daemonSessionByFile(path);
  return descendantSessionsOf(own?.id);
}

/** Sessions started under the OPEN session while it is still a draft (not yet in `savedSessions`). */
export function childSessionsOfOpen(): DaemonSession[] {
  const id = openDaemonId();
  if (!id) return [];
  const file = openFile();
  if (file && savedSessions().some((s) => s.path === file)) return [];
  return descendantSessionsOf(id);
}

/** Maps a child worktree directory back to its owning project folder so child worktrees don't clutter Workspaces. */
export function projectCwdOf(cwd: string, session?: DaemonSession): string {
  if (!cwd) return cwd;
  if (session?.worktree?.baseCwd) return session.worktree.baseCwd;
  if (session?.parentId && cwd.includes("/.pipi-worktrees/")) {
    const all = daemonSessionList();
    const seen = new Set<string>([session.id]);
    let cur: DaemonSession | undefined = session;
    while (cur?.parentId && !seen.has(cur.parentId)) {
      seen.add(cur.parentId);
      const up = all.find((s) => s.id === cur!.parentId);
      if (!up) break;
      if (up.worktree?.baseCwd) return up.worktree.baseCwd;
      if (!up.cwd.includes("/.pipi-worktrees/")) return up.cwd;
      cur = up;
    }
  }
  return cwd;
}

/** The session file open on screen — what the daemon lookups above key on. */
export const openFile = () => state()?.sessionFile;

/** The daemon id of the session on screen. */
export const currentDaemonId = () => openDaemonId();
export const currentSessionDaemonId = currentDaemonId;

/** The daemon's record of the session on screen. */
export const currentDaemonSession = computed(() => daemonSessionOfId(openDaemonId()));

/** The active project folder in the sidebar (maps open child worktree sessions back to their parent project). */
export const activeProjectPath = computed(() => {
  const target = heading();
  if (target) {
    const ds = target.daemonId ? daemonSessionOfId(target.daemonId) : daemonSessionByFile(target.file);
    return projectCwdOf(target.cwd, ds);
  }
  return projectCwdOf(workspace(), currentDaemonSession());
});

/** The session that started the session whose file is `path`, for the title bar's parent tag. */
export function sessionParentOf(path: string | undefined): { id: string; file?: string; cwd: string; title: string } | undefined {
  const all = daemonSessionList();
  const own = all.find((session) => session.file === path);
  const parent = own?.parentId ? all.find((session) => session.id === own.parentId) : undefined;
  return parent ? { id: parent.id, file: parent.file, cwd: parent.cwd, title: daemonSessionTitle(parent) } : undefined;
}

/** The parent of whichever session is currently open on screen (works with or without a session file). */
export const currentParentSession = computed((): { id: string; file?: string; cwd: string; title: string } | undefined => {
  const all = daemonSessionList();
  const target = heading();
  const own = target
    ? (target.daemonId ? all.find((s) => s.id === target.daemonId) : target.file ? all.find((s) => s.file === target.file) : undefined)
    : (daemonSessionOfId(openDaemonId()) ?? (openFile() ? all.find((s) => s.file === openFile()) : undefined));
  const parent = own?.parentId ? all.find((s) => s.id === own.parentId) : undefined;
  return parent ? { id: parent.id, file: parent.file, cwd: parent.cwd, title: daemonSessionTitle(parent) } : undefined;
});

/**
 * Sessions working under the open one: the open session itself is at rest, so
 * this is the "waiting on N sessions" the activity line and the Stop affordance use.
 */
export const waitingCount = computed(
  () => descendantSessionsOf(openDaemonId()).filter((session) => session.status === "working" || session.status === "blocked").length,
);

/** Count of all daemon sessions currently running or waiting on confirmation across the machine. */
export const activeDaemonSessionCount = computed(
  () => daemonSessionList().filter((session) => session.status === "working" || session.status === "blocked").length,
);

/** The highest runtime permission mode the open session is allowed to hold (clamped by all ancestors). */
export const currentRuntimeCeiling = computed<RuntimeMode>(() => {
  const all = daemonSessionList();
  const seen = new Set<string>();
  let ceiling: RuntimeMode = "full-access";
  let cur = currentDaemonSession();
  if (cur) seen.add(cur.id);
  while (cur?.parentId && !seen.has(cur.parentId)) {
    seen.add(cur.parentId);
    const parent = all.find((s) => s.id === cur!.parentId);
    if (!parent) break;
    if (runtimeModeRank(parent.runtimeMode) < runtimeModeRank(ceiling)) {
      ceiling = parent.runtimeMode;
    }
    cur = parent;
  }
  return ceiling;
});

// Multi-agent accessors
export const availableAgents = () => agents();
export const activeAgentId = () => currentAgentId();
export const activeAgent = computed<AgentHarnessStatus>(() => {
  const id = currentAgentId();
  return agents().find((a) => a.id === id) ?? agents()[0] ?? defaultAgentStatuses()[0];
});
export const runtimeMode = () => currentRuntimeMode();
export const gitWorkspaceInfo = () => gitInfo();

/**
 * pipi's own slash commands: what the shell itself does from the composer, the
 * same names on every engine, so what the user learned on one agent holds on
 * the next. Each is an action the app already has elsewhere (the palette, the
 * chips), offered only where the engine driving the session can do it:
 * compaction and HTML export are Pi's RPC and the bridge has neither, so they
 * are listed on Pi alone (an engine that compacts reports its own `/compact`).
 *
 * The shell owns the session and the controls around it: it keeps the
 * transcript, names the session, and hands every turn its model. An engine's
 * own command for one of those would change the engine behind the shell's back
 * — Claude Code's `/clear` starts a new session of its own while pipi still
 * shows the old conversation — so the names engines use for them are `aliases`
 * here: `/clear` is `/new` and `/rename` is `/name`, on any engine.
 */
const appCommands = computed<ComposerCommand[]>(() => {
  const onPi = activeAgent().driver === "pi";
  const own = (name: string, description: string, keywords: string[], more: Partial<ComposerCommand> = {}): ComposerCommand => ({
    name,
    description,
    keywords,
    source: "app",
    ...more,
  });
  return [
    own("new", tr("Start a new session", "新建会话"), ["reset", "新建", "新会话", "清空"], { aliases: ["clear"] }),
    ...(onPi ? [own("compact", tr("Compact the context", "压缩上下文"), ["summarize", "压缩", "上下文"], { argumentHint: tr("[instructions]", "[要求]") })] : []),
    own("model", tr("Choose the model", "选择模型"), ["models", "模型", "切换模型"]),
    own("name", tr("Rename this session", "重命名会话"), ["title", "重命名", "命名", "标题"], { argumentHint: tr("[name]", "[名称]"), aliases: ["rename"] }),
    own("copy", tr("Copy the last reply", "复制最后一条回复"), ["复制", "拷贝"]),
    ...(onPi ? [own("export", tr("Export the session as HTML", "导出为 HTML"), ["html", "导出"])] : []),
    own("delegate", tr("Hand a task to another agent", "把任务委派给另一个智能体"), ["subagent", "委派", "子智能体"], {
      argumentHint: tr("<agent> <task>", "<智能体> <任务>"),
      needsArguments: true,
      options: agents()
        .filter((agent) => agent.available)
        .map((agent) => ({ value: agent.id, description: agent.name })),
    }),
    own("parallel", tr("Run several agents on one task", "多个智能体并行处理同一任务"), ["orchestrate", "pipeline", "并行", "编排", "流水线"], { argumentHint: tr("[task]", "[任务]") }),
    own("settings", tr("Open Settings", "打开设置"), ["preferences", "config", "设置", "偏好"]),
  ];
});

/** Plumbing an engine registers for its host, not for the user: pipi's own Pi extension (`pipi-runtime-mode`), an engine's private names. */
const INTERNAL_COMMAND = /^(pipi-|__)/;

/** The agent's own commands that are the user's to run: not its plumbing, and not under a name pipi owns. */
const agentCommands = computed<SlashCommand[]>(() => {
  const own = appCommands();
  return commands().filter((command) => !INTERNAL_COMMAND.test(command.name) && !own.some((mine) => answersTo(mine, command.name)));
});

/**
 * Every command the composer offers: pipi's own, then the agent's. A name
 * pipi owns (an alias included) is pipi's — as a TUI's built-ins come before
 * its templates — so what the menu lists is exactly what `send` runs.
 */
export const slashCommands = computed<ComposerCommand[]>(() => [...appCommands(), ...agentCommands()]);

/** Rows shown in the main chat. */
export const transcriptRows = computed<Row[]>(() => rows());

/** Whether a model is selected that the active agent can call. */
export const hasModel = computed(() => {
  const model = state()?.model;
  return !!model && model.provider !== "unknown" && models().length > 0;
});

/** The session's title: its name, else the start of its first message. */
export const currentTitle = computed(() => {
  const target = heading();
  if (target && !target.keepTitle) {
    if (target.daemonId) {
      const ds = daemonSessionOfId(target.daemonId);
      if (ds) return daemonSessionTitle(ds);
    }
    if (!target.file) return tr("New session", "新会话");
    const list = target.cwd === workspace() ? sessions() : (sessionsByWorkspace()[target.cwd] ?? []);
    const found = list.find((s) => s.path === target.file) ?? sessions().find((s) => s.path === target.file);
    if (found) return sessionTitle(found, tr("New session", "新会话"));
  }
  const name = state()?.sessionName;
  if (name) return name;
  const first = rows().find((row) => row.kind === "user");
  if (first?.kind === "user" && first.text) {
    return sessionTitle({ firstMessage: first.text }, tr("New session", "新会话"));
  }
  const ds = currentDaemonSession();
  if (ds && (ds.parentId || ds.initiator === "external") && ds.title) {
    return ds.title;
  }
  return tr("New session", "新会话");
});

/** What Pip feels: the one place the app's state becomes the mascot's mood. */
export const pipMood = computed<Mood>(() => {
  const now = phase();
  if (now.name === "failed") return "error";
  if (now.name === "starting" || leaving() || (isSwitching() && !rows().length && !isDraftAhead())) return "sleep";
  if (cheer()) return "happy";
  const subRunning = waitingCount() > 0;
  if (!running() && !subRunning) return "idle";
  if (!running() && subRunning) return "work";
  const doing = activity();
  if (doing.kind === "writing") return "write";
  if (doing.kind === "tool") return "work";
  return "think";
});

// ── Processes & Transcripts ─────────────────────────────────────────────────

const STORE_TEARDOWN_KEY = "__pipiStoreTeardown";

let client: PiClient | undefined;
let generation = 0;
let transcript = new Transcript(() => activeLanguage());
/**
 * Conversations the reader left at rest, by session file: opening one again
 * shows it with the click instead of after the agent has loaded it.
 */
const visited = new Map<string, Transcript>();
const VISITED_LIMIT = 8;
/** The conversation shown from `visited`, until the agent's own history confirms or replaces it. */
let ahead: { transcript: Transcript; file: string } | undefined;
/** The change under way showed its destination before the agent got there: a change that fails puts the agent's session back. */
let early = false;
/** Settles when the session change under way is over, however it ends. */
let arrival: Promise<void> | undefined;
/**
 * When the open agent last went away on its own. One that does is started
 * again under its session (`revive`); one that will not stay up is not
 * started for ever — past `REVIVE_LIMIT` in `REVIVE_WINDOW_MS` the screen says so.
 */
let lostAt: number[] = [];
const REVIVE_LIMIT = 3;
const REVIVE_WINDOW_MS = 60_000;
/** Settles once the agent being started again has its session open (or could not be started): commands wait on it. */
let reopening: Promise<void> | undefined;
/** Settles once that agent is as the reader left it, model and all: a message waits on it. */
let revival: Promise<void> | undefined;
/**
 * One shared session daemon for the whole app: it owns every agent process —
 * the open session's included — so leaving a session only detaches the app's
 * view of it, never ends it. `clientDaemonId` ties each `PiClient` to the
 * daemon session it is attached to.
 */
let daemonClient: DaemonClient | undefined;
let daemonStarting: Promise<DaemonClient | undefined> | undefined;
const clientDaemonId = new Map<PiClient, string>();
let flushFrame: number | undefined;
let shownVersion = -1;
let toastId = 0;
const toastTimers = new Map<number, ReturnType<typeof setTimeout>>();
/** The reader asked the open run to stop. However it then ends is their doing: Pi settles a retry cancelled mid-wait as not aborted. */
let stopAsked = false;
let bashRequestId: string | undefined;

/** Publishes the transcript to the screen: synchronized to display VSync, at most once a frame. */
function flushSoon() {
  if (flushFrame !== undefined) return;
  flushFrame = requestAnimationFrame(flush);
}

function flush() {
  if (flushFrame !== undefined) cancelAnimationFrame(flushFrame);
  flushFrame = undefined;
  if (transcript.version === shownVersion) return;
  shownVersion = transcript.version;
  rows.set(transcript.rows());
}

/**
 * Sets the open conversation aside for `visited` as a session change leaves
 * it, a new transcript taking its place. Its rows stay on screen until the
 * next flush: the chat dims them while the destination loads. Running sessions
 * are stashed too — the daemon keeps the process, and when the user switches
 * back the stashed rows (including any in-progress thinking) are shown at once
 * while the re-attached event stream catches up.
 */
function stashTranscript() {
  const shownAhead = ahead?.transcript === transcript ? ahead : undefined;
  ahead = undefined;
  const file = shownAhead ? shownAhead.file : phase().name === "ready" ? state()?.sessionFile : undefined;
  // Always give the next session a fresh transcript; keep the previous one for
  // immediate restore. bashRunning is not stashed — a shell task has no rows
  // of its own to preserve. An empty transcript is not worth caching.
  const previous = transcript;
  transcript = new Transcript(() => activeLanguage());
  shownVersion = -1;
  if (!file || bashRunning() || !previous.rows().length) return;
  visited.delete(file);
  visited.set(file, previous);
  for (const oldest of visited.keys()) {
    if (visited.size <= VISITED_LIMIT) break;
    visited.delete(oldest);
  }
}

/** Whether two transcripts show the same conversation (row ids are minted per transcript and never match). */
function sameRows(a: Row[], b: Row[]) {
  if (a.length !== b.length) return false;
  const shape = (rows: Row[]) => JSON.stringify(rows, (key, value) => (key === "id" ? undefined : value));
  return shape(a) === shape(b);
}

/**
 * Puts the open session's messages on screen. A conversation shown ahead from
 * `visited` that the agent's history matches stays as it is — the same rows,
 * nothing for the list to do; one that moved on since is replaced.
 *
 * When switching back to a still-running session the agent's history does not
 * include the in-progress message yet, so it has fewer rows than what the
 * stash showed. Keep the stash in that case — the re-attached event stream
 * will fill in what happens next without a visible gap.
 */
function landHistory(messages: AgentMessage[]) {
  const shown = ahead?.transcript === transcript;
  ahead = undefined;
  early = false;
  if (shown) {
    const fresh = new Transcript(() => activeLanguage());
    fresh.load(messages);
    if (sameRows(fresh.rows(), transcript.rows())) return;
    // The agent's history lags the stashed view: an in-progress run has not
    // yet written its streaming message to the session file. Keep showing the
    // stash so the thinking rows stay on screen while the stream catches up.
    if (fresh.rows().length < transcript.rows().length) return;
    transcript = fresh;
    shownVersion = -1;
  } else {
    transcript.load(messages);
  }
  markTranscriptSeen();
  flush();
  landed.update((n) => n + 1);
  scrollToEnd.set(0);
}

/** Marks every row the transcript can put on screen as already seen: a landing never replays row entrances. */
function markTranscriptSeen() {
  markRowsSeen(displayRowIds(transcript.rows()));
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const STARTUP_RPC_TIMEOUT_MS = 20_000;

function withStartupTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(tr(`Timed out waiting for ${label}`, `等待 ${label} 响应超时`)));
    }, STARTUP_RPC_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Sends a command to the running agent; rejects when there is none. */
function request<C extends CommandType>(
  type: C,
  ...args: {} extends Commands[C]["args"] ? [args?: Commands[C]["args"]] : [args: Commands[C]["args"]]
): Promise<Commands[C]["data"]> {
  // An agent on its way back answers once its session is open again, not before and not never.
  if (reopening) return reopening.then(() => request(type, ...args));
  if (!client) return Promise.reject(new PiError(type, tr("Agent is not running", "智能体未运行")));
  return client.request(type, ...args);
}

// ── Session Daemon Wiring ───────────────────────────────────────────────────

/** Daemon sessions the store itself ended — their pushes are expected, not news. */
const quietSessions = new Set<string>();

/** What a daemon session is called on screen: its file's listing name/first message when there is one. */
function daemonSessionTitle(session: DaemonSession): string {
  const summary =
    (session.cwd === workspace() ? sessions() : (sessionsByWorkspace()[session.cwd] ?? [])).find((s) => s.path === session.file) ??
    sessions().find((s) => s.path === session.file);
  return summary ? sessionTitle(summary, session.title) : session.title;
}

/**
 * The daemon's registry replaces its entry for `session.id`, in place. A push is also how a run off
 * screen reports: a settle, a stop or a question is said once, and its sidebar rows re-read their
 * workspace list (a file first appearing is how a fresh session gets a row at all).
 */
function upsertDaemonSession(session: DaemonSession) {
  const prev = daemonSessionList().find((known) => known.id === session.id);
  daemonSessionList.update((list) => {
    const at = list.findIndex((known) => known.id === session.id);
    if (at < 0) return [...list, session];
    const next = list.slice();
    next[at] = session;
    return next;
  });
  // The open session's rows refresh through its own stream (a settle re-lists, as before); every
  // other session reports only here — a status, title or file change re-reads its workspace list.
  const open = client !== undefined && session.id === clientDaemonId.get(client);
  if (
    prev
      ? !open && (session.status !== prev.status || session.title !== prev.title || session.file !== prev.file)
      : Boolean(session.file)
  ) {
    void refreshSessions(session.cwd);
  }
  // The open session speaks through its own stream — but only while a client is attached to it:
  // one let go of (in the gap before the next attach) reports off screen like any other.
  if (!prev || open) return;
  const wasLive = prev.status === "working" || prev.status === "blocked";
  if (quietSessions.delete(session.id)) return;
  const title = daemonSessionTitle(session);
  if (session.status === "idle" && wasLive && session.unread) {
    toast("success", tr(`${title} finished in the background.`, `${title} 已在后台完成。`));
  } else if (session.status === "failed" && wasLive) {
    toast("warning", tr(`${title} stopped in the background.`, `${title} 已在后台停止。`));
  } else if (session.status === "blocked" && prev.status !== "blocked") {
    toast("info", tr(`${title} is waiting for you.`, `${title} 正在等待你的确认。`));
  }
}

/** Ends a daemon session the store asked to end, so its last push does not read as a death. */
function quietKill(sessionId: string) {
  quietSessions.add(sessionId);
  void daemonClient?.killSession(sessionId).catch(() => undefined);
}

/**
 * The one connection to the session daemon, made on first attach. A lost link
 * clears `daemonClient` so the next connect makes a new one; the sessions
 * themselves were never the app's, so nothing is recovered for them.
 */
async function ensureDaemon(): Promise<DaemonClient | undefined> {
  if (daemonClient) return daemonClient;
  if (!daemonStarting) {
    daemonStarting = (async () => {
      try {
        const connect = backend().connectDaemon;
        if (!connect) return undefined;
        const started = await connect({
          onSession: upsertDaemonSession,
          onExit: () => {
            daemonClient = undefined;
          },
        });
        daemonClient = started;
        pushDaemonConfig();
        return started;
      } catch (error) {
        toast("warning", `${tr("The session daemon could not start", "会话守护进程启动失败")}: ${message(error)}`);
        return undefined;
      } finally {
        daemonStarting = undefined;
      }
    })();
  }
  return daemonStarting;
}

/** Pushes the agent roster and the session-tree rules the daemon enforces. */
export function pushDaemonConfig() {
  daemonClient?.configure({
    agents: availableAgents(),
    overrides: storedAgentOverrides(),
    customAgents: storedCustomAgents(),
    allowAgentTools: agentSessionTools(),
    sendScope: agentSendScope(),
    maxDepth: sessionTreeDepth(),
    maxRunning: sessionTreeMax(),
    worktreeDefault: worktreeIsolationDefault(),
    linger: runInBackground(),
  });
}

/** Tells the daemon which session file the open process is on, and that the user is looking at it. */
function reportSessionFile() {
  const did = openDaemonId();
  if (!did) return;
  daemonClient?.reportFile(did, state()?.sessionFile);
  daemonClient?.markRead(did);
}

/** The MCP snippet an agent pipi did not start can use to join this machine's session daemon (`Settings → Sessions`). */
export async function externalMcpConfig(): Promise<string> {
  const daemon = await ensureDaemon();
  if (!daemon) throw new Error(tr("The session daemon is not running", "会话守护进程未运行"));
  const { url, token } = await daemon.externalMcp();
  return JSON.stringify({ mcpServers: { pipi: { type: "http", url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);
}

/** Installs the `pipi` command line tool (sessions from a terminal or script), resolving to where it landed. */
export async function installPipiCli(): Promise<string> {
  const daemon = await ensureDaemon();
  if (!daemon) throw new Error(tr("The session daemon is not running", "会话守护进程未运行"));
  return daemon.installCli();
}

let unlistenDaemonPrefs: (() => void) | undefined;

/** Lets go of everything this store evaluation holds (invoked before a hot-reload re-boot). The daemon's sessions are not its to stop. */
function teardownStore() {
  generation++;
  unlistenDaemonPrefs?.();
  unlistenDaemonPrefs = undefined;
  if (flushFrame !== undefined) cancelAnimationFrame(flushFrame);
  flushFrame = undefined;
  const active = client;
  client = undefined;
  for (const started of clientDaemonId.keys()) started.close(0);
  clientDaemonId.clear();
  active?.close(0);
  daemonClient?.close();
  daemonClient = undefined;
  daemonStarting = undefined;
  stopAppUpdateChecks();
}

// ── Boot & Harness Lifecycle ────────────────────────────────────────────────

/** Starts pipi, probes installed coding agents, and launches the preferred agent harness. */
export async function boot() {
  const g = globalThis as Record<string, unknown>;
  const prevTeardown = g[STORE_TEARDOWN_KEY] as (() => void) | undefined;
  prevTeardown?.();
  killAllSidecars();
  g[STORE_TEARDOWN_KEY] = teardownStore;
  unlistenDaemonPrefs = onDaemonPrefsChange(() => pushDaemonConfig());

  await loadPrefs();
  batch(() => {
    currentAgentId.set(preferredAgentId());
    currentRuntimeMode.set(preferredRuntimeMode());
    agents.set(defaultAgentStatuses(storedCustomAgents(), storedAgentOverrides()));
  });
  const list = recentWorkspaces();
  const last = lastActiveWorkspace();
  const first = (last && list.includes(last) ? last : list[0]) ?? backend().home();
  void refreshAgents();
  await start(first, undefined, preferredAgentId());
  if (phase().name !== "failed") {
    void refreshAllWorkspaceSessions();
  }
  startAppUpdateChecks();
}

export async function refreshAgents() {
  const probe = backend().probeAgents;
  if (!probe) return;
  try {
    const found = await probe({
      overrides: storedAgentOverrides(),
      customAgents: storedCustomAgents(),
    });
    if (found.length) {
      agents.set(found);
      pushDaemonConfig();
    }
  } catch (error) {
    if (phase().name !== "failed") {
      toast("warning", `${tr("Could not scan coding agents", "无法扫描已安装的编码智能体")}: ${message(error)}`);
    }
  }
}

export async function refreshGitWorkspace(cwd = workspace()) {
  const fn = backend().worktreeStatus;
  if (!fn || !cwd) return;
  try {
    const info = await fn(cwd);
    if (cwd === workspace()) gitInfo.set(info);
  } catch {
    if (cwd === workspace()) gitInfo.set({ isGitRepo: false });
  }
}

/**
 * (Re)starts the chosen agent harness (`agentId`) in `cwd`.
 * When `preserveRows` is supplied (Portable Context Handoff when switching agents
 * mid-session), existing visible rows remain on screen with a handoff divider!
 */
function start(
  cwd: string,
  reopen?: string,
  targetAgentId = currentAgentId(),
  preserveRows?: { previousRows: Row[]; handoffTitle: string; handoffDetail: string },
  daemonId?: string,
) {
  return headFor({ cwd, file: reopen, daemonId, keepTitle: Boolean(preserveRows) }, () =>
    launch(cwd, reopen, targetAgentId, preserveRows, daemonId),
  );
}

async function launch(
  cwd: string,
  reopen: string | undefined,
  targetAgentId: string,
  preserveRows?: { previousRows: Row[]; handoffTitle: string; handoffDetail: string },
  daemonId?: string,
) {
  const mine = ++generation;
  closeActive();
  if (flushFrame !== undefined) cancelAnimationFrame(flushFrame);
  flushFrame = undefined;

  const spec = agents().find((a) => a.id === targetAgentId);
  const effectiveAgentId = spec ? spec.id : "pi";

  batch(() => {
    phase.set({ name: "starting" });
    workspace.set(cwd);
    // Another agent's commands are not this one's: its own arrive once it has started.
    if (effectiveAgentId !== currentAgentId()) commands.set([]);
    currentAgentId.set(effectiveAgentId);
    if (!reopen && !daemonId) currentRuntimeMode.set(preferredRuntimeMode());
    state.set(undefined);
    running.set(false);
    activity.set({ kind: "idle" });
    queue.set({ steering: [], followUp: [] });
    dialogs.set([]);
    statuses.set({});
    widgets.set({});
    if (!preserveRows) {
      const rootCwd = projectCwdOf(cwd, daemonId ? daemonSessionOfId(daemonId) : daemonSessionByFile(reopen));
      const cached = sessionsByWorkspace()[rootCwd] ?? sessionsByWorkspace()[cwd];
      sessions.set(cached ?? []);
      // A folder listed before (even as empty) stays listed while its agent starts again.
      sessionsLoaded.set(cached !== undefined);
    }
    bashRunning.set(false);
  });

  if (preserveRows) {
    transcript.seedRows(preserveRows.previousRows);
    transcript.summary(preserveRows.handoffTitle, preserveRows.handoffDetail);
    flush();
    markTranscriptSeen();
  } else if (!ahead && !leaving()) {
    // Nothing of the destination to show and nothing on its way out (a cold start, a restart).
    transcript.load([]);
    flush();
    markTranscriptSeen();
  }

  try {
    const agentLabel = spec?.name ?? "Pi";
    const started = await connect(cwd, effectiveAgentId, mine, reopen, daemonId);
    if (!started) return;
    const first = await withStartupTimeout(started.request("get_state"), agentLabel);
    if (mine !== generation) return;
    rememberWorkspace(projectCwdOf(cwd, currentDaemonSession()));
    batch(() => {
      state.set(first);
      phase.set({ name: "ready" });
    });
    const retry = autoRetryChoice();
    if (retry !== undefined) request("set_auto_retry", { enabled: retry }).catch(() => undefined);
    if ((reopen || daemonId) && !preserveRows) {
      // The daemon already put the process on `reopen`'s session file before answering the attach.
      const [, history] = await Promise.all([
        refreshState(),
        withStartupTimeout(request("get_messages"), agentLabel),
      ]);
      if (mine !== generation) return;
      landHistory(history.messages);
      // The conversation is on screen: the session change is over, its pickers fill in behind it.
      void finishLaunch().catch(failLaunch);
      return;
    }
    await finishLaunch();
  } catch (error) {
    failLaunch(error);
  }

  /** What the open session supports: models, commands, levels, the lists around it. */
  async function finishLaunch() {
    const listCwd = projectCwdOf(cwd, currentDaemonSession());
    await Promise.all([
      refreshModels(),
      refreshCommands(),
      refreshSessions(listCwd),
      refreshCredentials(),
      refreshGitWorkspace(cwd),
    ]);
    if (mine !== generation) return;
    if (!reopen && !daemonId) {
      await applySessionChoices();
    }
    if (!preserveRows) {
      if (reopen || daemonId) {
        await Promise.all([refreshState(), refreshLevels(), refreshStats()]);
      } else {
        await syncSession();
      }
    } else {
      await Promise.all([refreshState(), refreshLevels(), refreshStats()]);
      scrollToEnd.set(0);
    }
  }

  function failLaunch(error: unknown) {
    if (mine !== generation) return;
    closeActive();
    // A process that ended while starting has said why already (`routeExit`): once is enough.
    if (phase().name === "failed") return;
    const agentTitle = spec?.name ?? "Pi";
    const title = error instanceof SidecarError ? error.message : tr(`${agentTitle} could not start`, `${agentTitle} 无法启动`);
    const detail = error instanceof SidecarError ? error.hint : message(error);
    phase.set({ name: "failed", title, detail });
    toast("error", detail ? `${title} — ${detail}` : title);
  }
}

/**
 * Attaches to a daemon session for `agentId` in `cwd` — the daemon spawns its
 * process on first attach (and switches it to `reopen`'s session file before
 * answering) — and makes it the open agent, not yet asked anything.
 * `undefined` when another start overtook this one (`mine`).
 */
async function connect(cwd: string, agentId: string, mine: number, reopen?: string, daemonId?: string): Promise<PiClient | undefined> {
  const spec = agents().find((a) => a.id === agentId);
  const driver = spec?.driver ?? (agentId === "pi" ? "pi" : "acp");
  const agentLabel = spec?.name ?? "Pi";
  const daemon = await ensureDaemon();
  if (mine !== generation) return undefined;
  if (!daemon) throw new Error(tr("The session daemon is not running", "会话守护进程未运行"));
  const customCfg = storedCustomAgents().find((c) => c.id === agentId);
  const override = storedAgentOverrides()[agentId];
  // A session the daemon already holds is found again by its registry id; its file matches too.
  const rootCwd = projectCwdOf(cwd, daemonId ? daemonSessionOfId(daemonId) : daemonSessionByFile(reopen));
  const known = reopen
    ? (sessions().find((s) => s.path === reopen) ??
       (sessionsByWorkspace()[rootCwd] ?? []).find((s) => s.path === reopen) ??
       (sessionsByWorkspace()[cwd] ?? []).find((s) => s.path === reopen))
    : undefined;
  const { transport, session } = await daemon.attach({
    id: daemonId ?? daemonSessionByFile(reopen)?.id,
    file: reopen,
    title: known ? sessionTitle(known, "") : undefined,
    cwd,
    agentId,
    agentName: spec?.name ?? agentId,
    driver,
    runtimeMode: currentRuntimeMode(),
    binaryPath: override?.binaryPath,
    extraArgs: override?.extraArgs,
    customAgent: customCfg,
  });

  if (mine !== generation) {
    transport.kill();
    return undefined;
  }
  let started: PiClient | undefined;
  started = new PiClient(transport, {
    onEvent: (event) => routeEvent(started, event),
    onUiRequest: (ui) => routeUiRequest(started, ui),
    onExit: (exit, stderr) => routeExit(started, exit, stderr, agentLabel),
  });
  client = started;
  clientDaemonId.set(started, session.id);
  batch(() => {
    openDaemonId.set(session.id);
    currentRuntimeMode.set(session.runtimeMode);
    if (session.agentId && session.agentId !== currentAgentId()) currentAgentId.set(session.agentId);
  });
  return started;
}

/**
 * Starts the open agent again under its session after its process went away
 * on its own (`routeExit`), on any engine. Nothing on screen changes for it:
 * the conversation, the draft and the pickers stay, commands sent meanwhile
 * wait (`request`), and the session's file is opened again in the new
 * process. Only a run that was cut short is said — it cannot be resumed — and
 * the conversation is then what the session has on file.
 */
function revive(agentLabel: string, cutShort: boolean, lost: Extract<Phase, { name: "failed" }>) {
  const mine = ++generation;
  const cwd = workspace();
  const agentId = currentAgentId();
  const known = state();
  const file = known?.sessionFile && ((known.messageCount ?? 0) > 0 || transcript.rows().length > 0) ? known.sessionFile : undefined;
  // What the process took with it: its run, its queue, the prompts and lines its extensions had up.
  batch(() => {
    running.set(false);
    bashRunning.set(false);
    activity.set({ kind: "idle" });
    queue.set({ steering: [], followUp: [] });
    dialogs.set([]);
    statuses.set({});
    widgets.set({});
    if (known) state.set({ ...known, isStreaming: false, isCompacting: false });
  });
  bashRequestId = undefined;
  stopAsked = false;

  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  reopening = gate;
  const open = () => {
    if (reopening === gate) reopening = undefined;
    release();
  };

  const work = (async () => {
    let started: PiClient | undefined;
    try {
      started = await connect(cwd, agentId, mine, file, openDaemonId());
      if (!started) return;
      await withStartupTimeout(started.request("get_state"), agentLabel);
      if (mine !== generation) return;
      const retry = autoRetryChoice();
      if (retry !== undefined) started.request("set_auto_retry", { enabled: retry }).catch(() => undefined);
      const [next, history] = await Promise.all([
        withStartupTimeout(started.request("get_state"), agentLabel),
        withStartupTimeout(started.request("get_messages"), agentLabel),
      ]);
      if (mine !== generation) return;
      state.set(next);
      // At rest the conversation on screen is the session's own and stays as it is. A run cut short left rows
      // no file has, and a session that could not be opened again is not the one shown: then the file speaks.
      if (!ahead && (cutShort || (file !== undefined && next.sessionFile !== file))) {
        const fresh = new Transcript(() => activeLanguage());
        fresh.load(history.messages);
        if (!sameRows(fresh.rows(), transcript.rows())) {
          transcript = fresh;
          shownVersion = -1;
          markTranscriptSeen();
          flush();
          landed.update((n) => n + 1);
          scrollToEnd.set(0);
        }
      }
      open();
      if (cutShort) {
        toast(
          "warning",
          tr(`${agentLabel} stopped mid-run and was restarted. The run was cut short.`, `${agentLabel} 在运行中途退出，已自动重启。本次运行被中断。`),
        );
      }
      await Promise.all([refreshModels(), refreshCommands(), refreshLevels(), refreshStats()]);
      if (mine !== generation) return;
      // A session with nothing in it yet is a fresh one in the new process: the reader's picks go back on it.
      if (!file) await applySessionChoices();
      refreshSessions(cwd);
      void refreshGitWorkspace(cwd);
    } catch (error) {
      if (mine !== generation) return;
      // The new process going away in its turn is `routeExit`'s to answer: it tries once more, or says so.
      if (started?.closed) return;
      // It could not be started, or does not answer: nothing is coming back, and the screen says so.
      closeActive();
      const title = error instanceof SidecarError ? error.message : lost.title;
      const detail = error instanceof SidecarError ? error.hint : message(error);
      phase.set({ name: "failed", title, detail });
      toast("error", detail ? `${title} — ${detail}` : title);
    } finally {
      open();
    }
  })();
  const whole = work.finally(() => {
    if (revival === whole) revival = undefined;
  });
  revival = whole;
  return whole;
}

/**
 * Switches the active coding agent harness (e.g. `Pi` → `Claude Code` or `Codex`).
 * When the current conversation already has messages, builds a token-budgeted
 * Portable Context Handoff (`agents/handoff.ts`) so the new agent seamlessly
 * continues the conversation with intact context!
 */
export async function switchAgentHarness(nextAgentId: string) {
  if (nextAgentId === currentAgentId() && phase().name === "ready") return;
  const target = agents().find((a) => a.id === nextAgentId);
  if (!target) return;
  if (!target.available) {
    toast("warning", tr(`${target.name} is not installed yet. Configure it in Settings → Agents.`, `${target.name} 尚未安装，请在「设置 → 智能体」中查看配置。`));
    showSettings("agents");
    return;
  }

  await settle();
  const prevName = activeAgent().name;
  setPreferredAgentId(nextAgentId);

  const currentRows = rows();
  const hasConversation = currentRows.some((r) => r.kind === "user" || r.kind === "text");
  if (hasConversation) {
    const handoff = buildPortableHandoff({
      rows: currentRows,
      fromAgentName: prevName,
      toAgentName: target.name,
    });
    pendingHandoff.set(
      handoff.formattedContext
        ? { fromAgent: prevName, toAgent: target.name, context: handoff.formattedContext }
        : undefined,
    );
    const title = tr(
      `Switched agent from ${prevName} to ${target.name}`,
      `已从 ${prevName} 切换至 ${target.name}`,
    );
    const detail = handoff.items.length
      ? tr(
          `Portable context handoff ready: ${handoff.items.length} intact items (${Math.ceil(handoff.byteCount / 1024)} KB)${handoff.omittedCount ? `, ${handoff.omittedCount} older items omitted` : ""}. Delivered automatically with your next message.`,
          `便携上下文交接已就绪：保留 ${handoff.items.length} 条完整记录（${Math.ceil(handoff.byteCount / 1024)} KB）${handoff.omittedCount ? `，省略 ${handoff.omittedCount} 条较早记录` : ""}。将在下次发送消息时自动注入。`,
        )
      : "";
    await start(workspace(), undefined, nextAgentId, {
      previousRows: currentRows,
      handoffTitle: title,
      handoffDetail: detail,
    });
  } else {
    pendingHandoff.set(undefined);
    await start(workspace(), undefined, nextAgentId);
  }
  focusComposer();
}

/** Updates the default runtime permission mode for newly created sessions (`Settings → Sessions`). */
export function updatePreferredRuntimeMode(mode: RuntimeMode) {
  setPreferredRuntimeMode(mode);
  const ds = currentDaemonSession();
  const isUntouchedTopDraft =
    !ds?.parentId &&
    ds?.initiator !== "external" &&
    !rows().length &&
    !(state()?.messageCount) &&
    !running() &&
    !bashRunning();
  if (isUntouchedTopDraft) {
    void changeRuntimeMode(mode);
  }
}

/** Changes the active session's runtime permission mode (`Supervised` / `Auto-edit` / `Full access`), clamped to its ancestor ceiling. */
export async function changeRuntimeMode(mode: RuntimeMode) {
  const ceiling = currentRuntimeCeiling();
  const effective: RuntimeMode = runtimeModeRank(mode) > runtimeModeRank(ceiling) ? ceiling : mode;
  currentRuntimeMode.set(effective);
  const did = openDaemonId();
  // The daemon's record first: it is the ceiling children and raw writes are clamped to.
  if (did) daemonClient?.setRuntimeMode(did, effective);
  if (phase().name === "ready" && client) {
    if (currentAgentId() === "pi") {
      // Update Pi's injected extension runtime mode live via slash command
      await request("prompt", { message: `/pipi-runtime-mode ${effective}` }).catch(() => undefined);
    } else {
      (client as unknown as { request(t: string, a: Record<string, unknown>): Promise<unknown> })
        .request("set_runtime_mode", { mode: effective })
        .catch(() => undefined);
    }
  }
}

/** Starts the current agent again in the same folder, returning to the session that was open. */
export function restartPi() {
  const file = state()?.sessionFile;
  const keep = file && (state()?.messageCount ?? 0) > 0 ? file : heading()?.file;
  busy.set(false);
  pendingHandoff.set(undefined);
  // The reader's own restart is a new start: what went wrong before does not count against it.
  lostAt = [];
  // A restart ends the process — a mere attach would adopt the live one. Let go of it before the kill,
  // so the exit that lands back is a detach the store asked for, not a death to revive.
  const did = openDaemonId();
  closeActive();
  if (did) quietSessions.add(did);
  const gone = did ? daemonClient?.killSession(did).catch(() => undefined) : undefined;
  if (gone) return gone.then(() => start(workspace(), keep, currentAgentId()));
  return start(workspace(), keep, currentAgentId());
}

/** Moves the app to another folder (or an isolated Git worktree), optionally opening `sessionPath` right away. */
export async function openWorkspace(path: string, sessionPath?: string, sessionAgentId?: string) {
  const held = daemonSessionByFile(sessionPath);
  const projectCwd = projectCwdOf(path, held);
  if (!sessionPath && isWorkspaceCollapsed(projectCwd)) {
    setGroupCollapsed("recents", false);
  }
  markSessionRead(sessionPath);
  if (path === workspace() && phase().name === "ready" && !isSwitching()) {
    rememberWorkspace(projectCwd);
    if (sessionPath) {
      await openSession(sessionPath);
    } else {
      view.set({ name: "chat" });
      focusComposer();
    }
    return;
  }
  pendingHandoff.set(undefined);
  view.set({ name: "chat" });
  if (running() || bashRunning()) return switchInto(path, sessionPath, sessionAgentId ?? currentAgentId(), held?.id);
  await start(path, sessionPath, sessionAgentId ?? currentAgentId(), undefined, held?.id);
}

/** Starts a fresh session in `cwd`, switching to that project first when needed. */
export async function newSessionInWorkspace(cwd: string) {
  if (isWorkspaceCollapsed(cwd)) {
    setGroupCollapsed("recents", false);
  }
  if (cwd === workspace() && phase().name === "ready") {
    return newSession();
  }
  pendingHandoff.set(undefined);
  view.set({ name: "chat" });
  if (running() || bashRunning()) return switchInto(cwd, undefined, currentAgentId());
  await start(cwd, undefined, currentAgentId());
  focusComposer();
}

/** Removes a project folder from the sidebar; switches to another project if it was active. */
export async function closeWorkspace(cwd: string) {
  const remaining = recentWorkspaces().filter((p) => p !== cwd);
  forgetWorkspace(cwd);
  if (cwd === workspace()) {
    pendingHandoff.set(undefined);
    const next = remaining[0] ?? backend().home();
    if (running() || bashRunning()) await switchInto(next, undefined, currentAgentId());
    else await start(next, undefined, currentAgentId());
  }
  // Closing a project stops whatever it left running off screen, and drops its list.
  for (const known of daemonSessionList()) {
    if (known.cwd !== cwd || !known.loaded) continue;
    quietKill(known.id);
  }
  if (!Object.values(archivedSessions()).some((m) => m.cwd === cwd)) {
    sessionsByWorkspace.update((all) => {
      const next = { ...all };
      delete next[cwd];
      return next;
    });
  }
}

/** Creates a fresh Git worktree branch and switches the workspace into it. */
export async function createAndOpenWorktree(label = "session") {
  const createFn = backend().createWorktree;
  if (!createFn) return void toast("warning", tr("Worktrees are not available here.", "当前环境不支持 Git 工作树。"));
  const wt = await attempt(tr("Could not create worktree", "无法创建 Git 工作树"), () => createFn(workspace(), label));
  if (!wt) return;
  toast("success", tr(`Switched to isolated worktree ${wt.branch}`, `已切换至独立工作树分支 ${wt.branch}`));
  await openWorkspace(wt.path);
}

/**
 * Runs a desktop pick; resolves `undefined` on cancel, and toasts the one
 * failure worth naming — a Linux box with neither zenity nor kdialog, where
 * the panel silently cannot appear.
 */
async function pickOrToast(pick: Promise<string | undefined>): Promise<string | undefined> {
  try {
    return await pick;
  } catch (error) {
    if (error instanceof NoPickerError) {
      toast(
        "warning",
        tr("No file picker found — install zenity or kdialog to choose files.", "找不到文件选择器——请安装 zenity 或 kdialog。"),
      );
      return undefined;
    }
    throw error;
  }
}

/** Asks for a folder with the system's panel, and opens it. */
export async function chooseWorkspace() {
  const path = await pickOrToast(backend().pickFolder(tr("Choose a folder to work in", "选择工作文件夹")));
  if (path) {
    setWorkspaceCollapsed(path, false);
    await openWorkspace(path);
  }
}

// ── Comparing Agents (the user sends one task to several harnesses) ─────────

export function setCompareOpen(open: boolean) {
  compareOpen.set(open);
}

/**
 * Sends one task to several agent harnesses at once: each gets a daemon
 * session of its own (in an isolated Git worktree when asked and possible),
 * nested under the session on screen. The daemon runs them; their answers
 * mark the sidebar rows unread — the app's streams stay unattached.
 */
export async function launchCompareSessions(options: {
  prompt: string;
  agentIds: string[];
  isolation?: WorkspaceIsolation;
}) {
  const promptText = options.prompt.trim();
  if (!promptText || options.agentIds.length === 0) return;
  const daemon = await ensureDaemon();
  if (!daemon) {
    toast("error", tr("The session daemon is unavailable.", "会话守护进程不可用。"));
    return;
  }
  const isolation: WorkspaceIsolation =
    options.isolation ?? (worktreeIsolationDefault() && gitInfo().isGitRepo ? "worktree" : "shared");

  const ceiling = currentRuntimeCeiling();
  const effectiveMode: RuntimeMode =
    runtimeModeRank(currentRuntimeMode()) > runtimeModeRank(ceiling) ? ceiling : currentRuntimeMode();

  await Promise.all(
    options.agentIds.map((agentId) =>
      attempt(tr(`Failed on ${agentId}`, `${agentId} 启动失败`), async () => {
        const spec = agents().find((a) => a.id === agentId);
        await daemon.startSession({
          title: `${spec?.name ?? agentId} · ${promptText.slice(0, 40)}`,
          agentId,
          cwd: workspace(),
          message: promptText,
          parentId: openDaemonId(),
          runtimeMode: effectiveMode,
          worktree: isolation === "worktree" && gitInfo().isGitRepo,
        });
      }),
    ),
  );
}

// ── Custom ACP Agents & Overrides Management ────────────────────────────────

export async function saveCustomAgent(config: CustomAgentConfig) {
  addCustomAgentPref(config);
  await refreshAgents();
  toast("success", tr(`Added custom agent "${config.name}".`, `已添加自定义智能体「${config.name}」。`));
}

export async function deleteCustomAgent(agentId: string) {
  removeCustomAgentPref(agentId);
  await refreshAgents();
  if (currentAgentId() === agentId) {
    await switchAgentHarness("pi");
  }
}

export async function updateAgentOverride(agentId: string, override: AgentOverride) {
  const prev = storedAgentOverrides()[agentId];
  setAgentOverride(agentId, { ...prev, ...override });
  await refreshAgents();
  if (currentAgentId() === agentId && override.enabled === false) {
    await switchAgentHarness("pi");
    return;
  }
  if (currentAgentId() === agentId && phase().name === "ready" && (override.binaryPath !== prev?.binaryPath || JSON.stringify(override.extraArgs) !== JSON.stringify(prev?.extraArgs))) {
    await restartPi();
  }
}

export async function resetAgentOverride(agentId: string) {
  const prev = storedAgentOverrides()[agentId];
  setAgentOverride(agentId, prev?.enabled === false ? { enabled: false } : {});
  await refreshAgents();
  if (currentAgentId() === agentId && phase().name === "ready") {
    await restartPi();
  }
}

export async function saveAgentApiKey(agentId: string, key: string) {
  const saved = await attempt(tr("Could not save API key", "无法保存 API 密钥"), async () => {
    await backend().saveApiKey(`agent:${agentId}`, key);
    return true;
  });
  if (!saved) return false;
  await Promise.all([refreshCredentials(), refreshAgents()]);
  if (currentAgentId() === agentId && phase().name === "ready") {
    await restartPi();
  }
  const label = agents().find((a) => a.id === agentId)?.name ?? agentId;
  toast("success", tr(`Saved API key for ${label}.`, `已保存 ${label} 的 API 密钥。`));
  return true;
}

export async function removeAgentApiKey(agentId: string) {
  const removed = await attempt(tr("Could not remove API key", "无法移除 API 密钥"), async () => {
    await backend().removeCredential(`agent:${agentId}`);
    return true;
  });
  if (!removed) return;
  await Promise.all([refreshCredentials(), refreshAgents()]);
  if (currentAgentId() === agentId && phase().name === "ready") {
    await restartPi();
  }
}

// ── Reading Active Agent's State ────────────────────────────────────────────

async function refreshState() {
  const next = await request("get_state");
  state.set(next);
  if (next.sessionFile) reportSessionFile();
  // A session the daemon kept working — reopened or revived — says so through its state, not an `agent_start` the attach missed.
  if (next.isStreaming && !running()) {
    runStartedAt.set(Date.now());
    running.set(true);
  }
  return next;
}

async function refreshModels() {
  try {
    models.set((await request("get_available_models")).models);
  } catch {
    models.set([]);
  }
}

async function refreshLevels() {
  try {
    levels.set((await request("get_available_thinking_levels")).levels);
  } catch {
    levels.set(["off"]);
  }
}

async function refreshStats() {
  try {
    stats.set(await request("get_session_stats"));
  } catch {
    stats.set(undefined);
  }
}

/** Re-scans every saved session for the Usage settings page. */
export async function refreshUsageStats() {
  try {
    usage.set((await backend().usageStats?.()) ?? EMPTY_USAGE);
  } catch (error) {
    toast("warning", `${tr("Could not read usage statistics", "无法读取用量统计")}: ${message(error)}`);
  }
}

/** The agent's own commands (`get_commands`); pipi's are `appCommands`, there whatever the agent answers. */
async function refreshCommands() {
  try {
    commands.set((await request("get_commands")).commands ?? []);
  } catch {
    commands.set([]);
  }
}

const DAY_MS = 86_400_000;

/**
 * Archives inactive conversations older than `autoArchiveDays` (the rule:
 * running and currently open conversations are never auto-archived).
 */
export function applyAutoArchive(now = Date.now()) {
  const days = autoArchiveDays();
  if (days <= 0) return;
  const cutoff = now - days * DAY_MS;
  const openFile = state()?.sessionFile;
  const candidates: { path: string; cwd: string }[] = [];
  const scan = (cwd: string, list: readonly SessionSummary[]) => {
    for (const s of list) {
      if (!s.path || isSessionArchived(s.path)) continue;
      if (s.path === openFile || isSessionRunning(s.path)) continue;
      if (s.modified > 0 && s.modified < cutoff) {
        candidates.push({ path: s.path, cwd });
      }
    }
  };
  const activeCwd = workspace();
  if (activeCwd) scan(activeCwd, sessions());
  for (const [cwd, list] of Object.entries(sessionsByWorkspace())) {
    if (cwd === activeCwd) continue;
    scan(cwd, list);
  }
  if (candidates.length > 0) {
    archiveSessionsBatch(candidates);
  }
}

export function updateAutoArchiveDays(days: AutoArchiveDays) {
  setAutoArchiveDays(days);
  if (days > 0) applyAutoArchive();
}

/** Reads the saved sessions of `cwd` (defaults to the active workspace). */
export async function refreshSessions(cwd = activeProjectPath()) {
  if (!cwd) return;
  try {
    const found = await backend().listSessions(cwd);
    sessionsByWorkspace.update((all) => ({ ...all, [cwd]: found }));
    if (cwd === workspace() || cwd === activeProjectPath()) sessions.set(found);
    applyAutoArchive();
  } catch (error) {
    if (phase().name !== "failed") {
      toast("warning", `${tr("Could not list saved sessions", "无法读取历史会话列表")}: ${message(error)}`);
    }
  } finally {
    if (cwd === workspace() || cwd === activeProjectPath()) sessionsLoaded.set(true);
  }
}

/** Reads saved sessions across all open sidebar project folders (plus folders with archived sessions). */
export async function refreshAllWorkspaceSessions() {
  const archivedCwds = Object.values(archivedSessions())
    .map((m) => m.cwd)
    .filter((c): c is string => !!c);
  const cwds = [...new Set([workspace(), ...recentWorkspaces(), ...archivedCwds].filter(Boolean))];
  if (!cwds.length) return;
  try {
    const b = backend();
    if (b.listWorkspaceSessions) {
      const batchMap = await b.listWorkspaceSessions(cwds);
      sessionsByWorkspace.update((all) => ({ ...all, ...batchMap }));
      const active = workspace();
      if (active && batchMap[active]) {
        sessions.set(batchMap[active]);
        sessionsLoaded.set(true);
      }
      applyAutoArchive();
      return;
    }
    await Promise.all(cwds.map((cwd) => refreshSessions(cwd)));
  } catch (error) {
    if (phase().name !== "failed") {
      toast("warning", `${tr("Could not list workspace sessions", "无法读取各项目的会话列表")}: ${message(error)}`);
    }
  }
}

export async function refreshCredentials() {
  try {
    credentials.set(await backend().storedCredentials());
  } catch (error) {
    toast("warning", `${tr("Could not read saved credentials", "无法读取已保存的凭据")}: ${message(error)}`);
  }
}

/**
 * Loads the session the active agent has open: its state and messages land at
 * once; what its model supports follows in the background — an external engine
 * only knows it once its own session is negotiated, which a switch must not wait on.
 */
async function syncSession() {
  const [, history] = await Promise.all([refreshState(), request("get_messages")]);
  landHistory(history.messages);
  reportSessionFile();
  void refreshLevels();
  void refreshStats();
}

/**
 * Re-applies the model and thinking depth the user last picked for the active
 * agent. A fresh session opens on the harness's own configured default (Pi on
 * `defaultModel`, external engines on whatever they advertise), so the user's
 * pick is put back the way `autoRetry` is — never on a reopened session, which
 * keeps the model its own history recorded.
 */
async function applySessionChoices() {
  const choice = storedSessionChoice(currentAgentId());
  if (!choice) return;
  // Compare against the fresh session's own state, not the screen's stale copy.
  let known = await refreshState().catch(() => undefined);
  const wantedModel = choice.model;
  if (wantedModel) {
    const found =
      models().find((m) => m.id === wantedModel.id && m.provider === wantedModel.provider) ?? models().find((m) => m.id === wantedModel.id);
    if (found && (known?.model?.id !== found.id || known?.model?.provider !== found.provider)) {
      const chosen = await request("set_model", { provider: found.provider, modelId: found.id }).catch(() => undefined);
      if (chosen) {
        state.update((s) => s && { ...s, model: chosen });
        known = await refreshState().catch(() => known);
      }
    }
  }
  const wantedLevel = choice.thinkingLevel;
  if (!wantedLevel) return;
  // The levels wait on the engine's own session: put the depth back once they are known, not before the session lands.
  const sessionId = known?.sessionId;
  void refreshLevels().then(async () => {
    if (!client || state()?.sessionId !== sessionId) return;
    if (!levels().includes(wantedLevel) || wantedLevel === state()?.thinkingLevel) return;
    await request("set_thinking_level", { level: wantedLevel });
    if (state()?.sessionId === sessionId) state.update((s) => s && { ...s, thinkingLevel: wantedLevel });
  }).catch(() => undefined);
}

// ── Events from Active Agent ────────────────────────────────────────────────

function onEvent(event: SessionEvent) {
  switch (event.type) {
    case "agent_start":
      stopAsked = false;
      batch(() => {
        if (!running()) runStartedAt.set(Date.now());
        running.set(true);
        // A retry is a run starting over: the line goes on saying which attempt it is until that attempt
        // shows life (or the retries end), rather than flapping to "Thinking" and back between attempts.
        if (activity().kind !== "retrying") activity.set({ kind: "thinking" });
      });
      break;
    case "message_update": {
      const kind = event.assistantMessageEvent.type;
      if (kind.startsWith("text")) activity.set({ kind: "writing" });
      else if (kind.startsWith("thinking")) activity.set({ kind: "thinking" });
      else if (kind === "toolcall_start") activity.set({ kind: "tool", name: event.assistantMessageEvent.toolName });
      break;
    }
    case "tool_execution_start":
      activity.set({ kind: "tool", name: event.toolName });
      break;
    case "message_end":
      // A fresh session gets its file as its first run starts (the bridge writes it then): knowing it is
      // how the session is found again, should its agent go away under the run.
      if (event.message.role === "user" && !state()?.sessionFile) void refreshState().catch(() => undefined);
      break;
    case "turn_start":
    case "turn_end":
      if (running() && activity().kind !== "retrying") activity.set({ kind: "thinking" });
      break;
    case "queue_update":
      queue.set({ steering: event.steering ?? [], followUp: event.followUp ?? [] });
      break;
    case "session_info_changed":
      state.update((s) => s && { ...s, sessionName: event.name });
      refreshSessions();
      break;
    case "thinking_level_changed":
      state.update((s) => s && { ...s, thinkingLevel: event.level });
      break;
    case "compaction_start":
      activity.set({ kind: "compacting" });
      state.update((s) => s && { ...s, isCompacting: true });
      break;
    case "compaction_end":
      state.update((s) => s && { ...s, isCompacting: false });
      activity.set(running() ? { kind: "thinking" } : { kind: "idle" });
      refreshStats();
      break;
    case "auto_retry_start":
      activity.set({ kind: "retrying", attempt: event.attempt, maxAttempts: event.maxAttempts, reason: event.errorMessage });
      break;
    case "auto_retry_end":
      if (running()) activity.set({ kind: "thinking" });
      break;
    case "bash_execution_update":
      if (!event.id || event.id === bashRequestId) transcript.bashOutput(event.delta);
      break;
    case "commands_changed":
      // The bridge learned the agent's own commands (ACP `available_commands_update`, Claude's `initialize`).
      void refreshCommands();
      return;
    case "models_changed":
      // The bridge adopted the agent's real catalog (ACP session negotiation).
      void (async () => {
        await Promise.all([refreshModels(), refreshLevels(), refreshState().catch(() => undefined)]);
        if (!running() && !rows().length && !(state()?.messageCount)) {
          await applySessionChoices();
        }
      })();
      return;
    case "agent_settled": {
      const wasRunning = running();
      batch(() => {
        running.set(false);
        activity.set({ kind: "idle" });
        queue.set({ steering: [], followUp: [] });
      });
      transcript.apply(event);
      flush();
      if (wasRunning && !event.aborted && !stopAsked) celebrate();
      stopAsked = false;
      refreshState().catch(() => undefined);
      refreshStats();
      refreshSessions();
      void refreshGitWorkspace();
      const current = view();
      if (current.name === "settings" && current.section === "usage") void refreshUsageStats();
      return;
    }
  }
  transcript.apply(event);
  flushSoon();
}

/** Whether a conversation's last word is an error: the run that left it there did not end well. */
function endedInError(rows: Row[]) {
  const last = rows.at(-1);
  return last?.kind === "notice" && last.tone === "error";
}

/** Pip jumps once when a run ends well. */
function celebrate() {
  if (endedInError(transcript.rows())) return;
  cheer.set(true);
  setTimeout(() => cheer.set(false), 900);
}

function onUiRequest(ui: ExtensionUiRequest) {
  switch (ui.method) {
    case "select":
    case "confirm":
    case "input":
    case "editor":
      dialogs.update((list) => [...list, ui]);
      break;
    case "notify":
      toast(ui.notifyType ?? "info", ui.message);
      break;
    case "setStatus":
      statuses.update((all) => {
        const next = { ...all };
        if (ui.statusText) next[ui.statusKey] = ui.statusText;
        else delete next[ui.statusKey];
        return next;
      });
      break;
    case "setWidget":
      widgets.update((all) => {
        const next = { ...all };
        if (ui.widgetLines?.length) next[ui.widgetKey] = { lines: ui.widgetLines, below: ui.widgetPlacement === "belowEditor" };
        else delete next[ui.widgetKey];
        return next;
      });
      break;
    case "setTitle":
      Window.get("main")?.set({ title: ui.title });
      break;
    case "set_editor_text":
      setDraft(ui.text);
      break;
  }
}

// ── Events from the open agent ──────────────────────────────────────────────

/** Routes a record to the open session's client; a detached client's stream no longer arrives. */
function routeEvent(source: PiClient | undefined, event: SessionEvent) {
  if (!source) return;
  if (source === client) return onEvent(event);
}

function routeUiRequest(source: PiClient | undefined, ui: ExtensionUiRequest) {
  if (!source) return;
  if (source === client) return onUiRequest(ui);
}

function routeExit(source: PiClient | undefined, exit: Exit, stderr: string, agentLabel: string) {
  if (!source) return;
  clientDaemonId.delete(source);
  // Only the open session's process ending is news: a detached one is a detach the store asked for.
  if (source !== client) return;
  client = undefined;
  const how = exit.signal
    ? tr(`signal ${exit.signal}`, `信号 ${exit.signal}`)
    : tr(`code ${exit.code ?? "unknown"}`, `退出码 ${exit.code ?? "未知"}`);
  const starting = phase().name === "starting";
  const title = starting
    ? tr(`${agentLabel} could not start`, `${agentLabel} 无法启动`)
    : tr(`${agentLabel} stopped unexpectedly`, `${agentLabel} 意外退出`);
  const lost = {
    name: "failed" as const,
    title,
    detail: stderr || exit.error || tr(`The process exited with ${how}.`, `进程已退出（${how}）。`),
  };
  const now = Date.now();
  lostAt = [...lostAt.filter((at) => now - at < REVIVE_WINDOW_MS), now];
  // A session that was open keeps its screen and gets its agent back. One still starting has nothing
  // to come back to, and one that keeps going away is not started for ever: those say so.
  if (phase().name === "ready" && lostAt.length <= REVIVE_LIMIT) {
    void revive(agentLabel, running() || bashRunning() || Boolean(state()?.isCompacting), lost);
    return;
  }
  batch(() => {
    running.set(false);
    bashRunning.set(false);
    activity.set({ kind: "idle" });
    phase.set(lost);
  });
  toast("error", stderr && starting ? `${title} — ${stderr.split("\n").pop()}` : title);
}

/** Answers the dialog an extension is waiting on. */
export function answerDialog(id: string, answer: ExtensionUiAnswer) {
  client?.respond(id, answer);
  dialogs.update((list) => list.filter((dialog) => dialog.id !== id));
}

/** Dismisses or declines whichever dialog is currently waiting at the head of the queue. */
export function cancelPendingDialog() {
  const dialog = dialogs()[0];
  if (!dialog) return;
  answerDialog(dialog.id, dialog.method === "confirm" ? { confirmed: false } : { cancelled: true });
}

// ── Toasts ──────────────────────────────────────────────────────────────────

/** How long a toast stays: longer for an error or one that offers an action, and for one that takes longer to read. */
function toastLifetime(tone: Toast["tone"], text: string, hasAction: boolean) {
  const base = tone === "error" || hasAction ? 6000 : 4000;
  // A CJK character reads about as long as two Latin ones.
  let length = 0;
  for (const ch of text) length += ch.charCodeAt(0) > 0x2e7f ? 2 : 1;
  return Math.min(12_000, base + Math.max(0, length - 60) * 40);
}

/** (Re)starts the time a toast has left. */
function expireToast(id: number, ttl: number) {
  clearTimeout(toastTimers.get(id));
  toastTimers.set(
    id,
    setTimeout(() => dismissToast(id), ttl),
  );
}

/**
 * pipi's single error/notice channel — every user-visible error surfaces here
 * (`views/Toasts.tsx`, top-right). The same message again is the same toast:
 * it stays where it is and its time starts over, so one whose cause just
 * happened again is not left to run out a moment later, nor taken away and
 * put back.
 */
export function toast(
  tone: Toast["tone"],
  text: string,
  options?: { icon?: IconName; action?: ToastAction; durationMs?: number },
) {
  const ttl = options?.durationMs ?? toastLifetime(tone, text, !!options?.action);
  const same = toasts().find((item) => item.tone === tone && item.text === text);
  if (same) {
    if (options?.icon || options?.action) {
      toasts.update((list) => list.map((item) => (item.id === same.id ? { ...item, icon: options.icon ?? item.icon, action: options.action ?? item.action } : item)));
    }
    expireToast(same.id, ttl);
    return;
  }
  const id = ++toastId;
  // Three at most: the oldest makes room.
  for (const gone of toasts().slice(0, -2)) {
    clearTimeout(toastTimers.get(gone.id));
    toastTimers.delete(gone.id);
  }
  toasts.update((list) => [...list.slice(-2), { id, tone, text, icon: options?.icon, action: options?.action }]);
  expireToast(id, ttl);
}

export function dismissToast(id: number) {
  clearTimeout(toastTimers.get(id));
  toastTimers.delete(id);
  toasts.update((list) => list.filter((item) => item.id !== id));
}

async function attempt<T>(what: string, action: () => Promise<T>): Promise<T | undefined> {
  try {
    return await action();
  } catch (error) {
    toast("error", `${what}: ${message(error)}`);
    return undefined;
  }
}

// ── The composer ────────────────────────────────────────────────────────────

export function setDraft(text: string) {
  draft.set(text);
}

export function focusComposer() {
  composerFocus.set(0);
}

export function addAttachment(image: Attachment) {
  attachments.update((list) => [...list, image]);
}

export function removeAttachment(index: number) {
  attachments.update((list) => list.filter((_, i) => i !== index));
}

/** A paste's file reads land on promises; `send` waits for them so a fast paste-and-send keeps its attachments. */
const attachmentReads = new Set<Promise<unknown>>();
export function trackAttachmentRead(read: Promise<unknown>) {
  attachmentReads.add(read);
  void read.then(
    () => attachmentReads.delete(read),
    () => attachmentReads.delete(read),
  );
}

/**
 * Runs the line when it is one of pipi's own commands (`appCommands`); `false`
 * hands it on to the agent. What a command does not take stays in the
 * composer, so words typed after it are never lost.
 */
async function runAppCommand(text: string): Promise<boolean> {
  const line = parseSlashLine(text);
  const command = line && appCommands().find((own) => answersTo(own, line.name));
  if (!line || !command) return false;
  const rest = line.args;
  switch (command.name) {
    case "new":
      draft.set(rest);
      await newSession();
      break;
    case "compact":
      // A run in progress refuses (and says so): the instructions stay to be sent again.
      if (!running()) draft.set("");
      await compactNow(rest || undefined);
      break;
    case "model":
      draft.set(rest);
      openModelPicker();
      break;
    case "name":
      draft.set("");
      if (rest) await renameSession(rest);
      else startRenaming();
      break;
    case "copy":
      draft.set(rest);
      await copyLastReply();
      break;
    case "export":
      draft.set(rest);
      await exportHtml();
      break;
    case "delegate": {
      // `/delegate <agent> <task>`: delegating is comparing now — the sheet asks for the agents, the task stays in the composer.
      const [, token = "", task = ""] = /^@?(\S+)\s*([\s\S]*)$/.exec(rest) ?? [];
      const agent = agents().find((a) => a.id.toLowerCase() === token.toLowerCase() || a.name.toLowerCase() === token.toLowerCase());
      draft.set(agent ? task : rest);
      compareOpen.set(true);
      break;
    }
    case "parallel":
      draft.set(rest);
      compareOpen.set(true);
      break;
    case "settings":
      draft.set(rest);
      showSettings();
      break;
  }
  return true;
}

/**
 * Sends what the composer holds:
 * - `/name …` that is one of pipi's own commands runs in the app (`runAppCommand`),
 *   whatever the session is doing; any other `/name` is the agent's and goes to it.
 * - `!cmd` / `!!cmd` runs a shell command.
 * - If a Portable Context Handoff is pending (from switching agents mid-conversation),
 *   prepends the budgeted handoff context to the wire prompt while keeping the
 *   user's clean message in the visible chat bubble!
 */
export async function send(mode: "steer" | "followUp" = "steer") {
  if (attachmentReads.size) await Promise.allSettled([...attachmentReads]);
  // A message written while a session change is under way is for where it lands.
  for (let wait = arrival; heading() && wait; wait = arrival === wait ? undefined : arrival) await wait;
  // One written while the agent is being started again goes to it once it is back.
  while (revival) await revival;
  const text = draft().trim();
  const images = attachments().map(({ type, data, mimeType }) => ({ type, data, mimeType }));
  if (!text && !images.length) return;
  // pipi's own commands need no agent: they run whatever the session is doing.
  if (await runAppCommand(text)) return;
  if (phase().name !== "ready") return;

  if (text.startsWith("!") && !running()) {
    const exclude = text.startsWith("!!");
    const command = text.slice(exclude ? 2 : 1).trim();
    if (!command) return;
    draft.set("");
    return runBash(command, exclude);
  }

  if (!hasModel()) {
    toast("warning", tr("Connect a model provider before sending.", "请先连接模型服务商再发送。"));
    showAgentSettings();
    return;
  }

  const activeFile = state()?.sessionFile;
  if (activeFile && isSessionArchived(activeFile)) {
    setSessionArchived(activeFile, false);
  }

  // An agent's own command is a line the agent must see as written: `/name` first, or it is no command to it.
  // The handoff waits for the next message instead of going in front of it.
  const line = parseSlashLine(text);
  const agentCommand = Boolean(line && agentCommands().some((command) => command.name === line.name));
  const handoff = agentCommand ? undefined : pendingHandoff();
  const wirePrompt = handoff ? prependHandoffToPrompt(handoff.context, text) : text;

  batch(() => {
    draft.set("");
    attachments.set([]);
    if (handoff) pendingHandoff.set(undefined);
  });
  enableLiveRowEntrance();
  scrollToEnd.set(0);
  const queued = running();
  const activeClient = client;
  if (!queued) {
    batch(() => {
      running.set(true);
      runStartedAt.set(Date.now());
      activity.set({ kind: "thinking" });
    });
  }
  try {
    const { disposition } = await request("prompt", {
      message: wirePrompt,
      ...(images.length ? { images } : {}),
      ...(queued ? { streamingBehavior: mode } : {}),
    });
    // The user may have switched sessions while the agent was answering: that run is the daemon's now, not this screen's.
    if (client !== activeClient) return;
    if (!queued && disposition === "handled") {
      batch(() => {
        running.set(false);
        activity.set({ kind: "idle" });
      });
    }
  } catch (error) {
    if (client !== activeClient) return;
    batch(() => {
      if (!queued) {
        running.set(false);
        activity.set({ kind: "idle" });
      }
      if (!draft()) draft.set(text);
      if (handoff) pendingHandoff.set(handoff);
    });
    // Said once, as every app error is: a toast. The message is back in the composer, and the conversation
    // keeps no note of it — one no history has, there until the session was next opened and then gone.
    toast("error", `${tr("The message was not sent", "消息未能发送")}: ${message(error)}`);
  }
}

async function runBash(command: string, excludeFromContext: boolean) {
  const activeClient = client;
  if (!activeClient) return;
  const runTranscript = transcript;
  enableLiveRowEntrance();
  runTranscript.bashStart(command);
  if (runTranscript === transcript) flush();
  scrollToEnd.set(0);
  bashRunning.set(true);
  bashRequestId = activeClient.peekId();
  try {
    runTranscript.bashEnd(await activeClient.request("bash", { command, ...(excludeFromContext ? { excludeFromContext } : {}) }));
  } catch (error) {
    runTranscript.bashEnd({ error: message(error) });
  } finally {
    if (client === activeClient) {
      bashRequestId = undefined;
      bashRunning.set(false);
    }
    if (runTranscript === transcript) flush();
  }
}

/** Stops the open run, and every session still working under it (the daemon aborts the tree). */
export async function stop() {
  if (bashRunning()) return void request("abort_bash").catch(() => undefined);
  if (running() || state()?.isCompacting) {
    stopAsked = true;
    if (activity().kind === "retrying") request("abort_retry").catch(() => undefined);
    try {
      const cleared = await request("clear_queue");
      const waiting = [...cleared.steering, ...cleared.followUp].join("\n\n");
      if (waiting && !draft()) draft.set(waiting);
    } catch {}
    await attempt(tr("Could not stop", "无法停止"), () => request("abort"));
  }
  const did = openDaemonId();
  if (did) void daemonClient?.stopTree(did).catch(() => undefined);
}

/** Stops a nested daemon session (and its children) from the sidebar's child row. */
export async function stopDaemonSession(sessionId: string) {
  await daemonClient?.stopTree(sessionId).catch(() => undefined);
}

/** Stops every working or blocked daemon session across all trees (e.g. "Stop All & Quit"). */
export async function stopAllDaemonSessions() {
  if (running() || bashRunning() || state()?.isCompacting) {
    await stop();
  }
  await daemonClient?.stopAll().catch(() => undefined);
}

/** Opens a daemon session — by its saved transcript file when present, else by attaching its daemon id directly. */
export function openDaemonSession(sessionId: string) {
  const session = daemonSessionOfId(sessionId);
  if (!session) return;
  if (session.id === openDaemonId() && phase().name === "ready" && !isSwitching()) {
    view.set({ name: "chat" });
    focusComposer();
    return;
  }
  daemonClient?.markRead(session.id);
  if (session.file) {
    void openSession(session.file, projectCwdOf(session.cwd, session));
    return;
  }
  void switchInto(session.cwd, undefined, session.agentId, session.id);
}

/** Puts the queued messages back in the composer without stopping the run. */
export async function recallQueue() {
  const cleared = await attempt(tr("Could not clear the queue", "无法清空队列"), () => request("clear_queue"));
  if (!cleared) return;
  const waiting = [...cleared.steering, ...cleared.followUp].join("\n\n");
  if (waiting) draft.set(draft() ? `${draft()}\n\n${waiting}` : waiting);
  focusComposer();
}

// ── Sessions ────────────────────────────────────────────────────────────────

/**
 * Whether the open daemon session is tied to an active run, a session tree, or
 * an external caller — if so, leaving it detaches and opens a separate daemon
 * session rather than switching files inside its process.
 */
function mustDetachOnSwitch(): boolean {
  if (running() || bashRunning()) return true;
  const held = currentDaemonSession();
  if (held?.parentId || held?.initiator === "external") return true;
  if (held && descendantSessionsOf(held.id).length > 0) return true;
  return false;
}

/**
 * Lets go of the open agent's view: the daemon keeps its process — a run in
 * progress keeps going off screen. The store lets go of it first — an exit
 * (a detach) the store asked for is not one to recover from (`routeExit`).
 */
function closeActive() {
  const current = client;
  const leavingCwd = projectCwdOf(workspace(), currentDaemonSession());
  client = undefined;
  if (current) clientDaemonId.delete(current);
  current?.close();
  // A run let go of keeps working off screen: re-list so its sidebar rows exist for the mark.
  if (running() || bashRunning()) void refreshSessions(leavingCwd);
}

/**
 * Switches to another session or folder under a new attach: the open session
 * is only detached — the daemon keeps its process, run and all, and its row
 * in the sidebar keeps its working mark.
 */
async function switchInto(cwd: string, sessionPath: string | undefined, agentId = currentAgentId(), daemonId?: string): Promise<boolean> {
  if (busy()) return false;
  busy.set(true);
  try {
    closeActive();
    batch(() => {
      view.set({ name: "chat" });
      pendingHandoff.set(undefined);
      renaming.set(false);
      attachments.set([]);
    });
    await start(cwd, sessionPath, agentId, undefined, daemonId);
    focusComposer();
    return true;
  } finally {
    busy.set(false);
  }
}

/** A change that showed its destination ahead and then did not happen: the agent's own session goes back on screen. */
async function stayPut() {
  if (!early) return;
  early = false;
  ahead = undefined;
  await syncSession().catch(() => undefined);
}

async function settle() {
  if (running() || bashRunning()) await stop();
}

async function changeSession(what: string, action: () => Promise<{ cancelled: boolean }>, target?: { file?: string }): Promise<boolean> {
  if (busy()) return false;
  if (target) return headFor({ cwd: workspace(), file: target.file }, () => changeSession(what, action));
  busy.set(true);
  try {
    await settle();
    const { cancelled } = await action();
    if (cancelled) {
      toast("info", tr("An extension cancelled the change.", "扩展已取消该操作。"));
      await stayPut();
      return false;
    }
    batch(() => {
      view.set({ name: "chat" });
      pendingHandoff.set(undefined);
      renaming.set(false);
      attachments.set([]);
      running.set(false);
      bashRunning.set(false);
      activity.set({ kind: "idle" });
      queue.set({ steering: [], followUp: [] });
      dialogs.set([]);
      statuses.set({});
      widgets.set({});
    });
    bashRequestId = undefined;
    await syncSession();
    refreshSessions();
    focusComposer();
    return true;
  } catch (error) {
    toast("error", `${what}: ${message(error)}`);
    await stayPut();
    return false;
  } finally {
    busy.set(false);
  }
}

/** Starts a fresh session, then puts back the model, thinking, and initial permission mode for this agent. */
async function requestNewSession() {
  const result = await request("new_session");
  if (!result.cancelled) {
    currentRuntimeMode.set(preferredRuntimeMode());
    if (openDaemonId()) daemonClient?.setRuntimeMode(openDaemonId()!, preferredRuntimeMode());
    await applySessionChoices();
  }
  return result;
}

export function newSession() {
  pendingHandoff.set(undefined);
  const rootCwd = activeProjectPath() || workspace();
  if (phase().name !== "ready") {
    busy.set(false);
    view.set({ name: "chat" });
    return start(rootCwd, undefined, currentAgentId());
  }
  if (isSwitching()) {
    if (!heading()?.file && !heading()?.daemonId && !busy()) return focusComposer();
    busy.set(false);
    view.set({ name: "chat" });
    return start(rootCwd, undefined, currentAgentId());
  }
  if (!rows().length && !(state()?.messageCount) && !mustDetachOnSwitch() && view().name === "chat") {
    return focusComposer();
  }
  if (mustDetachOnSwitch() || rootCwd !== workspace()) {
    return switchInto(rootCwd, undefined, currentAgentId());
  }
  return changeSession(tr("Could not start a session", "无法新建会话"), requestNewSession, {});
}

async function openSessionFile(path: string, ownerAgentId?: string) {
  const held = daemonSessionByFile(path);
  const targetCwd = held?.cwd ?? activeProjectPath() ?? workspace();
  const neededAgent =
    held?.agentId ||
    ownerAgentId ||
    (path.endsWith(".pipi-agent.jsonl") ? sessions().find((s) => s.path === path)?.agentId : "pi") ||
    currentAgentId();
  const targetSpec = agents().find((a) => a.id === neededAgent);
  const switchHarness =
    neededAgent !== currentAgentId() &&
    Boolean(targetSpec && (targetSpec.available || targetSpec.statusText === "Checking…" || path.endsWith(".pipi-agent.jsonl")));
  const own = held !== undefined && held.id === openDaemonId();
  if (switchHarness || phase().name !== "ready" || isSwitching() || (held !== undefined && !own) || mustDetachOnSwitch() || targetCwd !== workspace()) {
    if (phase().name === "ready" && !isSwitching()) {
      return switchInto(targetCwd, path, neededAgent, held?.id);
    }
    busy.set(false);
    view.set({ name: "chat" });
    pendingHandoff.set(undefined);
    await start(targetCwd, path, neededAgent, undefined, held?.id);
    return true;
  }
  return changeSession(tr("Could not open the session", "无法打开会话"), () => request("switch_session", { sessionPath: path }), { file: path });
}

export function openSession(path: string, cwd?: string) {
  markSessionRead(path);
  const held = daemonSessionByFile(path);
  const effectiveCwd = cwd ?? (held ? projectCwdOf(held.cwd, held) : undefined);
  if (effectiveCwd && effectiveCwd !== activeProjectPath()) {
    const summary = (sessionsByWorkspace()[effectiveCwd] ?? []).find((s) => s.path === path);
    return openWorkspace(held?.cwd ?? effectiveCwd, path, held?.agentId ?? summary?.agentId);
  }
  if (path === state()?.sessionFile && phase().name === "ready" && !isSwitching()) {
    view.set({ name: "chat" });
    focusComposer();
    return;
  }
  const summary = sessions().find((s) => s.path === path);
  return openSessionFile(path, summary?.agentId);
}

export function duplicateSession() {
  return changeSession(tr("Could not duplicate the session", "无法复制会话"), () => request("clone"));
}

export async function forkFrom(index: number) {
  const candidates = await attempt(tr("Could not fork", "无法创建分支"), () => request("get_fork_messages"));
  const target = candidates?.messages[index];
  if (!target) return void toast("warning", tr("This message cannot be forked from.", "无法从这条消息创建分支。"));
  let text = "";
  const ok = await changeSession(tr("Could not fork", "无法创建分支"), async () => {
    const result = await request("fork", { entryId: target.entryId });
    // Pi hands the message back as the model got it: the draft is what the person wrote.
    text = withoutImageNotes(result.text ?? "");
    return result;
  });
  if (ok && text) draft.set(text);
}

export function startRenaming() {
  view.set({ name: "chat" });
  renaming.set(true);
}

export function cancelRenaming() {
  renaming.set(false);
}

export async function renameSession(name: string) {
  renaming.set(false);
  const next = name.trim();
  if (!next || next === state()?.sessionName) return;
  await attempt(tr("Could not rename", "无法重命名"), () => request("set_session_name", { name: next }));
  state.update((s) => s && { ...s, sessionName: next });
  refreshSessions();
}

/**
 * Archives a session without touching its `.jsonl` file on disk: moves it out
 * of active workspace and recent lists into Archive, where it can be read or
 * restored anytime. Running conversations ask for confirmation
 * before interrupting the run.
 */
export async function archiveSession(path: string, cwd = workspace(), options?: { force?: boolean }) {
  if (!path || isSessionArchived(path)) return;
  const force = options?.force === true;
  if (!force && isSessionRunning(path)) {
    toast("warning", tr("This conversation is still running. Archive it after it finishes.", "对话仍在运行，结束后再归档。"), {
      durationMs: 7000,
      action: {
        label: tr("Archive anyway", "仍然归档"),
        onPress: () => void archiveSession(path, cwd, { force: true }),
      },
    });
    return;
  }
  const summary =
    sessions().find((s) => s.path === path) ??
    (sessionsByWorkspace()[cwd] ?? []).find((s) => s.path === path);
  const title =
    path === state()?.sessionFile
      ? currentTitle()
      : summary
        ? sessionTitle(summary, tr("Conversation", "对话"))
        : tr("Conversation", "对话");
  const held = daemonSessionByFile(path);
  // A background session holding this file ends with it; the open one moves to a new file instead.
  if (held?.loaded && held.id !== openDaemonId()) quietKill(held.id);
  // The list moves at once; leaving the open session follows, and puts the row back if it cannot.
  const open = path === state()?.sessionFile;
  setSessionArchived(path, true, cwd);
  if (open && !(await changeSession(tr("Could not archive the session", "无法归档会话"), requestNewSession))) {
    setSessionArchived(path, false);
    return;
  }
  toast("info", tr(`“${title}” archived.`, `「${title}」已归档。`), {
    icon: "archive",
    action: {
      label: tr("View archive", "查看归档"),
      onPress: () => showSettings("archive"),
    },
  });
}

/** Restores an archived session back into its workspace's active list. */
export function unarchiveSession(path: string) {
  if (!path || !isSessionArchived(path)) return;
  const targetCwd = archivedSessions()[path]?.cwd;
  setSessionArchived(path, false);
  if (targetCwd && targetCwd !== workspace() && !recentWorkspaces().includes(targetCwd)) {
    ensureWorkspaceListed(targetCwd);
    setWorkspaceCollapsed(targetCwd, false);
  }
  toast("info", tr("Restored from Archive.", "已从归档恢复。"));
}

/**
 * Permanently deletes all currently archived session files across workspaces,
 * keeping any session that was restored before deletion ran.
 */
export async function deleteAllArchivedSessions() {
  const targets = archivedSessionItems();
  if (targets.length === 0) return;
  const openFile = state()?.sessionFile;
  if (openFile && targets.some((t) => t.session.path === openFile)) {
    const left = await changeSession(tr("Could not close the session", "无法关闭会话"), requestNewSession);
    if (!left) return;
  }
  let deleted = 0;
  let failed = 0;
  const affectedCwds = new Set<string>();
  for (const { session, cwd } of targets) {
    if (!isSessionArchived(session.path)) continue;
    const held = daemonSessionByFile(session.path);
    if (held?.loaded && held.id !== openDaemonId()) quietKill(held.id);
    try {
      await backend().deleteSession(session.path);
      clearArchivedSessionPref(session.path);
      affectedCwds.add(cwd);
      deleted++;
    } catch {
      failed++;
    }
  }
  for (const cwd of affectedCwds) void refreshSessions(cwd);
  void refreshUsageStats();
  if (failed > 0) {
    toast("warning", tr(`Deleted ${deleted} archived sessions; ${failed} could not be deleted.`, `已删除 ${deleted} 个归档会话，${failed} 个未能删除。`));
  } else if (deleted > 0) {
    toast("info", tr(`Deleted ${deleted} archived session${deleted === 1 ? "" : "s"}.`, `已删除 ${deleted} 个归档会话。`));
  }
}

export async function archiveCurrentSession() {
  const file = state()?.sessionFile;
  if (!file) return;
  await archiveSession(file, workspace());
}

export function unarchiveCurrentSession() {
  const file = state()?.sessionFile;
  if (!file) return;
  unarchiveSession(file);
}

export async function toggleArchiveCurrentSession() {
  const file = state()?.sessionFile;
  if (!file) return;
  if (isSessionArchived(file)) unarchiveSession(file);
  else await archiveSession(file, workspace());
}

export async function removeSession(path: string, cwd = workspace()) {
  if (path === state()?.sessionFile) {
    const left = await changeSession(tr("Could not close the session", "无法关闭会话"), requestNewSession);
    if (!left) return;
  }
  // Deleting a run that is still going off screen stops it first: its file is going away.
  const held = daemonSessionByFile(path);
  if (held?.loaded && held.id !== openDaemonId()) quietKill(held.id);
  visited.delete(path);
  await attempt(tr("Could not delete the session", "无法删除会话"), () => backend().deleteSession(path));
  clearArchivedSessionPref(path);
  sessionsByWorkspace.update((all) => {
    const list = all[cwd];
    return list ? { ...all, [cwd]: list.filter((session) => session.path !== path) } : all;
  });
  if (cwd === workspace()) sessions.update((list) => list.filter((session) => session.path !== path));
  refreshSessions(cwd);
}

/** Compacts the context now; `instructions` say what the summary should keep (`/compact <instructions>`). */
export async function compactNow(instructions?: string) {
  if (running()) return void toast("info", tr("Wait for the run to finish before compacting.", "请等待当前运行结束后再压缩。"));
  await attempt(tr("Compaction failed", "压缩失败"), () => request("compact", instructions ? { customInstructions: instructions } : {}));
  refreshStats();
}

export async function exportHtml() {
  const result = await attempt(tr("Export failed", "导出失败"), () => request("export_html"));
  if (result) toast("success", tr(`Exported to ${result.path}`, `已导出至 ${result.path}`));
}

export async function copyLastReply() {
  const result = await attempt(tr("Could not copy", "无法复制"), () => request("get_last_assistant_text"));
  if (!result?.text) return void toast("info", tr("There is no reply to copy yet.", "暂无可复制的回复。"));
  await copyText(result.text);
}

export async function copyText(text: string) {
  await attempt(tr("Could not copy", "无法复制"), () => Clipboard.writeText(text));
  toast("success", tr("Copied", "已复制"));
}

/** Copies a message from its own button: the button says it was copied, so only a failure toasts. */
export async function copyMessage(text: string): Promise<boolean> {
  return (await attempt(tr("Could not copy", "无法复制"), async () => (await Clipboard.writeText(text), true))) ?? false;
}

// ── Model and behavior ──────────────────────────────────────────────────────

export async function chooseModel(model: Model) {
  const chosen = await attempt(tr("Could not switch model", "无法切换模型"), () => request("set_model", { provider: model.provider, modelId: model.id }));
  if (!chosen) return;
  rememberSessionChoice(currentAgentId(), { model: { provider: chosen.provider, id: chosen.id } });
  state.update((s) => s && { ...s, model: chosen });
  await Promise.all([refreshLevels(), refreshState().catch(() => undefined), refreshStats()]);
}

export async function chooseThinkingLevel(level: ThinkingLevel) {
  const applied = await attempt(tr("Could not change thinking", "无法更改思考深度"), async () => {
    await request("set_thinking_level", { level });
    return true;
  });
  if (!applied) return;
  rememberSessionChoice(currentAgentId(), { thinkingLevel: level });
  state.update((s) => s && { ...s, thinkingLevel: level });
}

export async function setSteeringMode(mode: QueueMode) {
  await attempt(tr("Could not change steering", "无法更改引导模式"), () => request("set_steering_mode", { mode }));
  state.update((s) => s && { ...s, steeringMode: mode });
}

export async function setFollowUpMode(mode: QueueMode) {
  await attempt(tr("Could not change follow-ups", "无法更改追问模式"), () => request("set_follow_up_mode", { mode }));
  state.update((s) => s && { ...s, followUpMode: mode });
}

export async function setAutoCompaction(enabled: boolean) {
  await attempt(tr("Could not change compaction", "无法更改自动压缩"), () => request("set_auto_compaction", { enabled }));
  state.update((s) => s && { ...s, autoCompactionEnabled: enabled });
}

export async function setAutoRetry(enabled: boolean) {
  rememberAutoRetry(enabled);
  await attempt(tr("Could not change retry", "无法更改自动重试"), () => request("set_auto_retry", { enabled }));
}

// ── Credentials ─────────────────────────────────────────────────────────────

export async function saveProviderKey(provider: string, key: string) {
  const saved = await attempt(tr("Could not save the key", "无法保存密钥"), async () => {
    await backend().saveApiKey(provider, key);
    return true;
  });
  if (!saved) return false;
  // Only a running Pi has a key to load: a session on another agent is left alone.
  if (activeAgent().driver !== "pi") {
    await refreshCredentials();
    toast("success", tr("Key saved. Pi loads it the next time it starts.", "密钥已保存，Pi 下次启动时加载。"));
    return true;
  }
  await restartPi();
  const connected = models().some((model) => model.provider === provider);
  toast(
    connected ? "success" : "warning",
    connected
      ? tr("Key saved. The provider's models are ready.", "密钥已保存，该服务商的模型已就绪。")
      : tr(`Key saved, but ${activeAgent().name} lists no models for this provider yet.`, `密钥已保存，但 ${activeAgent().name} 尚未列出该服务商的模型。`),
  );
  return true;
}

export async function removeProviderKey(provider: string) {
  const removed = await attempt(tr("Could not remove the credential", "无法移除凭据"), async () => {
    await backend().removeCredential(provider);
    return true;
  });
  if (!removed) return;
  if (activeAgent().driver === "pi") await restartPi();
  else await refreshCredentials();
}

// ── Navigation ──────────────────────────────────────────────────────────────

export function showChat() {
  view.set({ name: "chat" });
  focusComposer();
}

export function showSettings(section: SettingsSection = "general") {
  view.set({ name: "settings", section });
  if (section === "usage") void refreshUsageStats();
}

/** Opens Settings on one agent's configuration (the active agent's by default): every agent is set up under Agents. */
export function showAgentSettings(agentId: string = currentAgentId()) {
  view.set({ name: "settings", section: "agents", agent: agentId });
}

export function setPaletteOpen(open: boolean) {
  paletteOpen.set(open);
}

/** Opens the composer's model list, as a press on its chip does. */
export function openModelPicker() {
  view.set({ name: "chat" });
  modelPickerAsk.set(0);
}

// ── Wallpaper ────────────────────────────────────────────────────────────────

export {
  wallpaper,
  wallpaperEffect,
  wallpaperFolder,
  wallpaperHistory,
  wallpaperSource,
  wallpaperThemeColors,
};

const MAX_WALLPAPER_BYTES = 25 * 1024 * 1024;

function wallpapersDir(): string {
  return `${backend().dataDir().replace(/\/$/, "")}/new-thread-backgrounds`;
}

function isPathInsideFolder(filePath: string, folderPath?: string): boolean {
  if (!folderPath) return false;
  const cleanFolder = folderPath.replace(/\/$/, "");
  return filePath === cleanFolder || filePath.startsWith(`${cleanFolder}/`);
}

async function applyWallpaperFile(sourcePath: string, recordInHistory = true): Promise<boolean> {
  const bytes = await fs.readFile(sourcePath);
  if (bytes.byteLength > MAX_WALLPAPER_BYTES) {
    throw new Error(tr("Image must be 25 MB or smaller.", "图片大小不能超过 25 MB。"));
  }
  const info = inspectImageBytes(bytes);
  if (!info) {
    throw new Error(tr("Unsupported or corrupted image file.", "不支持或已损坏的图片文件。"));
  }

  const fileName = sourcePath.split("/").pop() || `wallpaper.${info.format}`;
  const dot = fileName.lastIndexOf(".");
  const ext = dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : info.format;
  const dir = wallpapersDir();
  let targetPath = sourcePath;

  try {
    await fs.mkdir(dir, { recursive: true });
    targetPath = `${dir}/background-${Date.now()}.${ext}`;
    await fs.writeFile(targetPath, bytes);
  } catch {
    // In headless tests or read-only sandboxes, fall back to referencing sourcePath directly.
    targetPath = sourcePath;
  }

  const prevPath = wallpaper()?.path;
  if (prevPath && prevPath !== targetPath && prevPath.startsWith(`${dir}/`)) {
    await fs.unlink(prevPath).catch(() => undefined);
  }

  const trackSource =
    recordInHistory || isPathInsideFolder(sourcePath, wallpaperFolder()) ? sourcePath : undefined;

  setWallpaperPref(
    {
      path: targetPath,
      name: fileName,
      width: info.width,
      height: info.height,
      adjustment: { ...DEFAULT_WALLPAPER_ADJUSTMENT },
      ...(info.dominantColor ? { dominantColor: info.dominantColor } : {}),
    },
    trackSource,
  );
  return true;
}

export async function chooseWallpaperImage(): Promise<boolean> {
  const picker = backend().pickImage;
  if (!picker) return false;
  const picked = await pickOrToast(picker(tr("Choose wallpaper", "选择壁纸图片")));
  if (!picked) return false;
  const ok = await attempt(tr("Could not set background image", "无法设置背景图片"), () =>
    applyWallpaperFile(picked, isPathInsideFolder(picked, wallpaperFolder())),
  );
  return Boolean(ok);
}

export async function setWallpaperFromPath(sourcePath: string): Promise<boolean> {
  const ok = await attempt(tr("Could not set background image", "无法设置背景图片"), () =>
    applyWallpaperFile(sourcePath, true),
  );
  return Boolean(ok);
}

export async function removeWallpaper() {
  const current = wallpaper();
  if (!current) return;
  const dir = wallpapersDir();
  if (current.path.startsWith(`${dir}/`)) {
    await fs.unlink(current.path).catch(() => undefined);
  }
  setWallpaperPref(null, undefined);
}

export function updateWallpaperAdjustment(adjustment: WallpaperAdjustment) {
  setWallpaperAdjustmentPref(adjustment);
}

export function setWallpaperEffect(effect: WallpaperEffect) {
  setWallpaperEffectPref(effect);
}

export function setWallpaperThemeColors(enabled: boolean) {
  setWallpaperThemeColorsPref(enabled);
}

export async function chooseWallpaperFolder() {
  const picked = await pickOrToast(backend().pickFolder(tr("Choose wallpaper folder", "选择壁纸文件夹")));
  if (!picked) return;
  setWallpaperFolderPref(picked);
  await randomWallpaper(picked);
}

export function clearWallpaperFolder() {
  setWallpaperFolderPref(undefined);
}

export async function randomWallpaper(folderOverride?: string): Promise<boolean> {
  const folder = (folderOverride ?? wallpaperFolder())?.trim();
  if (!folder) {
    toast(
      "info",
      tr(
        "Set a wallpaper folder in Settings → General first.",
        "请先在「设置 → 通用」中设置壁纸文件夹。",
      ),
    );
    return false;
  }

  const chosen = await attempt(tr("Could not switch wallpaper", "无法切换随机壁纸"), async () => {
    const names = await fs.readdir(folder);
    const candidates = names
      .filter((name) => !name.startsWith(".") && isSupportedWallpaperPath(name))
      .sort((a, b) => a.localeCompare(b))
      .map((name) => `${folder.replace(/\/$/, "")}/${name}`);

    if (candidates.length === 0) {
      toast("warning", tr("No supported images found in wallpaper folder.", "壁纸文件夹中未找到受支持的图片。"));
      return false;
    }

    const candidate = chooseRandomWallpaperCandidate(candidates, wallpaperSource(), wallpaperHistory());
    if (!candidate) return false;
    await applyWallpaperFile(candidate, true);
    return true;
  });

  return Boolean(chosen);
}
