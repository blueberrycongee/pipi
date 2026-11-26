import { Animated, Canvas, cleanup, computed, createAnimatedValue, effect, Path2D, reduceMotion, signal, Text, token, untracked, View } from "nsh";
import type { CanvasRenderingContext2D, CompositeAnimation, JSX, ViewRef } from "nsh";
import { Button as BaseButton, Popover } from "nsh/base";
import { Menu } from "nsh/desktop";
import { activeLanguage, tr } from "../lib/i18n";
import { derivePipLiveStatus, formatElapsedCompact, type PipChildStatus, type PipLiveStatus, type PipPhase } from "../lib/pip-status";
import { Pip } from "../mascot/Pip";
import {
  type PipDelegatedSession,
  type PipFooterRow,
  type PipSessionsRow,
  type PipTurnMeta,
  spokenDuration,
} from "../pi/turns";
import {
  activeAgent,
  copyMessage,
  currentActivity,
  currentChildSessions,
  currentDaemonSession,
  daemonSessionOfId,
  draftModel,
  headingDaemonSession,
  isLeavingSession,
  isRunning,
  openDaemonSession,
  pendingDialog,
  personaDisplayName,
  pipMood,
  runStart,
  sessionState,
  sidecarPhase,
  transcriptRows,
  waitingCount,
} from "../store/app";
import { Icon } from "../ui/Icon";
import {
  EASING,
  isRowSeen,
  popupHiddenStyle,
  popupLeavingStyle,
  popupStyle,
  useBreathingOpacity,
  useSmsBubbleEntrance,
} from "../ui/motion";
import { FOCUS_RING, HOVER_REVEAL, POPUP, PRESS, PRESS_SCALE } from "../ui/styles";
import { uiHeight, uiType } from "../ui/typography";
import { PipBubbleBlocks, type PipBubbleRow } from "./Prose";

const HOVER_OPEN_MS = 100;
const HOVER_CLOSE_MS = 160;

/** Crisp curved macOS iMessage tail drawn on a 11x15 Retina canvas. */
const TAIL_PATH = new Path2D(
  "M 11 0 L 5.5 0 C 5.5 6.8 3.6 11.4 0.4 13.8 C 0.1 14.05 0.25 14.5 0.7 14.5 C 4.4 14.5 7.6 13.3 10.2 11.2 L 11 11.2 Z",
);

export function BubbleTail(props: { side: "left" | "right"; tone: "sms-incoming" | "brand" }) {
  const draw = (cx: CanvasRenderingContext2D) => {
    cx.save();
    if (props.side === "right") {
      cx.translate(11, 0);
      cx.scale(-1, 1);
    }
    cx.fillStyle = token(props.tone);
    cx.fill(TAIL_PATH);
    cx.restore();
  };

  return (
    <View
      class={`pointer-events-none absolute bottom-0 ${props.side === "left" ? "-left-[5.5px]" : "-right-[5.5px]"}`}
      style={{ width: 11, height: 15 }}
    >
      <Canvas style={{ width: 11, height: 15 }} draw={draw} />
    </View>
  );
}

/** Live status snapshot for Pip, derived reactively from real store + transcript + daemon state. */
export const pipLiveStatus = computed<PipLiveStatus>(() => {
  const model = sessionState()?.model ?? draftModel();
  const modelName = model?.name || model?.id || "";
  const agentName = activeAgent().name;
  const engineLabel = [agentName, modelName].filter(Boolean).join(" · ");
  const dialog = pendingDialog();
  return derivePipLiveStatus({
    name: personaDisplayName(),
    lang: activeLanguage(),
    rows: transcriptRows(),
    running: isRunning(),
    activity: currentActivity(),
    runStartedAt: runStart(),
    pendingDialog: dialog ? { method: dialog.method, title: dialog.title } : undefined,
    daemonSession: headingDaemonSession() ?? currentDaemonSession(),
    childSessions: currentChildSessions(),
    sidecarFailed: sidecarPhase().name === "failed",
    engineLabel,
  });
});

function phaseDotClass(phase: PipPhase): string {
  switch (phase) {
    case "thinking":
    case "tool":
    case "writing":
    case "waiting_sessions":
    case "compacting":
      return "bg-brand";
    case "waiting_user":
    case "retrying":
      return "bg-warning";
    case "error":
      return "bg-destructive";
    default:
      return "bg-subtle/50";
  }
}

