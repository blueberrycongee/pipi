import { cleanup, createAnimatedValue, effect, reduceMotion, Scroll, signal, Text, untracked, View } from "nsh";
import type { JSX } from "nsh";
import { Collapsible, TextView } from "nsh/base";
import { Menu } from "nsh/desktop";
import { clip, duration } from "../lib/format";
import { activeLanguage, tr } from "../lib/i18n";
import type { Row, ToolRow } from "../pi/transcript";
import {
  type ActivityRow,
  describeActiveStep,
  describeActivity,
  describeToolCall,
  describeToolsSummary,
  describeTurn,
  classifyTool,
  type DiffStats,
  type DisplayRow,
  thinkingLabel,
  type TurnHeaderRow,
} from "../pi/turns";
import { conversationKey, copyMessage, copyText, daemonSessionOfId, forkFrom, openDaemonSession, transcriptRows } from "../store/app";
import { IconButton } from "../ui/Button";
import { Icon, type IconName } from "../ui/Icon";
import { EASING, keepLast, Presence, useBreathingOpacity, useRowEntrance } from "../ui/motion";
import { RollingText } from "../ui/RollingText";
import { FOCUS_RING, PRESS } from "../ui/styles";
import { clearProseState, PROSE, ProseBlock, type ProseRow } from "./Prose";

/**
 * The rows of the chat. `List` recycles its cells, so every row reads its
 * reactive props inside effects/accessors and keeps expand/collapse state in
 * module-level maps keyed by stable row or fold ID.
 */

/**
 * What the reader folded and unfolded, by conversation and by row. A press is
 * the only thing that writes here, and what it wrote holds: through the run
 * going on and ending, the next message, a change of session and back.
 *
 * The conversation is the one the rows on screen belong to (`conversationKey`,
 * set in the same turn as the rows), never the agent's word on its session,
 * which lags a session change: no conversation is shown under another's folds,
 * and one shown again has its own with the click. Its rows are found again by
 * their ids, which a conversation keeps when it is loaded again (`Transcript.adopt`).
 */
const choices = signal<Record<number, Record<string, boolean>>>({});

/** What the reader said on a fold, if they pressed it. */
const chosen = (id: string): boolean | undefined => choices()[conversationKey()]?.[id];

function choose(id: string, open: boolean, also?: string) {
  const key = untracked(conversationKey);
  choices.update((all) => ({ ...all, [key]: { ...all[key], [id]: open, ...(also ? { [also]: open } : {}) } }));
}

/** Whether a disclosure shows its body: explicit user choice wins, else `fallback`. */
const isOpen = (id: string, fallback: boolean) => chosen(id) ?? fallback;
/**
 * What the chat does before a fold the reader pressed opens or closes: it lets
 * go of the end, so the list keeps its offset and the row pressed stays under
 * the pointer while what follows it moves (the folds). Following, the list
 * would keep its end in place and push the pressed row up instead.
 */
let anchorFold: () => void = () => {};
export function onFoldToggle(anchor: () => void) {
  anchorFold = anchor;
}

const toggle = (id: string, fallback: boolean) => {
  anchorFold();
  choose(id, !untracked(() => isOpen(id, fallback)));
};

let foldSettled: () => void = () => {};
export function onFoldSettled(fn: () => void) {
  foldSettled = fn;
}

/** The rows each turn's fold shows, by row id, with their place among them: set by the chat with every projection. */
let processTurns = new Map<string, { turn: string; at: number }>();
export function setProcessTurns(rows: ReadonlyMap<string, string>) {
  const next = new Map<string, { turn: string; at: number }>();
  const counts = new Map<string, number>();
  for (const [id, turn] of rows) {
    const at = counts.get(turn) ?? 0;
    counts.set(turn, at + 1);
    next.set(id, { turn, at });
  }
  processTurns = next;
}

/**
 * Per-turn scoped fold lifecycle (both auto-fold on answer arrival and manual
 * toggle on `TurnHeaderView`). Uses `Collapsible`'s scoped native spring
 * (`Spring::new(180)`, ~265ms critically damped) per process row instead of
 * global `LayoutAnimation.configureNext`, so the virtualized `List` never
 * cross-fades or clips sibling/recycled cells.
 */
const FOLD_SETTLE_MS = 275;
const closingTurns = signal<Record<string, "arming" | "collapsing">>({});
const openingTurns = signal<Record<string, "arming" | "expanding">>({});
const pendingAutoClose = new Set<string>();
const foldTimers = new Map<string, ReturnType<typeof setTimeout>[]>();
/** Ticks when a fold was decided outside the projection (one owed to the reader, made): it runs again. */
const foldTick = signal(0);

/** Read inside `displayRows` so projection re-runs when a turn finishes collapsing. */
export function trackFoldState() {
  closingTurns();
  foldTick();
}

/** Whether `id`'s process rows stay mounted in `displayRows` while collapsing to 0pt. */
export function isTurnClosing(id: string): boolean {
  return pendingAutoClose.has(id) || closingTurns()[id] !== undefined;
}

function clearTurnTimers(id: string) {
  const timers = foldTimers.get(id);
  if (timers) {
    for (const timer of timers) clearTimeout(timer);
    foldTimers.delete(id);
  }
  pendingAutoClose.delete(id);
}

function scheduleAutoFold(id: string) {
  clearTurnTimers(id);
  pendingAutoClose.add(id);
  // Let the settle commit lay out the finished reply and its Copy row at rest
  // first, then collapse the process rows in their own scoped pass one frame later.
  const tCollapse = setTimeout(() => {
    pendingAutoClose.delete(id);
    closingTurns.update((all) => ({ ...all, [id]: "collapsing" }));
  }, 16);
  const tDone = setTimeout(() => {
    clearTurnTimers(id);
    closingTurns.update(({ [id]: _, ...rest }) => rest);
    foldSettled();
  }, 16 + FOLD_SETTLE_MS);
  foldTimers.set(id, [tCollapse, tDone]);
}

