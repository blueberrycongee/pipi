import {
  batch,
  cleanup,
  computed,
  createAnimatedValue,
  effect,
  List,
  platform,
  reduceMotion,
  Scroll,
  signal,
  Text,
  untracked,
  View,
  type ListRef,
  type ScrollEvent,
  type ScrollRef,
  type ViewRef,
  type WheelEvent,
} from "nsh";
import { Button as BaseButton, Command, type CommandItem, Input, Popover } from "nsh/base";
import { runtimeModeRank } from "../agents/catalog";
import type { RuntimeMode } from "../agents/types";
import { basename, clip } from "../lib/format";
import { activeLanguage, formatAgentMeta, runtimeModeIcon, runtimeModeText, thinkingText, tr } from "../lib/i18n";
import { topBarHeight } from "../lib/layout";
import { collectTranscriptImages } from "../lib/media";
import { Pip } from "../mascot/Pip";
import type { ExtensionUiDialog, Model, ThinkingLevel } from "../pi/protocol";
import { providerName } from "../pi/providers";
import type { Row, ToolRow } from "../pi/transcript";
import { describeToolCall, elapsedSeconds, reasoningPreview } from "../pi/turns";
import { availableAgents, currentRuntimeCeiling, daemonSessionOfId, isChatFolder, placeLabel, showAgentSettings, wallpaper } from "../store/app";
import { backend } from "../store/backend";
import { docTabTitle } from "../store/docs";
import {
  closeSplit,
  focusedPane,
  focusPane,
  isSplitOpen,
  promoteSplitToPrimary,
  setSplitRatio,
  SPLIT_RATIO_DEFAULT,
  SPLIT_RATIO_MAX,
  SPLIT_RATIO_MIN,
  splitDrag,
  splitRatio,
  splitSide,
  splitTarget,
  swapSplitSide,
  workspaceBounds,
  type SplitDragState,
  type SplitSide,
  type SplitTarget,
} from "../store/split";
import { createSplitChatController, type SplitChatController } from "../store/split-chat";
import { AgentLogo } from "../ui/AgentLogo";
import { Button, Chip, IconButton } from "../ui/Button";
import { Icon } from "../ui/Icon";
import {
  DURATION,
  EASING,
  keepLast,
  PATIENCE_MS,
  popupHiddenStyle,
  popupLeavingStyle,
  popupStyle,
  Presence,
} from "../ui/motion";
import { RollingText } from "../ui/RollingText";
import { FOCUS_RING, GLASS_REGULAR, POPUP, PRESS } from "../ui/styles";
import { tip } from "../ui/Tip";
import { codeType, readingType, uiHeight, uiIconSize, uiRowHeight, uiType } from "../ui/typography";
import { FOLLOW_THRESHOLD, footOf, HORIZON_GAP, INPUT_WINDOW_MS, RELEASE_SETTLE_MS, ScrollToBottomPill, type ScrollMode, UPWARD_GUARD_MS } from "./chat-scroll";
import { Composer, type ComposerStore } from "./Composer";
import { DocEditor } from "./DocEditor";
import { isKnownMissingPath, MediaStreamContext } from "./Media";
import { ProseBlock, proseRows, type ProseRow } from "./Prose";

const RUNTIME_MODES: readonly RuntimeMode[] = ["approval-required", "auto-accept-edits", "full-access"];
const modelKey = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;

// ── Drag-to-split drop-zone overlay ─────────────────────────────────────────

function DropZoneCard(props: { side: SplitSide; active: () => boolean }) {
  const isLeft = props.side === "left";
  const label = () => (isLeft ? tr("Add left split", "添加到左侧分屏") : tr("Add right split", "添加到右侧分屏"));
  const icon = isLeft ? "splitLeft" : "splitRight";
  const scale = createAnimatedValue(1);
  effect(() => {
    const on = props.active();
    untracked(() => {
      if (reduceMotion()) {
        scale.set(1);
        return;
      }
      void scale.timing(on ? 1.018 : 1, { duration: 120, easing: EASING.signature });
    });
  });
  cleanup(() => void scale.stop());

  return (
    <View
      testID={isLeft ? "split-drop-left" : "split-drop-right"}
      accessibilityLabel={label()}
      class={`items-center justify-center rounded-[18px] corner-squircle border-[1.5px] border-dashed transition-colors duration-150 ease-out-quint motion-reduce:transition-none ${
        props.active()
          ? "border-hairline-hover bg-accent/80 shadow-composer dark:bg-accent/65 dark:shadow-composer-dark"
          : "border-border bg-card/88 shadow-popover dark:bg-card/82"
      }`}
      style={{
        ...GLASS_REGULAR,
        position: "absolute",
        top: topBarHeight() + 18,
        bottom: 20,
        ...(isLeft ? { left: 20 } : { right: 20 }),
        width: "34%",
        maxWidth: 320,
        minWidth: 180,
        transform: [{ scale }],
      }}
    >
      <View class="items-center gap-2.5 px-4">
        <Icon name={icon} size={22} tone={props.active() ? "brand-text" : "muted-foreground"} />
        <Text
          class={`text-center ${uiType("base")} font-medium ${
            props.active() ? "text-brand-text" : "text-muted-foreground"
          }`}
        >
          {label()}
        </Text>
      </View>
    </View>
  );
}

/** The ghost's tilt cap while it trails the pointer (degrees). */
const GHOST_MAX_TILT = 7;
/** Pointer speed (px/ms) that reaches full tilt. */
const GHOST_TILT_SPEED = 0.7;
/** Horizontal follow: near-critical so the card tracks the pointer within ~20px. */
/** Tilt wobble: underdamped so a flick swings past center and settles. */
const GHOST_TILT_SPRING = { stiffness: 190, damping: 13, mass: 0.9 };
/** Pickup pop: a quick slightly-overshooting lift when the card appears. */
const GHOST_PICK_SPRING = { stiffness: 420, damping: 16, mass: 0.9 };
/** Pointer-quiet window after which the tilt eases back to level. */
const GHOST_TILT_REST_MS = 140;

/** Where the ghost's leading corner sits for pointer `(x, y)`, clamped inside the workspace. */
function ghostTarget(x: number, y: number) {
  const rect = workspaceBounds();
  if (!rect) return null;
  return {
    left: Math.max(12, Math.min(rect.width - 212, x - rect.left + 14)),
    top: Math.max(12, Math.min(rect.height - 44, y - rect.top - 16)),
  };
}

/**
 * The dragged card: a small preview pill that trails the pointer on springs.
 * Horizontal pointer velocity leans it a few degrees (a card held by a corner);
 * appearing it pops up with a deeper shadow, and on drop or cancel it shrinks
 * out under the overlay's own fade. `reduceMotion` keeps it rigid and level.
 */
