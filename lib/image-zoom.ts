/**
 * The zoom layer image viewer's math, pure and testable: a fixed viewport
 * (the box the image fits when it opens) into content scaled by `z` and moved
 * by `tx` / `ty` — `screen = content × z + t` per axis, the transform acting
 * around the content's top left corner. `z` 1 is the fit the preview opens
 * at; it never goes below it.
 */

export interface ZoomState {
  z: number;
  tx: number;
  ty: number;
}

export interface ZoomBox {
  width: number;
  height: number;
}

/** The pan range of one axis: content `content` long in a viewport `view` long. */
export function panRange(content: number, view: number): { min: number; max: number } {
  if (content <= view) {
    const center = (view - content) / 2;
    return { min: center, max: center };
  }
  return { min: view - content, max: 0 };
}

/** Clamps a pan so the content stays centered when smaller than `view` and never leaves a gap when larger. */
export function clampPan(state: ZoomState, box: ZoomBox, view: ZoomBox = box): ZoomState {
  const x = panRange(box.width * state.z, view.width);
  const y = panRange(box.height * state.z, view.height);
  return {
    z: state.z,
    tx: Math.min(x.max, Math.max(x.min, state.tx)),
    ty: Math.min(y.max, Math.max(y.min, state.ty)),
  };
}

/**
 * Zooms from `state` to `z1` keeping the content point under the viewport
 * point (`ax`, `ay`) there — the pointer the wheel or pinch is at, the middle
 * for keys and buttons. Edges win over the anchor: the clamped result can
 * drift off it, never into a gap.
 */
export function zoomAtPoint(
  state: ZoomState,
  z1: number,
  ax: number,
  ay: number,
  box: ZoomBox,
  view: ZoomBox = box,
): ZoomState {
  if (z1 === state.z) return clampPan(state, box, view);
  const cx = (ax - state.tx) / state.z;
  const cy = (ay - state.ty) / state.z;
  return clampPan({ z: z1, tx: ax - cx * z1, ty: ay - cy * z1 }, box, view);
}

/** Where a zoom lands, bounded: never past the fit (`1`), never past `maxZ`. */
export function clampZoom(z: number, maxZ: number): number {
  return Math.min(maxZ, Math.max(1, z));
}

/**
 * The scale a wheel event asks for. Positive `deltaY` scrolls down and zooms
 * out, as a map does. Mouse notches (`lines`) step in quarters of a power;
 * a touchpad's points stream continuously, gentle enough that the momentum
 * tail after the fingers lift reads as the gesture gliding out, not a runaway.
 */
export function wheelScale(deltaY: number, deltaMode: "points" | "lines"): number {
  if (deltaMode === "lines") {
    const step = Math.max(-3, Math.min(3, deltaY));
    return Math.pow(1.25, -step);
  }
  const points = Math.max(-100, Math.min(100, deltaY));
  return Math.exp(-points * 0.0035);
}

/**
 * A stepped zoom (the − / + buttons, the keys) by one step of `dir` (1 in,
 * −1 out), snapping to the landmarks it crosses: the fit (`1`) and the
 * image's own pixels (`naturalScale`), so a step can land exactly on 100%.
 */
export function stepZoom(z: number, dir: 1 | -1, naturalScale: number, maxZ: number): number {
  const STEP = 1.4;
  let z1 = z * (dir > 0 ? STEP : 1 / STEP);
  if (dir > 0) {
    if (z < naturalScale && z1 > naturalScale) z1 = naturalScale;
  } else {
    if (z > naturalScale && z1 < naturalScale) z1 = naturalScale;
    if (z > 1 && z1 < 1) z1 = 1;
  }
  return clampZoom(z1, maxZ);
}

/**
 * What a double press toggles to: zoomed in (past a hair) it goes back to the
 * fit; at the fit it dives to the image's own pixels (`naturalScale`) when
 * they are a real dive, a plain 2× otherwise — the point pressed the anchor.
 */
export function toggleZoom(z: number, naturalScale: number, maxZ: number): number {
  if (z > 1.02) return 1;
  return clampZoom(Math.max(2, naturalScale), maxZ);
}

/** The zoom ceiling: past the image's own pixels by half, at least 4× the fit. */
export function maxZoom(naturalScale: number): number {
  return Math.max(4, naturalScale * 1.5);
}

/** What the readout says: the image's own pixels at 100%, the fit wherever it lands. */
export function zoomPercent(z: number, fitScale: number): number {
  return Math.max(1, Math.round(z * fitScale * 100));
}

/**
 * Cubic Bézier easing sampled at `t` (0..1) — the same curve the compositor
 * plays, so a gesture that interrupts an animated zoom can pick it up exactly
 * where it visibly is instead of jumping to its end.
 */
export function sampleBezier([x1, y1, x2, y2]: [number, number, number, number], t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  // x is itself a cubic curve of the parameter: solve x(s) = t by bisection
  // (the curve is monotonic for the easing cubics in use), then read y(s).
  const cubic = (a1: number, a2: number, s: number) => {
    const u = 1 - s;
    return 3 * u * u * s * a1 + 3 * u * s * s * a2 + s * s * s;
  };
  let lo = 0;
  let hi = 1;
  let s = t;
  for (let i = 0; i < 24; i++) {
    const x = cubic(x1, x2, s);
    if (Math.abs(x - t) < 1e-5) break;
    if (x < t) lo = s;
    else hi = s;
    s = (lo + hi) / 2;
  }
  return cubic(y1, y2, s);
}
