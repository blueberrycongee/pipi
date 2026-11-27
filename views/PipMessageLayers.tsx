import { cleanup, createAnimatedValue, effect, Image, keymap, reduceMotion, signal, Text, untracked, View } from "nsh";
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
  customStickers,
  messageInteraction,
  pipMessageMenu,
  pipReplyTarget,
  TAPBACKS,
  toggleTapback,
  type PipMessageMenuState,
  type PipReplyTarget,
  type MessageStickerDraft,
} from "../store/pip-interactions";
import { Icon } from "../ui/Icon";
import { EASING } from "../ui/motion";
import { FOCUS_RING, GLASS_REGULAR, POPUP, PRESS, PRESS_SCALE, ROW } from "../ui/styles";
import { readingType, uiType } from "../ui/typography";
import { pipMessageNode } from "./PipAdornments";
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
                <MenuItem testID="pip-menu-reply" icon="quote" label={tr("Reply…", "回复…")} onPress={() => beginPipReply(shown()!)} />
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
  if (!images.length) return null;
  return (
    <View class="flex-row flex-wrap justify-end gap-1.5 pb-1.5">
      {images.slice(0, 3).map((image, index) => (
        <Image src={`data:${image.mimeType};base64,${image.data}`} class="size-16 rounded-xl corner-squircle" style={{ objectFit: "cover" }} />
      ))}
    </View>
  );
}

function FocusPipBlocks(props: { target: PipReplyTarget }) {
  if (!props.target.blocks?.length) return <Text class={`${readingType()} text-foreground`}>{props.target.text || props.target.excerpt}</Text>;
  const row: PipBubbleRow = {
    kind: "pip-bubble",
    id: `focus:${props.target.displayId}`,
    rowId: props.target.rowId,
    bubbleIndex: 0,
    first: true,
    last: true,
    blocks: props.target.blocks,
    copyText: props.target.copyText ?? props.target.text,
    fullText: props.target.fullText ?? props.target.copyText ?? props.target.text,
    wide: Boolean(props.target.wide),
    ...(props.target.mediaOnly ? { mediaOnly: true } : {}),
    pip: { lead: true, tail: true, indent: true, fullText: props.target.fullText ?? props.target.copyText ?? props.target.text },
  };
  return <PipBubbleBlocks row={row} />;
}

/** macOS Messages' reply-focus state: the conversation frosts over, the target bubble stays sharp. */
export function PipReplyFocusLayer() {
  const shown = signal<PipReplyTarget | undefined>(undefined);
  const frame = signal<{ x: number; y: number; width: number; height: number } | undefined>(undefined);
  const opacity = createAnimatedValue(0);
  const root = signal<ViewRef | undefined>(undefined);
  let exitTimer: ReturnType<typeof setTimeout> | undefined;
  let measureTimers: Array<ReturnType<typeof setTimeout>> = [];

  const measure = async (target: PipReplyTarget) => {
    const node = untracked(root);
    const bubble = pipMessageNode(target.displayId);
    if (!node || !bubble) return;
    const [rootBox, bubbleBox] = await Promise.all([node.measure(), bubble.measure()]).catch(() => [undefined, undefined] as const);
    if (!rootBox || !bubbleBox) return;
    frame.set({
      x: bubbleBox.pagePosition.x - rootBox.pagePosition.x,
      y: bubbleBox.pagePosition.y - rootBox.pagePosition.y,
      width: bubbleBox.bounds.size.width,
      height: bubbleBox.bounds.size.height,
    });
  };

  effect(() => {
    const target = pipReplyTarget();
    untracked(() => {
      clearTimeout(exitTimer);
      for (const timer of measureTimers) clearTimeout(timer);
      measureTimers = [];
      if (target) {
        shown.set(target);
        frame.set(undefined);
        measureTimers = [30, 130, 250, 420].map((delay) => setTimeout(() => void measure(target), delay));
        void opacity.stop();
        if (reduceMotion()) opacity.set(1);
        else {
          opacity.set(0);
          void opacity.timing(1, { duration: 200, easing: EASING.entrance });
        }
      } else if (shown()) {
        void opacity.stop();
        if (reduceMotion()) {
          opacity.set(0);
          shown.set(undefined);
        } else {
          void opacity.timing(0, { duration: 160, easing: EASING.exit });
          exitTimer = setTimeout(() => shown.set(undefined), 170);
        }
      }
    });
  });
  effect(() => {
    if (!pipReplyTarget()) return;
    cleanup(keymap.bind("escape", clearPipReply, { when: "always" }));
  });
  cleanup(() => {
    clearTimeout(exitTimer);
    for (const timer of measureTimers) clearTimeout(timer);
    void opacity.stop();
  });

  const target = () => shown();
  const bubbleStyle = () => {
    const box = frame();
    const current = target();
    if (!current) return { opacity: 0 };
    if (!box) return { opacity: 0 };
    return { position: "absolute" as const, left: box.x, top: box.y, width: box.width, minHeight: box.height, zIndex: 2 };
  };

  return (
    <View ref={(node: ViewRef | undefined) => root.set(node)} class="pointer-events-none absolute inset-0 z-[6]">
      {target() ? (
        <View testID="pip-reply-focus-layer" class="pointer-events-auto absolute inset-0">
          <View
            testID="pip-reply-focus-backdrop"
            class="absolute inset-0 bg-background/34 dark:bg-black/24"
            style={{ backdropFilter: "blur(22px) saturate(165%)", opacity }}
            onPress={clearPipReply}
          />
          <View style={{ opacity }}>
            <View testID="pip-reply-focus-bubble" style={bubbleStyle()}>
              {target()!.side === "right" ? (
                <View class="max-w-full items-end">
                  <FocusUserImages target={target()!} />
                  {target()!.text ? (
                    <View testID="pip-reply-focus-text-bubble" class="max-w-full rounded-[18px] rounded-br-[5px] corner-squircle bg-brand px-3.5 py-2 shadow-lg">
                      <Text class={`${readingType()} text-brand-foreground`}>{target()!.text}</Text>
                    </View>
                  ) : null}
                </View>
              ) : (
                <View class={target()!.mediaOnly ? "max-w-full" : "max-w-full rounded-[18px] rounded-bl-[5px] corner-squircle bg-sms-incoming px-3.5 py-2 shadow-lg"}>
                  <FocusPipBlocks target={target()!} />
                </View>
              )}
            </View>
          </View>
        </View>
      ) : null}
    </View>
  );
}
