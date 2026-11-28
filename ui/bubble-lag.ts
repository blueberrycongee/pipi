// Subtle iMessage elastic lag for settled bubbles above a newly appended
// persona message: as `nsh`'s native critically damped spring scrolls the
// column upward, settled bubbles above trail by 1–5pt and gather back home
// without oscillation. Flying throw-animation slots are excluded so their
// landing targets stay pixel-exact.

import {
  Animated,
  type AnimatedValue,
  cleanup,
  type CompositeAnimation,
  createAnimatedValue,
  effect,
  reduceMotion,
  signal,
  untracked,
} from "nsh";
import { isSmsBubbleFlying } from "./pip-throw";

/**
 * The lag's physics, in points and milliseconds. A row `rank` bubbles above
 * the arrival falls `min(rank, RANKS) * STEP` points behind the scroll (scaled
 * by how far the column moves, never past `CAP`), reaching it over
 * `RISE + rank * RISE_STEP` ms as the list pulls away, then springs home on a
 * near-critically damped spring (ζ ≈ 0.93: no oscillation, a 0.1pt overshoot
 * at most). Neighbours differ by `STEP` at most, well under the 3pt between
 * clustered bubbles, so rows never touch.
 */
export const LAG = {
  STEP: 1.0,
  CAP: 5.5,
  RANKS: 6,
  /** The glide the amplitudes are tuned for: a one-line bubble and its seat. */
  REFERENCE_GAP: 64,
  RISE: 52,
  RISE_STEP: 9,
  SPRING: { stiffness: 250, damping: 30, mass: 1 },
} as const;

interface Wave {
  seq: number;
  gap: number;
  ranks: ReadonlyMap<string, number>;
}

const wave = signal<Wave | undefined>(undefined);
let waveSeq = 0;

/**
 * Sends the wave up the column: `above` is the conversation's settled rows
 * above the arrival, nearest first; `gap` how far the column moves (positive:
 * upward scroll).
 */
export function pushWave(above: readonly string[], gap: number) {
  if (untracked(reduceMotion) || Math.abs(gap) < 4) return;
  const ranks = new Map<string, number>();
  let rank = 0;
  for (const id of above) {
    if (isSmsBubbleFlying(id)) continue;
    ranks.set(id, ++rank);
    if (rank >= LAG.RANKS * 2) break;
  }
  if (ranks.size === 0) return;
  wave.set({ seq: ++waveSeq, gap, ranks });
}

/** The lag of one row: bind it as a `translateY` (added to whatever else moves the row). */
export function useBubbleLag(id: () => string): AnimatedValue {
  const lag = createAnimatedValue(0);
  let running: CompositeAnimation | undefined;
  let played = untracked(wave)?.seq ?? 0;
  let bound = "";
  const stop = () => {
    running?.stop();
    running = undefined;
  };
  effect(() => {
    const rowId = id();
    const current = wave();
    untracked(() => {
      if (rowId !== bound) {
        // A recycled cell carries no other row's motion.
        bound = rowId;
        stop();
        lag.set(0);
      }
      if (!current || current.seq === played) return;
      played = current.seq;
      if (isSmsBubbleFlying(rowId)) {
        stop();
        lag.set(0);
        return;
      }
      const rank = current.ranks.get(rowId);
      if (!rank || reduceMotion()) return;
      const k = Math.min(rank, LAG.RANKS);
      const scale = Math.min(1.2, Math.max(0.55, Math.abs(current.gap) / LAG.REFERENCE_GAP));
      const behind = Math.sign(current.gap) * Math.min(LAG.CAP, k * LAG.STEP * scale);
      stop();
      running = Animated.sequence([
        Animated.timing(lag, { toValue: behind, duration: LAG.RISE + k * LAG.RISE_STEP, easing: "easeOut" }),
        Animated.spring(lag, { toValue: 0, ...LAG.SPRING }),
      ]);
      void running.start();
    });
  });
  cleanup(stop);
  return lag;
}
