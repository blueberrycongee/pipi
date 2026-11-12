import { Text, View } from "nsh";
import type { JSX } from "nsh";
import { Button as BaseButton, Input, Switch as BaseSwitch } from "nsh/base";
import type { InputRef } from "nsh";
import { animateNextLayout } from "./motion";
import { FIELD_SURFACE, FOCUS_RING, PRESS } from "./styles";

/** An on/off control. */
export function Switch(props: { checked: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <BaseSwitch
      checked={props.checked}
      disabled={props.disabled}
      accessibilityLabel={props.label}
      onChange={({ checked }) => props.onChange(checked)}
      hitSlop={6}
      class={`shrink-0 rounded-full ${FOCUS_RING} disabled:opacity-50`}
      trackClass="w-8 rounded-full bg-input p-0.5 transition-colors duration-150 checked:bg-primary"
      thumbClass="size-4 rounded-full bg-foreground transition-transform duration-150 ease-out-quint checked:translate-x-3 checked:bg-primary-foreground"
    />
  );
}

/** A choice among a few options, all visible. */
export function Segmented<T extends string>(props: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
  fullWidth?: boolean;
}) {
  return (
    <View
      class={`${props.fullWidth ? "w-full" : "shrink-0"} flex-row rounded-lg bg-muted p-0.5`}
      role="radiogroup"
      accessibilityLabel={props.label}
    >
      <Each of={props.options}>
        {(option) => (
          <BaseButton
            selected={props.value === option().value}
            onPress={() => {
              if (props.value !== option().value) animateNextLayout(180);
              props.onChange(option().value);
            }}
            class={`h-6 ${props.fullWidth ? "min-w-0 flex-1" : "shrink-0"} items-center justify-center rounded-md px-2.5 text-sm text-muted-foreground ${PRESS} ${FOCUS_RING} hover:text-foreground selected:bg-card selected:text-foreground selected:shadow-sm`}
          >
            <Text class={props.fullWidth ? "truncate" : ""}>{option().label}</Text>
          </BaseButton>
        )}
      </Each>
    </View>
  );
}

/** A single-line text field in the app's look. */
export function TextField(props: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  masked?: boolean;
  mono?: boolean;
  autoFocus?: boolean;
  onSubmit?: () => void;
  label: string;
  ref?: (input: InputRef) => void;
  class?: string;
}) {
  return (
    <Input
      ref={props.ref}
      value={props.value}
      onChange={({ value }) => props.onChange(value)}
      onSubmit={props.onSubmit}
      placeholder={props.placeholder}
      masked={props.masked}
      autoFocus={props.autoFocus}
      autoCorrect={false}
      autoCapitalize="none"
      accessibilityLabel={props.label}
      class={`h-8 rounded-lg px-2.5 text-base text-foreground caret-brand placeholder:text-subtle ${FIELD_SURFACE} ${props.mono ? "font-mono text-sm" : ""} ${props.class ?? ""}`}
    />
  );
}

/** A settings row: what it is and what it does on the left, its control on the right. */
export function SettingRow(props: { title: string; description?: string; children?: JSX.Element }) {
  return (
    <View class="min-h-11 flex-row items-center justify-between gap-4 py-2.5">
      <View class="min-w-0 flex-1 gap-0.5">
        <Text class="text-base text-foreground">{props.title}</Text>
        {props.description ? <Text class="text-sm leading-relaxed text-muted-foreground">{props.description}</Text> : null}
      </View>
      {props.children}
    </View>
  );
}

/** A titled group of settings rows, ruled between rows. */
export function SettingGroup(props: { title?: string; children?: JSX.Element }) {
  return (
    <View class="gap-1.5">
      {props.title ? (
        <Text class="px-1 text-sm text-muted-foreground" role="header">
          {props.title}
        </Text>
      ) : null}
      <View class="overflow-hidden rounded-xl bg-muted/50 px-4">{props.children}</View>
    </View>
  );
}

/** The hairline between rows of a group. */
export function Rule() {
  return <View class="h-px bg-border" />;
}
