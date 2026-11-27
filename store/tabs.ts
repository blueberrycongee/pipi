import * as fs from "fs/promises";
import { batch, cleanup, computed, effect, signal, untracked } from "nsh";
import { plainMarkdown } from "../lib/doc-wire";
import { tr } from "../lib/i18n";
import { sessionTitle } from "../pi/sessions";
import {
  activeDaemonSessionCount,
  activeProjectPath,
  attachDoc,
  composerAttachments,
  composerDocs,
  composerDraft,
  currentDaemonSession,
  currentTitle,
  currentView,
  daemonSessionByFile,
  daemonSessionOfId,
  daemonSessionTitle,
  detachDoc,
  docOpener,
  docRefText,
  ensureChatFolder,
  findKnownSessionSummary,
  isChatFolder,
  isRunning,
  isSwitching,
  lastProject,
  newSession,
  newSessionInWorkspace,
  openDaemonSession,
  openSession,
  pendingSession,
  savedSessions,
  sessionState,
  setDraft,
  settleDocRef,
  showChat,
  showDoc,
  toast,
  transcriptRows,
  workspaceSessions,
} from "./app";
import { backend, NoPickerError } from "./backend";
import {
  closeDoc,
  deleteNoteFile,
  docAt,
  docFileContent,
  docIsBlank,
  docPassage,
  docTabTitle,
  docText,
  ensureDoc,
  flushDoc,
  isNote,
  newDocPath,
  notes,
  notesDir,
  refreshNotes,
  syncDocs,
} from "./docs";
import { forgetDocRank, prefsReady, setGroupCollapsed, setOpenTabs, storedOpenTabs } from "./prefs";

/**
 * The tab bar's working set: which surfaces are open, in which order. A tab
 * is a chat session or a markdown document.
 *
 * The sidebar is the shelf — every session and note there is, by project and
 * by age. The strip follows Obsidian's rule: the reader owns its tabs. A plain
 * click in the sidebar navigates inside the **current** tab (replacing what it
 * shows, or switching to an existing tab if that surface is already open);
 * `⌘`-click, middle-click, `"Open in New Tab"`, `+`, or `⌘T` opens a new tab.
 * There is no preview seat and no tab ever spawns or vanishes on its own.
 * Closing a tab puts the thing back on the shelf; it deletes nothing and stops
 * nothing.
 *
 * A chat tab's `ref` is the conversation's identity — its session file —
 * not the daemon attach underneath it: one attached agent switches session
 * files in place, and the tab belongs to the conversation, so switching
 * back re-opens the file (the daemon re-attaches as needed). A session with
 * no file yet (a task still on its first run) keeps `"daemon:<id>"` until
 * the daemon says its file; `""` or `"draft:<n>"` while the tab is an
 * unstarted new session.
 */

export interface OpenTab {
  kind: "chat" | "doc";
  ref: string;
  /** chat with a `"daemon:"` ref only: the session file it resolved to once. */
  file?: string;
}

export const tabId = (tab: OpenTab) => `${tab.kind}:${tab.ref}`;

const DAEMON_REF = "daemon:";
const DRAFT_REF = "draft:";
const daemonRefId = (ref: string) => (ref.startsWith(DAEMON_REF) ? ref.slice(DAEMON_REF.length) : undefined);
export const isDraftRef = (ref: string) => ref === "" || ref.startsWith(DRAFT_REF);

const tabs = signal<OpenTab[]>([]);
export const openTabs = () => tabs();

/** Which draft tab is active when the chat view shows an unstarted new session. */
const activeDraftRef = signal<string | undefined>(undefined);
/** The draft tabs that hold a chat, so coming back to one starts it in the chat folder again. */
const chatDrafts = new Set<string>();

/** Marks the draft tab on screen by the folder it is in now, as it is left. */
function noteDraftFolder() {
  const ref = activeDraftRef();
  if (ref === undefined) return;
  if (isChatFolder(activeProjectPath())) chatDrafts.add(ref);
  else chatDrafts.delete(ref);
}
/** Last active tab on the strip (remembered while Settings is open so sidebar clicks replace it). */
let lastActiveId: string | undefined;
let draftSeq = 0;

