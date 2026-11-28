// Apple iMessage CKThrowAnimationManager-style Throw + Morph engine for
// Personal Agent (Pip SMS) outgoing messages.
//
// Zero-clipping, zero-latency choreography:
// 1. Composer input bounds are kept cached in the chat pane's coordinate space
//    whenever the composer lays out or resizes, so pressing Enter captures the
//    exact origin synchronously and clears the input immediately for bursts.
// 2. The real message row mounts at its final full height inside `<List>` with
//    `opacity: 0` while in flight, so `nsh`'s native critically damped spring
//    scroll (`follow_end_animated`) makes room cleanly without any vertical
//    curtain clipping.
// 3. Each flight in `activeThrowFlights()` runs an analytical critically damped
//    2D spring (X converges slightly ahead of Y for a natural subtle arc, zero
//    overshoot) driven via compositor `AnimatedValue`s, while continuously
//    re-measuring the real bubble slot so bursts and scrolling retarget live.
// 4. Handoff removes the clone and reveals the real bubble in one `batch()`
//    commit frame (zero flicker, zero ghosting, sub-pixel landing precision).

import {
  type AnimatedValue,
  batch,
  createAnimatedValue,
  reduceMotion,
  signal,
  untracked,
  type ViewRef,
} from "nsh";

export interface ThrowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ThrowTelemetry {
  id: string;
  originX: number;
  originY: number;
  targetX: number;
  targetY: number;
  landX: number;
  landY: number;
  errorPt: number;
  durationMs: number;
  frames: number;
  movedX: number;
  movedY: number;
}

export interface SmsThrowFlight {
  id: string;
  text: string;
  folded: boolean;
  origin: ThrowRect;
  maxWidth: number;
  tx: AnimatedValue;
  ty: AnimatedValue;
  bgOpacity: AnimatedValue;
  darkTextOpacity: AnimatedValue;
  whiteTextOpacity: AnimatedValue;
  tailOpacity: AnimatedValue;
  /** Mutable physics state stepped in the single shared rAF loop. */
  x: number;
  y: number;
  vx: number;
  vy: number;
  startX: number;
  startY: number;
  targetX: number;
  targetY: number;
  targetWidth: number;
  targetHeight: number;
  hasMeasuredTarget: boolean;
  startedAt: number;
  lastAt: number;
  frames: number;
  measuringTarget: boolean;
}

/** Matches `UserRow` SMS bubble padding (`px-3.5 py-2` = 14pt horizontal, 8pt vertical). */
const BUBBLE_PAD_X = 14;
const BUBBLE_PAD_Y = 8;

/**
 * Critically damped angular frequencies (rad/s, ζ = 1.0 -> mathematically zero overshoot).
 * X converges slightly ahead of Y to carve a natural upward-right iMessage throw arc
 * in ~290–330ms, harmonizing with `nsh`'s ~300ms spring scroll.
 */
const THROW_OMEGA_X = 26;
const THROW_OMEGA_Y = 20.5;

/** Blue pill bloom & text ink crossfade duration (ms). */
const MORPH_MS = 72;
/** Tail fades in softly during the second half of the arc as the bubble docks right. */
const TAIL_START_MS = 135;
const TAIL_END_MS = 240;
/** Minimum flight dwell so morph always finishes cleanly before handoff. */
const MIN_HANDOFF_MS = 110;
/** Hard safety ceiling (ms) so no orphan clone can ever linger on screen. */
const MAX_FLIGHT_MS = 650;
/** Sub-pixel landing tolerances for seamless same-frame handoff. */
const LAND_EPS_PT = 0.5;
const LAND_VEL_PT_S = 14;

/** Exact closed-form step of a critically damped spring (`ζ = 1`, `ω = omega`). */
export function stepCriticallyDamped(
  p: number,
  v: number,
  target: number,
  omega: number,
  dt: number,
): [number, number] {
  const x0 = p - target;
  const e = Math.exp(-omega * dt);
  const c1 = x0;
  const c2 = v + omega * x0;
  const nextX = (c1 + c2 * dt) * e;
  const nextV = (c2 - omega * (c1 + c2 * dt)) * e;
  return [target + nextX, nextV];
}

