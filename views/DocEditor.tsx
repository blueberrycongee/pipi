import {
  batch,
  cleanup,
  colorScheme,
  computed,
  createAnimatedValue,
  effect,
  keymap,
  platform,
  reduceMotion,
  signal,
  Text,
  token,
  untracked,
  View,
  type Signal,
} from "nsh";
import type { JSX } from "nsh";
import {
  Button as BaseButton,
  chain,
  deleteRange,
  exitSuggestion,
  insertContent,
  insertTable,
  RichEditor,
  setBlockType,
  toggleList,
  toggleMark,
  wrapIn,
  type RichCommand,
  type RichEditorSession,
} from "nsh/base";
import { Menu, type MenuItem } from "nsh/desktop";
import { compactPath, tildePath } from "../lib/format";
import { topBarHeight } from "../lib/layout";
import { activeLanguage, tr } from "../lib/i18n";
import { currentView, showChat, wallpaper } from "../store/app";
import { backend } from "../store/backend";
import { ensureDoc, isNote, revealDoc, SLASH_KEYS, syncDoc, type MarkdownDoc } from "../store/docs";
import { ensureDocAssistant, type DocSelection } from "../store/doc-assistant";
import { addDocToNewSession, addDocToTab, docChatTargets, docDraftOrigin, openTabs, returnDraftDocToOrigin } from "../store/tabs";
import { Icon, type IconName } from "../ui/Icon";
import { type DeckPane, DURATION, EASING, keepLast, LayerActive, ViewDeck } from "../ui/motion";
import { FOCUS_RING, GLASS_REGULAR, POPUP, PRESS, PRESS_SCALE } from "../ui/styles";
import { readingType, codeType } from "../ui/typography";
import { tip } from "../ui/Tip";
import {
  createDocOrbPointerBridge,
  DocActivityRibbon,
  DocDraftingSkeleton,
  DocFloatingOrb,
  DocRefreshSweep,
  DocSkeleton,
  DocUpdatePill,
} from "./DocOrb";

interface SlashItem {
  id: string;
  group: 0 | 1 | 2;
  label: () => string;
  hint: string;
  keys: string;
  glyph?: string;
  icon?: IconName;
  make: () => RichCommand;
}

/**
 * What `/` offers: block kinds as Notion calls them, each a command on the
 * session. Labels localize at render; `keys` are what a query may also match
 * (the Markdown habit, the short name), whatever language the label is in.
 */
const SLASH_ITEMS: SlashItem[] = [
  { id: "h1", group: 0, glyph: "H1", label: () => tr("Heading 1", "一级标题"), hint: "#", keys: "h1 heading title 标题 biaoti", make: () => setBlockType("heading", { level: 1 }) },
  { id: "h2", group: 0, glyph: "H2", label: () => tr("Heading 2", "二级标题"), hint: "##", keys: "h2 heading 标题 biaoti", make: () => setBlockType("heading", { level: 2 }) },
  { id: "h3", group: 0, glyph: "H3", label: () => tr("Heading 3", "三级标题"), hint: "###", keys: "h3 heading 标题 biaoti", make: () => setBlockType("heading", { level: 3 }) },
  { id: "bullet", group: 1, icon: "listBullet", label: () => tr("Bullet List", "无序列表"), hint: "-", keys: "ul bullet list 列表 liebiao", make: () => toggleList("bulletList", "listItem") },
  { id: "ordered", group: 1, icon: "listOrdered", label: () => tr("Numbered List", "有序列表"), hint: "1.", keys: "ol ordered numbered list 列表 liebiao", make: () => toggleList("orderedList", "listItem") },
  { id: "task", group: 1, icon: "listTask", label: () => tr("Task List", "任务列表"), hint: "[ ]", keys: "todo task check 任务 待办 renwu daiban", make: () => toggleList("taskList", "taskItem") },
  { id: "quote", group: 2, icon: "quote", label: () => tr("Quote", "引用"), hint: ">", keys: "quote blockquote 引用 yinyong", make: () => wrapIn("blockquote") },
  { id: "code", group: 2, icon: "code", label: () => tr("Code Block", "代码块"), hint: "```", keys: "code pre 代码 daima", make: () => setBlockType("codeBlock") },
  { id: "table", group: 2, icon: "table", label: () => tr("Table", "表格"), hint: "3×3", keys: "table grid 表格 biaoge", make: () => insertTable({ rows: 3, cols: 3, withHeaderRow: true }) },
  { id: "rule", group: 2, icon: "minus", label: () => tr("Divider", "分割线"), hint: "---", keys: "hr divider rule line 分割线 fengexian", make: () => insertContent([{ type: "horizontalRule" }]) },
];

/** A query matches where a word starts — "h" lists the headings, not everything with an h in it. */
function slashFilter(query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return SLASH_ITEMS;
  return SLASH_ITEMS.filter((item) => `${item.label()} ${item.keys}`.toLowerCase().split(/\s+/).some((word) => word.startsWith(q)));
}

/** The `/` menu as the editor has it now: which trigger, what it covers, what was typed after it. */
interface SlashState {
  key: string;
  id: string;
  from: number;
  to: number;
  query: string;
}

/**
 * The document's typography: the conversation's own scale (`views/Prose.tsx`),
 * given room to be written in. The editor lays blocks out as a flow, with no
 * gap of its own between them, so the rhythm is each block's margins: a
 * paragraph stands 12 clear of the next, a heading opens a section with more
 * above it than below, and what is boxed (code, a table, a quote) keeps a
 * little more room than prose.
 *
 * Node classes resolve text attributes per-property, innermost first: a
 * paragraph inside a wrapper leaves its size and tone unset so the wrapper's
 * class fills them — the base face (`text-md` on `foreground`) lives on
 * `content`, so a table cell's `sm`, a header cell's `xs` muted, and a
 * blockquote's muted reach their inner paragraphs exactly as the
 * transcript's table and quote read.
 */
