import {
  batch,
  Clipboard,
  cleanup,
  computed,
  createAnimatedValue,
  effect,
  keymap,
  openUrl,
  platform,
  reduceMotion,
  Scroll,
  signal,
  Text,
  untracked,
  View,
} from "nsh";
import type { AnimatedValue, ContextMenuEvent, GestureResponderEvent, JSX, MouseEvent, PressEvent, ScrollRef, ViewRef } from "nsh";
import { AlertDialog, Button as BaseButton, Collapsible } from "nsh/base";
import { Haptics, isAvailable as hapticsAvailable } from "nsh/mobile";
import { Menu, type MenuItem } from "nsh/desktop";
import { SHEET_INSET, TITLE_BAR_HEIGHT, titleBarArea } from "../lib/layout";
import { basename, tildePath } from "../lib/format";
import { tr } from "../lib/i18n";
import { Pip } from "../mascot/Pip";
import type { DaemonSession } from "../pi/daemon";
import { type SessionSummary, sessionTitle } from "../pi/sessions";
import { AgentLogo } from "../ui/AgentLogo";
import {
  activeAgentId,
  activeProjectPath as openFolderPath,
  archivedSessionItems,
  archiveDaemonSession,
  archiveSession,
  availableAgents,
  chatFolder,
  childSessionsOf,
  childSessionsOfDaemon,
  childSessionsOfOpen,
  chooseWorkspace,
  closeWorkspace,
  copyText,
  currentDaemonId,
  currentDaemonSession,
  currentTitle,
  currentView,
  daemonRootEarnsRow,
  daemonSessionByFile,
  daemonSessionOfId,
  daemonSessions,
  daemonSessionTitle,
  daemonTreePlace,
  isChatFolder,
  isDaemonTaskSession,
  isDraftAhead,
  isPersonaFolder,
  isRunning,
  isSessionRunning,
  isSessionUnread,
  leaveSettings,
  openWorkspace,
  pendingSession,
  placeLabel,
  projectCwdOf,
  removeDaemonSession,
  removeSession,
  savedSessions,
  sessionsReady,
  sessionState,
  showChat,
  showSettings,
  sidecarPhase,
  startRenaming,
  stopDaemonSession,
  unarchiveSession,
  wallpaper,
  workspaceSessions,
} from "../store/app";
import { backend } from "../store/backend";
import { chooseDocsFolder, type NoteSummary, notes, revealDoc, revealDocsFolder } from "../store/docs";
import {
  addDocToNewSession,
  addDocToTab,
  deleteNote,
  docChatTargets,
  docTabTitle,
  newDocTab,
  openDaemonSessionTab,
  openDocTab,
  openNewChatTab,
  openNewSessionTab,
  openSessionTab,
  pickDocTab,
  saveDocAs,
} from "../store/tabs";
import { endSplitDrag, isPointInWorkspace, moveSplitDrag, openSplit, splitDrag, startSplitDrag, type SplitTarget } from "../store/split";
import {
  docRankOverrides,
  isGroupCollapsed,
  isSessionArchived,
  isWorkspaceCollapsed,
  recentRankOverrides,
  recentWorkspaces,
  reorderWorkspaces,
  sessionRankOverrides,
  setDocRankOverrides,
  setGroupCollapsed,
  setRecentRankOverrides,
  setSessionRankOverrides,
  setSidebarOpen,
  setWorkspaceCollapsed,
  toggleGroupCollapsed,
  toggleWorkspaceCollapsed,
} from "../store/prefs";
import { IconButton } from "../ui/Button";
import { Icon, type IconName } from "../ui/Icon";
import { animateNextLayout, delayedFade, EASING, Presence, Reveal } from "../ui/motion";
import { FOCUS_RING, HOVER_REVEAL, PRESS, WALLPAPER_FROST } from "../ui/styles";
import { tip } from "../ui/Tip";
import { uiHeight, uiIconSize, uiRowHeight, uiType } from "../ui/typography";
import { PipRow } from "./PipRow";

/** A row inside an expanded workspace folder: a saved session. */
type FolderItem = { id: string; session?: SessionSummary; child?: DaemonSession };

type GroupId = "workspaces" | "recents" | "docs" | "archived";

/** A row in 最近: a saved session, or a daemon session of a tree with no saved row to hang under. */
type RecentItem = { id: string; session?: SessionSummary; child?: DaemonSession; cwd?: string };

/** How many sessions 最近 lists before its footer offers to show the rest. */
const RECENT_LIMIT = 100;
/** How many documents 文档 lists before its footer offers to show the rest. */
const DOCS_LIMIT = 10;
const REPO_URL = "https://github.com/blueberrycongee/pipi";
const ICON_SLOT = "size-5 shrink-0 items-center justify-center";
/** Trailing 24pt slot (`right-1` inside `px-2`) centered vertically on the row's dynamic height. */
const TRAILING_SLOT = "pointer-events-none absolute right-1 size-6 flex-row items-center justify-center";
const rowTrailingTop = () => Math.round((uiRowHeight(28) - 24) / 2);
const groupActionTop = () => Math.round((uiRowHeight(24) - 24) / 2);
/**
 * Window controls stand at the sidebar strip's left end (macOS's traffic
 * lights; a Linux layout can place them there too — `titleBar().left`).
 * `platform.os` covers them headless, where `titleBar()` reports zeros.
 */
const leftControls = () => platform.os === "macos" || titleBarArea().left > 0;
/** True when the platform's primary modifier (⌘ on macOS, Ctrl elsewhere) was held on a press. */
const isModPress = (e?: { modifiers?: { platform?: boolean; control?: boolean } }) =>
  Boolean(platform.os === "macos" ? e?.modifiers?.platform : e?.modifiers?.control);
function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sameStringSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const item of a) if (!b.has(item)) return false;
  return true;
}

const sameEngine = (
  a: { id: string; name: string; available: boolean },
  b: { id: string; name: string; available: boolean },
) => a.id === b.id && a.name === b.name && a.available === b.available;

const sameLabel = (a: { name: string; parent?: string }, b: { name: string; parent?: string }) =>
  a.name === b.name && a.parent === b.parent;

/** The open project folder; Pip's folder of notes is no project, so with Pip open none is. */
const activeProjectPath = computed(() => {
  const cwd = openFolderPath();
  return isPersonaFolder(cwd) ? "" : cwd;
});
const activeViewName = computed(() => currentView().name);
const activeDocId = computed(() => {
  const v = currentView();
  return v.name === "doc" ? v.docId : undefined;
});
const ROW_PRESS = `${PRESS} ${FOCUS_RING} hover:bg-sidebar-accent group-hover:bg-sidebar-accent active:bg-sidebar-accent`;
/**
 * The pointer rests while rows slide under it — a draft row opening or closing
 * shifts every row below as a session changes. A hover is the pointer's doing,
 * not the list's: until it moves again, the rows passing under it stay quiet
 * instead of lighting up one after the other (and one of them for good, beside
 * the row just opened).
 */
const pointerResting = signal(false);
/** A row's wrapper: `group` carries its hover looks, which a resting pointer does not earn. */
const hoverGroup = () => (pointerResting() ? "relative" : "group relative");
/** A pressable's own hover background, dropped the same way. */
const calm = (classes: string) => (pointerResting() ? classes.replace(" hover:bg-sidebar-accent", "") : classes);
/** A row's hover action is inert under a resting pointer too: never shown, it cannot be pressed blind. */
const inert = (classes: string) => (pointerResting() ? `${classes} pointer-events-none` : classes);
/** The group each session was last clicked in (`ownsActiveSession`). */
const chosenGroups = signal<Record<string, GroupId>>({});
/** Which group (`workspaces` or `recents`) owns the open draft session's highlight. */
const draftGroup = signal<GroupId>("workspaces");
let explicitDraftGroup: GroupId | undefined;

/** The open project folders: the active one first, then the recents it also leads. */
const projects = computed(
  () => {
    const active = activeProjectPath();
    const list = recentWorkspaces();
    if (!active || isChatFolder(active)) return list;
    return list.includes(active) ? list : [active, ...list];
  },
  { equals: sameItems },
);

const WORKSPACE_LIMIT = 6;
const workspacesExpanded = signal(false);
const shownProjects = computed(
  () => {
    const all = projects();
    if (workspacesExpanded() || all.length <= WORKSPACE_LIMIT) return all;
    const head = all.slice(0, WORKSPACE_LIMIT);
    const active = activeProjectPath();
    if (active && !isChatFolder(active) && all.includes(active) && !head.includes(active)) {
      return [active, ...head.slice(0, WORKSPACE_LIMIT - 1)];
    }
    return head;
  },
  { equals: sameItems },
);

/** The folders 最近 gathers sessions from: every open project, and the chat folder. */
const recentFolders = computed(() => [...projects(), chatFolder()], { equals: sameItems });

const titleOf = (session: SessionSummary) => sessionTitle(session, tr("New session", "新会话"));

/** The daemon session open on screen (or where a session change is heading). */
const openDaemon = computed(() => {
  const pending = pendingSession();
  if (pending) return pending.daemonId ? daemonSessionOfId(pending.daemonId) : daemonSessionByFile(pending.file);
  return currentDaemonSession();
});

/**
 * The open session has no row of its own yet: it is not in the saved list. Pi
 * assigns its sessionFile on startup while other engines get one with the first
 * message, and the list only catches up once a run settles, so the draft row
 * stays until the saved row takes its place, never leaving a gap between them.
 * While a session change is under way, its destination decides instead.
 */
const openDaemonId = computed(() => pendingSession()?.daemonId ?? currentDaemonId());

const isDraftSession = computed(() => {
  const ds = openDaemon();
  if (isDaemonTaskSession(ds)) return false;
  const pending = pendingSession();
  if (pending) return !pending.file;
  const current = sessionState();
  if (!current) return false;
  return !current.sessionFile || !savedSessions().some((s) => s.path === current.sessionFile);
});

/** The session file the sidebar marks as open: where a change is heading, else the one on screen. */
const openFile = computed(() => {
  const pending = pendingSession();
  return pending ? pending.file : sessionState()?.sessionFile;
});

/** The active folder's list can be trusted: its agent is ready, or a session change knows where it lands. */
const listSteady = computed(() => sidecarPhase().name === "ready" || pendingSession() !== undefined);

/** True on a fresh single-folder install with nothing saved, archived, or written yet. */
const singleEmpty = computed(
  () =>
    projects().length === 1 &&
    !isChatFolder(activeProjectPath()) &&
    savedSessions().length === 0 &&
    (workspaceSessions()[chatFolder()]?.length ?? 0) === 0 &&
    notes().length === 0 &&
    archivedSessionItems().length === 0 &&
    !daemonSessions().some(
      (ds) => !(isDraftSession() && ds.id === openDaemonId()) && (Boolean(ds.parentId) || daemonRootEarnsRow(ds)),
    ) &&
    sessionsReady() &&
    listSteady(),
);

/** Whether 最近 surfaces the open unsaved draft session at its top. */
const hasRecentDraft = computed(() => Boolean(activeProjectPath()) && listSteady() && isDraftSession() && !singleEmpty());

/**
 * True when a draft slot closes because the draft session itself just entered
 * `savedSessions()` (rather than the user switching away): the saved `SessionRow`
 * takes its exact place in the same commit, so collapsing the draft slot would
 * briefly show the session twice.
 */
const draftGraduated = computed(() => {
  if (isDraftSession() || pendingSession()?.file) return false;
  const file = sessionState()?.sessionFile;
  return Boolean(file && savedSessions().some((s) => s.path === file));
});

/** Animates explicit sidebar list edits without ever touching layout animation during a run (`AGENTS.md`). */
function animateSidebarList() {
  // Animated or not (a run vetoes the motion but the rows still move), rows are
  // about to pass under the pointer: it is resting until it says otherwise.
  pointerResting.set(true);
  if (!isRunning()) animateNextLayout(220);
}

// ── Drag to reorder ─────────────────────────────────────────────────────────
//
// Three lists accept a drag: 工作区's project rows (list `"workspaces"`, row id
// = folder path), each folder's session rows (`"ws:<cwd>"`, id = session path),
// and 最近's root rows (`"recents"`, id = session path or `daemon:<id>`).
//
// A drag lifts the row under the pointer: it grows a little, throws a shadow and
// rises above the list while the rows it passes flow to the slots it would
// leave them in. Every row owns its slot offset as a native spring, retargeted
// from wherever it is, so a reorder mid-flow bends into the next slot instead of
// restarting; the lifted row follows the pointer with no spring at all (a
// transform set on each move). Release commits the order at once and rebases
// each row's offset by the slot the commit gives it, so the commit itself
// cannot jump; the springs then land on the new layout (see `finishDrag`).
//
// Two input paths run the same machinery: a mouse press that travels past
// `DRAG_ARM_DISTANCE`, or rests past `DRAG_HOLD_MS`, lifts the row (the
// sidebar's container sees moves over every row), and a touch drag is claimed
// sideways-first by the row's pan recognizer (`panActivation`), so a plain
// vertical swipe stays the scroll view's.

/** Payload carried when dragging a sidebar row horizontally into the workspace to split. */
type SplitDragInfo = { target: SplitTarget; title: string; agentId?: string };
/** Which list a draggable row belongs to and the id its order is kept under. */
type DragSpec = { list: string; id: string; split?: SplitDragInfo };

/** Points of travel before a held row becomes a drag. */
const DRAG_ARM_DISTANCE = 6;
/** How long a press stays still before it lifts the row (a mouse, or a touch that does not scroll). */
const DRAG_HOLD_MS = 150;
/** Sideways travel that lets a row claim a touch drag from the scroll view around it. */
const DRAG_CLAIM_X = 12;
/** How far past the sidebar's scroll viewport a drag may wander before it is called off. */
const DRAG_ESCAPE_MARGIN = 96;
/** How near the scroll viewport's edge a dragged row starts to scroll it, and how fast at the edge. */
const DRAG_EDGE = 40;
const DRAG_EDGE_SPEED = 200;
/** How far apart two dropped rows' ranks stand; interpolations halve the gap between drops. */
const RANK_STEP = 1000;

/**
 * The lift and the drop, and the flow of the other rows. Written as React
 * Native's physical spring (mass 1): `damping = ratio × 2√(stiffness)` — the
 * brief's `{ stiffness: 300, damping: 0.7 }`, `{ 280, 0.75 }`, `{ 350, 0.8 }`.
 */
const LIFT_SPRING = { stiffness: 300, damping: 24, mass: 1 } as const;
const FLOW_SPRING = { stiffness: 280, damping: 25, mass: 1 } as const;
const DROP_SPRING = { stiffness: 350, damping: 30, mass: 1 } as const;

/** A row's place in the dragged list, in the scroll content's coordinates (scroll offsets cancel). */
type DragFrame = { id: string; top: number; height: number };

/** The drag in flight and where its drop would land (`before` a row's id; `null` = past the last). */
const rowDrag = signal<DragSpec | null>(null);
const dropTarget = signal<{ list: string; before: string | null } | null>(null);
/** The rows measured when the drag lifted, and the slot offset each row takes for the current target. */
const dragFrames = signal<DragFrame[]>([]);
const dragShifts = signal<Record<string, number>>({});
/** Targets kept through a drop's settle: the offsets are rebased on the commit, these finish the springs. */
const settleState = signal<{ list: string; targets: Record<string, number> } | null>(null);
/** The content top the lifted row takes if released now (`null`: the order would not change). */
let dragDropTop: number | null = null;
/** The insertion the current drop line shows (`dragTargetSet` says there is one). */
let dragTargetSet = false;
let dragTargetBefore: string | null = null;
/** A drop's settle; a newer drag supersedes the callbacks of an older one. */
let settleGeneration = 0;

