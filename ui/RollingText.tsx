import { cleanup, computed, createAnimatedValue, effect, reduceMotion, signal, Text, untracked, View } from "nsh";
import type { ViewStyle } from "nsh";
import { EASING } from "./motion";

/**
 * Status words that change in place — "Thinking" morphing into "Reading
 * file.ts" as work goes on.
 *
 * In `pace` mode (aggregated tool-call rows and live turn previews), rapid
 * bursts are paced to a calm human-readable cadence with a two-layer vertical
 * cross-glide (outgoing eases up and out while incoming glides up from below),
 * eliminating hard opacity drops, rapid text jitter, and running <-> settled
 * ping-pong between consecutive steps. Discrete one-shot labels (turn header
 * completion, individual tool verbs) swap immediately with a gentle settle.
 *
 * `id` names the row the words belong to: a recycled `List` cell rebound to
 * another row snaps to its words instead of animating between two rows'
 * states. Single-instance text can leave it out.
 */
const BOX_ONLY_CLASSES = new Set(["min-w-0", "shrink", "shrink-0", "flex-1", "grow", "truncate"]);
const MAX_LINE_CHARS = 320;
const OUT_OPACITY_MS = 115;
const OUT_MOVE_MS = 145;
const IN_DELAY_MS = 35;
const IN_OPACITY_MS = 155;
const IN_MOVE_DELAY_MS = 20;
const IN_MOVE_MS = 180;
const ANIM_LOCK_MS = IN_MOVE_DELAY_MS + IN_MOVE_MS;
const LIVE_DWELL_MS = 380;
const SETTLE_HOLD_MS = 340;
const DISCRETE_COALESCE_MS = 180;
const DISCRETE_SETTLE_MS = 185;