const editorClasses = computed(() => ({
  root: "flex-1",
  content: `mx-auto w-full max-w-180 px-10 ${readingType()} text-foreground`,
  placeholder: "text-subtle",
  caret: "bg-brand",
  selection: "bg-brand/15 dark:bg-brand/25",
  gapCursor: "bg-brand",
  dropCursor: "bg-brand",
  selectedNode: "rounded-lg corner-squircle ring-2 ring-ring",
  composition: "underline",
  taskCheckbox:
    "mr-2 mt-1 size-3.5 rounded-xs corner-squircle border border-hairline-focus bg-card transition-all duration-150 ease-out-quint hover:border-brand/70 active:scale-90 motion-reduce:transition-none motion-reduce:active:scale-100 checked:border-brand checked:bg-brand",
  listMarker: `${readingType()} leading-relaxed text-subtle tabular-nums`,
  selectedCell: "bg-brand-soft",
  tableGrip: "rounded-full bg-hairline-hover transition-colors duration-100 hover:bg-brand",
  tableResizeHandle: "bg-brand/60",
  tableDropIndicator: "bg-brand",
  nodes: {
    paragraph: "my-1.5 leading-relaxed",
    "heading[level=1]": `mb-2 mt-6 ${readingType("2xl")} font-semibold leading-tight tracking-tight text-foreground`,
    "heading[level=2]": `mb-1.5 mt-6 ${readingType("xl")} font-semibold leading-snug tracking-tight text-foreground`,
    "heading[level=3]": `mb-1 mt-5 ${readingType("lg")} font-semibold leading-snug text-foreground`,
    heading: `mb-1 mt-4 ${readingType()} font-semibold leading-snug text-foreground`,
    bulletList: "my-1 pl-6",
    orderedList: "my-1 pl-6",
    taskList: "my-1 pl-1",
    // A paragraph's own margins would set a list's items a paragraph apart: an item takes most of them back.
    listItem: "-my-1",
    taskItem: "-my-1",
    "taskItem[checked=true]": "-my-1 opacity-60",
    blockquote: "my-2.5 border-l-2 border-border pl-3.5 text-muted-foreground",
    codeBlock: `my-2.5 rounded-xl corner-squircle border border-border bg-sunken p-3.5 font-mono ${codeType()} leading-relaxed text-foreground`,
    horizontalRule: "my-5 h-px bg-border",
    table: "my-2.5 w-full rounded-lg corner-squircle border border-border",
    tableCell: `border border-border px-3 py-1.5 ${readingType("sm")} leading-relaxed`,
    tableHeader: `border border-border bg-muted px-3 py-1.5 ${readingType("xs")} font-semibold leading-relaxed text-muted-foreground`,
  },
  marks: {
    bold: "font-semibold",
    italic: "italic",
    strike: "text-muted-foreground line-through",
    code: `rounded-sm corner-squircle bg-muted px-1 font-mono ${readingType("sm")} text-foreground`,
    link: "text-brand-text underline",
  },
}));

const SLASH_MENU_W = 240;
const SLASH_ROW_H = 32;
const SLASH_SEP_H = 9;
const EDGE_MASK_STEPS = 6;
const smoothStep = (t: number) => t * t * (3 - 2 * t);

function slashRowY(index: number, grouped: boolean): number {
  if (!grouped) return index * SLASH_ROW_H;
  return index * SLASH_ROW_H + (index >= 3 ? SLASH_SEP_H : 0) + (index >= 6 ? SLASH_SEP_H : 0);
}

