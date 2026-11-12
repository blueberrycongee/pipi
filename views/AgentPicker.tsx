import { computed, createMotion, Scroll, signal, Text, View } from "nsh";
import { Button as BaseButton, Dialog, Input, Popover } from "nsh/base";
import type { DelegateRole, RuntimeMode, WorkspaceIsolation } from "../agents/types";
import { duration } from "../lib/format";
import { delegateRoleText, formatAgentMeta, runtimeModeIcon, runtimeModeText, tr } from "../lib/i18n";
import {
  activeAgent,
  activeAgentId,
  availableAgents,
  bringTaskResultToChat,
  cancelDelegatedTask,
  changeRuntimeMode,
  clearFinishedDelegatedTasks,
  composerDraft,
  delegatedTasks,
  focusComposer,
  gitWorkspaceInfo,
  inspectDelegatedTask,
  inspectingTaskId,
  isOrchestrateOpen,
  launchAgentPipeline,
  launchDelegatedTask,
  launchParallelAgents,
  runtimeMode,
  setDraft,
  setOrchestrateOpen,
  switchAgentHarness,
} from "../store/app";
import { backend } from "../store/backend";
import { worktreeIsolationDefault } from "../store/prefs";
import { AgentLogo } from "../ui/AgentLogo";
import { Button, Chip, IconButton } from "../ui/Button";
import { Segmented, Switch } from "../ui/Controls";
import { Icon } from "../ui/Icon";
import { DIALOG_RISE, keepLast, popupHiddenStyle, popupLeavingStyle, popupStyle, Presence, Reveal } from "../ui/motion";
import { FIELD_SURFACE, FOCUS_RING, GLASS_REGULAR, GLASS_SCRIM, POPUP, PRESS } from "../ui/styles";