/** A left-button press on a draggable row, not yet moved far enough (or held long enough) to lift it. */
let mouseArm: { spec: DragSpec; x: number; y: number } | null = null;
let holdTimer: ReturnType<typeof setTimeout> | undefined;
/** The drag's input path: the pointer that lifted it, or the row's pan after a touch claimed it. */
let dragVia: "pointer" | "pan" = "pointer";
/** A finger is down on a row, so its press-up is a pan cancellation rather than a release. */
let touchHeld = false;
let dragStarting = false;
/** The pointer (page Y), where it lifted, and the scroll offset it lifted at. */
let lastPointerY = Number.NaN;
let dragStartPointerY = Number.NaN;
let dragStartScrollY = 0;
/** The scroll viewport (page coordinates) and the dragged list's box (content coordinates). */
let dragViewport: { top: number; bottom: number } | null = null;
let dragViewportTop = 0;
let dragViewportHeight = 0;
let dragListBounds: { top: number; bottom: number } | null = null;
/** The scroll's offset, and the furthest it needs to go for this list (content coordinates). */
let dragScrollY = 0;
let dragScrollMax = 0;

/** Each droppable list's rows (`list` → row `id` → ref), for hit-testing a drag's pointer. */
const dropRows = new Map<string, Map<string, ViewRef>>();
/** Each droppable list's container ref. */
const dropLists = new Map<string, ViewRef>();
/** The sidebar's one scroll view: the drag's edge scroll asks it. */
let sidebarScroll: ScrollRef | null = null;

/** One row's animated channels: its slot offset, the lifted row's follow, and its lift (grow, fade, plate). */
type RowAnim = {
  list: string;
  id: string;
  shift: AnimatedValue;
  dragY: AnimatedValue;
  lift: AnimatedValue;
  setLifted: (lifted: boolean) => void;
  shiftTarget: number;
  shiftRun: Promise<{ finished: boolean }>;
  liftTarget: number;
  liftRun: Promise<{ finished: boolean }>;
};

const rowAnims = new Map<string, RowAnim>();
const animKey = (list: string, id: string) => `${list}\n${id}`;

function springTo(value: AnimatedValue, to: number, spring: { stiffness: number; damping: number; mass: number }) {
  if (reduceMotion()) {
    value.set(to);
    return Promise.resolve({ finished: true });
  }
  return value.spring(to, spring);
}

function rowSpring(row: RowAnim, target: number) {
  if (row.shiftTarget === target) return row.shiftRun;
  row.shiftTarget = target;
  row.shiftRun = springTo(row.shift, target, FLOW_SPRING);
  return row.shiftRun;
}

function rowLift(row: RowAnim, target: number) {
  if (row.liftTarget === target) return row.liftRun;
  row.liftTarget = target;
  row.liftRun = springTo(row.lift, target, target ? LIFT_SPRING : DROP_SPRING);
  return row.liftRun;
}

/** Folds offsets a previous drop left (or a settle still finishing) into their values, at rest. */
function normalizeRow(row: RowAnim) {
  void row.shift.stop();
  void row.dragY.stop();
  row.shift.flattenOffset();
  row.dragY.flattenOffset();
  row.shiftTarget = 0;
  row.shiftRun = springTo(row.shift, 0, FLOW_SPRING);
}

function registerRowAnim(row: RowAnim) {
  rowAnims.set(animKey(row.list, row.id), row);
}

function unregisterRowAnim(list: string, id: string) {
  rowAnims.delete(animKey(list, id));
}

function registerDropRow(list: string, id: string, ref: ViewRef | null) {
  if (ref) {
    let rows = dropRows.get(list);
    if (!rows) dropRows.set(list, (rows = new Map()));
    rows.set(id, ref);
    return;
  }
  const rows = dropRows.get(list);
  if (rows) {
    rows.delete(id);
    if (!rows.size) dropRows.delete(list);
  }
}

function registerDropList(list: string, ref: ViewRef | null) {
  if (ref) dropLists.set(list, ref);
  else dropLists.delete(list);
}

/** A press went down on a draggable row; a still press lifts it after `DRAG_HOLD_MS`. */
function armMouseDrag(spec: DragSpec, y = Number.NaN, x = Number.NaN) {
  if (Number.isFinite(y)) lastPointerY = y;
  if (mouseArm && mouseArm.spec.list === spec.list && mouseArm.spec.id === spec.id) {
    if (!Number.isFinite(mouseArm.y) && Number.isFinite(y)) mouseArm.y = y;
    if (!Number.isFinite(mouseArm.x) && Number.isFinite(x)) mouseArm.x = x;
    return;
  }
  disarmMouseDrag();
  mouseArm = { spec, x, y };
  if (spec.list === "__split__") return;
  holdTimer = setTimeout(() => {
    holdTimer = undefined;
    const arm = mouseArm;
    if (!arm || rowDrag() || dragStarting) return;
    void beginDrag(arm.spec, "pointer");
  }, DRAG_HOLD_MS);
}

function disarmMouseDrag() {
  if (holdTimer !== undefined) clearTimeout(holdTimer);
  holdTimer = undefined;
  mouseArm = null;
}

/** Hands an active or armed sidebar row drag off to the workspace's split drop overlay. */
function handoffSidebarToSplit(split: SplitDragInfo, x: number, y: number) {
  disarmMouseDrag();
  if (rowDrag()) finishDrag(false);
  startSplitDrag(
    {
      source: "sidebar",
      target: split.target,
      title: split.title,
      agentId: split.agentId,
      x,
      y,
    },
    () => pointerResting.set(false),
  );
}

/** Called from `Shell`'s window-level mouse move so dragging a sidebar row into the workspace hands off cleanly. */
export function notifySidebarPointerMove(x: number, y: number, pressed: boolean) {
  if (splitDrag()) return;
  if (!pressed) {
    if (rowDrag() && dragVia === "pointer") finishDrag(true);
    else if (!rowDrag()) disarmMouseDrag();
    return;
  }
  const active = rowDrag();
  if (active && dragVia === "pointer") {
    if (active.split && isPointInWorkspace(x, y)) {
      handoffSidebarToSplit(active.split, x, y);
    }
    return;
  }
  const arm = mouseArm;
  if (arm?.spec.split && isPointInWorkspace(x, y)) {
    handoffSidebarToSplit(arm.spec.split, x, y);
  }
}

/** Called from `Shell`'s window-level mouse up so a sidebar drag released outside the sidebar never lingers. */
export function notifySidebarPointerUp() {
  if (splitDrag()) {
    disarmMouseDrag();
    return;
  }
  endMouseDrag();
}

/** Measures the list once and lifts the row; a release before the measure lands is dropped. */
async function beginDrag(spec: DragSpec, via: "pointer" | "pan") {
  if (rowDrag() || dragStarting) return;
  dragStarting = true;
  dragVia = via;
  const armY = mouseArm?.y ?? Number.NaN;
  disarmMouseDrag();
  settleGeneration++;
  settleState.set(null);
  for (const row of rowAnims.values()) if (row.list === spec.list) normalizeRow(row);
  dragShifts.set({});
  dragFrames.set([]);
  dragTargetSet = false;
  dragDropTop = null;
  dropTarget.set(null);
  rowDrag.set(spec);
  pointerResting.set(true);
  if (hapticsAvailable) Haptics.impact("medium");
  const rows = [...(dropRows.get(spec.list) ?? [])];
  const [listBox, viewBox, ...measured] = await Promise.all([
    dropLists.get(spec.list)?.measure().catch(() => null),
    sidebarScroll?.measure().catch(() => null),
    ...rows.map(async ([id, ref]) => {
      const m = await ref.measure().catch(() => null);
      return m ? { id, pageTop: m.pagePosition.y, height: m.bounds.size.height } : null;
    }),
  ]);
  dragStarting = false;
  const d = rowDrag();
  if (d?.list !== spec.list || d.id !== spec.id) return;
  dragViewportTop = viewBox ? viewBox.pagePosition.y : 0;
  dragViewportHeight = viewBox ? viewBox.bounds.size.height : 0;
  dragViewport = viewBox ? { top: viewBox.pagePosition.y, bottom: viewBox.pagePosition.y + viewBox.bounds.size.height } : null;
  dragStartScrollY = dragScrollY;
  const frame = measured.find((m): m is { id: string; pageTop: number; height: number } => m !== null && m.id === spec.id);
  const frames = measured
    .filter((m): m is { id: string; pageTop: number; height: number } => m !== null)
    .map((m) => ({ id: m.id, top: m.pageTop - dragViewportTop + dragStartScrollY, height: m.height }))
    .sort((a, b) => a.top - b.top);
  if (!frame || !frames.some((f) => f.id === spec.id)) {
    finishDrag(false);
    return;
  }
  dragFrames.set(frames);
  dragListBounds = listBox
    ? {
        top: listBox.pagePosition.y - dragViewportTop + dragStartScrollY,
        bottom: listBox.pagePosition.y + listBox.bounds.size.height - dragViewportTop + dragStartScrollY,
      }
    : null;
  // Edge scrolling stops once the list's last row reaches the bottom: there is
  // nothing more of this list to reveal past it.
  const last = frames[frames.length - 1];
  dragScrollMax = Math.max(0, last.top + last.height + 24 - dragViewportHeight);
  dragStartPointerY = Number.isFinite(lastPointerY)
    ? lastPointerY
    : Number.isFinite(armY)
      ? armY
      : frame.pageTop + frame.height / 2;
  syncDragPosition();
  updateDragTarget(dragStartPointerY);
  startEdgeScroll();
}

/** The lifted row follows the pointer: its own move plus the content scrolled under it. */
function syncDragPosition() {
  const d = rowDrag();
  if (!d || !Number.isFinite(lastPointerY) || !Number.isFinite(dragStartPointerY)) return;
  const row = rowAnims.get(animKey(d.list, d.id));
  if (!row) return;
  row.dragY.set(lastPointerY - dragStartPointerY + (dragScrollY - dragStartScrollY));
}

/** Where `pageY` would drop the row: the midpoint of each measured row cuts it in two. */
function updateDragTarget(pageY: number) {
  const d = rowDrag();
  const frames = dragFrames();
  if (!d || !frames.length || !Number.isFinite(pageY)) return;
  const contentY = pageY - dragViewportTop + dragScrollY;
  if (
    dragListBounds &&
    (contentY < dragListBounds.top - DRAG_ARM_DISTANCE || contentY > dragListBounds.bottom + DRAG_ARM_DISTANCE)
  )
    return;
  const others = frames.filter((f) => f.id !== d.id);
  let insertion = others.length;
  for (let i = 0; i < others.length; i++) {
    if (contentY < others[i].top + others[i].height / 2) {
      insertion = i;
      break;
    }
  }
  const before = others[insertion]?.id ?? null;
  if (dragTargetSet && dragTargetBefore === before) return;
  const order = others.map((f) => f.id);
  order.splice(insertion, 0, d.id);
  const current = frames.map((f) => f.id);
  if (order.every((id, i) => id === current[i])) {
    dragTargetSet = false;
    dragTargetBefore = null;
    dragDropTop = null;
    dragShifts.set({});
    dropTarget.set(null);
    return;
  }
  // Lay the new order on the slots the list has now: each slot keeps the gap
  // that follows it in the real layout, so rows of different heights land
  // without overlapping (a project section's `pt-1` belongs to its position).
  const heightOf = new Map(frames.map((f) => [f.id, f.height]));
  const tops = new Map<string, number>();
  let top = frames[0].top;
  for (let p = 0; p < order.length; p++) {
    const id = order[p];
    tops.set(id, top);
    const gap = frames[p + 1] ? Math.max(0, frames[p + 1].top - (frames[p].top + frames[p].height)) : 0;
    top += (heightOf.get(id) ?? frames[p].height) + gap;
  }
  dragTargetSet = true;
  dragTargetBefore = before;
  dragDropTop = tops.get(d.id) ?? null;
  const shifts: Record<string, number> = {};
  for (const f of others) shifts[f.id] = (tops.get(f.id) ?? f.top) - f.top;
  dragShifts.set(shifts);
  dropTarget.set({ list: d.list, before });
}

/**
 * Ends the drag: a committed drop applies the order the drop line last showed.
 * Every row is rebased by the slot the commit gives it before the order lands,
 * so the natural layout jumps under offsets that cancel it; the springs finish
 * toward the targets the drag had them at, then fold the offsets away in place.
 */
function finishDrag(commit: boolean) {
  const d = untracked(rowDrag);
  const target = untracked(dropTarget);
  const frames = untracked(dragFrames);
  const shifts = untracked(dragShifts);
  const targetTop = dragDropTop;
  stopEdgeScroll();
  if (!d) {
    batch(() => {
      settleState.set(null);
      dragFrames.set([]);
      dragShifts.set({});
      dragTargetSet = false;
      dragDropTop = null;
      dropTarget.set(null);
    });
    disarmMouseDrag();
    return;
  }
  const gen = ++settleGeneration;
  let ids: string[] | null = null;
  let delta = 0;
  const dragged = rowAnims.get(animKey(d.list, d.id));
  const draggedFrame = frames.find((f) => f.id === d.id);
  if (commit && target?.list === d.list && targetTop !== null && dragged && draggedFrame) {
    const others = frames.filter((f) => f.id !== d.id).map((f) => f.id);
    const at = target.before === null ? others.length : others.indexOf(target.before);
    if (at >= 0) {
      ids = [...others];
      ids.splice(at, 0, d.id);
      delta = targetTop - draggedFrame.top;
      const current = orderedIds(d.list);
      if (ids.length === current.length && ids.every((id, i) => id === current[i])) ids = null;
    }
  }
  if (ids && dragged) {
    for (const f of frames) {
      const row = rowAnims.get(animKey(d.list, f.id));
      if (!row) continue;
      if (f.id === d.id) row.dragY.setOffset(-delta);
      else row.shift.setOffset(-(shifts[f.id] ?? 0));
    }
    const settle = { list: d.list, targets: { ...shifts } };
    batch(() => {
      settleState.set(settle);
      dragFrames.set([]);
      dragShifts.set({});
      dragTargetSet = false;
      dragTargetBefore = null;
      dragDropTop = null;
      dropTarget.set(null);
      writeOrder(d.list, d.id, ids!);
      rowDrag.set(null);
    });
    finishLift(dragged, delta, gen);
    const jobs: Promise<unknown>[] = [];
    for (const f of frames) {
      if (f.id === d.id) continue;
      const row = rowAnims.get(animKey(d.list, f.id));
      if (!row) continue;
      jobs.push(
        rowSpring(row, shifts[f.id] ?? 0).then(() => {
          if (gen !== settleGeneration) return;
          row.shift.flattenOffset();
          row.shiftTarget = 0;
        }),
      );
    }
    void Promise.all(jobs).then(() => {
      if (gen !== settleGeneration) return;
      settleState.set(null);
    });
    return;
  }
  // A cancelled drag, or a drop that changes nothing: every row flows home.
  const homeTargets: Record<string, number> = {};
  for (const f of frames) if (f.id !== d.id) homeTargets[f.id] = 0;
  batch(() => {
    settleState.set(frames.some((f) => f.id !== d.id) ? { list: d.list, targets: homeTargets } : null);
    dragFrames.set([]);
    dragShifts.set({});
    dragTargetSet = false;
    dragTargetBefore = null;
    dragDropTop = null;
    dropTarget.set(null);
    rowDrag.set(null);
  });
  if (dragged) finishLift(dragged, 0, gen);
  const homeJobs: Promise<unknown>[] = [];
  for (const f of frames) {
    if (f.id === d.id) continue;
    const row = rowAnims.get(animKey(d.list, f.id));
    if (!row) continue;
    homeJobs.push(
      rowSpring(row, 0).then(() => {
        if (gen !== settleGeneration) return;
        row.shift.flattenOffset();
        row.shiftTarget = 0;
      }),
    );
  }
  if (homeJobs.length) {
    void Promise.all(homeJobs).then(() => {
      if (gen !== settleGeneration) return;
      settleState.set(null);
    });
  }
}