function childStatusLabel(status: PipChildStatus["status"]): string {
  switch (status) {
    case "working":
      return tr("Working", "运行中");
    case "blocked":
      return tr("Needs confirmation", "待确认");
    case "failed":
      return tr("Failed", "失败");
    case "interrupted":
      return tr("Stopped", "已停止");
    default:
      return tr("Done", "已完成");
  }
}

/** Floating Liquid Glass real-time status card shown when hovering any Pip avatar or typing bubble. */
function PipStatusCard(props: {
  open: () => boolean;
  turnMeta?: () => PipTurnMeta | undefined;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onOpenSession: (id: string) => void;
  /** Whether the hovered turn's process is unfolded in the stream. */
  processOpen?: () => boolean;
  /** Folds or unfolds the hovered turn's process into the stream. The card stays open:
   * closing it under the pointer lands the pointer back on the avatar, which is a hover loop. */
  onToggleProcess?: () => void;
}) {
  const status = pipLiveStatus;
  const now = signal(Date.now());

  // Tick the elapsed counter only while the hover card is open and Pip has an active start timestamp.
  effect(() => {
    if (!props.open()) return;
    const startedAt = status().startedAt;
    if (startedAt === undefined) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      const at = Date.now();
      now.set(at);
      const into = Math.max(0, at - startedAt) % 1000;
      timer = setTimeout(tick, 1000 - into + 4);
    };
    tick();
    cleanup(() => clearTimeout(timer));
  });

  const elapsed = () => {
    const startedAt = status().startedAt;
    if (startedAt === undefined) return "";
    const ms = Math.max(0, now() - startedAt);
    return ms >= 1000 ? formatElapsedCompact(ms) : "";
  };

  const idleTurnLine = () => {
    const meta = props.turnMeta?.();
    if (!meta || status().active) return "";
    const zh = activeLanguage() === "zh";
    const parts: string[] = [];
    if (meta.durationMs !== undefined) {
      parts.push(
        meta.durationMs < 1000
          ? tr("Under 1s", "不到 1 秒")
          : zh
            ? `用时 ${spokenDuration(meta.durationMs, true)}`
            : `Finished in ${spokenDuration(meta.durationMs, false)}`,
      );
    }
    if (meta.summary) parts.push(meta.summary);
    return parts.join(" · ");
  };

  /** The one door to a settled turn's process lives here, on the avatar's card: the stream itself stays clean. */
  const showProcessToggle = () => !status().active && props.turnMeta?.()?.hasDetails === true && props.onToggleProcess !== undefined;

  return (
    <View
      testID="pip-status-card"
      onMouseEnter={props.onPointerEnter}
      onMouseLeave={props.onPointerLeave}
      class="w-68 select-none gap-2 p-3"
    >
      {/* Header: status dot + Pip · live phase + elapsed seconds */}
      <View class="flex-row items-center gap-2">
        <View class={`size-2 shrink-0 rounded-full ${phaseDotClass(status().phase)}`} />
        <Text class={`shrink-0 ${uiType("sm")} font-medium text-foreground`}>{status().name}</Text>
        <Text class={`shrink-0 ${uiType("xs")} text-subtle`}>·</Text>
        <Text class={`min-w-0 flex-1 truncate ${uiType("xs")} text-muted-foreground`}>{status().headline}</Text>
        <If when={elapsed()}>
          <Text testID="pip-status-elapsed" class={`shrink-0 ${uiType("xs")} tabular-nums text-subtle`}>
            {elapsed()}
          </Text>
        </If>
      </View>

      {/* Current active step / detail (active tool call, retry reason, dialog title, error) */}
      <If when={status().detail}>
        {(detail) => (
          <View class="flex-row items-center gap-2 rounded-md corner-squircle bg-muted/55 px-2 py-1.5">
            <If
              when={status().phase === "tool"}
              else={
                <Icon
                  name={status().phase === "error" ? "alert" : status().phase === "waiting_user" ? "clock" : "info"}
                  size={12}
                  tone={status().phase === "error" ? "destructive" : status().phase === "waiting_user" ? "warning" : "muted-foreground"}
                />
              }
            >
              <View class="size-2.5 shrink-0 rounded-full border-[1.5px] border-input border-t-brand motion-safe:animate-spin" />
            </If>
            <Text class={`min-w-0 flex-1 ${uiType("xs")} text-foreground`}>{detail()}</Text>
          </View>
        )}
      </If>

      {/* Recent completed steps inside the current in-flight turn */}
      <If when={status().active && status().recentSteps.length > 0}>
        <View class="gap-1 border-t border-hairline pt-2">
          <Each of={status().recentSteps} key="index">
            {(step) => (
              <View class="flex-row items-center gap-1.5">
                <Icon name="check" size={11} tone="subtle" />
                <Text class={`min-w-0 flex-1 truncate ${uiType("xs")} text-subtle`}>{step()}</Text>
              </View>
            )}
          </Each>
        </View>
      </If>

      {/* Running / blocked child sessions: clickable to jump straight in */}
      <If when={status().activeChildren.length > 0}>
        <View class="gap-1 border-t border-hairline pt-2">
          <Text class={`${uiType("2xs")} font-medium text-subtle`}>{tr("Active sessions", "进行中的子会话")}</Text>
          <Each of={status().activeChildren} key={(child) => child.id}>
            {(child) => (
              <BaseButton
                testID={`pip-status-child-${child().id}`}
                onPress={() => props.onOpenSession(child().id)}
                class={`flex-row items-center gap-2 rounded-md corner-squircle px-2 py-1 ${PRESS} ${FOCUS_RING} hover:bg-accent active:bg-accent`}
              >
                <If
                  when={child().status === "blocked"}
                  else={<View class="size-2.5 shrink-0 rounded-full border-[1.5px] border-input border-t-brand motion-safe:animate-spin" />}
                >
                  <View class="size-2 shrink-0 rounded-full bg-warning" />
                </If>
                <Text class={`min-w-0 flex-1 truncate ${uiType("xs")} font-medium text-foreground`}>{child().title}</Text>
                <Text class={`shrink-0 ${uiType("2xs")} text-subtle`}>
                  {child().status === "blocked" ? childStatusLabel("blocked") : child().agentName}
                </Text>
                <Icon name="external" size={11} tone="subtle" />
              </BaseButton>
            )}
          </Each>
        </View>
      </If>

      {/* Idle turn metadata (when hovering a delivered message's Pip avatar while Pip is at rest):
          how long it took and what it did, plus the one door to its process in the stream. */}
      <If when={idleTurnLine() || showProcessToggle()}>
        <View class="gap-1 border-t border-hairline pt-2">
          <If when={idleTurnLine()}>
            <Text class={`${uiType("xs")} text-muted-foreground`}>{idleTurnLine()}</Text>
          </If>
          <If when={showProcessToggle()}>
            <BaseButton
              testID="pip-process-toggle"
              onPress={() => props.onToggleProcess?.()}
              accessibilityLabel={
                (props.processOpen?.() ?? false) ? tr("Hide process", "收起过程") : tr("Show process", "查看过程")
              }
              class={`-ml-1.5 self-start flex-row items-center gap-1 rounded-md corner-squircle px-1.5 py-0.5 ${PRESS} ${FOCUS_RING} hover:bg-accent active:bg-accent`}
            >
              <View
                class={`transition-transform duration-200 ease-out-quint motion-reduce:transition-none ${
                  (props.processOpen?.() ?? false) ? "rotate-90" : ""
                }`}
              >
                <Icon name="chevronRight" size={11} tone="subtle" />
              </View>
              <Text class={`${uiType("xs")} text-muted-foreground`}>
                {(props.processOpen?.() ?? false) ? tr("Hide process", "收起过程") : tr("Show process", "查看过程")}
              </Text>
            </BaseButton>
          </If>
        </View>
      </If>

      {/* Quiet engine/model caption when idle */}
      <If when={!status().active && status().engineLabel}>
        <Text class={`${uiType("2xs")} text-subtle`}>{status().engineLabel}</Text>
      </If>
    </View>
  );
}

