import { Animated, cleanup, computed, createAnimatedValue, effect, List, reduceMotion, Scroll, signal, Text, untracked, View } from "nsh";
import type { JSX, ListRef, MouseEvent, ScrollEvent, ViewRef, WheelEvent } from "nsh";
import { Button as BaseButton, Popover } from "nsh/base";
import { edgeStep, edgeTarget } from "../lib/edge-scroll";
import { topBarHeight } from "../lib/layout";
import { basename, tildePath } from "../lib/format";
import { activeLanguage, tr } from "../lib/i18n";
import { markPacersSeeded } from "../lib/stream-pacer";
import { markVeilsSeeded } from "../lib/veil";
import type { Mood } from "../mascot/geometry";
import { Pip } from "../mascot/Pip";
import {
  activeAgent,
  attachLocalPath,
  chooseWorkspace,
  composerAttachments,
  composerDocs,
  composerDraft,
  composerFiles,
  conversationKey,
  currentActivity,
  currentDaemonSession,
  headingDaemonSession,
  hasModel,
  isChatFolder,
  isDraftAhead,
  isLeavingSession,
  isPersonaSession,
  isRunning,
  isSwitching,
  newSession,
  newSessionInWorkspace,
  pendingDialog,
  pipMood,
  placeLabel,
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
import { openNewChatTab } from "../store/tabs";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { DURATION, EASING, enterStagger, keepLast, markRowsSeen, popupHiddenStyle, popupLeavingStyle, popupStyle, PATIENCE_MS, Presence, SPRING } from "../ui/motion";
import { RollingText } from "../ui/RollingText";
import { tip } from "../ui/Tip";
import { FOCUS_RING, GLASS_REGULAR, POPUP, PRESS, PRESS_SCALE } from "../ui/styles";
import { uiHeight, uiMinHeight, uiType } from "../ui/typography";
import { Composer } from "./Composer";
import { hasFormTakeover, hasInlinePrompt } from "./ExtensionDialog";
import { PipWorkingFooter } from "./PipPresence";
import { proseRows } from "./Prose";
import {
  type ChatRow,
  enterConversation,
  heldActions,
  isTurnClosing,
  onFoldSettled,
  onFoldToggle,
  recallingUserSnapshots,
  replyActions,
  setHorizonPrompt,
  setProcessTurns,
  trackFoldState,
  trackRecallingUsers,
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

/**
 * What the run is doing, in a word or two — when no row says it.
 *
 * The conversation says the work where it happens: the turn's header ("Working
 * 12s"), the step under way ("Reading package.json"), the reply as it is
 * written. Pip stands under them and feels it (`pipMood`); words here that
 * restate the row a line above ("Running read" under "Reading package.json")
 * are the same thing said three times, and the one said worst. So once the run
 * has rows of its own on screen (`said`) the line keeps to Pip — and speaks for
 * what no row says: a wait on the reader or on other sessions, a compaction, a
 * retry, and the moment before the run's first row.
 */
function activityLabel(said: boolean) {
  const dialog = pendingDialog();
  if (dialog?.method === "form") return hasFormTakeover() ? "" : tr("Waiting for your answer", "等待你的回答");
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
    case "compacting":
      return tr("Compacting context", "正在压缩上下文");
    case "retrying":
      return activity.maxAttempts > 0
        ? tr(`Retrying (${activity.attempt} of ${activity.maxAttempts})`, `正在重试（${activity.attempt}/${activity.maxAttempts}）`)
        : tr(`Retrying (attempt ${activity.attempt})`, `正在重试（第 ${activity.attempt} 次）`);
    case "writing":
      return said ? "" : tr("Writing", "正在回复");
    case "tool": {
      if (said) return "";
      const oneLine = activity.name.replace(/\s*\n\s*/g, " ; ").replace(/\s+/g, " ").trim();
      return tr(`Running ${oneLine}`, `正在执行 ${oneLine}`);
    }
    default:
      return said ? "" : tr("Thinking", "正在思考");
  }
}

/** The line under the transcript while Pi works: Pip and what it is doing (the turn's header keeps the time).
 * Reserves a constant 36pt (`h-9`) slot so starting, finishing or celebrating a run never
 * shifts the scroll content height or causes a layout jump at the end of a stream.
 * It is the last thing in the list, so where it stands is where the conversation ends (`anchor`). */
function ActivityLine(props: { anchor?: (node: ViewRef | undefined) => void; said: () => boolean; hostedByTurn: () => boolean }) {
  const alreadyWorking = untracked(() => (isChatActive() || pipMood() === "happy") && transcriptRows().some((row) => row.kind !== "user"));
  const shown = signal(alreadyWorking);
  const opacity = createAnimatedValue(alreadyWorking ? 1 : 0);
  const translateY = createAnimatedValue(alreadyWorking ? 0 : 4);
  let exitTimer: ReturnType<typeof setTimeout> | undefined;

  const reason = () => {
    const activity = currentActivity();
    return activity.kind === "retrying" ? activity.reason : "";
  };
  const label = () => (isChatActive() ? activityLabel(props.said()) : "");
  // When a live TurnHeaderView already anchors Pip on screen and there is no
  // extra status label to announce, keep this foot slot quietly empty so Pip
  // is never duplicated underneath the running turn.
  const activeHere = () => (isChatActive() && (!props.hostedByTurn() || label() !== "")) || pipMood() === "happy";

  effect(() => {
    if (isLeavingSession()) return;
    const active = activeHere();
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

  // The words leave as they came, whole: they keep what they said to the last frame of the fade.
  const shownLabel = keepLast(() => label() || undefined, "");

  return (
    <View ref={(node: ViewRef) => props.anchor?.(node)} class="h-9 w-full max-w-180 select-none justify-center overflow-hidden self-center">
      <If when={shown()}>
        <View
          class="min-w-0 flex-row items-center gap-2.5 pt-1"
          style={{ opacity, transform: [{ translateY }] }}
          accessibilityState={{ busy: isChatActive() }}
          accessibilityLabel={isChatActive() ? activityLabel(false) : undefined}
        >
          <View class="shrink-0">
            <Pip size={22} mood={pipMood()} />
          </View>
          <Presence show={label() !== ""} scaleFrom={1} duration={160} class="min-w-0 shrink flex-row items-center gap-2.5">
            <RollingText text={() => shownLabel() ?? ""} class={`min-w-0 shrink truncate ${uiType("sm")} text-muted-foreground`} />
            <If when={reason()}>
              <Text class={`min-w-0 flex-1 truncate ${uiType("xs")} text-subtle`}>{reason()}</Text>
            </If>
          </Presence>
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
      <Text class={`text-center ${uiType("2xl")} font-semibold tracking-tight text-foreground`} role="header">
        {titleText()}
      </Text>
      <If when={props.detail}>
        <Text class={`text-center ${uiType("sm")} text-subtle`}>{props.detail}</Text>
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
function WelcomeProject(props: { onActiveChange?: (active: boolean) => void }) {
  const open = signal(false);
  const closing = signal(false);
  const home = backend().home();
  const current = () => workspacePath();
  const buildProjects = () => {
    const active = current();
    const rest = recentWorkspaces().filter((path) => path !== active);
    return active && !isChatFolder(active) ? [active, ...rest] : rest;
  };
  const shownCurrent = signal(untracked(current));
  const shownProjects = signal<string[]>(untracked(buildProjects));
  effect(() => {
    const active = current();
    const list = buildProjects();
    if (!open() && !closing()) {
      shownCurrent.set(active);
      shownProjects.set(list);
    }
  });
  effect(() => {
    props.onActiveChange?.(open() || closing());
  });
  cleanup(() => props.onActiveChange?.(false));
  const closeAndRun = (action: () => void) => {
    closing.set(true);
    open.set(false);
    setTimeout(action, 0);
  };
  const pick = (cwd: string) => {
    closeAndRun(() => void newSessionInWorkspace(cwd));
  };
  return (
    <Popover
      open={open()}
      onOpenChange={(e) => {
        if (e.open) {
          closing.set(false);
          shownCurrent.set(untracked(current));
          shownProjects.set(untracked(buildProjects));
        } else {
          closing.set(true);
        }
        open.set(e.open);
      }}
      onClose={() => closing.set(false)}
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
          tooltip={open() || closing() ? undefined : tip(placeLabel(current()))}
          class={`${uiHeight(28)} flex-row items-center gap-1.5 ${PRESS} ${FOCUS_RING} ${
            // Over a wallpaper the words cannot stand on the picture: they get the composer's glass, as a capsule.
            wallpaper() ? "rounded-full border-[0.5px] border-hairline bg-card/65 pl-3 pr-2.5 hover:bg-card/85 dark:bg-card/58 dark:hover:bg-card/75" : "rounded-md corner-squircle px-2 hover:bg-accent"
          }`}
          style={wallpaper() ? GLASS_REGULAR : undefined}
        >
          <Icon name={isChatFolder(current()) ? "message" : "folder"} size={12.5} tone="subtle" />
          <Text class={`max-w-80 truncate ${uiType("sm")} text-muted-foreground`}>{`${activeAgent().name} · ${placeLabel(current())}`}</Text>
          <Icon name="chevronDown" size={11.5} tone="subtle" />
        </BaseButton>
      }
    >
      <Scroll class="max-h-72">
        <Each of={shownProjects()} key={(cwd) => cwd}>
          {(cwd) => (
            <BaseButton
              selected={cwd() === shownCurrent()}
              onPress={() => pick(cwd())}
              class={`${uiMinHeight(36)} flex-row items-center gap-2.5 rounded-md corner-squircle px-2 py-1 ${PRESS} hover:bg-accent focus:bg-accent active:bg-accent`}
            >
              <Icon name={cwd() === shownCurrent() ? "folderOpen" : "folder"} size={15} tone={cwd() === shownCurrent() ? "foreground" : "muted-foreground"} />
              <View class="min-w-0 flex-1">
                <Text class={`truncate ${uiType("base")} ${cwd() === shownCurrent() ? "text-foreground" : "text-muted-foreground"}`}>{basename(cwd())}</Text>
                <Text class={`truncate ${uiType("xs")} text-subtle`}>{tildePath(cwd(), home)}</Text>
              </View>
              <View class="w-4 shrink-0 items-center">{cwd() === shownCurrent() ? <Icon name="check" size={14} tone="brand-text" /> : null}</View>
            </BaseButton>
          )}
        </Each>
      </Scroll>
      <View class="mx-1 h-px bg-border" />
      <BaseButton
        selected={isChatFolder(shownCurrent())}
        onPress={() => closeAndRun(() => void openNewChatTab())}
        class={`mt-1 ${uiMinHeight(36)} flex-row items-center gap-2.5 rounded-md corner-squircle px-2 py-1 ${PRESS} hover:bg-accent focus:bg-accent active:bg-accent`}
      >
        <Icon name="message" size={15} tone={isChatFolder(shownCurrent()) ? "foreground" : "muted-foreground"} />
        <View class="min-w-0 flex-1">
          <Text class={`truncate ${uiType("base")} text-foreground`}>{tr("Chat", "闲聊")}</Text>
          <Text class={`truncate ${uiType("xs")} text-subtle`}>{tr("No project folder", "不在任何项目里")}</Text>
        </View>
        <View class="w-4 shrink-0 items-center">{isChatFolder(shownCurrent()) ? <Icon name="check" size={14} tone="brand-text" /> : null}</View>
      </BaseButton>
      <BaseButton
        onPress={() => closeAndRun(() => void chooseWorkspace())}
        class={`mt-1 ${uiMinHeight(36)} flex-row items-center gap-2.5 rounded-md corner-squircle px-2 py-1 ${PRESS} hover:bg-accent focus:bg-accent active:bg-accent`}
      >
        <Icon name="folderPlus" size={15} tone="muted-foreground" />
        <Text class={`flex-1 truncate ${uiType("base")} text-foreground`}>{tr("Add Project Folder…", "添加项目文件夹…")}</Text>
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
  const pickerActive = signal(false);
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
      : isPersonaSession()
        ? tr("Hey, what's up?", "嗨，有什么想聊的？")
        : isChatFolder(workspacePath())
          ? tr("What's on your mind?", "想聊点什么？")
          : tr("What are we building?", "今天要构建什么？");
  return (
    <Stage around title={title} mood={stageMood}>
      <If when={Boolean(workspacePath()) && !isPersonaSession() && (props.mode() === "welcome" || pickerActive())}>
        <View class={props.mode() === "welcome" ? "items-center" : "pointer-events-none h-0 overflow-hidden opacity-0"}>
          <WelcomeProject onActiveChange={(on) => pickerActive.set(on)} />
        </View>
      </If>
      <If when={props.mode() === "starting" && slow()}>
        <Text class={`max-w-110 text-center ${uiType("xs")} text-subtle`}>
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

function Connect() {
  const agentName = () => activeAgent().name;
  return (
    <Stage title={tr("Connect a model to begin", "连接模型以开始使用")} detail={tr(`${agentName()} has no models configured yet.`, `${agentName()} 尚未配置可用模型。`)}>
      <Button label={tr(`Configure ${agentName()}`, `配置 ${agentName()}`)} variant="primary" size="lg" icon="plug" onPress={() => showAgentSettings()} />
      <Text class={`max-w-110 text-center ${uiType("xs")} text-subtle`}>
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
        <Text class={`max-w-110 text-center ${uiType("xs")} text-subtle`}>
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
          opacity.keyframes([0, 1], { duration: DURATION.slower, delay: PATIENCE_MS, easing: EASING.signature });
        }
      } else if (mounted()) {
        if (reduceMotion()) return mounted.set(false);
        void opacity.timing(0, { duration: LEAVE_MS, easing: EASING.exit });
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
        <Text class={`font-mono ${uiType("xs")} leading-relaxed text-muted-foreground`}>{props.detail}</Text>
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
const FOLLOW_THRESHOLD = 48;

/** How long (ms) after a scroll gesture of the reader's begins its scroll events are read as theirs. */
const INPUT_WINDOW_MS = 1500;

/** After the reader releases the view, how long (ms) a move towards the end is not read as theirs: the list settles its layout once as it is released. */
const RELEASE_SETTLE_MS = 300;

/** After an upward wheel/trackpad gesture, how long (ms) bottom re-attachment is suppressed so trackpad bounce never snaps back. */
const UPWARD_GUARD_MS = 350;

/** Reading horizon below the title bar: where a newly sent prompt pauses gently when a long reply pushes it there. */
const HORIZON_GAP = 28;

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
const DOCK_SPRING = { stiffness: 260, damping: 32, mass: 0.96 } as const;
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
type ScrollMode = "tail" | "horizon" | "horizon-held" | "free";

/** Floating pill shown when the reader scrolls up past the follow threshold,
 * or when a long reply pauses at the reading horizon, offering a crisp return to the bottom. */
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
          void opacity.timing(1, { duration: 160, easing: EASING.entrance });
          void translateY.spring(0, SPRING.snappy);
          void scale.spring(1, SPRING.snappy);
        }
      } else if (mounted()) {
        if (reduced) {
          opacity.set(0);
          mounted.set(false);
        } else {
          void opacity.timing(0, { duration: 140, easing: EASING.exit });
          void translateY.timing(6, { duration: 140, easing: EASING.exit });
          void scale.timing(0.95, { duration: 140, easing: EASING.exit });
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
          class={`pointer-events-auto ${uiHeight(28)} flex-row items-center gap-1.5 rounded-full px-3 ${POPUP} ${PRESS} ${PRESS_SCALE} ${FOCUS_RING} hover:bg-muted/80 active:bg-muted`}
          style={GLASS_REGULAR}
        >
          <Text class={`${uiType("xs")} font-medium text-foreground`}>{tr("Jump to latest", "回到最新")}</Text>
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
          class={`pointer-events-auto ${uiHeight(28)} max-w-44 flex-row items-center gap-1.5 rounded-2xl rounded-br-md px-3 ${POPUP} ${PRESS} ${PRESS_SCALE} ${FOCUS_RING} hover:bg-muted/80 active:bg-muted`}
          style={GLASS_REGULAR}
        >
          <View class={below() ? "rotate-180" : undefined}>
            <Icon name="arrowUp" size={12} tone="muted-foreground" />
          </View>
          <If when={text()}>
            <Text class={`min-w-0 shrink truncate ${uiType("xs")} text-foreground`}>{text()}</Text>
          </If>
          <If when={!text() && images() > 0}>
            <Icon name="image" size={12} tone="muted-foreground" />
            <Text class={`${uiType("xs")} text-foreground`}>{tr(images() === 1 ? "1 image" : `${images()} images`, `${images()} 张图片`)}</Text>
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
   * Natural Reading Physics (`ScrollMode`):
   * - `"tail"`: pins cleanly to the end via `maintainVisibleContentPosition`.
   * - `"horizon"`: active after sending a fresh prompt; rides growth from the
   *   bottom until the sent prompt reaches `horizonInset()`, then pauses cleanly
   *   in `"horizon-held"` so long replies are read from the top without yanking.
   * - `"horizon-held"`: pauses at the reading horizon while the reply continues
   *   growing below; never yanks to the end when the run settles.
   * - `"free"`: user scrolled or toggled a fold; user intent always wins
   *   immediately with zero tug-of-war or snap-back jitter.
   */
  const scrollMode = signal<ScrollMode>("tail");
  const bottomFollowing = computed(() => scrollMode() === "tail" || scrollMode() === "horizon");
  const distanceFromEnd = signal(0);
  const topRow = signal(-1);
  const bottomRow = signal(-1);
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
  let inputAt = 0;
  let releasedAt = 0;
  let lastUpwardInputAt = 0;
  let isDragging = false;
  let wheelDirection = 0;
  let lastY: number | undefined;
  let lastDistance = 0;
  let lastScrollDir = 0;
  const activePromptId = signal<string | undefined>(undefined);
  let horizonNode: ViewRef | undefined;
  let checkingHorizon = false;
  effect(() => {
    const id = activePromptId();
    untracked(() => {
      setHorizonPrompt(id, (node) => {
        horizonNode = node;
      });
    });
  });
  cleanup(() => setHorizonPrompt(undefined, () => {}));

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
    trackRecallingUsers();
    const processOf = new Map<string, string>();
    const projected = buildDisplayRows(
      transcriptRows(),
      isChatActive(),
      {
        chosen: turnChoice,
        said: turnSay,
        byDefault: turnDefault,
        keepMounted: isTurnClosing,
      },
      processOf,
      { cwd: workspacePath(), home: backend().home(), persona: isPersonaSession(), lang: activeLanguage() },
    );
    let merged = projected;
    const snapEntries = Object.entries(recallingUserSnapshots());
    if (snapEntries.length > 0) {
      const existingIds = new Set(merged.map((row) => row.id));
      const missing = snapEntries.filter(([id]) => !existingIds.has(id));
      if (missing.length > 0) {
        merged = [...merged];
        for (const [, snap] of missing) {
          const afterIdx = snap.prevId ? merged.findIndex((row) => row.id === snap.prevId) : -1;
          if (afterIdx >= 0) merged.splice(afterIdx + 1, 0, snap.row);
          else merged.push(snap.row);
        }
      }
    }
    const watching = bottomFollowing();
    // The actions row's seat sits under a text row only while it trails the
    // conversation — the one that can still become the reply. A text row with
    // rows after it (the next step's call, a queued send) is mid-turn
    // commentary: a seat there stands as a blank line among the steps. The seat
    // never leaves before a next text row takes it (one commit: a seat lost and
    // a seat gained is no height at all), so no seat's leaving ever pulls the
    // rows around it.
    const stabilized = watching ? stable(merged) : merged;
    const lastRowId = merged.at(-1)?.id;
    const rows: ChatRow[] = [];
    for (let idx = 0; idx < stabilized.length; idx++) {
      const row = stabilized[idx];
      if (row.kind !== "text") {
        rows.push(row);
        continue;
      }
      if (row.pip || isPersonaSession()) {
        rows.push(...proseRows(row));
        continue;
      }
      if (row.final) {
        rows.push(...proseRows(row));
        while (idx + 1 < stabilized.length) {
          const next = stabilized[idx + 1];
          if (next.kind !== "media") break;
          idx++;
          rows.push(next);
        }
        rows.push(replyActions(row));
      } else if (row.id === lastRowId) {
        rows.push(...proseRows(row), heldActions(row));
      } else {
        rows.push(...proseRows(row));
      }
    }
    // The rows a turn's fold shows, in order (commentary is a row per block, each the turn's its reply is).
    const folded = new Map<string, string>();
    for (const row of rows) {
      const turn = processOf.get(row.id) ?? (row.kind === "prose" || row.kind === "actions" ? processOf.get(row.rowId) : undefined);
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
   * The run has rows of its own on screen — its header, its steps, its reply — so the conversation says
   * what it is doing and Pip's line need not. Not "a row is live": the answer once known, no row is, yet
   * the run is not settled, and words would pop in under a finished reply for the frames in between.
   * Before the run's first row the last thing said is still the reader's own message.
   */
  const hasRunningTurn = computed(() => displayRows().some((row) => row.kind === "turn" && row.running));

  const liveRowShown = computed(() => {
    const rows = displayRows();
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      if (row.kind !== "user") return true;
      // Messages waiting in the queue trail the end; they are not what the run is answering.
      if (!row.queued) return false;
    }
    return false;
  });

  /**
   * The last prompt sent, while it is out of view — the bubble's only subject.
   * Above the viewport's top while its reply is being read, or below the bottom
   * while older history is being read (`below`).
   */
  const promptAway = computed(() => {
    const top = topRow();
    if (top < 0) return undefined;
    const mode = scrollMode();
    const activeId = activePromptId();
    const rows = displayRows();
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      if (row.kind !== "user") continue;
      if (mode === "horizon-held" && row.id === activeId) return undefined;
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

  const horizonInset = () => untracked(topBarHeight) + HORIZON_GAP;

  /** Back to that prompt: it lands just under the title bar's reading horizon. */
  const jumpToPrompt = () => {
    const target = untracked(promptAway);
    if (!target) return;
    disengageFollow(false);
    inputAt = Date.now();
    list?.scrollToIndex({ index: target.index, viewPosition: 0, viewOffset: horizonInset(), animated: !untracked(reduceMotion) });
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
      const instant = reduceMotion() || (!middle && isSwitching());
      const way = middle ? dropAhead() : drop || dropAhead();
      const from = slideNow() + (middle ? way : -way);
      // Sending a multi-line draft or attachment from Welcome clears the composer in the same frame it docks:
      // compensate `stand` by the composer's height drop so `bottom-full` hero content stays pinned while fading out.
      const shrink = !middle && heroFigure > FIGURE_REST && !composerDraft() && !composerAttachments().length && !composerDocs().length && !composerFiles().length ? heroFigure - FIGURE_REST : 0;
      travel = undefined;
      // Up: the stage is where it will be, and the composer comes to it. Down: it stays where it was.
      stand.set(middle ? 0 : -(way + shrink));
      if (instant) slide.set(0);
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
      if (instant || dimmedOut) return stage.set(undefined);
      stageFade.set(1);
      void stageFade.timing(0, { duration: STAGE_OUT_MS, easing: EASING.exit });
      stageTimer = setTimeout(() => stage.set(undefined), STAGE_OUT_MS + 10);
    });
  });
  cleanup(() => {
    clearTimeout(stageTimer);
    void slide.stop();
    void stageFade.stop();
  });

  const disengageFollow = (upward = false) => {
    endSettleEpoch++;
    endSettlePasses = 0;
    releasedAt = Date.now();
    if (upward) lastUpwardInputAt = releasedAt;
    if (untracked(scrollMode) !== "free") scrollMode.set("free");
  };

  const checkHorizon = () => {
    if (checkingHorizon || untracked(scrollMode) !== "horizon" || !untracked(isRunning)) return;
    if (isDragging || Date.now() - inputAt <= INPUT_WINDOW_MS || Date.now() - lastUpwardInputAt <= UPWARD_GUARD_MS) return;
    const targetList = list;
    const targetNode = horizonNode;
    if (!targetList || !targetNode) return;
    checkingHorizon = true;
    void Promise.all([targetList.measure(), targetNode.measure(), ending?.measure()]).then(([frame, pBox, end]) => {
      checkingHorizon = false;
      if (list !== targetList || horizonNode !== targetNode) return;
      if (untracked(scrollMode) !== "horizon" || !untracked(isRunning)) return;
      if (isDragging || Date.now() - inputAt <= INPUT_WINDOW_MS || Date.now() - lastUpwardInputAt <= UPWARD_GUARD_MS) return;
      if (!frame || !pBox || frame.bounds.size.height <= 0) return;
      const pad = untracked(foot).end;
      const frameBottom = frame.pagePosition.y + frame.bounds.size.height;
      if (end && end.pagePosition.y + end.bounds.size.height + pad < frameBottom - 24) return;
      const hTop = frame.pagePosition.y + horizonInset();
      const readableBottom = frameBottom - pad;
      const readableH = Math.max(120, readableBottom - hTop);
      const pTop = pBox.pagePosition.y;
      const pBottom = pTop + pBox.bounds.size.height;
      const reached = pBox.bounds.size.height <= readableH * 0.4 ? pTop <= hTop + 24 : pBottom <= hTop + readableH * 0.32;
      if (reached) {
        endSettleEpoch++;
        endSettlePasses = 0;
        scrollMode.set("horizon-held");
        if (pTop < frame.pagePosition.y + untracked(topBarHeight) + 4) {
          const promptId = untracked(activePromptId);
          const promptIdx = promptId ? untracked(displayRows).findIndex((r) => r.id === promptId) : -1;
          if (promptIdx >= 0) {
            targetList.scrollToIndex({ index: promptIdx, viewPosition: 0, viewOffset: horizonInset(), animated: false });
          }
        }
        measureEnd();
        measureTop();
      }
    });
  };

  const onWheel = (e: WheelEvent) => {
    inputAt = Date.now();
    wheelDirection = Math.sign(e.delta.y);
    if (e.delta.y < -0.1) {
      disengageFollow(true);
      return;
    }
    if (e.delta.y > 0.1 && untracked(scrollMode) === "horizon-held") {
      scrollMode.set("free");
    }
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
    const reattachThreshold = isChatActive() ? 24 : FOLLOW_THRESHOLD;
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
        ((isDragging && wheelDirection <= 0) || untracked(selecting)) &&
        movedWithinContent && lastY !== undefined && y < lastY - 0.5 && distance > lastDistance + 0.5
      ) {
        disengageFollow(true);
      } else if (untracked(scrollMode) === "horizon-held" && movedWithinContent && lastY !== undefined && Math.abs(y - lastY) > 0.5) {
        releasedAt = now;
        if (y < lastY - 0.5) lastUpwardInputAt = now;
        scrollMode.set("free");
      } else if (!untracked(bottomFollowing) && lastY !== undefined && y > lastY + 0.5) {
        const reattachThreshold = isChatActive() ? 24 : 40;
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
    measureTop();
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
  const activityMaxHeight = computed(() => Math.min(320, Math.max(0, (viewHeight() - topBarHeight() - foot().end) / 2)));

  // A released view holds its offset, so the list reports no scroll while the
  // reply grows under it, and the distance last reported goes stale: a reader
  // who scrolled up less than the threshold would never be offered the way
  // back. So what changes the rows of a released view measures where the end
  // went: the activity line's foot plus the pad under it, from the list's own.
  let ending: ViewRef | undefined;
  const measureEnd = () => {
    if (untracked(bottomFollowing)) return;
    const pad = untracked(foot).end;
    void Promise.all([list?.measure(), ending?.measure()]).then(([frame, end]) => {
      // Rows far from the end are not mounted: the distance the scroll reported stands.
      if (!frame || !end || untracked(bottomFollowing)) return;
      const gap = end.pagePosition.y + end.bounds.size.height + pad - (frame.pagePosition.y + frame.bounds.size.height);
      // The list is not told how content grew under a held offset; keep the max
      // offset it would have from the measure, so a return knows where to go.
      lastMax = Math.max(0, (lastY ?? 0) + gap);
      distanceFromEnd.set(Math.max(0, gap));
    });
  };
  effect(() => {
    displayRows();
    foot();
    untracked(() => {
      if (scrollMode() === "horizon") checkHorizon();
      measureEnd();
      // Rows can change what the top row is without a scroll (a fold closing
      // above a held view, history landing): measure keeps the bubble aimed.
      measureTop();
    });
  });

  // When a run finishes, a short reply stays in tail mode; a long reply held at the reading horizon
  // transitions cleanly to free mode without yanking the reader down to the bottom.
  effect(() => {
    const running = isRunning();
    untracked(() => {
      if (running) return;
      const mode = scrollMode();
      if (mode === "horizon") {
        scrollMode.set("tail");
      } else if (mode === "horizon-held") {
        scrollMode.set("free");
        measureEnd();
      }
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
      if (!untracked(bottomFollowing) || isDragging || Date.now() - inputAt <= INPUT_WINDOW_MS) return;
      if (!frame || list !== targetList || listKey !== expectedKey || !listReady) return;
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
      targetList.scrollTo({ y: 1e7, animated: false });
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

  // A fold the reader presses grows or shrinks the rows under it, not those above: let go of the end.
  onFoldToggle(() => {
    pokeRepaint();
    disengageFollow(false);
  });
  onFoldSettled(() => {
    pokeRepaint();
    measureEnd();
  });

  // The way back to the end the reader asked for: a live reply still moves it
  // under the flight, but the flight is theirs.
  const jumpToLatest = () => follow(!reduceMotion());

  effect(() => {
    const cue = sendAnchorTick();
    untracked(() => {
      if (!cue) return;
      const rows = untracked(transcriptRows);
      const promptPos = rows.findIndex((row) => row.id === cue.rowId);
      const hasHistoryAbove = promptPos > 0 || (promptPos < 0 && rows.length > 0);
      activePromptId.set(hasHistoryAbove ? cue.rowId : undefined);
      inputAt = 0;
      lastUpwardInputAt = 0;
      isDragging = false;
      scrollMode.set(hasHistoryAbove ? "horizon" : "tail");
      if (list && listKey === conversationKey() && listReady && untracked(distanceFromEnd) > FOLLOW_THRESHOLD) {
        scheduleEndSettle(2);
      }
    });
  });

  effect(() => {
    scrollToEndTick();
    if (!scrollArmed) {
      scrollArmed = true;
      return;
    }
    untracked(() => {
      if (scrollMode() === "horizon") return;
      if (isDragging || Date.now() - inputAt <= INPUT_WINDOW_MS) return;
      inputAt = 0;
      lastUpwardInputAt = 0;
      scrollMode.set("tail");
      // A conversation mounting a fresh `<List>` in this turn opens at its end natively via
      // `initialScrollAtEnd` (before its first frame, following while rows measure); calling
      // `scrollTo` during that synchronous swap would hit the outgoing list or cancel the pass.
      if (list && listKey === conversationKey() && listReady) {
        scheduleEndSettle(3);
      }
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
      lastUpwardInputAt = 0;
      isDragging = false;
      lastY = undefined;
      if (scrollMode() !== "horizon") scrollMode.set("tail");
    });
  });
  // The foot rising moves the end up with it — attachments, a draft growing, an inline prompt — and the list
  // does not go along by itself (it loses its place, and paints blank): a view that follows is sent to the end again,
  // while one held at the reading horizon or released stays steady.
  let footEnd = untracked(foot).end;
  effect(() => {
    const end = foot().end;
    const rose = end > footEnd;
    footEnd = end;
    if (!rose || !untracked(bottomFollowing) || isDragging || Date.now() - inputAt <= INPUT_WINDOW_MS) return;
    if ((untracked(hasInlinePrompt) || untracked(hasFormTakeover)) && !untracked(reduceMotion)) list?.scrollToEnd({ animated: true });
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
      if (bottomFollowing() && !isDragging && Date.now() - inputAt > INPUT_WINDOW_MS && list && listKey === conversationKey() && listReady) {
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
      else void pane.timing(0, { duration: LEAVE_MS, easing: EASING.exit });
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
          void pane.timing(1, { duration: ARRIVE_MS, easing: EASING.entrance });
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
      lastUpwardInputAt = 0;
      isDragging = false;
      lastY = undefined;
      lastScrollDir = 0;
      selected = "";
      endSettleEpoch++;
      endSettlePasses = 0;
      endSelecting();
      activePromptId.set(undefined);
      horizonNode = undefined;
      checkingHorizon = false;
      scrollMode.set("tail");
      distanceFromEnd.set(0);
      topRow.set(-1);
      bottomRow.set(-1);
      viewSpan = -1;
      enterConversation(key);
      const seenIds = displayRowIds(transcriptRows());
      markRowsSeen(seenIds);
      markPacersSeeded(seenIds);
      markVeilsSeeded(seenIds);
      pokeRepaint();
    });
  });

  const onDroppedFiles = (uris: readonly string[]) => {
    for (const raw of uris) {
      const s = raw.trim();
      let decoded = s;
      if (s.startsWith("file://")) {
        const stripped = s.replace(/^file:\/\/localhost/i, "").replace(/^file:\/\//i, "");
        try {
          decoded = decodeURIComponent(stripped);
        } catch {
          decoded = stripped;
        }
        if (/^\/[A-Za-z]:\//.test(decoded)) decoded = decoded.slice(1);
      }
      if (decoded) void attachLocalPath(decoded);
    }
  };

  return (
    <View
      class="relative flex-1"
      onFileDrop={(e) => onDroppedFiles(e.uris)}
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
                    onScrollDragStart={onDragStart}
                    onScrollDragEnd={onDragEnd}
                    onMomentumStart={onInput}
                    onWheel={onWheel}
                    onViewableItemsChange={(info) => {
                      const items = info.viewableItems;
                      const first = items[0]?.index ?? -1;
                      const last = items[items.length - 1]?.index ?? -1;
                      topRow.set(first);
                      bottomRow.set(last);
                      if (first >= 0 && last >= first) viewSpan = last - first;
                    }}
                    maintainVisibleContentPosition={bottomFollowing() ? { autoscrollToBottomThreshold: FOLLOW_THRESHOLD } : undefined}
                    class="flex-1"
                    contentStyle={{
                      paddingHorizontal: 24,
                      paddingTop: topBarHeight() + (wallpaper() && !HEADER_BAND ? HEAD_FADE : 12),
                      paddingBottom: foot().end,
                    }}
                    accessibilityLabel={tr("Conversation", "对话")}
                    footer={
                      <If
                        when={isPersonaSession()}
                        else={
                          <ActivityLine
                            said={liveRowShown}
                            hostedByTurn={hasRunningTurn}
                            anchor={(node) => {
                              if (node) ending = mountedEnding = node;
                              else if (ending === mountedEnding) ending = undefined;
                            }}
                          />
                        }
                      >
                        <PipWorkingFooter
                          anchor={(node) => {
                            if (node) ending = mountedEnding = node;
                            else if (ending === mountedEnding) ending = undefined;
                          }}
                        />
                      </If>
                    }
                  >
                    {(row) => <TranscriptRow row={row()} activityMaxHeight={activityMaxHeight()} />}
                  </List>
                );
              }}
            </Each>
          </View>
          <ScrollToBottomPill
            visible={!bottomFollowing() && distanceFromEnd() > FOLLOW_THRESHOLD}
            bottom={foot().end}
            onPress={jumpToLatest}
          />
          <PromptJumpPill visible={promptAway() !== undefined} prompt={promptAway} top={horizonInset()} onPress={jumpToPrompt} />
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
          testID={hero() ? "composer-hero" : "composer-docked"}
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
