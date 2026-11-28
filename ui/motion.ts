// Motion primitives built on NSH's native animation engine.
//
// All animations run on the native compositor thread without per-frame JS,
// and honor the user's `reduceMotion()` preference automatically.

import {
  Animated,
  type AnimatedNode,
  type AnimatedValue,
  cleanup,
  type CompositeAnimation,
  createAnimatedValue,
  createMotion,
  type Easing,
  effect,
  LayoutAnimation,
  type Motion,
  type MotionName,
  type MotionOptions,
  type MotionSpec,
  reduceMotion,
  signal,
  untracked,
  type ViewStyle,
} from "nsh";
import { traceMotion } from "./motion-trace";

/** Shared duration tokens (ms). */
export const DURATION = {
  instant: 120,
  fast: 180,
  base: 240,
  slow: 320,
  slower: 420,
} as const;

/** Refined easing curves inspired by Apple's motion design language.
 * Each curve is tuned for its semantic role: entrance, exit, or transformation. */
export const EASING = {
  out: "easeOut" as const,
  inOut: "easeInOut" as const,
  in: "easeIn" as const,
  /** Signature ease-out: smooth deceleration with gentle landing (replaces smoothOut). */
  signature: [0.16, 1, 0.3, 1] as [number, number, number, number],
  /** Crisp entrance: confident start with quick settle. */
  entrance: [0.2, 0.92, 0.36, 1] as [number, number, number, number],
  /** Weighted settle: half the peak velocity of `signature`, motion spread across
      the whole duration — for objects carrying meaning (a sent message) that
      lift off and glide into their seat rather than darting into place. */
  settle: [0.25, 0.7, 0.35, 1] as [number, number, number, number],
  /** Graceful exit: smooth acceleration into fade. */
  exit: [0.4, 0, 0.6, 1] as [number, number, number, number],
  /** Expressive transform: playful overshoot for major transitions. */
  expressive: [0.34, 1.26, 0.64, 1] as [number, number, number, number],
  /** Legacy smooth-out kept for compatibility (prefer signature). */
  smoothOut: [0.22, 1, 0.36, 1] as [number, number, number, number],
};

/** Spring configurations for `AnimatedValue.spring`. */
export const SPRING = {
  /** Quick press / hover / small control settle (~220ms). */
  snappy: { stiffness: 480, damping: 32, mass: 0.95 },
  /** Panels, sidebars, drawers, sliding indicators (~320ms critically damped). */
  surface: { stiffness: 320, damping: 30, mass: 0.92 },
  /** Gentle follow and organic motion. */
  gentle: { stiffness: 180, damping: 22, mass: 0.88 },
} as const;

/** How long a wait goes unremarked: a passing state (a quick session switch) that ends sooner never shows at all. */
export const PATIENCE_MS = 600;

/** Opacity that fades in once, slowly, after `delay`: a wait that ends sooner never flashes on screen. */
export function delayedFade(delay: number = PATIENCE_MS, duration: number = DURATION.slower) {
  const opacity = createAnimatedValue(reduceMotion() ? 1 : 0);
  if (!reduceMotion()) opacity.keyframes([0, 1], { duration, delay, easing: EASING.signature });
  return opacity;
}

/** Plays a named motion preset once when the host view mounts.
 * Call in a component body and spread/pass `.style`. Use only for top-level
 * cold stages — never inside a `FloatingLayer` (which already animates as one
 * surface) or on panes that swap inside an already-open surface (`ViewDeck`). */
export function enter(preset: MotionName = "fadeInUp", delay = 0) {
  return untracked(() => createMotion({ enter: preset, delay }).style);
}

/** Staggered entrance for top-level cold stages (`opacity 0->1`, `translateY 10->0`).
 * Never nest inside an animating `FloatingLayer` or replay on pane switches
 * inside an already-open surface — use `ViewDeck` instead. */
export function enterStagger(index: number, stepMs = 45) {
  return untracked(() =>
    createMotion({
      enter: {
        keyframes: { opacity: [0, 1], translateY: [10, 0] },
        duration: DURATION.slow,
        easing: EASING.signature,
        delay: Math.min(index, 6) * stepMs,
      },
    }).style,
  );
}

