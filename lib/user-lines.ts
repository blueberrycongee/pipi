/**
 * Calibrated visual line estimation for sent user bubbles (`views/Rows.tsx`)
 * before the platform's first `onTextLayout` pass runs.
 *
 * Why this matters:
 * - A user bubble renders at `max-w-[70%]` with `px-3.5` (`28pt` horizontal
 *   padding) and `text-md` (`14pt`). In the standard chat column (`max-w-190` /
 *   `~760pt`), the inner text width is ~`504pt` (~82 narrow Latin columns, not
 *   68).
 * - Counting UTF-16 code units (`charCodeAt >= 0x2e80 ? 2 : 1`) treated every
 *   surrogate-pair emoji as 4 columns and ZWJ emoji clusters (`👨‍👩‍👧‍👦`) as
 *   18+ columns, systematically overestimating borderline messages so they
 *   rendered folded (`line-clamp-6`) on Frame 1 and popped open on Frame 2.
 * - Here we segment grapheme clusters (`Intl.Segmenter` when present, with an
 *   equivalent scalar-value cluster scanner for QuickJS), measure calibrated
 *   `14pt` glyph widths with word wrapping, and require a conservative margin
 *   (`USER_PREFOLD_LINES`) before pre-folding wrapped prose without hard breaks.
 */

/** A sent message that lays out past this many lines folds to a preview. */
export const USER_FOLD_LINES = 6;

/**
 * Wrapped prose without >6 hard line breaks only pre-folds ahead of
 * `onTextLayout` once its estimated height clearly clears the 6-line clamp, so
 * borderline messages (~5–7 lines) never fold on Frame 1 and pop open on Frame 2.
 */
export const USER_PREFOLD_LINES = 8;

/** Typical inner text width (pt) of a `max-w-[70%] px-3.5` user bubble in the chat column. */
const USER_BUBBLE_INNER_PT = 504;

type GraphemeSegmenter = {
  segment(input: string): Iterable<{ segment: string }>;
};

const nativeSegmenter: GraphemeSegmenter | undefined = (() => {
  const intl = globalThis.Intl as { Segmenter?: new (locales?: string, options?: { granularity: "grapheme" }) => GraphemeSegmenter } | undefined;
  if (intl && typeof intl.Segmenter === "function") {
    return new intl.Segmenter("en", { granularity: "grapheme" });
  }
  return undefined;
})();

function isRegionalIndicator(cp: number): boolean {
  return cp >= 0x1f1e6 && cp <= 0x1f1ff;
}

function isEmojiScalar(cp: number): boolean {
  return (
    (cp >= 0x1f000 && cp <= 0x1faff) ||
    (cp >= 0x2600 && cp <= 0x27bf) ||
    cp === 0x231a ||
    cp === 0x231b ||
    (cp >= 0x23e9 && cp <= 0x23fa) ||
    cp === 0x2b50 ||
    cp === 0x2b55
  );
}

function isClusterContinuation(cp: number): boolean {
  return (
    cp === 0xfe0e ||
    cp === 0xfe0f ||
    cp === 0x20e3 ||
    (cp >= 0x1f3fb && cp <= 0x1f3ff) ||
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe20 && cp <= 0xfe2f) ||
    (cp >= 0xe0020 && cp <= 0xe007f) ||
    (cp >= 0xe0100 && cp <= 0xe01ef)
  );
}

function isFullwidthScalar(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3040 && cp <= 0xa4cf) ||
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff01 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/** Splits a single line into grapheme clusters without depending on `\p{...}` or `Intl.Segmenter` in QuickJS. */
export function splitGraphemes(line: string): string[] {
  if (!line) return [];
  if (nativeSegmenter) {
    const out: string[] = [];
    for (const part of nativeSegmenter.segment(line)) out.push(part.segment);
    return out;
  }
  const scalars = Array.from(line);
  const clusters: string[] = [];
  let i = 0;
  while (i < scalars.length) {
    let cluster = scalars[i]!;
    const first = cluster.codePointAt(0) ?? 0;
    i++;
    if (isRegionalIndicator(first) && i < scalars.length && isRegionalIndicator(scalars[i]!.codePointAt(0) ?? 0)) {
      cluster += scalars[i]!;
      i++;
    }
    while (i < scalars.length) {
      const cp = scalars[i]!.codePointAt(0) ?? 0;
      if (cp === 0x200d) {
        cluster += scalars[i]!;
        i++;
        if (i < scalars.length) {
          cluster += scalars[i]!;
          i++;
        }
        continue;
      }
      if (isClusterContinuation(cp)) {
        cluster += scalars[i]!;
        i++;
        continue;
      }
      break;
    }
    clusters.push(cluster);
  }
  return clusters;
}