/** Lands the lifted row: the drop's spring and the lift's fade, then its offsets fold away in place. */
function finishLift(row: RowAnim, delta: number, gen: number) {
  const liftDone = rowLift(row, 0);
  if (reduceMotion()) {
    row.dragY.setOffset(0);
    row.dragY.set(0);
    void liftDone.then(() => {
      if (gen === settleGeneration) row.setLifted(false);
    });
    return;
  }
  void Promise.all([row.dragY.spring(delta, DROP_SPRING), liftDone]).then(() => {
    if (gen !== settleGeneration) return;
    row.dragY.flattenOffset();
    row.setLifted(false);
  });
}

/** A mouse release anywhere in the sidebar ends a pointer drag (or disarms one that never lifted). */
function endMouseDrag() {
  // A touch's press-up is the pan telling the row it took the gesture, not the finger letting go.
  if (touchHeld) return;
  if (rowDrag() && dragVia === "pointer") finishDrag(true);
  else if (!rowDrag()) disarmMouseDrag();
}

/** A mouse move over the sidebar tree: arms a held row past the threshold, then tracks the drop. */
function sidebarDragMove(e: MouseEvent) {
  lastPointerY = e.pagePosition.y;
  if (splitDrag()) return;
  if (e.pressedButton === "left") {
    const arm = mouseArm;
    if (!rowDrag() && arm) {
      if (arm.spec.split && isPointInWorkspace(e.pagePosition.x, e.pagePosition.y)) {
        handoffSidebarToSplit(arm.spec.split, e.pagePosition.x, e.pagePosition.y);
        return;
      }
      if (arm.spec.list !== "__split__") {
        if (!Number.isFinite(arm.y)) arm.y = e.pagePosition.y;
        else if (Math.abs(e.pagePosition.y - arm.y) > DRAG_ARM_DISTANCE) void beginDrag(arm.spec, "pointer");
      }
    }
    if (rowDrag() && dragVia === "pointer") {
      if (rowDrag()?.split && isPointInWorkspace(e.pagePosition.x, e.pagePosition.y)) {
        handoffSidebarToSplit(rowDrag()!.split!, e.pagePosition.x, e.pagePosition.y);
        return;
      }
      if (
        dragViewport &&
        (lastPointerY < dragViewport.top - DRAG_ESCAPE_MARGIN || lastPointerY > dragViewport.bottom + DRAG_ESCAPE_MARGIN)
      ) {
        finishDrag(false);
        return;
      }
      syncDragPosition();
      updateDragTarget(lastPointerY);
      startEdgeScroll();
    }
  } else if (e.pressedButton === null) {
    // The button let go where no release was heard (a drag released off window).
    if (rowDrag() && dragVia === "pointer") finishDrag(true);
    else if (!rowDrag()) disarmMouseDrag();
  }
}

/** The row ids of `list` in display order — what a drop writes back. */
function orderedIds(list: string): string[] {
  if (list === "workspaces") return [...projects()];
  if (list === "recents") {
    return recents()
      .filter((item) => !item.id.startsWith("recent-child:"))
      .map(recentKey);
  }
  if (list === "docs") return shownDocs().map((note) => note.path);
  const cwd = list.slice(3);
  return sortedFolderSessions(cwd).map((s) => s.path);
}

/** The folder's sessions in drop order: a drag rank stands where the row was
 * left (a session without one keeps its last-modified place). */
function sortedFolderSessions(cwd: string): SessionSummary[] {
  const ranks = sessionRankOverrides(cwd);
  return sessionsOf(cwd)
    .filter((session) => !daemonSessionByFile(session.path)?.parentId)
    .sort(
      (a, b) =>
        (ranks[b.path] ?? b.modified) - (ranks[a.path] ?? a.modified) || b.modified - a.modified || a.path.localeCompare(b.path),
    );
}

/** The standing `id` sorts by in `list` right now: its drag rank when it has one, else the natural. */
function standingOfId(list: string, id: string): number {
  if (list === "recents") return recentRankOverrides()[id] ?? recentStanding.get(id) ?? 0;
  if (list === "docs") return docRankOverrides()[id] ?? docStanding.get(id) ?? 0;
  const cwd = list.slice(3);
  const ranks = sessionRankOverrides(cwd);
  return ranks[id] ?? sessionsOf(cwd).find((s) => s.path === id)?.modified ?? 0;
}

/** Where a dropped row lands between its new neighbors; `moved`'s rank is the only write unless stands collide. */
function nextRanks(ordered: string[], moved: string, list: string, ranks: Record<string, number>): Record<string, number> {
  const i = ordered.indexOf(moved);
  if (i < 0) return ranks;
  const stand = (id: string) => ranks[id] ?? standingOfId(list, id);
  const above = i > 0 ? stand(ordered[i - 1]) : undefined;
  const below = i < ordered.length - 1 ? stand(ordered[i + 1]) : undefined;
  let rank: number | null = null;
  if (above === undefined) rank = (below ?? Date.now()) + RANK_STEP;
  else if (below === undefined) rank = above - RANK_STEP;
  else {
    const mid = (above + below) / 2;
    if (mid < above && mid > below) rank = mid;
  }
  if (rank !== null) return { ...ranks, [moved]: rank };
  // Two neighbors share a stand: rewrite the shown order's ranks evenly from its top.
  const top = Math.max(Date.now(), ...ordered.map(stand)) + RANK_STEP;
  const next = { ...ranks };
  ordered.forEach((id, j) => {
    next[id] = top - j * RANK_STEP;
  });
  return next;
}

function writeOrder(list: string, moved: string, ordered: string[]) {
  if (list === "workspaces") {
    reorderWorkspaces(ordered);
  } else if (list === "recents") {
    setRecentRankOverrides(nextRanks(ordered, moved, list, recentRankOverrides()));
  } else if (list === "docs") {
    // The fold's hidden documents stand below the shown ones: a drop at the bottom lands above them.
    const hidden = allDocs()
      .map((note) => note.path)
      .filter((path) => !ordered.includes(path));
    setDocRankOverrides(nextRanks([...ordered, ...hidden], moved, list, docRankOverrides()));
  } else {
    const cwd = list.slice(3);
    setSessionRankOverrides(cwd, nextRanks(ordered, moved, list, sessionRankOverrides(cwd)));
  }
}

/** One edge-scroll frame; stops when the pointer leaves the edges or the list has no more to show. */
let edgeFrame: number | undefined;
let edgeAt = 0;

function stopEdgeScroll() {
  cancelAnimationFrame(edgeFrame);
  edgeFrame = undefined;
  edgeAt = 0;
}

function startEdgeScroll() {
  if (edgeFrame !== undefined || !rowDrag()) return;
  edgeAt = 0;
  edgeFrame = requestAnimationFrame(edgeTick);
}

function edgeTick() {
  edgeFrame = undefined;
  if (!rowDrag() || !dragViewport || !Number.isFinite(lastPointerY) || dragViewportHeight <= 0) return;
  const fromTop = lastPointerY - dragViewport.top;
  const fromBottom = dragViewport.bottom - lastPointerY;
  const closeness = (distance: number) => Math.min(1, Math.max(0, (DRAG_EDGE - distance) / DRAG_EDGE));
  let speed = 0;
  if (fromTop < DRAG_EDGE) speed = -DRAG_EDGE_SPEED * closeness(Math.max(0, fromTop));
  else if (fromBottom < DRAG_EDGE) speed = DRAG_EDGE_SPEED * closeness(Math.max(0, fromBottom));
  if (!speed) {
    edgeAt = 0;
    return;
  }
  const now = Date.now();
  const dt = edgeAt ? Math.min(64, now - edgeAt) : 16;
  edgeAt = now;
  const max = Math.max(dragScrollY, dragScrollMax);
  const next = Math.min(max, Math.max(0, dragScrollY + (speed * dt) / 1000));
  if (Math.abs(next - dragScrollY) < 0.25) return;
  dragScrollY = next;
  sidebarScroll?.scrollTo({ y: next, animated: false });
  syncDragPosition();
  updateDragTarget(lastPointerY);
  edgeFrame = requestAnimationFrame(edgeTick);
}

/**
 * A sidebar row the user can drag into a new place: a `View` wrapper that
 * registers its box for hit-testing, arms a mouse drag on press (touch drags
 * are claimed sideways-first by `panActivation`, so vertical swipes stay the
 * scroll view's), follows the pointer once lifted, and draws the drop line
 * where it would land. `list`/`id` match `orderedIds`' view of the row.
 */
function DropRow(props: {
  list: string;
  id: string;
  split?: () => SplitDragInfo;
  onContextMenu?: (e: ContextMenuEvent) => void;
  children?: JSX.Element;
}) {
  const spec = (): DragSpec => ({ list: props.list, id: props.id, ...(props.split ? { split: props.split() } : {}) });
  const dragging = () => rowDrag()?.list === props.list && rowDrag()?.id === props.id;
  const lineAbove = () => dropTarget()?.list === props.list && dropTarget()?.before === props.id;
  const lineBelow = () => {
    const t = dropTarget();
    if (t?.list !== props.list || t.before !== null) return false;
    const ids = orderedIds(props.list).filter((id) => id !== rowDrag()?.id);
    return ids[ids.length - 1] === props.id;
  };
  const shift = createAnimatedValue(0);
  const dragY = createAnimatedValue(0);
  const lift = createAnimatedValue(0);
  const lifted = signal(false);
  const row: RowAnim = {
    list: props.list,
    id: props.id,
    shift,
    dragY,
    lift,
    setLifted: (on) => lifted.set(on),
    shiftTarget: 0,
    shiftRun: Promise.resolve({ finished: true }),
    liftTarget: 0,
    liftRun: Promise.resolve({ finished: true }),
  };
  registerRowAnim(row);
  cleanup(() => {
    unregisterRowAnim(props.list, props.id);
    void shift.stop();
    void dragY.stop();
    void lift.stop();
  });
  const liftScale = lift.interpolate({ inputRange: [0, 1], outputRange: [1, 1.03] });
  const liftOpacity = lift.interpolate({ inputRange: [0, 1], outputRange: [1, 0.95] });
  /** Whether this row has anything moving: the drag's list, a drop settling, or its own flight home. */
  const live = () => rowDrag()?.list === props.list || settleState()?.list === props.list || lifted();
  const liveStyle = () => {
    if (!live()) return undefined;
    return {
      zIndex: lifted() ? 30 : undefined,
      transform: [{ translateY: shift }, { translateY: dragY }, { scale: liftScale }],
      opacity: liftOpacity,
    };
  };
  const targetShift = () => {
    const settle = settleState();
    if (settle?.list === props.list) {
      const at = settle.targets[props.id];
      if (at !== undefined) return at;
    }
    return dragShifts()[props.id] ?? 0;
  };
  effect(() => {
    const target = targetShift();
    untracked(() => void rowSpring(row, target));
  });
  effect(() => {
    const on = dragging();
    untracked(() => {
      if (on) {
        lifted.set(true);
        void rowLift(row, 1);
      } else if (lifted()) {
        void rowLift(row, 0);
      }
    });
  });
  // The row follows the finger once its pan claims the gesture (sideways first:
  // `panActivation` keeps a vertical swipe the scroll view's), then lands where
  // the drop puts it.
  const panX = createAnimatedValue(0);
  const panY = createAnimatedValue(0);
  let panActive = false;
  return (
    <View
      ref={(ref) => registerDropRow(props.list, props.id, ref)}
      class={hoverGroup()}
      style={liveStyle()}
      onContextMenu={props.onContextMenu}
      onPressDown={(e) => armMouseDrag(spec(), e.pagePosition.y, e.pagePosition.x)}
      onPressUp={endMouseDrag}
      pan={{ x: panX, y: panY }}
      panActivation={{ activeOffsetX: DRAG_CLAIM_X, failOffsetY: DRAG_CLAIM_X }}
      onPanStart={() => {
        panActive = true;
        if (splitDrag()) return;
        if (rowDrag()?.list === props.list && rowDrag()?.id === props.id) dragVia = "pan";
        else void beginDrag(spec(), "pan");
        startEdgeScroll();
      }}
      onPanEnd={(e) => {
        panActive = false;
        panX.set(0);
        panY.set(0);
        if (splitDrag()) {
          endSplitDrag(!e.cancelled);
          return;
        }
        if (rowDrag()?.list === props.list && rowDrag()?.id === props.id) finishDrag(!e.cancelled);
      }}
      onTouchStart={(e: GestureResponderEvent) => {
        touchHeld = true;
        lastPointerY = e.pageY;
      }}
      onTouchMove={(e: GestureResponderEvent) => {
        lastPointerY = e.pageY;
        if (splitDrag()) {
          moveSplitDrag(e.pageX, e.pageY);
          return;
        }
        const splitInfo = props.split?.();
        if (splitInfo && isPointInWorkspace(e.pageX, e.pageY)) {
          handoffSidebarToSplit(splitInfo, e.pageX, e.pageY);
          return;
        }
        const d = rowDrag();
        if (!d || d.list !== props.list || d.id !== props.id) return;
        if (panActive) dragVia = "pan";
        syncDragPosition();
        updateDragTarget(e.pageY);
        startEdgeScroll();
      }}
      onTouchEnd={() => {
        touchHeld = false;
        if (splitDrag()) {
          endSplitDrag(true);
          return;
        }
        if (!panActive && rowDrag()?.list === props.list && rowDrag()?.id === props.id) finishDrag(true);
        else if (!rowDrag()) disarmMouseDrag();
      }}
      onTouchCancel={() => {
        touchHeld = false;
        if (splitDrag()) {
          endSplitDrag(false);
          return;
        }
        if (!panActive && rowDrag()?.list === props.list && rowDrag()?.id === props.id) finishDrag(false);
        else if (!rowDrag()) disarmMouseDrag();
      }}
    >
      {/* The lifted row's own surface: its shadow rides in with the lift, under the row. */}
      <If when={live()}>
        <View
          testID={dragging() ? "sidebar-drag-lift" : undefined}
          class="pointer-events-none absolute inset-0 rounded-md corner-squircle bg-sidebar-accent shadow-raised"
          style={{ opacity: lift }}
        />
      </If>
      {props.children}
      <If when={lineAbove()}>
        <View testID="sidebar-drop-line" class="pointer-events-none absolute -top-px left-2 right-2 h-0.5 rounded-full bg-brand" />
      </If>
      <If when={lineBelow()}>
        <View testID="sidebar-drop-line" class="pointer-events-none absolute -bottom-px left-2 right-2 h-0.5 rounded-full bg-brand" />
      </If>
    </View>
  );
}

