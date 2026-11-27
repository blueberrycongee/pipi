import { cleanup, effect, keymap, signal, Text, View } from "nsh";
import { AlertDialog, Button as BaseButton, Input } from "nsh/base";
import { Menu, type MenuItem } from "nsh/desktop";
import { tr } from "../lib/i18n";
import { topBarHeight } from "../lib/layout";
import {
  activePersonaSession,
  deletePersonalAgent,
  newPersonaConversation,
  openLocalFile,
  personalAgents,
  renamePersonalAgent,
  resetPersonalAgentAvatar,
  setPersonalAgentAvatar,
  toast,
} from "../store/app";
import { backend } from "../store/backend";
import { IconButton } from "../ui/Button";
import { PRESS } from "../ui/styles";
import { tip } from "../ui/Tip";
import { uiHeight, uiType } from "../ui/typography";
import { PersonaAvatar } from "./PersonaAvatar";

/** Vertical room the centered persona identity reserves at the transcript's top. */
export const PERSONA_HEADER_HEIGHT = 76;

async function confirmDeletePersona(sessionId: string, title: string) {
  const { action } = await AlertDialog.show({
    title: tr("Delete this personal agent?", "删除此个人智能体？"),
    description: tr(
      `“${title}”, its PERSONA.md, MEMORY.md and avatar will be removed from this Mac. Sessions it started are kept. This cannot be undone.`,
      `“${title}”及其 PERSONA.md、MEMORY.md 和头像将从此设备移除；它发起的编码会话会保留。该操作无法撤销。`,
    ),
    actions: [
      { label: tr("Cancel", "取消"), role: "cancel", id: "cancel" },
      { label: tr("Delete", "删除"), role: "destructive", id: "delete" },
    ],
  });
  if (action === "delete") await deletePersonalAgent(sessionId);
}

/**
 * The personal agent's Messages-style identity at the top of its conversation:
 * a centered circular avatar with its name underneath. The avatar chooses a
 * picture; the name edits inline; everything else stays inside the quiet `…`.
 */
export function PersonaHeader() {
  const editing = signal(false);
  const name = signal("");
  const persona = () => activePersonaSession();
  const title = () => persona()?.title || "Pip";

  const beginEdit = () => {
    name.set(title());
    editing.set(true);
  };
  const cancelEdit = () => {
    name.set(title());
    editing.set(false);
  };
  const commitEdit = () => {
    if (!editing()) return;
    const id = persona()?.id;
    const next = name().trim();
    editing.set(false);
    if (id && next && next !== title()) void renamePersonalAgent(id, next);
  };
  effect(() => {
    if (!editing()) return;
    cleanup(keymap.bind("escape", cancelEdit, { when: "always" }));
  });

  const chooseAvatar = async () => {
    const id = persona()?.id;
    if (!id) return;
    try {
      const picked = backend().pickImage
        ? await backend().pickImage!(tr("Choose avatar", "选择头像"))
        : await backend().pickFile?.(tr("Choose avatar", "选择头像"), ["png", "jpg", "jpeg", "webp", "gif"]);
      if (picked) await setPersonalAgentAvatar(id, picked);
    } catch {
      toast("warning", tr("No image picker is available on this system.", "此系统没有可用的图片选择器。"));
    }
  };

  const menuItems = (): MenuItem[] => {
    const current = persona();
    if (!current) return [];
    const dir = current.cwd.replace(/\/$/, "");
    const personaId = current.personaId ?? "default";
    const deletable = personaId !== "default";
    return [
      { label: tr("Rename…", "重命名…"), onSelect: beginEdit },
      { label: tr("Change Avatar…", "更换头像…"), onSelect: () => void chooseAvatar() },
      { label: tr("Reset Avatar", "恢复默认头像"), disabled: !current.avatar, onSelect: () => void resetPersonalAgentAvatar(current.id) },
      { type: "separator" },
      { label: tr("Open PERSONA.md", "打开 PERSONA.md"), onSelect: () => void openLocalFile(`${dir}/PERSONA.md`) },
      { label: tr("Open MEMORY.md", "打开 MEMORY.md"), onSelect: () => void openLocalFile(`${dir}/MEMORY.md`) },
      { type: "separator" },
      { label: tr("New Conversation", "新建对话"), onSelect: () => void newPersonaConversation() },
      ...(deletable
        ? [
            { type: "separator" } as MenuItem,
            { label: tr("Delete Personal Agent…", "删除个人智能体…"), onSelect: () => void confirmDeletePersona(current.id, title()) },
          ]
        : []),
    ];
  };

  return (
    <If when={Boolean(persona())}>
      <View
        testID="persona-header"
        class="pointer-events-none absolute inset-x-0 z-10 items-center"
        style={{ top: topBarHeight() + 4, height: PERSONA_HEADER_HEIGHT - 4 }}
      >
        <View class="pointer-events-auto items-center">
        <BaseButton
          testID="persona-avatar-button"
          onPress={() => void chooseAvatar()}
          accessibilityLabel={tr("Change avatar", "更换头像")}
          tooltip={tip(tr("Change avatar", "更换头像"))}
          class={`group size-11 items-center justify-center rounded-full ${PRESS}`}
        >
          <View class="size-11 overflow-hidden rounded-full border-[0.5px] border-hairline bg-card shadow-sm">
            <PersonaAvatar avatar={() => persona()?.avatar} size={31} mood="idle" still testID="persona-header-avatar" />
          </View>
        </BaseButton>
        <View class="mt-1 h-6 flex-row items-center justify-center">
          {editing() ? (
            <Input
              autoFocus
              value={name()}
              onChange={({ value }) => name.set(value)}
              onSubmit={commitEdit}
              onBlur={commitEdit}
              accessibilityLabel={tr("Personal agent name", "个人智能体名字")}
              testID="persona-name-input"
              class={`${uiHeight(24)} w-40 rounded-md corner-squircle px-2 text-center ${uiType("sm")} font-medium text-foreground caret-brand`}
            />
          ) : (
            <BaseButton
              testID="persona-name-button"
              onPress={beginEdit}
              accessibilityLabel={tr("Rename personal agent", "重命名个人智能体")}
              tooltip={tip(tr("Rename", "重命名"))}
              class={`${uiHeight(24)} max-w-56 items-center justify-center rounded-md corner-squircle px-1.5 ${PRESS}`}
            >
              <Text class={`truncate text-center ${uiType("sm")} font-medium text-foreground`}>{title()}</Text>
            </BaseButton>
          )}
          <View class="w-6 items-center">
            <IconButton
              icon="more"
              size="sm"
              label={tr("Personal agent actions", "个人智能体操作")}
              testID="persona-actions-button"
              class="size-5"
              onPress={() => void Menu.popup(menuItems())}
            />
          </View>
        </View>
      </View>
      </View>
    </If>
  );
}
