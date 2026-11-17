// Streaming fade veil:
//
// - Streamed text commits to layout immediately (zero positional offset).
// - Each rendered element inside a row (`ElemVeil`) tracks its own previously
//   committed flat text independently, so multiple paragraphs, headings, list
//   items, blockquotes, and code blocks never clobber each other's fade state.
// - Per-chunk fade duration adapts to stream cadence via EMA (`clamp(ema * 3, 120, 400)`),
//   with a fast-stream boost when 3+ chunks are fading concurrently.
// - Attach baseline seeding prevents re-fading already-streamed content when
//   switching back to a session or recycling a `List` cell.

/** EMA seed for the inter-append gap (`VEIL_EMA_SEED_MS`). */
export const VEIL_EMA_SEED_MS = 90;
/** Duration clamp (`VEIL_MIN_FADE_MS` / `VEIL_MAX_FADE_MS`). */
export const VEIL_MIN_FADE_MS = 100;
export const VEIL_MAX_FADE_MS = 240;
/** Dissolve exponent (`1 - (1 - p)^1.6`). */
export const VEIL_CURVE_POW = 1.6;
/** Gap clamp feeding the EMA (`min(gap, 1000)`). */
const VEIL_GAP_CLAMP_MS = 1000;
/** First-seen text longer than this indicates re-attaching mid-reply: seed baseline. */
export const VEIL_ATTACH_SEED_CHARS = 240;

/**
 * How long the fade takes to travel the whole of one appended chunk (ms). A
 * chunk is what arrived between two frames: at a fast stream that is a couple
 * of words, at a burst a whole line. Lit on one frame it is a slab that pops;
 * travelling word by word it reads as the reply being written. Bounded, so a
 * long chunk is a sweep and not a crawl, and so no chunk outlives its fade by
 * more than this.
 */
export const VEIL_WAVE_MS = 36;

/** Text alpha for fade progress `p` (0..1): `1 - (1 - p)^1.6`. */
export function veilOpacity(p: number): number {
  const q = Math.min(1, Math.max(0, p));
  return 1 - Math.pow(1 - q, VEIL_CURVE_POW);
}

/** Chunk fade duration from inter-append EMA (`clamp(ema * 3, 120, 400)`). */
export function veilDurationMs(emaMs: number): number {
  return Math.min(VEIL_MAX_FADE_MS, Math.max(VEIL_MIN_FADE_MS, emaMs * 3));
}

/** Fast-stream boost: 3+ concurrent chunks speed up by 30% each (`1 + 0.3 * max(0, n - 2)`). */
export function veilBoost(activeChunks: number): number {
  return 1 + 0.3 * Math.max(0, activeChunks - 2);
}

/** EMA update on a new append gap (`ema * 0.7 + min(gap, 1000) * 0.3`). */
export function veilEmaNext(emaMs: number, gapMs: number): number {
  return emaMs * 0.7 + Math.min(gapMs, VEIL_GAP_CLAMP_MS) * 0.3;
}

/** Longest common prefix length of `a` and `b`, snapped back so it never splits
 * a UTF-16 surrogate pair (`common_prefix`). */
