import { cleanup, createAnimatedValue, effect, reduceMotion, signal, Text, untracked, View } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { tr } from "../lib/i18n";
import { Icon } from "../ui/Icon";
import { EASING, SPRING } from "../ui/motion";
import { FOCUS_RING, GLASS_REGULAR, POPUP, PRESS, PRESS_SCALE } from "../ui/styles";
import { uiHeight, uiType } from "../ui/typography";

/** How near the end of the conversation (pt) counts as at it: the list follows from within it, and a released
 * reader who scrolls back down re-attaches from within it too — a moving end can never be landed on exactly,
 * and the pill would hide at this distance anyway. */
export const FOLLOW_THRESHOLD = 48;

/** How long (ms) after a scroll gesture of the reader's begins its scroll events are read as theirs. */
export const INPUT_WINDOW_MS = 1500;

/** After the reader releases the view, how long (ms) a move towards the end is not read as theirs: the list settles its layout once as it is released. */
export const RELEASE_SETTLE_MS = 300;

/** After an upward wheel/trackpad gesture, how long (ms) bottom re-attachment is suppressed so trackpad bounce never snaps back. */
export const UPWARD_GUARD_MS = 350;

/** Reading horizon below the title bar: where a newly sent prompt pauses gently when a long reply pushes it there. */
export const HORIZON_GAP = 28;

export type ScrollMode = "tail" | "horizon" | "horizon-held" | "free";

/**
 * The foot of the conversation, measured up from the pane's lower edge. What stands there is the composer's
 * figure as laid out (`figure`, its height): 20 under the composer, the composer, whatever stands on it — the
 * attachments, a long draft, an inline prompt — and 12 over that. At rest that is 124 (a 92pt composer), its
 * top edge at 112; the edge is wherever the figure puts it, and what meets it is placed from it, so the three
 * move together and nothing the composer grows by covers the reply:
 * - `end`: the conversation ends 16 above the edge, a container's pad. The activity line's slot is the last
 *   thing in it, so a reply at rest stands clear of the composer.
 * - "Jump to latest" stands on that same line.
 * - `edge`: rows fade out as they pass under that edge where the pane masks them.
 */
export const FIGURE_REST = 124;

export function footOf(figure: number) {
  const edge = (figure || FIGURE_REST) - 12;
  return { edge, end: edge + 16 };
}

/** Floating pill shown when the reader scrolls up past the follow threshold,
 * or when a long reply pauses at the reading horizon, offering a crisp return to the bottom. */
export function ScrollToBottomPill(props: { visible: boolean; bottom: number; onPress: () => void }) {
  const mounted = signal(false);
  const opacity = createAnimatedValue(0);
  const translateY = createAnimatedValue(8);
  const scale = createAnimatedValue(0.94);
  let timer: ReturnType<typeof setTimeout> | undefined;

  effect(() => {
    const show = props.visible;
    const reduced = reduceMotion();
    untracked(() => {
      clearTimeout(timer);
      if (show) {
        mounted.set(true);
        if (reduced) {
          opacity.set(1);
          translateY.set(0);
          scale.set(1);
        } else {
          void opacity.timing(1, { duration: 160, easing: EASING.entrance });
          void translateY.spring(0, SPRING.snappy);
          void scale.spring(1, SPRING.snappy);
        }
      } else if (mounted()) {
        if (reduced) {
          opacity.set(0);
          mounted.set(false);
        } else {
          void opacity.timing(0, { duration: 140, easing: EASING.exit });
          void translateY.timing(6, { duration: 140, easing: EASING.exit });
          void scale.timing(0.95, { duration: 140, easing: EASING.exit });
          timer = setTimeout(() => mounted.set(false), 150);
        }
      }
    });
  });

  cleanup(() => {
    clearTimeout(timer);
    void opacity.stop();
    void translateY.stop();
    void scale.stop();
  });

  return (
    <If when={mounted()}>
      <View
        class="pointer-events-none absolute inset-x-0 z-10 items-center"
        style={{ bottom: props.bottom, opacity, transform: [{ translateY }, { scale }] }}
      >
        <BaseButton
          onPress={props.onPress}
          accessibilityLabel={tr("Scroll to bottom", "滚动到底部")}
          class={`pointer-events-auto ${uiHeight(28)} flex-row items-center gap-1.5 rounded-full px-3 ${POPUP} ${PRESS} ${PRESS_SCALE} ${FOCUS_RING} hover:bg-muted/80 active:bg-muted`}
          style={GLASS_REGULAR}
        >
          <Text class={`${uiType("xs")} font-medium text-foreground`}>{tr("Jump to latest", "回到最新")}</Text>
          <View class="rotate-180">
            <Icon name="arrowUp" size={12} tone="muted-foreground" />
          </View>
        </BaseButton>
      </View>
    </If>
  );
}
