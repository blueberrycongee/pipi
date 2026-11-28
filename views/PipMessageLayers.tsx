import { cleanup, colorScheme, createAnimatedValue, effect, Image, keymap, reduceMotion, signal, Text, untracked, View } from "nsh";
import type { ViewRef } from "nsh";
import { tr } from "../lib/i18n";
import { Pip } from "../mascot/Pip";
import type { Mood } from "../mascot/geometry";
import { copyMessage, toast } from "../store/app";
import {
  addCustomStickerImage,
  addSticker,
  beginPipReply,
  clearPipReply,
  closePipMessageMenu,
  coverPipReplyOriginal,
  customStickers,
  messageInteraction,
  pipMessageMenu,
  pipReplyTarget,
  TAPBACKS,
  uncoverPipReplyOriginal,
  toggleTapback,
  type PipMessageMenuState,
  type PipReplyTarget,
  type MessageStickerDraft,
} from "../store/pip-interactions";
import { Icon } from "../ui/Icon";
import { EASING } from "../ui/motion";
import { FOCUS_RING, GLASS_REGULAR, POPUP, PRESS, PRESS_SCALE, ROW } from "../ui/styles";
import { readingType, uiType } from "../ui/typography";
import { PipMessageAdornments, pipMessageNode } from "./PipAdornments";
import { BubbleTail } from "./PipPresence";
import { PipBubbleBlocks, type PipBubbleRow } from "./Prose";

function MenuItem(props: { icon?: "quote" | "image" | "copy"; label: string; testID: string; onPress: () => void; chevron?: boolean }) {
  return (
    <View
      testID={props.testID}
      role="button"
      accessibilityLabel={props.label}
      onPress={props.onPress}
      class={`${ROW} ${PRESS_SCALE} ${FOCUS_RING} select-none`}
    >
      {props.icon ? <Icon name={props.icon} size={14} tone="muted-foreground" /> : null}
      <Text class={`min-w-0 flex-1 truncate ${uiType("sm")} text-foreground`}>{props.label}</Text>
      {props.chevron ? <Icon name="chevronRight" size={12} tone="subtle" /> : null}
    </View>
  );
}

function TapbackRow(props: { menu: PipMessageMenuState }) {
  const current = () => messageInteraction(props.menu.scope, props.menu.target)?.tapback;
  return (
    <View testID="pip-tapback-row" class="flex-row items-center justify-between gap-1 rounded-lg bg-background/28 px-1.5 py-1">
      <Each of={TAPBACKS} key={(tapback) => tapback}>
        {(tapback) => (
          <View
            testID={`pip-tapback-${tapback()}`}
            role="button"
            accessibilityLabel={tr(`React ${tapback()}`, `用 ${tapback()} 回应`)}
            onPress={() => {
              toggleTapback(props.menu.scope, props.menu.target, tapback());
              closePipMessageMenu();
            }}
            class={`size-8 select-none items-center justify-center rounded-full ${PRESS} ${PRESS_SCALE} ${FOCUS_RING} ${current() === tapback() ? "bg-accent" : "hover:bg-accent/70"}`}
          >
            <Text style={{ fontSize: 17, lineHeight: 20 }}>{tapback()}</Text>
          </View>
        )}
      </Each>
    </View>
  );
}

const PIP_STICKER_MOODS: Mood[] = ["happy", "idle", "think", "write", "work", "sleep", "error"];
const EMOJI_STICKERS = ["😀", "😂", "😍", "😘", "😎", "🥹", "😭", "😡", "🎉", "🔥", "✨", "👻", "💯", "🫶", "🙌", "👀"];

