import { readFile } from "fs/promises";
import { Canvas, cleanup, Clipboard, computed, createAnimatedValue, effect, Image, keymap, Overlay, reduceMotion, Scroll, signal, Text, token, untracked, View } from "nsh";
import type { InputRef, JSX, PasteEvent, ScrollRef, ViewRef } from "nsh";
import { Button as BaseButton, Input, Popover } from "nsh/base";
import { money } from "../lib/format";
import { matchDocMentions, readDocMention, removeDocMention, type DocMentionInput } from "../lib/doc-mention";
import { commandSourceLabel, tr } from "../lib/i18n";
import { extensionLabel, formatBytes, isRichPasteFile, type FileAttachment } from "../lib/media";
import { matchCommands, matchOptions, readSlashInput, type ComposerCommand } from "../lib/slash";
import type { ExtensionUiAnswer, ExtensionUiDialog, SessionStats } from "../pi/protocol";
import { compactNumber } from "../pi/transcript";
import {
  activeAgent,
  addAttachment,
  answerDialog,
  attachLocalPath,
  type Attachment,
  composerAttachments,
  composerDocs,
  composerDraft,
  composerFiles,
  composerFocusTick,
  currentView,
  detachDoc,
  type DocRef,
  extensionStatuses,
  extensionWidgets,
  focusComposer,
  hasModel,
  isBashRunning,
  isDraftAhead,
  isPersonaSession,
  isRunning,
  openLocalFile,
  pendingDialog,
  personaDisplayName,
  pickComposerFile,
  removeAttachment,
  removeFileAttachment,
  send,
  sessionState,
  sessionStats,
  setDraft,
  sidecarPhase,
  slashCommands,
  stop,
  toast,
  trackAttachmentRead,
  transcriptRows,
  waitingCount,
} from "../store/app";
import { docAt } from "../store/docs";
import { readingSize, FONT_SIZES, SEND_MODES, sendMode, setSendMode, type SendMode } from "../store/prefs";
import { focusedPane, focusPane, isSplitOpen } from "../store/split";
import { attachDocToCurrentComposer, draftToDoc, mentionableDocs, openDocTab } from "../store/tabs";
import { IconButton } from "../ui/Button";
import { Icon, type IconName } from "../ui/Icon";
import { EASING, enter, keepLast, popupHiddenStyle, popupLeavingStyle, popupStyle, Presence, Reveal, SPRING } from "../ui/motion";
import { COMPOSER_SURFACE, FOCUS_RING, GLASS_REGULAR, HOVER_REVEAL, POPUP, PRESS, PRESS_SCALE } from "../ui/styles";
import { tip } from "../ui/Tip";
import { readingType, uiHeight, uiMinHeight, uiType } from "../ui/typography";
import { AgentPicker, PermissionPicker } from "./AgentPicker";
import { openMediaZoom } from "./Media";
import { ExtensionPrompt } from "./ExtensionDialog";
import { ModelConfigPickers, ModelPicker, ThinkingPicker } from "./ModelPicker";
import { QuestionForm } from "./QuestionForm";

const MIN_HEIGHT = 32;
const MAX_HEIGHT = 220;
/** The field's height from its third line on: a draft that long is offered a document to go on in. */
const LONG_DRAFT_HEIGHT = 66;

/** The image types Pi's providers take; past its bound a paste stays a path instead. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"]);
const IMAGE_EXTENSIONS: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** What the bytes say they are: a pasted File's `type` and a copied file's name can both lie. */
const sniffImageType = (bytes: Uint8Array): string | undefined => {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "image/gif";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45) return "image/webp";
  return undefined;
};

/** A local file copied in a file manager arrives as a `file:` URL, not pasted bytes. */
const fileUriPath = (uri: string): string | undefined => {
  if (!uri.startsWith("file://")) return undefined;
  try {
    return decodeURIComponent(uri.slice("file://".length).replace(/^localhost/, ""));
  } catch {
    return undefined;
  }
};

/** One line of the slash menu: a command, or a value for a command's first argument. */
interface SlashRow {
  key: string;
  /** In mono: the command with its slash, or the argument's value. */
  title: string;
  /** What follows the command, dimmed after it: `<agent> <task>`. */
  hint?: string;
  description?: string;
  /** Whose command it is. */
  tag?: string;
  /** The draft confirming the row leaves: the row filled in, the caret where the next word goes. */
  completion: string;
}

/**
 * The slash menu's state: what the draft finds, which row is marked, and the
 * keys that are the menu's while it shows. Choosing a row (Enter, Tab, or a
 * press) confirms it into the draft so arguments can follow — or a second
 * Enter sends it; Escape closes the menu and leaves the draft, which then
 * sends as written. The commands are the shell's own and the active engine's
 * (`slashCommands`), so the list changes with the agent and the shell's part
 * of it does not.
 */
/**
 * State and actions that drive a `Composer` instance. Every chat surface —
 * primary pane and split panes alike — mounts the exact same `Composer`
 * component backed by its own `ComposerStore`.
 */
export interface ComposerStore {
  isActive: () => boolean;
  isFocused: () => boolean;
  onFocusPane?: () => void;
  draft: () => string;
  setDraft: (value: string) => void;
  attachments: () => Attachment[];
  addAttachment: (att: Attachment) => void;
  removeAttachment: (index: number) => void;
  files: () => FileAttachment[];
  attachLocalPath: (path: string) => Promise<boolean>;
  removeFileAttachment: (path: string) => void;
  pickFile: () => Promise<void>;
  docs: () => DocRef[];
  attachDocPath: (path: string) => Promise<void>;
  detachDoc: (path: string) => void;
  draftToDoc?: () => Promise<void>;
  trackAttachmentRead?: (pending: Promise<void>) => void;
  focusTick: () => number;
  requestFocus: () => void;
  ready: () => boolean;
  canSend: () => boolean;
  failed: () => boolean;
  hasModel: () => boolean;
  visionSupported: () => boolean;
  running: () => boolean;
  working: () => boolean;
  agentName: () => string;
  personaName?: () => string | undefined;
  slashCommands: () => ComposerCommand[];
  pendingDialog: () => ExtensionUiDialog | undefined;
  answerDialog: (id: string, answer: ExtensionUiAnswer) => void;
  extensionStatuses?: () => Record<string, string>;
  extensionWidgets?: () => Record<string, { lines: string[]; below: boolean }>;
  contextUsage?: () => { stats: SessionStats | undefined; hasRows: boolean };
  send: (mode?: "steer" | "followUp") => Promise<unknown>;
  stop: () => Promise<unknown>;
  renderLeftPickers?: (dismissMenus: () => void) => JSX.Element;
  renderPermissionPicker?: (dismissMenus: () => void) => JSX.Element;
  renderExtensionPrompt?: () => JSX.Element;
  inputTestID?: string;
  inputLabel?: string;
  sendTestID?: string;
  stopTestID?: string;
  autoFocus?: boolean;
}

