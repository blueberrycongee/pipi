import * as fs from "fs/promises";
import { computed, keymap, reduceMotion, signal, type Signal } from "nsh";
import {
  RichEditorPlugin,
  StarterKit,
  TableKit,
  chain,
  createRichEditor,
  defineExtension,
  deleteRange,
  focus as focusAt,
  insertContent,
  markdown,
  setTextSelection,
  suggestion,
  undo as undoCommand,
  type RichEditorSession,
} from "nsh/base";
import { plainMarkdown } from "../lib/doc-wire";
import { tr } from "../lib/i18n";
import { merge3 } from "../lib/merge3";
import { currentView, toast } from "./app";
import { backend, NoPickerError } from "./backend";
import { docsFolder, setDocsFolderPref } from "./prefs";

/**
 * Markdown documents open in tabs. Each open document keeps one live
 * `RichEditorSession` — the kernel holds the document, the selection and the
 * undo history in Rust — so switching between tabs never re-parses, never
 * loses undo, and never moves the caret. The session is made from the file
 * once it is read (so the first undo step is the reader's own, not the file
 * landing) and lives until its tab closes; the file on disk follows the
 * editor on a short debounce, and a close flushes a last write.
 *
 * The file is not the editor's alone: an agent asked to tighten a paragraph
 * writes it too. So the editor never writes over what it has not read
 * (`reconcile`): what else wrote the file comes into the document first — as
 * one change undo takes back — and where the person typed meanwhile the two
 * are merged by paragraph (`lib/merge3.ts`), theirs standing where both
 * changed the same words.
 *
 * Notes are the documents the app keeps itself, under `<dataDir>/docs`. They
 * are listed (`notes()`) for the sidebar's 最近, beside the sessions they are
 * written for — a note whose tab is closed is put away, not lost.
 */

/** Milliseconds a change waits for the next one before the file is written. */
const SAVE_DEBOUNCE_MS = 800;
/** Milliseconds a change waits before the words are counted again. */
const COUNT_DEBOUNCE_MS = 300;
/** New notes are named by the day they were started; the title shown is their first line. */
const NOTE_PREFIX = "note-";
/** The `/` menu's two triggers: the key as typed, and what a Chinese input method types for it. */
export const SLASH_KEYS = ["slash", "slashCn"] as const;
/** Decoration plugin key used to briefly mark text updated from disk by an agent or external editor. */
const EXTERNAL_EDIT_PLUGIN = "pipiExternalEdit";

const docs = new Map<string, MarkdownDoc>();
/** Ticks when a document opens or closes: what names a document by its path (a tab, a card) asks again. */
const opened = signal(0);
let updateEventSeq = 0;

/** Listeners informed when a document tab closes (used by the inline AI assistant store to detach cleanly). */
const docCloseListeners = new Set<(path: string) => void>();
export function onDocClosed(listener: (path: string) => void): () => void {
  docCloseListeners.add(listener);
  return () => docCloseListeners.delete(listener);
}

/** Optional predicate checked before firing the global file-update toast (suppressed when an inline doc assistant is already displaying its update pill + inline badge). */
let suppressDiskToast: ((path: string) => boolean) | undefined;
export function setDiskUpdateToastSuppressor(fn: ((path: string) => boolean) | undefined) {
  suppressDiskToast = fn;
}

/** A visible update landed on an open document from disk or from an applied AI reply. */
export interface DocUpdateEvent {
  id: number;
  at: number;
  source: "disk" | "insert" | "replace" | "append";
  deltaWords: number;
  conflict: boolean;
}

export interface MarkdownDoc {
  /** The backing file's absolute path — the document's identity and its tab's ref. */
  path: string;
  /** The live editor, once the file has been read. */
  session: () => RichEditorSession | undefined;
  /** The first line when it names the document (a heading; any first line of a note), else the file's name. */
  title: () => string;
  /** Changes since the last finished write. */
  dirty: () => boolean;
  /** A write is in flight (dirty stays true through it until it lands). */
  saving: () => boolean;
  /** How much is written: words, a CJK character counting as one. */
  words: () => number;
  /** The file holds what the editor cannot keep (raw HTML, footnotes): it is shown, never rewritten. */
  readOnly: () => boolean;
  /** Most recent visible update banner (disk sync or applied AI edit), cleared on dismiss or undo. */
  lastUpdate: () => DocUpdateEvent | undefined;
  /** Monotonic counter incremented every time an update lands on this document. */
  updateSeq: () => number;
  /** Dismisses the floating update pill without undoing the edit. */
  dismissUpdate: () => void;
}

interface DocState {
  session: Signal<RichEditorSession | undefined>;
  titleText: Signal<string>;
  dirtyFlag: Signal<boolean>;
  savingFlag: Signal<boolean>;
  wordCount: Signal<number>;
  readOnlyFlag: Signal<boolean>;
  lastUpdateEvent: Signal<DocUpdateEvent | undefined>;
  updateCount: Signal<number>;
  saveTimer: ReturnType<typeof setTimeout> | undefined;
  countTimer: ReturnType<typeof setTimeout> | undefined;
  /** Serializes writes and reads of the file so a save never overlaps a newer one, or a look at the disk. */
  saveTail: Promise<void>;
  /** The file was on disk when the document opened, or a save has made it since. */
  onDisk: boolean;
  /** The file's text as of the last read or write: what "changed on disk" is measured against. `undefined`: no file. */
  disk: string | undefined;
  /** The file's modification time as of then: a look at the disk reads the file only when it moved. */
  mtime: number;
  /** The editor's Markdown as of then: what the person typed since is its difference from this. */
  base: string;
  /** Front matter, kept as written outside the editor (it has no block for it). */
  front: string;
  /** The session's revision after a change that was the file's, not the person's: no save answers it. */
  quiet: number;
  /** Revision whose update triggered an intentional highlight (kept alive until a subsequent edit). */
  highlightRev: number;
  /** The file changed the document while it was not in front: said when it next is. */
  changedUnseen: boolean;
  /** Pending update banner waiting to appear when the document comes forward. */
  pendingUpdate: DocUpdateEvent | undefined;
  /** Changed document range waiting to be flashed when the document comes forward. */
  pendingHighlight: { from: number; to: number } | undefined;
  /** Active timers clearing or fading the external-edit highlight. */
  highlightTimers: ReturnType<typeof setTimeout>[];
  /** Resolves when the file has been read and the session made. */
  loaded: Promise<void>;
  stopListeners: () => void;
}

