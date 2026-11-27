import type { Lang } from "../lib/i18n";
import { mediaRowFromProtocolBlock, type MediaItem } from "../lib/media";
import type {
  AgentMessage,
  AssistantMessage,
  AssistantMessageEvent,
  AudioContent,
  ImageContent,
  MediaResourceContent,
  SessionEvent,
  MessageVersion,
  TextContent,
  ToolResult,
  ToolResultBlock,
  ToolResultMessage,
} from "./protocol";

/**
 * The transcript: a session's messages as the rows the chat shows.
 *
 * Pi's messages nest content blocks; the chat is flat. An assistant message
 * becomes one row per block (prose, thinking, a tool call), and a tool's
 * result joins its call's row. Rows are immutable: a change replaces the row
 * with a new object under the same `id`, which is what the list diffs by.
 */
export type Row =
  /** `queued`: staged behind the agent's queue — on screen, but not sent into the run yet. */
  | { kind: "user"; id: string; text: string; images: number; imageBlocks?: ImageContent[]; queued?: boolean }
  | ({ kind: "text"; id: string; text: string; streaming: boolean; editKey?: string; versions?: MessageVersion[]; /** The prose of a message that called no tools: the turn's answer. Known once the message ended. */ final?: boolean } & TurnStamp)
  | ({ kind: "thinking"; id: string; text: string; streaming: boolean; redacted: boolean; durationMs?: number } & TurnStamp)
  | ({ kind: "media"; id: string; title?: string; items: MediaItem[] } & TurnStamp)
  | ToolRow
  | { kind: "bash"; id: string; command: string; output: string; running: boolean; exitCode?: number; cancelled: boolean; truncated: boolean }
  | { kind: "notice"; id: string; tone: "info" | "warning" | "error"; title: string; text: string }
  | { kind: "summary"; id: string; title: string; text: string }
  /** An answer another session delivered back (`<pipi-message>` envelope), shown as a from-session row. */
  | { kind: "delivery"; id: string; from: string; fromTitle: string; agent: string; status: string; text: string };

/** When the turn a row belongs to started, and on the turn's first row, how long the turn took once it is over. */
export interface TurnStamp {
  silentEdit?: boolean;
  t0?: number;
  turnMs?: number;
  turnStart?: boolean;
}

const isTurnRow = (row: Row): row is Extract<Row, { kind: "text" | "thinking" | "tool" | "media" }> =>
  row.kind === "text" || row.kind === "thinking" || row.kind === "tool" || row.kind === "media";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

function sameJsonValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!sameJsonValue(a[i], b[i])) return false;
    }
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao).filter((k) => ao[k] !== undefined);
  const bKeys = Object.keys(bo).filter((k) => bo[k] !== undefined);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!(k in bo) || bo[k] === undefined || !sameJsonValue(ao[k], bo[k])) return false;
  }
  return true;
}

const COMPACTION_AFTER_EN = / to about [\d.]+[kM]?(?= tokens$)/;
const COMPACTION_AFTER_ZH = /，压缩至约 [\d.]+[kM]?$/;
const normalizeSummaryTitle = (title: string) =>
  title.replace(COMPACTION_AFTER_EN, "").replace(COMPACTION_AFTER_ZH, "");

function formatProviderError(raw: string): string {
  const trimmed = raw.trim();
  const brace = trimmed.indexOf("{");
  if (brace >= 0 && trimmed.endsWith("}")) {
    const prefix = trimmed.slice(0, brace).trim();
    try {
      const parsed = JSON.parse(trimmed.slice(brace)) as Record<string, unknown>;
      const inner = parsed.error && typeof parsed.error === "object" ? (parsed.error as Record<string, unknown>) : parsed;
      const msg = typeof inner.message === "string" && inner.message.trim() ? inner.message.trim() : undefined;
      if (msg) {
        const meta: string[] = [];
        if (prefix && /^\d{3}$/.test(prefix)) meta.push(prefix);
        const code =
          typeof inner.code === "string" && inner.code
            ? inner.code
            : typeof inner.type === "string" && inner.type && inner.type !== "error"
              ? inner.type
              : undefined;
        if (code) meta.push(code);
        return meta.length ? `${msg} (${meta.join(" · ")})` : msg;
      }
    } catch {}
  }
  return trimmed;
}

/** Whether two rows render the same conversation content on screen (ignoring row ids and live-vs-disk timing skew). */
export function sameVisualRow(a: Row, b: Row): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind) return false;
  if (isTurnRow(a) && isTurnRow(b)) {
    if (Boolean(a.turnStart) !== Boolean(b.turnStart)) return false;
  }
  switch (a.kind) {
    case "user": {
      const bu = b as Extract<Row, { kind: "user" }>;
      return (
        a.text === bu.text &&
        a.images === bu.images &&
        (a.imageBlocks?.length ?? 0) === (bu.imageBlocks?.length ?? 0) &&
        Boolean(a.queued) === Boolean(bu.queued)
      );
    }
    case "text": {
      const bt = b as Extract<Row, { kind: "text" }>;
      return a.text === bt.text && a.streaming === bt.streaming && Boolean(a.final) === Boolean(bt.final) && a.editKey === bt.editKey && sameJsonValue(a.versions, bt.versions);
    }
    case "thinking": {
      const bth = b as Extract<Row, { kind: "thinking" }>;
      return a.text === bth.text && a.streaming === bth.streaming && a.redacted === bth.redacted;
    }
    case "media": {
      const bm = b as Extract<Row, { kind: "media" }>;
      return a.title === bm.title && sameJsonValue(a.items, bm.items);
    }
    case "tool": {
      const btool = b as ToolRow;
      return (
        a.name === btool.name &&
        a.status === btool.status &&
        a.output === btool.output &&
        a.images === btool.images &&
        (a.imageBlocks?.length ?? 0) === (btool.imageBlocks?.length ?? 0) &&
        (a.resources?.length ?? 0) === (btool.resources?.length ?? 0) &&
        Boolean(a.background) === Boolean(btool.background) &&
        sameJsonValue(a.args, btool.args) &&
        sameJsonValue(a.details, btool.details)
      );
    }
    case "bash": {
      const bb = b as Extract<Row, { kind: "bash" }>;
      return (
        a.command === bb.command &&
        a.output === bb.output &&
        a.running === bb.running &&
        a.exitCode === bb.exitCode &&
        a.cancelled === bb.cancelled &&
        a.truncated === bb.truncated
      );
    }
    case "notice": {
      const bn = b as Extract<Row, { kind: "notice" }>;
      return a.tone === bn.tone && a.title === bn.title && a.text === bn.text;
    }
    case "summary": {
      const bs = b as Extract<Row, { kind: "summary" }>;
      return a.text === bs.text && normalizeSummaryTitle(a.title) === normalizeSummaryTitle(bs.title);
    }
    case "delivery": {
      const bd = b as Extract<Row, { kind: "delivery" }>;
      return (
        a.from === bd.from &&
        a.fromTitle === bd.fromTitle &&
        a.agent === bd.agent &&
        a.status === bd.status &&
        a.text === bd.text
      );
    }
  }
}

/** Whether two row lists show the same visual conversation. */
export function sameVisualRows(a: readonly Row[], b: readonly Row[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!sameVisualRow(a[i], b[i])) return false;
  }
  return true;
}

/** Diagnostic helper returning the first index where two row lists visually diverge (`undefined` when identical). */
export function firstVisualRowDiff(
  a: readonly Row[],
  b: readonly Row[],
): { index: number; a?: Row; b?: Row } | undefined {
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (i >= a.length || i >= b.length || !sameVisualRow(a[i], b[i])) {
      return { index: i, a: a[i], b: b[i] };
    }
  }
  return undefined;
}

/** What a row says, apart from its minted row id: two loads of a conversation pair their rows up by it (`adopt`). */
const signature = (row: Row): string => {
  switch (row.kind) {
    case "user":
      return `user\n${row.images}\n${row.text}`;
    case "text":
    case "thinking":
      return `${row.kind}\n${row.text}`;
    case "media":
      return `media\n${row.title ?? ""}\n${canonicalJson(row.items)}`;
    case "tool":
      return `tool\n${row.callId ?? row.id}\n${row.name}\n${canonicalJson(row.args)}`;
    case "bash":
      return `bash\n${row.command}`;
    case "notice":
      return `notice\n${row.title}\n${row.text}`;
    case "summary":
      return `summary\n${normalizeSummaryTitle(row.title)}\n${row.text}`;
    case "delivery":
      return `delivery\n${row.from}\n${row.text}`;
  }
};

const isProcessBlock = (block: AssistantMessage["content"][number]): boolean =>
  block.type === "toolCall" || block.type === "thinking";

/** Whether the message answered its turn: called no tools without failing, or —
 * a turn held in one message, as the bridge plays ACP harnesses — ended on
 * prose/media after its steps. One still calling tools or that failed answers nothing. */
const answeredTurn = (message: AssistantMessage): boolean => {
  if (message.stopReason === "error") return false;
  if (!message.content.some((block) => block.type === "toolCall")) return true;
  const last = message.content.at(-1);
  return message.stopReason !== "toolUse" && Boolean(last && !isProcessBlock(last));
};

export interface ToolRow extends TurnStamp {
  kind: "tool";
  id: string;
  /** The wire `toolCallId` from the harness (before any `~k` occurrence suffix). */
  callId?: string;
  name: string;
  /** The arguments once the call is complete; while it streams, what has parsed so far. */
  args: Record<string, unknown>;
  /** `call`: the model is still writing the call. `queued`: written, not yet started. */
  status: "call" | "queued" | "running" | "done" | "error";
  output: string;
  images: number;
  imageBlocks?: ImageContent[];
  resources?: (AudioContent | MediaResourceContent)[];
  details?: unknown;
  durationMs?: number;
  background?: boolean;
  /** While `status === "call"`, the argument key whose string value has not seen its closing quote yet. */
  incompleteArg?: string;
}

