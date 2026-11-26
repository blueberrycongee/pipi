import { batch, computed, signal, untracked } from "nsh";
import {
  activeAgentId,
  activeProjectPath,
  currentDaemonId,
  currentDaemonSession,
  currentView,
  daemonSessionByFile,
  daemonSessionOfId,
  findKnownSessionSummary,
  isChatFolder,
  lastProject,
  onStoreTeardown,
  sessionState,
  workspacePath,
} from "./app";
import { ensureDoc } from "./docs";
import {
  activeTabId,
  chatTabSession,
  chatTabTitle,
  isDraftRef,
  openDaemonSessionTab,
  openDocTab,
  openSessionTab,
  openTabs,
  selectTab,
  tabId,
  type OpenTab,
} from "./tabs";

/**
 * Split view state and the cross-region drag-to-split coordinator.
 *
 * A split lays a second live surface (chat session or Markdown document)
 * alongside the primary workspace on the `"left"` or `"right"` edge.
 * Dragging a row out of the sidebar or a pill down from the tab strip into
 * the main workspace activates two dashed drop zones ("Add left split" /
 * "Add right split"); dropping on either side opens the split immediately.
 */

export type SplitSide = "left" | "right";
export type FocusedPane = "primary" | "split";

export type SplitTarget =
  | {
      kind: "chat";
      /** Stable identity key for deduplication (`file`, `"daemon:<id>"`, or `"new:<seq>"`). */
      ref: string;
      file?: string;
      daemonId?: string;
      cwd?: string;
      agentId?: string;
      title?: string;
    }
  | {
      kind: "doc";
      path: string;
    };

export interface SplitPaneState {
  side: SplitSide;
  target: SplitTarget;
  /** Fraction of the workspace width owned by the split pane (0.28..0.72). */
  ratio: number;
}

export interface WorkspaceBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface SplitDragState {
  source: "sidebar" | "tab";
  target: SplitTarget;
  title: string;
  agentId?: string;
  /** Pointer coordinates in page space. */
  x: number;
  y: number;
  /** Whether the pointer is inside the main workspace region. */
  overWorkspace: boolean;
  /** Which split drop zone the pointer currently targets (`"left"` | `"right"` | null). */
  hoverSide: SplitSide | null;
}

export const SPLIT_RATIO_MIN = 0.28;
export const SPLIT_RATIO_MAX = 0.72;
export const SPLIT_RATIO_DEFAULT = 0.5;

const clampRatio = (ratio: number) =>
  Math.round(Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, ratio)) * 1000) / 1000;

const split = signal<SplitPaneState | null>(null);
const focused = signal<FocusedPane>("primary");
const drag = signal<SplitDragState | null>(null);
const bounds = signal<WorkspaceBounds | null>(null);
let splitDraftSeq = 0;
let measureWorkspaceFn: (() => Promise<WorkspaceBounds | null>) | undefined;
let onDragEndHook: (() => void) | undefined;

export const splitState = () => split();
export const isSplitOpen = computed(() => split() !== null);
export const splitSide = computed<SplitSide>(() => split()?.side ?? "right");
export const splitRatio = computed<number>(() => split()?.ratio ?? SPLIT_RATIO_DEFAULT);
export const splitTarget = computed<SplitTarget | null>(() => split()?.target ?? null);
export const focusedPane = () => focused();
export const splitDrag = () => drag();
export const workspaceBounds = () => bounds();

export function splitTargetKey(target: SplitTarget): string {
  return target.kind === "doc" ? `doc:${target.path}` : `chat:${target.file || target.ref}`;
}

export function focusPane(pane: FocusedPane) {
  if (pane === "split" && !untracked(split)) return;
  if (untracked(focused) !== pane) focused.set(pane);
}

export function setWorkspaceBounds(next: WorkspaceBounds | null) {
  bounds.set(next);
}

export function registerWorkspaceMeasurer(fn: (() => Promise<WorkspaceBounds | null>) | undefined) {
  measureWorkspaceFn = fn;
}

export function refreshWorkspaceBounds(): Promise<WorkspaceBounds | null> {
  if (!measureWorkspaceFn) return Promise.resolve(untracked(bounds));
  return measureWorkspaceFn()
    .then((measured) => {
      if (measured && measured.width > 0 && measured.height > 0) bounds.set(measured);
      return measured ?? untracked(bounds);
    })
    .catch(() => untracked(bounds));
}

/** True when `target` is the exact surface currently shown in the primary pane. */
function isPrimarySurface(target: SplitTarget): boolean {
  const v = untracked(currentView);
  if (target.kind === "doc") return v.name === "doc" && v.docId === target.path;
  if (v.name !== "chat") return false;
  const activeFile = untracked(sessionState)?.sessionFile ?? untracked(currentDaemonSession)?.file;
  const activeDaemon = untracked(currentDaemonId);
  if (target.file && activeFile && target.file === activeFile) return true;
  if (target.daemonId && activeDaemon && target.daemonId === activeDaemon) return true;
  return false;
}

