import { cleanup, createAnimatedValue, effect, Image, openUrl, reduceMotion, Scroll, signal, Text, untracked, View } from "nsh";
import type { JSX, ScrollEvent, ViewRef } from "nsh";
import { Collapsible, TextView } from "nsh/base";
import { Menu } from "nsh/desktop";
import { clip } from "../lib/format";
import { activeLanguage, tr } from "../lib/i18n";
import { type DocPart, replyExcerpt, splitDocMessage } from "../lib/doc-wire";
import { edgeFadeMask } from "../lib/scroll-mask";
import {
  extractMarkdownMediaPaths,
  extractPresentedMedia,
  extractToolResultMedia,
  resolveMediaTarget,
  splitFileMessage,
  type FileAttachment,
  type MediaItem,
} from "../lib/media";
import { hardBreakLines, roughUserLines, USER_FOLD_LINES, USER_PREFOLD_LINES } from "../lib/user-lines";
import { pipAnchor, userAnchor } from "../lib/pip-anchors";
import type { ImageContent } from "../pi/protocol";
import { type Row, type ToolRow, withoutPreamble, withoutImageNotes } from "../pi/transcript";
import {
  type ActivityRow,
  describeActiveStep,
  describeActivity,
  describeToolCall,
  describeToolsSummary,
  describeTurn,
  elapsedSeconds,
  classifyTool,
  type DiffStats,
  type DisplayRow,
  type DisplayUserRow,
  type PipRowSlot,
  thinkingLabel,
  type TurnHeaderRow,
} from "../pi/turns";
import { Pip } from "../mascot/Pip";
import {
  conversationKey,
  copyMessage,
  copyText,
  activePersonaId,
  currentDaemonSession,
  daemonSessionOfId,
  forkFrom,
  isPersonaSession,
  messageQueue,
  openDaemonSession,
  openLocalFile,
  pipMood,
  takeQueued,
  transcriptRows,
  workspacePath,
} from "../store/app";
import { backend } from "../store/backend";
import { docTabTitle, titleLine } from "../store/docs";
import { openDocIfThere } from "../store/tabs";
import { messageInteraction, openPipMessageMenu, pipReplyCoveredId } from "../store/pip-interactions";
import { IconButton } from "../ui/Button";
import { Icon, type IconName } from "../ui/Icon";
import { DURATION, EASING, isRowSeen, keepLast, Presence, useRowEntrance, useSmsBubbleEntrance } from "../ui/motion";
import { RollingText } from "../ui/RollingText";
import { FOCUS_RING, HOVER_REVEAL, PRESS, PRESS_SCALE } from "../ui/styles";
import { tip } from "../ui/Tip";
import { readingType, codeType, uiHeight, uiType } from "../ui/typography";
import { readingSize, FONT_SIZES } from "../store/prefs";
import { MediaGallery, MediaStreamContext, mediaZoomOptions, openMediaZoom } from "./Media";
import { PipMessageAdornments, PipMessageHoverActions, PipQuotePreview, pipMessageNode, registerPipMessageNode } from "./PipAdornments";
import { BubbleTail, PipAvatarBadge, PipBubbleView, PipFooterView, PipSessionsView } from "./PipPresence";
import { clearProseState, proseClasses, ProseBlock, proseVeilUntil, type PipBubbleRow, type ProseRow } from "./Prose";

/**
 * The rows of the chat. `List` recycles its cells, so every row reads its
 * reactive props inside effects/accessors and keeps expand/collapse state in
 * module-level maps keyed by stable row or fold ID.
 */

/**
 * What the reader folded and unfolded, by conversation and by row. A press is
 * the only thing that writes here, and what it wrote holds: through the run
 * going on and ending, the next message, a change of session and back.
 *
 * The conversation is the one the rows on screen belong to (`conversationKey`,
 * set in the same turn as the rows), never the agent's word on its session,
 * which lags a session change: no conversation is shown under another's folds,
 * and one shown again has its own with the click. Its rows are found again by
 * their ids, which a conversation keeps when it is loaded again (`Transcript.adopt`).
 */
const choices = signal<Record<number, Record<string, boolean>>>({});

/** What the reader said on a fold, if they pressed it. */
const chosen = (id: string): boolean | undefined => choices()[conversationKey()]?.[id];

function choose(id: string, open: boolean, also?: string) {
  const key = untracked(conversationKey);
  choices.update((all) => ({ ...all, [key]: { ...all[key], [id]: open, ...(also ? { [also]: open } : {}) } }));
}

/** Whether a disclosure shows its body: explicit user choice wins, else `fallback`. */
const isOpen = (id: string, fallback: boolean) => chosen(id) ?? fallback;
/**
 * What the chat does before a fold the reader pressed opens or closes: it lets
 * go of the end, so the list keeps its offset and the row pressed stays under
 * the pointer while what follows it moves (the folds). Following, the list
 * would keep its end in place and push the pressed row up instead.
 */
let anchorFold: () => void = () => {};
export function onFoldToggle(anchor: () => void) {
  anchorFold = anchor;
}

const toggle = (id: string, fallback: boolean) => {
  anchorFold();
  choose(id, !untracked(() => isOpen(id, fallback)));
};

let foldSettled: () => void = () => {};
export function onFoldSettled(fn: () => void) {
  foldSettled = fn;
}

/** The rows each turn's fold shows, by row id, with their place among them: set by the chat with every projection. */
let processTurns = new Map<string, { turn: string; at: number }>();
export function setProcessTurns(rows: ReadonlyMap<string, string>) {
  const next = new Map<string, { turn: string; at: number }>();
  const counts = new Map<string, number>();
  for (const [id, turn] of rows) {
    const at = counts.get(turn) ?? 0;
    counts.set(turn, at + 1);
    next.set(id, { turn, at });
  }
  processTurns = next;
}

/**
 * Automatic folds commit once the reply is lit. Only reader-initiated folds
 * use a scoped spring: even a scoped layout animation moves the virtualized
 * list's sibling cells, leaving the finished reply shifted while it settles.
 */
const FOLD_SETTLE_MS = 275;
const closingTurns = signal<Record<string, "arming" | "collapsing">>({});
const openingTurns = signal<Record<string, "arming" | "expanding">>({});
const pendingAutoClose = new Set<string>();
const autoFoldCommit = signal(0);
const foldTimers = new Map<string, ReturnType<typeof setTimeout>[]>();

const horizonPromptId = signal<string | undefined>(undefined);
let horizonPromptNodeCallback: (node: ViewRef | undefined) => void = () => {};
let currentHorizon: { id: string; node: ViewRef } | undefined;

function reportHorizon(id: string, node: ViewRef | undefined) {
  if (node) {
    if (currentHorizon?.id === id && currentHorizon?.node === node) return;
    currentHorizon = { id, node };
    horizonPromptNodeCallback(node);
  } else if (currentHorizon?.id === id) {
    currentHorizon = undefined;
    horizonPromptNodeCallback(undefined);
  }
}

/** Registers the active sent user bubble id so the chat can measure when it reaches the reading horizon. */
export function setHorizonPrompt(id: string | undefined, onNode: (node: ViewRef | undefined) => void) {
  horizonPromptNodeCallback = onNode;
  if (!id) currentHorizon = undefined;
  horizonPromptId.set(id);
}

const RECALL_MS = 210;
const recallingUsers = signal<Record<string, { row: Extract<Row, { kind: "user" }>; prevId?: string }>>({});
const recallTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Read inside `displayRows` so a recalled queued bubble stays mounted while collapsing out. */
export function trackRecallingUsers() {
  recallingUsers();
}

export function recallingUserSnapshots(): Readonly<Record<string, { row: Extract<Row, { kind: "user" }>; prevId?: string }>> {
  return untracked(recallingUsers);
}

function recallQueuedRow(row: Extract<Row, { kind: "user" }>, edit: boolean) {
  if (untracked(reduceMotion)) {
    void takeQueued(row.id, edit);
    return;
  }
  const list = untracked(transcriptRows);
  const idx = list.findIndex((item) => item.id === row.id);
  const prevId = idx > 0 ? list[idx - 1].id : undefined;
  const existing = recallTimers.get(row.id);
  if (existing) clearTimeout(existing);
  recallingUsers.update((all) => ({ ...all, [row.id]: { row, prevId } }));
  recallTimers.set(
    row.id,
    setTimeout(() => {
      recallTimers.delete(row.id);
      recallingUsers.update(({ [row.id]: _, ...rest }) => rest);
    }, RECALL_MS),
  );
  void takeQueued(row.id, edit);
}

/** Read inside `displayRows` so projection re-runs when a turn finishes collapsing. */
export function trackFoldState() {
  closingTurns();
  autoFoldCommit();
}

/** Whether `id`'s process rows stay mounted in `displayRows` while collapsing to 0pt. */
export function isTurnClosing(id: string): boolean {
  return pendingAutoClose.has(id) || closingTurns()[id] !== undefined;
}

function clearTurnTimers(id: string) {
  const timers = foldTimers.get(id);
  if (timers) {
    for (const timer of timers) clearTimeout(timer);
    foldTimers.delete(id);
  }
  pendingAutoClose.delete(id);
}

function scheduleAutoFold(id: string) {
  clearTurnTimers(id);
  pendingAutoClose.add(id);
  // Wait for the last word, then remove the process in one layout pass.
  // A Collapsible reveal here interpolates sibling list cells at run settle.
  const collapse = () => {
    clearTurnTimers(id);
    autoFoldCommit.update((n) => n + 1);
    foldSettled();
  };
  const tCollapse = setTimeout(() => {
    const wait = proseVeilUntil() - Date.now();
    if (wait <= 0) {
      collapse();
      return;
    }
    foldTimers.set(id, [setTimeout(collapse, wait)]);
  }, 16);
  foldTimers.set(id, [tCollapse]);
}

