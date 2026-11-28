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
import { basename, tildePath } from "../lib/format";
import { activeLanguage, tr } from "../lib/i18n";
import { composeDocMessage, composeReplyMessage, titleWords } from "../lib/doc-wire";
import { classifyMediaKind, composeFileMessage, isMarkdownPath, mimeTypeForPath, type FileAttachment } from "../lib/media";
import { formAnswerText } from "../lib/form-answers";
import { answersTo, type ComposerCommand, parseSlashLine } from "../lib/slash";
import { markPacersSeeded } from "../lib/stream-pacer";
import { markVeilsSeeded, reseedVeils } from "../lib/veil";
import { pipiWorktreeBaseCwd, projectListPath } from "../lib/worktree-path";
import {
  chooseRandomWallpaperCandidate,
  DEFAULT_WALLPAPER_ADJUSTMENT,
  DYNAMIC_WALLPAPER_ENABLED,
  inspectImageBytes,
  inspectWallpaperBytes,
  isAvailableWallpaperEffect,
  isSupportedWallpaperPath,
  isVideoWallpaperPath,
  isWallpaperPreset,
  parseWallpaperEngineProject,
  WALLPAPER_PRESET_META,
  type WallpaperAdjustment,
  type WallpaperEffect,
  type WallpaperPauseMode,
  type WallpaperPreset,
  type WallpaperVideoClickAction,
} from "../lib/wallpaper";
import type { Mood } from "../mascot/geometry";
import { type Exit, PiClient, PiError, type Transport } from "../pi/client";
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
import { piHistoryMessages } from "../pi/session-file";
import { type SessionSnapshot, type SessionSummary, sessionTitle } from "../pi/sessions";
import { EMPTY_USAGE, type UsageStats } from "../pi/usage";
import { killAllSidecars, SidecarError } from "../pi/sidecar";
import { type Row, sameVisualRows, Transcript, withoutPreamble, withoutImageNotes } from "../pi/transcript";
import { displayRowIds } from "../pi/turns";
import type { IconName } from "../ui/Icon";
import { enableLiveRowEntrance, markRowsSeen } from "../ui/motion";
import { backend, NoPickerError } from "./backend";
import { clearPipReply, loadPipInteractions, pipReplyTarget, replyWirePart } from "./pip-interactions";
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
  markArchivedSessionGone,
  ensureWorkspaceListed,
  forgetWorkspace,
  isSessionArchived,
  isWorkspaceCollapsed,
  lastActiveWorkspace,
  loadPrefs,
  onDaemonPrefsChange,
  onWorkspacesChange,
  preferredAgentId,
  preferredPersonalAgentId,
  setPreferredPersonalAgentId,
  preferredRuntimeMode,
  recentWorkspaces,
  rememberAutoRetry,
  rememberPersonaAgentChoice,
  rememberPersonaChoice,
  rememberSessionChoice,
  rememberWorkspace as listWorkspace,
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
  setWallpaperAgentReactivePref,
  setWallpaperDimensionsPref,
  setWallpaperEffectPref,
  setWallpaperFolderPref,
  setWallpaperInteractivePref,
  setWallpaperMutedPref,
  setWallpaperPausedPref,
  setWallpaperPauseModePref,
  setWallpaperPref,
  setWallpaperThemeColorsPref,
  setWallpaperVideoClickActionPref,
  setWorkspaceCollapsed,
  seedPersonaChoice,
  storedAgentOverrides,
  storedCustomAgents,
  storedPersonaAgentChoice,
  storedPersonaChoice,
  storedSessionChoice,
  storedSessionChoices,
  wallpaper,
  wallpaperAgentReactive,
  wallpaperEffect,
  wallpaperFolder,
  wallpaperHistory,
  wallpaperInteractive,
  wallpaperMuted,
  wallpaperPaused,
  wallpaperPauseMode,
  wallpaperSource,
  wallpaperThemeColors,
  wallpaperVideoClickAction,
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

/** Settings on `section`; `agent` names the agent whose configuration is open inside Agents. A `doc` names the open document's file. */
export type View = { name: "chat" } | { name: "doc"; docId: string } | { name: "settings"; section: SettingsSection; agent?: string };
export type SettingsSection = "general" | "agents" | "sessions" | "archive" | "usage" | "shortcuts" | "about";

const phase = signal<Phase>({ name: "starting" });
const workspace = signal("");
const state = signal<SessionState | undefined>(undefined);
const models = signal<Model[]>([]);
const levels = signal<ThinkingLevel[]>(["off"]);
const stats = signal<SessionStats | undefined>(undefined);
const usage = signal<UsageStats>(EMPTY_USAGE);
const usageLoaded = signal(false);
const commands = signal<SlashCommand[]>([]);
const sessions = signal<SessionSummary[]>([]);
const sessionsByWorkspace = signal<Record<string, SessionSummary[]>>({});
const sessionsLoaded = signal(false);
const rows = signal<Row[]>([]);
/** Which conversation `rows` are: set with them, so nothing reads one conversation's rows as another's. */
const conversation = signal(0);
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
function setViewChat() {
  if (view().name !== "chat") view.set({ name: "chat" });
}
const draft = signal("");
const attachments = signal<Attachment[]>([]);
const fileAttachments = signal<FileAttachment[]>([]);
const docRefs = signal<DocRef[]>([]);
const composerFocus = signal(0, { equals: false });
/** Ticks when something outside the model chip (`/model`) asks for its list. */
const modelPickerAsk = signal(0, { equals: false });
const scrollToEnd = signal(0, { equals: false });
/** The staged row of a send that begins a fresh run: the chat's cue to track its prompt to the reading horizon. */
const sendAnchor = signal<{ rowId: string } | undefined>(undefined, { equals: false });
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
/** A fast disk-snapshot read is in flight inside its brief grace window before dimming. */
const snapPending = signal(false);
const LEAVING_GRACE_MS = 70;
let leavingGraceTimer: ReturnType<typeof setTimeout> | undefined;
function clearLeavingGrace() {
  if (leavingGraceTimer !== undefined) {
    clearTimeout(leavingGraceTimer);
    leavingGraceTimer = undefined;
  }
}
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

/**
 * Where a chat with no project runs: an empty folder of the app's own, under no
 * repository, so no project's `AGENTS.md` or `CLAUDE.md` rides along. Shown as
 * a special built-in workspace (闲聊) under 工作区 and in 最近, never persisted
 * into the user's project workspace list.
 */
export const chatFolder = () => `${backend().dataDir().replace(/\/$/, "")}/chat`;
export const isChatFolder = (cwd: string | undefined) => Boolean(cwd) && cwd === chatFolder();
/** A folder as the reader knows it: `~/code/app`, or 闲聊 for the chat folder. */
export const placeLabel = (cwd: string) => (isChatFolder(cwd) ? tr("Chat", "闲聊") : tildePath(cwd, backend().home()));

/** The project last worked in, else the first remembered one, else home. */
export function lastProject() {
  const list = recentWorkspaces();
  const last = lastActiveWorkspace();
  return (last && list.includes(last) ? last : list[0]) ?? backend().home();
}

function rememberProject(path: string) {
  if (!isChatFolder(path)) rememberWorkspace(path);
}

/** Makes sure the chat folder is there for an agent to start in; resolves with its path. */
export async function ensureChatFolder() {
  const dir = chatFolder();
  await fs.mkdir(dir, { recursive: true }).catch(() => undefined);
  return dir;
}
export const sessionState = () => state();
export const availableModels = () => models();
export const thinkingLevels = () => levels();
export const sessionStats = () => stats();
/** Token use and cost across every saved session on this machine (`sidecar/usage-stats.mjs`). */
export const usageStats = () => usage();
export const usageReady = () => usageLoaded();
export interface ArchivedSessionItem {
  id: string;
  session: SessionSummary;
  cwd: string;
  archivedAt: number;
}

function sameArrayRefs<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sameSessionSummary(a: SessionSummary, b: SessionSummary): boolean {
  return (
    a.path === b.path &&
    a.id === b.id &&
    a.name === b.name &&
    a.firstMessage === b.firstMessage &&
    a.messageCount === b.messageCount &&
    a.created === b.created &&
    a.modified === b.modified &&
    a.agentId === b.agentId
  );
}

/** Reuses unchanged `SessionSummary` object refs and returns `prev` itself when the whole list is structurally identical. */
function reconcileSessionList(prev: SessionSummary[] | undefined, next: SessionSummary[]): SessionSummary[] {
  if (!prev) return next;
  const byPath = new Map<string, SessionSummary>();
  for (const item of prev) byPath.set(item.path, item);
  let same = prev.length === next.length;
  const merged = next.map((item, idx) => {
    const existing = byPath.get(item.path);
    if (existing && sameSessionSummary(existing, item)) {
      if (same && prev[idx] !== existing) same = false;
      return existing;
    }
    same = false;
    return item;
  });
  return same ? prev : merged;
}

const activeSessionFile = computed(() => state()?.sessionFile);

