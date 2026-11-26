import {
  batch,
  cleanup,
  computed,
  createAnimatedValue,
  effect,
  reduceMotion,
  Scroll,
  signal,
  Text,
  untracked,
  View,
  type ScrollRef,
} from "nsh";
import { Button as BaseButton, Command, type CommandItem, Input, Popover } from "nsh/base";
import { runtimeModeRank } from "../agents/catalog";
import type { RuntimeMode } from "../agents/types";
import { basename, clip } from "../lib/format";
import { activeLanguage, formatAgentMeta, runtimeModeIcon, runtimeModeText, thinkingText, tr } from "../lib/i18n";
import { topBarHeight } from "../lib/layout";
import { collectTranscriptImages } from "../lib/media";
import { Pip } from "../mascot/Pip";
import type { ExtensionUiDialog, Model, ThinkingLevel } from "../pi/protocol";
import { providerName } from "../pi/providers";
import type { Row, ToolRow } from "../pi/transcript";
import { describeToolCall, elapsedSeconds, reasoningPreview } from "../pi/turns";
import { availableAgents, currentRuntimeCeiling, isChatFolder, placeLabel, showAgentSettings, wallpaper } from "../store/app";
import { backend } from "../store/backend";
import { docTabTitle } from "../store/docs";
import {
  closeSplit,
  focusedPane,
  focusPane,
  isSplitOpen,
  promoteSplitToPrimary,
  setSplitRatio,
  SPLIT_RATIO_DEFAULT,
  splitDrag,
  splitRatio,
  splitSide,
  splitTarget,
  swapSplitSide,
  workspaceBounds,
  type SplitSide,
  type SplitTarget,
} from "../store/split";
import { createSplitChatController, type SplitChatController } from "../store/split-chat";
import { AgentLogo } from "../ui/AgentLogo";
import { Button, Chip, IconButton } from "../ui/Button";
import { Icon } from "../ui/Icon";
import {
  DURATION,
  EASING,
  keepLast,
  PATIENCE_MS,
  popupHiddenStyle,
  popupLeavingStyle,
  popupStyle,
  Presence,
} from "../ui/motion";
import { RollingText } from "../ui/RollingText";
import { FOCUS_RING, GLASS_REGULAR, POPUP, PRESS } from "../ui/styles";
import { tip } from "../ui/Tip";
import { codeType, readingType, uiHeight, uiIconSize, uiRowHeight, uiType } from "../ui/typography";
import { Composer, type ComposerStore } from "./Composer";
import { DocEditor } from "./DocEditor";
import { isKnownMissingPath, MediaStreamContext } from "./Media";
import { ProseBlock, proseRows } from "./Prose";

const RUNTIME_MODES: readonly RuntimeMode[] = ["approval-required", "auto-accept-edits", "full-access"];
const modelKey = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;

// ── Drag-to-split drop-zone overlay ─────────────────────────────────────────

function DropZoneCard(props: { side: SplitSide; active: () => boolean }) {
  const isLeft = props.side === "left";
  const label = () => (isLeft ? tr("Add left split", "添加到左侧分屏") : tr("Add right split", "添加到右侧分屏"));
  const icon = isLeft ? "splitLeft" : "splitRight";
  const scale = createAnimatedValue(1);
  effect(() => {
    const on = props.active();
    untracked(() => {
      if (reduceMotion()) {
        scale.set(1);
        return;
      }
      void scale.timing(on ? 1.018 : 1, { duration: 120, easing: EASING.signature });
    });
  });
  cleanup(() => void scale.stop());

  return (
    <View
      testID={isLeft ? "split-drop-left" : "split-drop-right"}
      accessibilityLabel={label()}
      class={`items-center justify-center rounded-[18px] corner-squircle border-[1.5px] border-dashed transition-colors duration-150 ease-out-quint motion-reduce:transition-none ${
        props.active()
          ? "border-brand bg-brand-soft/80 shadow-composer dark:bg-brand-soft/45 dark:shadow-composer-dark"
          : "border-border bg-card/88 shadow-popover dark:bg-card/82"
      }`}
      style={{
        ...GLASS_REGULAR,
        position: "absolute",
        top: topBarHeight() + 18,
        bottom: 20,
        ...(isLeft ? { left: 20 } : { right: 20 }),
        width: "34%",
        maxWidth: 320,
        minWidth: 180,
        transform: [{ scale }],
      }}
    >
      <View class="items-center gap-2.5 px-4">
        <Icon name={icon} size={22} tone={props.active() ? "brand-text" : "muted-foreground"} />
        <Text
          class={`text-center ${uiType("base")} font-medium ${
            props.active() ? "text-brand-text" : "text-muted-foreground"
          }`}
        >
          {label()}
        </Text>
      </View>
    </View>
  );
}

/**
 * Arc/Dia-style split drop overlay shown over the workspace while a sidebar row
 * or tab pill is dragged into the canvas. Left and right dashed drop zones let
 * the user pick either half; releasing in the center gap cancels cleanly.
 */
