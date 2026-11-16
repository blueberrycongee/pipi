import { Animated, cleanup, computed, createAnimatedValue, effect, List, reduceMotion, Scroll, signal, Text, untracked, View } from "nsh";
import type { JSX, ListRef, MouseEvent, ScrollEvent, ViewRef } from "nsh";
import { Button as BaseButton, Popover } from "nsh/base";
import { edgeStep, edgeTarget } from "../lib/edge-scroll";
import { topBarHeight } from "../lib/layout";
import { basename, tildePath } from "../lib/format";
import { tr } from "../lib/i18n";
import { markVeilsSeeded } from "../lib/veil";
import type { Mood } from "../mascot/geometry";
import { Pip } from "../mascot/Pip";
import {
  activeAgent,
  chooseWorkspace,
  composerAttachments,
  composerDraft,
  conversationKey,
  currentActivity,
  currentDaemonSession,
  headingDaemonSession,
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
  sendAnchorTick,
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
import { DURATION, EASING, enterStagger, keepLast, markRowsSeen, popupHiddenStyle, popupLeavingStyle, popupStyle, PATIENCE_MS, Presence, SPRING } from "../ui/motion";
import { RollingText } from "../ui/RollingText";
import { tip } from "../ui/Tip";
import { FOCUS_RING, GLASS_REGULAR, POPUP, PRESS, PRESS_SCALE } from "../ui/styles";
import { Composer } from "./Composer";
import { hasInlinePrompt } from "./ExtensionDialog";
import { proseRows } from "./Prose";
import {
  type ChatRow,
  enterConversation,
  foldOwedTurns,
  isTurnClosing,
  onFoldSettled,
  onFoldToggle,
  replyActions,
  setProcessTurns,
  trackFoldState,
  TranscriptRow,
  turnChoice,
  turnDefault,
  turnSay,
} from "./Rows";
import { HEADER_BAND, HeaderBand, PaneVeil } from "./Wallpaper";
import { buildDisplayRows, displayRowIds, stableDisplayRows } from "../pi/turns";

/** Whether the displayed conversation is actively running. */
function isChatActive() {
  return isRunning() || waitingCount() > 0;
}

/** What the run is doing, in a word or two. */
function activityLabel() {
  const dialog = pendingDialog();
  if (dialog) return tr("Waiting for confirmation", "等待确认");
  // A blocked session is waiting before its dialog replay lands: the daemon's
  // word is earlier than the attach's, and "thinking" would be a lie it tells.
  if ((headingDaemonSession() ?? currentDaemonSession())?.status === "blocked") return tr("Waiting for confirmation", "等待确认");
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
function ActivityLine(props: { anchor?: (node: ViewRef | undefined) => void }) {
  const alreadyWorking = untracked(() => (isChatActive() || pipMood() === "happy") && transcriptRows().some((row) => row.kind !== "user"));
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
          void opacity.keyframes([0, 1], { duration: 160, delay: 45, easing: EASING.out });
          void translateY.spring(0, SPRING.snappy);
        } else {
          void opacity.timing(1, { duration: 160, easing: "easeOut" });
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
function Stage(props: { title: string | (() => string); detail?: string; size?: number; around?: boolean; mood?: () => Mood; children?: JSX.Element }) {
  const titleText = () => (typeof props.title === "function" ? props.title() : props.title);
  const mood = () => (props.mood ? props.mood() : pipMood());
  const pip = (
    <View style={enterStagger(0)}>
      <Pip size={props.size ?? 96} mood={mood()} />
    </View>
  );
  const words = (
    <View class="max-w-110 items-center gap-1.5" style={enterStagger(1)}>
      <Text class="text-center text-2xl font-semibold tracking-tight text-foreground" role="header">
        {titleText()}
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
            wallpaper() ? "rounded-full border-[0.5px] border-hairline bg-card/65 pl-3 pr-2.5 hover:bg-card/85 dark:bg-card/58 dark:hover:bg-card/75" : "rounded-md corner-squircle px-1.5 hover:bg-accent"
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
              class={`min-h-9 flex-row items-center gap-2.5 rounded-md corner-squircle px-2 py-1 ${PRESS} hover:bg-accent focus:bg-accent active:bg-accent`}
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
        class={`mt-1 min-h-9 flex-row items-center gap-2.5 rounded-md corner-squircle px-2 py-1 ${PRESS} hover:bg-accent focus:bg-accent active:bg-accent`}
      >
        <Icon name="folderPlus" size={15} tone="muted-foreground" />
        <Text class="flex-1 truncate text-base text-foreground">{tr("Add Project Folder…", "添加项目文件夹…")}</Text>
      </BaseButton>
    </Popover>
  );
}

/**
 * The centered hero stage shared across `"starting"` and `"welcome"` so Pip and
 * the stage wrapper stay mounted when the CLI finishes waking up instead of
 * unmounting and replaying `enterStagger` (which flickers the whole center).
 */
function HeroStage(props: { mode: () => "welcome" | "starting"; fading?: () => boolean }) {
  const agentName = () => activeAgent().name;
  const slow = signal(false);
  let lastMood: Mood = untracked(pipMood);
  const stageMood = (): Mood => {
    if (props.fading?.()) return lastMood;
    lastMood = pipMood();
    return lastMood;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  effect(() => {
    const starting = props.mode() === "starting";
    clearTimeout(timer);
    if (!starting) {
      slow.set(false);
      return;
    }
    timer = setTimeout(() => slow.set(true), SLOW_WAKE_MS);
  });
  cleanup(() => clearTimeout(timer));
  const title = () =>
    props.mode() === "starting"
      ? tr(`Waking ${agentName()}…`, `正在唤醒 ${agentName()}…`)
      : tr("What are we building?", "今天要构建什么？");
  return (
    <Stage around title={title} mood={stageMood}>
      <If
        when={props.mode() === "welcome"}
        else={
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
        }
      >
        <If when={workspacePath()}>
          <WelcomeProject />
        </If>
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
      <View class="max-h-48 w-full max-w-130 overflow-hidden rounded-lg corner-squircle border border-border bg-sunken p-3" selectable>
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
 * reader who scrolls back down re-attaches from within it too — a moving end can never be landed on exactly,
 * and the pill would hide at this distance anyway. */
const FOLLOW_THRESHOLD = 72;

/** How long (ms) after a scroll gesture of the reader's begins its scroll events are read as theirs. */
const INPUT_WINDOW_MS = 1500;

/** After the reader releases the view, how long (ms) a move towards the end is not read as theirs: the list settles its layout once as it is released. */
const RELEASE_SETTLE_MS = 300;

/** How far under the title bar's band a sent prompt rests once its send anchors it there (zeron's own-send inset: the chrome plus the first row's air). */
const OWN_SEND_TOP_GAP = 10;
/** How long (ms) a send's entry glide gets to land before the hold re-asserts the prompt's place absolutely. */
const OWN_SEND_GLIDE_MS = 380;
/** How quiet (ms) the offset must be after the glide's window to call the flight landed: re-asking sooner — animated or not — restarts or snaps the stretch still arriving. */
const OWN_SEND_QUIET_MS = 50;
/** The longest (ms) the landing wait runs before the pin takes over wherever the flight got to. */
const OWN_SEND_LAND_MS = 900;
/** The longest (ms) a settled hold's glide back to the end may take before the reservation is dropped anyway — a list that reports no passes lands the same way, only later. */
const OWN_SEND_RETURN_MS = 900;

/** How long (ms) a selection drag that has left the pane goes on scrolling after the selection last grew: the button going up out there is not heard. */
const EDGE_BEAT_MS = 250;

/**
 * The foot of the conversation, measured up from the pane's lower edge. What stands there is the composer's
 * figure as laid out (`figure`, its height): 20 under the composer, the composer, whatever stands on it — the
 * attachments, a long draft, an inline prompt — and 12 over that. At rest that is 124 (a 92pt composer), its
 * top edge at 112; the edge is wherever the figure puts it, and what meets it is placed from it, so the three
 * move together and nothing the composer grows by covers the reply:
 * - `end`: the conversation ends 16 above the edge, a container's pad. The activity line's 36pt slot is the last
 *   thing in it, so a reply at rest stands 52 clear of the composer and Pip, working, about 20.
 * - "Jump to latest" stands on that same line.
 * - `fade`: rows fade out as they pass under that edge.
 */
const FIGURE_REST = 124;
const HEAD_FADE = 24;
const MASK_STEPS = 6;
const smoothMask = (t: number) => t * t * (3 - 2 * t);

function maskRamp(from: number, to: number, start: number, end: number): string[] {
  const stops: string[] = [];
  for (let i = 0; i <= MASK_STEPS; i++) {
    const t = i / MASK_STEPS;
    const at = Math.round((start + (end - start) * t) * 10) / 10;
    const a = Math.round(Math.max(0, Math.min(1, from + (to - from) * smoothMask(t))) * 255)
      .toString(16)
      .padStart(2, "0");
    // A mask channel only: the alpha carries the fade, the color is never seen.
    stops.push(`#000000${a} ${at}px`);
  }
  return stops;
}

function footOf(figure: number) {
  const edge = (figure || FIGURE_REST) - 12;
  return { edge, end: edge + 16 };
}

/**
 * One top-to-bottom mask (`maskImage` takes a single gradient) fading rows out
 * at both ends of what can be read:
 * - Above: without a wallpaper the title bar's own glass blurs rows behind it,
 *   so the fade runs inside the bar (`top - HEAD_FADE` → `top`) right up to its
 *   hairline; over a wallpaper the title bar has no band of its own, so the
 *   bar's whole height stays transparent (`0` → `top`) and rows fade in below
 *   it (`top` → `top + HEAD_FADE`), never crossing the title text.
 * - Below: rows fade out as they pass under the composer's top `edge`.
 */
function transcriptMask(height: number, top: number, edge: number, overWallpaper: boolean): string {
  const headStart = overWallpaper ? Math.max(0, top - 4) : Math.max(0, top - HEAD_FADE);
  const headEnd = overWallpaper ? top + HEAD_FADE : top;
  const stops = maskRamp(0, 1, headStart, headEnd);
  if (height > headEnd + edge + 24) {
    const footStart = height - (edge + 20);
    const footEnd = height - Math.max(16, edge);
    stops.push(...maskRamp(1, 0, footStart, Math.max(footStart + 1, footEnd)));
  }
  return `linear-gradient(to bottom, ${stops.join(", ")})`;
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

/**
 * A floating bubble at the pane's top-right, on the line a sent prompt lands:
 * the reader's own last question, in its own words and in the user bubble's own
 * shape, while that question is out of view — above the top as its reply runs
 * on, or below the bottom while older history is being read. Pressing it lands
 * the view back on the prompt.
 */
function PromptJumpPill(props: {
  visible: boolean;
  prompt: () => { index: number; text: string; images: number; below: boolean } | undefined;
  top: number;
  onPress: () => void;
}) {
  // `Presence` is the standard indicator show/hide; `keepLast` holds the
  // prompt's words through the exit fade instead of blanking its first frame.
  const prompt = keepLast(props.prompt);
  const text = () => (prompt()?.text ?? "").replace(/\s*\n\s*/g, " ").replace(/\s+/g, " ").trim();
  const images = () => prompt()?.images ?? 0;
  const below = () => prompt()?.below ?? false;
  return (
    <View class="pointer-events-none absolute inset-x-0 z-10 items-end pr-4" style={{ top: props.top }}>
      <Presence show={props.visible}>
        <BaseButton
          onPress={props.onPress}
          accessibilityLabel={below() ? tr("Forward to the last prompt", "前往最后一条提问") : tr("Back to the prompt", "回到上一条提问")}
          tooltip={tip(tr("Back to the prompt that produced this", "回到产生此内容的提问"), undefined, "left")}
          class={`pointer-events-auto h-7 max-w-44 flex-row items-center gap-1.5 rounded-2xl rounded-br-md px-3 ${POPUP} ${PRESS} ${PRESS_SCALE} ${FOCUS_RING} hover:bg-muted/80 active:bg-muted`}
          style={GLASS_REGULAR}
        >
          <View class={below() ? "rotate-180" : undefined}>
            <Icon name="arrowUp" size={12} tone="muted-foreground" />
          </View>
          <If when={text()}>
            <Text class="min-w-0 shrink truncate text-xs text-foreground">{text()}</Text>
          </If>
          <If when={!text() && images() > 0}>
            <Icon name="image" size={12} tone="muted-foreground" />
            <Text class="text-xs text-foreground">{tr(images() === 1 ? "1 image" : `${images()} images`, `${images()} 张图片`)}</Text>
          </If>
        </BaseButton>
      </Presence>
    </View>
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
  /** The rows at the viewport's top and bottom: the range the prompt bubble
   * reads the last prompt against. `onViewableItemsChange` feeds both where the
   * platform reports; the scroll passes measure the top (`measureTop`), which
   * every platform answers, and the bottom follows from the last reported span —
   * without a span only the top is certain and the below-view case stays dark. */
  const topRow = signal(-1);
  const bottomRow = signal(-1);
  /** Rows a screen held at the last full viewable report: `measureTop`'s estimate of the bottom when only the top is measured. */
  let viewSpan = -1;
  let measuringTop = false;
  const measureTop = () => {
    if (measuringTop) return;
    const target = list;
    if (!target) return;
    measuringTop = true;
    void target.measureScrollPosition().then((at) => {
      measuringTop = false;
      if (list === target && at) {
        topRow.set(at.index);
        bottomRow.set(viewSpan < 0 ? -1 : at.index + viewSpan);
      }
    });
  };
  /** When the reader last began a scroll gesture. */
  let inputAt = 0;
  let releasedAt = 0;
  let lastY: number | undefined;
  /** When the offset last actually moved: the send's anchor reads it to know its glide has landed before pinning. */
  let lastMoveAt = 0;
  let lastDistance = 0;
  let lastViewportH = 0;
  /**
   * A send's own-turn anchor (zeron's send): its bubble glides to the top of the
   * view and the view holds it there while the reply fills the runway reserved
   * under it — the bubble never rides a folding turn or a growing stream. A
   * scroll gesture of the reader's releases the hold; a filled runway hands the
   * view back to the end-follow.
   */
  /**
   * `glideUntil`: the entry glide's retarget window. `seatBy`: how long its last
   * flight may take to land before the pin takes over anyway; `seated`: it has.
   * `askedIx`: the index the flying retarget was aimed at — only a new one is
   * worth restarting the flight.
   */
  let ownSend: { id: string; glideUntil: number; seatBy: number; seated: boolean; askedIx?: number } | undefined;
  /** Scrollable room reserved under the anchored prompt (extra bottom pad): what lets it reach the top. It goes once the reply fills the view or the hold ends. */
  const runway = signal(0);
  /** Set while the anchor owns the view: the end-pin, the jump pill and the end-settle stay out of its way. */
  const ownHold = signal(false);
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
  let shownKey = -1;
  const displayRows = computed<ChatRow[]>(() => {
    if (isLeavingSession() && shown.length > 0) return shown;
    const key = conversationKey();
    trackFoldState();
    const processOf = new Map<string, string>();
    const projected = buildDisplayRows(
      transcriptRows(),
      isChatActive(),
      {
        chosen: turnChoice,
        said: turnSay,
        // Under a send's hold the fold asks whether the reader is still watching under it:
        // they are — an end under their prompt folds before them; they pressed into a
        // process or scrolled — it is owed to them still, whatever the anchor pins.
        byDefault: (id, working, hasDetails) => turnDefault(id, working, untracked(following) || ownHold(), hasDetails),
        keepMounted: isTurnClosing,
      },
      processOf,
    );
    // The send's hold counts as watching the end: the reader is shown the turn they
    // sent from, so a turn that ends under it folds before them as it would were they following.
    const watching = following() || ownHold();
    const rows = (watching ? stable(projected) : projected).flatMap((row): ChatRow[] =>
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
    if (key === shownKey && watching && rows.length === shown.length && rows.every((row, at) => row === shown[at])) return shown;
    shownKey = key;
    shown = rows;
    return rows;
  });

  /**
   * The last prompt sent, while it is out of view — the bubble's only subject.
   * Above the viewport's top while its reply is being read, or below the bottom
   * while older history is being read (`below`): either way the reader's own
   * question has scrolled off and the bubble offers the way back to it. Prompts
   * passed on the way are never named. The send's anchor is already that prompt
   * pinned at the top, so while it holds the bubble is out of the way.
   */
  const promptAway = computed(() => {
    if (ownHold()) return undefined;
    // A reserve draining under an end-held view is the anchor still settling,
    // not the reader having scrolled off: nothing to offer the way back from.
    if (following() && runway() > 0) return undefined;
    const top = topRow();
    if (top < 0) return undefined;
    const rows = displayRows();
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      if (row.kind !== "user") continue;
      if (i < top) return { index: i, text: row.text, images: row.images, below: false };
      const bottom = bottomRow();
      // Below is only real where the scroll says the view left the end: a stale
      // range report (a `viewSpan` measured on other rows) can put the last rows
      // out of view while the offset still sits on the end.
      if (bottom >= 0 && i > bottom && distanceFromEnd() > FOLLOW_THRESHOLD) return { index: i, text: row.text, images: row.images, below: true };
      return undefined;
    }
    return undefined;
  });

  /** Back to that prompt: it lands where a sent prompt rests, just under the title bar. */
  const jumpToPrompt = () => {
    const target = untracked(promptAway);
    if (!target) return;
    releaseOwnSend();
    inputAt = Date.now();
    releasedAt = Date.now();
    following.set(false);
    list?.scrollToIndex({ index: target.index, viewPosition: 0, viewOffset: ownSendInset(), animated: !untracked(reduceMotion) });
  };

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
  const viewHeight = signal(0);
  /** The composer's figure as laid out: the composer and what stands on it. The conversation's foot is placed from it (`footOf`). */
  const figure = signal(0);
  let heroFigure = 0;
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
      // Sending a multi-line draft or attachment from Welcome clears the composer in the same frame it docks:
      // compensate `stand` by the composer's height drop so `bottom-full` hero content stays pinned while fading out.
      const shrink = !middle && heroFigure > FIGURE_REST && !composerDraft() && !composerAttachments().length ? heroFigure - FIGURE_REST : 0;
      travel = undefined;
      // Up: the stage is where it will be, and the composer comes to it. Down: it stays where it was.
      stand.set(middle ? 0 : -(way + shrink));
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

  /** Where the anchored prompt rests: just under the title bar's band, like zeron's `OWN_SEND_TOP_INSET_PX`. */
  const ownSendInset = () => untracked(topBarHeight) + OWN_SEND_TOP_GAP;

  /**
   * The return glide of a hold that ended short of a filled runway: the end
   * the content will have once the reservation goes. The reservation is what
   * let the pin stand there, so it stays until the glide lands — dropped
   * first, the list would clamp the held offset at once and the prompt would
   * snap back instead of settling.
   */
  let runwayLanding: { target: number } | undefined;

  /** The anchor's pin ends: the hold is lifted but the reservation stays — it is the reader's to scroll through now. */
  const releasePin = () => {
    ownSend = undefined;
    ownHold.set(false);
  };

  /** The anchor ends: pin, hold and reservation gone at once — only where no view stands on the reservation (a conversation change remounts the list whole). */
  const dropOwnSend = () => {
    releasePin();
    runway.set(0);
    runwayLanding = undefined;
    if (runwayDrain !== undefined) {
      cancelAnimationFrame(runwayDrain);
      runwayDrain = undefined;
    }
  };

  /**
   * The reservation is a consumable scroll room, never dropped while the view
   * can see it — removing scrollable space under the offset clamps the list and
   * snaps every row down. While released it is spent by the reader's own scroll
   * (`onScroll`): out of sight it goes whole, under the view it keeps just the
   * stretch they are inside, and at the end it drains away (`drainRunway`).
   */
  let runwayDrain: number | undefined;
  const drainRunway = () => {
    if (runwayDrain !== undefined) return;
    const tick = () => {
      runwayDrain = undefined;
      if (ownSend || runwayLanding || !untracked(following)) return;
      const room = untracked(runway);
      if (room <= 0) return;
      const next = room - Math.max(18, room * 0.18);
      runway.set(next <= 2 ? 0 : next);
      if (next > 2) runwayDrain = requestAnimationFrame(tick);
    };
    runwayDrain = requestAnimationFrame(tick);
  };

  /** A scroll gesture of the reader's, or their press into what they were reading: the anchor's word is spent — the reservation is theirs, to be consumed. */
  const releaseOwnSend = () => {
    if (!ownSend && !runwayLanding) return;
    releasePin();
    runwayLanding = undefined;
  };

  /**
   * One layout pass of the anchor's pin, fed by the list's own scroll reports.
   *
   * The entry glide is re-asked only when the prompt's index has moved (a fold
   * taking rows away above it): every animated re-ask starts the native flight
   * over, so asking per report kept it restarting and arriving after the
   * window — the pin then snapped its last stretch into a jump. Untouched, one
   * flight lands it whole. After the window the last flight is given a beat of
   * quiet to land (`seatBy` the cap), and only then does the pin assert the
   * prompt's place absolutely (`scrollToIndex` resolves the row wherever folds
   * and growth move it).
   */
  const ownSendStep = () => {
    const o = ownSend;
    if (!o) return;
    const ix = untracked(displayRows).findIndex((row) => row.id === o.id);
    if (ix < 0) return settleOwnSend(false);
    const now = Date.now();
    if (now < o.glideUntil) {
      if (ix !== o.askedIx) {
        o.askedIx = ix;
        list?.scrollToIndex({ index: ix, viewPosition: 0, viewOffset: ownSendInset(), animated: true });
      }
      return;
    }
    if (!o.seated) {
      if (now - lastMoveAt < OWN_SEND_QUIET_MS && now < o.seatBy) return;
      o.seated = true;
    }
    list?.scrollToIndex({ index: ix, viewPosition: 0, viewOffset: ownSendInset(), animated: false });
  };

  /**
   * The anchor's natural end. A filled runway hands off where it stands — the
   * end is already in view, so the reservation can go at once. A hold ending
   * short of it — the run over, the bubble gone — leaves the prompt somewhere
   * the content cannot keep without the reservation, so the view first glides
   * to the end it will have, and the pad goes when the glide lands (or when a
   * quiet list has had long enough to land it): the return settles, it never
   * snaps back.
   */
  const settleOwnSend = (filled: boolean) => {
    releasePin();
    following.set(true);
    if (filled || untracked(reduceMotion) || !list) {
      runway.set(0);
      runwayLanding = undefined;
      scheduleEndSettle(2);
      return;
    }
    endSettlePasses = 0;
    if (untracked(isChatActive)) {
      // Work is still landing under the prompt: the reserve stays until the
      // end's own passes consume it — it is never dropped from under a view
      // that can see it.
      scheduleEndSettle(2);
      drainRunway();
      return;
    }
    const landing = (runwayLanding = { target: Math.max(0, lastMax - untracked(runway)) });
    list.scrollTo({ y: landing.target, animated: true });
    setTimeout(() => {
      if (runwayLanding !== landing) return;
      runwayLanding = undefined;
      runway.set(0);
      scheduleEndSettle(1);
    }, OWN_SEND_RETURN_MS);
  };

  const onScroll = (e: ScrollEvent) => {
    const y = e.offset.y;
    const distance = e.contentSize.height - (y + e.size.height);
    // The return glide has landed where the end will be: the reservation goes now.
    if (runwayLanding && y <= runwayLanding.target + 0.5) {
      runwayLanding = undefined;
      runway.set(0);
      scheduleEndSettle(1);
    }
    if (ownSend) {
      // A scroll of the reader's inside the input window ends the hold (theirs wins);
      // the layout's own passes — the glide's, the fold's, the reply's — feed its step.
      // Only the held phase checks drift: the glide's own frames move the offset legitimately.
      if (lastY !== undefined && Date.now() >= ownSend.glideUntil && Date.now() - inputAt < INPUT_WINDOW_MS && Math.abs(y - lastY) > 0.5) releaseOwnSend();
      ownSendStep();
    }
    distanceFromEnd.set(distance);
    // The list reports its own layout passes too (a row measured, the fold
    // closing): only a move within a gesture of the reader's is theirs. Up and
    // away from the end releases; back down to within the threshold follows again.
    if (lastY !== undefined && Date.now() - inputAt < INPUT_WINDOW_MS) {
      if (following() && y < lastY - 0.5 && distance > Math.max(lastDistance, 0) + 0.5) {
        following.set(false);
        releasedAt = Date.now();
      } else if (!following() && y > lastY + 0.5 && distance <= FOLLOW_THRESHOLD && Date.now() - releasedAt > RELEASE_SETTLE_MS) {
        follow(!reduceMotion() && !isChatActive());
      }
    }
    if (lastY === undefined || Math.abs(y - lastY) > 0.5) lastMoveAt = Date.now();
    lastY = y;
    lastDistance = distance;
    lastViewportH = e.size.height;
    lastMax = e.contentSize.height - e.size.height;
    // A released reservation is spent here, as the reader's scroll reaches it:
    // none of it on screen — it goes whole; the reader inside it — it is their
    // scroll room, spent by travelling; at the end — it drains away under the
    // view. It is never dropped while they can see it: losing scrollable room
    // under the offset clamps the list and snaps every row down.
    const room = untracked(runway);
    if (room > 0 && !ownSend && !runwayLanding) {
      if (distance >= room - 0.5) runway.set(0);
      else if (following()) drainRunway();
    }
    // A scroll asked while its commit settled is re-asked as the list reports
    // its passes — each lands on the end the layout now says. A gesture of the
    // reader's ends it: theirs wins.
    if (endSettlePasses > 0) {
      endSettlePasses--;
      if (following() && Date.now() - inputAt > INPUT_WINDOW_MS && Math.abs(distance) > 1) {
        list?.scrollTo({ y: Math.max(0, e.contentSize.height - e.size.height), animated: false });
      }
    }
    measureTop();
  };
  const onInput = () => {
    inputAt = Date.now();
    // A gesture beginning is the reader's say on the view: the hold ends where it is.
    releaseOwnSend();
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
    const top = untracked(topBarHeight);
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
    const pad = untracked(foot).end + untracked(runway);
    void Promise.all([list?.measure(), ending?.measure()]).then(([frame, end]) => {
      // Rows far from the end are not mounted: the distance the scroll reported stands.
      if (!frame || !end || untracked(following)) return;
      distanceFromEnd.set(end.pagePosition.y + end.bounds.size.height + pad - (frame.pagePosition.y + frame.bounds.size.height));
    });
  };
  effect(() => {
    displayRows();
    foot();
    untracked(() => {
      measureEnd();
      // Rows can change what the top row is without a scroll (a fold closing
      // above a held view, history landing): measure keeps the bubble aimed.
      measureTop();
    });
  });

  /**
   * Whether the reply has reached the end of the view and filled the runway —
   * measured the same way `measureEnd` finds the end, since scroll reports alone
   * cannot say how the stream grew (a list that reports no passes still has its
   * measures). Filled: the hold hands the view back to the end-follow.
   */
  effect(() => {
    displayRows();
    untracked(() => {
      const o = ownSend;
      if (!o || !list || !ending || Date.now() < o.glideUntil) return;
      if (untracked(displayRows).findIndex((row) => row.id === o.id) < 0) return settleOwnSend(false);
      void Promise.all([list.measure(), ending.measure()]).then(([frame, end]) => {
        if (!frame || !end || ownSend !== o) return;
        const filled = end.pagePosition.y + end.bounds.size.height + untracked(foot).end >= frame.pagePosition.y + frame.bounds.size.height - 1;
        if (filled) settleOwnSend(true);
      });
    });
  });

  // The run a send anchored is over — nothing more fills the room the pin
  // reserved: the hold hands the view back to the end. A timed cap once did
  // this instead, cutting live runs short and snapping the prompt back.
  effect(() => {
    const running = isRunning();
    untracked(() => {
      if (!running && ownSend) settleOwnSend(false);
    });
  });

  let listKey = -1;
  let listReady = false;
  let scrollArmed = false;
  // Defer imperative un-animated end-scrolls until this turn's layout pass has
  // settled (`targetList.measure()`), and measure the exact remaining gap to the
  // footer anchor so a shrinking composer or unmeasured bubble never overshoots
  // `maxScroll` into a 1-frame blank band before clamping back.
  let endSettlePasses = 0;
  let endSettleEpoch = 0;
  const scheduleEndSettle = (passes = 2) => {
    const epoch = ++endSettleEpoch;
    const expectedKey = untracked(conversationKey);
    const targetList = list;
    if (!targetList || listKey !== expectedKey || !listReady) return;
    endSettlePasses = passes;
    void Promise.all([targetList.measure(), ending?.measure()]).then(([frame, end]) => {
      if (epoch !== endSettleEpoch) return;
      if (!untracked(following) || Date.now() - inputAt <= INPUT_WINDOW_MS) return;
      if (!frame || list !== targetList || listKey !== expectedKey || !listReady) return;
      const pad = untracked(foot).end + untracked(runway);
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
      targetList.scrollTo({ y: 1e7, animated: false });
    });
  };

  const follow = (animated: boolean) => {
    releaseOwnSend();
    inputAt = 0;
    following.set(true);
    if (animated) list?.scrollToEnd({ animated: true });
    else scheduleEndSettle(2);
    // Already at the end reports no scroll pass: the reserve left over drains here.
    if (untracked(runway) > 0) drainRunway();
  };

  // A fold the reader presses grows or shrinks the rows under it, not those above: let go of the end.
  onFoldToggle(() => {
    pokeRepaint();
    // Pressing into a turn is the reader elsewhere: the send's anchor is spent too.
    releaseOwnSend();
    if (!untracked(following)) return;
    following.set(false);
    releasedAt = Date.now();
  });
  onFoldSettled(() => {
    pokeRepaint();
    measureEnd();
  });
  // A turn that ended while the reader was reading elsewhere kept its process open for them. Following
  // again — back at the end, the pill, a message sent — they are done there: it folds as it would have.
  effect(() => {
    // Owed folds run under the send's hold too: the anchor keeps the prompt where it
    // is while the turn above it folds, which is what the hold is for.
    if (following() || ownHold()) untracked(foldOwedTurns);
  });

  // A reply still growing moves the end under an animated scroll: go there at once.
  const jumpToLatest = () => follow(!reduceMotion() && !isChatActive());

  effect(() => {
    scrollToEndTick();
    if (!scrollArmed) {
      scrollArmed = true;
      return;
    }
    untracked(() => {
      if (ownHold()) return;
      inputAt = 0;
      following.set(true);
      // A conversation mounting a fresh `<List>` in this turn opens at its end natively via
      // `initialScrollAtEnd` (before its first frame, following while rows measure); calling
      // `scrollTo` during that synchronous swap would hit the outgoing list or cancel the pass.
      if (list && listKey === conversationKey() && listReady) {
        scheduleEndSettle(3);
      }
    });
  });
  // A send that begins a fresh run anchors on its bubble instead of riding the
  // end: the prompt glides under the title bar's edge and holds there while the
  // reply fills the runway reserved below it — the zeron send. What the reader
  // sent never slides under a folding turn or a stream's own growth.
  let pendingAnchor: string | undefined;
  const tryInstallAnchor = () => {
    const id = pendingAnchor;
    if (!id || !list || !listReady || untracked(screen) !== "transcript") return;
    // A run already over holds nothing: the bubble rests where it landed.
    if (!untracked(isRunning)) {
      pendingAnchor = undefined;
      return;
    }
    const ix = untracked(displayRows).findIndex((row) => row.id === id);
    if (ix < 0) return;
    pendingAnchor = undefined;
    inputAt = 0;
    const reduced = untracked(reduceMotion);
    const glideUntil = Date.now() + (reduced ? 0 : OWN_SEND_GLIDE_MS);
    ownSend = { id, glideUntil, seatBy: glideUntil + OWN_SEND_LAND_MS, seated: reduced, askedIx: ix };
    lastMoveAt = Date.now();
    ownHold.set(true);
    following.set(false);
    // Sending is moving on: ends owed to the reader fold now, under the pin.
    untracked(foldOwedTurns);
    // The runway is the room the prompt needs to reach the top: a viewport of
    // scrollable space under it, kept until the reply fills the view.
    runway.set(lastViewportH || untracked(viewHeight) || 600);
    list.scrollToIndex({ index: ix, viewPosition: 0, viewOffset: ownSendInset(), animated: !reduced });
  };
  effect(() => {
    const cue = sendAnchorTick();
    untracked(() => {
      if (!cue) return;
      pendingAnchor = cue.rowId;
      // The cue lands the same turn the bubble does — a welcome send's list is
      // still mounting, so the install retries over the next passes too.
      tryInstallAnchor();
      setTimeout(tryInstallAnchor, 0);
      setTimeout(tryInstallAnchor, 80);
    });
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
  // The foot rising moves the end up with it — attachments, a draft growing, an inline prompt — and the list
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
    else scheduleEndSettle(2);
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
  let landedArmed = false;
  effect(() => {
    sessionLandedTick();
    if (!landedArmed) {
      landedArmed = true;
      return;
    }
    untracked(() => {
      pokeRepaint();
      if (following() && list && listKey === conversationKey() && listReady) {
        scheduleEndSettle(2);
      }
    });
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
        // Only snap to 0 and fade in when the pane was actually dimmed by a
        // leaving animation. For sessions shown immediately (visited cache or
        // welcome), the pane is already at 1 — snapping it to 0 first causes
        // a visible flash/flicker before fading back in.
        if (dimmed) {
          void pane.timing(1, { duration: ARRIVE_MS, easing: EASING.out });
        } else {
          pane.set(1);
        }
      }
      dimmed = false;
    });
  });
  cleanup(() => void pane.stop());

  // Another conversation's rows are other rows: what was in motion there is not
  // here, and the rows landing were already on screen, so none of them enters again.
  // The key is the rows' own (`conversationKey`), not the agent's session: it changes
  // with the rows, and not when the same conversation is only loaded again.
  // Only the conversation changing runs this. What it reads on the way — the
  // rows — is not what it waits for: tracked, every delta of a reply would
  // follow again and take the view back from a reader who scrolled up.
  effect(() => {
    const key = conversationKey();
    untracked(() => {
      inputAt = 0;
      lastY = undefined;
      selected = "";
      endSettleEpoch++;
      endSettlePasses = 0;
      endSelecting();
      pendingAnchor = undefined;
      dropOwnSend();
      following.set(true);
      distanceFromEnd.set(0);
      topRow.set(-1);
      bottomRow.set(-1);
      viewSpan = -1;
      enterConversation(key);
      const seenIds = displayRowIds(transcriptRows());
      markRowsSeen(seenIds);
      markVeilsSeeded(seenIds);
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
            style={{ maskImage: transcriptMask(viewHeight(), topBarHeight(), foot().edge, Boolean(wallpaper()) && !HEADER_BAND) }}
          >
            <Each of={[conversationKey()]} key={(k) => k}>
              {(key) => {
                const currentKey = untracked(key);
                let mountedList: ListRef | undefined;
                let mountedEnding: ViewRef | undefined;
                listKey = currentKey;
                listReady = false;
                queueMicrotask(() => {
                  if (listKey === currentKey) listReady = true;
                });
                cleanup(() => {
                  if (listKey === currentKey) {
                    listKey = -1;
                    listReady = false;
                  }
                });
                return (
                  <List
                    ref={(node) => {
                      if (node) list = mountedList = node;
                      else if (list === mountedList) list = undefined;
                    }}
                    each={displayRows()}
                    initialScrollAtEnd
                    estimatedItemSize={44}
                    keyExtractor={(row) => row.id}
                    onScroll={onScroll}
                    scrollEventThrottle={16}
                    onScrollDragStart={onInput}
                    onMomentumStart={onInput}
                    onViewableItemsChange={(info) => {
                      const items = info.viewableItems;
                      const first = items[0]?.index ?? -1;
                      const last = items[items.length - 1]?.index ?? -1;
                      topRow.set(first);
                      bottomRow.set(last);
                      if (first >= 0 && last >= first) viewSpan = last - first;
                    }}
                    maintainVisibleContentPosition={following() ? { autoscrollToBottomThreshold: FOLLOW_THRESHOLD } : undefined}
                    class="flex-1"
                    contentStyle={{
                      paddingHorizontal: 24,
                      paddingTop: topBarHeight() + (wallpaper() && !HEADER_BAND ? HEAD_FADE : 12),
                      paddingBottom: foot().end + runway(),
                    }}
                    accessibilityLabel={tr("Conversation", "对话")}
                    footer={
                      <ActivityLine
                        anchor={(node) => {
                          if (node) ending = mountedEnding = node;
                          else if (ending === mountedEnding) ending = undefined;
                        }}
                      />
                    }
                  >
                    {(row) => <TranscriptRow row={row()} />}
                  </List>
                );
              }}
            </Each>
          </View>
          <ScrollToBottomPill visible={!following() && !ownHold() && distanceFromEnd() > FOLLOW_THRESHOLD} bottom={foot().end} onPress={jumpToLatest} />
          <PromptJumpPill visible={promptAway() !== undefined} prompt={promptAway} top={ownSendInset()} onPress={jumpToPrompt} />
        </If>
        <If when={screen() === "connect"}>
          <Connect />
        </If>
        <If when={screen() === "failed"}>
          <Failure title={failure().title} detail={failure().detail} />
        </If>
      </View>
      <Waiting show={isLeavingSession() && !hero()} />
      <HeaderBand show={screen() === "transcript"} height={topBarHeight()} />
      {/* The composer's column: the spacers over and under it are where it stands (`hero`). */}
      <View
        class="pointer-events-none absolute inset-0 z-10"
        onLayout={(e) => {
          paneHeight = e.bounds.size.height;
          viewHeight.set(Math.round(e.bounds.size.height));
        }}
      >
        <View style={{ flexGrow: hero() ? HERO.rise : 1, flexShrink: 1, flexBasis: hero() ? HERO.head : 0 }} />
        <View
          class="relative"
          style={{ transform: [{ translateY: slide }] }}
          onLayout={(e) => {
            const h = Math.round(e.bounds.size.height);
            figure.set(h);
            if (untracked(hero)) heroFigure = h;
          }}
        >
          <View class="absolute inset-0" style={{ transform: [{ translateY: Animated.subtract(stand, slide) }] }}>
            <If when={stage() !== undefined}>
              {/* The stage is the pane's content: it dims and lands with it, and fades on its own once the composer has left it. */}
              <View class="absolute inset-0" style={{ opacity: hero() ? pane : stageFade }}>
                <If when={stage() === "welcome" || stage() === "starting"}>
                  <HeroStage mode={() => (stage() === "starting" ? "starting" : "welcome")} fading={() => !hero()} />
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