function nextDraftRef(): string {
  const used = new Set(tabs().map((t) => t.ref));
  while (true) {
    const ref = `${DRAFT_REF}${++draftSeq}`;
    if (!used.has(ref)) return ref;
  }
}

/**
 * Documents opened by expanding a session's composer draft (`⌘E` / `draftToDoc`):
 * remembers which chat ref they came from so they can return directly to it.
 */
const draftOrigins = signal<Record<string, string>>({});

function clearDraftOrigin(path: string) {
  if (!(path in draftOrigins())) return;
  draftOrigins.update((all) => {
    const next = { ...all };
    delete next[path];
    return next;
  });
}

/** True when the chat surface is an unstarted blank new session (even if Pi assigned a file at boot). */
function isCurrentChatUnstarted(): boolean {
  const pending = pendingSession();
  if (pending) return !pending.file && !pending.daemonId;
  const ds = currentDaemonSession();
  if (ds && (ds.parentId || ds.persona || ds.initiator === "external" || ds.status !== "idle" || ds.unread)) return false;
  if (transcriptRows().length > 0 || (sessionState()?.messageCount ?? 0) > 0 || isRunning()) return false;
  const file = sessionState()?.sessionFile;
  if (file && findKnownSessionSummary(file)) return false;
  return true;
}

/** The shown chat surface's real conversation ref: pending destination, else file, else daemon id, else "". */
function liveChatRef(): string {
  const pending = pendingSession();
  if (pending) {
    if (pending.file) return pending.file;
    if (pending.daemonId) {
      const ds = daemonSessionOfId(pending.daemonId);
      return ds?.file ?? `${DAEMON_REF}${pending.daemonId}`;
    }
    return "";
  }
  const file = sessionState()?.sessionFile;
  if (file) return file;
  const ds = currentDaemonSession();
  if (ds?.file) return ds.file;
  return ds ? `${DAEMON_REF}${ds.id}` : "";
}