/** Soft scroll edge fade matched to the current background token. */
function edgeFade(direction: "to bottom" | "to top", solidPx: number, fadePx: number): string {
  // Subscribe to scheme changes so theme switches immediately re-tint the scroll veil.
  colorScheme();
  let hex = String(token("background")).trim();
  if (hex.length === 4 && hex.startsWith("#")) {
    hex = `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
  }
  const base = hex.slice(0, 7);
  const stop = (alpha: number, px: number) => {
    const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
      .toString(16)
      .padStart(2, "0");
    return `${base}${a} ${Math.round(px * 10) / 10}px`;
  };
  const stops: string[] = [];
  if (solidPx > 0) stops.push(stop(1, 0), stop(1, solidPx));
  for (let i = 0; i <= EDGE_MASK_STEPS; i++) {
    const t = i / EDGE_MASK_STEPS;
    stops.push(stop(1 - smoothStep(t), solidPx + fadePx * t));
  }
  return `linear-gradient(${direction}, ${stops.join(", ")})`;
}

const CJK_RUN_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]+/g;
const WORD_RE = /[A-Za-z0-9\u00C0-\u024F\u0400-\u04FF]+(?:['’-][A-Za-z0-9\u00C0-\u024F\u0400-\u04FF]+)*/g;

/** Words in a selected passage, CJK-aware without relying on `\p{...}` in QuickJS. */
function countSelectionWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  let total = 0;
  const runs = trimmed.match(CJK_RUN_RE);
  if (runs) {
    for (let i = 0; i < runs.length; i++) total += runs[i]!.length;
  }
  const words = trimmed.match(WORD_RE);
  if (words) total += words.length;
  return total;
}

/** Brief settle pause before raising the selection bubble after a keyboard sweep or mouse-down before drag. */
const SELECTION_SETTLE_MS = 110;
/** Two keyboard selection steps within this window hide an already-open bubble until the sweep settles. */
const RAPID_EXTEND_MS = 180;
/** Safety settle when a drag leaves the app window and releases on the desktop without a window mouse-up. */
const OUTSIDE_RELEASE_MS = 260;

const pointerUpListeners = new Set<() => void>();
/** Notifies open document editors when a mouse button releases anywhere in the window. */
export function notifyDocPointerUp() {
  for (const fn of pointerUpListeners) fn();
}

/**
 * A menu at the caret settles in: opacity leads, with a breath of scale and a
 * whisper of directional travel from the caret — it never jumps or overshoots.
 */
function PopIn(props: { placement?: "top" | "bottom"; children: JSX.Element }) {
  const still = untracked(reduceMotion);
  const startY = props.placement === "bottom" ? -4 : 4;
  const opacity = createAnimatedValue(still ? 1 : 0);
  const scale = createAnimatedValue(still ? 1 : 0.97);
  const translateY = createAnimatedValue(still ? 0 : startY);
  if (!still) {
    void opacity.timing(1, { duration: 130, easing: EASING.entrance });
    void scale.timing(1, { duration: 140, easing: EASING.signature });
    void translateY.timing(0, { duration: 140, easing: EASING.signature });
  }
  cleanup(() => {
    void opacity.stop();
    void scale.stop();
    void translateY.stop();
  });
  return <View style={{ opacity, transform: [{ translateY }, { scale }] }}>{props.children}</View>;
}

/** The `/` block insertion menu: quiet icons, grouped blocks, and a single sliding selection pill. */
function SlashMenu(props: {
  items: () => SlashItem[];
  index: () => number;
  query: () => string;
  onPick: (item: SlashItem) => void;
  onHover: (index: number) => void;
}) {
  const grouped = () => !props.query().trim() && props.items().length === SLASH_ITEMS.length;
  const clampedIndex = () => Math.min(props.index(), Math.max(0, props.items().length - 1));
  const pillY = createAnimatedValue(untracked(() => slashRowY(clampedIndex(), grouped())));
  let lastCount = untracked(() => props.items().length);
  let lastGrouped = untracked(grouped);

  effect(() => {
    const list = props.items();
    const g = grouped();
    const idx = clampedIndex();
    const target = slashRowY(idx, g);
    const sameShape = list.length === lastCount && g === lastGrouped;
    lastCount = list.length;
    lastGrouped = g;
    untracked(() => {
      void pillY.stop();
      if (!sameShape || reduceMotion()) pillY.set(target);
      else void pillY.timing(target, { duration: 110, easing: EASING.signature });
    });
  });
  cleanup(() => void pillY.stop());

  return (
    /* The bubble centers on the caret; a clear half to the left leaves the menu's own edge there. */
    <View class="flex-row justify-end" style={{ width: SLASH_MENU_W * 2, pointerEvents: "box-none" }}>
      <PopIn placement="bottom">
        <View testID="doc-slash-menu" class={`relative p-1 ${POPUP}`} style={{ width: SLASH_MENU_W, ...GLASS_REGULAR }}>
          <View
            class="pointer-events-none absolute inset-x-1 top-1 h-8 rounded-md corner-squircle bg-accent"
            style={{ transform: [{ translateY: pillY }] }}
          />
          <Each of={props.items()} key={(item) => item.id}>
            {(item, at) => {
              const active = () => at() === clampedIndex();
              const needsDivider = () => grouped() && (at() === 3 || at() === 6);
              return (
                <>
                  <If when={needsDivider()}>
                    <View class="mx-2 my-1 h-px bg-border" />
                  </If>
                  <BaseButton
                    onPress={() => props.onPick(item())}
                    onMouseMove={() => {
                      if (props.index() !== at()) props.onHover(at());
                    }}
                    selected={active()}
                    class="h-8 flex-row items-center gap-2 rounded-md corner-squircle px-1.5"
                  >
                    <View class="size-6 shrink-0 items-center justify-center rounded-md corner-squircle bg-muted/60">
                      <If
                        when={item().icon}
                        else={
                          <Text class={`text-2xs font-semibold ${active() ? "text-foreground" : "text-muted-foreground"}`}>
                            {item().glyph ?? ""}
                          </Text>
                        }
                      >
                        {(iconName) => <Icon name={iconName()} size={13} tone={active() ? "foreground" : "muted-foreground"} />}
                      </If>
                    </View>
                    <Text class="flex-1 text-sm text-foreground">{item().label()}</Text>
                    <Text class={`font-mono text-2xs ${active() ? "text-muted-foreground" : "text-subtle"}`}>{item().hint}</Text>
                  </BaseButton>
                </>
              );
            }}
          </Each>
        </View>
      </PopIn>
    </View>
  );
}

/** One button of the selection's bubble menu: a mark the session toggles. */
function BubbleButton(props: {
  session: RichEditorSession;
  mark: string;
  label: string;
  title: string;
  shortcut?: string;
  class?: string;
  rev: () => number;
}) {
  const on = computed(() => {
    props.rev();
    return props.session.isActive(props.mark);
  });
  return (
    <BaseButton
      onPress={() => props.session.run(toggleMark(props.mark))}
      accessibilityLabel={props.title}
      selected={on()}
      tooltip={tip(props.title, props.shortcut, "top")}
      class={`group h-7 min-w-7 items-center justify-center rounded-md corner-squircle px-1.5 transition-colors duration-100 ease-out-quint active:scale-[0.94] motion-reduce:transition-none motion-reduce:active:scale-100 ${on() ? "bg-brand-soft" : "hover:bg-accent"}`}
    >
      <Text
        class={`text-sm transition-colors duration-100 ${props.class ?? ""} ${on() ? "text-brand-text" : "text-muted-foreground group-hover:text-foreground"}`}
      >
        {props.label}
      </Text>
    </BaseButton>
  );
}

interface EditorPointerBridge {
  onMove: (pressed: boolean) => void;
  onLeave: () => void;
  onUp: () => void;
}

/**
 * The editor on a document whose file has been read. It listens to the
 * session once, and keeps active selection drags completely free of glass
 * bubble reflows, FFI text copies, word-count regexes, and cross-pane signal
 * churn — settling the bubble menu, footer count, and AI selection context in
 * one batch the instant the drag releases (or a keyboard sweep pauses).
 */
function Editor(props: {
  doc: MarkdownDoc;
  session: RichEditorSession;
  picked: { (): boolean; set: (on: boolean) => void };
  pickedWords: Signal<number>;
  liveSelection: Signal<DocSelection | undefined>;
  drafting: () => boolean;
  onDraggingChange: (dragging: boolean) => void;
  bindPointer: (bridge: EditorPointerBridge) => () => void;
  bindSelectionReader: (reader: () => DocSelection | undefined) => () => void;
}) {
  const session = props.session;
  const slash = signal<SlashState | null>(null);
  const index = signal(0);
  /** Text selection has settled: footer count and AI selection scope follow this. */
  const picked = props.picked;
  /** Selection bubble menu is mounted (kept unmounted while actively dragging or sweeping). */
  const bubbleOpen = signal(false);
  /** Ticks when a settled selection or its marks change, so the marks' buttons follow. */
  const rev = signal(0);
  /** Captured keys already answered, by trigger: a count that only grows, never replayed. */
  const keysSeen = new Map<string, number>();

  let pointerDown = false;
  let pointerOutside = false;
  let dragSelecting = false;
  let lastSyncedRev = -1;
  let lastFrom = -1;
  let lastTo = -1;
  let committedFrom = -1;
  let committedTo = -1;
  let committedRev = -1;
  let lastRangeChangeAt = 0;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let outsideTimer: ReturnType<typeof setTimeout> | undefined;

  const items = computed(() => slashFilter(slash()?.query ?? ""));

  function apply(item: SlashItem | undefined) {
    const s = slash();
    if (!s || !item) return;
    slash.set(null);
    // One step: the typed `/h1` leaves and the block arrives together, so one undo takes both back.
    if (!session.run(chain([deleteRange({ from: s.from, to: s.to }), item.make()]))) {
      session.run(deleteRange({ from: s.from, to: s.to }));
      session.run(item.make());
    }
    session.focus();
  }

  function clearTimers() {
    if (settleTimer !== undefined) {
      clearTimeout(settleTimer);
      settleTimer = undefined;
    }
    if (outsideTimer !== undefined) {
      clearTimeout(outsideTimer);
      outsideTimer = undefined;
    }
  }

  function setDragSelecting(next: boolean) {
    if (dragSelecting === next) return;
    dragSelecting = next;
    props.onDraggingChange(next);
  }

  function rawTextRange(): { from: number; to: number } | undefined {
    const sel = session.selection as { type?: string; anchor?: number; head?: number };
    if (sel.type !== "text" || sel.anchor === undefined || sel.head === undefined || sel.anchor === sel.head) {
      return undefined;
    }
    return { from: Math.min(sel.anchor, sel.head), to: Math.max(sel.anchor, sel.head) };
  }

  /** Reads the live selection synchronously on demand (⌘J, orb click/hover), reusing the settled cache when current. */
  function readLiveSelection(): DocSelection | undefined {
    const range = rawTextRange();
    if (!range) return undefined;
    const cached = untracked(props.liveSelection);
    if (cached && cached.from === range.from && cached.to === range.to && committedRev === session.revision) {
      return cached;
    }
    const text = session.textBetween(range.from, range.to, "\n\n").trim();
    if (!text) return undefined;
    return { from: range.from, to: range.to, text, words: countSelectionWords(text) };
  }

  function clearSelectionState() {
    clearTimers();
    lastFrom = -1;
    lastTo = -1;
    committedFrom = -1;
    committedTo = -1;
    committedRev = -1;
    batch(() => {
      if (untracked(bubbleOpen)) bubbleOpen.set(false);
      if (untracked(picked)) picked.set(false);
      if (untracked(props.pickedWords) !== 0) props.pickedWords.set(0);
      if (untracked(props.liveSelection) !== undefined) props.liveSelection.set(undefined);
    });
  }

  function commitSelection() {
    clearTimers();
    const range = rawTextRange();
    if (!range) {
      clearSelectionState();
      return;
    }
    const { from, to } = range;
    lastFrom = from;
    lastTo = to;

    const revNow = session.revision;
    lastSyncedRev = revNow;
    const prev = untracked(props.liveSelection);
    let nextSel = prev;
    let words = untracked(props.pickedWords);
    if (from !== committedFrom || to !== committedTo || revNow !== committedRev) {
      const text = session.textBetween(from, to, "\n\n").trim();
      words = countSelectionWords(text);
      nextSel = text
        ? prev && prev.from === from && prev.to === to && prev.text === text && prev.words === words
          ? prev
          : { from, to, text, words }
        : undefined;
      committedFrom = from;
      committedTo = to;
      committedRev = revNow;
    }

    batch(() => {
      if (!untracked(picked)) picked.set(true);
      if (!untracked(bubbleOpen)) bubbleOpen.set(true);
      rev.update((n) => n + 1);
      if (untracked(props.pickedWords) !== words) props.pickedWords.set(words);
      if (untracked(props.liveSelection) !== nextSel) props.liveSelection.set(nextSel);
    });
  }

  function scheduleSettle(delayMs = SELECTION_SETTLE_MS) {
    if (settleTimer !== undefined) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = undefined;
      if (!dragSelecting) commitSelection();
    }, delayMs);
  }

  function scheduleOutsideFallback() {
    if (outsideTimer !== undefined) clearTimeout(outsideTimer);
    outsideTimer = setTimeout(() => {
      outsideTimer = undefined;
      if ((pointerDown || dragSelecting) && pointerOutside) {
        pointerDown = false;
        setDragSelecting(false);
        commitSelection();
      }
    }, OUTSIDE_RELEASE_MS);
  }

  function finishPointerDrag() {
    const wasDragging = dragSelecting;
    const hadPending = settleTimer !== undefined;
    const wasDown = pointerDown;
    pointerDown = false;
    setDragSelecting(false);
    if (outsideTimer !== undefined) {
      clearTimeout(outsideTimer);
      outsideTimer = undefined;
    }
    if (!wasDragging && !hadPending && !wasDown && (untracked(bubbleOpen) || !session.isFocused)) {
      return;
    }
    const range = rawTextRange();
    if (!range) {
      if (wasDragging || hadPending || untracked(picked) || untracked(bubbleOpen)) clearSelectionState();
      return;
    }
    // Commit immediately on mouse release (zero lag after drag or double-click).
    if (wasDragging || hadPending || (wasDown && !untracked(bubbleOpen)) || (session.isFocused && !untracked(bubbleOpen))) {
      commitSelection();
    }
  }

  function sync(initial = false) {
    const revNow = session.revision;
    const slashActive = untracked(slash) !== null;
    // Coalesce duplicate or queued transactions that observe the same settled revision.
    if (!initial && !slashActive && revNow === lastSyncedRev) return;
    lastSyncedRev = revNow;

    if (!dragSelecting || slashActive) {
      let found: SlashState | null = null;
      for (const key of SLASH_KEYS) {
        const s = session.suggestion(key);
        if (!s) continue;
        const seen = keysSeen.get(key);
        const pressed = s.active && seen !== undefined && s.keyCount > seen ? s.lastKey : undefined;
        keysSeen.set(key, s.keyCount);
        if (!s.active || found) continue;
        found = { key, id: s.decorationId ?? "", from: s.range.from, to: s.range.to, query: s.query ?? "" };
        const before = untracked(slash);
        if (before?.id !== found.id) index.set(0);
        const list = slashFilter(found.query);
        if (!list.length) {
          // Nothing to offer: the menu must not keep Enter and Tab from the text.
          session.run(exitSuggestion(key));
          found = null;
          continue;
        }
        if (before && before.query !== found.query) index.set(0);
        if (pressed === "ArrowUp") index.update((i) => (Math.min(i, list.length - 1) - 1 + list.length) % list.length);
        else if (pressed === "ArrowDown") index.update((i) => (i + 1) % list.length);
        else if (pressed === "Enter" || pressed === "Tab") {
          slash.set(found);
          apply(list[Math.min(index(), list.length - 1)]);
          return;
        }
      }
      const before = untracked(slash);
      if (found?.id !== before?.id || found?.from !== before?.from || found?.to !== before?.to || found?.query !== before?.query) {
        slash.set(found);
      }
    }

    const range = rawTextRange();
    if (!range) {
      clearSelectionState();
      return;
    }

    if (initial) {
      commitSelection();
      return;
    }

    const rangeChanged = range.from !== lastFrom || range.to !== lastTo;
    lastFrom = range.from;
    lastTo = range.to;

    if (pointerDown && (rangeChanged || dragSelecting)) {
      // Actively dragging a text selection: keep the glass bubble unmounted and defer FFI/word-count work until release.
      setDragSelecting(true);
      if (untracked(bubbleOpen)) bubbleOpen.set(false);
      if (settleTimer !== undefined) {
        clearTimeout(settleTimer);
        settleTimer = undefined;
      }
      if (pointerOutside) scheduleOutsideFallback();
      return;
    }

    if (!rangeChanged && untracked(bubbleOpen)) {
      // Same range (e.g. toggling Bold/Italic): refresh mark buttons immediately without hiding the bar.
      commitSelection();
      return;
    }

    const now = Date.now();
    const rapid = now - lastRangeChangeAt < RAPID_EXTEND_MS;
    lastRangeChangeAt = now;
    if (untracked(bubbleOpen) && rapid) {
      bubbleOpen.set(false);
    }
    scheduleSettle(SELECTION_SETTLE_MS);
  }

  const stopTx = session.on("transaction", () => sync(false));
  const unbindPointer = props.bindPointer({
    onMove(pressed) {
      pointerOutside = false;
      if (outsideTimer !== undefined) {
        clearTimeout(outsideTimer);
        outsideTimer = undefined;
      }
      if (pressed) {
        pointerDown = true;
      } else if (pointerDown || dragSelecting) {
        finishPointerDrag();
      }
    },
    onLeave() {
      pointerOutside = true;
      if (pointerDown || dragSelecting) scheduleOutsideFallback();
    },
    onUp: finishPointerDrag,
  });
  const unbindReader = props.bindSelectionReader(readLiveSelection);
  cleanup(() => {
    clearTimers();
    stopTx();
    pointerUpListeners.delete(finishPointerDrag);
    unbindPointer();
    unbindReader();
    setDragSelecting(false);
  });
  sync(true);

  // In front on the deck: the caret is the document's. Asked again a turn
  // later — the pane is laid out (`display`) in the commit this runs in.
  const layerActive = LayerActive();
  effect(() => {
    if (!layerActive()) {
      clearTimers();
      pointerDown = false;
      setDragSelecting(false);
      // Behind the chat (or a sheet): the keyboard is not the document's.
      if (untracked(() => session.isFocused)) session.blur();
      return;
    }
    // Coming forward, the document is what its file says now: an agent may have written it meanwhile.
    void syncDoc(props.doc.path);
    session.focus();
    const timer = setTimeout(() => session.focus(), 0);
    pointerUpListeners.add(finishPointerDrag);
    const unbind = keymap.bind(
      "mod+j",
      () => ensureDocAssistant(props.doc.path).requestFocus(readLiveSelection()),
      { when: "always" },
    );
    cleanup(() => {
      clearTimeout(timer);
      pointerUpListeners.delete(finishPointerDrag);
      unbind();
    });
  });

  return (
    <View class="relative min-h-0 flex-1">
      <RichEditor
        editor={session}
        autoFocus
        accessibilityLabel={tr("Document", "文档")}
        placeholder={props.drafting() ? "" : tr("Write a brief, a draft, anything…  “/” for blocks", "写需求、写文章、随手记…  输入“/”插入块")}
        placeholders={{
          heading: tr("Heading", "标题"),
          blockquote: tr("Quote", "引用"),
          codeBlock: tr("Code", "代码"),
        }}
        classes={editorClasses()}
        styles={{ content: { paddingTop: topBarHeight() + 28, paddingBottom: 156 } }}
        bubbleMenuPlacement={slash() ? "bottom" : "top"}
        bubbleMenuOffset={slash() ? 6 : 8}
        bubbleMenu={
          <If
            when={slash()}
            else={
              <If when={bubbleOpen()}>
                <PopIn placement="top">
                  <View class={`flex-row items-center gap-0.5 p-1 ${POPUP}`} style={GLASS_REGULAR}>
                    <If when={!props.doc.readOnly()}>
                      <BubbleButton session={session} mark="bold" label="B" title={tr("Bold", "加粗")} shortcut="mod+b" class="font-semibold" rev={rev} />
                      <BubbleButton session={session} mark="italic" label="I" title={tr("Italic", "斜体")} shortcut="mod+i" class="italic" rev={rev} />
                      <BubbleButton session={session} mark="strike" label="S" title={tr("Strikethrough", "删除线")} shortcut="mod+shift+s" class="line-through" rev={rev} />
                      <BubbleButton session={session} mark="code" label="</>" title={tr("Inline Code", "行内代码")} shortcut="mod+e" class="font-mono" rev={rev} />
                      <View class="mx-1 h-4 w-px bg-border" />
                    </If>
                    {/* Quick inline AI right inside the document floating bar. */}
                    <BaseButton
                      testID="doc-bubble-quick-ai"
                      onPress={() => ensureDocAssistant(props.doc.path).requestFocus(readLiveSelection())}
                      tooltip={tip(tr("Edit or ask inline with Pip", "在文档中直接唤起 AI 处理"), "mod+j", "top")}
                      class="group h-7 flex-row items-center gap-1 rounded-md corner-squircle px-2 transition-colors duration-100 ease-out-quint hover:bg-brand-soft active:scale-[0.96] motion-reduce:transition-none motion-reduce:active:scale-100"
                    >
                      <Icon name="sparkle" size={13} tone="brand-text" />
                      <Text class="text-sm font-medium text-brand-text">{tr("Pip", "Pip")}</Text>
                    </BaseButton>
                    {/* Explicit session choice for the selected passage — never a mystery target. */}
                    <BaseButton
                      testID="doc-bubble-add"
                      onPress={() => openSelectionMenu(props.doc.path)}
                      tooltip={tip(tr("Ask AI about selection", "针对选中内容向 AI 提问"), undefined, "top")}
                      class="group h-7 flex-row items-center gap-1 rounded-md corner-squircle px-2 transition-colors duration-100 ease-out-quint hover:bg-accent active:scale-[0.96] motion-reduce:transition-none motion-reduce:active:scale-100"
                    >
                      <Icon name="message" size={13} tone="muted-foreground" />
                      <Text class="text-sm font-medium text-muted-foreground transition-colors duration-100 group-hover:text-foreground">
                        {tr("Ask AI", "问 AI")}
                      </Text>
                      <Icon name="chevronDown" size={11} tone="subtle" />
                    </BaseButton>
                  </View>
                </PopIn>
              </If>
            }
          >
            <SlashMenu
              items={items}
              index={index}
              query={() => slash()?.query ?? ""}
              onPick={apply}
              onHover={(at) => index.set(at)}
            />
          </If>
        }
        onPasteFiles={(e) => {
          // A dropped or pasted file lands as a Markdown image/link — the
          // document stays portable text; binaries are not copied next to it.
          const uri = e.paste.uris[0];
          const file = e.paste.files[0];
          if (uri) session.insertContent(`![${uri.split("/").pop() ?? "image"}](${uri})`, "markdown");
          else if (file) session.insertContent(`[${file.name ?? "file"}](attachment:${file.name ?? "file"})`, "markdown");
        }}
      />
      {/* Top scroll veil: softens scrolling prose as it passes behind the glass title bar (or clears it over wallpaper). */}
      <View
        class="pointer-events-none absolute inset-x-0"
        style={
          wallpaper()
            ? { top: 0, height: topBarHeight() + 24, backgroundImage: edgeFade("to bottom", topBarHeight(), 24) }
            : { top: topBarHeight(), height: 18, backgroundImage: edgeFade("to bottom", 0, 18) }
        }
      />
      {/* Bottom scroll veil: softens prose gently above the quiet 44pt footer bar. */}
      <View
        class="pointer-events-none absolute inset-x-0 bottom-0"
        style={{ height: 32, backgroundImage: edgeFade("to top", 0, 32) }}
      />
    </View>
  );
}

/** How much is written, as the language counts it: words, where a CJK character is one. */
function wordsLabel(count: number) {
  const n = count.toLocaleString(activeLanguage() === "zh" ? "zh-CN" : "en-US");
  return tr(count === 1 ? "1 word" : `${n} words`, `${n} 字`);
}

/** Native destination menu for a selected passage in the bubble menu. */
function openSelectionMenu(path: string) {
  const targets = docChatTargets();
  const items: MenuItem[] = [
    targets.hasActiveDraft && targets.draftTab
      ? {
          label: tr("Add to Current Draft", "添加到当前草稿"),
          onSelect: () => void addDocToTab(path, targets.draftTab!),
        }
      : {
          label: tr("New Session", "新建会话"),
          onSelect: () => void addDocToNewSession(path),
        },
    ...(targets.sessions.length
      ? [
          { type: "separator" as const },
          ...targets.sessions.map((s) => ({
            label: tr(`Add to “${s.title}”`, `添加到「${s.title}」`),
            onSelect: () => void addDocToTab(path, s.tab),
          })),
        ]
      : []),
  ];
  void Menu.popup(items);
}

/**
 * The document's foot: how much is written and where the file lives (clickable
 * to reveal on disk), and — for a draft expanded out of a session with ⌘E — a
 * one-click way straight back to the session it came from.
 */
function DocFoot(props: { doc: MarkdownDoc; picked: () => boolean; pickedWords: () => number }) {
  const home = backend().home();
  const external = () => !isNote(props.doc.path);
  const fullPath = () => tildePath(props.doc.path, home);
  const revealHint = () =>
    platform.os === "macos" ? tr("Click to show in Finder", "点击在访达中显示") : tr("Click to show in file manager", "点击在文件管理器中显示");
  const hasStatus = () => props.doc.readOnly() || props.doc.words() > 0 || external();
  const statusOpacity = createAnimatedValue(untracked(hasStatus) ? 1 : 0);
  let hadStatus = untracked(hasStatus);
  effect(() => {
    const on = hasStatus();
    if (on === hadStatus) return;
    hadStatus = on;
    void statusOpacity.stop();
    if (untracked(reduceMotion)) {
      statusOpacity.set(on ? 1 : 0);
      return;
    }
    void statusOpacity.timing(on ? 1 : 0, {
      duration: on ? DURATION.fast : DURATION.instant,
      easing: on ? EASING.entrance : EASING.exit,
    });
  });
  cleanup(() => void statusOpacity.stop());

  const status = () => {
    if (props.doc.readOnly()) return tr("Read-only — this file holds formatting the editor cannot keep", "只读 — 此文件含有编辑器无法保留的格式");
    const count = props.doc.words();
    const sel = props.pickedWords();
    if (external()) {
      const loc = compactPath(fullPath(), 36);
      if (count === 0) return loc;
      if (props.picked() && sel > 0) return `${tr(`${wordsLabel(sel)} selected`, `已选 ${wordsLabel(sel)}`)} · ${loc}`;
      return `${loc} · ${wordsLabel(count)}`;
    }
    if (count === 0) return "";
    if (props.picked() && sel > 0) {
      return `${tr(`${wordsLabel(sel)} selected`, `已选 ${wordsLabel(sel)}`)} · ${wordsLabel(count)} · ${tr("Saved automatically", "自动保存")}`;
    }
    return `${wordsLabel(count)} · ${tr("Saved automatically", "自动保存")}`;
  };

  const origin = () => (props.picked() ? undefined : docDraftOrigin(props.doc.path));
  const disabled = () => props.doc.words() === 0;

  return (
    <View class="h-11 shrink-0 justify-center">
      <View class="mx-auto w-full max-w-180 flex-row items-center gap-3 px-10">
        <View class="min-w-0 flex-1 flex-row items-center" style={{ opacity: statusOpacity }}>
          <BaseButton
            onPress={() => void revealDoc(props.doc.path)}
            disabled={!hasStatus()}
            tooltip={hasStatus() ? tip(`${fullPath()} · ${revealHint()}`, undefined, "top") : undefined}
            accessibilityLabel={status() || fullPath()}
            class={`-ml-1.5 min-w-0 max-w-full flex-row items-center gap-1.5 rounded-md corner-squircle px-1.5 py-1 ${PRESS} ${FOCUS_RING} hover:bg-accent`}
          >
            <If when={props.doc.readOnly()}>
              <Icon name="eye" size={13} tone="subtle" class="shrink-0" />
            </If>
            <Text testID="doc-status" class="min-w-0 shrink truncate text-xs tabular-nums text-subtle">
              {status()}
            </Text>
          </BaseButton>
        </View>
        <If when={origin()}>
          {(src) => (
            <BaseButton
              testID="doc-return-origin"
              onPress={() => void returnDraftDocToOrigin(props.doc.path)}
              disabled={disabled()}
              class={`h-7 shrink-0 flex-row items-center gap-1.5 rounded-md corner-squircle border-[0.5px] border-hairline bg-secondary px-2.5 text-sm text-secondary-foreground hover:border-hairline-hover hover:bg-secondary/80 active:bg-secondary/70 disabled:opacity-40 disabled:hover:border-hairline disabled:hover:bg-secondary ${PRESS} ${PRESS_SCALE} ${FOCUS_RING}`}
            >
              <Icon name="arrowLeft" size={13} tone="foreground" />
              <Text class="max-w-52 truncate text-sm font-medium text-secondary-foreground">
                {src().isBlankDraft ? tr("Back to Composer", "回到输入框") : tr(`Back to “${src().label}”`, `回到「${src().label}」`)}
              </Text>
            </BaseButton>
          )}
        </If>
      </View>
    </View>
  );
}

/**
 * One open document: the session lives in `store/docs` so switching tabs
 * keeps the text, the selection and the whole undo history — nothing here
 * re-parses or re-mounts the kernel. The page is the writing and nothing
 * else; under it, one line says it is kept and takes it to a session.
 */
export function DocEditor(props: { path: string }) {
  const doc = ensureDoc(props.path);
  const assistant = ensureDocAssistant(props.path);
  const picked = signal(false);
  const pickedWords = signal(0);
  const liveSelection = signal<DocSelection | undefined>(undefined);
  const readyAtMount = untracked(() => Boolean(doc.session()));
  const editorOpacity = createAnimatedValue(readyAtMount || untracked(reduceMotion) ? 1 : 0);
  const editorY = createAnimatedValue(readyAtMount || untracked(reduceMotion) ? 0 : 4);
  const editorSettled = signal(readyAtMount || untracked(reduceMotion));
  let revealed = readyAtMount;
  let revealTimer: ReturnType<typeof setTimeout> | undefined;
  effect(() => {
    const ready = Boolean(doc.session());
    if (!ready || revealed) return;
    revealed = true;
    if (untracked(reduceMotion)) {
      editorOpacity.set(1);
      editorY.set(0);
      editorSettled.set(true);
      return;
    }
    void editorOpacity.timing(1, { duration: 170, easing: EASING.entrance });
    void editorY.timing(0, { duration: 190, easing: EASING.signature });
    revealTimer = setTimeout(() => {
      revealTimer = undefined;
      editorSettled.set(true);
    }, 200);
  });
  cleanup(() => {
    clearTimeout(revealTimer);
    void editorOpacity.stop();
    void editorY.stop();
  });

  const orbPointer = createDocOrbPointerBridge();
  let editorPointer: EditorPointerBridge | undefined;
  let selectionReader: (() => DocSelection | undefined) | undefined;
  const drafting = () => Boolean(doc.session()) && !doc.readOnly() && doc.words() === 0 && assistant.running();

  return (
    <View
      testID="doc-editor"
      class="relative min-h-0 min-w-0 flex-1 bg-background"
      onMouseMove={(e) => {
        editorPointer?.onMove(e.pressedButton !== null);
        orbPointer.onPaneMove(e);
      }}
      onMouseLeave={() => {
        editorPointer?.onLeave();
        orbPointer.onPaneLeave();
      }}
      onMouseUp={() => {
        editorPointer?.onUp();
      }}
      onTouchStart={() => {
        editorPointer?.onMove(true);
      }}
      onTouchMove={() => {
        editorPointer?.onMove(true);
      }}
      onTouchEnd={() => {
        editorPointer?.onUp();
      }}
      onTouchCancel={() => {
        editorPointer?.onUp();
      }}
    >
      <View class="relative min-h-0 flex-1">
        <DocSkeleton show={() => !doc.session()} />
        <View
          class="min-h-0 flex-1"
          style={editorSettled() ? undefined : { opacity: editorOpacity, transform: [{ translateY: editorY }] }}
        >
          <If when={doc.session()}>
            {(session) => (
              <Editor
                doc={doc}
                session={session()}
                picked={picked}
                pickedWords={pickedWords}
                liveSelection={liveSelection}
                drafting={drafting}
                onDraggingChange={(dragging) => orbPointer.setDraggingSelection(dragging)}
                bindPointer={(bridge) => {
                  editorPointer = bridge;
                  return () => {
                    if (editorPointer === bridge) editorPointer = undefined;
                  };
                }}
                bindSelectionReader={(reader) => {
                  selectionReader = reader;
                  return () => {
                    if (selectionReader === reader) selectionReader = undefined;
                  };
                }}
              />
            )}
          </If>
        </View>
        <DocDraftingSkeleton show={drafting} hasContent={() => doc.words() > 0} />
        <DocRefreshSweep doc={doc} />
        <DocActivityRibbon active={() => assistant.running()} />
        <DocUpdatePill doc={doc} />
        <DocFloatingOrb
          doc={doc}
          liveSelection={liveSelection}
          readLiveSelection={() => (selectionReader ? selectionReader() : untracked(liveSelection))}
          pointerBridge={orbPointer}
          onReturnFocus={() => doc.session()?.focus()}
        />
      </View>
      <DocFoot doc={doc} picked={picked} pickedWords={pickedWords} />
    </View>
  );
}

/**
 * The documents' layer over the chat: every open document keeps its pane
 * mounted (hidden panes only `display: "none"`), so a switch costs nothing —
 * the chat below is untouched and the daemon session keeps running.
 *
 * Between the chat and a document the layer cross-fades: the document is
 * whole from its first frame over a chat that is whole under it, so every
 * frame between is two settled surfaces — never a blank. A document keeps
 * its place under Settings, which is a sheet over whatever was there.
 */
export function DocDeck() {
  let under = "";
  const active = computed(() => {
    const v = currentView();
    if (v.name === "doc") return (under = v.docId);
    if (v.name === "settings") return under;
    return (under = "");
  });
  /** The pane the deck shows: the last document through the layer's way out. */
  const shownDoc = keepLast(() => active() || undefined);
  const inFront = () => currentView().name === "doc";
  // A doc view naming a tab that is gone (closed out from under it) lands on the chat instead.
  effect(() => {
    const v = currentView();
    if (v.name === "doc" && !openTabs().some((t) => t.kind === "doc" && t.ref === v.docId)) showChat();
  });
  const panes = computed((): DeckPane<string>[] =>
    openTabs()
      .filter((t) => t.kind === "doc")
      .map((t) => ({ id: t.ref, render: () => <DocEditor path={t.ref} /> })),
  );

  const start = untracked(() => !!active());
  const laid = signal(start);
  const opacity = createAnimatedValue(start ? 1 : 0);
  let was = start;
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  effect(() => {
    const on = !!active();
    if (on === was) return;
    was = on;
    const mine = ++seq;
    clearTimeout(timer);
    // The document that was in front is gone (its tab closed): there is nothing to fade but an empty page.
    const gone = !on && untracked(() => !panes().some((pane) => pane.id === shownDoc()));
    if (gone || untracked(reduceMotion)) {
      void opacity.stop();
      opacity.set(on ? 1 : 0);
      laid.set(on);
      return;
    }
    // A reversal goes on from where the fade is, never from an end it did not reach.
    void opacity.stop();
    if (on) {
      laid.set(true);
      void opacity.timing(1, { duration: 160, easing: EASING.entrance });
    } else {
      void opacity.timing(0, { duration: DURATION.instant, easing: EASING.exit });
      timer = setTimeout(() => {
        if (seq === mine) laid.set(false);
      }, DURATION.instant);
    }
  });
  cleanup(() => clearTimeout(timer));

  return (
    <View
      class={`absolute inset-0 z-10 bg-background ${active() ? "" : "pointer-events-none"}`}
      style={{ display: laid() ? "flex" : "none", opacity }}
    >
      <LayerActive.Provider value={inFront}>
        <ViewDeck active={shownDoc() ?? ""} panes={panes()} />
      </LayerActive.Provider>
    </View>
  );
}
