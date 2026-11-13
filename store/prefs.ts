import { setColorScheme, setTheme, signal, Storage } from "nsh";
import type { AgentOverride, CustomAgentConfig, RuntimeMode } from "../agents/types";
import type { ThinkingLevel } from "../pi/protocol";
import { isCoat, type CoatId } from "../mascot/geometry";
import {
  buildWallpaperTintedTheme,
  clampAdjustment,
  isWallpaperEffect,
  rememberWallpaperHistory,
  type WallpaperAdjustment,
  type WallpaperConfig,
  type WallpaperEffect,
} from "../lib/wallpaper";

/** What pipi remembers between launches, kept in the app's own storage. */
export type Appearance = "system" | "light" | "dark";
export type Language = "system" | "en" | "zh";
export const AUTO_ARCHIVE_DAYS = [0, 7, 14, 30, 90] as const;
export type AutoArchiveDays = (typeof AUTO_ARCHIVE_DAYS)[number];
export type AgentSendScope = "all" | "children";
export const SESSION_TREE_DEPTHS = [1, 2, 3] as const;
export type SessionTreeDepth = (typeof SESSION_TREE_DEPTHS)[number];
export const SESSION_TREE_MAX = [4, 8, 16] as const;
export type SessionTreeMax = (typeof SESSION_TREE_MAX)[number];

export interface ArchivedSessionMeta {
  /** Unix timestamp (ms) when the session was archived. */
  archivedAt: number;
  /** Working directory of the project that owns this session. */
  cwd?: string;
}

/** What the user last picked on one agent's pickers; every fresh session on that agent restores it. */
export interface AgentSessionChoice {
  /** Model as `{provider, id}` (the same key the model list uses). */
  model?: { provider: string; id: string };
  /** Thinking depth: pipi's levels, or an ACP harness's own advertised effort value. */
  thinkingLevel?: ThinkingLevel;
}

interface Prefs {
  /** Open project folders in the sidebar, in display order. */
  workspaces: string[];
  /** Project folders whose session lists are collapsed in the sidebar. */
  collapsedWorkspaces: string[];
  /** Sidebar functional groups folded away: `"workspaces"`, `"recents"`, `"archived"`. */
  collapsedGroups: string[];
  /** Saved sessions tucked into Archived (never deleted on disk), keyed by session `.jsonl` path. */
  archivedSessions: Record<string, ArchivedSessionMeta>;
  /** Days without activity before an inactive conversation is archived automatically; `0` turns it off. */
  autoArchiveDays: AutoArchiveDays;
  /** The last active project folder. */
  activeWorkspace?: string;
  appearance: Appearance;
  /** Which coat Pip wears: the same mascot in a different coat (`mascot/geometry.ts` → `COATS`). */
  pipCoat: CoatId;
  language: Language;
  sidebarOpen: boolean;
  /** The sidebar's width in points, kept between launches. */
  sidebarWidth: number;
  /** Automatic retry, once the user chose: Pi reports no current value, so the app re-applies the choice at start. */
  autoRetry?: boolean;
  /** Default coding agent harness id (`"pi"`, `"claude"`, `"codex"`, `"opencode"`, `"cursor"`, or custom ACP id). */
  defaultAgentId: string;
  /** Shared runtime permission ceiling (`"approval-required"`, `"auto-accept-edits"`, `"full-access"`). */
  runtimeMode: RuntimeMode;
  /** Whether parallel multi-agent orchestrations isolate each agent in its own Git worktree by default. */
  worktreeIsolationDefault: boolean;
  /** Whether agents inside pipi sessions may call the six session tools (start/read/send/list/stop). */
  agentSessionTools: boolean;
  /** Which sessions an agent may message: only sessions it started, or any session in reach. */
  agentSendScope: AgentSendScope;
  /** How many generations of agent-started sessions may nest under one session. */
  sessionTreeDepth: SessionTreeDepth;
  /** How many sessions one session tree may keep running at once. */
  sessionTreeMax: SessionTreeMax;
  /** Whether sessions keep running (the session daemon stays up) after the window closes. */
  runInBackground: boolean;
  /** Per-agent binary path / launch flag overrides. */
  agentOverrides: Record<string, AgentOverride>;
  /** User-configured custom ACP / CLI coding agents. */
  customAgents: CustomAgentConfig[];
  /** Per-agent last model + thinking picks, restored onto each fresh session. */
  agentSessionChoices: Record<string, AgentSessionChoice>;
  /** The wallpaper laid under the whole window. */
  wallpaper: WallpaperConfig | null;
  /** Visual shader effect the wallpaper is drawn through. */
  wallpaperEffect: WallpaperEffect;
  /** Optional directory scanned when rotating random wallpapers (`⌘U`). */
  wallpaperFolder?: string;
  /** Original source file path of the active wallpaper inside `wallpaperFolder`. */
  wallpaperSource?: string;
  /** Recently picked wallpaper source paths so random rotation avoids immediate repeats. */
  wallpaperHistory: string[];
  /** Whether app theme surface and accent tokens are tinted from the wallpaper's dominant color. */
  wallpaperThemeColors: boolean;
}

