import type { Lang } from "../lib/i18n";
import type { AgentMessage, AssistantMessage, AssistantMessageEvent, ImageContent, SessionEvent, TextContent, ToolResult, ToolResultMessage } from "./protocol";

/**
 * The transcript: a session's messages as the rows the chat shows.
 *
 * Pi's messages nest content blocks; the chat is flat. An assistant message
 * becomes one row per block (prose, thinking, a tool call), and a tool's
 * result joins its call's row. Rows are immutable: a change replaces the row
 * with a new object under the same `id`, which is what the list diffs by.
 */
export type Row =
  | { kind: "user"; id: string; text: string; images: number }
  | ({ kind: "text"; id: string; text: string; streaming: boolean; /** The prose of a message that called no tools: the turn's answer. Known once the message ended. */ final?: boolean } & TurnStamp)
  | ({ kind: "thinking"; id: string; text: string; streaming: boolean; redacted: boolean; durationMs?: number } & TurnStamp)
  | ToolRow
  | { kind: "bash"; id: string; command: string; output: string; running: boolean; exitCode?: number; cancelled: boolean; truncated: boolean }
  | { kind: "notice"; id: string; tone: "info" | "warning" | "error"; title: string; text: string }
  | { kind: "summary"; id: string; title: string; text: string }
  /** An answer another session delivered back (`<pipi-message>` envelope), shown as a from-session row. */
  | { kind: "delivery"; id: string; from: string; fromTitle: string; agent: string; status: string; text: string };

/** When the turn a row belongs to started, and on the turn's first row, how long the turn took once it is over. */
export interface TurnStamp {
  t0?: number;
  turnMs?: number;
}

const isTurnRow = (row: Row): row is Extract<Row, { kind: "text" | "thinking" | "tool" }> =>
  row.kind === "text" || row.kind === "thinking" || row.kind === "tool";

/** What a row says, apart from its id: two loads of a conversation pair their rows up by it (`adopt`). */
const signature = (row: Row): string => {
  switch (row.kind) {
    case "user":
      return `user\n${row.images}\n${row.text}`;
    case "text":
    case "thinking":
      return `${row.kind}\n${row.text}`;
    case "tool":
      return `tool\n${row.id}`;
    case "bash":
      return `bash\n${row.command}`;
    case "notice":
      return `notice\n${row.title}\n${row.text}`;
    case "summary":
      return `summary\n${row.text}`;
    case "delivery":
      return `delivery\n${row.from}\n${row.text}`;
  }
};

/** Whether the message answered its turn: called no tools without failing, or —
 * a turn held in one message, as the bridge plays ACP harnesses — ended on
 * prose after its steps. One still calling tools or that failed answers nothing. */
const answeredTurn = (message: AssistantMessage): boolean => {
  if (message.stopReason === "error") return false;
  if (!message.content.some((block) => block.type === "toolCall")) return true;
  return message.stopReason !== "toolUse" && message.content.at(-1)?.type === "text";
};

export interface ToolRow extends TurnStamp {
  kind: "tool";
  id: string;
  name: string;
  /** The arguments once the call is complete; while it streams, what has parsed so far. */
  args: Record<string, unknown>;
  /** `call`: the model is still writing the call. `queued`: written, not yet started. */
  status: "call" | "queued" | "running" | "done" | "error";
  output: string;
  images: number;
  details?: unknown;
  durationMs?: number;
}

const textOf = (content: string | (TextContent | ImageContent)[] | undefined) =>
  typeof content === "string"
    ? content
    : (content ?? [])
        .filter((block): block is TextContent => block.type === "text")
        .map((block) => block.text)
        .join("\n");

const imagesOf = (content: string | (TextContent | ImageContent)[] | undefined) =>
  typeof content === "string" ? 0 : (content ?? []).filter((block) => block.type === "image").length;

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

