import { cleanup, computed, createAnimatedValue, effect, reduceMotion, signal, Text, untracked, View } from "nsh";
import type { ViewStyle } from "nsh";
import { EASING } from "./motion";

/**
 * Status words that change in place — "Thinking" flipping into "Reading
 * file.ts" as work goes on, split-flap style: each piece of the line folds
 * back and up like a flap-board letter, and the new one drops in on a spring
 * that settles with a wobble. Pieces flip in a left-to-right cascade, and a
 * piece whose glyph did not change stays still — "正在读取" rolling into
 * "正在搜索" only flips two glyphs.
 *
 * `id` names the row the words belong to: a recycled `List` cell rebound to
 * another row snaps to its words instead of animating between two rows'
 * states. Single-instance text can leave it out.
 */
const BOX_ONLY_CLASSES = new Set(["min-w-0", "shrink", "shrink-0", "flex-1", "grow", "truncate"]);
const MAX_LINE_CHARS = 320;
const MAX_FLAP_SLOTS = 96;

export function RollingText(props: {
  id?: () => string;
  text: () => string;
  class?: string;
  style?: ViewStyle;
}) {
  let lastId: string | undefined = props.id ? untracked(props.id) : undefined;
  let size = -1;
  const boxW = signal(0);
  const trackW = signal(0);
  const canTruncate = () => Boolean(props.class && /\btruncate\b/.test(props.class));
  const overflowing = computed(() => canTruncate() && boxW() > 0 && trackW() > boxW() + 1);
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
  const slots = computed(() => {
    const bound = props.id?.();
    const rebound = bound !== lastId;
    lastId = bound;
    const tokens = pieces(line()).slice(0, MAX_FLAP_SLOTS);
    // A line's first look — mount or a recycled cell's rebind — shows it whole:
    // only pieces a live line grows into afterwards are born flaps, so a landed
    // transcript's status words never replay the drop.
    const prev = rebound || size < 0 || untracked(overflowing) ? tokens.length : size;
    size = tokens.length;
    // Shortened lines keep their old slots a moment: each flaps away to "".
    return Array.from({ length: Math.max(prev, tokens.length) }, (_, i) => ({
      key: i,
      ch: tokens[i] ?? "",
      delay: Math.min(i * 15, 190),
      born: !rebound && i >= prev,
    }));
  });
  // Tests watch for a line's born flaps (`id:rolling-born`): a landing must
  // mount none, a live line's growth still does.
  const flapping = computed(() => slots().some((slot) => slot.born));

  return (
    <View
      class={`relative flex-row items-center overflow-hidden ${boxClass()}`}
      style={props.style}
      onLayout={(e) => boxW.set(e.bounds.size.width)}
      testID={flapping() ? "rolling-born" : undefined}
    >
      <View
        class="shrink-0 flex-row"
        style={overflowing() ? { visibility: "hidden" } : undefined}
        onLayout={(e) => trackW.set(e.bounds.size.width)}
      >
        <Each of={slots()} key={(slot) => slot.key}>
          {(slot) => (
            <RollingToken id={props.id} ch={() => slot().ch} delay={() => slot().delay} born={slot().born} class={textClass()} />
          )}
        </Each>
      </View>
      <If when={overflowing()}>
        <Text class={`pointer-events-none absolute inset-x-0 top-0 truncate ${textClass()}`}>
          {line()}
        </Text>
      </If>
    </View>
  );
}

const FLAP = 74;
const OUT_MS = 150;
/** The in-spring: underdamped so a landing flap swings a hair past rest. */
const LAND = { stiffness: 320, damping: 24, mass: 0.9 };
/** A flap is only readable flat: past ~34° its letter fades out, so a tilted
 * glyph never sits on screen reading as a crooked one. */
const FOLD: [number, number] = [9, 34];

function RollingToken(props: { id?: () => string; ch: () => string; delay: () => number; born: boolean; class?: string }) {
  const born = props.born && !untracked(reduceMotion);
  const shown = signal(untracked(props.ch));
  const translateY = createAnimatedValue(born ? 4 : 0);
  const rotateX = createAnimatedValue(born ? -FLAP : 0);
  const opacity = rotateX.interpolate({
    inputRange: [-FLAP, -FOLD[1], -FOLD[0], 0, FOLD[0], FOLD[1], FLAP],
    outputRange: [0, 0, 1, 1, 1, 0, 0],
  });
  let trackedId = props.id ? untracked(props.id) : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let swapping = false;

  const drop = () => {
    void translateY.timing(0, { duration: 240, easing: EASING.smoothOut });
    void rotateX.spring(0, LAND);
  };

  if (born) timer = setTimeout(drop, untracked(props.delay));

  effect(() => {
    const next = props.ch();
    const bound = props.id?.();
    const delay = props.delay();
    const reduced = reduceMotion();
    untracked(() => {
      if (bound !== trackedId) {
        trackedId = bound;
        clearTimeout(timer);
        swapping = false;
        shown.set(next);
        translateY.set(0);
        rotateX.set(0);
        return;
      }
      if (next === shown()) {
        // The word swung back before the flap swapped: let it swing back too.
        if (swapping) {
          swapping = false;
          clearTimeout(timer);
          void rotateX.stop();
          void translateY.stop();
          void rotateX.spring(0, LAND);
          void translateY.timing(0, { duration: 200, easing: EASING.smoothOut });
        }
        return;
      }
      clearTimeout(timer);
      swapping = false;
      if (reduced) {
        shown.set(next);
        translateY.set(0);
        rotateX.set(0);
        return;
      }
      void rotateX.stop();
      void translateY.stop();
      void rotateX.timing(FLAP, { duration: OUT_MS, delay, easing: "easeIn" });
      void translateY.timing(-3, { duration: OUT_MS, delay, easing: "easeIn" });
      swapping = true;
      timer = setTimeout(() => {
        swapping = false;
        shown.set(next);
        translateY.set(4);
        rotateX.set(-FLAP);
        drop();
      }, delay + OUT_MS);
    });
  });

  cleanup(() => {
    clearTimeout(timer);
    void translateY.stop();
    void rotateX.stop();
  });

  return (
    <Text class={`line-clamp-1 shrink-0 ${props.class ?? ""}`} style={{ opacity, transform: [{ perspective: 650 }, { rotateX }, { translateY }] }}>
      {shown()}
    </Text>
  );
}

const NBSP = "\u00a0";

/** Flap-board pieces: every wide (CJK, fullwidth, emoji) glyph is a piece of
 * its own, a run of narrow glyphs (a Latin word, a number) flips as one, and
 * spaces between pieces lead the piece after them, as non-breaking ones, so
 * the line's spacing survives the split. Never trailing: a text's measured
 * width leaves out its trailing whitespace, so the space would vanish and wrap
 * the piece onto a second line that pushes the row's words off center. */
function pieces(text: string): string[] {
  const out: string[] = [];
  let run = "";
  let gap = "";
  const flush = () => {
    if (run) {
      out.push(run);
      run = "";
    }
  };
  for (const ch of text) {
    if (/\s/.test(ch)) {
      gap += NBSP;
      continue;
    }
    if ((ch.codePointAt(0) ?? 0) > 0x2e7f) {
      flush();
      out.push(gap + ch);
    } else {
      run += (run ? " ".repeat(gap.length) : gap) + ch;
    }
    gap = "";
  }
  flush();
  return out;
}