function SplitDragGhost(props: { drag: () => SplitDragState; exiting: () => boolean }) {
  const first = ghostTarget(props.drag().x, props.drag().y) ?? { left: 12, top: 12 };
  const gx = createAnimatedValue(first.left);
  const gy = createAnimatedValue(first.top);
  const tilt = createAnimatedValue(0);
  const lift = createAnimatedValue(1);
  let lastX = props.drag().x;
  let lastT = Date.now();
  let lastVx = 0;
  let tiltTimer: ReturnType<typeof setTimeout> | undefined;

  if (!reduceMotion()) {
    lift.set(0.9);
    void lift.spring(1, GHOST_PICK_SPRING);
  }

  effect(() => {
    const d = props.drag();
    const pos = ghostTarget(d.x, d.y);
    if (!pos) return;
    const now = Date.now();
    const dt = now - lastT;
    let vx = lastVx;
    if (dt > 0) vx = (d.x - lastX) / dt;
    lastX = d.x;
    lastT = now;
    lastVx = vx;
    untracked(() => {
      if (reduceMotion()) {
        gx.set(pos.left);
        gy.set(pos.top);
        tilt.set(0);
        return;
      }
      gx.set(pos.left);
      gy.set(pos.top);
      const lean = Math.max(-GHOST_MAX_TILT, Math.min(GHOST_MAX_TILT, (vx / GHOST_TILT_SPEED) * GHOST_MAX_TILT));
      void tilt.spring(lean, GHOST_TILT_SPRING);
      clearTimeout(tiltTimer);
      tiltTimer = setTimeout(() => {
        tiltTimer = undefined;
        void tilt.spring(0, GHOST_TILT_SPRING);
      }, GHOST_TILT_REST_MS);
    });
  });

  effect(() => {
    const off = props.exiting();
    untracked(() => {
      if (reduceMotion() || !off) return;
      void lift.timing(0.92, { duration: DURATION.instant, easing: EASING.exit });
      void tilt.spring(0, GHOST_TILT_SPRING);
    });
  });

  cleanup(() => {
    clearTimeout(tiltTimer);
    void gx.stop();
    void gy.stop();
    void tilt.stop();
    void lift.stop();
  });

  const d = props.drag();
  return (
    <View
      testID="split-drag-ghost"
      class={`pointer-events-none absolute left-0 top-0 max-w-56 flex-row items-center gap-2 rounded-xl corner-squircle border-[0.5px] border-hairline px-2.5 py-1.5 shadow-toast ${
        platform.os === "linux" ? "bg-popover" : "bg-popover/72 dark:bg-popover/68"
      }`}
      style={{
        ...GLASS_REGULAR,
        transformOrigin: "18% 0%",
        transform: [{ translateX: gx }, { translateY: gy }, { rotate: tilt }, { scale: lift }],
      }}
    >
      {d.target.kind === "doc" ? (
        <Icon name="file" size={13} tone="foreground" class="shrink-0" />
      ) : d.agentId ? (
        <AgentLogo id={d.agentId} size={13} tone="foreground" />
      ) : (
        <Icon name="terminal" size={13} tone="foreground" class="shrink-0" />
      )}
      <Text class={`min-w-0 flex-1 truncate ${uiType("sm")} font-medium text-foreground`}>{d.title}</Text>
    </View>
  );
}

/**
 * Arc/Dia-style split drop overlay shown over the workspace while a sidebar row
 * or tab pill is dragged into the canvas. Left and right dashed drop zones let
 * the user pick either half; releasing in the center gap cancels cleanly.
 */
export function SplitDropOverlay() {
  const active = computed(() => Boolean(splitDrag()?.overWorkspace));
  const mounted = signal(untracked(active));
  const opacity = createAnimatedValue(untracked(active) ? 1 : 0);
  let hideTimer: ReturnType<typeof setTimeout> | undefined;

  effect(() => {
    const on = active();
    untracked(() => {
      clearTimeout(hideTimer);
      if (reduceMotion()) {
        opacity.set(on ? 1 : 0);
        mounted.set(on);
        return;
      }
      if (on) {
        mounted.set(true);
        void opacity.timing(1, { duration: 130, easing: EASING.entrance });
      } else if (mounted()) {
        void opacity.timing(0, { duration: DURATION.instant, easing: EASING.exit });
        hideTimer = setTimeout(() => {
          hideTimer = undefined;
          if (!untracked(active)) mounted.set(false);
        }, DURATION.instant + 10);
      }
    });
  });
  cleanup(() => {
    clearTimeout(hideTimer);
    void opacity.stop();
  });

  const shownDrag = keepLast(() => (splitDrag()?.overWorkspace ? splitDrag() : undefined));

  return (
    <If when={mounted()}>
      <View
        testID="split-drop-overlay"
        class="pointer-events-none absolute inset-0 z-40 overflow-hidden"
        style={{ opacity }}
      >
        <DropZoneCard side="left" active={() => splitDrag()?.hoverSide === "left"} />
        <DropZoneCard side="right" active={() => splitDrag()?.hoverSide === "right"} />
        <If when={shownDrag()}>
          {(d) => <SplitDragGhost drag={d} exiting={() => !active()} />}
        </If>
      </View>
    </If>
  );
}

// ── Draggable resize sash between primary and split panes ───────────────────

const SPLIT_PANE_MIN_WIDTH = 280;
const sashDragging = signal(false);
let sashStartX = 0;
let sashStartRatio = SPLIT_RATIO_DEFAULT;
let sashLastDeltaX = 0;
let sashPanActive = false;
let sashPressClickCount = 0;
let sashDragMoved = false;

export const isSplitSashDragging = () => sashDragging();

function clampSplitSashRatio(ratio: number, width: number) {
  const minRatio = Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, SPLIT_PANE_MIN_WIDTH / width));
  return Math.min(SPLIT_RATIO_MAX, Math.max(minRatio, ratio));
}

function updateSplitSashDrag(deltaX: number) {
  if (!untracked(sashDragging)) return;
  const rect = workspaceBounds();
  if (!rect || rect.width <= 0) return;
  sashLastDeltaX = deltaX;
  if (Math.abs(deltaX) >= 4) sashDragMoved = true;
  const delta = deltaX / rect.width;
  const raw = splitSide() === "left" ? sashStartRatio + delta : sashStartRatio - delta;
  setSplitRatio(clampSplitSashRatio(raw, rect.width));
}

function finishSplitSashDrag(deltaX = sashLastDeltaX) {
  if (!untracked(sashDragging)) return;
  updateSplitSashDrag(deltaX);
  sashDragging.set(false);
  sashPanActive = false;
}

function resetSplitSashForDoubleClick() {
  if (sashPressClickCount >= 2 && !sashDragMoved) setSplitRatio(SPLIT_RATIO_DEFAULT);
}

export function notifySplitSashMove(pageX: number, pressed: boolean) {
  if (!untracked(sashDragging)) return;
  if (!pressed) {
    if (!sashPanActive) finishSplitSashDrag();
    return;
  }
  updateSplitSashDrag(pageX - sashStartX);
}

export function notifySplitSashUp(pageX?: number) {
  if (!untracked(sashDragging) || sashPanActive) return;
  finishSplitSashDrag(pageX === undefined ? sashLastDeltaX : pageX - sashStartX);
}

