import { computed, effect, signal, Text, untracked, View } from "nsh";
import { Button as BaseButton, Command, type CommandItem, Popover } from "nsh/base";
import { thinkingText, tr } from "../lib/i18n";
import type { SessionModelConfig, ThinkingLevel } from "../pi/protocol";
import { providerName } from "../pi/providers";
import { activeAgent, availableModels, chooseModel, chooseModelConfig, chooseThinkingLevel, draftModel, draftThinkingLevel, focusComposer, modelPickerTick, sessionState, showAgentSettings, sidecarPhase, thinkingLevels } from "../store/app";
import { Chip } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { popupHiddenStyle, popupLeavingStyle, popupStyle, Presence } from "../ui/motion";
import { POPUP, PRESS } from "../ui/styles";
import { uiHeight, uiType } from "../ui/typography";

const modelKey = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;

/** The searchable list of the models Pi can call, grouped by provider. */
export function ModelList(props: { onChosen: () => void; class?: string }) {
  const query = signal("");
  const current = () => {
    const model = draftModel() ?? sessionState()?.model;
    return model ? modelKey(model) : "";
  };
  const items = computed<CommandItem[]>(() =>
    availableModels().map((model) => ({
      id: modelKey(model),
      label: model.name || model.id,
      group: model.group ?? providerName(model.provider),
      keywords: [model.id, model.provider],
      checked: modelKey(model) === current(),
    })),
  );
  const byKey = computed(() => new Map(availableModels().map((model) => [modelKey(model), model])));
  return (
    <Command
      items={items()}
      query={query()}
      onQueryChange={(event) => query.set(event.query)}
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
      searchBarClass={`${uiHeight(40)} flex-row items-center gap-2 border-b border-border px-3`}
      searchPrefix={<Icon name="search" size={14} tone="subtle" />}
      searchClass={`flex-1 ${uiType("base")} text-foreground caret-brand placeholder:text-subtle`}
      listClass="max-h-80 p-1"
      groupClass={`px-2 pb-1 pt-2 ${uiType("xs")} font-medium text-subtle`}
      separatorClass="mx-1 my-1 h-px bg-border"
      itemClass={`group ${uiHeight(32)} flex-row items-center rounded-md corner-squircle px-2 ${PRESS} focus:bg-accent`}
      empty={
        <View class="items-center gap-3 px-6 py-8">
          <Text class={`text-center ${uiType("sm")} text-muted-foreground`}>{availableModels().length
            ? tr(`No models match “${query()}”.`, `没有与“${query()}”匹配的模型。`)
            : tr("Connect a provider to see its models here.", "连接服务商后即可在此查看其模型。")}</Text>
          <If when={!availableModels().length}>
            <BaseButton onPress={() => (props.onChosen(), showAgentSettings())} class={`${uiHeight(28)} justify-center rounded-md corner-squircle bg-secondary px-2.5 ${PRESS} hover:bg-secondary/80`}>
              <Text class={`${uiType("base")} font-medium text-secondary-foreground`}>{tr(`Configure ${activeAgent().name}`, `配置 ${activeAgent().name}`)}</Text>
            </BaseButton>
          </If>
        </View>
      }
      renderItem={(entry) => (
        <View class="flex-1 flex-row items-center gap-2">
          <Text class={`shrink truncate ${uiType("base")} text-foreground`}>{entry.label}</Text>
          {byKey().get(entry.id)?.reasoning ? <Icon name="sparkle" size={12} tone="subtle" /> : null}
          <View class="flex-1" />
          <View class="w-4 items-center">{entry.checked ? <Icon name="check" size={14} tone="brand-text" /> : null}</View>
        </View>
      )}
    />
  );
}