/**
 * Reusable hoverable Pip avatar with a floating real-time status card.
 * Anchors at the bottom-left of both the typing indicator and each delivered Pip bubble cluster.
 */
export function PipAvatarBadge(props: {
  /** Active working indicator at the bottom (`true`) vs delivered message avatar (`false`). */
  active?: boolean;
  /** Stable id for recycled List cells so switching cells closes any stray hover popover. */
  rowId?: () => string;
  /** Optional metadata for a delivered turn (shown when hovering at rest). */
  turnMeta?: () => PipTurnMeta | undefined;
  /** Whether this turn's process is unfolded in the stream (the card's toggle reads it). */
  processOpen?: () => boolean;
  /** Folds or unfolds this turn's process into the stream. */
  onToggleProcess?: () => void;
  /** Optional external hover/toggle controller so hovering the adjacent typing bubble shares the same card. */
  externalOpen?: () => boolean;
  onExternalHover?: (hovering: boolean) => void;
  onExternalToggle?: () => void;
  testID?: string;
}) {
  const localOpen = signal(false);
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;

  const isControlled = Boolean(props.externalOpen);
  const open = () => (props.externalOpen ? props.externalOpen() : localOpen());

  const clearTimers = () => {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    openTimer = undefined;
    closeTimer = undefined;
  };

  // Recycled list cells reset their hover state when bound to another row.
  let boundId = untracked(() => props.rowId?.() ?? "");
  effect(() => {
    const nextId = props.rowId?.() ?? "";
    if (nextId !== boundId) {
      boundId = nextId;
      clearTimers();
      localOpen.set(false);
    }
  });

  cleanup(clearTimers);

  const onEnter = () => {
    if (props.onExternalHover) {
      props.onExternalHover(true);
      return;
    }
    clearTimeout(closeTimer);
    closeTimer = undefined;
    if (untracked(localOpen)) return;
    clearTimeout(openTimer);
    openTimer = setTimeout(() => {
      openTimer = undefined;
      localOpen.set(true);
    }, HOVER_OPEN_MS);
  };

  const onLeave = () => {
    if (props.onExternalHover) {
      props.onExternalHover(false);
      return;
    }
    clearTimeout(openTimer);
    openTimer = undefined;
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      closeTimer = undefined;
      localOpen.set(false);
    }, HOVER_CLOSE_MS);
  };

  const onToggle = () => {
    if (props.onExternalToggle) {
      props.onExternalToggle();
      return;
    }
    clearTimers();
    localOpen.set(!untracked(localOpen));
  };

  const status = pipLiveStatus;
  const isBusy = () => Boolean(props.active) && status().active;
  const haloOpacity = useBreathingOpacity(isBusy);
  const avatarSize = () => (props.active ? 19 : 18);
  const boxClass = () => "size-7";
  const cornerDotClass = () => {
    if (!props.active || !status().active) return "";
    if (status().phase === "waiting_user" || status().phase === "retrying") return "bg-warning";
    return "bg-brand";
  };

  return (
    <Popover
      open={open()}
      onOpenChange={(e) => {
        clearTimers();
        if (isControlled) {
          if (!e.open) props.onExternalHover?.(false);
        } else {
          localOpen.set(e.open);
        }
      }}
      placement="top"
      align="start"
      offset={8}
      margin={12}
      closeOnEscape
      closeOnPressOutside
      popupClass={`${POPUP}`}
      popupStyle={popupStyle("top", "start")}
      popupStartingStyle={popupHiddenStyle("top", "start")}
      popupEndingStyle={popupLeavingStyle("top", "start")}
      trigger={
        <View
          role="button"
          testID={props.testID ?? (props.active ? "pip-active-avatar" : "pip-message-avatar")}
          accessibilityLabel={`${status().name}: ${status().headline}`}
          accessibilityState={{ busy: isBusy(), expanded: open() }}
          onMouseEnter={onEnter}
          onMouseLeave={onLeave}
          onPress={onToggle}
          class={`relative ${boxClass()} shrink-0 select-none items-center justify-center rounded-full border-[0.5px] border-hairline bg-card/90 ${PRESS} ${PRESS_SCALE} ${FOCUS_RING} hover:border-hairline-hover hover:bg-card`}
        >
          {/* Soft breathing cobalt halo while Pip is actively working */}
          <If when={isBusy()}>
            <View
              class="pointer-events-none absolute -inset-0.5 rounded-full border border-brand/45"
              style={{ opacity: haloOpacity }}
            />
          </If>
          <Pip size={avatarSize()} mood={props.active ? pipMood() : "idle"} still={!props.active} />
          <If when={cornerDotClass()}>
            <View class={`pointer-events-none absolute -bottom-0.5 -right-0.5 size-2 rounded-full border-[1.5px] border-background ${cornerDotClass()}`} />
          </If>
        </View>
      }
    >
      <PipStatusCard
        open={open}
        turnMeta={props.turnMeta}
        onPointerEnter={onEnter}
        onPointerLeave={onLeave}
        onOpenSession={(id) => {
          clearTimers();
          if (isControlled) props.onExternalHover?.(false);
          else localOpen.set(false);
          void openDaemonSession(id);
        }}
        processOpen={props.processOpen}
        onToggleProcess={props.onToggleProcess}
      />
    </Popover>
  );
}