/**
 * Opens or closes a turn's fold (the process fold): opening, its rows mount
 * at 0pt and spring open with staggered opacity/glide; closing, they spring to
 * 0pt and fade out before leaving the list, so nothing pops or blinks out.
 *
 * The press is the reader's say on the turn. On the turn the run is on it is
 * also their say on the work (`turnSay`): folded, the work stays folded as it
 * goes on past a message sent into it. A press on a turn that is over says
 * nothing on the work: a look inside an earlier part opens that part alone.
 */
function toggleTurn(id: string, open: boolean, running: boolean) {
  anchorFold();
  clearTurnTimers(id);
  // The turn is the reader's from here on: no fold of its own is left to make.
  watched.seen.delete(id);
  watched.owed.delete(id);
  const work = running ? workOf(id) : undefined;
  if (reduceMotion()) {
    closingTurns.update(({ [id]: _, ...rest }) => rest);
    openingTurns.update(({ [id]: _, ...rest }) => rest);
    choose(id, !open, work);
    return;
  }
  if (!open) {
    const wasClosing = closingTurns()[id] !== undefined;
    closingTurns.update(({ [id]: _, ...rest }) => rest);
    if (wasClosing) {
      openingTurns.update((all) => ({ ...all, [id]: "expanding" }));
      choose(id, true, work);
      const tDone = setTimeout(() => {
        clearTurnTimers(id);
        openingTurns.update(({ [id]: _, ...rest }) => rest);
        foldSettled();
      }, FOLD_SETTLE_MS);
      foldTimers.set(id, [tDone]);
      return;
    }
    openingTurns.update((all) => ({ ...all, [id]: "arming" }));
    choose(id, true, work);
    const tExpand = setTimeout(() => {
      openingTurns.update((all) => (all[id] ? { ...all, [id]: "expanding" } : all));
    }, 20);
    const tDone = setTimeout(() => {
      clearTurnTimers(id);
      openingTurns.update(({ [id]: _, ...rest }) => rest);
      foldSettled();
    }, 20 + FOLD_SETTLE_MS);
    foldTimers.set(id, [tExpand, tDone]);
    return;
  }
  openingTurns.update(({ [id]: _, ...rest }) => rest);
  closingTurns.update((all) => ({ ...all, [id]: "collapsing" }));
  choose(id, false, work);
  const tDone = setTimeout(() => {
    clearTurnTimers(id);
    closingTurns.update(({ [id]: _, ...rest }) => rest);
    foldSettled();
  }, FOLD_SETTLE_MS);
  foldTimers.set(id, [tDone]);
}

/**
 * How a row of a turn's process folds open or shut. Recycled `List` cells are
 * keyed by `id()`: rebinding to another row snaps `Collapsible` immediately
 * without animating the recycled cell, while transitions of the bound row's
 * own turn animate height + opacity + `translateY`.
 */
function useProcessFold(id: () => string) {
  const cellOpen = signal(true);
  const reveal = signal(true);
  const opacity = createAnimatedValue(1);
  const translateY = createAnimatedValue(0);
  let trackedId = "";
  let currentOpen = true;
  let rearmSeq = 0;

  const desiredState = (rowId: string): { open: boolean; phase: "steady" | "arming" | "expanding" | "collapsing"; at: number } => {
    const place = processTurns.get(rowId);
    if (!place) return { open: true, phase: "steady", at: 0 };
    if (closingTurns()[place.turn] === "collapsing") return { open: false, phase: "collapsing", at: place.at };
    const openPhase = openingTurns()[place.turn];
    if (openPhase === "arming") return { open: false, phase: "arming", at: place.at };
    if (openPhase === "expanding") return { open: true, phase: "expanding", at: place.at };
    return { open: true, phase: "steady", at: place.at };
  };

  effect(() => {
    const rowId = id();
    closingTurns();
    openingTurns();
    untracked(() => {
      const { open: nextOpen, phase, at } = desiredState(rowId);
      const rebound = rowId !== trackedId;
      trackedId = rowId;

      if (rebound) {
        const seq = ++rearmSeq;
        void opacity.stop();
        void translateY.stop();
        opacity.set(nextOpen ? 1 : 0);
        translateY.set(nextOpen ? 0 : -6);
        if (nextOpen !== currentOpen) {
          currentOpen = nextOpen;
          reveal.set(false);
          cellOpen.set(nextOpen);
          queueMicrotask(() => {
            if (rearmSeq === seq) reveal.set(true);
          });
        }
        return;
      }

      if (nextOpen === currentOpen) return;
      currentOpen = nextOpen;
      if (!reveal()) reveal.set(true);
      cellOpen.set(nextOpen);

      void opacity.stop();
      void translateY.stop();
      if (reduceMotion()) {
        opacity.set(nextOpen ? 1 : 0);
        translateY.set(0);
        return;
      }
      if (nextOpen) {
        const delay = phase === "expanding" ? Math.min(at, 6) * 24 : 0;
        opacity.set(0);
        translateY.set(-6);
        void opacity.timing(1, { duration: 200, delay, easing: EASING.smoothOut });
        void translateY.timing(0, { duration: 240, delay, easing: EASING.smoothOut });
      } else {
        void opacity.timing(0, { duration: 150, easing: EASING.out });
        void translateY.timing(-4, { duration: 180, easing: EASING.out });
      }
    });
  });

  cleanup(() => {
    rearmSeq++;
    void opacity.stop();
    void translateY.stop();
  });

  return {
    open: cellOpen,
    reveal,
    isFolding: () => {
      const place = processTurns.get(id());
      if (!place) return false;
      return closingTurns()[place.turn] !== undefined || openingTurns()[place.turn] !== undefined;
    },
    style: { opacity, transform: [{ translateY }] },
  };
}

/**
 * The turns of the conversation on screen as the reader watched them: those
 * `seen` working, whose process was open under their eyes and so folds before
 * them when the turn is over, and those whose fold is `owed`. Nothing here
 * outlives the conversation's stay on screen: one the reader comes back to
 * shows each turn as it stands by then, with no fold left to play.
 */
