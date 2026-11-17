import { batch, signal } from "nsh";

/**
 * Adaptive frame-paced buffer for streaming reply text.
 *
 * Bursty network deltas (> 8 chars) drain across 16ms ticks with exponential
 * catch-up (`ceil(backlog * 0.3)`, at least 6 chars) so sudden multi-line packets
 * flow into layout smoothly without multi-line jumps, while settled messages,
 * historical loads, seeded re-attaches, and `reduceMotion` always bypass buffering.
 *
 * A cut is also a fade boundary (`veil.ts`): half a word fading in, then the
 * other half fading in again, reads as a broken typewriter. So each cut lands
 * on a word's edge — back first, then forward — and what is left at the end
 * of a reply drains in one piece rather than a syllable a frame.
 */

const PACER_TICK_MS = 16;
const PACER_IMMEDIATE_CHARS = 8;
const PACER_SEED_CHARS = 240;

interface PacerEntry {
  raw: string;
  shownLen: number;
  tick: ReturnType<typeof signal<number>>;
}

const entries = new Map<string, PacerEntry>();
const seededIds = new Set<string>();
let drainTimer: ReturnType<typeof setTimeout> | undefined;

function commonSafePrefix(a: string, b: string): number {
  let p = 0;
  const n = Math.min(a.length, b.length);
  while (p < n && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  if (p > 0 && p < b.length) {
    const c = b.charCodeAt(p - 1);
    if (c >= 0xd800 && c <= 0xdbff) p--;
  }
  return p;
}

/**
 * How far a cut may move to land on a word's edge instead of inside one. A cut
 * is a fade boundary: half a word fading in, then the other half fading in
 * again, reads as a broken typewriter. It looks back first (it never commits
 * more than its own step), then forward (finishing the word it landed in), so
 * each word fades once, whole.
 */
const PACER_BACK_WITHIN = 24;
const PACER_FORWARD_WITHIN = 8;
/** Below this much left to commit, the rest goes in one piece: no use cutting a
 * word's tail into frames of a syllable each. */
const PACER_TAIL_CHARS = 12;

/** CJK and other unspaced scripts: their words are laid out by the shaper, so a
 * cut between two of their glyphs is not a cut inside a word to the reader. */
const UNSPACED = /[\u2E80-\u9FFF\u3000-\u303F\uF900-\uFAFF\uAC00-\uD7AF\uFF00-\uFFEF]/;

/** Whether a break may fall between `a` and `b`: on a space or punctuation, or
 * anywhere in a script without word gaps — never between two letters of a word. */
function breakableHere(a: string, b: string): boolean {
  if (/\s/.test(a) || /\s/.test(b)) return true;
  if (UNSPACED.test(a) || UNSPACED.test(b)) return true;
  return !(/[\p{L}\p{N}]/u.test(a) && /[\p{L}\p{N}]/u.test(b));
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** Moves `end` onto the nearest clean break (back first, then forward); left where it is when none is near. */
function snapToWord(raw: string, pos: number, end: number): number {
  if (end <= pos || end >= raw.length) return end;
  const clean = (at: number) =>
    at > pos &&
    at < raw.length &&
    !isHighSurrogate(raw.charCodeAt(at - 1)) &&
    !isLowSurrogate(raw.charCodeAt(at)) &&
    breakableHere(raw[at - 1], raw[at]);
  if (clean(end)) return end;
  for (let at = end - 1; at > pos && end - at <= PACER_BACK_WITHIN; at--) {
    if (clean(at)) return at;
  }
  for (let at = end + 1; at < raw.length && at - end <= PACER_FORWARD_WITHIN; at++) {
    if (clean(at)) return at;
  }
  return end;
}

/** How many chars a frame takes of what is left, before the cut is moved onto a word's edge. */
const PACER_STEP_SHARE = 0.3;
const PACER_STEP_MIN = 6;

function nextSliceEnd(raw: string, pos: number, rem: number): number {
  // What is left is not worth cutting again: it drains as one piece.
  if (rem <= Math.max(PACER_IMMEDIATE_CHARS, PACER_TAIL_CHARS)) return raw.length;
  const step = Math.max(PACER_STEP_MIN, Math.ceil(rem * PACER_STEP_SHARE));
  let end = Math.min(raw.length, pos + step);
  // A cut never falls inside a character whose UTF-16 form is two code units.
  if (end > pos && end < raw.length && isHighSurrogate(raw.charCodeAt(end - 1))) end++;
  return snapToWord(raw, pos, end);
}

function drain() {
  drainTimer = undefined;
  let again = false;
  batch(() => {
    for (const entry of entries.values()) {
      const rem = entry.raw.length - entry.shownLen;
      if (rem <= 0) continue;
      entry.shownLen = nextSliceEnd(entry.raw, entry.shownLen, rem);
      entry.tick.update((n) => (n ?? 0) + 1);
      if (entry.shownLen < entry.raw.length) again = true;
    }
  });
  if (again) ensureDrainTimer();
}

function ensureDrainTimer() {
  if (drainTimer !== undefined) return;
  drainTimer = setTimeout(drain, PACER_TICK_MS);
}

/** Marks existing row ids as seeded so initial re-attaches display existing text immediately. */
export function markPacersSeeded(ids: Iterable<string>): void {
  for (const id of ids) seededIds.add(id);
}

/** Clears all pacer buffers and timers across conversation switches. */
export function clearPacers(): void {
  if (drainTimer !== undefined) {
    clearTimeout(drainTimer);
    drainTimer = undefined;
  }
  entries.clear();
  seededIds.clear();
}

/** Returns the display-ready prefix for a streaming reply row. */
export function pacedStreamText(id: string, text: string, streaming: boolean, reduced = false): string {
  if (!streaming || reduced) {
    entries.delete(id);
    seededIds.delete(id);
    return text;
  }

  if (seededIds.delete(id)) {
    entries.set(id, { raw: text, shownLen: text.length, tick: signal(0) });
    return text;
  }

  let entry = entries.get(id);
  if (!entry) {
    if (text.length > PACER_SEED_CHARS) {
      entries.set(id, { raw: text, shownLen: text.length, tick: signal(0) });
      return text;
    }
    entry = { raw: text, shownLen: 0, tick: signal(0) };
    entries.set(id, entry);
  }

  if (text !== entry.raw) {
    if (entry.shownLen > 0) {
      const shownPrefix = entry.raw.slice(0, entry.shownLen);
      if (!text.startsWith(shownPrefix)) {
        entry.shownLen = commonSafePrefix(shownPrefix, text);
      }
    }
    entry.raw = text;
  }

  const rem = text.length - entry.shownLen;
  if (rem <= PACER_IMMEDIATE_CHARS) {
    entry.shownLen = text.length;
    return text;
  }

  if (entry.shownLen === 0 || drainTimer === undefined) {
    entry.shownLen = nextSliceEnd(text, entry.shownLen, rem);
  }
  entry.tick();
  if (entry.shownLen < text.length) ensureDrainTimer();
  return text.slice(0, entry.shownLen);
}