export function SplitResizeSash() {
  const hovered = signal(false);
  const panX = createAnimatedValue(0);
  let hoverTimer: ReturnType<typeof setTimeout> | undefined;

  const clearHover = () => {
    if (hoverTimer !== undefined) {
      clearTimeout(hoverTimer);
      hoverTimer = undefined;
    }
  };
  cleanup(() => {
    clearHover();
    sashDragging.set(false);
    sashPanActive = false;
  });

  return (
    <View
      testID="split-resize-sash"
      role="adjustable"
      focusable={false}
      desktop={{ windowDrag: false }}
      accessibilityLabel={tr("Split pane width", "分屏宽度")}
      class="relative z-20 w-[1px] shrink-0 bg-border/70"
      style={{ paddingTop: topBarHeight() }}
    >
      <View
        testID="split-resize-sash-hit"
        style={{ position: "absolute", top: topBarHeight(), bottom: 0, left: -4, width: 9, zIndex: 25, cursor: "col-resize" }}
        pan={{ x: panX }}
        panActivation={{ activeOffsetX: 4 }}
        onPanStart={() => {
          sashPanActive = true;
        }}
        onPanEnd={(e) => {
          sashPanActive = false;
          panX.set(0);
          finishSplitSashDrag(e.translation.x);
          resetSplitSashForDoubleClick();
          hovered.set(false);
        }}
        onMouseEnter={() => {
          if (sashDragging()) return;
          clearHover();
          hoverTimer = setTimeout(() => {
            hoverTimer = undefined;
            hovered.set(true);
          }, 120);
        }}
        onMouseLeave={() => {
          clearHover();
          if (!sashDragging()) hovered.set(false);
        }}
        onPressDown={(e) => {
          clearHover();
          sashPressClickCount = e.clickCount;
          sashStartX = e.pagePosition.x;
          const width = workspaceBounds()?.width;
          sashStartRatio = width ? clampSplitSashRatio(splitRatio(), width) : splitRatio();
          sashLastDeltaX = 0;
          sashDragMoved = false;
          sashPanActive = false;
          panX.set(0);
          sashDragging.set(true);
        }}
        onPressUp={() => {
          if (!sashPanActive) {
            finishSplitSashDrag();
            resetSplitSashForDoubleClick();
          }
          hovered.set(false);
        }}
        onTouchMove={(e) => updateSplitSashDrag(e.pageX - sashStartX)}
        onTouchEnd={(e) => {
          if (!sashPanActive) finishSplitSashDrag(e.pageX - sashStartX);
          resetSplitSashForDoubleClick();
        }}
        onTouchCancel={() => {
          if (!sashPanActive) finishSplitSashDrag();
        }}
      >
        <View
          class={`pointer-events-none absolute inset-y-0 left-1 w-[2px] transition-opacity duration-150 ${
            sashDragging() ? "bg-brand/60" : "bg-foreground/18"
          }`}
          style={{ opacity: sashDragging() || hovered() ? 1 : 0 }}
        />
      </View>
    </View>
  );
}

// ── Split chat transcript & pickers ─────────────────────────────────────────

function SplitToolRow(props: { row: ToolRow }) {
  const open = signal(false);
  const info = () => describeToolCall({ ...props.row, name: props.row.name ?? "" }, activeLanguage());
  const hasOutput = () => Boolean(props.row.output?.trim());

  return (
    <View class="w-full py-0.5">
      <BaseButton
        disabled={!hasOutput()}
        onPress={() => open.update((v) => !v)}
        class={`w-full flex-row items-center gap-1.5 rounded-md corner-squircle px-1.5 py-1 text-left ${
          hasOutput() ? `${PRESS} hover:bg-accent` : ""
        }`}
      >
        <Icon
          name={props.row.status === "running" ? "clock" : props.row.status === "error" ? "alert" : info().icon}
          size={13}
          tone={props.row.status === "running" ? "brand" : props.row.status === "error" ? "destructive" : "subtle"}
          class="shrink-0"
        />
        <Text class={`shrink-0 ${uiType("sm")} font-medium text-foreground`}>{info().verb}</Text>
        <If when={info().target}>
          <Text class={`min-w-0 flex-1 truncate font-mono ${uiType("xs")} text-muted-foreground`}>
            {info().target}
          </Text>
        </If>
        <If when={hasOutput()}>
          <Icon name={open() ? "chevronDown" : "chevronRight"} size={12} tone="subtle" class="shrink-0" />
        </If>
      </BaseButton>
      <If when={open() && hasOutput()}>
        <View class="mt-1 rounded-lg corner-squircle border-[0.5px] border-border bg-sunken px-3 py-2">
          <Text class={`select-text font-mono ${codeType()} leading-relaxed text-muted-foreground`}>
            {clip(props.row.output ?? "", 24, 3000).text}
          </Text>
        </View>
      </If>
    </View>
  );
}

function SplitThinkingRow(props: { text: string; streaming: boolean; durationMs?: number }) {
  const open = signal(false);
  const secs = () => (props.durationMs ? elapsedSeconds(props.durationMs) : 0);
  const label = () => {
    if (props.streaming) return tr("Thinking…", "正在思考…");
    const s = secs();
    return s > 0 ? tr(`Thought for ${s}s`, `思考了 ${s} 秒`) : tr("Thought", "已思考");
  };
  const preview = () => reasoningPreview(props.text);

  return (
    <View class="w-full py-0.5">
      <BaseButton
        onPress={() => open.update((v) => !v)}
        class={`w-full flex-row items-center gap-1.5 rounded-md corner-squircle px-1.5 py-1 text-left ${PRESS} hover:bg-accent`}
      >
        <Icon name="thinking" size={13} tone="subtle" class="shrink-0" />
        <Text class={`shrink-0 ${uiType("sm")} text-muted-foreground`}>{label()}</Text>
        <If when={!open() && preview()}>
          <Text class={`min-w-0 flex-1 truncate ${uiType("xs")} text-subtle`}>{preview()}</Text>
        </If>
        <Icon name={open() ? "chevronDown" : "chevronRight"} size={12} tone="subtle" class="shrink-0" />
      </BaseButton>
      <If when={open()}>
        <View class="mt-1 border-l-2 border-border pl-3">
          <Text class={`select-text ${readingType("sm")} leading-relaxed text-muted-foreground`}>
            {props.text}
          </Text>
        </View>
      </If>
    </View>
  );
}

type SplitListRow = Row | ProseRow;

function SplitUserRow(props: { row: Extract<Row, { kind: "user" }>; anchor?: () => string | undefined; onAnchor?: (node: ViewRef | undefined) => void }) {
  const hostNode = signal<ViewRef | undefined>(undefined);
  effect(() => {
    const target = props.anchor?.();
    const node = hostNode();
    if (target !== props.row.id || !node) return;
    untracked(() => props.onAnchor?.(node));
    cleanup(() => props.onAnchor?.(undefined));
  });
  if (!props.row.text.trim()) return null;
  return (
    <View ref={(node: ViewRef) => hostNode.set(node)} class="w-full items-end pt-3 pb-1.5">
      <View class="max-w-[82%] rounded-2xl corner-squircle bg-secondary px-3.5 py-2">
        <Text class={`select-text ${readingType()} leading-relaxed text-secondary-foreground`}>
          {props.row.text}
        </Text>
      </View>
    </View>
  );
}

function SplitNoticeRow(props: { row: Extract<Row, { kind: "notice" }> }) {
  const isErr = props.row.tone === "error";
  return (
    <View
      class={`my-1.5 flex-row items-start gap-2 rounded-xl corner-squircle border px-3 py-2 ${
        isErr ? "border-destructive/30 bg-destructive/8" : "border-border bg-card"
      }`}
    >
      <Icon name={isErr ? "alert" : "info"} size={14} tone={isErr ? "destructive" : "subtle"} class="mt-0.5 shrink-0" />
      <View class="min-w-0 flex-1 gap-0.5">
        <Text class={`${uiType("sm")} font-medium ${isErr ? "text-destructive" : "text-foreground"}`}>{props.row.title}</Text>
        <If when={props.row.text}>
          <Text class={`select-text ${uiType("xs")} text-muted-foreground`}>
            {props.row.text}
          </Text>
        </If>
      </View>
    </View>
  );
}

