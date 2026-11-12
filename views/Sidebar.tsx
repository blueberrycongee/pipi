import { computed, createAnimatedValue, effect, openUrl, reduceMotion, Scroll, signal, Text, untracked, View } from "nsh";
import type { JSX } from "nsh";
import { AlertDialog, Button as BaseButton, Collapsible } from "nsh/base";
import { Menu, type MenuItem, titleBar } from "nsh/desktop";
import { basename, tildePath } from "../lib/format";
import { tr } from "../lib/i18n";
import { Pip } from "../mascot/Pip";
import { type SessionSummary, sessionTitle } from "../pi/sessions";
import { AgentLogo } from "../ui/AgentLogo";
import {
  activeAgentId,
  archivedSessionItems,
  archiveSession,
  availableAgents,
  chooseWorkspace,
  closeWorkspace,
  copyText,
  currentTitle,
  currentView,
  isRunning,
  isSessionRunning,
  newSession,
  newSessionInWorkspace,
  openSession,
  openWorkspace,
  pendingSession,
  removeSession,
  runningDelegatedCount,
  savedSessions,
  sessionsReady,
  sessionState,
  setOrchestrateOpen,
  showChat,
  showSettings,
  sidecarPhase,
  startRenaming,
  unarchiveSession,
  workspacePath,
  workspaceSessions,
} from "../store/app";
import { backend } from "../store/backend";
import {
  isGroupCollapsed,
  isSessionArchived,
  isWorkspaceCollapsed,
  recentWorkspaces,
  setGroupCollapsed,
  setSidebarOpen,
  toggleGroupCollapsed,
  toggleWorkspaceCollapsed,
} from "../store/prefs";
import { IconButton } from "../ui/Button";
import { Icon, type IconName } from "../ui/Icon";
import { animateNextLayout, delayedFade, Presence, Reveal } from "../ui/motion";
import { FOCUS_RING, PRESS } from "../ui/styles";
import { tip } from "../ui/Tip";

/** A row inside an expanded workspace folder: a saved session. */
type FolderItem = { id: string; session: SessionSummary };

type GroupId = "workspaces" | "recents" | "archived";

/** A session in 最近: the summary plus the project folder that owns it. */
type RecentItem = { id: string; session: SessionSummary; cwd: string };

/** Sessions the sidebar lists, how many 最近 surfaces, and the indent of a row's text. */
const RECENT_LIMIT = 8;
const REPO_URL = "https://github.com/blueberrycongee/pipi";
const ICON_SLOT = "size-5 shrink-0 items-center justify-center";
/** Trailing 24pt slot (`right-1` inside `px-2`) centered on the sidebar's 24pt right axis. */
const TRAILING_SLOT = "pointer-events-none absolute right-1 top-0.5 size-6 flex-row items-center justify-center";
const ROW_PRESS = `${PRESS} ${FOCUS_RING} hover:bg-sidebar-accent group-hover:bg-sidebar-accent active:bg-sidebar-accent`;
/** The group each session was last clicked in (`ownsActiveSession`). */
const chosenGroups = signal<Record<string, GroupId>>({});
/** Which group (`workspaces` or `recents`) owns the open draft session's highlight. */
const draftGroup = signal<GroupId>("workspaces");
let explicitDraftGroup: GroupId | undefined;

/** The open project folders: the active one first, then the recents it also leads. */
const projects = computed(() => {
  const active = workspacePath();
  const list = recentWorkspaces();
  if (!active) return list;
  return list.includes(active) ? list : [active, ...list];
});

const titleOf = (session: SessionSummary) => sessionTitle(session, tr("New session", "新会话"));

/**
 * The open session has no row of its own yet: it is not in the saved list. Pi
 * assigns its sessionFile on startup while other engines get one with the first
 * message, and the list only catches up once a run settles, so the draft row
 * stays until the saved row takes its place, never leaving a gap between them.
 * While a session change is under way, its destination decides instead.
 */
const isDraftSession = () => {
  const pending = pendingSession();
  if (pending) return !pending.file;
  const current = sessionState();
  if (!current) return false;
  return !current.sessionFile || !savedSessions().some((s) => s.path === current.sessionFile);
};

/** The session file the sidebar marks as open: where a change is heading, else the one on screen. */
const openFile = () => {
  const pending = pendingSession();
  return pending ? pending.file : sessionState()?.sessionFile;
};