export function SplitDropOverlay() {
  const active = computed(() => Boolean(splitDrag()?.overWorkspace));
  const mounted = signal(untracked(active));
  const opacity = createAnimatedValue(untracked(active) ? 1 : 0);
  let hideTimer: ReturnType<typeof setTimeout> | undefined;

  effect(() => {
    const on = active();
    untracked(() => {
      clearTimeout(hideTimer);
      if (reduceMotion()) {
        opacity.set(on ? 1 : 0);
        mounted.set(on);
        return;
      }
      if (on) {
        mounted.set(true);
        void opacity.timing(1, { duration: 130, easing: EASING.entrance });
      } else if (mounted()) {
        void opacity.timing(0, { duration: DURATION.instant, easing: EASING.exit });
        hideTimer = setTimeout(() => {
          hideTimer = undefined;
          if (!untracked(active)) mounted.set(false);
        }, DURATION.instant + 10);
      }
    });
  });
  cleanup(() => {
    clearTimeout(hideTimer);
    void opacity.stop();
  });

  const shownDrag = keepLast(() => (splitDrag()?.overWorkspace ? splitDrag() : undefined));

  const ghostPos = () => {
    const d = shownDrag();
    const rect = workspaceBounds();
    if (!d || !rect) return null;
    const left = Math.max(12, Math.min(rect.width - 212, d.x - rect.left + 14));
    const top = Math.max(12, Math.min(rect.height - 44, d.y - rect.top - 16));
    return { left, top };
  };

  return (
    <If when={mounted()}>
      <View
        testID="split-drop-overlay"
        class="pointer-events-none absolute inset-0 z-40 overflow-hidden"
        style={{ opacity }}
      >
        <DropZoneCard side="left" active={() => splitDrag()?.hoverSide === "left"} />
        <DropZoneCard side="right" active={() => splitDrag()?.hoverSide === "right"} />
        <If when={shownDrag() && ghostPos()}>
          {() => {
            const d = shownDrag()!;
            const pos = ghostPos()!;
            return (
              <View
                testID="split-drag-ghost"
                class={`pointer-events-none absolute max-w-56 flex-row items-center gap-2 rounded-lg corner-squircle px-2.5 py-1.5 ${POPUP}`}
                style={{ ...GLASS_REGULAR, left: pos.left, top: pos.top }}
              >
                {d.target.kind === "doc" ? (
                  <Icon name="file" size={13} tone="foreground" class="shrink-0" />
                ) : d.agentId ? (
                  <AgentLogo id={d.agentId} size={13} tone="foreground" />
                ) : (
                  <Icon name="terminal" size={13} tone="foreground" class="shrink-0" />
                )}
                <Text class={`min-w-0 flex-1 truncate ${uiType("sm")} font-medium text-foreground`}>{d.title}</Text>
              </View>
            );
          }}
        </If>
      </View>
    </If>
  );
}

// ── Draggable resize sash between primary and split panes ───────────────────

const sashDragging = signal(false);
let sashStartX = 0;
let sashStartRatio = SPLIT_RATIO_DEFAULT;

export const isSplitSashDragging = () => sashDragging();

export function notifySplitSashMove(pageX: number, pressed: boolean) {
  if (!untracked(sashDragging)) return;
  if (!pressed) {
    sashDragging.set(false);
    return;
  }
  const rect = workspaceBounds();
  if (!rect || rect.width <= 0) return;
  const delta = (pageX - sashStartX) / rect.width;
  const next = splitSide() === "left" ? sashStartRatio + delta : sashStartRatio - delta;
  setSplitRatio(next);
}

export function notifySplitSashUp(pageX?: number) {
  if (!untracked(sashDragging)) return;
  if (pageX !== undefined) notifySplitSashMove(pageX, true);
  sashDragging.set(false);
}

export function SplitResizeSash() {
  const hovered = signal(false);
  let hoverTimer: ReturnType<typeof setTimeout> | undefined;

  const clearHover = () => {
    if (hoverTimer !== undefined) {
      clearTimeout(hoverTimer);
      hoverTimer = undefined;
    }
  };
  cleanup(() => {
    clearHover();
    sashDragging.set(false);
  });

  return (
    <View
      testID="split-resize-sash"
      role="adjustable"
      focusable={false}
      desktop={{ windowDrag: false }}
      accessibilityLabel={tr("Split pane width", "分屏宽度")}
      class="relative z-20 w-[1px] shrink-0 bg-border/70"
      style={{ paddingTop: topBarHeight() }}
    >
      <View
        style={{ position: "absolute", top: topBarHeight(), bottom: 0, left: -4, width: 9, zIndex: 25, cursor: "col-resize" }}
        onMouseEnter={() => {
          if (sashDragging()) return;
          clearHover();
          hoverTimer = setTimeout(() => {
            hoverTimer = undefined;
            hovered.set(true);
          }, 120);
        }}
        onMouseLeave={() => {
          clearHover();
          if (!sashDragging()) hovered.set(false);
        }}
        onPressDown={(e) => {
          if (e.clickCount >= 2) {
            setSplitRatio(SPLIT_RATIO_DEFAULT);
            return;
          }
          clearHover();
          sashStartX = e.pagePosition.x;
          sashStartRatio = splitRatio();
          sashDragging.set(true);
        }}
        onPressUp={(e) => {
          notifySplitSashUp(e.pagePosition.x);
          hovered.set(false);
        }}
      >
        <View
          class={`pointer-events-none absolute inset-y-0 left-1 w-[2px] transition-opacity duration-150 ${
            sashDragging() ? "bg-brand/60" : "bg-foreground/18"
          }`}
          style={{ opacity: sashDragging() || hovered() ? 1 : 0 }}
        />
      </View>
    </View>
  );
}

