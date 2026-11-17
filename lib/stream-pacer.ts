import { batch, signal } from "nsh";

/**
 * Adaptive frame-paced buffer for streaming reply text.
 *
 * Bursty network deltas (> 8 chars) drain across 16ms ticks with exponential
 * catch-up (`ceil(backlog * 0.25)`) so sudden multi-line packets flow into
 * layout smoothly without multi-line jumps, while settled messages, historical
 * loads, seeded re-attaches, and `reduceMotion` always bypass buffering.
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

function nextSliceEnd(raw: string, pos: number, rem: number): number {
  if (rem <= PACER_IMMEDIATE_CHARS) return raw.length;
  const step = Math.max(4, Math.ceil(rem * 0.25));
  let end = Math.min(raw.length, pos + step);
  if (end > pos && end < raw.length) {
    const code = raw.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end++;
  }
  return end;
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
