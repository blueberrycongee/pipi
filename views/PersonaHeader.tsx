import { cleanup, createAnimatedValue, effect, keymap, Overlay, platform, reduceMotion, signal, Text, token, View } from "nsh";
import type { InputRef } from "nsh";
import { AlertDialog, Button as BaseButton, Input } from "nsh/base";
import { Menu, type MenuItem } from "nsh/desktop";
import { tr } from "../lib/i18n";
import { topBarHeight } from "../lib/layout";
import {
  activePersonaSession,
  deletePersonalAgent,
  newPersonaConversation,
  openLocalFile,
  renamePersonalAgent,
  resetPersonalAgentAvatar,
  setPersonalAgentAvatar,
  toast,
} from "../store/app";
import { backend } from "../store/backend";
import { Icon } from "../ui/Icon";
import { EASING } from "../ui/motion";
import { FOCUS_RING, GLASS_REGULAR, PRESS } from "../ui/styles";
import { tip } from "../ui/Tip";
import { uiHeight, uiRowHeight, uiType } from "../ui/typography";
import { PersonaAvatar } from "./PersonaAvatar";

const AVATAR_SIZE = 48;
const NAMEPLATE_OVERLAP = 8;
const HEADER_TOP = 6;
const HEADER_BOTTOM_GAP = 16;

/** Room a persona conversation leaves under the title bar for the floating identity. */
export function personaHeaderClearance() {
  return HEADER_TOP + AVATAR_SIZE - NAMEPLATE_OVERLAP + uiRowHeight(28) + HEADER_BOTTOM_GAP;
}

const SCRIM_STEPS = 8;
const smoothstep = (t: number) => t * t * (3 - 2 * t);
const alphaHex = (alpha: number) =>
  Math.round(Math.max(0, Math.min(1, alpha)) * 255)
    .toString(16)
    .padStart(2, "0");

/** The page-colored scrim rows recede into, eased at both ends so no fade line shows. */
function personaScrim(height: number): string {
  const base = String(token("background")).slice(0, 7);
  const fade = 52;
  const start = Math.max(0, height - fade);
  const stops = [`${base}ff 0px`, `${base}ff ${start}px`];
  for (let i = 1; i <= SCRIM_STEPS; i++) {
    const t = i / SCRIM_STEPS;
    const at = Math.round((start + fade * t) * 10) / 10;
    stops.push(`${base}${alphaHex(1 - smoothstep(t))} ${at}px`);
  }
  return `linear-gradient(to bottom, ${stops.join(", ")})`;
}

function capsuleSurface(active: boolean) {
  const tint = platform.os === "linux" ? "bg-popover" : active ? "bg-popover/96 dark:bg-popover/90" : "bg-popover/84 dark:bg-popover/78";
  return `rounded-full border-[0.5px] ${active ? "border-hairline-hover" : "border-hairline"} shadow-popover transition-colors duration-200 ease-out-quint motion-reduce:transition-none ${tint}`;
}

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
 * The personal agent's identity floating over its conversation: a prominent
 * circular avatar with a small frosted nameplate tucked onto its lower edge.
 * The avatar chooses a picture; the name edits inline. At rest the badge is
 * just those two shapes — its `…` arrives with the pointer, keyboard focus, or
 * its own open menu.
 */