const KEY = "pipi.prefs.v1";
/**
 * The sidebar's usable minimum width in points: sized so macOS window traffic
 * lights (`titleBar().left`, ~78pt), a draggable header gap, and the
 * top-right hide-sidebar button never collide or overlap.
 */
export const SIDEBAR_MIN_WIDTH = 236;
export const SIDEBAR_MAX_WIDTH = 480;
export const SIDEBAR_DEFAULT_WIDTH = 264;
const DEFAULTS: Prefs = {
  workspaces: [],
  collapsedWorkspaces: [],
  collapsedGroups: ["archived"],
  archivedSessions: {},
  autoArchiveDays: 0,
  appearance: "system",
  pipCoat: "ghost",
  language: "system",
  sidebarOpen: true,
  sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
  defaultAgentId: "pi",
  runtimeMode: "full-access",
  worktreeIsolationDefault: true,
  agentSessionTools: true,
  agentSendScope: "all",
  sessionTreeDepth: 2,
  sessionTreeMax: 8,
  runInBackground: false,
  agentOverrides: {},
  customAgents: [],
  agentSessionChoices: {},
  wallpaper: null,
  wallpaperEffect: "none",
  wallpaperHistory: [],
  wallpaperThemeColors: false,
};
const MAX_WORKSPACES = 20;

const clampSidebarWidth = (width: number) => Math.round(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width)));

function normalizeArchivedSessions(raw: unknown): Record<string, ArchivedSessionMeta> {
  if (Array.isArray(raw)) {
    const out: Record<string, ArchivedSessionMeta> = {};
    for (const item of raw) {
      if (typeof item === "string" && item) out[item] = { archivedAt: 0 };
    }
    return out;
  }
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, ArchivedSessionMeta> = {};
  for (const [path, meta] of Object.entries(raw as Record<string, unknown>)) {
    if (!path) continue;
    if (typeof meta === "number") {
      out[path] = { archivedAt: meta };
    } else if (meta && typeof meta === "object") {
      const m = meta as Partial<ArchivedSessionMeta>;
      out[path] = {
        archivedAt: typeof m.archivedAt === "number" ? m.archivedAt : 0,
        ...(typeof m.cwd === "string" && m.cwd ? { cwd: m.cwd } : {}),
      };
    }
  }
  return out;
}

function normalizeWallpaperConfig(raw: unknown): WallpaperConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const w = raw as Partial<WallpaperConfig>;
  if (typeof w.path !== "string" || !w.path) return null;
  const width = typeof w.width === "number" && w.width > 0 ? w.width : 1920;
  const height = typeof w.height === "number" && w.height > 0 ? w.height : 1080;
  const name = typeof w.name === "string" && w.name ? w.name : w.path.split("/").pop() ?? "wallpaper";
  return {
    path: w.path,
    name,
    width,
    height,
    adjustment: clampAdjustment(w.adjustment),
    ...(typeof w.dominantColor === "string" && w.dominantColor ? { dominantColor: w.dominantColor } : {}),
  };
}

function normalizeSessionChoices(raw: unknown): Record<string, AgentSessionChoice> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, AgentSessionChoice> = {};
  for (const [agentId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!agentId || !value || typeof value !== "object") continue;
    const choice = value as Partial<AgentSessionChoice>;
    const model =
      choice.model && typeof choice.model === "object" && typeof choice.model.provider === "string" && typeof choice.model.id === "string" && choice.model.id
        ? { provider: choice.model.provider, id: choice.model.id }
        : undefined;
    // ACP harnesses may advertise effort values outside pipi's level union; keep any non-empty string.
    const thinkingLevel = typeof choice.thinkingLevel === "string" && choice.thinkingLevel ? (choice.thinkingLevel as ThinkingLevel) : undefined;
    if (model || thinkingLevel) {
      out[agentId] = { ...(model ? { model } : {}), ...(thinkingLevel ? { thinkingLevel } : {}) };
    }
  }
  return out;
}

