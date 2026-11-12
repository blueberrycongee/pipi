import { cleanup, createAnimatedValue, effect, reduceMotion, signal, untracked, View } from "nsh";
import type { JSX } from "nsh";
import { Collapsible } from "nsh/base";
import { DURATION, EASING } from "./motion";

/**
 * Standard vertical flow presence (`DESIGN.md` → Motion):
 *
 * Expands and collapses an item in a vertical stack using `Collapsible`'s
 * scoped native spring (`ElementRef::animate_layout`, ~265ms critically damped)
 * paired with compositor-driven opacity + subtle vertical glide — without ever
 * invoking global `LayoutAnimation.configureNext` (so virtualized `List`s
 * elsewhere in the window are never disturbed).
 *
 * - Mounts at rest when `open` is already `true` on initial render.
 * - Animates height + opacity + `translateY` on both `false → true` and `true → false`.
 * - Pass `instant` when an item is replaced in-place in the same commit (such
 *   as a draft session graduating into its saved `SessionRow`), skipping the
 *   collapse while re-arming the 0pt region on the next microtask for future opens.
 */
export function Reveal(props: {
  open: boolean;
  instant?: boolean;
  offset?: number;
  children: JSX.Element;
}) {
  const shift = () => props.offset ?? -4;
  const initiallyOpen = untracked(() => props.open);
  const reveal = signal(true);
  const opacity = createAnimatedValue(initiallyOpen ? 1 : 0);
  const translateY = createAnimatedValue(initiallyOpen ? 0 : shift());
  let wasOpen = initiallyOpen;

  effect(() => {
    const isOpen = props.open;
    if (isOpen === wasOpen) return;
    wasOpen = isOpen;
    const skip = Boolean(untracked(() => props.instant));
    if (!isOpen && skip) {
      reveal.set(false);
      opacity.set(0);
      translateY.set(untracked(shift));
      queueMicrotask(() => {
        if (!wasOpen) reveal.set(true);
      });
      return;
    }
    if (!untracked(reveal)) reveal.set(true);
    if (skip || untracked(reduceMotion)) {
      opacity.set(isOpen ? 1 : 0);
      translateY.set(isOpen ? 0 : untracked(shift));
      return;
    }
    const d = untracked(shift);
    if (isOpen) {
      opacity.keyframes([0, 1], { duration: DURATION.fast, easing: EASING.smoothOut });
      translateY.keyframes([d, 0], { duration: DURATION.base, easing: EASING.smoothOut });
    } else {
      opacity.keyframes([1, 0], { duration: 150, easing: EASING.out });
      translateY.keyframes([0, d], { duration: DURATION.fast, easing: EASING.out });
    }
  });

  return (
    <Collapsible
      open={props.open}
      reveal={reveal()}
      content={
        <View
          class={props.open ? undefined : "pointer-events-none"}
          style={{ opacity, transform: [{ translateY }] }}
        >
          {props.children}
        </View>
      }
    />
  );
}

/**
 * Retains the last defined value from `read` so a collapsing `<Reveal>` or
 * `<Presence>` keeps rendering its outgoing content until unmount instead of
 * blanking on the first exit frame.
 */
export function keepLast<T>(read: () => T | undefined, initial?: T): () => T | undefined {
  let held = initial;
  return () => {
    const next = read();
    if (next !== undefined) held = next;
    return next ?? held;
  };
}

/**
 * Standard inline presence for fixed-slot indicators (such as a row's running
 * Pip or status badge) whose enter/exit does not reflow sibling heights:
 * fades and scales in on show, fades and scales out before unmounting on hide.
 */
export function Presence(props: {
  show: boolean;
  duration?: number;
  scaleFrom?: number;
  class?: string;
  testID?: string;
  accessibilityLabel?: string;
  children: JSX.Element;
}) {
  const enterMs = () => props.duration ?? DURATION.fast;
  const exitMs = () => Math.round(enterMs() * 0.8);
  const fromScale = () => props.scaleFrom ?? 0.78;
  const initiallyShown = untracked(() => props.show);
  const mounted = signal(initiallyShown);
  const opacity = createAnimatedValue(initiallyShown ? 1 : 0);
  const scale = createAnimatedValue(initiallyShown ? 1 : fromScale());
  let wasShown = initiallyShown;
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  effect(() => {
    const now = props.show;
    if (now === wasShown) return;
    wasShown = now;
    const mySeq = ++seq;
    clearTimeout(timer);
    if (untracked(reduceMotion)) {
      opacity.set(now ? 1 : 0);
      scale.set(1);
      mounted.set(now);
      return;
    }
    const s0 = untracked(fromScale);
    if (now) {
      mounted.set(true);
      opacity.keyframes([0, 1], { duration: untracked(enterMs), easing: EASING.smoothOut });
      scale.keyframes([s0, 1], { duration: untracked(enterMs), easing: EASING.smoothOut });
    } else {
      const ms = untracked(exitMs);
      opacity.keyframes([1, 0], { duration: ms, easing: EASING.out });
      scale.keyframes([1, s0], { duration: ms, easing: EASING.out });
      timer = setTimeout(() => {
        if (seq === mySeq) mounted.set(false);
      }, ms);
    }
  });

  cleanup(() => clearTimeout(timer));

  return (
    <If when={mounted()}>
      <View
        testID={props.testID}
        class={props.class}
        accessibilityLabel={props.accessibilityLabel}
        style={{ opacity, transform: [{ scale }] }}
      >
        {props.children}
      </View>
    </If>
  );
}
