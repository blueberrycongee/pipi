import { computed, createMotion, Text, View } from "nsh";
import { Command, type CommandItem, Dialog } from "nsh/base";
import type { RuntimeMode } from "../agents/types";
import { basename, tildePath } from "../lib/format";
import { sessionTitle } from "../pi/sessions";
import {
  activeAgent,
  activeAgentId,
  archiveCurrentSession,
  archivedSessionItems,
  availableAgents,
  availableModels,
  canArchiveCurrentSession,
  changeRuntimeMode,
  chooseModel,
  chooseThinkingLevel,
  chooseWorkspace,
  compactNow,
  copyLastReply,
  createAndOpenWorktree,
  duplicateSession,
  exportHtml,
  gitWorkspaceInfo,
  isCurrentSessionArchived,
  isPaletteOpen,
  newSession,
  newSessionInWorkspace,
  openSession,
  openWorkspace,
  randomWallpaper,
  restartPi,
  runtimeMode,
  savedSessions,
  sessionState,
  setOrchestrateOpen,
  setPaletteOpen,
  showSettings,
  startRenaming,
  switchAgentHarness,
  thinkingLevels,
  unarchiveCurrentSession,
  workspacePath,
  workspaceSessions,
} from "../store/app";
import { backend } from "../store/backend";
import { type Appearance, language, type Language, recentWorkspaces, setAppearance, setLanguage, setSidebarOpen, sidebarOpen } from "../store/prefs";
import { Icon, type IconName } from "../ui/Icon";
import { DIALOG_RISE } from "../ui/motion";
import { runtimeModeIcon, runtimeModeText, thinkingText, tr } from "../lib/i18n";
import { GLASS_REGULAR, GLASS_SCRIM, POPUP, PRESS } from "../ui/styles";

interface Action extends CommandItem {
  icon: IconName;
  run: () => void;
}