const textOf = (content: string | ToolResultBlock[] | undefined) =>
  typeof content === "string"
    ? content
    : (content ?? [])
        .filter((block): block is TextContent => block.type === "text")
        .map((block) => block.text)
        .join("\n");

const imagesOf = (content: string | ToolResultBlock[] | undefined) =>
  typeof content === "string" ? 0 : (content ?? []).filter((block) => block.type === "image").length;

const imageBlocksOf = (content: string | ToolResultBlock[] | undefined): ImageContent[] =>
  typeof content === "string"
    ? []
    : (content ?? []).filter((block): block is ImageContent => block.type === "image" && typeof block.data === "string" && block.data.length > 0);

const resourcesOf = (content: string | ToolResultBlock[] | undefined): (AudioContent | MediaResourceContent)[] =>
  typeof content === "string"
    ? []
    : (content ?? []).filter(
        (block): block is AudioContent | MediaResourceContent =>
          (block.type === "audio" && typeof block.data === "string" && block.data.length > 0) ||
          (block.type === "resource" && (typeof block.uri === "string" || typeof block.data === "string")),
      );

/** One `<pipi-message from="s_x" title="…" agent="…" status="…">…</pipi-message>` envelope the daemon delivers. */
const PIPPI_MESSAGE = /<pipi-message from="([^"]*)" title="([^"]*)" agent="([^"]*)" status="([^"]*)">([\s\S]*?)<\/pipi-message>/g;
const unattr = (text: string) =>
  text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** Splits a delivered-messages prompt into its envelopes; `undefined` when the text is a normal user message. */
export function pippiDeliveries(text: string): { from: string; fromTitle: string; agent: string; status: string; text: string }[] | undefined {
  if (!text.includes("<pipi-message")) return undefined;
  const out: { from: string; fromTitle: string; agent: string; status: string; text: string }[] = [];
  let matched = false;
  for (const hit of text.matchAll(PIPPI_MESSAGE)) {
    matched = true;
    out.push({
      from: hit[1],
      fromTitle: unattr(hit[2]),
      agent: unattr(hit[3]),
      status: hit[4],
      text: hit[5].replace(/^\n+|\n+$/g, ""),
    });
  }
  return matched ? out : undefined;
}

/** What Pi tells the model about a prompt's image: how it was scaled, what it was converted from. */
const IMAGE_NOTE_FOR_MODEL =
  /^\[Image(?:: original \d+x\d+, displayed at \d+x\d+\. Multiply coordinates by [\d.]+ to map to original image\.| converted from \S+ to \S+\.)\]$/;
/** What Pi says of an image it could not send: the reader needs that one too. */
const IMAGE_NOTE_OMITTED = /^\[Image omitted: [^\]]*\]$/;

/**
 * A prompt's text as the person wrote it. Pi fits a prompt's images to what
 * the model takes and says so in the prompt's own text: a blank line, then a
 * note per image (`[Image: original 1914x2040, displayed at 1876x2000. …]`).
 * Those are for the model, so they are not shown, copied or made a title of
 * (`sidecar/list-sessions.mjs` reads titles the same way).
 */
export function withoutImageNotes(text: string): string {
  const at = text.lastIndexOf("\n\n");
  if (at < 0) return text;
  const notes = text.slice(at + 2).split("\n");
  if (!notes.every((line) => IMAGE_NOTE_FOR_MODEL.test(line) || IMAGE_NOTE_OMITTED.test(line))) return text;
  const kept = notes.filter((line) => IMAGE_NOTE_OMITTED.test(line));
  if (kept.length === notes.length) return text;
  const head = text.slice(0, at);
  return kept.length ? `${head}\n\n${kept.join("\n")}` : head;
}

const HANDOFF_PREFIX = /^<conversation_handoff\b[^>]*>[\s\S]*?<\/conversation_handoff>\s*User message:\n/;
/** What the daemon opens a fresh conversation with the personal agent with (`withPersona` in `sidecar/pipi-daemon.mjs`). */
const PERSONA_PREFIX = /^<pipi-persona\b[^>]*>[\s\S]*?<\/pipi-persona>\s*/;

interface StagedUserEntry {
  row: Extract<Row, { kind: "user" }>;
  t0: number;
  queued?: boolean;
  queueAcked?: boolean;
  dropAt?: number;
}

/**
 * Strips the context pipi prepends to a prompt — the personal agent's persona,
 * a Portable Context Handoff — so the user bubble shows only what the person wrote.
 */
export function withoutPreamble(text: string): string {
  const said = text.startsWith("<pipi-persona") ? text.replace(PERSONA_PREFIX, "") : text;
  return said.startsWith("<conversation_handoff") ? said.replace(HANDOFF_PREFIX, "") : said;
}

/**
 * How long a queued bubble stays on screen after its queue entry goes, waiting
 * for the echo that delivery brings. A dequeue's echo lands well inside it; a
 * recall's never does, and the store withdraws the bubble once it passes.
 */
const QUEUE_ECHO_GRACE_MS = 3000;

/** The arguments a partial JSON object has so far: enough to title a tool call while it streams. */
function partialArgs(json: string): { args: Record<string, unknown>; incompleteKey?: string } {
  const args: Record<string, unknown> = {};
  let incompleteKey: string | undefined;
  let i = json.indexOf("{") + 1;
  if (!i) return { args };
  const n = json.length;
  const skip = () => {
    while (i < n && (json.charCodeAt(i) <= 32 || json[i] === ",")) i++;
  };
  /** String contents from the `"` at i; reports whether the closing quote was reached. */
  const scanString = (): { value: string; closed: boolean } => {
    let out = "";
    i++;
    while (i < n) {
      const c = json[i++];
      if (c === '"') return { value: out, closed: true };
      if (c === "\\" && i < n) {
        const e = json[i++];
        if (e === "u" && i + 4 <= n) {
          const code = parseInt(json.slice(i, i + 4), 16);
          if (Number.isNaN(code)) break;
          out += String.fromCharCode(code);
          i += 4;
          continue;
        }
        out += e === "n" ? "\n" : e === "t" ? "\t" : e === "r" ? "\r" : e === "b" ? "\b" : e === "f" ? "\f" : e;
      } else out += c;
    }
    return { value: out, closed: false };
  };
  while (i < n) {
    skip();
    if (i >= n || json[i] === "}") break;
    if (json[i] !== '"') break;
    const keyScan = scanString();
    if (!keyScan.closed) break;
    const key = keyScan.value;
    skip();
    if (json[i] !== ":") break;
    i++;
    skip();
    if (i >= n) break;
    const c = json[i];
    if (c === '"') {
      // An unfinished string still titles the call: `{"path":"src/ap` reads as { path: "src/ap" }.
      const valScan = scanString();
      args[key] = valScan.value;
      if (!valScan.closed) incompleteKey = key;
      continue;
    }
    if (c === "{" || c === "[") {
      const start = i;
      let depth = 0,
        inString = false,
        escaped = false;
      while (i < n) {
        const ch = json[i++];
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = inString;
        else if (ch === '"') inString = !inString;
        else if (!inString && (ch === "{" || ch === "[")) depth++;
        else if (!inString && (ch === "}" || ch === "]") && !--depth) break;
      }
      if (depth) break;
      try {
        args[key] = JSON.parse(json.slice(start, i));
      } catch {}
      continue;
    }
    const start = i;
    while (i < n && !",}] \t\n\r".includes(json[i])) i++;
    if (i >= n) break;
    try {
      args[key] = JSON.parse(json.slice(start, i));
    } catch {}
  }
  return { args, incompleteKey };
}

/**
 * Row ids count across every transcript, not per transcript: a parked run, the
 * session loaded after it and a delegated task each have their own, and rows
 * of two conversations sharing an id look like one row to whatever keys on it
 * — the list keeps the cell, and its words roll from one session's into the
 * other's on a switch.
 */
let seq = 0;

/**
 * Builds the rows of a session and keeps them current as events arrive.
 * It holds no signals: the store takes `rows()` when `version` moved.
 */
export class Transcript {
  #editing = false;
  #editText = new Map<string, string>();
  #rows: Row[] = [];
  #index = new Map<string, number>();
  /**
   * User messages shown at once on send before the agent echoes `message_start`:
   * kept after `#rows` until confirmed so an idle-wake catch-up arriving ahead of
   * the prompt still lands before the bubble, and the echoed message keeps the
   * exact same row object and id. A message the agent queued (`queued`) may yet
   * be taken back before its echo: `reconcileQueue` marks it `dropAt`, it stays
   * on screen for a grace while the echo may still land, and `sweepDrops`
   * withdraws it when none does.
   */
  #staged: StagedUserEntry[] = [];
  /** The assistant message being streamed: its key, and what its tool calls have of their arguments. */
  #live: { key: string; rowIds: Map<number, string>; toolIds: Map<number, string>; toolJson: Map<number, string>; thinkingSince: Map<number, number>; argsAt: Map<number, number> } | undefined;
  /** Start timestamps for running tool executions so external engines without `durationMs` still measure elapsed time. */
  #toolSince = new Map<string, number>();
  /**
   * Results read ahead of the call that made them, in the order read: the
   * bridge lists a turn's tool results before the one assistant message
   * holding every block (its calls included), so on a reload a result can
   * land before its call's row exists. It waits here for the block instead —
   * minting the row on sight would park every tool at the head of its turn
   * and leave the message's prose out of order.
   */
  #pendingResults = new Map<string, ToolResultMessage[]>();
  /**
   * Row ids minted per wire `toolCallId`: how many times each was seen, and
   * the row its open call resolves to — engines reusing `item_0` / `"0"` across
   * turns get a suffix instead of overwriting the earlier call's row in place
   * (`#mintToolId`). A call the run abandoned stays mapped until `agent_settled`
   * marks it `ended`; every event after that mints the next occurrence.
   */
  #callCounts = new Map<string, number>();
  #callRows = new Map<string, { id: string; ended: boolean }>();
  /** Rows that are still open when a run stops, to close them. */
  #bashId: string | undefined;
  /** When the current turn started: the user's message, else its first row. */
  #turnStart: number | undefined;
  /** The turn at the end of the rows was closed (`#closeTurn`): a row that joins it opens it again. */
  #closed = false;
  /** The next turn row begins a new visual turn even without a user row before it. */
  #newTurn = false;
  /** While loading history: the time of the message being read (`null` when it has none). */
  #clock: number | null | undefined;
  /**
   * What the last assistant message failed on, not yet said. Whether it is the
   * run's failure depends on what follows: a retry takes its place and nothing
   * is said, so an error never shows only to be withdrawn; once the run settles
   * or the conversation moves on, it is reported, once (`#reportFailure`).
   */
  #failure: string | undefined;
  /** Bumped by every change. */
  version = 0;

  /** Builds the rows of a session and keeps them current as events arrive. */
  #lang: () => Lang;

  constructor(lang: () => Lang = () => "en") {
    this.#lang = lang;
  }

  #tr(en: string, zh: string) {
    return this.#lang() === "zh" ? zh : en;
  }

  /** The rows, in order: a new array each time they changed. */
  rows(): Row[] {
    const now = Date.now();
    const pending = this.#staged.filter((item) => item.dropAt === undefined || item.dropAt > now);
    return pending.length ? [...this.#rows, ...pending.map((item) => item.row)] : this.#rows.slice();
  }

  /**
   * Replaces everything with a session's messages (`get_messages`).
   * `working`: its run is still going (a session the daemon kept working, opened
   * again) — nothing in it has stopped, and its last turn is not over.
   */
  load(messages: AgentMessage[], working = false) {
    this.#editing = false;
    this.#editText.clear();
    this.#rows = [];
    this.#staged = [];
    this.#index.clear();
    this.#live = undefined;
    this.#toolSince.clear();
    this.#pendingResults.clear();
    this.#callCounts.clear();
    this.#callRows.clear();
    this.#bashId = undefined;
    this.#turnStart = undefined;
    this.#closed = false;
    this.#newTurn = false;
    this.#failure = undefined;
    let lastClock: number | null = null;
    for (const message of messages) {
      const assistantStart = message.role === "assistant" && !!message.turnStart;
      if (message.role === "user" || assistantStart) this.#closeTurn();
      const rawAt = (message as { timestamp?: unknown }).timestamp;
      const parsedAt =
        typeof rawAt === "number" && Number.isFinite(rawAt)
          ? rawAt
          : typeof rawAt === "string" && rawAt
            ? Date.parse(rawAt)
            : NaN;
      // An unstamped message is of its time, not of none: the last stamped keeps the clock.
      if (Number.isFinite(parsedAt)) lastClock = parsedAt;
      this.#clock = lastClock;
      if (assistantStart) {
        this.#turnStart = this.#now();
        this.#newTurn = true;
      }
      if (message.role === "assistant") this.#editing = Boolean(message.silentEdit);
      if (message.role === "assistant" && message.stopReason === "pending") this.#pendingMessage(message);
      else this.#append(message);
    }
    if (working) {
      this.#flushResults();
    } else {
      // A call with no recorded result was interrupted; history never shows it as running.
      this.#settle(false);
      this.#turnStart = undefined;
    }
    this.#clock = undefined;
    this.version++;
  }

  /**
   * Takes the ids of `before` — the same conversation as it last stood on
   * screen — for the rows both hold. Loading a session again mints its rows
   * anew, and what is kept by row (a fold the reader opened, the list's cell)
   * would lose them: with their ids back, it finds them where it left them.
   *
   * Rows pair up in order, by what they say; a row `before` was still
   * streaming pairs with the one that begins as it did. A row with no pair
   * keeps its new id, so the worst a mismatch costs is that row's default look.
   */
  adopt(before: readonly Row[]) {
    if (!before.length || !this.#rows.length) return;
    const beforeSigs = before.map(signature);
    const freshSigs = this.#rows.map(signature);

    // Unique-signature anchors + LIS keep global turn alignment even when one load
    // has an extra/missing row or reused short prompts ("continue", "ok") earlier on.
    const beforeCounts = new Map<string, number>();
    const beforePos = new Map<string, number>();
    for (let i = 0; i < beforeSigs.length; i++) {
      const s = beforeSigs[i];
      beforeCounts.set(s, (beforeCounts.get(s) ?? 0) + 1);
      beforePos.set(s, i);
    }
    const freshCounts = new Map<string, number>();
    for (let j = 0; j < freshSigs.length; j++) {
      const s = freshSigs[j];
      freshCounts.set(s, (freshCounts.get(s) ?? 0) + 1);
    }
    const candidates: { b: number; f: number }[] = [];
    for (let j = 0; j < freshSigs.length; j++) {
      const s = freshSigs[j];
      if (freshCounts.get(s) === 1 && beforeCounts.get(s) === 1) {
        candidates.push({ b: beforePos.get(s)!, f: j });
      }
    }
    const anchors: { b: number; f: number }[] = [];
    if (candidates.length > 0) {
      const tails: number[] = [];
      const prev = new Int32Array(candidates.length).fill(-1);
      for (let k = 0; k < candidates.length; k++) {
        const val = candidates[k].b;
        let lo = 0;
        let hi = tails.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (candidates[tails[mid]].b < val) lo = mid + 1;
          else hi = mid;
        }
        if (lo > 0) prev[k] = tails[lo - 1];
        tails[lo] = k;
      }
      for (let cur = tails[tails.length - 1]; cur >= 0; cur = prev[cur]) {
        anchors.push(candidates[cur]);
      }
      anchors.reverse();
    }

    const pairedBefore: (number | undefined)[] = new Array(this.#rows.length);
    const matchGap = (bStart: number, bEnd: number, fStart: number, fEnd: number) => {
      if (bStart >= bEnd || fStart >= fEnd) return;
      const waiting = new Map<string, number[]>();
      const streaming: number[] = [];
      for (let at = bStart; at < bEnd; at++) {
        const key = beforeSigs[at];
        const list = waiting.get(key);
        if (list) list.push(at);
        else waiting.set(key, [at]);
        const old = before[at];
        if ((old.kind === "text" || old.kind === "thinking") && old.streaming) streaming.push(at);
      }
      let from = bStart;
      for (let j = fStart; j < fEnd; j++) {
        const row = this.#rows[j];
        const list = waiting.get(freshSigs[j]);
        while (list?.length && list[0] < from) list.shift();
        let at = list?.shift();
        if (at === undefined && (row.kind === "text" || row.kind === "thinking")) {
          at = streaming.find((index) => {
            const old = before[index];
            if (index < from || old.kind !== row.kind) return false;
            // Nothing written yet begins anything: only the row next in line is taken for it.
            return old.text ? row.text.startsWith(old.text) : index === from;
          });
        } else if (at === undefined && row.kind === "tool") {
          for (let index = from; index < bEnd; index++) {
            const old = before[index];
            if (
              old.kind === "tool" &&
              (old.callId ?? old.id) === (row.callId ?? row.id) &&
              old.name === row.name
            ) {
              at = index;
              break;
            }
          }
        }
        if (at === undefined) continue;
        from = at + 1;
        pairedBefore[j] = at;
      }
    };

    let prevB = 0;
    let prevF = 0;
    for (const anchor of anchors) {
      matchGap(prevB, anchor.b, prevF, anchor.f);
      pairedBefore[anchor.f] = anchor.b;
      prevB = anchor.b + 1;
      prevF = anchor.f + 1;
    }
    matchGap(prevB, before.length, prevF, this.#rows.length);

    // Paired rows claim their `before` ids first so an earlier unpaired occurrence of
    // a reused wire id (`item_0`) never blocks a paired row from keeping its cell id.
    const claimed = new Set<string>();
    const targetIds: string[] = new Array(this.#rows.length);
    for (let j = 0; j < this.#rows.length; j++) {
      const at = pairedBefore[j];
      if (at === undefined) continue;
      const oldId = before[at].id;
      if (!claimed.has(oldId)) {
        claimed.add(oldId);
        targetIds[j] = oldId;
      }
    }
    for (let j = 0; j < this.#rows.length; j++) {
      if (targetIds[j] !== undefined) continue;
      const row = this.#rows[j];
      let id = row.id;
      if (claimed.has(id)) {
        const base = row.kind === "tool" ? (row.callId ?? row.id) : row.id;
        let count = (this.#callCounts.get(base) ?? 1) + 1;
        id = `${base}~${count}`;
        while (claimed.has(id) || this.#index.has(id)) id = `${base}~${++count}`;
        if (row.kind === "tool") this.#callCounts.set(base, count);
      }
      claimed.add(id);
      targetIds[j] = id;
    }

    const renamed = new Map<string, string>();
    let changed = false;
    this.#rows = this.#rows.map((row, j) => {
      const id = targetIds[j];
      if (id !== row.id) renamed.set(row.id, id);
      const at = pairedBefore[j];
      if (at === undefined) {
        if (id === row.id) return row;
        changed = true;
        return { ...row, id } as Row;
      }
      const old = before[at];
      const keepTurnMs =
        isTurnRow(row) &&
        isTurnRow(old) &&
        old.turnMs !== undefined &&
        ((row.turnMs !== undefined && row.turnMs !== old.turnMs) || (row.turnMs === undefined && this.#closed))
          ? old.turnMs
          : undefined;
      const effectiveTurnMs = keepTurnMs ?? (isTurnRow(row) ? row.turnMs : undefined);
      const keepDuration =
        (row.kind === "thinking" || row.kind === "tool") &&
        old.kind === row.kind &&
        row.durationMs === undefined &&
        old.durationMs !== undefined
          ? old.durationMs
          : undefined;
      const effectiveDuration =
        keepDuration ?? (row.kind === "thinking" || row.kind === "tool" ? row.durationMs : undefined);
      // Returning `old` (`===`) whenever visually & structurally unchanged keeps the
      // exact row reference on screen so `buildDisplayRows`, `stableDisplayRows`, and
      // `<List>` do zero re-measurement on unaffected prefix rows.
      if (
        id === old.id &&
        sameVisualRow(old, row) &&
        (!isTurnRow(row) ||
          !isTurnRow(old) ||
          ((old.t0 === undefined) === (row.t0 === undefined) &&
            (old.turnMs === undefined) === (effectiveTurnMs === undefined))) &&
        (row.kind !== "thinking" && row.kind !== "tool"
          ? true
          : (old as { durationMs?: number }).durationMs === effectiveDuration) &&
        (row.kind !== "tool" || (old as ToolRow).callId === row.callId)
      ) {
        if (old !== row) changed = true;
        return old;
      }
      if (id === row.id && keepTurnMs === undefined && keepDuration === undefined) return row;
      changed = true;
      return {
        ...row,
        id,
        ...(keepTurnMs !== undefined ? { turnMs: keepTurnMs } : {}),
        ...(keepDuration !== undefined ? { durationMs: keepDuration } : {}),
      } as Row;
    });
    if (!changed) return;
    this.#index.clear();
    this.#rows.forEach((row, at) => this.#index.set(row.id, at));
    // The maps that point at rows by id follow the rename, or an open call's
    // next event would resolve to nothing and mint a phantom row.
    if (renamed.size) {
      for (const [wire, call] of this.#callRows) {
        const to = renamed.get(call.id);
        if (to) this.#callRows.set(wire, { ...call, id: to });
      }
      if (this.#toolSince.size) {
        const moved = new Map<string, number>();
        for (const [id, since] of this.#toolSince) moved.set(renamed.get(id) ?? id, since);
        this.#toolSince = moved;
      }
      if (this.#bashId) this.#bashId = renamed.get(this.#bashId) ?? this.#bashId;
      if (this.#live) {
        for (const [contentIndex, id] of this.#live.toolIds) {
          const to = renamed.get(id);
          if (to) this.#live.toolIds.set(contentIndex, to);
        }
        // Rows a still-open message's deltas write by contentIndex follow the same renames.
        for (const [contentIndex, id] of this.#live.rowIds) {
          const to = renamed.get(id);
          if (to) this.#live.rowIds.set(contentIndex, to);
        }
      }
    }
    this.version++;
  }

  /** Applies a session event. */
  apply(event: SessionEvent) {
    switch (event.type) {
      case "agent_start":
        this.#editing = false;
        this.#editText.clear();
        break;
      case "message_edit": {
        const targets = this.#rows.filter((row) => row.kind === "text" && row.editKey === event.key);
        const first = targets[0];
        if (first?.kind === "text" && event.versions.length > 1) {
          this.#set({ ...first, text: event.versions.at(-1)!.content, versions: event.versions, streaming: false });
          for (const row of targets.slice(1)) this.#removeRow(row.id);
        }
        this.#editing = true;
        break;
      }
      case "message_start":
        if (event.message.role === "assistant") {
          if (!event.message.turnStart && this.#staged.length) this.#commitStaged();
          this.#live = { key: `m${++seq}`, rowIds: new Map(), toolIds: new Map(), toolJson: new Map(), thinkingSince: new Map(), argsAt: new Map() };
          if (event.message.turnStart) {
            this.#closeTurn();
            this.#turnStart = this.#now();
            this.#newTurn = true;
          }
        } else if (event.message.role === "user") {
          this.#closeTurn();
          this.#append(event.message);
        }
        break;
      case "message_update":
        this.#update(event.assistantMessageEvent, (event as { message?: AssistantMessage }).message);
        break;
      case "message_end":
        if (event.message.role === "assistant") this.#finish(event.message);
        else if (event.message.role !== "user") this.#append(event.message);
        break;
      case "tool_execution_start": {
        const rowId = this.#callRow(event.toolCallId);
        if (!this.#toolSince.has(rowId)) this.#toolSince.set(rowId, Date.now());
        this.#tool(
          rowId,
          (row) => {
            const { incompleteArg: _inc, ...rest } = row;
            return { ...rest, callId: rest.callId ?? event.toolCallId, name: event.toolName, args: event.args ?? rest.args, status: "running" };
          },
          event.toolName,
          event.toolCallId,
        );
        break;
      }
      case "tool_execution_update": {
        const rowId = this.#callRow(event.toolCallId);
        if (!this.#toolSince.has(rowId)) this.#toolSince.set(rowId, Date.now());
        this.#tool(
          rowId,
          (row) => {
            const { incompleteArg: _inc, ...rest } = row;
            return { ...rest, callId: rest.callId ?? event.toolCallId, ...this.#result(event.partialResult, row), status: "running" };
          },
          event.toolName,
          event.toolCallId,
        );
        break;
      }
      case "tool_execution_end": {
        const rowId = this.#callRow(event.toolCallId);
        const started = this.#toolSince.get(rowId);
        this.#toolSince.delete(rowId);
        const measured = started !== undefined ? Math.max(0, Date.now() - started) : undefined;
        this.#tool(
          rowId,
          (row) => {
            const { background: _bg, incompleteArg: _inc, ...rest } = row;
            return {
              ...rest,
              callId: rest.callId ?? event.toolCallId,
              ...this.#result(event.result, row),
              status: event.isError ? "error" : "done",
              durationMs: event.durationMs ?? row.durationMs ?? measured,
            };
          },
          event.toolName,
          event.toolCallId,
        );
        break;
      }
      case "compaction_end":
        // Compacting an overflowed context is Pi recovering the reply that failed on it: the retry answers for it.
        if (event.result && event.willRetry) this.#failure = undefined;
        else this.#reportFailure();
        if (event.result) {
          const { tokensBefore, estimatedTokensAfter } = event.result;
          const after = estimatedTokensAfter ? this.#tr(` to about ${compactNumber(estimatedTokensAfter)}`, `，压缩至约 ${compactNumber(estimatedTokensAfter)}`) : "";
          this.#push({
            kind: "summary",
            id: this.#id("compaction"),
            title: this.#tr(`Context compacted from ${compactNumber(tokensBefore)}${after} tokens`, `上下文已从 ${compactNumber(tokensBefore)} tokens 压缩${after}`),
            text: event.result.summary,
          });
        } else if (!event.aborted && event.errorMessage) {
          this.#push({ kind: "notice", id: this.#id("notice"), tone: "error", title: this.#tr("Compaction failed", "压缩失败"), text: event.errorMessage });
        }
        break;
      case "auto_retry_start":
        // The attempt is being made again: the status line says so while it waits, and the transcript says nothing.
        // (When the retries run out, the last attempt's own error is what gets reported; a retry the reader
        // cancelled leaves none. `auto_retry_end` adds nothing to either.)
        this.#failure = undefined;
        return;
      case "extension_error":
        this.#push({ kind: "notice", id: this.#id("notice"), tone: "warning", title: this.#tr(`Extension error in ${event.event}`, `扩展在 ${event.event} 中出错`), text: `${event.error}\n${event.extensionPath}` });
        break;
      case "agent_settled":
        this.#settle(!!event.aborted);
        break;
      default:
        return;
    }
    this.version++;
  }

  /** Starts a row for a shell command the user ran (`bash`); its output arrives with `bashOutput`. */
  bashStart(command: string) {
    this.#bashId = this.#id("bash");
    this.#push({ kind: "bash", id: this.#bashId, command, output: "", running: true, cancelled: false, truncated: false });
    this.version++;
  }

  bashOutput(delta: string) {
    this.#patch(this.#bashId, "bash", (row) => ({ ...row, output: row.output + delta }));
  }

  bashEnd(result: { output: string; exitCode?: number; cancelled: boolean; truncated: boolean } | { error: string }) {
    this.#patch(this.#bashId, "bash", (row) =>
      "error" in result
        ? { ...row, running: false, output: row.output + result.error, exitCode: 1 }
        : { ...row, running: false, output: row.output || result.output, exitCode: result.exitCode, cancelled: result.cancelled, truncated: result.truncated },
    );
    this.#bashId = undefined;
  }

  /** Adds a note of the client's own (a command that failed, a session that could not open). */
  note(tone: "info" | "warning" | "error", title: string, text = "") {
    this.#push({ kind: "notice", id: this.#id("notice"), tone, title, text });
    this.version++;
  }

  /** A user's answer to an agent's question, kept as their bubble though it never rode the wire. */
  recordAnswer(text: string) {
    const clean = withoutPreamble(withoutImageNotes(text));
    if (!clean) return;
    this.#closeTurn();
    this.#reportFailure();
    this.#flushResults();
    this.#push({ kind: "user", id: this.#id("u"), text: clean, images: 0 });
    this.version++;
  }

  /** Adds a summary divider row (such as a Portable Context Handoff or multi-agent synthesis). */
  summary(title: string, text = "") {
    this.#push({ kind: "summary", id: this.#id("handoff"), title, text });
    this.version++;
  }

  /** Stages an outgoing user message so its bubble appears on send, ahead of the agent's echo. */
  stageUser(rawText: string, images: number | readonly ImageContent[] = 0, queued = false): string | undefined {
    const text = withoutPreamble(withoutImageNotes(rawText));
    const imageCount = typeof images === "number" ? images : images.length;
    const imageBlocks =
      typeof images === "number"
        ? []
        : images.filter((block): block is ImageContent => block.type === "image" && typeof block.data === "string" && block.data.length > 0);
    if ((!text && !imageCount) || (!imageCount && pippiDeliveries(text))) return undefined;
    const id = this.#id("u");
    this.#staged.push({
      row: {
        kind: "user",
        id,
        text,
        images: imageCount,
        ...(imageBlocks.length ? { imageBlocks } : {}),
        ...(queued ? { queued } : {}),
      },
      t0: Date.now(),
      queued,
    });
    this.version++;
    return id;
  }

  /** Withdraws an unconfirmed staged user message (e.g. a refused or extension-handled prompt). */
  dropStagedUser(id: string | undefined): boolean {
    if (!id) return false;
    const at = this.#staged.findIndex((item) => item.row.id === id);
    if (at < 0) return false;
    this.#staged.splice(at, 1);
    this.version++;
    return true;
  }

  /** A staged bubble's send is live again after waiting out a switch: the withdrawal clock its carry armed stands down. */
  keepStaged(id: string | undefined) {
    const item = this.#staged.find((entry) => entry.row.id === id);
    if (!item || item.dropAt === undefined) return;
    item.dropAt = undefined;
    this.version++;
  }

  /** Marks a staged message as one the agent queued: it may yet be recalled before its echo. */
  markStagedQueued(id: string | undefined) {
    const item = this.#staged.find((entry) => entry.row.id === id);
    if (!item) return;
    item.queueAcked = true;
    item.dropAt = undefined;
    if (item.queued) return;
    item.queued = true;
    item.row = { ...item.row, queued: true };
    this.version++;
  }

  /** Marks an optimistically-queued staged message as actively started (the previous run settled before the prompt arrived). */
  markStagedStarted(id: string | undefined) {
    const item = this.#staged.find((entry) => entry.row.id === id);
    if (!item) return;
    item.queueAcked = true;
    if (!item.queued && item.dropAt === undefined) return;
    item.queued = false;
    item.dropAt = undefined;
    const { queued: _q, ...rest } = item.row;
    item.row = rest;
    this.version++;
  }

  /**
   * Reconciles staged queued bubbles with the agent's queue: an entry still
   * queued keeps its bubble; one that left gets `dropAt` — it normally echoes
   * back as delivered, and only a recall leaves it to `sweepDrops`. An entry
   * no bubble stands for (the queue of a session attached anew: its bubbles
   * went with the screen that sent them) gets one — the conversation is where
   * the queue is shown and taken back, so every entry must stand in it.
   */
  reconcileQueue(steering: readonly string[], followUp: readonly string[]) {
    const wireItems = [...steering, ...followUp];
    const cover = this.#queueCover(wireItems);
    const now = Date.now();
    let changed = false;
    const unmatched: StagedUserEntry[] = [];
    // The queue delivers oldest-first, so when identical texts thin out the cover
    // goes to the newest bubbles: the oldest copy is the one being delivered, and
    // marking the still-waiting newest for withdrawal would vanish it from the line.
    for (const item of [...this.#staged].reverse()) {
      if (!item.queued) continue;
      const left = cover.get(item.row.text) ?? 0;
      if (left > 0) {
        cover.set(item.row.text, left - 1);
        item.queueAcked = true;
        if (item.dropAt !== undefined) {
          item.dropAt = undefined;
          changed = true;
        }
      } else {
        unmatched.push(item);
      }
    }
    let unmatchedWire = 0;
    for (const count of cover.values()) unmatchedWire += count;
    const spare = unmatchedWire;
    for (const item of unmatched) {
      if (unmatchedWire > 0) {
        // A `/skill` or template-expanded prompt in the agent's queue no longer matches
        // the typed text verbatim, so remaining wire slots keep its bubble covered.
        unmatchedWire--;
        item.queueAcked = true;
        if (item.dropAt !== undefined) {
          item.dropAt = undefined;
          changed = true;
        }
      } else if (wireItems.length > 0 && !item.queueAcked) {
        // An earlier queue change arrived while this prompt's RPC is still in flight.
        continue;
      } else if (item.dropAt === undefined) {
        item.dropAt = now + QUEUE_ECHO_GRACE_MS;
        changed = true;
      }
    }
    // A prompt sent as a fresh run that the agent queued instead is staged, not yet marked: a slot is its own.
    unmatchedWire -= this.#staged.filter((item) => !item.queued).length;
    if (unmatchedWire > 0) {
      // The entries left over, in the order the queue will deliver them; the first `spare - unmatchedWire` stand already.
      const left: string[] = [];
      for (const raw of wireItems) {
        const text = withoutPreamble(withoutImageNotes(raw));
        const n = cover.get(text) ?? 0;
        if (n <= 0) continue;
        cover.set(text, n - 1);
        left.push(text);
      }
      for (const text of left.slice(spare - unmatchedWire)) {
        const id = this.stageUser(text, 0, true);
        const item = id ? this.#staged.find((entry) => entry.row.id === id) : undefined;
        if (item) item.queueAcked = true;
      }
    }
    if (changed) this.version++;
  }

  /**
   * Drops the staged bubbles of messages a `clear_queue` took back, at once —
   * the texts it returned name exactly what will never echo.
   */
  dropQueuedMatching(cleared: readonly string[]) {
    const cover = this.#queueCover([...cleared]);
    const exactDropped = new Set<StagedUserEntry>();
    for (const item of this.#staged) {
      if (!item.queued) continue;
      const left = cover.get(item.row.text) ?? 0;
      if (left > 0) {
        cover.set(item.row.text, left - 1);
        exactDropped.add(item);
      }
    }
    let unmatchedCleared = 0;
    for (const count of cover.values()) unmatchedCleared += count;
    const kept = this.#staged.filter((item) => {
      if (!item.queued) return true;
      if (exactDropped.has(item)) return false;
      if (unmatchedCleared > 0) {
        unmatchedCleared--;
        return false;
      }
      return true;
    });
    if (kept.length === this.#staged.length) return;
    this.#staged = kept;
    this.version++;
  }

  /** Whether a sent user message is still waiting for its `message_start` echo. */
  hasStagedUser(): boolean {
    return this.#staged.length > 0;
  }

  /** Whether a staged bubble with this row id still waits here — one staged before a switch may have ridden across a landing (`carryStagedTo`) or been withdrawn meanwhile. */
  hasStagedId(id: string | undefined): boolean {
    return id !== undefined && this.#staged.some((item) => item.row.id === id);
  }

  /**
   * Whether a staged message still expects a run or an echo: one the queue took
   * back (`dropAt`) no longer does — its bubble only waits out the grace. One
   * the agent confirmed into its queue does not count either: it is not about to
   * start anything, so a settle arriving over it is the run's real end (which only
   * error or abort can bring while the queue still holds it), not a stale one.
   */
  hasPendingUser(): boolean {
    return this.#staged.some((item) => item.dropAt === undefined && !(item.queued && item.queueAcked));
  }

  /** The soonest a staged bubble may withdraw, for the store to wake a flush at. */
  dropDeadline(): number | undefined {
    let at: number | undefined;
    for (const item of this.#staged) {
      if (item.dropAt !== undefined && (at === undefined || item.dropAt < at)) at = item.dropAt;
    }
    return at;
  }

  /** Withdraws staged bubbles past their `dropAt`; true when rows changed. */
  sweepDrops(): boolean {
    const now = Date.now();
    const kept = this.#staged.filter((item) => item.dropAt === undefined || item.dropAt > now);
    if (kept.length === this.#staged.length) return false;
    this.#staged = kept;
    this.version++;
    return true;
  }

  /** Promotes any still-staged user rows into `#rows` (e.g. when re-attaching after `message_start` already ran). */
  commitStagedUsers() {
    if (!this.#staged.length) return;
    this.#commitStaged();
    this.version++;
  }

  /**
   * Gives a transcript that replaces this one the staged bubbles its rows do not
   * already show — this transcript belongs to the same conversation (a landing
   * re-fetches its session). A bubble the file has not echoed yet survives the
   * replacement with a grace: an echo still coming adopts it (`#takeStaged`
   * matches on text), one that never comes withdraws it honestly instead of the
   * send vanishing between frames or committing phantom later.
   */
  carryStagedTo(next: Transcript, now = Date.now()) {
    for (const item of this.#staged) {
      const echoed = next.rows().some((row) => row.kind === "user" && row.text === item.row.text && (row.images ?? 0) === item.row.images);
      if (!echoed) next.#staged.push({ ...item, dropAt: item.dropAt ?? now + QUEUE_ECHO_GRACE_MS });
    }
  }

  #commitStaged() {
    // A queued bubble commits only on its own echo: promoting it here would leave
    // the echo to mint a second row for the same message.
    const ready = this.#staged.filter((item) => !item.queued);
    if (!ready.length) return;
    this.#staged = this.#staged.filter((item) => item.queued);
    for (const { row, t0 } of ready) {
      this.#closeTurn();
      this.#reportFailure();
      this.#flushResults();
      this.#push(row);
      this.#turnStart = t0;
    }
  }

  /** How many staged bubbles each queued text still covers (the queue holds wire prompts; staged rows hold what was typed). */
  #queueCover(texts: readonly string[]) {
    const cover = new Map<string, number>();
    for (const raw of texts) {
      const text = withoutPreamble(withoutImageNotes(raw));
      cover.set(text, (cover.get(text) ?? 0) + 1);
    }
    return cover;
  }

  /**
   * The staged bubble an echoed user message confirms. Content first — queued
   * messages echo in delivery order, not send order — then, for an echo the
   * agent rewrote (a skill or template expanded), the message already dequeued
   * for delivery or the oldest still waiting on its echo.
   */
  #takeStaged(text: string, images: number) {
    const exact = this.#staged.findIndex((item) => item.row.text === text && item.row.images === images);
    if (exact >= 0) return this.#staged.splice(exact, 1)[0];
    const dequeued = this.#staged.findIndex((item) => item.dropAt !== undefined);
    const pending = this.#staged.findIndex((item) => !item.queued);
    const at = dequeued >= 0 ? dequeued : pending;
    return at >= 0 ? this.#staged.splice(at, 1)[0] : undefined;
  }

  /** Prepends historical rows (for example, keeping visible conversation rows across a harness switch). */
  seedRows(previous: readonly Row[]) {
    this.#editing = false;
    this.#editText.clear();
    this.#rows = [];
    this.#staged = [];
    this.#index.clear();
    this.#callCounts.clear();
    this.#callRows.clear();
    for (const row of previous) this.#push(row);
    this.version++;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  #id(prefix: string) {
    return `${prefix}${++seq}`;
  }

  /**
   * The row id for one call of a wire `toolCallId`: the id itself the first
   * time, a suffix for every later occurrence, so engines reusing `item_0` /
   * `"0"` across turns never overwrite earlier rows. The minted id becomes the
   * wire id's entry in `#callRows` — the row every event for that open call
   * resolves to.
   */
  #mintToolId(toolCallId: string) {
    let count = (this.#callCounts.get(toolCallId) ?? 0) + 1;
    let id = count === 1 ? toolCallId : `${toolCallId}~${count}`;
    while (this.#index.has(id)) id = `${toolCallId}~${++count}`;
    this.#callCounts.set(toolCallId, count);
    this.#callRows.set(toolCallId, { id, ended: false });
    return id;
  }

  /** The row a wire `toolCallId`'s live events resolve to: its open call's, else a new occurrence's. */
  #callRow(toolCallId: string) {
    const open = this.#callRows.get(toolCallId);
    return open && !open.ended ? open.id : this.#mintToolId(toolCallId);
  }

  /** The time as the transcript reads it: now, or while loading, the message's (`undefined` when it has none). */
  #now() {
    return this.#clock === undefined ? Date.now() : (this.#clock ?? undefined);
  }

  #push(row: Row) {
    if (isTurnRow(row)) {
      if (row.t0 === undefined) row = { ...row, t0: this.#turnStart ?? this.#now() };
      if (this.#newTurn) {
        row = { ...row, turnStart: true };
        this.#newTurn = false;
      } else if (this.#closed) {
        // A closed turn that a row joins goes on: it is not over, and how long it took is not known yet.
        this.#stampTurn(undefined);
      }
    }
    this.#closed = false;
    this.#index.set(row.id, this.#rows.length);
    this.#rows.push(row);
  }

  /** Index of the first row of the turn at the end of the rows (stopping at a `turnStart` boundary). */
  #turnHead(): number {
    let first = this.#rows.length;
    while (first > 0) {
      const prev = this.#rows[first - 1];
      if (!isTurnRow(prev)) break;
      first--;
      if (prev.turnStart) break;
    }
    return first;
  }

  /** Writes how long the turn at the end of the rows took on its first row; `undefined` takes it back. */
  #stampTurn(turnMs: number | undefined) {
    const first = this.#turnHead();
    const row = this.#rows[first];
    if (row && isTurnRow(row) && row.turnMs !== turnMs) this.#rows[first] = { ...row, turnMs };
  }

  #set(row: Row) {
    const at = this.#index.get(row.id);
    if (at === undefined) return this.#push(row);
    // What a row learned about its turn outlives the changes that replace it.
    const before = this.#rows[at];
    if (isTurnRow(row) && isTurnRow(before)) {
      row = {
        ...row,
        t0: row.t0 ?? before.t0,
        turnMs: row.turnMs ?? before.turnMs,
        ...((row.turnStart ?? before.turnStart) ? { turnStart: true } : {}),
      };
      if (row.kind === "text" && before.kind === "text" && row.final === undefined && before.final) row = { ...row, final: true };
    }
    this.#rows[at] = row;
  }

  /** The turn at the end of the rows is over: its first row keeps how long it took. */
  #closeTurn() {
    const first = this.#turnHead();
    const row = this.#rows[first];
    const now = this.#now();
    if (row && isTurnRow(row) && row.turnMs === undefined && row.t0 !== undefined && now !== undefined) {
      this.#rows[first] = { ...row, turnMs: Math.max(0, now - row.t0) };
    }
    if (this.#editing && row && isTurnRow(row)) this.#rows[first] = { ...this.#rows[first], silentEdit: true } as Row;
    this.#closed = row !== undefined && isTurnRow(row);
    this.#turnStart = undefined;
    this.#newTurn = false;
  }

  #get(id: string | undefined) {
    const at = id === undefined ? undefined : this.#index.get(id);
    return at === undefined ? undefined : this.#rows[at];
  }

  #patch<K extends Row["kind"]>(id: string | undefined, kind: K, change: (row: Extract<Row, { kind: K }>) => Row) {
    const row = this.#get(id);
    if (!row || row.kind !== kind) return;
    this.#set(change(row as Extract<Row, { kind: K }>));
    this.version++;
  }

  #removeRow(id: string) {
    const at = this.#index.get(id);
    if (at === undefined) return;
    const removed = this.#rows[at];
    const next = this.#rows[at + 1];
    if (isTurnRow(removed)) {
      if (next && isTurnRow(next)) {
        let patched = next;
        if (patched.t0 === undefined && removed.t0 !== undefined) patched = { ...patched, t0: removed.t0 };
        if (removed.turnStart && !patched.turnStart) patched = { ...patched, turnStart: true };
        if (patched.turnMs === undefined && removed.turnMs !== undefined) patched = { ...patched, turnMs: removed.turnMs };
        if (patched !== next) this.#rows[at + 1] = patched;
      } else {
        if (removed.t0 !== undefined) this.#turnStart ??= removed.t0;
        if (removed.turnStart) this.#newTurn = true;
      }
    }
    this.#rows.splice(at, 1);
    this.#index.delete(id);
    for (let i = at; i < this.#rows.length; i++) this.#index.set(this.#rows[i].id, i);
  }

  #tool(id: string, change: (row: ToolRow) => ToolRow, name: string, callId?: string) {
    const row = this.#get(id);
    const base: ToolRow =
      row?.kind === "tool"
        ? row
        : { kind: "tool", id, ...(callId ? { callId } : {}), name, args: {}, status: "queued", output: "", images: 0 };
    this.#set(change(base));
  }

  #result(result: ToolResult | undefined, row: ToolRow) {
    if (!result) return {};
    const imageBlocks = imageBlocksOf(result.content);
    const resources = resourcesOf(result.content);
    return {
      output: textOf(result.content) || row.output,
      images: imagesOf(result.content),
      ...(imageBlocks.length ? { imageBlocks } : {}),
      ...(resources.length ? { resources } : {}),
      details: result.details ?? row.details,
    };
  }

  /** The row a live block writes next: prose an answer bubble cut goes on below it, not silently appended above. */
  #openRow(id: string, kind: "text" | "thinking") {
    const row = this.#get(id);
    const at = row ? this.#index.get(id) : undefined;
    if (row?.kind === kind && at !== undefined && this.#rows.slice(at + 1).some((entry) => entry.kind === "user")) {
      this.#rows.splice(at, 1);
      this.#index.clear();
      this.#rows.forEach((entry, index) => this.#index.set(entry.id, index));
      this.#push(row);
      return this.#get(id);
    }
    return row;
  }

  /** One content block's progress in the live assistant message. */
  #update(event: AssistantMessageEvent, snapshot?: AssistantMessage) {
    let live = this.#live;
    if (!("contentIndex" in event)) return;
    if (!live) {
      // Mid-stream re-attach (e.g. Pi `get_entries` omits the in-flight assistant message,
      // so the first live event after attach is a `message_update` with no prior `message_start`).
      // Recover `#live` from an attached cumulative snapshot when present, or synthesize `#live`
      // on demand so subsequent deltas stream smoothly instead of being dropped until `message_end`.
      if (snapshot?.role === "assistant" && Array.isArray(snapshot.content)) {
        this.#pendingMessage(snapshot);
        return;
      }
      live = { key: `m${++seq}`, rowIds: new Map(), toolIds: new Map(), toolJson: new Map(), thinkingSince: new Map(), argsAt: new Map() };
      this.#live = live;
      const last = this.#rows.at(-1);
      if (
        last &&
        (((event.type === "text_delta" || event.type === "text_end") && last.kind === "text" && last.streaming) ||
          ((event.type === "thinking_delta" || event.type === "thinking_end") && last.kind === "thinking" && last.streaming))
      ) {
        live.rowIds.set(event.contentIndex, last.id);
      }
    }
    const id = live.rowIds.get(event.contentIndex) ?? `${live.key}.${event.contentIndex}`;
    if (this.#editing && (event.type === "text_start" || event.type === "text_delta" || event.type === "text_end")) {
      live.rowIds.set(event.contentIndex, id);
      const text = event.type === "text_start" ? "" : event.type === "text_end" ? event.content : (this.#editText.get(id) ?? "") + event.delta;
      this.#editText.set(id, text);
      const trimmed = text.trim().toLowerCase();
      if (!trimmed || ["[edited]", "<no-reply/>"].some((marker) => marker.startsWith(trimmed))) {
        this.#removeRow(id);
      } else {
        this.#set({ kind: "text", id, text, streaming: event.type !== "text_end" });
      }
      return;
    }
    switch (event.type) {
      case "text_start":
        live.rowIds.set(event.contentIndex, id);
        this.#set({ kind: "text", id, text: "", streaming: true });
        break;
      case "text_delta": {
        if (!live.rowIds.has(event.contentIndex)) live.rowIds.set(event.contentIndex, id);
        const row = this.#openRow(id, "text");
        this.#set({ kind: "text", id, text: (row?.kind === "text" ? row.text : "") + event.delta, streaming: true });
        break;
      }
      case "text_end":
        if (!live.rowIds.has(event.contentIndex)) live.rowIds.set(event.contentIndex, id);
        this.#set({ kind: "text", id, text: event.content, streaming: false });
        break;
      case "thinking_start":
        live.rowIds.set(event.contentIndex, id);
        live.thinkingSince.set(event.contentIndex, Date.now());
        this.#set({ kind: "thinking", id, text: "", streaming: true, redacted: false });
        break;
      case "thinking_delta": {
        if (!live.rowIds.has(event.contentIndex)) live.rowIds.set(event.contentIndex, id);
        const row = this.#openRow(id, "thinking");
        this.#set({ kind: "thinking", id, text: (row?.kind === "thinking" ? row.text : "") + event.delta, streaming: true, redacted: false });
        break;
      }
      case "thinking_end": {
        if (!live.rowIds.has(event.contentIndex)) live.rowIds.set(event.contentIndex, id);
        const since = live.thinkingSince.get(event.contentIndex);
        this.#set({ kind: "thinking", id, text: event.content, streaming: false, redacted: false, durationMs: since ? Date.now() - since : undefined });
        break;
      }
      case "toolcall_start": {
        const rowId = this.#mintToolId(event.id);
        live.toolIds.set(event.contentIndex, rowId);
        live.rowIds.set(event.contentIndex, rowId);
        live.toolJson.set(event.contentIndex, "");
        this.#set({ kind: "tool", id: rowId, callId: event.id, name: event.toolName, args: {}, status: "call", output: "", images: 0 });
        break;
      }
      case "toolcall_delta": {
        const toolId = live.toolIds.get(event.contentIndex);
        const row = this.#get(toolId);
        if (row?.kind !== "tool") break;
        const json = (live.toolJson.get(event.contentIndex) ?? "") + event.delta;
        live.toolJson.set(event.contentIndex, json);
        // The title only needs the leading fields; ~10x a second keeps it typing without re-scanning each token.
        const now = Date.now();
        if (now - (live.argsAt.get(event.contentIndex) ?? 0) > 90) {
          live.argsAt.set(event.contentIndex, now);
          const { args, incompleteKey } = partialArgs(json);
          const { incompleteArg: _inc, ...rest } = row;
          this.#set({ ...rest, args, ...(incompleteKey ? { incompleteArg: incompleteKey } : {}) });
        }
        break;
      }
      case "toolcall_end": {
        const rowId = live.toolIds.get(event.contentIndex) ?? this.#callRow(event.toolCall.id);
        const row = this.#get(rowId);
        const base: ToolRow =
          row?.kind === "tool"
            ? row
            : { kind: "tool", id: rowId, callId: event.toolCall.id, name: event.toolCall.name, args: {}, status: "queued", output: "", images: 0 };
        const { incompleteArg: _inc, ...rest } = base;
        this.#set({
          ...rest,
          callId: rest.callId ?? event.toolCall.id,
          name: event.toolCall.name,
          args: event.toolCall.arguments ?? {},
          status: rest.status === "call" ? "queued" : rest.status,
        });
        break;
      }
      case "media_block": {
        const media = mediaRowFromProtocolBlock(event.block, id);
        if (media) {
          live.rowIds.set(event.contentIndex, id);
          this.#set({ kind: "media", id, ...(media.title ? { title: media.title } : {}), items: media.items });
        }
        break;
      }
    }
  }

  /** The authoritative message replaces what was reconstructed from deltas, row by row. */
  #finish(message: AssistantMessage) {
    if (this.#editing) message = { ...message, content: message.content.map((block) => block.type === "text" && /^(?:\[edited\]|<no-reply\s*\/>)$/i.test(block.text.trim()) ? { ...block, text: "" } : block) };
    const live = this.#live ?? { key: `m${++seq}`, rowIds: new Map(), toolIds: new Map(), toolJson: new Map(), thinkingSince: new Map(), argsAt: new Map() };
    this.#live = undefined;
    this.#blocks(message, live.key, true, live.toolIds, live.rowIds);
    // The answer is in: the turn took this long, whatever the provider still cleans up.
    // (A message that failed is no answer yet: a retry goes on in the same turn.)
    if (answeredTurn(message)) this.#closeTurn();
  }

  #blocks(message: AssistantMessage, key: string, keepRuns: boolean, toolIds?: Map<number, string>, rowIds?: Map<number, string>) {
    // A later assistant message is the attempt made again: it answers for the one that failed before it.
    this.#failure = undefined;
    const failed = message.stopReason === "error";
    // A message that calls no tools ends the turn: its prose is the answer. A
    // turn held in one message (the bridge's play of ACP harnesses) answers
    // with the prose after its last step — the same trailing run of texts
    // `#settle` marks when the live run ends. Not one that failed: what it left
    // becomes the answer only if the failure stands (`#reportFailure`).
    const hasTools = message.content.some((block) => block.type === "toolCall");
    const lastStep = message.content.reduce((at, block, index) => (isProcessBlock(block) ? index : at), -1);
    const final = (index: number) => !failed && (hasTools ? message.stopReason !== "toolUse" && index > lastStep : true);
    message.content.forEach((block, index) => {
      const id = rowIds?.get(index) ?? `${key}.${index}`;
      if (block.type === "text") {
        if (block.text.trim()) this.#set({ kind: "text", id, text: block.text, streaming: false, final: final(index), ...(index > lastStep ? { editKey: message.editKey, versions: message.versions } : {}) });
        else this.#removeRow(id);
      } else if (block.type === "thinking") {
        const before = this.#get(id);
        if (block.thinking.trim() || block.redacted) {
          this.#set({ kind: "thinking", id, text: block.thinking, streaming: false, redacted: !!block.redacted, durationMs: before?.kind === "thinking" ? before.durationMs : undefined });
        } else {
          this.#removeRow(id);
        }
      } else if (block.type === "image" || block.type === "audio" || block.type === "resource" || block.type === "presented_media") {
        const media = mediaRowFromProtocolBlock(block, id);
        if (media) this.#set({ kind: "media", id, ...(media.title ? { title: media.title } : {}), items: media.items });
      } else if (block.type === "toolCall") {
        // The block's own call is the one streamed at its content index, if
        // there was one; anything else — history, a call never streamed — is
        // the wire id seen once more: a new occurrence, not the row it named
        // before.
        const rowId = toolIds?.get(index) ?? this.#mintToolId(block.id);
        const before = this.#get(rowId);
        const base: ToolRow =
          before?.kind === "tool"
            ? before
            : { kind: "tool", id: rowId, callId: block.id, name: block.name, args: {}, status: "queued", output: "", images: 0 };
        const bg = !!block.background && !failed && message.stopReason !== "aborted";
        // A call the failed message never got to run will not run: it does not go on spinning through the retries.
        if (failed && (base.status === "call" || base.status === "queued")) {
          const { background: _bg, incompleteArg: _inc, ...rest } = base;
          this.#set({
            ...rest,
            callId: rest.callId ?? block.id,
            name: block.name,
            args: block.arguments ?? {},
            status: "error",
            output: base.output || this.#tr("Stopped before it finished.", "完成前已停止。"),
          });
        } else {
          const settled = base.status === "done" || base.status === "error";
          if (bg && !settled) {
            const { incompleteArg: _inc, ...rest } = base;
            this.#set({ ...rest, callId: rest.callId ?? block.id, name: block.name, args: block.arguments ?? {}, status: "running", background: true });
          } else {
            const { background: _bg, incompleteArg: _inc, ...rest } = base;
            this.#set({
              ...rest,
              callId: rest.callId ?? block.id,
              name: block.name,
              args: block.arguments ?? {},
              status: keepRuns && base.status !== "call" ? base.status : "queued",
            });
          }
        }
        // A result read ahead of its call lands on the row now that the call is
        // known — the first in line: an id the turn used twice has a result
        // waiting for each of its calls, in the order they ran.
        const pendings = this.#pendingResults.get(block.id);
        const pending = pendings?.shift();
        if (pending) {
          if (!pendings!.length) this.#pendingResults.delete(block.id);
          this.#tool(rowId, (row) => this.#applyToolResult(row, pending), pending.toolName, block.id);
          // Its result consumed, the call is over: the id's next use is a new occurrence's.
          if (this.#callRows.get(block.id)?.id === rowId) this.#callRows.delete(block.id);
        }
      }
    });
    if (rowIds) {
      for (const [index, id] of rowIds) {
        if (index < message.content.length) continue;
        const leftover = this.#get(id);
        if (leftover && ((leftover.kind === "text" && !leftover.text.trim()) || (leftover.kind === "thinking" && !leftover.text.trim() && !leftover.redacted))) {
          this.#removeRow(id);
        }
      }
    }
    if (failed) {
      this.#failure = message.errorMessage?.trim() || this.#tr("No details were given.", "未提供详细信息。");
    } else if (message.stopReason === "length") {
      this.#push({
        kind: "notice",
        id: this.#id("notice"),
        tone: "warning",
        title: this.#tr("The reply hit the output limit", "回复达到了输出上限"),
        text: this.#tr("Ask the model to continue to get the rest.", "请让模型继续以获取剩余内容。"),
      });
    }
  }

  /**
   * Says what the run failed on: one notice, after whatever the failed message
   * left, and the same one a session's history gives. The prose before it is as
   * much of an answer as there will be.
   */
  #reportFailure() {
    const text = this.#failure;
    if (text === undefined) return;
    this.#failure = undefined;
    for (let at = this.#rows.length - 1; at >= 0; at--) {
      const row = this.#rows[at];
      if (row.kind !== "text") break;
      if (row.streaming || !row.final) this.#rows[at] = { ...row, streaming: false, final: true };
    }
    this.#push({
      kind: "notice",
      id: this.#id("notice"),
      tone: "error",
      title: this.#tr("The model returned an error", "模型返回了错误"),
      text: formatProviderError(text),
    });
  }

  /**
   * A still-streaming assistant message `get_messages` carried (the bridge's
   * `stopReason: "pending"`): its rows go up as they stand — open blocks marked
   * `streaming`, running calls marked `background` — and the live state with
   * them, so the stream it was cut from keeps writing to the same rows.
   */
  #pendingMessage(message: AssistantMessage) {
    const live = { key: `m${++seq}`, rowIds: new Map<number, string>(), toolIds: new Map<number, string>(), toolJson: new Map<number, string>(), thinkingSince: new Map<number, number>(), argsAt: new Map<number, number>() };
    this.#live = live;
    message.content.forEach((block, index) => {
      const id = `${live.key}.${index}`;
      if (block.type === "text") {
        if (block.streaming === true || block.text.trim()) {
          live.rowIds.set(index, id);
          this.#set({ kind: "text", id, text: block.text, streaming: block.streaming === true });
        }
      } else if (block.type === "thinking") {
        if (block.streaming === true || block.thinking.trim() || block.redacted) {
          live.rowIds.set(index, id);
          if (block.streaming === true) live.thinkingSince.set(index, Date.now());
          this.#set({ kind: "thinking", id, text: block.thinking, streaming: block.streaming === true, redacted: !!block.redacted });
        }
      } else if (block.type === "image" || block.type === "audio" || block.type === "resource" || block.type === "presented_media") {
        const media = mediaRowFromProtocolBlock(block, id);
        if (media) {
          live.rowIds.set(index, id);
          this.#set({ kind: "media", id, ...(media.title ? { title: media.title } : {}), items: media.items });
        }
      } else if (block.type === "toolCall") {
        const rowId = this.#mintToolId(block.id);
        live.toolIds.set(index, rowId);
        live.rowIds.set(index, rowId);
        this.#set({ kind: "tool", id: rowId, callId: block.id, name: block.name, args: block.arguments ?? {}, status: block.background ? "running" : "queued", output: "", images: 0 });
        if (block.background) this.#toolSince.set(rowId, Date.now());
        // A result read ahead of the call lands on the row now that the call is known.
        const pendings = this.#pendingResults.get(block.id);
        const pending = pendings?.shift();
        if (pending) {
          if (!pendings!.length) this.#pendingResults.delete(block.id);
          this.#tool(rowId, (row) => this.#applyToolResult(row, pending), pending.toolName, block.id);
          if (this.#callRows.get(block.id)?.id === rowId) this.#callRows.delete(block.id);
        }
      }
    });
  }

  /** A tool's result applied to its call's row: its output, images and outcome. */
  #applyToolResult(row: ToolRow, message: ToolResultMessage): ToolRow {
    const { background: _bg, ...rest } = row;
    const imageBlocks = imageBlocksOf(message.content);
    const resources = resourcesOf(message.content);
    return {
      ...rest,
      output: textOf(message.content) || row.output,
      images: imagesOf(message.content),
      ...(imageBlocks.length ? { imageBlocks } : {}),
      ...(resources.length ? { resources } : {}),
      details: message.details ?? row.details,
      status: message.isError ? "error" : "done",
    };
  }

  /** Results still waiting on their call missed it once the transcript moves on: they land where the wait ended. */
  #flushResults() {
    if (!this.#pendingResults.size) return;
    for (const pendings of this.#pendingResults.values()) {
      for (const message of pendings) {
        const rowId = this.#callRow(message.toolCallId);
        this.#tool(rowId, (row) => this.#applyToolResult(row, message), message.toolName, message.toolCallId);
        this.#callRows.delete(message.toolCallId);
      }
    }
    this.#pendingResults.clear();
  }

  /** A whole message: from history, or one that arrives complete (a user's, a tool's result). */
  #append(message: AgentMessage) {
    // The conversation moves on from a failure nothing took the place of: it is said before what follows.
    if (message.role !== "assistant") {
      this.#reportFailure();
      if (message.role !== "toolResult") this.#flushResults();
    }
    switch (message.role) {
      case "user": {
        const text = withoutPreamble(withoutImageNotes(textOf(message.content)));
        const images = imagesOf(message.content);
        const imageBlocks = imageBlocksOf(message.content);
        const deliveries = images ? undefined : pippiDeliveries(text);
        if (deliveries) {
          for (const item of deliveries) this.#push({ kind: "delivery", id: this.#id("d"), ...item });
          this.#turnStart = this.#now();
        } else if (text || images) {
          const staged = this.#clock === undefined ? this.#takeStaged(text, images) : undefined;
          const keptImages = imageBlocks.length ? imageBlocks : staged?.row.imageBlocks;
          const sameStagedImages = (staged?.row.imageBlocks?.length ?? 0) === (keptImages?.length ?? 0);
          const row: Row =
            staged && staged.row.text === text && staged.row.images === images && sameStagedImages && !staged.row.queued
              ? staged.row
              : {
                  kind: "user",
                  id: staged ? staged.row.id : this.#id("u"),
                  text,
                  images,
                  ...(keptImages?.length ? { imageBlocks: keptImages } : {}),
                };
          this.#push(row);
          this.#turnStart = staged?.t0 ?? this.#now();
        } else {
          this.#turnStart = this.#now();
        }
        break;
      }
      case "assistant":
        this.#blocks(message, `m${++seq}`, false);
        break;
      case "toolResult": {
        // A result whose call is open joins its row — and ends it, so the id's
        // next use is a new occurrence's; one read ahead of its call waits for
        // the block, in line behind any read before it.
        const open = this.#callRows.get(message.toolCallId);
        if (open && !open.ended && this.#get(open.id)?.kind === "tool") {
          this.#tool(open.id, (row) => this.#applyToolResult(row, message), message.toolName, message.toolCallId);
          this.#callRows.delete(message.toolCallId);
        } else {
          const waiting = this.#pendingResults.get(message.toolCallId) ?? [];
          waiting.push(message);
          this.#pendingResults.set(message.toolCallId, waiting);
        }
        break;
      }
      case "bashExecution":
        this.#push({
          kind: "bash",
          id: this.#id("bash"),
          command: message.command,
          output: message.output,
          running: false,
          exitCode: message.exitCode,
          cancelled: message.cancelled,
          truncated: message.truncated,
        });
        break;
      case "custom":
        if (message.display) this.#push({ kind: "notice", id: this.#id("notice"), tone: "info", title: message.customType, text: textOf(message.content) });
        break;
      case "compactionSummary":
        this.#push({
          kind: "summary",
          id: this.#id("compaction"),
          title: this.#tr(`Context compacted from ${compactNumber(message.tokensBefore)} tokens`, `上下文已从 ${compactNumber(message.tokensBefore)} tokens 压缩`),
          text: message.summary,
        });
        break;
      case "branchSummary":
        this.#push({ kind: "summary", id: this.#id("branch"), title: this.#tr("Summary of the branch you left", "所离开分支的摘要"), text: message.summary });
        break;
    }
  }

  /** A run is over: nothing is streaming or running any more, whatever the last event said. */
  #settle(aborted = false) {
    this.#live = undefined;
    this.#toolSince.clear();
    this.#flushResults();
    this.#newTurn = false;
    // Prose a stopped run left at the end is as much of an answer as there will
    // be — prose a message already classified keeps the place it was given.
    let tail = this.#rows.length;
    while (tail > 0 && (this.#rows[tail - 1].kind === "text" || this.#rows[tail - 1].kind === "media")) tail--;
    this.#rows = this.#rows.map((row, at) => {
      if (row.kind === "text" && at >= tail && row.final === undefined) return { ...row, streaming: false, final: true };
      if ((row.kind === "text" || row.kind === "thinking") && row.streaming) return { ...row, streaming: false };
      if (row.kind === "tool" && (row.status === "call" || row.status === "queued" || row.status === "running")) {
        if (row.background && !aborted && row.status === "running") return row;
        const { background: _bg, ...rest } = row;
        return { ...rest, status: "error" as const, output: row.output || this.#tr("Stopped before it finished.", "完成前已停止。") };
      }
      return row;
    });
    // The calls still open when the run stopped are over: an id minting again
    // past this point is a new occurrence's, never theirs. A background call
    // goes on running — its events still find it.
    for (const open of this.#callRows.values()) {
      const row = this.#get(open.id);
      if (!row || row.kind !== "tool" || !(!aborted && row.background && row.status === "running")) open.ended = true;
    }
    this.#closeTurn();
    this.#reportFailure();
  }
}