/**
 * Three smoothly bouncing & pulsing dots inside the iMessage typing bubble.
 * Driven entirely on the native UI compositor thread via staggered infinite keyframes.
 */
function TypingDots() {
  const dots = [0, 1, 2].map(() => ({
    opacity: createAnimatedValue(0.36),
    scale: createAnimatedValue(0.88),
    translateY: createAnimatedValue(0),
  }));

  effect(() => {
    const reduced = reduceMotion();
    const running: CompositeAnimation[] = [];
    if (reduced) {
      const staticAlphas = [0.45, 0.72, 0.96];
      dots.forEach((dot, idx) => {
        void dot.opacity.stop();
        void dot.scale.stop();
        void dot.translateY.stop();
        dot.opacity.set(staticAlphas[idx]);
        dot.scale.set(1);
        dot.translateY.set(0);
      });
      return;
    }

    dots.forEach((dot, idx) => {
      const delay = idx * 165;
      const anim = Animated.parallel([
        Animated.keyframes(dot.opacity, {
          keyframes: [
            { offset: 0, value: 0.34, easing: "easeInOut" },
            { offset: 0.28, value: 0.96, easing: "easeInOut" },
            { offset: 0.62, value: 0.34, easing: "easeInOut" },
            { offset: 1, value: 0.34 },
          ],
          duration: 1180,
          delay,
          iterations: "infinite",
        }),
        Animated.keyframes(dot.scale, {
          keyframes: [
            { offset: 0, value: 0.86, easing: "easeInOut" },
            { offset: 0.28, value: 1.15, easing: "easeInOut" },
            { offset: 0.62, value: 0.86, easing: "easeInOut" },
            { offset: 1, value: 0.86 },
          ],
          duration: 1180,
          delay,
          iterations: "infinite",
        }),
        Animated.keyframes(dot.translateY, {
          keyframes: [
            { offset: 0, value: 0, easing: "easeInOut" },
            { offset: 0.28, value: -2.4, easing: "easeInOut" },
            { offset: 0.62, value: 0, easing: "easeInOut" },
            { offset: 1, value: 0 },
          ],
          duration: 1180,
          delay,
          iterations: "infinite",
        }),
      ]);
      void anim.start();
      running.push(anim);
    });

    cleanup(() => {
      for (const anim of running) anim.stop();
      for (const dot of dots) {
        void dot.opacity.stop();
        void dot.scale.stop();
        void dot.translateY.stop();
      }
    });
  });

  return (
    <View class="flex-row items-center gap-[5px]">
      {dots.map((dot) => (
        <View
          class="size-[7px] rounded-full bg-muted-foreground"
          style={{
            opacity: dot.opacity,
            transform: [{ translateY: dot.translateY }, { scale: dot.scale }],
          }}
        />
      ))}
    </View>
  );
}