const flights = signal<SmsThrowFlight[]>([]);
const flyingIds = signal<ReadonlySet<string>>(new Set());
/** True briefly right after a flight launches so the composer placeholder does not collide with the lifting text. */
const launching = signal(false);
let launchHideTimer: ReturnType<typeof setTimeout> | undefined;
/** Rows that launched via Throw + Morph in this conversation so `useSmsBubbleEntrance` skips them. */
const thrownIds = new Set<string>();
const telemetry: ThrowTelemetry[] = [];

let layerRoot: ViewRef | undefined;
let composerInput: ViewRef | undefined;
let paneWidth = 760;
let paneHeight = 560;
let cachedOrigin: ThrowRect | undefined;
let originMeasuring = false;
let originDirty = false;

const bubbleNodes = new Map<string, ViewRef>();
let rafHandle: number | undefined;

export const activeThrowFlights = () => flights();

export function isSmsThrowLaunching(): boolean {
  return launching();
}

export function isSmsBubbleFlying(rowId: string): boolean {
  return flyingIds().has(rowId);
}

export function wasSmsBubbleThrown(rowId: string): boolean {
  return thrownIds.has(rowId);
}

export function smsThrowTelemetry(): readonly ThrowTelemetry[] {
  return telemetry;
}

export function clearSmsThrowTelemetry() {
  telemetry.length = 0;
}

export function setThrowPaneSize(width: number, height: number) {
  const widthChanged = paneWidth > 0 && width > 0 && Math.abs(width - paneWidth) > 2;
  if (width > 0) paneWidth = width;
  if (height > 0) paneHeight = height;
  if (widthChanged && untracked(flights).length > 0) {
    // Window width changed mid-flight (line wraps could shift): finish cleanly.
    cancelAllSmsThrows();
  }
  refreshComposerOrigin();
}

export function registerThrowLayerRoot(node: ViewRef | undefined) {
  layerRoot = node;
  if (node) refreshComposerOrigin();
  else cancelAllSmsThrows();
}

export function registerThrowComposerInput(node: ViewRef | undefined) {
  composerInput = node;
  if (node) refreshComposerOrigin();
  else cachedOrigin = undefined;
}

export function notifyThrowComposerLayout() {
  refreshComposerOrigin();
}

function refreshComposerOrigin() {
  if (!layerRoot || !composerInput) return;
  if (originMeasuring) {
    originDirty = true;
    return;
  }
  const root = layerRoot;
  const input = composerInput;
  originMeasuring = true;
  void Promise.all([root.measure(), input.measure()])
    .then(([rootBox, inputBox]) => {
      originMeasuring = false;
      if (root === layerRoot && input === composerInput && rootBox && inputBox && inputBox.bounds.size.width > 0) {
        cachedOrigin = {
          x: inputBox.pagePosition.x - rootBox.pagePosition.x,
          y: inputBox.pagePosition.y - rootBox.pagePosition.y,
          width: inputBox.bounds.size.width,
          height: inputBox.bounds.size.height,
        };
      }
      if (originDirty) {
        originDirty = false;
        refreshComposerOrigin();
      }
    })
    .catch(() => {
      originMeasuring = false;
      originDirty = false;
    });
}

export function registerThrowBubbleNode(rowId: string, node: ViewRef | undefined) {
  if (!node) return;
  bubbleNodes.set(rowId, node);
  const flight = untracked(flights).find((f) => f.id === rowId);
  if (flight) measureFlightTarget(flight);
  return () => {
    if (bubbleNodes.get(rowId) === node) bubbleNodes.delete(rowId);
  };
}

function measureFlightTarget(flight: SmsThrowFlight) {
  if (flight.measuringTarget) return;
  const root = layerRoot;
  const node = bubbleNodes.get(flight.id);
  if (!root || !node) return;
  flight.measuringTarget = true;
  void Promise.all([root.measure(), node.measure()])
    .then(([rootBox, bubbleBox]) => {
      flight.measuringTarget = false;
      if (!rootBox || !bubbleBox || bubbleBox.bounds.size.width <= 0) return;
      flight.targetX = bubbleBox.pagePosition.x - rootBox.pagePosition.x;
      flight.targetY = bubbleBox.pagePosition.y - rootBox.pagePosition.y;
      flight.targetWidth = bubbleBox.bounds.size.width;
      flight.targetHeight = bubbleBox.bounds.size.height;
      flight.hasMeasuredTarget = true;
    })
    .catch(() => {
      flight.measuringTarget = false;
    });
}

