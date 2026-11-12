import { cleanup, computed, createAnimatedValue, effect, List, reduceMotion, Scroll, signal, Text, untracked, View } from "nsh";
import type { JSX, ListRef, ScrollEvent } from "nsh";
import { Button as BaseButton, Popover } from "nsh/base";
import { basename, tildePath } from "../lib/format";
import { tr } from "../lib/i18n";
import { Pip } from "../mascot/Pip";
import {
  activeAgent,
  activeAgentId,
  chooseWorkspace,
  currentActivity,
  hasModel,
  inspectingTask,
  isRunning,
  isSwitching,
  newSession,
  newSessionInWorkspace,
  pendingDialog,
  pipMood,
  restartPi,
  scrollToEndTick,
  sessionLandedTick,
  sessionState,
  showSettings,
  sidecarPhase,
  transcriptRows,
  workspacePath,
} from "../store/app";
import { backend } from "../store/backend";
import { recentWorkspaces } from "../store/prefs";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { enterStagger, popupHiddenStyle, popupLeavingStyle, popupStyle, SPRING, useBreathingOpacity } from "../ui/motion";
import { tip } from "../ui/Tip";
import { FOCUS_RING, GLASS_REGULAR, POPUP, PRESS, PRESS_SCALE } from "../ui/styles";
import { Composer } from "./Composer";
import { hasInlinePrompt } from "./ExtensionDialog";
import { proseRows } from "./Prose";
import {
  type ChatRow,
  isTurnClosing,
  onFoldSettled,
  onFoldToggle,
  replyActions,
  resetExpanded,
  setProcessTurns,
  trackFoldState,
  TranscriptRow,
  turnOpen,
} from "./Rows";
import { NewThreadBackground } from "./Wallpaper";
import { buildDisplayRows, stableDisplayRows } from "../pi/turns";

/** Whether the currently displayed conversation (main or inspected sub-agent) is actively running. */
function isChatActive() {
  const sub = inspectingTask();
  return sub ? sub.status === "running" : isRunning();
}

/** What the run is doing, in a word or two. */
function activityLabel() {
  const sub = inspectingTask();
  const dialog = pendingDialog();
  if (sub && sub.status === "running") {
    if (dialog?.id.startsWith(`${sub.id}::`)) return tr("Waiting for confirmation", "等待确认");
    return tr(`${sub.agentName} working…`, `${sub.agentName} 正在运行…`);
  }
  if (dialog) return tr("Waiting for confirmation", "等待确认");
  const activity = currentActivity();
  switch (activity.kind) {
    case "writing":
      return tr("Writing", "正在回复");
    case "tool":
      return tr(`Running ${activity.name}`, `正在执行 ${activity.name}`);
    case "compacting":
      return tr("Compacting context", "正在压缩上下文");
    case "retrying":
      return tr(`Retrying (${activity.attempt} of ${activity.maxAttempts})`, `正在重试（${activity.attempt}/${activity.maxAttempts}）`);
    default:
      return tr("Thinking", "正在思考");
  }
}

/** The line under the transcript while Pi works: Pip and what it is doing (the turn's header keeps the time).
 * Reserves a constant 36pt (`h-9`) slot so starting, finishing or celebrating a run never
 * shifts the scroll content height or causes a layout jump at the end of a stream. */