let watched = { key: -1, seen: new Set<string>(), owed: new Set<string>() };

/** The reader's own say on a turn's fold, if they pressed its header. */
export const turnChoice = chosen;

/** Under what a press on the working turn is kept as the reader's say on the work, beside their say on the turn. */
const workOf = (id: string) => `work:${id}`;

/** What the reader said on the work while the run was on this turn, if they pressed its header then. */
export const turnSay = (id: string) => chosen(workOf(id));

/**
 * Whether a turn's process shows when the reader said nothing on it: open
 * while the run is `working` on it, folded once it is over. The fold happens
 * before a reader who is following the reply. One who scrolled away is reading
 * what would fold: for them it stays, and the fold is owed — made once they
 * follow again (`foldOwedTurns`), not kept from them for good.
 */
export function turnDefault(id: string, working: boolean, following: boolean, hasDetails = true): boolean {
  const key = conversationKey();
  if (watched.key !== key) watched = { key, seen: new Set(), owed: new Set() };
  if (working) {
    if (hasDetails) watched.seen.add(id);
    return true;
  }
  if (!watched.seen.has(id)) return false;
  if (watched.owed.has(id)) return true;
  if (!following) {
    watched.owed.add(id);
    return true;
  }
  watched.seen.delete(id);
  if (hasDetails && !untracked(reduceMotion)) scheduleAutoFold(id);
  return false;
}

/** The reader follows the conversation again: the turns that ended while they read elsewhere fold now. */
export function foldOwedTurns() {
  if (!watched.owed.size || watched.key !== untracked(conversationKey)) return;
  const reduced = untracked(reduceMotion);
  for (const id of watched.owed) {
    watched.seen.delete(id);
    if (!reduced) scheduleAutoFold(id);
  }
  watched.owed.clear();
  foldTick.update((n) => n + 1);
}

/** How many conversations' folds are kept: those left longest ago go first. */
const CHOICES_KEPT = 32;
let shownKeys: number[] = [];

/**
 * Another conversation fills the list (`key`). The reader's folds are kept by
 * conversation and need no swap; what is keyed by row id alone — folds in
 * motion, the veil, the prose cache — clears, since those ids mean other rows
 * in another conversation.
 */
export function enterConversation(key: number) {
  for (const id of [...foldTimers.keys()]) clearTurnTimers(id);
  pendingAutoClose.clear();
  closingTurns.set({});
  openingTurns.set({});
  // What was watched in the conversation left is not watched any more (one with no turn to show, an empty
  // chat, asks `turnDefault` nothing and would leave it standing): coming back finds no fold owed or to play.
  if (watched.key !== key) watched = { key: -1, seen: new Set(), owed: new Set() };

  shownKeys = [...shownKeys.filter((shown) => shown !== key), key];
  if (shownKeys.length > CHOICES_KEPT) {
    const gone = shownKeys.splice(0, shownKeys.length - CHOICES_KEPT);
    choices.update((all) => {
      const kept = { ...all };
      for (const old of gone) delete kept[old];
      return kept;
    });
  }

  replyActionRows.clear();
  clearProseState();
}

/** A sent message lays out past this many lines and the bubble folds to a preview. */
const USER_FOLD_LINES = 6;
/**
 * The laid-out height of each user bubble's text, by row id. The text's own
 * layout reports it while it runs free; a folded pass reports at most the
 * clamp, so only a count under it (the real count again) is taken then — a
 * wrong first guess corrects itself.
 */
const userLineCounts = signal<Record<string, number>>({});

/** Visual column width of a line (wide CJK/emoji glyphs count as two narrow columns). */
function visualColumns(line: string): number {
  let cols = 0;
  for (let i = 0; i < line.length; i++) {
    cols += line.charCodeAt(i) >= 0x2e80 ? 2 : 1;
  }
  return cols;
}

/** A rough line count before the text's first layout: wraps per paragraph so CJK and Latin bubbles start already folded without a second-frame jump. */
function roughLines(text: string): number {
  let total = 0;
  for (const line of text.split("\n")) {
    total += Math.max(1, Math.ceil(visualColumns(line) / 68));
  }
  return total;
}