function stopLoop() {
  if (rafHandle !== undefined) {
    cancelAnimationFrame(rafHandle);
    rafHandle = undefined;
  }
}

function finishFlights(landed: SmsThrowFlight[], now: number) {
  if (landed.length === 0) return;
  const landedIds = new Set(landed.map((f) => f.id));
  for (const f of landed) {
    const errorPt = Math.hypot(f.x - f.targetX, f.y - f.targetY);
    f.tx.set(f.targetX);
    f.ty.set(f.targetY);
    f.bgOpacity.set(1);
    f.whiteTextOpacity.set(1);
    f.darkTextOpacity.set(0);
    f.tailOpacity.set(1);
    telemetry.push({
      id: f.id,
      originX: Math.round(f.startX * 10) / 10,
      originY: Math.round(f.startY * 10) / 10,
      targetX: Math.round(f.targetX * 10) / 10,
      targetY: Math.round(f.targetY * 10) / 10,
      landX: Math.round(f.x * 10) / 10,
      landY: Math.round(f.y * 10) / 10,
      errorPt: Math.round(errorPt * 100) / 100,
      durationMs: Math.max(0, now - f.startedAt),
      frames: f.frames,
      movedX: Math.round((f.targetX - f.startX) * 10) / 10,
      movedY: Math.round((f.targetY - f.startY) * 10) / 10,
    });
    if (telemetry.length > 64) telemetry.splice(0, telemetry.length - 64);
  }
  batch(() => {
    flyingIds.update((prev) => {
      const next = new Set(prev);
      for (const id of landedIds) next.delete(id);
      return next;
    });
    flights.update((prev) => prev.filter((f) => !landedIds.has(f.id)));
  });
}

function tick() {
  rafHandle = undefined;
  const active = untracked(flights);
  if (active.length === 0) return;

  if (untracked(reduceMotion)) {
    cancelAllSmsThrows();
    return;
  }

  const now = Date.now();
  const landed: SmsThrowFlight[] = [];

  for (const f of active) {
    measureFlightTarget(f);
    const dt = Math.min(0.032, Math.max(0.004, (now - f.lastAt) / 1000));
    f.lastAt = now;
    f.frames++;
    const elapsed = now - f.startedAt;

    // Step critically damped 2D spring toward the latest live measured slot.
    // If target hasn't reported its first layout yet (<1 frame), hold neatly at
    // origin while morphing so the bubble never heads toward a wrong guess.
    if (f.hasMeasuredTarget) {
      const [nx, nvx] = stepCriticallyDamped(f.x, f.vx, f.targetX, THROW_OMEGA_X, dt);
      const [ny, nvy] = stepCriticallyDamped(f.y, f.vy, f.targetY, THROW_OMEGA_Y, dt);
      f.x = nx;
      f.vx = nvx;
      f.y = ny;
      f.vy = nvy;
    }

    const morphT = Math.min(1, elapsed / MORPH_MS);
    const morphEase = 1 - Math.pow(1 - morphT, 3);
    f.bgOpacity.set(morphEase);
    f.whiteTextOpacity.set(morphEase);
    f.darkTextOpacity.set(1 - morphEase);

    const tailT = Math.min(1, Math.max(0, (elapsed - TAIL_START_MS) / (TAIL_END_MS - TAIL_START_MS)));
    f.tailOpacity.set(tailT);

    f.tx.set(f.x);
    f.ty.set(f.y);

    const dist = Math.hypot(f.x - f.targetX, f.y - f.targetY);
    const speed = Math.hypot(f.vx, f.vy);
    const offscreen = f.hasMeasuredTarget && elapsed > 160 && (f.targetY < -200 || f.targetY > paneHeight + 120);
    const settled = f.hasMeasuredTarget && elapsed >= MIN_HANDOFF_MS && dist <= LAND_EPS_PT && speed <= LAND_VEL_PT_S;
    if (settled || offscreen || elapsed >= MAX_FLIGHT_MS) {
      landed.push(f);
    }
  }

  if (landed.length > 0) finishFlights(landed, now);
  if (untracked(flights).length > 0) rafHandle = requestAnimationFrame(tick);
}