const prefs = signal<Prefs>(DEFAULTS);

/** Reads the stored preferences; call once, before the first screen. */
export async function loadPrefs() {
  try {
    const stored = await Storage.getItem(KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<Prefs> & { archivedSessions?: unknown };
      const rawGroups = Array.isArray(parsed.collapsedGroups) ? parsed.collapsedGroups : DEFAULTS.collapsedGroups;
      const collapsedGroups = parsed.archivedSessions === undefined && !rawGroups.includes("archived") ? [...rawGroups, "archived"] : rawGroups;
      prefs.set({
        ...DEFAULTS,
        ...parsed,
        agentOverrides: parsed.agentOverrides ?? {},
        customAgents: Array.isArray(parsed.customAgents) ? parsed.customAgents : [],
        agentSessionChoices: normalizeSessionChoices(parsed.agentSessionChoices),
        collapsedWorkspaces: Array.isArray(parsed.collapsedWorkspaces) ? parsed.collapsedWorkspaces : [],
        collapsedGroups,
        archivedSessions: normalizeArchivedSessions(parsed.archivedSessions),
        autoArchiveDays: AUTO_ARCHIVE_DAYS.includes(parsed.autoArchiveDays as AutoArchiveDays)
          ? (parsed.autoArchiveDays as AutoArchiveDays)
          : 0,
        sidebarWidth: typeof parsed.sidebarWidth === "number" ? clampSidebarWidth(parsed.sidebarWidth) : SIDEBAR_DEFAULT_WIDTH,
        wallpaper: normalizeWallpaperConfig(parsed.wallpaper),
        wallpaperEffect: isWallpaperEffect(parsed.wallpaperEffect) ? parsed.wallpaperEffect : "none",
        wallpaperFolder: typeof parsed.wallpaperFolder === "string" && parsed.wallpaperFolder ? parsed.wallpaperFolder : undefined,
        wallpaperSource: typeof parsed.wallpaperSource === "string" && parsed.wallpaperSource ? parsed.wallpaperSource : undefined,
        wallpaperHistory: Array.isArray(parsed.wallpaperHistory)
          ? parsed.wallpaperHistory.filter((p): p is string => typeof p === "string" && p.length > 0)
          : [],
        wallpaperThemeColors: Boolean(parsed.wallpaperThemeColors),
      });
    }
  } catch {
    // Unreadable preferences are replaced by the defaults at the next change.
  }
  applyAppearance(prefs().appearance);
  applyWallpaperTheme();
}

function change(patch: Partial<Prefs>) {
  prefs.set({ ...prefs(), ...patch });
  Storage.setItem(KEY, JSON.stringify(prefs())).catch(() => undefined);
}

function applyAppearance(appearance: Appearance) {
  setColorScheme(appearance);
}

function applyWallpaperTheme() {
  const { wallpaperThemeColors: enabled, wallpaper: wp } = prefs();
  if (enabled && wp?.dominantColor) {
    const tinted = buildWallpaperTintedTheme(wp.dominantColor);
    if (tinted) {
      setTheme(tinted);
      return;
    }
  }
  setTheme(null);
}

export const recentWorkspaces = () => prefs().workspaces;
export const lastActiveWorkspace = () => prefs().activeWorkspace;
export const collapsedWorkspaces = () => prefs().collapsedWorkspaces;
export const isWorkspaceCollapsed = (path: string) => prefs().collapsedWorkspaces.includes(path);
export const isGroupCollapsed = (id: string) => prefs().collapsedGroups.includes(id);
export const archivedSessions = () => prefs().archivedSessions;
export const isSessionArchived = (path: string | undefined) =>
  !!path && Object.prototype.hasOwnProperty.call(prefs().archivedSessions, path);