function SplitRowItem(props: { row: SplitListRow; anchor?: () => string | undefined; onAnchor?: (node: ViewRef | undefined) => void }) {
  const of = <K extends SplitListRow["kind"]>(kind: K) => (props.row.kind === kind ? (props.row as Extract<SplitListRow, { kind: K }>) : undefined);
  return (
    <View class="w-full">
      <If when={of("user")}>{(row) => <SplitUserRow row={row()} anchor={props.anchor} onAnchor={props.onAnchor} />}</If>
      <If when={of("prose")}>
        {(row) => (
          <View class="w-full py-1">
            <ProseBlock row={row()} />
          </View>
        )}
      </If>
      <If when={of("text")}>
        {(row) => (
          <View class="w-full gap-1.5 py-1">
            <Each of={proseRows({ id: row().id, text: row().text, streaming: row().streaming })} key={(b) => b.id}>
              {(b) => <ProseBlock row={b()} />}
            </Each>
          </View>
        )}
      </If>
      <If when={of("thinking")}>{(row) => <SplitThinkingRow text={row().text} streaming={row().streaming} durationMs={row().durationMs} />}</If>
      <If when={of("tool")}>{(row) => <SplitToolRow row={row()} />}</If>
      <If when={of("notice")}>{(row) => <SplitNoticeRow row={row()} />}</If>
    </View>
  );
}

function SplitDialogPrompt(props: { dialog: ExtensionUiDialog; onAnswer: (id: string, answer: any) => void }) {
  const inputVal = signal("");
  const d = props.dialog;

  if (d.method === "form") return null;

  return (
    <View class={`mb-2 gap-2.5 rounded-2xl corner-squircle border-[0.5px] border-hairline bg-card/90 p-3 shadow-popover`}>
      <View class="gap-1">
        <Text class={`${uiType("base")} font-medium text-foreground`}>{d.title}</Text>
        <If when={d.method === "confirm" && d.message}>
          <Text class={`select-text ${uiType("xs")} text-muted-foreground`}>
            {(d as Extract<ExtensionUiDialog, { method: "confirm" }>).message}
          </Text>
        </If>
      </View>
      <If when={d.method === "confirm"}>
        <View class="flex-row justify-end gap-2">
          <Button size="sm" variant="secondary" label={tr("Deny", "拒绝")} onPress={() => props.onAnswer(d.id, { confirmed: false })} />
          <Button size="sm" variant="primary" label={tr("Allow", "允许")} onPress={() => props.onAnswer(d.id, { confirmed: true })} />
        </View>
      </If>
      <If when={d.method === "select"}>
        <View class="gap-1">
          <Each of={(d as Extract<ExtensionUiDialog, { method: "select" }>).options} key={(opt) => opt}>
            {(opt) => (
              <BaseButton
                onPress={() => props.onAnswer(d.id, { value: opt() })}
                class={`${uiHeight(28)} rounded-md corner-squircle px-2.5 text-left hover:bg-accent ${PRESS}`}
              >
                <Text class={`${uiType("sm")} text-foreground`}>{opt()}</Text>
              </BaseButton>
            )}
          </Each>
        </View>
      </If>
      <If when={d.method === "input"}>
        <View class="flex-row items-center gap-2">
          <Input
            value={inputVal()}
            onChange={({ value }) => inputVal.set(value)}
            onSubmit={() => props.onAnswer(d.id, { value: inputVal() })}
            placeholder={(d as Extract<ExtensionUiDialog, { method: "input" }>).placeholder ?? ""}
            class={`flex-1 rounded-lg corner-squircle border border-input bg-background px-2.5 py-1.5 ${uiType("sm")} text-foreground`}
          />
          <Button size="sm" variant="primary" label={tr("Submit", "提交")} onPress={() => props.onAnswer(d.id, { value: inputVal() })} />
        </View>
      </If>
    </View>
  );
}

// ── Split chat pickers (Agent, Model, Thinking, Permission) ─────────────────

function SplitAgentPicker(props: { chat: SplitChatController; onOpen?: () => void }) {
  const open = signal(false);
  const current = () => props.chat.agent();
  const list = () => availableAgents().filter((a) => a.available);

  return (
    <Popover
      open={open()}
      onOpenChange={(e) => {
        if (e.open) props.onOpen?.();
        open.set(e.open);
      }}
      placement="top"
      align="start"
      offset={8}
      margin={12}
      popupClass={`w-56 p-1 ${POPUP}`}
      popupStyle={popupStyle("top", "start")}
      popupStartingStyle={popupHiddenStyle("top", "start")}
      popupEndingStyle={popupLeavingStyle("top", "start")}
      trigger={
        <BaseButton
          accessibilityLabel={tr("Switch split agent", "切换分屏智能体")}
          tooltip={tip(current().name)}
          class={`${uiHeight(24)} max-w-28 shrink-0 overflow-hidden flex-row items-center gap-1.5 rounded-md corner-squircle px-1.5 hover:bg-accent ${PRESS} ${FOCUS_RING}`}
        >
          <View class="shrink-0">
            <AgentLogo id={current().id} size={13} tone="foreground" />
          </View>
          <Text class={`min-w-0 shrink truncate ${uiType("xs")} font-medium text-foreground`}>{current().name}</Text>
        </BaseButton>
      }
    >
      <Scroll class="max-h-60">
        <Each of={list()} key={(a) => a.id}>
          {(a) => {
            const active = () => a().id === props.chat.agentId();
            return (
              <BaseButton
                onPress={() => {
                  open.set(false);
                  void props.chat.chooseAgent(a().id);
                }}
                class={`${uiRowHeight(28)} w-full flex-row items-center gap-2 rounded-md corner-squircle px-2 hover:bg-accent ${PRESS}`}
              >
                <AgentLogo id={a().id} size={14} tone="foreground" />
                <Text class={`min-w-0 flex-1 truncate ${uiType("sm")} ${active() ? "font-medium text-foreground" : "text-muted-foreground"}`}>
                  {a().name}
                </Text>
                <If when={active()}>
                  <Icon name="check" size={13} tone="brand-text" />
                </If>
              </BaseButton>
            );
          }}
        </Each>
      </Scroll>
    </Popover>
  );
}