/** The arguments a partial JSON object has so far: enough to title a tool call while it streams. */
function partialArgs(json: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  let i = json.indexOf("{") + 1;
  if (!i) return args;
  const n = json.length;
  const skip = () => {
    while (i < n && (json.charCodeAt(i) <= 32 || json[i] === ",")) i++;
  };
  /** String contents from the `"` at i; stops at its close or at end of input. */
  const scanString = (): string => {
    let out = "";
    i++;
    while (i < n) {
      const c = json[i++];
      if (c === '"') break;
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
    return out;
  };
  while (i < n) {
    skip();
    if (i >= n || json[i] === "}") break;
    if (json[i] !== '"') break;
    const key = scanString();
    skip();
    if (json[i] !== ":") break;
    i++;
    skip();
    if (i >= n) break;
    const c = json[i];
    if (c === '"') {
      // An unfinished string still titles the call: `{"path":"src/ap` reads as { path: "src/ap" }.
      args[key] = scanString();
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
  return args;
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
  #rows: Row[] = [];
  #index = new Map<string, number>();
  /** The assistant message being streamed: its key, and what its tool calls have of their arguments. */
  #live: { key: string; toolIds: Map<number, string>; toolJson: Map<number, string>; thinkingSince: Map<number, number>; argsAt: Map<number, number> } | undefined;
  /** Start timestamps for running tool executions so external engines without `durationMs` still measure elapsed time. */
  #toolSince = new Map<string, number>();
  /**
   * Results read ahead of the call that made them: the bridge lists a turn's
   * tool results before the one assistant message holding every block (its
   * calls included), so on a reload a result can land before its call's row
   * exists. It waits here for the block instead — minting the row on sight
   * would park every tool at the head of its turn and leave the message's
   * prose out of order.
   */
  #pendingResults = new Map<string, ToolResultMessage>();
  /** Rows that are still open when a run stops, to close them. */
  #bashId: string | undefined;
  /** When the current turn started: the user's message, else its first row. */
  #turnStart: number | undefined;
  /** The turn at the end of the rows was closed (`#closeTurn`): a row that joins it opens it again. */
  #closed = false;
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
    return this.#rows.slice();
  }

  /**
   * Replaces everything with a session's messages (`get_messages`).
   * `working`: its run is still going (a session the daemon kept working, opened
   * again) — nothing in it has stopped, and its last turn is not over.
   */
  load(messages: AgentMessage[], working = false) {
    this.#rows = [];
    this.#index.clear();
    this.#live = undefined;
    this.#toolSince.clear();
    this.#pendingResults.clear();
    this.#bashId = undefined;
    this.#turnStart = undefined;
    this.#closed = false;
    this.#failure = undefined;
    for (const message of messages) {
      if (message.role === "user") this.#closeTurn();
      const at = (message as { timestamp?: unknown }).timestamp;
      this.#clock = typeof at === "number" ? at : null;
      this.#append(message);
    }
    if (working) {
      this.#flushResults();
    } else {
      // A call with no recorded result was interrupted; history never shows it as running.
      this.#settle();
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
    const waiting = new Map<string, number[]>();
    const streaming: number[] = [];
    before.forEach((row, at) => {
      const key = signature(row);
      const list = waiting.get(key);
      if (list) list.push(at);
      else waiting.set(key, [at]);
      if ((row.kind === "text" || row.kind === "thinking") && row.streaming) streaming.push(at);
    });
    const taken = new Set(this.#rows.map((row) => row.id));
    // A conversation's order does not change: a pair is looked for after the last one made.
    let from = 0;
    let changed = false;
    this.#rows = this.#rows.map((row) => {
      const list = waiting.get(signature(row));
      while (list?.length && list[0] < from) list.shift();
      let at = list?.shift();
      if (at === undefined && (row.kind === "text" || row.kind === "thinking")) {
        at = streaming.find((index) => {
          const old = before[index];
          if (index < from || old.kind !== row.kind) return false;
          // Nothing written yet begins anything: only the row next in line is taken for it.
          return old.text ? row.text.startsWith(old.text) : index === from;
        });
      }
      if (at === undefined) return row;
      from = at + 1;
      const id = before[at].id;
      if (id === row.id || taken.has(id)) return row;
      taken.delete(row.id);
      taken.add(id);
      changed = true;
      return { ...row, id };
    });
    if (!changed) return;
    this.#index.clear();
    this.#rows.forEach((row, at) => this.#index.set(row.id, at));
    this.version++;
  }

  /** Applies a session event. */
  apply(event: SessionEvent) {
    switch (event.type) {
      case "message_start":
        if (event.message.role === "assistant") {
          this.#live = { key: `m${++seq}`, toolIds: new Map(), toolJson: new Map(), thinkingSince: new Map(), argsAt: new Map() };
        } else if (event.message.role === "user") {
          this.#closeTurn();
          this.#append(event.message);
        }
        break;
      case "message_update":
        this.#update(event.assistantMessageEvent);
        break;
      case "message_end":
        if (event.message.role === "assistant") this.#finish(event.message);
        else if (event.message.role !== "user") this.#append(event.message);
        break;
      case "tool_execution_start":
        if (!this.#toolSince.has(event.toolCallId)) this.#toolSince.set(event.toolCallId, Date.now());
        this.#tool(event.toolCallId, (row) => ({ ...row, name: event.toolName, args: event.args ?? row.args, status: "running" }), event.toolName);
        break;
      case "tool_execution_update":
        if (!this.#toolSince.has(event.toolCallId)) this.#toolSince.set(event.toolCallId, Date.now());
        this.#tool(event.toolCallId, (row) => ({ ...row, ...this.#result(event.partialResult, row), status: "running" }), event.toolName);
        break;
      case "tool_execution_end": {
        const started = this.#toolSince.get(event.toolCallId);
        this.#toolSince.delete(event.toolCallId);
        const measured = started !== undefined ? Math.max(0, Date.now() - started) : undefined;
        this.#tool(
          event.toolCallId,
          (row) => ({
            ...row,
            ...this.#result(event.result, row),
            status: event.isError ? "error" : "done",
            durationMs: event.durationMs ?? row.durationMs ?? measured,
          }),
          event.toolName,
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
        this.#settle();
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

  /** Adds a summary divider row (such as a Portable Context Handoff or multi-agent synthesis). */
  summary(title: string, text = "") {
    this.#push({ kind: "summary", id: this.#id("handoff"), title, text });
    this.version++;
  }

  /** Prepends historical rows (for example, keeping visible conversation rows across a harness switch). */
  seedRows(previous: readonly Row[]) {
    this.#rows = [];
    this.#index.clear();
    for (const row of previous) this.#push(row);
    this.version++;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  #id(prefix: string) {
    return `${prefix}${++seq}`;
  }

  /** The time as the transcript reads it: now, or while loading, the message's (`undefined` when it has none). */
  #now() {
    return this.#clock === undefined ? Date.now() : (this.#clock ?? undefined);
  }

  #push(row: Row) {
    if (isTurnRow(row)) {
      if (row.t0 === undefined) row = { ...row, t0: this.#turnStart ?? this.#now() };
      // A closed turn that a row joins goes on: it is not over, and how long it took is not known yet.
      if (this.#closed) this.#stampTurn(undefined);
    }
    this.#closed = false;
    this.#index.set(row.id, this.#rows.length);
    this.#rows.push(row);
  }

  /** Writes how long the turn at the end of the rows took on its first row; `undefined` takes it back. */
  #stampTurn(turnMs: number | undefined) {
    let first = this.#rows.length;
    while (first > 0 && isTurnRow(this.#rows[first - 1])) first--;
    const row = this.#rows[first];
    if (row && isTurnRow(row) && row.turnMs !== turnMs) this.#rows[first] = { ...row, turnMs };
  }

  #set(row: Row) {
    const at = this.#index.get(row.id);
    if (at === undefined) return this.#push(row);
    // What a row learned about its turn outlives the changes that replace it.
    const before = this.#rows[at];
    if (isTurnRow(row) && isTurnRow(before)) {
      row = { ...row, t0: row.t0 ?? before.t0, turnMs: row.turnMs ?? before.turnMs };
      if (row.kind === "text" && before.kind === "text" && row.final === undefined && before.final) row = { ...row, final: true };
    }
    this.#rows[at] = row;
  }

  /** The turn at the end of the rows is over: its first row keeps how long it took. */
  #closeTurn() {
    let first = this.#rows.length;
    while (first > 0 && isTurnRow(this.#rows[first - 1])) first--;
    const row = this.#rows[first];
    const now = this.#now();
    if (row && isTurnRow(row) && row.turnMs === undefined && row.t0 !== undefined && now !== undefined) {
      this.#rows[first] = { ...row, turnMs: Math.max(0, now - row.t0) };
    }
    this.#closed = row !== undefined && isTurnRow(row);
    this.#turnStart = undefined;
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

  #tool(id: string, change: (row: ToolRow) => ToolRow, name: string) {
    const row = this.#get(id);
    const base: ToolRow = row?.kind === "tool" ? row : { kind: "tool", id, name, args: {}, status: "queued", output: "", images: 0 };
    this.#set(change(base));
  }

  #result(result: ToolResult | undefined, row: ToolRow) {
    if (!result) return {};
    return { output: textOf(result.content) || row.output, images: imagesOf(result.content), details: result.details ?? row.details };
  }

  /** One content block's progress in the live assistant message. */
  #update(event: AssistantMessageEvent) {
    const live = this.#live;
    if (!live || !("contentIndex" in event)) return;
    const id = `${live.key}.${event.contentIndex}`;
    switch (event.type) {
      case "text_start":
        this.#set({ kind: "text", id, text: "", streaming: true });
        break;
      case "text_delta": {
        const row = this.#get(id);
        this.#set({ kind: "text", id, text: (row?.kind === "text" ? row.text : "") + event.delta, streaming: true });
        break;
      }
      case "text_end":
        this.#set({ kind: "text", id, text: event.content, streaming: false });
        break;
      case "thinking_start":
        live.thinkingSince.set(event.contentIndex, Date.now());
        this.#set({ kind: "thinking", id, text: "", streaming: true, redacted: false });
        break;
      case "thinking_delta": {
        const row = this.#get(id);
        this.#set({ kind: "thinking", id, text: (row?.kind === "thinking" ? row.text : "") + event.delta, streaming: true, redacted: false });
        break;
      }
      case "thinking_end": {
        const since = live.thinkingSince.get(event.contentIndex);
        this.#set({ kind: "thinking", id, text: event.content, streaming: false, redacted: false, durationMs: since ? Date.now() - since : undefined });
        break;
      }
      case "toolcall_start":
        live.toolIds.set(event.contentIndex, event.id);
        live.toolJson.set(event.contentIndex, "");
        this.#set({ kind: "tool", id: event.id, name: event.toolName, args: {}, status: "call", output: "", images: 0 });
        break;
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
          this.#set({ ...row, args: partialArgs(json) });
        }
        break;
      }
      case "toolcall_end": {
        const row = this.#get(event.toolCall.id);
        const base: ToolRow = row?.kind === "tool" ? row : { kind: "tool", id: event.toolCall.id, name: event.toolCall.name, args: {}, status: "queued", output: "", images: 0 };
        this.#set({ ...base, name: event.toolCall.name, args: event.toolCall.arguments ?? {}, status: base.status === "call" ? "queued" : base.status });
        break;
      }
    }
  }

  /** The authoritative message replaces what was reconstructed from deltas, row by row. */
  #finish(message: AssistantMessage) {
    const live = this.#live ?? { key: `m${++seq}`, toolIds: new Map(), toolJson: new Map(), thinkingSince: new Map(), argsAt: new Map() };
    this.#live = undefined;
    this.#blocks(message, live.key, true);
    // The answer is in: the turn took this long, whatever the provider still cleans up.
    // (A message that failed is no answer yet: a retry goes on in the same turn.)
    if (answeredTurn(message)) this.#closeTurn();
  }

  #blocks(message: AssistantMessage, key: string, keepRuns: boolean) {
    // A later assistant message is the attempt made again: it answers for the one that failed before it.
    this.#failure = undefined;
    const failed = message.stopReason === "error";
    // A message that calls no tools ends the turn: its prose is the answer. A
    // turn held in one message (the bridge's play of ACP harnesses) answers
    // with the prose after its last step — the same trailing run of texts
    // `#settle` marks when the live run ends. Not one that failed: what it left
    // becomes the answer only if the failure stands (`#reportFailure`).
    const hasTools = message.content.some((block) => block.type === "toolCall");
    const lastStep = message.content.reduce((at, block, index) => (block.type === "text" ? at : index), -1);
    const final = (index: number) => !failed && (hasTools ? message.stopReason !== "toolUse" && index > lastStep : true);
    message.content.forEach((block, index) => {
      const id = `${key}.${index}`;
      if (block.type === "text") {
        if (block.text.trim()) this.#set({ kind: "text", id, text: block.text, streaming: false, final: final(index) });
      } else if (block.type === "thinking") {
        const before = this.#get(id);
        if (block.thinking.trim() || block.redacted) {
          this.#set({ kind: "thinking", id, text: block.thinking, streaming: false, redacted: !!block.redacted, durationMs: before?.kind === "thinking" ? before.durationMs : undefined });
        }
      } else if (block.type === "toolCall") {
        const before = this.#get(block.id);
        const base: ToolRow = before?.kind === "tool" ? before : { kind: "tool", id: block.id, name: block.name, args: {}, status: "queued", output: "", images: 0 };
        // A call the failed message never got to run will not run: it does not go on spinning through the retries.
        if (failed && (base.status === "call" || base.status === "queued")) {
          this.#set({ ...base, name: block.name, args: block.arguments ?? {}, status: "error", output: base.output || this.#tr("Stopped before it finished.", "完成前已停止。") });
        } else {
          this.#set({ ...base, name: block.name, args: block.arguments ?? {}, status: keepRuns && base.status !== "call" ? base.status : "queued" });
        }
        // A result read ahead of its call lands on the row now that the call is known.
        const pending = this.#pendingResults.get(block.id);
        if (pending) {
          this.#pendingResults.delete(block.id);
          this.#tool(block.id, (row) => this.#applyToolResult(row, pending), pending.toolName);
        }
      }
    });
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
    this.#push({ kind: "notice", id: this.#id("notice"), tone: "error", title: this.#tr("The model returned an error", "模型返回了错误"), text });
  }

  /** A tool's result applied to its call's row: its output, images and outcome. */
  #applyToolResult(row: ToolRow, message: ToolResultMessage): ToolRow {
    return {
      ...row,
      output: textOf(message.content) || row.output,
      images: imagesOf(message.content),
      details: message.details ?? row.details,
      status: message.isError ? "error" : "done",
    };
  }

  /** Results still waiting on their call missed it once the transcript moves on: they land where the wait ended. */
  #flushResults() {
    if (!this.#pendingResults.size) return;
    for (const message of this.#pendingResults.values()) {
      this.#tool(message.toolCallId, (row) => this.#applyToolResult(row, message), message.toolName);
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
        const text = withoutImageNotes(textOf(message.content));
        const images = imagesOf(message.content);
        const deliveries = images ? undefined : pippiDeliveries(text);
        if (deliveries) {
          for (const item of deliveries) this.#push({ kind: "delivery", id: this.#id("d"), ...item });
        } else if (text || images) {
          this.#push({ kind: "user", id: this.#id("u"), text, images });
        }
        this.#turnStart = this.#now();
        break;
      }
      case "assistant":
        this.#blocks(message, `m${++seq}`, false);
        break;
      case "toolResult":
        // A result whose call has a row joins it; one read ahead of it waits for the block.
        if (this.#get(message.toolCallId)?.kind === "tool") this.#tool(message.toolCallId, (row) => this.#applyToolResult(row, message), message.toolName);
        else this.#pendingResults.set(message.toolCallId, message);
        break;
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
  #settle() {
    this.#live = undefined;
    this.#toolSince.clear();
    this.#flushResults();
    // Prose a stopped run left at the end is as much of an answer as there will
    // be — prose a message already classified keeps the place it was given.
    let tail = this.#rows.length;
    while (tail > 0 && this.#rows[tail - 1].kind === "text") tail--;
    this.#rows = this.#rows.map((row, at) => {
      if (row.kind === "text" && at >= tail && row.final === undefined) return { ...row, streaming: false, final: true };
      if ((row.kind === "text" || row.kind === "thinking") && row.streaming) return { ...row, streaming: false };
      if (row.kind === "tool" && (row.status === "call" || row.status === "queued" || row.status === "running"))
        return { ...row, status: "error" as const, output: row.output || this.#tr("Stopped before it finished.", "完成前已停止。") };
      return row;
    });
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
