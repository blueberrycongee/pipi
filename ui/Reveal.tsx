import { batch, cleanup, computed, context, createAnimatedValue, effect, Overlay, reduceMotion, signal, untracked, View } from "nsh";
import type { JSX } from "nsh";
import { Button as BaseButton, Collapsible } from "nsh/base";
import { DURATION, EASING } from "./motion";
import { GLASS_REGULAR, POPUP, SCRIM } from "./styles";

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

/**
 * Accessor context reporting whether the enclosing `FloatingLayer` / `ViewDeck`
 * pane is currently active on screen (`true` outside any layer/deck). Controls
 * such as `TextField` subscribe so inputs inside a pane hidden via
 * `display: "none"` or a closing sheet immediately release keyboard focus.
 */
export const LayerActive = context<() => boolean>(() => true);

/** One pane inside a `ViewDeck`. */
export interface DeckPane<K extends string> {
  id: K;
  render: () => JSX.Element;
}

/**
 * Multi-pane switcher inside an already-open surface (such as Settings sections
 * and subpages). Lazily mounts each pane on its first visit and keeps visited
 * panes alive (`display: "none"` when inactive) at steady `opacity: 1`:
 *
 * - Synchronous `visited` tracking ensures outgoing and incoming panes switch in
 *   the same commit with zero blank or translucent gap frames.
 * - Revisiting a pane (such as `General` with 14 `<Pip>` canvases or `Agents` with
 *   18 `<AgentLogo>` canvases, or returning from `Providers` to `Agents`) swaps
 *   `display` in place without cold-remounting canvases or losing filter/scroll state.
 * - Active panes omit `display` (`undefined`) so `View` keeps nsh's default
 *   vertical column flex layout (`LayoutStyle.display` defaults `"flex"` to row).
 */
export function ViewDeck<K extends string>(props: {
  active: K;
  panes: readonly DeckPane<K>[];
  class?: string;
}) {
  const parentActive = LayerActive();
  const seen = new Set<K>();
  const visited = computed(() => {
    seen.add(props.active);
    return new Set(seen);
  });

  return (
    <View class={props.class ?? "min-h-0 min-w-0 flex-1"}>
      <Each of={props.panes} key={(pane) => pane.id}>
        {(pane) => {
          const id = () => pane().id;
          const isVisited = () => visited().has(id());
          const isActive = () => props.active === id();
          const paneActive = () => parentActive() && isActive();
          return (
            <If when={isVisited()}>
              <View
                class="min-h-0 min-w-0 flex-1"
                style={isActive() ? undefined : { display: "none" }}
              >
                <LayerActive.Provider value={paneActive}>{pane().render()}</LayerActive.Provider>
              </View>
            </If>
          );
        }}
      </Each>
    </View>
  );
}

/**
 * Standard in-window glass layer over `SCRIM` (`z-40`, below `Toasts`):
 *
 * - Batches starting pose (`opacity: 0`, `scale: 0.97`, `translateY: 8`) with
 *   `mounted.set(true)` so the first mounted frame never paints a stale pose.
 * - Reverses smoothly from live UI-thread values if re-opened mid-close
 *   (`mounted()` still `true`), never snapping a visible panel back to `0`.
 * - Uses bounded `DURATION.fast` (`180ms`) `timing` curves (`<= 220ms` per
 *   `DESIGN.md`) rather than unbounded springs that keep `nsh` non-idle.
 * - Registers a childless `<Overlay onCancel>` while open so `Escape` closes
 *   the layer even when a `TextField` inside it holds focus, while yielding to
 *   any `<Popover>` or `<Dialog>` opened on top of it.
 */
export function FloatingLayer(props: {
  open: boolean;
  onClose: () => void;
  closeLabel: string;
  panelClass?: string;
  testID?: string;
  children: JSX.Element;
}) {
  const parentActive = LayerActive();
  const layerActive = () => parentActive() && props.open;
  const initiallyOpen = untracked(() => props.open);
  const mounted = signal(initiallyOpen);
  const scrimOpacity = createAnimatedValue(initiallyOpen ? 1 : 0);
  const panelOpacity = createAnimatedValue(initiallyOpen ? 1 : 0);
  const panelScale = createAnimatedValue(initiallyOpen ? 1 : 0.97);
  const panelY = createAnimatedValue(initiallyOpen ? 0 : 8);
  let wasOpen = initiallyOpen;
  let seq = 0;
  let exitTimer: ReturnType<typeof setTimeout> | undefined;

  effect(() => {
    const isOpen = props.open;
    if (isOpen === wasOpen) return;
    wasOpen = isOpen;
    const mySeq = ++seq;
    const reduced = untracked(reduceMotion);
    untracked(() => {
      clearTimeout(exitTimer);
      void scrimOpacity.stop();
      void panelOpacity.stop();
      void panelScale.stop();
      void panelY.stop();
      if (isOpen) {
        const alreadyMounted = mounted();
        if (reduced) {
          batch(() => {
            scrimOpacity.set(1);
            panelOpacity.set(1);
            panelScale.set(1);
            panelY.set(0);
            if (!alreadyMounted) mounted.set(true);
          });
          return;
        }
        if (!alreadyMounted) {
          batch(() => {
            scrimOpacity.set(0);
            panelOpacity.set(0);
            panelScale.set(0.97);
            panelY.set(8);
            mounted.set(true);
          });
        }
        void scrimOpacity.timing(1, { duration: DURATION.fast, easing: EASING.out });
        void panelOpacity.timing(1, { duration: DURATION.fast, easing: EASING.smoothOut });
        void panelScale.timing(1, { duration: DURATION.fast, easing: EASING.smoothOut });
        void panelY.timing(0, { duration: DURATION.fast, easing: EASING.smoothOut });
      } else if (mounted()) {
        if (reduced) {
          batch(() => {
            scrimOpacity.set(0);
            panelOpacity.set(0);
            mounted.set(false);
          });
          return;
        }
        const ms = 140;
        void scrimOpacity.timing(0, { duration: ms, easing: EASING.out });
        void panelOpacity.timing(0, { duration: ms, easing: EASING.out });
        void panelScale.timing(0.98, { duration: ms, easing: EASING.out });
        void panelY.timing(6, { duration: ms, easing: EASING.out });
        exitTimer = setTimeout(() => {
          if (seq === mySeq) mounted.set(false);
        }, ms + 10);
      }
    });
  });

  cleanup(() => {
    clearTimeout(exitTimer);
    void scrimOpacity.stop();
    void panelOpacity.stop();
    void panelScale.stop();
    void panelY.stop();
  });

  return (
    <If when={mounted()}>
      <View
        testID={props.testID}
        class={`absolute inset-0 z-40 items-center justify-center p-6${props.open ? "" : " pointer-events-none"}`}
      >
        <View class={`pointer-events-none absolute inset-0 ${SCRIM}`} style={{ opacity: scrimOpacity }} />
        <If when={props.open}>
          <Overlay onCancel={props.onClose} class="pointer-events-none" />
          <BaseButton onPress={props.onClose} accessibilityLabel={props.closeLabel} class="absolute inset-0" />
        </If>
        <View
          class={`overflow-hidden ${POPUP} ${props.panelClass ?? ""}${props.open ? "" : " pointer-events-none"}`}
          style={{ ...GLASS_REGULAR, opacity: panelOpacity, transform: [{ translateY: panelY }, { scale: panelScale }] }}
        >
          <LayerActive.Provider value={layerActive}>{props.children}</LayerActive.Provider>
        </View>
      </View>
    </If>
  );
}