/** The shown chat surface's tab ref: its file, `"daemon:<id>"` file-less, or the active draft tab's ref. */
function currentChatRef(): string {
  const real = isCurrentChatUnstarted() ? "" : liveChatRef();
  if (real) return real;
  const list = tabs();
  const preferred = activeDraftRef();
  if (preferred !== undefined && list.some((t) => t.kind === "chat" && t.ref === preferred)) return preferred;
  const anyDraft = list.find((t) => t.kind === "chat" && isDraftRef(t.ref));
  return anyDraft ? anyDraft.ref : "";
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

/** A document's tab is gone: its editor goes after a last save, and a card it has on the composer keeps what it said. */
function letDocGo(path: string) {
  clearDraftOrigin(path);
  const text = docText(path);
  if (text !== undefined) settleDocRef(path, text);
  void closeDoc(path);
}

/** The tab already stands for the shown chat: by its ref, or by a `"daemon:"` name whose session the file belongs to. */
const ownsChat = (t: OpenTab, ref: string) =>
  t.kind === "chat" &&
  !isDraftRef(t.ref) &&
  (t.ref === ref || (daemonRefId(t.ref) !== undefined && daemonSessionOfId(daemonRefId(t.ref)!)?.file === ref));

/**
 * Chat refs closed or replaced while they were shown: activating the next
 * session is async, so the surface can still report the old ref for a moment —
 * the follow-effect must not resurrect its tab in that window. A ban lifts
 * once the surface moves to any other ref, or when opened again explicitly.
 */
const closedShownRefs = new Set<string>();

function banShownChatRef(ref: string | undefined, file?: string) {
  if (ref && !isDraftRef(ref)) {
    closedShownRefs.add(ref);
    const d = daemonRefId(ref);
    const f = d ? (daemonSessionOfId(d)?.file ?? file) : undefined;
    if (f) closedShownRefs.add(f);
  }
}

/** Index of the active tab (or the last active tab before Settings opened). */
function currentSlotIndex(list: OpenTab[]): number {
  const active = activeTabId() ?? lastActiveId;
  if (active) {
    const at = list.findIndex((t) => tabId(t) === active);
    if (at >= 0) return at;
  }
  return list.length - 1;
}

/** Replaces the tab at `slot` with `tab` (or appends when the strip is empty), letting any replaced doc go. */
function replaceSlot(list: OpenTab[], slot: number, tab: OpenTab) {
  if (slot < 0 || slot >= list.length) {
    tabs.set([...list, tab]);
    persist();
    return;
  }
  const left = list[slot];
  if (tabId(left) === tabId(tab)) return;
  if (left.kind === "chat") banShownChatRef(left.ref, left.file);
  const next = [...list];
  next[slot] = tab;
  tabs.set(next);
  persist();
  if (left.kind === "doc") letDocGo(left.ref);
}

/**
 * Places `tab` on the strip: if it is already open, keeps the strip as is (the
 * caller switches to it); otherwise replaces the current tab (`"replace"`) or
 * appends a new one (`"new"`).
 */
function placeTab(tab: OpenTab, mode: "replace" | "new") {
  const list = tabs();
  const existing = list.findIndex((t) =>
    tab.kind === "chat" && tab.ref && !isDraftRef(tab.ref) ? ownsChat(t, tab.ref) : tabId(t) === tabId(tab),
  );
  if (existing >= 0) return;
  if (mode === "new") {
    tabs.set([...list, tab]);
    persist();
    return;
  }
  replaceSlot(list, currentSlotIndex(list), tab);
}

effect(() => {
  const active = activeTabId();
  if (active && untracked(tabs).some((t) => tabId(t) === active)) {
    lastActiveId = active;
  }
});

/**
 * Follows the app: ensures the shown chat has its tab without ever spawning
 * unasked-for tabs. An active draft tab promotes in place once its session
 * starts; a chat opened directly (outside `openSessionTab`) replaces the
 * current tab in place unless it is already open in the strip.
 */
effect(() => {
  if (currentView().name !== "chat") {
    // The surface left chat entirely: every close-ban has done its job.
    closedShownRefs.clear();
    return;
  }
  const real = isCurrentChatUnstarted() ? "" : liveChatRef();
  const file = real && !daemonRefId(real) ? real : undefined;
  untracked(() => {
    for (const closed of [...closedShownRefs]) if (closed !== real) closedShownRefs.delete(closed);
    const list = tabs();
    if (!real) {
      const preferred = activeDraftRef();
      if (preferred !== undefined && list.some((t) => t.kind === "chat" && t.ref === preferred)) return;
      if (list.some((t) => t.kind === "chat" && isDraftRef(t.ref))) return;
      if (list.length === 0) {
        tabs.set([{ kind: "chat", ref: "" }]);
        persist();
      } else {
        replaceSlot(list, currentSlotIndex(list), { kind: "chat", ref: "" });
      }
      activeDraftRef.set("");
      return;
    }
    // The surface still reports a ref whose tab was just closed or replaced:
    // hold off until the destination's open lands and reports its own.
    if (closedShownRefs.has(real)) return;
    const held = list.find((t) => ownsChat(t, real));
    if (held) {
      if (held.ref !== real) {
        tabs.set(list.map((t) => (t === held ? { ...t, ref: real, file } : t)));
        persist();
      } else if (file && held.file !== file) {
        tabs.set(list.map((t) => (t === held ? { ...t, file } : t)));
        persist();
      }
      return;
    }
    // The active draft tab started a real conversation: promote that exact tab in place.
    const preferredDraft = activeDraftRef();
    const draftIdx =
      preferredDraft !== undefined
        ? list.findIndex((t) => t.kind === "chat" && t.ref === preferredDraft)
        : list.findIndex((t) => t.kind === "chat" && isDraftRef(t.ref) && tabId(t) === lastActiveId);
    if (draftIdx >= 0) {
      const next = [...list];
      next[draftIdx] = { kind: "chat", ref: real, file };
      tabs.set(next);
      persist();
      activeDraftRef.set(undefined);
      return;
    }
    // A session opened directly (outside `openSessionTab`, e.g. subagent chip, Settings, harness):
    // navigate inside the current tab rather than adding one on its own.
    replaceSlot(list, currentSlotIndex(list), { kind: "chat", ref: real, file });
  });
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
    const merged: OpenTab[] = stored.map((t) => ({ kind: t.kind === "doc" ? "doc" : "chat", ref: t.ref, file: t.file }));
    for (const t of merged) {
      if (t.kind === "chat" && t.ref.startsWith(DRAFT_REF)) {
        const n = Number(t.ref.slice(DRAFT_REF.length));
        if (Number.isFinite(n) && n > draftSeq) draftSeq = n;
      }
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
  if (tab.kind !== "chat" || isDraftRef(tab.ref)) return undefined;
  const id = daemonRefId(tab.ref);
  return id ? daemonSessionOfId(id) : daemonSessionByFile(tab.ref);
}

/** A chat tab's label: the name its sidebar row shows — a daemon row's word for a nested or fileless session, else its file's listed title. */
export function chatTabTitle(tab: OpenTab): string {
  if (isDraftRef(tab.ref)) return tr("New session", "新会话");
  const id = daemonRefId(tab.ref);
  const ds = id ? daemonSessionOfId(id) : daemonSessionByFile(tab.ref);
  const file = id ? (ds?.file ?? tab.file) : tab.ref;
  if (file) {
    const base = file.split("/").pop() ?? file;
    const fallback = base && !base.endsWith(".jsonl")
      ? base
      : base.replace(/\.pipi-agent\.jsonl$|\.jsonl$/, "") || tr("Session", "会话");
    // The daemon registry carries a delegated task's given title and a persona's
    // name; `daemonSessionTitle` still lets a user-renamed saved file win.
    if (ds) return daemonSessionTitle(ds, fallback);
    const summary = findKnownSessionSummary(file);
    if (summary) return sessionTitle(summary, fallback);
    return fallback;
  }
  // The daemon calls an untitled session "New session": `daemonSessionTitle`
  // reads that as untitled and answers in the reader's language.
  return ds ? daemonSessionTitle(ds) : tr("Session", "会话");
}

/** Shows a tab: its chat session attaches, or its document opens. */
export function selectTab(tab: OpenTab) {
  noteDraftFolder();
  if (tab.kind === "doc") {
    ensureDoc(tab.ref);
    showDoc(tab.ref);
    return;
  }
  if (isDraftRef(tab.ref)) {
    activeDraftRef.set(tab.ref);
    showChat();
    if (chatDrafts.has(tab.ref)) void ensureChatFolder().then(newSessionInWorkspace);
    else if (isChatFolder(activeProjectPath())) void newSessionInWorkspace(lastProject());
    else void newSession();
    return;
  }
  activeDraftRef.set(undefined);
  closedShownRefs.delete(tab.ref);
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

/** Opens a saved session in the current tab (default) or a new tab (`newTab: true`: ⌘-click / middle-click). */
export function openSessionTab(path: string, cwd?: string, options?: { newTab?: boolean; agentId?: string }) {
  closedShownRefs.delete(path);
  const hidden = liveChatRef();
  if (hidden && hidden !== path && !tabs().some((t) => ownsChat(t, hidden))) banShownChatRef(hidden);
  let result: ReturnType<typeof openSession>;
  batch(() => {
    placeTab({ kind: "chat", ref: path, file: path }, options?.newTab ? "new" : "replace");
    activeDraftRef.set(undefined);
    result = openSession(path, cwd, options?.agentId);
  });
  return result!;
}

/** Opens a daemon session in the current tab (default) or a new tab (`newTab: true`: ⌘-click / middle-click). */
export function openDaemonSessionTab(sessionId: string, options?: { newTab?: boolean }) {
  const ds = daemonSessionOfId(sessionId);
  if (!ds) return;
  const ref = ds.file ?? `${DAEMON_REF}${ds.id}`;
  closedShownRefs.delete(ref);
  if (ds.file) closedShownRefs.delete(ds.file);
  const hidden = liveChatRef();
  if (hidden && hidden !== ref && !tabs().some((t) => ownsChat(t, hidden))) banShownChatRef(hidden);
  batch(() => {
    placeTab({ kind: "chat", ref, ...(ds.file ? { file: ds.file } : {}) }, options?.newTab ? "new" : "replace");
    activeDraftRef.set(undefined);
    openDaemonSession(sessionId);
  });
}

/**
 * Starts a fresh empty session: in the current tab by default (⌘N, sidebar
 * "New session"), or in a brand-new tab (`newTab: true`: TabBar `+`, ⌘T,
 * ⌘-click).
 */
export function openNewSessionTab(options?: { newTab?: boolean; cwd?: string }) {
  let result: ReturnType<typeof newSession> | ReturnType<typeof newSessionInWorkspace>;
  // A new session from a chat goes back to the project last worked in.
  const cwd = options?.cwd ?? (isChatFolder(activeProjectPath()) ? lastProject() : undefined);
  batch(() => {
    noteDraftFolder();
    const list = tabs();
    if (options?.newTab) {
      const ref = nextDraftRef();
      tabs.set([...list, { kind: "chat", ref }]);
      persist();
      activeDraftRef.set(ref);
    } else {
      const slot = currentSlotIndex(list);
      const cur = slot >= 0 ? list[slot] : undefined;
      if (cur && cur.kind === "chat" && isDraftRef(cur.ref)) {
        activeDraftRef.set(cur.ref);
      } else {
        const ref = list.some((t) => t.kind === "chat" && t.ref === "") ? nextDraftRef() : "";
        replaceSlot(list, slot, { kind: "chat", ref });
        activeDraftRef.set(ref);
      }
    }
    const ref = activeDraftRef();
    if (ref !== undefined) {
      if (isChatFolder(cwd)) chatDrafts.add(ref);
      else chatDrafts.delete(ref);
    }
    if (cwd) {
      result = newSessionInWorkspace(cwd);
    } else {
      showChat();
      result = newSession();
    }
  });
  return result!;
}

/** Starts a chat with no project (`chatFolder`), here or in a brand-new tab like `openNewSessionTab`. */
export async function openNewChatTab(options?: { newTab?: boolean }) {
  const cwd = await ensureChatFolder();
  return openNewSessionTab({ newTab: options?.newTab, cwd });
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
  next.splice(Math.max(0, Math.min(index, next.length)), 0, moved);
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
  batch(() => {
    tabs.set(next);
    persist();
    if (activeDraftRef() === tab.ref) activeDraftRef.set(undefined);
    if (!wasActive) return;
    if (tab.kind === "chat") banShownChatRef(tab.ref, tab.file);
    const neighbor = next[Math.min(index, next.length - 1)];
    if (neighbor) selectTab(neighbor);
    else {
      tabs.set([{ kind: "chat", ref: "" }]);
      persist();
      activeDraftRef.set("");
      showChat();
      void newSession();
    }
  });
  if (tab.kind === "doc") letDocGo(tab.ref);
}

/**
 * A new document tab: the file is made by its first words (one nobody wrote in
 * leaves nothing). A blank one already open is the new document — asking twice
 * does not make two.
 */
export async function newDocTab() {
  setGroupCollapsed("docs", false);
  const blank = tabs().find((t) => t.kind === "doc" && isNote(t.ref) && docIsBlank(t.ref));
  if (blank) return openDocTab(blank.ref, { newTab: true });
  openDocTab(await newDocPath(), { newTab: true });
}

/**
 * The composer's draft goes on as a document: a message that outgrew the
 * field is moved, not copied, into a new note — where Return is a new line
 * and every word is saved — with the caret after its last word. Remembers
 * which session it came from so returning lands right back there. Nothing
 * drafted: a blank document.
 */
export async function draftToDoc() {
  const text = composerDraft();
  if (!text.trim()) return newDocTab();
  const origin = currentChatRef();
  const path = await newDocPath();
  try {
    await fs.writeFile(path, `${text.replace(/\s+$/, "")}\n`);
  } catch {
    toast("warning", tr("Could not save the document", "无法保存文档"));
    return;
  }
  setDraft("");
  setGroupCollapsed("docs", false);
  draftOrigins.update((all) => ({ ...all, [path]: origin }));
  void refreshNotes();
  ensureDoc(path, { caret: "end" });
  openDocTab(path, { newTab: true });
}

/**
 * A Markdown file as a document tab: navigates inside the current tab by
 * default (sidebar click, palette), or opens a new tab (`newTab: true`:
 * ⌘-click, New Document, ⌘E, drop, Open File, chat card).
 */
export function openDocTab(path: string, options?: { newTab?: boolean }) {
  ensureDoc(path);
  const tab: OpenTab = { kind: "doc", ref: path };
  batch(() => {
    placeTab(tab, options?.newTab ? "new" : "replace");
    showDoc(path);
  });
}

/** Opens a document named by something said earlier (a card on a sent message): it may have been deleted since. */
export async function openDocIfThere(path: string) {
  if (docAt(path) || (await fs.exists(path).catch(() => false))) openDocTab(path, { newTab: true });
  else toast("info", tr("That document is no longer there", "这篇文档已经不在了"));
}

/** The system's file picker onto a Markdown file, opened as a document tab. */
export async function pickDocTab() {
  const pick = backend().pickFile;
  if (!pick) return;
  try {
    const path = await pick(tr("Open a Markdown document", "打开一个 Markdown 文档"), ["md", "markdown", "mdown", "txt"]);
    if (path) openDocTab(path, { newTab: true });
  } catch (error) {
    if (error instanceof NoPickerError) {
      toast("warning", tr("No file picker found — install zenity or kdialog to choose files.", "找不到文件选择器——请安装 zenity 或 kdialog。"));
    }
  }
}

/** Saves a document to a chosen path (preserving front matter and latest edits) and switches its tab there. */
export async function saveDocAs(path: string) {
  const pick = backend().pickSaveFile;
  if (!pick) return;
  await flushDoc(path);
  const content = await docFileContent(path);
  if (content === undefined) return;
  const rawTitle = docTabTitle(path)
    .replace(/[/\\:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64);
  const base = rawTitle && rawTitle !== tr("Untitled", "未命名") ? rawTitle : "document";
  const defaultName = /\.(md|markdown|txt)$/i.test(base) ? base : `${base}.md`;
  let dest: string | undefined;
  try {
    dest = await pick(tr("Save document as", "文档另存为"), defaultName, activeProjectPath() || notesDir());
  } catch (error) {
    if (error instanceof NoPickerError) {
      toast("warning", tr("No file picker found — install zenity or kdialog to save files.", "找不到文件选择器——请安装 zenity 或 kdialog。"));
    }
    return;
  }
  if (!dest) return;
  if (!/\.(md|markdown|mdown|txt)$/i.test(dest)) dest = `${dest}.md`;
  try {
    await fs.mkdir(dest.split("/").slice(0, -1).join("/"), { recursive: true });
    await fs.writeFile(dest, content);
  } catch {
    toast("warning", tr("Could not save the document", "无法保存文档"));
    return;
  }
  if (dest !== path) {
    const oldId = `doc:${path}`;
    const destTab: OpenTab = { kind: "doc", ref: dest };
    const list = tabs();
    const oldIdx = list.findIndex((t) => tabId(t) === oldId);
    const destIdx = list.findIndex((t) => tabId(t) === tabId(destTab));
    if (oldIdx >= 0) {
      batch(() => {
        if (destIdx >= 0) {
          tabs.set(list.filter((_, i) => i !== oldIdx));
        } else {
          const next = [...list];
          next[oldIdx] = destTab;
          tabs.set(next);
        }
        persist();
        ensureDoc(dest);
        showDoc(dest);
      });
      letDocGo(path);
    } else {
      openDocTab(dest, { newTab: true });
    }
  }
  void refreshNotes();
  toast("info", tr(`Saved as ${dest.split("/").pop() ?? dest}`, `已保存为 ${dest.split("/").pop() ?? dest}`));
}

// ── Between a document and a session ────────────────────────────────────────

export interface DocChatTargetSession {
  tab: OpenTab;
  title: string;
  current: boolean;
  agentId?: string;
}

export interface DocChatTargets {
  /** True when the strip's unstarted draft tab already holds unsent text or attachments. */
  hasActiveDraft: boolean;
  /** Short single-line preview of the unsent draft text. */
  draftPreview: string;
  /** The unstarted draft tab on the strip, if present. */
  draftTab?: OpenTab;
  /** Open real conversations (with a session file or daemon id), in strip order. */
  sessions: DocChatTargetSession[];
}

/** Live display label for a real chat tab (never falls back to a generic label if the live title is known). */
function sessionTargetTitle(tab: OpenTab, current: boolean): string {
  const title = chatTabTitle(tab);
  if (current && !isSwitching() && (title === tr("Session", "会话") || title === tr("New session", "新会话"))) {
    return currentTitle();
  }
  return title;
}

/** True when a chat tab is still an unstarted blank session (Pi assigns a sessionFile at boot before any message). */
function isUnstartedChatTab(tab: OpenTab, active: string): boolean {
  if (tab.kind !== "chat") return false;
  if (isDraftRef(tab.ref)) return true;
  if (ownsChat(tab, active)) {
    return transcriptRows().length === 0 && !(sessionState()?.messageCount) && !isRunning();
  }
  const ds = chatTabSession(tab);
  if (ds && (ds.status === "working" || ds.status === "blocked")) return false;
  const id = daemonRefId(tab.ref);
  const file = id ? (ds?.file ?? tab.file) : tab.ref;
  if (!file) return true;
  if (savedSessions().some((s) => s.path === file)) return false;
  for (const list of Object.values(workspaceSessions())) {
    if (list.some((s) => s.path === file)) return false;
  }
  return true;
}

/** Explicit destinations a document can be sent/attached to — never a mystery session. */
export function docChatTargets(): DocChatTargets {
  const list = tabs();
  const active = currentChatRef();
  const draftTab = list.find((t) => t.kind === "chat" && isUnstartedChatTab(t, active));
  const draftText = composerDraft().trim();
  const activeIsUnstarted =
    isDraftRef(active) || (transcriptRows().length === 0 && !(sessionState()?.messageCount) && !isRunning());
  const hasActiveDraft = Boolean(
    draftTab &&
      activeIsUnstarted &&
      (draftText.length > 0 || composerDocs().length > 0 || composerAttachments().length > 0),
  );
  const draftPreview = draftText.replace(/\s+/g, " ").slice(0, 48);
  const sessions: DocChatTargetSession[] = list
    .filter((t) => t.kind === "chat" && !isUnstartedChatTab(t, active))
    .map((tab) => {
      const current = ownsChat(tab, active);
      return {
        tab,
        title: sessionTargetTitle(tab, current),
        current,
        agentId: chatTabSession(tab)?.agentId,
      };
    });
  return { hasActiveDraft, draftPreview, draftTab, sessions };
}

/** The exact chat tab a `⌘E` draft document came from, while that tab is still open. */
export function docDraftOrigin(path: string): { tab: OpenTab; label: string; isBlankDraft: boolean } | undefined {
  const origin = draftOrigins()[path];
  if (origin === undefined) return undefined;
  const list = tabs();
  const active = currentChatRef();
  const tab = isDraftRef(origin)
    ? list.find((t) => t.kind === "chat" && t.ref === origin)
    : list.find((t) => ownsChat(t, origin));
  if (!tab) return undefined;
  const isBlankDraft = isUnstartedChatTab(tab, active);
  const label = isBlankDraft ? "" : sessionTargetTitle(tab, ownsChat(tab, active));
  return { tab, label, isBlankDraft };
}

/** Open and saved non-blank documents that can be referenced from the composer (`@`). */
export const mentionableDocs = computed<{ path: string; title: string; open: boolean }[]>(() => {
  const seen = new Set<string>();
  const out: { path: string; title: string; open: boolean }[] = [];
  for (const tab of tabs()) {
    if (tab.kind !== "doc" || seen.has(tab.ref) || docIsBlank(tab.ref)) continue;
    seen.add(tab.ref);
    out.push({ path: tab.ref, title: docTabTitle(tab.ref), open: true });
  }
  for (const note of notes()) {
    if (seen.has(note.path) || docIsBlank(note.path)) continue;
    seen.add(note.path);
    out.push({ path: note.path, title: docTabTitle(note.path), open: false });
  }
  return out;
});

async function readDocForChat(path: string, useSelection: boolean): Promise<{ text: string; excerpt: boolean } | undefined> {
  if (docAt(path)) {
    if (useSelection) return docPassage(path);
    const text = docText(path);
    return text !== undefined ? { text, excerpt: false } : undefined;
  }
  const text = plainMarkdown(await fs.readFile(path, "utf8").catch(() => "")).trim();
  return { text, excerpt: false };
}

/** Starts a clean new session tab (or focuses an empty draft tab) with this document (or selection) attached. */
export async function addDocToNewSession(path: string, options?: { selection?: boolean }) {
  const passage = await readDocForChat(path, options?.selection !== false);
  if (!passage) return;
  if (!passage.text) {
    toast("info", tr("Nothing written to add yet", "还没有写下可以添加的内容"));
    return;
  }
  const targets = docChatTargets();
  attachDoc({ path, title: docTabTitle(path), text: passage.text, ...(passage.excerpt ? { excerpt: true } : {}) });
  void flushDoc(path);
  clearDraftOrigin(path);
  if (targets.draftTab && !targets.hasActiveDraft) {
    selectTab(targets.draftTab);
    showChat();
  } else {
    void openNewSessionTab({ newTab: true });
  }
}

/** Switches to an explicit chat tab and attaches this document (or selection) to its composer. */
export async function addDocToTab(path: string, tab: OpenTab, options?: { selection?: boolean }) {
  const passage = await readDocForChat(path, options?.selection !== false);
  if (!passage) return;
  if (!passage.text) {
    toast("info", tr("Nothing written to add yet", "还没有写下可以添加的内容"));
    return;
  }
  attachDoc({ path, title: docTabTitle(path), text: passage.text, ...(passage.excerpt ? { excerpt: true } : {}) });
  void flushDoc(path);
  clearDraftOrigin(path);
  selectTab(tab);
  showChat();
}

/** Returns a `⌘E` expanded draft document back to the exact session it came from. */
export async function returnDraftDocToOrigin(path: string) {
  const origin = docDraftOrigin(path);
  if (origin) return addDocToTab(path, origin.tab, { selection: false });
  return addDocToNewSession(path, { selection: false });
}

/** Pulls a document directly into the currently shown chat composer (used by `@` mentions and composer attach). */
export async function attachDocToCurrentComposer(path: string): Promise<boolean> {
  const passage = await readDocForChat(path, false);
  if (!passage || !passage.text) {
    toast("info", tr("Nothing written to add yet", "还没有写下可以添加的内容"));
    return false;
  }
  attachDoc({ path, title: docTabTitle(path), text: passage.text });
  void flushDoc(path);
  return true;
}

// An attached document is sent as it reads when sent: what was written after attaching goes too, and is on disk by then.
docRefText.read = (ref) => {
  void flushDoc(ref.path);
  return docText(ref.path) || ref.text;
};

docOpener.open = async (path) => {
  if (!(docAt(path) || (await fs.exists(path).catch(() => false)))) return false;
  openDocTab(path, { newTab: true });
  return true;
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

/** Deletes a note for good: its tab closes, its file goes. */
export async function deleteNote(path: string) {
  detachDoc(path);
  const id = `doc:${path}`;
  if (tabs().some((t) => tabId(t) === id)) {
    closeTab(id);
    // The close flushes a last save: the file must go after it, not before.
    await closeDoc(path);
  }
  forgetDocRank(path);
  await deleteNoteFile(path);
}

export { docTabTitle };