function ActivityLine() {
  const shown = signal(false);
  const opacity = createAnimatedValue(0);
  const translateY = createAnimatedValue(4);
  const labelOpacity = createAnimatedValue(1);
  const shownLabel = signal(activityLabel());
  let exitTimer: ReturnType<typeof setTimeout> | undefined;
  let labelTimer: ReturnType<typeof setTimeout> | undefined;

  effect(() => {
    const active = isChatActive() || pipMood() === "happy";
    const reduced = reduceMotion();
    untracked(() => {
      clearTimeout(exitTimer);
      if (active) {
        shown.set(true);
        if (reduced) {
          opacity.set(1);
          translateY.set(0);
        } else {
          void opacity.timing(1, { duration: 180, easing: "easeOut" });
          void translateY.spring(0, SPRING.snappy);
        }
      } else if (shown()) {
        if (reduced) {
          opacity.set(0);
          shown.set(false);
        } else {
          void opacity.timing(0, { duration: 200, easing: "easeOut" });
          void translateY.timing(3, { duration: 200, easing: "easeOut" });
          exitTimer = setTimeout(() => shown.set(false), 210);
        }
      }
    });
  });

  // Cross-fade the activity label smoothly when Pi transitions between Thinking -> Running tool -> Writing.
  effect(() => {
    const next = activityLabel();
    const reduced = reduceMotion();
    untracked(() => {
      if (next === shownLabel()) return;
      clearTimeout(labelTimer);
      if (reduced || !shown()) {
        shownLabel.set(next);
        labelOpacity.set(1);
        return;
      }
      void labelOpacity.timing(0, { duration: 85, easing: "easeIn" });
      labelTimer = setTimeout(() => {
        shownLabel.set(next);
        void labelOpacity.timing(1, { duration: 135, easing: "easeOut" });
      }, 85);
    });
  });

  cleanup(() => {
    clearTimeout(exitTimer);
    clearTimeout(labelTimer);
    void opacity.stop();
    void translateY.stop();
    void labelOpacity.stop();
  });

  const reason = () => {
    const activity = currentActivity();
    return activity.kind === "retrying" ? activity.reason : "";
  };

  return (
    <View class="h-9 w-full max-w-190 select-none justify-center self-center">
      <If when={shown()}>
        <View
          class="flex-row items-center gap-2.5 pt-1"
          style={{ opacity, transform: [{ translateY }] }}
          accessibilityState={{ busy: isChatActive() }}
        >
          <Pip size={22} mood={pipMood()} />
          <If when={isChatActive()}>
            <Text class="text-sm text-muted-foreground" style={{ opacity: labelOpacity }}>
              {shownLabel()}
            </Text>
            <If when={reason()}>
              <Text class="flex-1 truncate text-xs text-subtle">{reason()}</Text>
            </If>
          </If>
        </View>
      </If>
    </View>
  );
}

/** A centered message with Pip: every state the chat can be in before there is a conversation. */
function Stage(props: { title: string; detail?: string; size?: number; children?: JSX.Element }) {
  return (
    <View class="flex-1 items-center justify-center gap-6 px-8 pb-28 pt-12">
      <View style={enterStagger(0)}>
        <Pip size={props.size ?? 96} mood={pipMood()} />
      </View>
      <View class="max-w-110 items-center gap-1.5" style={enterStagger(1)}>
        <Text class="text-center text-2xl font-semibold tracking-tight text-foreground" role="header">
          {props.title}
        </Text>
        <If when={props.detail}>
          <Text class="text-center text-sm text-subtle">{props.detail}</Text>
        </If>
      </View>
      <If when={props.children}>
        <View class="w-full items-center gap-6" style={enterStagger(2)}>
          {props.children}
        </View>
      </If>
    </View>
  );
}