/**
 * Bottom iMessage typing indicator row for Pip (personal agent) conversations:
 * Pip's live avatar paired with an authentic macOS Messages typing bubble (three
 * staggered pulsing dots + two trailing thought-dots) that pops in from bottom-left
 * while Pip is working and vanishes cleanly the instant the reply bubbles land.
 * Hovering either Pip's avatar or the typing bubble reveals the live status card.
 *
 * Reserves a constant 48pt (`h-12`) slot so starting and settling a run never
 * shifts the scroll content height.
 */
export function PipWorkingFooter(props: { anchor?: (node: ViewRef | undefined) => void }) {
  const isChatActive = () => isRunning() || waitingCount() > 0;
  const alreadyWorking = untracked(() => isChatActive() && transcriptRows().length > 0);
  const shown = signal(alreadyWorking);
  const cardOpen = signal(false);
  const opacity = createAnimatedValue(alreadyWorking ? 1 : 0);
  const translateY = createAnimatedValue(alreadyWorking ? 0 : 7);
  const scale = createAnimatedValue(alreadyWorking ? 1 : 0.48);
  const breathe = createAnimatedValue(1);
  let exitTimer: ReturnType<typeof setTimeout> | undefined;
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let breatheAnim: CompositeAnimation | null = null;

  const clearHoverTimers = () => {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    openTimer = undefined;
    closeTimer = undefined;
  };

  const handleHover = (hovering: boolean) => {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    openTimer = undefined;
    closeTimer = undefined;
    if (hovering) {
      if (untracked(cardOpen)) return;
      openTimer = setTimeout(() => {
        openTimer = undefined;
        cardOpen.set(true);
      }, HOVER_OPEN_MS);
    } else {
      closeTimer = setTimeout(() => {
        closeTimer = undefined;
        cardOpen.set(false);
      }, HOVER_CLOSE_MS);
    }
  };

  const handleToggle = () => {
    clearHoverTimers();
    cardOpen.set(!untracked(cardOpen));
  };

  effect(() => {
    if (isLeavingSession()) return;
    const active = isChatActive();
    const reduced = reduceMotion();
    untracked(() => {
      clearTimeout(exitTimer);
      breatheAnim?.stop();
      breatheAnim = null;
      if (active) {
        const entering = !shown();
        shown.set(true);
        if (reduced) {
          opacity.set(1);
          translateY.set(0);
          scale.set(1);
          breathe.set(1);
        } else if (entering) {
          opacity.set(0);
          translateY.set(7);
          scale.set(0.48);
          void opacity.keyframes([0, 1], { duration: 180, delay: 60, easing: EASING.entrance });
          void translateY.keyframes(
            [
              { offset: 0, value: 7 },
              { offset: 0.68, value: -1 },
              { offset: 1, value: 0 },
            ],
            { duration: 240, delay: 60, easing: EASING.signature },
          );
          void scale.keyframes(
            [
              { offset: 0, value: 0.48 },
              { offset: 0.66, value: 1.04 },
              { offset: 1, value: 1 },
            ],
            { duration: 240, delay: 60, easing: EASING.signature },
          );
        } else {
          void opacity.timing(1, { duration: 150, easing: EASING.entrance });
          void translateY.timing(0, { duration: 180, easing: EASING.signature });
          void scale.timing(1, { duration: 180, easing: EASING.signature });
        }
        if (!reduced) {
          breatheAnim = Animated.keyframes(breathe, {
            keyframes: [
              { offset: 0, value: 1, easing: "easeInOut" },
              { offset: 0.5, value: 1.022, easing: "easeInOut" },
              { offset: 1, value: 1 },
            ],
            duration: 1800,
            delay: entering ? 300 : 0,
            iterations: "infinite",
          });
          void breatheAnim.start();
        }
      } else if (shown()) {
        clearHoverTimers();
        cardOpen.set(false);
        breathe.set(1);
        if (reduced) {
          opacity.set(0);
          scale.set(0.84);
          shown.set(false);
        } else {
          void opacity.timing(0, { duration: 130, easing: EASING.exit });
          void translateY.timing(4, { duration: 130, easing: EASING.exit });
          void scale.timing(0.82, { duration: 130, easing: EASING.exit });
          exitTimer = setTimeout(() => shown.set(false), 140);
        }
      }
    });
  });

  cleanup(() => {
    clearTimeout(exitTimer);
    clearHoverTimers();
    breatheAnim?.stop();
    void opacity.stop();
    void translateY.stop();
    void scale.stop();
    void breathe.stop();
  });

  const status = pipLiveStatus;
  const isWaitingChildrenOnly = () => !isRunning() && waitingCount() > 0 && status().phase === "waiting_sessions";
  const isWaitingUser = () => status().phase === "waiting_user";

  return (
    <View ref={(node: ViewRef) => props.anchor?.(node)} class="h-12 w-full max-w-180 select-none justify-end self-center pb-1">
      <If when={shown()}>
        <View class="flex-row items-end gap-3.5">
          <PipAvatarBadge
            active
            testID="pip-active-avatar"
            externalOpen={cardOpen}
            onExternalHover={handleHover}
            onExternalToggle={handleToggle}
          />
          <View
            testID="pip-typing-bubble"
            role="button"
            accessibilityLabel={`${status().name}: ${status().headline}`}
            accessibilityState={{ busy: isChatActive() }}
            onMouseEnter={() => handleHover(true)}
            onMouseLeave={() => handleHover(false)}
            onPress={handleToggle}
            style={{
              transformOrigin: "left bottom",
              opacity,
              transform: [{ translateY }, { scale: scale.mul(breathe) }],
            }}
            class="relative mb-0.5"
          >
            {/* Iconic iMessage typing thought-tail dots at bottom-left */}
            <View class="pointer-events-none absolute -bottom-[1px] -left-[2px] size-[8.5px] rounded-full bg-sms-incoming" />
            <View class="pointer-events-none absolute -bottom-[4px] -left-[6px] size-[4.5px] rounded-full bg-sms-incoming" />
            <View class="h-[34px] flex-row items-center justify-center gap-2 rounded-[18px] corner-squircle bg-sms-incoming px-3.5">
              <If
                when={isWaitingUser()}
                else={
                  <If when={isWaitingChildrenOnly()} else={<TypingDots />}>
                    <View class="size-2.5 shrink-0 rounded-full border-[1.5px] border-input border-t-brand motion-safe:animate-spin" />
                    <Text class={`${uiType("xs")} text-muted-foreground`}>{status().headline}</Text>
                  </If>
                }
              >
                <View class="size-2 shrink-0 rounded-full bg-warning" />
                <Text class={`${uiType("xs")} text-muted-foreground`}>{status().headline}</Text>
              </If>
            </View>
          </View>
        </View>
      </If>
    </View>
  );
}