const states = new Map<string, DocState>();

export const defaultNotesDir = () => `${backend().dataDir().replace(/\/$/, "")}/docs`;
export const notesDir = () => (docsFolder() || defaultNotesDir()).replace(/\/$/, "");
export const isNote = (path: string) => path.startsWith(`${notesDir()}/`);

const fileName = (path: string) => path.split("/").pop() ?? path;
const stem = (path: string) => fileName(path).replace(/\.(md|markdown|mdown|txt)$/i, "");
/** True for pipi's own date-stamped files (`note-YYYY-MM-DD.md`), not user-named Markdown files. */
export const isGeneratedNoteName = (path: string) => fileName(path).startsWith(NOTE_PREFIX);

/** A document's display name: what its first line says, else — a generated note's file name says nothing — "Untitled", or the file's name. */
function displayTitle(path: string, firstLine: string) {
  if (firstLine) return firstLine;
  return isNote(path) && isGeneratedNoteName(path) ? tr("Untitled", "未命名") : stem(path);
}

/**
 * The first line that names a document, out of its Markdown: a heading
 * anywhere in a file's opening, or — for a note, which has no other name —
 * whatever its first line of text says.
 */
export function titleLine(markdownText: string, note: boolean): string {
  let first = "";
  for (const raw of splitFront(markdownText.slice(0, 4000)).body.split("\n")) {
    const line = raw.trim();
    if (!line || /^(```|---|\*\*\*|#{1,6}|\|[\s:|-]+\|?)$/.test(line)) continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) return plain(heading[1]);
    if (!note) continue;
    first ||= plain(line.replace(/^(>\s*|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/, ""));
    if (first) return first;
  }
  return first;
}

/** Inline Markdown down to its words, cut to a title's length: a link is its label, a marker goes, an escaped character is itself. */
const plain = (text: string) =>
  text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\\([!-/:-@[-`{-~])|[*_`~]/g, (_, escaped?: string) => escaped ?? "")
    .replace(/^\||\|$/g, "")
    .trim()
    .slice(0, 80);

/** The title as the open document has it: the first block's own text (no serializing the document per keystroke). */
function liveTitle(path: string, session: RichEditorSession): string {
  // What is typed after `/` is a query, not the document's words.
  if (SLASH_KEYS.some((key) => session.suggestion(key)?.active)) return "";
  const first = session.nodeAt(0) as { type?: string; content?: { text?: string }[] } | null;
  const text = (first?.content ?? []).map((inline) => inline?.text ?? "").join("").trim().slice(0, 80);
  if (text && (first?.type === "heading" || (isNote(path) && isGeneratedNoteName(path) && first?.type === "paragraph"))) return text;
  // Not said by the first block: a heading further down may, which takes the document's Markdown — left to the save.
  return "";
}

/**
 * The editor's keys that are the app's, ranked over the kit: an editor's
 * plugins come after its extensions', so as bare plugins the kit's own Enter
 * (split the block) and Tab ran first and the `/` menu never heard them —
 * only the arrows, which nothing else binds. `、` is what a Chinese input
 * method types for the `/` key: the menu answers the key, not the character.
 */
function appKeys() {
  return defineExtension({
    name: "pipiKeys",
    priority: 1000,
    addProseMirrorPlugins: () => [
      suggestion({ char: "/", key: SLASH_KEYS[0], captureKeys: ["ArrowUp", "ArrowDown", "Enter", "Tab"] }),
      // Only where `/` would open it (a line's start, after a space): mid-sentence `、` is the enumeration comma.
      suggestion({ char: "、", key: SLASH_KEYS[1], captureKeys: ["ArrowUp", "ArrowDown", "Enter", "Tab"] }),
      new RichEditorPlugin(EXTERNAL_EDIT_PLUGIN),
    ] as never,
  });
}

function makeSession(text: string): RichEditorSession {
  return createRichEditor({
    extensions: [appKeys(), StarterKit, TableKit],
    plugins: [markdown()],
    content: text,
    format: "markdown",
  });
}

// ── The file and the editor ─────────────────────────────────────────────────

/**
 * A file's front matter and the Markdown under it. The editor has no block
 * for front matter — read as Markdown it is a rule and a heading, and a save
 * would write it back as those — so it stays out of the editor, as written.
 * What the editor writes never reads as front matter: its blocks are a blank
 * line apart, and front matter's first key follows its opening line at once.
 */
function splitFront(text: string): { front: string; body: string } {
  const found = /^---\r?\n[\w-]+[ \t]*:[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  return found ? { front: found[0], body: text.slice(found[0].length) } : { front: "", body: text };
}

/**
 * Whether a file says what the editor cannot keep: raw HTML and comments
 * (written back as escaped text), footnotes and link definitions (dropped),
 * math (its underscores escaped). Code is the writer's own and says nothing.
 */
function unkept(body: string): boolean {
  const prose = body
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[^\n]*$|(?![\s\S]))/gm, "")
    .replace(/`[^`\n]*`/g, "")
    .replace(/\\[!-/:-@[-`{-~]/g, "");
  return (
    /<\/?[A-Za-z][\w-]*(?:\s[^<>\n]*)?\/?>/.test(prose) ||
    prose.includes("<!--") ||
    /^ {0,3}\[[^\]\n]+\]:\s*\S/m.test(prose) ||
    /\[\^[^\]\n]+\]/.test(prose) ||
    /\$[^$\n]*[\\_*][^$\n]*\$/.test(prose)
  );
}

/** Markdown as the editor writes it: what a file's text is compared and merged as. */
function normalized(body: string): string {
  const scratch = createRichEditor({ extensions: [StarterKit, TableKit], plugins: [markdown()], content: body, format: "markdown" });
  try {
    return scratch.getMarkdown();
  } finally {
    scratch.dispose();
  }
}

/** The file as it is on disk, or `undefined` when there is none. */
async function readDisk(path: string): Promise<{ text: string; mtime: number } | undefined> {
  try {
    const text = await fs.readFile(path, "utf8");
    return { text, mtime: (await fs.stat(path)).mtimeMs };
  } catch {
    return undefined;
  }
}

/** The document's last position: found by asking, since a position's unit is the kernel's. */
function lastPos(session: RichEditorSession): number {
  const valid = (pos: number) => {
    try {
      session.resolve(pos);
      return true;
    } catch {
      return false;
    }
  };
  let high = 1;
  while (valid(high)) high *= 2;
  let low = high >> 1;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (valid(mid)) low = mid;
    else high = mid;
  }
  return valid(low) ? low : 0;
}

/** The document's text before `pos`, a line per block: where a caret is, in characters. */
const textBefore = (session: RichEditorSession, pos: number) => session.textBetween(0, pos, "\n").length;

function applyDecorations(state: DocState, session: RichEditorSession, decorations: Parameters<RichEditorSession["setDecorations"]>[1]) {
  const before = session.revision;
  try {
    session.setDecorations(EXTERNAL_EDIT_PLUGIN, decorations);
  } catch {}
  const after = session.revision;
  if (after !== before) {
    if (state.quiet === before) state.quiet = after;
    if (state.highlightRev === before) state.highlightRev = after;
  }
}

function clearHighlight(state: DocState, session?: RichEditorSession) {
  while (state.highlightTimers.length) {
    const timer = state.highlightTimers.pop();
    if (timer !== undefined) clearTimeout(timer);
  }
  state.pendingHighlight = undefined;
  if (session) applyDecorations(state, session, []);
}

function flashHighlight(state: DocState, session: RichEditorSession, range: { from: number; to: number }) {
  clearHighlight(state, session);
  if (range.from >= range.to) return;
  const paint = (cls: string) => {
    applyDecorations(state, session, [{ from: range.from, to: range.to, kind: "inline", attrs: { class: cls } }]);
  };
  if (reduceMotion()) {
    paint("rounded-xs bg-brand-soft");
    state.highlightTimers.push(
      setTimeout(() => {
        clearHighlight(state, session);
      }, 1800),
    );
    return;
  }
  // Smooth multi-stage highlight sweep: blooms gently into the brand tint, holds briefly, then dissolves back into the paper.
  paint("rounded-xs bg-brand/22");
  state.highlightTimers.push(
    setTimeout(() => paint("rounded-xs bg-brand/16"), 220),
    setTimeout(() => paint("rounded-xs bg-brand/12"), 950),
    setTimeout(() => paint("rounded-xs bg-brand/8"), 1350),
    setTimeout(() => paint("rounded-xs bg-brand/4"), 1700),
    setTimeout(() => clearHighlight(state, session), 2050),
  );
}

/** Finds the ProseMirror position corresponding to a character offset in `session.textBetween(0, pos, "\n")`. */
function posAtChar(session: RichEditorSession, end: number, chars: number): number {
  let low = 0;
  let high = end;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (textBefore(session, mid) < chars) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** Computes common prefix & suffix lengths ignoring trailing newline skew so a single-word rewrite never highlights the rest of the document. */
function diffSpan(wasRaw: string, nowRaw: string): { head: number; tail: number; wasLen: number; nowLen: number } {
  const was = wasRaw.replace(/\s+$/, "");
  const now = nowRaw.replace(/\s+$/, "");
  let head = 0;
  while (head < was.length && head < now.length && was[head] === now[head]) head++;
  let tail = 0;
  while (tail < was.length - head && tail < now.length - head && was[was.length - 1 - tail] === now[now.length - 1 - tail]) tail++;
  return { head, tail, wasLen: was.length, nowLen: now.length };
}

/** Computes the exact changed ProseMirror range after mutating `session` from previous plain text `was`. */
function diffChangedRange(session: RichEditorSession, was: string): { from: number; to: number } | undefined {
  const now = session.textBetween(undefined, undefined, "\n");
  const { head, tail, nowLen } = diffSpan(was, now);
  const changedEnd = nowLen - tail;
  if (changedEnd <= head) return undefined;
  const end = lastPos(session);
  const from = posAtChar(session, end, head);
  const to = posAtChar(session, end, changedEnd);
  return from < to ? { from, to } : undefined;
}

/**
 * Replaces the document as one change undo takes back, and leaves the caret
 * in the words it was in: the text before and after what changed is the same
 * text, so a place in it maps across. Returns the changed ProseMirror range
 * when the new text contains changed or inserted content.
 */
function replaceContent(session: RichEditorSession, text: string): { from: number; to: number } | undefined {
  const selection = session.selection as { anchor?: number; head?: number };
  const was = session.textBetween(undefined, undefined, "\n");
  const places = [selection.anchor, selection.head].map((pos) => (pos === undefined ? undefined : textBefore(session, pos)));
  session.setContent(text, "markdown");
  const now = session.textBetween(undefined, undefined, "\n");
  const { head, tail, wasLen, nowLen } = diffSpan(was, now);
  const end = lastPos(session);
  /** Where a place in the old text is in the new: as it was before the change, as far from the end after it, at its edge inside it. */
  const across = (at: number) => (at <= head ? at : at >= wasLen - tail ? Math.max(0, nowLen - (wasLen - at)) : Math.min(head, nowLen));
  const posOf = (chars: number) => posAtChar(session, end, chars);
  const changedEnd = nowLen - tail;
  const changed = changedEnd > head ? { from: posOf(head), to: posOf(changedEnd) } : undefined;
  if (places[0] !== undefined) {
    const anchor = posOf(across(places[0]));
    const headPos = places[1] === undefined || places[1] === places[0] ? anchor : posOf(across(places[1]));
    try {
      session.run(setTextSelection(anchor, headPos));
    } catch {
      // No caret can stand there: it stays where the change left it.
    }
  }
  return changed && changed.from < changed.to ? changed : undefined;
}

const setTitle = (path: string, state: DocState, session: RichEditorSession, text: string) =>
  state.titleText.set(displayTitle(path, liveTitle(path, session) || titleLine(text, isNote(path) && isGeneratedNoteName(path))));

/**
 * Takes in what the file has become since the editor last read or wrote it.
 * Nothing typed meanwhile: the file's text is the document. Otherwise the two
 * are merged, and what the editor then holds past the file is left to the
 * save. A file that is gone is only forgotten: the next save makes it again.
 */
function reconcile(path: string, state: DocState, session: RichEditorSession, disk: { text: string; mtime: number } | undefined) {
  if (!disk) {
    state.disk = undefined;
    state.onDisk = false;
    state.mtime = 0;
    return;
  }
  state.mtime = disk.mtime;
  state.onDisk = true;
  if (disk.text === state.disk) return;
  const { front, body } = splitFront(disk.text);
  state.disk = disk.text;
  state.front = front;
  const mine = session.getMarkdown();
  const theirs = normalized(body);
  const base = state.base;
  state.base = theirs;
  if (theirs === mine) return;
  const merged = mine === base ? { text: theirs, conflict: false } : merge3(base, mine, theirs);
  if (merged.text !== mine) {
    const beforeWords = session.words();
    const changed = replaceContent(session, merged.text);
    // The change is the file's: the listener that hears it has nothing to save.
    state.quiet = session.revision;
    state.highlightRev = session.revision;
    setTitle(path, state, session, merged.text);
    countWords(state, session);
    const event: DocUpdateEvent = {
      id: ++updateEventSeq,
      at: Date.now(),
      source: "disk",
      deltaWords: session.words() - beforeWords,
      conflict: merged.conflict,
    };
    state.updateCount.update((n) => n + 1);
    state.changedUnseen = true;
    state.pendingUpdate = event;
    state.pendingHighlight = changed;
    sayChanged(path, state);
    if (isNote(path)) void refreshNotes();
  }
  if (merged.conflict) {
    toast("warning", tr("This document also changed on disk; where both changed the same lines, what you wrote was kept", "文档在磁盘上也被修改了；两边改到同一处的地方保留了你写的"));
  }
  if (session.getMarkdown() === theirs) {
    // Nothing of the person's is left to write.
    if (state.saveTimer !== undefined) clearTimeout(state.saveTimer);
    state.saveTimer = undefined;
    state.dirtyFlag.set(false);
  } else scheduleSave(path, state, session);
}

/**
 * Words under the reader's eyes changed without their hand: said once, with
 * the way back — when it happens in the document in front, else when the
 * document next comes forward.
 */
function sayChanged(path: string, state: DocState) {
  const view = currentView();
  if (view.name !== "doc" || view.docId !== path) return;
  if (state.changedUnseen) {
    state.changedUnseen = false;
    if (!suppressDiskToast?.(path)) {
      const undo = keymap.label("mod+z");
      toast("info", tr(`This document was updated from its file — ${undo} takes it back`, `文档已随文件的改动更新，${undo} 可撤回`));
    }
  }
  if (state.pendingUpdate) {
    const ev = state.pendingUpdate;
    state.pendingUpdate = undefined;
    state.lastUpdateEvent.set(ev);
  }
  const range = state.pendingHighlight;
  const session = state.session();
  if (range && session) {
    state.pendingHighlight = undefined;
    flashHighlight(state, session, range);
  }
}

async function writeDoc(path: string, state: DocState, session: RichEditorSession) {
  if (state.readOnlyFlag()) return;
  const disk = await readDisk(path);
  if (disk ? disk.text !== state.disk : state.disk !== undefined) {
    // An input method's marked text is not in the document yet: a change under it would cut it off.
    if (session.composing) return scheduleSave(path, state, session);
    reconcile(path, state, session, disk);
  }
  if (state.saveTimer !== undefined) {
    clearTimeout(state.saveTimer);
    state.saveTimer = undefined;
  }
  // A generated note nobody wrote in is not a note: nothing is made for it, and one emptied again is taken off the shelf.
  // User-named Markdown files (e.g. in a custom documents folder) are never deleted when emptied.
  if (isNote(path) && isGeneratedNoteName(path) && session.isEmpty) {
    if (state.onDisk) await fs.unlink(path).catch(() => undefined);
    state.onDisk = false;
    state.disk = undefined;
    state.mtime = 0;
    state.base = session.getMarkdown();
    state.dirtyFlag.set(false);
    state.titleText.set(displayTitle(path, ""));
    void refreshNotes();
    return;
  }
  const text = session.getMarkdown();
  if (state.onDisk && text === state.base) {
    state.dirtyFlag.set(false);
    return;
  }
  state.savingFlag.set(true);
  try {
    const out = state.front ? `${state.front}${state.front.endsWith("\n") ? "" : "\n"}\n${text}` : text;
    await fs.mkdir(path.split("/").slice(0, -1).join("/"), { recursive: true });
    await fs.writeFile(path, out);
    state.onDisk = true;
    state.disk = out;
    state.base = text;
    state.mtime = await fs.stat(path).then(
      (stat) => stat.mtimeMs,
      () => 0,
    );
    // Typed in while the write was out: the save that answers it is already waiting.
    if (state.saveTimer === undefined) state.dirtyFlag.set(false);
    setTitle(path, state, session, text);
    if (isNote(path)) void refreshNotes();
  } catch {
    toast("warning", tr("Could not save the document", "无法保存文档"));
  } finally {
    state.savingFlag.set(false);
  }
}

function countWords(state: DocState, session: RichEditorSession) {
  if (state.countTimer !== undefined) clearTimeout(state.countTimer);
  state.countTimer = undefined;
  state.wordCount.set(session.words());
}

function scheduleSave(path: string, state: DocState, session: RichEditorSession) {
  state.dirtyFlag.set(true);
  const title = liveTitle(path, session);
  if (title) state.titleText.set(title);
  // Transitioning between empty and non-empty updates immediately so footer actions enable/disable without lag.
  if (session.isEmpty || state.wordCount() === 0) {
    countWords(state, session);
  } else if (state.countTimer === undefined) {
    state.countTimer = setTimeout(() => {
      state.countTimer = undefined;
      if (states.get(path) === state) state.wordCount.set(session.words());
    }, COUNT_DEBOUNCE_MS);
  }
  if (state.saveTimer !== undefined) clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => {
    state.saveTimer = undefined;
    // What is typed after `/` is a query, not yet the document's words: the
    // file is written once the menu closes, so it never holds a half-typed
    // query — and the title never reads as one. An explicit flush still
    // writes now: a document on its way to a session is the agent's to read.
    if (SLASH_KEYS.some((key) => session.suggestion(key)?.active)) {
      scheduleSave(path, state, session);
      return;
    }
    state.saveTail = state.saveTail.then(() => writeDoc(path, state, session));
  }, SAVE_DEBOUNCE_MS);
}

/**
 * Looks at the file again: when something else wrote it — an agent, another
 * editor — the document takes the change in (`reconcile`). Asked when a
 * document comes forward, when the window does, and while agents work.
 */
export function syncDoc(path: string): Promise<void> {
  const state = states.get(path);
  if (!state) return Promise.resolve();
  state.saveTail = state.saveTail
    .then(async () => {
      const session = state.session();
      if (!session || states.get(path) !== state || session.composing) return;
      const mtime = await fs.stat(path).then(
        (stat) => stat.mtimeMs,
        () => 0,
      );
      if (mtime === state.mtime) return;
      const disk = await readDisk(path);
      if (states.get(path) !== state || session.composing) return;
      if (state.readOnlyFlag()) {
        // A file the editor only shows is shown as it is now.
        if (!disk) return;
        state.disk = disk.text;
        state.mtime = disk.mtime;
        const body = splitFront(disk.text).body;
        replaceContent(session, body);
        state.quiet = session.revision;
        state.base = session.getMarkdown();
        state.dirtyFlag.set(false);
        setTitle(path, state, session, body);
        countWords(state, session);
        return;
      }
      reconcile(path, state, session, disk);
    })
    .catch(() => undefined)
    .then(() => sayChanged(path, state));
  return state.saveTail;
}

/** Every open document looked at again (`syncDoc`). */
export const syncDocs = () => Promise.all([...states.keys()].map(syncDoc)).then(() => undefined);

/** The open document for `path`, made on first ask and kept until `closeDoc`; its editor arrives with the file. `caret: "end"` opens it ready to go on writing. */
export function ensureDoc(path: string, options?: { caret?: "end" }): MarkdownDoc {
  const held = docs.get(path);
  if (held) return held;
  const state: DocState = {
    session: signal<RichEditorSession | undefined>(undefined),
    titleText: signal(displayTitle(path, listedTitle(path))),
    dirtyFlag: signal(false),
    savingFlag: signal(false),
    wordCount: signal(0),
    readOnlyFlag: signal(false),
    lastUpdateEvent: signal<DocUpdateEvent | undefined>(undefined),
    updateCount: signal(0),
    saveTimer: undefined,
    countTimer: undefined,
    saveTail: Promise.resolve(),
    onDisk: false,
    disk: undefined,
    mtime: 0,
    base: "",
    front: "",
    quiet: -1,
    highlightRev: -1,
    changedUnseen: false,
    pendingUpdate: undefined,
    pendingHighlight: undefined,
    highlightTimers: [],
    loaded: Promise.resolve(),
    stopListeners: () => {},
  };
  const doc: MarkdownDoc = {
    path,
    session: () => state.session(),
    title: () => state.titleText(),
    dirty: () => state.dirtyFlag(),
    saving: () => state.savingFlag(),
    words: () => state.wordCount(),
    readOnly: () => state.readOnlyFlag(),
    lastUpdate: () => state.lastUpdateEvent(),
    updateSeq: () => state.updateCount(),
    dismissUpdate: () => state.lastUpdateEvent.set(undefined),
  };
  docs.set(path, doc);
  states.set(path, state);
  opened.update((n) => n + 1);
  if (isNote(path)) openNotes.update((list) => (list.some((n) => n.path === path) ? list : [...list, { path, since: Date.now() }]));
  state.loaded = (closings.get(path) ?? Promise.resolve())
    .then(() => readDisk(path))
    .then((disk) => {
      // Closed before its file was read: there is no one to make an editor for.
      if (states.get(path) !== state) return;
      // A file that is not there yet (a new document) starts empty; the first save makes it.
      const { front, body } = splitFront(disk?.text ?? "");
      const session = makeSession(body);
      state.onDisk = disk !== undefined;
      state.disk = disk?.text;
      state.mtime = disk?.mtime ?? 0;
      state.front = front;
      state.base = session.getMarkdown();
      if (!isGeneratedNoteName(path) && unkept(body)) {
        state.readOnlyFlag.set(true);
        session.setEditable(false);
      }
      if (options?.caret === "end") session.run(focusAt("end"));
      state.stopListeners = session.on("update", (ev) => {
        const rev = (ev as { revision?: number } | undefined)?.revision ?? session.revision;
        if (rev !== state.quiet && session.revision !== state.quiet) {
          if (rev !== state.highlightRev && session.revision !== state.highlightRev) {
            clearHighlight(state, session);
            if (state.lastUpdateEvent()) state.lastUpdateEvent.set(undefined);
          }
          scheduleSave(path, state, session);
        }
      });
      setTitle(path, state, session, body);
      state.wordCount.set(session.words());
      state.session.set(session);
    });
  return doc;
}

export function docAt(path: string): MarkdownDoc | undefined {
  opened();
  return docs.get(path);
}

/** A name for a document tab that works before its session exists: the note's listed title, or the file's name. */
export function docTabTitle(path: string): string {
  opened();
  return docs.get(path)?.title() ?? displayTitle(path, listedTitle(path));
}

/** Whether the document has anything in it worth keeping (a tab nobody wrote in gives its seat up). */
export function docIsBlank(path: string): boolean {
  const state = states.get(path);
  if (!state) return false;
  const session = state.session();
  return !state.onDisk && !state.dirtyFlag() && (!session || session.isEmpty);
}

/**
 * What a document hands to a session: the passage selected in it when there
 * is one, else all of it — as an agent should read it (`plainMarkdown`).
 * `undefined` while the file is still being read.
 */
export function docPassage(path: string): { text: string; excerpt: boolean } | undefined {
  const session = docs.get(path)?.session();
  if (!session) return undefined;
  const selection = session.selection as { type?: string; anchor?: number; head?: number };
  if (selection.type === "text" && selection.anchor !== undefined && selection.head !== undefined && selection.anchor !== selection.head) {
    const from = Math.min(selection.anchor, selection.head);
    const to = Math.max(selection.anchor, selection.head);
    const text = session.textBetween(from, to, "\n\n").trim();
    if (text) return { text, excerpt: true };
  }
  return { text: plainMarkdown(session.getMarkdown()).trim(), excerpt: false };
}

/** The open document's whole text as an agent should read it, as it is now; `undefined` when it is not open. */
export function docText(path: string): string | undefined {
  const session = docs.get(path)?.session();
  return session ? plainMarkdown(session.getMarkdown()).trim() : undefined;
}

/** Full file contents to write when saving a copy elsewhere: preserves front matter and latest edits. */
export async function docFileContent(path: string): Promise<string | undefined> {
  const state = states.get(path);
  const session = state?.session();
  if (state && session) {
    if (state.readOnlyFlag() && state.disk !== undefined) return state.disk;
    const text = session.getMarkdown();
    return state.front ? `${state.front}${state.front.endsWith("\n") ? "" : "\n"}\n${text}` : text;
  }
  return fs.readFile(path, "utf8").catch(() => undefined);
}

/** Closes under way, by path: a document opened again meanwhile reads the file only after the last save landed. */
const closings = new Map<string, Promise<void>>();

/**
 * Applies an AI reply directly into the open document as one undoable step,
 * highlights the exact changed text range with a smooth sweep, and surfaces
 * the floating update pill so the user can undo in one press (`⌘Z`).
 */
export function applyDocEdit(
  path: string,
  mode: "replace" | "insert" | "append",
  markdownText: string,
  range?: { from: number; to: number },
): boolean {
  const state = states.get(path);
  const session = state?.session();
  const body = markdownText.trim();
  if (!state || !session || state.readOnlyFlag() || !body) return false;
  const beforeText = session.textBetween(undefined, undefined, "\n");
  const beforeWords = session.words();
  let changed: { from: number; to: number } | undefined;

  if (mode === "append") {
    const existing = session.getMarkdown().trimEnd();
    const combined = existing ? `${existing}\n\n${body}` : body;
    changed = replaceContent(session, combined);
    session.run(focusAt("end"));
  } else if (mode === "replace" && range && range.to > range.from) {
    const end = lastPos(session);
    const from = Math.max(0, Math.min(range.from, end));
    const to = Math.max(from, Math.min(range.to, end));
    if (to > from) {
      const ok = session.run(chain([deleteRange({ from, to }), insertContent(body, "markdown")]));
      if (!ok) {
        session.run(setTextSelection(from, to));
        session.insertContent(body, "markdown");
      }
    } else {
      session.insertContent(body, "markdown");
    }
    changed = diffChangedRange(session, beforeText);
  } else {
    session.insertContent(body, "markdown");
    changed = diffChangedRange(session, beforeText);
  }

  state.highlightRev = session.revision;
  setTitle(path, state, session, session.getMarkdown());
  countWords(state, session);
  const ev: DocUpdateEvent = {
    id: ++updateEventSeq,
    at: Date.now(),
    source: mode,
    deltaWords: session.words() - beforeWords,
    conflict: false,
  };
  state.updateCount.update((n) => n + 1);
  state.lastUpdateEvent.set(ev);
  if (changed) flashHighlight(state, session, changed);
  scheduleSave(path, state, session);
  session.focus();
  return true;
}

/** Undoes the last change in the open document and clears any active update banner/highlight. */
export function undoDoc(path: string): boolean {
  const state = states.get(path);
  const session = state?.session();
  if (!state || !session || state.readOnlyFlag()) return false;
  const ok = session.run(undoCommand());
  clearHighlight(state, session);
  state.lastUpdateEvent.set(undefined);
  setTitle(path, state, session, session.getMarkdown());
  countWords(state, session);
  session.focus();
  return ok;
}

/** Flushes pending writes and lets the document's session go. */
export function closeDoc(path: string): Promise<void> {
  const doc = docs.get(path);
  const state = states.get(path);
  if (!doc || !state) return closings.get(path) ?? Promise.resolve();
  for (const listener of [...docCloseListeners]) {
    try {
      listener(path);
    } catch {}
  }
  // Off the books at once: the same path opened again is a new document, not this one on its way out.
  docs.delete(path);
  states.delete(path);
  opened.update((n) => n + 1);
  const closing = (async () => {
    await state.loaded;
    const session = state.session();
    if (state.saveTimer !== undefined) {
      clearTimeout(state.saveTimer);
      state.saveTimer = undefined;
    }
    if (state.countTimer !== undefined) clearTimeout(state.countTimer);
    state.stopListeners();
    clearHighlight(state, session);
    const cleanEmptyGenerated = Boolean(session && state.onDisk && session.isEmpty && isNote(path) && isGeneratedNoteName(path));
    if (session && (state.dirtyFlag() || cleanEmptyGenerated)) {
      state.saveTail = state.saveTail.then(() => writeDoc(path, state, session));
    }
    await state.saveTail.catch(() => undefined);
    session?.dispose();
    // The shelf lists what the save left before the open note's own row goes: a written note never blinks off it.
    if (isNote(path)) await refreshNotes();
  })().finally(() => {
    if (closings.get(path) === closing) closings.delete(path);
    if (!docs.has(path)) openNotes.update((list) => (list.some((n) => n.path === path) ? list.filter((n) => n.path !== path) : list));
  });
  closings.set(path, closing);
  return closing;
}

/** A path for a new note under the app's docs folder — the file is made on the first save. */
export async function newDocPath(): Promise<string> {
  const dir = notesDir();
  await fs.mkdir(dir, { recursive: true }).catch(() => undefined);
  const day = new Date().toISOString().slice(0, 10);
  let n = 0;
  for (;;) {
    const path = `${dir}/${NOTE_PREFIX}${day}${n ? `-${n}` : ""}.md`;
    if (!docs.has(path) && !closings.has(path) && !(await fs.exists(path).catch(() => false))) return path;
    n++;
  }
}

/**
 * Writes the document's pending save now. A document on its way to a session
 * is on disk before the agent looks for it: asked to change it, the agent
 * changes the file — which must be what was just written, not what it was a
 * moment before.
 */
export function flushDoc(path: string): Promise<void> {
  const state = states.get(path);
  const session = state?.session();
  if (!state || !session || state.saveTimer === undefined) return state?.saveTail ?? Promise.resolve();
  clearTimeout(state.saveTimer);
  state.saveTimer = undefined;
  state.saveTail = state.saveTail.then(() => writeDoc(path, state, session));
  return state.saveTail;
}

/**
 * Ensures an open writable document exists on disk with its latest contents
 * before handing its path to an inline agent — including a brand-new blank note,
 * so the agent's read/edit tools can update the file immediately without ENOENT.
 */
export function ensureDocOnDisk(path: string): Promise<void> {
  const state = states.get(path);
  if (!state) return Promise.resolve();
  state.saveTail = state.saveTail.then(async () => {
    await state.loaded;
    const session = state.session();
    if (!session || states.get(path) !== state || state.readOnlyFlag()) return;
    if (state.saveTimer !== undefined) {
      clearTimeout(state.saveTimer);
      state.saveTimer = undefined;
      await writeDoc(path, state, session);
    }
    if (state.onDisk) return;
    const text = session.getMarkdown();
    const out = state.front ? `${state.front}${state.front.endsWith("\n") ? "" : "\n"}\n${text}` : text;
    try {
      await fs.mkdir(path.split("/").slice(0, -1).join("/"), { recursive: true });
      await fs.writeFile(path, out);
      state.onDisk = true;
      state.disk = out;
      state.base = text;
      state.mtime = await fs.stat(path).then(
        (stat) => stat.mtimeMs,
        () => 0,
      );
      if (state.saveTimer === undefined) state.dirtyFlag.set(false);
    } catch {
      toast("warning", tr("Could not prepare the document file", "无法准备文档文件"));
    }
  });
  return state.saveTail;
}

/** Writes pending saves of every open document — window close, app quit. */
export async function flushDocs() {
  await Promise.all(
    [...states.entries()].map(async ([path, state]) => {
      const session = state.session();
      if (state.saveTimer !== undefined) {
        clearTimeout(state.saveTimer);
        state.saveTimer = undefined;
        if (session && state.dirtyFlag()) state.saveTail = state.saveTail.then(() => writeDoc(path, state, session));
      }
      await state.saveTail.catch(() => undefined);
    }),
  );
}

// ── Notes: the documents the app keeps ──────────────────────────────────────

export interface NoteSummary {
  path: string;
  title: string;
  /** Milliseconds since the epoch the file was last written. */
  modified: number;
}

/** How many notes are listed at most (newest first). */
const NOTES_LIMIT = 200;
const noteList = signal<NoteSummary[]>([]);
/** The notes open in the editor, and since when: one not written yet has no file to be listed by. */
const openNotes = signal<{ path: string; since: number }[]>([]);
/** A note's title as last listed: a tab restored before its file is read is named already. */
const listedTitle = (path: string) => noteList().find((n) => n.path === path)?.title ?? "";
/** The newest listing asked for: a slower, older one must not land over it. */
let notesAsk = 0;

/**
 * The notes there are, newest first: the files on disk, and the notes open
 * that have none yet — a new note is on the shelf from the press that made
 * it, where its first words will name it. An open note's title is the live
 * one (`docTabTitle`).
 */
export const notes = computed<NoteSummary[]>(() => {
  const listed = noteList();
  const unwritten = openNotes()
    .filter((open) => isNote(open.path) && !listed.some((n) => n.path === open.path))
    .map((open) => ({ path: open.path, title: "", modified: open.since }));
  return unwritten.length ? [...unwritten, ...listed].sort((a, b) => b.modified - a.modified) : listed;
});

/** Reads the notes folder again: on boot, after a save, after a note is deleted. */
export async function refreshNotes() {
  const ask = ++notesAsk;
  const dir = notesDir();
  try {
    const names = (await fs.readdir(dir)).filter((name) => /\.(md|markdown)$/i.test(name));
    const found = await Promise.all(
      names.map(async (name): Promise<NoteSummary | undefined> => {
        const path = `${dir}/${name}`;
        try {
          const stat = await fs.stat(path);
          const before = noteList().find((n) => n.path === path);
          // Unchanged since it was last listed: its title stands, the file is not read again.
          if (before && before.modified === stat.mtimeMs) return before;
          const text = await fs.readFile(path, "utf8");
          const generated = isGeneratedNoteName(path);
          // A generated note with no words in it is no note (one left by a heading typed and taken back).
          if (generated && !titleLine(text, true) && !text.replace(/[#>*_`~\-\s|]/g, "")) return undefined;
          return { path, title: displayTitle(path, titleLine(text, generated)), modified: stat.mtimeMs };
        } catch {
          return undefined;
        }
      }),
    );
    if (ask !== notesAsk) return;
    const list = found
      .filter((n): n is NoteSummary => n !== undefined)
      .sort((a, b) => b.modified - a.modified)
      .slice(0, NOTES_LIMIT);
    const same = list.length === noteList().length && list.every((n, i) => n.path === noteList()[i].path && n.title === noteList()[i].title && n.modified === noteList()[i].modified);
    if (!same) noteList.set(list);
  } catch {
    // No notes folder yet: no notes.
    if (ask === notesAsk && noteList().length) noteList.set([]);
  }
}