const primaryComposerStore: ComposerStore = {
  isActive: () => currentView().name === "chat",
  isFocused: () => currentView().name === "chat" && (!isSplitOpen() || focusedPane() === "primary"),
  onFocusPane: () => {
    if (isSplitOpen()) focusPane("primary");
  },
  draft: composerDraft,
  setDraft,
  attachments: composerAttachments,
  addAttachment,
  removeAttachment,
  files: composerFiles,
  attachLocalPath,
  removeFileAttachment,
  pickFile: pickComposerFile,
  docs: composerDocs,
  attachDocPath: async (path) => {
    await attachDocToCurrentComposer(path);
  },
  detachDoc,
  draftToDoc,
  trackAttachmentRead,
  focusTick: composerFocusTick,
  requestFocus: focusComposer,
  ready: () => sidecarPhase().name === "ready",
  canSend: () => sidecarPhase().name === "ready" || isDraftAhead(),
  failed: () => sidecarPhase().name === "failed",
  hasModel,
  visionSupported: () => Boolean(sessionState()?.model?.input?.includes("image")),
  running: isRunning,
  working: () => isRunning() || isBashRunning() || waitingCount() > 0,
  agentName: () => activeAgent().name,
  personaName: () => (isPersonaSession() ? personaDisplayName() : undefined),
  slashCommands,
  pendingDialog,
  answerDialog,
  extensionStatuses,
  extensionWidgets,
  contextUsage: () => ({ stats: sessionStats(), hasRows: transcriptRows().length > 0 }),
  send,
  stop,
  autoFocus: true,
};

function useSlashMenu(s: ComposerStore, onComplete: (row: SlashRow) => void) {
  const selected = signal(0);
  /** Ticks when an arrow key moves the mark: the list scrolls after the keys, not after the pointer. */
  const keyed = signal(0, { equals: false });
  /** The kind of input Escape closed the menu on; it stays closed while the draft is still that. */
  const dismissed = signal<"command" | "argument" | undefined>(undefined);
  const input = computed(() => (s.isFocused() ? readSlashInput(s.draft()) : undefined));
  const rows = computed<SlashRow[]>(() => {
    const asked = input();
    if (!asked || asked.kind === dismissed()) return [];
    if (asked.kind === "command") {
      const agentName = s.agentName();
      return matchCommands(s.slashCommands(), asked.query).map((command) => ({
        key: command.name,
        title: `/${command.name}`,
        hint: command.argumentHint,
        description: command.description,
        tag: commandSourceLabel(command.source, agentName),
        completion: `/${command.name} `,
      }));
    }
    const command = s.slashCommands().find((known) => known.name === asked.name);
    return matchOptions(command?.options ?? [], asked.query).map((option) => ({
      key: `${asked.name} ${option.value}`,
      title: option.value,
      description: option.description,
      completion: `/${asked.name} ${option.value} `,
    }));
  });
  /**
   * A command is being typed that nothing here answers to. Each engine has its
   * own commands, and a name known from one engine's own tool may not exist on
   * this one: the menu says so rather than closing, since the line then goes to
   * the agent as written.
   */
  const unmatched = computed(() => {
    const asked = input();
    return asked?.kind === "command" && asked.query !== "" && asked.kind !== dismissed() && rows().length === 0;
  });
  const open = () => rows().length > 0 || unmatched();
  const current = () => rows()[Math.min(selected(), rows().length - 1)] as SlashRow | undefined;
  effect(() => {
    rows();
    selected.set(0);
  });
  effect(() => {
    if (input()?.kind !== dismissed()) dismissed.set(undefined);
  });
  // These keys are the menu's only while it shows. Escape's newest binding is this one, so it closes the menu before it stops a run.
  effect(() => {
    if (!open()) return;
    cleanup(keymap.bind("escape", () => dismissed.set(untracked(input)?.kind), { when: "always" }));
    // With no row to mark, the arrows and Tab stay the input's.
    if (!rows().length) return;
    const move = (by: number) => {
      selected.update((at) => (Math.min(at, rows().length - 1) + by + rows().length) % rows().length);
      keyed.set(0);
    };
    cleanup(keymap.bind({ up: () => move(-1), down: () => move(1) }, { when: "always", repeat: true }));
    cleanup(
      keymap.bind(
        "tab",
        () => {
          const row = current();
          if (row) onComplete(row);
        },
        { when: "always" },
      ),
    );
  });
  /** Closes the menu as Escape does, the draft left as it was until a new slash. */
  const dismiss = () => dismissed.set(untracked(input)?.kind);
  return { rows, unmatched, selected, keyed, open, current, dismiss };
}

/**
 * The menu over the composer: eight and a half rows show at most — the half
 * row says the list goes on — and the rest scroll. The mark follows the
 * pointer once it moves, so there is one marked row and never a hovered one
 * beside it; a row scrolled under a resting pointer does not take it.
 *
 * It is an `Overlay` anchored to the composer's column, so a press anywhere
 * else — the transcript, the sidebar, the composer's own chips — closes it as
 * Escape does, and still reaches what it landed on. A press inside the column
 * (the input, the tray, the chip row) is not an outside press: the draft is
 * still being written there.
 */
function SlashMenu(props: {
  menu: ReturnType<typeof useSlashMenu>;
  agentName: () => string;
  onChoose: (row: SlashRow) => void;
  anchor?: ViewRef;
  width: number;
}) {
  const mounted = signal(false);
  const opacity = createAnimatedValue(0);
  const translateY = createAnimatedValue(6);
  const scale = createAnimatedValue(0.97);
  // What the menu holds, kept while it fades out: its rows, or the line that says nothing matches.
  const shown = keepLast(
    () => {
      const list = props.menu.rows();
      if (list.length > 0) return { rows: list, unmatched: false };
      return props.menu.unmatched() ? { rows: [] as SlashRow[], unmatched: true } : undefined;
    },
    { rows: [] as SlashRow[], unmatched: false },
  );
  const rowViews = new Map<string, ViewRef>();
  let list: ScrollRef | undefined;
  let exitTimer: ReturnType<typeof setTimeout> | undefined;

  // The marked row stays in view: the arrow keys take the list with them.
  effect(() => {
    props.menu.keyed();
    const row = untracked(props.menu.current);
    if (row) rowViews.get(row.key)?.reveal({ vertical: "nearest", animated: false });
  });
  // A list that changes while it shows marks its first row again: back to the top with it.
  let showing = false;
  effect(() => {
    const now = props.menu.rows().length > 0;
    if (now && showing) list?.scrollTo({ y: 0, animated: false });
    showing = now;
  });

  effect(() => {
    const open = props.menu.open();
    const reduced = reduceMotion();
    untracked(() => {
      clearTimeout(exitTimer);
      void opacity.stop();
      void translateY.stop();
      void scale.stop();
      if (open) {
        mounted.set(true);
        if (reduced) {
          opacity.set(1);
          translateY.set(0);
          scale.set(1);
        } else {
          opacity.set(0);
          translateY.set(6);
          scale.set(0.97);
          void opacity.timing(1, { duration: 160, easing: EASING.entrance });
          void translateY.spring(0, SPRING.snappy);
          void scale.spring(1, SPRING.snappy);
        }
      } else if (mounted()) {
        if (reduced) {
          opacity.set(0);
          mounted.set(false);
        } else {
          void opacity.timing(0, { duration: 130, easing: EASING.exit });
          void translateY.timing(4, { duration: 130, easing: EASING.exit });
          void scale.timing(0.98, { duration: 130, easing: EASING.exit });
          exitTimer = setTimeout(() => mounted.set(false), 135);
        }
      }
    });
  });

  cleanup(() => {
    clearTimeout(exitTimer);
    void opacity.stop();
    void translateY.stop();
    void scale.stop();
  });

  return (
    <If when={mounted()}>
      <If when={props.anchor}>
        {(anchor) => (
      <Overlay
        anchor={anchor()}
        placement="top"
        align="start"
        offset={8}
        margin={12}
        onPressOutside={props.menu.open() ? () => props.menu.dismiss() : undefined}
      >
      <View
        class={`overflow-hidden ${POPUP}${props.menu.open() ? "" : " pointer-events-none"}`}
        style={{ ...GLASS_REGULAR, width: props.width, opacity, transform: [{ translateY }, { scale }] }}
        role="menu"
        accessibilityLabel={tr("Commands", "命令")}
      >
        <Scroll ref={list} class="max-h-69" contentClass="p-1">
          <If when={shown()?.unmatched === true}>
            <View class={`${uiHeight(32)} flex-row items-center px-2`}>
              <Text class={`min-w-0 flex-1 truncate ${uiType("sm")} text-muted-foreground`}>
                {tr(
                  `No command by that name. Enter sends it to ${props.agentName()} as written.`,
                  `没有这个命令，回车将原样发给 ${props.agentName()}。`,
                )}
              </Text>
            </View>
          </If>
          <Each of={shown()?.rows ?? []} key={(row) => row.key}>
            {(row, index) => (
              <View
                ref={(view: ViewRef) => rowViews.set(row().key, view)}
                role="menuitem"
                focusable={false}
                onPress={() => props.onChoose(row())}
                onMouseMove={() => {
                  if (props.menu.selected() !== index()) props.menu.selected.set(index());
                }}
                class={`${uiHeight(32)} flex-row items-center gap-2 rounded-md corner-squircle px-2 ${PRESS}`}
                classList={{ "bg-accent": index() === props.menu.selected() }}
              >
                <Text class={`shrink-0 font-mono ${uiType("sm")} text-foreground`}>{row().title}</Text>
                <If when={Boolean(row().hint)}>
                  <Text class={`shrink-0 font-mono ${uiType("sm")} text-subtle`}>{row().hint ?? ""}</Text>
                </If>
                <Text class={`min-w-0 flex-1 truncate ${uiType("sm")} text-muted-foreground`}>{row().description ?? ""}</Text>
                <Text class={`shrink-0 ${uiType("xs")} text-subtle`}>{row().tag ?? ""}</Text>
              </View>
            )}
          </Each>
        </Scroll>
      </View>
      </Overlay>
        )}
      </If>
    </If>
  );
}