/**
 * Opens or closes a turn's fold (the process fold): opening, its rows mount
 * at 0pt and spring open with staggered opacity/glide; closing, they spring to
 * 0pt and fade out before leaving the list, so nothing pops or blinks out.
 *
 * The press is the reader's say on the turn. On the turn the run is on it is
 * also their say on the work (`turnSay`): folded, the work stays folded as it
 * goes on past a message sent into it. A press on a turn that is over says
 * nothing on the work: a look inside an earlier part opens that part alone.
 */
function toggleTurn(id: string, open: boolean, running: boolean) {
  anchorFold();
  const wasPendingClose = !running && pendingAutoClose.has(id);
  clearTurnTimers(id);
  // The turn is the reader's from here on: no fold of its own is left to make.
  watched.seen.delete(id);
  const work = running ? workOf(id) : undefined;
  if (reduceMotion() || wasPendingClose) {
    closingTurns.update(({ [id]: _, ...rest }) => rest);
    openingTurns.update(({ [id]: _, ...rest }) => rest);
    choose(id, wasPendingClose ? true : !open, work);
    if (wasPendingClose) foldSettled();
    return;
  }
  if (!open) {
    const wasClosing = closingTurns()[id] !== undefined;
    closingTurns.update(({ [id]: _, ...rest }) => rest);
    if (wasClosing) {
      openingTurns.update((all) => ({ ...all, [id]: "expanding" }));
      choose(id, true, work);
      const tDone = setTimeout(() => {
        clearTurnTimers(id);
        openingTurns.update(({ [id]: _, ...rest }) => rest);
        foldSettled();
      }, FOLD_SETTLE_MS);
      foldTimers.set(id, [tDone]);
      return;
    }
    openingTurns.update((all) => ({ ...all, [id]: "arming" }));
    choose(id, true, work);
    const tExpand = setTimeout(() => {
      openingTurns.update((all) => (all[id] ? { ...all, [id]: "expanding" } : all));
    }, 20);
    const tDone = setTimeout(() => {
      clearTurnTimers(id);
      openingTurns.update(({ [id]: _, ...rest }) => rest);
      foldSettled();
    }, 20 + FOLD_SETTLE_MS);
    foldTimers.set(id, [tExpand, tDone]);
    return;
  }
  openingTurns.update(({ [id]: _, ...rest }) => rest);
  closingTurns.update((all) => ({ ...all, [id]: "collapsing" }));
  choose(id, false, work);
  const tDone = setTimeout(() => {
    clearTurnTimers(id);
    closingTurns.update(({ [id]: _, ...rest }) => rest);
    foldSettled();
  }, FOLD_SETTLE_MS);
  foldTimers.set(id, [tDone]);
}

/**
 * How a row of a turn's process folds open or shut. Recycled `List` cells are
 * keyed by `id()`: rebinding to another row snaps `Collapsible` immediately
 * without animating the recycled cell, while transitions of the bound row's
 * own turn animate height + opacity + `translateY`.
 */
function useProcessFold(id: () => string) {
  const cellOpen = signal(true);
  const reveal = signal(true);
  const opacity = createAnimatedValue(1);
  const translateY = createAnimatedValue(0);
  let trackedId = "";
  let currentOpen = true;
  let rearmSeq = 0;

  const desiredState = (rowId: string): { open: boolean; phase: "steady" | "arming" | "expanding" | "collapsing"; at: number; recall?: boolean } => {
    if (recallingUsers()[rowId]) return { open: false, phase: "collapsing", at: 0, recall: true };
    const place = processTurns.get(rowId);
    if (!place) return { open: true, phase: "steady", at: 0 };
    if (closingTurns()[place.turn] === "collapsing") return { open: false, phase: "collapsing", at: place.at };
    const openPhase = openingTurns()[place.turn];
    if (openPhase === "arming") return { open: false, phase: "arming", at: place.at };
    if (openPhase === "expanding") return { open: true, phase: "expanding", at: place.at };
    return { open: true, phase: "steady", at: place.at };
  };

  effect(() => {
    const rowId = id();
    recallingUsers();
    closingTurns();
    openingTurns();
    untracked(() => {
      const { open: nextOpen, phase, at, recall } = desiredState(rowId);
      const rebound = rowId !== trackedId;
      trackedId = rowId;

      if (rebound) {
        const seq = ++rearmSeq;
        void opacity.stop();
        void translateY.stop();
        opacity.set(nextOpen ? 1 : 0);
        translateY.set(nextOpen ? 0 : recall ? 6 : -6);
        if (nextOpen !== currentOpen) {
          currentOpen = nextOpen;
          reveal.set(false);
          cellOpen.set(nextOpen);
          queueMicrotask(() => {
            if (rearmSeq === seq) reveal.set(true);
          });
        }
        return;
      }

      if (nextOpen === currentOpen) return;
      currentOpen = nextOpen;
      if (!reveal()) reveal.set(true);
      cellOpen.set(nextOpen);

      void opacity.stop();
      void translateY.stop();
      if (reduceMotion()) {
        opacity.set(nextOpen ? 1 : 0);
        translateY.set(0);
        return;
      }
      if (nextOpen) {
        const delay = phase === "expanding" ? Math.min(at, 6) * 24 : 0;
        opacity.set(0);
        translateY.set(-6);
        void opacity.timing(1, { duration: 200, delay, easing: EASING.entrance });
        void translateY.timing(0, { duration: 240, delay, easing: EASING.signature });
      } else {
        void opacity.timing(0, { duration: 150, easing: EASING.exit });
        void translateY.timing(recall ? 6 : -4, { duration: 180, easing: EASING.exit });
      }
    });
  });

  cleanup(() => {
    rearmSeq++;
    void opacity.stop();
    void translateY.stop();
  });

  return {
    open: cellOpen,
    reveal,
    isFolding: () => {
      if (recallingUsers()[id()]) return true;
      const place = processTurns.get(id());
      if (!place) return false;
      return closingTurns()[place.turn] !== undefined || openingTurns()[place.turn] !== undefined;
    },
    style: { opacity, transform: [{ translateY }] },
  };
}

/**
 * The turns of the conversation on screen as the reader watched them: those
 * `seen` working, whose process was open under their eyes and so folds when
 * the turn is over. Nothing here outlives the conversation's stay on screen:
 * one the reader comes back to shows each turn as it stands by then, with no
 * fold left to play.
 */
let watched = { key: -1, seen: new Set<string>() };

/** The reader's own say on a turn's fold, if they pressed its header. */
export const turnChoice = chosen;

/** Under what a press on the working turn is kept as the reader's say on the work, beside their say on the turn. */
const workOf = (id: string) => `work:${id}`;

/** What the reader said on the work while the run was on this turn, if they pressed its header then. */
export const turnSay = (id: string) => chosen(workOf(id));

/**
 * Whether a turn's process shows when the reader said nothing on it: open
 * while the run is `working` on it, folded once it is over — before a reader
 * following the end and before one reading elsewhere alike.
 */
export function turnDefault(id: string, working: boolean, hasDetails = true): boolean {
  const key = conversationKey();
  if (watched.key !== key) watched = { key, seen: new Set() };
  if (working) {
    watched.seen.add(id);
    return true;
  }
  if (!watched.seen.has(id)) return pendingAutoClose.has(id);
  watched.seen.delete(id);
  if (!hasDetails || untracked(reduceMotion)) return false;
  scheduleAutoFold(id);
  // The header holds its open frame until the fold's own pass: head and body
  // fold in one commit — never a folded head over a still-open process.
  return pendingAutoClose.has(id);
}

/** How many conversations' folds are kept: those left longest ago go first. */
const CHOICES_KEPT = 32;
let shownKeys: number[] = [];

/**
 * Another conversation fills the list (`key`). The reader's folds are kept by
 * conversation and need no swap; what is keyed by row id alone — folds in
 * motion, the veil, the prose cache — clears, since those ids mean other rows
 * in another conversation.
 */
export function enterConversation(key: number) {
  for (const id of [...foldTimers.keys()]) clearTurnTimers(id);
  for (const timer of recallTimers.values()) clearTimeout(timer);
  recallTimers.clear();
  if (Object.keys(untracked(recallingUsers)).length > 0) recallingUsers.set({});
  currentHorizon = undefined;
  pendingAutoClose.clear();
  if (Object.keys(untracked(closingTurns)).length > 0) closingTurns.set({});
  if (Object.keys(untracked(openingTurns)).length > 0) openingTurns.set({});
  // What was watched in the conversation left is not watched any more (one with no turn to show, an empty
  // chat, asks `turnDefault` nothing and would leave it standing): coming back finds no fold left to play.
  if (watched.key !== key) watched = { key: -1, seen: new Set() };

  shownKeys = [...shownKeys.filter((shown) => shown !== key), key];
  if (shownKeys.length > CHOICES_KEPT) {
    const gone = shownKeys.splice(0, shownKeys.length - CHOICES_KEPT);
    choices.update((all) => {
      const kept = { ...all };
      for (const old of gone) delete kept[old];
      return kept;
    });
  }

  replyActionRows.clear();
  heldActionRows.clear();
  clearProseState();
}

/**
 * The laid-out height of each user bubble's text, keyed by stable text content
 * signature + reading size so cold switches (which mint fresh row ids) hit the
 * measured line count on Frame 1 without folding/unfolding on Frame 2.
 */
const USER_LINE_COUNTS_LIMIT = 500;
const userLineCounts = signal<Record<string, number>>({});

