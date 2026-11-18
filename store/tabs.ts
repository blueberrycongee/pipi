import * as fs from "fs/promises";
import { cleanup, computed, effect, signal, untracked } from "nsh";
import { plainMarkdown } from "../lib/doc-wire";
import { tr } from "../lib/i18n";
import { sessionTitle } from "../pi/sessions";
import {
  activeDaemonSessionCount,
  attachDoc,
  composerDraft,
  currentDaemonSession,
  currentView,
  daemonSessionByFile,
  daemonSessionOfId,
  daemonSessionTitle,
  detachDoc,
  docRefText,
  isRunning,
  newSession,
  openDaemonSession,
  openSession,
  savedSessions,
  sessionState,
  setDraft,
  settleDocRef,
  showChat,
  showDoc,
  toast,
} from "./app";
import { backend } from "./backend";
import {
  closeDoc,
  deleteNoteFile,
  docAt,
  docIsBlank,
  docKeys,
  docPassage,
  docTabTitle,
  docText,
  ensureDoc,
  flushDoc,
  isNote,
  newDocPath,
  refreshNotes,
  syncDocs,
} from "./docs";
import { prefsReady, setOpenTabs, storedOpenTabs } from "./prefs";

/**
 * The tab bar's working set: which surfaces are open, in which order. A tab
 * is a chat session or a markdown document.
 *
 * The sidebar is the shelf — every session and note there is, by project and
 * by age; a press there *looks* at one. The strip is the desk — the few
 * things in hand, a press apart. So that looking does not litter the desk,
 * what was only looked at sits in the strip's one **preview** seat (its name
 * in italics), and the next thing looked at takes that seat over. A tab is
 * *kept* once it is worked on — its session runs, its document is written in
 * or taken to a session — or the reader says so (a double press, a drag,
 * New/Open). Closing a tab puts the thing back on the shelf; it deletes
 * nothing and stops nothing.
 *
 * A chat tab's `ref` is the conversation's identity — its session file —
 * not the daemon attach underneath it: one attached agent switches session
 * files in place, and the tab belongs to the conversation, so switching
 * back re-opens the file (the daemon re-attaches as needed). A session with
 * no file yet (a task still on its first run) keeps `"daemon:<id>"` until
 * the daemon says its file; `""` while the chat is still an unstarted draft.
 *
 * The store only *follows* the app: an effect turns every shown chat into a
 * tab, so sessions opened from anywhere — sidebar, palette, `session_send`,
 * a parent chip — appear on the strip without those callers knowing about
 * tabs. Tabs are never dropped when their session leaves the registry: a
 * click re-attaches, and a stale one keeps its title for next launch.
 */

export interface OpenTab {
  kind: "chat" | "doc";
  ref: string;
  /** chat with a `"daemon:"` ref only: the session file it resolved to once. */
  file?: string;
  /** Only looked at so far: the next thing looked at takes this tab's seat. */
  preview?: boolean;
}

export const tabId = (tab: OpenTab) => `${tab.kind}:${tab.ref}`;

const DAEMON_REF = "daemon:";
const daemonRefId = (ref: string) => (ref.startsWith(DAEMON_REF) ? ref.slice(DAEMON_REF.length) : undefined);

const tabs = signal<OpenTab[]>([]);
export const openTabs = () => tabs();

/** The shown chat surface's tab ref: its file, `"daemon:<id>"` file-less, `""` the draft. */
function currentChatRef(): string {
  const file = sessionState()?.sessionFile;
  if (file) return file;
  const ds = currentDaemonSession();
  if (ds?.file) return ds.file;
  return ds ? `${DAEMON_REF}${ds.id}` : "";
}

/** The tab the main pane is on; `undefined` on surfaces outside the strip (settings). */
export const activeTabId = computed(() => {
  const v = currentView();
  if (v.name === "doc") return `doc:${v.docId}`;
  if (v.name === "chat") return `chat:${currentChatRef()}`;
  return undefined;
});

function persist() {
  // Writes before `loadPrefs` resolves would clobber the still-unread stored
  // preferences: the boot draft's seat lands before the first screen does.
  if (prefsReady()) setOpenTabs(tabs());
}

function indexOf(tab: OpenTab) {
  return tabs().findIndex((t) => tabId(t) === tabId(tab));
}