/** Lazily allocates a `Motion` only on its first `.play()`, costing zero native
 * nodes for controls that never animate. */
export function lazyMotion(options?: MotionOptions) {
  const made = signal<Motion | null>(null);
  const get = (): Motion => {
    let m = untracked(made);
    if (!m) {
      m = createMotion(options);
      made.set(m);
    }
    return m;
  };
  return {
    get style() {
      return made()?.style;
    },
    get,
    play(motion: MotionName | MotionSpec, play?: Parameters<Motion["play"]>[1]) {
      return get().play(motion, play);
    },
    stop() {
      untracked(made)?.stop();
    },
    reset() {
      untracked(made)?.reset();
    },
  };
}

/** Lean multi-channel motion (`opacity`, `translateX`, `translateY`, `scale`) for recycled
 * `List` cells so each row allocates only the native `AnimatedValue` nodes it needs. */
const REST = { opacity: 1, translateX: 0, translateY: 0, scale: 1 } as const;
type LeanChannel = keyof typeof REST;

interface LeanSpec<C extends LeanChannel> {
  tracks: Record<C, { offset: number; value: number }[]>;
  duration: number;
  easing: Easing;
}

function leanMotion<C extends LeanChannel>(channels: readonly C[], born?: LeanSpec<C>) {
  const values = {} as Record<C, AnimatedValue>;
  for (const c of channels) values[c] = createAnimatedValue(born ? born.tracks[c][0].value : REST[c]);
  let running: CompositeAnimation | null = null;
  const stop = () => {
    running?.stop();
    running = null;
  };
  return {
    values,
    play(spec: LeanSpec<C>, delay = 0) {
      stop();
      if (reduceMotion()) {
        for (const c of channels) {
          const track = spec.tracks[c];
          values[c].set(track[track.length - 1].value);
        }
        return;
      }
      running = Animated.parallel(
        channels.map((c) =>
          Animated.keyframes(values[c], {
            keyframes: spec.tracks[c],
            duration: spec.duration,
            easing: spec.easing,
            delay,
          }),
        ),
      );
      void running.start();
    },
    stop,
    reset() {
      stop();
      for (const c of channels) values[c].set(REST[c]);
    },
  };
}

const SLIDE_UP_SPEC: LeanSpec<"opacity" | "translateY"> = {
  tracks: {
    opacity: [
      { offset: 0, value: 0 },
      { offset: 0.65, value: 1 },
      { offset: 1, value: 1 },
    ],
    translateY: [
      { offset: 0, value: 0 },
      { offset: 1, value: 0 },
    ],
  },
  duration: 240,
  easing: EASING.signature,
};

const STREAM_FADE_SPEC: LeanSpec<"opacity" | "translateY"> = {
  tracks: {
    opacity: [
      { offset: 0, value: 0 },
      { offset: 1, value: 1 },
    ],
    translateY: [
      { offset: 0, value: 0 },
      { offset: 1, value: 0 },
    ],
  },
  duration: 180,
  easing: EASING.entrance,
};

/** Sent user bubbles rise gently from the composer: upward glide paired with crisp opacity. */
const USER_ENTRANCE_SPEC: LeanSpec<"opacity" | "translateY"> = {
  tracks: {
    opacity: [
      { offset: 0, value: 0 },
      { offset: 0.55, value: 0.88 },
      { offset: 1, value: 1 },
    ],
    translateY: [
      { offset: 0, value: 8 },
      { offset: 1, value: 0 },
    ],
  },
  duration: 210,
  easing: EASING.signature,
};

/** iMessage-style outgoing SMS bubble pop-in from the bottom-right corner. */
const SMS_OUTGOING_SPEC: LeanSpec<"opacity" | "translateX" | "translateY" | "scale"> = {
  tracks: {
    opacity: [
      { offset: 0, value: 0 },
      { offset: 0.42, value: 0.94 },
      { offset: 1, value: 1 },
    ],
    translateX: [
      { offset: 0, value: 6 },
      { offset: 1, value: 0 },
    ],
    translateY: [
      { offset: 0, value: 12 },
      { offset: 1, value: 0 },
    ],
    scale: [
      { offset: 0, value: 0.965 },
      { offset: 1, value: 1 },
    ],
  },
  duration: 340,
  easing: EASING.settle,
};

