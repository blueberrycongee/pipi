import { cleanup, computed, createAnimatedValue, effect, reduceMotion, signal, Text, untracked, View } from "nsh";
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
import { topBarHeight } from "../lib/layout";
import { activeLanguage, tr } from "../lib/i18n";
import { currentView, showChat } from "../store/app";
import { ensureDoc, SLASH_KEYS, syncDoc, type MarkdownDoc } from "../store/docs";
import { addDocToChat, openTabs } from "../store/tabs";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { type DeckPane, DURATION, EASING, keepLast, LayerActive, ViewDeck } from "../ui/motion";
import { PRESS } from "../ui/styles";

/**
 * What `/` offers: block kinds as Notion calls them, each a command on the
 * session. Labels localize at render; `keys` are what a query may also match
 * (the Markdown habit, the short name), whatever language the label is in.
 */
const SLASH_ITEMS: { id: string; label: () => string; hint: string; keys: string; make: () => RichCommand }[] = [
  { id: "h1", label: () => tr("Heading 1", "一级标题"), hint: "#", keys: "h1 heading title 标题 biaoti", make: () => setBlockType("heading", { level: 1 }) },
  { id: "h2", label: () => tr("Heading 2", "二级标题"), hint: "##", keys: "h2 heading 标题 biaoti", make: () => setBlockType("heading", { level: 2 }) },
  { id: "h3", label: () => tr("Heading 3", "三级标题"), hint: "###", keys: "h3 heading 标题 biaoti", make: () => setBlockType("heading", { level: 3 }) },
  { id: "bullet", label: () => tr("Bullet List", "无序列表"), hint: "-", keys: "ul bullet list 列表 liebiao", make: () => toggleList("bulletList", "listItem") },
  { id: "ordered", label: () => tr("Numbered List", "有序列表"), hint: "1.", keys: "ol ordered numbered list 列表 liebiao", make: () => toggleList("orderedList", "listItem") },
  { id: "task", label: () => tr("Task List", "任务列表"), hint: "[ ]", keys: "todo task check 任务 待办 renwu daiban", make: () => toggleList("taskList", "taskItem") },
  { id: "quote", label: () => tr("Quote", "引用"), hint: ">", keys: "quote blockquote 引用 yinyong", make: () => wrapIn("blockquote") },
  { id: "code", label: () => tr("Code Block", "代码块"), hint: "```", keys: "code pre 代码 daima", make: () => setBlockType("codeBlock") },
  { id: "table", label: () => tr("Table", "表格"), hint: "3×3", keys: "table grid 表格 biaoge", make: () => insertTable({ rows: 3, cols: 3, withHeaderRow: true }) },
  { id: "rule", label: () => tr("Divider", "分割线"), hint: "---", keys: "hr divider rule line 分割线 fengexian", make: () => insertContent([{ type: "horizontalRule" }]) },
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
 */
const EDITOR_CLASSES = {
  root: "flex-1",
  content: "mx-auto w-full max-w-180 px-10",
  placeholder: "text-subtle",
  caret: "bg-brand",
  taskCheckbox: "mr-2 mt-2.5 size-4 rounded-xs corner-squircle border border-hairline-hover bg-background transition-colors duration-150 ease-out-quint motion-reduce:transition-none checked:border-brand checked:bg-brand",
  listMarker: "text-subtle tabular-nums",
  nodes: {
    paragraph: "my-1.5 text-md leading-relaxed text-foreground",
    "heading[level=1]": "mb-2 mt-6 text-2xl font-semibold leading-snug tracking-tight text-foreground",
    "heading[level=2]": "mb-1.5 mt-6 text-xl font-semibold leading-snug tracking-tight text-foreground",
    "heading[level=3]": "mb-1 mt-5 text-lg font-semibold leading-snug text-foreground",
    heading: "mb-1 mt-4 text-md font-semibold leading-snug text-foreground",
    bulletList: "my-1 pl-6",
    orderedList: "my-1 pl-6",
    taskList: "my-1 pl-1",
    // A paragraph's own margins would set a list's items a paragraph apart: an item takes most of them back.
    listItem: "-my-1",
    taskItem: "-my-1",
    blockquote: "my-2.5 border-l-2 border-brand/35 pl-3.5",
    codeBlock: "my-2.5 rounded-xl corner-squircle border border-border bg-sunken p-3.5 font-mono text-xs leading-relaxed text-foreground",
    horizontalRule: "my-5 h-px bg-border",
    table: "my-2.5 w-full",
    tableCell: "border border-border px-3 py-0.5",
    tableHeader: "border border-border bg-muted px-3 py-0.5 font-semibold",
  },
  marks: {
    bold: "font-semibold",
    italic: "italic",
    strike: "text-muted-foreground line-through",
    code: "rounded-sm bg-sunken px-1 font-mono text-sm",
    link: "text-brand underline",
  },
};

const MENU_SURFACE = "rounded-xl corner-squircle border-[0.5px] border-hairline bg-popover shadow-popover";

/**
 * A menu at the caret settles in: opacity leads, with a breath of scale — it
 * is in place from its first frame, never sliding to it. It leaves at once,
 * with the choice that closed it.
 */
function PopIn(props: { children: JSX.Element }) {
  const still = untracked(reduceMotion);
  const opacity = createAnimatedValue(still ? 1 : 0);
  const scale = createAnimatedValue(still ? 1 : 0.97);
  if (!still) {
    void opacity.timing(1, { duration: DURATION.instant, easing: EASING.entrance });
    void scale.timing(1, { duration: DURATION.instant, easing: EASING.entrance });
  }
  return <View style={{ opacity, transform: [{ scale }] }}>{props.children}</View>;
}

/** One button of the selection's bubble menu: a mark the session toggles. */
function BubbleButton(props: { session: RichEditorSession; mark: string; label: string; class?: string; rev: () => number }) {
  const on = () => (props.rev(), props.session.isActive(props.mark));
  return (
    <BaseButton
      onPress={() => props.session.run(toggleMark(props.mark))}
      class={`h-6 min-w-6 items-center justify-center rounded-md corner-squircle px-1.5 transition-colors ${on() ? "bg-accent" : "hover:bg-accent"}`}
    >
      <Text class={`text-sm ${props.class ?? ""} ${on() ? "text-foreground" : "text-muted-foreground"}`}>{props.label}</Text>
    </BaseButton>
  );
}

/**
 * The editor on a document whose file has been read. It listens to the
 * session once, and on a keystroke does only what a keystroke can change:
 * the `/` menu's state and whether text is selected. Nothing here serializes
 * the document as it is typed.
 */
function Editor(props: { doc: MarkdownDoc; session: RichEditorSession; picked: { (): boolean; set: (on: boolean) => void } }) {
  const session = props.session;
  const slash = signal<SlashState | null>(null);
  const index = signal(0);
  /** Text is selected: the bubble menu's marks apply, and the passage is what goes to a session. */
  const picked = props.picked;
  /** Ticks while text is selected, so the marks' buttons follow the selection. */
  const rev = signal(0);
  /** Captured keys already answered, by trigger: a count that only grows, never replayed. */
  const keysSeen = new Map<string, number>();

  const items = computed(() => slashFilter(slash()?.query ?? ""));

  function apply(item: (typeof SLASH_ITEMS)[number] | undefined) {
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

  function sync() {
    let found: SlashState | null = null;
    for (const key of SLASH_KEYS) {
      const s = session.suggestion(key);
      if (!s) continue;
      const seen = keysSeen.get(key);
      const pressed = s.active && seen !== undefined && s.keyCount > seen ? s.lastKey : undefined;
      keysSeen.set(key, s.keyCount);
      if (!s.active || found) continue;
      found = { key, id: s.decorationId ?? "", from: s.range.from, to: s.range.to, query: s.query ?? "" };
      const before = slash();
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
    const before = slash();
    if (found?.id !== before?.id || found?.from !== before?.from || found?.to !== before?.to || found?.query !== before?.query) slash.set(found);
    const sel = session.selection as { type?: string; anchor?: number; head?: number };
    const has = sel.type === "text" && sel.anchor !== undefined && sel.head !== undefined && sel.anchor !== sel.head;
    if (has !== picked()) picked.set(has);
    if (has) rev.update((n) => n + 1);
  }
  session.on("transaction", sync);
  session.on("selectionUpdate", sync);
  sync();

  // In front on the deck: the caret is the document's. Asked again a turn
  // later — the pane is laid out (`display`) in the commit this runs in.
  const layerActive = LayerActive();
  effect(() => {
    if (!layerActive()) {
      // Behind the chat (or a sheet): the keyboard is not the document's.
      if (untracked(() => session.isFocused)) session.blur();
      return;
    }
    // Coming forward, the document is what its file says now: an agent may have written it meanwhile.
    void syncDoc(props.doc.path);
    session.focus();
    const timer = setTimeout(() => session.focus(), 0);
    cleanup(() => clearTimeout(timer));
  });

  return (
    <RichEditor
      editor={session}
      autoFocus
      accessibilityLabel={tr("Document", "文档")}
      placeholder={tr("Write a brief, a draft, anything…  “/” for blocks", "写需求、写文章、随手记…  输入“/”插入块")}
      classes={EDITOR_CLASSES}
      styles={{ content: { paddingTop: topBarHeight() + 20, paddingBottom: 96 } }}
      bubbleMenuPlacement={slash() ? "bottom" : "top"}
      bubbleMenuOffset={6}
      bubbleMenu={
        <If
          when={slash()}
          else={
            <If when={picked()}>
              <PopIn>
              <View class={`flex-row items-center gap-0.5 p-1 ${MENU_SURFACE}`}>
                <If when={!props.doc.readOnly()}>
                  <BubbleButton session={session} mark="bold" label="B" class="font-semibold" rev={rev} />
                  <BubbleButton session={session} mark="italic" label="I" class="italic" rev={rev} />
                  <BubbleButton session={session} mark="strike" label="S" class="line-through" rev={rev} />
                  <BubbleButton session={session} mark="code" label="</>" class="font-mono" rev={rev} />
                  <View class="mx-1 h-3.5 w-px bg-border" />
                </If>
                {/* The passage, taken to the session: what was selected is what is asked about. */}
                <BaseButton
                  testID="doc-bubble-add"
                  onPress={() => addDocToChat(props.doc.path)}
                  class="h-6 flex-row items-center gap-1.5 rounded-md corner-squircle px-1.5 transition-colors hover:bg-accent"
                >
                  <Icon name="message" size={13} tone="muted-foreground" />
                  <Text class="text-sm text-muted-foreground">{tr("Add to Chat", "添加到会话")}</Text>
                </BaseButton>
              </View>
              </PopIn>
            </If>
          }
        >
          {/* The bubble centers on the caret; a clear half to the left leaves the menu's own edge there. */}
          <View class="w-112 flex-row justify-end" style={{ pointerEvents: "box-none" }}>
          <PopIn>
          <View testID="doc-slash-menu" class={`w-56 p-1 ${MENU_SURFACE}`}>
            <Each of={items()} key={(item) => item.id}>
              {(item, at) => (
                <BaseButton
                  onPress={() => apply(item())}
                  selected={at() === index()}
                  class={`h-7 flex-row items-center gap-2 rounded-md corner-squircle px-2 transition-colors duration-100 ease-out-quint motion-reduce:transition-none ${at() === index() ? "bg-accent" : "hover:bg-accent/60"}`}
                >
                  <Text class="flex-1 text-sm text-foreground">{item().label()}</Text>
                  <Text class="font-mono text-2xs text-subtle">{item().hint}</Text>
                </BaseButton>
              )}
            </Each>
          </View>
          </PopIn>
          </View>
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
  );
}

/** How much is written, as the language counts it: words, where a CJK character is one. */
function wordsLabel(count: number) {
  const n = count.toLocaleString(activeLanguage() === "zh" ? "zh-CN" : "en-US");
  return tr(count === 1 ? "1 word" : `${n} words`, `${n} 字`);
}

/**
 * The document's foot: how much is written and that it is kept, and the one
 * thing a document here is for — going to a session. The button says what
 * will go: the passage selected, else the whole document.
 */
function DocFoot(props: { doc: MarkdownDoc; picked: () => boolean }) {
  const status = () => {
    if (props.doc.readOnly()) return tr("Read-only — this file holds formatting the editor cannot keep", "只读 — 此文件含有编辑器无法保留的格式");
    const count = props.doc.words();
    return count > 0 ? `${wordsLabel(count)} · ${tr("Saved automatically", "自动保存")}` : "";
  };
  return (
    <View class="h-11 shrink-0 justify-center">
      <View class="mx-auto w-full max-w-180 flex-row items-center gap-3 px-10">
        <Text testID="doc-status" class="pointer-events-none min-w-0 flex-1 truncate text-xs tabular-nums text-subtle">
          {status()}
        </Text>
        <Button
          testID="doc-add"
          label={props.picked() ? tr("Add Selection to Chat", "添加选中内容到会话") : tr("Add to Chat", "添加到会话")}
          icon="message"
          size="sm"
          shortcut="mod+enter"
          disabled={props.doc.words() === 0}
          onPress={() => addDocToChat(props.doc.path)}
          class={PRESS}
        />
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
  const picked = signal(false);
  return (
    <View testID="doc-editor" class="min-h-0 min-w-0 flex-1 bg-background">
      <View class="min-h-0 flex-1">
        <If when={doc.session()}>{(session) => <Editor doc={doc} session={session()} picked={picked} />}</If>
      </View>
      <DocFoot doc={doc} picked={picked} />
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
      void opacity.timing(1, { duration: DURATION.instant, easing: EASING.entrance });
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