function userTextSig(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${text.length}:${(h >>> 0).toString(36)}`;
}
function UserImages(props: {
  rowId: string;
  images: readonly ImageContent[];
  missing: number;
  onContextMenu: (e: { pagePosition: { x: number; y: number } }) => void;
}) {
  const getStream = MediaStreamContext();
  const totalCount = () => props.images.length + props.missing;
  const mediaItems = (): MediaItem[] =>
    props.images.map((img, idx) => ({
      id: `${props.rowId}:img:${idx}`,
      kind: "image",
      title:
        totalCount() > 1
          ? tr(`Image ${idx + 1} of ${totalCount()}`, `图片 ${idx + 1} / ${totalCount()}`)
          : tr("Image", "图片"),
      src: `data:${img.mimeType};base64,${img.data}`,
      mimeType: img.mimeType,
      data: img.data,
    }));

  return (
    <If
      when={props.images.length > 0}
      else={
        <View
          testID="message-image-fallback"
          onContextMenu={props.onContextMenu}
          class="select-none flex-row items-center gap-1.5 rounded-xl corner-squircle border-[0.5px] border-hairline bg-secondary/70 px-2.5 py-1.5"
        >
          <Icon name="image" size={14} tone="muted-foreground" />
          <Text class={`${uiType("xs")} text-muted-foreground`}>
            {tr(props.missing === 1 ? "1 image" : `${props.missing} images`, `${props.missing} 张图片`)}
          </Text>
        </View>
      }
    >
      <View class="max-w-full flex-row flex-wrap justify-end gap-1.5" onContextMenu={props.onContextMenu}>
        <Each of={props.images} key="index">
          {(image, index) => (
            <View
              testID="message-image"
              role="button"
              onPress={() => {
                const local = mediaItems();
                const picked = local[index()];
                if (picked) openMediaZoom(picked, mediaZoomOptions(getStream, local));
              }}
              onContextMenu={props.onContextMenu}
              accessibilityLabel={
                totalCount() > 1
                  ? tr(`Preview image ${index() + 1}`, `预览第 ${index() + 1} 张图片`)
                  : tr("Preview image", "预览图片")
              }
              tooltip={tip(tr("Preview image", "预览图片"))}
              class={`relative size-18 shrink-0 overflow-hidden rounded-xl corner-squircle bg-secondary ${PRESS} ${PRESS_SCALE} ${FOCUS_RING}`}
            >
              <Image
                src={`data:${image().mimeType};base64,${image().data}`}
                class="size-full"
                style={{ objectFit: "cover" }}
                accessibilityLabel={
                  totalCount() > 1
                    ? tr(`Sent image ${index() + 1}`, `已发送的图片 ${index() + 1}`)
                    : tr("Sent image", "已发送的图片")
                }
              />
              {/* The edge is drawn over the pixels, so a white screenshot still has one. */}
              <View class="pointer-events-none absolute inset-0 rounded-xl corner-squircle border-[0.5px] border-hairline-hover" />
            </View>
          )}
        </Each>
        <If when={props.missing > 0}>
          <View
            testID="message-image-fallback"
            class="size-18 shrink-0 select-none items-center justify-center gap-1 rounded-xl corner-squircle border-[0.5px] border-hairline bg-secondary/70"
          >
            <Icon name="image" size={16} tone="muted-foreground" />
            <Text class={`${uiType("xs")} text-muted-foreground`}>+{props.missing}</Text>
          </View>
        </If>
      </View>
    </If>
  );
}

function fileAttachmentToMedia(file: FileAttachment, id: string): MediaItem {
  const resolved = resolveMediaTarget(file.path, workspacePath(), backend().home());
  return {
    id,
    kind: file.kind,
    title: file.name,
    path: resolved?.path ?? file.path,
    ...(resolved?.src ? { src: resolved.src } : {}),
    ...(file.mimeType ? { mimeType: file.mimeType } : resolved?.mimeType ? { mimeType: resolved.mimeType } : {}),
    ...(typeof file.size === "number" ? { size: file.size } : {}),
    ...(resolved?.isMarkdown ? { isMarkdown: true } : {}),
  };
}

function UserRow(props: { row: DisplayUserRow }) {
  // The fork command names a message by its place among the user's messages on screen.
  const ordinal = () =>
    transcriptRows()
      .filter((row) => row.kind === "user")
      .findIndex((row) => row.id === props.row.id);
  const sms = () => props.row.sms;
  const isSms = () => Boolean(sms());
  const open = () => isOpen(props.row.id, false);
  /** The message as its words, attached documents, and attached files (`lib/doc-wire.ts`, `lib/media.ts`); read again only when the text is another. */
  let readText: string | undefined;
  let read: { said: string; docs: DocPart[]; files: FileAttachment[] } = { said: "", docs: [], files: [] };
  const parts = () => {
    const text = props.row.text;
    if (text !== readText) {
      readText = text;
      const fileSplit = splitFileMessage(text);
      const docSplit = splitDocMessage(fileSplit.said);
      read = { said: docSplit.said, docs: docSplit.docs, files: fileSplit.files };
    }
    return read;
  };
  const said = () => parts().said;
  const fileMedia = () => parts().files.map((file, idx) => fileAttachmentToMedia(file, `${props.row.id}:att:${idx}`));
  const measureKey = () => `${userTextSig(said())}:${readingSize()}`;
  const foldable = () => {
    const measured = userLineCounts()[measureKey()];
    if (measured !== undefined) return measured > USER_FOLD_LINES;
    return hardBreakLines(said()) > USER_FOLD_LINES || roughUserLines(said(), undefined, readingSize() / FONT_SIZES.reading.default) >= USER_PREFOLD_LINES;
  };
  const folded = () => foldable() && !open();
  const fold = () => toggle(props.row.id, false);
  /** The queue still holds this message: its bubble stands where it was sent, but reads as waiting — not said into the run yet. */
  const queued = () => props.row.queued === true;
  /** How it will go: into the run at its next step, or after the run is done. The queue keeps wire text; the row's is stripped. */
  const followsUp = () => {
    const said = (wire: string) => withoutPreamble(withoutImageNotes(wire));
    const q = messageQueue();
    return q.followUp.some((wire) => said(wire) === props.row.text) && !q.steering.some((wire) => said(wire) === props.row.text);
  };
  const bubbleOpacity = createAnimatedValue(untracked(queued) ? 0.6 : 1);
  let trackedBubbleId = untracked(() => props.row.id);
  let wasQueued = untracked(queued);
  effect(() => {
    const id = props.row.id;
    const isQueued = queued();
    const reduced = reduceMotion();
    untracked(() => {
      if (id !== trackedBubbleId) {
        trackedBubbleId = id;
        wasQueued = isQueued;
        void bubbleOpacity.stop();
        bubbleOpacity.set(isQueued ? 0.6 : 1);
        return;
      }
      if (isQueued === wasQueued) return;
      wasQueued = isQueued;
      void bubbleOpacity.stop();
      if (reduced) {
        bubbleOpacity.set(isQueued ? 0.6 : 1);
      } else {
        // Delivery is a state flip, not an entrance: a quick symmetric fade
        // reads as "sent", a long entrance-eased one as a second pop-in.
        void bubbleOpacity.timing(isQueued ? 0.6 : 1, { duration: DURATION.instant, easing: EASING.inOut });
      }
    });
  });
  cleanup(() => void bubbleOpacity.stop());

  const smsEntrance = useSmsBubbleEntrance(
    () => props.row.id,
    () => "right",
    { enabled: isSms, muted: queued },
  );

  const hostNode = signal<ViewRef | undefined>(undefined);
  effect(() => {
    const rowId = props.row.id;
    const target = horizonPromptId();
    const node = hostNode();
    if (target === rowId && node) {
      untracked(() => reportHorizon(rowId, node));
      cleanup(() => reportHorizon(rowId, undefined));
    }
  });

  const imageBlocks = () => props.row.imageBlocks ?? [];
  const missingImages = () => Math.max(0, props.row.images - imageBlocks().length);
  const hasImages = () => imageBlocks().length > 0 || missingImages() > 0;
  const hasBubble = () => Boolean(said()) || parts().docs.length > 0;

  const smsBubbleRadius = () => {
    const slot = sms();
    if (!slot) return "rounded-2xl rounded-br-md";
    if (slot.first && slot.last) return "rounded-[18px] rounded-br-[5px]";
    if (slot.first) return "rounded-[18px] rounded-br-[6px]";
    if (slot.last) return "rounded-[18px] rounded-tr-[6px] rounded-br-[5px]";
    return "rounded-[18px] rounded-r-[6px]";
  };

  const personaScope = () => `${activePersonaId() ?? "default"}:${currentDaemonSession()?.id ?? "unattached"}`;
  const messageTarget = () => userAnchor(transcriptRows(), props.row.id) ?? props.row.id;
  const messageSnapshot = () => ({
    scope: personaScope(),
    target: messageTarget(),
    rowId: props.row.id,
    displayId: props.row.id,
    side: "right" as const,
    author: "You",
    excerpt: replyExcerpt(said() || parts().files.map((file) => file.name).join(" ")),
    images: props.row.images,
    text: said(),
    copyText: props.row.text,
    imageBlocks: props.row.imageBlocks,
    first: sms()?.first ?? true,
    last: sms()?.last ?? true,
    tail: sms()?.last ?? true,
  });
  const openPersonaMenu = (x: number, y: number) => openPipMessageMenu(messageSnapshot(), x, y);
  const bubbleNode = signal<ViewRef | undefined>(undefined);
  const mediaNode = signal<ViewRef | undefined>(undefined);
  const clusterNode = signal<ViewRef | undefined>(undefined);
  effect(() => {
    const rowId = props.row.id;
    const node = clusterNode() ?? bubbleNode() ?? (!hasBubble() && (hasImages() || fileMedia().length > 0) ? mediaNode() ?? hostNode() : undefined);
    if (!node) return;
    const unregister = registerPipMessageNode(rowId, node);
    if (unregister) cleanup(unregister);
  });
  const openPersonaActions = () => {
    const node = pipMessageNode(props.row.id) ?? clusterNode() ?? bubbleNode() ?? mediaNode() ?? hostNode();
    if (!node) return;
    void node.measure().then((m) => {
      if (!m) return;
      openPersonaMenu(m.pagePosition.x - 4 - 248, m.pagePosition.y + m.bounds.size.height / 2 - 12);
    }).catch(() => undefined);
  };

  const contextMenu = (e: { pagePosition: { x: number; y: number } }) => {
    if (isPersonaSession() && isSms()) {
      openPersonaMenu(e.pagePosition.x, e.pagePosition.y);
      return;
    }
    Menu.popup(
      [
        ...(props.row.text ? [{ label: tr("Copy", "复制"), onSelect: () => void copyText(props.row.text) }] : []),
        // There is nothing in the session to fork at until the agent takes the message.
        ...(queued()
          ? [
              { label: tr("Edit", "编辑"), onSelect: () => recallQueuedRow(props.row, true) },
              { label: tr("Remove From Queue", "从队列中移除"), onSelect: () => recallQueuedRow(props.row, false) },
            ]
          : [{ label: tr("Fork From Here", "从此处创建分支"), onSelect: () => void forkFrom(ordinal()) }]),
      ],
      e.pagePosition,
    );
  };

  return (
    <View ref={(node: ViewRef) => hostNode.set(node)} class="group items-end">
      <View
        class={`${isSms() ? "max-w-[72%]" : "max-w-[70%]"} items-end`}
        style={isSms() ? smsEntrance : undefined}
      >
        <View class="max-w-full items-end gap-1.5" style={{ opacity: bubbleOpacity }}>
          {isPersonaSession() && props.row.reply ? <PipQuotePreview reply={props.row.reply} side="right" /> : null}
          <View
            ref={(node: ViewRef | undefined) => clusterNode.set(node)}
            class="max-w-full items-end gap-1.5"
            style={{ visibility: pipReplyCoveredId() === props.row.id ? "hidden" : "visible" }}
          >
            <If when={!hasBubble() && (hasImages() || fileMedia().length > 0)}>
              <View ref={(node: ViewRef | undefined) => mediaNode.set(node)} class="relative max-w-full" onContextMenu={contextMenu}>
                {isPersonaSession() && isSms() ? <PipMessageAdornments scope={personaScope()} target={messageTarget()} side="right" /> : null}
                {isPersonaSession() && isSms() ? <PipMessageHoverActions side="right" onPress={openPersonaActions} /> : null}
                <View class="items-end gap-1.5">
                  <If when={hasImages()}>
                    <UserImages rowId={props.row.id} images={imageBlocks()} missing={missingImages()} onContextMenu={contextMenu} />
                  </If>
                  <If when={fileMedia().length > 0}>
                    <MediaGallery items={fileMedia()} compact align="end" />
                  </If>
                </View>
              </View>
            </If>
            <If when={hasBubble() && hasImages()}>
              <UserImages rowId={props.row.id} images={imageBlocks()} missing={missingImages()} onContextMenu={contextMenu} />
            </If>
            <If when={hasBubble() && fileMedia().length > 0}>
              <MediaGallery items={fileMedia()} compact align="end" />
            </If>
            <If when={hasBubble()}>
              <View
                testID="message-bubble"
                ref={(node: ViewRef | undefined) => bubbleNode.set(node)}
                class={
                  isSms()
                    ? `relative max-w-full gap-1.5 ${smsBubbleRadius()} corner-squircle bg-brand px-3.5 py-2`
                    : "max-w-full gap-1.5 rounded-2xl rounded-br-md corner-squircle border-[0.5px] border-hairline bg-secondary px-4 py-2.5"
                }
                selectable
                onContextMenu={contextMenu}
              >
                {isPersonaSession() && isSms() ? <PipMessageAdornments scope={personaScope()} target={messageTarget()} side="right" /> : null}
                {isPersonaSession() && isSms() ? <PipMessageHoverActions side="right" onPress={openPersonaActions} /> : null}
                <If when={sms()?.last}>
                  <BubbleTail side="right" tone="brand" />
                </If>
                <If when={said()}>
                  {/* While folded the whole message takes the press; while open it is plain selectable text again. */}
                  <View
                    role={folded() ? "button" : undefined}
                    onPress={folded() ? fold : undefined}
                    accessibilityState={folded() ? { expanded: false } : undefined}
                  >
                    <Text
                      class={`${readingType()} ${isSms() ? "text-brand-foreground" : "text-secondary-foreground"} ${folded() ? "line-clamp-6" : ""}`}
                      style={folded() ? { maskImage: "linear-gradient(to bottom, black 64%, transparent 94%)" } : undefined}
                      onTextLayout={(e) => {
                        const n = e.lines.length;
                        // Fewer lines than the text's own breaks (or a zero-height headless stub box) is not a real layout pass.
                        if (n < hardBreakLines(said()) || (n === 1 && (e.lines[0]?.bounds.size.height ?? 0) === 0)) return;
                        if (folded() && n >= USER_FOLD_LINES) return;
                        const key = measureKey();
                        if (n !== userLineCounts()[key]) {
                          userLineCounts.update((all) => {
                            const keys = Object.keys(all);
                            if (keys.length >= USER_LINE_COUNTS_LIMIT) {
                              const trimmed: Record<string, number> = {};
                              for (let i = keys.length - Math.floor(USER_LINE_COUNTS_LIMIT / 2); i < keys.length; i++) {
                                trimmed[keys[i]] = all[keys[i]];
                              }
                              trimmed[key] = n;
                              return trimmed;
                            }
                            return { ...all, [key]: n };
                          });
                        }
                      }}
                    >
                      {said()}
                    </Text>
                  </View>
                </If>
                {/* A document that rode on the message is named, not printed: its words are in the document, a press away. */}
                <Each of={parts().docs} key="index">
                  {(doc) => (
                    <View
                      testID="message-doc"
                      role="button"
                      onPress={() => void openDocIfThere(doc().path)}
                      tooltip={tip(tr("Open the document", "打开文档"))}
                      class={`group -mx-1 select-none flex-row items-center gap-1.5 self-start rounded-md corner-squircle px-1 py-0.5 ${PRESS} ${PRESS_SCALE} ${FOCUS_RING} ${
                        isSms() ? "hover:bg-brand-foreground/15" : "hover:bg-accent"
                      }`}
                    >
                      <Icon name="file" size={14} tone={isSms() ? "brand-foreground" : "muted-foreground"} />
                      <Text
                        class={`shrink truncate ${uiType("xs")} transition-colors duration-100 ${
                          isSms() ? "text-brand-foreground/85 group-hover:text-brand-foreground" : "text-muted-foreground group-hover:text-foreground"
                        }`}
                      >
                        {(doc().excerpt ? "" : titleLine(doc().text, true)) || docTabTitle(doc().path)}
                        {doc().excerpt ? tr(" · selection", " · 选中的内容") : ""}
                      </Text>
                    </View>
                  )}
                </Each>
                <If when={foldable()}>
                  <View
                    role="button"
                    onPress={fold}
                    accessibilityState={{ expanded: open() }}
                    accessibilityLabel={open() ? tr("Collapse message", "收起消息") : tr("Expand message", "展开消息")}
                    class={`-mx-1 -mb-1 h-5 select-none items-center justify-center rounded-md corner-squircle ${PRESS} ${FOCUS_RING}`}
                  >
                    <View
                      class={`transition-transform duration-200 ease-out-quint motion-reduce:transition-none ${open() ? "rotate-180" : ""}`}
                    >
                      <Icon name="chevronDown" size={12} tone={isSms() ? "brand-foreground" : "muted-foreground"} />
                    </View>
                  </View>
                </If>
              </View>
            </If>
          </View>
        </View>
      </View>
      <If
        when={isSms()}
        else={
          /* Shown while the pointer is on the message (or just after a copy), so the bubbles stay quiet. */
          <View class="h-6 select-none flex-row items-center gap-1.5 pt-0.5">
            {/* A waiting message is still the reader's: each one is taken back from its own bubble, to write again or to drop. */}
            <If when={queued()}>
              <View
                class="flex-row items-center gap-1 pr-1"
                accessibilityLabel={followsUp() ? tr("Follow-up", "追问") : tr("Steering", "引导")}
                tooltip={tip(followsUp() ? tr("Follow-up: sent when the run is done", "追问：本轮结束后发送") : tr("Steering: sent at the run's next step", "引导：在本轮的下一步发送"))}
              >
                <Icon name={followsUp() ? "queue" : "steer"} size={12} tone="subtle" />
                <Text class={`${uiType("xs")} text-subtle`}>{tr("Queued", "排队中")}</Text>
              </View>
              <IconButton
                icon="pencil"
                tone="subtle"
                size="sm"
                tipPlacement="bottom"
                label={tr("Edit queued message", "编辑排队消息")}
                onPress={() => recallQueuedRow(props.row, true)}
              />
              <IconButton
                icon="x"
                tone="subtle"
                size="sm"
                tipPlacement="bottom"
                label={tr("Remove from queue", "从队列中移除")}
                onPress={() => recallQueuedRow(props.row, false)}
              />
            </If>
            <If when={props.row.text}>
              <CopyButton
                id={props.row.id}
                text={props.row.text}
                label={tr("Copy message", "复制消息")}
                class={`-mr-1 transition-opacity duration-150 motion-reduce:transition-none ${HOVER_REVEAL}`}
              />
            </If>
          </View>
        }
      >
        {/* The queued label and the receipt share one seat, so a message the
         * queue lets go of trades marks without moving the bubble above. */}
        <If when={queued() || Boolean(sms()?.receipt)}>
          <View class="h-6 select-none flex-row items-center gap-1.5 pt-0.5">
            <If when={queued()}>
              <View
                class="flex-row items-center gap-1 pr-1"
                accessibilityLabel={followsUp() ? tr("Follow-up", "追问") : tr("Steering", "引导")}
                tooltip={tip(followsUp() ? tr("Follow-up: sent when the run is done", "追问：本轮结束后发送") : tr("Steering: sent at the run's next step", "引导：在本轮的下一步发送"))}
              >
                <Icon name={followsUp() ? "queue" : "steer"} size={12} tone="subtle" />
                <Text class={`${uiType("2xs")} text-subtle`}>{tr("Queued", "排队中")}</Text>
              </View>
              <IconButton
                icon="pencil"
                tone="subtle"
                size="sm"
                tipPlacement="bottom"
                label={tr("Edit queued message", "编辑排队消息")}
                onPress={() => recallQueuedRow(props.row, true)}
              />
              <IconButton
                icon="x"
                tone="subtle"
                size="sm"
                tipPlacement="bottom"
                label={tr("Remove from queue", "从队列中移除")}
                onPress={() => recallQueuedRow(props.row, false)}
              />
            </If>
            <If when={!queued() && sms()?.receipt}>
              <Text testID="sms-receipt" class={`pr-1 ${uiType("2xs")} font-medium text-subtle`}>
                {sms()?.receipt === "read" ? tr("Read", "已读") : tr("Delivered", "已送达")}
              </Text>
            </If>
          </View>
        </If>
      </If>
    </View>
  );
}

/** The message whose Copy was just pressed: its button shows a check for a moment. One at a time, by row id (cells are recycled). */
const copiedId = signal<string | undefined>(undefined);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
const COPIED_MS = 1600;

/** Copies a message's text; the icon turns to a check while it holds. */
function CopyButton(props: { id: string; text: string; label: string; class?: string }) {
  const copied = () => copiedId() === props.id;
  return (
    <IconButton
      icon={copied() ? "check" : "copy"}
      tone={copied() ? "success" : "subtle"}
      size="sm"
      label={copied() ? tr("Copied", "已复制") : props.label}
      tipPlacement="bottom"
      class={copied() ? `${props.class ?? ""} opacity-100` : props.class}
      onPress={() =>
        void copyMessage(props.text).then((ok) => {
          if (!ok) return;
          clearTimeout(copiedTimer);
          copiedId.set(props.id);
          copiedTimer = setTimeout(() => copiedId.set(undefined), COPIED_MS);
        })
      }
    />
  );
}

/** The line under a finished reply: its Copy. A row of its own, after the reply's blocks. */
export interface ReplyActionsRow {
  kind: "actions";
  id: string;
  /** The reply (transcript row) it acts on. */
  rowId: string;
  text: string;
  /** Set while the reply is still written: the row takes the Copy line's height
   * already, so the reply's end fills a seat instead of adding one. */
  held?: boolean;
}

const replyActionRows = new Map<string, ReplyActionsRow>();
const heldActionRows = new Map<string, ReplyActionsRow>();

/** The actions row of a finished reply: the same object while the reply does not change, so the list leaves it alone. */
export function replyActions(row: { id: string; text: string }): ReplyActionsRow {
  const before = replyActionRows.get(row.id);
  if (before && before.text === row.text) return before;
  const made: ReplyActionsRow = { kind: "actions", id: `${row.id}#actions`, rowId: row.id, text: row.text };
  replyActionRows.set(row.id, made);
  return made;
}