export function commonPrefix(a: string, b: string): number {
  let p = 0;
  const n = Math.min(a.length, b.length);
  while (p < n && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  if (p > 0 && p < b.length) {
    const c = b.charCodeAt(p - 1);
    if (c >= 0xd800 && c <= 0xdbff) p--;
  }
  return p;
}

/** One appended chunk of text mid-fade. */
export interface VeilChunk {
  /** UTF-16 range `[start, end)` within the element's flat text. */
  start: number;
  end: number;
  startedAt: number;
  /** Fade duration (ms) fixed at arrival from the cadence EMA. */
  durationMs: number;
  /** Where each word of the chunk starts fading, by its offset in the chunk, in ms from `startedAt`:
   * the fade travels through the chunk word by word instead of lighting all of it on one frame. */
  wave?: { last: number; at: Map<number, number> };
  /** Highest normalized progress its last word reached (below 0 until the wave gets there), so
   * retiring earlier chunks never regresses alpha. The chunk is done when its last word is. */
  peak?: number;
}

/** Per-element chunk tracker (`ElemVeil`). */
export interface ElemVeil {
  prev: string;
  chunks: VeilChunk[];
  emaMs: number;
  lastAppend: number | null;
}

/** Per-row veil state keyed by element discriminator (`RowVeil`). */
export interface RowVeil {
  elems: Map<string, ElemVeil>;
  /** True during the initial attach pass of a non-streaming or mid-stream-reattached row. */
  seeding: boolean;
  initialized: boolean;
  /** Block indexes already surfaced, so newly-created structural blocks can fade smoothly once. */
  seenBlocks: number;
  blockNodes: Map<number, unknown>;
}

const rowVeils = new Map<string, RowVeil>();
const seededVeilIds = new Set<string>();

/** Marks row ids whose initial attach pass should seed existing text without re-fading from alpha 0. */
export function markVeilsSeeded(ids: Iterable<string>): void {
  for (const id of ids) seededVeilIds.add(id);
}

function createElemVeil(seed = ""): ElemVeil {
  return {
    prev: seed,
    chunks: [],
    emaMs: VEIL_EMA_SEED_MS,
    lastAppend: null,
  };
}

/** Returns (or creates) the `RowVeil` for row `id`. */
export function rowVeil(id: string): RowVeil {
  let v = rowVeils.get(id);
  if (!v) {
    v = {
      elems: new Map(),
      seeding: seededVeilIds.delete(id),
      initialized: false,
      seenBlocks: 0,
      blockNodes: new Map(),
    };
    rowVeils.set(id, v);
  } else if (!v.initialized && seededVeilIds.delete(id)) {
    v.seeding = true;
  }
  return v;
}

/** Begins a document pass on `v`, determining whether initial elements should seed without fading. */
export function beginVeilPass(v: RowVeil, totalChars: number, streaming: boolean): void {
  if (!v.initialized) {
    v.initialized = true;
    // Historical rows or mid-reply session re-attaches adopt existing text as baseline without fading.
    if (!streaming || totalChars > VEIL_ATTACH_SEED_CHARS) {
      v.seeding = true;
    }
  }
}

/** Completes the initial attach pass so any blocks/elements arriving afterwards fade normally. */
export function finishVeilPass(v: RowVeil): void {
  v.seeding = false;
}

/**
 * Where each word of an appended `piece` starts fading, by its offset in the
 * chunk, in ms from the chunk's arrival: every word takes its turn, the first
 * at once and the last `VEIL_WAVE_MS` later. A cut inside a word (a span
 * boundary in the renderer) reads the word it is in.
 */
export function waveOf(piece: string): { last: number; at: Map<number, number> } {
  const words: number[] = [];
  let at = 0;
  while (at < piece.length) {
    // A word runs to the space after it, so a word and the gap before the next fade as one.
    const next = piece.slice(at).search(/\s/);
    const stop = next === -1 ? piece.length : at + next;
    if (stop > at) words.push(at);
    at = stop + 1;
  }
  const turns = Math.max(1, words.length - 1);
  const map = new Map<number, number>();
  words.forEach((word, i) => map.set(word, Math.round((VEIL_WAVE_MS * i) / turns * 10) / 10));
  return { last: words.length > 1 ? map.get(words[words.length - 1])! : 0, at: map };
}

/** The delay (ms) a word `offset` characters into `chunk` waits for: the turn of the word it is in. */
export function waveDelay(chunk: VeilChunk, offset: number): number {
  const wave = chunk.wave;
  if (!wave) return 0;
  // The last word start at or before `offset`: its turn is the one this character waits for.
  let turn = 0;
  let found = false;
  for (const [at, waits] of wave.at) {
    if (at > offset) continue;
    if (!found || at >= turn) {
      turn = at;
      found = true;
    }
  }
  return found ? wave.at.get(turn)! : wave.last;
}

/** Advances a single element (`elemKey`) inside `v` to `text` at `now` (ms).
 * Idempotent when `text` is unchanged; returns active fading chunks for this element. */
export function advanceElemVeil(v: RowVeil, elemKey: string, text: string, now: number): VeilChunk[] {
  if (v.seeding && !v.elems.has(elemKey)) {
    v.elems.set(elemKey, createElemVeil(text));
    return [];
  }
  let el = v.elems.get(elemKey);
  if (!el) {
    el = createElemVeil();
    v.elems.set(elemKey, el);
  }

  if (text !== el.prev) {
    const p = commonPrefix(el.prev, text);
    el.chunks = el.chunks.filter((c) => {
      c.end = Math.min(c.end, p);
      return c.start < c.end;
    });
    if (text.length > p) {
      if (el.lastAppend !== null) {
        el.emaMs = veilEmaNext(el.emaMs, Math.max(0, now - el.lastAppend));
      }
      el.lastAppend = now;
      el.chunks.push({
        start: p,
        end: text.length,
        startedAt: now,
        durationMs: veilDurationMs(el.emaMs),
        wave: waveOf(text.slice(p)),
      });
    }
    el.prev = text;
  }

  pruneSettledChunks(el.chunks, now);
  return el.chunks;
}

/**
 * Prunes settled chunks in place at `now`, matching the per-frame
 * `ElemVeil::advance` retain (`elapsed * boost < duration_ms`). Mutating in
 * place keeps `chunkAlpha` monotonic across intermediate animation frames even
 * when no new text delta has arrived yet: once a boosted chunk reaches full
 * opacity it stays retired, so later frames never see `boost` snap backward
 * when its unboosted `durationMs` elapses.
 */
export function pruneSettledChunks(chunks: VeilChunk[], now: number): number {
  if (chunks.length === 0) return 1;
  const initialBoost = veilBoost(chunks.length);
  let write = 0;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const p = Math.max(c.peak ?? Number.NEGATIVE_INFINITY, progressOf(c, now, initialBoost));
    c.peak = p;
    if (p < 1) {
      chunks[write++] = c;
    }
  }
  chunks.length = write;
  return veilBoost(chunks.length);
}

