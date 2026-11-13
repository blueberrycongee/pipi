import { Canvas, effect, Overlay, signal, Text, token, View } from "nsh";
import type { InputRef } from "nsh";
import { Button as BaseButton, Input } from "nsh/base";
import { titleBar } from "nsh/desktop";
import { money } from "../lib/format";
import { tr } from "../lib/i18n";
import { compactNumber } from "../pi/transcript";
import {
  cancelRenaming,
  currentDaemonSession,
  currentParentSession,
  currentTitle,
  isCurrentSessionArchived,
  isRenaming,
  isRunning,
  newSession,
  openDaemonSession,
  openWorkspace,
  renameSession,
  sessionState,
  sessionStats,
  sidecarPhase,
  startRenaming,
  transcriptRows,
  unarchiveCurrentSession,
  wallpaper,
} from "../store/app";
import { setSidebarOpen, sidebarOpen } from "../store/prefs";
import { Button, Chip, IconButton } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { animateLayoutOn, enter, Presence } from "../ui/motion";
import { FIELD_SURFACE, FOCUS_RING, GLASS_REGULAR, HEADER_GLASS, PRESS } from "../ui/styles";
import { tip } from "../ui/Tip";

/** How full the model's context window is: a ring and a percentage. An engine
 * that reports no window still gets its used count in the tooltip, with the
 * ring left unfilled rather than a made-up share. */
function ContextMeter() {
  const usage = () => sessionStats()?.contextUsage;
  const percent = () => usage()?.percent ?? null;
  const visible = () => {
    const context = usage();
    if (!context || transcriptRows().length === 0) return false;
    const share = percent();
    return share === null ? (context.tokens ?? 0) > 0 : share >= 50;
  };
  const detail = () => {
    const stats = sessionStats();
    const context = usage();
    if (!stats || !context) return tr("Context", "上下文");
    const used = context.tokens === null ? "—" : compactNumber(context.tokens);
    const tokens =
      context.contextWindow === null
        ? tr(`${used} tokens in context`, `上下文已用 ${used} tokens`)
        : tr(
            `${used} of ${compactNumber(context.contextWindow)} tokens in context`,
            `上下文已用 ${used} / ${compactNumber(context.contextWindow)} tokens`,
          );
    return `${tokens} · ${tr(`${money(stats.cost)} this session`, `本会话 ${money(stats.cost)}`)}`;
  };
  return (
    <Presence show={visible()} scaleFrom={0.85}>
      <View class="h-6 flex-row items-center gap-1.5 rounded-md px-1.5" tooltip={tip(detail())} accessibilityLabel={detail()}>
        <Canvas
          style={{ width: 14, height: 14 }}
          draw={(cx, { width }) => {
            const middle = width / 2;
            const share = Math.min(1, (percent() ?? 0) / 100);
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

/** The bar over the main pane: what is open, and what can be done with it. It moves the window.
 * Over a wallpaper it is no band of its own: the picture runs up behind it to the window's edge,
 * and what it stands on is the chat's veil (`PaneVeil` in `views/Wallpaper.tsx`). */
export function TitleBar() {
  /** The session this one was started under — its label leads back there. */
  const parent = () => currentParentSession();
  const worktree = () => currentDaemonSession()?.worktree;
  animateLayoutOn(() => !!parent(), 220, () => !isRunning());
  return (
    <View
      desktop={{ windowDrag: true }}
      class={`absolute inset-x-0 top-0 z-20 flex-row items-center gap-1 pr-3 ${wallpaper() ? "" : HEADER_GLASS}`}
      style={{
        ...(wallpaper() ? undefined : GLASS_REGULAR),
        height: titleBar().height || 44,
        paddingLeft: sidebarOpen() ? 12 : (titleBar().left ? titleBar().left + 12 : 12),
      }}
    >
      <Presence show={!sidebarOpen()} scaleFrom={0.92} class="shrink-0 flex-row items-center gap-1">
        <IconButton icon="sidebar" label={tr("Show sidebar", "显示侧边栏")} shortcut="mod+b" onPress={() => setSidebarOpen(true)} />
        <IconButton icon="pencil" label={tr("New session", "新建会话")} shortcut="mod+n" onPress={() => void newSession()} />
      </Presence>
      <View class="min-w-0 shrink flex-row items-center gap-1">
        <Presence show={!!parent()} class="shrink-0">
          <If when={parent()}>
            {(up) => (
              <BaseButton
                onPress={() => openDaemonSession(up().id)}
                tooltip={tip(tr(`Back to ${up().title}`, `回到 ${up().title}`))}
                class={`h-6 max-w-44 shrink-0 flex-row items-center gap-1 rounded-md bg-muted px-1.5 ${PRESS} hover:bg-accent`}
              >
                <Icon name="arrowLeft" size={12} tone="subtle" />
                <Text class="shrink truncate text-2xs text-muted-foreground">{up().title}</Text>
              </BaseButton>
            )}
          </If>
        </Presence>
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
        <Presence show={!!worktree()}>
          <If when={worktree()}>
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
        </Presence>
      </View>
      <View class="flex-1" />
      <If when={sidecarPhase().name === "ready"}>
        <ContextMeter />
      </If>
    </View>
  );
}