function SplitModelPicker(props: { chat: SplitChatController; onOpen?: () => void }) {
  const open = signal(false);
  const query = signal("");
  const current = () => props.chat.currentModel();
  const currentKey = () => (current() ? modelKey(current()!) : "");
  const models = () => props.chat.availableModels();
  const byKey = computed(() => new Map<string, Model>(models().map((m) => [modelKey(m), m])));
  const items = computed<CommandItem[]>(() =>
    models().map((m) => ({
      id: modelKey(m),
      label: m.name || m.id,
      keywords: [m.id, m.provider, providerName(m.provider)],
      group: providerName(m.provider),
      checked: modelKey(m) === currentKey(),
    })),
  );

  return (
    <Popover
      open={open()}
      onOpenChange={(e) => {
        if (e.open) {
          props.onOpen?.();
          query.set("");
        }
        open.set(e.open);
      }}
      placement="top"
      align="start"
      offset={8}
      margin={12}
      popupClass={`w-64 overflow-hidden ${POPUP}`}
      popupStyle={popupStyle("top", "start")}
      popupStartingStyle={popupHiddenStyle("top", "start")}
      popupEndingStyle={popupLeavingStyle("top", "start")}
      trigger={
        <Chip
          label={current()?.name || current()?.id || tr("Model", "模型")}
          tipText={tr("Switch split model", "切换分屏模型")}
          onPress={() => open.update((v) => !v)}
          class="min-w-0 max-w-36 shrink"
        />
      }
    >
      <If
        when={models().length > 0}
        else={
          <View class="items-center gap-2 p-4">
            <Text class={`${uiType("xs")} text-muted-foreground`}>{tr("No models available", "暂无可用模型")}</Text>
            <Button
              size="sm"
              variant="secondary"
              label={tr("Configure", "去配置")}
              onPress={() => {
                open.set(false);
                showAgentSettings(props.chat.agentId());
              }}
            />
          </View>
        }
      >
        <Command
          items={items()}
          query={query()}
          onQueryChange={(event) => query.set(event.query)}
          placeholder={tr("Search models…", "搜索模型…")}
          accessibilityLabel={tr("Split models", "分屏模型")}
          onCancel={() => open.set(false)}
          onSelect={(item) => {
            open.set(false);
            const chosen = byKey().get(item.id);
            if (chosen) void props.chat.chooseModel(chosen);
          }}
          class="max-h-72"
        />
      </If>
    </Popover>
  );
}

function SplitThinkingPicker(props: { chat: SplitChatController; onOpen?: () => void }) {
  const open = signal(false);
  const levels = () => props.chat.thinkingLevels();
  const show = () => Boolean(props.chat.currentModel()?.reasoning) && levels().length > 1;
  const current = () => props.chat.thinkingLevel();

  return (
    <If when={show()}>
      <Popover
        open={open()}
        onOpenChange={(e) => {
          if (e.open) props.onOpen?.();
          open.set(e.open);
        }}
        placement="top"
        align="start"
        offset={8}
        margin={12}
        popupClass={`w-44 p-1 ${POPUP}`}
        popupStyle={popupStyle("top", "start")}
        popupStartingStyle={popupHiddenStyle("top", "start")}
        popupEndingStyle={popupLeavingStyle("top", "start")}
        trigger={
          <Chip
            label={thinkingText(current()).label}
            tipText={tr("Thinking level", "思考深度")}
            onPress={() => open.update((v) => !v)}
          />
        }
      >
        <Each of={levels()} key={(l) => l}>
          {(level) => {
            const active = () => level() === current();
            return (
              <BaseButton
                onPress={() => {
                  open.set(false);
                  void props.chat.chooseThinkingLevel(level());
                }}
                class={`${uiRowHeight(28)} w-full flex-row items-center justify-between rounded-md corner-squircle px-2 hover:bg-accent ${PRESS}`}
              >
                <Text class={`${uiType("sm")} ${active() ? "font-medium text-foreground" : "text-muted-foreground"}`}>
                  {thinkingText(level()).label}
                </Text>
                <If when={active()}>
                  <Icon name="check" size={13} tone="brand-text" />
                </If>
              </BaseButton>
            );
          }}
        </Each>
      </Popover>
    </If>
  );
}

function SplitPermissionPicker(props: { chat: SplitChatController; onOpen?: () => void }) {
  const open = signal(false);
  const current = () => props.chat.runtimeMode();
  const ceiling = () => currentRuntimeCeiling();
  const supported = () => {
    const raw = props.chat.agent().supportedRuntimeModes;
    return RUNTIME_MODES.filter(
      (m) => runtimeModeRank(m) <= runtimeModeRank(ceiling()) && (raw.length === 0 || raw.includes(m)),
    );
  };

  return (
    <Popover
      open={open()}
      onOpenChange={(e) => {
        if (e.open) props.onOpen?.();
        open.set(e.open);
      }}
      placement="top"
      align="end"
      offset={8}
      margin={12}
      popupClass={`w-52 p-1 ${POPUP}`}
      popupStyle={popupStyle("top", "end")}
      popupStartingStyle={popupHiddenStyle("top", "end")}
      popupEndingStyle={popupLeavingStyle("top", "end")}
      trigger={
        <IconButton
          icon={runtimeModeIcon(current())}
          size="sm"
          tone="subtle"
          label={runtimeModeText(current()).label}
          tipPlacement="top"
          onPress={() => open.update((v) => !v)}
        />
      }
    >
      <Each of={supported()} key={(m) => m}>
        {(mode) => {
          const active = () => mode() === current();
          const info = () => runtimeModeText(mode());
          return (
            <BaseButton
              onPress={() => {
                open.set(false);
                void props.chat.chooseRuntimeMode(mode());
              }}
              class={`w-full flex-row items-center gap-2 rounded-md corner-squircle px-2 py-1.5 hover:bg-accent ${PRESS}`}
            >
              <Icon name={runtimeModeIcon(mode())} size={14} tone={active() ? "brand-text" : "muted-foreground"} />
              <View class="min-w-0 flex-1">
                <Text class={`${uiType("sm")} ${active() ? "font-medium text-foreground" : "text-foreground"}`}>
                  {info().label}
                </Text>
              </View>
              <If when={active()}>
                <Icon name="check" size={13} tone="brand-text" />
              </If>
            </BaseButton>
          );
        }}
      </Each>
    </Popover>
  );
}

// ── Live split chat view ────────────────────────────────────────────────────