// ── Split chat transcript & pickers ─────────────────────────────────────────

function SplitToolRow(props: { row: ToolRow }) {
  const open = signal(false);
  const info = () => describeToolCall(props.row, activeLanguage());
  const hasOutput = () => Boolean(props.row.output?.trim());

  return (
    <View class="w-full py-0.5">
      <BaseButton
        disabled={!hasOutput()}
        onPress={() => open.update((v) => !v)}
        class={`w-full flex-row items-center gap-1.5 rounded-md corner-squircle px-1.5 py-1 text-left ${
          hasOutput() ? `${PRESS} hover:bg-accent` : ""
        }`}
      >
        <Icon
          name={props.row.status === "running" ? "clock" : props.row.status === "error" ? "alert" : info().icon}
          size={13}
          tone={props.row.status === "running" ? "brand" : props.row.status === "error" ? "destructive" : "subtle"}
          class="shrink-0"
        />
        <Text class={`shrink-0 ${uiType("sm")} font-medium text-foreground`}>{info().verb}</Text>
        <If when={info().target}>
          <Text class={`min-w-0 flex-1 truncate font-mono ${uiType("xs")} text-muted-foreground`}>
            {info().target}
          </Text>
        </If>
        <If when={hasOutput()}>
          <Icon name={open() ? "chevronDown" : "chevronRight"} size={12} tone="subtle" class="shrink-0" />
        </If>
      </BaseButton>
      <If when={open() && hasOutput()}>
        <View class="mt-1 rounded-lg corner-squircle border-[0.5px] border-border bg-sunken px-3 py-2">
          <Text class={`select-text font-mono ${codeType()} leading-relaxed text-muted-foreground`}>
            {clip(props.row.output ?? "", 24, 3000).text}
          </Text>
        </View>
      </If>
    </View>
  );
}

function SplitThinkingRow(props: { text: string; streaming: boolean; durationMs?: number }) {
  const open = signal(false);
  const secs = () => (props.durationMs ? elapsedSeconds(props.durationMs) : 0);
  const label = () => {
    if (props.streaming) return tr("Thinking…", "正在思考…");
    const s = secs();
    return s > 0 ? tr(`Thought for ${s}s`, `思考了 ${s} 秒`) : tr("Thought", "已思考");
  };
  const preview = () => reasoningPreview(props.text);

  return (
    <View class="w-full py-0.5">
      <BaseButton
        onPress={() => open.update((v) => !v)}
        class={`w-full flex-row items-center gap-1.5 rounded-md corner-squircle px-1.5 py-1 text-left ${PRESS} hover:bg-accent`}
      >
        <Icon name="thinking" size={13} tone="subtle" class="shrink-0" />
        <Text class={`shrink-0 ${uiType("sm")} text-muted-foreground`}>{label()}</Text>
        <If when={!open() && preview()}>
          <Text class={`min-w-0 flex-1 truncate ${uiType("xs")} text-subtle`}>{preview()}</Text>
        </If>
        <Icon name={open() ? "chevronDown" : "chevronRight"} size={12} tone="subtle" class="shrink-0" />
      </BaseButton>
      <If when={open()}>
        <View class="mt-1 border-l-2 border-border pl-3">
          <Text class={`select-text ${readingType("sm")} leading-relaxed text-muted-foreground`}>
            {props.text}
          </Text>
        </View>
      </If>
    </View>
  );
}