function UserRow(props: { row: Extract<Row, { kind: "user" }> }) {
  // The fork command names a message by its place among the user's messages on screen.
  const ordinal = () =>
    transcriptRows()
      .filter((row) => row.kind === "user")
      .findIndex((row) => row.id === props.row.id);
  const open = () => isOpen(props.row.id, false);
  const foldable = () => (userLineCounts()[props.row.id] ?? roughLines(props.row.text)) > USER_FOLD_LINES;
  const folded = () => foldable() && !open();
  const fold = () => toggle(props.row.id, false);
  return (
    <View class="group items-end">
      <View
        class="max-w-[70%] gap-1.5 rounded-2xl rounded-br-md bg-secondary px-3.5 py-2.5"
        selectable
        onContextMenu={(e) =>
          Menu.popup(
            [
              { label: tr("Copy", "复制"), onSelect: () => void copyText(props.row.text) },
              { label: tr("Fork From Here", "从此处创建分支"), onSelect: () => void forkFrom(ordinal()) },
            ],
            e.pagePosition,
          )
        }
      >
        <If when={props.row.text}>
          {/* While folded the whole message takes the press; while open it is plain selectable text again. */}
          <View
            role={folded() ? "button" : undefined}
            onPress={folded() ? fold : undefined}
            accessibilityState={folded() ? { expanded: false } : undefined}
          >
            <Text
              class={`text-md text-secondary-foreground ${folded() ? "line-clamp-6" : ""}`}
              style={folded() ? { maskImage: "linear-gradient(to bottom, black 64%, transparent 94%)" } : undefined}
              onTextLayout={(e) => {
                const n = e.lines.length;
                // Fewer lines than the text's own breaks is not a real layout pass (the headless engine reports one box).
                if (n < props.row.text.split("\n").length) return;
                if (folded() && n >= USER_FOLD_LINES) return;
                if (n !== userLineCounts()[props.row.id]) userLineCounts.update((all) => ({ ...all, [props.row.id]: n }));
              }}
            >
              {props.row.text}
            </Text>
          </View>
        </If>
        <If when={props.row.images > 0}>
          <View class="select-none flex-row items-center gap-1.5">
            <Icon name="image" size={14} tone="muted-foreground" />
            <Text class="text-xs text-muted-foreground">
              {tr(props.row.images === 1 ? "1 image" : `${props.row.images} images`, `${props.row.images} 张图片`)}
            </Text>
          </View>
        </If>
        <If when={foldable()}>
          <View
            role="button"
            onPress={fold}
            accessibilityState={{ expanded: open() }}
            accessibilityLabel={open() ? tr("Collapse message", "收起消息") : tr("Expand message", "展开消息")}
            class={`-mx-1 -mb-1 h-5 select-none items-center justify-center rounded-md ${PRESS} ${FOCUS_RING}`}
          >
            <View
              class={`transition-transform duration-200 ease-out-quint motion-reduce:transition-none ${open() ? "rotate-180" : ""}`}
            >
              <Icon name="chevronDown" size={12} tone="muted-foreground" />
            </View>
          </View>
        </If>
      </View>
      {/* Shown while the pointer is on the message (or just after a copy), so the bubbles stay quiet. */}
      <View class="h-6 select-none flex-row items-center pt-0.5">
        <If when={props.row.text}>
          <CopyButton
            id={props.row.id}
            text={props.row.text}
            label={tr("Copy message", "复制消息")}
            class="-mr-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus:opacity-100 motion-reduce:transition-none"
          />
        </If>
      </View>
    </View>
  );
}

/** The message whose Copy was just pressed: its button shows a check for a moment. One at a time, by row id (cells are recycled). */
const copiedId = signal<string | undefined>(undefined);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
const COPIED_MS = 1600;

/** Copies a message's text; the icon turns to a check while it holds. */
function CopyButton(props: { id: string; text: string; label: string; class?: string }) {
  const copied = () => copiedId() === props.id;
  return (
    <IconButton
      icon={copied() ? "check" : "copy"}
      tone={copied() ? "success" : "subtle"}
      size="sm"
      label={copied() ? tr("Copied", "已复制") : props.label}
      tipPlacement="bottom"
      class={copied() ? `${props.class ?? ""} opacity-100` : props.class}
      onPress={() =>
        void copyMessage(props.text).then((ok) => {
          if (!ok) return;
          clearTimeout(copiedTimer);
          copiedId.set(props.id);
          copiedTimer = setTimeout(() => copiedId.set(undefined), COPIED_MS);
        })
      }
    />
  );
}

/** The line under a finished reply: its Copy. A row of its own, after the reply's blocks. */
export interface ReplyActionsRow {
  kind: "actions";
  id: string;
  /** The reply (transcript row) it acts on. */
  rowId: string;
  text: string;
}

const replyActionRows = new Map<string, ReplyActionsRow>();

/** The actions row of a finished reply: the same object while the reply does not change, so the list leaves it alone. */
export function replyActions(row: { id: string; text: string }): ReplyActionsRow {
  const before = replyActionRows.get(row.id);
  if (before && before.text === row.text) return before;
  const made: ReplyActionsRow = { kind: "actions", id: `${row.id}#actions`, rowId: row.id, text: row.text };
  replyActionRows.set(row.id, made);
  return made;
}

function ReplyActionsView(props: { row: ReplyActionsRow }) {
  return (
    <View class="h-6 select-none flex-row items-center">
      <CopyButton id={props.row.id} text={props.row.text} label={tr("Copy reply", "复制回复")} class="-ml-1" />
    </View>
  );
}

/** Shared compact disclosure trigger row for Level-1 & Level-2 folds. */
function Disclosure(props: {
  open: boolean;
  onPress: () => void;
  compact?: boolean;
  alwaysShowChevron?: boolean;
  children?: JSX.Element;
}) {
  return (
    <View
      role="button"
      onPress={props.onPress}
      accessibilityState={{ expanded: props.open }}
      class={`group -mx-2 ${props.compact ? "h-6.5" : "h-7"} select-none flex-row items-center gap-2 rounded-md px-2 ${PRESS} active:scale-[0.995] motion-reduce:active:scale-100 ${FOCUS_RING} hover:bg-accent active:bg-accent`}
    >
      {props.children}
      <View
        class={`shrink-0 transition-all duration-200 ease-out-quint motion-reduce:transition-none ${
          props.open
            ? "rotate-90 opacity-100"
            : props.alwaysShowChevron
              ? "opacity-55 group-hover:opacity-100"
              : "opacity-0 group-hover:opacity-100"
        }`}
      >
        <Icon name="chevronRight" size={12} tone="subtle" />
      </View>
    </View>
  );
}

/**
 * A process line: quiet words with the fold's chevron right after them,
 * no icon, no hover fill. The words carry the state; the row never changes height.
 */
function ProcessLine(props: { open: boolean; onPress?: () => void; children?: JSX.Element }) {
  return (
    <If
      when={props.onPress}
      else={<View class="h-7 min-w-0 max-w-full select-none flex-row items-center gap-1.5">{props.children}</View>}
    >
      <View
        role="button"
        onPress={props.onPress}
        accessibilityState={{ expanded: props.open }}
        class={`group h-7 min-w-0 max-w-full select-none flex-row items-center gap-1.5 self-start rounded-md ${FOCUS_RING}`}
      >
        {props.children}
        <View
          class={`shrink-0 transition-all duration-200 ease-out-quint motion-reduce:transition-none ${
            props.open ? "rotate-90 opacity-100" : "opacity-60 group-hover:opacity-100"
          }`}
        >
          <Icon name="chevronRight" size={12} tone="subtle" />
        </View>
      </View>
    </If>
  );
}

