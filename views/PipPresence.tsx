import { cleanup, computed, createAnimatedValue, effect, reduceMotion, signal, Text, untracked, View } from "nsh";
import type { JSX, ViewRef } from "nsh";
import { Button as BaseButton, Popover } from "nsh/base";
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
import { EASING, popupHiddenStyle, popupLeavingStyle, popupStyle, SPRING, useBreathingOpacity } from "../ui/motion";
import { FOCUS_RING, POPUP, PRESS, PRESS_SCALE } from "../ui/styles";
import { uiHeight, uiType } from "../ui/typography";

const HOVER_OPEN_MS = 100;
const HOVER_CLOSE_MS = 160;

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

/** Floating Liquid Glass real-time status card shown when hovering any Pip avatar. */
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
 * Reusable hoverable Pip avatar with a Raft-style floating real-time status card.
 * Used identically on the bottom active working indicator and on every delivered Pip message.
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
  testID?: string;
}) {
  const open = signal(false);
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;

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
      open.set(false);
    }
  });

  cleanup(clearTimers);

  const onEnter = () => {
    clearTimeout(closeTimer);
    closeTimer = undefined;
    if (untracked(open)) return;
    clearTimeout(openTimer);
    openTimer = setTimeout(() => {
      openTimer = undefined;
      open.set(true);
    }, HOVER_OPEN_MS);
  };

  const onLeave = () => {
    clearTimeout(openTimer);
    openTimer = undefined;
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      closeTimer = undefined;
      open.set(false);
    }, HOVER_CLOSE_MS);
  };

  const status = pipLiveStatus;
  const isBusy = () => Boolean(props.active) && status().active;
  const haloOpacity = useBreathingOpacity(isBusy);
  const avatarSize = () => (props.active ? 20 : 18);
  const boxClass = () => (props.active ? "size-8" : "size-7");
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
        open.set(e.open);
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
          onPress={() => {
            clearTimers();
            open.set(!untracked(open));
          }}
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
          open.set(false);
          void openDaemonSession(id);
        }}
        processOpen={props.processOpen}
        onToggleProcess={props.onToggleProcess}
      />
    </Popover>
  );
}

/**
 * Bottom active placeholder for Pip (personal agent) conversations: replaces
 * `ActivityLine`'s streaming status words with a quiet, breathing Pip avatar
 * medallion. Hovering the avatar reveals Pip's real-time status card.
 *
 * Reserves a constant 44pt (`h-11`) slot so starting and settling a run never
 * shifts the scroll content height.
 */
export function PipWorkingFooter(props: { anchor?: (node: ViewRef | undefined) => void }) {
  const isChatActive = () => isRunning() || waitingCount() > 0;
  const alreadyWorking = untracked(() => (isChatActive() || pipMood() === "happy") && transcriptRows().length > 0);
  const shown = signal(alreadyWorking);
  const opacity = createAnimatedValue(alreadyWorking ? 1 : 0);
  const translateY = createAnimatedValue(alreadyWorking ? 0 : 4);
  let exitTimer: ReturnType<typeof setTimeout> | undefined;

  effect(() => {
    if (isLeavingSession()) return;
    const active = isChatActive() || pipMood() === "happy";
    const reduced = reduceMotion();
    untracked(() => {
      clearTimeout(exitTimer);
      if (active) {
        const entering = !shown();
        shown.set(true);
        if (reduced) {
          opacity.set(1);
          translateY.set(0);
        } else if (entering) {
          opacity.set(0);
          void opacity.keyframes([0, 1], { duration: 160, delay: 45, easing: EASING.entrance });
          void translateY.spring(0, SPRING.snappy);
        } else {
          void opacity.timing(1, { duration: 160, easing: EASING.entrance });
          void translateY.spring(0, SPRING.snappy);
        }
      } else if (shown()) {
        if (reduced) {
          opacity.set(0);
          shown.set(false);
        } else {
          void opacity.timing(0, { duration: 200, easing: EASING.exit });
          void translateY.timing(3, { duration: 200, easing: EASING.exit });
          exitTimer = setTimeout(() => shown.set(false), 210);
        }
      }
    });
  });

  cleanup(() => {
    clearTimeout(exitTimer);
    void opacity.stop();
    void translateY.stop();
  });

  return (
    <View ref={(node: ViewRef) => props.anchor?.(node)} class="h-11 w-full max-w-180 select-none justify-center self-center pt-1">
      <If when={shown()}>
        <View class="flex-row items-center" style={{ opacity, transform: [{ translateY }] }}>
          <PipAvatarBadge active testID="pip-active-avatar" />
        </View>
      </If>
    </View>
  );
}

/** Clean clickable cards for child sessions Pip dispatched (`session_start`), reading live daemon state. */
export function PipSessionsView(props: { row: PipSessionsRow }) {
  return (
    <View testID="pip-delegated-sessions" class="flex-row flex-wrap gap-1.5 py-0.5">
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
          class={`${uiHeight(28)} select-none flex-row items-center gap-1.5 rounded-lg corner-squircle border-[0.5px] border-hairline bg-card/75 px-2.5`}
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
        class={`${uiHeight(28)} select-none flex-row items-center gap-1.5 rounded-lg corner-squircle border-[0.5px] border-hairline bg-card/80 px-2.5 ${PRESS} ${PRESS_SCALE} ${FOCUS_RING} hover:border-hairline-hover hover:bg-accent active:bg-accent`}
      >
        {chipBody()}
      </BaseButton>
    </If>
  );
}

/** Quiet IM message footer: the Copy action, nothing else. A turn's process is the avatar card's to show. */
export function PipFooterView(props: {
  row: PipFooterRow;
  renderCopy: (id: string, text: string) => JSX.Element;
}) {
  return (
    <View class="h-6 select-none flex-row items-center gap-2">
      <View class="-ml-1">{props.renderCopy(props.row.id, props.row.text)}</View>
    </View>
  );
}