function StickerPanel(props: { menu: PipMessageMenuState }) {
  const attach = (sticker: MessageStickerDraft) => {
    addSticker(props.menu.scope, props.menu.target, sticker);
    closePipMessageMenu();
  };
  const pickCustom = () => {
    void addCustomStickerImage()
      .then((sticker) => {
        if (sticker) attach({ kind: "image", path: sticker.path, ...(sticker.mimeType ? { mimeType: sticker.mimeType } : {}) });
      })
      .catch(() => toast("warning", tr("No image picker is available on this system.", "此系统没有可用的图片选择器。")));
  };
  return (
    <View testID="pip-sticker-panel" class="w-68 gap-2 p-2">
      <Text class={`${uiType("2xs")} font-medium uppercase tracking-wide text-subtle`}>{tr("Pip", "Pip")}</Text>
      <View class="flex-row flex-wrap gap-1">
        <Each of={PIP_STICKER_MOODS} key={(mood) => mood}>
          {(mood) => (
            <View
              testID={`pip-sticker-mood-${mood()}`}
              role="button"
              accessibilityLabel={tr(`Add Pip ${mood()} sticker`, `添加 Pip ${mood()} 贴纸`)}
              onPress={() => attach({ kind: "pip", mood: mood() })}
              class={`size-11 select-none items-center justify-center rounded-xl corner-squircle ${PRESS} ${PRESS_SCALE} ${FOCUS_RING} hover:bg-accent`}
            >
              <Pip size={36} mood={mood()} still />
            </View>
          )}
        </Each>
      </View>
      <Text class={`${uiType("2xs")} font-medium uppercase tracking-wide text-subtle`}>{tr("Emoji", "表情")}</Text>
      <View class="flex-row flex-wrap gap-0.5">
        <Each of={EMOJI_STICKERS} key={(emoji) => emoji}>
          {(emoji) => (
            <View
              testID={`pip-sticker-emoji-${emoji()}`}
              role="button"
              accessibilityLabel={tr(`Add ${emoji()} sticker`, `添加 ${emoji()} 贴纸`)}
              onPress={() => attach({ kind: "emoji", emoji: emoji() })}
              class={`size-9 select-none items-center justify-center rounded-lg corner-squircle ${PRESS} ${PRESS_SCALE} ${FOCUS_RING} hover:bg-accent`}
            >
              <Text style={{ fontSize: 24, lineHeight: 28 }}>{emoji()}</Text>
            </View>
          )}
        </Each>
      </View>
      <View class="flex-row items-center justify-between gap-2 pt-0.5">
        <Text class={`${uiType("2xs")} font-medium uppercase tracking-wide text-subtle`}>{tr("Custom", "自定义")}</Text>
        <View
          testID="pip-sticker-add-custom"
          role="button"
          accessibilityLabel={tr("Add image sticker", "添加图片贴纸")}
          onPress={pickCustom}
          class={`h-7 select-none flex-row items-center gap-1 rounded-md corner-squircle px-2 ${PRESS} ${PRESS_SCALE} ${FOCUS_RING} hover:bg-accent`}
        >
          <Icon name="plus" size={12} tone="muted-foreground" />
          <Text class={`${uiType("xs")} text-muted-foreground`}>{tr("Add…", "添加…")}</Text>
        </View>
      </View>
      <If when={customStickers().length > 0}>
        <View class="flex-row flex-wrap gap-1.5">
          <Each of={customStickers()} key={(sticker) => sticker.id}>
            {(sticker) => (
              <View
                testID="pip-custom-sticker-choice"
                role="button"
                accessibilityLabel={sticker().name}
                onPress={() => attach({ kind: "image", path: sticker().path, ...(sticker().mimeType ? { mimeType: sticker().mimeType } : {}) })}
                class={`size-11 select-none overflow-hidden rounded-xl corner-squircle border-[0.5px] border-hairline ${PRESS} ${PRESS_SCALE} ${FOCUS_RING}`}
              >
                <Image src={sticker().path} class="size-full" style={{ objectFit: "cover" }} />
              </View>
            )}
          </Each>
        </View>
      </If>
    </View>
  );
}