/** The composer's model chip: shows the model in use, opens the list to change it. */
export function ModelPicker(props: { onOpen?: () => void }) {
  const open = signal(false);
  let held = "";
  const label = () => {
    const model = draftModel() ?? sessionState()?.model;
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
      onOpenChange={(e) => {
        if (e.open) props.onOpen?.();
        open.set(e.open);
      }}
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


/** One engine-reported model-adjacent selector (ACP `model_config` — Devin's speed, for example). */
function ModelConfigPicker(props: { config: SessionModelConfig; onOpen?: () => void }) {
  const open = signal(false);
  const bool = props.config.type === "boolean";
  const choices: { value: string | boolean; name: string; description?: string }[] = bool
    ? [
        { value: true, name: tr("On", "开启") },
        { value: false, name: tr("Off", "关闭") },
      ]
    : (props.config.options ?? []);
  const current = () => choices.find((choice) => choice.value === props.config.currentValue);
  if (choices.length < 2) return null;
  return (
    <Popover
      open={open()}
      onOpenChange={(e) => {
        if (e.open) props.onOpen?.();
        open.set(e.open);
      }}
      placement="top"
      align="start"
      offset={8}
      margin={12}
      popupClass={`w-56 p-1 ${POPUP}`}
      popupStyle={popupStyle("top", "start")}
      popupStartingStyle={popupHiddenStyle("top", "start")}
      popupEndingStyle={popupLeavingStyle("top", "start")}
      trigger={<Chip label={current()?.name ?? String(props.config.currentValue)} class="text-subtle" />}
    >
      <Text class={`px-2 pb-1 pt-1.5 ${uiType("xs")} font-medium text-subtle`} role="header">
        {props.config.name}
      </Text>
      <Each of={choices} key={(choice) => String(choice.value)}>
        {(choice) => (
          <BaseButton
            selected={choice().value === props.config.currentValue}
            onPress={() => {
              open.set(false);
              void chooseModelConfig(props.config.id, choice().value);
              focusComposer();
            }}
            class={`${uiHeight(32)} flex-row items-center gap-2 rounded-md corner-squircle px-2 ${PRESS} hover:bg-accent focus:bg-accent active:bg-accent`}
          >
            <Text class={`${uiType("base")} text-foreground`}>{choice().name}</Text>
            <Text class={`flex-1 truncate ${uiType("xs")} text-subtle`}>{choice().description ?? ""}</Text>
            <View class="w-4 items-center">{choice().value === props.config.currentValue ? <Icon name="check" size={14} tone="brand-text" /> : null}</View>
          </BaseButton>
        )}
      </Each>
    </Popover>
  );
}

/** Every model-adjacent selector the active engine reported, beside the model itself as ACP asks. */
export function ModelConfigPickers(props: { onOpen?: () => void }) {
  return (
    <Each of={sessionState()?.modelConfigs ?? []} key={(config) => config.id}>
      {(config) => <ModelConfigPicker config={config()} onOpen={props.onOpen} />}
    </Each>
  );
}

/** The composer's thinking chip, shown for models that reason. */
export function ThinkingPicker(props: { onOpen?: () => void }) {
  const open = signal(false);
  let held: ThinkingLevel | undefined;
  const level = () => {
    const now = draftThinkingLevel() ?? sessionState()?.thinkingLevel;
    // As the model chip does: an agent that is starting has not said otherwise.
    if (!now && held && sidecarPhase().name === "starting") return held;
    return (held = now ?? "off");
  };
  return (
    <Presence show={thinkingLevels().length > 1} scaleFrom={0.92}>
      <Popover
        open={open()}
        onOpenChange={(e) => {
          if (e.open) props.onOpen?.();
          open.set(e.open);
        }}
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
        <Text class={`px-2 pb-1 pt-1.5 ${uiType("xs")} font-medium text-subtle`} role="header">
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
              class={`${uiHeight(32)} flex-row items-center gap-2 rounded-md corner-squircle px-2 ${PRESS} hover:bg-accent focus:bg-accent active:bg-accent`}
            >
              <Text class={`${uiType("base")} text-foreground`}>{thinkingText(option()).label}</Text>
              <Text class={`flex-1 truncate ${uiType("xs")} text-subtle`}>{thinkingText(option()).hint}</Text>
              <View class="w-4 items-center">{option() === level() ? <Icon name="check" size={14} tone="brand-text" /> : null}</View>
            </BaseButton>
          )}
        </Each>
      </Popover>
    </Presence>
  );
}