/** iMessage-style incoming SMS bubble pop-in blooming from the bottom-left corner.
 * Pip's replies land as whole thoughts rather than streamed ink, so they take the
 * heavier settle curve: less sideways dart than the outgoing send, a shorter rise,
 * and most of the opacity arriving early enough for the shape to read immediately. */
const SMS_INCOMING_SPEC: LeanSpec<"opacity" | "translateX" | "translateY" | "scale"> = {
  tracks: {
    opacity: [
      { offset: 0, value: 0 },
      { offset: 0.32, value: 0.92 },
      { offset: 1, value: 1 },
    ],
    translateX: [
      { offset: 0, value: -5 },
      { offset: 1, value: 0 },
    ],
    translateY: [
      { offset: 0, value: 9 },
      { offset: 1, value: 0 },
    ],
    scale: [
      { offset: 0, value: 0.975 },
      { offset: 1, value: 1 },
    ],
  },
  duration: 300,
  easing: EASING.settle,
};

/** The trailing avatar is part of the last bubble's arrival, not a piece of
 * chrome that can appear early and wait for it. It keeps the same clock but a
 * smaller travel, so the bubble remains the moving mass. */
const SMS_COMPANION_SPEC: LeanSpec<"opacity" | "translateY" | "scale"> = {
  tracks: {
    opacity: [
      { offset: 0, value: 0 },
      { offset: 0.42, value: 0.9 },
      { offset: 1, value: 1 },
    ],
    translateY: [
      { offset: 0, value: 4 },
      { offset: 1, value: 0 },
    ],
    scale: [
      { offset: 0, value: 0.94 },
      { offset: 1, value: 1 },
    ],
  },
  duration: SMS_INCOMING_SPEC.duration,
  easing: SMS_INCOMING_SPEC.easing,
};

const SMS_INCOMING_STAGGER_MS = 58;
const smsIncomingDelay = (stagger: number | undefined) => Math.min(Math.max(0, stagger ?? 0), 4) * SMS_INCOMING_STAGGER_MS;

/** Tracks which transcript row IDs have already animated in during the current
 * session so recycled `List` cells and history loads stay still while newly
 * streamed/appended rows glide into place once. */
const seenRowIds = new Set<string>();
let liveEntranceEnabled = false;

/** Marks existing rows as already seen (e.g. when loading history or switching
 * sessions) so only subsequent live rows animate in. */
export function markRowsSeen(ids: Iterable<string>) {
  seenRowIds.clear();
  for (const id of ids) seenRowIds.add(id);
  liveEntranceEnabled = true;
}

/** Whether a row id (or its parent transcript row id) was already seen on screen. */
export function isRowSeen(id: string): boolean {
  return seenRowIds.has(id);
}

/** Whether a row would arrive live: entrances are on and it has not been on screen. */
export function isLiveArrival(id: string): boolean {
  return liveEntranceEnabled && !seenRowIds.has(id);
}

/** A row that never came on screen to arrive (a list that did not mount it) arrives no more. */
export function forgetArrival(id: string) {
  seenRowIds.add(id);
}

/** The spring an arriving SMS row opens its room on. */
export const ARRIVAL_SPRING = { stiffness: 260, damping: 30, mass: 1 } as const;

/** Enables live entrance animations (e.g. right before sending a prompt in an
 * empty session). */
export function enableLiveRowEntrance() {
  liveEntranceEnabled = true;
}

/** Smoothly animates a newly-arrived transcript row once — opacity only,
 * never a positional offset: streamed text settles through its own veil
 * (`skip()` true for `text` rows: no entrance at all). Recycled cells and
 * loaded history stay steady. */