/**
 * The actions row's seat under a reply still being written: the same row id and
 * height it will keep, nothing in it yet. When the reply ends the seat fills
 * where it stood — the reader at its foot is not pushed a line.
 */
export function heldActions(row: { id: string }): ReplyActionsRow {
  let held = heldActionRows.get(row.id);
  if (!held) {
    held = { kind: "actions", id: `${row.id}#actions`, rowId: row.id, text: "", held: true };
    heldActionRows.set(row.id, held);
  }
  return held;
}

function ReplyActionsView(props: { row: ReplyActionsRow }) {
  return (
    <View class="h-6 select-none flex-row items-center">
      <Presence show={!props.row.held} scaleFrom={1} class="-ml-1">
        <CopyButton id={props.row.id} text={props.row.text} label={tr("Copy reply", "复制回复")} />
      </Presence>
    </View>
  );
}

/** Shared compact disclosure trigger row for Level-1 & Level-2 folds. */
function Disclosure(props: {
  open: boolean;
  onPress: () => void;
  compact?: boolean;
  alwaysShowChevron?: boolean;
  children?: JSX.Element;
}) {
  return (
    <View
      role="button"
      onPress={props.onPress}
      accessibilityState={{ expanded: props.open }}
      class={`group ${props.compact ? `${uiHeight(26)} px-2` : `-mx-2 ${uiHeight(28)} px-2`} select-none flex-row items-center gap-2 rounded-md corner-squircle ${PRESS} active:scale-[0.995] motion-reduce:active:scale-100 ${FOCUS_RING} hover:bg-accent active:bg-accent`}
    >
      {props.children}
      <View
        class={`shrink-0 transition-all duration-200 ease-out-quint motion-reduce:transition-none ${
          props.open
            ? "rotate-90 opacity-100"
            : props.alwaysShowChevron
              ? "opacity-55 group-hover:opacity-100"
              : "opacity-0 group-hover:opacity-100"
        }`}
      >
        <Icon name="chevronRight" size={12} tone="subtle" />
      </View>
    </View>
  );
}

