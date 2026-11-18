import { batch, Clipboard, cleanup, createAnimatedValue, effect, keymap, Overlay, reduceMotion, Scroll, signal, Text, untracked, View } from "nsh";
import type { AnimatedValue, ContextMenuEvent, GestureResponderEvent, InputRef, MouseEvent, ScrollRef, ViewRef, WheelEvent } from "nsh";
import { Button as BaseButton, Input } from "nsh/base";
import { Menu, type MenuItem, titleBar } from "nsh/desktop";
import { tr } from "../lib/i18n";
import { Pip } from "../mascot/Pip";
import type { DaemonSession } from "../pi/daemon";
import {
  cancelRenaming,
  currentDaemonSession,
  currentParentSession,
  currentTitle,
  currentView,
  isCurrentSessionArchived,
  isRenaming,
  newSession,
  openDaemonSession,
  openWorkspace,
  renameSession,
  sessionState,
  sidecarPhase,
  startRenaming,
  unarchiveCurrentSession,
  wallpaper,
} from "../store/app";
import { docTabTitle } from "../store/docs";
import { prefsReady, setSidebarOpen, sidebarOpen } from "../store/prefs";
import {
  activeTabId,
  addNoteToChat,
  chatTabSession,
  chatTabTitle,
  closeTab,
  cycleTab,
  keepTab,
  moveTab,
  newDocTab,
  openDocTab,
  openTabs,
  pickDocTab,
  selectTab,
  tabId,
  type OpenTab,
} from "../store/tabs";
import { AgentLogo } from "../ui/AgentLogo";
import { Chip, IconButton } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { DURATION, EASING, Presence } from "../ui/motion";
import { FIELD_SURFACE, GLASS_REGULAR, HEADER_GLASS, PRESS } from "../ui/styles";
import { tip } from "../ui/Tip";

/** One tab's width: uniform so a drag's slot math is exact and the strip reads as one row. */
const TAB_W = 160;
/** The gap between pills (`gap-1` on the strip's content). */
const TAB_GAP = 4;
/** How long the strip keeps its pills on transforms after a tab opens or closes: the flow spring's rest. */
const FLOW_REST_MS = 700;
/** Trackpad points of travel that switch one tab (a notch of a mouse wheel switches directly). */
const WHEEL_TAB_PX = 48;
/** The shortest gap between wheel switches, so one flick passes tabs one by one. */
const WHEEL_THROTTLE_MS = 120;

// ── Drag to reorder ──────────────────────────────────────────────────────────
// The sidebar's drag engine laid on its side: a held pill lifts — grows a
// little, throws a shadow, rides over the strip — while the pills it passes
// flow to the slots it would leave them. Every pill owns its slot offset as a
// native spring retargeted mid-flow; the lifted pill follows the pointer with
// no spring. A release commits the order and rebases each offset by the slot
// the commit gives it, so the commit itself cannot jump; the springs then land
// on the new layout (see `finishDrag`). A press that travels past DRAG_ARM_X,
// or rests past DRAG_HOLD_MS, lifts it; a touch drag is claimed horizontally by
// `panActivation`, so a vertical swipe stays the strip's scroll.

/** Points of travel before a held pill becomes a drag. */
const DRAG_ARM_X = 6;
/** How long a press stays still before it lifts the pill (a mouse, or a touch that does not scroll). */
const DRAG_HOLD_MS = 150;
/** Sideways travel that lets a pill claim a touch drag from the scroll around it. */
const DRAG_CLAIM_X = 12;
/** How far above or below the strip a drag may wander before it is called off. */
const DRAG_ESCAPE_Y = 96;
/** How near the strip's edge a dragged pill starts to scroll it, and how fast at the edge. */
const DRAG_EDGE = 40;
const DRAG_EDGE_SPEED = 200;

/** The lift and the drop, and the flow of the other pills — the sidebar's springs (mass 1). */
const LIFT_SPRING = { stiffness: 300, damping: 24, mass: 1 } as const;
const FLOW_SPRING = { stiffness: 280, damping: 25, mass: 1 } as const;
const DROP_SPRING = { stiffness: 350, damping: 30, mass: 1 } as const;

/** A pill's place in the strip at lift, in scroll-content coordinates (scroll offsets cancel). */
interface PillFrame {
  id: string;
  left: number;
  width: number;
}

/** One pill's animated channels: its slot offset, the lifted pill's follow, and its lift (grow, fade, plate). */
interface PillAnim {
  id: string;
  shift: AnimatedValue;
  dragX: AnimatedValue;
  lift: AnimatedValue;
  setLifted: (lifted: boolean) => void;
  shiftTarget: number;
  shiftRun: Promise<{ finished: boolean }>;
  liftTarget: number;
  liftRun: Promise<{ finished: boolean }>;
}

