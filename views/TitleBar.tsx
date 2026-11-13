import { effect, Overlay, signal, Text, View } from "nsh";
import type { InputRef } from "nsh";
import { Button as BaseButton, Input } from "nsh/base";
import { titleBar } from "nsh/desktop";
import { tr } from "../lib/i18n";
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
  sidecarPhase,
  startRenaming,
  unarchiveCurrentSession,
  wallpaper,
} from "../store/app";
import { setSidebarOpen, sidebarOpen } from "../store/prefs";
import { Button, Chip, IconButton } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { animateLayoutOn, enter, Presence } from "../ui/motion";
import { FIELD_SURFACE, FOCUS_RING, GLASS_REGULAR, HEADER_GLASS, PRESS } from "../ui/styles";
import { tip } from "../ui/Tip";

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
        scrollbar={false}
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
    </View>
  );
}