/** 1234 → "1.2k", 1500000 → "1.5M". */
export function compactNumber(n: number) {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** A tool call in one line: the part of its arguments a person would say aloud. */
export function toolSummary(name: string, args: Record<string, unknown>, lang: Lang = "en"): string {
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = args[key];
      if (typeof value === "string" && value) return value;
    }
    return "";
  };
  const within = (place: string) => (lang === "zh" ? `  于 ${place}` : `  in ${place}`);
  switch (name) {
    case "bash":
      return pick("command");
    case "read":
    case "write":
    case "edit":
    case "ls":
      return pick("path", "file_path");
    case "grep": {
      const where = pick("path", "glob");
      return `${pick("pattern")}${where ? within(where) : ""}`;
    }
    case "find":
      return `${pick("pattern")}${pick("path") ? within(pick("path")) : ""}`;
    case "delegate_task": {
      const target = pick("agentId", "agent");
      const role = pick("role");
      const title = pick("title", "task");
      return [target, role, title].filter(Boolean).join(" · ");
    }
    case "session_start": {
      const target = pick("agent", "agentId");
      const title = pick("title");
      return [target, title].filter(Boolean).join(" · ");
    }
    case "session_send":
    case "session_read":
    case "session_stop":
      return pick("session", "sessionId", "id");
    case "sessions_list":
      return lang === "zh" ? "会话树" : "the session tree";
    case "agents_list":
      return lang === "zh" ? "可用智能体与模型" : "available agents & models";
    default: {
      const first = pick("path", "file_path", "command", "query", "pattern", "url", "name", "prompt", "description");
      if (first) return first;
      const text = JSON.stringify(args);
      return text === "{}" ? "" : text;
    }
  }
}