/**
 * One iMessage-style incoming SMS bubble from Pip:
 * - Soft neutral gray bubble (`bg-sms-incoming`) with cluster-aware corner radii
 *   and a crisp curved bottom-left tail on the last bubble of the cluster.
 * - Pip's hoverable avatar sits cleanly at the bottom-left beside the final bubble's tail.
 * - New live bubbles pop out from `left bottom` with brisk multi-bubble stagger.
 */
export function PipBubbleView(props: {
  row: PipBubbleRow;
  processOpen?: () => boolean;
  onToggleProcess?: () => void;
}) {
  const entrance = useSmsBubbleEntrance(
    () => props.row.id,
    () => "left",
    {
      skip: () => isRowSeen(props.row.rowId),
      stagger: () => props.row.bubbleIndex,
    },
  );

  const bubbleRadius = () => {
    if (props.row.first && props.row.last) return "rounded-[18px] rounded-bl-[5px]";
    if (props.row.first) return "rounded-[18px] rounded-bl-[6px]";
    if (props.row.last) return "rounded-[18px] rounded-tl-[6px] rounded-bl-[5px]";
    return "rounded-[18px] rounded-l-[6px]";
  };

  const contextMenu = (e: { pagePosition: { x: number; y: number } }) => {
    const items = [
      ...(props.row.copyText
        ? [{ label: tr("Copy", "复制"), onSelect: () => void copyMessage(props.row.copyText) }]
        : []),
      ...(props.row.fullText && props.row.fullText !== props.row.copyText
        ? [{ label: tr("Copy Full Reply", "复制完整回复"), onSelect: () => void copyMessage(props.row.fullText) }]
        : []),
    ];
    if (items.length > 0) Menu.popup(items, e.pagePosition);
  };

  const bubblePad = () => (props.row.blocks.length > 1 || props.row.wide ? "px-4 py-3" : "px-3.5 py-2");

  return (
    <View class="flex-row items-end gap-3">
      <View class="w-7 shrink-0 pb-0.5">
        <If when={props.row.pip.tail}>
          <PipAvatarBadge
            rowId={() => props.row.id}
            turnMeta={() => props.row.pip.meta}
            processOpen={props.processOpen}
            onToggleProcess={props.onToggleProcess}
          />
        </If>
      </View>
      <View class="min-w-0 flex-1 items-start">
        <If
          when={props.row.mediaOnly}
          else={
            <View
              testID="pip-sms-bubble"
              selectable
              onContextMenu={contextMenu}
              style={entrance}
              class={`relative ${props.row.wide ? "max-w-[84%]" : "max-w-[74%]"} ${bubbleRadius()} corner-squircle bg-sms-incoming ${bubblePad()}`}
            >
              <If when={props.row.last}>
                <BubbleTail side="left" tone="sms-incoming" />
              </If>
              <PipBubbleBlocks row={props.row} />
            </View>
          }
        >
          <View testID="pip-sms-bubble" style={entrance} class="max-w-[74%]">
            <PipBubbleBlocks row={props.row} />
          </View>
        </If>
      </View>
    </View>
  );
}