/** Unified leading indicator: spinner while active, error mark on failure, or semantic icon when settled.
 * Plays a crisp spring pop only on live running -> settled transitions, never on recycled cells. */
function LeadGlyph(props: {
  id: string;
  running: boolean;
  error: boolean;
  icon: IconName;
  activeTone?: "brand-text" | "muted-foreground" | "subtle";
}) {
  const scale = createAnimatedValue(1);
  const opacity = createAnimatedValue(1);
  let trackedId = "";
  let wasRunning = false;

  effect(() => {
    const id = props.id;
    const settled = !props.running;
    untracked(() => {
      if (id !== trackedId) {
        trackedId = id;
        wasRunning = !settled;
        scale.set(1);
        opacity.set(1);
        return;
      }
      if (wasRunning && settled && !reduceMotion()) {
        wasRunning = false;
        scale.set(0.72);
        opacity.set(0.4);
        void scale.spring(1, { stiffness: 520, damping: 28, mass: 0.9 });
        void opacity.timing(1, { duration: 150, easing: "easeOut" });
      } else {
        wasRunning = !settled;
      }
    });
  });

  cleanup(() => {
    void scale.stop();
    void opacity.stop();
  });

  return (
    <View class="size-4 shrink-0 items-center justify-center">
      <If
        when={props.running}
        else={
          <View style={{ opacity, scale }}>
            <If
              when={props.error}
              else={<Icon name={props.icon} size={14} tone={props.activeTone ?? "muted-foreground"} />}
            >
              <Icon name="x" size={14} tone="destructive" />
            </If>
          </View>
        }
      >
        <View class="size-3 rounded-full border-[1.5px] border-input border-t-brand motion-safe:animate-spin" />
      </If>
    </View>
  );
}

function DiffBadge(props: { stats?: DiffStats }) {
  return (
    <If when={props.stats && (props.stats.added > 0 || props.stats.removed > 0) ? props.stats : undefined}>
      {(stats) => (
        <View class="shrink-0 flex-row items-center gap-1">
          <If when={stats().added > 0}>
            <Text class="font-mono text-2xs font-medium tabular-nums text-success">{`+${stats().added}`}</Text>
          </If>
          <If when={stats().removed > 0}>
            <Text class="font-mono text-2xs font-medium tabular-nums text-destructive">{`-${stats().removed}`}</Text>
          </If>
        </View>
      )}
    </If>
  );
}

function ThinkingRow(props: { row: Extract<Row, { kind: "thinking" }>; defaultOpen?: boolean; compact?: boolean }) {
  const pulseOpacity = useBreathingOpacity(() => props.row.streaming, 0.48, 1500);
  const fallback = () => Boolean(props.defaultOpen);
  const open = () => isOpen(props.row.id, fallback());
  const label = () => thinkingLabel(props.row, activeLanguage());
  const hasBody = () => Boolean(props.row.text.trim());
  const text = () => `min-w-0 shrink truncate ${props.compact ? "text-sm" : "text-md"} text-subtle`;

  // Among a run's steps it reads as the tool calls beside it do: a glyph, then the words.
  if (props.compact) {
    return (
      <Collapsible open={open() && hasBody()} reveal content={<ReasoningBody text={props.row.text} />}>
        <Disclosure open={open() && hasBody()} compact onPress={() => hasBody() && toggle(props.row.id, fallback())}>
          <LeadGlyph id={props.row.id} running={props.row.streaming} error={false} icon="thinking" />
          <RollingText id={() => props.row.id} text={label} class="min-w-0 shrink truncate text-sm text-muted-foreground" />
        </Disclosure>
      </Collapsible>
    );
  }

  return (
    <Collapsible open={open() && hasBody()} reveal content={<ReasoningBody text={props.row.text} />}>
      <ProcessLine open={open() && hasBody()} onPress={hasBody() ? () => toggle(props.row.id, fallback()) : undefined}>
        <RollingText id={() => props.row.id} text={label} class={text()} style={{ opacity: pulseOpacity }} />
      </ProcessLine>
    </Collapsible>
  );
}

/** Reasoning, unfolded: quiet prose on a hairline. */
function ReasoningBody(props: { text: string }) {
  return (
    <View class="mb-1 border-l border-hairline py-1 pl-3.5" selectable>
      <Text class="text-sm leading-relaxed text-muted-foreground">{props.text.trim()}</Text>
    </View>
  );
}

/** Output in a sunken, scrollable block: monospaced, selectable, bounded. */
function Output(props: { text: string; command?: string; tone?: "error"; insetClass?: string }) {
  const shown = () => clip(props.text, 400);
  return (
    <View selectable class={`mb-1 mt-0.5 overflow-hidden rounded-lg border border-border bg-sunken ${props.insetClass ?? "ml-6"}`}>
      <Scroll class="max-h-72" contentClass="p-3">
        <View>
          <If when={props.command}>
            <Text class={`font-mono text-xs leading-relaxed text-subtle ${shown().text ? "pb-2" : ""}`}>{`$ ${props.command}`}</Text>
          </If>
          <If when={!props.command || !!shown().text}>
            <Text class={`font-mono text-xs leading-relaxed ${props.tone === "error" ? "text-destructive" : "text-muted-foreground"}`}>
              {shown().text || tr("No output.", "无输出。")}
            </Text>
          </If>
        </View>
        <If when={shown().hidden > 0}>
          <Text class="pt-2 text-xs text-subtle">{tr(`${shown().hidden} more lines not shown`, `另有 ${shown().hidden} 行未显示`)}</Text>
        </If>
      </Scroll>
    </View>
  );
}

/** The diff an edit made, when the tool reports one: highlighted as a diff. */
const diffOf = (row: ToolRow) => {
  const details = row.details as { diff?: unknown } | undefined;
  return typeof details?.diff === "string" && details.diff ? details.diff : undefined;
};

