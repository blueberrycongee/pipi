import { signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { tr } from "../lib/i18n";
import { createPersonalAgent } from "../store/app";
import { openDaemonSessionTab } from "../store/tabs";
import { Button } from "../ui/Button";
import { FloatingLayer } from "../ui/motion";
import { FIELD_SURFACE } from "../ui/styles";
import { uiHeight, uiType } from "../ui/typography";

export const personaCreateOpen = signal(false);

export function openPersonaCreate() {
  personaCreateOpen.set(true);
}

/** Centered creation surface for a personal agent; the sidebar itself stays a compact navigation list. */
export function PersonaCreateDialog() {
  const busy = signal(false);
  const name = signal("");
  const description = signal("");

  const close = () => {
    personaCreateOpen.set(false);
    name.set("");
    description.set("");
  };

  const submit = async () => {
    if (busy() || !name().trim()) return;
    busy.set(true);
    try {
      const id = await createPersonalAgent(name(), description());
      if (id) {
        close();
        openDaemonSessionTab(id);
      }
    } finally {
      busy.set(false);
    }
  };

  return (
    <FloatingLayer open={personaCreateOpen()} onClose={close} closeLabel={tr("Close", "关闭")} panelClass="w-full max-w-90" testID="persona-create-layer">
      <View testID="persona-create-form" class="p-4">
        <Text class={`${uiType("lg")} font-medium text-foreground`}>{tr("New personal agent", "新建个人智能体")}</Text>
        <Input
          autoFocus
          value={name()}
          placeholder={tr("Name", "名字")}
          accessibilityLabel={tr("Personal agent name", "个人智能体名字")}
          testID="persona-name-input"
          onChange={({ value }) => name.set(value)}
          onSubmit={() => void submit()}
          class={`${uiHeight(32)} mt-4 rounded-lg corner-squircle px-3 ${uiType("base")} text-foreground caret-brand placeholder:text-subtle ${FIELD_SURFACE}`}
        />
        <Input
          value={description()}
          placeholder={tr("Role or personality (optional)", "角色或性格（可选）")}
          accessibilityLabel={tr("Personal agent description", "个人智能体描述")}
          testID="persona-description-input"
          onChange={({ value }) => description.set(value)}
          onSubmit={() => void submit()}
          class={`${uiHeight(32)} mt-2 rounded-lg corner-squircle px-3 ${uiType("base")} text-foreground caret-brand placeholder:text-subtle ${FIELD_SURFACE}`}
        />
        <View class="mt-4 flex-row justify-end gap-2">
          <Button size="sm" variant="ghost" testID="persona-create-cancel" label={tr("Cancel", "取消")} onPress={close} />
          <Button size="sm" variant="primary" testID="persona-create-submit" disabled={!name().trim() || busy()} label={tr("Create", "创建")} onPress={() => void submit()} />
        </View>
      </View>
    </FloatingLayer>
  );
}