export const savedSessions = computed<SessionSummary[]>(() => sessions().filter((s) => !isSessionArchived(s.path)), {
  equals: sameArrayRefs,
});
let prevWorkspaceSessions: Record<string, SessionSummary[]> = {};
export const workspaceSessions = computed<Record<string, SessionSummary[]>>(() => {
  const raw = sessionsByWorkspace();
  const out: Record<string, SessionSummary[]> = {};
  let changed = Object.keys(raw).length !== Object.keys(prevWorkspaceSessions).length;
  for (const [cwd, list] of Object.entries(raw)) {
    const filtered = list.filter((s) => !isSessionArchived(s.path));
    const prevList = prevWorkspaceSessions[cwd];
    if (prevList && sameArrayRefs(prevList, filtered)) {
      out[cwd] = prevList;
    } else {
      out[cwd] = filtered;
      changed = true;
    }
  }
  if (!changed) return prevWorkspaceSessions;
  prevWorkspaceSessions = out;
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
      if (!meta || meta.gone || seen.has(session.path)) continue;
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
  // A session started under another may be listed under no open folder (a worktree's, a folder since closed):
  // the daemon's record of it stands in for the summary, so what was archived from the tree is in the archive.
  for (const held of daemonSessionList()) {
    const meta = held.file ? map[held.file] : undefined;
    if (!held.file || !meta || meta.gone || seen.has(held.file)) continue;
    seen.add(held.file);
    const named = held.title && held.title !== "New session" ? titleWords(held.title).replace(/\s+/g, " ").trim() : "";
    out.push({
      id: `archived:${held.file}`,
      session: {
        path: held.file,
        id: held.id,
        name: named || undefined,
        firstMessage: named,
        messageCount: 0,
        created: held.createdAt,
        modified: held.lastActive,
        agentId: held.agentId,
      },
      cwd: meta.cwd || projectCwdOf(held.cwd, held),
      archivedAt: meta.archivedAt || held.lastActive,
    });
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
export const composerFiles = () => fileAttachments();
export const composerDocs = () => docRefs();
export const composerFocusTick = () => composerFocus();
export const modelPickerTick = () => modelPickerAsk();
export const scrollToEndTick = () => scrollToEnd();
/** The staged row of a send that began a fresh run: the chat's cue to track its prompt to the reading horizon. */
export const sendAnchorTick = () => sendAnchor();
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
/** A cold session switch is inside its brief grace window waiting on a local disk snapshot before dimming. */
export const isSnapshotPending = () => snapPending();
/** Ticks each time a session change shows its destination, so the chat settles it in once. */
export const sessionArrivedTick = () => arrived();
/** The change under way is heading for a fresh session, whose empty chat is already on screen. */
export const isDraftAhead = () => heading()?.welcome === true;

type Heading = {
  cwd: string;
  file?: string;
  daemonId?: string;
  agentId?: string;
  keepTitle?: boolean;
  /** A fresh session's empty chat is shown ahead of the agent. */
  welcome?: boolean;
};

/** Cached models and thinking levels per agent id so fresh/inline sessions know ahead what an engine offers. */
const modelsByAgent = new Map<string, Model[]>();
const levelsByAgent = new Map<string, ThinkingLevel[]>();
const catalogCacheVersion = signal(0);

export function cachedModelsForAgent(agentId: string): Model[] {
  catalogCacheVersion();
  const cached = modelsByAgent.get(agentId);
  if (cached && cached.length > 0) return cached;
  if (agentId === currentAgentId()) {
    const live = models();
    if (live.length > 0) return live;
  }
  return agents().find((a) => a.id === agentId)?.models ?? [];
}

export function cacheAgentModels(agentId: string, list: Model[]) {
  if (!agentId) return;
  if (list.length) modelsByAgent.set(agentId, list);
  else modelsByAgent.delete(agentId);
  catalogCacheVersion.update((n) => n + 1);
}

export function cachedThinkingLevelsForAgent(agentId: string): ThinkingLevel[] {
  catalogCacheVersion();
  const cached = levelsByAgent.get(agentId);
  if (cached && cached.length > 0) return cached;
  if (agentId === currentAgentId()) return levels();
  return ["off"];
}

export function cacheAgentThinkingLevels(agentId: string, list: ThinkingLevel[]) {
  if (!agentId) return;
  if (list.length) levelsByAgent.set(agentId, list);
  else levelsByAgent.delete(agentId);
  catalogCacheVersion.update((n) => n + 1);
}

function agentHasModel(agentId: string): boolean {
  if (agentId === currentAgentId() && hasModel()) return true;
  const cached = modelsByAgent.get(agentId);
  if (cached && cached.length > 0) return true;
  const spec = agents().find((a) => a.id === agentId);
  return Boolean(spec && spec.available && spec.models.length > 0);
}

function hasLiveRow(list: readonly Row[]): boolean {
  return list.some(
    (row) =>
      ((row.kind === "text" || row.kind === "thinking") && row.streaming) ||
      (row.kind === "tool" && (row.status === "call" || row.status === "queued" || row.status === "running")) ||
      (row.kind === "bash" && row.running),
  );
}

/**
 * Marks a session change as heading for `target` until `work` ends.
 *
 * A change answers the click, not the agent: a conversation seen before goes
 * on screen at once from `visited` (the agent's own history confirms or
 * replaces it as it lands), and so does a fresh session's empty chat. A saved
 * file read gets a brief grace window before dimming so fast local snapshots
 * land directly at steady opacity 1 without a blink/fade-in; only a genuinely
 * slow switch (or one with no file to read) dims and waits (`leaving`).
 */
async function headFor<T>(goal: Heading, work: () => Promise<T>): Promise<T> {
  let target = goal;
  let shown = false;
  let run!: Promise<T>;
  clearLeavingGrace();
  if (!goal.keepTitle) {
    // The app is usable already: ready, a welcome shown ahead, or content a
    // switch in flight already put on screen. Only a cold boot is not warm —
    // its "starting" stage stands until the first agent answers.
    const warm = phase().name === "ready" || isDraftAhead() || ahead !== undefined || transcript.rows().length > 0;
    const seenFile = goal.file ?? (goal.daemonId ? daemonSessionOfId(goal.daemonId)?.file : undefined);
    const seenDaemonId = goal.daemonId ?? (goal.file ? daemonSessionByFile(goal.file)?.id : undefined);
    const seenDaemon = seenDaemonId ? daemonSessionOfId(seenDaemonId) : undefined;
    const emptyDaemon =
      Boolean(goal.daemonId) &&
      !seenFile &&
      seenDaemon !== undefined &&
      seenDaemon.status !== "working" &&
      seenDaemon.status !== "blocked";
    const welcome = !goal.file && (!goal.daemonId || emptyDaemon) && warm && agentHasModel(goal.agentId ?? currentAgentId());
    stashTranscript();
    const seenWorking = Boolean(seenDaemon && (seenDaemon.status === "working" || seenDaemon.status === "blocked"));
    let seen = (seenFile ? visited.get(seenFile) : undefined) ?? (seenDaemonId ? visitedByDaemon.get(seenDaemonId) : undefined);
    // Invalidate stale cached transcripts: a session that became unread/finished in background
    // or still carries streaming/running rows while the daemon says idle must read fresh from disk.
    if (seen && ((seenFile && isSessionUnread(seenFile)) || seenDaemon?.unread || (!seenWorking && hasLiveRow(seen.rows())))) {
      if (seenFile) visited.delete(seenFile);
      if (seenDaemonId) visitedByDaemon.delete(seenDaemonId);
      seen = undefined;
    }
    if (seen) {
      if (seenFile) visited.delete(seenFile);
      if (seenDaemonId) visitedByDaemon.delete(seenDaemonId);
      transcript = seen;
      ahead = { transcript: seen, file: seenFile, daemonId: seenDaemonId };
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
    // A welcome/empty screen has nothing to fade — and a cold saved-file switch
    // holds steady during a brief grace window so fast local reads land at opacity 1.
    const hadContent = rows().length > 0;
    const shouldDim = !shown && hadContent && (leaving() || warm);
    const snapFile = !shown ? (goal.file ?? (goal.daemonId ? daemonSessionOfId(goal.daemonId)?.file : undefined)) : undefined;
    const deferDim = Boolean(snapFile) && !leaving();
    batch(() => {
      heading.set(target);
      snapPending.set(deferDim);
      leaving.set(deferDim ? false : shouldDim);
      if (shown) {
        if (seenWorking && !running()) runStartedAt.set(Date.now());
        running.set(seenWorking);
        bashRunning.set(false);
        activity.set(seenWorking ? { kind: "thinking" } : { kind: "idle" });
        queue.set({ steering: [], followUp: [] });
        dialogs.set([]);
        statuses.set({});
        widgets.set({});
        flush();
        landed.update((n) => n + 1);
        scrollToEnd.set(0);
        arrived.update((n) => n + 1);
      }
      run = work();
    });
    // Nothing cached or fresh to show — the saved file still can be: it reads
    // in milliseconds while the agent attaches and confirms with its own.
    if (snapFile) {
      const snapHeld = (goal.daemonId ? daemonSessionOfId(goal.daemonId) : undefined) ?? daemonSessionByFile(snapFile);
      const epoch = ++snapshotEpoch;
      if (deferDim) {
        leavingGraceTimer = setTimeout(() => {
          leavingGraceTimer = undefined;
          if (snapshotEpoch !== epoch || heading() !== target || ahead) return;
          batch(() => {
            snapPending.set(false);
            if (shouldDim) leaving.set(true);
          });
        }, LEAVING_GRACE_MS);
      }
      void backend()
        .readSessionSnapshot(snapFile, { keepBackgroundTools: Boolean(snapHeld?.loaded) })
        .then((snap) => {
          if (snapshotEpoch !== epoch || heading() !== target || ahead) return;
          if (!snap?.messages.length) {
            clearLeavingGrace();
            batch(() => {
              snapPending.set(false);
              if (shouldDim) leaving.set(true);
            });
            return;
          }
          landSnapshot(snapFile, goal.daemonId, snap);
        })
        .catch(() => {
          if (snapshotEpoch !== epoch || heading() !== target || ahead) return;
          clearLeavingGrace();
          batch(() => {
            snapPending.set(false);
            if (shouldDim) leaving.set(true);
          });
        });
    }
  } else {
    batch(() => {
      heading.set(target);
      snapPending.set(false);
      run = work();
    });
  }
  arrival = run.then(
    () => undefined,
    () => undefined,
  );
  try {
    return await run;
  } finally {
    if (heading() === target) {
      early = false;
      clearLeavingGrace();
      batch(() => {
        heading.set(undefined);
        snapPending.set(false);
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
  const known = daemonSessionByFile(path);
  const daemonBusy = known?.status === "working" || known?.status === "blocked";
  if (path === activeSessionFile()) return hasActiveOrQueuedWork() || daemonBusy;
  return daemonBusy;
}

/** Whether a background run finished with something the user has not seen yet. */
export function isSessionUnread(path: string) {
  return daemonSessionByFile(path)?.unread === true || unreadSessions().includes(path);
}

function markSessionUnread(path: string) {
  visited.delete(path);
  if (!unreadSessions().includes(path)) unreadSessions.set([...unreadSessions(), path]);
}

function markSessionRead(path: string | undefined) {
  if (!path) return;
  const wasUnread = unreadSessions().includes(path) || daemonSessionByFile(path)?.unread === true;
  if (wasUnread) visited.delete(path);
  if (unreadSessions().includes(path)) unreadSessions.set(unreadSessions().filter((p) => p !== path));
}

// ── Session daemon accessors ────────────────────────────────────────────────

/** Every session in the daemon's registry: the app's own, agent-started children, compare runs. */
export const daemonSessions = () => daemonSessionList();

const daemonIndex = computed(() => {
  const byId = new Map<string, DaemonSession>();
  const byFile = new Map<string, DaemonSession>();
  const byParent = new Map<string, DaemonSession[]>();
  for (const s of daemonSessionList()) {
    byId.set(s.id, s);
    if (s.file && !byFile.has(s.file)) byFile.set(s.file, s);
    if (s.parentId) {
      let group = byParent.get(s.parentId);
      if (!group) byParent.set(s.parentId, (group = []));
      group.push(s);
    }
  }
  return { byId, byFile, byParent };
});

/** Every personal agent the daemon keeps, stable in creation order. */
export const personalAgents = computed(() => daemonSessionList().filter((s) => s.persona).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)));

/** The legacy default personal agent (Pip), kept as the zero-configuration entry. */
export const personalAgent = computed(() => personalAgents().find((s) => (s.personaId ?? "default") === "default") ?? personalAgents()[0]);

/** Whether `cwd` is any personal agent's folder of notes, which is never a project. */
export function isPersonaFolder(cwd: string | undefined) {
  return Boolean(cwd && personalAgents().some((persona) => persona.cwd === cwd));
}

/** Lists a project folder as the active workspace; Pip's folder of notes is not one. */
function rememberWorkspace(path: string) {
  if (!isPersonaFolder(path)) listWorkspace(path);
}

/** A daemon session by its daemon id. */
export function daemonSessionOfId(id: string | undefined) {
  return id ? daemonIndex().byId.get(id) : undefined;
}

/** A daemon session by the session file it holds. */
export function daemonSessionByFile(path: string | undefined) {
  return path ? daemonIndex().byFile.get(path) : undefined;
}

/** Whether `start` or any session above it in the daemon's ownership tree is a personal agent. */
function chainReachesPersona(start: DaemonSession, byId: ReadonlyMap<string, DaemonSession>): boolean {
  const seen = new Set<string>();
  let cur: DaemonSession | undefined = start;
  while (cur && !seen.has(cur.id)) {
    if (cur.persona) return true;
    seen.add(cur.id);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return false;
}

/**
 * Whether a session is persona-driven: started under a personal agent, or handed
 * to one upstream (`initiator` is the live turn's caller, `upstreamInitiator`
 * the chain the daemon keeps after the turn settles). User/external starts are not.
 */
export function isPersonaDrivenSession(session: DaemonSession | undefined): boolean {
  if (!session) return false;
  const { byId } = daemonIndex();
  if (chainReachesPersona(session, byId)) return true;
  for (const id of [session.initiator, session.upstreamInitiator]) {
    if (!id || id === "user" || id === "external") continue;
    const source = byId.get(id);
    if (source && chainReachesPersona(source, byId)) return true;
  }
  return false;
}

/**
 * Cycle-safe depth-first walk of every descendant session under `rootId`.
 * `listed` leaves out what the reader archived, with everything under it: the
 * tree as the sidebar shows it. Work is counted on the whole tree.
 */
function descendantSessionsOf(rootId: string | undefined, listed = false): DaemonSession[] {
  if (!rootId) return [];
  const { byParent } = daemonIndex();
  const out: DaemonSession[] = [];
  const seen = new Set<string>([rootId]);
  const visit = (pid: string) => {
    const children = byParent.get(pid);
    if (!children) return;
    for (const s of children) {
      if (!seen.has(s.id)) {
        seen.add(s.id);
        if (listed && isSessionArchived(s.file)) continue;
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
  return descendantSessionsOf(sessionId, true);
}

export function sidebarSessionParent(session: DaemonSession | undefined): string | undefined {
  const parentId = session?.parentId;
  return daemonSessionOfId(parentId)?.persona ? undefined : parentId;
}

export function sidebarSessionDepth(session: DaemonSession): number {
  let depth = 0;
  let cur = session;
  const seen = new Set<string>([cur.id]);
  let parentId = sidebarSessionParent(cur);
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    depth++;
    const parent = daemonSessionOfId(parentId);
    if (!parent) break;
    cur = parent;
    parentId = sidebarSessionParent(cur);
  }
  return depth;
}

/**
 * Where a daemon session's subtree hangs in a list of saved files: `claimed`
 * is the nearest ancestor whose file is in `files` (the row its tree nests
 * under); when no ancestor claims it, `top` is the unclaimed top of the chain —
 * the session itself when it stands alone.
 */
export function daemonTreePlace(session: DaemonSession, files: ReadonlySet<string>): { claimed?: DaemonSession; top: DaemonSession } {
  const { byId } = daemonIndex();
  const seen = new Set<string>([session.id]);
  let cur = session;
  while (cur.parentId && !seen.has(cur.parentId)) {
    seen.add(cur.parentId);
    const up = byId.get(cur.parentId);
    if (!up || up.persona) break;
    if (up.file && files.has(up.file)) return { claimed: up, top: up };
    // A personal agent is a sidebar boundary, not a parent row: coding sessions
    // it starts stand beside the user's own sessions rather than nesting under Pip.
    if (up.persona) return { top: cur };
    cur = up;
  }
  return { top: cur };
}

/** Whether `session` is an explicit daemon task (child, external caller, or named job) rather than an untitled UI scratchpad. */
export function isDaemonTaskSession(session: DaemonSession | undefined): boolean {
  return Boolean(session && (session.parentId || session.initiator === "external" || session.titleLocked));
}

/** Whether a tree root earns a sidebar row of its own: work, a wait, an unread answer, a named job, or an outside caller. */
export function daemonRootEarnsRow(session: DaemonSession): boolean {
  return !session.persona && (
    Boolean(session.parentId && !sidebarSessionParent(session)) ||
    session.initiator === "external" || Boolean(session.titleLocked) || session.status !== "idle" || session.unread
  );
}

/** Sessions started under the session whose file is `path`, nested in the sidebar under it. */
export function childSessionsOf(path: string | undefined): DaemonSession[] {
  if (!path) return [];
  const own = daemonSessionByFile(path);
  return descendantSessionsOf(own?.id, true);
}

/** Sessions started under the OPEN session while it is still a draft (not yet in `savedSessions`). */
export function childSessionsOfOpen(): DaemonSession[] {
  const id = openDaemonId();
  if (!id) return [];
  const file = openFile();
  if (file && savedSessions().some((s) => s.path === file)) return [];
  return descendantSessionsOf(id, true);
}

/** Maps a child worktree directory back to its owning project folder so child worktrees don't clutter Workspaces. */
export function projectCwdOf(cwd: string, session?: DaemonSession): string {
  if (!cwd) return cwd;
  const worktreeBase = projectListPath(session?.worktree?.path);
  if (worktreeBase) return worktreeBase;
  const declaredBase = projectListPath(session?.worktree?.baseCwd);
  if (declaredBase) return declaredBase;
  const layoutBase = pipiWorktreeBaseCwd(cwd);
  if (layoutBase) return layoutBase;
  if (session?.parentId && cwd.includes("/.pipi-worktrees/")) {
    const { byId } = daemonIndex();
    const seen = new Set<string>([session.id]);
    let cur: DaemonSession | undefined = session;
    while (cur?.parentId && !seen.has(cur.parentId)) {
      seen.add(cur.parentId);
      const up = byId.get(cur.parentId);
      if (!up || up.persona) break;
      const parentBase = projectListPath(up.worktree?.path) ?? projectListPath(up.worktree?.baseCwd);
      if (parentBase) return parentBase;
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

/** The daemon's record of the destination while a session change is still heading there — earlier than the attach's own word. */
export const headingDaemonSession = computed(() => {
  const target = heading();
  if (!target) return undefined;
  return target.daemonId ? daemonSessionOfId(target.daemonId) : daemonSessionByFile(target.file);
});

/** The personal-agent session currently shown (or immediately landing), if the conversation is one. */
export const activePersonaSession = computed(() => {
  const target = !leaving() ? heading() : undefined;
  if (target) {
    const ds = target.daemonId ? daemonSessionOfId(target.daemonId) : daemonSessionByFile(target.file);
    if (ds?.persona) return ds;
    return undefined;
  }
  const current = currentDaemonSession();
  return current?.persona ? current : undefined;
});

/** Whether the conversation currently shown (or immediately landing) is a personal agent. */
export const isPersonaSession = computed(() => Boolean(activePersonaSession()));

/** The shown persona's stable id (`"default"` is the legacy Pip). */
export const activePersonaId = computed(() => activePersonaSession()?.personaId ?? (activePersonaSession() ? "default" : undefined));

/** Display name of the active persona (its daemon title, defaulting to `"Pip"`). */
export const personaDisplayName = computed(() => {
  const persona = activePersonaSession() ?? personalAgent();
  return persona ? daemonSessionTitle(persona) : "Pip";
});

/** Custom avatar image of the active persona, copied inside its folder; undefined means the Pip mascot. */
export const personaAvatar = computed(() => activePersonaSession()?.avatar);

/** Descendant sessions under the currently open (or landing) session, in tree order. */
export const currentChildSessions = computed<DaemonSession[]>(() => {
  const target = !leaving() ? heading() : undefined;
  const id = target ? (target.daemonId ?? daemonSessionByFile(target.file)?.id) : openDaemonId();
  return descendantSessionsOf(id, true);
});

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
  const { byId, byFile } = daemonIndex();
  const own = path ? byFile.get(path) : undefined;
  const parent = own?.parentId ? byId.get(own.parentId) : undefined;
  return parent ? { id: parent.id, file: parent.file, cwd: parent.cwd, title: daemonSessionTitle(parent) } : undefined;
}

/** The parent of whichever session is currently open on screen (works with or without a session file). */
export const currentParentSession = computed((): { id: string; file?: string; cwd: string; title: string } | undefined => {
  const { byId, byFile } = daemonIndex();
  const target = heading();
  const own = target
    ? (target.daemonId ? byId.get(target.daemonId) : target.file ? byFile.get(target.file) : undefined)
    : (daemonSessionOfId(openDaemonId()) ?? (openFile() ? byFile.get(openFile()!) : undefined));
  const parent = own?.parentId ? byId.get(own.parentId) : undefined;
  return parent ? { id: parent.id, file: parent.file, cwd: parent.cwd, title: daemonSessionTitle(parent) } : undefined;
});

/**
 * Sessions working under the open one: the open session itself is at rest, so
 * this is the "waiting on N sessions" the activity line and the Stop affordance use.
 */
export const waitingCount = computed(() => {
  const target = !leaving() ? heading() : undefined;
  const id = target ? (target.daemonId ?? daemonSessionByFile(target.file)?.id) : openDaemonId();
  return descendantSessionsOf(id).filter((session) => session.status === "working" || session.status === "blocked").length;
});

/** Count of all daemon sessions currently running or waiting on confirmation across the machine. */
export const activeDaemonSessionCount = computed(
  () => daemonSessionList().filter((session) => session.status === "working" || session.status === "blocked").length,
);

/** The highest runtime permission mode the open session is allowed to hold (clamped by all ancestors). */
export const currentRuntimeCeiling = computed<RuntimeMode>(() => {
  const { byId } = daemonIndex();
  const seen = new Set<string>();
  let ceiling: RuntimeMode = "full-access";
  let cur = currentDaemonSession();
  if (cur) seen.add(cur.id);
  while (cur?.parentId && !seen.has(cur.parentId)) {
    seen.add(cur.parentId);
    const parent = byId.get(cur.parentId);
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

/**
 * The conversation those rows belong to. It changes with them, in the same
 * turn, and only when they become another conversation's: the same one loaded
 * again (a session opened again, its agent restarted) keeps its key, and its
 * rows their ids (`Transcript.adopt`). What the chat keeps per conversation —
 * the reader's folds — is kept under it.
 */
export const conversationKey = () => conversation();

/** Whether a model is selected that the active agent can call. */
export const hasModel = computed(() => {
  const model = state()?.model;
  return !!model && model.provider !== "unknown" && models().length > 0;
});

/** Optimistic model for a fresh draft session shown ahead of the agent (`isDraftAhead`). */
export const draftModel = computed<Model | undefined>(() => {
  if (!isDraftAhead()) return undefined;
  const id = currentAgentId();
  const cached = modelsByAgent.get(id);
  const list = cached && cached.length ? cached : (agents().find((a) => a.id === id)?.models ?? models());
  const wanted = storedSessionChoice(id)?.model;
  if (wanted) {
    const picked = list.find((m) => m.id === wanted.id && m.provider === wanted.provider) ?? list.find((m) => m.id === wanted.id);
    if (picked) return picked;
  }
  return list[0];
});

/** Optimistic thinking depth for a fresh draft session shown ahead of the agent (`isDraftAhead`). */
export const draftThinkingLevel = computed<ThinkingLevel | undefined>(() => {
  if (!isDraftAhead()) return undefined;
  return currentSessionChoice()?.thinkingLevel;
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
    if (found) return sessionDisplayTitle(found, tr("New session", "新会话"));
  }
  const ds = currentDaemonSession();
  if (ds?.persona) return daemonSessionTitle(ds);
  const name = state()?.sessionName;
  if (name) return name;
  if (ds?.title && ds.title !== "New session") return daemonSessionTitle(ds);
  const first = rows().find((row) => row.kind === "user");
  if (first?.kind === "user" && first.text) {
    return sessionTitle({ firstMessage: first.text }, tr("New session", "新会话"));
  }
  if (isDaemonTaskSession(ds)) {
    return daemonSessionTitle(ds!);
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
/** The key of the conversation each transcript holds (`conversationKey`). */
const conversationOf = new WeakMap<Transcript, number>();
let conversationSeq = 0;
function keyOf(held: Transcript) {
  let key = conversationOf.get(held);
  if (key === undefined) conversationOf.set(held, (key = ++conversationSeq));
  return key;
}
/** `next` is `before`'s conversation, loaded again: it goes on under its key, its rows under their ids. */
function succeed(before: Transcript, next: Transcript) {
  next.adopt(before.rows());
  conversationOf.set(next, keyOf(before));
}
/**
 * Conversations the reader left at rest, by session file: opening one again
 * shows it with the click instead of after the agent has loaded it.
 */
const visited = new Map<string, Transcript>();
const visitedByDaemon = new Map<string, Transcript>();
const VISITED_LIMIT = 8;
/** The conversation shown from `visited`, until the agent's own history confirms or replaces it. */
let ahead: { transcript: Transcript; file?: string; daemonId?: string } | undefined;
/** The change under way showed its destination before the agent got there: a change that fails puts the agent's session back. */
let early = false;
/** The session-change generation a pending saved-file read belongs to: a change that reverts or is superseded voids it. */
let snapshotEpoch = 0;
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
let dropSweepTimer: ReturnType<typeof setTimeout> | undefined;
let dropSweepAt: number | undefined;
let toastId = 0;
const toastTimers = new Map<number, { timer: ReturnType<typeof setTimeout>; deadline: number }>();
/** What a hovered toast still had ahead of it when the pointer came to rest on it. */
const heldToasts = new Map<number, number>();
/** The reader asked the open run to stop. However it then ends is their doing: Pi settles a retry cancelled mid-wait as not aborted. */
let stopAsked = false;
let bashRequestId: string | undefined;
let pendingSendCount = 0;
let deferredSendTail: Promise<void> = Promise.resolve();
/**
 * What each waiting bubble went to the agent as, by row id: taking one message
 * out of the queue clears it whole (`clear_queue` is all Pi's RPC has, and it
 * answers with text alone), so the others go back in as they were first sent —
 * images, handoff and all.
 */
interface QueuedSend {
  /** The conversation its bubble stands in. */
  held: Transcript;
  wire: string;
  images: ImageContent[];
  mode: "steer" | "followUp";
  handoff?: { fromAgent: string; toAgent: string; context: string };
}
const queuedSends = new Map<string, QueuedSend>();
/** One queue edit at a time: each clears the queue and puts the rest back. */
let queueEditTail: Promise<void> = Promise.resolve();
let queueEditing = false;

/** Forgets the sends whose bubbles no longer wait: delivered, taken back, or left with their conversation. */
function pruneQueuedSends() {
  if (!queuedSends.size) return;
  const waiting = new Set<string>();
  for (const row of transcript.rows()) if (row.kind === "user" && row.queued) waiting.add(row.id);
  for (const [id, sent] of queuedSends) if (sent.held === transcript && !waiting.has(id)) queuedSends.delete(id);
}
/** Holds a detached client's pipe open briefly when an in-flight `send()` is finishing attachment reads before writing its prompt. */
const clientSendHolds = new Map<PiClient, Set<Promise<void>>>();

function hasQueuedMessages(): boolean {
  const q = queue();
  return q.steering.length > 0 || q.followUp.length > 0 || (state()?.pendingMessageCount ?? 0) > 0;
}

function hasActiveOrQueuedWork(): boolean {
  return running() || bashRunning() || Boolean(state()?.isCompacting) || hasQueuedMessages() || pendingSendCount > 0;
}

/** Publishes the transcript to the screen: synchronized to display VSync, at most once a frame. */
function flushSoon() {
  if (flushFrame !== undefined) return;
  flushFrame = requestAnimationFrame(flush);
}

/**
 * Wakes a flush for the soonest staged bubble the queue reconcile marked for
 * withdrawal: its echo either lands inside the grace or it never does.
 */
function armDropSweep() {
  const at = transcript.dropDeadline();
  if (at === dropSweepAt) return;
  if (dropSweepTimer !== undefined) clearTimeout(dropSweepTimer);
  dropSweepTimer = undefined;
  dropSweepAt = at;
  if (at === undefined) return;
  dropSweepTimer = setTimeout(() => {
    dropSweepTimer = undefined;
    dropSweepAt = undefined;
    if (transcript.sweepDrops()) flushSoon();
  }, Math.max(0, at - Date.now()) + 25);
}

function flush() {
  if (flushFrame !== undefined) cancelAnimationFrame(flushFrame);
  flushFrame = undefined;
  armDropSweep();
  if (transcript.version === shownVersion) return;
  shownVersion = transcript.version;
  batch(() => {
    conversation.set(keyOf(transcript));
    rows.set(transcript.rows());
  });
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
  const file = shownAhead
    ? shownAhead.file
    : phase().name === "ready"
      ? (state()?.sessionFile ?? currentDaemonSession()?.file)
      : undefined;
  const did = shownAhead ? shownAhead.daemonId : phase().name === "ready" ? openDaemonId() : undefined;
  // Always give the next session a fresh transcript; keep the previous one for
  // immediate restore. bashRunning is not stashed — a shell task has no rows
  // of its own to preserve. An empty transcript is not worth caching.
  const previous = transcript;
  transcript = new Transcript(() => activeLanguage());
  shownVersion = -1;
  if (bashRunning() || !previous.rows().length) return;
  if (file) {
    visited.delete(file);
    visited.set(file, previous);
    for (const oldest of visited.keys()) {
      if (visited.size <= VISITED_LIMIT) break;
      visited.delete(oldest);
    }
    if (did) visitedByDaemon.delete(did);
  } else if (did) {
    visitedByDaemon.delete(did);
    visitedByDaemon.set(did, previous);
    for (const oldest of visitedByDaemon.keys()) {
      if (visitedByDaemon.size <= VISITED_LIMIT) break;
      visitedByDaemon.delete(oldest);
    }
  }
}

/**
 * Puts the open session's messages on screen. A conversation shown ahead from
 * `visited` or `landSnapshot` that the agent's history matches stays as it is
 * — the same rows, nothing for the list to do; one that moved on since is
 * replaced while keeping `===` row references on unchanged turns (`succeed`).
 *
 * When switching back to a still-working session (including external harnesses
 * where the daemon reports `working`/`blocked` even while `isStreaming` is not
 * set), the session history may omit in-progress rows that the stash already
 * holds. Keep the stash when history is a visual prefix — the re-attached event
 * stream will fill in what happens next without a visible gap.
 */
/** Live events received from a newly attached client before its authoritative `landHistory` commits. */
let pendingAttachClient: PiClient | undefined;
let pendingAttachEvents: SessionEvent[] = [];

function clearPendingAttach() {
  pendingAttachClient = undefined;
  pendingAttachEvents = [];
}

/**
 * Replays live events buffered during attach without duplicating messages that
 * `displayHistory` already returned.
 */
function replayPendingAttachEvents(messages: readonly AgentMessage[]) {
  const buffered = pendingAttachEvents;
  const active = client;
  const source = pendingAttachClient;
  clearPendingAttach();
  if (!buffered.length || !active || active !== source) return;
  const hadPendingAssistant = messages.some((m) => m.role === "assistant" && m.stopReason === "pending");
  if (hadPendingAssistant) {
    // External bridges include the in-flight pending turn in `get_messages`; only replay
    // session/lifecycle events that may have raced with `get_state`.
    for (const event of buffered) {
      if (
        event.type === "agent_settled" ||
        event.type === "queue_update" ||
        event.type === "session_info_changed" ||
        event.type === "thinking_level_changed"
      ) {
        onEvent(event);
      }
    }
    return;
  }
  // Native Pi `get_entries` persists on `message_end`, omitting any in-flight assistant deltas:
  // skip events up through the last `message_end` (already in `messages`), and replay everything after.
  let startAt = 0;
  for (let i = buffered.length - 1; i >= 0; i--) {
    if (buffered[i].type === "message_end") {
      startAt = i + 1;
      break;
    }
  }
  for (let i = startAt; i < buffered.length; i++) {
    const event = buffered[i];
    if (event.type === "message_start" && event.message.role === "user") continue;
    onEvent(event);
  }
}

function landHistory(messages: AgentMessage[]) {
  snapshotEpoch++;
  clearLeavingGrace();
  const known = state();
  const heldSession = currentDaemonSession();
  const file = known?.sessionFile ?? heldSession?.file;
  const did = openDaemonId();
  const held = heldSession ?? (did ? daemonSessionOfId(did) : undefined) ?? (file ? daemonSessionByFile(file) : undefined);
  const working = Boolean(known?.isStreaming) || held?.status === "working" || held?.status === "blocked";
  const shown = ahead?.transcript === transcript;
  ahead = undefined;
  early = false;
  const fresh = new Transcript(() => activeLanguage());
  // A session the daemon kept working is still on its last turn: nothing in it has stopped.
  fresh.load(messages, working);
  // The conversation as it last stood on screen, when it is still held: shown ahead, or set aside under its file / daemon id.
  const before = shown
    ? transcript
    : (file ? visited.get(file) : undefined) ?? (did ? visitedByDaemon.get(did) : undefined);
  if (before && !shown) {
    if (file) visited.delete(file);
    if (did) visitedByDaemon.delete(did);
  }
  if (
    messages.length === 0 &&
    transcript.rows().length === 0 &&
    rows().length === 0 &&
    shownVersion === transcript.version &&
    !leaving() &&
    !snapPending() &&
    !before &&
    !queue().steering.length &&
    !queue().followUp.length
  ) {
    return;
  }
  const countUsers = (list: readonly Row[]) => list.reduce((n, r) => (r.kind === "user" ? n + 1 : n), 0);
  if (
    before &&
    (sameVisualRows(fresh.rows(), before.rows()) ||
      (working &&
        fresh.rows().length < before.rows().length &&
        sameVisualRows(fresh.rows(), before.rows().slice(0, fresh.rows().length))))
  ) {
    // The same rows, or the agent's history is an exact prefix of the stashed view: an in-progress
    // run has not yet written its streaming message to the session file. Keep
    // showing the stash so the thinking rows stay on screen while the stream catches up.
    if (before.hasStagedUser() && countUsers(fresh.rows()) >= countUsers(before.rows())) {
      before.commitStagedUsers();
    }
    if (shown) {
      if (snapPending()) snapPending.set(false);
      return;
    }
    transcript = before;
  } else {
    if (before) {
      succeed(before, fresh);
      before.carryStagedTo(fresh);
    }
    transcript = fresh;
  }
  // The queue is shown in the conversation alone: one that landed before its history stands in it all the same.
  const waiting = queue();
  if (waiting.steering.length || waiting.followUp.length) transcript.reconcileQueue(waiting.steering, waiting.followUp);
  shownVersion = -1;
  markTranscriptSeen(true);
  batch(() => {
    flush();
    if (snapPending()) snapPending.set(false);
    if (leaving()) {
      leaving.set(false);
      arrived.update((n) => n + 1);
    }
    landed.update((n) => n + 1);
    if (!shown) scrollToEnd.set(0);
  });
}

/** Marks every row the transcript can put on screen as already seen: a landing never replays row entrances, pacers, or streaming veils. */
function markTranscriptSeen(reseed = false) {
  const ids = displayRowIds(transcript.rows());
  markRowsSeen(ids);
  markPacersSeeded(ids);
  if (reseed) reseedVeils(ids);
  else markVeilsSeeded(ids);
}

/**
 * A saved session's file is its conversation's last settled state, read
 * straight from disk while the agent is still attaching — the switch answers
 * the click with it, and the agent's own history confirms or replaces it as it
 * lands (`landHistory`). The daemon's registry still says whether a run is
 * going on there: the file may lag it, so its turn stays open.
 */
function landSnapshot(file: string | undefined, daemonId: string | undefined, snap: SessionSnapshot) {
  snapshotEpoch++;
  clearLeavingGrace();
  const fresh = new Transcript(() => activeLanguage());
  const held = (file ? daemonSessionByFile(file) : undefined) ?? (daemonId ? daemonSessionOfId(daemonId) : undefined);
  const working = held?.status === "working" || held?.status === "blocked";
  fresh.load(snap.messages, working);
  transcript = fresh;
  ahead = { transcript: fresh, file, daemonId };
  early = true;
  shownVersion = -1;
  markTranscriptSeen();
  batch(() => {
    if (working && !running()) runStartedAt.set(Date.now());
    running.set(working);
    bashRunning.set(false);
    activity.set(working ? { kind: "thinking" } : { kind: "idle" });
    queue.set({ steering: [], followUp: [] });
    dialogs.set([]);
    statuses.set({});
    widgets.set({});
    flush();
    landed.update((n) => n + 1);
    scrollToEnd.set(0);
    // The destination is on screen: the grace wait or leaving dim is over.
    if (snapPending()) snapPending.set(false);
    if (leaving()) leaving.set(false);
    arrived.update((n) => n + 1);
  });
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
/** Fileless daemon sessions the user archived/dismissed (kept so an older un-restarted daemon cannot push them back). */
const dismissedDaemonIds = new Set<string>();
/** Untitled fileless daemon sessions that were opened from a failed/interrupted state (retired if left untouched). */
const recoveredZombieIds = new Set<string>();

/** What a daemon session is called on screen: localized when untitled, synced with its saved file when renamed. */
export function daemonSessionTitle(session: DaemonSession, fallback = tr("New session", "新会话")): string {
  const summary = session.file ? findKnownSessionSummary(session.file) : undefined;
  // Defense in depth for a registry written before titles were cleaned: the
  // transport envelope is never the words a row is titled by.
  const registryTitle = session.title && session.title !== "New session" ? titleWords(session.title).replace(/\s+/g, " ").trim() : "";
  if (session.titleLocked && registryTitle) {
    return registryTitle;
  }
  if (summary?.name) return sessionTitle(summary, fallback);
  if (registryTitle) return registryTitle;
  if (summary) return sessionTitle(summary, fallback);
  return fallback;
}

/**
 * What a saved session file is called wherever it is listed. A file the daemon
 * holds is titled by the daemon registry first (a locked delegation title is
 * the task's real name); otherwise its indexed first message is the fallback.
 */
export function sessionDisplayTitle(session: SessionSummary, fallback = tr("New session", "新会话")): string {
  const held = daemonSessionByFile(session.path);
  return held ? daemonSessionTitle(held, fallback) : sessionTitle(session, fallback);
}

function removeDaemonSessionLocal(sessionId: string) {
  daemonSessionList.update((list) => (list.some((s) => s.id === sessionId) ? list.filter((s) => s.id !== sessionId) : list));
  visitedByDaemon.delete(sessionId);
  recoveredZombieIds.delete(sessionId);
}

function retireDaemonSession(sessionId: string) {
  dismissedDaemonIds.add(sessionId);
  quietSessions.add(sessionId);
  removeDaemonSessionLocal(sessionId);
  if (daemonClient) {
    void daemonClient.removeSession(sessionId).catch(() => daemonClient?.killSession(sessionId).catch(() => undefined));
  }
}

/**
 * The daemon's registry replaces its entry for `session.id`, in place. A push is also how a run off
 * screen reports: a settle, a stop or a question is said once, and its sidebar rows re-read their
 * workspace list (a file first appearing is how a fresh session gets a row at all).
 */
function upsertDaemonSession(session: DaemonSession) {
  if (dismissedDaemonIds.has(session.id)) return;
  if (session.file || (session.title && session.title !== "New session")) recoveredZombieIds.delete(session.id);
  const prev = daemonSessionList().find((known) => known.id === session.id);
  daemonSessionList.update((list) => {
    const at = list.findIndex((known) => known.id === session.id);
    if (at < 0) return [...list, session];
    const next = list.slice();
    next[at] = session;
    return next;
  });
  if (!prev && session.parentId && !sidebarSessionParent(session) && !isSessionArchived(session.file)) {
    rememberProject(projectCwdOf(session.cwd, session));
  }
  if (session.file && visitedByDaemon.has(session.id)) {
    const stashed = visitedByDaemon.get(session.id)!;
    visitedByDaemon.delete(session.id);
    if (!visited.has(session.file)) {
      visited.set(session.file, stashed);
      for (const oldest of visited.keys()) {
        if (visited.size <= VISITED_LIMIT) break;
        visited.delete(oldest);
      }
    }
  }
  // The open session's rows refresh through its own stream (a settle re-lists, as before); every
  // other session reports only here — a status, title or file change re-reads its workspace list.
  const open = client !== undefined && session.id === clientDaemonId.get(client);
  // A background session that changed status, finished unread, or progressed since stashed
  // must not replay its stale mid-run `visited` cache on return.
  if (
    !open &&
    prev &&
    (session.status !== prev.status || session.unread || session.lastActive !== prev.lastActive)
  ) {
    if (session.file) visited.delete(session.file);
    visitedByDaemon.delete(session.id);
  }
  if (
    prev
      ? !open && (session.status !== prev.status || session.title !== prev.title || session.file !== prev.file)
      : Boolean(session.file)
  ) {
    void refreshSessions(session.cwd);
  }
  // The open session speaks through its own stream — but only while a client is attached to it:
  // one let go of (in the gap before the next attach) reports off screen like any other.
  const inlineFront = inlineDaemonWatchers.get(session.id)?.() === true;
  if (!prev || open || inlineFront) return;
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

/** Inline surfaces (such as a document's floating AI assistant) watching a daemon session live. */
const inlineDaemonWatchers = new Map<string, () => boolean>();
const teardownListeners = new Set<() => void>();

export function registerInlineDaemon(id: string, isFront: () => boolean) {
  inlineDaemonWatchers.set(id, isFront);
}

export function unregisterInlineDaemon(id: string) {
  inlineDaemonWatchers.delete(id);
}

export function onStoreTeardown(listener: () => void): () => void {
  teardownListeners.add(listener);
  return () => teardownListeners.delete(listener);
}

export function setInlineDaemonRuntimeMode(id: string, mode: RuntimeMode) {
  daemonClient?.setRuntimeMode(id, mode);
}

/**
 * Attaches an independent daemon session using the active agent, workspace,
 * and runtime configuration (for inline surfaces like the document floating AI).
 * Also returns the user's preferred model/thinking choice for that agent.
 */
export async function attachInlineSession(options: {
  id?: string;
  file?: string;
  cwd?: string;
  agentId?: string;
  title?: string;
  runtimeMode?: RuntimeMode;
}): Promise<{
  transport: Transport;
  session: DaemonSession;
  daemon: DaemonClient;
  agentId: string;
  agentName: string;
  preferredModel?: { provider: string; id: string };
  preferredThinking?: ThinkingLevel;
}> {
  const daemon = await ensureDaemon();
  if (!daemon) throw new Error(tr("The session daemon is not running", "会话守护进程未运行"));
  const agentId = options.agentId ?? currentAgentId();
  const spec = agents().find((a) => a.id === agentId);
  const effectiveId = spec ? spec.id : "pi";
  const driver = spec?.driver ?? (effectiveId === "pi" ? "pi" : "acp");
  const customCfg = storedCustomAgents().find((c) => c.id === effectiveId);
  const override = storedAgentOverrides()[effectiveId];
  const cwd = options.cwd || activeProjectPath() || workspace();
  const { transport, session } = await daemon.attach({
    id: options.id,
    file: options.file,
    title: options.title,
    cwd,
    agentId: effectiveId,
    agentName: spec?.name ?? effectiveId,
    driver,
    runtimeMode: options.runtimeMode ?? currentRuntimeMode(),
    binaryPath: override?.binaryPath,
    extraArgs: override?.extraArgs,
    customAgent: customCfg,
  });
  const choice = storedSessionChoice(effectiveId);
  return {
    transport,
    session,
    daemon,
    agentId: effectiveId,
    agentName: spec?.name ?? effectiveId,
    preferredModel: choice?.model,
    preferredThinking: choice?.thinkingLevel,
  };
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
          onSessionRemoved: removeDaemonSessionLocal,
          onCatalog: (agentId, catalog) => {
            if (catalog.models?.length) cacheAgentModels(agentId, catalog.models);
            if (catalog.thinkingLevels?.length) cacheAgentThinkingLevels(agentId, catalog.thinkingLevels);
            if (agentId === currentAgentId() && phase().name === "starting") {
              batch(() => {
                if (catalog.models?.length && models().length === 0) models.set(catalog.models);
                if (catalog.thinkingLevels?.length && levels().length <= 1) levels.set(catalog.thinkingLevels);
                if (catalog.commands?.length && commands().length === 0) commands.set(catalog.commands);
              });
            }
          },
          onExit: () => {
            daemonClient = undefined;
          },
        });
        daemonClient = started;
        pushDaemonConfig();
        pushWorkspaces();
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

const personalAgentStarts = new Map<string, Promise<string | undefined>>();

/** A persona's session id, starting it on its own preferred engine the first time it is asked for. */
export async function ensurePersonalAgent(personaId = "default", options?: { name?: string; description?: string }): Promise<string | undefined> {
  const heldNow = personalAgents().find((persona) => (persona.personaId ?? "default") === personaId);
  if (heldNow) {
    if (personaId === "default" && heldNow.agentId && storedPersonaChoice("default")?.agentId !== heldNow.agentId) {
      rememberPersonaChoice("default", { agentId: heldNow.agentId });
    }
    return heldNow.id;
  }
  const alreadyStarting = personalAgentStarts.get(personaId);
  if (alreadyStarting) return alreadyStarting;
  const work = (async () => {
    const daemon = await ensureDaemon();
    if (!daemon) return undefined;
    // Boot connects the daemon asynchronously: its registry can arrive while this
    // first click was waiting. Re-read it rather than racing a duplicate persona.
    const held = personalAgents().find((persona) => (persona.personaId ?? "default") === personaId);
    if (held) return held.id;
    seedPersonaChoice(personaId);
    const stored = storedPersonaChoice(personaId);
    const agentId = stored?.agentId ?? preferredAgentId();
    const choice = storedPersonaAgentChoice(personaId, agentId);
    try {
      const session = await daemon.startSession({
        persona: true,
        personaId,
        personaName: options?.name,
        personaDescription: options?.description,
        agentId,
        model: choice?.model && `${choice.model.provider}/${choice.model.id}`,
        thinking: choice?.thinkingLevel,
        modelConfigs: choice?.modelConfigs,
        runtimeMode: preferredRuntimeMode(),
      });
      upsertDaemonSession(session);
      return session.id;
    } catch (error) {
      // The daemon's registry is the truth: a persona it still holds is this one's,
      // whatever the local mirror missed (a retired id an older daemon pushes back,
      // a push filtered or lost before it landed). Adopt it rather than report a failure.
      const heldRemotely = await daemon
        .list()
        .then((all) => all.find((s) => s.persona && (s.personaId ?? "default") === personaId))
        .catch(() => undefined);
      if (heldRemotely) {
        dismissedDaemonIds.delete(heldRemotely.id);
        upsertDaemonSession(heldRemotely);
        return heldRemotely.id;
      }
      const label = options?.name?.trim() || (personaId === "default" ? "Pip" : tr("the personal agent", "个人智能体"));
      toast("warning", `${tr(`${label} could not start`, `${label} 启动失败`)}: ${message(error)}`);
      return undefined;
    }
  })();
  personalAgentStarts.set(personaId, work);
  try {
    return await work;
  } finally {
    if (personalAgentStarts.get(personaId) === work) personalAgentStarts.delete(personaId);
  }
}

/** Creates a custom persona in its own daemon folder, then answers with its new session id. */
export async function createPersonalAgent(name: string, description?: string): Promise<string | undefined> {
  const display = name.replace(/\s+/g, " ").trim();
  if (!display) return undefined;
  const base = display.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 32) || "persona";
  const taken = new Set(personalAgents().map((persona) => persona.personaId ?? "default"));
  const root = base === "pip" || base === "default" ? "persona" : base;
  let personaId = root;
  for (let n = 2; taken.has(personaId); n++) personaId = `${root}-${n}`.slice(0, 48);
  seedPersonaChoice(personaId);
  return ensurePersonalAgent(personaId, { name: display, description });
}

/** Renames a persona: the daemon owns the session title and the `PERSONA.md` heading together. */
export async function renamePersonalAgent(sessionId: string, name: string): Promise<boolean> {
  const display = name.replace(/\s+/g, " ").trim();
  if (!display) return false;
  const daemon = await ensureDaemon();
  if (!daemon) return false;
  const updated = await attempt(tr("Could not rename the personal agent", "无法重命名个人智能体"), () => daemon.updatePersona(sessionId, { name: display }));
  if (!updated) return false;
  upsertDaemonSession(updated);
  if (openDaemonId() === sessionId) state.update((s) => s && { ...s, sessionName: updated.title });
  return true;
}

/** Copies a picked avatar image into the persona's own folder and puts it on every avatar surface. */
export async function setPersonalAgentAvatar(sessionId: string, sourcePath: string): Promise<boolean> {
  const daemon = await ensureDaemon();
  if (!daemon) return false;
  const updated = await attempt(tr("Could not change the avatar", "无法更换头像"), () => daemon.updatePersona(sessionId, { avatar: sourcePath }));
  if (!updated) return false;
  upsertDaemonSession(updated);
  return true;
}

/** Removes the persona's custom avatar, returning every avatar surface to the Pip mascot. */
export async function resetPersonalAgentAvatar(sessionId: string): Promise<boolean> {
  const daemon = await ensureDaemon();
  if (!daemon) return false;
  const updated = await attempt(tr("Could not reset the avatar", "无法恢复默认头像"), () => daemon.updatePersona(sessionId, { avatar: null }));
  if (!updated) return false;
  upsertDaemonSession(updated);
  return true;
}

/** Deletes a custom persona after the caller's confirmation; default and last persona are protected here too. */
export async function deletePersonalAgent(sessionId: string): Promise<boolean> {
  const persona = daemonSessionOfId(sessionId);
  if (!persona?.persona) return false;
  const personaId = persona.personaId ?? "default";
  if (personaId === "default") {
    toast("warning", tr("The default personal agent cannot be deleted.", "默认个人智能体不能删除。"));
    return false;
  }
  const personaCount = personalAgents().length + (personalAgents().some((s) => (s.personaId ?? "default") === "default") ? 0 : 1);
  if (personaCount <= 1) {
    toast("warning", tr("The last personal agent cannot be deleted.", "最后一个个人智能体不能删除。"));
    return false;
  }
  const daemon = await ensureDaemon();
  if (!daemon) return false;
  if (openDaemonId() === sessionId) {
    const left = await switchInto(lastProject(), undefined, preferredAgentId());
    if (!left) return false;
  }
  const gone = await attempt(tr("Could not delete the personal agent", "无法删除个人智能体"), async () => {
    await daemon.deletePersona(sessionId);
    return true;
  });
  if (!gone) return false;
  removeDaemonSessionLocal(sessionId);
  toast("success", tr(`“${daemonSessionTitle(persona)}” deleted.`, `「${daemonSessionTitle(persona)}」已删除。`));
  return true;
}

/** Tells the daemon which project folders are open, for agents asking `workspaces_list`. */
function pushWorkspaces() {
  daemonClient?.setWorkspaces(recentWorkspaces());
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
    sessionChoices: storedSessionChoices(),
    autoRetry: autoRetryChoice(),
  });
}

/** Asks the daemon to warm a standby for `(cwd, agentId)` now that the active launch settled. */
function requestPrewarm(cwd: string, agentId: string) {
  if (!cwd || !daemonClient) return;
  const spec = agents().find((a) => a.id === agentId);
  const effectiveId = spec ? spec.id : "pi";
  const driver = spec?.driver ?? (effectiveId === "pi" ? "pi" : "acp");
  const customCfg = storedCustomAgents().find((c) => c.id === effectiveId);
  const override = storedAgentOverrides()[effectiveId];
  daemonClient.prewarm({
    cwd,
    agentId: effectiveId,
    agentName: spec?.name ?? effectiveId,
    driver,
    runtimeMode: preferredRuntimeMode(),
    binaryPath: override?.binaryPath,
    extraArgs: override?.extraArgs,
    customAgent: customCfg,
    initialChoice: storedSessionChoice(effectiveId),
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
let unlistenWorkspaces: (() => void) | undefined;

/** Lets go of everything this store evaluation holds (invoked before a hot-reload re-boot). The daemon's sessions are not its to stop. */
function teardownStore() {
  generation++;
  unlistenDaemonPrefs?.();
  unlistenDaemonPrefs = undefined;
  unlistenWorkspaces?.();
  unlistenWorkspaces = undefined;
  if (flushFrame !== undefined) cancelAnimationFrame(flushFrame);
  flushFrame = undefined;
  clearLeavingGrace();
  clearPendingAttach();
  prevWorkspaceSessions = {};
  const active = client;
  client = undefined;
  for (const listener of [...teardownListeners]) {
    try {
      listener();
    } catch {}
  }
  inlineDaemonWatchers.clear();
  for (const started of clientDaemonId.keys()) started.close(0);
  clientDaemonId.clear();
  clientSendHolds.clear();
  dismissedDaemonIds.clear();
  recoveredZombieIds.clear();
  visited.clear();
  visitedByDaemon.clear();
  active?.close(0);
  daemonClient?.close();
  daemonClient = undefined;
  daemonStarting = undefined;
  modelsByAgent.clear();
  levelsByAgent.clear();
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
  unlistenWorkspaces = onWorkspacesChange(pushWorkspaces);

  await loadPrefs();
  await loadPipInteractions();
  batch(() => {
    currentAgentId.set(preferredAgentId());
    currentRuntimeMode.set(preferredRuntimeMode());
    agents.set(defaultAgentStatuses(storedCustomAgents(), storedAgentOverrides()));
    usageLoaded.set(false);
  });
  void refreshAgents();
  await start(lastProject(), undefined, preferredAgentId());
  if (phase().name !== "failed") {
    void refreshAllWorkspaceSessions();
    void refreshUsageStats();
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
  freshDaemonRecord = false,
) {
  return headFor({ cwd, file: reopen, daemonId, agentId: targetAgentId, keepTitle: Boolean(preserveRows) }, () =>
    launch(cwd, reopen, targetAgentId, preserveRows, daemonId, freshDaemonRecord),
  );
}

async function launch(
  cwd: string,
  reopen: string | undefined,
  targetAgentId: string,
  preserveRows?: { previousRows: Row[]; handoffTitle: string; handoffDetail: string },
  daemonId?: string,
  freshDaemonRecord = false,
) {
  const mine = ++generation;
  closeActive();
  if (flushFrame !== undefined) cancelAnimationFrame(flushFrame);
  flushFrame = undefined;

  const spec = agents().find((a) => a.id === targetAgentId);
  const effectiveAgentId = spec ? spec.id : "pi";

  const keepAheadRun = Boolean(ahead && running());
  const switchingAgent = effectiveAgentId !== currentAgentId();
  batch(() => {
    phase.set({ name: "starting" });
    workspace.set(cwd);
    // Another agent's commands and pickers are not this one's: seed from daemon
    // catalog cache when available so fresh pickers are populated immediately.
    if (switchingAgent) {
      commands.set([]);
      const cachedModels = modelsByAgent.get(effectiveAgentId);
      const cachedLevels = levelsByAgent.get(effectiveAgentId);
      models.set(cachedModels?.length ? cachedModels : []);
      levels.set(cachedLevels?.length ? cachedLevels : ["off"]);
    }
    currentAgentId.set(effectiveAgentId);
    if (!reopen && !daemonId) currentRuntimeMode.set(preferredRuntimeMode());
    state.set(undefined);
    if (!keepAheadRun) {
      running.set(false);
      activity.set({ kind: "idle" });
    }
    queue.set({ steering: [], followUp: [] });
    dialogs.set([]);
    statuses.set({});
    widgets.set({});
    if (!preserveRows) {
      const rootCwd = projectCwdOf(cwd, daemonId ? daemonSessionOfId(daemonId) : daemonSessionByFile(reopen));
      const cached = sessionsByWorkspace()[rootCwd] ?? sessionsByWorkspace()[cwd];
      const nextSessions = cached ?? [];
      const reconciled = reconcileSessionList(sessions(), nextSessions);
      if (reconciled !== sessions()) sessions.set(reconciled);
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
  } else if (!ahead && !leaving() && !snapPending() && !isDraftAhead()) {
    // Nothing of the destination to show and nothing on its way out (a cold start, a restart).
    transcript.load([]);
    flush();
    markTranscriptSeen();
  }

  try {
    const agentLabel = spec?.name ?? "Pi";
    const started = await connect(cwd, effectiveAgentId, mine, reopen, daemonId, freshDaemonRecord);
    if (!started) return;
    if ((reopen || daemonId) && !preserveRows) {
      let first = await withStartupTimeout(started.request("get_state"), agentLabel);
      if (mine !== generation) return;
      if (reopen && first.sessionFile !== reopen && !first.isStreaming) {
        // Re-attaching to a warm daemon process whose previous `switch_session` had not
        // yet taken effect (or that was still on another/empty session) must align the
        // engine onto `reopen` before reading history, or `displayHistory` returns `[]`
        // and flashes Welcome over the destination.
        const switched = await withStartupTimeout(started.request("switch_session", { sessionPath: reopen }), agentLabel);
        if (mine !== generation) return;
        if (!switched.cancelled) {
          first = await withStartupTimeout(started.request("get_state"), agentLabel);
          if (mine !== generation) return;
        }
      }
      rememberProject(projectCwdOf(cwd, currentDaemonSession()));
      const retry = autoRetryChoice();
      if (retry !== undefined) request("set_auto_retry", { enabled: retry }).catch(() => undefined);
      // The daemon already put the process on `reopen`'s session file before answering the attach.
      const [, history] = await Promise.all([
        refreshState(),
        withStartupTimeout(displayHistory(started, effectiveAgentId), agentLabel),
      ]);
      if (mine !== generation) return;
      const current = state() ?? first;
      const heldStatus = currentDaemonSession()?.status;
      const activeRun = Boolean(current.isStreaming) || heldStatus === "working" || heldStatus === "blocked";
      if (history.messages.length === 0 && !activeRun && !ahead) {
        // An empty at-rest session lands on Welcome rather than a transcript: resolve
        // models and user choices before publishing `"ready"`, as `finishFreshLaunch` does.
        await Promise.all([refreshModels(effectiveAgentId), refreshLevels()]);
        if (mine !== generation) return;
        const base = state() ?? first;
        const chosen = await applySessionChoices(base, false);
        if (mine !== generation) return;
        const resolved = await applyThinkingChoice(chosen, false);
        if (mine !== generation) return;
        batch(() => {
          state.set(resolved ?? base);
          running.set(false);
          activity.set({ kind: "idle" });
          phase.set({ name: "ready" });
          landHistory(history.messages);
        });
        replayPendingAttachEvents(history.messages);
        if ((resolved ?? base)?.sessionFile) reportSessionFile();
        const listCwd = projectCwdOf(cwd, currentDaemonSession());
        void Promise.all([refreshCommands(), refreshSessions(listCwd), refreshCredentials(), refreshGitWorkspace(cwd), refreshStats()]).catch(failLaunch);
        return;
      }
      batch(() => {
        if (!state()) state.set(first);
        if (activeRun) {
          if (!running()) runStartedAt.set(Date.now());
          running.set(true);
          if (activity().kind === "idle") activity.set({ kind: "thinking" });
        } else if (running()) {
          running.set(false);
          activity.set({ kind: "idle" });
        }
        phase.set({ name: "ready" });
        landHistory(history.messages);
      });
      replayPendingAttachEvents(history.messages);
      if ((state() ?? first).sessionFile) reportSessionFile();
      // The conversation is on screen: the session change is over, its pickers fill in behind it.
      void finishLaunch().catch(failLaunch);
      return;
    }
    // Fresh launch: issue `get_state`, models, and thinking levels in parallel to eliminate the serial waterfall.
    const [first] = await Promise.all([
      withStartupTimeout(started.request("get_state"), agentLabel),
      refreshModels(effectiveAgentId),
      refreshLevels(effectiveAgentId),
    ]);
    if (mine !== generation) return;
    rememberProject(projectCwdOf(cwd, currentDaemonSession()));
    const retry = autoRetryChoice();
    if (retry !== undefined) request("set_auto_retry", { enabled: retry }).catch(() => undefined);
    await finishFreshLaunch(started, first, agentLabel);
  } catch (error) {
    failLaunch(error);
  }

  /**
   * Resolves models, levels and user session choices before publishing `"ready"` so fresh
   * sessions never flash default models or levels. The lists around the session — its own
   * commands, the saved sessions, credentials, git — are the sidebar's and the pickers',
   * not the conversation's: they fill in behind the screen instead of holding it.
   */
  async function finishFreshLaunch(started: PiClient, first: SessionState, agentLabel: string) {
    const listCwd = projectCwdOf(cwd, currentDaemonSession());
    void Promise.all([refreshCommands(), refreshSessions(listCwd), refreshCredentials(), refreshGitWorkspace(cwd)]);
    // A brand-new empty session (`messageCount === 0`) has no history to fetch; skip the round trip.
    const history =
      preserveRows
        ? undefined
        : (first.messageCount ?? 0) > 0
          ? await withStartupTimeout(displayHistory(started, effectiveAgentId), agentLabel)
          : { messages: [] };
    if (mine !== generation) return;
    const chosen = await applySessionChoices(first, false);
    if (mine !== generation) return;
    const resolved = await applyThinkingChoice(chosen, false);
    if (mine !== generation) return;
    batch(() => {
      state.set(resolved);
      phase.set({ name: "ready" });
      if (preserveRows) {
        scrollToEnd.set(0);
      } else if (history) {
        landHistory(history.messages);
      }
    });
    if (history) replayPendingAttachEvents(history.messages);
    else clearPendingAttach();
    reportSessionFile();
    requestPrewarm(cwd, effectiveAgentId);
    void refreshStats();
  }

  /** What the open session supports: models, commands, levels, the lists around it. */
  async function finishLaunch() {
    const listCwd = projectCwdOf(cwd, currentDaemonSession());
    await Promise.all([
      refreshModels(effectiveAgentId),
      refreshCommands(),
      refreshSessions(listCwd),
      refreshCredentials(),
      refreshGitWorkspace(cwd),
    ]);
    if (mine !== generation) return;
    await Promise.all([refreshState(), refreshLevels(), refreshStats()]);
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
async function connect(cwd: string, agentId: string, mine: number, reopen?: string, daemonId?: string, freshDaemonRecord = false): Promise<PiClient | undefined> {
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
  const targetId = daemonId ?? daemonSessionByFile(reopen)?.id;
  const priorHeld = targetId ? daemonSessionOfId(targetId) : undefined;
  const wasFailedUntitledZombie = Boolean(
    priorHeld &&
      !priorHeld.file &&
      !isDaemonTaskSession(priorHeld) &&
      (!priorHeld.title || priorHeld.title === "New session") &&
      (priorHeld.status === "failed" || priorHeld.status === "interrupted"),
  );
  const { transport, session } = await daemon.attach({
    id: targetId,
    file: reopen,
    fresh: freshDaemonRecord,
    title: known ? sessionDisplayTitle(known, "") : undefined,
    cwd,
    agentId,
    agentName: spec?.name ?? agentId,
    driver,
    runtimeMode: currentRuntimeMode(),
    binaryPath: override?.binaryPath,
    extraArgs: override?.extraArgs,
    customAgent: customCfg,
    initialChoice: !reopen && !targetId ? storedSessionChoice(agentId) : undefined,
  });

  if (mine !== generation) {
    transport.kill();
    return undefined;
  }
  if (wasFailedUntitledZombie) recoveredZombieIds.add(session.id);
  const settledSession =
    session.status === "failed" || session.status === "interrupted"
      ? { ...session, status: "idle" as const, error: undefined }
      : session;
  let started: PiClient | undefined;
  started = new PiClient(transport, {
    onEvent: (event) => routeEvent(started, event),
    onUiRequest: (ui) => routeUiRequest(started, ui),
    onExit: (exit, stderr) => routeExit(started, exit, stderr, agentLabel),
  });
  client = started;
  pendingAttachClient = started;
  pendingAttachEvents = [];
  clientDaemonId.set(started, settledSession.id);
  batch(() => {
    if (settledSession !== session) upsertDaemonSession(settledSession);
    openDaemonId.set(settledSession.id);
    currentRuntimeMode.set(settledSession.runtimeMode);
    if (settledSession.agentId && settledSession.agentId !== currentAgentId()) currentAgentId.set(settledSession.agentId);
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
        withStartupTimeout(displayHistory(started, agentId), agentLabel),
      ]);
      if (mine !== generation) return;
      state.set(next);
      const heldStatus = currentDaemonSession()?.status;
      const sessionWorking = Boolean(next.isStreaming) || heldStatus === "working" || heldStatus === "blocked";
      if (sessionWorking && !running()) {
        runStartedAt.set(Date.now());
        running.set(true);
        if (activity().kind === "idle") activity.set({ kind: "thinking" });
      }
      // At rest the conversation on screen is the session's own and stays as it is. A run cut short left rows
      // no file has, and a session that could not be opened again is not the one shown: then the file speaks.
      if (!ahead && (cutShort || (file !== undefined && next.sessionFile !== file))) {
        const fresh = new Transcript(() => activeLanguage());
        fresh.load(history.messages, sessionWorking);
        if (!sameVisualRows(fresh.rows(), transcript.rows())) {
          // The session opened again is the conversation on screen: the reader's folds stay on it.
          if (next.sessionFile === file) {
            succeed(transcript, fresh);
            transcript.carryStagedTo(fresh);
          }
          transcript = fresh;
          shownVersion = -1;
          markTranscriptSeen(true);
          flush();
          landed.update((n) => n + 1);
          scrollToEnd.set(0);
        }
      }
      replayPendingAttachEvents(history.messages);
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

  const pip = currentDaemonSession();
  if (pip?.persona) {
    const daemon = await ensureDaemon();
    if (!daemon) return;
    if (busy()) return;
    const previousRows = rows();
    const handoff = buildPortableHandoff({ rows: previousRows, fromAgentName: activeAgent().name, toAgentName: target.name });
    const personaId = pip.personaId ?? "default";
    const choice = storedPersonaAgentChoice(personaId, nextAgentId);
    const previousName = activeAgent().name;
    busy.set(true);
    try {
      closeActive();
      const session = await attempt(tr("Could not switch Pip's engine", "无法切换 Pip 引擎"), () => daemon.startSession({
        persona: true,
        replacePersona: pip.id,
        personaId,
        agentId: nextAgentId,
        model: choice?.model && `${choice.model.provider}/${choice.model.id}`,
        thinking: choice?.thinkingLevel,
        modelConfigs: choice?.modelConfigs,
        runtimeMode: pip.runtimeMode,
      }));
      if (!session) {
        await start(pip.cwd, pip.file, pip.agentId, undefined, pip.id);
        return;
      }
      rememberPersonaChoice(personaId, { agentId: nextAgentId });
      upsertDaemonSession(session);
      pendingHandoff.set(handoff.formattedContext ? { fromAgent: previousName, toAgent: target.name, context: handoff.formattedContext } : undefined);
      await start(session.cwd, undefined, nextAgentId, previousRows.length ? {
        previousRows,
        handoffTitle: tr(`Switched agent from ${previousName} to ${target.name}`, `已从 ${previousName} 切换至 ${target.name}`),
        handoffDetail: "",
      } : undefined, session.id);
      focusComposer();
    } finally {
      busy.set(false);
    }
    return;
  }

  const prevName = activeAgent().name;
  const currentRows = rows();
  const hasConversation = currentRows.some((r) => r.kind === "user" || r.kind === "text");
  let preserve: { previousRows: Row[]; handoffTitle: string; handoffDetail: string } | undefined;
  if (hasConversation) {
    const handoff = buildPortableHandoff({ rows: currentRows, fromAgentName: prevName, toAgentName: target.name });
    pendingHandoff.set(handoff.formattedContext ? { fromAgent: prevName, toAgent: target.name, context: handoff.formattedContext } : undefined);
    preserve = {
      previousRows: currentRows,
      handoffTitle: tr(`Switched agent from ${prevName} to ${target.name}`, `已从 ${prevName} 切换至 ${target.name}`),
      handoffDetail: "",
    };
  } else {
    pendingHandoff.set(undefined);
  }
  setPreferredAgentId(nextAgentId);
  await start(workspace(), undefined, nextAgentId, preserve);
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
  const previous = currentRuntimeMode();
  currentRuntimeMode.set(effective);
  const did = openDaemonId();
  // The daemon's record first: it is the ceiling children and raw writes are clamped to.
  if (did) daemonClient?.setRuntimeMode(did, effective);
  if (phase().name === "ready" && client) {
    try {
      if (currentAgentId() === "pi") {
        // Update Pi's injected extension runtime mode live via slash command
        await request("prompt", { message: `/pipi-runtime-mode ${effective}` });
      } else {
        await (client as unknown as { request(t: string, a: Record<string, unknown>): Promise<unknown> }).request("set_runtime_mode", { mode: effective });
      }
    } catch (error) {
      // The pick was optimistic: a session that refused it is put back as it was.
      currentRuntimeMode.set(previous);
      toast("error", `${tr("Could not change the permission mode", "无法更改权限模式")}: ${message(error)}`);
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
    rememberProject(projectCwd);
    if (sessionPath) {
      await openSession(sessionPath, undefined, sessionAgentId);
    } else {
      setViewChat();
      focusComposer();
    }
    return;
  }
  pendingHandoff.set(undefined);
  setViewChat();
  const resolvedAgentId = sessionAgentId ?? held?.agentId ?? findKnownSessionSummary(sessionPath)?.agentId ?? currentAgentId();
  if (mustDetachOnSwitch()) return switchInto(path, sessionPath, resolvedAgentId, held?.id);
  await start(path, sessionPath, resolvedAgentId, undefined, held?.id);
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
  setViewChat();
  if (mustDetachOnSwitch()) return switchInto(cwd, undefined, currentAgentId());
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
    if (mustDetachOnSwitch()) await switchInto(next, undefined, currentAgentId());
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
  // Pip's notes hold no project: from Pip, the runs go to the latest project, on their own rows.
  const fromPip = Boolean(currentDaemonSession()?.persona);

  await Promise.all(
    options.agentIds.map((agentId) =>
      attempt(tr(`Failed on ${agentId}`, `${agentId} 启动失败`), async () => {
        const spec = agents().find((a) => a.id === agentId);
        await daemon.startSession({
          title: `${spec?.name ?? agentId} · ${promptText.slice(0, 40)}`,
          agentId,
          cwd: fromPip ? workCwd() : workspace(),
          message: promptText,
          parentId: fromPip ? undefined : openDaemonId(),
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
  modelsByAgent.delete(agentId);
  levelsByAgent.delete(agentId);
  daemonClient?.clearCatalog(agentId);
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
  const heldStatus = currentDaemonSession()?.status;
  if ((next.isStreaming || heldStatus === "working" || heldStatus === "blocked") && !running()) {
    runStartedAt.set(Date.now());
    running.set(true);
    if (activity().kind === "idle") activity.set({ kind: "thinking" });
  }
  return next;
}

async function refreshModels(agentId = currentAgentId()) {
  try {
    const list = (await request("get_available_models")).models;
    models.set(list);
    cacheAgentModels(agentId, list);
  } catch {
    models.set([]);
  }
}

async function refreshLevels(agentId = currentAgentId()) {
  try {
    const next = (await request("get_available_thinking_levels")).levels;
    levels.set(next);
    cacheAgentThinkingLevels(agentId, next);
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
  } finally {
    usageLoaded.set(true);
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
    const prev = sessionsByWorkspace()[cwd];
    const reconciled = reconcileSessionList(prev, found);
    if (prev && reconciled !== prev) {
      const openPath = activeSessionFile();
      const prevByPath = new Map(prev.map((s) => [s.path, s]));
      for (const item of reconciled) {
        const old = prevByPath.get(item.path);
        if (item.path !== openPath && old && (old.modified !== item.modified || old.messageCount !== item.messageCount)) {
          visited.delete(item.path);
        }
      }
    }
    if (reconciled !== prev) {
      sessionsByWorkspace.update((all) => ({ ...all, [cwd]: reconciled }));
    }
    if (cwd === workspace() || cwd === activeProjectPath()) {
      const activeReconciled = reconcileSessionList(sessions(), reconciled);
      if (activeReconciled !== sessions()) sessions.set(activeReconciled);
    }
    if (reconciled !== prev || !prev) applyAutoArchive();
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
  const cwds = [...new Set([workspace(), ...recentWorkspaces(), chatFolder(), ...archivedCwds].filter(Boolean))];
  if (!cwds.length) return;
  try {
    const b = backend();
    if (b.listWorkspaceSessions) {
      const batchMap = await b.listWorkspaceSessions(cwds);
      const prevMap = sessionsByWorkspace();
      const openPath = activeSessionFile();
      let mapChanged = false;
      const updates: Record<string, SessionSummary[]> = {};
      for (const [cwd, found] of Object.entries(batchMap)) {
        const prev = prevMap[cwd];
        const reconciled = reconcileSessionList(prev, found);
        if (prev && reconciled !== prev) {
          const prevByPath = new Map(prev.map((s) => [s.path, s]));
          for (const item of reconciled) {
            const old = prevByPath.get(item.path);
            if (item.path !== openPath && old && (old.modified !== item.modified || old.messageCount !== item.messageCount)) {
              visited.delete(item.path);
            }
          }
        }
        if (reconciled !== prev) {
          updates[cwd] = reconciled;
          mapChanged = true;
        }
      }
      if (mapChanged) {
        sessionsByWorkspace.update((all) => ({ ...all, ...updates }));
      }
      const active = workspace();
      if (active && batchMap[active]) {
        const activeNext = updates[active] ?? prevMap[active] ?? batchMap[active];
        const activeReconciled = reconcileSessionList(sessions(), activeNext);
        if (activeReconciled !== sessions()) sessions.set(activeReconciled);
        sessionsLoaded.set(true);
      }
      if (mapChanged) applyAutoArchive();
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

/** External bridges already return the full display stream, including their pending turn.
 * Native Pi's get_messages is model context; get_entries is the unabridged session tree. */
async function displayHistory(from: PiClient, agentId: string): Promise<{ messages: AgentMessage[] }> {
  if (agentId === "pi") {
    try {
      const { entries, leafId } = await from.request("get_entries");
      return { messages: piHistoryMessages(entries, leafId) };
    } catch (error) {
      // Older Pi versions predate get_entries. Do not mask an actual history read failure.
      if (!(error instanceof PiError && /unknown command/i.test(error.message))) throw error;
    }
  }
  return from.request("get_messages");
}

/**
 * Loads the session the active agent has open: its state and messages land at
 * once; what its model supports follows in the background — an external engine
 * only knows it once its own session is negotiated, which a switch must not wait on.
 */
async function syncSession() {
  if (!client) throw new PiError("history", tr("Agent is not running", "智能体未运行"));
  const [, history] = await Promise.all([refreshState(), displayHistory(client, currentAgentId())]);
  landHistory(history.messages);
  reportSessionFile();
  void refreshLevels();
  void refreshStats();
}

/** Model/thinking picks in the active session's preference scope: a persona's own when it is one, else the engine-wide pick. */
function currentSessionChoice() {
  const persona = activePersonaSession();
  if (persona) return storedPersonaAgentChoice(persona.personaId ?? "default", currentAgentId());
  return storedSessionChoice(currentAgentId());
}

/** Remembers a picker choice in the same scope `currentSessionChoice` reads. */
function rememberCurrentSessionChoice(patch: { model?: { provider: string; id: string }; thinkingLevel?: ThinkingLevel; modelConfigs?: Record<string, string | boolean> }) {
  const persona = activePersonaSession();
  if (persona) rememberPersonaAgentChoice(persona.personaId ?? "default", currentAgentId(), patch);
  else rememberSessionChoice(currentAgentId(), patch);
}

/**
 * Re-applies the model and thinking depth the user last picked for the active
 * agent. A fresh session opens on the harness's own configured default (Pi on
 * `defaultModel`, external engines on whatever they advertise), so the user's
 * pick is put back the way `autoRetry` is — never on a reopened session, which
 * keeps the model its own history recorded.
 */
async function applySessionChoices(initialState?: SessionState, commit = true): Promise<SessionState | undefined> {
  const choice = currentSessionChoice();
  // Compare against the fresh session's own state without flashing intermediate defaults on screen.
  let known = initialState ?? (await request("get_state").catch(() => undefined));
  const wantedModel = choice?.model;
  if (wantedModel) {
    const found =
      models().find((m) => m.id === wantedModel.id && m.provider === wantedModel.provider) ?? models().find((m) => m.id === wantedModel.id);
    if (found && (known?.model?.id !== found.id || known?.model?.provider !== found.provider)) {
      const chosen = await request("set_model", { provider: found.provider, modelId: found.id }).catch(() => undefined);
      if (chosen) {
        // ACP model changes can also alter advertised `modelConfigs` or clamped effort;
        // other drivers return the full chosen model directly without needing another `get_state`.
        known =
          activeAgent().driver === "acp"
            ? await request("get_state").catch(() => (known ? { ...known, model: chosen } : undefined))
            : known
              ? { ...known, model: chosen }
              : undefined;
      }
    }
  }
  if (isPersonaSession()) {
    for (const [configId, value] of Object.entries(choice?.modelConfigs ?? {})) {
      if (!known?.modelConfigs?.some((cfg) => cfg.id === configId && cfg.currentValue !== value)) continue;
      await request("set_model_config", { configId, value });
      known = await request("get_state");
    }
  }
  if (!commit) return known;
  await refreshLevels();
  const resolved = await applyThinkingChoice(known, false);
  if (resolved) state.set(resolved);
  return resolved;
}

async function applyThinkingChoice(known: SessionState | undefined, commit = true): Promise<SessionState | undefined> {
  const wantedLevel = currentSessionChoice()?.thinkingLevel;
  if (!wantedLevel || !known) return known;
  if ((!isPersonaSession() && !levels().includes(wantedLevel)) || wantedLevel === known.thinkingLevel) return known;
  await request("set_thinking_level", { level: wantedLevel }).catch(() => undefined);
  const next = isPersonaSession() ? await request("get_state") : { ...known, thinkingLevel: wantedLevel };
  if (commit && state()?.sessionId === known.sessionId) state.update((s) => s && { ...s, thinkingLevel: next.thinkingLevel });
  return next;
}

// ── Events from Active Agent ────────────────────────────────────────────────

function onEvent(event: SessionEvent, source?: PiClient) {
  if (event.type === "commands_changed") {
    // The bridge learned the agent's own commands (ACP `available_commands_update`, Claude's `initialize`).
    void refreshCommands();
    return;
  }
  if (event.type === "models_changed") {
    // The bridge adopted the agent's real catalog (ACP session negotiation).
    void (async () => {
      await Promise.all([refreshModels(), refreshLevels(), refreshState().catch(() => undefined)]);
      if (!running() && !rows().length && !(state()?.messageCount)) {
        await applySessionChoices();
      }
    })();
    return;
  }
  // While a destination is still attaching (`pendingAttachClient`), buffer its live
  // events so `landHistory` can commit first and replay any post-history deltas
  // without dropping words; events from an outgoing same-process session while `ahead`
  // is set are still discarded so they never leak into the destination.
  if (client && client === pendingAttachClient) {
    pendingAttachEvents.push(event);
    return;
  }
  if (ahead) return;

  if (event.type === "agent_settled") {
    // An idle-wake catch-up (`acpWakeBeforePrompt`) settles its own turn right before
    // the staged user prompt's `agent_start` arrives: settle the wake rows, keep the run live.
    if (!event.aborted && !stopAsked && transcript.hasPendingUser()) {
      transcript.apply(event);
      flush();
      return;
    }
    const wasRunning = running();
    // A settle with the queue still holding messages means the run ended by error or
    // abort before delivering them: the agent keeps them stranded — Pi never drains
    // its queue on a dead run, and they would surface at the end of some later,
    // unrelated run. Hand the words back to the composer instead of vanishing the
    // bubbles, and pull the messages out of the agent so they cannot echo later.
    // A stop the person asked for already did this on its way out (`stop` recalls
    // the queue itself) — the queue signal still lists the messages here, but their
    // words are the composer's already.
    const strandedWire = stopAsked ? [] : [...queue().steering, ...queue().followUp];
    batch(() => {
      transcript.commitStagedUsers();
      transcript.apply(event);
      running.set(false);
      activity.set({ kind: "idle" });
      queue.set({ steering: [], followUp: [] });
      // A settle empties the queue too: whatever it still held never echoes.
      transcript.reconcileQueue([], []);
      if (strandedWire.length) {
        transcript.dropQueuedMatching(strandedWire);
        const said = (wire: string) => withoutPreamble(withoutImageNotes(wire));
        const waiting = strandedWire.map(said).filter(Boolean).join("\n\n");
        if (waiting) draft.set(draft() ? `${draft()}\n\n${waiting}` : waiting);
      }
      flush();
    });
    if (strandedWire.length) {
      if (source && !source.closed) void source.request("clear_queue").catch(() => undefined);
      toast("warning", tr("The run ended before the queued messages were sent; they are back in the composer.", "运行结束前排队消息未能发出，已放回输入框。"));
    }
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

  // Advance the transcript before updating `running` or `activity`, and flush synchronously
  // whenever a user message lands or the activity phase changes so a reply state ("Writing" /
  // "Thinking") never commits on a frame ahead of the user's bubble or the turn's row.
  if (event.type === "bash_execution_update") {
    if (!event.id || event.id === bashRequestId) transcript.bashOutput(event.delta);
    flushSoon();
    return;
  }
  transcript.apply(event);

  const publishActivity = (next: Activity) => {
    if (sameActivity(activity(), next)) return false;
    batch(() => {
      flush();
      activity.set(next);
    });
    return true;
  };

  switch (event.type) {
    case "agent_start":
      stopAsked = false;
      batch(() => {
        flush();
        if (!running()) runStartedAt.set(Date.now());
        running.set(true);
        // A retry is a run starting over: the line goes on saying which attempt it is until that attempt
        // shows life (or the retries end), rather than flapping to "Thinking" and back between attempts.
        if (activity().kind !== "retrying") activity.set({ kind: "thinking" });
      });
      return;
    case "message_start":
      if (event.message.role === "user") {
        flush();
        return;
      }
      break;
    case "message_update": {
      const kind = event.assistantMessageEvent.type;
      const next: Activity | undefined =
        kind === "text_start" || kind === "text_delta"
          ? { kind: "writing" }
          : kind === "thinking_start" || kind === "thinking_delta"
            ? { kind: "thinking" }
            : kind === "toolcall_start"
              ? { kind: "tool", name: event.assistantMessageEvent.toolName }
              : undefined;
      if (next && publishActivity(next)) return;
      break;
    }
    case "tool_execution_start":
      if (publishActivity({ kind: "tool", name: event.toolName })) return;
      break;
    case "message_end":
      // A fresh session gets its file as its first run starts (the bridge writes it then): knowing it is
      // how the session is found again, should its agent go away under the run.
      if (event.message.role === "user" && !state()?.sessionFile) void refreshState().catch(() => undefined);
      break;
    // A turn starting is the model taking up the work again. A turn ending says nothing of what is
    // next — the run may be over: "Thinking" there would be said of a reply just finished, on its way out.
    case "turn_start":
      if (running() && activity().kind !== "retrying" && publishActivity({ kind: "thinking" })) return;
      break;
    case "queue_update":
      queue.set({ steering: event.steering ?? [], followUp: event.followUp ?? [] });
      transcript.reconcileQueue(event.steering ?? [], event.followUp ?? []);
      if (!event.steering?.length && !event.followUp?.length && !queueEditing) pruneQueuedSends();
      break;
    case "session_info_changed":
      state.update((s) => s && { ...s, sessionName: event.name });
      refreshSessions();
      break;
    case "thinking_level_changed":
      state.update((s) => s && { ...s, thinkingLevel: event.level });
      break;
    case "compaction_start":
      batch(() => {
        flush();
        activity.set({ kind: "compacting" });
        state.update((s) => s && { ...s, isCompacting: true });
      });
      return;
    case "compaction_end":
      batch(() => {
        flush();
        state.update((s) => s && { ...s, isCompacting: false });
        activity.set(running() ? { kind: "thinking" } : { kind: "idle" });
      });
      refreshStats();
      return;
    case "auto_retry_start":
      if (publishActivity({ kind: "retrying", attempt: event.attempt, maxAttempts: event.maxAttempts, reason: event.errorMessage })) return;
      break;
    case "auto_retry_end":
      if (running() && publishActivity({ kind: "thinking" })) return;
      break;
  }
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
    case "form":
      dialogs.update((list) => list.some((dialog) => dialog.id === ui.id) ? list : [...list, ui]);
      break;
    case "dismiss":
      dialogs.update((list) => list.filter((dialog) => dialog.id !== ui.id));
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
  if (source === client) return onEvent(event, source);
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
  if (exit.expected) {
    // The daemon asked for this exit — a stop that had to kill, an idle unload, a
    // shutdown. It is not a death to put back: the screen stays as it is and the
    // next send re-attaches, instead of reviving what was stopped.
    batch(() => {
      running.set(false);
      bashRunning.set(false);
      activity.set({ kind: "idle" });
      queue.set({ steering: [], followUp: [] });
      dialogs.set([]);
      statuses.set({});
      widgets.set({});
      const known = state();
      if (known) state.set({ ...known, isStreaming: false, isCompacting: false });
    });
    bashRequestId = undefined;
    stopAsked = false;
    return;
  }
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
  const dialog = dialogs().find((entry) => entry.id === id);
  if (!dialog) return;
  // A form's picks ride the elicitation response, not the wire — but the
  // person still answered, so their bubble keeps the record in the chat.
  if (dialog.method === "form" && "answers" in answer) {
    transcript.recordAnswer(formAnswerText(dialog.fields, answer.answers));
    flush();
  }
  client?.respond(id, answer);
  dialogs.update((list) => list.filter((entry) => entry.id !== id));
}

/** Dismisses or declines whichever dialog is currently waiting at the head of the queue. */
export function cancelPendingDialog() {
  const dialog = dialogs()[0];
  if (!dialog) return;
  answerDialog(
    dialog.id,
    dialog.method === "confirm" ? { confirmed: false } : dialog.method === "form" ? { declined: true } : { cancelled: true },
  );
}

// ── Toasts ──────────────────────────────────────────────────────────────────

/** A toast says its piece on one line — however long the title or the error it carries. */
const TOAST_MAX_CHARS = 120;

/** How long a toast stays: longer for an error or one that offers an action, and for one that takes longer to read. */
function toastLifetime(tone: Toast["tone"], text: string, hasAction: boolean) {
  const base = tone === "error" || hasAction ? 6000 : 4000;
  // A CJK character reads about as long as two Latin ones.
  let length = 0;
  for (const ch of text) length += ch.charCodeAt(0) > 0x2e7f ? 2 : 1;
  return Math.min(12_000, base + Math.max(0, length - 60) * 40);
}

/** The beat a toast still gets once the pointer leaves it — long enough to come back to, short enough to move on. */
const TOAST_LINGER_MS = 1600;

/** (Re)starts the time a toast has left. A held one only learns its new clock. */
function expireToast(id: number, ttl: number) {
  const entry = toastTimers.get(id);
  if (entry) clearTimeout(entry.timer);
  toastTimers.delete(id);
  if (heldToasts.has(id)) {
    heldToasts.set(id, ttl);
    return;
  }
  toastTimers.set(id, { timer: setTimeout(() => dismissToast(id), ttl), deadline: Date.now() + ttl });
}

/** Holds a toast's clock while the pointer rests on it, so what it offers cannot vanish mid-reach. */
export function pauseToast(id: number) {
  const entry = toastTimers.get(id);
  if (!entry || heldToasts.has(id)) return;
  clearTimeout(entry.timer);
  toastTimers.delete(id);
  heldToasts.set(id, Math.max(0, entry.deadline - Date.now()));
}

/** Starts a held toast's clock again, with a beat left even if the pointer only just caught it. */
export function resumeToast(id: number) {
  const left = heldToasts.get(id);
  if (left === undefined) return;
  heldToasts.delete(id);
  expireToast(id, Math.max(left, TOAST_LINGER_MS));
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
  const oneLine = text.replace(/\s+/g, " ").trim();
  const shown = oneLine.length > TOAST_MAX_CHARS ? `${oneLine.slice(0, TOAST_MAX_CHARS - 1)}…` : oneLine;
  const ttl = options?.durationMs ?? toastLifetime(tone, shown, !!options?.action);
  const same = toasts().find((item) => item.tone === tone && item.text === shown);
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
    const entry = toastTimers.get(gone.id);
    if (entry) clearTimeout(entry.timer);
    toastTimers.delete(gone.id);
    heldToasts.delete(gone.id);
  }
  toasts.update((list) => [...list.slice(-2), { id, tone, text: shown, icon: options?.icon, action: options?.action }]);
  expireToast(id, ttl);
}

export function dismissToast(id: number) {
  const entry = toastTimers.get(id);
  if (entry) clearTimeout(entry.timer);
  toastTimers.delete(id);
  heldToasts.delete(id);
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

export function addFileAttachment(file: FileAttachment) {
  fileAttachments.update((list) => (list.some((held) => held.path === file.path) ? list.map((held) => (held.path === file.path ? file : held)) : [...list, file]));
}

export function removeFileAttachment(path: string) {
  if (fileAttachments().some((held) => held.path === path)) {
    fileAttachments.update((list) => list.filter((held) => held.path !== path));
  }
}

const IMAGE_WIRE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_WIRE_IMAGE_BYTES = 20 * 1024 * 1024;

/** Hook set by `store/tabs` so opening a `.md` link/card opens it inside pipi's document editor when available. */
export const docOpener: { open?: (path: string) => Promise<boolean> | boolean } = {};

export async function openLocalFile(filePath: string) {
  if (!filePath) return;
  if (isMarkdownPath(filePath) && docOpener.open) {
    const handled = await Promise.resolve(docOpener.open(filePath)).catch(() => false);
    if (handled) return;
  }
  await attempt(tr("Could not open the file", "无法打开文件"), async () => {
    await backend().openPath?.(filePath);
  });
}

export async function revealLocalFile(filePath: string) {
  if (!filePath) return;
  await attempt(tr("Could not show the file in the file manager", "无法在文件管理器中显示文件"), async () => {
    await backend().revealPath?.(filePath);
  });
}

export async function attachLocalPath(filePath: string): Promise<boolean> {
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
  const vision = Boolean(state()?.model?.input?.includes("image"));
  if (kind === "image" && mimeType && IMAGE_WIRE_MIMES.has(mimeType) && vision && st.size <= MAX_WIRE_IMAGE_BYTES) {
    try {
      const bytes = await fs.readFile(filePath);
      addAttachment({ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType, name });
      return true;
    } catch {
      // Fall through to attaching by path when raw byte read is unavailable.
    }
  }
  addFileAttachment({ path: filePath, name, kind, ...(mimeType ? { mimeType } : {}), size: st.size });
  return true;
}

export async function pickComposerFile() {
  const pick = backend().pickFile;
  if (!pick) return;
  try {
    const picked = await pick(tr("Attach file", "添加文件"));
    if (picked) await attachLocalPath(picked);
  } catch (error) {
    if (error instanceof NoPickerError) {
      toast("warning", tr("No file picker found — install zenity or kdialog to choose files.", "找不到文件选择器——请安装 zenity 或 kdialog。"));
    } else {
      toast("error", `${tr("Could not attach file", "无法添加文件")}: ${message(error)}`);
    }
  }
}

/**
 * A document riding on the message being written: all of it, or a passage
 * selected in it. It is attached, not pasted — the words stay in the
 * document, where they are written — and it goes wherever the composer's
 * next message goes, whichever session that is by then.
 */
export interface DocRef {
  /** The document's file. */
  path: string;
  /** Its name when it was attached. */
  title: string;
  /** The text as attached. The whole document goes as it reads when sent (`docRefText`), a passage as it was selected. */
  text: string;
  /** A passage selected in the document rather than all of it. */
  excerpt?: boolean;
}

/** What an attached document says now; `store/tabs` answers with the open document's text, so words written after attaching are sent too. */
export const docRefText: { read: (ref: DocRef) => string } = { read: (ref) => ref.text };

/** Attaches a document to the composer's message; attached again it is the same card, as it reads now. */
export function attachDoc(ref: DocRef) {
  docRefs.update((list) => (list.some((held) => held.path === ref.path) ? list.map((held) => (held.path === ref.path ? ref : held)) : [...list, ref]));
}

export function detachDoc(path: string) {
  if (docRefs().some((held) => held.path === path)) docRefs.update((list) => list.filter((held) => held.path !== path));
}

/** The attached document's editor is going (its tab closed): the card keeps the text it had then. */
export function settleDocRef(path: string, text: string) {
  if (!docRefs().some((held) => held.path === path && !held.excerpt && held.text !== text)) return;
  docRefs.update((list) => list.map((held) => (held.path === path && !held.excerpt ? { ...held, text } : held)));
}

/**
 * Makes the draft the message it will be sent as: the words typed, then the
 * attached documents (`lib/doc-wire.ts`) — or a lone document's own text when
 * nothing was typed. A line that is a command of the app's or the shell's is
 * not a message about them: the documents wait for the one after it.
 */
function takeDocsIntoDraft(): { message: string; said: string; refs: DocRef[]; files: FileAttachment[] } | undefined {
  const refs = docRefs();
  const files = fileAttachments();
  if (!refs.length && !files.length) return undefined;
  const said = draft().trim();
  const line = said ? parseSlashLine(said) : undefined;
  if (said.startsWith("!") || (line && appCommands().some((own) => answersTo(own, line.name)))) return undefined;
  const parts = refs.map((ref) => ({ path: ref.path, text: ref.excerpt ? ref.text : docRefText.read(ref), ...(ref.excerpt ? { excerpt: true } : {}) }));
  let message: string;
  if (!parts.length) {
    message = composeFileMessage(said, files);
  } else if (files.length > 0 && !said && parts.length === 1) {
    const docTag = parts[0].excerpt ? "selection" : "document";
    const escapedPath = parts[0].path.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    message = composeFileMessage(`<${docTag} path="${escapedPath}">\n${parts[0].text.trim()}\n</${docTag}>`, files);
  } else {
    message = composeFileMessage(composeDocMessage(said, parts), files);
  }
  batch(() => {
    draft.set(message);
    docRefs.set([]);
    fileAttachments.set([]);
  });
  return { message, said, refs, files };
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
      if (isPersonaSession()) await changeSession(tr("Could not start a new conversation", "无法新建对话"), requestNewSession);
      else await newSession();
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
  // pipi's own commands need no agent or attachments: run them before counting an outgoing prompt send,
  // so `/new` or `/clear` on an idle session reuses the open process instead of detaching.
  const immediateText = draft().trim();
  const immediateLine = immediateText ? parseSlashLine(immediateText) : undefined;
  if (immediateLine && appCommands().some((own) => answersTo(own, immediateLine.name))) {
    if (heading() || revival) {
      for (let wait = arrival; heading() && wait; wait = arrival === wait ? undefined : arrival) await wait;
      while (revival) await revival;
    }
    await runAppCommand(immediateText);
    return;
  }

  const preSwitch = Boolean(heading() || revival);
  const pinnedClient = !preSwitch && phase().name === "ready" ? client : undefined;
  const pinnedWasQueued = running() || Boolean(state()?.isStreaming);
  const pinnedHandoff = pinnedClient ? pendingHandoff() : undefined;
  const preAttachments = pinnedClient ? attachments() : [];
  let releaseHold: (() => void) | undefined;
  if (pinnedClient && attachmentReads.size > 0) {
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    let set = clientSendHolds.get(pinnedClient);
    if (!set) {
      set = new Set();
      clientSendHolds.set(pinnedClient, set);
    }
    set.add(hold);
    void hold.finally(() => {
      set?.delete(hold);
      if (set && set.size === 0) clientSendHolds.delete(pinnedClient);
    });
  }

  pendingSendCount++;
  let countedSend = true;
  const finishSendCount = () => {
    if (!countedSend) return;
    countedSend = false;
    pendingSendCount = Math.max(0, pendingSendCount - 1);
  };
  try {
    if (attachmentReads.size) await Promise.allSettled([...attachmentReads]);
    // From here to the send nothing waits: the draft becomes the whole message and is cleared in the same turn,
    // so the field never shows a document's text.
    const withDocs = takeDocsIntoDraft();
    const replySeed = isPersonaSession() ? pipReplyTarget() : undefined;
    let replyUsed = false;
    const encodeReply = (raw: string) => {
      if (!replySeed || raw.startsWith("!") || parseSlashLine(raw)) return raw;
      replyUsed = true;
      return composeReplyMessage(replyWirePart(replySeed), raw);
    };
    const clearUsedReply = () => {
      if (replyUsed) clearPipReply();
    };

    // If `send` was triggered on an open session and the user switched away while `attachmentReads` finished,
    // deliver the message to the original session's held pipe rather than misrouting it to the new session.
    if (pinnedClient && client !== pinnedClient) {
      const text = draft().trim();
      const merged = [...preAttachments];
      for (const item of attachments()) {
        if (!merged.some((k) => k.data === item.data && k.mimeType === item.mimeType)) merged.push(item);
      }
      const images = merged.map(({ type, data, mimeType }) => ({ type, data, mimeType }));
      if (!text && !images.length) return;
      const line = parseSlashLine(text);
      if (line && appCommands().some((own) => answersTo(own, line.name))) {
        releaseHold?.();
        releaseHold = undefined;
        finishSendCount();
        await runAppCommand(text);
        return;
      }
      const outgoing = encodeReply(text);
      const wirePrompt = pinnedHandoff ? prependHandoffToPrompt(pinnedHandoff.context, outgoing) : outgoing;
      batch(() => {
        draft.set("");
        attachments.set([]);
      });
      clearUsedReply();
      if (!pinnedClient.closed) {
        void pinnedClient
          .request("prompt", {
            message: wirePrompt,
            ...(images.length ? { images } : {}),
            ...(pinnedWasQueued ? { streamingBehavior: mode } : {}),
          })
          .catch((error) => {
            // The bubble never left the held conversation, so the words go back to the composer.
            batch(() => {
              draft.set(draft() ? `${draft()}\n\n${text}` : text);
              if (merged.length) attachments.update((list) => [...list, ...merged]);
            });
            toast("error", `${tr("The message was not sent", "消息未能发送")}: ${message(error)}`);
          });
      }
      return;
    }
    releaseHold?.();
    releaseHold = undefined;

    // A message written while a session change or revival is under way is for where it lands.
    // Snapshot and clear the composer immediately so multiple queued messages submitted during
    // a slow switch are preserved in FIFO order instead of overwriting `draft()`.
    if (heading() || revival) {
      const text = draft().trim();
      const images = attachments().map(({ type, data, mimeType }) => ({ type, data, mimeType }));
      const pendingAttachments = attachments();
      if (!text && !images.length) return;
      const line = parseSlashLine(text);
      if (line && appCommands().some((own) => answersTo(own, line.name))) {
        finishSendCount();
        for (let wait = arrival; heading() && wait; wait = arrival === wait ? undefined : arrival) await wait;
        while (revival) await revival;
        await runAppCommand(text);
        return;
      }
      // A destination already on screen — shown ahead of its attach, or kept
      // through its revival — takes the bubble now: the send reads as waiting
      // there rather than as nothing, and the landing carries it across.
      const outgoing = encodeReply(text);
      const stageIn = ahead?.transcript === transcript || (revival && !heading()) ? transcript : undefined;
      const preStagedId = stageIn?.stageUser(outgoing, images);
      batch(() => {
        draft.set("");
        attachments.set([]);
        if (preStagedId) {
          enableLiveRowEntrance();
          flush();
          scrollToEnd.set(0);
        }
      });
      const runDeferred = deferredSendTail.then(async () => {
        for (let wait = arrival; heading() && wait; wait = arrival === wait ? undefined : arrival) await wait;
        while (revival) await revival;
        clearUsedReply();
        await dispatchPrompt(
          outgoing,
          images,
          mode,
          false,
          pendingAttachments,
          stageIn && preStagedId ? { transcript: stageIn, id: preStagedId } : undefined,
        );
      });
      deferredSendTail = runDeferred.catch(() => undefined);
      await runDeferred;
      return;
    }

    const text = draft().trim();
    const images = attachments().map(({ type, data, mimeType }) => ({ type, data, mimeType }));
    if (!text && !images.length) return;
    // pipi's own commands need no agent: they run whatever the session is doing.
    const line = parseSlashLine(text);
    if (line && appCommands().some((own) => answersTo(own, line.name))) {
      finishSendCount();
      await runAppCommand(text);
      return;
    }
    const outgoing = encodeReply(text);
    clearUsedReply();
    await dispatchPrompt(outgoing, images, mode, true);
    // Not sent (no agent ready, no model): the words and the documents are on the composer as they were.
    if (withDocs && draft() === withDocs.message) {
      batch(() => {
        draft.set(withDocs.said);
        docRefs.set(withDocs.refs);
        fileAttachments.set(withDocs.files);
      });
    }
  } finally {
    releaseHold?.();
    finishSendCount();
  }
}

async function dispatchPrompt(
  text: string,
  images: ImageContent[],
  mode: "steer" | "followUp",
  clearComposer: boolean,
  unsentAttachments: Attachment[] = [],
  preStaged?: { transcript: Transcript; id: string },
) {
  const restoreUnsent = () => {
    if (clearComposer) return;
    if (text) draft.set(draft() ? `${draft()}\n\n${text}` : text);
    if (unsentAttachments.length) {
      const merged = [...attachments()];
      for (const item of unsentAttachments) {
        if (!merged.some((k) => k.data === item.data && k.mimeType === item.mimeType)) merged.push(item);
      }
      attachments.set(merged);
    }
  };

  if (phase().name !== "ready") {
    restoreUnsent();
    return;
  }

  if (text.startsWith("!") && !running() && !state()?.isStreaming) {
    const exclude = text.startsWith("!!");
    const command = text.slice(exclude ? 2 : 1).trim();
    if (!command) return;
    if (clearComposer) draft.set("");
    return runBash(command, exclude);
  }

  if (!hasModel()) {
    restoreUnsent();
    toast("warning", tr("Connect a model provider before sending.", "请先连接模型服务商再发送。"));
    showAgentSettings();
    return;
  }

  let activeClient = client;
  if (!activeClient && openDaemonId() && phase().name === "ready" && !revival) {
    // The session's process was let go — a stop that had to kill it, the daemon's
    // unload. Sending is what puts the agent back under its conversation.
    const label = activeAgent().name;
    await revive(label, false, {
      name: "failed",
      title: tr(`${label} could not start`, `${label} 无法启动`),
      detail: tr("The agent process is not running.", "智能体进程未在运行。"),
    });
    activeClient = client;
  }
  if (!activeClient) {
    restoreUnsent();
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

  const runTranscript = transcript;
  const queued = running() || Boolean(state()?.isStreaming);
  enableLiveRowEntrance();
  let stagedId: string | undefined;
  batch(() => {
    if (clearComposer) {
      draft.set("");
      attachments.set([]);
    }
    if (handoff) pendingHandoff.set(undefined);
    if (!queued) cheer.set(false);
    // The bubble shows at once even when the agent queues the message behind its
    // run: it lands after the turn's rows, where it belongs in the order sent.
    // One staged ahead of the send's wait for its session keeps its row — it
    // either rode the landing into this transcript under the same id, or sits in
    // a transcript the landing left behind and is dropped there instead.
    if (preStaged && runTranscript.hasStagedId(preStaged.id)) {
      stagedId = preStaged.id;
      runTranscript.keepStaged(stagedId);
    } else {
      if (preStaged) preStaged.transcript.dropStagedUser(preStaged.id);
      stagedId = runTranscript.stageUser(text, images, queued);
    }
    if (stagedId) queuedSends.set(stagedId, { held: runTranscript, wire: wirePrompt, images, mode, ...(handoff ? { handoff } : {}) });
    if (runTranscript === transcript) flush();
    if (!queued) {
      running.set(true);
      runStartedAt.set(Date.now());
      activity.set({ kind: "thinking" });
      // A fresh run starts in horizon mode: the prompt rises naturally until it reaches the reading horizon.
      if (stagedId) sendAnchor.set({ rowId: stagedId });
    }
    scrollToEnd.set(0);
  });
  try {
    const { disposition } = await activeClient.request("prompt", {
      message: wirePrompt,
      ...(images.length ? { images } : {}),
      ...(queued ? { streamingBehavior: mode } : {}),
    });
    if (stagedId && disposition !== "queued") queuedSends.delete(stagedId);
    // The user may have switched sessions while the agent was answering: that run is the daemon's now, not this screen's.
    if (client !== activeClient) {
      if (disposition === "queued") runTranscript.markStagedQueued(stagedId);
      else if (disposition === "handled") runTranscript.dropStagedUser(stagedId);
      else if (queued && disposition === "started") runTranscript.markStagedStarted(stagedId);
      return;
    }
    if (disposition === "handled" || disposition === "queued" || (queued && disposition === "started")) {
      batch(() => {
        if (disposition === "queued") runTranscript.markStagedQueued(stagedId);
        else if (disposition === "handled") runTranscript.dropStagedUser(stagedId);
        else runTranscript.markStagedStarted(stagedId);
        if (runTranscript === transcript) flush();
        if (!queued && disposition === "handled") {
          running.set(false);
          activity.set({ kind: "idle" });
        } else if (queued && disposition === "started" && !running()) {
          running.set(true);
          runStartedAt.set(Date.now());
          activity.set({ kind: "thinking" });
        }
      });
    }
  } catch (error) {
    if (stagedId) queuedSends.delete(stagedId);
    // Detaching closes the virtual transport (`activeClient.closed`), rejecting local response waiters
    // after the `in` frame already went out to the daemon.
    if (client !== activeClient && activeClient.closed) return;
    if (client !== activeClient) {
      runTranscript.dropStagedUser(stagedId);
      return;
    }
    batch(() => {
      runTranscript.dropStagedUser(stagedId);
      if (runTranscript === transcript) flush();
      if (!queued) {
        running.set(false);
        activity.set({ kind: "idle" });
      }
      draft.set(draft() ? `${draft()}\n\n${text}` : text);
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
      transcript.dropQueuedMatching([...cleared.steering, ...cleared.followUp]);
      flushSoon();
      const waiting = [...cleared.steering, ...cleared.followUp].join("\n\n");
      if (waiting) draft.set(draft() ? `${draft()}\n\n${waiting}` : waiting);
    } catch {}
    // The app's own abort is the graceful end, not a gate: an agent that never
    // answers must not hold the daemon's stop (which kills it) — or quit, which
    // goes through this on its way out.
    void attempt(tr("Could not stop", "无法停止"), () => request("abort"));
  }
  const did = openDaemonId();
  if (did) void daemonClient?.stopTree(did).catch(() => undefined);
}

/** Stops a nested daemon session (and its children) from the sidebar's child row. */
export async function stopDaemonSession(sessionId: string) {
  await attempt(tr("Could not stop", "无法停止"), () => daemonClient?.stopTree(sessionId) ?? Promise.resolve());
}

/** Stops every working or blocked daemon session across all trees (e.g. "Stop All & Quit"). */
export async function stopAllDaemonSessions() {
  if (running() || bashRunning() || state()?.isCompacting) {
    await stop();
  }
  await attempt(tr("Could not stop", "无法停止"), () => daemonClient?.stopAll() ?? Promise.resolve());
}

/** Opens a daemon session — by its saved transcript file when present, else by attaching its daemon id directly. */
export function openDaemonSession(sessionId: string) {
  const session = daemonSessionOfId(sessionId);
  if (!session) return;
  if (session.id === openDaemonId() && phase().name === "ready" && !isSwitching()) {
    setViewChat();
    focusComposer();
    return;
  }
  if (session.unread) {
    if (session.file) visited.delete(session.file);
    visitedByDaemon.delete(session.id);
  }
  daemonClient?.markRead(session.id);
  if (session.file) {
    void openSession(session.file, projectCwdOf(session.cwd, session));
    return;
  }
  void switchInto(session.cwd, undefined, session.agentId, session.id);
}

/**
 * Takes one waiting message out of the queue, from its bubble: back into the
 * composer to be written again (`edit`), or gone. Pi's RPC takes the queue back
 * only whole (`clear_queue`), so the rest goes in again, in the order and the
 * way each was sent. A message the run took meanwhile is the run's: it stays.
 */
export function takeQueued(id: string, edit: boolean) {
  const next = queueEditTail.then(() => takeQueuedNow(id, edit));
  queueEditTail = next.catch(() => undefined);
  return next;
}

async function takeQueuedNow(id: string, edit: boolean) {
  const held = transcript;
  const activeClient = client;
  const row = held.rows().find((item) => item.kind === "user" && item.id === id);
  if (!activeClient || !row || row.kind !== "user" || !row.queued) return;
  const sent = queuedSends.get(id);
  const said = (wire: string) => withoutPreamble(withoutImageNotes(wire));
  const mine = (wire: string) => (sent ? wire === sent.wire : said(wire) === row.text);
  queueEditing = true;
  try {
    const cleared = await attempt(tr("Could not change the queue", "无法修改队列"), () => activeClient.request("clear_queue"));
    if (!cleared) return;
    const rest = [
      ...cleared.steering.map((wire) => ({ wire, mode: "steer" as const })),
      ...cleared.followUp.map((wire) => ({ wire, mode: "followUp" as const })),
    ];
    const order = sent?.mode === "followUp" ? [...rest].reverse() : rest;
    const taken = order.find((item) => mine(item.wire)) ?? order.find((item) => said(item.wire) === row.text);
    if (taken) {
      rest.splice(rest.indexOf(taken), 1);
      batch(() => {
        held.dropStagedUser(id);
        queuedSends.delete(id);
        if (held === transcript) flush();
        if (edit && client === activeClient) {
          if (row.text) draft.set(draft() ? `${draft()}\n\n${row.text}` : row.text);
          if (sent?.images.length) {
            attachments.update((list) => [...list, ...sent.images.map((image, at) => ({ ...image, name: `image-${list.length + at + 1}` }))]);
          }
          if (sent?.handoff && !pendingHandoff()) pendingHandoff.set(sent.handoff);
        }
      });
    }
    // The others go back as they were sent. Their bubbles never left: the queue's next word covers them again.
    const spare = [...queuedSends.values()];
    const lost: string[] = [];
    for (const item of rest) {
      const at = spare.findIndex((known) => known.wire === item.wire && known.mode === item.mode);
      const images = at >= 0 ? spare.splice(at, 1)[0].images : [];
      try {
        await activeClient.request("prompt", {
          message: item.wire,
          ...(images.length ? { images } : {}),
          streamingBehavior: item.mode,
        });
      } catch {
        lost.push(said(item.wire));
      }
    }
    if (lost.length) {
      // What could not go back is not lost: it is in the composer, and said once.
      // The composer is the reader's wherever the switch landed — a detach does
      // not make the texts die with the parked session.
      held.dropQueuedMatching(lost);
      if (held === transcript) flushSoon();
      const text = lost.join("\n\n");
      draft.set(draft() ? `${draft()}\n\n${text}` : text);
      toast("warning", tr("Some queued messages could not be queued again; they are back in the composer.", "部分排队消息未能重新排队，已放回输入框。"));
    }
    if (edit && taken && client === activeClient) focusComposer();
  } finally {
    queueEditing = false;
    pruneQueuedSends();
  }
}

// ── Sessions ────────────────────────────────────────────────────────────────

export function findKnownSessionSummary(path: string | undefined): SessionSummary | undefined {
  if (!path) return undefined;
  const direct = sessions().find((s) => s.path === path);
  if (direct) return direct;
  for (const list of Object.values(sessionsByWorkspace())) {
    const hit = list.find((s) => s.path === path);
    if (hit) return hit;
  }
  return undefined;
}

function hasConversationContent(): boolean {
  if (rows().length > 0 || (state()?.messageCount ?? 0) > 0 || Boolean(state()?.sessionName)) return true;
  const held = currentDaemonSession();
  if (isDaemonTaskSession(held)) return true;
  const file = state()?.sessionFile ?? held?.file;
  return Boolean(file && findKnownSessionSummary(file));
}

/**
 * Whether the open daemon session is tied to an active run, a session tree, an
 * existing conversation, or an external caller — if so, leaving it detaches
 * and opens a separate daemon session rather than switching files inside its process.
 */
function mustDetachOnSwitch(): boolean {
  if (hasActiveOrQueuedWork()) return true;
  if (hasConversationContent()) return true;
  const held = currentDaemonSession();
  if (held?.status === "working" || held?.status === "blocked") return true;
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
  const hadWork = hasActiveOrQueuedWork();
  const leavingSession = currentDaemonSession();
  const leavingCwd = projectCwdOf(workspace(), leavingSession);
  client = undefined;
  clearPendingAttach();
  let heldSend = false;
  if (current) {
    const holds = clientSendHolds.get(current);
    if (holds && holds.size > 0) {
      heldSend = true;
      void Promise.allSettled([...holds]).then(() => {
        clientSendHolds.delete(current);
        clientDaemonId.delete(current);
        current.close();
      });
    } else {
      clientDaemonId.delete(current);
      current.close();
    }
  }
  if (
    leavingSession &&
    recoveredZombieIds.has(leavingSession.id) &&
    !hadWork &&
    !heldSend &&
    !leavingSession.file &&
    !rows().length &&
    !(state()?.messageCount) &&
    descendantSessionsOf(leavingSession.id).length === 0
  ) {
    retireDaemonSession(leavingSession.id);
  }
  // A run let go of keeps working off screen: re-list so its sidebar rows exist for the mark.
  if (hadWork) void refreshSessions(leavingCwd);
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
    let started!: Promise<void>;
    batch(() => {
      setViewChat();
      pendingHandoff.set(undefined);
      renaming.set(false);
      attachments.set([]);
      started = start(cwd, sessionPath, agentId, undefined, daemonId);
    });
    await started;
    focusComposer();
    return true;
  } finally {
    busy.set(false);
  }
}

/** A change that showed its destination ahead and then did not happen: the agent's own session goes back on screen. */
async function stayPut() {
  // Nothing the destination's saved file read still in flight may show lands after a reverted change.
  snapshotEpoch++;
  clearLeavingGrace();
  clearPendingAttach();
  if (snapPending()) snapPending.set(false);
  if (!early) return;
  early = false;
  // The destination shown ahead goes back where it was kept; the session that stays comes back from there too (`landHistory`).
  if (ahead?.transcript === transcript) {
    if (ahead.file) visited.set(ahead.file, ahead.transcript);
    else if (ahead.daemonId) visitedByDaemon.set(ahead.daemonId, ahead.transcript);
    transcript = new Transcript(() => activeLanguage());
    shownVersion = -1;
  }
  ahead = undefined;
  await syncSession().catch(() => undefined);
}

async function settle() {
  if (running() || bashRunning()) await stop();
}

async function changeSession(what: string, action: () => Promise<{ cancelled: boolean }>, target?: { file?: string }): Promise<boolean> {
  if (busy()) return false;
  if (target) return headFor({ cwd: workspace(), file: target.file }, () => changeSession(what, action));
  const mine = generation;
  busy.set(true);
  try {
    await settle();
    if (mine !== generation) return false;
    const { cancelled } = await action();
    if (mine !== generation) return false;
    if (cancelled) {
      toast("info", tr("An extension cancelled the change.", "扩展已取消该操作。"));
      await stayPut();
      return false;
    }
    batch(() => {
      setViewChat();
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
    if (mine !== generation) return false;
    refreshSessions();
    focusComposer();
    return true;
  } catch (error) {
    if (mine !== generation) return false;
    toast("error", `${what}: ${message(error)}`);
    await stayPut();
    return false;
  } finally {
    if (mine === generation) busy.set(false);
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

/** Where work started from the screen runs: its project, or — from Pip's notes — the latest project. */
function workCwd() {
  const cwd = activeProjectPath() || workspace();
  return isPersonaFolder(cwd) ? (recentWorkspaces()[0] ?? cwd) : cwd;
}

export function newSession() {
  pendingHandoff.set(undefined);
  const rootCwd = workCwd();
  if (isDraftAhead() && heading()?.cwd === rootCwd && (!heading()?.agentId || heading()?.agentId === currentAgentId())) {
    setViewChat();
    return focusComposer();
  }
  if (phase().name !== "ready") {
    busy.set(false);
    setViewChat();
    return start(rootCwd, undefined, currentAgentId());
  }
  if (isSwitching()) {
    if (!heading()?.file && !heading()?.daemonId && !busy()) return focusComposer();
    busy.set(false);
    setViewChat();
    return start(rootCwd, undefined, currentAgentId());
  }
  if (!rows().length && !(state()?.messageCount) && !mustDetachOnSwitch()) {
    setViewChat();
    return focusComposer();
  }
  if (mustDetachOnSwitch() || rootCwd !== workspace()) {
    return switchInto(rootCwd, undefined, currentAgentId());
  }
  return changeSession(tr("Could not start a session", "无法新建会话"), requestNewSession, {});
}

/** Starts a clean conversation inside the same personal agent, keeping its identity, folder, engine and picker preferences. */
export function newPersonaConversation() {
  if (!isPersonaSession()) return newSession();
  if (phase().name !== "ready" || isSwitching()) return focusComposer();
  if (!rows().length && !(state()?.messageCount)) return focusComposer();
  return changeSession(tr("Could not start a conversation", "无法新建对话"), requestNewSession, {});
}

async function openSessionFile(path: string, ownerAgentId?: string) {
  const held = daemonSessionByFile(path);
  const targetCwd = held?.cwd ?? activeProjectPath() ?? workspace();
  let neededAgent =
    held?.agentId ||
    ownerAgentId ||
    (path.endsWith(".pipi-agent.jsonl") ? findKnownSessionSummary(path)?.agentId : "pi");
  if (!neededAgent && path.endsWith(".pipi-agent.jsonl")) {
    neededAgent = (await backend().readSessionSnapshot(path).catch(() => undefined))?.agentId;
  }
  neededAgent ||= currentAgentId();
  const targetSpec = agents().find((a) => a.id === neededAgent);
  const switchHarness =
    neededAgent !== currentAgentId() &&
    Boolean(targetSpec && (targetSpec.available || targetSpec.statusText === "Checking…" || path.endsWith(".pipi-agent.jsonl")));
  const own = held !== undefined && held.id === openDaemonId();
  if (switchHarness || phase().name !== "ready" || isSwitching() || (held !== undefined && !own) || mustDetachOnSwitch() || targetCwd !== workspace()) {
    if (phase().name === "ready" && !isSwitching()) {
      return switchInto(targetCwd, path, neededAgent, held?.id);
    }
    let started!: Promise<void>;
    batch(() => {
      busy.set(false);
      setViewChat();
      pendingHandoff.set(undefined);
      renaming.set(false);
      attachments.set([]);
      started = start(targetCwd, path, neededAgent, undefined, held?.id);
    });
    await started;
    return true;
  }
  return changeSession(tr("Could not open the session", "无法打开会话"), () => request("switch_session", { sessionPath: path }), { file: path });
}

export function openSession(path: string, cwd?: string, ownerAgentId?: string) {
  markSessionRead(path);
  const held = daemonSessionByFile(path);
  const effectiveCwd = cwd ?? (held ? projectCwdOf(held.cwd, held) : undefined);
  if (effectiveCwd && effectiveCwd !== activeProjectPath()) {
    const summary = (sessionsByWorkspace()[effectiveCwd] ?? []).find((s) => s.path === path) ?? findKnownSessionSummary(path);
    return openWorkspace(held?.cwd ?? effectiveCwd, path, ownerAgentId ?? held?.agentId ?? summary?.agentId);
  }
  if (path === state()?.sessionFile && phase().name === "ready" && !isSwitching()) {
    setViewChat();
    focusComposer();
    return;
  }
  const summary = findKnownSessionSummary(path);
  return openSessionFile(path, ownerAgentId ?? summary?.agentId);
}

export function duplicateSession() {
  if (running() || bashRunning()) {
    toast("info", tr("Wait for the run to finish before duplicating.", "请等待当前运行结束后再复制会话。"));
    return Promise.resolve(false);
  }
  return changeSession(tr("Could not duplicate the session", "无法复制会话"), () => request("clone"));
}

export async function forkFrom(index: number) {
  if (running() || bashRunning()) {
    toast("info", tr("Wait for the run to finish before forking.", "请等待当前运行结束后再创建分支。"));
    return;
  }
  const candidates = await attempt(tr("Could not fork", "无法创建分支"), () => request("get_fork_messages"));
  const target = candidates?.messages[index];
  if (!target) return void toast("warning", tr("This message cannot be forked from.", "无法从这条消息创建分支。"));
  let text = "";
  const ok = await changeSession(tr("Could not fork", "无法创建分支"), async () => {
    const result = await request("fork", { entryId: target.entryId });
    // Pi hands the message back as the model got it: the draft is what the person wrote.
    text = withoutPreamble(withoutImageNotes(result.text ?? ""));
    return result;
  });
  if (ok && text) draft.set(text);
}

export function startRenaming() {
  setViewChat();
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
        ? sessionDisplayTitle(summary, tr("Conversation", "对话"))
        : (daemonSessionByFile(path) ? daemonSessionTitle(daemonSessionByFile(path)!, tr("Conversation", "对话")) : tr("Conversation", "对话"));
  const held = daemonSessionByFile(path);
  const open = path === state()?.sessionFile;
  // A background session holding this file ends with it; the open one detaches onto a fresh draft.
  if (held?.loaded && held.id !== openDaemonId()) quietKill(held.id);
  // The list moves at once; leaving the open session follows, and puts the row back if it cannot.
  setSessionArchived(path, true, cwd);
  if (open) {
    const openId = openDaemonId();
    const left = await switchInto(activeProjectPath() || workspace(), undefined, currentAgentId());
    if (!left) {
      setSessionArchived(path, false);
      return;
    }
    if (openId) quietKill(openId);
  }
  toast("info", tr(`“${title}” archived.`, `「${title}」已归档。`), {
    icon: "archive",
    action: {
      label: tr("View archive", "查看归档"),
      onPress: () => showSettings("archive"),
    },
  });
}

/**
 * A deleted file's archive mark goes with it — unless the daemon still holds a
 * record of the session (one started under another, which its tree would list
 * again, file or no file): there the mark stays, as `gone`.
 */
function forgetDeletedSession(path: string) {
  if (daemonSessionByFile(path)) markArchivedSessionGone(path);
  else clearArchivedSessionPref(path);
}

/**
 * Archives a daemon session from its row in the sidebar: when it has a saved
 * transcript file on disk, tucks that file into Archive; when it never wrote a
 * transcript file (e.g. a start or run that failed before any message landed),
 * retires the dead daemon session cleanly so the user is never stuck with an
 * un-archivable row.
 */
export async function archiveDaemonSession(sessionId: string, options?: { force?: boolean }) {
  const session = daemonSessionOfId(sessionId);
  if (!session) return;
  const force = options?.force === true;
  const working = session.status === "working" || session.status === "blocked" || (session.id === openDaemonId() && isRunning());
  if (!force && working) {
    toast("warning", tr("This conversation is still running. Archive it after it finishes.", "对话仍在运行，结束后再归档。"), {
      durationMs: 7000,
      action: {
        label: tr("Archive anyway", "仍然归档"),
        onPress: () => void archiveDaemonSession(sessionId, { force: true }),
      },
    });
    return;
  }
  const cwd = projectCwdOf(session.cwd, session);
  const snapshot = session.file ? await backend().readSessionSnapshot(session.file).catch(() => undefined) : undefined;
  const hasSaved = Boolean(
    session.file &&
      (sessions().some((s) => s.path === session.file) ||
        (sessionsByWorkspace()[cwd] ?? []).some((s) => s.path === session.file) ||
        (snapshot && snapshot.messages.length > 0)),
  );
  if (session.file && hasSaved) {
    await archiveSession(session.file, cwd, { force });
    return;
  }
  const title = daemonSessionTitle(session, tr("New session", "新会话"));
  const wasOpen = session.id === openDaemonId();
  if (wasOpen) {
    closeActive();
    openDaemonId.set(undefined);
  }
  retireDaemonSession(session.id);
  if (wasOpen) {
    await start(cwd, undefined, currentAgentId());
  }
  toast("info", tr(`“${title}” archived.`, `「${title}」已归档。`), { icon: "archive" });
}

/** Permanently deletes a daemon session (and its transcript file when present). */
export async function removeDaemonSession(sessionId: string) {
  const session = daemonSessionOfId(sessionId);
  if (!session) return;
  const cwd = projectCwdOf(session.cwd, session);
  const file = session.file;
  const wasOpen = session.id === openDaemonId();
  if (wasOpen) {
    closeActive();
    openDaemonId.set(undefined);
  }
  retireDaemonSession(session.id);
  if (file) {
    visited.delete(file);
    await backend().deleteSession(file).catch(() => undefined);
    clearArchivedSessionPref(file);
    sessionsByWorkspace.update((all) => {
      const list = all[cwd];
      return list ? { ...all, [cwd]: list.filter((s) => s.path !== file) } : all;
    });
    if (cwd === workspace()) sessions.update((list) => list.filter((s) => s.path !== file));
    void refreshSessions(cwd);
  }
  if (wasOpen) {
    await start(cwd, undefined, currentAgentId());
  }
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
    const left = await switchInto(activeProjectPath() || workspace(), undefined, currentAgentId());
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
      if (held) retireDaemonSession(held.id);
      forgetDeletedSession(session.path);
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
    const left = await switchInto(activeProjectPath() || cwd, undefined, currentAgentId());
    if (!left) return;
  }
  // Deleting a run that is still going off screen stops it first: its file is going away.
  const held = daemonSessionByFile(path);
  if (held?.loaded && held.id !== openDaemonId()) quietKill(held.id);
  visited.delete(path);
  await attempt(tr("Could not delete the session", "无法删除会话"), () => backend().deleteSession(path));
  if (held) retireDaemonSession(held.id);
  forgetDeletedSession(path);
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
  const mine = generation;
  const persona = isPersonaSession();
  // During an optimistic new session or switch, remember the pick immediately so the
  // chip updates with zero wait and `finishFreshLaunch` applies it as soon as connected.
  if (phase().name === "starting" || isSwitching() || !client) {
    rememberCurrentSessionChoice({ model: { provider: model.provider, id: model.id }, ...(persona ? { modelConfigs: {} } : {}) });
    return;
  }
  const chosen = await attempt(tr("Could not switch model", "无法切换模型"), () => request("set_model", { provider: model.provider, modelId: model.id }));
  if (!chosen) return;
  rememberCurrentSessionChoice({ model: { provider: chosen.provider, id: chosen.id }, ...(persona ? { modelConfigs: {} } : {}) });
  if (mine !== generation) return;
  state.update((s) => s && { ...s, model: chosen });
  await Promise.all([refreshLevels(), refreshState().catch(() => undefined), refreshStats()]);
}

export async function chooseThinkingLevel(level: ThinkingLevel) {
  if (phase().name === "starting" || isSwitching() || !client) {
    rememberCurrentSessionChoice({ thinkingLevel: level });
    return;
  }
  const applied = await attempt(tr("Could not change thinking", "无法更改思考深度"), async () => {
    await request("set_thinking_level", { level });
    return true;
  });
  if (!applied) return;
  // The preference is the user's abstract pick; the session state is the engine's truth
  // (an ACP model may clamp max to the highest rung it actually offers).
  rememberCurrentSessionChoice({ thinkingLevel: level });
  const actual = await refreshState().catch(() => undefined);
  if (!actual) state.update((s) => s && { ...s, thinkingLevel: level });
}

/** Changes an engine-reported model-adjacent selector (ACP `model_config`, typically Devin's speed). */
export async function chooseModelConfig(configId: string, value: string | boolean) {
  const applied = await attempt(tr("Could not change model setting", "无法更改模型设置"), async () => {
    await request("set_model_config", { configId, value });
    return true;
  });
  if (!applied) return;
  if (isPersonaSession()) {
    rememberCurrentSessionChoice({ modelConfigs: { ...currentSessionChoice()?.modelConfigs, [configId]: value } });
  }
  await refreshState().catch(() => undefined);
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
  modelsByAgent.delete("pi");
  levelsByAgent.delete("pi");
  daemonClient?.clearCatalog("pi");
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
  if (activeAgent().driver === "pi") {
    modelsByAgent.delete("pi");
    levelsByAgent.delete("pi");
    daemonClient?.clearCatalog("pi");
    await restartPi();
  }
  else await refreshCredentials();
}

// ── Navigation ──────────────────────────────────────────────────────────────

export function showChat() {
  setViewChat();
  focusComposer();
}

/** Opens the document tab's editor on `docId` (the document's file path); the chat session stays attached. */
export function showDoc(docId: string) {
  const cur = view();
  if (cur.name !== "doc" || cur.docId !== docId) view.set({ name: "doc", docId });
}

/** The surface Settings was opened over: the back-out (Escape, ⌘,, the corner gear) returns to it — chat or a document. */
let surfaceBeforeSettings: View | null = null;

export function showSettings(section: SettingsSection = "general") {
  const cur = view();
  if (cur.name !== "settings") surfaceBeforeSettings = cur;
  if (cur.name !== "settings" || cur.section !== section || cur.agent !== undefined) {
    view.set({ name: "settings", section });
  }
  if (section === "usage" || !usageLoaded()) void refreshUsageStats();
}

/** Opens Settings on one agent's configuration (the active agent's by default): every agent is set up under Agents. */
export function showAgentSettings(agentId: string = currentAgentId()) {
  const cur = view();
  if (cur.name !== "settings") surfaceBeforeSettings = cur;
  if (cur.name !== "settings" || cur.section !== "agents" || cur.agent !== agentId) {
    view.set({ name: "settings", section: "agents", agent: agentId });
  }
  if (!usageLoaded()) void refreshUsageStats();
}

/** Leaves Settings for the surface it covered, defaulting to the chat when it came from nowhere else. */
export function leaveSettings() {
  const back = surfaceBeforeSettings;
  surfaceBeforeSettings = null;
  if (back?.name === "doc") view.set(back);
  else showChat();
}

export function setPaletteOpen(open: boolean) {
  paletteOpen.set(open);
}

/** Opens the composer's model list, as a press on its chip does. */
export function openModelPicker() {
  setViewChat();
  modelPickerAsk.set(0);
}

// ── Wallpaper ────────────────────────────────────────────────────────────────

export {
  wallpaper,
  wallpaperAgentReactive,
  wallpaperEffect,
  wallpaperFolder,
  wallpaperHistory,
  wallpaperInteractive,
  wallpaperMuted,
  wallpaperPaused,
  wallpaperPauseMode,
  wallpaperSource,
  wallpaperThemeColors,
  wallpaperVideoClickAction,
};

const MAX_WALLPAPER_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_WALLPAPER_VIDEO_INSPECT_BYTES = 32 * 1024 * 1024;
const MAX_WALLPAPER_VIDEO_COPY_BYTES = 8 * 1024 * 1024;

function wallpapersDir(): string {
  return `${backend().dataDir().replace(/\/$/, "")}/new-thread-backgrounds`;
}

function isPathInsideFolder(filePath: string, folderPath?: string): boolean {
  if (!folderPath) return false;
  const cleanFolder = folderPath.replace(/\/$/, "");
  return filePath === cleanFolder || filePath.startsWith(`${cleanFolder}/`);
}

async function resolveWallpaperSource(
  sourcePath: string,
): Promise<{ mediaPath: string; title?: string; dominantColor?: string }> {
  if (!DYNAMIC_WALLPAPER_ENABLED) {
    return { mediaPath: sourcePath };
  }
  let cleanPath = sourcePath.replace(/\/$/, "");
  try {
    const st = await fs.stat(cleanPath);
    if (st.isDirectory()) {
      cleanPath = `${cleanPath}/project.json`;
    }
  } catch {
    // Proceed with sourcePath directly
  }

  if (cleanPath.toLowerCase().endsWith("/project.json") || cleanPath.toLowerCase() === "project.json") {
    const jsonText = await fs.readFile(cleanPath, "utf8");
    const project = parseWallpaperEngineProject(jsonText);
    if (!project) {
      throw new Error(
        tr("Invalid Wallpaper Engine project.json file.", "无效的 Wallpaper Engine project.json 文件。"),
      );
    }
    const slash = cleanPath.lastIndexOf("/");
    const dir = slash >= 0 ? cleanPath.slice(0, slash) : ".";
    const candidatePath = `${dir}/${project.file}`;
    if (isSupportedWallpaperPath(candidatePath)) {
      return {
        mediaPath: candidatePath,
        title: project.title,
        dominantColor: project.dominantColor,
      };
    }
    // If project.file is a scene/web entry, check if the folder contains a direct video/image asset
    try {
      const entries = await fs.readdir(dir);
      const fallback =
        entries.find((e) => !e.startsWith(".") && isVideoWallpaperPath(e)) ??
        entries.find((e) => !e.startsWith(".") && isSupportedWallpaperPath(e));
      if (fallback) {
        return {
          mediaPath: `${dir}/${fallback}`,
          title: project.title,
          dominantColor: project.dominantColor,
        };
      }
    } catch {
      // Ignore directory fallback error
    }
    throw new Error(
      tr(
        "This Wallpaper Engine project does not contain a supported video or image file.",
        "该 Wallpaper Engine 壁纸不包含受支持的视频或图片文件。",
      ),
    );
  }

  return { mediaPath: sourcePath };
}

async function applyWallpaperFile(sourcePath: string, recordInHistory = true): Promise<boolean> {
  const resolved = await resolveWallpaperSource(sourcePath);
  const mediaPath = resolved.mediaPath;
  const isVideo = isVideoWallpaperPath(mediaPath);
  const dir = wallpapersDir();

  const applyImageMedia = async (bytes: Uint8Array): Promise<boolean> => {
    const info = inspectImageBytes(bytes);
    if (!info) {
      throw new Error(tr("Unsupported or corrupted image file.", "不支持或已损坏的图片文件。"));
    }
    const fileName = resolved.title || mediaPath.split("/").pop() || `wallpaper.${info.format}`;
    const dot = mediaPath.lastIndexOf(".");
    const ext = dot >= 0 ? mediaPath.slice(dot + 1).toLowerCase() : info.format;
    let targetPath = mediaPath;

    try {
      await fs.mkdir(dir, { recursive: true });
      // The copy is named by what the bytes are, not what the pick was called —
      // a renamed file must never produce a `background-*.mp4` that holds an image.
      targetPath = `${dir}/background-${Date.now()}.${isVideoWallpaperPath(mediaPath) ? info.format : ext}`;
      await fs.writeFile(targetPath, bytes);
    } catch {
      // In headless tests or read-only sandboxes, fall back to referencing mediaPath directly.
      targetPath = mediaPath;
    }

    const prevPath = wallpaper()?.path;
    if (prevPath && prevPath !== targetPath && prevPath.startsWith(`${dir}/`)) {
      await fs.unlink(prevPath).catch(() => undefined);
    }

    const trackSource =
      recordInHistory || isPathInsideFolder(sourcePath, wallpaperFolder()) ? sourcePath : undefined;
    const dominantColor = resolved.dominantColor ?? info.dominantColor;

    setWallpaperPref(
      {
        path: targetPath,
        name: fileName,
        width: info.width,
        height: info.height,
        adjustment: { ...DEFAULT_WALLPAPER_ADJUSTMENT },
        ...(dominantColor ? { dominantColor } : {}),
        kind: "image",
      },
      trackSource,
    );
    return true;
  };

  if (!DYNAMIC_WALLPAPER_ENABLED && isVideo) {
    throw new Error(tr("Unsupported or corrupted image file.", "不支持或已损坏的图片文件。"));
  }

  if (DYNAMIC_WALLPAPER_ENABLED && isVideo) {
    let fileSize = 0;
    try {
      const st = await fs.stat(mediaPath);
      fileSize = st.size;
    } catch {
      // Continue and let readFile report if unreadable
    }

    let width = 1920;
    let height = 1080;
    let format = mediaPath.split(".").pop()?.toLowerCase() || "mp4";
    let dominantColor = resolved.dominantColor;
    let targetPath = mediaPath;

    if (fileSize <= MAX_WALLPAPER_VIDEO_INSPECT_BYTES) {
      const bytes = await fs.readFile(mediaPath);
      const info = inspectWallpaperBytes(bytes, mediaPath);
      if (!info) {
        throw new Error(tr("Unsupported or corrupted video file.", "不支持或已损坏的视频壁纸文件。"));
      }
      // Content wins over the extension: a renamed image goes down the image path
      // instead of becoming a `kind:"video"` wallpaper nothing can play.
      if (info.kind === "image") {
        return applyImageMedia(bytes);
      }
      width = info.width;
      height = info.height;
      format = info.format;
      if (!dominantColor && info.dominantColor) dominantColor = info.dominantColor;

      if (bytes.byteLength <= MAX_WALLPAPER_VIDEO_COPY_BYTES) {
        try {
          await fs.mkdir(dir, { recursive: true });
          targetPath = `${dir}/background-${Date.now()}.${format}`;
          await fs.writeFile(targetPath, bytes);
        } catch {
          targetPath = mediaPath;
        }
      }
    }

    const prevPath = wallpaper()?.path;
    if (prevPath && prevPath !== targetPath && prevPath.startsWith(`${dir}/`)) {
      await fs.unlink(prevPath).catch(() => undefined);
    }

    const fileName = resolved.title || mediaPath.split("/").pop() || `wallpaper.${format}`;
    const trackSource =
      recordInHistory || isPathInsideFolder(sourcePath, wallpaperFolder()) ? sourcePath : undefined;

    setWallpaperPref(
      {
        path: targetPath,
        name: fileName,
        width,
        height,
        adjustment: { ...DEFAULT_WALLPAPER_ADJUSTMENT },
        ...(dominantColor ? { dominantColor } : {}),
        kind: "video",
      },
      trackSource,
    );
    return true;
  }

  const bytes = await fs.readFile(mediaPath);
  if (bytes.byteLength > MAX_WALLPAPER_IMAGE_BYTES) {
    throw new Error(tr("Image must be 25 MB or smaller.", "图片大小不能超过 25 MB。"));
  }
  return applyImageMedia(bytes);
}

export async function chooseWallpaperImage(): Promise<boolean> {
  const picker = backend().pickImage;
  if (!picker) return false;
  const picked = await pickOrToast(
    picker(
      DYNAMIC_WALLPAPER_ENABLED
        ? tr("Choose wallpaper", "选择壁纸（图片 / 视频 / project.json）")
        : tr("Choose wallpaper", "选择壁纸图片"),
    ),
  );
  if (!picked) return false;
  const ok = await attempt(
    DYNAMIC_WALLPAPER_ENABLED
      ? tr("Could not set wallpaper", "无法设置壁纸")
      : tr("Could not set background image", "无法设置背景图片"),
    () => applyWallpaperFile(picked, isPathInsideFolder(picked, wallpaperFolder())),
  );
  return Boolean(ok);
}

export async function setWallpaperFromPath(sourcePath: string): Promise<boolean> {
  const ok = await attempt(
    DYNAMIC_WALLPAPER_ENABLED
      ? tr("Could not set wallpaper", "无法设置壁纸")
      : tr("Could not set background image", "无法设置背景图片"),
    () => applyWallpaperFile(sourcePath, true),
  );
  return Boolean(ok);
}

export async function setWallpaperPreset(preset: WallpaperPreset) {
  if (!DYNAMIC_WALLPAPER_ENABLED || !isWallpaperPreset(preset)) return;
  const current = wallpaper();
  const dir = wallpapersDir();
  if (current?.path.startsWith(`${dir}/`)) {
    await fs.unlink(current.path).catch(() => undefined);
  }
  const meta = WALLPAPER_PRESET_META[preset];
  setWallpaperPref(
    {
      path: `preset:${preset}`,
      name: meta.name,
      width: 1920,
      height: 1080,
      adjustment: { ...DEFAULT_WALLPAPER_ADJUSTMENT },
      dominantColor: meta.dominantColor,
      kind: "shader",
      preset,
    },
    undefined,
  );
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

export function updateWallpaperDimensions(path: string, width: number, height: number) {
  if (!DYNAMIC_WALLPAPER_ENABLED) return;
  setWallpaperDimensionsPref(path, width, height);
}

export function setWallpaperEffect(effect: WallpaperEffect) {
  if (!isAvailableWallpaperEffect(effect)) return;
  setWallpaperEffectPref(effect);
}

export function setWallpaperThemeColors(enabled: boolean) {
  setWallpaperThemeColorsPref(enabled);
}

export function setWallpaperInteractive(enabled: boolean) {
  if (!DYNAMIC_WALLPAPER_ENABLED) return;
  setWallpaperInteractivePref(enabled);
}

export function setWallpaperAgentReactive(enabled: boolean) {
  if (!DYNAMIC_WALLPAPER_ENABLED) return;
  setWallpaperAgentReactivePref(enabled);
}

export function setWallpaperVideoClickAction(action: WallpaperVideoClickAction) {
  if (!DYNAMIC_WALLPAPER_ENABLED) return;
  setWallpaperVideoClickActionPref(action);
}

export function setWallpaperPauseMode(mode: WallpaperPauseMode) {
  if (!DYNAMIC_WALLPAPER_ENABLED) return;
  setWallpaperPauseModePref(mode);
}

export function setWallpaperPaused(paused: boolean) {
  if (!DYNAMIC_WALLPAPER_ENABLED) return;
  setWallpaperPausedPref(paused);
}

export function toggleWallpaperPaused() {
  if (!DYNAMIC_WALLPAPER_ENABLED) return;
  setWallpaperPausedPref(!wallpaperPaused());
}

export function setWallpaperMuted(muted: boolean) {
  if (!DYNAMIC_WALLPAPER_ENABLED) return;
  setWallpaperMutedPref(muted);
}

export function toggleWallpaperMuted() {
  if (!DYNAMIC_WALLPAPER_ENABLED) return;
  setWallpaperMutedPref(!wallpaperMuted());
}

export async function chooseWallpaperFolder() {
  const picked = await pickOrToast(backend().pickFolder(tr("Choose wallpaper folder", "选择壁纸文件夹")));
  if (!picked) return;
  setWallpaperFolderPref(picked);
  // Picking a folder configures ⌘U rotation; it must not silently replace the
  // wallpaper the user already chose — shuffle now only when there is none.
  if (!wallpaper()) await randomWallpaper(picked);
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
    const cleanFolder = folder.replace(/\/$/, "");
    const names = await fs.readdir(cleanFolder);
    const sorted = names.filter((name) => !name.startsWith(".")).sort((a, b) => a.localeCompare(b));
    const candidates: string[] = [];

    for (const name of sorted) {
      const fullPath = `${cleanFolder}/${name}`;
      if (isSupportedWallpaperPath(name)) {
        candidates.push(fullPath);
        continue;
      }
      // Check if subdirectory is a Wallpaper Engine item with `project.json`
      if (DYNAMIC_WALLPAPER_ENABLED && !name.includes(".")) {
        try {
          const pj = `${fullPath}/project.json`;
          const st = await fs.stat(pj);
          if (st.isFile()) {
            candidates.push(pj);
          }
        } catch {
          // Not a Wallpaper Engine project directory
        }
      }
    }

    if (candidates.length === 0) {
      toast(
        "warning",
        DYNAMIC_WALLPAPER_ENABLED
          ? tr(
              "No supported wallpapers found in wallpaper folder.",
              "壁纸文件夹中未找到受支持的壁纸文件。",
            )
          : tr("No supported images found in wallpaper folder.", "壁纸文件夹中未找到受支持的图片。"),
      );
      return false;
    }

    const candidate = chooseRandomWallpaperCandidate(candidates, wallpaperSource(), wallpaperHistory());
    if (!candidate) return false;
    await applyWallpaperFile(candidate, true);
    return true;
  });

  return Boolean(chosen);
}