interface DocMentionRow {
  path: string;
  title: string;
  open: boolean;
}

/**
 * `@` document mention state in the composer: pulls an open or saved Markdown
 * document straight into the active session's attachment tray without leaving
 * the conversation. Closes automatically when nothing matches so typing
 * decorators or scoped package names (`@scope/pkg`) never traps Enter or Tab.
 */
function useDocMention(
  s: ComposerStore,
  caretPos: () => number,
  slashOpen: () => boolean,
  onPick: (row: DocMentionRow, mention: DocMentionInput) => void,
) {
  const selected = signal(0);
  const keyed = signal(0, { equals: false });
  const dismissedStart = signal<number | undefined>(undefined);
  const input = computed(() => (s.isFocused() && !slashOpen() ? readDocMention(s.draft(), caretPos()) : undefined));
  const rows = computed<DocMentionRow[]>(() => {
    const asked = input();
    if (!asked || asked.start === dismissedStart()) return [];
    return matchDocMentions(mentionableDocs(), asked.query);
  });
  const open = () => rows().length > 0;
  const current = () => rows()[Math.min(selected(), rows().length - 1)] as DocMentionRow | undefined;

  effect(() => {
    rows();
    selected.set(0);
  });
  effect(() => {
    if (input()?.start !== dismissedStart()) dismissedStart.set(undefined);
  });
  effect(() => {
    if (!open()) return;
    cleanup(keymap.bind("escape", () => dismissedStart.set(untracked(input)?.start), { when: "always" }));
    const move = (by: number) => {
      selected.update((at) => (Math.min(at, rows().length - 1) + by + rows().length) % rows().length);
      keyed.set(0);
    };
    cleanup(keymap.bind({ up: () => move(-1), down: () => move(1) }, { when: "always", repeat: true }));
    cleanup(
      keymap.bind(
        "tab",
        () => {
          const row = current();
          const mention = untracked(input);
          if (row && mention) onPick(row, mention);
        },
        { when: "always" },
      ),
    );
  });
  const dismiss = () => {
    const start = untracked(input)?.start;
    if (start !== undefined) dismissedStart.set(start);
  };
  return { input, rows, selected, keyed, open, current, dismiss };
}

/** The `@` document mention popup anchored above the composer column, matching `SlashMenu`. */
function DocMentionMenu(props: {
  menu: ReturnType<typeof useDocMention>;
  onChoose: (row: DocMentionRow) => void;
  anchor?: ViewRef;
  width: number;
}) {
  const mounted = signal(false);
  const opacity = createAnimatedValue(0);
  const translateY = createAnimatedValue(6);
  const scale = createAnimatedValue(0.97);
  const shown = keepLast(() => {
    const list = props.menu.rows();
    return list.length > 0 ? list : undefined;
  }, [] as DocMentionRow[]);
  const rowViews = new Map<string, ViewRef>();
  let list: ScrollRef | undefined;
  let exitTimer: ReturnType<typeof setTimeout> | undefined;

  effect(() => {
    props.menu.keyed();
    const row = untracked(props.menu.current);
    if (row) rowViews.get(row.path)?.reveal({ vertical: "nearest", animated: false });
  });
  let showing = false;
  effect(() => {
    const now = props.menu.rows().length > 0;
    if (now && showing) list?.scrollTo({ y: 0, animated: false });
    showing = now;
  });

  effect(() => {
    const open = props.menu.open();
    const reduced = reduceMotion();
    untracked(() => {
      clearTimeout(exitTimer);
      void opacity.stop();
      void translateY.stop();
      void scale.stop();
      if (open) {
        mounted.set(true);
        if (reduced) {
          opacity.set(1);
          translateY.set(0);
          scale.set(1);
        } else {
          opacity.set(0);
          translateY.set(6);
          scale.set(0.97);
          void opacity.timing(1, { duration: 160, easing: EASING.entrance });
          void translateY.spring(0, SPRING.snappy);
          void scale.spring(1, SPRING.snappy);
        }
      } else if (mounted()) {
        if (reduced) {
          opacity.set(0);
          mounted.set(false);
        } else {
          void opacity.timing(0, { duration: 130, easing: EASING.exit });
          void translateY.timing(4, { duration: 130, easing: EASING.exit });
          void scale.timing(0.98, { duration: 130, easing: EASING.exit });
          exitTimer = setTimeout(() => mounted.set(false), 135);
        }
      }
    });
  });

  cleanup(() => {
    clearTimeout(exitTimer);
    void opacity.stop();
    void translateY.stop();
    void scale.stop();
  });

  return (
    <If when={mounted()}>
      <If when={props.anchor}>
        {(anchor) => (
          <Overlay
            anchor={anchor()}
            placement="top"
            align="start"
            offset={8}
            margin={12}
            onPressOutside={props.menu.open() ? () => props.menu.dismiss() : undefined}
          >
            <View
              testID="composer-doc-menu"
              class={`overflow-hidden ${POPUP}${props.menu.open() ? "" : " pointer-events-none"}`}
              style={{ ...GLASS_REGULAR, width: props.width, opacity, transform: [{ translateY }, { scale }] }}
              role="menu"
              accessibilityLabel={tr("Documents", "文档")}
            >
              <Scroll ref={list} class="max-h-60" contentClass="p-1">
                <Each of={shown() ?? []} key={(row) => row.path}>
                  {(row, index) => (
                    <View
                      ref={(view: ViewRef) => rowViews.set(row().path, view)}
                      role="menuitem"
                      focusable={false}
                      onPress={() => props.onChoose(row())}
                      onMouseMove={() => {
                        if (props.menu.selected() !== index()) props.menu.selected.set(index());
                      }}
                      class={`${uiHeight(32)} flex-row items-center gap-2 rounded-md corner-squircle px-2 ${PRESS}`}
                      classList={{ "bg-accent": index() === props.menu.selected() }}
                    >
                      <Icon name="file" size={14} tone="muted-foreground" class="shrink-0" />
                      <Text class={`min-w-0 flex-1 truncate ${uiType("sm")} font-medium text-foreground`}>{row().title}</Text>
                      <If when={row().open}>
                        <Text class={`shrink-0 ${uiType("xs")} text-subtle`}>{tr("Open", "已打开")}</Text>
                      </If>
                    </View>
                  )}
                </Each>
              </Scroll>
            </View>
          </Overlay>
        )}
      </If>
    </If>
  );
}