function SplitRowItem(props: { row: Row }) {
  const r = () => props.row;
  if (r().kind === "user") {
    const user = r() as Extract<Row, { kind: "user" }>;
    if (!user.text.trim()) return null;
    return (
      <View class="w-full items-end pt-3 pb-1.5">
        <View class="max-w-[82%] rounded-2xl corner-squircle bg-secondary px-3.5 py-2">
          <Text class={`select-text ${readingType()} leading-relaxed text-secondary-foreground`}>
            {user.text}
          </Text>
        </View>
      </View>
    );
  }
  if (r().kind === "text") {
    const textRow = r() as Extract<Row, { kind: "text" }>;
    const blocks = () => proseRows({ id: textRow.id, text: textRow.text, streaming: textRow.streaming });
    return (
      <View class="w-full gap-1.5 py-1">
        <Each of={blocks()} key={(b) => b.id}>
          {(b) => <ProseBlock row={b()} />}
        </Each>
      </View>
    );
  }
  if (r().kind === "thinking") {
    const t = r() as Extract<Row, { kind: "thinking" }>;
    return <SplitThinkingRow text={t.text} streaming={t.streaming} durationMs={t.durationMs} />;
  }
  if (r().kind === "tool") {
    return <SplitToolRow row={r() as ToolRow} />;
  }
  if (r().kind === "notice") {
    const n = r() as Extract<Row, { kind: "notice" }>;
    const isErr = n.tone === "error";
    return (
      <View
        class={`my-1.5 flex-row items-start gap-2 rounded-xl corner-squircle border px-3 py-2 ${
          isErr ? "border-destructive/30 bg-destructive/8" : "border-border bg-card"
        }`}
      >
        <Icon name={isErr ? "alert" : "info"} size={14} tone={isErr ? "destructive" : "subtle"} class="mt-0.5 shrink-0" />
        <View class="min-w-0 flex-1 gap-0.5">
          <Text class={`${uiType("sm")} font-medium ${isErr ? "text-destructive" : "text-foreground"}`}>{n.title}</Text>
          <If when={n.text}>
            <Text class={`select-text ${uiType("xs")} text-muted-foreground`}>
              {n.text}
            </Text>
          </If>
        </View>
      </View>
    );
  }
  return null;
}

function SplitDialogPrompt(props: { dialog: ExtensionUiDialog; onAnswer: (id: string, answer: any) => void }) {
  const inputVal = signal("");
  const d = props.dialog;

  if (d.method === "form") return null;

  return (
    <View class={`mb-2 gap-2.5 rounded-2xl corner-squircle border-[0.5px] border-hairline bg-card/90 p-3 shadow-popover`}>
      <View class="gap-1">
        <Text class={`${uiType("base")} font-medium text-foreground`}>{d.title}</Text>
        <If when={d.method === "confirm" && d.message}>
          <Text class={`select-text ${uiType("xs")} text-muted-foreground`}>
            {(d as Extract<ExtensionUiDialog, { method: "confirm" }>).message}
          </Text>
        </If>
      </View>
      <If when={d.method === "confirm"}>
        <View class="flex-row justify-end gap-2">
          <Button size="sm" variant="secondary" label={tr("Deny", "拒绝")} onPress={() => props.onAnswer(d.id, { confirmed: false })} />
          <Button size="sm" variant="primary" label={tr("Allow", "允许")} onPress={() => props.onAnswer(d.id, { confirmed: true })} />
        </View>
      </If>
      <If when={d.method === "select"}>
        <View class="gap-1">
          <Each of={(d as Extract<ExtensionUiDialog, { method: "select" }>).options} key={(opt) => opt}>
            {(opt) => (
              <BaseButton
                onPress={() => props.onAnswer(d.id, { value: opt() })}
                class={`${uiHeight(28)} rounded-md corner-squircle px-2.5 text-left hover:bg-accent ${PRESS}`}
              >
                <Text class={`${uiType("sm")} text-foreground`}>{opt()}</Text>
              </BaseButton>
            )}
          </Each>
        </View>
      </If>
      <If when={d.method === "input"}>
        <View class="flex-row items-center gap-2">
          <Input
            value={inputVal()}
            onChange={({ value }) => inputVal.set(value)}
            onSubmit={() => props.onAnswer(d.id, { value: inputVal() })}
            placeholder={(d as Extract<ExtensionUiDialog, { method: "input" }>).placeholder ?? ""}
            class={`flex-1 rounded-lg corner-squircle border border-input bg-background px-2.5 py-1.5 ${uiType("sm")} text-foreground`}
          />
          <Button size="sm" variant="primary" label={tr("Submit", "提交")} onPress={() => props.onAnswer(d.id, { value: inputVal() })} />
        </View>
      </If>
    </View>
  );
}

// ── Split chat pickers (Agent, Model, Thinking, Permission) ─────────────────