/**
 * A process line: quiet words with the fold's chevron right after them,
 * no icon, no hover fill. The words carry the state; the row never changes height.
 */
function ProcessLine(props: { open: boolean; onPress?: () => void; children?: JSX.Element }) {
  return (
    <If
      when={props.onPress}
      else={<View class={`${uiHeight(28)} min-w-0 max-w-full select-none flex-row items-center gap-1.5`}>{props.children}</View>}
    >
      <View
        role="button"
        onPress={props.onPress}
        accessibilityState={{ expanded: props.open }}
        class={`group ${uiHeight(28)} min-w-0 max-w-full select-none flex-row items-center gap-1.5 self-start rounded-md corner-squircle ${FOCUS_RING}`}
      >
        {props.children}
        <View
          class={`shrink-0 transition-all duration-200 ease-out-quint motion-reduce:transition-none ${
            props.open ? "rotate-90 opacity-100" : "opacity-60 group-hover:opacity-100"
          }`}
        >
          <Icon name="chevronRight" size={12} tone="subtle" />
        </View>
      </View>
    </If>
  );
}

/** Unified leading indicator: spinner while active, error mark on failure, or semantic icon when settled.
 * Plays a crisp spring pop only on live running -> settled transitions, never on recycled cells. */
function LeadGlyph(props: {
  id: string;
  running: boolean;
  error: boolean;
  icon: IconName;
  activeTone?: "brand-text" | "muted-foreground" | "subtle";
}) {
  const scale = createAnimatedValue(1);
  const opacity = createAnimatedValue(1);
  let trackedId = "";
  let wasRunning = false;

  effect(() => {
    const id = props.id;
    const settled = !props.running;
    untracked(() => {
      if (id !== trackedId) {
        trackedId = id;
        wasRunning = !settled;
        scale.set(1);
        opacity.set(1);
        return;
      }
      if (wasRunning && settled && !reduceMotion()) {
        wasRunning = false;
        scale.set(0.72);
        opacity.set(0.4);
        void scale.spring(1, { stiffness: 520, damping: 28, mass: 0.9 });
        void opacity.timing(1, { duration: 150, easing: EASING.entrance });
      } else {
        wasRunning = !settled;
      }
    });
  });

  cleanup(() => {
    void scale.stop();
    void opacity.stop();
  });

  return (
    <View class="size-4 shrink-0 items-center justify-center">
      <If
        when={props.running}
        else={
          <View style={{ opacity, scale }}>
            <If
              when={props.error}
              else={<Icon name={props.icon} size={14} tone={props.activeTone ?? "muted-foreground"} />}
            >
              <Icon name="x" size={14} tone="destructive" />
            </If>
          </View>
        }
      >
        <View class="size-3 rounded-full border-[1.5px] border-input border-t-brand motion-safe:animate-spin" />
      </If>
    </View>
  );
}

function DiffBadge(props: { stats?: DiffStats }) {
  return (
    <If when={props.stats && (props.stats.added > 0 || props.stats.removed > 0) ? props.stats : undefined}>
      {(stats) => (
        <View class="shrink-0 flex-row items-center gap-1">
          <If when={stats().added > 0}>
            <Text class={`font-mono ${uiType("2xs")} font-medium tabular-nums text-success`}>{`+${stats().added}`}</Text>
          </If>
          <If when={stats().removed > 0}>
            <Text class={`font-mono ${uiType("2xs")} font-medium tabular-nums text-destructive`}>{`-${stats().removed}`}</Text>
          </If>
        </View>
      )}
    </If>
  );
}

function ThinkingRow(props: { row: Extract<Row, { kind: "thinking" }>; defaultOpen?: boolean; compact?: boolean }) {
  const fallback = () => Boolean(props.defaultOpen);
  const open = () => isOpen(props.row.id, fallback());
  const label = () => thinkingLabel(props.row, activeLanguage());
  const hasBody = () => Boolean(props.row.text.trim());
  const text = () => `min-w-0 shrink truncate ${uiType("sm")} text-muted-foreground`;

  // Among a run's steps it reads as the tool calls beside it do: a glyph, then the words.
  if (props.compact) {
    return (
      <Collapsible open={open() && hasBody()} reveal content={<ReasoningBody text={props.row.text} />}>
        <Disclosure open={open() && hasBody()} compact onPress={() => hasBody() && toggle(props.row.id, fallback())}>
          <LeadGlyph id={props.row.id} running={props.row.streaming} error={false} icon="thinking" />
          <RollingText id={() => props.row.id} text={label} class={`min-w-0 shrink truncate ${uiType("sm")} text-muted-foreground`} />
        </Disclosure>
      </Collapsible>
    );
  }

  return (
    <Collapsible open={open() && hasBody()} reveal content={<ReasoningBody text={props.row.text} />}>
      <ProcessLine open={open() && hasBody()} onPress={hasBody() ? () => toggle(props.row.id, fallback()) : undefined}>
        <RollingText id={() => props.row.id} text={label} class={text()} />
      </ProcessLine>
    </Collapsible>
  );
}

