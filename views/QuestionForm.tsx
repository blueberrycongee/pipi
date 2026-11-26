import { cleanup, computed, effect, keymap, reduceMotion, Scroll, signal, Text, untracked, View } from "nsh";
import type { JSX } from "nsh";
import { Button as BaseButton, Input } from "nsh/base";
import { formOptionLabel } from "../lib/form-answers";
import { tr } from "../lib/i18n";
import type { ExtensionUiAnswer, ExtensionUiForm, FormField, FormValue, FormValues } from "../pi/protocol";
import { formContent, meaningfulFormMessage } from "../sidecar/acp-form.mjs";
import { AgentLogo, type AgentLogoId } from "../ui/AgentLogo";
import { Button, IconButton } from "../ui/Button";
import { TextField } from "../ui/Controls";
import { Icon } from "../ui/Icon";
import { FOCUS_RING, PRESS } from "../ui/styles";
import { uiMinHeight, uiType } from "../ui/typography";

const AGENT_LOGO_PATTERNS: readonly [RegExp, AgentLogoId][] = [
  [/antigravity|\bagy\b/i, "antigravity"],
  [/claude/i, "claude"],
  [/codex|openai/i, "codex"],
  [/devin/i, "devin"],
  [/opencode/i, "opencode"],
  [/cursor/i, "cursor"],
  [/gemini/i, "gemini"],
  [/copilot/i, "copilot"],
  [/grok/i, "grok"],
  [/goose/i, "goose"],
  [/kimi/i, "kimi"],
  [/qwen/i, "qwen"],
  [/deepseek|\bdsh\b/i, "dsh"],
  [/hermes/i, "hermes"],
  [/kiro/i, "kiro"],
  [/droid|factory/i, "droid"],
  [/\bamp\b/i, "amp"],
  [/^pi$/i, "pi"],
];

function resolveAgentLogo(agent: string): AgentLogoId | undefined {
  const clean = agent.trim();
  if (!clean) return undefined;
  return AGENT_LOGO_PATTERNS.find(([pattern]) => pattern.test(clean))?.[1];
}

function AgentMark(props: { agent: string }) {
  const logo = () => resolveAgentLogo(props.agent);
  return (
    <If when={logo()} else={<Icon name="message" size={14} tone="brand-text" />}>
      {(id) => <AgentLogo id={id()} size={14} />}
    </If>
  );
}

/**
 * Stepped, keyboard-first question surface for agent elicitations.
 *
 * Focuses one question at a time so multi-question prompts never collapse into
 * clipped scrollboxes. Single-choice questions with a companion free-text field
 * keep "Other…" folded as the last option until chosen, preserving one-tap
 * selection for every standard option and keeping custom answers mutually
 * exclusive with radio picks.
 */