/** Quiet toolbar button for mouse users to attach an existing document to this session. */
/**
 * A document riding on the message: a card naming it, and whether all of it
 * goes or a passage. A press goes back to the document — the words are still
 * written there, not here.
 */
function DocCard(props: { doc: DocRef; onRemove: (path: string) => void }) {
  const title = () => docAt(props.doc.path)?.title() ?? props.doc.title;
  return (
    <View testID="composer-doc" class={`group relative ${uiHeight(56)} w-52 shrink-0`} style={enter("zoomIn")}>
      <BaseButton
        onPress={() => openDocTab(props.doc.path, { newTab: true })}
        accessibilityLabel={title()}
        tooltip={tip(tr("Back to the document", "回到文档"))}
        class={`size-full flex-row items-center gap-2.5 rounded-lg corner-squircle border-[0.5px] border-hairline-hover bg-background/70 pl-2 pr-3 ${PRESS} ${PRESS_SCALE} ${FOCUS_RING} hover:border-hairline-focus hover:bg-accent`}
      >
        <View class={`size-9 shrink-0 items-center justify-center rounded-md corner-squircle ${props.doc.excerpt ? "bg-brand-soft" : "bg-muted"}`}>
          <Icon name="file" size={16} tone={props.doc.excerpt ? "brand-text" : "muted-foreground"} />
        </View>
        <View class="min-w-0 flex-1">
          <Text class={`truncate ${uiType("sm")} font-medium text-foreground`}>{title()}</Text>
          <Text class={`truncate ${uiType("xs")} text-subtle`}>{props.doc.excerpt ? tr("Selection", "选中的内容") : tr("Document", "文档")}</Text>
        </View>
      </BaseButton>
      <BaseButton
        onPress={() => props.onRemove(props.doc.path)}
        accessibilityLabel={tr("Remove document", "移除文档")}
        tooltip={tip(tr("Remove document", "移除文档"))}
        class={`absolute right-1 top-1 size-5 items-center justify-center rounded-full border-[0.5px] border-hairline-hover bg-popover shadow-sm ${PRESS} ${FOCUS_RING} hover:bg-secondary ${HOVER_REVEAL}`}
      >
        <Icon name="x" size={12} tone="foreground" />
      </BaseButton>
    </View>
  );
}

function fileCardIcon(kind: FileAttachment["kind"]): IconName {
  if (kind === "video") return "video";
  if (kind === "audio") return "audio";
  if (kind === "image") return "image";
  if (kind === "archive") return "archive";
  return "file";
}

function pastedImageItem(image: Attachment, index: number) {
  return {
    id: `paste:${index}:${image.name}`,
    kind: "image" as const,
    title: image.name,
    src: `data:${image.mimeType};base64,${image.data}`,
    mimeType: image.mimeType,
    data: image.data,
  };
}

function composerImageGallery(store: ComposerStore) {
  const fromFiles = store
    .files()
    .filter((f) => f.kind === "image")
    .map((f) => ({
      id: `att:${f.path}`,
      kind: "image" as const,
      title: f.name,
      path: f.path,
      src: f.path,
      mimeType: f.mimeType,
      size: f.size,
    }));
  const fromPasted = store.attachments().map((img, idx) => pastedImageItem(img, idx));
  return [...fromFiles, ...fromPasted];
}

function FileCard(props: { file: FileAttachment; onRemove: (path: string) => void; gallery: () => ReturnType<typeof composerImageGallery> }) {
  const meta = () => [extensionLabel(props.file.path, props.file.mimeType), formatBytes(props.file.size)].filter(Boolean).join(" · ");
  const preview = () => {
    if (props.file.kind === "image" || props.file.kind === "video") {
      openMediaZoom(
        {
          id: `att:${props.file.path}`,
          kind: props.file.kind,
          title: props.file.name,
          path: props.file.path,
          src: props.file.path,
          mimeType: props.file.mimeType,
          size: props.file.size,
        },
        props.file.kind === "image" ? { gallery: props.gallery() } : undefined,
      );
    } else {
      void openLocalFile(props.file.path);
    }
  };
  return (
    <View testID="composer-file" class={`group relative ${uiHeight(56)} w-52 shrink-0`} style={enter("zoomIn")}>
      <BaseButton
        onPress={preview}
        accessibilityLabel={props.file.name}
        tooltip={tip(props.file.path)}
        class={`size-full flex-row items-center gap-2.5 rounded-lg corner-squircle border-[0.5px] border-hairline-hover bg-background/70 pl-2 pr-3 ${PRESS} ${PRESS_SCALE} ${FOCUS_RING} hover:border-hairline-focus hover:bg-accent`}
      >
        <View class="size-9 shrink-0 items-center justify-center rounded-md corner-squircle bg-muted">
          <Icon name={fileCardIcon(props.file.kind)} size={16} tone="muted-foreground" />
        </View>
        <View class="min-w-0 flex-1">
          <Text class={`truncate ${uiType("sm")} font-medium text-foreground`}>{props.file.name}</Text>
          <Text class={`truncate ${uiType("xs")} text-subtle`}>{meta()}</Text>
        </View>
      </BaseButton>
      <BaseButton
        onPress={() => props.onRemove(props.file.path)}
        accessibilityLabel={tr("Remove file", "移除文件")}
        tooltip={tip(tr("Remove file", "移除文件"))}
        class={`absolute right-1 top-1 size-5 items-center justify-center rounded-full border-[0.5px] border-hairline-hover bg-popover shadow-sm ${PRESS} ${FOCUS_RING} hover:bg-secondary ${HOVER_REVEAL}`}
      >
        <Icon name="x" size={12} tone="foreground" />
      </BaseButton>
    </View>
  );
}

/**
 * What rides on the message waits in a tray that rises from behind the
 * composer's top edge: a little narrower than the composer, its lower edge
 * tucked under it, so adding to it never changes the input's own size.
 * Documents come first, then attached files, then pasted images — each one's
 * remove button shows on hover or focus.
 */
