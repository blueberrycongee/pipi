import { Canvas, effect, Overlay, signal, Text, token, View } from "nsh";
import type { InputRef } from "nsh";
import { Button as BaseButton, Input } from "nsh/base";
import { titleBar } from "nsh/desktop";
import { money } from "../lib/format";
import { delegateRoleText, tr } from "../lib/i18n";
import { compactNumber } from "../pi/transcript";
import {
  bringTaskResultToChat,
  cancelRenaming,
  currentTitle,
  inspectDelegatedTask,
  inspectingTask,
  isCurrentSessionArchived,
  isRenaming,
  isRunning,
  newSession,
  openWorkspace,
  renameSession,
  sessionState,
  sessionStats,
  sidecarPhase,
  startRenaming,
  transcriptRows,
  unarchiveCurrentSession,
} from "../store/app";
import { setSidebarOpen, sidebarOpen } from "../store/prefs";
import { Button, Chip, IconButton } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { animateLayoutOn, enter, Presence } from "../ui/motion";
import { FIELD_SURFACE, FOCUS_RING, GLASS_REGULAR, HEADER_GLASS, PRESS } from "../ui/styles";
import { tip } from "../ui/Tip";

/** How full the model's context window is: a ring and a percentage. */
function ContextMeter() {
  const usage = () => sessionStats()?.contextUsage;
  const percent = () => usage()?.percent ?? 0;
  const detail = () => {
    const stats = sessionStats();
    const context = usage();
    if (!stats || !context) return tr("Context", "上下文");
    const used = context.tokens === null ? "—" : compactNumber(context.tokens);
    return tr(
      `${used} of ${compactNumber(context.contextWindow)} tokens in context · ${money(stats.cost)} this session`,
      `上下文已用 ${used} / ${compactNumber(context.contextWindow)} tokens · 本会话 ${money(stats.cost)}`,
    );
  };
  return (
    <Presence show={Boolean(usage() && percent() >= 50 && transcriptRows().length > 0)} scaleFrom={0.85}>
      <View class="h-6 flex-row items-center gap-1.5 rounded-md px-1.5" tooltip={tip(detail())} accessibilityLabel={detail()}>
        <Canvas
          style={{ width: 14, height: 14 }}
          draw={(cx, { width }) => {
            const middle = width / 2;
            const share = Math.min(1, percent() / 100);
            cx.lineWidth = 2;
            cx.lineCap = "round";
            cx.strokeStyle = token("input");
            cx.beginPath();
            cx.arc(middle, middle, middle - 1.5, 0, Math.PI * 2);
            cx.stroke();
            if (share > 0) {
              cx.strokeStyle = token(share > 0.85 ? "warning" : "muted-foreground");
              cx.beginPath();
              cx.arc(middle, middle, middle - 1.5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * share);
              cx.stroke();
            }
          }}
        />
      </View>
    </Presence>
  );
}

function SessionTitle() {
  const name = signal("");
  const anchor = signal<InputRef | undefined>(undefined);
  effect(() => {
    if (!isRenaming()) return;
    name.set(sessionState()?.sessionName ?? currentTitle());
  });
  // Leaving the field commits; Escape alone cancels.
  const commit = () => {
    if (isRenaming()) void renameSession(name());
  };
  return (
    <If
      when={isRenaming()}
      else={
        <BaseButton
          testID="session-title"
          onPress={startRenaming}
          disabled={sidecarPhase().name !== "ready"}
          tooltip={tip(tr("Rename session", "重命名会话"))}
          class={`h-7 min-w-0 shrink flex-row items-center rounded-md px-2 ${PRESS} ${FOCUS_RING} hover:bg-accent active:bg-accent`}
        >
          <Text class="max-w-150 shrink truncate text-base font-medium text-foreground">{currentTitle()}</Text>
        </BaseButton>
      }
    >
      <Input
        ref={(ref) => {
          if (ref) anchor.set(ref);
        }}
        value={name()}
        onChange={({ value }) => name.set(value)}
        onSubmit={commit}
        onBlur={commit}
        autoFocus
        accessibilityLabel={tr("Session name", "会话名称")}
        placeholder={tr("Name this session", "为会话命名")}
        class={`h-7 w-80 rounded-md px-2 text-base font-medium text-foreground caret-brand placeholder:text-subtle ${FIELD_SURFACE}`}
      />
      <If when={anchor()}>
        {(field) => <Overlay anchor={field()} onPressOutside={commit} onCancel={cancelRenaming} />}
      </If>
    </If>
  );
}

