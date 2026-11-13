import { Animated, cleanup, computed, createAnimatedValue, effect, List, reduceMotion, Scroll, signal, Text, untracked, View } from "nsh";
import type { JSX, ListRef, MouseEvent, ScrollEvent, ViewRef } from "nsh";
import { Button as BaseButton, Popover } from "nsh/base";
import { titleBar } from "nsh/desktop";
import { edgeStep, edgeTarget } from "../lib/edge-scroll";
import { basename, tildePath } from "../lib/format";
import { tr } from "../lib/i18n";
import { Pip } from "../mascot/Pip";
import {
  activeAgent,
  chooseWorkspace,
  currentActivity,
  hasModel,
  isDraftAhead,
  isLeavingSession,
  isRunning,
  isSwitching,
  newSession,
  newSessionInWorkspace,
  pendingDialog,
  pipMood,
  restartPi,
  scrollToEndTick,
  sessionArrivedTick,
  sessionLandedTick,
  sessionState,
  showAgentSettings,
  showSettings,
  sidecarPhase,
  transcriptRows,
  waitingCount,
  wallpaper,
  workspacePath,
} from "../store/app";
import { backend } from "../store/backend";
import { recentWorkspaces } from "../store/prefs";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { DURATION, EASING, enterStagger, markRowsSeen, popupHiddenStyle, popupLeavingStyle, popupStyle, PATIENCE_MS, SPRING } from "../ui/motion";
import { RollingText } from "../ui/RollingText";
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
  setProcessTurns,
  swapConversation,
  trackFoldState,
  TranscriptRow,
  turnOpen,
} from "./Rows";
import { HeaderBand, PaneVeil } from "./Wallpaper";
import { buildDisplayRows, displayRowIds, stableDisplayRows } from "../pi/turns";

/** Whether the displayed conversation is actively running. */
function isChatActive() {
  return isRunning() || waitingCount() > 0;
}