export function useRowEntrance(id: () => string, streaming?: () => boolean, skip?: () => boolean | "delegate", crisp?: () => boolean) {
  const item = leanMotion(["opacity", "translateY"] as const);
  let lastId = "";
  effect(() => {
    const currentId = id();
    untracked(() => {
      if (currentId === lastId) return;
      lastId = currentId;
      const skipped = skip?.();
      if (!currentId || skipped) {
        if (currentId && skipped !== "delegate") seenRowIds.add(currentId);
        item.reset();
        return;
      }
      if (!liveEntranceEnabled || seenRowIds.has(currentId)) {
        seenRowIds.add(currentId);
        item.reset();
        return;
      }
      seenRowIds.add(currentId);
      if (crisp?.()) {
        item.values.opacity.set(0);
        item.values.translateY.set(8);
        item.play(USER_ENTRANCE_SPEC);
        return;
      }
      const isStream = streaming?.() ?? false;
      item.values.opacity.set(0);
      item.play(isStream ? STREAM_FADE_SPEC : SLIDE_UP_SPEC);
    });
  });
  cleanup(() => item.stop());
  return {
    opacity: item.values.opacity,
    transform: [{ translateY: item.values.translateY }],
  };
}

/** iMessage-style bubble pop-in anchored directly to the bubble's own corner
 * (`left bottom` for Pip's incoming bubbles, `right bottom` for the user's outgoing bubbles).
 * Plays once for newly arrived live bubbles; loaded history and recycled cells stay steady. */
export function useSmsBubbleEntrance(
  id: () => string,
  side: () => "left" | "right",
  options?: { enabled?: () => boolean; skip?: () => boolean; stagger?: () => number },
): ViewStyle {
  const specOf = () => (side() === "left" ? SMS_INCOMING_SPEC : SMS_OUTGOING_SPEC);
  // A bubble that will enter is born where its entrance starts: values made at
  // rest and moved there by the effect (which runs after rendering) could reach
  // the screen for a frame fully drawn, then vanish into the pop-in.
  const born = untracked(() => {
    const currentId = id();
    const live = (options?.enabled ? options.enabled() : true) && currentId && !options?.skip?.() && liveEntranceEnabled && !seenRowIds.has(currentId);
    return live && !reduceMotion() ? specOf() : undefined;
  });
  const item = leanMotion(["opacity", "translateX", "translateY", "scale"] as const, born);
  let lastId = "";
  effect(() => {
    const currentId = id();
    const enabled = options?.enabled ? options.enabled() : true;
    untracked(() => {
      if (currentId === lastId && enabled) return;
      lastId = currentId;
      if (!enabled || !currentId || options?.skip?.()) {
        if (currentId) seenRowIds.add(currentId);
        item.reset();
        return;
      }
      if (!liveEntranceEnabled || seenRowIds.has(currentId)) {
        seenRowIds.add(currentId);
        item.reset();
        return;
      }
      seenRowIds.add(currentId);
      const isLeft = side() === "left";
      const spec = specOf();
      const delay = isLeft ? smsIncomingDelay(options?.stagger?.()) : 0;
      if (reduceMotion()) {
        item.reset();
        return;
      }
      for (const channel of ["opacity", "translateX", "translateY", "scale"] as const) {
        item.values[channel].set(spec.tracks[channel][0].value);
      }
      item.play(spec, delay);
    });
  });
  cleanup(() => item.stop());
  traceMotion(() => untracked(id), { eo: item.values.opacity, ex: item.values.translateX, ey: item.values.translateY, es: item.values.scale });
  return {
    transformOrigin: side() === "left" ? "left bottom" : "right bottom",
    opacity: item.values.opacity,
    transform: [
      { translateX: item.values.translateX },
      { translateY: item.values.translateY },
      { scale: item.values.scale },
    ],
  };
}

/** Companion entrance for the avatar sitting beside an incoming bubble's tail.
 * It uses its own seen key so it can share the bubble's stagger clock without
 * the bubble hook treating it as already played. */