/** The project the new session will run in: its name, underlined as the switcher to another one. */
function WelcomeProject() {
  const open = signal(false);
  const home = backend().home();
  const current = () => workspacePath();
  const projects = computed(() => {
    const active = current();
    const rest = recentWorkspaces().filter((path) => path !== active);
    return active ? [active, ...rest] : rest;
  });
  const pick = (cwd: string) => {
    open.set(false);
    void newSessionInWorkspace(cwd);
  };
  return (
    <Popover
      open={open()}
      onOpenChange={(e) => open.set(e.open)}
      placement="bottom"
      align="center"
      offset={8}
      margin={12}
      popupClass={`w-72 p-1 ${POPUP}`}
      popupStyle={popupStyle("bottom", "center")}
      popupStartingStyle={popupHiddenStyle("bottom", "center")}
      popupEndingStyle={popupLeavingStyle("bottom", "center")}
      trigger={
        <BaseButton
          accessibilityLabel={tr("Project this session works in", "会话所在项目")}
          tooltip={tip(tildePath(current(), home))}
          class={`h-7 flex-row items-center gap-1.5 rounded-md px-1.5 ${PRESS} ${FOCUS_RING} hover:bg-accent`}
        >
          <Text class="max-w-80 truncate text-sm text-muted-foreground underline">{`${activeAgent().name} · ${tildePath(current(), home)}`}</Text>
          <Icon name="chevronDown" size={12} tone="subtle" />
        </BaseButton>
      }
    >
      <Scroll class="max-h-72">
        <Each of={projects()} key={(cwd) => cwd}>
          {(cwd) => (
            <BaseButton
              selected={cwd() === current()}
              onPress={() => pick(cwd())}
              class={`min-h-9 flex-row items-center gap-2.5 rounded-md px-2 py-1 ${PRESS} hover:bg-accent focus:bg-accent active:bg-accent`}
            >
              <Icon name={cwd() === current() ? "folderOpen" : "folder"} size={15} tone={cwd() === current() ? "foreground" : "muted-foreground"} />
              <View class="min-w-0 flex-1">
                <Text class={`truncate text-base ${cwd() === current() ? "text-foreground" : "text-muted-foreground"}`}>{basename(cwd())}</Text>
                <Text class="truncate text-xs text-subtle">{tildePath(cwd(), home)}</Text>
              </View>
              <View class="w-4 shrink-0 items-center">{cwd() === current() ? <Icon name="check" size={14} tone="brand-text" /> : null}</View>
            </BaseButton>
          )}
        </Each>
      </Scroll>
      <View class="mx-1 h-px bg-border" />
      <BaseButton
        onPress={() => {
          open.set(false);
          void chooseWorkspace();
        }}
        class={`mt-1 min-h-9 flex-row items-center gap-2.5 rounded-md px-2 py-1 ${PRESS} hover:bg-accent focus:bg-accent active:bg-accent`}
      >
        <Icon name="folderPlus" size={15} tone="muted-foreground" />
        <Text class="flex-1 truncate text-base text-foreground">{tr("Add Project Folder…", "添加项目文件夹…")}</Text>
      </BaseButton>
    </Popover>
  );
}

/** The empty chat: Pip, the question, and which project the session will run in. */
function Welcome() {
  return (
    <Stage title={tr("What are we building?", "今天要构建什么？")}>
      <If when={workspacePath()}>
        <WelcomeProject />
      </If>
    </Stage>
  );
}

function Connect() {
  const isPi = () => activeAgentId() === "pi";
  const agentName = () => activeAgent().name;
  return (
    <Stage
      title={tr("Connect a model to begin", "连接模型以开始使用")}
      detail={
        isPi()
          ? tr("Add an API key and its models appear here.", "添加 API 密钥后即可在此使用其模型。")
          : tr(`${agentName()} has no models configured yet.`, `${agentName()} 尚未配置可用模型。`)
      }
    >
      <Button label={isPi() ? tr("Add a Provider", "添加服务商") : tr("Configure Agents", "配置智能体")} variant="primary" size="lg" icon="plug" onPress={() => showSettings(isPi() ? "providers" : "agents")} />
      <Text class="max-w-110 text-center text-xs text-subtle">
        {tr("Environment keys and installed CLIs are detected automatically.", "环境变量密钥与本机已安装的智能体会自动识别。")}
      </Text>
    </Stage>
  );
}

const SLOW_WAKE_MS = 5000;

function Waking() {
  const agentName = () => activeAgent().name;
  const slow = signal(false);
  const timer = setTimeout(() => slow.set(true), SLOW_WAKE_MS);
  cleanup(() => clearTimeout(timer));
  return (
    <Stage title={tr(`Waking ${agentName()}…`, `正在唤醒 ${agentName()}…`)} size={80}>
      <If when={slow()}>
        <Text class="max-w-110 text-center text-xs text-subtle">
          {tr(
            "Taking longer than usual — you can restart the agent or start a fresh session.",
            "响应时间较长，你可以重启智能体或开启新会话。",
          )}
        </Text>
        <View class="flex-row flex-wrap justify-center gap-2">
          <Button label={tr(`Restart ${agentName()}`, `重启 ${agentName()}`)} variant="primary" size="lg" icon="refresh" onPress={() => void restartPi()} />
          <Button label={tr("New session", "新会话")} size="lg" icon="plus" onPress={() => void newSession()} />
        </View>
      </If>
    </Stage>
  );
}