export const autoArchiveDays = () => prefs().autoArchiveDays;
export const appearance = () => prefs().appearance;
export const pipCoat = (): CoatId => (isCoat(prefs().pipCoat) ? prefs().pipCoat : "ghost");
export const language = () => prefs().language;
export const sidebarOpen = () => prefs().sidebarOpen;
export const sidebarWidth = () => prefs().sidebarWidth;
export const autoRetryChoice = () => prefs().autoRetry;
export const preferredAgentId = () => prefs().defaultAgentId;
export const preferredRuntimeMode = () => prefs().runtimeMode;
export const worktreeIsolationDefault = () => prefs().worktreeIsolationDefault;
export const agentSessionTools = () => prefs().agentSessionTools;
export const agentSendScope = () => prefs().agentSendScope;
export const sessionTreeDepth = () => prefs().sessionTreeDepth;
export const sessionTreeMax = () => prefs().sessionTreeMax;
export const runInBackground = () => prefs().runInBackground;
export const storedAgentOverrides = () => prefs().agentOverrides;
export const storedCustomAgents = () => prefs().customAgents;
export const storedSessionChoice = (agentId: string): AgentSessionChoice | undefined => prefs().agentSessionChoices[agentId];
export const wallpaper = () => prefs().wallpaper;
export const wallpaperEffect = () => prefs().wallpaperEffect;
export const wallpaperFolder = () => prefs().wallpaperFolder;
export const wallpaperSource = () => prefs().wallpaperSource;
export const wallpaperHistory = () => prefs().wallpaperHistory;
export const wallpaperThemeColors = () => prefs().wallpaperThemeColors;

export function setAppearance(next: Appearance) {
  change({ appearance: next });
  applyAppearance(next);
}

export function setPipCoat(next: CoatId) {
  change({ pipCoat: next });
}

export function setLanguage(next: Language) {
  change({ language: next });
}

export function setSidebarOpen(open: boolean) {
  change({ sidebarOpen: open });
}

export function setSidebarWidth(width: number) {
  change({ sidebarWidth: clampSidebarWidth(width) });
}

export function rememberAutoRetry(enabled: boolean) {
  change({ autoRetry: enabled });
}

export function setPreferredAgentId(agentId: string) {
  change({ defaultAgentId: agentId });
}

const daemonPrefsListeners = new Set<() => void>();

/** Subscribes to preference changes that must be pushed live to the session daemon. */
export function onDaemonPrefsChange(listener: () => void): () => void {
  daemonPrefsListeners.add(listener);
  return () => daemonPrefsListeners.delete(listener);
}

function notifyDaemonPrefs() {
  for (const listener of daemonPrefsListeners) listener();
}

export function setPreferredRuntimeMode(mode: RuntimeMode) {
  change({ runtimeMode: mode });
}

export function setWorktreeIsolationDefault(enabled: boolean) {
  change({ worktreeIsolationDefault: enabled });
  notifyDaemonPrefs();
}

export function setAgentSessionTools(enabled: boolean) {
  change({ agentSessionTools: enabled });
  notifyDaemonPrefs();
}

export function setAgentSendScope(scope: AgentSendScope) {
  change({ agentSendScope: scope });
  notifyDaemonPrefs();
}

export function setSessionTreeDepth(depth: SessionTreeDepth) {
  if (!SESSION_TREE_DEPTHS.includes(depth)) return;
  change({ sessionTreeDepth: depth });
  notifyDaemonPrefs();
}

export function setSessionTreeMax(max: SessionTreeMax) {
  if (!SESSION_TREE_MAX.includes(max)) return;
  change({ sessionTreeMax: max });
  notifyDaemonPrefs();
}

export function setRunInBackground(enabled: boolean) {
  change({ runInBackground: enabled });
  notifyDaemonPrefs();
}

export function setAgentOverride(agentId: string, override: AgentOverride) {
  const next = { ...prefs().agentOverrides };
  const binaryPath = override.binaryPath?.trim() || undefined;
  const extraArgs = override.extraArgs?.filter(Boolean);
  const defaultModel = override.defaultModel?.trim() || undefined;
  const enabled = override.enabled === false ? false : undefined;
  if (!binaryPath && (!extraArgs || extraArgs.length === 0) && !defaultModel && enabled === undefined) {
    delete next[agentId];
  } else {
    next[agentId] = {
      ...(enabled !== undefined ? { enabled } : {}),
      ...(binaryPath ? { binaryPath } : {}),
      ...(extraArgs?.length ? { extraArgs } : {}),
      ...(defaultModel ? { defaultModel } : {}),
    };
  }
  change({ agentOverrides: next });
}

/** Merges the user's latest model/thinking pick into what is remembered for `agentId`. */
export function rememberSessionChoice(agentId: string, patch: Partial<AgentSessionChoice>) {
  if (!agentId) return;
  const current = prefs().agentSessionChoices[agentId] ?? {};
  change({ agentSessionChoices: { ...prefs().agentSessionChoices, [agentId]: { ...current, ...patch } } });
}

export function addCustomAgentPref(agent: CustomAgentConfig) {
  change({ customAgents: [...prefs().customAgents.filter((c) => c.id !== agent.id), agent] });
}

