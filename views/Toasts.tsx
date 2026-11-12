import { cleanup, createAnimatedValue, createMotion, effect, reduceMotion, signal, Text, untracked, View } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { tr } from "../lib/i18n";
import { activeToasts, dismissToast, type Toast } from "../store/app";
import { IconButton } from "../ui/Button";
import { Icon, type IconName, type Tone } from "../ui/Icon";
import { EASING, Reveal } from "../ui/motion";
import { FOCUS_RING, POPUP_TOAST, PRESS } from "../ui/styles";

const LOOK: Record<Toast["tone"], { icon: IconName; tone: Tone }> = {
  info: { icon: "info", tone: "muted-foreground" },
  success: { icon: "check", tone: "success" },
  warning: { icon: "alert", tone: "warning" },
  error: { icon: "alert", tone: "destructive" },
};

const TOAST_EXIT_MS = 270;

function ToastCard(props: { toast: Toast; leaving: boolean }) {
  const enter = createMotion({
    enter: {
      keyframes: { opacity: [0, 1], translateY: [-12, 0], scale: [0.95, 1] },
      duration: 220,
      easing: EASING.smoothOut,
    },
  });
  const exitScale = createAnimatedValue(1);
  let wasLeaving = false;
  effect(() => {
    const leaving = props.leaving;
    if (leaving === wasLeaving) return;
    wasLeaving = leaving;
    untracked(() => {
      void exitScale.stop();
      if (!leaving || reduceMotion()) {
        exitScale.set(1);
        return;
      }
      void exitScale.timing(0.95, { duration: 150, easing: EASING.out });
    });
  });
  cleanup(() => void exitScale.stop());

  const icon = () => props.toast.icon ?? LOOK[props.toast.tone].icon;
  return (
    <Reveal open={!props.leaving} offset={-6}>
      <View class="items-end pb-2" style={{ transform: [{ scale: exitScale }] }}>
        <View
          class={`${props.leaving ? "pointer-events-none" : "pointer-events-auto"} max-w-120 flex-row items-center gap-2.5 py-2 pl-3 pr-1.5 ${POPUP_TOAST}`}
          style={enter.style}
          role="alert"
        >
          <View class="shrink-0">
            <Icon name={icon()} tone={LOOK[props.toast.tone].tone} />
          </View>
          <Text class="min-w-0 shrink text-sm text-popover-foreground">{props.toast.text}</Text>
          <If when={props.toast.action}>
            {(act) => (
              <BaseButton
                onPress={() => {
                  const fn = act().onPress;
                  dismissToast(props.toast.id);
                  fn();
                }}
                class={`h-6 shrink-0 flex-row items-center rounded-md bg-secondary px-2 ${PRESS} ${FOCUS_RING} hover:bg-secondary/80 active:bg-secondary/70`}
              >
                <Text class="text-xs font-medium text-secondary-foreground">{act().label}</Text>
              </BaseButton>
            )}
          </If>
          <IconButton icon="x" size="sm" label={tr("Dismiss", "关闭")} onPress={() => dismissToast(props.toast.id)} />
        </View>
      </View>
    </Reveal>
  );
}

/** pipi's single error/notice channel: brief messages stacked under the top-right corner. */
export function Toasts() {
  const shown = signal<{ toast: Toast; leaving: boolean }[]>([]);
  const timers = new Map<number, ReturnType<typeof setTimeout>>();

  effect(() => {
    const live = activeToasts();
    const reduced = reduceMotion();
    untracked(() => {
      if (reduced) {
        for (const timer of timers.values()) clearTimeout(timer);
        timers.clear();
        shown.set(live.map((toast) => ({ toast, leaving: false })));
        return;
      }
      const liveById = new Map(live.map((t) => [t.id, t]));
      const prev = shown();
      const seen = new Set<number>();
      const next: { toast: Toast; leaving: boolean }[] = [];
      for (const entry of prev) {
        const id = entry.toast.id;
        seen.add(id);
        const fresh = liveById.get(id);
        if (fresh) {
          const timer = timers.get(id);
          if (timer) {
            clearTimeout(timer);
            timers.delete(id);
          }
          next.push({ toast: fresh, leaving: false });
        } else {
          next.push({ toast: entry.toast, leaving: true });
          if (!timers.has(id)) {
            timers.set(
              id,
              setTimeout(() => {
                timers.delete(id);
                shown.update((items) => items.filter((item) => item.toast.id !== id));
              }, TOAST_EXIT_MS),
            );
          }
        }
      }
      for (const toast of live) {
        if (!seen.has(toast.id)) next.push({ toast, leaving: false });
      }
      shown.set(next);
    });
  });

  cleanup(() => {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  });

  return (
    <View class="pointer-events-none absolute right-8 top-14 items-end">
      <Each of={shown()} key={(entry) => entry.toast.id}>
        {(entry) => <ToastCard toast={entry().toast} leaving={entry().leaving} />}
      </Each>
    </View>
  );
}