/** Converts an `OpenTab` into a `SplitTarget`. */
export function splitTargetFromTab(tab: OpenTab): SplitTarget {
  if (tab.kind === "doc") return { kind: "doc", path: tab.ref };
  if (isDraftRef(tab.ref)) {
    const cwd = untracked(activeProjectPath) || untracked(workspacePath) || lastProject();
    return { kind: "chat", ref: `split-draft:${++splitDraftSeq}`, cwd, agentId: untracked(activeAgentId) };
  }
  const ds = chatTabSession(tab);
  const daemonId = tab.ref.startsWith("daemon:") ? tab.ref.slice("daemon:".length) : ds?.id;
  const file = tab.ref.startsWith("daemon:") ? (ds?.file ?? tab.file) : tab.ref;
  const summary = file ? findKnownSessionSummary(file) : undefined;
  return {
    kind: "chat",
    ref: file || tab.ref,
    file,
    daemonId,
    cwd: ds?.cwd ?? (untracked(activeProjectPath) || untracked(workspacePath)),
    agentId: ds?.agentId ?? summary?.agentId,
    title: chatTabTitle(tab),
  };
}

/** Builds a fresh chat `SplitTarget` in `cwd` (defaults to the active project). */
export function newChatSplitTarget(cwd?: string): SplitTarget {
  const active = untracked(activeProjectPath) || untracked(workspacePath);
  const targetCwd = cwd ?? (isChatFolder(active) ? lastProject() : active || lastProject());
  return {
    kind: "chat",
    ref: `split-new:${++splitDraftSeq}`,
    cwd: targetCwd,
    agentId: untracked(activeAgentId),
  };
}

/** True when `tab` (from TabBar) is the surface currently shown in the split pane. */
export function isTabInSplit(tab: OpenTab): boolean {
  const cur = split();
  if (!cur) return false;
  if (cur.target.kind === "doc") return tab.kind === "doc" && tab.ref === cur.target.path;
  if (tab.kind !== "chat" || isDraftRef(tab.ref)) return false;
  if (cur.target.file && (tab.ref === cur.target.file || tab.file === cur.target.file)) return true;
  const id = tab.ref.startsWith("daemon:") ? tab.ref.slice("daemon:".length) : chatTabSession(tab)?.id;
  return Boolean(cur.target.daemonId && id && cur.target.daemonId === id);
}

/**
 * Opens `target` in the split pane on `side` (`"left"` or `"right"`).
 *
 * If `target` is already the primary pane's active surface:
 * - when another tab is open on the strip, the primary pane switches to that
 *   neighbour so the dragged surface moves cleanly into the requested split;
 * - when it is the only open surface, a fresh split chat opens beside it so
 *   dragging even a single tab still gives an immediate side-by-side chat.
 */
export function openSplit(target: SplitTarget, side: SplitSide = "right") {
  let effective = target;
  if (isPrimarySurface(target)) {
    const active = untracked(activeTabId);
    const others = untracked(openTabs).filter((t) => tabId(t) !== active);
    if (others.length > 0) {
      selectTab(others[0]);
    } else {
      effective = newChatSplitTarget(target.kind === "chat" ? target.cwd : undefined);
    }
  }
  if (effective.kind === "doc") ensureDoc(effective.path);
  const prevRatio = untracked(split)?.ratio ?? SPLIT_RATIO_DEFAULT;
  batch(() => {
    split.set({ side, target: effective, ratio: prevRatio });
    focused.set("split");
  });
}

/** Opens a fresh chat session in the split pane, or toggles split closed if already open when `toggle` is set. */
export function toggleSplitView(side: SplitSide = "right") {
  if (untracked(split)) {
    closeSplit();
    return;
  }
  const active = untracked(activeTabId);
  const other = untracked(openTabs).find((t) => tabId(t) !== active);
  if (other) {
    openSplit(splitTargetFromTab(other), side);
    return;
  }
  openSplit(newChatSplitTarget(), side);
}

/** Opens a brand-new chat in the split pane explicitly. */
export function openNewChatSplit(side: SplitSide = "right", cwd?: string) {
  openSplit(newChatSplitTarget(cwd), side);
}

/** Closes the split pane without stopping any running daemon session. */
export function closeSplit() {
  if (!untracked(split)) return;
  batch(() => {
    split.set(null);
    focused.set("primary");
  });
}

/** Swaps the split pane between the left and right edges. */
export function swapSplitSide() {
  split.update((cur) => (cur ? { ...cur, side: cur.side === "left" ? "right" : "left" } : null));
}

