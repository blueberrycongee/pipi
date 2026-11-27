import { platform, signal, Text, View } from "nsh";
import type { JSX, MouseEvent, PressEvent } from "nsh";
import { Input } from "nsh/base";
import { tr } from "../lib/i18n";
import type { DaemonSession } from "../pi/daemon";
import { createPersonalAgent, currentDaemonId, currentView, ensurePersonalAgent, isRunning, pendingSession, personalAgents } from "../store/app";
import { openDaemonSessionTab } from "../store/tabs";
import { Button, IconButton } from "../ui/Button";
import { uiHeight, uiType } from "../ui/typography";
import { FIELD_SURFACE, FOCUS_RING, HOVER_REVEAL, PRESS } from "../ui/styles";
import { tip } from "../ui/Tip";
import { PersonaAvatar } from "./PersonaAvatar";

const isModPress = (e?: { modifiers?: { platform?: boolean; control?: boolean } }) =>
  Boolean(platform.os === "macos" ? e?.modifiers?.platform : e?.modifiers?.control);

type PersonaListEntry = {
  personaId: string;
  title: string;
  id?: DaemonSession["id"];
  status?: DaemonSession["status"];
  unread?: boolean;
  avatar?: string;
};

/** The default Pip exists even before its daemon session has ever been started. */
function personaEntries(): PersonaListEntry[] {
  const list: PersonaListEntry[] = personalAgents().map((persona) => ({ ...persona, personaId: persona.personaId ?? "default" }));
  if (!list.some((persona) => persona.personaId === "default")) {
    list.unshift({ personaId: "default", title: "Pip", status: "idle", unread: false });
  }
  return list;
}

async function openPersonalAgent(personaId: string, newTab: boolean) {
  const id = await ensurePersonalAgent(personaId);
  if (id) openDaemonSessionTab(id, { newTab });
}

function PersonaRowItem(props: { persona: PersonaListEntry; trailing?: JSX.Element }) {
  const persona = () => props.persona;
  const open = () => {
    const id = persona().id;
    return id !== undefined && (pendingSession()?.daemonId ?? currentDaemonId()) === id;
  };
  const selected = () => open() && currentView().name === "chat";
  const working = () => (open() && isRunning()) || persona().status === "working" || persona().status === "blocked";
  const unread = () => Boolean(persona().unread) && !open() && !working();
  const title = () => persona().title || "Pip";
  return (
    <View class="group relative flex-1">
      <View
        role="button"
        testID={persona().personaId === "default" ? "sidebar-pip" : `sidebar-persona-${persona().personaId}`}
        accessibilityLabel={title()}
        accessibilityState={{ selected: selected() }}
        onPress={(e: PressEvent) => void openPersonalAgent(persona().personaId, isModPress(e))}
        onMouseUp={(e: MouseEvent) => {
          if (e.button === "middle") void openPersonalAgent(persona().personaId, true);
        }}
        tooltip={tip(tr(`${title()}, your personal agent`, `${title()}，你的私人助理`), undefined, "right")}
        class={`${uiHeight(32)} flex-row items-center gap-1.5 rounded-lg corner-squircle border-[0.5px] px-2.5 ${props.trailing ? "pr-8" : ""} ${PRESS} ${FOCUS_RING} hover:bg-sidebar-accent active:bg-sidebar-accent ${
          selected() ? "border-hairline bg-card shadow-sidebar-row dark:shadow-sidebar-row-dark" : "border-transparent"
        }`}
      >
        <View class="size-5 shrink-0 items-center justify-center overflow-hidden rounded-full">
          <PersonaAvatar avatar={() => persona().avatar} size={16} mood={working() ? "work" : "idle"} still={!working()} />
        </View>
        <Text class={`min-w-0 flex-1 truncate ${uiType("base")} text-sidebar-foreground ${selected() ? "font-medium" : ""}`}>{title()}</Text>
        <View testID={persona().personaId === "default" ? "sidebar-pip-unread" : undefined} class={`size-1.5 rounded-full bg-brand ${unread() ? "" : "opacity-0"}`} />
      </View>
      {props.trailing}
    </View>
  );
}

/**
 * The personal agents pinned above the sidebar's lists. One persona stays a
 * single compact row; more get a quiet section heading. The `+` opens a small
 * inline creation form and the new persona opens straight into conversation.
 */
export function PipRow() {
  const creating = signal(false);
  const busy = signal(false);
  const name = signal("");
  const description = signal("");
  const entries = () => personaEntries();
  const many = () => entries().length > 1;

  const submit = async () => {
    if (busy() || !name().trim()) return;
    busy.set(true);
    try {
      const id = await createPersonalAgent(name(), description());
      if (id) {
        creating.set(false);
        name.set("");
        description.set("");
        openDaemonSessionTab(id);
      }
    } finally {
      busy.set(false);
    }
  };

  const addButton = (className = "") => (
    <IconButton
      icon="plus"
      size="sm"
      label={tr("New personal agent", "新建个人智能体")}
      testID="sidebar-persona-add"
      class={className}
      onPress={() => {
        creating.set(true);
      }}
    />
  );

  return (
    <View class="shrink-0 px-2 pb-1">
      {many() ? (
        <View class="flex-row items-center justify-between pl-2.5 pr-1 pt-1">
          <Text class={`${uiType("2xs")} font-medium tracking-wide text-subtle`}>{tr("Personal", "个人智能体")}</Text>
          {addButton()}
        </View>
      ) : null}
      {entries().map((persona, index) => (
        <PersonaRowItem
          persona={persona}
          trailing={
            !many() && index === 0 ? (
              <View class={`absolute right-1 top-1/2 -translate-y-1/2 ${HOVER_REVEAL}`}>{addButton()}</View>
            ) : undefined
          }
        />
      ))}
      {creating() ? (
        <View testID="persona-create-form" class="mt-1 rounded-lg corner-squircle border-[0.5px] border-hairline bg-card p-2">
          <Input
            autoFocus
            value={name()}
            placeholder={tr("Name", "名字")}
            accessibilityLabel={tr("Personal agent name", "个人智能体名字")}
            testID="persona-name-input"
            onChange={({ value }) => name.set(value)}
            onSubmit={() => void submit()}
            class={`${uiHeight(26)} rounded-md corner-squircle px-2 ${uiType("sm")} text-foreground caret-brand placeholder:text-subtle ${FIELD_SURFACE}`}
          />
          <Input
            value={description()}
            placeholder={tr("Role or personality (optional)", "角色或性格（可选）")}
            accessibilityLabel={tr("Personal agent description", "个人智能体描述")}
            testID="persona-description-input"
            onChange={({ value }) => description.set(value)}
            onSubmit={() => void submit()}
            class={`${uiHeight(26)} mt-1.5 rounded-md corner-squircle px-2 ${uiType("sm")} text-foreground caret-brand placeholder:text-subtle ${FIELD_SURFACE}`}
          />
          <View class="mt-2 flex-row justify-end gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              label={tr("Cancel", "取消")}
              onPress={() => {
                creating.set(false);
                name.set("");
                description.set("");
              }}
            />
            <Button size="sm" variant="primary" testID="persona-create-submit" disabled={!name().trim() || busy()} label={tr("Create", "创建")} onPress={() => void submit()} />
          </View>
        </View>
      ) : null}
    </View>
  );
}