function SplitChatView(props: { chat: SplitChatController }) {
  let list: ListRef | undefined;
  let ending: ViewRef | undefined;
  const scrollMode = signal<ScrollMode>("tail");
  const bottomFollowing = computed(() => scrollMode() === "tail" || scrollMode() === "horizon");
  const distanceFromEnd = signal(0);
  const activePromptId = signal<string | undefined>(undefined);
  let stagedPromptSeen = "";
  let horizonNode: ViewRef | undefined;
  let checkingHorizon = false;
  let inputAt = 0;
  let releasedAt = 0;
  let lastUpwardInputAt = 0;
  let isDragging = false;
  let wheelDirection = 0;
  let lastY: number | undefined;
  let lastDistance = 0;
  let lastMax = 0;
  let lastScrollDir = 0;
  let endSettlePasses = 0;
  let endSettleEpoch = 0;
  const figure = signal(0);
  const foot = computed(() => footOf(figure()), { equals: (a, b) => a.end === b.end });
  const waitVisible = signal(false);

  effect(() => {
    const waiting = props.chat.loading() && props.chat.rows().length === 0;
    if (!waiting) {
      waitVisible.set(false);
      return;
    }
    const timer = setTimeout(() => waitVisible.set(true), PATIENCE_MS);
    cleanup(() => clearTimeout(timer));
  });

  const activityText = () => {
    const dialog = props.chat.pendingDialog();
    if (dialog) return tr("Waiting for confirmation", "等待确认");
    const act = props.chat.activity();
    switch (act.kind) {
      case "compacting":
        return tr("Compacting context", "正在压缩上下文");
      case "retrying":
        return tr(`Retrying (${act.attempt})`, `正在重试（第 ${act.attempt} 次）`);
      case "writing":
        return tr("Writing", "正在回复");
      case "tool":
        return tr(`Running ${act.name}`, `正在执行 ${act.name}`);
      case "thinking":
        return tr("Thinking", "正在思考");
      default:
        return "";
    }
  };

  const disengageFollow = (upward = false) => {
    endSettleEpoch++;
    endSettlePasses = 0;
    releasedAt = Date.now();
    if (upward) lastUpwardInputAt = releasedAt;
    if (untracked(scrollMode) !== "free") scrollMode.set("free");
  };

  const measureEnd = () => {
    if (untracked(bottomFollowing)) return;
    const pad = untracked(foot).end;
    void Promise.all([list?.measure(), ending?.measure()]).then(([frame, end]) => {
      if (!frame || !end || untracked(bottomFollowing)) return;
      const gap = end.pagePosition.y + end.bounds.size.height + pad - (frame.pagePosition.y + frame.bounds.size.height);
      lastMax = Math.max(0, (lastY ?? 0) + gap);
      distanceFromEnd.set(Math.max(0, gap));
    });
  };

  const checkHorizon = () => {
    if (checkingHorizon || untracked(scrollMode) !== "horizon" || !untracked(props.chat.running)) return;
    if (isDragging || Date.now() - inputAt <= INPUT_WINDOW_MS || Date.now() - lastUpwardInputAt <= UPWARD_GUARD_MS) return;
    const targetList = list;
    const targetNode = horizonNode;
    if (!targetList || !targetNode) return;
    checkingHorizon = true;
    void Promise.all([targetList.measure(), targetNode.measure(), ending?.measure()]).then(([frame, prompt, end]) => {
      checkingHorizon = false;
      if (list !== targetList || horizonNode !== targetNode) return;
      if (untracked(scrollMode) !== "horizon" || !untracked(props.chat.running)) return;
      if (isDragging || Date.now() - inputAt <= INPUT_WINDOW_MS || Date.now() - lastUpwardInputAt <= UPWARD_GUARD_MS) return;
      if (!frame || !prompt || frame.bounds.size.height <= 0) return;
      const pad = untracked(foot).end;
      const frameBottom = frame.pagePosition.y + frame.bounds.size.height;
      if (end && end.pagePosition.y + end.bounds.size.height + pad < frameBottom - 24) return;
      const hTop = frame.pagePosition.y + HORIZON_GAP;
      const readableBottom = frameBottom - pad;
      const readableH = Math.max(120, readableBottom - hTop);
      const promptTop = prompt.pagePosition.y;
      const promptBottom = promptTop + prompt.bounds.size.height;
      const reached = prompt.bounds.size.height <= readableH * 0.4 ? promptTop <= hTop + 24 : promptBottom <= hTop + readableH * 0.32;
      if (!reached) return;
      endSettleEpoch++;
      endSettlePasses = 0;
      scrollMode.set("horizon-held");
      if (promptTop < frame.pagePosition.y + 4) {
        const promptId = untracked(activePromptId);
        const promptIndex = promptId ? untracked(listRows).findIndex((row) => row.id === promptId) : -1;
        if (promptIndex >= 0) targetList.scrollToIndex({ index: promptIndex, viewPosition: 0, viewOffset: HORIZON_GAP, animated: false });
      }
      measureEnd();
    });
  };

  const onWheel = (e: WheelEvent) => {
    inputAt = Date.now();
    wheelDirection = Math.sign(e.delta.y);
    if (e.delta.y < -0.1) {
      disengageFollow(true);
      return;
    }
    if (e.delta.y > 0.1 && untracked(scrollMode) === "horizon-held") scrollMode.set("free");
  };

  const onDragStart = () => {
    isDragging = true;
    wheelDirection = 0;
    inputAt = Date.now();
    endSettleEpoch++;
    endSettlePasses = 0;
  };

  const onDragEnd = () => {
    isDragging = false;
    inputAt = Date.now();
    const now = Date.now();
    const reattachThreshold = props.chat.running() ? 24 : FOLLOW_THRESHOLD;
    if (
      !untracked(bottomFollowing) &&
      lastScrollDir > 0 &&
      lastDistance <= reattachThreshold &&
      now - lastUpwardInputAt > UPWARD_GUARD_MS &&
      now - releasedAt > RELEASE_SETTLE_MS
    ) {
      scrollMode.set("tail");
    }
  };

  const onScroll = (e: ScrollEvent) => {
    const y = e.offset.y;
    const max = Math.max(0, e.contentSize.height - e.size.height);
    const distance = Math.max(0, e.contentSize.height - (y + e.size.height));
    const now = Date.now();
    const movedWithinContent = lastY !== undefined && lastY >= 0 && lastY <= lastMax + 0.5 && Math.abs(max - lastMax) <= 0.5;

    if (now - inputAt < INPUT_WINDOW_MS) {
      if (movedWithinContent && lastY !== undefined && Math.abs(y - lastY) > 0.5) {
        lastScrollDir = y < lastY ? -1 : 1;
      }
      if (
        untracked(bottomFollowing) &&
        isDragging &&
        wheelDirection <= 0 &&
        movedWithinContent &&
        lastY !== undefined &&
        y < lastY - 0.5 &&
        distance > lastDistance + 0.5
      ) {
        disengageFollow(true);
      } else if (untracked(scrollMode) === "horizon-held" && movedWithinContent && lastY !== undefined && Math.abs(y - lastY) > 0.5) {
        releasedAt = now;
        if (y < lastY - 0.5) lastUpwardInputAt = now;
        scrollMode.set("free");
      } else if (!untracked(bottomFollowing) && lastY !== undefined && y > lastY + 0.5) {
        const reattachThreshold = props.chat.running() ? 24 : 40;
        if (
          distance <= reattachThreshold &&
          now - lastUpwardInputAt > UPWARD_GUARD_MS &&
          now - releasedAt > RELEASE_SETTLE_MS
        ) {
          scrollMode.set("tail");
        }
      }
    }
    lastY = y;
    lastDistance = distance;
    lastMax = max;
    distanceFromEnd.set(distance);
    if (untracked(scrollMode) === "horizon") checkHorizon();

    if (endSettlePasses > 0) {
      endSettlePasses--;
      if (untracked(bottomFollowing) && !isDragging && now - inputAt > INPUT_WINDOW_MS && Math.abs(distance) > 1) {
        list?.scrollTo({ y: Math.max(0, e.contentSize.height - e.size.height), animated: false });
      }
    }
  };

  const scheduleEndSettle = (passes = 2) => {
    const epoch = ++endSettleEpoch;
    const targetList = list;
    if (!targetList) return;
    endSettlePasses = passes;
    void Promise.all([targetList.measure(), ending?.measure()]).then(([frame, end]) => {
      if (epoch !== endSettleEpoch) return;
      if (!untracked(bottomFollowing) || isDragging || Date.now() - inputAt <= INPUT_WINDOW_MS) return;
      if (!frame || list !== targetList) return;
      const pad = untracked(foot).end;
      if (end && frame.bounds.size.height > 0) {
        const gap = end.pagePosition.y + end.bounds.size.height + pad - (frame.pagePosition.y + frame.bounds.size.height);
        if (Math.abs(gap) <= 1 || (gap < 0 && (lastY === undefined || lastY <= 0.5))) {
          endSettlePasses = 0;
          distanceFromEnd.set(0);
          return;
        }
        if (lastY !== undefined) {
          targetList.scrollTo({ y: Math.max(0, lastY + gap), animated: false });
          return;
        }
      }
      targetList.scrollToEnd({ animated: false });
    });
  };

  const follow = (animated: boolean) => {
    inputAt = 0;
    lastUpwardInputAt = 0;
    isDragging = false;
    scrollMode.set("tail");
    if (animated) list?.scrollToEnd({ animated: true });
    else scheduleEndSettle(2);
  };
  const jumpToLatest = () => follow(!reduceMotion());

  // A newly staged prompt starts the same reading contract as the primary chat:
  // with history above it rides toward the horizon; at the conversation's start it simply follows the tail.
  effect(() => {
    const staged = props.chat.stagedUser();
    const rowsNow = props.chat.rows();
    if (!staged) return;
    untracked(() => {
      const index = rowsNow.findIndex((row) => row.id === staged.id);
      if (index < 0 || staged.id === stagedPromptSeen) return;
      stagedPromptSeen = staged.id;
      const hasHistoryAbove = index > 0;
      activePromptId.set(hasHistoryAbove ? staged.id : undefined);
      inputAt = 0;
      lastUpwardInputAt = 0;
      isDragging = false;
      scrollMode.set(hasHistoryAbove ? "horizon" : "tail");
      scheduleEndSettle(2);
    });
  });

  // Growth under a released reader measures the real end rather than trusting a stale scroll report.
  effect(() => {
    props.chat.rows();
    foot();
    untracked(() => {
      if (scrollMode() === "horizon") checkHorizon();
      measureEnd();
    });
  });

  // A short reply stays at the tail; one held at the reading horizon becomes the reader's on settle.
  effect(() => {
    const running = props.chat.running();
    untracked(() => {
      if (running) return;
      const mode = scrollMode();
      if (mode === "horizon") scrollMode.set("tail");
      else if (mode === "horizon-held") {
        scrollMode.set("free");
        measureEnd();
      }
    });
  });

  // The composer rising under a following view raises the conversation's end with it.
  let footEnd = untracked(foot).end;
  effect(() => {
    const end = foot().end;
    const rose = end > footEnd;
    footEnd = end;
    if (!rose || !untracked(bottomFollowing) || isDragging || Date.now() - inputAt <= INPUT_WINDOW_MS) return;
    scheduleEndSettle(2);
  });

  // Like the primary transcript, long prose is projected into row-sized blocks before
  // virtualization; one monolithic reply cell is both unmeasureable and easy to cull.
  const listRows = computed<SplitListRow[]>(() =>
    props.chat.rows().flatMap((row): SplitListRow[] =>
      row.kind === "text" ? proseRows({ id: row.id, text: row.text, streaming: row.streaming }) : [row],
    ),
  );
  const hasRows = () => listRows().length > 0;

  const composerStore: ComposerStore = {
    isActive: () => isSplitOpen(),
    isFocused: () => isSplitOpen() && focusedPane() === "split",
    onFocusPane: () => focusPane("split"),
    draft: props.chat.draft,
    setDraft: props.chat.setDraft,
    attachments: props.chat.attachments,
    addAttachment: props.chat.addAttachment,
    removeAttachment: props.chat.removeAttachment,
    files: props.chat.files,
    attachLocalPath: props.chat.attachLocalPath,
    removeFileAttachment: props.chat.removeFileAttachment,
    pickFile: props.chat.pickFile,
    docs: props.chat.docs,
    attachDocPath: props.chat.attachDocPath,
    detachDoc: props.chat.detachDoc,
    focusTick: props.chat.focusTick,
    requestFocus: props.chat.requestFocus,
    ready: () => !props.chat.error(),
    canSend: () => !props.chat.error(),
    failed: () => Boolean(props.chat.error()),
    hasModel: () => Boolean(props.chat.currentModel() || props.chat.availableModels().length > 0),
    visionSupported: () => Boolean(props.chat.currentModel()?.input?.includes("image")),
    running: props.chat.running,
    working: props.chat.running,
    agentName: props.chat.agentName,
    slashCommands: props.chat.slashCommands,
    pendingDialog: props.chat.pendingDialog,
    answerDialog: props.chat.answerDialog,
    contextUsage: () => ({ stats: props.chat.sessionStats(), hasRows: props.chat.rows().length > 0 }),
    send: async (mode) => {
      inputAt = 0;
      lastUpwardInputAt = 0;
      isDragging = false;
      if (untracked(scrollMode) !== "horizon") scrollMode.set("tail");
      scheduleEndSettle(2);
      await props.chat.send(mode);
    },
    stop: props.chat.stop,
    renderLeftPickers: (dismissMenus) => (
      <>
        <SplitAgentPicker chat={props.chat} onOpen={dismissMenus} />
        <View class="mx-0.5 h-3 w-[0.5px] bg-hairline-hover" />
        <SplitModelPicker chat={props.chat} onOpen={dismissMenus} />
        <SplitThinkingPicker chat={props.chat} onOpen={dismissMenus} />
      </>
    ),
    renderPermissionPicker: (dismissMenus) => <SplitPermissionPicker chat={props.chat} onOpen={dismissMenus} />,
    renderExtensionPrompt: () => (
      <If when={props.chat.pendingDialog()?.method !== "form" ? props.chat.pendingDialog() : undefined}>
        {(dialog) => <SplitDialogPrompt dialog={dialog()} onAnswer={props.chat.answerDialog} />}
      </If>
    ),
    inputTestID: "split-composer-input",
    inputLabel: tr("Split message", "分屏消息"),
    sendTestID: "split-send",
    stopTestID: "split-stop",
    autoFocus: false,
  };

  return (
    <View
      class="relative min-h-0 flex-1"
      onFileDrop={(e) => {
        for (const uri of e.uris) {
          const path = decodeURIComponent(uri.replace(/^file:\/\//, ""));
          if (path) void props.chat.attachLocalPath(path);
        }
      }}
    >
      <If
        when={hasRows()}
        else={
          <View class="flex-1 items-center justify-center gap-4 px-6 pb-8">
            <Pip size={64} mood={props.chat.mood()} />
            <View class="items-center gap-1">
              <Text class={`text-center ${uiType("lg")} font-semibold tracking-tight text-foreground`}>
                {waitVisible() ? tr("Loading session…", "正在加载会话…") : tr("Split chat", "分屏对话")}
              </Text>
              <Text class={`text-center ${uiType("xs")} text-subtle`}>
                {`${props.chat.agentName()} · ${placeLabel(props.chat.cwd())}`}
              </Text>
            </View>
            <If when={props.chat.error()}>
              {(err) => (
                <Text class={`max-w-72 text-center ${uiType("xs")} text-destructive`}>{err()}</Text>
              )}
            </If>
          </View>
        }
      >
        <MediaStreamContext.Provider
          value={{
            images: () =>
              collectTranscriptImages(untracked(props.chat.rows), {
                cwd: untracked(props.chat.cwd),
                home: backend().home(),
                isMissingPath: isKnownMissingPath,
              }),
            isolateGroups: () => daemonSessionOfId(props.chat.daemonId())?.persona === true,
          }}
        >
          <List
            ref={(node) => {
              list = node;
            }}
            each={listRows()}
            initialScrollAtEnd
            estimatedItemSize={44}
            keyExtractor={(row) => row.id}
            onScroll={onScroll}
            scrollEventThrottle={16}
            onScrollDragStart={onDragStart}
            onScrollDragEnd={onDragEnd}
            onMomentumStart={() => {
              inputAt = Date.now();
            }}
            onWheel={onWheel}
            maintainVisibleContentPosition={bottomFollowing() ? { autoscrollToBottomThreshold: FOLLOW_THRESHOLD } : undefined}
            accessibilityLabel={tr("Split conversation", "分屏对话内容")}
            class="min-h-0 flex-1"
            contentStyle={{
              paddingHorizontal: 20,
              paddingTop: 12,
              paddingBottom: foot().end,
            }}
            footer={
              <View
                ref={(node: ViewRef) => {
                  ending = node;
                }}
                class="mx-auto h-9 w-full max-w-180 justify-center"
              >
                <Presence show={props.chat.running() || props.chat.mood() === "happy"} scaleFrom={0.96} duration={150}>
                  <View class="flex-row items-center gap-2 pt-1">
                    <Pip size={20} mood={props.chat.mood()} />
                    <If when={activityText()}>
                      <RollingText text={activityText} class={`${uiType("xs")} text-muted-foreground`} />
                    </If>
                  </View>
                </Presence>
              </View>
            }
          >
            {(row) => (
              <View class="mx-auto w-full max-w-180">
                <SplitRowItem
                  row={row()}
                  anchor={() => activePromptId()}
                  onAnchor={(node) => {
                    horizonNode = node;
                  }}
                />
              </View>
            )}
          </List>
        </MediaStreamContext.Provider>
      </If>

      <ScrollToBottomPill
        visible={hasRows() && !bottomFollowing() && distanceFromEnd() > FOLLOW_THRESHOLD}
        bottom={foot().end}
        onPress={() => {
          jumpToLatest();
        }}
      />

      {/* Unified Composer — exact same component & capabilities as the primary pane, docked over the transcript's measured foot. */}
      <View
        class="pointer-events-none absolute inset-x-0 bottom-0 z-20"
        onLayout={(e) => figure.set(Math.round(e.bounds.size.height))}
      >
        <Composer store={composerStore} />
      </View>
    </View>
  );
}

// ── Split pane shell ────────────────────────────────────────────────────────

function splitHeaderMeta(target: SplitTarget, chat: SplitChatController | undefined) {
  if (target.kind === "doc") {
    return {
      title: docTabTitle(target.path),
      subtitle: basename(target.path),
      agentId: undefined as string | undefined,
    };
  }
  const cwd = chat ? chat.cwd() : target.cwd ?? "";
  return {
    title: chat ? chat.title() : target.title || tr("New session", "新会话"),
    subtitle: cwd && !isChatFolder(cwd) ? basename(cwd) : "",
    agentId: chat ? chat.agentId() : target.agentId,
  };
}

/**
 * The secondary split pane mounted beside the primary workspace (`left` or
 * `right`). Supports live concurrent chat sessions and Markdown documents.
 */
export function SplitPane() {
  const controller = signal<SplitChatController | undefined>(undefined);
  let lastKey = "";

  effect(() => {
    const target = splitTarget();
    untracked(() => {
      if (!target || target.kind !== "chat") {
        controller()?.dispose();
        controller.set(undefined);
        lastKey = "";
        return;
      }
      const nextKey = target.file || target.ref;
      if (nextKey === lastKey && controller()) return;
      controller()?.dispose();
      lastKey = nextKey;
      controller.set(createSplitChatController(target));
    });
  });

  cleanup(() => {
    controller()?.dispose();
    controller.set(undefined);
  });

  const isFocused = () => focusedPane() === "split";
  const widthPercent = (): `${number}%` => `${Number((splitRatio() * 100).toFixed(2))}%`;

  return (
    <If when={splitTarget()}>
      {(target) => {
        const meta = () => splitHeaderMeta(target(), controller());
        const chat = () => controller();
        return (
          <View
            testID="split-pane"
            accessibilityLabel={
              splitSide() === "left" ? tr("Left split pane", "左侧分屏") : tr("Right split pane", "右侧分屏")
            }
            class={`relative min-w-0 shrink-0 ${wallpaper() ? "bg-background/88" : "bg-background"}`}
            style={{
              width: widthPercent(),
              minWidth: SPLIT_PANE_MIN_WIDTH,
              paddingTop: topBarHeight(),
            }}
            onPressDown={() => focusPane("split")}
          >
            {/* Slim split-pane header */}
            <View
              class={`h-9 shrink-0 flex-row items-center justify-between gap-2 border-b px-3 ${
                isFocused() ? "border-hairline-hover" : "border-border/60"
              }`}
            >
              <View class="min-w-0 flex-1 flex-row items-center gap-1.5">
                <If when={isFocused()}>
                  <View class="size-1.5 shrink-0 rounded-full bg-brand" />
                </If>
                {target().kind === "doc" ? (
                  <Icon name="file" size={uiIconSize(13)} tone="muted-foreground" class="shrink-0" />
                ) : meta().agentId ? (
                  <AgentLogo id={meta().agentId!} size={uiIconSize(13)} tone="foreground" />
                ) : (
                  <Icon name="terminal" size={uiIconSize(13)} tone="subtle" class="shrink-0" />
                )}
                <Text testID="split-pane-title" class={`min-w-0 shrink truncate ${uiType("sm")} font-medium text-foreground`}>
                  {meta().title}
                </Text>
                <If when={meta().subtitle}>
                  <Text class={`shrink-0 truncate ${uiType("2xs")} text-subtle`}>{meta().subtitle}</Text>
                </If>
              </View>
              <View class="shrink-0 flex-row items-center gap-0.5">
                <IconButton
                  testID="split-swap"
                  icon="swap"
                  size="sm"
                  label={tr("Swap split sides", "交换左右分屏")}
                  onPress={swapSplitSide}
                />
                <IconButton
                  testID="split-promote"
                  icon="expand"
                  size="sm"
                  label={tr("Open in main pane", "在主视图中打开")}
                  onPress={() => {
                    const c = chat();
                    promoteSplitToPrimary(
                      c
                        ? {
                            file: c.sessionFile(),
                            daemonId: c.daemonId(),
                            cwd: c.cwd(),
                            agentId: c.agentId(),
                          }
                        : undefined,
                    );
                  }}
                />
                <IconButton
                  testID="split-close"
                  icon="x"
                  size="sm"
                  label={tr("Close split", "关闭分屏")}
                  onPress={closeSplit}
                />
              </View>
            </View>

            {/* Pane body: document editor or live chat */}
            <View class="relative min-h-0 flex-1">
              {target().kind === "doc" ? (
                <DocEditor path={(target() as Extract<SplitTarget, { kind: "doc" }>).path} />
              ) : (
                <If when={chat()}>{(c) => <SplitChatView chat={c()} />}</If>
              )}
            </View>
          </View>
        );
      }}
    </If>
  );
}
