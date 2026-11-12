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
  describeTurn,
  classifyTool,
  type DiffStats,
  type DisplayRow,
  thinkingLabel,
  type TurnHeaderRow,
} from "../pi/turns";
import { copyMessage, copyText, forkFrom, transcriptRows } from "../store/app";
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

const expanded = signal<Record<string, boolean>>({});

/** Whether a disclosure shows its body: explicit user choice wins, else `fallback`. */
const isOpen = (id: string, fallback: boolean) => expanded()[id] ?? fallback;
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
  expanded.update((all) => ({ ...all, [id]: !(all[id] ?? fallback) }));
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

/** Read inside `displayRows` so projection re-runs when a turn finishes collapsing. */
export function trackFoldState() {
  closingTurns();
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
 */
function toggleTurn(id: string, open: boolean) {
  anchorFold();
  clearTurnTimers(id);
  if (reduceMotion()) {
    closingTurns.update(({ [id]: _, ...rest }) => rest);
    openingTurns.update(({ [id]: _, ...rest }) => rest);
    expanded.update((all) => ({ ...all, [id]: !open }));
    return;
  }
  if (!open) {
    const wasClosing = closingTurns()[id] !== undefined;
    closingTurns.update(({ [id]: _, ...rest }) => rest);
    if (wasClosing) {
      openingTurns.update((all) => ({ ...all, [id]: "expanding" }));
      expanded.update((all) => ({ ...all, [id]: true }));
      const tDone = setTimeout(() => {
        clearTurnTimers(id);
        openingTurns.update(({ [id]: _, ...rest }) => rest);
        foldSettled();
      }, FOLD_SETTLE_MS);
      foldTimers.set(id, [tDone]);
      return;
    }
    openingTurns.update((all) => ({ ...all, [id]: "arming" }));
    expanded.update((all) => ({ ...all, [id]: true }));
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
  expanded.update((all) => ({ ...all, [id]: false }));
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
 * What a conversation's folds remember: the reader's disclosures and each seen
 * turn's held-open choice. Row ids collide across conversations, so the memory
 * swaps with the conversation on screen — an inspected task's and the main
 * session's stay apart, and coming back restores what was left open.
 */
interface FoldMemory {
  expanded: Record<string, boolean>;
  seenOpen: Set<string>;
  held: Map<string, boolean>;
}
const foldMemories = new Map<string, FoldMemory>();
let foldKey = "";
let foldMemory: FoldMemory = { expanded: {}, seenOpen: new Set(), held: new Map() };
let turnsSeenOpen = foldMemory.seenOpen;
let turnsHeld = foldMemory.held;

/**
 * Whether a turn's process shows: the reader's toggle, else `fallback` (open
 * until its answer is known). The fold at the answer happens for a reader who
 * is following the reply; one who scrolled away is reading what would fold,
 * so for them it stays, and the choice made at that moment is kept.
 */
export function turnOpen(id: string, fallback: boolean, following: boolean, hasDetails = true): boolean {
  const chosen = expanded()[id];
  if (chosen !== undefined) return chosen;
  if (fallback) {
    if (hasDetails) turnsSeenOpen.add(id);
    return true;
  }
  if (!turnsSeenOpen.has(id)) return false;
  let held = turnsHeld.get(id);
  if (held === undefined) {
    turnsHeld.set(id, (held = !following));
    if (!held && hasDetails && !untracked(reduceMotion)) scheduleAutoFold(id);
  }
  return held;
}

/**
 * The conversation about to fill the list (`key`): its fold memory replaces the
 * current one, which stays under its own key for when the reader comes back.
 * Everything else keyed by row id — running folds, the veil, the prose cache —
 * clears, since those ids mean other rows in another conversation.
 */
export function swapConversation(key: string) {
  for (const id of [...foldTimers.keys()]) clearTurnTimers(id);
  pendingAutoClose.clear();
  closingTurns.set({});
  openingTurns.set({});

  if (key !== foldKey) {
    foldMemory.expanded = expanded();
    foldMemories.set(foldKey, foldMemory);
    foldKey = key;
    foldMemory = foldMemories.get(key) ?? { expanded: {}, seenOpen: new Set(), held: new Map() };
    foldMemories.set(key, foldMemory);
    turnsSeenOpen = foldMemory.seenOpen;
    turnsHeld = foldMemory.held;
    expanded.set(foldMemory.expanded);
  }

  replyActionRows.clear();
  clearProseState();
}

function UserRow(props: { row: Extract<Row, { kind: "user" }> }) {
  // The fork command names a message by its place among the user's messages on screen.
  const ordinal = () =>
    transcriptRows()
      .filter((row) => row.kind === "user")
      .findIndex((row) => row.id === props.row.id);
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
          <View>
            <Text class="text-md text-secondary-foreground">{props.row.text}</Text>
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
            classes={{ codeBlock: PROSE.codeBlock, codeBlockCode: "p-3 text-xs" }}
          />
        </View>
      )}
    </If>
  );
}

function ToolCallRow(props: { row: ToolRow; compact?: boolean }) {
  const open = () => isOpen(props.row.id, false);
  const desc = () => describeToolCall(props.row, activeLanguage());
  const running = () => props.row.status === "call" || props.row.status === "queued" || props.row.status === "running";

  return (
    <Collapsible open={open()} reveal content={<ToolDetail row={props.row} />}
    >
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
      <ProcessLine open={open() && hasBody()} onPress={hasBody() ? () => toggle(props.row.id, false) : undefined}>
        <RollingText id={() => props.row.id} text={title} class="min-w-0 shrink truncate text-md text-subtle" style={{ opacity: pulseOpacity }} />
      </ProcessLine>
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
  const livePreview = () => (props.row.running && !props.row.open && props.row.activeStep ? describeActiveStep(props.row.activeStep, activeLanguage()) : "");
  const shownPreview = keepLast(() => livePreview() || undefined, "");
  return (
    // The hairline under the header stays in both live and settled states, so the handoff cannot jump.
    <View class="border-b border-hairline pb-1.5">
      <ProcessLine
        open={props.row.open}
        onPress={props.row.hasDetails ? () => toggleTurn(props.row.id, props.row.open) : undefined}
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
        <Presence show={Boolean(livePreview())} scaleFrom={0.97} class="min-w-0 shrink">
          <RollingText id={() => props.row.id} text={() => shownPreview() ?? ""} class="min-w-0 shrink truncate text-md text-subtle" />
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
          <TextView markdown={props.row.text} selectable classes={{ ...PROSE, root: "gap-2 text-sm text-muted-foreground" }} />
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

/** A row of the chat's list: the projection's, with each reply as a row per block (and its actions after it, once finished). */
export type ChatRow = Exclude<DisplayRow, { kind: "text" }> | ProseRow | ReplyActionsRow;

/** The room around a row: turns are set apart, a turn's steps sit close, a reply's blocks a line apart. */
const SPACING: Record<ChatRow["kind"], string> = {
  user: "pt-7",
  turn: "pt-1.5 pb-2",
  prose: "py-1.5",
  actions: "pb-1",
  thinking: "py-1",
  activity: "py-1",
  bash: "py-1",
  notice: "py-2",
  summary: "py-3",
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
          </View>
        </View>
      }
    />
  );
}