/** Reasoning, unfolded: quiet prose on a hairline. */
function ReasoningBody(props: { text: string }) {
  return (
    <View class="mb-1 border-l border-hairline py-1 pl-3.5" selectable>
      <Text class={`${readingType("sm")} leading-relaxed text-muted-foreground`}>{props.text.trim()}</Text>
    </View>
  );
}

/** Grouped output scrolls with its steps; a standalone shell result owns its scroll. */
function Output(props: { text: string; command?: string; tone?: "error"; insetClass?: string; standalone?: boolean }) {
  const shown = () => clip(props.text, 400);
  const body = () => (
    <View class="p-3">
      <If when={props.command}>
        <Text class={`font-mono ${codeType()} leading-relaxed text-subtle ${shown().text ? "pb-2" : ""}`}>{`$ ${props.command}`}</Text>
      </If>
      <If when={!props.command || !!shown().text}>
        <Text class={`font-mono ${codeType()} leading-relaxed ${props.tone === "error" ? "text-destructive" : "text-muted-foreground"}`}>
          {shown().text || tr("No output.", "无输出。")}
        </Text>
      </If>
      <If when={shown().hidden > 0}>
        <Text class={`pt-2 ${uiType("xs")} text-subtle`}>{tr(`${shown().hidden} more lines not shown`, `另有 ${shown().hidden} 行未显示`)}</Text>
      </If>
    </View>
  );
  return (
    <View selectable class={`mb-1 mt-0.5 overflow-hidden rounded-lg corner-squircle border border-border bg-sunken ${props.insetClass ?? "ml-6"}`}>
      {props.standalone ? <Scroll class="max-h-72">{body()}</Scroll> : body()}
    </View>
  );
}

/** The diff an edit made, when the tool reports one: highlighted as a diff. */
const diffOf = (row: ToolRow) => {
  const details = row.details as { diff?: unknown } | undefined;
  return typeof details?.diff === "string" && details.diff ? details.diff : undefined;
};

/** What a call did, unfolded: the diff an edit made, media results returned/presented, else its output (a command's under its command line). */
function ToolDetail(props: { row: ToolRow; insetClass?: string }) {
  const command = () => (classifyTool(props.row.name).category === "command" ? String(props.row.args?.command ?? props.row.args?.cmd ?? "").trim() : "");
  const presented = () => extractPresentedMedia(props.row, workspacePath(), backend().home());
  const media = () => presented()?.items ?? extractToolResultMedia(props.row, workspacePath(), backend().home());
  const suppressPresentDump = () => Boolean(presented()) && props.row.status !== "error";
  const detail = () => {
    if (suppressPresentDump()) return "";
    if (props.row.output) return props.row.output;
    if (props.row.status === "call") return tr("Writing tool arguments…", "正在生成调用参数…");
    if (props.row.status === "queued" || props.row.status === "running") return tr("Running…", "正在运行…");
    if (props.row.images) return media().length > 0 ? "" : tr(`${props.row.images} image${props.row.images === 1 ? "" : "s"} returned.`, `返回了 ${props.row.images} 张图片。`);
    if (command()) return "";
    const rawArgs = JSON.stringify(props.row.args ?? {}, null, 2);
    return rawArgs && rawArgs !== "{}" ? rawArgs : tr("Completed with no output.", "已完成，无额外输出。");
  };
  return (
    <View>
      <If when={media().length > 0}>
        <MediaGallery items={media()} compact class={`mb-1 mt-1 ${props.insetClass ?? "ml-6"}`} />
      </If>
      <If
        when={diffOf(props.row)}
        else={
          <If when={detail() || command()}>
            <Output text={detail()} command={command()} tone={props.row.status === "error" ? "error" : undefined} insetClass={props.insetClass} />
          </If>
        }
      >
        {(diff) => (
          <View class={`mb-1 mt-0.5 ${props.insetClass ?? "ml-6"}`}>
            <TextView
              markdown={`\`\`\`diff\n${clip(diff(), 400).text}\n\`\`\``}
              selectable
              codeBlockScrollbar={false}
              classes={{ codeBlock: proseClasses().codeBlock, codeBlockCode: `p-3 ${codeType()}` }}
            />
          </View>
        )}
      </If>
    </View>
  );
}

/** Extracts a navigable daemon session id from a session-tool call (`session_start`, `session_send`, etc.). */
function sessionIdOfTool(row: ToolRow): string | undefined {
  const lower = row.name.replace(/^mcp__[^_]+__/i, "").toLowerCase();
  if (lower === "session_start" && row.output) {
    try {
      const parsed = JSON.parse(row.output) as { id?: unknown };
      if (typeof parsed?.id === "string" && parsed.id && daemonSessionOfId(parsed.id)) return parsed.id;
    } catch {
      // Output may be partial or an error text.
    }
  }
  if (lower === "session_send" || lower === "session_read" || lower === "session_stop") {
    const id = typeof row.args?.session === "string" ? row.args.session : undefined;
    if (id && daemonSessionOfId(id)) return id;
  }
  return undefined;
}

function ToolCallRow(props: { row: ToolRow; compact?: boolean }) {
  const open = () => isOpen(props.row.id, false);
  const desc = () => describeToolCall(props.row, activeLanguage());
  const running = () => props.row.status === "call" || props.row.status === "queued" || props.row.status === "running";
  const targetSession = () => sessionIdOfTool(props.row);

  return (
    <Collapsible open={open()} reveal content={<ToolDetail row={props.row} />}>
      <View class="flex-row items-center gap-1">
        <View class="min-w-0 flex-1">
          <Disclosure open={open()} compact={props.compact} onPress={() => toggle(props.row.id, false)}>
            <LeadGlyph
              id={props.row.id}
              running={running()}
              error={props.row.status === "error"}
              icon={desc().icon}
            />
            <RollingText
              id={() => props.row.id}
              text={() => desc().verb}
              class={`shrink-0 ${uiType("sm")} ${props.row.status === "error" ? "font-medium text-destructive" : "text-muted-foreground"}`}
            />
            <If when={desc().target}>
              <Text
                class={`min-w-0 shrink truncate ${
                  desc().monoTarget ? `font-mono ${uiType("xs")} text-foreground` : `${uiType("sm")} text-foreground`
                }`}
              >
                {desc().target}
              </Text>
            </If>
            <If when={desc().meta}>
              <Text class={`shrink-0 truncate ${uiType("xs")} text-subtle`}>{desc().meta}</Text>
            </If>
            <DiffBadge stats={desc().diffStats} />
          </Disclosure>
        </View>
        <If when={targetSession()}>
          {(sid) => (
            <IconButton
              icon="external"
              size="sm"
              label={tr("Open session", "打开会话")}
              onPress={() => openDaemonSession(sid())}
            />
          )}
        </If>
      </View>
    </Collapsible>
  );
}

/**
 * A run of non-prose process steps (reasoning and tool calls):
 * one quiet line, the step under way while it works and what it did once
 * settled. It unfolds to the reasoning or the call's output when it holds one
 * step, else to each step in the order they happened.
 */
function ActivityView(props: { row: ActivityRow; maxHeight: number }) {
  const open = () => isOpen(props.row.id, false);
  const title = () => describeActivity(props.row, activeLanguage());
  const only = () => (props.row.steps.length === 1 ? props.row.steps[0] : undefined);
  const onlySession = () => {
    const step = only();
    return step?.kind === "tool" ? sessionIdOfTool(step) : undefined;
  };
  const hasBody = () => {
    const step = only();
    return !step || step.kind === "tool" || Boolean(step.text.trim());
  };

  const aggregateDiff = (): DiffStats | undefined => {
    let added = 0;
    let removed = 0;
    for (const tool of props.row.tools) {
      const stats = describeToolCall(tool, activeLanguage()).diffStats;
      if (stats) {
        added += stats.added;
        removed += stats.removed;
      }
    }
    return added > 0 || removed > 0 ? { added, removed } : undefined;
  };

  const detailsMask = signal<string | undefined>(undefined);
  let detailsY = 0;
  let detailsViewHeight = 0;
  let detailsContentHeight = 0;
  const syncDetailsMask = () => {
    const next = edgeFadeMask(detailsViewHeight, detailsY, detailsContentHeight - detailsViewHeight - detailsY);
    if (next !== untracked(detailsMask)) detailsMask.set(next);
  };
  const detailsScrolled = (e: ScrollEvent) => {
    detailsY = e.offset.y;
    detailsViewHeight = e.size.height;
    detailsContentHeight = e.contentSize.height;
    syncDetailsMask();
  };

  return (
    <Collapsible
      open={open() && hasBody()}
      reveal
      content={
        <Scroll
          testID="activity-details"
          style={{ maxHeight: props.maxHeight, maskImage: detailsMask() }}
          scrollEventThrottle={16}
          onLayout={(e) => {
            detailsViewHeight = e.bounds.size.height;
            syncDetailsMask();
          }}
          onScroll={detailsScrolled}
        >
          <View
            class="w-full"
            onLayout={(e) => {
              detailsContentHeight = e.bounds.size.height;
              syncDetailsMask();
            }}
          >
            <If
              when={only()}
              else={
                <View class="mb-1 gap-0.5 py-0.5">
                  <Each of={props.row.steps} key={(step) => step.id}>
                    {(step) => (
                      <If
                        when={step().kind === "thinking" ? (step() as Extract<Row, { kind: "thinking" }>) : undefined}
                        else={<ToolCallRow row={step() as ToolRow} compact />}
                      >
                        {(thinking) => <ThinkingRow row={thinking()} compact defaultOpen={props.row.tools.length === 0} />}
                      </If>
                    )}
                  </Each>
                </View>
              }
            >
              {(step) => (
                <If when={step().kind === "thinking" ? (step() as Extract<Row, { kind: "thinking" }>) : undefined} else={<ToolDetail row={step() as ToolRow} insetClass="ml-0" />}>
                  {(thinking) => <ReasoningBody text={thinking().text} />}
                </If>
              )}
            </If>
          </View>
        </Scroll>
      }
    >
      <View class="flex-row items-center gap-1.5">
        <ProcessLine open={open() && hasBody()} onPress={hasBody() ? () => toggle(props.row.id, false) : undefined}>
          <RollingText
            id={() => props.row.id}
            text={title}
            pace
            settled={() => !props.row.running}
            holdSettle={() => props.row.mayGrow === true}
            class={`min-w-0 shrink truncate ${uiType("sm")} text-muted-foreground`}
          />
          <If when={!open()}>
            <DiffBadge stats={aggregateDiff()} />
          </If>
        </ProcessLine>
        <If when={onlySession()}>
          {(sid) => (
            <IconButton
              icon="external"
              size="sm"
              label={tr("Open session", "打开会话")}
              onPress={() => openDaemonSession(sid())}
            />
          )}
        </If>
      </View>
    </Collapsible>
  );
}

