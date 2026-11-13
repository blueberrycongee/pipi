import { computed, createMotion, Scroll, signal, Text, View } from "nsh";
import { Button as BaseButton, Dialog, Input, Popover } from "nsh/base";
import { runtimeModeRank } from "../agents/catalog";
import type { RuntimeMode, WorkspaceIsolation } from "../agents/types";
import { formatAgentMeta, runtimeModeIcon, runtimeModeText, tr } from "../lib/i18n";
import {
  activeAgent,
  activeAgentId,
  availableAgents,
  changeRuntimeMode,
  composerDraft,
  currentRuntimeCeiling,
  focusComposer,
  gitWorkspaceInfo,
  isCompareOpen,
  launchCompareSessions,
  runtimeMode,
  setDraft,
  setCompareOpen,
  switchAgentHarness,
} from "../store/app";
import { backend } from "../store/backend";
import { worktreeIsolationDefault } from "../store/prefs";
import { AgentLogo } from "../ui/AgentLogo";
import { Button, Chip, IconButton } from "../ui/Button";
import { Switch } from "../ui/Controls";
import { Icon } from "../ui/Icon";
import { DIALOG_RISE, popupHiddenStyle, popupLeavingStyle, popupStyle } from "../ui/motion";
import { FIELD_SURFACE, FOCUS_RING, GLASS_REGULAR, POPUP, PRESS, SCRIM } from "../ui/styles";

const RUNTIME_MODES: readonly RuntimeMode[] = ["approval-required", "auto-accept-edits", "full-access"];

/**
 * The composer's Agent Harness chip (`Pi`, `Claude Code`, `Codex`, `OpenCode`, `Cursor`, or custom ACP).
 * Switching mid-conversation automatically prepares a Portable Context Handoff!
 */
export function AgentPicker() {
  const open = signal(false);
  const current = () => activeAgent();
  const pickerAgents = computed(() => {
    const all = availableAgents();
    const activeId = activeAgentId();
    const checking = (a: (typeof all)[number]) => (a.statusText ?? "").toLowerCase().includes("checking");
    return all.filter((a) => a.id === activeId || (a.enabled !== false && (a.available || checking(a))));
  });
  const close = () => {
    open.set(false);
    focusComposer();
  };
  return (
    <Popover
      open={open()}
      onOpenChange={(e) => open.set(e.open)}
      placement="top"
      align="start"
      offset={8}
      margin={12}
      popupClass={`w-76 p-1 ${POPUP}`}
      popupStyle={popupStyle("top", "start")}
      popupStartingStyle={popupHiddenStyle("top", "start")}
      popupEndingStyle={popupLeavingStyle("top", "start")}
      trigger={<Chip testID="agent-chip" leading={<AgentLogo id={current().id} size={14} />} label={current().name} />}
    >
      <Scroll class="max-h-80" testID="agent-picker">
        <Each of={pickerAgents()} key={(a) => a.id}>
          {(agent) => {
            const meta = () => formatAgentMeta(agent(), backend().home());
            return (
              <BaseButton
                selected={agent().id === activeAgentId()}
                onPress={() => {
                  close();
                  void switchAgentHarness(agent().id);
                }}
                class={`min-h-9 flex-row items-center gap-2.5 rounded-md px-2 py-1 ${PRESS} hover:bg-accent focus:bg-accent active:bg-accent`}
              >
                <AgentLogo id={agent().id} size={18} tone={agent().available ? "foreground" : "muted-foreground"} status={agent().available ? "ready" : "off"} />
                <View class="min-w-0 flex-1">
                  <View class="min-w-0 flex-row items-center gap-1.5">
                    <Text class={`shrink truncate text-base ${agent().available ? "text-foreground" : "text-muted-foreground"}`}>{agent().name}</Text>
                    <If when={meta().versionBadge}>
                      {(v) => <Text class="shrink-0 font-mono text-2xs text-subtle">{v()}</Text>}
                    </If>
                  </View>
                  <Text class="truncate text-xs text-subtle">{meta().statusLabel}</Text>
                </View>
                <View class="w-4 shrink-0 items-center">{agent().id === activeAgentId() ? <Icon name="check" size={14} tone="brand-text" /> : null}</View>
              </BaseButton>
            );
          }}
        </Each>
      </Scroll>
    </Popover>
  );
}