function Failure(props: { title: string; detail: string }) {
  const agentName = () => activeAgent().name;
  return (
    <Stage title={props.title} size={80}>
      <View class="max-h-48 w-full max-w-130 overflow-hidden rounded-lg border border-border bg-sunken p-3" selectable>
        <Text class="font-mono text-xs leading-relaxed text-muted-foreground">{props.detail}</Text>
      </View>
      <View class="flex-row flex-wrap justify-center gap-2">
        <Button label={tr(`Restart ${agentName()}`, `重启 ${agentName()}`)} variant="primary" size="lg" icon="refresh" onPress={() => void restartPi()} />
        <Button label={tr("Configure Agents…", "配置智能体…")} size="lg" icon="agents" onPress={() => showSettings("agents")} />
      </View>
    </Stage>
  );
}

/** How near the end of the conversation (pt) counts as at it: the list follows from within it, and a reader who scrolls back down to it follows again. */
const FOLLOW_THRESHOLD = 72;

/** How long (ms) after a scroll gesture of the reader's begins its scroll events are read as theirs. */
const INPUT_WINDOW_MS = 1500;

/** After the reader releases the view, how long (ms) a move towards the end is not read as theirs: the list settles its layout once as it is released. */
const RELEASE_SETTLE_MS = 300;

type Screen = "starting" | "failed" | "connect" | "welcome" | "transcript";

/** Floating pill shown when the reader scrolls up past the follow threshold,
 * offering a crisp native spring return to the bottom of the conversation. */
function ScrollToBottomPill(props: { visible: boolean; streaming: boolean; promptOpen: boolean; onPress: () => void }) {
  const mounted = signal(false);
  const opacity = createAnimatedValue(0);
  const translateY = createAnimatedValue(8);
  const scale = createAnimatedValue(0.94);
  const dotOpacity = useBreathingOpacity(() => mounted() && props.streaming, 0.3, 1050);
  let timer: ReturnType<typeof setTimeout> | undefined;

  effect(() => {
    const show = props.visible;
    const reduced = reduceMotion();
    untracked(() => {
      clearTimeout(timer);
      if (show) {
        mounted.set(true);
        if (reduced) {
          opacity.set(1);
          translateY.set(0);
          scale.set(1);
        } else {
          void opacity.timing(1, { duration: 160, easing: "easeOut" });
          void translateY.spring(0, SPRING.snappy);
          void scale.spring(1, SPRING.snappy);
        }
      } else if (mounted()) {
        if (reduced) {
          opacity.set(0);
          mounted.set(false);
        } else {
          void opacity.timing(0, { duration: 140, easing: "easeIn" });
          void translateY.timing(6, { duration: 140, easing: "easeIn" });
          void scale.timing(0.95, { duration: 140, easing: "easeIn" });
          timer = setTimeout(() => mounted.set(false), 150);
        }
      }
    });
  });

  cleanup(() => {
    clearTimeout(timer);
    void opacity.stop();
    void translateY.stop();
    void scale.stop();
  });

  return (
    <If when={mounted()}>
      <View
        class={`pointer-events-none absolute inset-x-0 z-10 items-center ${props.promptOpen ? "bottom-68" : "bottom-36"}`}
        style={{ opacity, transform: [{ translateY }, { scale }] }}
      >
        <BaseButton
          onPress={props.onPress}
          accessibilityLabel={tr("Scroll to bottom", "滚动到底部")}
          class={`pointer-events-auto h-7 flex-row items-center gap-1.5 rounded-full px-3 ${POPUP} ${PRESS} ${PRESS_SCALE} ${FOCUS_RING} hover:bg-muted/80 active:bg-muted`}
          style={GLASS_REGULAR}
        >
          <If when={props.streaming}>
            <View class="size-1.5 rounded-full bg-brand" style={{ opacity: dotOpacity }} />
          </If>
          <Text class="text-xs font-medium text-foreground">
            {props.streaming ? tr("Follow reply", "跟随输出") : tr("Jump to latest", "回到最新")}
          </Text>
          <View class="rotate-180">
            <Icon name="arrowUp" size={12} tone="muted-foreground" />
          </View>
        </BaseButton>
      </View>
    </If>
  );
}