function isNarrowAscii(cp: number): boolean {
  // i l 1 . , : ; ! | ' " ( ) [ ] t f j r I - /
  return (
    cp === 0x69 ||
    cp === 0x6c ||
    cp === 0x31 ||
    cp === 0x2e ||
    cp === 0x2c ||
    cp === 0x3a ||
    cp === 0x3b ||
    cp === 0x21 ||
    cp === 0x7c ||
    cp === 0x27 ||
    cp === 0x22 ||
    cp === 0x28 ||
    cp === 0x29 ||
    cp === 0x5b ||
    cp === 0x5d ||
    cp === 0x74 ||
    cp === 0x66 ||
    cp === 0x6a ||
    cp === 0x72 ||
    cp === 0x49 ||
    cp === 0x2d ||
    cp === 0x2f
  );
}

function isWideAscii(cp: number): boolean {
  // m w M W @ % & G O Q D H N U
  return (
    cp === 0x6d ||
    cp === 0x77 ||
    cp === 0x4d ||
    cp === 0x57 ||
    cp === 0x40 ||
    cp === 0x25 ||
    cp === 0x26 ||
    cp === 0x47 ||
    cp === 0x4f ||
    cp === 0x51 ||
    cp === 0x44 ||
    cp === 0x48 ||
    cp === 0x4e ||
    cp === 0x55
  );
}

/** Explicit newline-delimited paragraph count (`text.split("\n").length`). */
export function hardBreakLines(text: string): number {
  let count = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count++;
  }
  return count;
}

function estimateParagraphLines(line: string, maxWidthPt: number): number {
  if (!line) return 1;
  const clusters = splitGraphemes(line);
  if (clusters.length === 0) return 1;
  let lines = 1;
  let cursorPt = 0;
  let wordPt = 0;

  const flushWord = () => {
    if (wordPt === 0) return;
    if (cursorPt > 0 && cursorPt + wordPt > maxWidthPt) {
      lines++;
      cursorPt = wordPt;
    } else {
      cursorPt += wordPt;
    }
    wordPt = 0;
  };

  for (const cluster of clusters) {
    const first = cluster.codePointAt(0) ?? 0;
    if (first === 0x20 || first === 0x09) {
      flushWord();
      const spacePt = first === 0x09 ? 15.6 : 3.9;
      if (cursorPt + spacePt <= maxWidthPt) cursorPt += spacePt;
      continue;
    }

    let emoji = isEmojiScalar(first);
    if (!emoji && cluster.length > 1) {
      for (const ch of cluster) {
        const cp = ch.codePointAt(0) ?? 0;
        if (isEmojiScalar(cp) || cp === 0xfe0f || cp === 0x20e3) {
          emoji = true;
          break;
        }
      }
    }

    if (emoji || isFullwidthScalar(first)) {
      flushWord();
      const glyphPt = emoji ? 16.5 : 14.0;
      if (cursorPt > 0 && cursorPt + glyphPt > maxWidthPt) {
        lines++;
        cursorPt = glyphPt;
      } else {
        cursorPt += glyphPt;
      }
      continue;
    }

    const chPt = isNarrowAscii(first) ? 4.1 : isWideAscii(first) ? 9.4 : 6.4;
    if (wordPt + chPt > maxWidthPt) {
      // Single unbroken token wider than the bubble wraps mid-token.
      if (cursorPt > 0) {
        lines++;
        cursorPt = 0;
      }
      lines += Math.floor((wordPt + chPt) / maxWidthPt);
      wordPt = (wordPt + chPt) % maxWidthPt;
    } else {
      wordPt += chPt;
    }
  }
  flushWord();
  return lines;
}

/**
 * Calibrated pre-layout line estimate for `UserRow` (`text-md` = 14pt in a
 * `~504pt` inner bubble). Counts grapheme clusters rather than UTF-16 code units.
 */
export function roughUserLines(text: string, maxWidthPt = USER_BUBBLE_INNER_PT, fontScale = 1): number {
  if (!text) return 0;
  let total = 0;
  for (const paragraph of text.split("\n")) {
    total += estimateParagraphLines(paragraph, maxWidthPt / fontScale);
  }
  return total;
}
