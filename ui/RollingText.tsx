import { cleanup, computed, createAnimatedValue, effect, reduceMotion, signal, Text, untracked, View } from "nsh";
import type { ViewStyle } from "nsh";
import { EASING } from "./motion";

/**
 * Status words that change in place — "Thinking" morphing into "Reading
 * file.ts" as work goes on — via a single native text node with a calm
 * vertical micro-slide (`StatusMorph`). Rapid bursts coalesce naturally into
 * one atomic text swap instead of queueing dozens of split-flap nodes.
 *
 * `id` names the row the words belong to: a recycled `List` cell rebound to
 * another row snaps to its words instead of animating between two rows'
 * states. Single-instance text can leave it out.
 */
const BOX_ONLY_CLASSES = new Set(["min-w-0", "shrink", "shrink-0", "flex-1", "grow", "truncate"]);
const MAX_LINE_CHARS = 320;
const IN_OPACITY_MS = 155;
const IN_MOVE_MS = 170;
const COALESCE_MS = 75;
const SETTLE_MS = 180;

export function RollingText(props: {
  id?: () => string;
  text: () => string;
  class?: string;
  style?: ViewStyle;
}) {
  const canTruncate = () => Boolean(props.class && /\btruncate\b/.test(props.class));
  const line = computed(() => {
    const flat = props.text().replace(/\s*\n\s*/g, " ").replace(/\s+/g, " ").trim();
    return flat.length > MAX_LINE_CHARS ? `${flat.slice(0, MAX_LINE_CHARS - 1)}…` : flat;
  });
  const boxClass = computed(() =>
    (props.class ?? "")
      .split(/\s+/)
      .filter((c) => c && c !== "truncate")
      .join(" "),
  );
  const textClass = computed(() =>
    (props.class ?? "")
      .split(/\s+/)
      .filter((c) => c && !BOX_ONLY_CLASSES.has(c))
      .join(" "),
  );

  const initial = untracked(line);
  const shown = signal(initial);
  const morphing = signal(false);
  const opacity = createAnimatedValue(1);
  const translateY = createAnimatedValue(0);

  let trackedId = props.id ? untracked(props.id) : undefined;
  let lastMorphAt = 0;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;

  effect(() => {
    const next = line();
    const bound = props.id?.();
    const reduced = reduceMotion();
    untracked(() => {
      if (bound !== trackedId) {
        trackedId = bound;
        clearTimeout(settleTimer);
        lastMorphAt = 0;
        morphing.set(false);
        void opacity.stop();
        void translateY.stop();
        opacity.set(1);
        translateY.set(0);
        shown.set(next);
        return;
      }

      if (next === shown()) return;

      shown.set(next);

      if (reduced) {
        clearTimeout(settleTimer);
        lastMorphAt = 0;
        morphing.set(false);
        void opacity.stop();
        void translateY.stop();
        opacity.set(1);
        translateY.set(0);
        return;
      }

      const now = Date.now();
      clearTimeout(settleTimer);
      morphing.set(true);
      settleTimer = setTimeout(() => {
        morphing.set(false);
      }, SETTLE_MS);

      if (now - lastMorphAt >= COALESCE_MS) {
        lastMorphAt = now;
        void opacity.stop();
        void translateY.stop();
        opacity.set(0.22);
        translateY.set(3.5);
        void opacity.timing(1, { duration: IN_OPACITY_MS, easing: EASING.entrance });
        void translateY.timing(0, { duration: IN_MOVE_MS, easing: EASING.signature });
      }
    });
  });

  cleanup(() => {
    clearTimeout(settleTimer);
    void opacity.stop();
    void translateY.stop();
  });

  return (
    <View
      class={`relative flex-row items-center overflow-hidden ${boxClass()}`}
      style={props.style}
      testID={morphing() ? "rolling-born" : undefined}
    >
      <Text
        class={`${canTruncate() ? "min-w-0 shrink truncate " : "shrink-0 "}line-clamp-1 ${textClass()}`}
        style={{ opacity, transform: [{ translateY }] }}
      >
        {shown()}
      </Text>
    </View>
  );
}