/** The active folder's list can be trusted: its agent is ready, or a session change knows where it lands. */
const listSteady = () => sidecarPhase().name === "ready" || pendingSession() !== undefined;

/** True on a fresh single-folder install with nothing saved or archived yet. */
const singleEmpty = computed(
  () =>
    projects().length === 1 &&
    savedSessions().length === 0 &&
    archivedSessionItems().length === 0 &&
    sessionsReady() &&
    listSteady(),
);

/** Whether 最近 surfaces the open unsaved draft session at its top. */
const hasRecentDraft = computed(() => Boolean(workspacePath()) && listSteady() && isDraftSession() && !singleEmpty());

/**
 * True when a draft slot closes because the draft session itself just entered
 * `savedSessions()` (rather than the user switching away): the saved `SessionRow`
 * takes its exact place in the same commit, so collapsing the draft slot would
 * briefly show the session twice.
 */
const draftGraduated = () => {
  if (isDraftSession() || pendingSession()?.file) return false;
  const file = sessionState()?.sessionFile;
  return Boolean(file && savedSessions().some((s) => s.path === file));
};

/** Animates explicit sidebar list edits without ever touching layout animation during a run (`AGENTS.md`). */
function animateSidebarList() {
  if (!isRunning()) animateNextLayout(220);
}

/** Recent sessions across every open folder, newest first, deduped by file. */
const recents = computed<RecentItem[]>(() => {
  const active = workspacePath();
  const seen = new Set<string>();
  const out: RecentItem[] = [];
  for (const cwd of projects()) {
    const list = cwd === active ? savedSessions() : (workspaceSessions()[cwd] ?? []);
    for (const session of list) {
      if (seen.has(session.path)) continue;
      seen.add(session.path);
      out.push({ id: `recent:${session.path}`, session, cwd });
    }
  }
  out.sort((a, b) => b.session.modified - a.session.modified);
  return out.slice(0, RECENT_LIMIT);
});

/**
 * Which group highlights (and carries Pip for) the open session when both
 * 工作区 and 最近 list it: the group the user clicked it in, falling back to
 * whichever group is currently unfolded. The choice is remembered per session,
 * so clicking a row in 最近 does not move the current session's highlight
 * before the clicked one opens.
 */
function ownsActiveSession(group: GroupId, sessionPath: string, cwd: string): boolean {
  if (isSessionArchived(sessionPath)) return group === "archived";
  const inWorkspaces = !isGroupCollapsed("workspaces") && !isWorkspaceCollapsed(cwd);
  const inRecents = !isGroupCollapsed("recents") && recents().some((item) => item.session.path === sessionPath);
  const owner: GroupId =
    chosenGroups()[sessionPath] === "recents" && inRecents ? "recents" : inWorkspaces ? "workspaces" : inRecents ? "recents" : "workspaces";
  return group === owner;
}

/** Which group highlights (and carries Pip for) the open draft session when both 工作区 and 最近 list it. */
function ownsDraftSession(group: GroupId, cwd: string): boolean {
  const inWorkspaces = !isGroupCollapsed("workspaces") && !isWorkspaceCollapsed(cwd);
  const inRecents = !isGroupCollapsed("recents") && hasRecentDraft();
  const owner: GroupId =
    draftGroup() === "recents" && inRecents ? "recents" : inWorkspaces ? "workspaces" : inRecents ? "recents" : "workspaces";
  return group === owner;
}

/**
 * The engine a saved session ran on: its mark and the name the picker shows.
 * A session whose engine is gone (a custom agent deleted, a CLI uninstalled)
 * still names itself, so the row never lies about where the transcript came from.
 */
function engineOf(id: string | undefined) {
  const key = id ?? "pi";
  const agent = availableAgents().find((a) => a.id === key);
  const name = agent?.name ?? (key === "pi" ? "Pi" : key);
  const available = agent ? agent.available && agent.enabled !== false : key === "pi";
  return { id: key, name, available };
}

async function confirmDelete(session: SessionSummary, cwd: string) {
  const name = titleOf(session);
  const { action } = await AlertDialog.show({
    title: tr("Delete this session?", "删除此会话？"),
    description: tr(`“${name}” will be removed from this Mac. This cannot be undone.`, `“${name}”将从此设备移除，该操作无法撤销。`),
    actions: [
      { label: tr("Cancel", "取消"), role: "cancel", id: "cancel" },
      { label: tr("Delete", "删除"), role: "destructive", id: "delete" },
    ],
  });
  if (action === "delete") {
    animateSidebarList();
    await removeSession(session.path, cwd);
  }
}