/**
 * Where each session stands in 最近: its last activity as of the first time
 * the list showed it, by session file. A row is found where it was left, so a
 * session that goes on working keeps its place instead of leaping to the top
 * with every message; a session that is new to the list lands by its own time
 * — a fresh one on top, a reopened folder's among the rest. The order is taken
 * anew, by last activity, when the app next starts.
 */
const recentStanding = new Map<string, number>();
const standingOf = (session: SessionSummary) => {
  const known = recentStanding.get(session.path);
  if (known !== undefined) return known;
  recentStanding.set(session.path, session.modified);
  return session.modified;
};
/** A daemon session's standing, keyed by id: first sight of its row, like `standingOf` for files. */
const daemonStandingOf = (session: DaemonSession) => {
  const key = `daemon:${session.id}`;
  const known = recentStanding.get(key);
  if (known !== undefined) return known;
  recentStanding.set(key, session.lastActive);
  return session.lastActive;
};
/** The sessions a project folder lists, active folder or parked one. */
const EMPTY_SESSIONS: SessionSummary[] = [];
const sessionsOf = (cwd: string) => {
  const byCwd = workspaceSessions();
  if (cwd in byCwd) return byCwd[cwd];
  return cwd === activeProjectPath() ? savedSessions() : EMPTY_SESSIONS;
};
/** What a root row of 最近 is ranked and dragged by: a session's file, or a daemon tree's id. */
const recentKey = (item: RecentItem) => item.session?.path ?? `daemon:${item.child!.id}`;
const standOf = (item: RecentItem) =>
  recentRankOverrides()[recentKey(item)] ??
  (item.session ? standingOf(item.session) : daemonStandingOf(item.child!));
const createdOf = (item: RecentItem) => item.session?.created ?? item.child?.createdAt ?? 0;

let prevRecentsById = new Map<string, RecentItem>();
function reuseRecentItem(id: string, session?: SessionSummary, child?: DaemonSession, cwd?: string): RecentItem {
  const prev = prevRecentsById.get(id);
  if (prev && prev.session === session && prev.child === child && prev.cwd === cwd) return prev;
  return { id, ...(session ? { session } : {}), ...(child ? { child } : {}), ...(cwd !== undefined ? { cwd } : {}) };
}

/**
 * What was worked on lately — sessions across every open folder in one list:
 * the forest's roots in the place each first took (`recentStanding`), every
 * root's daemon descendants nested under it in tree order — the tree a session
 * started shows here as it does in 工作区.
 * Roots are saved sessions and the daemon trees no saved row claims (external or
 * detached runs, starts still without a file); a child whose own tree hides keeps
 * a flat row rather than going missing.
 */
const allRecents = computed<RecentItem[]>(
  () => {
    const folders = recentFolders();
    const open = new Set(folders);
    const seen = new Set<string>();
    const summaries: { session: SessionSummary; cwd: string }[] = [];
    for (const cwd of folders) {
      const list = sessionsOf(cwd);
      for (const session of list) {
        if (seen.has(session.path)) continue;
        seen.add(session.path);
        summaries.push({ session, cwd });
      }
    }
    const listed = new Set(summaries.map((entry) => entry.session.path));

    // Daemon trees no saved row claims: each is led by its unclaimed top, and earns
    // the row when it or anything under it has something to say — or holds a file
    // the list would otherwise drop. The open draft leads no row: the draft's does.
    const tops = new Map<string, DaemonSession>();
    for (const ds of daemonSessions()) {
      if (ds.file && listed.has(ds.file)) continue;
      // Archived from its tree: it is in 已归档, and leads no row here.
      if (isSessionArchived(ds.file)) continue;
      const { claimed, top } = daemonTreePlace(ds, listed);
      if (claimed || top.id !== ds.id) continue;
      if (!open.has(projectCwdOf(ds.cwd, ds))) continue;
      const earns =
        daemonRootEarnsRow(ds) ||
        childSessionsOfDaemon(ds.id).some((d) => daemonRootEarnsRow(d) || (d.file !== undefined && listed.has(d.file)));
      if (!earns) continue;
      if (isDraftSession() && ds.id === openDaemonId()) continue;
      tops.set(ds.id, ds);
    }

    const roots: RecentItem[] = [];
    const draftChildren = hasRecentDraft() ? new Set(childSessionsOfOpen().map((c) => c.id)) : new Set<string>();
    for (const { session, cwd } of summaries) {
      const ds = daemonSessionByFile(session.path);
      if (ds?.parentId) {
        const { claimed, top } = daemonTreePlace(ds, listed);
        // A daemon child belongs under its tree's row, not in the flat list — unless nothing above it takes a row here.
        if (claimed || tops.has(top.id) || draftChildren.has(ds.id)) continue;
      }
      roots.push(reuseRecentItem(`recent:${session.path}`, session, undefined, cwd));
    }
    for (const ds of tops.values()) roots.push(reuseRecentItem(`recent-daemon:${ds.id}`, undefined, ds, undefined));
    roots.sort((a, b) => standOf(b) - standOf(a) || createdOf(b) - createdOf(a) || a.id.localeCompare(b.id));

    const out: RecentItem[] = [];
    for (const root of roots) {
      out.push(root);
      const children = root.session ? childSessionsOf(root.session.path) : childSessionsOfDaemon(root.child!.id);
      for (const child of children) out.push(reuseRecentItem(`recent-child:${child.id}`, undefined, child, undefined));
    }
    const nextById = new Map<string, RecentItem>();
    for (const item of out) nextById.set(item.id, item);
    prevRecentsById = nextById;
    return out;
  },
  { equals: sameItems },
);

/** What 最近 shows: its newest slice until the footer expands it, then everything. */
const recentsExpanded = signal(false);
const recents = computed<RecentItem[]>(() => (recentsExpanded() ? allRecents() : allRecents().slice(0, RECENT_LIMIT)), {
  equals: sameItems,
});

/**
 * Where each document stands in 文档: its last write as of the first time the
 * list showed it, as `recentStanding` keeps 最近's sessions. A document being
 * written, by the person or an agent, keeps its place instead of leaping to the
 * top with every save; a new one lands on top, by its own time; a drag's rank
 * stands over both. The order is taken anew, by last write, when the app next
 * starts.
 */
const docStanding = new Map<string, number>();
const docStandOf = (note: NoteSummary) => {
  const ranked = docRankOverrides()[note.path];
  if (ranked !== undefined) return ranked;
  const known = docStanding.get(note.path);
  if (known !== undefined) return known;
  docStanding.set(note.path, note.modified);
  return note.modified;
};
const allDocs = computed<NoteSummary[]>(
  () => {
    const listed = notes();
    // A path gone from the list stands anew when a note takes it again (`newDocPath` reuses a deleted note's name).
    const paths = new Set(listed.map((note) => note.path));
    for (const path of docStanding.keys()) if (!paths.has(path)) docStanding.delete(path);
    return [...listed].sort((a, b) => docStandOf(b) - docStandOf(a) || a.path.localeCompare(b.path));
  },
  { equals: sameItems },
);
/** What 文档 shows: its first slice until the footer expands it, then everything. */
const docsExpanded = signal(false);
const shownDocs = computed<NoteSummary[]>(() => (docsExpanded() ? allDocs() : allDocs().slice(0, DOCS_LIMIT)), {
  equals: sameItems,
});

/** Daemon sessions with a row in 最近 right now: nested under its roots, or under the draft's row. */
const recentDaemonRows = computed(
  () => {
    const ids = new Set<string>();
    for (const item of recents()) if (item.child) ids.add(item.child.id);
    if (hasRecentDraft()) for (const child of childSessionsOfOpen()) ids.add(child.id);
    return ids;
  },
  { equals: sameStringSet },
);

const recentSessionPaths = computed(
  () => {
    const paths = new Set<string>();
    for (const item of recents()) {
      if (item.session?.path) paths.add(item.session.path);
      if (item.child?.file) paths.add(item.child.file);
    }
    return paths;
  },
  { equals: sameStringSet },
);

/** Whether a daemon session's mark is already on show in 最近 (a folded folder needn't repeat it). */
const daemonShownInRecents = (ds: DaemonSession) => !isGroupCollapsed("recents") && recentDaemonRows().has(ds.id);

/**
 * Which group highlights the open session when both 工作区 and 最近 list it:
 * the group the user clicked it in, falling back to whichever group is
 * currently unfolded. The choice is remembered per session, so clicking a row
 * in 最近 does not move the current session's highlight before the clicked one
 * opens. Only the highlight is owned — a working session marks every row it has.
 */
function ownsActiveSession(group: GroupId, sessionPath: string, cwd: string): boolean {
  if (isSessionArchived(sessionPath)) return group === "archived";
  const inWorkspaces = !isGroupCollapsed("workspaces") && !isWorkspaceCollapsed(cwd);
  const inRecents = !isGroupCollapsed("recents") && recentSessionPaths().has(sessionPath);
  const owner: GroupId =
    chosenGroups()[sessionPath] === "recents" && inRecents ? "recents" : inWorkspaces ? "workspaces" : inRecents ? "recents" : "workspaces";
  return group === owner;
}

/** Whether a daemon session's row is nested somewhere under 工作区 right now. */
function daemonRowInWorkspaces(ds: DaemonSession): boolean {
  if (isGroupCollapsed("workspaces")) return false;
  const folders = recentFolders();
  const files = new Set<string>();
  for (const cwd of folders) {
    if (isWorkspaceCollapsed(cwd)) continue;
    for (const s of sessionsOf(cwd)) files.add(s.path);
  }
  const { claimed, top } = daemonTreePlace(ds, files);
  if (claimed) return true;
  if (top.id === openDaemonId() && isDraftSession()) return true;
  return (
    daemonRootEarnsRow(top) &&
    (!top.file || !files.has(top.file)) &&
    !isSessionArchived(top.file) &&
    folders.some((cwd) => !isWorkspaceCollapsed(cwd) && projectCwdOf(top.cwd, top) === cwd)
  );
}

/** Which group highlights the open daemon session's row — the one it was clicked in, else whichever shows it. */
function ownsDaemonRow(group: GroupId, ds: DaemonSession): boolean {
  const inWorkspaces = daemonRowInWorkspaces(ds);
  const inRecents = daemonShownInRecents(ds);
  const owner: GroupId =
    chosenGroups()[`daemon:${ds.id}`] === "recents" && inRecents ? "recents" : inWorkspaces ? "workspaces" : inRecents ? "recents" : "workspaces";
  return group === owner;
}

/** Which group highlights the open draft session when both 工作区 and 最近 list it (the mark follows `active`, not the owner). */
function ownsDraftSession(group: GroupId, cwd: string): boolean {
  const inWorkspaces = !isGroupCollapsed("workspaces") && !isWorkspaceCollapsed(cwd);
  const inRecents = !isGroupCollapsed("recents") && hasRecentDraft();
  const owner: GroupId =
    draftGroup() === "recents" && inRecents ? "recents" : inWorkspaces ? "workspaces" : inRecents ? "recents" : "workspaces";
  return group === owner;
}

/**
 * The engine a saved session ran on: its mark and the name the picker shows.
 * A session whose engine is gone (a custom agent deleted, a CLI uninstalled)
 * still names itself, so the row never lies about where the transcript came from.
 */
function engineOf(id: string | undefined) {
  const key = id ?? "pi";
  const agent = availableAgents().find((a) => a.id === key);
  const name = agent?.name ?? (key === "pi" ? "Pi" : key);
  const available = agent ? agent.available && agent.enabled !== false : key === "pi";
  return { id: key, name, available };
}

async function confirmDelete(session: SessionSummary, cwd: string) {
  const name = titleOf(session);
  const { action } = await AlertDialog.show({
    title: tr("Delete this session?", "删除此会话？"),
    description: tr(`“${name}” will be removed from this Mac. This cannot be undone.`, `“${name}”将从此设备移除，该操作无法撤销。`),
    actions: [
      { label: tr("Cancel", "取消"), role: "cancel", id: "cancel" },
      { label: tr("Delete", "删除"), role: "destructive", id: "delete" },
    ],
  });
  if (action === "delete") {
    animateSidebarList();
    await removeSession(session.path, cwd);
  }
}

async function confirmDeleteDaemon(session: DaemonSession) {
  const name = daemonSessionTitle(session);
  const { action } = await AlertDialog.show({
    title: tr("Delete this session?", "删除此会话？"),
    description: tr(`“${name}” will be removed from this Mac. This cannot be undone.`, `“${name}”将从此设备移除，该操作无法撤销。`),
    actions: [
      { label: tr("Cancel", "取消"), role: "cancel", id: "cancel" },
      { label: tr("Delete", "删除"), role: "destructive", id: "delete" },
    ],
  });
  if (action === "delete") {
    animateSidebarList();
    await removeDaemonSession(session.id);
  }
}

async function renameFrom(session: SessionSummary, cwd: string) {
  await openSessionTab(session.path, cwd);
  startRenaming();
}

/** Disambiguates duplicate folder basenames with their parent folder name (`parent/name`). */
function projectLabel(cwd: string, all: readonly string[]): { name: string; parent?: string } {
  const name = basename(cwd) || tr("Folder", "文件夹");
  const clashes = all.filter((other) => other !== cwd && basename(other) === name);
  if (!clashes.length) return { name };
  const trimmed = cwd.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  const parent = slash > 0 ? basename(trimmed.slice(0, slash)) : "";
  return parent ? { name, parent } : { name };
}

/** What every session row shows on a right click, in a workspace, 最近, or 已归档. */
function sessionSplitTarget(session: SessionSummary, cwd: string): SplitTarget {
  return {
    kind: "chat",
    ref: session.path,
    file: session.path,
    cwd,
    agentId: session.agentId,
    title: titleOf(session),
  };
}

function daemonSplitTarget(session: DaemonSession): SplitTarget {
  return {
    kind: "chat",
    ref: session.file ?? `daemon:${session.id}`,
    file: session.file,
    daemonId: session.id,
    cwd: session.cwd,
    agentId: session.agentId,
    title: daemonSessionTitle(session),
  };
}