/** What a call did, unfolded: the diff an edit made, else its output (a command's under its command line). */
function ToolDetail(props: { row: ToolRow; insetClass?: string }) {
  const command = () => (classifyTool(props.row.name).category === "command" ? String(props.row.args?.command ?? props.row.args?.cmd ?? "").trim() : "");
  const detail = () => {
    if (props.row.output) return props.row.output;
    if (props.row.status === "call") return tr("Writing tool arguments…", "正在生成调用参数…");
    if (props.row.status === "queued" || props.row.status === "running") return tr("Running…", "正在运行…");
    if (props.row.images) return tr(`${props.row.images} image${props.row.images === 1 ? "" : "s"} returned.`, `返回了 ${props.row.images} 张图片。`);
    if (command()) return "";
    const rawArgs = JSON.stringify(props.row.args ?? {}, null, 2);
    return rawArgs && rawArgs !== "{}" ? rawArgs : tr("Completed with no output.", "已完成，无额外输出。");
  };
  return (
    <If when={diffOf(props.row)} else={<Output text={detail()} command={command()} tone={props.row.status === "error" ? "error" : undefined} insetClass={props.insetClass} />}>
      {(diff) => (
        <View class={`mb-1 mt-0.5 ${props.insetClass ?? "ml-6"}`}>
          <TextView
            markdown={`\`\`\`diff\n${clip(diff(), 400).text}\n\`\`\``}
            selectable
            codeBlockScrollbar={false}
            classes={{ codeBlock: PROSE.codeBlock, codeBlockCode: "p-3 text-xs" }}
          />
        </View>
      )}
    </If>
  );
}

/** Extracts a navigable daemon session id from a session-tool call (`session_start`, `session_send`, etc.). */
function sessionIdOfTool(row: ToolRow): string | undefined {
  const lower = row.name.replace(/^mcp__[^_]+__/i, "").toLowerCase();
  if (lower === "session_start" && row.output) {
    try {
      const parsed = JSON.parse(row.output) as { id?: unknown };
      if (typeof parsed?.id === "string" && parsed.id && daemonSessionOfId(parsed.id)) return parsed.id;
    } catch {
      // Output may be partial or an error text.
    }
  }
  if (lower === "session_send" || lower === "session_read" || lower === "session_stop") {
    const id = typeof row.args?.session === "string" ? row.args.session : undefined;
    if (id && daemonSessionOfId(id)) return id;
  }
  return undefined;
}

function ToolCallRow(props: { row: ToolRow; compact?: boolean }) {
  const open = () => isOpen(props.row.id, false);
  const desc = () => describeToolCall(props.row, activeLanguage());
  const running = () => props.row.status === "call" || props.row.status === "queued" || props.row.status === "running";
  const targetSession = () => sessionIdOfTool(props.row);

  return (
    <Collapsible open={open()} reveal content={<ToolDetail row={props.row} />}>
      <View class="flex-row items-center gap-1">
        <View class="min-w-0 flex-1">
          <Disclosure open={open()} compact={props.compact} onPress={() => toggle(props.row.id, false)}>
            <LeadGlyph
              id={props.row.id}
              running={running()}
              error={props.row.status === "error"}
              icon={desc().icon}
            />
            <RollingText
              id={() => props.row.id}
              text={() => desc().verb}
              class={`shrink-0 text-sm ${props.row.status === "error" ? "font-medium text-destructive" : "text-muted-foreground"}`}
            />
            <If when={desc().target}>
              <Text
                class={`min-w-0 shrink truncate ${
                  desc().monoTarget ? "font-mono text-xs text-foreground" : "text-sm text-foreground"
                }`}
              >
                {desc().target}
              </Text>
            </If>
            <If when={desc().meta}>
              <Text class="shrink-0 truncate text-xs text-subtle">{desc().meta}</Text>
            </If>
            <DiffBadge stats={desc().diffStats} />
          </Disclosure>
        </View>
        <If when={targetSession()}>
          {(sid) => (
            <IconButton
              icon="external"
              size="sm"
              label={tr("Open session", "打开会话")}
              onPress={() => openDaemonSession(sid())}
            />
          )}
        </If>
      </View>
    </Collapsible>
  );
}

/**
 * A run of non-prose process steps (reasoning and tool calls):
 * one quiet line, the step under way while it works and what it did once
 * settled. It unfolds to the reasoning or the call's output when it holds one
 * step, else to each step in the order they happened.
 */
function ActivityView(props: { row: ActivityRow }) {
  const open = () => isOpen(props.row.id, false);
  const title = () => describeActivity(props.row, activeLanguage());
  const pulseOpacity = useBreathingOpacity(() => props.row.running, 0.55, 1300);
  const only = () => (props.row.steps.length === 1 ? props.row.steps[0] : undefined);
  const onlySession = () => {
    const step = only();
    return step?.kind === "tool" ? sessionIdOfTool(step) : undefined;
  };
  const hasBody = () => {
    const step = only();
    return !step || step.kind === "tool" || Boolean(step.text.trim());
  };

  return (
    <Collapsible
      open={open() && hasBody()}
      reveal
      content={
        <If
          when={only()}
          else={
            <View class="mb-1 gap-0.5 border-l border-hairline py-0.5 pl-3.5">
              <Each of={props.row.steps} key={(step) => step.id}>
                {(step) => (
                  <If
                    when={step().kind === "thinking" ? (step() as Extract<Row, { kind: "thinking" }>) : undefined}
                    else={<ToolCallRow row={step() as ToolRow} compact />}
                  >
                    {(thinking) => <ThinkingRow row={thinking()} compact defaultOpen={props.row.tools.length === 0} />}
                  </If>
                )}
              </Each>
            </View>
          }
        >
          {(step) => (
            <If when={step().kind === "thinking" ? (step() as Extract<Row, { kind: "thinking" }>) : undefined} else={<ToolDetail row={step() as ToolRow} insetClass="ml-0" />}>
              {(thinking) => <ReasoningBody text={thinking().text} />}
            </If>
          )}
        </If>
      }
    >
      <View class="flex-row items-center gap-1">
        <ProcessLine open={open() && hasBody()} onPress={hasBody() ? () => toggle(props.row.id, false) : undefined}>
          <RollingText id={() => props.row.id} text={title} class="min-w-0 shrink truncate text-md text-subtle" style={{ opacity: pulseOpacity }} />
        </ProcessLine>
        <If when={onlySession()}>
          {(sid) => (
            <IconButton
              icon="external"
              size="sm"
              label={tr("Open session", "打开会话")}
              onPress={() => openDaemonSession(sid())}
            />
          )}
        </If>
      </View>
    </Collapsible>
  );
}