const RUNTIME_MODES: readonly RuntimeMode[] = ["approval-required", "auto-accept-edits", "full-access"];
const ROLES: readonly DelegateRole[] = ["general", "researcher", "planner", "implementer", "reviewer"];

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
  const supported = () => activeAgent().supportedRuntimeModes;
  return (
    <Popover
      open={open()}
      onOpenChange={(e) => open.set(e.open)}
      placement="top"
      align="start"
      offset={8}
      margin={12}
      popupClass={`w-64 p-1 ${POPUP}`}
      popupStyle={popupStyle("top", "start")}
      popupStartingStyle={popupHiddenStyle("top", "start")}
      popupEndingStyle={popupLeavingStyle("top", "start")}
      trigger={<Chip icon={runtimeModeIcon(mode())} iconOnly label={`${runtimeModeText(mode()).label} — ${runtimeModeText(mode()).hint}`} tipText={`${runtimeModeText(mode()).label} — ${runtimeModeText(mode()).hint}`} />}
    >
      <Text class="px-2 pb-1 pt-1.5 text-xs font-medium text-subtle" role="header">
        {tr("Permission Ceiling", "运行权限上限")}
      </Text>
      <Each of={RUNTIME_MODES}>
        {(option) => {
          const allowed = () => supported().length === 0 || supported().includes(option());
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
 * Live Multi-Agent Sub-Agent Strip shown above the composer whenever background
 * or parallel/pipeline agents exist (modeled on t3code's `ProviderSubagentBar`).
 */
export function SubagentStrip() {
  const tasks = () => delegatedTasks();
  const shownTasks = keepLast(() => {
    const list = tasks();
    return list.length > 0 ? list : undefined;
  }, tasks());
  const hasDone = computed(() => (shownTasks() ?? []).some((t) => t.status !== "running"));
  return (
    <Reveal open={tasks().length > 0} offset={6}>
      <View class="w-full max-w-190 gap-1.5 self-center pb-2">
        <View class="flex-row items-center px-1">
          <Icon name="agents" size={14} tone="brand-text" />
          <Text class="ml-1.5 min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">{`${(shownTasks() ?? []).length}`}</Text>
          <Presence show={tasks().length > 0 && hasDone()}>
            <IconButton icon="trash" size="sm" label={tr("Clear finished", "清理已完成")} onPress={clearFinishedDelegatedTasks} />
          </Presence>
        </View>
        <View class="gap-1.5">
          <Each of={(shownTasks() ?? []).slice(0, 6)} key={(t) => t.id}>
            {(task) => {
              const active = () => inspectingTaskId() === task().id;
              const running = () => task().status === "running";
              const failed = () => task().status === "failed" || task().status === "cancelled";
              const elapsedMs = () => (task().completedAt ?? Date.now()) - task().startedAt;
              return (
                <View
                  class={`min-h-9 flex-row items-center gap-2 rounded-xl border px-3 py-1.5 ${active() ? "border-brand bg-accent" : "border-border bg-card"}`}
                >
                  <View class="size-4 shrink-0 items-center justify-center">
                    <If when={running()}>
                      <View class="size-3 rounded-full border-[1.5px] border-input border-t-brand motion-safe:animate-spin" />
                    </If>
                    <Presence show={task().status === "completed"}>
                      <Icon name="check" size={14} tone="success" />
                    </Presence>
                    <Presence show={failed()}>
                      <Icon name="x" size={14} tone="destructive" />
                    </Presence>
                  </View>
                  <BaseButton
                    onPress={() => inspectDelegatedTask(active() ? undefined : task().id)}
                    class={`min-w-0 flex-1 flex-row items-center gap-2 text-left ${PRESS}`}
                  >
                    <Text class="shrink-0 text-sm font-medium text-foreground">{task().agentName}</Text>
                    <Text class="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">{delegateRoleText(task().role)}</Text>
                    <If when={task().worktree}>
                      {(wt) => (
                        <View class="max-w-36 shrink-0 flex-row items-center gap-1 rounded-sm bg-muted px-1.5 py-0.5">
                          <Icon name="fork" size={11} tone="subtle" />
                          <Text class="shrink truncate font-mono text-2xs text-muted-foreground">{wt().branch}</Text>
                        </View>
                      )}
                    </If>
                    <Text class="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                      {running() ? task().activityLabel : task().summary.replace(/\s+/g, " ").slice(0, 90) || task().title}
                    </Text>
                  </BaseButton>
                  <If when={elapsedMs() >= 1000}>
                    <Text class="shrink-0 text-xs tabular-nums text-subtle">{duration(elapsedMs())}</Text>
                  </If>
                  <Presence show={!running() && !!task().summary}>
                    <BaseButton
                      onPress={() => bringTaskResultToChat(task().id)}
                      class={`h-6 shrink-0 flex-row items-center rounded-md bg-secondary px-2 ${PRESS} hover:bg-secondary/80`}
                    >
                      <Text class="text-xs font-medium text-secondary-foreground">{tr("Merge to Chat", "并入对话")}</Text>
                    </BaseButton>
                  </Presence>
                  <IconButton
                    icon={active() ? "arrowLeft" : "eye"}
                    size="sm"
                    label={active() ? tr("Back to main conversation", "返回主对话") : tr("Inspect sub-agent", "查看子智能体")}
                    onPress={() => inspectDelegatedTask(active() ? undefined : task().id)}
                  />
                  <Presence show={running()}>
                    <IconButton icon="stop" size="sm" label={tr("Stop sub-agent", "停止子智能体")} onPress={() => void cancelDelegatedTask(task().id)} />
                  </Presence>
                </View>
              );
            }}
          </Each>
        </View>
      </View>
    </Reveal>
  );
}

type WorkflowTab = "delegate" | "parallel" | "pipeline";

/**
 * Multi-Agent Orchestration Dialog (`OrchestrateDialog`):
 * Lets the user dispatch:
 * 1. **Delegate Sub-agent**: Send a focused task with a role (`Researcher`, `Planner`, `Implementer`, `Reviewer`) to any external or built-in agent.
 * 2. **Parallel Compare / Swarm**: Run 2+ coding agents side-by-side in isolated Git worktrees on the same task.
 * 3. **Plan → Implement → Review Pipeline**: Chain 3 specialized agents sequentially (e.g. Claude Code plans → Codex implements → Pi reviews).
 */
export function OrchestrateDialog() {
  const tab = signal<WorkflowTab>("parallel");
  const taskPrompt = signal("");
  const singleAgent = signal("claude");
  const singleRole = signal<DelegateRole>("reviewer");
  const parallelSelected = signal<Record<string, boolean>>({ pi: true, claude: true, codex: true });
  const plannerId = signal("claude");
  const implementerId = signal("codex");
  const reviewerId = signal("pi");
  const useWorktree = signal(worktreeIsolationDefault());

  const installed = computed(() => availableAgents().filter((a) => a.available && a.enabled !== false));
  const effectiveTask = () => taskPrompt().trim() || composerDraft().trim();
  const close = () => setOrchestrateOpen(false);

  const toggleParallel = (id: string) => {
    parallelSelected.update((cur) => ({ ...cur, [id]: !cur[id] }));
  };

  const chosenParallelIds = computed(() =>
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

    if (tab() === "delegate") {
      const target = installed().find((a) => a.id === singleAgent()) ?? installed()[0];
      if (!target) return;
      await launchDelegatedTask({
        title: `${target.name} · ${delegateRoleText(singleRole())}`,
        agentId: target.id,
        role: singleRole(),
        task: promptText,
        isolation,
        mode: "async",
      });
    } else if (tab() === "parallel") {
      const ids = chosenParallelIds().length ? chosenParallelIds() : installed().slice(0, 2).map((a) => a.id);
      await launchParallelAgents({
        prompt: promptText,
        agentIds: ids,
        role: "implementer",
        isolation,
      });
    } else {
      const fallback = installed()[0]?.id ?? "pi";
      const valid = (id: string) => (installed().some((a) => a.id === id) ? id : fallback);
      await launchAgentPipeline({
        prompt: promptText,
        plannerAgentId: valid(plannerId()),
        implementerAgentId: valid(implementerId()),
        reviewerAgentId: valid(reviewerId()),
        isolation,
      });
    }
  };

  return (
    <Dialog
      open={isOrchestrateOpen()}
      animation="fade"
      onOpenChange={({ open }) => setOrchestrateOpen(open)}
      backdropClass="bg-scrim"
      backdropStyle={GLASS_SCRIM}
      class="mx-auto mt-20 w-full max-w-150 px-4"
    >
      <View class={`gap-4 p-5 ${POPUP}`} style={{ ...GLASS_REGULAR, ...createMotion({ enter: DIALOG_RISE }).style }}>
        <View class="flex-row items-start justify-between gap-3">
          <View class="min-w-0 flex-1 gap-0.5">
            <Text class="text-lg font-semibold text-foreground" role="header">
              {tr("Multi-Agent Orchestration", "多智能体协同编排")}
            </Text>
            <Text class="text-sm text-muted-foreground">
              {tr("Run coding agents side by side or chain them in a sequential pipeline.", "跨多个编码智能体并行对比方案，或按阶段串联协作。")}
            </Text>
          </View>
          <IconButton icon="x" label={tr("Close", "关闭")} onPress={close} />
        </View>

        <Segmented
          fullWidth
          label={tr("Orchestration mode", "编排模式")}
          value={tab()}
          options={[
            { value: "parallel" as const, label: tr("Parallel", "并行对比") },
            { value: "pipeline" as const, label: tr("Plan → Build → Review", "规划 → 实现 → 审查") },
            { value: "delegate" as const, label: tr("Delegate", "委派子任务") },
          ]}
          onChange={(v) => tab.set(v)}
        />

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
          accessibilityLabel={tr("Orchestration task", "编排任务描述")}
          class={`min-h-22 rounded-xl p-3 text-base text-foreground caret-brand placeholder:text-subtle ${FIELD_SURFACE}`}
        />

        <If when={tab() === "parallel"}>
          <View class="gap-2">
            <Text class="text-xs font-medium text-subtle">
              {tr("Agents to run simultaneously", "同时运行的编码智能体")}
            </Text>
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
        </If>

        <If when={tab() === "pipeline"}>
          <View class="gap-2.5 rounded-xl border border-border bg-sunken p-3">
            <StageAgentSelector
              step={tr("1. Planner", "1. 规划师")}
              hint={tr("Read-only analysis & plan", "只读分析并生成方案")}
              value={plannerId()}
              onChange={(v) => plannerId.set(v)}
              agents={installed()}
            />
            <View class="h-px bg-border" />
            <StageAgentSelector
              step={tr("2. Implementer", "2. 实现者")}
              hint={tr("Writes code & runs checks", "按方案编写代码并验证")}
              value={implementerId()}
              onChange={(v) => implementerId.set(v)}
              agents={installed()}
            />
            <View class="h-px bg-border" />
            <StageAgentSelector
              step={tr("3. Reviewer", "3. 审查员")}
              hint={tr("Audits diff for regressions", "独立审查变更与潜在问题")}
              value={reviewerId()}
              onChange={(v) => reviewerId.set(v)}
              agents={installed()}
            />
          </View>
        </If>

        <If when={tab() === "delegate"}>
          <View class="gap-3 rounded-xl border border-border bg-sunken p-3">
            <StageAgentSelector
              step={tr("Target Agent", "目标智能体")}
              value={singleAgent()}
              onChange={(v) => singleAgent.set(v)}
              agents={installed()}
            />
            <View class="h-px bg-border" />
            <View class="flex-row items-center justify-between gap-3">
              <Text class="shrink-0 text-sm text-foreground">{tr("Role", "角色分工")}</Text>
              <View class="min-w-0 flex-1 flex-row flex-wrap justify-end gap-1">
                <Each of={ROLES}>
                  {(r) => (
                    <BaseButton
                      selected={singleRole() === r()}
                      onPress={() => singleRole.set(r())}
                      class={`h-7 shrink-0 justify-center rounded-md px-2.5 ${PRESS} ${singleRole() === r() ? "bg-secondary shadow-sm" : "bg-card hover:bg-accent"}`}
                    >
                      <Text class={`text-xs ${singleRole() === r() ? "font-medium text-secondary-foreground" : "text-muted-foreground"}`}>{delegateRoleText(r())}</Text>
                    </BaseButton>
                  )}
                </Each>
              </View>
            </View>
          </View>
        </If>

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
          <Button
            label={tr("Launch Agents", "启动编排")}
            variant="primary"
            size="lg"
            icon="agents"
            disabled={!effectiveTask()}
            onPress={() => void run()}
          />
        </View>
      </View>
    </Dialog>
  );
}

function StageAgentSelector(props: {
  step: string;
  hint?: string;
  value: string;
  onChange: (id: string) => void;
  agents: readonly { id: string; name: string }[];
}) {
  return (
    <View class="flex-row items-center justify-between gap-3">
      <View class="min-w-0 flex-1 gap-0.5">
        <Text class="text-sm font-medium text-foreground">{props.step}</Text>
        {props.hint ? <Text class="text-xs text-subtle">{props.hint}</Text> : null}
      </View>
      <View class="flex-row flex-wrap justify-end gap-1">
        <Each of={props.agents} key={(a) => a.id}>
          {(agent) => {
            const active = () => props.value === agent().id || (!props.agents.some((x) => x.id === props.value) && props.agents[0]?.id === agent().id);
            return (
              <BaseButton
                selected={active()}
                onPress={() => props.onChange(agent().id)}
                class={`h-7 shrink-0 flex-row items-center rounded-md px-2.5 ${PRESS} ${active() ? "bg-secondary shadow-sm" : "bg-card hover:bg-accent"}`}
              >
                <Text class={`text-xs ${active() ? "font-medium text-secondary-foreground" : "text-muted-foreground"}`}>{agent().name}</Text>
              </BaseButton>
            );
          }}
        </Each>
      </View>
    </View>
  );
}