async function renameFrom(session: SessionSummary, cwd: string) {
  await openSession(session.path, cwd);
  startRenaming();
}

/** Disambiguates duplicate folder basenames with their parent folder name (`parent/name`). */
function projectLabel(cwd: string, all: readonly string[]): { name: string; parent?: string } {
  const name = basename(cwd) || tr("Folder", "文件夹");
  const clashes = all.filter((other) => other !== cwd && basename(other) === name);
  if (!clashes.length) return { name };
  const trimmed = cwd.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  const parent = slash > 0 ? basename(trimmed.slice(0, slash)) : "";
  return parent ? { name, parent } : { name };
}

/** What every session row shows on a right click, in a workspace, 最近, or 已归档. */
function sessionMenuItems(session: SessionSummary, cwd: string): MenuItem[] {
  if (isSessionArchived(session.path)) {
    return [
      { label: tr("Open", "打开"), onSelect: () => void openSession(session.path, cwd) },
      {
        label: tr("Unarchive", "取消归档"),
        onSelect: () => {
          animateSidebarList();
          unarchiveSession(session.path);
        },
      },
      { type: "separator" },
      { label: tr("Delete…", "删除…"), onSelect: () => void confirmDelete(session, cwd) },
    ];
  }
  return [
    { label: tr("Open", "打开"), onSelect: () => void openSession(session.path, cwd) },
    { label: tr("Rename…", "重命名…"), onSelect: () => void renameFrom(session, cwd) },
    {
      label: tr("Archive", "归档"),
      onSelect: () => {
        animateSidebarList();
        void archiveSession(session.path, cwd);
      },
    },
    { type: "separator" },
    { label: tr("Delete…", "删除…"), onSelect: () => void confirmDelete(session, cwd) },
  ];
}

function startNewSession() {
  showChat();
  void newSession();
}

function startNewSessionFromRecents() {
  setGroupCollapsed("recents", false);
  explicitDraftGroup = "recents";
  draftGroup.set("recents");
  showChat();
  void newSession();
}

function startNewSessionIn(cwd: string) {
  if (isWorkspaceCollapsed(cwd)) {
    setGroupCollapsed("recents", false);
    explicitDraftGroup = "recents";
    draftGroup.set("recents");
  } else {
    explicitDraftGroup = "workspaces";
    draftGroup.set("workspaces");
  }
  void newSessionInWorkspace(cwd);
}

/**
 * A functional group's heading (工作区 / 最近 / 已归档): the quiet label, the fold cue
 * that only an open group hides until hovered, and the group's own action.
 * The label sits on the same left axis as every row's text.
 */
function GroupHeading(props: {
  id: GroupId;
  label: string;
  count: number;
  action?: { icon: IconName; label: string; shortcut?: string; onPress: () => void };
}) {
  const collapsed = () => isGroupCollapsed(props.id);
  return (
    <View class="group relative">
      <BaseButton
        onPress={() => toggleGroupCollapsed(props.id)}
        accessibilityLabel={collapsed() ? tr(`Expand ${props.label}`, `展开 ${props.label}`) : tr(`Collapse ${props.label}`, `收起 ${props.label}`)}
        class={`h-6 w-full min-w-0 flex-row items-center gap-1 rounded-md pl-2.5 ${props.action ? "pr-8" : "pr-2.5"} ${ROW_PRESS}`}
      >
        <Text class="shrink-0 truncate text-sm text-subtle">{props.label}</Text>
        <If when={collapsed() && props.count > 0}>
          <Text class="text-xs tabular-nums text-subtle">{String(props.count)}</Text>
        </If>
        <View
          class={`shrink-0 transition-all duration-200 ease-out-quint motion-reduce:transition-none ${
            collapsed() ? "opacity-55" : "rotate-90 opacity-0 group-hover:opacity-100"
          }`}
        >
          <Icon name="chevronRight" size={12} tone="subtle" />
        </View>
      </BaseButton>
      <If when={props.action}>
        {(action) => (
          <IconButton
            testID={`sidebar-${props.id}-action`}
            icon={action().icon}
            size="sm"
            label={action().label}
            shortcut={action().shortcut}
            tipPlacement="right"
            onPress={() => action().onPress()}
            class="absolute right-1 top-0 opacity-0 transition-opacity group-hover:opacity-100"
          />
        )}
      </If>
    </View>
  );
}

