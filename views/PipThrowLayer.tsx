// Floating Throw + Morph overlay for Personal Agent (Pip SMS) outgoing bubbles.
//
// Sits above both `<List>` and `<Composer>` (`pointer-events-none`) in the chat
// pane's shared coordinate space so multiple rapid-burst bubbles can fly
// simultaneously from the composer text field into their exact live `<List>`
// slots without being clipped by the composer chrome or transcript edge mask.

import { cleanup, effect, reduceMotion, Text, View } from "nsh";
import type { ViewRef } from "nsh";
import type { DisplayUserRow } from "../pi/turns";
import { traceMotion } from "../ui/motion-trace";
import {
  activeThrowFlights,
  cancelAllSmsThrows,
  registerThrowLayerRoot,
  type SmsThrowFlight,
} from "../ui/pip-throw";
import { readingType } from "../ui/typography";
import { BubbleTail } from "./PipPresence";

type SmsSlot = NonNullable<DisplayUserRow["sms"]>;

function smsRadiusClass(slot: SmsSlot | undefined): string {
  if (!slot || (slot.first && slot.last)) return "rounded-[18px] rounded-br-[5px]";
  if (slot.first) return "rounded-[18px] rounded-br-[6px]";
  if (slot.last) return "rounded-[18px] rounded-tr-[6px] rounded-br-[5px]";
  return "rounded-[18px] rounded-r-[6px]";
}

function ThrowClone(props: { flight: SmsThrowFlight; smsSlot: () => SmsSlot | undefined }) {
  const f = props.flight;
  const radius = () => smsRadiusClass(props.smsSlot());
  const showTail = () => props.smsSlot()?.last ?? true;

  // Report morph opacity under `f.id` for burst monotonicity checks and full
  // coordinates under `throw:${f.id}` for trajectory/handoff tests.
  traceMotion(() => f.id, { eo: f.bgOpacity });
  traceMotion(() => `throw:${f.id}`, { x: f.tx, y: f.ty, bg: f.bgOpacity });

  return (
    <View
      testID="pip-throw-clone"
      class="pointer-events-none absolute left-0 top-0"
      style={{
        maxWidth: f.maxWidth,
        transform: [{ translateX: f.tx }, { translateY: f.ty }],
      }}
    >
      <View class={`relative max-w-full ${radius()} corner-squircle px-3.5 py-2`}>
        {/* Solid brand SMS fill blooming behind the text — no stroke, no halo. */}
        <View
          class={`pointer-events-none absolute inset-0 ${radius()} corner-squircle bg-brand`}
          style={{ opacity: f.bgOpacity }}
        />
        <If when={showTail()}>
          <View class="pointer-events-none absolute inset-0" style={{ opacity: f.tailOpacity }}>
            <BubbleTail side="right" tone="brand" />
          </View>
        </If>
        {/* White SMS text sets the exact intrinsic box geometry matching UserRow. */}
        <Text
          class={`${readingType()} text-brand-foreground ${f.folded ? "line-clamp-6" : ""}`}
          style={{ opacity: f.whiteTextOpacity }}
        >
          {f.text}
        </Text>
        {/* Composer ink overlay crossfades cleanly out as the blue pill wraps the words. */}
        <View class="pointer-events-none absolute inset-0 px-3.5 py-2">
          <Text
            class={`${readingType()} text-foreground ${f.folded ? "line-clamp-6" : ""}`}
            style={{ opacity: f.darkTextOpacity }}
          >
            {f.text}
          </Text>
        </View>
        <If when={f.folded}>
          {/* Matches UserRow's expand chevron foot seat so folded multi-line bubbles match height. */}
          <View class="-mb-1 h-5" />
        </If>
      </View>
    </View>
  );
}

export function PipThrowLayer(props: { smsSlotOf: (rowId: string) => SmsSlot | undefined }) {
  let rootNode: ViewRef | undefined;
  traceMotion(() => "throw-root", {}, () => rootNode);
  effect(() => {
    if (reduceMotion()) cancelAllSmsThrows();
  });
  cleanup(() => {
    rootNode = undefined;
    registerThrowLayerRoot(undefined);
  });

  return (
    <View
      ref={(node: ViewRef | undefined) => {
        rootNode = node;
        registerThrowLayerRoot(node);
      }}
      testID="pip-throw-layer"
      class="pointer-events-none absolute inset-0 z-20 overflow-hidden"
    >
      <Each of={activeThrowFlights()} key={(flight) => flight.id}>
        {(flight) => <ThrowClone flight={flight()} smsSlot={() => props.smsSlotOf(flight().id)} />}
      </Each>
    </View>
  );
}