/** The persona bubble menu: Liquid Glass, neutral selection, tapbacks on top. */
export function PipMessageMenuLayer() {
  const panel = signal<"menu" | "stickers">("menu");
  const opacity = createAnimatedValue(0);
  const scale = createAnimatedValue(0.96);
  const root = signal<ViewRef | undefined>(undefined);
  const frame = signal<{ x: number; y: number; width: number; height: number } | undefined>(undefined);
  let exitTimer: ReturnType<typeof setTimeout> | undefined;
  const shown = signal<PipMessageMenuState | undefined>(undefined);

  const measure = async () => {
    const node = untracked(root);
    if (!node) return;
    const m = await node.measure().catch(() => undefined);
    if (m) frame.set({ x: m.pagePosition.x, y: m.pagePosition.y, width: m.bounds.size.width, height: m.bounds.size.height });
  };

  effect(() => {
    const open = pipMessageMenu();
    untracked(() => {
      clearTimeout(exitTimer);
      if (open) {
        shown.set(open);
        panel.set("menu");
        void measure();
        void primeReplyMeasurement(open);
        void opacity.stop();
        void scale.stop();
        if (reduceMotion()) {
          opacity.set(1);
          scale.set(1);
        } else {
          opacity.set(0);
          scale.set(0.96);
          void opacity.timing(1, { duration: 140, easing: EASING.entrance });
          void scale.spring(1, { stiffness: 420, damping: 30, mass: 0.9 });
        }
      } else {
        void opacity.stop();
        void scale.stop();
        if (reduceMotion()) {
          opacity.set(0);
          shown.set(undefined);
        } else void opacity.timing(0, { duration: 110, easing: EASING.exit });
        exitTimer = setTimeout(() => {
          shown.set(undefined);
          panel.set("menu");
        }, 120);
      }
    });
  });
  effect(() => {
    if (!pipMessageMenu()) return;
    cleanup(keymap.bind("escape", closePipMessageMenu, { when: "always" }));
  });
  cleanup(() => {
    clearTimeout(exitTimer);
    void opacity.stop();
    void scale.stop();
  });

  const position = () => {
    const menu = shown();
    const rootFrame = frame();
    if (!menu || !rootFrame) return { left: 0, top: 0 };
    const width = panel() === "stickers" ? 288 : 248;
    const height = panel() === "stickers" ? 390 : 190;
    return {
      left: Math.max(8, Math.min(menu.x - rootFrame.x, rootFrame.width - width - 8)),
      top: Math.max(8, Math.min(menu.y - rootFrame.y, rootFrame.height - height - 8)),
    };
  };

  return (
    <View ref={(node: ViewRef | undefined) => root.set(node)} class="pointer-events-none absolute inset-0 z-40">
      {shown() ? (
        <View class="pointer-events-auto absolute inset-0">
          <View testID="pip-message-menu-backdrop" class="absolute inset-0" onPress={closePipMessageMenu} />
          <View
            testID="pip-message-menu"
            class={`absolute ${POPUP} p-1.5`}
            style={{ ...GLASS_REGULAR, left: position().left, top: position().top, opacity, transform: [{ scale }] }}
          >
            {panel() === "stickers" ? (
              <StickerPanel menu={shown()!} />
            ) : (
              <View class="w-60 gap-1">
                <TapbackRow menu={shown()!} />
                <MenuItem testID="pip-menu-reply" icon="quote" label={tr("Reply…", "回复…")} onPress={() => void beginMeasuredPipReply(shown()!)} />
                <MenuItem testID="pip-menu-stickers" icon="image" label={tr("Add Sticker…", "附加贴纸…")} chevron onPress={() => panel.set("stickers")} />
                <MenuItem
                  testID="pip-menu-copy"
                  icon="copy"
                  label={tr("Copy", "拷贝")}
                  onPress={() => {
                    void copyMessage(shown()!.copyText || shown()!.text);
                    closePipMessageMenu();
                  }}
                />
              </View>
            )}
          </View>
        </View>
      ) : null}
    </View>
  );
}