/** The command palette: every action, session, model and thinking level, one search away. */
export function Palette() {
  const actions = computed<Action[]>(() => {
    const model = sessionState()?.model;
    const current = model ? `${model.provider}/${model.id}` : "";
    const viewGroup = tr("View", "视图");
    const sessionGroup = tr("Session", "会话");
    const agentsGroup = tr("Agents & Orchestration", "多智能体与编排");
    const workspaceGroup = tr("Workspace", "工作区");
    const permissionModes: RuntimeMode[] = ["approval-required", "auto-accept-edits", "full-access"];
    const theme = (value: Appearance, label: string, keywords: string[]): Action => ({
      id: `theme:${value}`,
      label: tr(`Appearance: ${label}`, `外观：${label}`),
      group: viewGroup,
      keywords,
      icon: "eye",
      checked: false,
      run: () => setAppearance(value),
    });
    const lang = (value: Language, label: string, keywords: string[]): Action => ({
      id: `language:${value}`,
      label: tr(`Language: ${label}`, `语言：${label}`),
      group: viewGroup,
      keywords,
      icon: "sliders",
      checked: language() === value,
      run: () => setLanguage(value),
    });
    return [
      { id: "new", label: tr("New Session", "新建会话"), group: sessionGroup, keywords: ["new session"], shortcut: "mod+n", icon: "pencil", run: () => void newSession() },
      { id: "rename", label: tr("Rename Session…", "重命名会话…"), group: sessionGroup, keywords: ["rename session"], icon: "pencil", run: startRenaming },
      { id: "duplicate", label: tr("Duplicate Session", "复制会话"), group: sessionGroup, keywords: ["duplicate session"], icon: "copy", run: () => void duplicateSession() },
      ...(canArchiveCurrentSession()
        ? [
            isCurrentSessionArchived()
              ? {
                  id: "unarchive",
                  label: tr("Unarchive Session", "取消归档会话"),
                  group: sessionGroup,
                  keywords: ["unarchive", "restore", "archive", "取消归档", "恢复会话", "归档"],
                  icon: "unarchive" as const,
                  run: unarchiveCurrentSession,
                }
              : {
                  id: "archive",
                  label: tr("Archive Session", "归档会话"),
                  group: sessionGroup,
                  keywords: ["archive", "hide", "归档", "归档会话"],
                  icon: "archive" as const,
                  run: () => void archiveCurrentSession(),
                },
          ]
        : []),
      { id: "compact", label: tr("Compact Context", "压缩上下文"), group: sessionGroup, keywords: ["compact context"], icon: "compact", run: () => void compactNow() },
      { id: "copy", label: tr("Copy Last Reply", "复制最后一条回复"), group: sessionGroup, keywords: ["copy last reply"], icon: "copy", run: () => void copyLastReply() },
      { id: "export", label: tr("Export as HTML", "导出为 HTML"), group: sessionGroup, keywords: ["export html"], icon: "download", run: () => void exportHtml() },
      { id: "orchestrate", label: tr("Orchestrate Multiple Agents…", "多智能体协同编排…"), group: agentsGroup, keywords: ["orchestrate", "parallel", "pipeline", "delegate", "subagent", "swarm", "编排", "并行", "子智能体"], shortcut: "mod+shift+o", icon: "fork", run: () => setOrchestrateOpen(true) },
      { id: "agents-settings", label: tr("Configure External Coding Agents…", "配置外部编码智能体…"), group: agentsGroup, keywords: ["claude", "codex", "opencode", "cursor", "acp", "agents", "智能体"], icon: "agents", run: () => showSettings("agents") },
      ...availableAgents()
        .filter((a) => a.available)
        .map(
          (a): Action => ({
            id: `agent:${a.id}`,
            label: tr(`Agent: ${a.name}`, `智能体：${a.name}`),
            group: agentsGroup,
            keywords: [a.id, a.name, "agent", "harness", "switch", "切换智能体"],
            icon: "agents",
            checked: a.id === activeAgentId(),
            run: () => void switchAgentHarness(a.id),
          }),
        ),
      ...permissionModes.map(
        (m): Action => ({
          id: `permission:${m}`,
          label: tr(`Permissions: ${runtimeModeText(m).label}`, `权限上限：${runtimeModeText(m).label}`),
          group: agentsGroup,
          keywords: ["permission", "approval", "sandbox", "mode", m, "权限"],
          icon: runtimeModeIcon(m),
          checked: runtimeMode() === m,
          run: () => void changeRuntimeMode(m),
        }),
      ),
      { id: "folder", label: tr("Add Project Folder…", "添加项目文件夹…"), group: workspaceGroup, keywords: ["open folder", "add project", "workspace", "项目", "工作区"], shortcut: "mod+o", icon: "folderPlus", run: () => void chooseWorkspace() },
      ...(gitWorkspaceInfo().isGitRepo
        ? [
            {
              id: "worktree-new",
              label: tr("New Isolated Git Worktree Session", "新建独立 Git 工作树会话"),
              group: workspaceGroup,
              keywords: ["worktree", "git", "branch", "isolate", "工作树", "分支"],
              icon: "fork" as const,
              run: () => void createAndOpenWorktree("session"),
            },
          ]
        : []),
      { id: "restart", label: tr(`Restart ${activeAgent().name}`, `重启 ${activeAgent().name}`), group: workspaceGroup, keywords: ["restart", "pi", "agent"], icon: "refresh", run: () => void restartPi() },
      ...[...new Set([workspacePath(), ...recentWorkspaces()].filter(Boolean))].flatMap((cwd): Action[] => {
        const name = basename(cwd) || cwd;
        const short = tildePath(cwd, backend().home());
        return [
          {
            id: `workspace:${cwd}`,
            label: `${name} (${short})`,
            group: workspaceGroup,
            keywords: [name, short, "project", "workspace", "项目"],
            icon: "folder",
            checked: cwd === workspacePath(),
            run: () => void openWorkspace(cwd),
          },
          {
            id: `workspace-new:${cwd}`,
            label: tr(`New Session in ${name}`, `在 ${name} 中新建会话`),
            group: workspaceGroup,
            keywords: [name, "new session", "新建会话"],
            icon: "pencil",
            run: () => void newSessionInWorkspace(cwd),
          },
        ];
      }),
      { id: "settings", label: tr("Settings", "设置"), group: viewGroup, keywords: ["settings", "preferences", "language", "语言"], shortcut: "mod+,", icon: "sliders", run: () => showSettings() },
      { id: "archive-settings", label: tr("Archive", "归档管理"), group: viewGroup, keywords: ["archive", "conversation", "restore", "delete", "归档", "会话", "恢复", "删除"], icon: "archive", run: () => showSettings("archive") },
      ...(activeAgentId() === "pi"
        ? [{ id: "providers", label: tr("Providers", "服务商"), group: viewGroup, keywords: ["providers", "api key", "credentials", "login", "密钥"], icon: "plug" as IconName, run: () => showSettings("providers") }]
        : []),
      { id: "sidebar", label: sidebarOpen() ? tr("Hide Sidebar", "隐藏侧边栏") : tr("Show Sidebar", "显示侧边栏"), group: viewGroup, keywords: ["sidebar", "侧边栏"], shortcut: "mod+b", icon: "sidebar", run: () => setSidebarOpen(!sidebarOpen()) },
      { id: "random-wallpaper", label: tr("Random Wallpaper", "随机壁纸"), group: viewGroup, keywords: ["wallpaper", "background", "random", "shuffle", "壁纸", "背景", "随机壁纸"], shortcut: "mod+u", icon: "shuffle", run: () => void randomWallpaper() },
      theme("system", tr("System", "跟随系统"), ["theme", "appearance", "system"]),
      theme("light", tr("Light", "浅色"), ["theme", "appearance", "light"]),
      theme("dark", tr("Dark", "深色"), ["theme", "appearance", "dark"]),
      lang("system", tr("System", "跟随系统"), ["language", "locale", "system", "语言", "跟随系统"]),
      lang("en", "English", ["language", "locale", "english", "英文", "英语", "语言"]),
      lang("zh", "中文", ["language", "locale", "chinese", "zh", "中文", "汉语", "语言"]),
      ...thinkingLevels().map(
        (level): Action => ({
          id: `thinking:${level}`,
          label: tr(`Thinking: ${thinkingText(level).label}`, `思考深度：${thinkingText(level).label}`),
          group: tr("Thinking", "思考深度"),
          keywords: ["thinking", level],
          icon: "bolt",
          checked: level === sessionState()?.thinkingLevel,
          run: () => void chooseThinkingLevel(level),
        }),
      ),
      ...availableModels().map(
        (item): Action => ({
          id: `model:${item.provider}/${item.id}`,
          label: item.name || item.id,
          group: tr("Models", "模型"),
          keywords: [item.id, item.provider, "model", "模型"],
          icon: "chip",
          checked: `${item.provider}/${item.id}` === current,
          run: () => void chooseModel(item),
        }),
      ),
      ...[...new Set([workspacePath(), ...recentWorkspaces()].filter(Boolean))]
        .flatMap((cwd) => {
          const list = cwd === workspacePath() ? savedSessions() : (workspaceSessions()[cwd] ?? []);
          return list.map((session) => ({ cwd, session }));
        })
        .slice(0, 60)
        .map(({ cwd, session }): Action => {
          const folder = basename(cwd);
          const multi = recentWorkspaces().length > 1;
          const title = sessionTitle(session, tr("New session", "新会话"));
          return {
            id: `session:${cwd}:${session.path}`,
            label: multi && folder ? `${folder} / ${title}` : title,
            group: tr("Sessions", "历史会话"),
            keywords: [folder, title, "session"],
            icon: "message",
            checked: cwd === workspacePath() && session.path === sessionState()?.sessionFile,
            run: () => void openSession(session.path, cwd),
          };
        }),
      ...archivedSessionItems()
        .slice(0, 40)
        .map(({ cwd, session }): Action => {
          const folder = basename(cwd);
          const multi = recentWorkspaces().length > 1;
          const title = sessionTitle(session, tr("New session", "新会话"));
          return {
            id: `archived-session:${cwd}:${session.path}`,
            label: multi && folder ? `${folder} / ${title}` : title,
            group: tr("Archived Sessions", "已归档会话"),
            keywords: [folder, title, "archived", "session", "已归档", "归档"],
            icon: "archive",
            checked: cwd === workspacePath() && session.path === sessionState()?.sessionFile,
            run: () => void openSession(session.path, cwd),
          };
        }),
    ];
  });
  const byId = computed(() => new Map(actions().map((action) => [action.id, action])));
  const close = () => setPaletteOpen(false);
  return (
    <Dialog
      open={isPaletteOpen()}
      animation="fade"
      onOpenChange={({ open }) => setPaletteOpen(open)}
      backdropClass="bg-scrim"
      backdropStyle={GLASS_SCRIM}
      class="mx-auto mt-28 w-full max-w-150 px-4"
    >
      <View class={`overflow-hidden ${POPUP}`} style={{ ...GLASS_REGULAR, ...createMotion({ enter: DIALOG_RISE }).style }}>
        <Command
          items={actions()}
          placeholder={tr("Search actions, sessions and models", "搜索操作、会话和模型")}
          accessibilityLabel={tr("Commands", "命令面板")}
          autoFocus
          onCancel={close}
          onSelect={({ id }) => {
            close();
            byId().get(id)?.run();
          }}
          class="overflow-hidden"
          searchBarClass="h-12 flex-row items-center gap-2.5 border-b border-border px-4"
          searchPrefix={<Icon name="search" tone="subtle" />}
          searchClass="flex-1 text-md text-foreground caret-brand placeholder:text-subtle"
          listClass="max-h-96 p-1.5"
          groupClass="px-2.5 pb-1 pt-2.5 text-xs font-medium text-subtle"
          separatorClass="mx-1 my-1 h-px bg-border"
          itemClass={`group h-9 flex-row items-center rounded-lg px-2.5 ${PRESS} focus:bg-accent`}
          empty={<Text class="py-10 text-center text-sm text-muted-foreground">{tr("Nothing matches.", "无匹配结果。")}</Text>}
          renderItem={(entry) => (
            <View class="flex-1 flex-row items-center gap-2.5">
              <Icon name={byId().get(entry.id)?.icon ?? "dot"} tone="muted-foreground" />
              <Text class="flex-1 truncate text-base text-foreground">{entry.label}</Text>
              {entry.checked ? <Icon name="check" size={14} tone="brand-text" /> : null}
              {entry.shortcutLabel ? <Text class="text-xs text-subtle">{entry.shortcutLabel}</Text> : null}
            </View>
          )}
        />
      </View>
    </Dialog>
  );
}