/**
 * The line above a turn's work (the process header): "Working" and a timer
 * while it runs, how long it took after. It folds the turn's process rows,
 * which the list shows or leaves out; the header itself never changes height.
 */
function TurnHeaderView(props: { row: TurnHeaderRow }) {
  const pulseOpacity = useBreathingOpacity(() => props.row.running, 0.55, 1300);
  const settleOpacity = createAnimatedValue(1);
  let trackedId = "";
  let wasRunning = false;
  effect(() => {
    const id = props.row.id;
    const running = props.row.running;
    untracked(() => {
      if (id !== trackedId) {
        trackedId = id;
        wasRunning = running;
        void settleOpacity.stop();
        settleOpacity.set(1);
        return;
      }
      if (wasRunning && !running && !reduceMotion()) {
        wasRunning = false;
        settleOpacity.set(0.45);
        void settleOpacity.timing(1, { duration: 180, easing: EASING.smoothOut });
      } else {
        wasRunning = running;
      }
    });
  });
  cleanup(() => void settleOpacity.stop());

  const now = signal(Date.now());
  effect(() => {
    if (!props.row.running) return;
    now.set(Date.now());
    const timer = setInterval(() => now.set(Date.now()), 1000);
    cleanup(() => clearInterval(timer));
  });
  const elapsed = () => (props.row.running && props.row.startedAt !== undefined ? Math.max(0, now() - props.row.startedAt) : undefined);
  const preview = () => {
    if (props.row.open) return "";
    const lang = activeLanguage();
    if (props.row.running) return props.row.activeStep ? describeActiveStep(props.row.activeStep, lang) : "";
    if (props.row.backgroundStep) return describeActiveStep(props.row.backgroundStep, lang);
    if (props.row.summaryTools?.length) return describeToolsSummary(props.row.summaryTools, lang);
    return "";
  };
  const shownPreview = keepLast(() => preview() || undefined, "");
  return (
    // The hairline under the header stays in both live and settled states, so the handoff cannot jump.
    <View class="border-b border-hairline pb-1.5">
      <ProcessLine
        open={props.row.open}
        onPress={props.row.hasDetails ? () => toggleTurn(props.row.id, props.row.open, props.row.running) : undefined}
      >
        <View style={{ opacity: settleOpacity }}>
          <RollingText
            id={() => props.row.id}
            text={() => describeTurn(props.row, activeLanguage())}
            class="shrink-0 text-md text-subtle"
            style={{ opacity: pulseOpacity }}
          />
        </View>
        <If when={elapsed() !== undefined && (elapsed() ?? 0) >= 1000}>
          <Text class="shrink-0 text-md tabular-nums text-subtle">{(elapsed() ?? 0) < 60_000 ? `${Math.floor((elapsed() ?? 0) / 1000)}s` : duration(elapsed() ?? 0)}</Text>
        </If>
        <Presence show={Boolean(preview())} scaleFrom={0.97} class="min-w-0 shrink flex-row items-center gap-1.5">
          <If when={!props.row.running}>
            <Text class="shrink-0 text-md text-subtle">·</Text>
          </If>
          <RollingText id={() => `${props.row.id}:preview`} text={() => shownPreview() ?? ""} class="min-w-0 shrink truncate text-md text-subtle" />
        </Presence>
      </ProcessLine>
    </View>
  );
}

function BashRow(props: { row: Extract<Row, { kind: "bash" }> }) {
  const open = () => isOpen(props.row.id, true);
  const running = () => props.row.running;
  const error = () => !props.row.running && (props.row.cancelled || (props.row.exitCode !== undefined && props.row.exitCode !== 0));
  const note = () =>
    props.row.cancelled
      ? tr("cancelled", "已取消")
      : props.row.exitCode
        ? tr(`exit ${props.row.exitCode}`, `退出码 ${props.row.exitCode}`)
        : props.row.truncated
          ? tr("truncated", "已截断")
          : "";
  return (
    <Collapsible open={open()} reveal content={<Output text={props.row.output} />}>
      <Disclosure open={open()} onPress={() => toggle(props.row.id, true)}>
        <LeadGlyph id={props.row.id} running={running()} error={error()} icon="terminal" />
        <RollingText
          id={() => props.row.id}
          text={() => (running() ? tr("Running", "正在运行") : tr("Ran", "运行"))}
          class="shrink-0 text-sm text-muted-foreground"
        />
        <Text class="min-w-0 shrink truncate font-mono text-xs text-foreground">{props.row.command}</Text>
        <If when={note()}>
          <Text class="shrink-0 text-xs tabular-nums text-subtle">{note()}</Text>
        </If>
      </Disclosure>
    </Collapsible>
  );
}

function NoticeRow(props: { row: Extract<Row, { kind: "notice" }> }) {
  const tone = () => (props.row.tone === "error" ? "destructive" : props.row.tone === "warning" ? "warning" : "muted-foreground");
  return (
    <View selectable class={`flex-row gap-2.5 rounded-lg border px-3 py-2.5 ${props.row.tone === "error" ? "border-destructive/30 bg-destructive/5" : "border-border bg-card"}`}>
      <View class="pt-px">
        <Icon name={props.row.tone === "info" ? "info" : "alert"} tone={tone()} />
      </View>
      <View class="flex-1 gap-0.5">
        <Text class="text-base font-medium text-foreground">{props.row.title}</Text>
        <If when={props.row.text}>
          <Text class="text-sm text-muted-foreground">{props.row.text}</Text>
        </If>
      </View>
    </View>
  );
}