function FocusUserImages(props: { target: PipReplyTarget }) {
  const images = props.target.imageBlocks ?? [];
  const missing = Math.max(0, props.target.images - images.length);
  if (!images.length && !missing) return null;
  return (
    <View class="max-w-full flex-row flex-wrap justify-end gap-1.5">
      {images.map((image) => (
        <View class="relative size-18 shrink-0 overflow-hidden rounded-xl corner-squircle bg-secondary">
          <Image src={`data:${image.mimeType};base64,${image.data}`} class="size-full" style={{ objectFit: "cover" }} />
          <View class="pointer-events-none absolute inset-0 rounded-xl corner-squircle border-[0.5px] border-hairline-hover" />
        </View>
      ))}
      {missing > 0 ? (
        <View class="size-18 shrink-0 items-center justify-center gap-1 rounded-xl corner-squircle border-[0.5px] border-hairline bg-secondary/70">
          <Icon name="image" size={16} tone="muted-foreground" />
          <Text class={`${uiType("xs")} text-muted-foreground`}>+{missing}</Text>
        </View>
      ) : null}
    </View>
  );
}

function focusPipRow(target: PipReplyTarget): PipBubbleRow {
  return {
    kind: "pip-bubble",
    id: `focus:${target.displayId}`,
    rowId: target.rowId,
    bubbleIndex: 0,
    first: target.first ?? true,
    last: target.last ?? true,
    blocks: target.blocks ?? [],
    ...(target.footnotes?.length ? { footnotes: target.footnotes } : {}),
    copyText: target.copyText ?? target.text,
    fullText: target.fullText ?? target.copyText ?? target.text,
    wide: Boolean(target.wide),
    ...(target.mediaOnly ? { mediaOnly: true } : {}),
    pip: { lead: target.first ?? true, tail: target.last ?? true, indent: true, fullText: target.fullText ?? target.copyText ?? target.text },
  };
}

function pipRadius(target: PipReplyTarget) {
  const first = target.first ?? true;
  const last = target.last ?? true;
  if (first && last) return "rounded-[18px] rounded-bl-[5px]";
  if (first) return "rounded-[18px] rounded-bl-[6px]";
  if (last) return "rounded-[18px] rounded-tl-[6px] rounded-bl-[5px]";
  return "rounded-[18px] rounded-l-[6px]";
}

function userRadius(target: PipReplyTarget) {
  const first = target.first ?? true;
  const last = target.last ?? true;
  if (first && last) return "rounded-[18px] rounded-br-[5px]";
  if (first) return "rounded-[18px] rounded-br-[6px]";
  if (last) return "rounded-[18px] rounded-tr-[6px] rounded-br-[5px]";
  return "rounded-[18px] rounded-r-[6px]";
}

/** The deepening contact shadow is the lift's mass cue; its opacity is the shared lift clock. */
function FocusLiftShadow(props: { radius: string; tone: "brand" | "sms-incoming"; lift: ReturnType<typeof createAnimatedValue> }) {
  const shadow = () =>
    colorScheme() === "dark"
      ? "0 14px 34px rgb(0 0 0 / 0.52), 0 3px 10px rgb(0 0 0 / 0.34)"
      : "0 12px 30px rgb(0 0 0 / 0.18), 0 3px 9px rgb(0 0 0 / 0.10)";
  return (
    <View
      class={`pointer-events-none absolute inset-0 ${props.radius} corner-squircle ${props.tone === "brand" ? "bg-brand" : "bg-sms-incoming"}`}
      style={{ opacity: props.lift, boxShadow: shadow() }}
    />
  );
}

function FocusPipBubble(props: { target: PipReplyTarget; lift: ReturnType<typeof createAnimatedValue> }) {
  const row = focusPipRow(props.target);
  if (props.target.mediaOnly) {
    return (
      <View class="relative w-full">
        <PipMessageAdornments scope={props.target.scope} target={props.target.target} side="left" />
        <PipBubbleBlocks row={row} />
      </View>
    );
  }
  const radius = pipRadius(props.target);
  const pad = (props.target.blocks?.length ?? 0) > 1 || props.target.wide ? "px-4 py-3" : "px-3.5 py-2";
  return (
    <View testID="pip-reply-focus-text-bubble" class={`relative w-full ${radius} corner-squircle bg-sms-incoming ${pad}`}>
      <FocusLiftShadow radius={radius} tone="sms-incoming" lift={props.lift} />
      <PipMessageAdornments scope={props.target.scope} target={props.target.target} side="left" />
      {(props.target.tail ?? props.target.last ?? true) ? <BubbleTail side="left" tone="sms-incoming" /> : null}
      <PipBubbleBlocks row={row} />
    </View>
  );
}