/** One collapsible section of the tree: heading plus the body it reveals. */
function FunctionalGroup(props: {
  id: GroupId;
  label: string;
  count: number;
  action?: { icon: IconName; label: string; shortcut?: string; onPress: () => void };
  first?: boolean;
  children?: JSX.Element;
}) {
  const collapsed = () => isGroupCollapsed(props.id);
  return (
    <View class={props.first ? "pt-1" : "pt-6"}>
      <Collapsible open={!collapsed()} reveal content={<View class="pt-1.5">{props.children}</View>}>
        <GroupHeading id={props.id} label={props.label} count={props.count} action={props.action} />
      </Collapsible>
    </View>
  );
}

function ProjectRow(props: { cwd: string; first: boolean; allProjects: readonly string[] }) {
  const home = backend().home();
  const active = () => props.cwd === workspacePath();
  const collapsed = () => isWorkspaceCollapsed(props.cwd);
  const label = () => projectLabel(props.cwd, props.allProjects);
  const sessions = () => (active() ? savedSessions() : (workspaceSessions()[props.cwd] ?? []));
  const activeShownInRecents = () => {
    if (isGroupCollapsed("recents")) return false;
    if (isDraftSession()) return hasRecentDraft();
    const file = openFile();
    return Boolean(file && recents().some((item) => item.session.path === file));
  };
  const activeCollapsedRunning = () => active() && collapsed() && isRunning() && !activeShownInRecents();
  const startingHere = () => active() && sidecarPhase().name === "starting";
  const canRemove = () => props.allProjects.length > 1;

  return (
    <View
      class={props.first ? "" : "pt-0.5"}
      onContextMenu={(e) =>
        Menu.popup(
          [
            { label: tr("Open Workspace", "打开此工作区"), onSelect: () => void openWorkspace(props.cwd) },
            { label: tr("New Session Here", "在此新建会话"), onSelect: () => startNewSessionIn(props.cwd) },
            {
              label: collapsed() ? tr("Expand Sessions", "展开会话") : tr("Collapse Sessions", "收起会话"),
              onSelect: () => toggleProject(props.cwd),
            },
            { label: tr("Copy Path", "复制路径"), onSelect: () => void copyText(props.cwd) },
            { type: "separator" },
            {
              label: tr("Remove from Sidebar", "从侧边栏移除"),
              disabled: !canRemove(),
              onSelect: () => {
                animateSidebarList();
                void closeWorkspace(props.cwd);
              },
            },
          ],
          e.pagePosition,
        )
      }
    >
      <View class="group relative">
        <BaseButton
          onPress={() => toggleProject(props.cwd)}
          accessibilityLabel={collapsed() ? tr(`Expand ${label().name}`, `展开 ${label().name}`) : tr(`Collapse ${label().name}`, `收起 ${label().name}`)}
          tooltip={tip(tildePath(props.cwd, home), undefined, "right")}
          class={`h-7 w-full min-w-0 flex-row items-center gap-1.5 rounded-md pl-2.5 pr-8 ${ROW_PRESS}`}
        >
          <View class={ICON_SLOT}>
            <Icon name={collapsed() ? "folder" : "folderOpen"} size={14} tone={active() ? "foreground" : "muted-foreground"} />
          </View>
          <Text
            class={`shrink truncate text-base ${
              active() ? "font-semibold text-sidebar-foreground" : "font-medium text-muted-foreground group-hover:text-sidebar-foreground"
            }`}
          >
            {label().name}
          </Text>
          <If when={label().parent}>
            {(p) => <Text class="shrink truncate text-xs text-subtle">{p()}</Text>}
          </If>
          <View
            class={`shrink-0 transition-all duration-200 ease-out-quint motion-reduce:transition-none ${
              collapsed() ? "" : "rotate-90"
            } opacity-0 group-hover:opacity-100`}
          >
            <Icon name="chevronRight" size={12} tone="subtle" />
          </View>
        </BaseButton>
        <View class={`${TRAILING_SLOT} transition-opacity group-hover:opacity-0`}>
          <If when={startingHere()}>
            <View class="absolute inset-0 items-center justify-center">
              <FadeIn>
                <View class="size-2.5 rounded-full border-[1.5px] border-input border-t-brand animate-spin" />
              </FadeIn>
            </View>
          </If>
          <Presence
            show={!startingHere() && activeCollapsedRunning()}
            testID="sidebar-project-running"
            accessibilityLabel={tr("Running in the background", "后台运行中")}
            class="absolute inset-0 items-center justify-center"
          >
            <Pip size={16} mood="work" />
          </Presence>
          <If when={!startingHere() && !activeCollapsedRunning() && collapsed() && sessions().length > 0}>
            <View class="absolute inset-0 items-center justify-center">
              <Text class="text-xs tabular-nums text-subtle">{String(sessions().length)}</Text>
            </View>
          </If>
        </View>
        <IconButton
          icon="plus"
          size="sm"
          label={tr(`New session in ${label().name}`, `在 ${label().name} 中新建会话`)}
          tipPlacement="right"
          onPress={() => startNewSessionIn(props.cwd)}
          class="absolute right-1 top-0.5 opacity-0 transition-opacity group-hover:opacity-100"
        />
      </View>
    </View>
  );
}