/** Clean clickable cards for child sessions Pip dispatched (`session_start`), reading live daemon state. */
export function PipSessionsView(props: { row: PipSessionsRow }) {
  return (
    <View testID="pip-delegated-sessions" class="max-w-[76%] flex-row flex-wrap gap-1.5 py-0.5">
      <Each of={props.row.sessions} key={(s) => s.toolId}>
        {(ref) => <PipSessionChip session={ref()} />}
      </Each>
    </View>
  );
}

function PipSessionChip(props: { session: PipDelegatedSession }) {
  const live = () => (props.session.sessionId ? daemonSessionOfId(props.session.sessionId) : undefined);
  const title = () => {
    const ds = live();
    return (ds?.title && ds.title !== "New session" ? ds.title : undefined) ?? props.session.title;
  };
  const agent = () => live()?.agentName ?? props.session.agent;
  const status = () => (props.session.failed ? "failed" : live()?.status ?? "idle");
  const clickable = () => Boolean(props.session.sessionId && live());

  const chipBody = () => (
    <>
      <If
        when={status() === "working"}
        else={
          <If
            when={status() === "blocked"}
            else={
              <If
                when={status() === "failed" || status() === "interrupted"}
                else={<Icon name="check" size={12} tone="subtle" />}
              >
                <Icon name="x" size={12} tone="destructive" />
              </If>
            }
          >
            <View class="size-2 shrink-0 rounded-full bg-warning" />
          </If>
        }
      >
        <View class="size-2.5 shrink-0 rounded-full border-[1.5px] border-input border-t-brand motion-safe:animate-spin" />
      </If>
      <Text class={`max-w-56 truncate ${uiType("xs")} font-medium text-foreground`}>{title()}</Text>
      <If when={agent()}>
        <Text class={`shrink-0 ${uiType("2xs")} text-subtle`}>{agent()}</Text>
      </If>
      <If when={status() === "working" || status() === "blocked"}>
        <Text class={`shrink-0 ${uiType("2xs")} ${status() === "blocked" ? "text-warning" : "text-brand-text"}`}>
          {childStatusLabel(status())}
        </Text>
      </If>
      <If when={clickable()}>
        <Icon name="external" size={11} tone="subtle" />
      </If>
    </>
  );

  return (
    <If
      when={clickable()}
      else={
        <View
          testID="pip-session-chip"
          class={`${uiHeight(28)} select-none flex-row items-center gap-1.5 rounded-[14px] corner-squircle border-[0.5px] border-hairline bg-card/80 px-3`}
        >
          {chipBody()}
        </View>
      }
    >
      <BaseButton
        testID="pip-session-chip"
        onPress={() => {
          if (props.session.sessionId) void openDaemonSession(props.session.sessionId);
        }}
        accessibilityLabel={tr(`Open session ${title()}`, `打开会话「${title()}」`)}
        class={`${uiHeight(28)} select-none flex-row items-center gap-1.5 rounded-[14px] corner-squircle border-[0.5px] border-hairline bg-card/85 px-3 ${PRESS} ${PRESS_SCALE} ${FOCUS_RING} hover:border-hairline-hover hover:bg-accent active:bg-accent`}
      >
        {chipBody()}
      </BaseButton>
    </If>
  );
}

/** Quiet SMS message footer: hover-revealed Copy action, nothing else. A turn's process is the avatar card's to show. */
export function PipFooterView(props: {
  row: PipFooterRow;
  renderCopy: (id: string, text: string, cls?: string) => JSX.Element;
}) {
  return (
    <View class="group h-5 select-none flex-row items-center gap-2">
      <View class="-ml-1">
        {props.renderCopy(props.row.id, props.row.text, `transition-opacity duration-150 motion-reduce:transition-none ${HOVER_REVEAL}`)}
      </View>
    </View>
  );
}