/** The composer's Runtime Permission Mode chip (`Supervised` / `Auto-edit` / `Full access`). */
export function PermissionPicker() {
  const open = signal(false);
  const mode = () => runtimeMode();
  const ceiling = () => currentRuntimeCeiling();
  const supported = () => activeAgent().supportedRuntimeModes;
  return (
    <Popover
      open={open()}
      onOpenChange={(e) => open.set(e.open)}
      placement="top"
      align="end"
      offset={8}
      margin={12}
      popupClass={`w-64 p-1 ${POPUP}`}
      popupStyle={popupStyle("top", "end")}
      popupStartingStyle={popupHiddenStyle("top", "end")}
      popupEndingStyle={popupLeavingStyle("top", "end")}
      trigger={<Chip icon={runtimeModeIcon(mode())} iconOnly label={`${runtimeModeText(mode()).label} — ${runtimeModeText(mode()).hint}`} tipText={`${runtimeModeText(mode()).label} — ${runtimeModeText(mode()).hint}`} />}
    >
      <Text class="px-2 pb-1 pt-1.5 text-xs font-medium text-subtle" role="header">
        {tr("Permissions", "运行权限")}
      </Text>
      <Each of={RUNTIME_MODES}>
        {(option) => {
          const allowed = () =>
            (supported().length === 0 || supported().includes(option())) &&
            runtimeModeRank(option()) <= runtimeModeRank(ceiling());
          return (
            <BaseButton
              disabled={!allowed()}
              selected={option() === mode()}
              onPress={() => {
                open.set(false);
                void changeRuntimeMode(option());
                focusComposer();
              }}
              class={`min-h-9 flex-row items-center gap-2 rounded-md px-2 py-1 ${PRESS} hover:bg-accent focus:bg-accent active:bg-accent disabled:opacity-45`}
            >
              <Icon name={runtimeModeIcon(option())} size={15} tone={option() === mode() ? "foreground" : "muted-foreground"} />
              <View class="min-w-0 flex-1">
                <Text class="truncate text-base text-foreground">{runtimeModeText(option()).label}</Text>
                <Text class="truncate text-xs text-subtle">{runtimeModeText(option()).hint}</Text>
              </View>
              <View class="w-4 shrink-0 items-center">{option() === mode() ? <Icon name="check" size={14} tone="brand-text" /> : null}</View>
            </BaseButton>
          );
        }}
      </Each>
    </Popover>
  );
}

/**
 * The compare dialog (`CompareDialog`): run the same task in several sessions at
 * once — each its own agent, nested under the current one in the sidebar — and
 * weigh the answers side by side. Delegation between sessions is the agents'
 * own job (`session_start`); this surface only starts the parallel runs.
 */