/** The chat status mark of a tab's trailing slot, in the sidebar's own language. */
function StatusMark(props: { session: () => DaemonSession | undefined }) {
  const status = () => props.session()?.status;
  const unread = () => props.session()?.unread === true;
  const working = () => status() === "working" || status() === "blocked";
  const blocked = () => status() === "blocked";
  const failed = () => status() === "failed" || status() === "interrupted";
  return (
    <>
      <Presence show={working() && !blocked()} accessibilityLabel={tr("Running in the background", "后台运行中")}>
        <Pip size={14} mood="work" />
      </Presence>
      <Presence
        show={blocked()}
        accessibilityLabel={tr("Waiting for confirmation", "等待确认")}
        class="absolute inset-0 items-center justify-center"
      >
        <Icon name="clock" size={12} tone="warning" />
      </Presence>
      <Presence
        show={failed()}
        accessibilityLabel={status() === "interrupted" ? tr("Interrupted", "已中断") : tr("Failed", "已失败")}
        class="absolute inset-0 items-center justify-center"
      >
        <Icon name="alert" size={12} tone="destructive" />
      </Presence>
      <Presence
        show={!working() && !failed() && unread()}
        accessibilityLabel={tr("Finished in the background", "后台已完成")}
        class="absolute inset-0 items-center justify-center"
      >
        <View class="size-1.5 rounded-full bg-brand" />
      </Presence>
    </>
  );
}

/** What one tab names itself: the live title for the open session, the store's for the rest. */
function tabTitle(tab: OpenTab): string {
  if (tab.kind === "doc") return docTabTitle(tab.ref);
  if (activeTabId() === tabId(tab) && currentView().name === "chat") return currentTitle();
  return chatTabTitle(tab);
}