function FocusUserBubble(props: { target: PipReplyTarget; lift: ReturnType<typeof createAnimatedValue> }) {
  const radius = userRadius(props.target);
  return (
    <View class="w-full items-end gap-1.5">
      <FocusUserImages target={props.target} />
      {props.target.text ? (
        <View testID="pip-reply-focus-text-bubble" class={`relative max-w-full gap-1.5 ${radius} corner-squircle bg-brand px-3.5 py-2`}>
          <FocusLiftShadow radius={radius} tone="brand" lift={props.lift} />
          <PipMessageAdornments scope={props.target.scope} target={props.target.target} side="right" />
          {(props.target.tail ?? props.target.last ?? true) ? <BubbleTail side="right" tone="brand" /> : null}
          <Text class={`${readingType()} text-brand-foreground`}>{props.target.text}</Text>
        </View>
      ) : null}
    </View>
  );
}

interface ReplyFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

let focusRoot: ViewRef | undefined;
let preparedMeasure: { id: string; promise: Promise<ReplyFrame | undefined> } | undefined;

async function measureReplyFrame(target: PipReplyTarget): Promise<ReplyFrame | undefined> {
  const node = focusRoot;
  const bubble = pipMessageNode(target.displayId);
  if (!node || !bubble) return undefined;
  const measured = await Promise.all([node.measure(), bubble.measure()]).catch(() => undefined);
  const rootBox = measured?.[0];
  const bubbleBox = measured?.[1];
  if (!rootBox || !bubbleBox) return undefined;
  return {
    x: bubbleBox.pagePosition.x - rootBox.pagePosition.x,
    y: bubbleBox.pagePosition.y - rootBox.pagePosition.y,
    width: bubbleBox.bounds.size.width,
    height: bubbleBox.bounds.size.height,
  };
}

/** Measurement starts when the menu opens, so choosing Reply normally awaits an already-finished read. */
function primeReplyMeasurement(target: PipReplyTarget) {
  if (preparedMeasure?.id === target.displayId) return preparedMeasure.promise;
  const promise = measureReplyFrame(target);
  preparedMeasure = { id: target.displayId, promise };
  return promise;
}

/** Replicas that cannot faithfully reproduce the original (notably attachment-only cards) never veil it. */
function faithfulFocusReplica(target: PipReplyTarget) {
  if (target.side === "left") return true;
  if ((target.imageBlocks?.length ?? 0) > 0) return true;
  return Boolean(target.text) && (target.copyText ?? target.text) === target.text;
}

export async function beginMeasuredPipReply(target: PipReplyTarget) {
  const frame = await primeReplyMeasurement(target);
  if (frame && faithfulFocusReplica(target)) coverPipReplyOriginal(target.displayId);
  beginPipReply(target, frame ? { initialFrame: frame } : undefined);
}

const REPLY_FROST_MS = 220;
const REPLY_LIFT_DELAY_MS = 20;
const REPLY_LIFT_MS = 320;
const REPLY_EXIT_FROST_DELAY_MS = 120;
const REPLY_EXIT_TOTAL_MS = 340;
const REPLY_LIFT_SCALE = 1.03;