function AttachmentTray(props: { store: ComposerStore }) {
  const s = props.store;
  const held = () => s.attachments().length > 0 || s.docs().length > 0 || s.files().length > 0;
  const shown = keepLast(() => (held() ? { docs: s.docs(), files: s.files(), images: s.attachments() } : undefined), {
    docs: s.docs(),
    files: s.files(),
    images: s.attachments(),
  });
  return (
    <Reveal open={held()} offset={6}>
      <View
        class="relative mx-4 -mb-2 overflow-hidden rounded-t-2xl corner-squircle border-[0.5px] border-b-0 border-hairline bg-card/85 pb-2 dark:bg-card/75"
        accessibilityLabel={tr("Attachments", "附件")}
      >
        <Scroll horizontal contentClass="flex-row gap-2 p-2">
          <Each of={shown()?.docs ?? []} key={(doc) => doc.path}>
            {(doc) => <DocCard doc={doc()} onRemove={s.detachDoc} />}
          </Each>
          <Each of={shown()?.files ?? []} key={(file) => file.path}>
            {(file) => <FileCard file={file()} onRemove={s.removeFileAttachment} gallery={() => composerImageGallery(s)} />}
          </Each>
          <Each of={shown()?.images ?? []} key="index">
            {(image, index) => (
              <View class="group relative size-14 shrink-0 overflow-hidden rounded-lg corner-squircle bg-muted" style={enter("zoomIn")}>
                <BaseButton
                  testID="composer-image"
                  onPress={() => openMediaZoom(pastedImageItem(image(), index()), { gallery: composerImageGallery(s) })}
                  accessibilityLabel={image().name}
                  tooltip={tip(image().name)}
                  class={`size-full rounded-lg corner-squircle ${PRESS} ${PRESS_SCALE} ${FOCUS_RING}`}
                >
                  <Image
                    src={`data:${image().mimeType};base64,${image().data}`}
                    class="size-full"
                    style={{ objectFit: "cover" }}
                    accessibilityElementsHidden
                  />
                </BaseButton>
                {/* The edge is drawn over the pixels, so a white screenshot still has one. */}
                <View class="pointer-events-none absolute inset-0 rounded-lg corner-squircle border-[0.5px] border-hairline-hover" />
                <BaseButton
                  onPress={() => s.removeAttachment(index())}
                  accessibilityLabel={tr("Remove image", "移除图片")}
                  tooltip={tip(tr("Remove image", "移除图片"))}
                  class={`absolute right-1 top-1 size-5 items-center justify-center rounded-full border-[0.5px] border-hairline-hover bg-popover shadow-sm ${PRESS} ${FOCUS_RING} hover:bg-secondary ${HOVER_REVEAL}`}
                >
                  <Icon name="x" size={12} tone="foreground" />
                </BaseButton>
              </View>
            )}
          </Each>
        </Scroll>
      </View>
    </Reveal>
  );
}

/** Lines an extension shows beside the editor (`setWidget`), and its statuses (`setStatus`). */
function ExtensionLines(props: { store: ComposerStore; below: boolean }) {
  const lines = computed(() =>
    Object.values(props.store.extensionWidgets?.() ?? {})
      .filter((widget) => widget.below === props.below)
      .flatMap((widget) => widget.lines),
  );
  const shown = keepLast(() => {
    const list = lines();
    return list.length > 0 ? list : undefined;
  }, [] as string[]);
  return (
    <Reveal open={lines().length > 0}>
      <View class="px-3 py-1">
        <Each of={shown() ?? []} key="index">
          {(line) => <Text class={`font-mono ${uiType("xs")} text-muted-foreground`}>{line()}</Text>}
        </Each>
      </View>
    </Reveal>
  );
}

/** How full the model's context window is: a ring and a percentage. An engine
 * that reports no window still gets its used count in the tooltip, with the
 * ring left unfilled rather than a made-up share. */
function ContextMeter(props: { store: ComposerStore }) {
  const info = () => props.store.contextUsage?.() ?? { stats: undefined, hasRows: false };
  const usage = () => info().stats?.contextUsage;
  const percent = () => usage()?.percent ?? null;
  const visible = () => {
    const context = usage();
    if (!context || !info().hasRows) return false;
    const share = percent();
    return share === null ? (context.tokens ?? 0) > 0 : share >= 50;
  };
  const detail = () => {
    const stats = info().stats;
    const context = usage();
    if (!stats || !context) return tr("Context", "上下文");
    const used = context.tokens === null ? "—" : compactNumber(context.tokens);
    const tokens =
      context.contextWindow === null
        ? tr(`${used} tokens in context`, `上下文已用 ${used} tokens`)
        : tr(
            `${used} of ${compactNumber(context.contextWindow)} tokens in context`,
            `上下文已用 ${used} / ${compactNumber(context.contextWindow)} tokens`,
          );
    // An engine that names no cost gets none: the tokens it did report, instead.
    if (stats.costReported === false) {
      const spent = compactNumber(stats.tokens.total);
      return `${tokens} · ${tr(`${spent} tokens this session`, `本会话 ${spent} tokens`)}`;
    }
    return `${tokens} · ${tr(`${money(stats.cost)} this session`, `本会话 ${money(stats.cost)}`)}`;
  };
  return (
    <Presence show={visible()} scaleFrom={0.85}>
      <View class="h-6 flex-row items-center gap-1.5 rounded-md corner-squircle px-1.5" tooltip={tip(detail())} accessibilityLabel={detail()}>
        <Canvas
          style={{ width: 14, height: 14 }}
          draw={(cx, { width }) => {
            const middle = width / 2;
            const share = Math.min(1, (percent() ?? 0) / 100);
            cx.lineWidth = 2;
            cx.lineCap = "round";
            cx.strokeStyle = token("input");
            cx.beginPath();
            cx.arc(middle, middle, middle - 1.5, 0, Math.PI * 2);
            cx.stroke();
            if (share > 0) {
              cx.strokeStyle = token(share > 0.85 ? "warning" : "muted-foreground");
              cx.beginPath();
              cx.arc(middle, middle, middle - 1.5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * share);
              cx.stroke();
            }
          }}
        />
      </View>
    </Presence>
  );
}

/**
 * What a send press does while a run is on, picked from the send button's
 * chevron menu. The choice is remembered (a preference), and holds for the
 * button and Enter alike until changed again:
 * - `steer`: the default — the message goes into the run at its next step.
 * - `queue`: the message waits for the run to finish, as ⌘↵ sends it.
 */
const sendModeText = (mode: SendMode): { icon: IconName; label: string; hint: string } => {
  if (mode === "queue") {
    return { icon: "queue", label: tr("Queue", "排队发送"), hint: tr("⌘↵ — send after the run finishes", "⌘↵ — 本轮结束后再发送") };
  }
  return { icon: "steer", label: tr("Interrupt & send", "打断发送"), hint: tr("Sent at the run's next step", "在本轮的下一步发送") };
};