/**
 * The line above a turn's work (the process header): "Working" and a timer
 * while it runs, how long it took after. It folds the turn's process rows,
 * which the list shows or leaves out; the header itself never changes height.
 */
/** A working turn's time so far, in whole seconds gone: "7s", "1m 4s". */
function runningFor(ms: number): string {
  const total = elapsedSeconds(ms);
  return total < 60 ? `${total}s` : `${Math.floor(total / 60)}m ${total % 60}s`;
}

function TurnHeaderView(props: { row: TurnHeaderRow }) {

  // The timer turns over as each second of the turn completes, not a second
  // after the header happened to mount: an interval of its own phase reads up
  // to a second behind, and the figure the turn ends on ("Finished in 13
  // seconds") would jump ahead of the one it was counting ("Working 12s").
  const now = signal(Date.now());
  effect(() => {
    if (!props.row.running) return;
    const startedAt = props.row.startedAt;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      const at = Date.now();
      now.set(at);
      const into = startedAt === undefined ? 0 : Math.max(0, at - startedAt) % 1000;
      timer = setTimeout(tick, 1000 - into + 4);
    };
    tick();
    cleanup(() => clearTimeout(timer));
  });
  const elapsed = () => (props.row.running && props.row.startedAt !== undefined ? Math.max(0, now() - props.row.startedAt) : undefined);
  const preview = () => {
    if (props.row.open) return "";
    const lang = activeLanguage();
    if (props.row.running) return props.row.activeStep ? describeActiveStep(props.row.activeStep, lang) : "";
    if (props.row.backgroundStep) return describeActiveStep(props.row.backgroundStep, lang);
    if (props.row.summaryTools?.length) return describeToolsSummary(props.row.summaryTools, lang);
    return "";
  };
  const shownPreview = keepLast(() => preview() || undefined, "");
  return (
    <View testID="turn-process-header" class="pb-0.5">
      <ProcessLine
        open={props.row.open}
        onPress={props.row.hasDetails ? () => toggleTurn(props.row.id, props.row.open, props.row.running) : undefined}
      >
        <If when={props.row.running}>
          <View class="mr-0.5 size-5 shrink-0 items-center justify-center">
            <Pip size={19} mood={pipMood()} />
          </View>
        </If>
        <RollingText
          id={() => props.row.id}
          text={() => describeTurn(props.row, activeLanguage())}
          class={`shrink-0 ${uiType("base")} ${props.row.running ? "font-medium text-foreground/85" : "text-subtle"}`}
        />
        <If when={elapsed() !== undefined && (elapsed() ?? 0) >= 1000}>
          <Text class={`shrink-0 font-mono ${uiType("xs")} tabular-nums text-subtle`}>{runningFor(elapsed() ?? 0)}</Text>
        </If>
        <Presence show={Boolean(preview())} scaleFrom={0.97} class="min-w-0 shrink flex-row items-center gap-1.5">
          <If when={!props.row.running}>
            <Text class={`shrink-0 ${uiType("sm")} text-subtle`}>·</Text>
          </If>
          <RollingText
            id={() => `${props.row.id}:preview`}
            text={() => shownPreview() ?? ""}
            pace
            settled={() => !props.row.running}
            class={`min-w-0 shrink truncate ${uiType("sm")} text-subtle`}
          />
        </Presence>
      </ProcessLine>
    </View>
  );
}

function BashRow(props: { row: Extract<Row, { kind: "bash" }> }) {
  const open = () => isOpen(props.row.id, true);
  const running = () => props.row.running;
  const error = () => !props.row.running && (props.row.cancelled || (props.row.exitCode !== undefined && props.row.exitCode !== 0));
  const note = () =>
    props.row.cancelled
      ? tr("cancelled", "已取消")
      : props.row.exitCode
        ? tr(`exit ${props.row.exitCode}`, `退出码 ${props.row.exitCode}`)
        : props.row.truncated
          ? tr("truncated", "已截断")
          : "";
  return (
    <Collapsible open={open()} reveal content={<Output text={props.row.output} standalone />}>
      <Disclosure open={open()} onPress={() => toggle(props.row.id, true)}>
        <LeadGlyph id={props.row.id} running={running()} error={error()} icon="terminal" />
        <RollingText
          id={() => props.row.id}
          text={() => (running() ? tr("Running", "正在运行") : tr("Ran", "运行"))}
          class={`shrink-0 ${uiType("sm")} text-muted-foreground`}
        />
        <Text class={`min-w-0 shrink truncate font-mono ${uiType("xs")} text-foreground`}>{props.row.command}</Text>
        <If when={note()}>
          <Text class={`shrink-0 ${uiType("xs")} tabular-nums text-subtle`}>{note()}</Text>
        </If>
      </Disclosure>
    </Collapsible>
  );
}

function NoticeRow(props: { row: Extract<Row, { kind: "notice" }> }) {
  const tone = () => (props.row.tone === "error" ? "destructive" : props.row.tone === "warning" ? "warning" : "muted-foreground");
  return (
    <View selectable class={`flex-row gap-2.5 rounded-lg corner-squircle border px-3 py-2.5 ${props.row.tone === "error" ? "border-destructive/30 bg-destructive/5" : "border-border bg-card"}`}>
      <View class="pt-px">
        <Icon name={props.row.tone === "info" ? "info" : "alert"} tone={tone()} />
      </View>
      <View class="flex-1 gap-0.5">
        <Text class={`${uiType("base")} font-medium text-foreground`}>{props.row.title}</Text>
        <If when={props.row.text}>
          <Text class={`${uiType("sm")} text-muted-foreground`}>{props.row.text}</Text>
        </If>
      </View>
    </View>
  );
}

const detailProse = () => ({ ...proseClasses(), root: `gap-2 ${readingType("sm")} text-muted-foreground` });

/** A mark in the conversation's history: where context was compacted, a branch summarized. */
function SummaryRow(props: { row: Extract<Row, { kind: "summary" }> }) {
  const open = () => isOpen(props.row.id, false);
  return (
    <Collapsible
      open={open()}
      reveal
      content={
        <View class="mt-2 rounded-lg corner-squircle border border-border bg-card px-3 py-2.5">
          <TextView markdown={props.row.text} selectable codeBlockScrollbar={false} tableScrollbar={false} classes={detailProse()} />
        </View>
      }
    >
      <View role="button" onPress={() => toggle(props.row.id, false)} accessibilityState={{ expanded: open() }} class={`${uiHeight(28)} select-none flex-row items-center gap-3 rounded-md corner-squircle ${FOCUS_RING}`}>
        <View class="h-px flex-1 bg-border" />
        <Icon name="compact" size={14} tone="subtle" />
        <Text class={`${uiType("xs")} text-muted-foreground`}>{props.row.title}</Text>
        <View class="h-px flex-1 bg-border" />
      </View>
    </Collapsible>
  );
}

function extractDeliveryMedia(markdown: string, cwd?: string, home?: string, rowId = "del"): MediaItem[] {
  const paths = [...extractMarkdownMediaPaths(markdown, cwd, home)];
  const out: MediaItem[] = [];
  paths.forEach((p, idx) => {
    const resolved = resolveMediaTarget(p, cwd, home);
    if (!resolved) return;
    if (resolved.kind === "image" || resolved.kind === "video" || resolved.kind === "audio" || resolved.kind === "document" || resolved.kind === "archive") {
      out.push({
        id: `${rowId}:m:${idx}`,
        kind: resolved.kind,
        title: resolved.title,
        ...(resolved.path ? { path: resolved.path } : {}),
        ...(resolved.src ? { src: resolved.src } : {}),
        ...(resolved.mimeType ? { mimeType: resolved.mimeType } : {}),
        ...(resolved.isMarkdown ? { isMarkdown: true } : {}),
      });
    }
  });
  return out;
}