export function removeCustomAgentPref(agentId: string) {
  change({
    customAgents: prefs().customAgents.filter((c) => c.id !== agentId),
    ...(prefs().defaultAgentId === agentId ? { defaultAgentId: "pi" } : {}),
  });
}

/** Ensures a folder is in the open projects list (preserving existing order) and marks it active. */
export function rememberWorkspace(path: string) {
  if (!path) return;
  const current = prefs().workspaces;
  const workspaces = current.includes(path) ? current : [...current, path].slice(-MAX_WORKSPACES);
  change({ workspaces, activeWorkspace: path });
}

/** Ensures a folder is in the open projects list without changing which workspace is active. */
export function ensureWorkspaceListed(path: string) {
  if (!path) return;
  const current = prefs().workspaces;
  if (current.includes(path)) return;
  change({ workspaces: [...current, path].slice(-MAX_WORKSPACES) });
}

export function setSessionArchived(path: string, archived: boolean, cwd?: string) {
  if (!path) return;
  const current = prefs().archivedSessions;
  if (!archived && !(path in current)) return;
  const next = { ...current };
  if (archived) {
    const prevCwd = current[path]?.cwd;
    const effectiveCwd = cwd || prevCwd;
    next[path] = {
      archivedAt: Date.now(),
      ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
    };
  } else {
    delete next[path];
  }
  change({ archivedSessions: next });
}

export function archiveSessionsBatch(entries: readonly { path: string; cwd?: string }[], archivedAt = Date.now()) {
  if (entries.length === 0) return;
  const current = prefs().archivedSessions;
  let changed = false;
  const next = { ...current };
  for (const { path, cwd } of entries) {
    if (!path || path in next) continue;
    next[path] = { archivedAt, ...(cwd ? { cwd } : {}) };
    changed = true;
  }
  if (changed) change({ archivedSessions: next });
}

export function clearArchivedSessionPref(path: string) {
  setSessionArchived(path, false);
}

export function setAutoArchiveDays(days: AutoArchiveDays) {
  if (!AUTO_ARCHIVE_DAYS.includes(days)) return;
  change({ autoArchiveDays: days });
}

export function forgetWorkspace(path: string) {
  const workspaces = prefs().workspaces.filter((p) => p !== path);
  change({
    workspaces,
    collapsedWorkspaces: prefs().collapsedWorkspaces.filter((p) => p !== path),
    ...(prefs().activeWorkspace === path ? { activeWorkspace: workspaces[0] } : {}),
  });
}

export function setWorkspaceCollapsed(path: string, collapsed: boolean) {
  const list = prefs().collapsedWorkspaces.filter((p) => p !== path);
  change({ collapsedWorkspaces: collapsed ? [...list, path] : list });
}

export function toggleWorkspaceCollapsed(path: string) {
  setWorkspaceCollapsed(path, !isWorkspaceCollapsed(path));
}

export function setGroupCollapsed(id: string, collapsed: boolean) {
  const list = prefs().collapsedGroups.filter((g) => g !== id);
  change({ collapsedGroups: collapsed ? [...list, id] : list });
}

export function toggleGroupCollapsed(id: string) {
  setGroupCollapsed(id, !isGroupCollapsed(id));
}

export function setWallpaperPref(
  next: WallpaperConfig | null,
  sourcePath?: string,
) {
  const history = sourcePath
    ? rememberWallpaperHistory(prefs().wallpaperHistory, sourcePath)
    : prefs().wallpaperHistory;
  change({
    wallpaper: next ? normalizeWallpaperConfig(next) : null,
    wallpaperSource: next ? sourcePath : undefined,
    wallpaperHistory: history,
  });
  applyWallpaperTheme();
}

export function setWallpaperAdjustmentPref(adjustment: WallpaperAdjustment) {
  const current = prefs().wallpaper;
  if (!current) return;
  change({
    wallpaper: {
      ...current,
      adjustment: clampAdjustment(adjustment),
    },
  });
}

export function setWallpaperEffectPref(effect: WallpaperEffect) {
  if (!isWallpaperEffect(effect)) return;
  change({ wallpaperEffect: effect });
}

export function setWallpaperFolderPref(folder: string | undefined) {
  const trimmed = folder?.trim() || undefined;
  change({ wallpaperFolder: trimmed });
}

export function setWallpaperThemeColorsPref(enabled: boolean) {
  change({ wallpaperThemeColors: enabled });
  applyWallpaperTheme();
}