function insertTab(tab: OpenTab) {
  if (indexOf(tab) >= 0) return;
  tabs.set([...tabs(), tab]);
  persist();
}

/**
 * Seats a tab that was only looked at: in the preview seat when the strip has
 * one (what sat there goes back to the shelf), else at the strip's end.
 */
function seatPreview(tab: OpenTab) {
  if (indexOf(tab) >= 0) return;
  const list = tabs();
  const seat = list.findIndex((t) => t.preview);
  if (seat < 0) {
    insertTab({ ...tab, preview: true });
    return;
  }
  const left = list[seat];
  const next = [...list];
  next[seat] = { ...tab, preview: true };
  tabs.set(next);
  persist();
  if (left.kind === "doc") letDocGo(left.ref);
}

/** A document's tab is gone: its editor goes after a last save, and a card it has on the composer keeps what it said. */
function letDocGo(path: string) {
  const text = docText(path);
  if (text !== undefined) settleDocRef(path, text);
  void closeDoc(path);
}

/** The tab stays: it was worked on, or the reader said so. */
export function keepTab(id: string | undefined) {
  if (!id || !tabs().some((t) => t.preview && tabId(t) === id)) return;
  tabs.set(tabs().map((t) => (t.preview && tabId(t) === id ? { ...t, preview: undefined } : t)));
  persist();
}

/** The tab already stands for the shown chat: by its ref, or by a `"daemon:"` name whose session the file belongs to. */
const ownsChat = (t: OpenTab, ref: string) =>
  t.kind === "chat" &&
  (t.ref === ref || (daemonRefId(t.ref) !== undefined && daemonSessionOfId(daemonRefId(t.ref)!)?.file === ref));

/**
 * Chat refs closed while they were shown: activating the neighbour is async,
 * so the surface still reports the closed ref for a moment — the effect must
 * not resurrect its tab in that window. A ban lifts once the surface shows
 * any other ref, so re-opening the session later makes a tab again.
 */
const closedShownRefs = new Set<string>();

/**
 * Follows the app: the shown chat's tab exists. The boot draft's seat goes to
 * the first session that attaches in place — a fresh strip grows no dead
 * draft — and a tab still on its daemon name takes the file's once the
 * session says it.
 */
effect(() => {
  if (currentView().name !== "chat") {
    // The surface left chat entirely: every close-ban has done its job.
    closedShownRefs.clear();
    return;
  }
  const ref = currentChatRef();
  const file = daemonRefId(ref) ? undefined : ref || undefined;
  untracked(() => {
    for (const closed of [...closedShownRefs]) if (closed !== ref) closedShownRefs.delete(closed);
    const list = tabs();
    if (!ref) {
      if (!list.some((t) => t.kind === "chat" && !t.ref)) insertTab({ kind: "chat", ref: "" });
      return;
    }
    // The surface still reports a ref whose tab was just closed: hold off
    // until the neighbour's open lands and reports its own.
    if (closedShownRefs.has(ref)) return;
    const draftIndex = list.findIndex((t) => t.kind === "chat" && !t.ref);
    if (draftIndex >= 0) {
      // The draft became a real session: it keeps its place on the strip.
      if (!list.some((t) => ownsChat(t, ref))) {
        const next = [...list];
        // Only looked at, until it runs: a draft the reader sent from is running already.
        next[draftIndex] = { kind: "chat", ref, file, preview: true };
        tabs.set(next);
        persist();
        return;
      }
      // A draft and this session's tab both exist: the session's wins.
      tabs.set(list.filter((t, i) => i !== draftIndex));
      persist();
      return;
    }
    const held = list.find((t) => ownsChat(t, ref));
    if (!held) {
      seatPreview({ kind: "chat", ref, file });
      return;
    }
    if (held.ref !== ref) {
      tabs.set(list.map((t) => (t === held ? { ...t, ref, file } : t)));
      persist();
    } else if (file && held.file !== file) {
      tabs.set(list.map((t) => (t === held ? { ...t, file } : t)));
      persist();
    }
  });
});

/**
 * Work keeps a tab: the shown session running (a message was sent in it), a
 * session at work or waiting on the reader off screen, a document written in.
 */