function sessionMenuItems(session: SessionSummary, cwd: string): MenuItem[] {
  const splitTarget = sessionSplitTarget(session, cwd);
  if (isSessionArchived(session.path)) {
    return [
      { label: tr("Open", "打开"), onSelect: () => void openSessionTab(session.path, cwd) },
      { label: tr("Open in New Tab", "在新标签页中打开"), onSelect: () => void openSessionTab(session.path, cwd, { newTab: true }) },
      { label: tr("Split Right", "向右分屏"), onSelect: () => openSplit(splitTarget, "right") },
      { label: tr("Split Left", "向左分屏"), onSelect: () => openSplit(splitTarget, "left") },
      { type: "separator" },
      {
        label: tr("Unarchive", "取消归档"),
        onSelect: () => {
          animateSidebarList();
          unarchiveSession(session.path);
        },
      },
      { type: "separator" },
      { label: tr("Delete…", "删除…"), onSelect: () => void confirmDelete(session, cwd) },
    ];
  }
  return [
    { label: tr("Open", "打开"), onSelect: () => void openSessionTab(session.path, cwd) },
    { label: tr("Open in New Tab", "在新标签页中打开"), onSelect: () => void openSessionTab(session.path, cwd, { newTab: true }) },
    { label: tr("Split Right", "向右分屏"), onSelect: () => openSplit(splitTarget, "right") },
    { label: tr("Split Left", "向左分屏"), onSelect: () => openSplit(splitTarget, "left") },
    { type: "separator" },
    { label: tr("Rename…", "重命名…"), onSelect: () => void renameFrom(session, cwd) },
    {
      label: tr("Archive", "归档"),
      onSelect: () => {
        animateSidebarList();
        void archiveSession(session.path, cwd);
      },
    },
    { type: "separator" },
    { label: tr("Delete…", "删除…"), onSelect: () => void confirmDelete(session, cwd) },
  ];
}

function startNewSession(newTab = false) {
  void openNewSessionTab({ newTab });
}

function startNewSessionFromRecents(newTab = false) {
  setGroupCollapsed("recents", false);
  explicitDraftGroup = "recents";
  draftGroup.set("recents");
  void openNewSessionTab({ newTab });
}

function startNewChat(newTab = false) {
  const cwd = chatFolder();
  if (isWorkspaceCollapsed(cwd)) {
    setGroupCollapsed("recents", false);
    explicitDraftGroup = "recents";
    draftGroup.set("recents");
  } else {
    setGroupCollapsed("workspaces", false);
    explicitDraftGroup = "workspaces";
    draftGroup.set("workspaces");
  }
  void openNewChatTab({ newTab });
}

function startNewSessionIn(cwd: string, newTab = false) {
  if (isWorkspaceCollapsed(cwd)) {
    setGroupCollapsed("recents", false);
    explicitDraftGroup = "recents";
    draftGroup.set("recents");
  } else {
    explicitDraftGroup = "workspaces";
    draftGroup.set("workspaces");
  }
  void openNewSessionTab({ newTab, cwd });
}

/**
 * A functional group's heading (工作区 / 最近 / 文档 / 已归档): the quiet label, the fold cue
 * that only an open group hides until hovered, and the group's own action.
 * The label sits on the same left axis as every row's text.
 */
function GroupHeading(props: {
  id: GroupId;
  label: string;
  count: number;
  action?: { icon: IconName; label: string; shortcut?: string; onPress: () => void };
  alwaysShowAction?: boolean;
  onContextMenu?: (e: ContextMenuEvent) => void;
}) {
  const collapsed = computed(() => isGroupCollapsed(props.id));
  const actionReveal = () =>
    props.alwaysShowAction
      ? "opacity-55 hover:opacity-100 group-hover:opacity-100 focus-within:opacity-100"
      : inert(HOVER_REVEAL);
  return (
    <View class={hoverGroup()} onContextMenu={props.onContextMenu}>
      <BaseButton
        onPress={() => {
          if (props.count > 0) toggleGroupCollapsed(props.id);
          else props.action?.onPress();
        }}
        accessibilityLabel={
          props.count === 0
            ? (props.action?.label ?? props.label)
            : collapsed()
              ? tr(`Expand ${props.label}`, `展开 ${props.label}`)
              : tr(`Collapse ${props.label}`, `收起 ${props.label}`)
        }
        hitSlop={{ bottom: 6 }}
        class={`${uiHeight(24)} w-full min-w-0 flex-row items-center gap-1 rounded-md corner-squircle pl-2.5 ${props.action ? "pr-8" : "pr-2.5"} ${calm(ROW_PRESS)}`}
      >
        <Text class={`shrink-0 truncate ${uiType("sm")} text-subtle`}>{props.label}</Text>
        <If when={collapsed() && props.count > 0}>
          <Text class={`${uiType("xs")} tabular-nums text-subtle`}>{String(props.count)}</Text>
        </If>
        <If when={props.count > 0}>
          <View
            class={`shrink-0 transition-all duration-200 ease-out-quint motion-reduce:transition-none ${
              collapsed() ? "opacity-55" : "rotate-90 opacity-0 group-hover:opacity-100"
            }`}
          >
            <Icon name="chevronRight" size={12} tone="subtle" />
          </View>
        </If>
      </BaseButton>
      <If when={props.action}>
        {(action) => (
          <IconButton
            testID={`sidebar-${props.id}-action`}
            icon={action().icon}
            size="sm"
            label={action().label}
            shortcut={action().shortcut}
            tipPlacement="right"
            onPress={() => action().onPress()}
            class={`absolute right-1 transition-opacity ${actionReveal()}`}
            style={{ top: groupActionTop() }}
          />
        )}
      </If>
    </View>
  );
}

/** One collapsible section of the tree: heading plus the body it reveals. */
function FunctionalGroup(props: {
  id: GroupId;
  label: string;
  count: number;
  action?: { icon: IconName; label: string; shortcut?: string; onPress: () => void };
  alwaysShowAction?: boolean;
  onContextMenu?: (e: ContextMenuEvent) => void;
  first?: boolean;
  children?: JSX.Element;
}) {
  const collapsed = computed(() => isGroupCollapsed(props.id));
  return (
    <View class={props.first ? "pt-1" : "pt-6"}>
      <Collapsible open={!collapsed() && props.count > 0} reveal content={<View class="pt-1.5">{props.children}</View>}>
        <GroupHeading
          id={props.id}
          label={props.label}
          count={props.count}
          action={props.action}
          alwaysShowAction={props.alwaysShowAction}
          onContextMenu={props.onContextMenu}
        />
      </Collapsible>
    </View>
  );
}

function ProjectRow(props: { cwd: string; first: boolean; allProjects: readonly string[] }) {
  const home = backend().home();
  const active = computed(() => props.cwd === activeProjectPath());
  const collapsed = computed(() => isWorkspaceCollapsed(props.cwd));
  const label = computed(() => projectLabel(props.cwd, props.allProjects), { equals: sameLabel });
  const sessions = computed(() => sessionsOf(props.cwd));
  const shownInRecents = (path: string | undefined) => !isGroupCollapsed("recents") && Boolean(path && recentSessionPaths().has(path));
  const activeShownInRecents = () =>
    !isGroupCollapsed("recents") && (isDraftSession() ? hasRecentDraft() : shownInRecents(openFile()));
  /** A folded folder still says so when a run inside it keeps working off screen — active or parked, any project. */
  const hiddenRunningInside = () =>
    sessions().some((s) => isSessionRunning(s.path) && !shownInRecents(s.path)) ||
    daemonSessions().some(
      (ds) =>
        projectCwdOf(ds.cwd, ds) === props.cwd &&
        (ds.status === "working" || ds.status === "blocked") &&
        !daemonShownInRecents(ds),
    );
  const collapsedRunning = computed(
    () => collapsed() && (hiddenRunningInside() || (active() && isRunning() && !activeShownInRecents())),
  );
  /** A folded folder surfaces an answer that finished out of sight the same way. */
  const collapsedUnread = computed(
    () =>
      collapsed() &&
      !collapsedRunning() &&
      (sessions().some((s) => isSessionUnread(s.path) && !shownInRecents(s.path)) ||
        daemonSessions().some((ds) => projectCwdOf(ds.cwd, ds) === props.cwd && ds.unread && !daemonShownInRecents(ds))),
  );
  const startingHere = computed(
    () =>
      active() &&
      sidecarPhase().name === "starting" &&
      !isDraftAhead() &&
      !pendingSession()?.file &&
      !pendingSession()?.daemonId &&
      !collapsedRunning() &&
      !collapsedUnread(),
  );
  const canRemove = computed(() => props.allProjects.length > 1);
  const tooltipText = computed(() => tildePath(props.cwd, home));

  return (
    <View
      class={props.first ? "" : "pt-1"}
      onContextMenu={(e) =>
        Menu.popup(
          [
            { label: tr("Open Workspace", "打开此工作区"), onSelect: () => void openWorkspace(props.cwd) },
            { label: tr("New Session Here", "在此新建会话"), onSelect: () => startNewSessionIn(props.cwd) },
            {
              label: collapsed() ? tr("Expand Sessions", "展开会话") : tr("Collapse Sessions", "收起会话"),
              onSelect: () => toggleProject(props.cwd),
            },
            { label: tr("Copy Path", "复制路径"), onSelect: () => void copyText(props.cwd) },
            { type: "separator" },
            {
              label: tr("Remove from Sidebar", "从侧边栏移除"),
              disabled: !canRemove(),
              onSelect: () => {
                animateSidebarList();
                void closeWorkspace(props.cwd);
              },
            },
          ],
          e.pagePosition,
        )
      }
    >
      <DropRow list="workspaces" id={props.cwd}>
        <BaseButton
          onPress={() => toggleProject(props.cwd)}
          onPressDown={() => armMouseDrag({ list: "workspaces", id: props.cwd })}
          onPressUp={endMouseDrag}
          accessibilityLabel={collapsed() ? tr(`Expand ${label().name}`, `展开 ${label().name}`) : tr(`Collapse ${label().name}`, `收起 ${label().name}`)}
          hitSlop={props.first ? undefined : { top: 4 }}
          tooltip={tip(tooltipText(), undefined, "right")}
          class={`${uiHeight(28)} w-full min-w-0 flex-row items-center gap-1.5 rounded-md corner-squircle pl-2.5 pr-8 ${calm(ROW_PRESS)}`}
        >
          <View class={ICON_SLOT}>
            <Icon name={collapsed() ? "folder" : "folderOpen"} size={uiIconSize(14)} tone={active() ? "foreground" : "muted-foreground"} />
          </View>
          <Text
            class={`shrink truncate ${uiType("base")} ${
              active() ? "font-semibold text-sidebar-foreground" : "font-medium text-muted-foreground group-hover:text-sidebar-foreground"
            }`}
          >
            {label().name}
          </Text>
          <If when={label().parent}>
            {(p) => <Text class={`shrink truncate ${uiType("xs")} text-subtle`}>{p()}</Text>}
          </If>
          <View
            class={`shrink-0 transition-all duration-200 ease-out-quint motion-reduce:transition-none ${
              collapsed() ? "" : "rotate-90"
            } opacity-0 group-hover:opacity-100`}
          >
            <Icon name="chevronRight" size={12} tone="subtle" />
          </View>
        </BaseButton>
        <View class={`${TRAILING_SLOT} transition-opacity group-hover:opacity-0`} style={{ top: rowTrailingTop() }}>
          <If when={startingHere()}>
            <View class="absolute inset-0 items-center justify-center">
              <FadeIn>
                <View class="size-2.5 rounded-full border-[1.5px] border-input border-t-brand animate-spin" />
              </FadeIn>
            </View>
          </If>
          <Presence
            show={collapsedRunning()}
            testID="sidebar-project-running"
            accessibilityLabel={tr("Running in the background", "后台运行中")}
            class="absolute inset-0 items-center justify-center"
          >
            <Pip size={16} mood="work" />
          </Presence>
          <Presence
            show={collapsedUnread()}
            testID="sidebar-project-unread"
            accessibilityLabel={tr("Finished in the background", "后台已完成")}
            class="absolute inset-0 items-center justify-center"
          >
            <View class="size-1.5 rounded-full bg-brand" />
          </Presence>
        </View>
        <IconButton
          icon="plus"
          size="sm"
          label={tr(`New session in ${label().name}`, `在 ${label().name} 中新建会话`)}
          tipPlacement="right"
          hitSlop={{ top: 2, bottom: 2 }}
          onPress={() => startNewSessionIn(props.cwd)}
          class={`absolute right-1 transition-opacity ${inert(HOVER_REVEAL)}`}
          style={{ top: rowTrailingTop() }}
        />
      </DropRow>
    </View>
  );
}

/**
 * The special workspace for repo-free chats (`<dataDir>/chat`): sits inside
 * 工作区 alongside project folders, with its own message mark, hover `+` to
 * start a chat, and expand/collapse once it holds sessions (a click when empty
 * opens a chat straight away). Never persisted into the user's project list.
 */
function ChatWorkspaceRow(props: { first: boolean }) {
  const cwd = computed(() => chatFolder());
  const active = computed(() => cwd() === activeProjectPath());
  const collapsed = computed(() => isWorkspaceCollapsed(cwd()));
  const sessions = computed(() => sessionsOf(cwd()));
  const hasDaemonInside = computed(() =>
    daemonSessions().some(
      (ds) =>
        projectCwdOf(ds.cwd, ds) === cwd() &&
        !isSessionArchived(ds.file) &&
        daemonRootEarnsRow(ds) &&
        !(isDraftSession() && ds.id === openDaemonId()),
    ),
  );
  const hasChildren = computed(() => sessions().length > 0 || (active() && isDraftSession()) || hasDaemonInside());
  const shownInRecents = (path: string | undefined) => !isGroupCollapsed("recents") && Boolean(path && recentSessionPaths().has(path));
  const activeShownInRecents = () =>
    !isGroupCollapsed("recents") && (isDraftSession() ? hasRecentDraft() : shownInRecents(openFile()));
  const hiddenRunningInside = () =>
    sessions().some((s) => isSessionRunning(s.path) && !shownInRecents(s.path)) ||
    daemonSessions().some(
      (ds) =>
        projectCwdOf(ds.cwd, ds) === cwd() &&
        (ds.status === "working" || ds.status === "blocked") &&
        !daemonShownInRecents(ds),
    );
  const collapsedRunning = computed(
    () => collapsed() && (hiddenRunningInside() || (active() && isRunning() && !activeShownInRecents())),
  );
  const collapsedUnread = computed(
    () =>
      collapsed() &&
      !collapsedRunning() &&
      (sessions().some((s) => isSessionUnread(s.path) && !shownInRecents(s.path)) ||
        daemonSessions().some((ds) => projectCwdOf(ds.cwd, ds) === cwd() && ds.unread && !daemonShownInRecents(ds))),
  );
  const startingHere = computed(
    () =>
      active() &&
      sidecarPhase().name === "starting" &&
      !isDraftAhead() &&
      !pendingSession()?.file &&
      !pendingSession()?.daemonId &&
      !collapsedRunning() &&
      !collapsedUnread(),
  );

  const openChat = (newTab = false) => {
    if (collapsed()) setWorkspaceCollapsed(cwd(), false);
    startNewChat(newTab);
  };

  return (
    <View
      class={props.first ? "" : "pt-1"}
      onContextMenu={(e) =>
        Menu.popup(
          [
            { label: tr("New Session Here", "在此新建会话"), onSelect: () => startNewChat() },
            ...(hasChildren()
              ? [
                  {
                    label: collapsed() ? tr("Expand Sessions", "展开会话") : tr("Collapse Sessions", "收起会话"),
                    onSelect: () => toggleProject(cwd()),
                  },
                ]
              : []),
          ],
          e.pagePosition,
        )
      }
    >
      <View class={hoverGroup()}>
        <View
          role="button"
          testID="sidebar-chat-workspace"
          onPress={(e: PressEvent) => {
            if (isModPress(e)) {
              openChat(true);
              return;
            }
            if (hasChildren()) toggleProject(cwd());
            else openChat(false);
          }}
          onMouseUp={(e: MouseEvent) => {
            if (e.button === "middle") openChat(true);
          }}
          accessibilityLabel={
            hasChildren()
              ? collapsed()
                ? tr("Expand Chat", "展开闲聊")
                : tr("Collapse Chat", "收起闲聊")
              : tr("New chat", "新建闲聊")
          }
          hitSlop={props.first ? undefined : { top: 4 }}
          tooltip={tip(tr("Chat · No project folder", "闲聊 · 不在任何项目里"), undefined, "right")}
          class={`${uiHeight(28)} w-full min-w-0 flex-row items-center gap-1.5 rounded-md corner-squircle pl-2.5 pr-8 ${calm(ROW_PRESS)}`}
        >
          <View class={ICON_SLOT}>
            <Icon name="message" size={uiIconSize(14)} tone={active() ? "foreground" : "muted-foreground"} />
          </View>
          <Text
            class={`shrink truncate ${uiType("base")} ${
              active() ? "font-semibold text-sidebar-foreground" : "font-medium text-muted-foreground group-hover:text-sidebar-foreground"
            }`}
          >
            {tr("Chat", "闲聊")}
          </Text>
          <If when={hasChildren()}>
            <View
              class={`shrink-0 transition-all duration-200 ease-out-quint motion-reduce:transition-none ${
                collapsed() ? "" : "rotate-90"
              } opacity-0 group-hover:opacity-100`}
            >
              <Icon name="chevronRight" size={12} tone="subtle" />
            </View>
          </If>
        </View>
        <View class={`${TRAILING_SLOT} transition-opacity group-hover:opacity-0`} style={{ top: rowTrailingTop() }}>
          <If when={startingHere()}>
            <View class="absolute inset-0 items-center justify-center">
              <FadeIn>
                <View class="size-2.5 rounded-full border-[1.5px] border-input border-t-brand animate-spin" />
              </FadeIn>
            </View>
          </If>
          <Presence
            show={collapsedRunning()}
            testID="sidebar-project-running"
            accessibilityLabel={tr("Running in the background", "后台运行中")}
            class="absolute inset-0 items-center justify-center"
          >
            <Pip size={16} mood="work" />
          </Presence>
          <Presence
            show={collapsedUnread()}
            testID="sidebar-project-unread"
            accessibilityLabel={tr("Finished in the background", "后台已完成")}
            class="absolute inset-0 items-center justify-center"
          >
            <View class="size-1.5 rounded-full bg-brand" />
          </Presence>
        </View>
        <IconButton
          testID="sidebar-chat-new"
          icon="plus"
          size="sm"
          label={tr("New session in Chat", "在闲聊中新建会话")}
          tipPlacement="right"
          hitSlop={{ top: 2, bottom: 2 }}
          onPress={() => startNewChat()}
          class={`absolute right-1 transition-opacity ${inert(HOVER_REVEAL)}`}
          style={{ top: rowTrailingTop() }}
        />
      </View>
    </View>
  );
}