export function CompareDialog() {
  const taskPrompt = signal("");
  const parallelSelected = signal<Record<string, boolean>>({ pi: true, claude: true, codex: true });
  const useWorktree = signal(worktreeIsolationDefault());

  const installed = computed(() => availableAgents().filter((a) => a.available && a.enabled !== false));
  const effectiveTask = () => taskPrompt().trim() || composerDraft().trim();
  const close = () => setCompareOpen(false);

  const toggleParallel = (id: string) => {
    parallelSelected.update((cur) => ({ ...cur, [id]: !cur[id] }));
  };

  const chosenIds = computed(() =>
    installed()
      .map((a) => a.id)
      .filter((id) => parallelSelected()[id]),
  );

  const run = async () => {
    const promptText = effectiveTask();
    if (!promptText) return;
    const isolation: WorkspaceIsolation = useWorktree() && gitWorkspaceInfo().isGitRepo ? "worktree" : "shared";
    if (!taskPrompt().trim() && composerDraft().trim()) setDraft("");
    taskPrompt.set("");
    close();
    const ids = chosenIds().length ? chosenIds() : installed().slice(0, 2).map((a) => a.id);
    await launchCompareSessions({ prompt: promptText, agentIds: ids, isolation });
  };

  return (
    <Dialog
      open={isCompareOpen()}
      animation="fade"
      onOpenChange={({ open }) => setCompareOpen(open)}
      backdropClass={SCRIM}
      class="mx-auto mt-20 w-full max-w-150 px-4"
    >
      <View class={`gap-4 p-5 ${POPUP}`} style={{ ...GLASS_REGULAR, ...createMotion({ enter: DIALOG_RISE }).style }}>
        <View class="flex-row items-start justify-between gap-3">
          <View class="min-w-0 flex-1 gap-0.5">
            <Text class="text-lg font-semibold text-foreground" role="header">
              {tr("Compare Agents", "智能体并行对比")}
            </Text>
            <Text class="text-sm text-muted-foreground">
              {tr(
                "Run the same task in several sessions at once — each its own agent — then compare the answers side by side.",
                "把同一个任务交给多个智能体分别开新会话并行处理，再对比各自的回答。",
              )}
            </Text>
          </View>
          <IconButton icon="x" label={tr("Close", "关闭")} onPress={close} />
        </View>

        <Input
          multiline
          autoFocus
          value={taskPrompt()}
          onChange={({ value }) => taskPrompt.set(value)}
          placeholder={
            composerDraft().trim()
              ? tr(`Using composer draft: "${composerDraft().trim().slice(0, 56)}…"`, `将使用输入框草稿：「${composerDraft().trim().slice(0, 48)}…」`)
              : tr("Describe the task, files, and goal…", "描述要交给智能体执行的任务、目标与约束…")
          }
          accessibilityLabel={tr("Comparison task", "对比任务描述")}
          class={`min-h-22 rounded-xl p-3 text-base text-foreground caret-brand placeholder:text-subtle ${FIELD_SURFACE}`}
        />

        <View class="gap-2">
          <Text class="text-xs font-medium text-subtle">{tr("Agents to run side by side", "并行运行的编码智能体")}</Text>
          <View class="flex-row flex-wrap gap-2">
            <Each of={installed()} key={(a) => a.id}>
              {(agent) => {
                const on = () => !!parallelSelected()[agent().id];
                return (
                  <BaseButton
                    selected={on()}
                    onPress={() => toggleParallel(agent().id)}
                    class={`h-8 shrink-0 flex-row items-center gap-2 rounded-lg border px-3 ${PRESS} ${on() ? "border-brand bg-accent" : "border-border bg-card hover:bg-accent/50"}`}
                  >
                    <Icon name={on() ? "check" : "agents"} size={14} tone={on() ? "brand-text" : "muted-foreground"} />
                    <Text class="text-sm font-medium text-foreground">{agent().name}</Text>
                  </BaseButton>
                );
              }}
            </Each>
          </View>
        </View>

        <If when={gitWorkspaceInfo().isGitRepo}>
          <View class="flex-row items-center justify-between gap-3 rounded-xl border border-border bg-card px-3.5 py-2.5">
            <View class="min-w-0 flex-1 gap-0.5">
              <Text class="text-sm font-medium text-foreground">{tr("Isolate in Git worktrees", "Git 工作树分支隔离")}</Text>
              <Text class="text-xs text-subtle">
                {tr("Each agent works on its own pipi/* branch without touching your working tree.", "每个智能体在独立的 pipi/* 分支工作树上修改，互不干扰当前工作区。")}
              </Text>
            </View>
            <Switch label={tr("Isolate in Git worktrees", "Git 工作树隔离")} checked={useWorktree()} onChange={(on) => useWorktree.set(on)} />
          </View>
        </If>

        <View class="flex-row items-center justify-end gap-2 pt-1">
          <Button label={tr("Cancel", "取消")} variant="ghost" size="lg" onPress={close} />
          <Button label={tr("Launch Comparison", "开始并行对比")} variant="primary" size="lg" icon="agents" disabled={!effectiveTask()} onPress={() => void run()} />
        </View>
      </View>
    </Dialog>
  );
}