function SplitAgentPicker(props: { chat: SplitChatController; onOpen?: () => void }) {
  const open = signal(false);
  const current = () => props.chat.agent();
  const list = () => availableAgents().filter((a) => a.available);

  return (
    <Popover
      open={open()}
      onOpenChange={(e) => {
        if (e.open) props.onOpen?.();
        open.set(e.open);
      }}
      placement="top"
      align="start"
      offset={8}
      margin={12}
      popupClass={`w-56 p-1 ${POPUP}`}
      popupStyle={popupStyle("top", "start")}
      popupStartingStyle={popupHiddenStyle("top", "start")}
      popupEndingStyle={popupLeavingStyle("top", "start")}
      trigger={
        <BaseButton
          accessibilityLabel={tr("Switch split agent", "切换分屏智能体")}
          tooltip={tip(current().name)}
          class={`${uiHeight(24)} max-w-28 shrink-0 overflow-hidden flex-row items-center gap-1.5 rounded-md corner-squircle px-1.5 hover:bg-accent ${PRESS} ${FOCUS_RING}`}
        >
          <View class="shrink-0">
            <AgentLogo id={current().id} size={13} tone="foreground" />
          </View>
          <Text class={`min-w-0 shrink truncate ${uiType("xs")} font-medium text-foreground`}>{current().name}</Text>
        </BaseButton>
      }
    >
      <Scroll class="max-h-60">
        <Each of={list()} key={(a) => a.id}>
          {(a) => {
            const active = () => a().id === props.chat.agentId();
            return (
              <BaseButton
                onPress={() => {
                  open.set(false);
                  void props.chat.chooseAgent(a().id);
                }}
                class={`${uiRowHeight(28)} w-full flex-row items-center gap-2 rounded-md corner-squircle px-2 hover:bg-accent ${PRESS}`}
              >
                <AgentLogo id={a().id} size={14} tone="foreground" />
                <Text class={`min-w-0 flex-1 truncate ${uiType("sm")} ${active() ? "font-medium text-foreground" : "text-muted-foreground"}`}>
                  {a().name}
                </Text>
                <If when={active()}>
                  <Icon name="check" size={13} tone="brand-text" />
                </If>
              </BaseButton>
            );
          }}
        </Each>
      </Scroll>
    </Popover>
  );
}

function SplitModelPicker(props: { chat: SplitChatController; onOpen?: () => void }) {
  const open = signal(false);
  const query = signal("");
  const current = () => props.chat.currentModel();
  const currentKey = () => (current() ? modelKey(current()!) : "");
  const models = () => props.chat.availableModels();
  const byKey = computed(() => new Map<string, Model>(models().map((m) => [modelKey(m), m])));
  const items = computed<CommandItem[]>(() =>
    models().map((m) => ({
      id: modelKey(m),
      label: m.name || m.id,
      keywords: [m.id, m.provider, providerName(m.provider)],
      group: providerName(m.provider),
      checked: modelKey(m) === currentKey(),
    })),
  );

  return (
    <Popover
      open={open()}
      onOpenChange={(e) => {
        if (e.open) {
          props.onOpen?.();
          query.set("");
        }
        open.set(e.open);
      }}
      placement="top"
      align="start"
      offset={8}
      margin={12}
      popupClass={`w-64 overflow-hidden ${POPUP}`}
      popupStyle={popupStyle("top", "start")}
      popupStartingStyle={popupHiddenStyle("top", "start")}
      popupEndingStyle={popupLeavingStyle("top", "start")}
      trigger={
        <Chip
          label={current()?.name || current()?.id || tr("Model", "模型")}
          tipText={tr("Switch split model", "切换分屏模型")}
          onPress={() => open.update((v) => !v)}
          class="min-w-0 max-w-36 shrink"
        />
      }
    >
      <If
        when={models().length > 0}
        else={
          <View class="items-center gap-2 p-4">
            <Text class={`${uiType("xs")} text-muted-foreground`}>{tr("No models available", "暂无可用模型")}</Text>
            <Button
              size="sm"
              variant="secondary"
              label={tr("Configure", "去配置")}
              onPress={() => {
                open.set(false);
                showAgentSettings(props.chat.agentId());
              }}
            />
          </View>
        }
      >
        <Command
          items={items()}
          query={query()}
          onQueryChange={(event) => query.set(event.query)}
          placeholder={tr("Search models…", "搜索模型…")}
          accessibilityLabel={tr("Split models", "分屏模型")}
          onCancel={() => open.set(false)}
          onSelect={(item) => {
            open.set(false);
            const chosen = byKey().get(item.id);
            if (chosen) void props.chat.chooseModel(chosen);
          }}
          class="max-h-72"
        />
      </If>
    </Popover>
  );
}

function SplitThinkingPicker(props: { chat: SplitChatController; onOpen?: () => void }) {
  const open = signal(false);
  const levels = () => props.chat.thinkingLevels();
  const show = () => Boolean(props.chat.currentModel()?.reasoning) && levels().length > 1;
  const current = () => props.chat.thinkingLevel();

  return (
    <If when={show()}>
      <Popover
        open={open()}
        onOpenChange={(e) => {
          if (e.open) props.onOpen?.();
          open.set(e.open);
        }}
        placement="top"
        align="start"
        offset={8}
        margin={12}
        popupClass={`w-44 p-1 ${POPUP}`}
        popupStyle={popupStyle("top", "start")}
        popupStartingStyle={popupHiddenStyle("top", "start")}
        popupEndingStyle={popupLeavingStyle("top", "start")}
        trigger={
          <Chip
            label={thinkingText(current()).label}
            tipText={tr("Thinking level", "思考深度")}
            onPress={() => open.update((v) => !v)}
          />
        }
      >
        <Each of={levels()} key={(l) => l}>
          {(level) => {
            const active = () => level() === current();
            return (
              <BaseButton
                onPress={() => {
                  open.set(false);
                  void props.chat.chooseThinkingLevel(level());
                }}
                class={`${uiRowHeight(28)} w-full flex-row items-center justify-between rounded-md corner-squircle px-2 hover:bg-accent ${PRESS}`}
              >
                <Text class={`${uiType("sm")} ${active() ? "font-medium text-foreground" : "text-muted-foreground"}`}>
                  {thinkingText(level()).label}
                </Text>
                <If when={active()}>
                  <Icon name="check" size={13} tone="brand-text" />
                </If>
              </BaseButton>
            );
          }}
        </Each>
      </Popover>
    </If>
  );
}