effect(() => {
  const activeRef = currentView().name === "chat" ? currentChatRef() : undefined;
  const runningHere = activeRef !== undefined && isRunning();
  const worked = tabs().filter((t) => {
    if (!t.preview) return false;
    if (t.kind === "doc") return docAt(t.ref)?.dirty() === true;
    // A live tab may still carry its daemon id while the session state has
    // already reported the file. Match the conversation, not the temporary
    // ref, so the prompt that keeps a preview cannot be lost during attach.
    if (runningHere && ownsChat(t, activeRef!)) return true;
    const status = chatTabSession(t)?.status;
    return status === "working" || status === "blocked";
  });
  if (worked.length) {
    untracked(() => worked.forEach((t) => keepTab(tabId(t))));
  }
});

/** A `"daemon:<id>"` tab whose session gained a file takes the file as its ref (the conversation is the identity). */
effect(() => {
  const list = tabs();
  const resolved = list.filter(
    (t) => t.kind === "chat" && daemonRefId(t.ref) && (daemonSessionOfId(daemonRefId(t.ref)!)?.file ?? t.file),
  );
  if (!resolved.length) return;
  untracked(() => {
    const next: OpenTab[] = [];
    for (const t of list) {
      const file = daemonRefId(t.ref) ? (daemonSessionOfId(daemonRefId(t.ref)!)?.file ?? t.file) : undefined;
      const to: OpenTab = file ? { ...t, ref: file } : t;
      // Folding into a ref another tab already owns (earlier or later in the strip) drops the duplicate.
      if (to !== t && list.some((o) => o !== t && tabId(o) === tabId(to))) continue;
      next.push(to);
    }
    if (next.length !== list.length || next.some((t, i) => t !== list[i])) {
      tabs.set(next);
      persist();
    }
  });
});

let restored = false;

/**
 * Restores the strip from prefs once `loadPrefs` lands (views mount before
 * it resolves). Tabs the follow-effect already made for the session boot
 * opened stay: the stored order comes first, they append after it.
 */
effect(() => {
  if (!prefsReady() || restored) return;
  restored = true;
  void refreshNotes();
  const stored = untracked(storedOpenTabs);
  if (!stored?.length) return;
  untracked(() => {
    const merged: OpenTab[] = stored.map((t) => ({ kind: t.kind === "doc" ? "doc" : "chat", ref: t.ref, file: t.file, preview: t.preview }));
    // One preview seat: of several stored (or one stored and the boot's), the first stands.
    let seat = false;
    for (const t of merged) {
      if (t.preview && seat) t.preview = undefined;
      seat ||= !!t.preview;
    }
    for (const t of tabs()) if (!merged.some((m) => tabId(m) === tabId(t))) merged.push(t);
    tabs.set(merged);
  });
  void dropUnwrittenNotes();
});

/**
 * A restored tab on a note that has no file — one nobody wrote in before the
 * app last closed, or one deleted since — stands for nothing: it leaves the
 * strip rather than coming back as a blank page.
 */
async function dropUnwrittenNotes() {
  for (const tab of tabs()) {
    if (tab.kind !== "doc" || !isNote(tab.ref) || docAt(tab.ref)) continue;
    if (await fs.exists(tab.ref).catch(() => true)) continue;
    if (!docAt(tab.ref) && activeTabId() !== tabId(tab)) closeTab(tabId(tab));
  }
}

/** The live daemon session behind a chat tab, when the daemon still knows it (status marks, the agent's logo). */
export function chatTabSession(tab: OpenTab) {
  if (tab.kind !== "chat") return undefined;
  const id = daemonRefId(tab.ref);
  return id ? daemonSessionOfId(id) : daemonSessionByFile(tab.ref);
}

