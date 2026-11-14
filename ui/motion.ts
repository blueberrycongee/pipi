// Motion primitives built on NSH's native animation engine.
//
// All animations run on the native compositor thread without per-frame JS,
// and honor the user's `reduceMotion()` preference automatically.

import {
  Animated,
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

/** Shared duration tokens (ms). */
export const DURATION = {
  instant: 120,
  fast: 180,
  base: 240,
  slow: 360,
  slower: 480,
} as const;

/** Shared easing curves. */
export const EASING = {
  out: "easeOut" as const,
  inOut: "easeInOut" as const,
  in: "easeIn" as const,
  smoothOut: [0.22, 1, 0.36, 1] as [number, number, number, number],
};

/** Spring configurations for `AnimatedValue.spring`. */
export const SPRING = {
  /** Quick press / hover / small control settle. */
  snappy: { stiffness: 520, damping: 34, mass: 1 },
  /** Panels, sidebars, drawers, sliding indicators (~380ms critically damped). */
  surface: { stiffness: 300, damping: 32, mass: 1 },
  /** Gentle follow. */
  gentle: { stiffness: 160, damping: 24, mass: 1 },
} as const;

/** How long a wait goes unremarked: a passing state (a quick session switch) that ends sooner never shows at all. */
export const PATIENCE_MS = 600;

/** Opacity that fades in once, slowly, after `delay`: a wait that ends sooner never flashes on screen. */
export function delayedFade(delay: number = PATIENCE_MS, duration: number = DURATION.slower) {
  const opacity = createAnimatedValue(reduceMotion() ? 1 : 0);
  if (!reduceMotion()) opacity.keyframes([0, 1], { duration, delay, easing: EASING.smoothOut });
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
        easing: EASING.smoothOut,
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

/** Lean two-channel motion (`opacity` + `translateY` / `translateX`) for recycled
 * `List` cells so each row costs 2 native `AnimatedValue` nodes instead of 11. */
const REST = { opacity: 1, translateX: 0, translateY: 0 } as const;
type LeanChannel = keyof typeof REST;

interface LeanSpec<C extends LeanChannel> {
  tracks: Record<C, { offset: number; value: number }[]>;
  duration: number;
  easing: Easing;
}

function leanMotion<C extends LeanChannel>(channels: readonly C[]) {
  const values = {} as Record<C, AnimatedValue>;
  for (const c of channels) values[c] = createAnimatedValue(REST[c]);
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
      { offset: 0.7, value: 1 },
      { offset: 1, value: 1 },
    ],
    translateY: [
      { offset: 0, value: 0 },
      { offset: 1, value: 0 },
    ],
  },
  duration: 210,
  easing: [0.22, 1, 0.36, 1],
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
  duration: 160,
  easing: [0.22, 1, 0.36, 1],
};

/** Sent user bubbles start perceptibly present so they never visually trail the reply indicator below them. */
const USER_ENTRANCE_SPEC: LeanSpec<"opacity" | "translateY"> = {
  tracks: {
    opacity: [
      { offset: 0, value: 0.35 },
      { offset: 1, value: 1 },
    ],
    translateY: [
      { offset: 0, value: 0 },
      { offset: 1, value: 0 },
    ],
  },
  duration: 120,
  easing: [0.22, 1, 0.36, 1],
};

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

/** Enables live entrance animations (e.g. right before sending a prompt in an
 * empty session). */
export function enableLiveRowEntrance() {
  liveEntranceEnabled = true;
}

/** Smoothly animates a newly-arrived transcript row once — opacity only,
 * never a positional offset: streamed text settles through its own veil
 * (`skip()` true for `text` rows: no entrance at all). Recycled cells and
 * loaded history stay steady. */
export function useRowEntrance(id: () => string, streaming?: () => boolean, skip?: () => boolean, crisp?: () => boolean) {
  const item = leanMotion(["opacity", "translateY"] as const);
  let lastId = "";
  effect(() => {
    const currentId = id();
    untracked(() => {
      if (currentId === lastId) return;
      lastId = currentId;
      if (!currentId || skip?.()) {
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
      if (crisp?.()) {
        item.values.opacity.set(0.35);
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

/** Compositor-driven organic breathing opacity (`[1, minOpacity, 1]`) that runs
 * purely on the native UI thread and honors `reduceMotion()`. */
export function useBreathingOpacity(active: () => boolean, minOpacity = 0.28, duration = 1150) {
  const opacity = createAnimatedValue(1);
  let anim: CompositeAnimation | null = null;
  const stop = () => {
    anim?.stop();
    anim = null;
    opacity.set(1);
  };
  effect(() => {
    const on = active();
    const reduced = reduceMotion();
    untracked(() => {
      stop();
      if (!on || reduced) return;
      anim = Animated.keyframes(opacity, {
        keyframes: [
          { offset: 0, value: 1, easing: "easeInOut" },
          { offset: 0.5, value: minOpacity, easing: "easeInOut" },
          { offset: 1, value: 1 },
        ],
        duration,
        iterations: "infinite",
      });
      void anim.start();
    });
  });
  cleanup(stop);
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
    transitionDuration: 260,
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
  keyframes: { opacity: [0, 1], scale: [0.97, 1], translateY: [10, 0] },
  duration: DURATION.base,
  easing: EASING.smoothOut,
};

export { type DeckPane, FloatingLayer, keepLast, LayerActive, Presence, Reveal, ViewDeck } from "./Reveal";
