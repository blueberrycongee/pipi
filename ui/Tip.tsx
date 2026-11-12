import { keymap, Text } from "nsh";
import { Tooltip } from "nsh/base";
import { GLASS_REGULAR } from "./styles";

/**
 * The app's tooltip: what a control does, and its shortcut when it has one.
 * Use it as the `tooltip` of icon-only controls, which also carry an
 * `accessibilityLabel`.
 */
export function tip(label: string, shortcut?: string, placement: "top" | "bottom" | "left" | "right" = "bottom") {
  return (
    <Tooltip
      placement={placement}
      offset={6}
      delay={450}
      style={GLASS_REGULAR}
      class="flex-row items-center gap-1.5 rounded-lg border-[0.5px] border-hairline bg-popover/74 px-2 py-1 shadow-popover transition-all duration-150 ease-out-quint dark:bg-popover/70 motion-reduce:transition-none"
      startingClass="opacity-0 scale-95"
      endingClass="opacity-0 scale-95"
    >
      <Text class="text-xs text-popover-foreground">{label}</Text>
      {shortcut ? <Text class="text-xs text-subtle">{keymap.label(shortcut)}</Text> : null}
    </Tooltip>
  );
}