function SplitPermissionPicker(props: { chat: SplitChatController; onOpen?: () => void }) {
  const open = signal(false);
  const current = () => props.chat.runtimeMode();
  const ceiling = () => currentRuntimeCeiling();
  const supported = () => {
    const raw = props.chat.agent().supportedRuntimeModes;
    return RUNTIME_MODES.filter(
      (m) => runtimeModeRank(m) <= runtimeModeRank(ceiling()) && (raw.length === 0 || raw.includes(m)),
    );
  };

  return (
    <Popover
      open={open()}
      onOpenChange={(e) => {
        if (e.open) props.onOpen?.();
        open.set(e.open);
      }}
      placement="top"
      align="end"
      offset={8}
      margin={12}
      popupClass={`w-52 p-1 ${POPUP}`}
      popupStyle={popupStyle("top", "end")}
      popupStartingStyle={popupHiddenStyle("top", "end")}
      popupEndingStyle={popupLeavingStyle("top", "end")}
      trigger={
        <IconButton
          icon={runtimeModeIcon(current())}
          size="sm"
          tone="subtle"
          label={runtimeModeText(current()).label}
          tipPlacement="top"
          onPress={() => open.update((v) => !v)}
        />
      }
    >
      <Each of={supported()} key={(m) => m}>
        {(mode) => {
          const active = () => mode() === current();
          const info = () => runtimeModeText(mode());
          return (
            <BaseButton
              onPress={() => {
                open.set(false);
                void props.chat.chooseRuntimeMode(mode());
              }}
              class={`w-full flex-row items-center gap-2 rounded-md corner-squircle px-2 py-1.5 hover:bg-accent ${PRESS}`}
            >
              <Icon name={runtimeModeIcon(mode())} size={14} tone={active() ? "brand-text" : "muted-foreground"} />
              <View class="min-w-0 flex-1">
                <Text class={`${uiType("sm")} ${active() ? "font-medium text-foreground" : "text-foreground"}`}>
                  {info().label}
                </Text>
              </View>
              <If when={active()}>
                <Icon name="check" size={13} tone="brand-text" />
              </If>
            </BaseButton>
          );
        }}
      </Each>
    </Popover>
  );
}

// ── Live split chat view ────────────────────────────────────────────────────

