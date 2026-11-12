import { keymap, Text } from "nsh";
import type { JSX } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { Icon, type IconName, type Tone } from "./Icon";
import { FOCUS_RING, PRESS, PRESS_SCALE } from "./styles";
import { tip } from "./Tip";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

const VARIANT: Record<Variant, string> = {
  primary: "bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary/80",
  secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80 active:bg-secondary/70",
  ghost: "text-foreground hover:bg-accent active:bg-accent",
  danger: "text-destructive hover:bg-destructive/10 active:bg-destructive/15",
};

const ICON_TONE: Record<Variant, Tone> = { primary: "brand-foreground", secondary: "foreground", ghost: "muted-foreground", danger: "destructive" };

const SIZE: Record<Size, string> = {
  sm: "h-6 gap-1.5 rounded-md px-2 text-sm",
  md: "h-7 gap-1.5 rounded-md px-2.5 text-base",
  lg: "h-8 gap-2 rounded-lg px-3.5 text-base",
};

/** The app's button: a label, an optional icon before it and shortcut after it. */
export function Button(props: {
  label: string;
  onPress: () => void;
  variant?: Variant;
  size?: Size;
  icon?: IconName;
  shortcut?: string;
  disabled?: boolean;
  class?: string;
}) {
  return (
    <BaseButton
      onPress={props.onPress}
      disabled={props.disabled}
      class={`shrink-0 flex-row items-center justify-center ${PRESS} ${PRESS_SCALE} ${FOCUS_RING} disabled:opacity-40 ${SIZE[props.size ?? "md"]} ${VARIANT[props.variant ?? "secondary"]} ${props.class ?? ""}`}
    >
      {props.icon ? <Icon name={props.icon} size={14} tone={ICON_TONE[props.variant ?? "secondary"]} /> : null}
      <Text class="font-medium">{props.label}</Text>
      {props.shortcut ? <Text class="text-xs opacity-60">{keymap.label(props.shortcut)}</Text> : null}
    </BaseButton>
  );
}

/** An icon-only button: always named for screen readers, explained by a tooltip. */
export function IconButton(props: {
  icon: IconName;
  label: string;
  onPress: () => void;
  shortcut?: string;
  tone?: Tone;
  size?: "sm" | "md";
  disabled?: boolean;
  selected?: boolean;
  tipPlacement?: "top" | "bottom" | "left" | "right";
  class?: string;
  testID?: string;
}) {
  return (
    <BaseButton
      testID={props.testID}
      onPress={props.onPress}
      disabled={props.disabled}
      selected={props.selected}
      accessibilityLabel={props.label}
      tooltip={tip(props.label, props.shortcut, props.tipPlacement)}
      class={`shrink-0 items-center justify-center rounded-md ${PRESS} active:scale-[0.94] disabled:active:scale-100 motion-reduce:active:scale-100 ${FOCUS_RING} hover:bg-accent active:bg-accent selected:bg-accent disabled:opacity-40 ${props.size === "sm" ? "size-6" : "size-7"} ${props.class ?? ""}`}
    >
      <Icon name={props.icon} tone={props.tone ?? "muted-foreground"} />
    </BaseButton>
  );
}

/** A keystroke as the platform writes it, in a quiet keycap. */
export function Kbd(props: { keys: string }) {
  return <Text class="shrink-0 rounded-sm border border-border bg-muted px-1 text-2xs text-muted-foreground">{keymap.label(props.keys)}</Text>;
}

/** A chip: a compact control that shows a current choice and opens something to change it. */
export function Chip(props: { label: string; icon?: IconName; iconOnly?: boolean; tipText?: string; onPress?: () => void; disabled?: boolean; leading?: JSX.Element; trailing?: JSX.Element; class?: string; testID?: string }) {
  return (
    <BaseButton
      testID={props.testID}
      onPress={props.onPress}
      disabled={props.disabled}
      tooltip={props.tipText ? tip(props.tipText) : undefined}
      accessibilityLabel={props.label}
      class={`h-6 min-w-0 max-w-52 shrink flex-row items-center gap-1.5 rounded-md px-1.5 text-sm text-muted-foreground ${PRESS} ${PRESS_SCALE} ${FOCUS_RING} hover:bg-accent hover:text-foreground active:bg-accent aria-expanded:bg-accent disabled:opacity-50 ${props.class ?? ""}`}
    >
      {props.leading}
      {props.icon ? <Icon name={props.icon} size={14} /> : null}
      {props.iconOnly ? null : (
        <Text class="shrink truncate">
          {props.label}
        </Text>
      )}
      {props.trailing}
    </BaseButton>
  );
}