/** A session row anywhere in the sidebar: the engine's mark, the title, and the running cue or archive action. */
const sessionRowClass = (indent: boolean, reserveTrailing: boolean, reserveHoverAction: boolean) =>
  `h-7 w-full min-w-0 flex-row items-center gap-1.5 rounded-md ${indent ? "pl-8" : "pl-2.5"} ${
    reserveTrailing ? "pr-8" : reserveHoverAction ? "pr-2.5 group-hover:pr-8" : "pr-2.5"
  } ${PRESS} active:scale-[0.99] motion-reduce:active:scale-100 ${FOCUS_RING} hover:bg-sidebar-accent group-hover:bg-sidebar-accent active:bg-sidebar-accent selected:bg-sidebar-accent`;

const sessionTitleClass = (selected: boolean) =>
  `min-w-0 flex-1 truncate text-base ${PRESS} ${selected ? "font-medium text-sidebar-foreground" : "text-muted-foreground group-hover:text-sidebar-foreground"}`;

/** Fades its content in after the shared patience delay, so a state that ends sooner (a quick restart) never shows at all. */
function FadeIn(props: { children: JSX.Element }) {
  return <View style={{ opacity: delayedFade() }}>{props.children}</View>;
}

/** A row's engine mark; switching the engine settles the new mark in rather than swapping it in one frame. */
function EngineMark(props: { id: string; available: boolean }) {
  const opacity = createAnimatedValue(1);
  const scale = createAnimatedValue(1);
  let shown = untracked(() => props.id);
  effect(() => {
    const id = props.id;
    if (id === shown) return;
    shown = id;
    if (untracked(reduceMotion)) return;
    opacity.keyframes([0, 1], { duration: 220, easing: "easeOut" });
    scale.keyframes([0.6, 1], { duration: 260, easing: [0.22, 1, 0.36, 1] });
  });
  return (
    <View class={ICON_SLOT} style={{ opacity, transform: [{ scale }] }}>
      <AgentLogo id={props.id} size={14} tone="muted-foreground" status={props.available ? "ready" : "off"} />
    </View>
  );
}

function DraftSessionRow(props: { cwd: string; group: GroupId; indent?: boolean }) {
  const home = backend().home();
  const resolvedCwd = () => props.cwd || workspacePath();
  const active = () => Boolean(resolvedCwd()) && resolvedCwd() === workspacePath() && isDraftSession();
  const primary = () => active() && ownsDraftSession(props.group, resolvedCwd());
  const running = () => primary() && isRunning();
  const selected = () => primary() && currentView().name === "chat";
  const shownTitle = signal(untracked(() => (isDraftSession() ? currentTitle() : tr("New session", "新会话"))));
  const shownAgentId = signal(untracked(activeAgentId));
  const shownCwd = signal(untracked(resolvedCwd));
  effect(() => {
    if (!active()) return;
    shownTitle.set(currentTitle());
    shownAgentId.set(activeAgentId());
    shownCwd.set(resolvedCwd());
  });
  const engine = () => engineOf(shownAgentId());
  return (
    <View class="group relative">
      <BaseButton
        selected={selected()}
        onPress={() => {
          const target = shownCwd();
          draftGroup.set(props.group);
          showChat();
          if (target && target !== workspacePath()) void openWorkspace(target);
        }}
        tooltip={tip(
          props.group === "recents" ? `${engine().name} · ${tildePath(shownCwd(), home)}` : engine().name,
          undefined,
          "right",
        )}
        class={sessionRowClass(Boolean(props.indent), running(), false)}
      >
        <EngineMark id={engine().id} available={engine().available} />
        <Text class={sessionTitleClass(selected())}>{shownTitle()}</Text>
      </BaseButton>
      <View class={TRAILING_SLOT}>
        <Presence show={running()} testID="sidebar-draft-running">
          <Pip size={16} mood="work" />
        </Presence>
      </View>
    </View>
  );
}

