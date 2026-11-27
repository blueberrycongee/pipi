import { platform, Text, View } from "nsh";
import type { JSX, MouseEvent, PressEvent } from "nsh";
import { tr } from "../lib/i18n";
import type { DaemonSession } from "../pi/daemon";
import { currentDaemonId, currentView, ensurePersonalAgent, isRunning, pendingSession, personalAgents } from "../store/app";
import { openDaemonSessionTab } from "../store/tabs";
import { IconButton } from "../ui/Button";
import { uiHeight, uiType } from "../ui/typography";
import { FOCUS_RING, HOVER_REVEAL, PRESS } from "../ui/styles";
import { tip } from "../ui/Tip";
import { PersonaAvatar } from "./PersonaAvatar";
import { openPersonaCreate } from "./PersonaCreateDialog";

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
 * floating creation surface and the new persona opens straight into conversation.
 */
export function PipRow() {
  const entries = () => personaEntries();
  const many = () => entries().length > 1;

  const addButton = (className = "") => (
    <IconButton
      icon="plus"
      size="sm"
      label={tr("New personal agent", "新建个人智能体")}
      testID="sidebar-persona-add"
      class={className}
      onPress={() => {
        openPersonaCreate();
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
    </View>
  );
}