/** A mark in the conversation's history: where context was compacted, a branch summarized. */
function SummaryRow(props: { row: Extract<Row, { kind: "summary" }> }) {
  const open = () => isOpen(props.row.id, false);
  return (
    <Collapsible
      open={open()}
      reveal
      content={
        <View class="mt-2 rounded-lg border border-border bg-card px-3 py-2.5">
          <TextView markdown={props.row.text} selectable codeBlockScrollbar={false} tableScrollbar={false} classes={{ ...PROSE, root: "gap-2 text-sm text-muted-foreground" }} />
        </View>
      }
    >
      <View role="button" onPress={() => toggle(props.row.id, false)} accessibilityState={{ expanded: open() }} class={`h-7 select-none flex-row items-center gap-3 rounded-md ${FOCUS_RING}`}>
        <View class="h-px flex-1 bg-border" />
        <Icon name="compact" size={14} tone="subtle" />
        <Text class="text-xs text-muted-foreground">{props.row.title}</Text>
        <View class="h-px flex-1 bg-border" />
      </View>
    </Collapsible>
  );
}

/** An answer delivered back from another session (`<pipi-message>`): one labelled divider, its text unfolds. */
function DeliveryRow(props: { row: Extract<Row, { kind: "delivery" }> }) {
  const open = () => isOpen(props.row.id, false);
  const label = () =>
    props.row.status === "blocked"
      ? tr(`${props.row.fromTitle} is waiting on you`, `「${props.row.fromTitle}」在等待你确认`)
      : props.row.status === "failed"
        ? tr(`${props.row.fromTitle} stopped`, `「${props.row.fromTitle}」已停止`)
        : tr(`Answer from ${props.row.fromTitle}`, `「${props.row.fromTitle}」的回答`);
  return (
    <Collapsible
      open={open()}
      reveal
      content={
        <View class="mt-2 rounded-lg border border-border bg-card px-3 py-2.5">
          <TextView markdown={props.row.text} selectable codeBlockScrollbar={false} tableScrollbar={false} classes={{ ...PROSE, root: "gap-2 text-sm text-muted-foreground" }} />
        </View>
      }
    >
      <View
        role="button"
        onPress={() => toggle(props.row.id, false)}
        accessibilityState={{ expanded: open() }}
        accessibilityLabel={label()}
        class={`h-7 select-none flex-row items-center gap-3 rounded-md ${FOCUS_RING}`}
      >
        <View class="h-px flex-1 bg-border" />
        <Icon name="agents" size={14} tone="brand-text" />
        <Text class="max-w-96 truncate text-xs text-muted-foreground">{label()}</Text>
        <If when={props.row.status === "blocked"}>
          <View class="size-1.5 rounded-full bg-warning" />
        </If>
        <IconButton
          icon="external"
          size="sm"
          label={tr(`Open ${props.row.fromTitle}`, `打开「${props.row.fromTitle}」`)}
          onPress={() => openDaemonSession(props.row.from)}
        />
        <View class="h-px flex-1 bg-border" />
      </View>
    </Collapsible>
  );
}

/** A row of the chat's list: the projection's, with each reply as a row per block (and its actions after it, once finished). */
export type ChatRow = Exclude<DisplayRow, { kind: "text" }> | ProseRow | ReplyActionsRow;

/** The room around a row: turns are set apart, a turn's steps sit close, a reply's blocks a line apart. */
const SPACING: Record<ChatRow["kind"], string> = {
  user: "pt-7",
  turn: "pt-1.5 pb-2",
  // Selection drops target line boxes only, so room between a reply's blocks is
  // where a drag dead-ends back to the block before; keep it thin.
  prose: "py-0.5",
  actions: "pb-1",
  thinking: "py-1",
  activity: "py-1",
  bash: "py-1",
  notice: "py-2",
  summary: "py-3",
  delivery: "py-3",
};

/** One row of the transcript. */
export function TranscriptRow(props: { row: ChatRow }) {
  const isStreamingRow = () =>
    (props.row.kind === "turn" && props.row.running) ||
    (props.row.kind === "thinking" && props.row.streaming) ||
    (props.row.kind === "activity" && props.row.running);
  const fold = useProcessFold(() => props.row.id);
  const entrance = useRowEntrance(
    () => props.row.id,
    isStreamingRow,
    () => props.row.kind === "prose" || fold.isFolding(), // streamed text settles through its veil; folding rows animate via fold
    () => props.row.kind === "user",
  );
  const of = <K extends ChatRow["kind"]>(kind: K) => (props.row.kind === kind ? (props.row as Extract<ChatRow, { kind: K }>) : undefined);
  return (
    <Collapsible
      open={fold.open()}
      reveal={fold.reveal()}
      content={
        <View class={`w-full max-w-190 self-center ${SPACING[props.row.kind]}${fold.open() ? "" : " pointer-events-none"}`} style={entrance}>
          <View style={fold.style}>
            <If when={of("user")}>{(row) => <UserRow row={row()} />}</If>
            <If when={of("turn")}>{(row) => <TurnHeaderView row={row()} />}</If>
            <If when={of("activity")}>{(row) => <ActivityView row={row()} />}</If>
            <If when={of("prose")}>{(row) => <ProseBlock row={row()} />}</If>
            <If when={of("actions")}>{(row) => <ReplyActionsView row={row()} />}</If>
            <If when={of("thinking")}>{(row) => <ThinkingRow row={row()} />}</If>
            <If when={of("bash")}>{(row) => <BashRow row={row()} />}</If>
            <If when={of("notice")}>{(row) => <NoticeRow row={row()} />}</If>
            <If when={of("summary")}>{(row) => <SummaryRow row={row()} />}</If>
            <If when={of("delivery")}>{(row) => <DeliveryRow row={row()} />}</If>
          </View>
        </View>
      }
    />
  );
}
