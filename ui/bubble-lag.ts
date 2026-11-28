// iMessage's arrival: a new bubble opens its room under the column, the column
// glides up to make it, and the bubbles above follow it the way a chain of
// springs does — the nearest at once, each one further up a touch later and a
// touch further behind — then all of them settle together. Nothing here lays
// anything out: the room is `Collapsible`'s native reveal, the glide is the
// list's animated scroll, and the lag is one compositor `translateY` per row.

import {
  Animated,
  type AnimatedValue,
  batch,
  cleanup,
  type CompositeAnimation,
  createAnimatedValue,
  effect,
  reduceMotion,
  signal,
  untracked,
} from "nsh";
import { isLiveArrival, isRowSeen } from "./motion";

/**
 * The lag's physics, in points and milliseconds. A row `rank` bubbles above
 * the arrival falls `min(rank, RANKS) * STEP` points behind the glide (scaled
 * by how far the column moves, never past `CAP`), reaching it over
 * `RISE + rank * RISE_STEP` ms as the glide pulls away, then springs home on a
 * near-critically damped spring (ζ ≈ 0.93: no oscillation, a 0.1pt overshoot
 * at most). Neighbours differ by `STEP` at most, well under the 3pt between
 * clustered bubbles, so rows never touch; the whole column stretches by `CAP`
 * at most, then gathers.
 */
export const LAG = {
  STEP: 1.1,
  CAP: 6,
  RANKS: 6,
  /** The glide the amplitudes are tuned for: a one-line bubble and its seat. */
  REFERENCE_GAP: 64,
  RISE: 56,
  RISE_STEP: 10,
  SPRING: { stiffness: 240, damping: 29, mass: 1 },
} as const;

/** How long after an arrival's glide starts the column counts as settled. */
export const ARRIVAL_SETTLE_MS = 460;

interface Wave {
  seq: number;
  gap: number;
  ranks: ReadonlyMap<string, number>;
}

const wave = signal<Wave | undefined>(undefined);
let waveSeq = 0;

/** The arrivals in flight: rows whose room has opened and whose glide has not settled. */
const arrivals = signal(0);
const arrivedRow = signal<{ id: string; seq: number } | undefined>(undefined);
let arrivalSeq = 0;

/** A row's room opened this frame (`TranscriptRow`): the list holds its offset for the glide. */
export function noteArrival(id: string, open: () => void) {
  batch(() => {
    open();
    arrivals.update((n) => n + 1);
    arrivedRow.set({ id, seq: ++arrivalSeq });
  });
}

/** The shape of a transcript row this needs to know: what it is, and how it was seen. */
interface ArrivalRow {
  kind: string;
  id: string;
  sms?: unknown;
  edited?: boolean;
  rowId?: string;
}

/** A row that arrives with a room of its own when it lands at the end: a persona conversation's
 * bubbles (Pip's, unless an edit or loaded history; the reader's) and the footer under a reply. */
export function arrivingRow(row: ArrivalRow): boolean {
  if (!isLiveArrival(row.id)) return false;
  if (row.kind === "pip-bubble") return !row.edited && !(row.rowId && isRowSeen(row.rowId));
  return (row.kind === "user" && Boolean(row.sms)) || row.kind === "pip-footer";
}

let arrivalTail: () => ReadonlySet<string> = () => new Set();
/** The conversation names the rows arriving at its end (`views/Chat.tsx`), read in the commit they land in. */
export function provideArrivalTail(tail: () => ReadonlySet<string>) {
  arrivalTail = tail;
  cleanup(() => {
    if (arrivalTail === tail) arrivalTail = () => new Set();
  });
}
/** Whether `id` is arriving at the conversation's end now. */
export const isArrivalTail = (id: string) => arrivalTail().has(id);

/** The latest arrival, for the conversation to glide to. */
export const latestArrival = () => arrivedRow();
/** Bumped each time the column settles, for what reads arrivals off rows to read them again. */
const settled = signal(0);
/** Read it where arrivals are read off rows: they are read again once the column settles. */
export const arrivalEpoch = () => settled();
/** Whether the list should hold its offset: an arrival's glide is still in flight, or `pending` (a row
 * about to arrive, read off the rows in the commit they change: the room a receipt gives up there must
 * not be followed on its own a frame ahead of the room that takes it). */
export const arrivalHeld = (pending: () => boolean) => arrivals() > 0 || pending();
/** The glide has settled: the list may follow the end on its own again. */
export function settleArrivals() {
  batch(() => {
    if (untracked(arrivals)) arrivals.set(0);
    settled.update((n) => n + 1);
  });
}

/**
 * Sends the wave up the column: `above` is the conversation's rows above the
 * arrival, nearest first; `gap` how far the column glides (negative: down).
 */
export function pushWave(above: readonly string[], gap: number) {
  if (untracked(reduceMotion) || Math.abs(gap) < 4) return;
  const ranks = new Map<string, number>();
  above.forEach((id, at) => ranks.set(id, at + 1));
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
      const rank = current.ranks.get(rowId);
      if (!rank || reduceMotion()) return;
      const k = Math.min(rank, LAG.RANKS);
      const scale = Math.min(1.25, Math.max(0.5, Math.abs(current.gap) / LAG.REFERENCE_GAP));
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
