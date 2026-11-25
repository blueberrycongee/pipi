import { computed, Scroll, signal, Text, View } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { formOptionLabel } from "../lib/form-answers";
import { tr } from "../lib/i18n";
import type { ExtensionUiAnswer, ExtensionUiForm, FormField, FormValue, FormValues } from "../pi/protocol";
import { formContent } from "../sidecar/acp-form.mjs";
import { Button, IconButton } from "../ui/Button";
import { TextField } from "../ui/Controls";
import { Icon } from "../ui/Icon";
import { FOCUS_RING, PRESS } from "../ui/styles";
import { uiMinHeight, uiType } from "../ui/typography";

/**
 * One form, answered where it is asked: picks fill the card's own radios and
 * checkboxes, and a real reply row sends them — the composer and its draft are
 * never touched. A one-question card answers on the pick itself; the card's
 * close is the skip.
 */
export function QuestionForm(props: {
  request: ExtensionUiForm;
  onAnswer: (id: string, answer: ExtensionUiAnswer) => void;
}) {
  const edited = signal<{ id: string; values: FormValues } | undefined>(undefined);
  const initial = computed<FormValues>(() => {
    const entries: [string, FormValue][] = [];
    for (const field of props.request.fields) {
      if (field.initial !== undefined) entries.push([field.id, field.initial]);
      if ("other" in field && field.other?.initial !== undefined) entries.push([field.other.id, field.other.initial]);
    }
    return Object.fromEntries(entries);
  });
  const draft = () => {
    const current = edited();
    return current?.id === props.request.id ? current.values : initial();
  };
  const valueOf = (id: string) => {
    const values = draft();
    return Object.hasOwn(values, id) ? values[id] : undefined;
  };
  const update = (id: string, value: FormValue | undefined) => {
    const next = value === undefined ? { ...draft() } : { ...draft(), [id]: value };
    if (value === undefined) delete next[id];
    edited.set({ id: props.request.id, values: next });
  };
  const complete = () => formContent(props.request.fields, draft()) !== undefined;
  const respond = (answer: ExtensionUiAnswer) => props.onAnswer(props.request.id, answer);
  const submit = () => {
    if (!complete()) return;
    respond({ answers: draft() });
  };
  const heading = () => tr(`${props.request.agent} asks`, `${props.request.agent} 提问`);
  /** A lone required pick needs no reply row: tapping the option is the answer. */
  const oneTap = () => {
    const fields = props.request.fields;
    return fields.length === 1 && fields[0].kind === "choice" && fields[0].required && !fields[0].other;
  };

  return (
    <View testID="question-form" class="gap-2">
      <View class="min-w-0 flex-row items-center gap-2">
        <Icon name="message" size={15} tone="brand-text" />
        <Text class={`min-w-0 flex-1 ${uiType("base")} font-semibold text-foreground`} role="header">{heading()}</Text>
        <IconButton icon="x" label={tr("Skip questions", "跳过提问")} size="sm" onPress={() => respond({ declined: true })} />
      </View>
      <Scroll testID="question-fields" class="max-h-56">
        <View class="gap-3">
          <If when={props.request.title && props.request.title !== props.request.message}>
            <Text class={`${uiType("base")} font-medium text-foreground`}>{props.request.title}</Text>
          </If>
          <If when={props.request.message}>
            <Text class={`${uiType("sm")} text-muted-foreground`}>{props.request.message}</Text>
          </If>
          <Each of={props.request.fields} key={(field) => field.id}>
            {(field) => {
              const options = () => {
                const entry = field();
                return "options" in entry ? entry.options : [];
              };
              const multi = () => field().kind === "multiChoice";
              const choiceLabel = (option: { value: string; label: string }) => formOptionLabel(field(), option.value);
              const selected = (value: string) => {
                const current = valueOf(field().id);
                return Array.isArray(current) ? current.includes(value) : current === value;
              };
              const toggle = (value: string) => {
                const entry = field();
                if (entry.kind === "multiChoice") {
                  const raw = valueOf(entry.id);
                  const before = Array.isArray(raw) ? raw : [];
                  if (before.includes(value)) {
                    const next = before.filter((id) => id !== value);
                    update(entry.id, next.length ? next : undefined);
                  } else if (before.length < (entry.maxItems ?? Infinity)) {
                    update(entry.id, [...before, value]);
                  }
                } else if (entry.kind === "choice") {
                  if (oneTap()) {
                    respond({ answers: { [entry.id]: value } });
                    return;
                  }
                  update(entry.id, selected(value) && (!entry.required || entry.other) ? undefined : value);
                }
              };
              const other = () => {
                const entry = field();
                return "other" in entry ? entry.other : undefined;
              };
              const multiHint = () => {
                const entry = field();
                if (entry.kind !== "multiChoice") return undefined;
                if ((entry.minItems ?? 0) > 1) return tr(`Pick at least ${entry.minItems}`, `至少选 ${entry.minItems} 项`);
                if ((entry.maxItems ?? Infinity) < entry.options.length) return tr(`Pick up to ${entry.maxItems}`, `最多选 ${entry.maxItems} 项`);
                return tr("Pick any that apply", "可多选");
              };
              return (
                <View class="gap-1">
                  <Text class={`${uiType("base")} font-medium text-foreground`}>{field().label}</Text>
                  <If when={field().description && field().description !== field().label}>
                    <Text class={`${uiType("sm")} text-muted-foreground`}>{field().description}</Text>
                  </If>
                  <If when={multiHint()}>
                    <Text class={`${uiType("xs")} text-subtle`}>{multiHint()}</Text>
                  </If>
                  <If when={options().length > 0} else={
                    <TextField
                      label={field().label}
                      value={String(valueOf(field().id) ?? "")}
                      onChange={(value) => update(field().id, value)}
                      onSubmit={submit}
                    />
                  }>
                    <View class="-mx-1 gap-0.5">
                      <Each of={options()} key={(option) => option.value}>
                        {(option) => (
                          <BaseButton
                            role={multi() ? "checkbox" : "radio"}
                            selected={selected(option().value)}
                            onPress={() => toggle(option().value)}
                            class={`${uiMinHeight(28)} flex-row items-center gap-2 rounded-md corner-squircle px-2 py-1 ${PRESS} ${FOCUS_RING} hover:bg-accent focus:bg-accent selected:bg-accent/60`}
                          >
                            <View class={`size-3.5 shrink-0 items-center justify-center border ${multi() ? "rounded-[4px] corner-squircle" : "rounded-full"} ${selected(option().value) ? "border-brand bg-brand/15" : "border-muted-foreground/40"}`}>
                              <If when={selected(option().value)}>
                                {multi() ? <Icon name="check" size={11} tone="brand-text" /> : <View class="size-1.5 rounded-full bg-brand" />}
                              </If>
                            </View>
                            <View class="min-w-0 flex-1">
                              <Text class={`${uiType("base")} text-foreground`}>{choiceLabel(option())}</Text>
                              <If when={option().description && option().description !== option().label}>
                                <Text class={`${uiType("sm")} text-muted-foreground`}>{option().description}</Text>
                              </If>
                            </View>
                          </BaseButton>
                        )}
                      </Each>
                      <If when={other()}>
                        {(input) => (
                          <View class="px-1 pt-0.5">
                            <TextField
                              label={tr(`Custom answer for ${field().label}`, `${field().label} 的自填答案`)}
                              placeholder={tr("Type your own answer", "输入自填答案")}
                              value={String(valueOf(input().id) ?? "")}
                              onChange={(value) => update(input().id, value)}
                              onSubmit={submit}
                            />
                          </View>
                        )}
                      </If>
                    </View>
                  </If>
                </View>
              );
            }}
          </Each>
        </View>
      </Scroll>
      <If when={!oneTap()}>
        <View class="flex-row items-center justify-end gap-2 pt-0.5">
          <Button label={tr("Skip", "跳过")} variant="ghost" size="md" shortcut="escape" onPress={() => respond({ declined: true })} />
          <Button label={tr("Reply", "回复")} variant="primary" size="md" disabled={!complete()} onPress={submit} />
        </View>
      </If>
    </View>
  );
}
