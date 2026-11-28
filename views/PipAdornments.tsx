import { Image, Text, View } from "nsh";
import type { ViewRef } from "nsh";
import type { ReplyPart } from "../lib/doc-wire";
import { tr } from "../lib/i18n";
import { Pip } from "../mascot/Pip";
import { IconButton } from "../ui/Button";
import { locatePipReply, messageInteraction, removeSticker, type MessageSticker } from "../store/pip-interactions";
import { HOVER_REVEAL } from "../ui/styles";
import { uiType } from "../ui/typography";

/** Bubble nodes by display-row id, for measuring the crisp foreground bubble of reply focus. */
const nodes = new Map<string, ViewRef>();

export function registerPipMessageNode(id: string, node: ViewRef | undefined) {
  if (!node) return;
  nodes.set(id, node);
  return () => {
    if (nodes.get(id) === node) nodes.delete(id);
  };
}

export function pipMessageNode(id: string): ViewRef | undefined {
  return nodes.get(id);
}

function StickerView(props: { scope: string; target: string; sticker: MessageSticker; index: number; side: "left" | "right" }) {
  const remove = () => removeSticker(props.scope, props.target, props.sticker.id);
  const outer = props.side === "right" ? "-left-11" : "-right-11";
  const outward = props.side === "right" ? -1 : 1;
  const offsetX = outward * props.index * 24;
  const offsetY = props.index % 2 === 0 ? 0 : -2;
  return (
    <View
      testID="pip-message-sticker"
      role="button"
      accessibilityLabel={tr("Remove sticker", "移除贴纸")}
      onPress={remove}
      class={`pointer-events-auto absolute bottom-0 ${outer} select-none`}
      style={{ transform: [{ translateX: offsetX }, { translateY: offsetY }, { rotate: props.sticker.rotation }], zIndex: 8 }}
      tooltip={tr("Remove sticker", "移除贴纸")}
    >
      {props.sticker.kind === "pip" ? (
        <Pip size={36} mood={props.sticker.mood} still />
      ) : props.sticker.kind === "emoji" ? (
        <Text style={{ fontSize: 28, lineHeight: 32 }}>{props.sticker.emoji}</Text>
      ) : (
        <Image src={props.sticker.path} class="size-10 rounded-xl corner-squircle border-[0.5px] border-hairline shadow-sm" style={{ objectFit: "cover" }} />
      )}
    </View>
  );
}

/**
 * The hover affordance parked beside a persona message. The transparent seat is
 * the whole 32pt strip from the bubble's edge through the button, for the full
 * height of the bubble, so a pointer crossing from the message never passes
 * through unhovered space. It stays below tapbacks and stickers; the visible
 * button keeps the outer 24pt of the strip and their original z-order.
 */
export function PipMessageHoverActions(props: { side: "left" | "right"; onPress: () => void }) {
  const outgoing = props.side === "right";
  const outward = outgoing ? "-left-8" : "-right-8";
  return (
    <>
      <View testID="pip-message-actions-bridge" class={`absolute top-0 bottom-0 z-10 w-8 ${outward}`} />
      <View
        class={`absolute top-0 bottom-0 z-30 w-8 flex-row items-center ${outward} ${outgoing ? "justify-start" : "justify-end"} ${HOVER_REVEAL}`}
        style={{ pointerEvents: "box-none" }}
      >
        <IconButton testID="pip-message-actions" icon="more" tone="subtle" size="sm" label={tr("Message actions", "消息操作")} onPress={props.onPress} />
      </View>
    </>
  );
}

/** Tapback and stickers attached to one bubble, all purely local adornments. */
export function PipMessageAdornments(props: { scope: string; target: string; side: "left" | "right" }) {
  const interaction = () => messageInteraction(props.scope, props.target);
  const tapbackSide = props.side === "right" ? "-left-3" : "-right-3";
  return (
    <View class="pointer-events-none absolute inset-0 z-20">
      {interaction()?.tapback ? (
        <View
          testID="pip-message-tapback"
          class={`absolute -top-3 ${tapbackSide} h-6 min-w-7 items-center justify-center rounded-full border-[0.5px] border-hairline bg-sms-incoming px-1.5 shadow-sm`}
        >
          <Text style={{ fontSize: 13, lineHeight: 16 }}>{interaction()?.tapback}</Text>
        </View>
      ) : null}
      {(interaction()?.stickers ?? []).map((sticker, index) => (
        <StickerView scope={props.scope} target={props.target} sticker={sticker} index={index} side={props.side} />
      ))}
    </View>
  );
}

/** The quiet quote card riding immediately above a replied user bubble. */
export function PipQuotePreview(props: { reply: ReplyPart; side: "left" | "right" }) {
  const author = () => (props.reply.author === "You" ? tr("You", "你") : props.reply.author);
  const excerpt = () => {
    const text = props.reply.excerpt.trim();
    if (text) return text;
    const images = props.reply.images ?? 0;
    return images > 0 ? (images === 1 ? tr("[Image]", "[图片]") : tr(`[${images} images]`, `[${images} 张图片]`)) : "";
  };
  return (
    <View
      testID="pip-quote-preview"
      role="button"
      accessibilityLabel={tr("Jump to quoted message", "跳转到引用的消息")}
      onPress={() => locatePipReply(props.reply.target)}
      class={`max-w-full select-none rounded-xl corner-squircle border-[0.5px] border-hairline bg-sms-incoming/80 px-2.5 py-1.5 ${props.side === "right" ? "self-end" : "self-start"}`}
    >
      <Text class={`${uiType("2xs")} font-medium text-muted-foreground`}>{author()}</Text>
      <Text class={`line-clamp-2 ${uiType("xs")} text-muted-foreground/85`}>{excerpt()}</Text>
    </View>
  );
}