export function PersonaHeader(props: { reading?: boolean }) {
  const editing = signal(false);
  const name = signal("");
  const nameWidth = signal(0);
  const inputRef = signal<InputRef | undefined>(undefined);
  const hovered = signal(false);
  const menuOpen = signal(false);
  const hoverAmount = createAnimatedValue(0);
  const persona = () => activePersonaSession();
  const title = () => persona()?.title || "Pip";

  const driveHover = (on: boolean) => {
    if (hovered() === on) return;
    hovered.set(on);
    void hoverAmount.stop();
    if (reduceMotion()) {
      hoverAmount.set(on ? 1 : 0);
      return;
    }
    void hoverAmount.timing(on ? 1 : 0, { duration: 180, easing: EASING.entrance });
  };
  let menuTicket = 0;
  cleanup(() => {
    menuTicket++;
    void hoverAmount.stop();
  });

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

  const openActions = () => {
    const ticket = ++menuTicket;
    menuOpen.set(true);
    void Menu.popup(menuItems()).then(
      () => {
        if (ticket === menuTicket) menuOpen.set(false);
      },
      () => {
        if (ticket === menuTicket) menuOpen.set(false);
      },
    );
  };

  const active = () => hovered() || editing() || menuOpen();
  const mascot = () => !persona()?.avatar;
  const playful = () => hovered() && mascot();
  const avatarLift = hoverAmount.interpolate({ inputRange: [0, 1], outputRange: [0, -1.5] });
  const avatarScale = hoverAmount.interpolate({ inputRange: [0, 1], outputRange: [1, 1.045] });
  const scrimHeight = () => topBarHeight() + personaHeaderClearance() + 30;

  return (
    <>
      <If when={Boolean(persona()) && props.reading}>
        <View
          testID="persona-header-scrim"
          class="pointer-events-none absolute inset-x-0 top-0 z-10"
          style={{ height: scrimHeight(), backgroundImage: personaScrim(scrimHeight()) }}
        />
      </If>
      <If when={Boolean(persona())}>
        <View
          testID="persona-header"
          class="pointer-events-none absolute inset-x-0 z-20 items-center"
          style={{ top: topBarHeight() + HEADER_TOP }}
        >
          <View
            testID="persona-header-hitarea"
            class="group pointer-events-auto items-center"
            onMouseEnter={() => driveHover(true)}
            onMouseLeave={() => driveHover(false)}
          >
            <BaseButton
              testID="persona-avatar-button"
              onPress={() => void chooseAvatar()}
              accessibilityLabel={tr("Change avatar", "更换头像")}
              tooltip={tip(tr("Change avatar", "更换头像"))}
              hitSlop={4}
              class={`size-12 items-center justify-center rounded-full ${PRESS} ${FOCUS_RING}`}
              style={{ transform: [{ translateY: avatarLift }, { scale: avatarScale }] }}
            >
              <View class="size-12 overflow-hidden rounded-full border-[0.5px] border-hairline bg-card shadow-raised">
                <PersonaAvatar
                  avatar={() => persona()?.avatar}
                  size={34}
                  mood={playful() ? "happy" : "idle"}
                  still={!playful()}
                  testID="persona-header-avatar"
                />
              </View>
              <View
                testID="persona-avatar-edit-hint"
                class="pointer-events-none absolute -right-0.5 -top-0.5 size-4 items-center justify-center rounded-full border-[0.5px] border-hairline bg-popover shadow-raised"
                style={{ opacity: hoverAmount }}
              >
                <Icon name="image" size={9} tone="muted-foreground" />
              </View>
            </BaseButton>
            <View
              testID="persona-header-capsule"
              class={`pointer-events-auto -mt-2 ${uiHeight(28)} min-w-20 max-w-60 flex-row items-center px-1 ${capsuleSurface(active())}`}
              style={GLASS_REGULAR}
            >
              <View class="w-5 shrink-0" />
              {editing() ? (
                <>
                  <Input
                    ref={(ref) => {
                      if (ref) inputRef.set(ref);
                    }}
                    autoFocus
                    value={name()}
                    onChange={({ value }) => name.set(value)}
                    onSubmit={commitEdit}
                    onBlur={commitEdit}
                    scrollbar={false}
                    accessibilityLabel={tr("Personal agent name", "个人智能体名字")}
                    testID="persona-name-input"
                    class={`${uiHeight(24)} rounded-full px-1 text-center ${uiType("sm")} font-medium text-foreground caret-brand`}
                    style={{ width: Math.max(72, nameWidth() + 8) }}
                  />
                  <If when={inputRef()}>
                    {(field) => <Overlay anchor={field()} onPressOutside={commitEdit} onCancel={cancelEdit} />}
                  </If>
                </>
              ) : (
                <BaseButton
                  testID="persona-name-button"
                  onPress={beginEdit}
                  onLayout={(e) => {
                    const width = Math.ceil(e.bounds.size.width);
                    if (!editing() && width > 0 && width !== nameWidth()) nameWidth.set(width);
                  }}
                  accessibilityLabel={tr("Rename personal agent", "重命名个人智能体")}
                  tooltip={tip(tr("Rename", "重命名"))}
                  class={`${uiHeight(24)} max-w-44 items-center justify-center rounded-full px-1 ${PRESS} ${FOCUS_RING}`}
                >
                  <Text class={`truncate text-center ${uiType("sm")} font-medium text-foreground`}>{title()}</Text>
                </BaseButton>
              )}
              <View class="w-5 shrink-0 items-center justify-center">
                <BaseButton
                  testID="persona-actions-button"
                  onPress={openActions}
                  accessibilityLabel={tr("Personal agent actions", "个人智能体操作")}
                  tooltip={tip(tr("Personal agent actions", "个人智能体操作"))}
                  hitSlop={4}
                  class={`size-5 items-center justify-center rounded-full ${PRESS} ${FOCUS_RING} hover:bg-accent active:bg-accent transition-opacity duration-200 ease-out-quint motion-reduce:transition-none`}
                  style={{ opacity: editing() || menuOpen() ? 1 : hoverAmount }}
                  focusVisibleStyle={{ opacity: 1 }}
                >
                  <Icon name="more" size={12} tone="muted-foreground" />
                </BaseButton>
              </View>
            </View>
          </View>
        </View>
      </If>
    </>
  );
}