/** A session row anywhere in the sidebar: the engine's mark, the title, and the running cue or archive action. */
const sessionRowClass = (
  indent: boolean,
  reserveTrailing: boolean,
  reserveHoverAction: boolean,
  depth = 0,
  keepTrailingOnHover = false,
) =>
  `${uiHeight(28)} w-full min-w-0 flex-row items-center gap-1.5 rounded-lg corner-squircle border-[0.5px] border-transparent ${
    depth >= 3 ? "pl-16" : depth === 2 ? "pl-14" : depth === 1 ? "pl-12" : indent ? "pl-8" : "pl-2.5"
  } ${
    reserveTrailing && reserveHoverAction && keepTrailingOnHover
      ? "pr-8 group-hover:pr-14"
      : reserveTrailing
        ? "pr-8"
        : reserveHoverAction
          ? "pr-2.5 group-hover:pr-8"
          : "pr-2.5"
  } ${PRESS} active:scale-[0.99] motion-reduce:active:scale-100 ${FOCUS_RING} hover:bg-sidebar-accent group-hover:bg-sidebar-accent active:bg-sidebar-accent selected:border-hairline selected:bg-card selected:shadow-sidebar-row dark:selected:shadow-sidebar-row-dark`;

const sessionTitleClass = (selected: boolean) =>
  // `transition-colors` only: font-weight is a discrete/variable-font property that cannot
  // animate gracefully with a generic `transition`, which makes the text width drift during
  // the 150ms window and shifts the truncation point — the visible "shake". Colour still
  // fades smoothly while the weight snaps at the moment of the click instead.
  `min-w-0 flex-1 truncate ${uiType("base")} transition-colors duration-150 ease-out-quint motion-reduce:transition-none ${selected ? "font-medium text-sidebar-foreground" : "text-muted-foreground group-hover:text-sidebar-foreground"}`;

/** Fades its content in after the shared patience delay, so a state that ends sooner (a quick restart) never shows at all. */
function FadeIn(props: { children: JSX.Element }) {
  return <View style={{ opacity: delayedFade() }}>{props.children}</View>;
}

/** A row's engine mark; switching the engine settles the new mark in rather than swapping it in one frame. */
function EngineMark(props: { id: string; available: boolean; selected?: boolean }) {
  const opacity = createAnimatedValue(1);
  const scale = createAnimatedValue(1);
  let shown = untracked(() => props.id);
  effect(() => {
    const id = props.id;
    if (id === shown) return;
    shown = id;
    if (untracked(reduceMotion)) return;
    opacity.keyframes([0, 1], { duration: 220, easing: EASING.entrance });
    scale.keyframes([0.6, 1], { duration: 260, easing: EASING.signature });
  });
  return (
    <View class={`${ICON_SLOT} transition-opacity duration-150 ${props.selected ? "opacity-100" : "opacity-65 group-hover:opacity-100"}`}>
      <View style={{ opacity, transform: [{ scale }] }}>
        <AgentLogo id={props.id} size={uiIconSize(13)} tone={props.selected ? "foreground" : "muted-foreground"} status={props.available ? "ready" : "off"} />
      </View>
    </View>
  );
}

function DraftSessionRow(props: { cwd: string; group: GroupId; indent?: boolean }) {
  const resolvedCwd = computed(() => props.cwd || activeProjectPath());
  const active = computed(() => Boolean(resolvedCwd()) && resolvedCwd() === activeProjectPath() && isDraftSession());
  const primary = computed(() => active() && ownsDraftSession(props.group, resolvedCwd()));
  const running = computed(() => active() && (isRunning() || openDaemon()?.status === "working" || openDaemon()?.status === "blocked"));
  const selected = computed(() => primary() && activeViewName() === "chat");
  const shownTitle = signal(untracked(() => (isDraftSession() ? currentTitle() : tr("New session", "新会话"))));
  const shownAgentId = signal(untracked(activeAgentId));
  const shownCwd = signal(untracked(resolvedCwd));
  effect(() => {
    if (!active()) return;
    shownTitle.set(currentTitle());
    shownAgentId.set(activeAgentId());
    shownCwd.set(resolvedCwd());
  });
  const engine = computed(() => engineOf(shownAgentId()), { equals: sameEngine });
  const tooltipText = computed(() =>
    props.group === "recents" ? `${engine().name} · ${placeLabel(shownCwd())}` : engine().name,
  );
  return (
    <View class={hoverGroup()}>
      <View
        role="button"
        accessibilityState={{ selected: selected() }}
        onPress={(e: PressEvent) => {
          const target = shownCwd();
          draftGroup.set(props.group);
          if (isModPress(e)) {
            void openNewSessionTab({ newTab: true, cwd: target && target !== activeProjectPath() ? target : undefined });
            return;
          }
          showChat();
          if (target && target !== activeProjectPath()) void openWorkspace(target);
        }}
        onMouseUp={(e: MouseEvent) => {
          if (e.button !== "middle") return;
          const target = shownCwd();
          draftGroup.set(props.group);
          void openNewSessionTab({ newTab: true, cwd: target && target !== activeProjectPath() ? target : undefined });
        }}
        tooltip={tip(tooltipText(), undefined, "right")}
        class={calm(sessionRowClass(Boolean(props.indent), running(), false))}
      >
        <EngineMark id={engine().id} available={engine().available} selected={selected()} />
        <Text class={sessionTitleClass(selected())}>{shownTitle()}</Text>
      </View>
      <View class={TRAILING_SLOT} style={{ top: rowTrailingTop() }}>
        <Presence show={running()} testID="sidebar-draft-running" class="items-center justify-center">
          <Pip size={16} mood="work" />
        </Presence>
      </View>
    </View>
  );
}

function SessionRow(props: { session: SessionSummary; cwd: string; group: GroupId; indent?: boolean }) {
  const path = computed(() => props.session.path);
  /** The daemon session behind this file — its status is the row's truth (a parent's children keep its mark too). */
  const daemon = computed(() => daemonSessionByFile(path()));
  const active = computed(
    () => !isDraftSession() && path() === openFile() && projectCwdOf(props.cwd, daemon()) === activeProjectPath(),
  );
  const owns = computed(() => ownsActiveSession(props.group, path(), props.cwd));
  const primary = computed(() => active() && owns());
  const waitingHere = computed(() => childSessionsOf(path()).some((c) => c.status === "working" || c.status === "blocked"));
  const daemonRunning = computed(() => isSessionRunning(path()) || waitingHere());
  /** A run kept going off screen marks every row the session has — whichever group the reader is looking at. */
  const backgroundRunning = computed(() => !active() && daemonRunning());
  /** The on-screen run marks all of the session's rows too; `owns` picks where the highlight sits, not the mark. */
  const running = computed(() => (active() && isRunning()) || daemonRunning());
  /** A session waiting on a person (an approval) shows the waiting mark, not the working one. */
  const blocked = computed(
    () => !active() && (daemon()?.status === "blocked" || childSessionsOf(path()).some((c) => c.status === "blocked")),
  );
  /** A run that died off screen keeps its mark until the session is opened again. */
  const failed = computed(() => !active() && !running() && daemon()?.status === "failed");
  /** A run that finished off screen leaves a dot until the session is opened again. */
  const unread = computed(() => !active() && !backgroundRunning() && !failed() && isSessionUnread(path()));
  const archived = computed(() => isSessionArchived(path()));
  const engine = computed(() => engineOf(props.session.agentId), { equals: sameEngine });
  const selected = computed(() => primary() && activeViewName() === "chat");
  const keepCue = computed(() => running() || blocked());
  const reserveTrailing = computed(() => running() || unread() || blocked() || failed());
  const title = computed(() => titleOf(props.session));
  const tooltipText = computed(() => `${engine().name} · ${placeLabel(props.cwd)}`);
  /** The list a drag of this row belongs to; 已归档's rows do not move. */
  const dropList = () =>
    props.group === "workspaces" ? `ws:${props.cwd}` : props.group === "recents" ? "recents" : undefined;
  const openRow = (newTab: boolean) => {
    touchHeld = false;
    disarmMouseDrag();
    const p = path();
    if (chosenGroups()[p] !== props.group) chosenGroups.update((all) => ({ ...all, [p]: props.group }));
    void openSessionTab(p, props.cwd, { newTab });
  };
  const content = (
    <>
      <View
        role="button"
        accessibilityState={{ selected: selected() }}
        onPress={(e: PressEvent) => openRow(isModPress(e))}
        onPressDown={(e: PressEvent) => {
          if (!isModPress(e)) {
            armMouseDrag(
              {
                list: dropList() ?? "__split__",
                id: path(),
                split: {
                  target: sessionSplitTarget(props.session, props.cwd),
                  title: title(),
                  agentId: props.session.agentId,
                },
              },
              e.pagePosition.y,
              e.pagePosition.x,
            );
          }
        }}
        onPressUp={endMouseDrag}
        onMouseUp={(e: MouseEvent) => {
          if (e.button === "middle") openRow(true);
        }}
        tooltip={tip(tooltipText(), undefined, "right")}
        class={calm(sessionRowClass(Boolean(props.indent), reserveTrailing(), true, 0, keepCue()))}
      >
        <EngineMark id={engine().id} available={engine().available} selected={selected()} />
        <Text class={sessionTitleClass(selected())}>{title()}</Text>
      </View>
      <View class={keepCue() ? TRAILING_SLOT : `${TRAILING_SLOT} transition-opacity group-hover:opacity-0`} style={{ top: rowTrailingTop() }}>
        <Presence
          show={running() && !blocked()}
          testID="sidebar-session-running"
          accessibilityLabel={backgroundRunning() ? tr("Running in the background", "后台运行中") : undefined}
          class="items-center justify-center"
        >
          <Pip size={16} mood="work" />
        </Presence>
        <Presence
          show={blocked()}
          testID="sidebar-session-blocked"
          accessibilityLabel={tr("Waiting for confirmation", "等待确认")}
          class="absolute inset-0 items-center justify-center"
        >
          <Icon name="clock" size={14} tone="warning" />
        </Presence>
        <Presence
          show={failed()}
          testID="sidebar-session-failed"
          accessibilityLabel={tr("Failed in the background", "后台运行失败")}
          class="absolute inset-0 items-center justify-center"
        >
          <Icon name="alert" size={14} tone="destructive" />
        </Presence>
        <Presence
          show={unread()}
          testID="sidebar-session-unread"
          accessibilityLabel={tr("Finished in the background", "后台已完成")}
          class="absolute inset-0 items-center justify-center"
        >
          <View class="size-1.5 rounded-full bg-brand" />
        </Presence>
      </View>
      <IconButton
        icon={archived() ? "unarchive" : "archive"}
        size="sm"
        label={archived() ? tr("Unarchive", "取消归档") : tr("Archive", "归档")}
        tipPlacement="right"
        hitSlop={{ top: 2, bottom: 2 }}
        onPress={() => {
          animateSidebarList();
          if (archived()) unarchiveSession(path());
          else void archiveSession(path(), props.cwd);
        }}
        class={`absolute ${keepCue() ? "right-7" : "right-1"} transition-opacity ${inert(HOVER_REVEAL)}`}
        style={{ top: rowTrailingTop() }}
      />
    </>
  );
  const list = dropList();
  if (!list) {
    return (
      <View class={hoverGroup()} onContextMenu={(e) => Menu.popup(sessionMenuItems(props.session, props.cwd), e.pagePosition)}>
        {content}
      </View>
    );
  }
  return (
    <DropRow
      list={list}
      id={path()}
      split={() => ({
        target: sessionSplitTarget(props.session, props.cwd),
        title: title(),
        agentId: props.session.agentId,
      })}
      onContextMenu={(e) => Menu.popup(sessionMenuItems(props.session, props.cwd), e.pagePosition)}
    >
      {content}
    </DropRow>
  );
}