/** An answer delivered back from another session (`<pipi-message>`): one labelled divider, its text unfolds. */
function DeliveryRow(props: { row: Extract<Row, { kind: "delivery" }> }) {
  const getStream = MediaStreamContext();
  const open = () => isOpen(props.row.id, false);
  const label = () =>
    props.row.status === "blocked"
      ? tr(`${props.row.fromTitle} is waiting on you`, `「${props.row.fromTitle}」在等待你确认`)
      : props.row.status === "failed"
        ? tr(`${props.row.fromTitle} stopped`, `「${props.row.fromTitle}」已停止`)
        : tr(`Answer from ${props.row.fromTitle}`, `「${props.row.fromTitle}」的回答`);
  const media = () => extractDeliveryMedia(props.row.text, workspacePath(), backend().home(), props.row.id);
  return (
    <Collapsible
      open={open()}
      reveal
      content={
        <View class="mt-2 gap-2 rounded-lg corner-squircle border border-border bg-card px-3 py-2.5">
          <TextView
            markdown={props.row.text}
            selectable
            links="report"
            codeBlockScrollbar={false}
            tableScrollbar={false}
            classes={detailProse()}
            onLinkPress={({ url }) => {
              const resolved = resolveMediaTarget(url, workspacePath(), backend().home());
              if (resolved?.path) void openLocalFile(resolved.path);
              else void openUrl(url);
            }}
            onImagePress={({ image }) => {
              const resolved = resolveMediaTarget(image.src, workspacePath(), backend().home());
              openMediaZoom(
                {
                  id: `del-img:${image.src}`,
                  kind: "image",
                  title: image.title || image.alt || resolved?.title || "image",
                  ...(resolved?.path ? { path: resolved.path } : {}),
                  src: resolved?.src ?? image.src,
                  ...(resolved?.remoteUrl ? { remoteUrl: resolved.remoteUrl } : {}),
                  ...(resolved?.mimeType ? { mimeType: resolved.mimeType } : {}),
                  ...(resolved?.data ? { data: resolved.data } : {}),
                },
                mediaZoomOptions(getStream, media()),
              );
            }}
          />
          <If when={media().length > 0}>
            <MediaGallery items={media()} compact />
          </If>
        </View>
      }
    >
      <View
        role="button"
        onPress={() => toggle(props.row.id, false)}
        accessibilityState={{ expanded: open() }}
        accessibilityLabel={label()}
        class={`${uiHeight(28)} select-none flex-row items-center gap-3 rounded-md corner-squircle ${FOCUS_RING}`}
      >
        <View class="h-px flex-1 bg-border" />
        <Icon name="agents" size={14} tone="brand-text" />
        <Text class={`max-w-96 truncate ${uiType("xs")} text-muted-foreground`}>{label()}</Text>
        <If when={props.row.status === "blocked"}>
          <View class="size-1.5 rounded-full bg-warning" />
        </If>
        <IconButton
          icon="external"
          size="sm"
          label={tr(`Open ${props.row.fromTitle}`, `打开「${props.row.fromTitle}」`)}
          onPress={() => openDaemonSession(props.row.from)}
        />
        <View class="h-px flex-1 bg-border" />
      </View>
    </Collapsible>
  );
}

/** A row of the chat's list: the projection's, with each reply as a row per block (or per SMS bubble in Pip mode). */
export type ChatRow = Exclude<DisplayRow, { kind: "text" }> | ProseRow | PipBubbleRow | ReplyActionsRow;

/** The room around a row: turns are set apart, a turn's steps sit close, a reply's blocks a line apart. */
const SPACING: Record<ChatRow["kind"], string> = {
  user: "pt-7",
  turn: "pt-2 pb-1",
  // Selection drops target line boxes only, so room between a reply's blocks is
  // where a drag dead-ends back to the block before; keep it thin.
  prose: "py-0.5",
  "pip-bubble": "py-[1.5px]",
  actions: "pb-1",
  media: "py-2",
  "pip-sessions": "pt-1.5 pb-0.5",
  "pip-footer": "pt-0.5 pb-1",
  thinking: "py-0.5",
  activity: "py-0.5",
  bash: "py-0.5",
  notice: "py-2",
  summary: "py-3",
  delivery: "py-3",
};

/** One row of the transcript. */
export function TranscriptRow(props: { row: ChatRow; activityMaxHeight: number }) {
  const pipSlot = (): PipRowSlot | undefined => ("pip" in props.row ? props.row.pip : undefined);
  const isPipProcess = () => isPersonaSession() && processTurns.has(props.row.id);
  const isStreamingRow = () =>
    (props.row.kind === "turn" && props.row.running) ||
    (props.row.kind === "thinking" && props.row.streaming) ||
    (props.row.kind === "activity" && props.row.running);
  const fold = useProcessFold(() => props.row.id);
  /** A row of a turn's process sits one indent in, its words aligned under the running header's own — the grouping is the indent and the quieter face, never a drawn line. */
  const indentedProcess = () =>
    (props.row.kind === "activity" || props.row.kind === "thinking" || props.row.kind === "bash") && processTurns.has(props.row.id);
  const entrance = useRowEntrance(
    () => props.row.id,
    isStreamingRow,
    () => {
      if (fold.isFolding()) return true;
      // SMS bubbles (Pip incoming bubbles and outgoing user SMS bubbles) run their own
      // corner-anchored iMessage pop-in animation (`useSmsBubbleEntrance`).
      if (props.row.kind === "pip-bubble") return "delegate";
      if (props.row.kind === "user" && props.row.sms) return "delegate";
      if (props.row.kind === "prose") {
        return !props.row.pip || isRowSeen(props.row.rowId);
      }
      return false;
    },
    () => props.row.kind === "user" || Boolean(pipSlot()),
  );
  const of = <K extends ChatRow["kind"]>(kind: K) => (props.row.kind === kind ? (props.row as Extract<ChatRow, { kind: K }>) : undefined);
  const hasTapback = () => {
    if (!isPersonaSession()) return false;
    const scope = `${activePersonaId() ?? "default"}:${currentDaemonSession()?.id ?? "unattached"}`;
    if (props.row.kind === "user" && props.row.sms) {
      const target = userAnchor(transcriptRows(), props.row.id) ?? props.row.id;
      return Boolean(messageInteraction(scope, target)?.tapback);
    }
    if (props.row.kind === "pip-bubble") {
      const target = pipAnchor(transcriptRows(), props.row.rowId, props.row.bubbleIndex) ?? props.row.id;
      return Boolean(messageInteraction(scope, target)?.tapback);
    }
    return false;
  };
  const spacing = () => {
    if (props.row.kind === "user" && props.row.sms) {
      if (props.row.sms.first) return "pt-3.5 pb-[1.5px]";
      return hasTapback() ? "pt-3 pb-[1.5px]" : "py-[1.5px]";
    }
    if (props.row.kind === "pip-bubble") {
      if (props.row.pip.lead) return "pt-3.5 pb-[1.5px]";
      return hasTapback() ? "pt-3 pb-[1.5px]" : "py-[1.5px]";
    }
    if (pipSlot()?.lead) return "pt-3.5 pb-0.5";
    return SPACING[props.row.kind];
  };
  const renderBody = () => (
    <>
      <If when={of("user")}>{(row) => <UserRow row={row()} />}</If>
      <If when={of("turn")}>{(row) => <TurnHeaderView row={row()} />}</If>
      <If when={of("activity")}>{(row) => <ActivityView row={row()} maxHeight={props.activityMaxHeight} />}</If>
      <If when={of("prose")}>{(row) => <ProseBlock row={row()} />}</If>
      <If when={of("pip-bubble")}>
        {(row) => (
          <PipBubbleView
            row={row()}
            processOpen={() => {
              const turnId = row().pip.meta?.turnId;
              return turnId ? (chosen(turnId) ?? false) : false;
            }}
            onToggleProcess={() => {
              const turnId = row().pip.meta?.turnId;
              if (turnId) toggleTurn(turnId, chosen(turnId) ?? false, false);
            }}
          />
        )}
      </If>
      <If when={of("media")}>{(row) => <MediaGallery title={row().title} items={row().items} />}</If>
      <If when={of("pip-sessions")}>{(row) => <PipSessionsView row={row()} />}</If>
      <If when={of("pip-footer")}>
        {(row) => (
          <PipFooterView
            row={row()}
            renderCopy={(id, text, cls) => <CopyButton id={id} text={text} label={tr("Copy reply", "复制回复")} class={cls} />}
          />
        )}
      </If>
      <If when={of("actions")}>{(row) => <ReplyActionsView row={row()} />}</If>
      <If when={of("thinking")}>{(row) => <ThinkingRow row={row()} />}</If>
      <If when={of("bash")}>{(row) => <BashRow row={row()} />}</If>
      <If when={of("notice")}>{(row) => <NoticeRow row={row()} />}</If>
      <If when={of("summary")}>{(row) => <SummaryRow row={row()} />}</If>
      <If when={of("delivery")}>{(row) => <DeliveryRow row={row()} />}</If>
    </>
  );

  // `pip-bubble` owns its own bottom-left avatar gutter; other Pip rows (media,
  // delegated session cards, footer) align cleanly to the same 40pt bubble edge.
  const needsOuterPipAvatar = () => props.row.kind !== "pip-bubble" && Boolean(pipSlot()?.tail);
  const needsOuterPipIndent = () => props.row.kind !== "pip-bubble" && Boolean(pipSlot()?.indent);

  return (
    <Collapsible
      open={fold.open()}
      reveal={fold.reveal()}
      content={
        <View class={`w-full max-w-180 self-center ${spacing()}${fold.open() ? "" : " pointer-events-none"}`} style={entrance}>
          <View style={fold.style} class={!isPipProcess() && indentedProcess() ? "pl-7" : undefined}>
            <If
              when={needsOuterPipAvatar()}
              else={
                <If
                  when={needsOuterPipIndent()}
                  else={
                    <If when={isPipProcess()} else={renderBody()}>
                      <View class="pl-10">
                        <View class="border-l border-hairline pl-3">{renderBody()}</View>
                      </View>
                    </If>
                  }
                >
                  <View class="pl-10">{renderBody()}</View>
                </If>
              }
            >
              <View class="flex-row items-end gap-3">
                <View class="w-7 shrink-0 pb-0.5">
                  <PipAvatarBadge
                    rowId={() => props.row.id}
                    turnMeta={() => pipSlot()?.meta}
                    processOpen={() => {
                      const turnId = pipSlot()?.meta?.turnId;
                      return turnId ? (chosen(turnId) ?? false) : false;
                    }}
                    onToggleProcess={() => {
                      const turnId = pipSlot()?.meta?.turnId;
                      if (turnId) toggleTurn(turnId, chosen(turnId) ?? false, false);
                    }}
                  />
                </View>
                <View class="min-w-0 flex-1">{renderBody()}</View>
              </View>
            </If>
          </View>
        </View>
      }
    />
  );
}