/** What the run is doing, in a word or two. */
function activityLabel() {
  const dialog = pendingDialog();
  if (dialog) return tr("Waiting for confirmation", "等待确认");
  if (!isRunning()) {
    const waiting = waitingCount();
    if (waiting > 0) return tr(`Waiting on ${waiting} ${waiting === 1 ? "session" : "sessions"}`, `等待 ${waiting} 个会话`);
  }
  const activity = currentActivity();
  switch (activity.kind) {
    case "writing":
      return tr("Writing", "正在回复");
    case "tool": {
      const oneLine = activity.name.replace(/\s*\n\s*/g, " ; ").replace(/\s+/g, " ").trim();
      return tr(`Running ${oneLine}`, `正在执行 ${oneLine}`);
    }
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
 * shifts the scroll content height or causes a layout jump at the end of a stream.
 * It is the last thing in the list, so where it stands is where the conversation ends (`anchor`). */
function ActivityLine(props: { anchor?: (node: ViewRef) => void }) {
  const shown = signal(false);
  const opacity = createAnimatedValue(0);
  const translateY = createAnimatedValue(4);
  let exitTimer: ReturnType<typeof setTimeout> | undefined;

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

  cleanup(() => {
    clearTimeout(exitTimer);
    void opacity.stop();
    void translateY.stop();
  });

  const reason = () => {
    const activity = currentActivity();
    return activity.kind === "retrying" ? activity.reason : "";
  };

  return (
    <View ref={(node: ViewRef) => props.anchor?.(node)} class="h-9 w-full max-w-190 select-none justify-center overflow-hidden self-center">
      <If when={shown()}>
        <View
          class="min-w-0 flex-row items-center gap-2.5 pt-1"
          style={{ opacity, transform: [{ translateY }] }}
          accessibilityState={{ busy: isChatActive() }}
        >
          <View class="shrink-0">
            <Pip size={22} mood={pipMood()} />
          </View>
          <If when={isChatActive()}>
            <RollingText text={activityLabel} class="min-w-0 shrink truncate text-sm text-muted-foreground" />
            <If when={reason()}>
              <Text class="min-w-0 flex-1 truncate text-xs text-subtle">{reason()}</Text>
            </If>
          </If>
        </View>
      </If>
    </View>
  );
}

/**
 * A centered message with Pip: every state the chat can be in before there is a conversation.
 *
 * `around` is the same message with the composer in the middle of it (`HERO`): Pip and the title stand
 * on the composer's top edge and what follows hangs from its lower one. Both are placed from the
 * composer's own box, so the three are one figure whatever the composer grows to.
 */
function Stage(props: { title: string; detail?: string; size?: number; around?: boolean; children?: JSX.Element }) {
  const pip = (
    <View style={enterStagger(0)}>
      <Pip size={props.size ?? 96} mood={pipMood()} />
    </View>
  );
  const words = (
    <View class="max-w-110 items-center gap-1.5" style={enterStagger(1)}>
      <Text class="text-center text-2xl font-semibold tracking-tight text-foreground" role="header">
        {props.title}
      </Text>
      <If when={props.detail}>
        <Text class="text-center text-sm text-subtle">{props.detail}</Text>
      </If>
    </View>
  );
  if (untracked(() => props.around)) {
    return (
      <>
        {/* 12 under the title and the composer's own 12 over its surface: a group's gap between them. */}
        <View class="absolute inset-x-0 bottom-full items-center gap-6 px-8 pb-3">
          {pip}
          {words}
        </View>
        <If when={props.children}>
          {/* The composer keeps 20 under its surface: 12 of it is left. */}
          <View class="absolute inset-x-0 top-full -mt-2 items-center px-8" style={enterStagger(2)}>
            <View class="pointer-events-auto items-center gap-6">{props.children}</View>
          </View>
        </If>
      </>
    );
  }
  return (
    <View class="flex-1 items-center justify-center gap-6 px-8 pb-28 pt-12">
      {pip}
      {words}
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
          class={`h-7 flex-row items-center gap-1.5 ${PRESS} ${FOCUS_RING} ${
            // Over a wallpaper the words cannot stand on the picture: they get the composer's glass, as a capsule.
            wallpaper() ? "rounded-full border-[0.5px] border-hairline bg-card/65 pl-3 pr-2.5 hover:bg-card/85 dark:bg-card/58 dark:hover:bg-card/75" : "rounded-md px-1.5 hover:bg-accent"
          }`}
          style={wallpaper() ? GLASS_REGULAR : undefined}
        >
          <Text class={`max-w-80 truncate text-sm text-muted-foreground ${wallpaper() ? "" : "underline"}`}>{`${activeAgent().name} · ${tildePath(current(), home)}`}</Text>
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

/** The empty chat: Pip and the question over the composer, and under it which project the session will run in. */
function Welcome() {
  return (
    <Stage around title={tr("What are we building?", "今天要构建什么？")}>
      <If when={workspacePath()}>
        <WelcomeProject />
      </If>
    </Stage>
  );
}

function Connect() {
  const agentName = () => activeAgent().name;
  return (
    <Stage title={tr("Connect a model to begin", "连接模型以开始使用")} detail={tr(`${agentName()} has no models configured yet.`, `${agentName()} 尚未配置可用模型。`)}>
      <Button label={tr(`Configure ${agentName()}`, `配置 ${agentName()}`)} variant="primary" size="lg" icon="plug" onPress={() => showAgentSettings()} />
      <Text class="max-w-110 text-center text-xs text-subtle">
        {tr("Environment keys and installed CLIs are detected automatically.", "环境变量密钥与本机已安装的智能体会自动识别。")}
      </Text>
    </Stage>
  );
}

const SLOW_WAKE_MS = 5000;

function Waking(props: { around?: boolean }) {
  const agentName = () => activeAgent().name;
  const slow = signal(false);
  const timer = setTimeout(() => slow.set(true), SLOW_WAKE_MS);
  cleanup(() => clearTimeout(timer));
  return (
    <Stage around={props.around} title={tr(`Waking ${agentName()}…`, `正在唤醒 ${agentName()}…`)} size={80}>
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

/** How long (ms) the conversation being left takes to dim, and its successor to settle in. */
const LEAVE_MS = 120;
const ARRIVE_MS = 200;

/**
 * What a session change shows once it has outlasted patience: a destination
 * that lands sooner never passes through it, and one that lands later takes
 * its place as this fades. `around`: the composer stands in the middle of the pane, and so does the wait.
 */
function Waiting(props: { show: boolean; around?: boolean }) {
  const mounted = signal(false);
  const opacity = createAnimatedValue(0);
  let timer: ReturnType<typeof setTimeout> | undefined;
  effect(() => {
    const show = props.show;
    untracked(() => {
      clearTimeout(timer);
      void opacity.stop();
      if (show) {
        mounted.set(true);
        if (reduceMotion()) opacity.set(1);
        else {
          opacity.set(0);
          opacity.keyframes([0, 1], { duration: DURATION.slower, delay: PATIENCE_MS, easing: EASING.smoothOut });
        }
      } else if (mounted()) {
        if (reduceMotion()) return mounted.set(false);
        void opacity.timing(0, { duration: LEAVE_MS, easing: EASING.out });
        timer = setTimeout(() => mounted.set(false), LEAVE_MS + 10);
      }
    });
  });
  cleanup(() => {
    clearTimeout(timer);
    void opacity.stop();
  });
  return (
    <If when={mounted()}>
      <View class={`absolute inset-0 ${props.show ? "" : "pointer-events-none"}`} style={{ opacity }}>
        <Waking around={props.around} />
      </View>
    </If>
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

/** How near the end of the conversation (pt) counts as at it: the list follows from within it, and a released
 * reader who scrolls back down glides the rest of the way once the reply can no longer move the end. */
const FOLLOW_THRESHOLD = 72;

/** How close to the end (pt) re-attaches while the reply can still move it: any catch-up lands short of a
 * moving end, and following's first pin jumps the difference — arriving at the end itself jumps nothing. */
const REATTACH_EPS = 8;

/** How long (ms) after a scroll gesture of the reader's begins its scroll events are read as theirs. */
const INPUT_WINDOW_MS = 1500;

/** After the reader releases the view, how long (ms) a move towards the end is not read as theirs: the list settles its layout once as it is released. */
const RELEASE_SETTLE_MS = 300;

/** How long (ms) a selection drag that has left the pane goes on scrolling after the selection last grew: the button going up out there is not heard. */
const EDGE_BEAT_MS = 250;

/**
 * The foot of the conversation, measured up from the pane's lower edge. What stands there is the composer's
 * figure as laid out (`figure`, its height): 20 under the composer, the composer, whatever stands on it — the
 * queue's tray, attachments, an inline prompt — and 12 over that. At rest that is 124 (a 92pt composer), its
 * top edge at 112; the edge is wherever the figure puts it, and what meets it is placed from it, so the three
 * move together and nothing the composer grows by covers the reply:
 * - `end`: the conversation ends 16 above the edge, a container's pad. The activity line's 36pt slot is the last
 *   thing in it, so a reply at rest stands 52 clear of the composer and Pip, working, about 20.
 * - "Jump to latest" stands on that same line.
 * - `fade`: rows fade out as they pass under that edge.
 */
const FIGURE_REST = 124;
function footOf(figure: number) {
  const edge = (figure || FIGURE_REST) - 12;
  return { end: edge + 16, fade: `linear-gradient(to top, transparent ${edge - 56}px, black ${edge + 6}px)` };
}

/**
 * Where the composer stands while there is no conversation: in the middle of the pane, with the stage
 * around it. The pane's free height is shared out over and under the figure — Pip and the title (`head`),
 * the composer, the project under it (`foot`) — a little more of it under (`rise` to `sink`), so the
 * figure sits just above the middle, where the eye puts the middle.
 */
const HERO = { head: 136, foot: 20, rise: 9, sink: 11 } as const;

/** How the composer travels between the middle of the pane and its foot: as a spring with no bounce in it
 * moves, a little softer than a panel's — it goes a third of the window, and has all but landed in ~550ms. */
const DOCK_SPRING = { stiffness: 220, damping: 30, mass: 1 } as const;
const DOCK_FPS = 60;
/** How near its end the travel is over, as a share of the way: a point in some three hundred. */
const DOCK_REST = 1 / 300;
/** How long (ms) the stage the composer leaves takes to fade where it stood. */
const STAGE_OUT_MS = 140;

/**
 * That spring as the native driver runs it, a value per frame from 0 to 1, cut where it has all but landed.
 * The travel plays these frames as keyframes, not the spring itself: over so long a way the driver's spring
 * goes on well after it has stopped on screen (a send kept the app busy for two seconds and more), and
 * nothing that waits for the app to be idle should wait for that. The same frames say where a travel under
 * way has got to.
 */
let dockCurve: number[] | undefined;
function dockFrames() {
  if (!dockCurve) {
    const samples = Animated.sampleSpring({ toValue: 1, ...DOCK_SPRING }, DOCK_FPS);
    const landed = samples.findIndex((at) => Math.abs(1 - at) < DOCK_REST);
    dockCurve = [...samples.slice(0, landed < 0 ? samples.length : landed), 1];
  }
  return dockCurve;
}

type Screen = "starting" | "failed" | "connect" | "welcome" | "transcript";

/** Floating pill shown when the reader scrolls up past the follow threshold,
 * offering a crisp native spring return to the bottom of the conversation. */
function ScrollToBottomPill(props: { visible: boolean; bottom: number; onPress: () => void }) {
  const mounted = signal(false);
  const opacity = createAnimatedValue(0);
  const translateY = createAnimatedValue(8);
  const scale = createAnimatedValue(0.94);
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
        class="pointer-events-none absolute inset-x-0 z-10 items-center"
        style={{ bottom: props.bottom, opacity, transform: [{ translateY }, { scale }] }}
      >
        <BaseButton
          onPress={props.onPress}
          accessibilityLabel={tr("Scroll to bottom", "滚动到底部")}
          class={`pointer-events-auto h-7 flex-row items-center gap-1.5 rounded-full px-3 ${POPUP} ${PRESS} ${PRESS_SCALE} ${FOCUS_RING} hover:bg-muted/80 active:bg-muted`}
          style={GLASS_REGULAR}
        >
          <Text class="text-xs font-medium text-foreground">{tr("Jump to latest", "回到最新")}</Text>
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
  let held: Screen = "starting";
  const screen = computed<Screen>(() => {
    const phase = sidecarPhase().name;
    if (phase === "failed") return (held = "failed");
    // What is being left stays, dimmed, until its successor lands: no state in between passes through.
    if (isLeavingSession()) return held;
    if (isDraftAhead()) return (held = "welcome");
    if (phase === "starting" || isSwitching() || !sessionState()) return (held = transcriptRows().length ? "transcript" : "starting");
    if (transcriptRows().length || isRunning()) return (held = "transcript");
    return (held = hasModel() ? "welcome" : "connect");
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

  /**
   * Where the composer stands. A conversation docks it at the pane's foot. With none — the empty chat,
   * and the wait for the agent before it — nothing is above it to read, so it stands in the middle of
   * the pane with the stage around it (`HERO`), and the first message sends it down.
   *
   * Both places are layout — the spacers over and under it — and never a transform at rest: a popup
   * opens where its trigger is laid out, the figure re-centers as the composer grows, and a window
   * resize costs no frame. The move between them is the layout changing at once while `slide` puts the
   * composer back where it was drawn, in the same turn and so the same frame, and then lets it go to rest.
   * The stage it leaves does not travel with it: `stand` holds that where it stood while it fades.
   */
  const hero = computed(() => screen() === "welcome" || screen() === "starting");
  /** The composer's offset from where it is laid out: zero but while it travels. */
  const slide = createAnimatedValue(0);
  /** The stage's offset from the composer's layout: zero around it, and the way back up once it has left. */
  const stand = createAnimatedValue(0);
  const stageFade = createAnimatedValue(1);
  /** The stage around the composer: the screen's while it stands in the middle, and that one still while it fades. */
  const stage = signal<Screen | undefined>(untracked(hero) ? untracked(screen) : undefined);
  let paneHeight = 0;
  /** The composer's figure as laid out: the composer and what stands on it. The conversation's foot is placed from it (`footOf`). */
  const figure = signal(0);
  /** How far the pane goes on under the composer in the middle, as laid out: the way down to the dock. */
  let drop = 0;
  /** The same before it is laid out, for the way up: the lower spacer's share of the free height. */
  const dropAhead = () => HERO.foot + (Math.max(0, paneHeight - untracked(figure) - HERO.head - HERO.foot) * HERO.sink) / (HERO.rise + HERO.sink);
  /** The travel under way, to start the next one from where this one has got to. */
  let travel: { from: number; at: number } | undefined;
  const slideNow = () => {
    if (!travel) return 0;
    const frames = dockFrames();
    const frame = Math.round(((Date.now() - travel.at) / 1000) * DOCK_FPS);
    return frame < frames.length ? travel.from * (1 - frames[frame]) : 0;
  };
  let stageTimer: ReturnType<typeof setTimeout> | undefined;
  let wasHero = untracked(hero);
  let wasLeaving = untracked(isLeavingSession);
  effect(() => {
    const middle = hero();
    const on = screen();
    const leaving = isLeavingSession();
    untracked(() => {
      // The pane was dimmed out for a change that has now landed: its stage is not there to fade.
      const dimmedOut = wasLeaving;
      wasLeaving = leaving;
      if (middle) {
        clearTimeout(stageTimer);
        stage.set(on);
      }
      if (middle === wasHero) return;
      wasHero = middle;
      const reduced = reduceMotion();
      const way = middle ? dropAhead() : drop || dropAhead();
      const from = slideNow() + (middle ? way : -way);
      travel = undefined;
      // Up: the stage is where it will be, and the composer comes to it. Down: it stays where it was.
      stand.set(middle ? 0 : -way);
      if (reduced) slide.set(0);
      else {
        const mine = (travel = { from, at: Date.now() });
        // Set first: the layout changes in this turn, and so must where the composer is drawn.
        slide.set(from);
        const frames = dockFrames();
        void slide
          .keyframes(
            frames.map((at) => from * (1 - at)),
            { duration: ((frames.length - 1) * 1000) / DOCK_FPS, easing: "linear" },
          )
          .then(() => {
            if (travel === mine) travel = undefined;
          });
      }
      if (middle) return;
      void stageFade.stop();
      if (reduced || dimmedOut) return stage.set(undefined);
      stageFade.set(1);
      void stageFade.timing(0, { duration: STAGE_OUT_MS, easing: EASING.out });
      stageTimer = setTimeout(() => stage.set(undefined), STAGE_OUT_MS + 10);
    });
  });
  cleanup(() => {
    clearTimeout(stageTimer);
    void slide.stop();
    void stageFade.stop();
  });

  const onScroll = (e: ScrollEvent) => {
    const y = e.offset.y;
    const distance = e.contentSize.height - (y + e.size.height);
    distanceFromEnd.set(distance);
    // The list reports its own layout passes too (a row measured, the fold
    // closing): only a move within a gesture of the reader's is theirs. Up and
    // away from the end releases; back down follows again — at the end itself
    // while the reply can still move it, from within the threshold once still.
    if (lastY !== undefined && Date.now() - inputAt < INPUT_WINDOW_MS) {
      if (following() && y < lastY - 0.5 && distance > Math.max(lastDistance, 0) + 0.5) {
        following.set(false);
        releasedAt = Date.now();
      } else if (!following() && y > lastY + 0.5 && distance <= (isChatActive() ? REATTACH_EPS : FOLLOW_THRESHOLD) && Date.now() - releasedAt > RELEASE_SETTLE_MS) {
        follow(!reduceMotion() && !isChatActive());
      }
    }
    lastY = y;
    lastDistance = distance;
    lastMax = e.contentSize.height - e.size.height;
  };
  const onInput = () => {
    inputAt = Date.now();
  };

  /**
   * A selection dragged to an edge of what can be read — the title bar's band above, the composer's top
   * below — scrolls the conversation on (`lib/edge-scroll.ts`), as text does everywhere. The platform's own
   * autoscroll looks for a scroll view around the selectable view, and here the list is inside it, under a
   * frame that goes on behind both edges: so the pane does it. The pane listens to the mouse only while a
   * selection is being made (the selection changing says so; the button up, or a move without it, ends it),
   * and each frame the pointer rests in an edge the list moves by a step, as the reader's own scroll: up
   * releases the view, down to the end follows again. The platform extends the selection as the pointer
   * moves, not as the text moves under it: held still, the highlight catches up on the next move.
   */
  const selecting = signal(false);
  let selected = "";
  let selectedAt = 0;
  /** Where the pressed pointer is down the pane, once it has moved; and whether that is where it left it. */
  let pointerY: number | undefined;
  let pointerOut = false;
  let lastMax = 0;
  let edgeFrame: number | undefined;
  let edgeAt = 0;
  let edgeFrom: number | undefined;
  let edgeAim: number | undefined;
  let edgeAsking = false;
  const edgeRest = () => {
    edgeAt = 0;
    edgeFrom = edgeAim = undefined;
  };
  const edgeTick = () => {
    edgeFrame = undefined;
    if (!untracked(selecting) || pointerY === undefined) return edgeRest();
    const top = untracked(() => titleBar().height) || 44;
    const bottom = paneHeight - (untracked(figure) || FIGURE_REST);
    const step = edgeStep(pointerY, top, bottom);
    if (!step || (pointerOut && Date.now() - selectedAt > EDGE_BEAT_MS)) return edgeRest();
    edgeFrame = requestAnimationFrame(edgeTick);
    if (lastY === undefined) {
      // A list that has not scrolled yet has not said where it is: ask it, and step from the row it names. It reports from then on.
      if (edgeAsking || !list) return;
      edgeAsking = true;
      void list.measureScrollPosition().then((at) => {
        edgeAsking = false;
        if (!at || lastY !== undefined || !untracked(selecting)) return;
        onInput();
        list?.scrollToIndex({ index: at.index, viewOffset: -(at.offset + step), animated: false });
      });
      return;
    }
    // Frames as long as at 60 Hz move as far, whatever the display's rate.
    const now = Date.now();
    const scale = edgeAt ? Math.min(4, Math.max(0.25, ((now - edgeAt) * 60) / 1000)) : 1;
    edgeAt = now;
    const target = edgeTarget(step * scale, lastY, lastMax, edgeFrom, edgeAim);
    // At an end: nothing to ask for again.
    if (target === (edgeFrom === lastY ? edgeAim : lastY)) return;
    edgeFrom = lastY;
    edgeAim = target;
    onInput();
    list?.scrollTo({ y: target, animated: false });
  };
  const edgeKick = () => {
    edgeFrame ??= requestAnimationFrame(edgeTick);
  };
  const endSelecting = () => {
    if (untracked(selecting)) selecting.set(false);
    pointerY = undefined;
    pointerOut = false;
    cancelAnimationFrame(edgeFrame);
    edgeFrame = undefined;
    edgeRest();
  };
  const onSelection = (e: { text: string }) => {
    // Its box moves with every scroll: only the text changing is the reader selecting.
    if (e.text === selected) return;
    selected = e.text;
    if (!e.text) return endSelecting();
    selectedAt = Date.now();
    if (!untracked(selecting)) selecting.set(true);
    edgeKick();
  };
  const onSelectMove = (e: MouseEvent) => {
    if (e.pressedButton !== "left") return endSelecting();
    pointerY = e.position.y;
    pointerOut = false;
    edgeKick();
  };
  const onSelectLeave = (e: MouseEvent) => {
    if (e.pressedButton !== "left") return endSelecting();
    pointerY = e.position.y;
    pointerOut = true;
    edgeKick();
  };
  cleanup(endSelecting);

  const foot = computed(() => footOf(figure()), { equals: (a, b) => a.end === b.end });

  // A released view holds its offset, so the list reports no scroll while the
  // reply grows under it, and the distance last reported goes stale: a reader
  // who scrolled up less than the threshold would never be offered the way
  // back. So what changes the rows of a released view measures where the end
  // went: the activity line's foot plus the pad under it, from the list's own.
  let ending: ViewRef | undefined;
  const measureEnd = () => {
    if (untracked(following)) return;
    const pad = untracked(foot).end;
    void Promise.all([list?.measure(), ending?.measure()]).then(([frame, end]) => {
      // Rows far from the end are not mounted: the distance the scroll reported stands.
      if (!frame || !end || untracked(following)) return;
      distanceFromEnd.set(end.pagePosition.y + end.bounds.size.height + pad - (frame.pagePosition.y + frame.bounds.size.height));
    });
  };
  effect(() => {
    displayRows();
    foot();
    untracked(measureEnd);
  });

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
  onFoldSettled(() => {
    pokeRepaint();
    measureEnd();
  });

  // A reply still growing moves the end under an animated scroll: go there at once.
  const jumpToLatest = () => follow(!reduceMotion() && !isChatActive());

  effect(() => {
    scrollToEndTick();
    untracked(() => follow(false));
  });
  // That reaches a list on screen only. A conversation can land while none is —
  // the empty chat held, dimmed, until its successor is whole — and the list
  // made for it then would open at its start, with the scroll to the end already
  // spent. So a list made anew opens at its end (`initialScrollAtEnd`, before its
  // first frame) and follows from there, whatever the one before it was left doing.
  let listed = false;
  effect(() => {
    const was = listed;
    listed = screen() === "transcript";
    if (!listed || was) return;
    untracked(() => {
      inputAt = 0;
      lastY = undefined;
      following.set(true);
    });
  });
  // The foot rising moves the end up with it — the queue's tray, a draft growing, an inline prompt — and the list
  // does not go along by itself (it loses its place, and paints blank): a view that follows is sent to the end again,
  // at once while the reply can move the end too, gliding under a prompt, which holds it. Sinking, the list clamps
  // itself; an offset asked for then, before the shorter content is laid out, is past the end.
  let footEnd = untracked(foot).end;
  effect(() => {
    const end = foot().end;
    const rose = end > footEnd;
    footEnd = end;
    if (!rose || !untracked(following)) return;
    if (untracked(hasInlinePrompt) && !untracked(reduceMotion)) list?.scrollToEnd({ animated: true });
    else list?.scrollTo({ y: 1e7, animated: false });
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

  /**
   * A session change is one motion, whatever it costs behind the screen. The
   * click is answered at once: a destination that can be shown (a conversation
   * seen before, a fresh session's empty chat) is, and settles in; otherwise
   * what is on screen dims out while the title bar and the sidebar already
   * name the destination, which settles in the same way as it lands. A quick
   * landing interrupts the dim-out, so it reads as a dip rather than a blank;
   * a slow one is waited for on an empty pane, then with Pip (`Waiting`).
   */
  const pane = createAnimatedValue(1);
  let dimmed = false;
  effect(() => {
    const leaving = isLeavingSession();
    untracked(() => {
      if (!leaving) return;
      dimmed = true;
      if (reduceMotion()) pane.set(0);
      else void pane.timing(0, { duration: LEAVE_MS, easing: EASING.out });
    });
  });
  let arrivedAt = untracked(sessionArrivedTick);
  effect(() => {
    const tick = sessionArrivedTick();
    untracked(() => {
      if (tick === arrivedAt) return;
      arrivedAt = tick;
      if (reduceMotion()) pane.set(1);
      else {
        if (!dimmed) pane.set(0);
        void pane.timing(1, { duration: ARRIVE_MS, easing: EASING.out });
      }
      dimmed = false;
    });
  });
  cleanup(() => void pane.stop());

  // Another conversation's rows are other rows: what was expanded there is not
  // here, and the rows landing were already on screen, so none of them enters again.
  const conversation = computed(() => sessionState()?.sessionId ?? "");
  // Only the conversation changing runs this. What it reads on the way — the
  // rows, the fold memory — is not what it waits for: tracked, every delta of a
  // reply would follow again and take the view back from a reader who scrolled up.
  effect(() => {
    const key = conversation();
    untracked(() => {
      inputAt = 0;
      lastY = undefined;
      selected = "";
      endSelecting();
      following.set(true);
      distanceFromEnd.set(0);
      swapConversation(key);
      markRowsSeen(displayRowIds(transcriptRows()));
      pokeRepaint();
    });
  });

  return (
    <View
      class="relative flex-1"
      onMouseMove={selecting() ? onSelectMove : undefined}
      onMouseLeave={selecting() ? onSelectLeave : undefined}
      onMouseUp={selecting() ? endSelecting : undefined}
    >
      <PaneVeil docked={!hero()} reading={screen() === "transcript"} />
      <View class={`relative flex-1 ${isLeavingSession() ? "pointer-events-none" : ""}`} style={{ opacity: pane }}>
        <If when={screen() === "transcript"}>
          <View
            selectable
            onSelectionChange={onSelection}
            class="flex-1"
            style={{ maskImage: `linear-gradient(to bottom, transparent 0px, black 40px), ${foot().fade}` }}
          >
            <List
              ref={list}
              each={displayRows()}
              initialScrollAtEnd
              estimatedItemSize={44}
              keyExtractor={(row) => row.id}
              onScroll={onScroll}
              scrollEventThrottle={16}
              onScrollDragStart={onInput}
              onMomentumStart={onInput}
              maintainVisibleContentPosition={following() ? { autoscrollToBottomThreshold: FOLLOW_THRESHOLD } : undefined}
              class="flex-1"
              contentStyle={{ paddingHorizontal: 24, paddingTop: (titleBar().height || 44) + 12, paddingBottom: foot().end }}
              accessibilityLabel={tr("Conversation", "对话")}
              footer={<ActivityLine anchor={(node) => (ending = node)} />}
            >
              {(row) => <TranscriptRow row={row()} />}
            </List>
          </View>
          <ScrollToBottomPill visible={!following() && distanceFromEnd() > FOLLOW_THRESHOLD} bottom={foot().end} onPress={jumpToLatest} />
        </If>
        <If when={screen() === "connect"}>
          <Connect />
        </If>
        <If when={screen() === "failed"}>
          <Failure title={failure().title} detail={failure().detail} />
        </If>
      </View>
      <Waiting show={isLeavingSession() && !hero()} />
      <HeaderBand show={screen() === "transcript"} height={titleBar().height || 44} />
      {/* The composer's column: the spacers over and under it are where it stands (`hero`). */}
      <View class="pointer-events-none absolute inset-0 z-10" onLayout={(e) => (paneHeight = e.bounds.size.height)}>
        <View style={{ flexGrow: hero() ? HERO.rise : 1, flexShrink: 1, flexBasis: hero() ? HERO.head : 0 }} />
        <View class="relative" style={{ transform: [{ translateY: slide }] }} onLayout={(e) => figure.set(Math.round(e.bounds.size.height))}>
          <View class="absolute inset-0" style={{ transform: [{ translateY: Animated.subtract(stand, slide) }] }}>
            <If when={stage() !== undefined}>
              {/* The stage is the pane's content: it dims and lands with it, and fades on its own once the composer has left it. */}
              <View class="absolute inset-0" style={{ opacity: hero() ? pane : stageFade }}>
                <If when={stage() === "welcome"}>
                  <Welcome />
                </If>
                <If when={stage() === "starting"}>
                  <Waking around />
                </If>
              </View>
            </If>
            <Waiting around show={isLeavingSession() && hero()} />
          </View>
          <Composer />
        </View>
        <View
          style={{ flexGrow: hero() ? HERO.sink : 0, flexShrink: 1, flexBasis: hero() ? HERO.foot : 0 }}
          onLayout={(e) => {
            if (hero()) drop = e.bounds.size.height;
          }}
        />
      </View>
      <If when={repaint() % 2 === 0}>
        <View class="pointer-events-none absolute size-0" />
      </If>
    </View>
  );
}