/** macOS Messages' reply-focus state: one already-coincident bubble lifts while the conversation frosts. */
export function PipReplyFocusLayer(props: { track?: () => number }) {
  const shown = signal<PipReplyTarget | undefined>(undefined);
  const frame = signal<ReplyFrame | undefined>(undefined);
  const frost = createAnimatedValue(0);
  const lift = createAnimatedValue(0);
  const scale = lift.interpolate({ inputRange: [0, 1], outputRange: [1, REPLY_LIFT_SCALE] });
  const root = signal<ViewRef | undefined>(undefined);
  let exitTimer: ReturnType<typeof setTimeout> | undefined;
  let measuring = false;
  let measureDirty = false;

  const currentTarget = () => shown() ?? pipReplyTarget();

  const requestMeasure = (target: PipReplyTarget) => {
    if (measuring) {
      measureDirty = true;
      return;
    }
    measuring = true;
    void measureReplyFrame(target).then((next) => {
      measuring = false;
      const current = currentTarget();
      if (next && current?.displayId === target.displayId) {
        frame.set(next);
        if (faithfulFocusReplica(target)) coverPipReplyOriginal(target.displayId);
      }
      if (measureDirty) {
        measureDirty = false;
        if (current) requestMeasure(current);
      }
    });
  };

  effect(() => {
    const target = pipReplyTarget();
    untracked(() => {
      clearTimeout(exitTimer);
      if (target) {
        shown.set(target);
        frame.set(target.initialFrame);
        requestMeasure(target);
        void frost.stop();
        void lift.stop();
        if (reduceMotion()) {
          frost.set(1);
          lift.set(1);
        } else {
          frost.set(0);
          lift.set(0);
          void frost.timing(1, { duration: REPLY_FROST_MS, easing: EASING.entrance });
          void lift.timing(1, { duration: REPLY_LIFT_MS, delay: REPLY_LIFT_DELAY_MS, easing: EASING.settle });
        }
      } else if (shown()) {
        const leaving = shown()!;
        void frost.stop();
        void lift.stop();
        if (reduceMotion()) {
          frost.set(0);
          lift.set(0);
          uncoverPipReplyOriginal(leaving.displayId);
          shown.set(undefined);
          frame.set(undefined);
        } else {
          // The reverse relay: the mass comes home first; only then does the frost lift.
          void lift.timing(0, { duration: REPLY_LIFT_MS, easing: EASING.settle });
          void frost.timing(0, { duration: REPLY_FROST_MS, delay: REPLY_EXIT_FROST_DELAY_MS, easing: EASING.exit });
          exitTimer = setTimeout(() => {
            uncoverPipReplyOriginal(leaving.displayId);
            shown.set(undefined);
            frame.set(undefined);
          }, REPLY_EXIT_TOTAL_MS + 10);
        }
      }
    });
  });

  // Scroll, streaming growth, folding, and pane resizing all re-read the original's frame;
  // one in flight at a time, with the latest event replayed — a tracker, not a retry ladder.
  effect(() => {
    props.track?.();
    const target = shown();
    if (!target) return;
    untracked(() => requestMeasure(target));
  });

  effect(() => {
    if (!pipReplyTarget()) return;
    cleanup(keymap.bind("escape", clearPipReply, { when: "always" }));
  });
  cleanup(() => {
    clearTimeout(exitTimer);
    if (focusRoot === untracked(root)) focusRoot = undefined;
    void frost.stop();
    void lift.stop();
  });

  const target = () => shown();
  const bubbleStyle = () => {
    const box = frame();
    const current = target();
    if (!current || !box) return { opacity: 0 };
    return {
      position: "absolute" as const,
      left: box.x,
      top: box.y,
      width: box.width,
      minHeight: box.height,
      zIndex: 2,
      transformOrigin: "center center",
      transform: [{ scale }],
    };
  };

  return (
    <View
      ref={(node: ViewRef | undefined) => {
        root.set(node);
        focusRoot = node;
      }}
      class="pointer-events-none absolute inset-0 z-[6]"
    >
      {target() ? (
        <View testID="pip-reply-focus-layer" class="pointer-events-auto absolute inset-0">
          <View
            testID="pip-reply-focus-backdrop"
            class="absolute inset-0 bg-background/34 dark:bg-black/24"
            style={{ backdropFilter: "blur(22px) saturate(165%)", opacity: frost }}
            onPress={clearPipReply}
          />
          <View testID="pip-reply-focus-bubble" style={bubbleStyle()}>
            {target()!.side === "right" ? <FocusUserBubble target={target()!} lift={lift} /> : <FocusPipBubble target={target()!} lift={lift} />}
          </View>
        </View>
      ) : null}
    </View>
  );
}