/** A session the daemon started under another one (or externally without a file yet) — nested in the sidebar. */
function DaemonSessionRow(props: { session: DaemonSession; group: GroupId; nested?: boolean }) {
  const session = () => props.session;
  const file = computed(() => session().file);
  const active = computed(
    () => session().id === openDaemonId() || (file() !== undefined && file() === openFile() && !isDraftSession()),
  );
  const engine = computed(() => engineOf(session().agentId), { equals: sameEngine });
  const working = computed(() => (active() && isRunning()) || session().status === "working" || session().status === "blocked");
  const blocked = computed(() => !active() && session().status === "blocked");
  const failed = computed(() => !active() && (session().status === "failed" || session().status === "interrupted"));
  const unread = computed(() => session().unread && !active() && !failed() && !working());
  /** A row the open session has in both groups takes the highlight in one only (`ownsDaemonRow`). */
  const primary = computed(() => active() && ownsDaemonRow(props.group, session()));
  const selected = computed(() => primary() && activeViewName() === "chat");
  /** Whether the row hangs under its parent's — a tree top whose own tree hides takes a flat row of its own. */
  const nested = computed(() => props.nested ?? Boolean(session().parentId));
  /** A child steps one notch in from its parent's row: 最近's roots sit at the folder's level, 工作区's a rung deeper. */
  const rowDepth = computed(() => {
    if (!nested()) return 0;
    return props.group === "recents" ? Math.max(0, session().depth - 1) : Math.max(1, session().depth);
  });
  /** Any settled/failed/interrupted daemon row (or one with a transcript file) can be archived out of the list. */
  const archivable = computed(() => file() !== undefined || !working());
  const reserveTrailing = computed(() => working() || unread() || failed());
  const title = computed(() => daemonSessionTitle(session()));
  const tooltipText = computed(
    () =>
      `${engine().name} · ${placeLabel(session().cwd)}${session().worktree?.branch ? ` · ${session().worktree!.branch}` : ""}${
        file() ? "" : ` · ${statusLabel(session().status)}`
      }`,
  );
  /** Only 最近's root rows drag: a nested row's place is its tree's, a 工作区 row's is the daemon's order. */
  const dropList = () => (props.group === "recents" && !nested() ? "recents" : undefined);
  const openDaemonRow = (newTab: boolean) => {
    touchHeld = false;
    disarmMouseDrag();
    const s = session();
    const key = `daemon:${s.id}`;
    if (chosenGroups()[key] !== props.group) chosenGroups.update((all) => ({ ...all, [key]: props.group }));
    if (!isDaemonTaskSession(s) && !s.file) {
      explicitDraftGroup = props.group;
      draftGroup.set(props.group);
    }
    openDaemonSessionTab(s.id, { newTab });
  };
  const content = (
    <>
      <View
        role="button"
        accessibilityState={{ selected: selected() }}
        onPress={(e: PressEvent) => openDaemonRow(isModPress(e))}
        onPressDown={(e: PressEvent) => {
          if (!isModPress(e)) {
            const s = session();
            armMouseDrag(
              {
                list: dropList() ?? "__split__",
                id: `daemon:${s.id}`,
                split: {
                  target: daemonSplitTarget(s),
                  title: daemonSessionTitle(s),
                  agentId: s.agentId,
                },
              },
              e.pagePosition.y,
              e.pagePosition.x,
            );
          }
        }}
        onPressUp={endMouseDrag}
        onMouseUp={(e: MouseEvent) => {
          if (e.button === "middle") openDaemonRow(true);
        }}
        tooltip={tip(tooltipText(), undefined, "right")}
        class={calm(
          sessionRowClass(
            props.group === "workspaces" || nested(),
            reserveTrailing(),
            archivable(),
            rowDepth(),
            working(),
          ),
        )}
      >
        <EngineMark id={engine().id} available={engine().available} selected={selected()} />
        <Text class={sessionTitleClass(selected())}>{title()}</Text>
      </View>
      <View class={working() || !archivable() ? TRAILING_SLOT : `${TRAILING_SLOT} transition-opacity group-hover:opacity-0`} style={{ top: rowTrailingTop() }}>
        <Presence
          show={working() && !blocked()}
          testID="sidebar-child-running"
          accessibilityLabel={tr("Running in the background", "后台运行中")}
          class="items-center justify-center"
        >
          <Pip size={16} mood="work" />
        </Presence>
        <Presence
          show={blocked()}
          testID="sidebar-child-blocked"
          accessibilityLabel={tr("Waiting for confirmation", "等待确认")}
          class="absolute inset-0 items-center justify-center"
        >
          <Icon name="clock" size={14} tone="warning" />
        </Presence>
        <Presence
          show={failed()}
          testID="sidebar-child-failed"
          accessibilityLabel={session().status === "interrupted" ? tr("Interrupted", "已中断") : tr("Failed", "已失败")}
          class="absolute inset-0 items-center justify-center"
        >
          <Icon name="alert" size={14} tone="destructive" />
        </Presence>
        <Presence
          show={unread()}
          testID="sidebar-child-unread"
          accessibilityLabel={tr("Finished in the background", "后台已完成")}
          class="absolute inset-0 items-center justify-center"
        >
          <View class="size-1.5 rounded-full bg-brand" />
        </Presence>
      </View>
      <If when={archivable()}>
        <IconButton
          icon="archive"
          size="sm"
          label={tr("Archive", "归档")}
          tipPlacement="right"
          hitSlop={{ top: 2, bottom: 2 }}
          onPress={() => {
            animateSidebarList();
            void archiveDaemonSession(session().id);
          }}
          class={`absolute ${working() ? "right-7" : "right-1"} transition-opacity ${inert(HOVER_REVEAL)}`}
          style={{ top: rowTrailingTop() }}
        />
      </If>
    </>
  );
  const list = dropList();
  if (!list) {
    return (
      <View class={hoverGroup()} onContextMenu={(e) => Menu.popup(childMenuItems(session()), e.pagePosition)}>
        {content}
      </View>
    );
  }
  return (
    <DropRow
      list={list}
      id={`daemon:${session().id}`}
      split={() => {
        const s = session();
        return {
          target: daemonSplitTarget(s),
          title: daemonSessionTitle(s),
          agentId: s.agentId,
        };
      }}
      onContextMenu={(e) => Menu.popup(childMenuItems(session()), e.pagePosition)}
    >
      {content}
    </DropRow>
  );
}

/** The status words a child row carries when it has no transcript to open. */
function statusLabel(status: DaemonSession["status"]) {
  switch (status) {
    case "working":
      return tr("running", "运行中");
    case "blocked":
      return tr("waiting", "等待确认");
    case "failed":
      return tr("failed", "已失败");
    case "interrupted":
      return tr("interrupted", "已中断");
    default:
      return tr("idle", "空闲");
  }
}

/** A daemon session's right-click: open it, stop it outright, archive it, or delete it. */
function childMenuItems(session: DaemonSession): MenuItem[] {
  const working = session.status === "working" || session.status === "blocked";
  const splitTarget = daemonSplitTarget(session);
  return [
    { label: tr("Open", "打开"), onSelect: () => openDaemonSessionTab(session.id) },
    { label: tr("Open in New Tab", "在新标签页中打开"), onSelect: () => openDaemonSessionTab(session.id, { newTab: true }) },
    { label: tr("Split Right", "向右分屏"), onSelect: () => openSplit(splitTarget, "right") },
    { label: tr("Split Left", "向左分屏"), onSelect: () => openSplit(splitTarget, "left") },
    { type: "separator" },
    {
      label: tr("Stop session", "停止会话"),
      disabled: !working,
      onSelect: () => void stopDaemonSession(session.id),
    },
    {
      label: tr("Archive", "归档"),
      disabled: !session.file && working,
      onSelect: () => {
        animateSidebarList();
        void archiveDaemonSession(session.id);
      },
    },
    { type: "separator" },
    {
      label: tr("Delete…", "删除…"),
      disabled: working,
      onSelect: () => void confirmDeleteDaemon(session),
    },
  ];
}

function ProjectSessions(props: { cwd: string; allProjects: readonly string[]; collapsed: () => boolean }) {
  const isCurrent = computed(() => props.cwd === activeProjectPath());
  const folderSessions = computed(() => sessionsOf(props.cwd));
  const hasDraft = computed(
    () =>
      isCurrent() &&
      listSteady() &&
      isDraftSession() &&
      (isChatFolder(props.cwd) || folderSessions().length > 0 || props.allProjects.length > 1 || childSessionsOfOpen().length > 0),
  );

  let prevById = new Map<string, FolderItem>();
  let lastItems: FolderItem[] = [];
  const reuseFolderItem = (id: string, session?: SessionSummary, child?: DaemonSession): FolderItem => {
    const prev = prevById.get(id);
    if (prev && prev.session === session && prev.child === child) return prev;
    return { id, ...(session ? { session } : {}), ...(child ? { child } : {}) };
  };
  const items = computed<FolderItem[]>(
    () => {
      if (props.collapsed()) return lastItems;
      const rows: FolderItem[] = [];
      const listed = new Set(folderSessions().map((s) => s.path));
      for (const ds of daemonSessions()) {
        if (ds.parentId || (ds.file && listed.has(ds.file))) continue;
        if (isSessionArchived(ds.file)) continue;
        if (projectCwdOf(ds.cwd, ds) !== props.cwd) continue;
        if (!daemonRootEarnsRow(ds)) continue;
        if (isDraftSession() && ds.id === openDaemonId()) continue;
        rows.push(reuseFolderItem(`child:${ds.id}`, undefined, ds));
        for (const child of childSessionsOfDaemon(ds.id)) rows.push(reuseFolderItem(`child:${child.id}`, undefined, child));
      }
      for (const session of sortedFolderSessions(props.cwd)) {
        rows.push(reuseFolderItem(`session:${session.path}`, session, undefined));
        for (const child of childSessionsOf(session.path)) rows.push(reuseFolderItem(`child:${child.id}`, undefined, child));
      }
      const nextById = new Map<string, FolderItem>();
      for (const item of rows) nextById.set(item.id, item);
      prevById = nextById;
      lastItems = rows;
      return rows;
    },
    { equals: sameItems },
  );

  const draftChildren = computed(() => (hasDraft() ? childSessionsOfOpen() : []), { equals: sameItems });
  return (
    <View ref={(ref) => registerDropList(`ws:${props.cwd}`, ref)}>
      <Reveal open={hasDraft()} instant={props.collapsed() || draftGraduated()}>
        <View>
          <DraftSessionRow cwd={props.cwd} group="workspaces" indent />
          <Each of={draftChildren()} key={(c) => `child:${c.id}`}>
            {(child) => <DaemonSessionRow session={child()} group="workspaces" />}
          </Each>
        </View>
      </Reveal>
      <Each of={items()} key={(item) => item.id}>
        {(item) =>
          item().child ? (
            <DaemonSessionRow session={item().child!} group="workspaces" />
          ) : (
            <SessionRow session={item().session!} cwd={props.cwd} group="workspaces" indent />
          )
        }
      </Each>
    </View>
  );
}

function ProjectSection(props: { cwd: string; first: boolean; allProjects: readonly string[]; chat?: boolean }) {
  const collapsed = computed(() => isWorkspaceCollapsed(props.cwd));
  const mounted = signal(!untracked(collapsed));
  let unmountTimer: ReturnType<typeof setTimeout> | undefined;
  effect(() => {
    const closed = collapsed();
    clearTimeout(unmountTimer);
    unmountTimer = undefined;
    if (!closed) {
      if (!untracked(mounted)) mounted.set(true);
      return;
    }
    if (!untracked(mounted)) return;
    if (untracked(reduceMotion)) {
      mounted.set(false);
      return;
    }
    unmountTimer = setTimeout(() => {
      unmountTimer = undefined;
      if (untracked(collapsed)) mounted.set(false);
    }, 320);
  });
  cleanup(() => clearTimeout(unmountTimer));
  return (
    <Collapsible
      open={!collapsed()}
      reveal
      content={
        <If when={mounted()}>
          <ProjectSessions cwd={props.cwd} allProjects={props.allProjects} collapsed={collapsed} />
        </If>
      }
    >
      {props.chat ? <ChatWorkspaceRow first={props.first} /> : <ProjectRow cwd={props.cwd} first={props.first} allProjects={props.allProjects} />}
    </Collapsible>
  );
}

function toggleProject(cwd: string) {
  toggleWorkspaceCollapsed(cwd);
}

async function confirmDeleteNote(note: NoteSummary) {
  const name = docTabTitle(note.path);
  const { action } = await AlertDialog.show({
    title: tr("Delete this document?", "删除这篇文档？"),
    description: tr(`“${name}” will be removed from this Mac. This cannot be undone.`, `“${name}”将从此设备移除，该操作无法撤销。`),
    actions: [
      { label: tr("Cancel", "取消"), role: "cancel", id: "cancel" },
      { label: tr("Delete", "删除"), role: "destructive", id: "delete" },
    ],
  });
  if (action === "delete") {
    animateSidebarList();
    await deleteNote(note.path);
  }
}

/**
 * A document in the sidebar's quiet 文档 group: a click opens it in the current
 * tab, ⌘-click or middle-click opens a new tab, and hovering shows where the file lives.
 */
function NoteRow(props: { note: NoteSummary }) {
  const home = backend().home();
  const selected = computed(() => activeDocId() === props.note.path);
  const title = computed(() => docTabTitle(props.note.path));
  const tooltipText = computed(() => tildePath(props.note.path, home));
  const revealLabel = () => (platform.os === "macos" ? tr("Show in Finder", "在访达中显示") : tr("Show in File Manager", "在文件管理器中显示"));
  const menu = (e: ContextMenuEvent) => {
    const targets = docChatTargets();
    const sessionItems: MenuItem[] = targets.sessions.map((s) => ({
      label: tr(`Add to “${s.title}”`, `添加到「${s.title}」`),
      onSelect: () => void addDocToTab(props.note.path, s.tab, { selection: false }),
    }));
    return Menu.popup(
      [
        { label: tr("Open", "打开"), onSelect: () => openDocTab(props.note.path) },
        { label: tr("Open in New Tab", "在新标签页中打开"), onSelect: () => openDocTab(props.note.path, { newTab: true }) },
        { label: tr("Split Right", "向右分屏"), onSelect: () => openSplit({ kind: "doc", path: props.note.path }, "right") },
        { label: tr("Split Left", "向左分屏"), onSelect: () => openSplit({ kind: "doc", path: props.note.path }, "left") },
        { type: "separator" },
        {
          label: targets.hasActiveDraft ? tr("Add to Current Draft", "添加到当前草稿") : tr("New Session with Document", "用新会话讨论"),
          onSelect: () =>
            targets.hasActiveDraft && targets.draftTab
              ? void addDocToTab(props.note.path, targets.draftTab, { selection: false })
              : void addDocToNewSession(props.note.path, { selection: false }),
        },
        ...sessionItems,
        { type: "separator" },
        { label: revealLabel(), onSelect: () => void revealDoc(props.note.path) },
        { label: tr("Save As…", "另存为…"), onSelect: () => void saveDocAs(props.note.path) },
        { label: tr("Copy Path", "复制路径"), onSelect: () => void Clipboard.writeText(props.note.path) },
        { type: "separator" },
        { label: tr("Delete…", "删除…"), onSelect: () => void confirmDeleteNote(props.note) },
      ],
      e.pagePosition,
    );
  };
  const openRow = (newTab: boolean) => {
    touchHeld = false;
    disarmMouseDrag();
    openDocTab(props.note.path, { newTab });
  };
  return (
    <DropRow
      list="docs"
      id={props.note.path}
      split={() => ({
        target: { kind: "doc", path: props.note.path },
        title: docTabTitle(props.note.path),
      })}
      onContextMenu={menu}
    >
      <View
        role="button"
        accessibilityState={{ selected: selected() }}
        onPress={(e: PressEvent) => openRow(isModPress(e))}
        onPressDown={(e: PressEvent) => {
          if (!isModPress(e)) {
            armMouseDrag(
              {
                list: "docs",
                id: props.note.path,
                split: {
                  target: { kind: "doc", path: props.note.path },
                  title: docTabTitle(props.note.path),
                },
              },
              e.pagePosition.y,
              e.pagePosition.x,
            );
          }
        }}
        onPressUp={endMouseDrag}
        onMouseUp={(e: MouseEvent) => {
          if (e.button === "middle") openRow(true);
        }}
        tooltip={tip(tooltipText(), undefined, "right")}
        class={calm(sessionRowClass(false, false, false))}
      >
        <View class={ICON_SLOT}>
          <Icon name="file" size={uiIconSize(14)} tone={selected() ? "foreground" : "muted-foreground"} />
        </View>
        <Text class={sessionTitleClass(selected())}>{title()}</Text>
      </View>
    </DropRow>
  );
}