export function useSmsCompanionEntrance(
  id: () => string,
  options?: { enabled?: () => boolean; skip?: () => boolean; stagger?: () => number },
): ViewStyle {
  const item = leanMotion(["opacity", "translateY", "scale"] as const);
  let lastId = "";
  effect(() => {
    const bubbleId = id();
    const currentId = bubbleId ? `${bubbleId}#companion` : "";
    const enabled = options?.enabled ? options.enabled() : true;
    untracked(() => {
      if (currentId === lastId && enabled) return;
      lastId = currentId;
      if (!enabled || !currentId || options?.skip?.()) {
        if (currentId) seenRowIds.add(currentId);
        item.reset();
        return;
      }
      if (!liveEntranceEnabled || seenRowIds.has(currentId)) {
        seenRowIds.add(currentId);
        item.reset();
        return;
      }
      seenRowIds.add(currentId);
      if (reduceMotion()) {
        item.reset();
        return;
      }
      for (const channel of ["opacity", "translateY", "scale"] as const) {
        item.values[channel].set(SMS_COMPANION_SPEC.tracks[channel][0].value);
      }
      item.play(SMS_COMPANION_SPEC, smsIncomingDelay(options?.stagger?.()));
    });
  });
  cleanup(() => item.stop());
  return {
    transformOrigin: "center bottom",
    opacity: item.values.opacity,
    transform: [{ translateY: item.values.translateY }, { scale: item.values.scale }],
  };
}

/** One breath, in ms — the tempo every "still working" cue inhales on;
 * the update track's drift runs at twice it. */
export const BREATH_MS = 1600;
/** How deep a breath dims the words: enough to read as alive, quiet under a reply. */
const BREATH_MIN = 0.68;
/** When the last live label settles, the breath eases home over this instead of
 * snapping a dimmed word back to full ink. */
const BREATH_SETTLE_MS = 320;

let breathValue: AnimatedValue | null = null;
let breathDimNode: AnimatedNode | null = null;
let breathAnim: CompositeAnimation | null = null;
let breathHolders = 0;

const breath = () => (breathValue ??= createAnimatedValue(1));
/** The ink the shared wave is taking, as a node: 0 at the crest, `1 - BREATH_MIN` at the trough. */
const breathDim = () =>
  (breathDimNode ??= breath().interpolate({ inputRange: [BREATH_MIN, 1], outputRange: [1 - BREATH_MIN, 0] }));

const startBreath = () => {
  void breath().stop();
  breathAnim = Animated.keyframes(breath(), {
    keyframes: [
      { offset: 0, value: 1, easing: "easeInOut" },
      { offset: 0.5, value: BREATH_MIN, easing: "easeInOut" },
      { offset: 1, value: 1 },
    ],
    duration: BREATH_MS,
    iterations: "infinite",
  });
  void breathAnim.start();
};

const settleBreath = () => {
  breathAnim?.stop();
  breathAnim = null;
  void breath().timing(1, { duration: BREATH_SETTLE_MS, easing: EASING.signature });
};

/** The alive cue: every label still working breathes on one shared clock —
 * a turn header and the step under it inhale together, and the cue handing
 * from one row to the next carries on mid-breath instead of restarting.
 * The wave binds each caller through its own `gate`, eased in while it is the
 * live one and back out when the cue moves on: opacity stays `1 - dim * gate`,
 * so a row only watching holds full ink while the wave rolls past it.
 * Compositor-driven, honors `reduceMotion()`. */
export function useBreathingOpacity(active: () => boolean): AnimatedNode {
  const gate = createAnimatedValue(0);
  const opacity = breathDim().mul(gate).interpolate({ inputRange: [0, 1], outputRange: [1, 0] });
  let holding = false;
  const glideGate = (to: number) => {
    void gate.stop();
    void gate.timing(to, { duration: BREATH_SETTLE_MS, easing: EASING.signature });
  };
  const release = () => {
    if (!holding) return;
    holding = false;
    glideGate(0);
    if (--breathHolders === 0) settleBreath();
  };
  effect(() => {
    const on = active();
    const reduced = reduceMotion();
    untracked(() => {
      if (on && !reduced) {
        if (holding) return;
        holding = true;
        glideGate(1);
        if (++breathHolders === 1) startBreath();
      } else {
        release();
      }
    });
  });
  cleanup(() => {
    release();
    void gate.stop();
  });
  return opacity;
}

/** Animates layout rearrangements window-wide when `step()` changes (such as
 * toggling composer queues/attachments); `when` vetoes a change it should not
 * animate. Because `LayoutAnimation.configureNext` touches the whole window,
 * avoid it when virtualized `List`s may be laying out (`!isRunning()`). */