/** Removes a note's file (its tab is the caller's to close first). */
export async function deleteNoteFile(path: string) {
  if (!isNote(path)) return;
  await fs.unlink(path).catch(() => undefined);
  await refreshNotes();
}

/** Lets the user choose a custom folder where pipi stores and lists Markdown documents. */
export async function chooseDocsFolder() {
  try {
    const picked = await backend().pickFolder(tr("Choose documents folder", "选择文档文件夹"));
    if (!picked) return;
    setDocsFolderPref(picked);
    await refreshNotes();
  } catch (error) {
    if (error instanceof NoPickerError) {
      toast("warning", tr("No file picker found — install zenity or kdialog to choose folders.", "找不到文件选择器——请安装 zenity 或 kdialog。"));
    } else {
      toast("warning", tr("Could not change the documents folder", "无法更改文档文件夹"));
    }
  }
}

/** Restores the default documents folder (`<dataDir>/docs`). */
export async function resetDocsFolder() {
  setDocsFolderPref(undefined);
  await refreshNotes();
}

/** Opens the documents folder in Finder / Explorer / the file manager. */
export async function revealDocsFolder() {
  const dir = notesDir();
  await fs.mkdir(dir, { recursive: true }).catch(() => undefined);
  await backend().revealPath?.(dir).catch(() => {
    toast("warning", tr("Could not open the documents folder", "无法打开文档文件夹"));
  });
}

/** Reveals a document's file on disk (flushing pending edits first; falls back to its folder if unwritten). */
export async function revealDoc(path: string) {
  await flushDoc(path);
  const exists = await fs.exists(path).catch(() => false);
  const target = exists ? path : path.split("/").slice(0, -1).join("/") || notesDir();
  if (!exists) await fs.mkdir(target, { recursive: true }).catch(() => undefined);
  await backend().revealPath?.(target).catch(() => {
    toast("warning", tr("Could not show the document in the file manager", "无法在文件管理器中显示文档"));
  });
}