function SplitChatView(props: { chat: SplitChatController }) {
  let scrollRef: ScrollRef | null = null;
  const following = signal(true);
  const waitVisible = signal(false);
  effect(() => {
    const waiting = props.chat.loading() && props.chat.rows().length === 0;
    if (!waiting) {
      waitVisible.set(false);
      return;
    }
    const timer = setTimeout(() => waitVisible.set(true), PATIENCE_MS);
    cleanup(() => clearTimeout(timer));
  });

  const activityText = () => {
    const dialog = props.chat.pendingDialog();
    if (dialog) return tr("Waiting for confirmation", "等待确认");
    const act = props.chat.activity();
    switch (act.kind) {
      case "compacting":
        return tr("Compacting context", "正在压缩上下文");
      case "retrying":
        return tr(`Retrying (${act.attempt})`, `正在重试（第 ${act.attempt} 次）`);
      case "writing":
        return tr("Writing", "正在回复");
      case "tool":
        return tr(`Running ${act.name}`, `正在执行 ${act.name}`);
      case "thinking":
        return tr("Thinking", "正在思考");
      default:
        return "";
    }
  };

  // Auto-follow bottom while reading at tail.
  effect(() => {
    props.chat.rows();
    props.chat.running();
    if (!untracked(following)) return;
    queueMicrotask(() => {
      scrollRef?.scrollToEnd({ animated: false });
    });
  });

  const hasRows = () => props.chat.rows().length > 0;

  const composerStore: ComposerStore = {
    isActive: () => isSplitOpen(),
    isFocused: () => isSplitOpen() && focusedPane() === "split",
    onFocusPane: () => focusPane("split"),
    draft: props.chat.draft,
    setDraft: props.chat.setDraft,
    attachments: props.chat.attachments,
    addAttachment: props.chat.addAttachment,
    removeAttachment: props.chat.removeAttachment,
    files: props.chat.files,
    attachLocalPath: props.chat.attachLocalPath,
    removeFileAttachment: props.chat.removeFileAttachment,
    pickFile: props.chat.pickFile,
    docs: props.chat.docs,
    attachDocPath: props.chat.attachDocPath,
    detachDoc: props.chat.detachDoc,
    focusTick: props.chat.focusTick,
    requestFocus: props.chat.requestFocus,
    ready: () => !props.chat.error(),
    canSend: () => !props.chat.error(),
    failed: () => Boolean(props.chat.error()),
    hasModel: () => Boolean(props.chat.currentModel() || props.chat.availableModels().length > 0),
    visionSupported: () => Boolean(props.chat.currentModel()?.input?.includes("image")),
    running: props.chat.running,
    working: props.chat.running,
    agentName: props.chat.agentName,
    slashCommands: props.chat.slashCommands,
    pendingDialog: props.chat.pendingDialog,
    answerDialog: props.chat.answerDialog,
    contextUsage: () => ({ stats: props.chat.sessionStats(), hasRows: props.chat.rows().length > 0 }),
    send: async (mode) => {
      following.set(true);
      await props.chat.send(mode);
    },
    stop: props.chat.stop,
    renderLeftPickers: (dismissMenus) => (
      <>
        <SplitAgentPicker chat={props.chat} onOpen={dismissMenus} />
        <View class="mx-0.5 h-3 w-[0.5px] bg-hairline-hover" />
        <SplitModelPicker chat={props.chat} onOpen={dismissMenus} />
        <SplitThinkingPicker chat={props.chat} onOpen={dismissMenus} />
      </>
    ),
    renderPermissionPicker: (dismissMenus) => <SplitPermissionPicker chat={props.chat} onOpen={dismissMenus} />,
    renderExtensionPrompt: () => (
      <If when={props.chat.pendingDialog()?.method !== "form" ? props.chat.pendingDialog() : undefined}>
        {(dialog) => <SplitDialogPrompt dialog={dialog()} onAnswer={props.chat.answerDialog} />}
      </If>
    ),
    inputTestID: "split-composer-input",
    inputLabel: tr("Split message", "分屏消息"),
    sendTestID: "split-send",
    stopTestID: "split-stop",
    autoFocus: false,
  };

  return (
    <View
      class="relative min-h-0 flex-1"
      onFileDrop={(e) => {
        for (const uri of e.uris) {
          const path = decodeURIComponent(uri.replace(/^file:\/\//, ""));
          if (path) void props.chat.attachLocalPath(path);
        }
      }}
    >
      <If
        when={hasRows()}
        else={
          <View class="flex-1 items-center justify-center gap-4 px-6 pb-8">
            <Pip size={64} mood={props.chat.mood()} />
            <View class="items-center gap-1">
              <Text class={`text-center ${uiType("lg")} font-semibold tracking-tight text-foreground`}>
                {waitVisible() ? tr("Loading session…", "正在加载会话…") : tr("Split chat", "分屏对话")}
              </Text>
              <Text class={`text-center ${uiType("xs")} text-subtle`}>
                {`${props.chat.agentName()} · ${placeLabel(props.chat.cwd())}`}
              </Text>
            </View>
            <If when={props.chat.error()}>
              {(err) => (
                <Text class={`max-w-72 text-center ${uiType("xs")} text-destructive`}>{err()}</Text>
              )}
            </If>
          </View>
        }
      >
        <MediaStreamContext.Provider
          value={() =>
            collectTranscriptImages(untracked(props.chat.rows), {
              cwd: untracked(props.chat.cwd),
              home: backend().home(),
              isMissingPath: isKnownMissingPath,
            })
          }
        >
        <Scroll
          ref={(ref) => {
            scrollRef = ref;
          }}
          accessibilityLabel={tr("Split conversation", "分屏对话内容")}
          class="min-h-0 flex-1"
          contentClass="px-5 pt-3 pb-4"
          onScroll={(e) => {
            const distFromBottom = e.contentSize.height - (e.offset.y + e.size.height);
            following.set(distFromBottom <= 48);
          }}
        >
          <View class="mx-auto w-full max-w-180">
            <Each of={props.chat.rows()} key={(r) => r.id}>
              {(r) => <SplitRowItem row={r()} />}
            </Each>
            <View class="h-9 justify-center">
              <Presence show={props.chat.running() || props.chat.mood() === "happy"} scaleFrom={0.96} duration={150}>
                <View class="flex-row items-center gap-2 pt-1">
                  <Pip size={20} mood={props.chat.mood()} />
                  <If when={activityText()}>
                    <RollingText text={activityText} class={`${uiType("xs")} text-muted-foreground`} />
                  </If>
                </View>
              </Presence>
            </View>
          </View>
        </Scroll>
        </MediaStreamContext.Provider>
      </If>

      {/* Jump to latest button when scrolled up */}
      <If when={hasRows() && !following()}>
        <View class="pointer-events-none absolute inset-x-0 bottom-28 z-10 items-center">
          <BaseButton
            onPress={() => {
              following.set(true);
              scrollRef?.scrollToEnd({ animated: !reduceMotion() });
            }}
            class={`pointer-events-auto flex-row items-center gap-1 rounded-full border-[0.5px] border-hairline bg-popover/95 px-2.5 py-1 shadow-popover ${PRESS}`}
          >
            <Icon name="chevronDown" size={12} tone="muted-foreground" />
            <Text class={`${uiType("xs")} text-muted-foreground`}>{tr("Jump to latest", "回到底部")}</Text>
          </BaseButton>
        </View>
      </If>

      {/* Unified Composer — exact same component & capabilities as the primary pane */}
      <Composer store={composerStore} />
    </View>
  );
}

// ── Split pane shell ────────────────────────────────────────────────────────

function splitHeaderMeta(target: SplitTarget, chat: SplitChatController | undefined) {
  if (target.kind === "doc") {
    return {
      title: docTabTitle(target.path),
      subtitle: basename(target.path),
      agentId: undefined as string | undefined,
    };
  }
  const cwd = chat ? chat.cwd() : target.cwd ?? "";
  return {
    title: chat ? chat.title() : target.title || tr("New session", "新会话"),
    subtitle: cwd && !isChatFolder(cwd) ? basename(cwd) : "",
    agentId: chat ? chat.agentId() : target.agentId,
  };
}

/**
 * The secondary split pane mounted beside the primary workspace (`left` or
 * `right`). Supports live concurrent chat sessions and Markdown documents.
 */
export function SplitPane() {
  const controller = signal<SplitChatController | undefined>(undefined);
  let lastKey = "";

  effect(() => {
    const target = splitTarget();
    untracked(() => {
      if (!target || target.kind !== "chat") {
        controller()?.dispose();
        controller.set(undefined);
        lastKey = "";
        return;
      }
      const nextKey = target.file || target.ref;
      if (nextKey === lastKey && controller()) return;
      controller()?.dispose();
      lastKey = nextKey;
      controller.set(createSplitChatController(target));
    });
  });

  cleanup(() => {
    controller()?.dispose();
    controller.set(undefined);
  });

  const isFocused = () => focusedPane() === "split";
  const widthPercent = (): `${number}%` => `${Number((splitRatio() * 100).toFixed(2))}%`;

  return (
    <If when={splitTarget()}>
      {(target) => {
        const meta = () => splitHeaderMeta(target(), controller());
        const chat = () => controller();
        return (
          <View
            testID="split-pane"
            accessibilityLabel={
              splitSide() === "left" ? tr("Left split pane", "左侧分屏") : tr("Right split pane", "右侧分屏")
            }
            class={`relative min-w-0 shrink-0 ${wallpaper() ? "bg-background/88" : "bg-background"}`}
            style={{
              width: widthPercent(),
              minWidth: 280,
              paddingTop: topBarHeight(),
            }}
            onPressDown={() => focusPane("split")}
          >
            {/* Slim split-pane header */}
            <View
              class={`h-9 shrink-0 flex-row items-center justify-between gap-2 border-b px-3 ${
                isFocused() ? "border-brand/35" : "border-border/60"
              }`}
            >
              <View class="min-w-0 flex-1 flex-row items-center gap-1.5">
                <If when={isFocused()}>
                  <View class="size-1.5 shrink-0 rounded-full bg-brand" />
                </If>
                {target().kind === "doc" ? (
                  <Icon name="file" size={uiIconSize(13)} tone="muted-foreground" class="shrink-0" />
                ) : meta().agentId ? (
                  <AgentLogo id={meta().agentId!} size={uiIconSize(13)} tone="foreground" />
                ) : (
                  <Icon name="terminal" size={uiIconSize(13)} tone="subtle" class="shrink-0" />
                )}
                <Text testID="split-pane-title" class={`min-w-0 shrink truncate ${uiType("sm")} font-medium text-foreground`}>
                  {meta().title}
                </Text>
                <If when={meta().subtitle}>
                  <Text class={`shrink-0 truncate ${uiType("2xs")} text-subtle`}>{meta().subtitle}</Text>
                </If>
              </View>
              <View class="shrink-0 flex-row items-center gap-0.5">
                <IconButton
                  testID="split-swap"
                  icon="swap"
                  size="sm"
                  label={tr("Swap split sides", "交换左右分屏")}
                  onPress={swapSplitSide}
                />
                <IconButton
                  testID="split-promote"
                  icon="expand"
                  size="sm"
                  label={tr("Open in main pane", "在主视图中打开")}
                  onPress={() => {
                    const c = chat();
                    promoteSplitToPrimary(
                      c
                        ? {
                            file: c.sessionFile(),
                            daemonId: c.daemonId(),
                            cwd: c.cwd(),
                            agentId: c.agentId(),
                          }
                        : undefined,
                    );
                  }}
                />
                <IconButton
                  testID="split-close"
                  icon="x"
                  size="sm"
                  label={tr("Close split", "关闭分屏")}
                  onPress={closeSplit}
                />
              </View>
            </View>

            {/* Pane body: document editor or live chat */}
            <View class="relative min-h-0 flex-1">
              {target().kind === "doc" ? (
                <DocEditor path={(target() as Extract<SplitTarget, { kind: "doc" }>).path} />
              ) : (
                <If when={chat()}>{(c) => <SplitChatView chat={c()} />}</If>
              )}
            </View>
          </View>
        );
      }}
    </If>
  );
}