export function QuestionForm(props: {
  request: ExtensionUiForm;
  onAnswer: (id: string, answer: ExtensionUiAnswer) => void;
  /** Enable bare keyboard navigation (1–9, arrows, Space/Enter, Esc) when shown in the main composer. */
  shortcuts?: boolean;
  /** Tighter spacing for narrow surfaces such as the document floating drawer. */
  compact?: boolean;
  /** Optional control rendered on the left side of the footer (e.g. a switch back to draft). */
  footerLeft?: JSX.Element;
}) {
  const edited = signal<{ id: string; values: FormValues } | undefined>(undefined);
  const stepState = signal<{ id: string; index: number }>({ id: "", index: 0 });
  const focusState = signal<{ id: string; step: number; index: number }>({ id: "", step: 0, index: -1 });
  const otherOpenState = signal<{ id: string; open: Record<string, boolean> }>({ id: "", open: {} });
  let advanceTimer: ReturnType<typeof setTimeout> | undefined;

  cleanup(() => clearTimeout(advanceTimer));

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

  const setValues = (next: FormValues) => {
    edited.set({ id: props.request.id, values: next });
  };

  const update = (id: string, value: FormValue | undefined, remove?: string) => {
    const next = { ...draft() };
    if (value === undefined) delete next[id];
    else next[id] = value;
    if (remove) delete next[remove];
    setValues(next);
  };

  const total = () => props.request.fields.length;
  const stepIndex = () => {
    const current = stepState();
    const max = Math.max(0, total() - 1);
    return current.id === props.request.id ? Math.min(current.index, max) : 0;
  };

  const setStep = (index: number) => {
    clearTimeout(advanceTimer);
    const bounded = Math.max(0, Math.min(total() - 1, index));
    stepState.set({ id: props.request.id, index: bounded });
    focusState.set({ id: props.request.id, step: bounded, index: -1 });
  };

  const isOtherOpen = (otherId: string) => {
    const current = otherOpenState();
    if (current.id === props.request.id && current.open[otherId]) return true;
    return Boolean(String(valueOf(otherId) ?? "").trim());
  };

  const setOtherOpen = (otherId: string, open: boolean) => {
    const current = otherOpenState();
    const base = current.id === props.request.id ? current.open : {};
    otherOpenState.set({ id: props.request.id, open: { ...base, [otherId]: open } });
  };

  const focusedIndex = () => {
    const current = focusState();
    return current.id === props.request.id && current.step === stepIndex() ? current.index : -1;
  };

  const setFocusedIndex = (index: number) => {
    focusState.set({ id: props.request.id, step: stepIndex(), index });
  };

  const fieldAnswered = (field: FormField) => {
    const raw = valueOf(field.id);
    const hasMain = Array.isArray(raw) ? raw.length > 0 : typeof raw === "string" ? raw.trim().length > 0 : false;
    const hasOther = "other" in field && field.other ? String(valueOf(field.other.id) ?? "").trim().length > 0 : false;
    return (hasMain || hasOther) && formContent([field], draft()) !== undefined;
  };

  const currentField = () => props.request.fields[stepIndex()] as FormField | undefined;
  const complete = () => formContent(props.request.fields, draft()) !== undefined;
  const respond = (answer: ExtensionUiAnswer) => {
    clearTimeout(advanceTimer);
    props.onAnswer(props.request.id, answer);
  };
  const submit = () => {
    if (!complete()) return;
    respond({ answers: draft() });
  };

  const firstUnansweredIndex = () => props.request.fields.findIndex((field) => field.required && !fieldAnswered(field));

  /** Single required single-choice question: tapping any standard option answers immediately. */
  const directChoice = () => {
    const fields = props.request.fields;
    return fields.length === 1 && fields[0].kind === "choice" && fields[0].required;
  };

  /** True when the footer needs no primary Submit button because picking an option submits on tap. */
  const pureOneTap = () => {
    if (!directChoice()) return false;
    const field = props.request.fields[0];
    return !("other" in field && field.other && isOtherOpen(field.other.id));
  };

  const canAdvanceCurrent = () => {
    const field = currentField();
    if (!field) return false;
    return !field.required || fieldAnswered(field);
  };

  const advanceOrSubmit = () => {
    if (stepIndex() < total() - 1) {
      if (canAdvanceCurrent()) setStep(stepIndex() + 1);
      return;
    }
    if (complete()) {
      submit();
      return;
    }
    const missing = firstUnansweredIndex();
    if (missing !== -1 && missing !== stepIndex()) setStep(missing);
  };

  const scheduleAutoAdvance = (fromStep: number) => {
    if (fromStep >= total() - 1) return;
    clearTimeout(advanceTimer);
    const go = () => {
      if (untracked(stepIndex) === fromStep) setStep(fromStep + 1);
    };
    if (untracked(reduceMotion)) go();
    else advanceTimer = setTimeout(go, 140);
  };

  const pickOption = (field: FormField, value: string) => {
    if (field.kind === "multiChoice") {
      const raw = valueOf(field.id);
      const before = Array.isArray(raw) ? raw : [];
      if (before.includes(value)) {
        const next = before.filter((id) => id !== value);
        update(field.id, next.length ? next : undefined);
      } else if (before.length < (field.maxItems ?? Infinity)) {
        update(field.id, [...before, value]);
      }
      return;
    }
    if (field.kind === "choice") {
      const otherId = field.other?.id;
      if (directChoice()) {
        respond({ answers: { [field.id]: value } });
        return;
      }
      const already = valueOf(field.id) === value;
      if (already && (!field.required || field.other)) {
        update(field.id, undefined);
        return;
      }
      if (otherId) setOtherOpen(otherId, false);
      update(field.id, value, otherId);
      if (stepIndex() < total() - 1) scheduleAutoAdvance(stepIndex());
    }
  };

  const openOtherField = (field: FormField) => {
    if (!("other" in field) || !field.other) return;
    setOtherOpen(field.other.id, true);
    if (field.kind === "choice") update(field.id, undefined);
  };

  const closeOtherField = (field: FormField) => {
    if (!("other" in field) || !field.other) return;
    update(field.other.id, undefined);
    setOtherOpen(field.other.id, false);
  };

  const handleOtherInput = (field: FormField, text: string) => {
    if (!("other" in field) || !field.other) return;
    const clearRadio = field.kind === "choice" && text.trim().length > 0 ? field.id : undefined;
    update(field.other.id, text || undefined, clearRadio);
  };

  const intro = () => meaningfulFormMessage(props.request.message, props.request.title, props.request.fields);

  const headerSub = () => {
    const title = props.request.title.trim();
    const first = props.request.fields[0]?.label.trim() ?? "";
    if (!title || title === first || title === props.request.agent.trim()) return "";
    return title;
  };

  const anyOtherOpenOnStep = () => {
    const field = currentField();
    return Boolean(field && "other" in field && field.other && isOtherOpen(field.other.id));
  };

  // Bare keyboard navigation while the card owns the main composer and no text field is focused.
  effect(() => {
    if (!props.shortcuts) return;
    const rowCount = () => {
      const field = currentField();
      if (!field || !("options" in field)) return 0;
      return field.options.length + (field.other ? 1 : 0);
    };
    const triggerIndex = (idx: number) => {
      const field = currentField();
      if (!field || !("options" in field)) return;
      if (idx >= 0 && idx < field.options.length) {
        pickOption(field, field.options[idx].value);
      } else if (field.other && idx === field.options.length) {
        openOtherField(field);
      }
    };
    const moveFocus = (delta: number) => {
      const count = rowCount();
      if (!count) return;
      const cur = focusedIndex();
      const next = cur < 0 ? (delta > 0 ? 0 : count - 1) : (cur + delta + count) % count;
      setFocusedIndex(next);
    };

    const bindings: Record<string, () => void> = {
      up: () => moveFocus(-1),
      down: () => moveFocus(1),
      left: () => {
        if (total() > 1 && stepIndex() > 0) setStep(stepIndex() - 1);
      },
      right: () => {
        if (total() > 1 && stepIndex() < total() - 1) setStep(stepIndex() + 1);
      },
      space: () => {
        const idx = focusedIndex();
        if (idx >= 0) triggerIndex(idx);
      },
      enter: () => {
        const idx = focusedIndex();
        const field = currentField();
        if (idx >= 0 && field && "options" in field) {
          if (field.kind === "choice" || (field.other && idx === field.options.length)) {
            triggerIndex(idx);
            return;
          }
          if (field.kind === "multiChoice" && !fieldAnswered(field)) {
            triggerIndex(idx);
            return;
          }
        }
        advanceOrSubmit();
      },
    };
    for (let n = 1; n <= 9; n++) {
      const idx = n - 1;
      bindings[String(n)] = () => triggerIndex(idx);
    }

    const unbindNav = keymap.bind(bindings);
    const unbindEsc = keymap.bind(
      "escape",
      () => {
        const field = currentField();
        if (field && "other" in field && field.other && isOtherOpen(field.other.id) && !String(valueOf(field.other.id) ?? "").trim()) {
          closeOtherField(field);
          return;
        }
        respond({ declined: true });
      },
      { when: "always" },
    );
    cleanup(() => {
      unbindNav();
      unbindEsc();
    });
  });

  const showSubmitAction = () => stepIndex() >= total() - 1 || complete();

  return (
    <View testID="question-form" class={props.compact ? "gap-2.5" : "gap-3"}>
      {/* Quiet top meta bar: engine identity left, stepped progress right when multi-question */}
      <View class="min-w-0 flex-row items-center justify-between gap-2">
        <View class="min-w-0 flex-1 flex-row items-center gap-1.5">
          <AgentMark agent={props.request.agent} />
          <Text class={`shrink-0 ${uiType("xs")} font-medium text-muted-foreground`}>{props.request.agent}</Text>
          <If when={headerSub()}>
            <Text class={`min-w-0 flex-1 truncate ${uiType("xs")} text-subtle`}>{`· ${headerSub()}`}</Text>
          </If>
        </View>
        <If when={total() > 1}>
          <View class="shrink-0 flex-row items-center gap-1.5">
            <View class="flex-row items-center gap-1 pr-0.5">
              <Each of={props.request.fields} key={(field) => field.id}>
                {(field, idx) => {
                  const active = () => idx() === stepIndex();
                  const done = () => fieldAnswered(field());
                  return (
                    <BaseButton
                      onPress={() => setStep(idx())}
                      accessibilityLabel={tr(`Question ${idx() + 1} of ${total()}`, `第 ${idx() + 1} 题，共 ${total()} 题`)}
                      class={`h-3 items-center justify-center rounded-full px-0.5 ${FOCUS_RING}`}
                    >
                      <View
                        class={`h-1.5 rounded-full transition-all duration-150 ${
                          active()
                            ? "w-4 bg-brand"
                            : done()
                              ? "w-1.5 bg-foreground/50"
                              : "w-1.5 bg-muted-foreground/25"
                        }`}
                      />
                    </BaseButton>
                  );
                }}
              </Each>
            </View>
            <IconButton
              icon="chevronLeft"
              size="sm"
              tone="subtle"
              label={tr("Previous question", "上一题")}
              disabled={stepIndex() <= 0}
              onPress={() => setStep(stepIndex() - 1)}
            />
            <Text class={`tabular-nums ${uiType("xs")} text-subtle`}>{`${stepIndex() + 1} / ${total()}`}</Text>
            <IconButton
              icon="chevronRight"
              size="sm"
              tone="subtle"
              label={tr("Next question", "下一题")}
              disabled={stepIndex() >= total() - 1}
              onPress={() => setStep(stepIndex() + 1)}
            />
          </View>
        </If>
      </View>

      {/* Optional contextual intro (only when the agent sent real context, never "The agent has N questions.") */}
      <If when={intro()}>
        <Text class={`${uiType("xs")} leading-relaxed text-muted-foreground`}>{intro()}</Text>
      </If>

      {/* Active question stage */}
      <If when={currentField()}>
        {(field) => {
          const options = () => {
            const entry = field();
            return "options" in entry ? entry.options : [];
          };
          const multi = () => field().kind === "multiChoice";
          const other = () => {
            const entry = field();
            return "other" in entry ? entry.other : undefined;
          };
          const choiceLabel = (option: { value: string; label: string }) => formOptionLabel(field(), option.value);
          const selected = (value: string) => {
            const current = valueOf(field().id);
            return Array.isArray(current) ? current.includes(value) : current === value;
          };
          const multiHint = () => {
            const entry = field();
            if (entry.kind !== "multiChoice") return "";
            if ((entry.minItems ?? 0) > 1) return tr(`Pick at least ${entry.minItems}`, `至少选 ${entry.minItems} 项`);
            if ((entry.maxItems ?? Infinity) < entry.options.length) return tr(`Pick up to ${entry.maxItems}`, `最多选 ${entry.maxItems} 项`);
            return tr("Multi-select", "可多选");
          };
          const needsScroll = () => options().length + (other() ? 1 : 0) > 6;

          const optionRows = () => (
            <View class={props.compact ? "gap-1" : "-mx-2 gap-1"}>
              <Each of={options()} key={(option) => option.value}>
                {(option, idx) => {
                  const isPicked = () => selected(option().value);
                  const isFocused = () => focusedIndex() === idx();
                  return (
                    <BaseButton
                      role={multi() ? "checkbox" : "radio"}
                      selected={isPicked()}
                      onPress={() => pickOption(field(), option().value)}
                      class={`group ${uiMinHeight(props.compact ? 32 : 36)} flex-row items-center gap-2.5 rounded-xl corner-squircle border-[0.5px] px-2 py-1.5 ${PRESS} ${FOCUS_RING} ${
                        isPicked()
                          ? "border-hairline-hover bg-accent"
                          : isFocused()
                            ? "border-transparent bg-accent"
                            : "border-transparent hover:bg-accent/70 active:bg-accent"
                      }`}
                    >
                      <View
                        class={`size-5 shrink-0 items-center justify-center rounded-md corner-squircle ${
                          isPicked()
                            ? "bg-brand"
                            : "border-[0.5px] border-border bg-muted/80"
                        }`}
                      >
                        <If
                          when={isPicked()}
                          else={<Text class={`${uiType("2xs")} font-medium tabular-nums text-muted-foreground`}>{String(idx() + 1)}</Text>}
                        >
                          <Icon name="check" size={11} tone="brand-foreground" />
                        </If>
                      </View>
                      <View class="min-w-0 flex-1">
                        <Text class={`${uiType("base")} ${isPicked() ? "font-medium" : ""} text-foreground`}>{choiceLabel(option())}</Text>
                        <If when={option().description && option().description !== option().label}>
                          <Text class={`${uiType("xs")} text-muted-foreground`}>{option().description}</Text>
                        </If>
                      </View>
                      <If when={directChoice()}>
                        <View class="shrink-0 opacity-0 transition-opacity duration-100 group-hover:opacity-60">
                          <Icon name="enter" size={12} tone="subtle" />
                        </View>
                      </If>
                    </BaseButton>
                  );
                }}
              </Each>

              {/* Folded "Other…" option that expands inline on click or number key */}
              <If when={other()}>
                {(input) => {
                  const otherIndex = () => options().length;
                  const expanded = () => isOtherOpen(input().id);
                  const val = () => String(valueOf(input().id) ?? "");
                  const hasText = () => val().trim().length > 0;
                  const isFocused = () => focusedIndex() === otherIndex();
                  return (
                    <If
                      when={expanded()}
                      else={
                        <BaseButton
                          onPress={() => openOtherField(field())}
                          accessibilityLabel={tr(`Custom answer for ${field().label}`, `${field().label} 的自填答案`)}
                          class={`group ${uiMinHeight(props.compact ? 32 : 36)} flex-row items-center gap-2.5 rounded-xl corner-squircle border-[0.5px] px-2 py-1.5 ${PRESS} ${FOCUS_RING} ${
                            isFocused()
                              ? "border-transparent bg-accent"
                              : "border-transparent hover:bg-accent/70 active:bg-accent"
                          }`}
                        >
                          <View class="size-5 shrink-0 items-center justify-center rounded-md corner-squircle border-[0.5px] border-border bg-muted/80">
                            <Text class={`${uiType("2xs")} font-medium tabular-nums text-muted-foreground`}>{String(otherIndex() + 1)}</Text>
                          </View>
                          <Text class={`min-w-0 flex-1 ${uiType("base")} text-muted-foreground`}>{tr("Other…", "其他…")}</Text>
                          <Icon name="pencil" size={12} tone="subtle" />
                        </BaseButton>
                      }
                    >
                      <View
                        class={`${uiMinHeight(props.compact ? 34 : 38)} flex-row items-center gap-2.5 rounded-xl corner-squircle border-[0.5px] border-hairline-hover bg-accent/70 px-2 py-1.5`}
                      >
                        <View
                          class={`size-5 shrink-0 items-center justify-center rounded-md corner-squircle ${
                            hasText() ? "bg-brand" : "border-[0.5px] border-hairline-hover bg-muted/80"
                          }`}
                        >
                          <If when={hasText()} else={<Icon name="pencil" size={11} tone="brand-text" />}>
                            <Icon name="check" size={11} tone="brand-foreground" />
                          </If>
                        </View>
                        <Input
                          autoFocus
                          value={val()}
                          placeholder={tr("Type your own answer…", "输入你的回答…")}
                          accessibilityLabel={tr(`Custom answer for ${field().label}`, `${field().label} 的自填答案`)}
                          onChange={({ value }) => handleOtherInput(field(), value)}
                          onSubmit={advanceOrSubmit}
                          class={`min-w-0 flex-1 ${uiType("base")} text-foreground caret-brand`}
                        />
                        <If when={!hasText()}>
                          <IconButton
                            icon="x"
                            size="sm"
                            tone="subtle"
                            label={tr("Cancel custom answer", "取消自填")}
                            onPress={() => closeOtherField(field())}
                          />
                        </If>
                      </View>
                    </If>
                  );
                }}
              </If>
            </View>
          );

          return (
            <View testID="question-fields" class="gap-2">
              <View class="gap-0.5">
                <View class="flex-row items-baseline justify-between gap-3">
                  <Text class={`min-w-0 flex-1 ${props.compact ? uiType("base") : uiType("md")} font-semibold leading-snug text-foreground`} role="header">
                    {field().label}
                  </Text>
                  <If when={multiHint()}>
                    <Text class={`shrink-0 ${uiType("xs")} text-subtle`}>{multiHint()}</Text>
                  </If>
                </View>
                <If when={field().description && field().description !== field().label}>
                  <Text class={`${uiType("xs")} leading-relaxed text-muted-foreground`}>{field().description}</Text>
                </If>
              </View>

              <If
                when={options().length > 0}
                else={
                  <TextField
                    autoFocus
                    label={field().label}
                    placeholder={field().kind === "number" ? tr("Enter a number…", "输入数字…") : tr("Type your answer…", "输入你的回答…")}
                    value={String(valueOf(field().id) ?? "")}
                    onChange={(value) => update(field().id, value || undefined)}
                    onSubmit={advanceOrSubmit}
                  />
                }
              >
                <If when={needsScroll()} else={optionRows()}>
                  <Scroll class="max-h-56">{optionRows()}</Scroll>
                </If>
              </If>
            </View>
          );
        }}
      </If>

      {/* Quiet single-row footer */}
      <View class="flex-row items-center justify-between gap-2 pt-0.5">
        <View class="min-w-0 flex-1 flex-row items-center">
          <If when={props.footerLeft} else={
            <If when={props.shortcuts && !props.compact && !anyOtherOpenOnStep()}>
              <Text class={`truncate ${uiType("xs")} text-subtle`}>
                {total() > 1
                  ? tr("1–9 to pick · ←/→ switch", "1–9 选择 · ←/→ 切题")
                  : tr("Press 1–9 to pick", "按 1–9 快速选择")}
              </Text>
            </If>
          }>
            {props.footerLeft}
          </If>
        </View>
        <View class="shrink-0 flex-row items-center gap-1.5">
          <Button
            testID="question-skip"
            label={tr("Skip", "跳过")}
            variant="ghost"
            size="sm"
            shortcut="escape"
            onPress={() => respond({ declined: true })}
          />
          <If when={!pureOneTap()}>
            <If
              when={showSubmitAction()}
              else={
                <Button
                  testID="question-next"
                  label={tr("Next", "下一题")}
                  variant={canAdvanceCurrent() ? "primary" : "secondary"}
                  size="sm"
                  disabled={!canAdvanceCurrent()}
                  onPress={advanceOrSubmit}
                />
              }
            >
              <Button
                testID="question-submit"
                label={tr("Reply", "回复")}
                variant="primary"
                size="sm"
                disabled={!complete()}
                onPress={submit}
              />
            </If>
          </If>
        </View>
      </View>
    </View>
  );
}