export function RollingText(props: {
  id?: () => string;
  text: () => string;
  /** Calm dwell pacing + two-layer cross-glide for high-frequency live status streams. */
  pace?: boolean;
  /** Whether the underlying activity is currently settled (non-running); used with `pace`. */
  settled?: () => boolean;
  /** Whether more steps may still join this group (holds settled summaries briefly to avoid ping-pong). */
  holdSettle?: () => boolean;
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
  const leaving = signal<string | undefined>(undefined);
  const morphing = signal(false);
  const inOpacity = createAnimatedValue(1);
  const inY = createAnimatedValue(0);
  const outOpacity = createAnimatedValue(0);
  const outY = createAnimatedValue(0);

  let trackedId = props.id ? untracked(props.id) : undefined;
  let lastCommitAt = props.pace ? Date.now() : 0;
  let pendingText: string | undefined;
  let pendingDueAt = 0;
  let settleHoldAt: number | undefined;
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;
  let leaveTimer: ReturnType<typeof setTimeout> | undefined;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;

  const clearTimers = () => {
    clearTimeout(pendingTimer);
    clearTimeout(leaveTimer);
    clearTimeout(settleTimer);
    pendingTimer = undefined;
    leaveTimer = undefined;
    settleTimer = undefined;
  };

  const snap = (text: string, now: number) => {
    clearTimers();
    pendingText = undefined;
    pendingDueAt = 0;
    settleHoldAt = undefined;
    lastCommitAt = props.pace ? now : 0;
    leaving.set(undefined);
    morphing.set(false);
    void inOpacity.stop();
    void inY.stop();
    void outOpacity.stop();
    void outY.stop();
    inOpacity.set(1);
    inY.set(0);
    outOpacity.set(0);
    outY.set(0);
    shown.set(text);
  };

  const commitPaced = (next: string, reduced: boolean) => {
    pendingTimer = undefined;
    pendingText = undefined;
    pendingDueAt = 0;
    const prev = shown();
    if (next === prev) return;
    lastCommitAt = Date.now();
    clearTimeout(leaveTimer);
    clearTimeout(settleTimer);
    leaveTimer = undefined;
    settleTimer = undefined;

    if (reduced || !prev || !next) {
      leaving.set(undefined);
      morphing.set(false);
      void inOpacity.stop();
      void inY.stop();
      void outOpacity.stop();
      void outY.stop();
      inOpacity.set(1);
      inY.set(0);
      outOpacity.set(0);
      outY.set(0);
      shown.set(next);
      return;
    }

    morphing.set(true);
    leaving.set(prev);
    shown.set(next);
    void outOpacity.stop();
    void outY.stop();
    void inOpacity.stop();
    void inY.stop();
    outOpacity.set(1);
    outY.set(0);
    inOpacity.set(0);
    inY.set(6);
    void outOpacity.timing(0, { duration: OUT_OPACITY_MS, easing: EASING.exit });
    void outY.timing(-6, { duration: OUT_MOVE_MS, easing: EASING.exit });
    void inOpacity.timing(1, { duration: IN_OPACITY_MS, delay: IN_DELAY_MS, easing: EASING.entrance });
    void inY.timing(0, { duration: IN_MOVE_MS, delay: IN_MOVE_DELAY_MS, easing: EASING.signature });
    leaveTimer = setTimeout(() => {
      leaveTimer = undefined;
      leaving.set(undefined);
    }, OUT_MOVE_MS + 16);
    settleTimer = setTimeout(() => {
      settleTimer = undefined;
      morphing.set(false);
    }, ANIM_LOCK_MS + 16);
  };

  effect(() => {
    const next = line();
    const bound = props.id?.();
    const reduced = reduceMotion();
    const isSettled = props.pace ? (props.settled?.() ?? false) : false;
    const hold = props.pace ? (props.holdSettle?.() ?? false) : false;
    untracked(() => {
      const now = Date.now();
      if (bound !== trackedId) {
        trackedId = bound;
        snap(next, now);
        return;
      }

      if (!props.pace) {
        if (next === shown()) return;
        shown.set(next);
        if (reduced) {
          snap(next, now);
          return;
        }
        clearTimeout(settleTimer);
        morphing.set(true);
        settleTimer = setTimeout(() => {
          settleTimer = undefined;
          morphing.set(false);
        }, DISCRETE_SETTLE_MS);

        if (now - lastCommitAt >= DISCRETE_COALESCE_MS) {
          lastCommitAt = now;
          void inOpacity.stop();
          void inY.stop();
          inOpacity.set(0.52);
          inY.set(3);
          void inOpacity.timing(1, { duration: IN_OPACITY_MS, easing: EASING.entrance });
          void inY.timing(0, { duration: IN_MOVE_MS, easing: EASING.signature });
        }
        return;
      }

      if (isSettled && hold) settleHoldAt ??= now;
      else settleHoldAt = undefined;

      if (next === shown()) {
        clearTimeout(pendingTimer);
        pendingTimer = undefined;
        pendingText = undefined;
        pendingDueAt = 0;
        return;
      }

      if (!shown() || !next) {
        clearTimeout(pendingTimer);
        commitPaced(next, reduced);
        return;
      }

      const elapsed = now - lastCommitAt;
      let delay = 0;
      if (isSettled) {
        if (hold) {
          const holdLeft = settleHoldAt !== undefined ? SETTLE_HOLD_MS - (now - settleHoldAt) : SETTLE_HOLD_MS;
          delay = Math.max(0, LIVE_DWELL_MS - elapsed, holdLeft);
        } else {
          delay = morphing() ? Math.max(0, ANIM_LOCK_MS - elapsed) : 0;
        }
      } else {
        delay = Math.max(0, LIVE_DWELL_MS - elapsed);
      }

      if (delay <= 0) {
        clearTimeout(pendingTimer);
        commitPaced(next, reduced);
        return;
      }

      const dueAt = now + delay;
      pendingText = next;
      // Keep the earliest deadline during live bursts so continuous streams step
      // on a steady rhythm instead of starving, release early if `holdSettle`
      // drops, and extend when entering a settle-hold so brief inter-step gaps
      // never flash the settled summary prematurely.
      const extendHold = isSettled && hold && dueAt > pendingDueAt + 8;
      if (!pendingTimer || dueAt < pendingDueAt - 8 || extendHold) {
        clearTimeout(pendingTimer);
        pendingDueAt = dueAt;
        pendingTimer = setTimeout(() => {
          const target = pendingText;
          if (target !== undefined) commitPaced(target, untracked(reduceMotion));
        }, delay);
      }
    });
  });

  cleanup(() => {
    clearTimers();
    void inOpacity.stop();
    void inY.stop();
    void outOpacity.stop();
    void outY.stop();
  });

  return (
    <View
      class={`relative flex-row items-center overflow-hidden ${boxClass()}`}
      style={props.style}
      testID={morphing() ? "rolling-born" : undefined}
    >
      <If when={leaving()}>
        {(prev) => (
          <Text
            class={`pointer-events-none absolute inset-x-0 top-0 line-clamp-1 truncate ${textClass()}`}
            style={{ opacity: outOpacity, transform: [{ translateY: outY }] }}
          >
            {prev()}
          </Text>
        )}
      </If>
      <Text
        class={`${canTruncate() ? "min-w-0 shrink truncate " : "shrink-0 "}line-clamp-1 ${textClass()}`}
        style={{ opacity: inOpacity, transform: [{ translateY: inY }] }}
      >
        {shown()}
      </Text>
    </View>
  );
}