/** A chat tab's label: the live title for the open session, the registry's or the file's for the rest. */
export function chatTabTitle(tab: OpenTab): string {
  if (!tab.ref) return tr("New Session", "新会话");
  const id = daemonRefId(tab.ref);
  const ds = id ? daemonSessionOfId(id) : daemonSessionByFile(tab.ref);
  const file = id ? (ds?.file ?? tab.file) : tab.ref;
  if (file) {
    // A saved conversation's name is stable even while its daemon is running
    // and reports a transient title from the latest prompt.
    const summary = savedSessions().find((s) => s.path === file);
    if (summary) return sessionTitle(summary, file.split("/").pop() ?? file);
    const base = file.split("/").pop() ?? file;
    if (base && !base.endsWith(".jsonl")) return base;
    return base.replace(/\.pipi-agent\.jsonl$|\.jsonl$/, "") || (ds ? daemonSessionTitle(ds) : tr("Session", "会话"));
  }
  // The daemon calls an untitled session "New session": `daemonSessionTitle`
  // reads that as untitled and answers in the reader's language.
  return ds ? daemonSessionTitle(ds) : tr("Session", "会话");
}

/** Shows a tab: its chat session attaches, or its document opens. */
export function selectTab(tab: OpenTab) {
  if (tab.kind === "doc") {
    ensureDoc(tab.ref);
    showDoc(tab.ref);
    return;
  }
  if (!tab.ref) {
    newSession();
    return;
  }
  const id = daemonRefId(tab.ref);
  if (id) {
    // A daemon ref that outlived its process still knows the file it resolved
    // to once — reopen by it rather than dead-ending the click.
    if (daemonSessionOfId(id)) openDaemonSession(id);
    else if (tab.file) void openSession(tab.file);
    return;
  }
  void openSession(tab.ref);
}

/** Cycles the strip by `delta` tabs (⌘⇧]'s). */
export function cycleTab(delta: number) {
  const list = tabs();
  if (list.length < 2) return;
  const active = activeTabId();
  const at = Math.max(0, list.findIndex((t) => tabId(t) === active));
  const next = list[(at + delta + list.length) % list.length];
  selectTab(next);
}

/** Moves the tab to `index` in the strip's final order (a drag's drop slot). */
export function moveTab(id: string, index: number) {
  const list = tabs();
  const from = list.findIndex((t) => tabId(t) === id);
  if (from < 0) return;
  const next = [...list];
  const [moved] = next.splice(from, 1);
  // Placing a tab is a say on it: it stays.
  const tab = moved.preview ? { ...moved, preview: undefined } : moved;
  next.splice(Math.max(0, Math.min(index, next.length)), 0, tab);
  tabs.set(next);
  persist();
}

/**
 * Closes a tab: a document flushes its save and lets go of its session; a
 * chat only leaves the strip — the daemon session keeps running (the
 * sidebar keeps its mark). Closing the active tab opens the one beside it,
 * or a fresh chat when it was the last.
 */
export function closeTab(id: string) {
  const list = tabs();
  const index = list.findIndex((t) => tabId(t) === id);
  if (index < 0) return;
  const tab = list[index];
  const wasActive = activeTabId() === id;
  const next = list.filter((t) => tabId(t) !== id);
  tabs.set(next);
  persist();
  if (tab.kind === "doc") letDocGo(tab.ref);
  if (!wasActive) return;
  if (tab.kind === "chat" && tab.ref) {
    // The surface still reports this ref until the neighbour's open lands.
    closedShownRefs.add(tab.ref);
    const d = daemonRefId(tab.ref);
    const f = d ? (daemonSessionOfId(d)?.file ?? tab.file) : undefined;
    if (f) closedShownRefs.add(f);
  }
  const neighbor = next[Math.min(index, next.length - 1)];
  if (neighbor) selectTab(neighbor);
  else newSession();
}

/**
 * A new document, open and kept: the file is made by its first words (one
 * nobody wrote in leaves nothing). A blank one already open is the new
 * document — asking twice does not make two.
 */
export async function newDocTab() {
  const blank = tabs().find((t) => t.kind === "doc" && isNote(t.ref) && docIsBlank(t.ref));
  if (blank) return openDocTab(blank.ref);
  openDocTab(await newDocPath());
}

/**
 * The composer's draft goes on as a document: a message that outgrew the
 * field is moved, not copied, into a new note — where Return is a new line
 * and every word is saved — with the caret after its last word. Nothing
 * drafted: a blank document.
 */
export async function draftToDoc() {
  const text = composerDraft();
  if (!text.trim()) return newDocTab();
  const path = await newDocPath();
  try {
    await fs.writeFile(path, `${text.replace(/\s+$/, "")}\n`);
  } catch {
    toast("warning", tr("Could not save the document", "无法保存文档"));
    return;
  }
  setDraft("");
  void refreshNotes();
  ensureDoc(path, { caret: "end" });
  openDocTab(path);
}

