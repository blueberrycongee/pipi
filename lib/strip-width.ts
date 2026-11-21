/**
 * The strip's pill width, as a browser sizes its tabs: the viewport shared
 * evenly between a widest and a narrowest pill — past the floor the strip
 * scrolls instead of squeezing further. `views/TabBar.tsx` tweens toward
 * this, and holds it while a close's pointer stays in the strip.
 */

/** The widest a tab's pill gets: uniform so a drag's slot math is exact and the strip reads as one row. */
export const TAB_MAX_W = 160;
/** The narrowest the pills squeeze to before the strip scrolls instead. */
export const TAB_MIN_W = 76;
/** The gap between pills (`gap-1` on the strip's content). */
export const TAB_GAP = 4;
/** What a squeeze must leave room for: the content's `px-1` ends and the "+" after the last pill (`size-6`). */
const STRIP_PAD = 8;
const PLUS_W = 24;

/** Pill width bounds scaled gently upward when interface text grows above the default 13pt. */
export function tabWidthBounds(scale = 1) {
  const grow = scale > 1 ? scale : 1;
  return {
    min: Math.round(TAB_MIN_W * grow),
    max: Math.round(TAB_MAX_W * grow),
  };
}

/** `count` pills' even share of `viewport` points, floored at `min`, capped at `max`. */
export function stripTabWidth(viewport: number, count: number, scale = 1) {
  const { min, max } = tabWidthBounds(scale);
  if (viewport <= 0 || count <= 0) return max;
  const fit = Math.floor((viewport - STRIP_PAD - count * TAB_GAP - PLUS_W) / count);
  return Math.min(max, Math.max(min, fit));
}