/** The scrollable tree: 工作区's project folders, 最近's sessions, 文档's Markdown notes, and 已归档's tucked-away sessions. */
function SidebarTree() {
  const recentCount = computed(() => allRecents().length + (hasRecentDraft() ? 1 + childSessionsOfOpen().length : 0));
  const showRecents = computed(() => recentCount() > 0);
  const recentDraftChildren = computed(() => (hasRecentDraft() ? childSessionsOfOpen() : []), { equals: sameItems });
  const docsGroupMenu = (e: ContextMenuEvent) =>
    Menu.popup(
      [
        { label: tr("New Document", "新建文档"), shortcut: "mod+shift+n", onSelect: () => void newDocTab() },
        { label: tr("Open Markdown File…", "打开 Markdown 文件…"), onSelect: () => void pickDocTab() },
        { type: "separator" },
        {
          label: platform.os === "macos" ? tr("Show Folder in Finder", "在访达中显示文件夹") : tr("Open Documents Folder", "打开文档文件夹"),
          onSelect: () => void revealDocsFolder(),
        },
        { label: tr("Change Documents Folder…", "更改文档文件夹…"), onSelect: () => void chooseDocsFolder() },
      ],
      e.pagePosition,
    );

  // The rows under the pointer are about to move: any relist is a move under a
  // resting pointer — a draft row opening, a daemon push, a rescan, an
  // auto-archive. The guard keys on the rendered row set itself, so switching
  // between already-listed workspaces leaves hover state undisturbed.
  const rowSignature = computed(() =>
    [
      projects().join(";"),
      allRecents()
        .map((item) => item.id)
        .join(";"),
      notes()
        .map((n) => n.path)
        .join(";"),
      ...recentFolders().map((cwd) => `${cwd}=${sessionsOf(cwd).map((s) => s.path).join(",")}`),
      archivedSessionItems()
        .map((item) => item.id)
        .join(";"),
      recentDraftChildren()
        .map((c) => c.id)
        .join(";"),
      hasRecentDraft() ? "draft" : "",
    ].join("|"),
  );
  let lastRows = untracked(rowSignature);
  effect(() => {
    const sig = rowSignature();
    if (sig === lastRows) return;
    lastRows = sig;
    pointerResting.set(true);
    // The rows were re-laid out under the drag's measured frames: a drop can
    // no longer be trusted to land where the line says.
    if (rowDrag()) finishDrag(false);
  });
  // Escape is the drag's while one is in flight: it hands the rows back
  // (newest binding wins, so it does not also stop a run).
  effect(() => {
    if (!rowDrag()) return;
    cleanup(keymap.bind("escape", () => finishDrag(false), { when: "always" }));
  });

  return (
    <View
      class="flex-1"
      onMouseMove={(e) => {
        // A drag keeps the rows quiet as they pass under the pointer.
        if (pointerResting() && !rowDrag()) pointerResting.set(false);
        sidebarDragMove(e);
      }}
      onMouseUp={endMouseDrag}
    >
      <PipRow />
      <Scroll
        ref={(ref) => {
          sidebarScroll = ref;
        }}
        class="flex-1"
        contentClass="px-2 pb-2"
        accessibilityLabel={tr("Workspaces and sessions", "工作区与会话")}
        onScroll={(e) => {
          // The list moved under the drag's measured rows: the pointer's place
          // in the content changed with it, so the follow and the target do too.
          dragScrollY = e.offset.y;
          if (rowDrag()) {
            syncDragPosition();
            updateDragTarget(lastPointerY);
          }
        }}
      >
        <FunctionalGroup
          id="workspaces"
          label={tr("Workspaces", "工作区")}
          count={projects().length + 1}
          first
          action={{
            icon: "plus",
            label: tr("Add project folder", "添加项目文件夹"),
            shortcut: "mod+o",
            onPress: () => {
              setGroupCollapsed("workspaces", false);
              void chooseWorkspace();
            },
          }}
        >
          <View testID="sidebar-workspaces" ref={(ref) => registerDropList("workspaces", ref)}>
            <Each of={shownProjects()} key={(cwd) => cwd}>
              {(cwd, index) => <ProjectSection cwd={cwd()} first={index() === 0} allProjects={projects()} />}
            </Each>
            <ProjectSection cwd={chatFolder()} first={shownProjects().length === 0} allProjects={projects()} chat />
            <If when={projects().length > WORKSPACE_LIMIT}>
              <BaseButton
                testID="sidebar-workspaces-more"
                onPress={() => {
                  animateSidebarList();
                  workspacesExpanded.update((on) => !on);
                }}
                accessibilityLabel={workspacesExpanded() ? tr("Show less", "收起") : tr("Show more", "展开更多…")}
                class={`${uiHeight(26)} w-full min-w-0 flex-row items-center rounded-md corner-squircle pl-8 pr-2.5 ${ROW_PRESS}`}
              >
                <Text class={`truncate ${uiType("xs")} text-subtle/80`}>
                  {workspacesExpanded() ? tr("Show less", "收起") : tr("Show more…", "展开更多…")}
                </Text>
              </BaseButton>
            </If>
          </View>
        </FunctionalGroup>
        <Reveal open={showRecents()}>
          <FunctionalGroup
            id="recents"
            label={tr("Recent", "最近")}
            count={recentCount()}
            action={{ icon: "pencil", label: tr("New session", "新会话"), shortcut: "mod+n", onPress: startNewSessionFromRecents }}
          >
            <View testID="sidebar-recents" ref={(ref) => registerDropList("recents", ref)}>
              <Reveal open={hasRecentDraft()} instant={draftGraduated()}>
                <View>
                  <DraftSessionRow cwd={activeProjectPath()} group="recents" />
                  <Each of={recentDraftChildren()} key={(c) => `child:${c.id}`}>
                    {(child) => <DaemonSessionRow session={child()} group="recents" />}
                  </Each>
                </View>
              </Reveal>
              <Each of={recents()} key={(item) => item.id}>
                {(item) =>
                  item().child ? (
                    <DaemonSessionRow session={item().child!} group="recents" nested={item().id.startsWith("recent-child:")} />
                  ) : (
                    <SessionRow session={item().session!} cwd={item().cwd!} group="recents" />
                  )
                }
              </Each>
              <If when={allRecents().length > RECENT_LIMIT}>
                <BaseButton
                  testID="sidebar-recents-more"
                  onPress={() => {
                    animateSidebarList();
                    recentsExpanded.update((on) => !on);
                  }}
                  accessibilityLabel={recentsExpanded() ? tr("Show less", "收起") : tr("Show more", "展开更多")}
                  class={`${uiHeight(28)} w-full min-w-0 flex-row items-center rounded-md corner-squircle pl-8 pr-2.5 ${ROW_PRESS}`}
                >
                  <Text class={`truncate ${uiType("sm")} text-subtle`}>{recentsExpanded() ? tr("Show less", "收起") : tr("Show more", "展开更多")}</Text>
                </BaseButton>
              </If>
            </View>
          </FunctionalGroup>
        </Reveal>
        <FunctionalGroup
          id="docs"
          label={tr("Documents", "文档")}
          count={notes().length}
          alwaysShowAction={notes().length === 0}
          onContextMenu={docsGroupMenu}
          action={{
            icon: "plus",
            label: tr("New document", "新建文档"),
            shortcut: "mod+shift+n",
            onPress: () => {
              setGroupCollapsed("docs", false);
              void newDocTab();
            },
          }}
        >
          <View testID="sidebar-docs" ref={(ref) => registerDropList("docs", ref)}>
            <Each of={shownDocs()} key={(note) => note.path}>
              {(note) => <NoteRow note={note()} />}
            </Each>
            <If when={allDocs().length > DOCS_LIMIT}>
              <BaseButton
                testID="sidebar-docs-more"
                onPress={() => {
                  animateSidebarList();
                  docsExpanded.update((on) => !on);
                }}
                accessibilityLabel={docsExpanded() ? tr("Show less", "收起") : tr("Show more", "展开更多")}
                class={`${uiHeight(28)} w-full min-w-0 flex-row items-center rounded-md corner-squircle pl-8 pr-2.5 ${ROW_PRESS}`}
              >
                <Text class={`truncate ${uiType("sm")} text-subtle`}>{docsExpanded() ? tr("Show less", "收起") : tr("Show more", "展开更多")}</Text>
              </BaseButton>
            </If>
          </View>
        </FunctionalGroup>
        <Reveal open={archivedSessionItems().length > 0}>
          <FunctionalGroup
            id="archived"
            label={tr("Archived", "已归档")}
            count={archivedSessionItems().length}
            action={{
              icon: "sliders",
              label: tr("Manage archive", "管理归档"),
              onPress: () => showSettings("archive"),
            }}
          >
            <View testID="sidebar-archived">
              <Each of={archivedSessionItems()} key={(item) => item.id}>
                {(item) => <SessionRow session={item().session} cwd={item().cwd} group="archived" />}
              </Each>
            </View>
          </FunctionalGroup>
        </Reveal>
      </Scroll>
      <Presence show={singleEmpty()} class="pointer-events-none absolute inset-0 items-center justify-center gap-3 px-6">
        <Pip size={40} mood="sleep" still />
        <Text class={`text-center ${uiType("sm")} text-subtle`}>
          {tr("No sessions here yet.", "此文件夹暂无会话。")}
        </Text>
      </Presence>
    </View>
  );
}

/** The left column: 新会话, the open project workspaces, 最近, and the way to settings. */
export function Sidebar() {
  const settingsOpen = computed(() => activeViewName() === "settings");
  let prevDraft = untracked(isDraftSession);
  let lastSavedOwner: GroupId = "workspaces";
  let lastDraftOwner: GroupId | undefined = prevDraft ? untracked(draftGroup) : undefined;
  effect(() => {
    const draft = isDraftSession();
    const cwd = activeProjectPath();
    const file = openFile();
    if (!draft) {
      if (prevDraft) {
        if (lastDraftOwner && file && !pendingSession()?.file && untracked(chosenGroups)[file] === undefined) {
          const inherited = lastDraftOwner;
          chosenGroups.update((all) => ({ ...all, [file]: inherited }));
        }
        lastDraftOwner = undefined;
        explicitDraftGroup = undefined;
      }
      if (file && cwd) {
        lastSavedOwner = ownsActiveSession("recents", file, cwd) ? "recents" : "workspaces";
      }
      prevDraft = false;
      return;
    }
    if (!prevDraft) {
      const next = explicitDraftGroup ?? lastSavedOwner;
      explicitDraftGroup = undefined;
      if (untracked(draftGroup) !== next) draftGroup.set(next);
    }
    const owner: GroupId = cwd && ownsDraftSession("recents", cwd) ? "recents" : "workspaces";
    lastDraftOwner = owner;
    if (file && untracked(chosenGroups)[file] !== owner) {
      chosenGroups.update((all) => ({ ...all, [file]: owner }));
    }
    prevDraft = true;
  });
  return (
    <View class={`size-full ${WALLPAPER_FROST ? "" : "bg-sidebar"}`}>
      {/* A title bar's height where window controls stand at the strip's left
         end — it carries the hide button; elsewhere a slim drag margin, and
         the hide button rides on 新会话's row instead. Without a wallpaper the
         sheet floats SHEET_INSET below the window's top, so the strip reaches
         that much farther down: its bottom meets the sheet strip's own, the
         rows below start on the pane's first line, and the traffic lights keep
         their air over 新会话. The padding centers the hide button on the
         strip's line rather than the lengthened strip's own. */}
      <View
        desktop={{ windowDrag: true }}
        class="shrink-0 flex-row items-center justify-end pr-2.5"
        style={{
          height: leftControls() ? TITLE_BAR_HEIGHT + (wallpaper() ? 0 : SHEET_INSET) : 12,
          paddingLeft: (titleBarArea().left || 0) + 14,
          paddingTop: leftControls() && !wallpaper() ? SHEET_INSET : 0,
        }}
      >
        <If when={leftControls()}>
          <IconButton icon="sidebar" label={tr("Hide sidebar", "隐藏侧边栏")} shortcut="mod+b" onPress={() => setSidebarOpen(false)} />
        </If>
      </View>
      <View class={`shrink-0 flex-row items-center gap-1 pb-2 pl-2 ${leftControls() ? "pr-2" : "pr-2.5"}`}>
        <View
          role="button"
          testID="sidebar-new-session"
          onPress={(e: PressEvent) => startNewSession(isModPress(e))}
          onMouseUp={(e: MouseEvent) => {
            if (e.button === "middle") startNewSession(true);
          }}
          accessibilityLabel={tr("New session", "新会话")}
          tooltip={tip(tr("New session", "新会话"), "mod+n", "right")}
          class={`${uiHeight(32)} min-w-0 flex-1 flex-row items-center gap-1.5 rounded-md corner-squircle px-2.5 ${ROW_PRESS}`}
        >
          <View class={ICON_SLOT}>
            <Icon name="pencil" size={uiIconSize(14)} tone="muted-foreground" />
          </View>
          <Text class={`${uiType("base")} text-sidebar-foreground`}>{tr("New session", "新会话")}</Text>
        </View>
        <If when={!leftControls()}>
          <IconButton icon="sidebar" label={tr("Hide sidebar", "隐藏侧边栏")} shortcut="mod+b" onPress={() => setSidebarOpen(false)} />
        </If>
      </View>
      <SidebarTree />
      <View class="px-2 py-1.5">
        <View class="flex-row items-center justify-between pl-1.5 pr-0.5">
          <IconButton
            icon="gear"
            selected={settingsOpen()}
            onPress={() => (settingsOpen() ? leaveSettings() : showSettings())}
            label={tr("Settings", "设置")}
            shortcut="mod+,"
            tone={settingsOpen() ? "foreground" : "muted-foreground"}
            tipPlacement="top"
            class="hover:bg-sidebar-accent active:bg-sidebar-accent selected:bg-sidebar-accent"
          />
          <IconButton
            icon="github"
            onPress={() => void openUrl(REPO_URL)}
            label={tr("pipi on GitHub", "GitHub 上的 pipi")}
            tipPlacement="top"
            class="hover:bg-sidebar-accent active:bg-sidebar-accent"
          />
        </View>
      </View>
    </View>
  );
}