function ensureLoop() {
  if (rafHandle === undefined) rafHandle = requestAnimationFrame(tick);
}

/**
 * Launches a Throw + Morph flight synchronously inside the send `batch()`.
 * Returns `true` when the flight started (caller's real bubble will stay hidden
 * until handoff); returns `false` when reduced motion is active or unavailable.
 */
export function launchSmsThrow(rowId: string, text: string, opts?: { folded?: boolean }): boolean {
  if (untracked(reduceMotion)) return false;
  if (!text.trim() || !layerRoot) return false;

  const colW = Math.min(Math.max(200, paneWidth - 48), 720);
  const colLeft = Math.max(24, (paneWidth - colW) / 2);
  const maxWidth = Math.floor(colW * 0.72);

  const origin: ThrowRect = cachedOrigin ?? {
    x: colLeft + 16,
    y: Math.max(48, paneHeight - 104),
    width: Math.max(120, colW - 52),
    height: 32,
  };

  // Place the clone so its text top-left (`x + BUBBLE_PAD_X`, `y + BUBBLE_PAD_Y`)
  // coincides pixel-for-pixel with the text's position inside the composer input.
  const startX = Math.max(4, origin.x - BUBBLE_PAD_X);
  const startY = Math.max(4, origin.y - BUBBLE_PAD_Y);
  const estTargetX = Math.max(colLeft, colLeft + colW - Math.min(maxWidth, 160));
  const estTargetY = Math.max(48, startY - 68);

  const now = Date.now();
  const flight: SmsThrowFlight = {
    id: rowId,
    text,
    folded: Boolean(opts?.folded),
    origin,
    maxWidth,
    tx: createAnimatedValue(startX),
    ty: createAnimatedValue(startY),
    bgOpacity: createAnimatedValue(0),
    darkTextOpacity: createAnimatedValue(1),
    whiteTextOpacity: createAnimatedValue(0),
    tailOpacity: createAnimatedValue(0),
    x: startX,
    y: startY,
    vx: 0,
    vy: 0,
    startX,
    startY,
    targetX: estTargetX,
    targetY: estTargetY,
    targetWidth: 0,
    targetHeight: 0,
    hasMeasuredTarget: false,
    startedAt: now,
    lastAt: now,
    frames: 0,
    measuringTarget: false,
  };

  thrownIds.add(rowId);
  clearTimeout(launchHideTimer);
  batch(() => {
    launching.set(true);
    flyingIds.update((prev) => {
      const next = new Set(prev);
      next.add(rowId);
      return next;
    });
    flights.update((prev) => [...prev.filter((item) => item.id !== rowId), flight]);
  });
  launchHideTimer = setTimeout(() => {
    launchHideTimer = undefined;
    launching.set(false);
  }, MORPH_MS + 45);

  if (bubbleNodes.has(rowId)) measureFlightTarget(flight);
  ensureLoop();
  return true;
}

/** Immediately ends all active flights and reveals their real bubbles (session switch, resize, reduce motion). */
export function cancelAllSmsThrows() {
  stopLoop();
  clearTimeout(launchHideTimer);
  launchHideTimer = undefined;
  const active = untracked(flights);
  if (active.length === 0 && untracked(flyingIds).size === 0 && !untracked(launching)) return;
  batch(() => {
    if (untracked(launching)) launching.set(false);
    if (untracked(flyingIds).size > 0) flyingIds.set(new Set());
    if (untracked(flights).length > 0) flights.set([]);
  });
}

/** Resets per-conversation throw tracking when switching conversations. */
export function resetSmsThrows() {
  cancelAllSmsThrows();
  thrownIds.clear();
  bubbleNodes.clear();
  refreshComposerOrigin();
}