/** Where the user writes to the active agent: shared across the primary chat and every split pane. */
export function Composer(props?: { store?: ComposerStore }) {
  const s = props?.store ?? primaryComposerStore;
  let input: InputRef | undefined;
  let selection = { start: 0, end: 0 };
  const caretPos = signal(0);
  let trackedDraft = untracked(s.draft);
  const height = signal(MIN_HEIGHT);
  /** An input method's marked text shows in the field while `draft` is still empty; the hint stays away for it. */
  const composing = signal(false);
  /** Confirming a menu row fills it into the draft with the caret at the end so arguments or a second Enter can follow. */
  const completeSlash = (row: SlashRow) => {
    const next = row.completion;
    composing.set(false);
    trackedDraft = next;
    selection = { start: next.length, end: next.length };
    caretPos.set(next.length);
    s.setDraft(next);
    input?.setSelection(next.length, next.length);
    s.requestFocus();
  };
  const slash = useSlashMenu(s, completeSlash);
  const applyDocMention = (row: DocMentionRow, mention: DocMentionInput) => {
    const next = removeDocMention(s.draft(), mention);
    trackedDraft = next.text;
    selection = { start: next.caret, end: next.caret };
    caretPos.set(next.caret);
    s.setDraft(next.text);
    input?.setSelection(next.caret, next.caret);
    void s.attachDocPath(row.path);
    s.requestFocus();
  };
  const docMention = useDocMention(s, caretPos, slash.open, applyDocMention);
  const dismissMenus = () => {
    slash.dismiss();
    docMention.dismiss();
  };
  /** The composer's column, which the slash menu stands on and whose width it takes. */
  const column = signal<ViewRef | undefined>(undefined);
  const columnWidth = signal(0);
  const ready = () => s.ready();
  const canSend = () => s.canSend();
  const working = () => s.working();
  const hasText = () => s.draft().trim().length > 0 || s.attachments().length > 0 || s.docs().length > 0 || s.files().length > 0;
  const showPlaceholder = computed(() => s.draft().length === 0 && !composing());
  const statusLine = () => Object.values(s.extensionStatuses?.() ?? {}).join("  ·  ");
  const shownStatus = keepLast(() => statusLine() || undefined, "");
  const showStop = () => working() && !hasText();
  const actionScale = createAnimatedValue(1);
  const actionOpacity = createAnimatedValue(1);
  let lastShowStop = untracked(showStop);

  effect(() => {
    const stopNow = showStop();
    if (stopNow === lastShowStop) return;
    lastShowStop = stopNow;
    untracked(() => {
      void actionScale.stop();
      void actionOpacity.stop();
      if (reduceMotion()) {
        actionScale.set(1);
        actionOpacity.set(1);
        return;
      }
      actionScale.set(0.84);
      actionOpacity.set(0.55);
      void actionScale.spring(1, SPRING.snappy);
      void actionOpacity.timing(1, { duration: 140, easing: EASING.entrance });
    });
  });
  cleanup(() => {
    void actionScale.stop();
    void actionOpacity.stop();
  });

  effect(() => {
    const draft = s.draft();
    if (draft !== trackedDraft) {
      trackedDraft = draft;
      selection = { start: draft.length, end: draft.length };
      caretPos.set(draft.length);
      if (!draft) height.set(MIN_HEIGHT);
    }
  });

  /** When the user temporarily steps out of a question card to queue a chat message. */
  const composeDuringForm = signal<string | undefined>(undefined);
  const formDialog = () => {
    const dialog = s.pendingDialog();
    return dialog?.method === "form" && s.isActive() ? dialog : undefined;
  };
  const showFormTakeover = () => Boolean(formDialog()) && composeDuringForm() !== formDialog()?.id;
  const showFormResume = () => Boolean(formDialog()) && composeDuringForm() === formDialog()?.id;

  effect(() => {
    const id = formDialog()?.id;
    if (!id && untracked(composeDuringForm)) composeDuringForm.set(undefined);
  });

  effect(() => {
    s.focusTick();
    // The keyboard is the composer's only while this surface is active & focused
    // and no question card currently owns the surface.
    if (s.isActive() && s.isFocused() && !showFormTakeover()) input?.focus();
    else if (!s.isActive()) input?.blur();
  });

  // Escape while temporarily drafting a queued message returns to the waiting question card.
  effect(() => {
    if (!showFormResume() || !s.isFocused()) return;
    cleanup(keymap.bind("escape", () => composeDuringForm.set(undefined), { when: "always" }));
  });

  const sendMenuOpen = signal(false);
  /** When a press closed the menu as an outside press, so the button it landed on doesn't reopen it on release. */
  let sendMenuClosedAt = 0;
  const questionOpen = () => s.pendingDialog()?.method === "form";
  const wireMode = () => (questionOpen() || sendMode() === "queue" ? ("followUp" as const) : ("steer" as const));
  /** A send press: an explicit mode wins; otherwise the menu's choice decides. */
  const fireSend = (mode?: "steer" | "followUp") => void s.send(mode ?? wireMode());
  const chooseDocMention = (row: DocMentionRow) => {
    const mention = docMention.input();
    if (mention) applyDocMention(row, mention);
    else void s.attachDocPath(row.path);
  };
  const submit = (mode?: "steer" | "followUp") => {
    if (untracked(composing)) return;
    const row = slash.current();
    if (row) return completeSlash(row);
    const mentioned = docMention.current();
    if (mentioned) return chooseDocMention(mentioned);
    fireSend(mode);
  };
  cleanup(
    keymap.bind(
      "mod+enter",
      () => {
        if (s.isActive() && s.isFocused()) submit("followUp");
      },
      { when: "always" },
    ),
  );

  /** A menu choice is the send button's new behavior — and fires it at once when a draft waits. */
  const pickSendMode = (mode: SendMode) => {
    sendMenuOpen.set(false);
    setSendMode(mode);
    s.requestFocus();
    if (canSend() && hasText()) submit();
  };

  const sendLabel = () =>
    wireMode() === "followUp"
      ? tr("Queue", "排队发送")
      : s.running()
        ? tr("Interrupt & send", "打断发送")
        : tr("Send", "发送");
  const sendTipText = () =>
    wireMode() === "followUp"
      ? tr("Queue — sends after the run finishes", "排队发送 — 本轮结束后发送")
      : s.running()
        ? tr("Interrupt & send — sent at the run's next step", "打断发送 — 在本轮的下一步发送")
        : tr("Send — ⌘↵ queues a follow-up", "发送 — ⌘↵ 排队追问");

  const paste = ({ text, files = [], uris = [] }: PasteEvent) => {
    const pending = (async () => {
      const vision = s.visionSupported();
      let rejected = false;
      let oversized = false;
      let attached = 0;
      const references: string[] = [];
      /** Image files the paste named but whose bytes we could not use. */
      const unreadImages: string[] = [];
      let unusableImage = false;
      const attach = (name: string, declared: string, bytes: Uint8Array, path?: string) => {
        const mimeType = sniffImageType(bytes) ?? (IMAGE_TYPES.has(declared) ? (declared === "image/jpg" ? "image/jpeg" : declared) : undefined);
        if (!mimeType || !vision || bytes.length > MAX_IMAGE_BYTES) {
          if (mimeType) (!vision ? (rejected = true) : (oversized = true));
          else if (declared.startsWith("image/") || !!IMAGE_EXTENSIONS[name.split(".").pop()?.toLowerCase() ?? ""]) unusableImage = true;
          if (path) references.push(path);
          return;
        }
        s.addAttachment({ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType, name });
        attached++;
      };
      for (const file of files) {
        try {
          attach(file.name || tr("Pasted image", "粘贴的图片"), file.type, new Uint8Array(await file.arrayBuffer()));
        } catch {} // A file that won't read shouldn't sink the rest of the paste.
      }
      const paths = uris.map(fileUriPath).filter((path): path is string => !!path);
      for (const path of paths) {
        const name = path.split("/").pop() ?? path;
        const ext = name.split(".").pop()?.toLowerCase() ?? "";
        const declared = IMAGE_EXTENSIONS[ext] ?? "";
        if (!declared && isRichPasteFile(path)) {
          const ok = await s.attachLocalPath(path);
          if (ok) {
            attached++;
            continue;
          }
        }
        try {
          const bytes = await readFile(path);
          const mimeType = sniffImageType(bytes) ?? (IMAGE_TYPES.has(declared) ? (declared === "image/jpg" ? "image/jpeg" : declared) : undefined);
          if (mimeType && (!vision || bytes.length > MAX_IMAGE_BYTES)) {
            if (await s.attachLocalPath(path)) {
              attached++;
              continue;
            }
          }
          attach(name, declared, bytes, path);
        } catch {
          // A folder, a file gone between copy and paste, or one we may not read.
          if (isRichPasteFile(path)) {
            const ok = await s.attachLocalPath(path);
            if (ok) {
              attached++;
              continue;
            }
          }
          (declared ? unreadImages : references).push(path);
        }
      }
      if (!attached && vision && (unusableImage || unreadImages.length)) {
        try {
          const image = await Clipboard.readImage();
          if (image) {
            const bytes = new Uint8Array(await (await fetch(image.url)).arrayBuffer());
            const name = unreadImages[0]?.split("/").pop() ?? tr("Pasted image", "粘贴的图片");
            attach(name, "", bytes);
          }
        } catch {} // Falls back to the path below.
      }
      if (!attached) references.push(...unreadImages);
      if (rejected) toast("warning", tr("This model does not take images.", "当前模型不支持图片输入。"));
      if (oversized) toast("warning", tr("Images over 20 MB can't be attached.", "超过 20 MB 的图片无法作为附件。"));
      // Copying a file makes the paste's text its own path or `file:` URL:
      // drop the text when it is only that echo, keep it verbatim otherwise.
      const echo = new Set([...uris, ...paths, ...paths.map((path) => path.split("/").pop() ?? "")]);
      const isFileEcho = !!text.trim() && text.split(/\s+/).every((word) => echo.has(word));
      const insertion = [...references, ...(isFileEcho || !text.trim() ? [] : [text])].join(" ");
      if (insertion) {
        const current = s.draft();
        const start = Math.max(0, Math.min(selection.start, current.length));
        const end = Math.max(start, Math.min(selection.end, current.length));
        const next = `${current.slice(0, start)}${insertion}${current.slice(end)}`;
        const caret = start + insertion.length;
        trackedDraft = next;
        selection = { start: caret, end: caret };
        s.setDraft(next);
        input?.setSelection(caret, caret);
      }
    })();
    s.trackAttachmentRead?.(pending);
  };

  const placeholder = () => {
    const name = s.agentName();
    // While the agent starts (a session switch), the field keeps its usual words rather than passing through others.
    if (s.failed()) return tr(`${name} is not running`, `${name} 未运行`);
    if (ready() && !s.hasModel()) return tr("Connect a model provider to start", "连接模型服务商以开始使用");
    // A document rides on the message: words are what to do with it, and none sends it as it is.
    if (s.docs().length) return tr("Say what to do with it, or just send", "说说要怎么处理，或直接发送");
    if (questionOpen()) return tr("Queue a follow-up…", "排队发送后续消息…");
    const persona = s.personaName?.();
    if (persona) return tr(`Message ${persona}…`, `给 ${persona} 发消息…`);
    if (s.running()) return tr(`Steer ${name}…`, `引导 ${name}…`);
    return tr(`Ask ${name}…`, `问问 ${name}…`);
  };

  return (
    <View class="px-6 pb-5 pt-3">
      <View
        ref={(node) => {
          if (node) column.set(node);
        }}
        onLayout={(e) => columnWidth.set(e.bounds.size.width)}
        class="pointer-events-auto relative w-full max-w-180 self-center"
      >
        {s.renderExtensionPrompt ? s.renderExtensionPrompt() : <ExtensionPrompt />}
        <Reveal open={showFormResume()} offset={6}>
          <If when={formDialog()}>
            {(dialog) => (
              <View class="mx-4 -mb-2 flex-row items-center justify-between gap-2 overflow-hidden rounded-t-2xl corner-squircle border-[0.5px] border-b-0 border-hairline bg-card/85 px-3.5 py-2 dark:bg-card/75">
                <View class="min-w-0 flex-1 flex-row items-center gap-2">
                  <Icon name="message" size={14} tone="brand-text" />
                  <Text class={`truncate ${uiType("sm")} text-muted-foreground`}>
                    {dialog().fields.length > 1
                      ? tr(`${dialog().agent} is waiting on ${dialog().fields.length} questions`, `${dialog().agent} 正在等待回答 ${dialog().fields.length} 个问题`)
                      : tr(`${dialog().agent} is waiting for your answer`, `${dialog().agent} 正在等待你的回答`)}
                  </Text>
                </View>
                <BaseButton
                  testID="question-resume"
                  onPress={() => composeDuringForm.set(undefined)}
                  class={`${uiHeight(24)} shrink-0 flex-row items-center gap-1 rounded-md corner-squircle bg-brand-soft px-2 ${uiType("xs")} font-medium text-brand-text ${PRESS} ${FOCUS_RING} hover:bg-brand/15`}
                >
                  <Text>{tr("Answer", "返回回答")}</Text>
                </BaseButton>
              </View>
            )}
          </If>
        </Reveal>
        <SlashMenu menu={slash} agentName={s.agentName} onChoose={completeSlash} anchor={column()} width={columnWidth()} />
        <DocMentionMenu menu={docMention} onChoose={chooseDocMention} anchor={column()} width={columnWidth()} />
        <If when={!showFormTakeover()}>
          <AttachmentTray store={s} />
        </If>
        <View class={`relative rounded-[22px] corner-squircle ${COMPOSER_SURFACE}`} style={GLASS_REGULAR}>
          <If
            when={showFormTakeover() ? formDialog() : undefined}
            else={
              <View>
                <ExtensionLines store={s} below={false} />
                <Input
                  testID={s.inputTestID}
                  ref={input}
                  multiline
                  autoFocus={s.autoFocus ?? true}
                  scrollbar={false}
                  value={s.draft()}
                  onFocus={() => s.onFocusPane?.()}
                  onChange={({ value }) => {
                    const before = trackedDraft.length;
                    const start = Math.max(0, Math.min(selection.start, before));
                    const end = Math.max(start, Math.min(selection.end, before));
                    const inserted = value.length - before + (end - start);
                    const caret = Math.max(0, Math.min(value.length, start + inserted));
                    trackedDraft = value;
                    selection = { start: caret, end: caret };
                    caretPos.set(caret);
                    s.setDraft(value);
                  }}
                  onSelectionChange={({ start, end }) => {
                    selection = { start, end };
                    caretPos.set(end);
                  }}
                  onSubmit={() => submit()}
                  onBlur={() => composing.set(false)}
                  onCompositionChange={({ composing: now }) => composing.set(now)}
                  onPaste={paste}
                  pasteBehavior="report"
                  onContentSizeChange={({ size }) => height.set(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(size.height))))}
                  submitBehavior="submit"
                  autoCapitalize="none"
                  autoCorrect={false}
                  disabled={s.failed()}
                  accessibilityLabel={s.inputLabel ?? tr("Message", "消息")}
                  class={`ml-4 mr-9 mt-4 ${readingType()} text-foreground caret-brand`}
                  style={{ height: Math.max(height(), Math.ceil(MIN_HEIGHT * readingSize() / FONT_SIZES.reading.default)) }}
                />
                {/* A draft past its second line is offered room: it goes on as a document, where Return is
                    a new line and every word is kept. The field's right margin is the button's seat always,
                    so its arrival never re-wraps what is written. */}
                <If when={Boolean(s.draftToDoc)}>
                  <Presence show={height() >= Math.round(LONG_DRAFT_HEIGHT * readingSize() / FONT_SIZES.reading.default)} scaleFrom={0.85} class="absolute right-2 top-2.5">
                    <IconButton
                      testID="composer-to-doc"
                      icon="expand"
                      size="sm"
                      tone="subtle"
                      label={tr("Continue in a document", "在文档中继续写")}
                      shortcut="mod+e"
                      tipPlacement="top"
                      onPress={() => void s.draftToDoc?.()}
                    />
                  </Presence>
                </If>
                {/* The hint is app-drawn, not the host's placeholder: host text re-rasterizes at
                    integer offsets under the dock's transform and visibly steps a frame late. */}
                <If when={showPlaceholder()}>
                  <View class="pointer-events-none absolute left-4 right-9 top-4">
                    <Text class={`truncate ${readingType()} text-subtle`}>{placeholder()}</Text>
                  </View>
                </If>
                <ExtensionLines store={s} below />
                <View class="flex-row items-end justify-between gap-2 pb-2 pl-2.5 pr-2 pt-2">
                  <View class="min-w-0 flex-1 flex-row items-center gap-1 overflow-hidden">
                    {s.renderLeftPickers ? (
                      s.renderLeftPickers(dismissMenus)
                    ) : (
                      <>
                        <AgentPicker onOpen={dismissMenus} />
                        <View class="mx-0.5 h-3 w-[0.5px] bg-hairline-hover" />
                        <ModelPicker onOpen={dismissMenus} />
                        <ModelConfigPickers onOpen={dismissMenus} />
                        <ThinkingPicker onOpen={dismissMenus} />
                      </>
                    )}
                  </View>
                  <View class="shrink-0 flex-row items-center gap-1.5">
                    <If when={ready()}>
                      <ContextMeter store={s} />
                    </If>
                    <IconButton
                      icon="paperclip"
                      size="sm"
                      tone="subtle"
                      label={tr("Attach file", "添加文件")}
                      tipPlacement="top"
                      onPress={() => void s.pickFile()}
                    />
                    {s.renderPermissionPicker ? s.renderPermissionPicker(dismissMenus) : <PermissionPicker onOpen={dismissMenus} />}
                    <View style={{ opacity: actionOpacity, transform: [{ scale: actionScale }] }}>
                      <If
                        when={showStop()}
                        else={
                          <View class={`h-7 shrink-0 flex-row items-stretch rounded-full shadow-sm ${canSend() && hasText() ? "bg-primary" : "bg-muted shadow-none"}`}>
                            <BaseButton
                              testID={s.sendTestID}
                              onPress={() => {
                                sendMenuOpen.set(false);
                                submit();
                              }}
                              disabled={!canSend() || !hasText()}
                              accessibilityLabel={sendLabel()}
                              tooltip={tip(sendTipText(), "enter", "top")}
                              class={`w-8 items-center justify-center rounded-l-full ${PRESS} ${FOCUS_RING} hover:bg-primary/90 active:scale-92 motion-reduce:active:scale-100 disabled:hover:bg-transparent`}
                            >
                              <Icon name="arrowUp" tone={canSend() && hasText() ? "brand-foreground" : "subtle"} />
                            </BaseButton>
                            <View class={`my-1.5 w-px ${canSend() && hasText() ? "bg-brand-foreground/25" : "bg-foreground/10"}`} />
                            <BaseButton
                              onPress={() => {
                                if (Date.now() - sendMenuClosedAt < 400) {
                                  sendMenuClosedAt = 0;
                                  return;
                                }
                                // The menu is the send's: the slash or mention menu behind it would take the press's send.
                                dismissMenus();
                                sendMenuOpen.update((v) => !v);
                              }}
                              disabled={!canSend()}
                              accessibilityLabel={tr("Send options", "发送选项")}
                              tooltip={sendMenuOpen() ? undefined : tip(tr("Send options", "发送选项"), undefined, "top")}
                              class={`w-6 items-center justify-center rounded-r-full ${PRESS} ${FOCUS_RING} hover:bg-primary/90 active:scale-92 motion-reduce:active:scale-100 disabled:hover:bg-transparent`}
                            >
                              <Icon name="chevronDown" size={12} tone={canSend() && hasText() ? "brand-foreground" : "subtle"} />
                            </BaseButton>
                          </View>
                        }
                      >
                        <BaseButton
                          testID={s.stopTestID}
                          onPress={() => void s.stop()}
                          accessibilityLabel={tr("Stop", "停止")}
                          tooltip={tip(tr("Stop", "停止"), "escape", "top")}
                          class={`size-7 shrink-0 items-center justify-center rounded-full bg-foreground ${PRESS} ${FOCUS_RING} hover:bg-foreground/85 active:scale-92 motion-reduce:active:scale-100`}
                        >
                          <View class="size-[8.5px] rounded-[2px] bg-background" />
                        </BaseButton>
                      </If>
                    </View>
                  </View>
                </View>
              </View>
            }
          >
            {(dialog) => (
              <View class="px-4 pb-3 pt-3.5">
                <QuestionForm
                  request={dialog()}
                  onAnswer={s.answerDialog}
                  shortcuts={s.isFocused()}
                  footerLeft={
                    <BaseButton
                      testID="question-to-draft"
                      onPress={() => {
                        composeDuringForm.set(dialog().id);
                        queueMicrotask(() => input?.focus());
                      }}
                      class={`-ml-2 ${uiHeight(24)} flex-row items-center gap-1.5 rounded-md corner-squircle px-2 text-subtle ${PRESS} ${FOCUS_RING} hover:bg-accent hover:text-foreground`}
                    >
                      <Icon name="queue" size={12} tone="subtle" />
                      <Text class={`${uiType("xs")}`}>
                        {s.draft().trim() ? tr("Draft", "草稿") : tr("Queue message", "排队消息")}
                      </Text>
                      <If when={s.draft().trim()}>
                        <View class="size-1.5 rounded-full bg-brand" />
                      </If>
                    </BaseButton>
                  }
                />
              </View>
            )}
          </If>
        </View>
        {/* The send menu's anchor: an invisible column at the composer's right edge,
            so the menu stands on the box's top-right corner like the surfaces that
            rise from behind its top edge, rather than straddling it off the pill.
            It takes no presses — they reach the send controls below — so the chevron
            press that closes it as an outside press must not reopen it on release
            (`sendMenuClosedAt`). */}
        <Popover
          open={sendMenuOpen()}
          onOpenChange={(e) => {
            if (!e.open && e.reason === "pressOutside") sendMenuClosedAt = Date.now();
            sendMenuOpen.set(e.open);
          }}
          placement="top"
          align="end"
          offset={8}
          margin={12}
          class="pointer-events-none absolute bottom-0 right-0 top-0 w-10"
          popupClass={`w-64 p-1 ${POPUP}`}
          popupStyle={popupStyle("top", "end")}
          popupStartingStyle={popupHiddenStyle("top", "end")}
          popupEndingStyle={popupLeavingStyle("top", "end")}
          trigger={<View class="pointer-events-none absolute bottom-0 right-0 top-0 w-10" />}
        >
          <Text class={`px-2 pb-1 pt-1.5 ${uiType("xs")} font-medium text-subtle`} role="header">
            {tr("Send", "发送")}
          </Text>
          <Each of={SEND_MODES}>
            {(mode) => {
              const meta = () => sendModeText(mode());
              return (
                <BaseButton
                  selected={mode() === sendMode()}
                  onPress={() => pickSendMode(mode())}
                  class={`${uiMinHeight(36)} flex-row items-center gap-2 rounded-md corner-squircle px-2 py-1 ${PRESS} hover:bg-accent focus:bg-accent active:bg-accent`}
                >
                  <Icon name={meta().icon} size={15} tone={mode() === sendMode() ? "foreground" : "muted-foreground"} />
                  <View class="min-w-0 flex-1">
                    <Text class={`truncate ${uiType("base")} text-foreground`}>{meta().label}</Text>
                    <Text class={`truncate ${uiType("xs")} text-subtle`}>{meta().hint}</Text>
                  </View>
                  <View class="w-4 shrink-0 items-center">{mode() === sendMode() ? <Icon name="check" size={14} tone="brand-text" /> : null}</View>
                </BaseButton>
              );
            }}
          </Each>
        </Popover>
      </View>
      <Reveal open={Boolean(statusLine())}>
        <Text class={`w-full max-w-180 self-center truncate px-3 pt-2 text-center ${uiType("xs")} text-subtle`}>{shownStatus()}</Text>
      </Reveal>
    </View>
  );
}