function SessionRow(props: { session: SessionSummary; cwd: string; group: GroupId; indent?: boolean }) {
  const home = backend().home();
  const active = () => !isDraftSession() && props.cwd === workspacePath() && props.session.path === openFile();
  const owns = () => ownsActiveSession(props.group, props.session.path, props.cwd);
  const primary = () => active() && owns();
  const backgroundRunning = () => !active() && owns() && isSessionRunning(props.session.path);
  const running = () => (primary() && isRunning()) || backgroundRunning();
  const archived = () => isSessionArchived(props.session.path);
  const engine = () => engineOf(props.session.agentId);
  const selected = () => primary() && currentView().name === "chat";
  return (
    <View class="group relative" onContextMenu={(e) => Menu.popup(sessionMenuItems(props.session, props.cwd), e.pagePosition)}>
      <BaseButton
        selected={selected()}
        onPress={() => {
          const path = props.session.path;
          if (chosenGroups()[path] !== props.group) chosenGroups.update((all) => ({ ...all, [path]: props.group }));
          void openSession(props.session.path, props.cwd);
        }}
        tooltip={tip(`${engine().name} · ${tildePath(props.cwd, home)}`, undefined, "right")}
        class={sessionRowClass(Boolean(props.indent), running(), true)}
      >
        <EngineMark id={engine().id} available={engine().available} />
        <Text class={sessionTitleClass(selected())}>{titleOf(props.session)}</Text>
      </BaseButton>
      <View class={`${TRAILING_SLOT} transition-opacity group-hover:opacity-0`}>
        <Presence
          show={running()}
          testID="sidebar-session-running"
          accessibilityLabel={backgroundRunning() ? tr("Running in the background", "后台运行中") : undefined}
        >
          <Pip size={16} mood="work" />
        </Presence>
      </View>
      <IconButton
        icon={archived() ? "unarchive" : "archive"}
        size="sm"
        label={archived() ? tr("Unarchive", "取消归档") : tr("Archive", "归档")}
        tipPlacement="right"
        onPress={() => {
          animateSidebarList();
          if (archived()) unarchiveSession(props.session.path);
          else void archiveSession(props.session.path, props.cwd);
        }}
        class="absolute right-1 top-0.5 opacity-0 transition-opacity group-hover:opacity-100"
      />
    </View>
  );
}

function EmptyProjectRow(props: { cwd: string }) {
  const active = () => props.cwd === workspacePath();
  return (
    <BaseButton
      onPress={() => startNewSessionIn(props.cwd)}
      class={`h-7 w-full flex-row items-center rounded-md pl-9 pr-2.5 ${ROW_PRESS}`}
    >
      <Text class="truncate text-xs text-subtle">
        {active() ? tr("No saved sessions yet", "暂无已保存会话") : tr("No sessions — click to start", "暂无会话，点击开始")}
      </Text>
    </BaseButton>
  );
}

function ProjectSessions(props: { cwd: string; allProjects: readonly string[]; singleEmpty: boolean }) {
  const isCurrent = () => props.cwd === workspacePath();
  const folderSessions = () => (isCurrent() ? savedSessions() : (workspaceSessions()[props.cwd] ?? []));
  const loaded = () => (isCurrent() ? sessionsReady() && listSteady() : props.cwd in workspaceSessions());
  const hasDraft = () =>
    isCurrent() && listSteady() && isDraftSession() && (folderSessions().length > 0 || props.allProjects.length > 1);
  const showEmpty = () => folderSessions().length === 0 && !hasDraft() && loaded() && !props.singleEmpty;

  const items = computed<FolderItem[]>(() =>
    folderSessions().map((session) => ({ id: `session:${session.path}`, session })),
  );

  return (
    <View>
      <Reveal open={hasDraft()} instant={draftGraduated()}>
        <DraftSessionRow cwd={props.cwd} group="workspaces" indent />
      </Reveal>
      <Each of={items()} key={(item) => item.id}>
        {(item) => <SessionRow session={item().session} cwd={props.cwd} group="workspaces" indent />}
      </Each>
      <Reveal open={showEmpty()}>
        <EmptyProjectRow cwd={props.cwd} />
      </Reveal>
    </View>
  );
}

