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
export const VEIL_EMA_SEED_MS = 160;
/** Duration clamp (`VEIL_MIN_FADE_MS` / `VEIL_MAX_FADE_MS`). */
export const VEIL_MIN_FADE_MS = 120;
export const VEIL_MAX_FADE_MS = 400;
/** Dissolve exponent (`1 - (1 - p)^1.6`). */
export const VEIL_CURVE_POW = 1.6;
/** Gap clamp feeding the EMA (`min(gap, 1000)`). */
const VEIL_GAP_CLAMP_MS = 1000;
/** First-seen text longer than this indicates re-attaching mid-reply: seed baseline. */
export const VEIL_ATTACH_SEED_CHARS = 240;

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
      seeding: false,
      initialized: false,
      seenBlocks: 0,
      blockNodes: new Map(),
    };
    rowVeils.set(id, v);
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
      el.chunks.push({ start: p, end: text.length, startedAt: now, durationMs: veilDurationMs(el.emaMs) });
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
    if ((now - c.startedAt) * initialBoost < c.durationMs) {
      chunks[write++] = c;
    }
  }
  chunks.length = write;
  return veilBoost(chunks.length);
}

/** The text alpha (0..1) of `chunk` at `now`, one of the element's `chunks`: a
 * backed-up stream (3+ fading at once) runs its fades faster. 1 once settled. */
export function chunkAlpha(chunks: VeilChunk[], chunk: VeilChunk, now: number): number {
  const boost = pruneSettledChunks(chunks, now);
  if (!chunks.includes(chunk)) return 1;
  return veilOpacity(((now - chunk.startedAt) * boost) / chunk.durationMs);
}

/** Upper bound on when the last of `chunks` finishes fading (0 when empty). */
export function veilEnd(chunks: readonly VeilChunk[]): number {
  let end = 0;
  for (const c of chunks) end = Math.max(end, c.startedAt + c.durationMs);
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
}
