import manifest from "../nsh.json";
import { codeSize, FONT_SIZES, readingSize, uiSize } from "../store/prefs";

const scale = manifest.tailwind.fontSize;
export type FontToken = keyof typeof scale;

const HEIGHT_TOKEN: Record<number, string> = {
  20: "h-5",
  24: "h-6",
  26: "h-6.5",
  28: "h-7",
  32: "h-8",
  36: "h-9",
  40: "h-10",
  44: "h-11",
  48: "h-12",
  56: "h-14",
};

const MIN_HEIGHT_TOKEN: Record<number, string> = {
  28: "min-h-7",
  32: "min-h-8",
  36: "min-h-9",
  44: "min-h-11",
};

/** Current interface scale ratio relative to the 13pt desktop default. */
export function uiScale(): number {
  return uiSize() / FONT_SIZES.ui.default;
}

/**
 * Interface / system-chrome typography: preserves the entire type ladder and
 * its line-height ratios across sidebar, tabs, menus, settings and controls;
 * returns the original Tailwind token verbatim at the 13pt default.
 */
export function uiType(token: FontToken = "base"): string {
  const ratio = uiScale();
  if (ratio === 1) return `text-${token}`;
  const [points, leading] = scale[token];
  return `text-[${Math.max(9, Math.round(points * ratio))}px]/[${leading}]`;
}

/**
 * Computes a chrome row or control height in points matched to the current
 * interface size. Each +1pt of UI text adds +2pt of row height (~1.5pt line
 * height + ~0.5pt vertical breathing room) on an even 2pt grid so single-line
 * rows, pills and inputs never clip or lose vertical optical balance.
 */
export function uiRowHeight(base: number, opts?: { min?: number; max?: number }): number {
  const delta = uiSize() - FONT_SIZES.ui.default;
  if (delta === 0) return base;
  const min = opts?.min ?? (base <= 24 ? 24 : base <= 28 ? 26 : Math.max(24, base - 4));
  const max = opts?.max ?? Number.POSITIVE_INFINITY;
  return Math.min(max, Math.max(min, base + delta * 2));
}

/** Fixed height class (`h-*`) that tracks `uiRowHeight`, verbatim at default. */
export function uiHeight(base: number, opts?: { min?: number; max?: number }): string {
  const px = uiRowHeight(base, opts);
  if (px === base && HEIGHT_TOKEN[base]) return HEIGHT_TOKEN[base];
  return `h-[${px}px]`;
}

/** Minimum height class (`min-h-*`) that tracks `uiRowHeight`, verbatim at default. */
export function uiMinHeight(base: number, opts?: { min?: number; max?: number }): string {
  const px = uiRowHeight(base, opts);
  if (px === base && MIN_HEIGHT_TOKEN[base]) return MIN_HEIGHT_TOKEN[base];
  return `min-h-[${px}px]`;
}

/** Gently damped icon sizing so marks stay optically balanced alongside larger or smaller UI text. */
export function uiIconSize(base: number): number {
  const ratio = uiScale();
  if (ratio === 1) return base;
  return Math.max(10, Math.round(base * (1 + (ratio - 1) * 0.6)));
}

/** Keep the type ladder and its line-height ratios; at the default use the original token verbatim. */
export function readingType(token: FontToken = "md"): string {
  const ratio = readingSize() / FONT_SIZES.reading.default;
  if (ratio === 1) return `text-${token}`;
  const [points, leading] = scale[token];
  return `text-[${Math.round(points * ratio)}px]/[${leading}]`;
}

/**
 * Relaxed reading line height as explicit points. A point value stays fixed in
 * nested inline text (such as 0.9em inline code), where a unitless multiple
 * would be recomputed at the smaller font size.
 */
export function readingLineHeight(token: FontToken = "md"): number {
  const ratio = readingSize() / FONT_SIZES.reading.default;
  const [points] = scale[token];
  return Math.round(points * ratio) * 1.625;
}

/** `readingLineHeight` as a Tailwind class. */
export function readingLeading(token: FontToken = "md"): string {
  return `leading-[${readingLineHeight(token)}px]`;
}

export function codeType(): string {
  return codeSize() === FONT_SIZES.code.default ? "text-xs" : `text-[${codeSize()}px]/[${scale.xs[1]}]`;
}