function ProjectSection(props: { cwd: string; first: boolean; allProjects: readonly string[]; singleEmpty: boolean }) {
  const collapsed = () => isWorkspaceCollapsed(props.cwd);
  return (
    <Collapsible
      open={!collapsed()}
      reveal
      content={<ProjectSessions cwd={props.cwd} allProjects={props.allProjects} singleEmpty={props.singleEmpty} />}
    >
      <ProjectRow cwd={props.cwd} first={props.first} allProjects={props.allProjects} />
    </Collapsible>
  );
}

function toggleProject(cwd: string) {
  toggleWorkspaceCollapsed(cwd);
}

/** The scrollable tree: 工作区's project folders, 最近's sessions across them, and 已归档's tucked-away sessions. */
function SidebarTree() {
  const recentCount = () => recents().length + (hasRecentDraft() ? 1 : 0);
  const showRecents = () => recentCount() > 0;

  return (
    <View class="flex-1">
      <Scroll
        class="flex-1"
        contentClass="px-2 pb-3"
        accessibilityLabel={tr("Workspaces and sessions", "工作区与会话")}
      >
        <FunctionalGroup
          id="workspaces"
          label={tr("Workspaces", "工作区")}
          count={projects().length}
          first
          action={{
            icon: "plus",
            label: tr("Add project folder", "添加项目文件夹"),
            shortcut: "mod+o",
            onPress: () => {
              setGroupCollapsed("workspaces", false);
              void chooseWorkspace();
            },
          }}
        >
          <View testID="sidebar-workspaces">
            <Each of={projects()} key={(cwd) => cwd}>
              {(cwd, index) => <ProjectSection cwd={cwd()} first={index() === 0} allProjects={projects()} singleEmpty={singleEmpty()} />}
            </Each>
          </View>
        </FunctionalGroup>
        <Reveal open={showRecents()}>
          <FunctionalGroup
            id="recents"
            label={tr("Recent", "最近")}
            count={recentCount()}
            action={{ icon: "pencil", label: tr("New session", "新会话"), shortcut: "mod+n", onPress: startNewSessionFromRecents }}
          >
            <View testID="sidebar-recents">
              <Reveal open={hasRecentDraft()} instant={draftGraduated()}>
                <DraftSessionRow cwd={workspacePath()} group="recents" />
              </Reveal>
              <Each of={recents()} key={(item) => item.id}>
                {(item) => <SessionRow session={item().session} cwd={item().cwd} group="recents" />}
              </Each>
            </View>
          </FunctionalGroup>
        </Reveal>
        <Reveal open={archivedSessionItems().length > 0}>
          <FunctionalGroup
            id="archived"
            label={tr("Archived", "已归档")}
            count={archivedSessionItems().length}
            action={{
              icon: "sliders",
              label: tr("Manage archive", "管理归档"),
              onPress: () => showSettings("archive"),
            }}
          >
            <View testID="sidebar-archived">
              <Each of={archivedSessionItems()} key={(item) => item.id}>
                {(item) => <SessionRow session={item().session} cwd={item().cwd} group="archived" />}
              </Each>
            </View>
          </FunctionalGroup>
        </Reveal>
      </Scroll>
      <Presence show={singleEmpty()} class="pointer-events-none absolute inset-x-0 top-28 items-center gap-3 px-6">
        <Pip size={40} mood="sleep" still />
        <Text class="text-center text-sm text-subtle">
          {tr("No sessions here yet.", "此文件夹暂无会话。")}
        </Text>
      </Presence>
    </View>
  );
}