/** Updates the split pane's width fraction (clamped to `[0.28, 0.72]`). */
export function setSplitRatio(ratio: number) {
  const clamped = clampRatio(ratio);
  split.update((cur) => (cur ? { ...cur, ratio: clamped } : null));
}

/** Moves the split pane's current session or document into the primary pane and closes the split. */
export function promoteSplitToPrimary(liveRef?: { file?: string; daemonId?: string; cwd?: string; agentId?: string }) {
  const cur = untracked(split);
  if (!cur) return;
  const target = cur.target;
  closeSplit();
  if (target.kind === "doc") {
    openDocTab(target.path, { newTab: true });
    return;
  }
  const daemonId = liveRef?.daemonId ?? target.daemonId;
  const file = liveRef?.file ?? target.file;
  if (daemonId && daemonSessionOfId(daemonId)) {
    openDaemonSessionTab(daemonId, { newTab: true });
    return;
  }
  if (file) {
    const held = daemonSessionByFile(file);
    if (held) openDaemonSessionTab(held.id, { newTab: true });
    else void openSessionTab(file, liveRef?.cwd ?? target.cwd, { newTab: true, agentId: liveRef?.agentId ?? target.agentId });
  }
}

// ── Cross-region drag-to-split coordinator ──────────────────────────────────

/**
 * Hit-tests `(x, y)` against the main workspace rect.
 * Left ~45% targets `"left"`, right ~45% targets `"right"`, and a quiet 10%
 * center band stays `null` so a reader can safely release in the middle to cancel.
 */
function hitTestWorkspace(x: number, y: number, rect: WorkspaceBounds | null): { over: boolean; side: SplitSide | null } {
  if (!rect || rect.width <= 0 || rect.height <= 0) return { over: false, side: null };
  const inside = x >= rect.left - 8 && x <= rect.left + rect.width + 8 && y >= rect.top - 4 && y <= rect.top + rect.height + 8;
  if (!inside) return { over: false, side: null };
  const relX = (x - rect.left) / rect.width;
  if (relX <= 0.45) return { over: true, side: "left" };
  if (relX >= 0.55) return { over: true, side: "right" };
  return { over: true, side: null };
}

/** True when `(x, y)` is inside the workspace drop zone (with a small leading margin for sidebar handoff). */
export function isPointInWorkspace(x: number, y: number): boolean {
  const rect = untracked(bounds);
  if (!rect || rect.width <= 0 || rect.height <= 0) return false;
  return x >= rect.left - 8 && x <= rect.left + rect.width + 8 && y >= rect.top && y <= rect.top + rect.height + 8;
}

/** Begins a cross-region split drag handed off from Sidebar or TabBar. */
export function startSplitDrag(
  info: {
    source: "sidebar" | "tab";
    target: SplitTarget;
    title: string;
    agentId?: string;
    x: number;
    y: number;
  },
  onEnd?: () => void,
) {
  onDragEndHook = onEnd;
  const rect = untracked(bounds);
  const hit = hitTestWorkspace(info.x, info.y, rect);
  drag.set({
    source: info.source,
    target: info.target,
    title: info.title,
    agentId: info.agentId,
    x: info.x,
    y: info.y,
    overWorkspace: hit.over,
    hoverSide: hit.side,
  });
  void refreshWorkspaceBounds().then((fresh) => {
    const cur = untracked(drag);
    if (!cur || !fresh) return;
    const updated = hitTestWorkspace(cur.x, cur.y, fresh);
    if (updated.over !== cur.overWorkspace || updated.side !== cur.hoverSide) {
      drag.set({ ...cur, overWorkspace: updated.over, hoverSide: updated.side });
    }
  });
}

/** Updates pointer coordinates during an active split drag. */
export function moveSplitDrag(x: number, y: number) {
  const cur = untracked(drag);
  if (!cur) return;
  const hit = hitTestWorkspace(x, y, untracked(bounds));
  drag.set({ ...cur, x, y, overWorkspace: hit.over, hoverSide: hit.side });
}

/** Ends an active split drag, committing the split if released over a drop zone. */
export function endSplitDrag(commit: boolean): boolean {
  const cur = untracked(drag);
  const hook = onDragEndHook;
  onDragEndHook = undefined;
  if (!cur) return false;
  drag.set(null);
  hook?.();
  if (commit && cur.overWorkspace && cur.hoverSide) {
    openSplit(cur.target, cur.hoverSide);
    return true;
  }
  return false;
}

export function cancelSplitDrag() {
  endSplitDrag(false);
}

onStoreTeardown(() => {
  split.set(null);
  focused.set("primary");
  drag.set(null);
  bounds.set(null);
  onDragEndHook = undefined;
});