/**
 * A Markdown file as a document tab. Asked for by name (a pick, a drop, New)
 * it is kept; `preview` is a look from the shelf, in the preview seat.
 */
export function openDocTab(path: string, options?: { preview?: boolean }) {
  ensureDoc(path);
  const tab: OpenTab = { kind: "doc", ref: path };
  if (options?.preview) seatPreview(tab);
  else if (indexOf(tab) >= 0) keepTab(tabId(tab));
  else insertTab(tab);
  showDoc(path);
}

/** Opens a document named by something said earlier (a card on a sent message): it may have been deleted since. */
export async function openDocIfThere(path: string) {
  if (docAt(path) || (await fs.exists(path).catch(() => false))) openDocTab(path);
  else toast("info", tr("That document is no longer there", "这篇文档已经不在了"));
}

/** The system's file picker onto a Markdown file, opened as a document tab. */
export async function pickDocTab() {
  const pick = backend().pickFile;
  if (!pick) return;
  const path = await pick(tr("Open a Markdown document", "打开一个 Markdown 文档"), ["md", "markdown", "mdown", "txt"]);
  if (path) openDocTab(path);
}

// ── Between a document and a session ────────────────────────────────────────

/**
 * Takes a document to the session: it is attached to the message being
 * written — the passage selected in it when there is one, else all of it —
 * and the chat comes forward. Nothing is sent and nothing is pasted: the
 * words stay in the document. Sent without a word of its own the message is
 * the document's text; with one, the document rides behind it, its file
 * named so the agent can change it where it lives (`lib/doc-wire.ts`). It
 * goes where the composer's message goes — the session in front, or
 * whichever the reader moves to before sending.
 */
export function addDocToChat(path: string) {
  const passage = docPassage(path);
  if (!passage) return;
  if (!passage.text) {
    toast("info", tr("Nothing written to add yet", "还没有写下可以添加的内容"));
    return;
  }
  attachDoc({ path, title: docTabTitle(path), text: passage.text, ...(passage.excerpt ? { excerpt: true } : {}) });
  void flushDoc(path);
  keepTab(`doc:${path}`);
  showChat();
}

/** A document on the shelf taken to the session whole, without opening it: its file is read as it stands. */
export async function addNoteToChat(path: string) {
  const text = docText(path) ?? plainMarkdown(await fs.readFile(path, "utf8").catch(() => "")).trim();
  if (!text) {
    toast("info", tr("Nothing written to add yet", "还没有写下可以添加的内容"));
    return;
  }
  attachDoc({ path, title: docTabTitle(path), text });
  showChat();
}

docKeys.send = addDocToChat;
// An attached document is sent as it reads when sent: what was written after attaching goes too, and is on disk by then.
docRefText.read = (ref) => {
  void flushDoc(ref.path);
  return docText(ref.path) || ref.text;
};

/**
 * While agents work, the open documents look at their files: one asked to
 * rewrite a paragraph writes the file, and the document takes it in as it
 * lands — and once more when the work ends.
 */
effect(() => {
  if (!tabs().some((t) => t.kind === "doc")) return;
  if (!isRunning() && activeDaemonSessionCount() === 0) return;
  const timer = setInterval(() => void syncDocs(), 1200);
  cleanup(() => {
    clearInterval(timer);
    void syncDocs();
  });
});

/** Keeps a piece of a conversation (a reply) as a new document, opened beside the chat. */
export async function noteFromText(text: string) {
  const body = text.trim();
  if (!body) return;
  const path = await newDocPath();
  try {
    await fs.writeFile(path, `${body}\n`);
  } catch {
    toast("warning", tr("Could not save the document", "无法保存文档"));
    return;
  }
  void refreshNotes();
  openDocTab(path);
}

/** Deletes a note for good: its tab closes, its file goes. */
export async function deleteNote(path: string) {
  detachDoc(path);
  const id = `doc:${path}`;
  if (tabs().some((t) => tabId(t) === id)) {
    closeTab(id);
    // The close flushes a last save: the file must go after it, not before.
    await closeDoc(path);
  }
  await deleteNoteFile(path);
}

export { docTabTitle };