/** The left column: 新会话, the open project workspaces, 最近, and the way to settings. */
export function Sidebar() {
  const settingsOpen = () => currentView().name === "settings";
  let prevDraft = untracked(isDraftSession);
  let lastSavedOwner: GroupId = "workspaces";
  let lastDraftOwner: GroupId | undefined = prevDraft ? untracked(draftGroup) : undefined;
  effect(() => {
    const draft = isDraftSession();
    const cwd = workspacePath();
    const file = openFile();
    if (!draft) {
      if (prevDraft && lastDraftOwner && file && !pendingSession()?.file && chosenGroups()[file] === undefined) {
        const inherited = lastDraftOwner;
        chosenGroups.update((all) => ({ ...all, [file]: inherited }));
      }
      lastDraftOwner = undefined;
      explicitDraftGroup = undefined;
      if (file && cwd) {
        lastSavedOwner = ownsActiveSession("recents", file, cwd) ? "recents" : "workspaces";
      }
      prevDraft = false;
      return;
    }
    if (!prevDraft) {
      const next = explicitDraftGroup ?? lastSavedOwner;
      explicitDraftGroup = undefined;
      if (untracked(draftGroup) !== next) draftGroup.set(next);
    }
    const owner: GroupId = cwd && ownsDraftSession("recents", cwd) ? "recents" : "workspaces";
    lastDraftOwner = owner;
    if (file && chosenGroups()[file] !== owner) {
      chosenGroups.update((all) => ({ ...all, [file]: owner }));
    }
    prevDraft = true;
  });
  return (
    <View class="size-full bg-sidebar">
      <View
        desktop={{ windowDrag: true }}
        class="shrink-0 flex-row items-center justify-end pr-2.5"
        style={{ height: titleBar().height || 44, paddingLeft: (titleBar().left || 0) + 14 }}
      >
        <IconButton icon="sidebar" label={tr("Hide sidebar", "隐藏侧边栏")} shortcut="mod+b" onPress={() => setSidebarOpen(false)} />
      </View>
      <View class="shrink-0 px-2 pb-1.5">
        <BaseButton
          testID="sidebar-new-session"
          onPress={startNewSession}
          accessibilityLabel={tr("New session", "新会话")}
          tooltip={tip(tr("New session", "新会话"), "mod+n", "right")}
          class={`h-8 w-full flex-row items-center gap-1.5 rounded-md px-2.5 ${ROW_PRESS}`}
        >
          <View class={ICON_SLOT}>
            <Icon name="pencil" size={14} tone="muted-foreground" />
          </View>
          <Text class="text-base text-sidebar-foreground">{tr("New session", "新会话")}</Text>
        </BaseButton>
      </View>
      <SidebarTree />
      <View class="border-t border-sidebar-border p-2">
        <Reveal open={runningDelegatedCount() > 0} offset={4}>
          <View class="pb-1">
            <BaseButton
              onPress={() => (showChat(), setOrchestrateOpen(true))}
              class={`h-8 flex-row items-center gap-1.5 rounded-md bg-sidebar-accent/70 pl-2.5 pr-1 ${PRESS} ${FOCUS_RING} hover:bg-sidebar-accent`}
            >
              <View class={ICON_SLOT}>
                <Pip size={16} mood="work" />
              </View>
              <Text class="flex-1 truncate text-sm font-medium text-sidebar-foreground">
                {tr(`${runningDelegatedCount()} sub-agent${runningDelegatedCount() === 1 ? "" : "s"} active`, `${runningDelegatedCount()} 个子智能体运行中`)}
              </Text>
              <View class="size-6 shrink-0 items-center justify-center">
                <Icon name="agents" size={14} tone="brand-text" />
              </View>
            </BaseButton>
          </View>
        </Reveal>
        <View class="flex-row items-center justify-between pl-1.5 pr-0.5">
          <IconButton
            icon="gear"
            selected={settingsOpen()}
            onPress={() => (settingsOpen() ? showChat() : showSettings())}
            label={tr("Settings", "设置")}
            shortcut="mod+,"
            tone={settingsOpen() ? "foreground" : "muted-foreground"}
            tipPlacement="top"
            class="hover:bg-sidebar-accent active:bg-sidebar-accent selected:bg-sidebar-accent"
          />
          <IconButton
            icon="github"
            onPress={() => void openUrl(REPO_URL)}
            label={tr("pipi on GitHub", "GitHub 上的 pipi")}
            tipPlacement="top"
            class="hover:bg-sidebar-accent active:bg-sidebar-accent"
          />
        </View>
      </View>
    </View>
  );
}