/** How far the fade of `c`'s last word has got at `now`: the wave reaches it `wave.last` after arrival. */
function progressOf(c: VeilChunk, now: number, boost: number): number {
  const spent = now - c.startedAt;
  if (!c.wave) return (spent * boost) / c.durationMs;
  return ((spent - c.wave.last) * boost) / c.durationMs;
}

/** The text alpha (0..1) of `chunk` at `now`, one of the element's `chunks`: a
 * backed-up stream (3+ fading at once) runs its fades faster. 1 once settled. */
export function chunkAlpha(chunks: VeilChunk[], chunk: VeilChunk, now: number, offset?: number): number {
  const boost = pruneSettledChunks(chunks, now);
  if (!chunks.includes(chunk)) return 1;
  // The last word's progress is the chunk's: what it has done, never undone by a later frame.
  const tail = Math.max(chunk.peak ?? Number.NEGATIVE_INFINITY, progressOf(chunk, now, boost));
  chunk.peak = tail;
  if (tail >= 1) {
    const idx = chunks.indexOf(chunk);
    if (idx >= 0) chunks.splice(idx, 1);
    return 1;
  }
  if (offset === undefined || !chunk.wave) return veilOpacity(tail);
  // A word is ahead of the last one by the turns between them: the wave's head leads, its tail follows.
  const ahead = ((chunk.wave.last - waveDelay(chunk, offset)) * boost) / chunk.durationMs;
  return veilOpacity(tail + ahead);
}

/** Upper bound on when the last of `chunks` finishes fading — its last word, counted (0 when empty). */
export function veilEnd(chunks: readonly VeilChunk[]): number {
  let end = 0;
  for (const c of chunks) end = Math.max(end, c.startedAt + c.durationMs + (c.wave?.last ?? 0));
  return end;
}

/** Legacy single-element wrapper kept for compatibility. */
export function advanceVeil(v: RowVeil, text: string, now: number, attachSeeds = false): VeilChunk[] {
  beginVeilPass(v, text.length, !attachSeeds);
  const out = advanceElemVeil(v, "root", text, now);
  finishVeilPass(v);
  return out;
}

/** Settles all elements in `v` immediately (stream finished or reduced motion). */
export function settleVeil(v: RowVeil, text?: string): void {
  v.seeding = false;
  for (const el of v.elems.values()) {
    el.chunks = [];
  }
  if (text !== undefined) {
    const root = v.elems.get("root");
    if (root) root.prev = text;
  }
}

/** Whether any element in `v` still has chunks actively fading. */
export function veilIsFading(v: RowVeil): boolean {
  for (const el of v.elems.values()) {
    if (el.chunks.length > 0) return true;
  }
  return false;
}

/** Intersects chunk ranges with `[start, end)` shifted to local offsets (`slice_spans`). */
export function sliceChunks(chunks: readonly VeilChunk[], start: number, end: number): { start: number; end: number; chunk: VeilChunk }[] {
  if (chunks.length === 0 || start >= end) return [];
  const out: { start: number; end: number; chunk: VeilChunk }[] = [];
  for (const c of chunks) {
    const s = Math.max(c.start, start);
    const e = Math.min(c.end, end);
    if (s < e) out.push({ start: s - start, end: e - start, chunk: c });
  }
  return out;
}

/** Clears all veil states across session switches. */
export function clearVeils(): void {
  rowVeils.clear();
  seededVeilIds.clear();
}