export function TabBar() {
  const pillRefs = new Map<string, ViewRef>();
  /** Each pill's animated channels, keyed by tab id. */
  const pillAnims = new Map<string, PillAnim>();
  /** A press that has not travelled far enough to lift a drag yet. */
  let mouseArm: { id: string; x: number } | null = null;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  /** The tab a press lifted into a drag: its release is a drop, not a click — reordering must not also select it. */
  let draggedId: string | null = null;
  /** The drag in flight — a signal so the lifted pill's look and transform swap the moment it lifts. */
  const dragSig = signal<{ id: string } | null>(null);
  const drag = () => dragSig();
  /** The slot offsets the drag currently wants the other pills at. */
  const dragShifts = signal<Record<string, number>>({});
  /** Targets kept through a drop's settle: rebased on the commit, these finish the springs. */
  const settle = signal<Record<string, number> | null>(null);
  /** A drop's settle; a newer drag supersedes the callbacks of an older one. */
  let settleGen = 0;
  /** Trackpad wheel travel and the last switch's time, for "one swipe one tab". */
  let wheelAcc = 0;
  let wheelLast = 0;

  /** The strip's pills measured at lift, in scroll-content coordinates. */
  let dragFrames: PillFrame[] = [];
  /** The lifted order's signature: a strip change under the drag cancels it. */
  let dragIds = "";
  let dragOwnLeft = 0;
  let dragOwnWidth = 0;
  /** The dragged pill's committed layout move if dropped now. */
  let dragDeltaX = 0;
  /** The insertion the pills' flow shows (`dragTargetSet` says it differs from the current order). */
  let dragTargetSet = false;
  let dragTargetIndex = 0;

  /** The pointer's page-x, where it lifted, and the scroll offset it lifted at. */
  let lastPageX = Number.NaN;
  let dragStartX = Number.NaN;
  let dragStartScrollX = 0;
  /** The strip's scroll offset, live (`onScroll`), and the furthest a drag may take it. */
  let stripScroll: ScrollRef | null = null;
  let scrollX = 0;
  let dragScrollMax = 0;
  /** The strip's viewport (page coordinates) and the pill's own page-y band, for the escape margin. */
  let dragViewportLeft = 0;
  let dragViewportWidth = 0;
  let dragTop = 0;
  let dragBottom = 0;
  /** The drag's input path: the pointer that lifted it, or the pill's touch claim. */
  let dragVia: "pointer" | "touch" = "pointer";
  let dragStarting = false;
  /** The edge-scroll loop's frame and its last tick. */
  let edgeFrame: number | undefined;
  let edgeAt = 0;

  function springTo(value: AnimatedValue, to: number, spring: { stiffness: number; damping: number; mass: number }) {
    if (reduceMotion()) {
      value.set(to);
      return Promise.resolve({ finished: true });
    }
    return value.spring(to, spring);
  }

  function pillSpring(row: PillAnim, target: number) {
    if (row.shiftTarget === target) return row.shiftRun;
    row.shiftTarget = target;
    row.shiftRun = springTo(row.shift, target, FLOW_SPRING);
    return row.shiftRun;
  }

  function pillLift(row: PillAnim, target: number) {
    if (row.liftTarget === target) return row.liftRun;
    row.liftTarget = target;
    row.liftRun = springTo(row.lift, target, target ? LIFT_SPRING : DROP_SPRING);
    return row.liftRun;
  }

  /** Folds offsets a previous drop left (or a settle still finishing) into their values, at rest. */
  function normalizePill(row: PillAnim) {
    void row.shift.stop();
    void row.dragX.stop();
    row.shift.flattenOffset();
    row.dragX.flattenOffset();
    row.shiftTarget = 0;
    row.shiftRun = springTo(row.shift, 0, FLOW_SPRING);
  }

  // ── The strip's own flow ──────────────────────────────────────────────────
  //
  // A tab that opens or closes changes the others' places. Each pill that
  // stays starts from where it stood (its old slot, as an offset from the new
  // one) and springs home on the drag's own flow spring; the "+" rides the
  // strip's end the same way. A new pill is in its slot from its first frame
  // and only fades in. Nothing is animated that the reader did not just see
  // happen: the strip a launch restores is simply there.
  const STRIDE = TAB_W + TAB_GAP;
  const flowing = signal(false);
  const plusShift = createAnimatedValue(0);
  let stripIds: string[] = untracked(() => openTabs().map((t) => tabId(t)));
  /** Pills this change added: whichever runs first, the effect or the pill's mount, the pill knows it is new. */
  const bornIds = new Set<string>();
  let stripSeeded = false;
  let flowTimer: ReturnType<typeof setTimeout> | undefined;
  effect(() => {
    if (!prefsReady() || stripSeeded) return;
    // After the restored strip (set in this same turn) has mounted.
    const timer = setTimeout(() => (stripSeeded = true), 0);
    cleanup(() => clearTimeout(timer));
  });
  cleanup(() => clearTimeout(flowTimer));
  effect(() => {
    const ids = openTabs().map((t) => tabId(t));
    untracked(() => {
      const before = stripIds;
      stripIds = ids;
      const added = ids.filter((id) => !before.includes(id));
      const removed = before.filter((id) => !ids.includes(id));
      // A reorder is the drag's own motion (its drop rebases the offsets); only membership flows here.
      if ((!added.length && !removed.length) || !stripSeeded || reduceMotion() || drag() || settle()) return;
      bornIds.clear();
      for (const id of added) bornIds.add(id);
      queueMicrotask(() => bornIds.clear());
      let moved = false;
      ids.forEach((id, index) => {
        const stood = before.indexOf(id);
        const row = pillAnims.get(id);
        if (stood < 0 || stood === index || !row) return;
        void row.shift.stop();
        row.shift.set((stood - index) * STRIDE);
        row.shiftTarget = Number.NaN;
        void pillSpring(row, 0);
        moved = true;
      });
      const plus = (before.length - ids.length) * STRIDE;
      if (plus) {
        void plusShift.stop();
        plusShift.set(plus);
        void springTo(plusShift, 0, FLOW_SPRING);
        moved = true;
      }
      if (!moved) return;
      flowing.set(true);
      clearTimeout(flowTimer);
      flowTimer = setTimeout(() => flowing.set(false), FLOW_REST_MS);
    });
  });

  /** A press went down on a pill; a still press lifts it after `DRAG_HOLD_MS`. */
  function armPress(id: string, x: number) {
    disarmPress();
    mouseArm = { id, x };
    holdTimer = setTimeout(() => {
      holdTimer = undefined;
      const arm = mouseArm;
      if (!arm || drag() || dragStarting) return;
      void beginDrag(arm.id, "pointer");
    }, DRAG_HOLD_MS);
  }

  function disarmPress() {
    if (holdTimer !== undefined) clearTimeout(holdTimer);
    holdTimer = undefined;
    mouseArm = null;
  }

  /** Measures the strip once and lifts the pill; a release before the measure lands is dropped. */
  async function beginDrag(id: string, via: "pointer" | "touch") {
    if (drag() || dragStarting) return;
    dragStarting = true;
    dragVia = via;
    const armX = mouseArm?.x ?? Number.NaN;
    disarmPress();
    draggedId = id;
    settleGen++;
    settle.set(null);
    for (const row of pillAnims.values()) normalizePill(row);
    const ids = openTabs().map((t) => tabId(t));
    // The lifted order's signature lands with the lift itself: the re-layout
    // guard reads it before the measure resolves, not after.
    dragIds = ids.join("\n");
    batch(() => {
      dragShifts.set({});
      dragSig.set({ id });
    });
    const [viewBox, ...measured] = await Promise.all([
      stripScroll?.measure().catch(() => null),
      ...ids.map(async (tid) => {
        const m = await pillRefs.get(tid)?.measure().catch(() => null);
        return m
          ? { id: tid, pageX: m.pagePosition.x, pageY: m.pagePosition.y, width: m.bounds.size.width, height: m.bounds.size.height }
          : null;
      }),
    ]);
    dragStarting = false;
    const d = drag();
    if (d?.id !== id) return;
    dragViewportLeft = viewBox ? viewBox.pagePosition.x : 0;
    dragViewportWidth = viewBox ? viewBox.bounds.size.width : 0;
    dragStartScrollX = scrollX;
    const mine = measured.find((m) => m?.id === id);
    const frames = measured
      .filter((m): m is NonNullable<typeof m> => m !== null)
      .map((m) => ({ id: m.id, left: m.pageX - dragViewportLeft + dragStartScrollX, width: m.width }))
      .sort((a, b) => a.left - b.left);
    if (!mine || !frames.some((f) => f.id === id)) {
      finishDrag(false);
      return;
    }
    dragFrames = frames;
    dragOwnLeft = frames.find((f) => f.id === id)!.left;
    dragOwnWidth = mine.width;
    dragTop = mine.pageY;
    dragBottom = mine.pageY + mine.height;
    // Edge scrolling stops once the last pill reaches the strip's end.
    const last = frames[frames.length - 1];
    dragScrollMax = Math.max(0, last.left + last.width + 12 - dragViewportWidth);
    dragStartX = Number.isFinite(lastPageX)
      ? lastPageX
      : Number.isFinite(armX)
        ? armX
        : mine.pageX + mine.width / 2;
    dragTargetSet = false;
    dragTargetIndex = frames.findIndex((f) => f.id === id);
    dragDeltaX = 0;
    syncDragPosition();
    updateDragTarget(dragStartX);
    startEdgeScroll();
  }

  /** The lifted pill follows the pointer: its own move plus the content scrolled under it. */
  function syncDragPosition() {
    const d = drag();
    if (!d || !Number.isFinite(lastPageX) || !Number.isFinite(dragStartX)) return;
    const row = pillAnims.get(d.id);
    if (!row) return;
    const first = dragFrames[0];
    const last = dragFrames[dragFrames.length - 1];
    const min = first ? first.left - dragOwnLeft : -Infinity;
    const max = last ? last.left + last.width - (dragOwnLeft + dragOwnWidth) : Infinity;
    row.dragX.set(Math.max(min, Math.min(max, lastPageX - dragStartX + (scrollX - dragStartScrollX))));
  }

  /** Where `pageX` would drop the pill: the midpoint of each measured pill cuts it in two. */
  function updateDragTarget(pageX: number) {
    const d = drag();
    const frames = dragFrames;
    if (!d || !frames.length || !Number.isFinite(pageX)) return;
    const contentX = pageX - dragViewportLeft + scrollX;
    const others = frames.filter((f) => f.id !== d.id);
    let insertion = others.length;
    for (let i = 0; i < others.length; i++) {
      if (contentX < others[i].left + others[i].width / 2) {
        insertion = i;
        break;
      }
    }
    if (dragTargetSet && dragTargetIndex === insertion) return;
    const order = others.map((f) => f.id);
    order.splice(insertion, 0, d.id);
    const current = frames.map((f) => f.id);
    if (order.every((id, i) => id === current[i])) {
      dragTargetSet = false;
      dragDeltaX = 0;
      dragShifts.set({});
      return;
    }
    // Lay the new order on the slots the strip has now: each slot keeps the
    // gap that follows it in the real layout.
    const widthOf = new Map(frames.map((f) => [f.id, f.width]));
    const lefts = new Map<string, number>();
    let left = frames[0].left;
    for (let p = 0; p < order.length; p++) {
      const oid = order[p];
      lefts.set(oid, left);
      const gap = frames[p + 1] ? Math.max(0, frames[p + 1].left - (frames[p].left + frames[p].width)) : 0;
      left += (widthOf.get(oid) ?? frames[p].width) + gap;
    }
    dragTargetSet = true;
    dragTargetIndex = insertion;
    dragDeltaX = (lefts.get(d.id) ?? dragOwnLeft) - dragOwnLeft;
    const shifts: Record<string, number> = {};
    for (const f of others) shifts[f.id] = (lefts.get(f.id) ?? f.left) - f.left;
    dragShifts.set(shifts);
  }

  /**
   * Ends the drag: a committed drop applies the order the flow last showed.
   * Every pill is rebased by the slot the commit gives it before the order
   * lands, so the natural layout jumps under offsets that cancel it; the
   * springs finish toward the targets the drag had them at, then fold the
   * offsets away in place.
   */
  function finishDrag(commit: boolean) {
    const d = untracked(drag);
    const frames = dragFrames;
    const shifts = untracked(dragShifts);
    stopEdgeScroll();
    if (!d) {
      batch(() => {
        settle.set(null);
        dragShifts.set({});
        dragTargetSet = false;
      });
      disarmPress();
      return;
    }
    const gen = ++settleGen;
    const dragged = pillAnims.get(d.id);
    const delta = dragDeltaX;
    const changed = commit && dragTargetSet;
    if (changed && dragged) {
      for (const f of frames) {
        const row = pillAnims.get(f.id);
        if (!row) continue;
        if (f.id === d.id) row.dragX.setOffset(-delta);
        else row.shift.setOffset(-(shifts[f.id] ?? 0));
      }
      const targets = { ...shifts };
      batch(() => {
        settle.set(targets);
        dragFrames = [];
        dragShifts.set({});
        dragTargetSet = false;
        dragSig.set(null);
        moveTab(d.id, dragTargetIndex);
      });
      finishLift(dragged, delta, gen);
      const jobs: Promise<unknown>[] = [];
      for (const f of frames) {
        if (f.id === d.id) continue;
        const row = pillAnims.get(f.id);
        if (!row) continue;
        jobs.push(
          pillSpring(row, targets[f.id] ?? 0).then(() => {
            if (gen !== settleGen) return;
            row.shift.flattenOffset();
            row.shiftTarget = 0;
          }),
        );
      }
      void Promise.all(jobs).then(() => {
        if (gen === settleGen) settle.set(null);
      });
      return;
    }
    // A cancelled drag, or a drop that changes nothing: every pill flows home.
    const homeTargets: Record<string, number> = {};
    for (const f of frames) if (f.id !== d.id) homeTargets[f.id] = 0;
    batch(() => {
      settle.set(frames.some((f) => f.id !== d.id) ? homeTargets : null);
      dragFrames = [];
      dragShifts.set({});
      dragTargetSet = false;
      dragSig.set(null);
    });
    if (dragged) finishLift(dragged, 0, gen);
    const homeJobs: Promise<unknown>[] = [];
    for (const f of frames) {
      if (f.id === d.id) continue;
      const row = pillAnims.get(f.id);
      if (!row) continue;
      homeJobs.push(
        pillSpring(row, 0).then(() => {
          if (gen !== settleGen) return;
          row.shift.flattenOffset();
          row.shiftTarget = 0;
        }),
      );
    }
    if (homeJobs.length) {
      void Promise.all(homeJobs).then(() => {
        if (gen !== settleGen) return;
        settle.set(null);
      });
    }
  }

  /** Lands the lifted pill: the drop's spring and the lift's fade, then its offsets fold away in place. */
  function finishLift(row: PillAnim, delta: number, gen: number) {
    const liftDone = pillLift(row, 0);
    if (reduceMotion()) {
      row.dragX.setOffset(0);
      row.dragX.set(0);
      void liftDone.then(() => {
        if (gen === settleGen) row.setLifted(false);
      });
      return;
    }
    void Promise.all([row.dragX.spring(delta, DROP_SPRING), liftDone]).then(() => {
      if (gen !== settleGen) return;
      row.dragX.flattenOffset();
      row.setLifted(false);
    });
  }

  /** A mouse release anywhere ends a pointer drag (or disarms one that never lifted). */
  function endPointerDrag() {
    if (drag() && dragVia === "pointer") finishDrag(true);
    else if (!drag()) disarmPress();
  }

  /** The pointer's page-y left the pill's band by the escape margin: the drag is called off. */
  const escaped = (pageY: number) => pageY < dragTop - DRAG_ESCAPE_Y || pageY > dragBottom + DRAG_ESCAPE_Y;

  function stopEdgeScroll() {
    if (edgeFrame !== undefined) cancelAnimationFrame(edgeFrame);
    edgeFrame = undefined;
    edgeAt = 0;
  }

  function startEdgeScroll() {
    if (edgeFrame !== undefined || !drag()) return;
    edgeAt = 0;
    edgeFrame = requestAnimationFrame(edgeTick);
  }

  function edgeTick() {
    edgeFrame = undefined;
    if (!drag() || !Number.isFinite(lastPageX) || dragViewportWidth <= 0) return;
    const fromLeft = lastPageX - dragViewportLeft;
    const fromRight = dragViewportLeft + dragViewportWidth - lastPageX;
    const closeness = (distance: number) => Math.min(1, Math.max(0, (DRAG_EDGE - distance) / DRAG_EDGE));
    let speed = 0;
    if (fromLeft < DRAG_EDGE) speed = -DRAG_EDGE_SPEED * closeness(Math.max(0, fromLeft));
    else if (fromRight < DRAG_EDGE) speed = DRAG_EDGE_SPEED * closeness(Math.max(0, fromRight));
    if (!speed) {
      edgeAt = 0;
      return;
    }
    const now = Date.now();
    const dt = edgeAt ? Math.min(64, now - edgeAt) : 16;
    edgeAt = now;
    const max = Math.max(scrollX, dragScrollMax);
    const next = Math.min(max, Math.max(0, scrollX + (speed * dt) / 1000));
    if (Math.abs(next - scrollX) < 0.25) return;
    stripScroll?.scrollTo({ x: next, animated: false });
    edgeFrame = requestAnimationFrame(edgeTick);
  }

  const onWheel = (e: WheelEvent) => {
    if (openTabs().length < 2) return;
    const d = Math.abs(e.delta.y) >= Math.abs(e.delta.x) ? e.delta.y : e.delta.x;
    if (e.deltaMode === "lines") {
      cycleTab(d > 0 ? 1 : -1);
      return;
    }
    if (Math.sign(d) !== Math.sign(wheelAcc)) wheelAcc = 0;
    wheelAcc += d;
    const now = Date.now();
    if (Math.abs(wheelAcc) >= WHEEL_TAB_PX && now - wheelLast > WHEEL_THROTTLE_MS) {
      wheelLast = now;
      cycleTab(wheelAcc > 0 ? 1 : -1);
      wheelAcc = 0;
    }
  };

  // The active tab always stays in view: a rename or a status mark that widened
  // its pill, or a click on a half-hidden tab, never leaves it clipped.
  effect(() => {
    const active = activeTabId();
    if (!active || drag() || settle()) return;
    const pill = pillRefs.get(active);
    if (!pill) return;
    // A pill mounted in this commit takes no reveal until it is laid out:
    // `measure` resolves then, `null` if it has left the tree instead.
    void pill.measure().then((m) => {
      if (m && untracked(activeTabId) === active) {
        pill.reveal({ horizontal: "nearest", animated: !untracked(reduceMotion) });
      }
    });
  });

  // The strip changed under the drag's measured pills: a drop can no longer be
  // trusted to land where the flow says.
  effect(() => {
    const ids = openTabs()
      .map((t) => tabId(t))
      .join("\n");
    if (drag() && ids !== dragIds) finishDrag(false);
  });

  // Escape is the drag's while one is in flight: it hands the pills back
  // (newest binding wins, so it does not also stop a run).
  effect(() => {
    if (!drag()) return;
    cleanup(keymap.bind("escape", () => finishDrag(false), { when: "always" }));
  });

  function menuItems(tab: OpenTab): MenuItem[] {
    const id = tabId(tab);
    const items: MenuItem[] = [];
    if (tab.kind === "chat" && activeTabId() === id && tab.ref) {
      items.push({
        label: tr("Rename…", "重命名…"),
        disabled: sidecarPhase().name !== "ready",
        onSelect: () => startRenaming(),
      });
    }
    if (tab.preview) items.push({ label: tr("Keep Open", "保持打开"), onSelect: () => keepTab(id) });
    items.push({ label: tr("Close Tab", "关闭标签页"), onSelect: () => closeTab(id) });
    if (openTabs().length > 1) {
      items.push({
        label: tr("Close Other Tabs", "关闭其他标签页"),
        onSelect: () => {
          for (const t of openTabs()) if (tabId(t) !== id) closeTab(tabId(t));
        },
      });
    }
    if (tab.kind === "doc") {
      items.push({ type: "separator" });
      items.push({ label: tr("Add to Chat", "添加到会话"), onSelect: () => void addNoteToChat(tab.ref) });
      items.push({
        label: tr("Copy Path", "复制路径"),
        onSelect: () => void Clipboard.writeText(tab.ref),
      });
    }
    return items;
  }

  /** The rename field inside the active chat tab's pill (the title bar's old input, moved into the tab). */
  function RenameField() {
    const name = signal(sessionState()?.sessionName ?? currentTitle());
    const anchor = signal<InputRef | undefined>(undefined);
    const commit = () => {
      if (isRenaming()) void renameSession(name());
    };
    return (
      <>
        <Input
          ref={(ref) => {
            if (ref) anchor.set(ref);
          }}
          value={name()}
          onChange={({ value }) => name.set(value)}
          onSubmit={commit}
          onBlur={commit}
          autoFocus
          scrollbar={false}
          accessibilityLabel={tr("Session name", "会话名称")}
          placeholder={tr("Name this session", "为会话命名")}
          class={`h-6 w-30 rounded corner-squircle px-1.5 text-sm font-medium text-foreground caret-brand placeholder:text-subtle ${FIELD_SURFACE}`}
        />
        <If when={anchor()}>
          {(field) => <Overlay anchor={field()} onPressOutside={commit} onCancel={cancelRenaming} />}
        </If>
      </>
    );
  }

  function TabPill(props: { tab: () => OpenTab }) {
    const id = () => tabId(props.tab());
    /** The page-x the current touch went down on (the lift's travel check). */
    let touchX0 = 0;
    const active = () => activeTabId() === id();
    const session = () => chatTabSession(props.tab());
    const renaming = () => isRenaming() && active() && props.tab().kind === "chat";
    const dragging = () => drag()?.id === id();
    const shift = createAnimatedValue(0);
    const dragX = createAnimatedValue(0);
    const lift = createAnimatedValue(0);
    const lifted = signal(false);
    const row: PillAnim = {
      id: id(),
      shift,
      dragX,
      lift,
      setLifted: (on) => lifted.set(on),
      shiftTarget: 0,
      shiftRun: Promise.resolve({ finished: true }),
      liftTarget: 0,
      liftRun: Promise.resolve({ finished: true }),
    };
    pillAnims.set(id(), row);
    cleanup(() => {
      pillAnims.delete(id());
      void shift.stop();
      void dragX.stop();
      void lift.stop();
    });
    const liftScale = lift.interpolate({ inputRange: [0, 1], outputRange: [1, 1.03] });
    const liftOpacity = lift.interpolate({ inputRange: [0, 1], outputRange: [1, 0.95] });
    /** Whether this pill has anything moving: the drag, a drop settling, or its own flight home. */
    const live = () => drag() !== null || settle() !== null || lifted() || flowing();
    /** A pill the reader just saw open fades in, in its slot from the first frame. */
    const fresh = untracked(() => stripSeeded && !reduceMotion() && (bornIds.has(id()) || !stripIds.includes(id())));
    const born = createAnimatedValue(fresh ? 0 : 1);
    if (fresh) void born.timing(1, { duration: DURATION.fast, easing: EASING.entrance });
    cleanup(() => void born.stop());
    const liveStyle = () => {
      if (!live()) return { opacity: born };
      return {
        zIndex: lifted() ? 30 : undefined,
        transform: [{ translateX: shift }, { translateX: dragX }, { scale: liftScale }],
        opacity: lifted() ? liftOpacity : born,
      };
    };
    const targetShift = () => {
      const s = settle();
      if (s !== null) return s[id()] ?? 0;
      return dragShifts()[id()] ?? 0;
    };
    effect(() => {
      const target = targetShift();
      untracked(() => void pillSpring(row, target));
    });
    effect(() => {
      const on = dragging();
      untracked(() => {
        if (on) {
          lifted.set(true);
          void pillLift(row, 1);
        } else if (lifted()) {
          void pillLift(row, 0);
        }
      });
    });
    return (
      <View
        ref={(ref) => {
          if (ref) pillRefs.set(id(), ref);
          else pillRefs.delete(id());
        }}
        testID={`tab-${openTabs().findIndex((t) => tabId(t) === id())}`}
        role="tab"
        accessibilityLabel={tabTitle(props.tab())}
        accessibilityState={{ selected: active() }}
        class="group relative h-7 shrink-0 flex-row items-center rounded-md corner-squircle pl-2 pr-1"
        style={{ width: TAB_W, ...liveStyle() }}
        onPressDown={(e) => {
          draggedId = null;
          if (e.clickCount >= 2) {
            // A double press on a tab only looked at keeps it; on one that is
            // kept it renames the chat it is already on — renaming follows
            // the open session, so other tabs only select.
            selectTab(props.tab());
            if (props.tab().preview) {
              keepTab(id());
              return;
            }
            if (active() && props.tab().kind === "chat" && props.tab().ref && sidecarPhase().name === "ready") startRenaming();
            return;
          }
          lastPageX = e.pagePosition.x;
          armPress(id(), e.pagePosition.x);
        }}
        onPress={() => {
          if (draggedId === id()) {
            draggedId = null;
            return;
          }
          selectTab(props.tab());
        }}
        onPressUp={endPointerDrag}
        onMouseUp={(e) => {
          if (e.button === "middle") closeTab(id());
        }}
        onContextMenu={(e: ContextMenuEvent) => Menu.popup(menuItems(props.tab()), e.pagePosition)}
        panActivation={{ activeOffsetX: DRAG_CLAIM_X, failOffsetY: DRAG_CLAIM_X }}
        onTouchStart={(e: GestureResponderEvent) => {
          touchX0 = e.pageX;
          lastPageX = e.pageX;
        }}
        onTouchMove={(e: GestureResponderEvent) => {
          lastPageX = e.pageX;
          const d = drag();
          if (!d) {
            if (Math.abs(e.pageX - touchX0) > DRAG_ARM_X) void beginDrag(id(), "touch");
            return;
          }
          if (d.id !== id()) return;
          if (escaped(e.pageY)) {
            finishDrag(false);
            return;
          }
          syncDragPosition();
          updateDragTarget(e.pageX);
          startEdgeScroll();
        }}
        onTouchEnd={() => {
          if (drag()?.id === id()) finishDrag(true);
          else if (!drag()) disarmPress();
        }}
        onTouchCancel={() => {
          if (drag()?.id === id()) finishDrag(false);
          else if (!drag()) disarmPress();
        }}
      >
        {/* The lifted pill's own surface: its shadow rides in with the lift, under the pill's fill. */}
        <If when={live()}>
          <View
            testID={dragging() ? "tab-drag-lift" : undefined}
            class="pointer-events-none absolute inset-0 rounded-md corner-squircle bg-card shadow-raised"
            style={{ opacity: lift }}
          />
        </If>
        {/* Fill: the active tab's card, hover on the rest — under everything in the pill. */}
        <View
          class={`pointer-events-none absolute inset-0 rounded-md corner-squircle transition-colors duration-150 ease-out-quint motion-reduce:transition-none ${
            active() ? "bg-card" : "group-hover:bg-accent"
          }`}
        />
        {props.tab().kind === "chat" ? (
          session()?.agentId ? (
            <AgentLogo id={session()!.agentId} size={14} tone={active() ? "foreground" : "muted-foreground"} class="shrink-0" />
          ) : (
            <Icon name={props.tab().ref ? "terminal" : "pencil"} size={13} tone={active() ? "foreground" : "subtle"} class="shrink-0" />
          )
        ) : (
          <Icon name="file" size={13} tone={active() ? "foreground" : "subtle"} class="shrink-0" />
        )}
        <If when={renaming()} else={<Text class={`mx-1.5 min-w-0 flex-1 truncate text-sm font-medium ${props.tab().preview ? "italic" : ""}`}>{tabTitle(props.tab())}</Text>}>
          <RenameField />
        </If>
        {/* Trailing slot: status mark at rest, the close control over it on hover (or always on the active tab). */}
        <View class="relative size-4 shrink-0 items-center justify-center">
          {/* A document carries no mark: it is saved as it is written, and a dot that came and went with every pause would say otherwise. */}
          {props.tab().kind === "chat" ? <StatusMark session={session} /> : null}
          <BaseButton
            onPress={() => closeTab(id())}
            tooltip={tip(tr("Close tab", "关闭标签页"))}
            accessibilityLabel={tr("Close tab", "关闭标签页")}
            class={`absolute inset-0 items-center justify-center rounded transition-opacity ${PRESS} ${
              active() ? "opacity-60 hover:opacity-100" : "opacity-0 group-hover:opacity-100"
            }`}
          >
            <Icon name="x" size={11} tone="muted-foreground" />
          </BaseButton>
        </View>
        {/* The active mark: a short brand underline inside the pill's foot — it grows in and out, never blinks. */}
        <Presence show={active()} scaleFrom={0.4} class="pointer-events-none absolute inset-x-3 bottom-0 h-0.5">
          <View class="h-0.5 rounded-full bg-brand" />
        </Presence>
      </View>
    );
  }

  function newMenu() {
    void Menu.popup([
      { label: tr("New Session", "新建会话"), shortcut: "mod+n", onSelect: () => void newSession() },
      { label: tr("New Document", "新建文档"), shortcut: "mod+shift+n", onSelect: () => void newDocTab() },
      { type: "separator" },
      { label: tr("Open Markdown File…", "打开 Markdown 文件…"), onSelect: () => void pickDocTab() },
    ]);
  }

  const parent = () => currentParentSession();
  const worktree = () => currentDaemonSession()?.worktree;
  const chatActive = () => currentView().name === "chat";

  return (
    <View
      desktop={{ windowDrag: true }}
      class={`absolute inset-x-0 top-0 z-20 flex-row items-center gap-1 pr-3 ${wallpaper() ? "" : HEADER_GLASS}`}
      style={{
        ...(wallpaper() ? undefined : GLASS_REGULAR),
        height: titleBar().height || 44,
        paddingLeft: sidebarOpen() ? 12 : (titleBar().left ? titleBar().left + 12 : 12),
      }}
      onMouseMove={(e: MouseEvent) => {
        lastPageX = e.pagePosition.x;
        if (e.pressedButton === "left") {
          const arm = mouseArm;
          if (!drag() && arm && Math.abs(e.pagePosition.x - arm.x) > DRAG_ARM_X) void beginDrag(arm.id, "pointer");
          if (drag() && dragVia === "pointer") {
            if (escaped(e.pagePosition.y)) {
              finishDrag(false);
              return;
            }
            syncDragPosition();
            updateDragTarget(e.pagePosition.x);
            startEdgeScroll();
          }
        } else if (e.pressedButton === null) {
          // The button let go where no release was heard (a drag released off window).
          if (drag() && dragVia === "pointer") finishDrag(true);
          else if (!drag()) disarmPress();
        }
      }}
      onMouseUp={endPointerDrag}
      onWheel={(e) => {
        if (!drag()) onWheel(e);
      }}
      onFileDrop={(e) => {
        for (const uri of e.uris) {
          const path = uri.replace(/^file:\/\//, "");
          if (/\.(md|markdown|mdown|txt)$/i.test(path)) openDocTab(decodeURIComponent(path));
        }
      }}
    >
      <Presence show={!sidebarOpen()} scaleFrom={0.92} class="shrink-0 flex-row items-center gap-1">
        <IconButton icon="sidebar" label={tr("Show sidebar", "显示侧边栏")} shortcut="mod+b" onPress={() => setSidebarOpen(true)} />
        <IconButton icon="pencil" label={tr("New session", "新建会话")} shortcut="mod+n" onPress={() => void newSession()} />
      </Presence>
      <Scroll
        ref={(ref) => {
          stripScroll = ref;
        }}
        horizontal
        role="tablist"
        class="min-w-0 flex-1"
        contentClass="flex-row items-center gap-1 px-1"
        onScroll={(e) => {
          // The strip moved under the drag's measured pills: the pointer's
          // place in the content changed with it, so the follow and the target do too.
          scrollX = e.offset.x;
          if (drag()) {
            syncDragPosition();
            updateDragTarget(lastPageX);
          }
        }}
      >
        <Each of={openTabs()} key={(tab) => tabId(tab)}>
          {(tab) => <TabPill tab={tab} />}
        </Each>
        <View class="shrink-0" style={{ transform: [{ translateX: plusShift }] }}>
          <IconButton
            icon="plus"
            size="sm"
            label={tr("New tab", "新建标签页")}
            onPress={newMenu}
            class="my-0.5 shrink-0"
          />
        </View>
      </Scroll>
      {/* The open session's context, kept from the old title bar — only while a chat tab is active. */}
      <If when={chatActive()}>
        <View class="min-w-0 shrink flex-row items-center gap-1">
          <Presence show={!!parent()} class="shrink-0">
            <If when={parent()}>
              {(up) => (
                <BaseButton
                  onPress={() => openDaemonSession(up().id)}
                  tooltip={tip(tr(`Back to ${up().title}`, `回到 ${up().title}`))}
                  class={`h-6 max-w-44 shrink-0 flex-row items-center gap-1 rounded-md corner-squircle bg-muted px-1.5 ${PRESS} hover:bg-accent`}
                >
                  <Icon name="arrowLeft" size={12} tone="subtle" />
                  <Text class="shrink truncate text-2xs text-muted-foreground">{up().title}</Text>
                </BaseButton>
              )}
            </If>
          </Presence>
          <Presence show={isCurrentSessionArchived()}>
            <Chip
              testID="titlebar-archived-chip"
              label={tr("Archived", "已归档")}
              icon="unarchive"
              tipText={tr("Unarchive session", "取消归档此会话")}
              onPress={unarchiveCurrentSession}
              class="shrink-0 bg-muted text-muted-foreground"
            />
          </Presence>
          <Presence show={!!worktree()}>
            <If when={worktree()}>
              {(wt) => (
                <BaseButton
                  onPress={() => void openWorkspace(wt().path)}
                  tooltip={tip(tr(`Open worktree ${wt().path}`, `打开工作树目录 ${wt().path}`))}
                  class={`h-6 max-w-36 shrink-0 flex-row items-center gap-1 rounded-md corner-squircle bg-muted px-1.5 ${PRESS} hover:bg-accent`}
                >
                  <Icon name="fork" size={11} tone="subtle" />
                  <Text class="shrink truncate font-mono text-2xs text-muted-foreground">{wt().branch}</Text>
                </BaseButton>
              )}
            </If>
          </Presence>
        </View>
      </If>
    </View>
  );
}