export function animateLayoutOn<T>(step: () => T, duration: number = DURATION.base, when?: (previous: T, next: T) => boolean): void {
  let initialized = false;
  let last: T;
  effect(() => {
    const now = step();
    if (initialized && now !== last && !reduceMotion() && (when?.(last, now) ?? true)) {
      const curve = { type: "spring" as const, springDamping: 0.92 };
      LayoutAnimation.configureNext({
        duration,
        update: curve,
        create: { type: "easeOut", property: "opacity", duration: Math.round(duration * 0.8) },
        delete: { type: "easeIn", property: "opacity", duration: Math.round(duration * 0.65) },
      });
    }
    initialized = true;
    last = now;
  });
}

/** Triggers a one-shot window-wide native layout animation right before a
 * synchronous state update. Never call from generic controls (`Segmented` uses
 * `Tabs`), never before an `await`, and guard with `!isRunning()` if a chat
 * list may be active (`Reveal` / `Presence` are scoped alternatives). */
export function animateNextLayout(duration: number = DURATION.base): void {
  if (reduceMotion()) return;
  LayoutAnimation.configureNext({
    duration,
    update: { type: "spring", springDamping: 0.92 },
    create: { type: "easeOut", property: "opacity", duration: Math.round(duration * 0.8) },
    delete: { type: "easeIn", property: "opacity", duration: Math.round(duration * 0.65) },
  });
}

/** Popover / menu morph transition styles,
 * growing from the corner nearest its trigger with subtle blur & spring overshoot. */
const POPUP_EASE = {
  open: "cubic-bezier(0.34, 1.18, 0.64, 1)" as const,
  close: "cubic-bezier(0.22, 1, 0.36, 1)" as const,
};

function popupOrigin(placement: "top" | "bottom" | "left" | "right", align: "start" | "center" | "end"): string {
  const edge = { top: "bottom", bottom: "top", left: "right", right: "left" }[placement];
  const vertical = placement === "top" || placement === "bottom";
  const along =
    align === "center" ? "center" : vertical ? (align === "start" ? "left" : "right") : align === "start" ? "top" : "bottom";
  return vertical ? `${along} ${edge}` : `${edge} ${along}`;
}

function popupHiddenState(placement: "top" | "bottom" | "left" | "right", align: "start" | "center" | "end"): ViewStyle {
  const d = 6;
  const slide = {
    top: `translateY(${d}px)`,
    bottom: `translateY(${-d}px)`,
    left: `translateX(${d}px)`,
    right: `translateX(${-d}px)`,
  }[placement];
  return {
    opacity: 0,
    transform: `${slide} scale(0.96)`,
    transformOrigin: popupOrigin(placement, align),
    filter: "blur(2px)",
  };
}

export function popupStyle(placement: "top" | "bottom" | "left" | "right" = "bottom", align: "start" | "center" | "end" = "start"): ViewStyle {
  const glass: ViewStyle = {
    glassEffect: "regular",
    backdropFilter: "blur(28px) saturate(180%)",
  };
  if (reduceMotion()) return { ...glass, transitionProperty: "none" };
  return {
    ...glass,
    transformOrigin: popupOrigin(placement, align),
    transitionProperty: "opacity, transform, filter",
    transitionDuration: DURATION.instant,
    transitionTimingFunction: POPUP_EASE.open,
  };
}

export function popupHiddenStyle(placement: "top" | "bottom" | "left" | "right" = "bottom", align: "start" | "center" | "end" = "start"): ViewStyle {
  if (reduceMotion()) return {};
  return popupHiddenState(placement, align);
}

export function popupLeavingStyle(placement: "top" | "bottom" | "left" | "right" = "bottom", align: "start" | "center" | "end" = "start"): ViewStyle {
  if (reduceMotion()) return { opacity: 0 };
  return {
    ...popupHiddenState(placement, align),
    transitionDuration: 180,
    transitionTimingFunction: POPUP_EASE.close,
  };
}

/** Dialog rise entrance spec. */
export const DIALOG_RISE: MotionSpec = {
  keyframes: { opacity: [0, 1], scale: [0.96, 1], translateY: [12, 0] },
  duration: DURATION.base,
  easing: EASING.signature,
};

export { type DeckPane, FloatingLayer, keepLast, LayerActive, Presence, Reveal, ViewDeck } from "./Reveal";
