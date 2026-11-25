import { platform, Text, View } from "nsh";
import type { MouseEvent, PressEvent } from "nsh";
import { tr } from "../lib/i18n";
import { Pip } from "../mascot/Pip";
import { currentDaemonId, currentView, ensurePersonalAgent, isRunning, pendingSession, personalAgent } from "../store/app";
import { openDaemonSessionTab } from "../store/tabs";
import { FOCUS_RING, PRESS } from "../ui/styles";
import { tip } from "../ui/Tip";
import { uiHeight, uiType } from "../ui/typography";

const isModPress = (e?: { modifiers?: { platform?: boolean; control?: boolean } }) =>
  Boolean(platform.os === "macos" ? e?.modifiers?.platform : e?.modifiers?.control);

async function openPersonalAgent(newTab: boolean) {
  const id = await ensurePersonalAgent();
  if (id) openDaemonSessionTab(id, { newTab });
}

/**
 * Pip, the personal agent, pinned above the lists: one press opens its
 * conversation, starting it the first time. Pip stands still here and works
 * only while it runs; a finished answer not yet read takes the brand dot.
 */
export function PipRow() {
  const pip = personalAgent;
  const open = () => {
    const id = pip()?.id;
    return id !== undefined && (pendingSession()?.daemonId ?? currentDaemonId()) === id;
  };
  const selected = () => open() && currentView().name === "chat";
  const working = () => (open() && isRunning()) || pip()?.status === "working" || pip()?.status === "blocked";
  const unread = () => Boolean(pip()?.unread) && !open() && !working();
  return (
    <View class="shrink-0 px-2 pb-1">
      <View
        role="button"
        testID="sidebar-pip"
        accessibilityLabel="Pip"
        accessibilityState={{ selected: selected() }}
        onPress={(e: PressEvent) => void openPersonalAgent(isModPress(e))}
        onMouseUp={(e: MouseEvent) => {
          if (e.button === "middle") void openPersonalAgent(true);
        }}
        tooltip={tip(tr("Pip, your personal agent", "Pip，你的私人助理"), undefined, "right")}
        class={`${uiHeight(32)} flex-row items-center gap-1.5 rounded-lg corner-squircle border-[0.5px] px-2.5 ${PRESS} ${FOCUS_RING} hover:bg-sidebar-accent active:bg-sidebar-accent ${
          selected() ? "border-hairline bg-card shadow-sidebar-row dark:shadow-sidebar-row-dark" : "border-transparent"
        }`}
      >
        <View class="size-5 shrink-0 items-center justify-center">
          <Pip size={16} mood={working() ? "work" : "idle"} still={!working()} />
        </View>
        <Text class={`min-w-0 flex-1 truncate ${uiType("base")} text-sidebar-foreground ${selected() ? "font-medium" : ""}`}>{pip()?.title || "Pip"}</Text>
        <View testID="sidebar-pip-unread" class={`size-1.5 rounded-full bg-brand ${unread() ? "" : "opacity-0"}`} />
      </View>
    </View>
  );
}
