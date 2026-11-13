// A selection drag scrolls what it selects in: held near an edge of the
// part of the conversation that can be read, the conversation moves under the
// pointer, faster the further past the edge. The platform does this for a
// scroll view around a selectable view; the chat's is the other way round
// (the list is inside the area — a `List` takes no `selectable`), and its
// frame goes on under the title bar and the composer, so `views/Chat.tsx`
// drives it from here.

/** How far inside an edge (pt) the scroll starts: the pointer need not leave the text to ask for more. */
export const EDGE_INSIDE = 20;
/** The step (pt per 60 Hz frame) where it starts: slow enough to stop on a line. */
export const EDGE_MIN = 3;
/** The largest step, `EDGE_RAMP` further out. */
export const EDGE_MAX = 36;
/** How far from where it starts (pt) the step reaches `EDGE_MAX`. */
export const EDGE_RAMP = 110;

/**
 * The step per 60 Hz frame for a pointer at `at` along the axis, where what can be read runs from `top` to
 * `bottom` (same coordinates): negative towards the start, positive towards the end, 0 between the edges.
 */
export function edgeStep(at: number, top: number, bottom: number): number {
  // Too short a band to have a middle: nothing to scroll by.
  if (bottom - top < EDGE_INSIDE * 4) return 0;
  const into = at < top + EDGE_INSIDE ? at - (top + EDGE_INSIDE) : at > bottom - EDGE_INSIDE ? at - (bottom - EDGE_INSIDE) : 0;
  if (!into) return 0;
  const t = Math.min(1, Math.abs(into) / EDGE_RAMP);
  return Math.sign(into) * (EDGE_MIN + t * (EDGE_MAX - EDGE_MIN));
}

/**
 * Where a frame's step takes the list. `offset` is where the list last said it is, `sentFrom` that same reading
 * when the last step was sent and `aim` where that step sent it: until the list reports again, the next step
 * goes on from the aim, not from the stale reading (the same target twice is a stutter). `max` is the last end
 * the list reported; the target may pass it by a step, for an end that has moved since (the list stops at its own).
 */
export function edgeTarget(step: number, offset: number, max: number, sentFrom: number | undefined, aim: number | undefined): number {
  const from = aim !== undefined && sentFrom === offset ? aim : offset;
  return Math.max(0, Math.min(from + step, Math.max(max, 0) + EDGE_MAX));
}