/** The bar over the main pane: what is open, and what can be done with it. It moves the window. */
export function TitleBar() {
  const subTask = () => inspectingTask();
  animateLayoutOn(() => !!subTask(), 220, () => !isRunning());
  return (
    <View
      desktop={{ windowDrag: true }}
      class={`absolute inset-x-0 top-0 z-20 flex-row items-center gap-1 pr-3 ${HEADER_GLASS}`}
      style={{
        ...GLASS_REGULAR,
        height: titleBar().height || 44,
        paddingLeft: sidebarOpen() ? 12 : (titleBar().left ? titleBar().left + 12 : 12),
      }}
    >
      <Presence show={!sidebarOpen()} scaleFrom={0.92} class="shrink-0 flex-row items-center gap-1">
        <IconButton icon="sidebar" label={tr("Show sidebar", "显示侧边栏")} shortcut="mod+b" onPress={() => setSidebarOpen(true)} />
        <IconButton icon="pencil" label={tr("New session", "新建会话")} shortcut="mod+n" onPress={() => void newSession()} />
      </Presence>
      <If
        when={subTask()}
        else={
          <View class="min-w-0 shrink flex-row items-center gap-1">
            <SessionTitle />
            <Presence show={isCurrentSessionArchived()}>
              <Chip
                testID="titlebar-archived-chip"
                label={tr("Archived", "已归档")}
                icon="unarchive"
                tipText={tr("Unarchive session", "取消归档此会话")}
                onPress={unarchiveCurrentSession}
                class="shrink-0 bg-muted text-muted-foreground"
              />
            </Presence>
          </View>
        }
      >
        {(sub) => (
          <View class="min-w-0 shrink flex-row items-center gap-1.5" style={enter("fadeIn")}>
            <IconButton icon="arrowLeft" label={tr("Back to main session", "返回主对话")} shortcut="escape" onPress={() => inspectDelegatedTask(undefined)} />
            <Icon name="agents" size={14} tone="brand-text" />
            <Text class="shrink-0 text-base font-medium text-foreground">{sub().agentName}</Text>
            <Text class="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">{delegateRoleText(sub().role)}</Text>
            <If when={sub().worktree}>
              {(wt) => (
                <BaseButton
                  onPress={() => void openWorkspace(wt().path)}
                  tooltip={tip(tr(`Open worktree ${wt().path}`, `打开工作树目录 ${wt().path}`))}
                  class={`h-6 max-w-36 shrink-0 flex-row items-center gap-1 rounded-md bg-muted px-1.5 ${PRESS} hover:bg-accent`}
                >
                  <Icon name="fork" size={11} tone="subtle" />
                  <Text class="shrink truncate font-mono text-2xs text-muted-foreground">{wt().branch}</Text>
                </BaseButton>
              )}
            </If>
            <Text class="min-w-0 shrink truncate text-sm text-muted-foreground">{sub().title}</Text>
          </View>
        )}
      </If>
      <View class="flex-1" />
      <If when={subTask()}>
        {(sub) => (
          <View class="shrink-0 flex-row items-center gap-1.5">
            <If when={sub().status !== "running" && !!sub().summary}>
              <Button label={tr("Merge to Chat", "并入主对话")} size="sm" variant="primary" onPress={() => bringTaskResultToChat(sub().id)} />
            </If>
            <Button label={tr("Back to Chat", "返回对话")} size="sm" variant="ghost" onPress={() => inspectDelegatedTask(undefined)} />
          </View>
        )}
      </If>
      <If when={!subTask() && sidecarPhase().name === "ready"}>
        <ContextMeter />
      </If>
    </View>
  );
}
