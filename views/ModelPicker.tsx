import { computed, effect, signal, Text, untracked, View } from "nsh";
import { Button as BaseButton, Command, type CommandItem, Popover } from "nsh/base";
import { thinkingText, tr } from "../lib/i18n";
import type { ThinkingLevel } from "../pi/protocol";
import { providerName } from "../pi/providers";
import { activeAgent, availableModels, chooseModel, chooseThinkingLevel, focusComposer, modelPickerTick, sessionState, showAgentSettings, sidecarPhase, thinkingLevels } from "../store/app";
import { Chip } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { popupHiddenStyle, popupLeavingStyle, popupStyle, Presence } from "../ui/motion";
import { POPUP, PRESS } from "../ui/styles";

const modelKey = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;

/** The searchable list of the models Pi can call, grouped by provider. */
export function ModelList(props: { onChosen: () => void; class?: string }) {
  const current = () => {
    const model = sessionState()?.model;
    return model ? modelKey(model) : "";
  };
  const items = computed<CommandItem[]>(() =>
    availableModels().map((model) => ({
      id: modelKey(model),
      label: model.name || model.id,
      group: providerName(model.provider),
      keywords: [model.id, model.provider],
      checked: modelKey(model) === current(),
    })),
  );
  const byKey = computed(() => new Map(availableModels().map((model) => [modelKey(model), model])));
  return (
    <Command
      items={items()}
      placeholder={tr("Search models", "搜索模型")}
      accessibilityLabel={tr("Models", "模型")}
      autoFocus
      onCancel={props.onChosen}
      onSelect={({ id }) => {
        const model = byKey().get(id);
        props.onChosen();
        if (model) void chooseModel(model);
      }}
      class={props.class}
      searchBarClass="h-10 flex-row items-center gap-2 border-b border-border px-3"
      searchPrefix={<Icon name="search" size={14} tone="subtle" />}
      searchClass="flex-1 text-base text-foreground caret-brand placeholder:text-subtle"
      listClass="max-h-80 p-1"
      groupClass="px-2 pb-1 pt-2 text-xs font-medium text-subtle"
      separatorClass="mx-1 my-1 h-px bg-border"
      itemClass={`group h-8 flex-row items-center rounded-md px-2 ${PRESS} focus:bg-accent`}
      empty={
        <View class="items-center gap-3 px-6 py-8">
          <Text class="text-center text-sm text-muted-foreground">{tr("No models match. Connect a provider to see its models here.", "没有匹配的模型。连接服务商后即可在此查看其模型。")}</Text>
          <BaseButton onPress={() => (props.onChosen(), showAgentSettings())} class={`h-7 justify-center rounded-md bg-secondary px-2.5 ${PRESS} hover:bg-secondary/80`}>
            <Text class="text-base font-medium text-secondary-foreground">{tr(`Configure ${activeAgent().name}`, `配置 ${activeAgent().name}`)}</Text>
          </BaseButton>
        </View>
      }
      renderItem={(entry) => (
        <View class="flex-1 flex-row items-center gap-2">
          <Text class="shrink truncate text-base text-foreground">{entry.label}</Text>
          {byKey().get(entry.id)?.reasoning ? <Icon name="sparkle" size={12} tone="subtle" /> : null}
          <View class="flex-1" />
          <View class="w-4 items-center">{entry.checked ? <Icon name="check" size={14} tone="brand-text" /> : null}</View>
        </View>
      )}
    />
  );
}

/** The composer's model chip: shows the model in use, opens the list to change it. */
export function ModelPicker() {
  const open = signal(false);
  let held = "";
  const label = () => {
    const model = sessionState()?.model;
    // While the agent starts (a session switch), the chip keeps its words rather than passing through "No model".
    if (!model && held && sidecarPhase().name === "starting") return held;
    return (held = model && model.provider !== "unknown" ? model.name || model.id : tr("No model", "无模型"));
  };
  const close = () => {
    open.set(false);
    focusComposer();
  };
  // `/model` opens the list as a press on the chip does.
  let asked = false;
  effect(() => {
    modelPickerTick();
    if (asked) untracked(() => open.set(true));
    asked = true;
  });
  return (
    <Popover
      open={open()}
      onOpenChange={(e) => open.set(e.open)}
      placement="top"
      align="start"
      offset={8}
      margin={12}
      popupClass={`w-80 overflow-hidden ${POPUP}`}
      popupStyle={popupStyle("top", "start")}
      popupStartingStyle={popupHiddenStyle("top", "start")}
      popupEndingStyle={popupLeavingStyle("top", "start")}
      trigger={<Chip label={label()} />}
    >
      <ModelList onChosen={close} />
    </Popover>
  );
}

/** The composer's thinking chip, shown for models that reason. */
export function ThinkingPicker() {
  const open = signal(false);
  let held: ThinkingLevel | undefined;
  const level = () => {
    const now = sessionState()?.thinkingLevel;
    // As the model chip does: an agent that is starting has not said otherwise.
    if (!now && held && sidecarPhase().name === "starting") return held;
    return (held = now ?? "off");
  };
  return (
    <Presence show={thinkingLevels().length > 1} scaleFrom={0.92}>
      <Popover
        open={open()}
        onOpenChange={(e) => open.set(e.open)}
        placement="top"
        align="start"
        offset={8}
        margin={12}
        popupClass={`w-56 p-1 ${POPUP}`}
        popupStyle={popupStyle("top", "start")}
        popupStartingStyle={popupHiddenStyle("top", "start")}
        popupEndingStyle={popupLeavingStyle("top", "start")}
        trigger={<Chip label={thinkingText(level()).label} class="text-subtle" />}
      >
        <Text class="px-2 pb-1 pt-1.5 text-xs font-medium text-subtle" role="header">
          {tr("Thinking", "思考深度")}
        </Text>
        <Each of={thinkingLevels()}>
          {(option) => (
            <BaseButton
              selected={option() === level()}
              onPress={() => {
                open.set(false);
                void chooseThinkingLevel(option());
                focusComposer();
              }}
              class={`h-8 flex-row items-center gap-2 rounded-md px-2 ${PRESS} hover:bg-accent focus:bg-accent active:bg-accent`}
            >
              <Text class="text-base text-foreground">{thinkingText(option()).label}</Text>
              <Text class="flex-1 truncate text-xs text-subtle">{thinkingText(option()).hint}</Text>
              <View class="w-4 items-center">{option() === level() ? <Icon name="check" size={14} tone="brand-text" /> : null}</View>
            </BaseButton>
          )}
        </Each>
      </Popover>
    </Presence>
  );
}