/** The main pane: the conversation, or what stands in for it, over the composer. */
export function Chat() {
  let list: ListRef | undefined;
  /**
   * Whether the view follows the reply as it grows.
   *
   * While it does, the list keeps itself at the end
   * (`maintainVisibleContentPosition`): the offset moves in the same layout
   * as the content, so no frame shows the reply behind its end, and nothing
   * here scrolls per delta. For that the list must be handed only what
   * changed: rows that did not change stay the same objects (`stable`), and a
   * reply is a row per block, so a delta changes the last row alone.
   *
   * The reader takes over by input: a scroll of theirs that
   * moves up at all releases the view at once, and it then holds where they
   * left it however the reply grows. Scrolling back down to the end, the jump
   * pill or sending follows again. Nothing else changes it, so it cannot flap.
   *
   * Releasing takes two things, both found by measuring the list: the prop
   * off, and the rows handed over anew (not `stable`) while released. With
   * only its last row changed, the list goes on pulling to the end it was
   * last told to keep.
   */
  const following = signal(true);
  const distanceFromEnd = signal(0);
  /** When the reader last began a scroll gesture. */
  let inputAt = 0;
  let releasedAt = 0;
  let lastY: number | undefined;
  let lastDistance = 0;
  const screen = computed<Screen>(() => {
    const phase = sidecarPhase().name;
    if (phase === "failed") return "failed";
    if (phase === "starting" || isSwitching() || !sessionState()) return transcriptRows().length ? "transcript" : "starting";
    if (transcriptRows().length || isRunning()) return "transcript";
    return hasModel() ? "welcome" : "connect";
  });
  const stable = stableDisplayRows();
  let shown: ChatRow[] = [];
  const displayRows = computed<ChatRow[]>(() => {
    trackFoldState();
    const processOf = new Map<string, string>();
    const projected = buildDisplayRows(
      transcriptRows(),
      isChatActive(),
      (id, fallback, hasDetails) => turnOpen(id, fallback, untracked(following), hasDetails),
      processOf,
      isTurnClosing,
    );
    const rows = (following() ? stable(projected) : projected).flatMap((row): ChatRow[] =>
      row.kind !== "text" ? [row] : row.final && !row.streaming ? [...proseRows(row), replyActions(row)] : proseRows(row),
    );
    // The rows a turn's fold shows, in order (commentary is a row per block, each the turn's its reply is).
    const folded = new Map<string, string>();
    for (const row of rows) {
      const turn = processOf.get(row.id) ?? (row.kind === "prose" ? processOf.get(row.rowId) : undefined);
      if (turn) folded.set(row.id, turn);
    }
    setProcessTurns(folded);
    // The same rows are the same list: an event that changed nothing on screen reaches the list as nothing.
    if (following() && rows.length === shown.length && rows.every((row, at) => row === shown[at])) return shown;
    shown = rows;
    return rows;
  });
  const failure = () => {
    const phase = sidecarPhase();
    return phase.name === "failed" ? phase : { title: "", detail: "" };
  };

  const onScroll = (e: ScrollEvent) => {
    const y = e.offset.y;
    const distance = e.contentSize.height - (y + e.size.height);
    distanceFromEnd.set(distance);
    // The list reports its own layout passes too (a row measured, the fold
    // closing): only a move within a gesture of the reader's is theirs. Up and
    // away from the end releases; back down to the end follows again.
    if (lastY !== undefined && Date.now() - inputAt < INPUT_WINDOW_MS) {
      if (following() && y < lastY - 0.5 && distance > Math.max(lastDistance, 0) + 0.5) {
        following.set(false);
        releasedAt = Date.now();
      } else if (!following() && y > lastY + 0.5 && distance <= FOLLOW_THRESHOLD && Date.now() - releasedAt > RELEASE_SETTLE_MS) {
        follow(false);
      }
    }
    lastY = y;
    lastDistance = distance;
  };
  const onInput = () => {
    inputAt = Date.now();
  };

  const follow = (animated: boolean) => {
    inputAt = 0;
    following.set(true);
    // An offset past any end is the end, with no pass through the top on the way (`scrollToEnd`'s).
    if (animated) list?.scrollToEnd({ animated: true });
    else list?.scrollTo({ y: 1e7, animated: false });
  };

  // A fold the reader presses grows or shrinks the rows under it, not those above: let go of the end.
  onFoldToggle(() => {
    pokeRepaint();
    if (!untracked(following)) return;
    following.set(false);
    releasedAt = Date.now();
  });
  onFoldSettled(() => pokeRepaint());

  // A reply still growing moves the end under an animated scroll: go there at once.
  const jumpToLatest = () => follow(!reduceMotion() && !isChatActive());

  effect(() => {
    scrollToEndTick();
    untracked(() => follow(false));
  });
  effect(() => {
    if (hasInlinePrompt() && untracked(following)) list?.scrollToEnd({ animated: !reduceMotion() });
  });
  /**
   * One more mount batch shortly after the transcript's big changes. The
   * platform defers painting a view mounted while it is not shown and catches
   * up on its next pass — a pass an idle surface can miss, leaving laid-out
   * space and accessibility text but no pixels. This pulse is that pass: a
   * zero-size child mounts and unmounts, so any deferred text draws. (nsh
   * upstream, to be removed once the surface retries its deferred draws.)
   */
  const repaint = signal(0);
  const repaintTimers: ReturnType<typeof setTimeout>[] = [];
  const pokeRepaint = () => {
    for (const timer of repaintTimers.splice(0)) clearTimeout(timer);
    repaintTimers.push(
      setTimeout(() => repaint.update((n) => n + 1), 300),
      setTimeout(() => repaint.update((n) => n + 1), 900),
    );
  };
  cleanup(() => {
    for (const timer of repaintTimers.splice(0)) clearTimeout(timer);
  });
  // A run settling is exactly the heavy-mount moment above.
  let wasActive = untracked(isChatActive);
  effect(() => {
    const active = isChatActive();
    const was = wasActive;
    wasActive = active;
    if (was && !active) pokeRepaint();
  });
  // The whole conversation landing (a parked session adopted, a file loaded).
  effect(() => {
    sessionLandedTick();
    untracked(pokeRepaint);
  });

  // Another session's rows are other rows: what was expanded there is not here.
  // (By id: the session's state is replaced with every refresh of it, mid-run too.)
  const sessionId = computed(() => sessionState()?.sessionId);
  effect(() => {
    sessionId();
    inputAt = 0;
    lastY = undefined;
    following.set(true);
    distanceFromEnd.set(0);
    resetExpanded();
    pokeRepaint();
  });

  return (
    <View class="relative flex-1">
      <NewThreadBackground visible={screen() !== "transcript"} />
      <View class="relative flex-1">
        <If when={screen() === "transcript"}>
          <View
            selectable
            class="flex-1"
            style={{
              maskImage: hasInlinePrompt()
                ? "linear-gradient(to bottom, transparent 0px, black 40px, black calc(100% - 240px), transparent calc(100% - 170px))"
                : "linear-gradient(to bottom, transparent 0px, black 40px, black calc(100% - 118px), transparent calc(100% - 56px))",
            }}
          >
            <List
              ref={list}
              each={displayRows()}
              estimatedItemSize={44}
              keyExtractor={(row) => row.id}
              onScroll={onScroll}
              scrollEventThrottle={16}
              onScrollDragStart={onInput}
              onMomentumStart={onInput}
              maintainVisibleContentPosition={following() ? { autoscrollToBottomThreshold: FOLLOW_THRESHOLD } : undefined}
              class="flex-1"
              contentClass={hasInlinePrompt() ? "px-6 pb-76 pt-14" : "px-6 pb-44 pt-14"}
              accessibilityLabel={tr("Conversation", "对话")}
              footer={<ActivityLine />}
            >
              {(row) => <TranscriptRow row={row()} />}
            </List>
          </View>
          <ScrollToBottomPill visible={!following() && distanceFromEnd() > FOLLOW_THRESHOLD} streaming={isChatActive()} promptOpen={hasInlinePrompt()} onPress={jumpToLatest} />
        </If>
        <If when={screen() === "welcome"}>
          <Welcome />
        </If>
        <If when={screen() === "connect"}>
          <Connect />
        </If>
        <If when={screen() === "starting"}>
          <Waking />
        </If>
        <If when={screen() === "failed"}>
          <Failure title={failure().title} detail={failure().detail} />
        </If>
      </View>
      <View class="pointer-events-none absolute inset-x-0 bottom-0 z-10">
        <Composer />
      </View>
      <If when={repaint() % 2 === 0}>
        <View class="pointer-events-none absolute size-0" />
      </If>
    </View>
  );
}
