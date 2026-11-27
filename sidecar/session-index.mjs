// One parse per session file, shared by `list-sessions.mjs` and
// `usage-stats.mjs`, cached on disk so a boot scans only what changed:
//
//   const index = await loadIndex();
//   const entry = await indexEntry(index, path);   // stat -> cache or scan
//   await saveIndex(index);
//
// Each entry carries the list view (title, counts, times) AND the usage
// contribution (tokens, cost, models, daily) of one file, keyed by
// (size, mtimeMs) — append or rewrite re-scans, untouched files are free.
// The index lives at `<agent-dir>/pipi-session-index.json` next to the
// external-session store pipi already owns there.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { agentDirPath } from "./env-paths.mjs";

const INDEX_VERSION = 2;

export function indexPath() {
  return path.join(agentDirPath(), "pipi-session-index.json");
}

const clip = (text) => (text.length > 240 ? `${text.slice(0, 240)}…` : text);

// What Pi appends to a prompt for the model about its images (`withoutImageNotes` in
// `pi/transcript.ts`): a blank line, then a note per image. A title is the person's words.
const IMAGE_NOTE_FOR_MODEL =
  /^\[Image(?:: original \d+x\d+, displayed at \d+x\d+\. Multiply coordinates by [\d.]+ to map to original image\.| converted from \S+ to \S+\.)\]$/;
const IMAGE_NOTE_OMITTED = /^\[Image omitted: [^\]]*\]$/;

function withoutImageNotes(text) {
  const at = text.lastIndexOf("\n\n");
  if (at < 0) return text;
  const notes = text.slice(at + 2).split("\n");
  if (!notes.every((line) => IMAGE_NOTE_FOR_MODEL.test(line) || IMAGE_NOTE_OMITTED.test(line))) return text;
  return text.slice(0, at);
}

// A document that rode on a prompt comes after the person's words, in a block that names its
// file (`lib/doc-wire.ts`). A title is the words; a prompt that was only documents is titled by
// what the first one says. Read loosely, so a text already clipped or run onto one line is too.
const DOC_BLOCK = /(?:^|\s)<(?:document|selection) path="[^"]*">[\s\S]*$/;
const ATTACHMENT_LINE = /^<attachment\s+[^>]*\bpath="([^"\n]*)"[^>]*\/>$/;

function stripTrailingAttachments(text) {
  const trimmed = text.replace(/\s+$/, "");
  if (!trimmed.includes("<attachment ")) return { said: text };
  const parseLines = (tail) => {
    const lines = tail.split("\n");
    const paths = [];
    for (const line of lines) {
      const hit = ATTACHMENT_LINE.exec(line);
      if (!hit) return undefined;
      paths.push(hit[1]);
    }
    return paths.length ? paths : undefined;
  };
  if (trimmed.startsWith("<attachment ")) {
    const paths = parseLines(trimmed);
    if (paths) return { said: "", first: path.basename(paths[0]) };
  }
  const marker = "\n\n<attachment ";
  let at = trimmed.lastIndexOf(marker);
  while (at >= 0) {
    const paths = parseLines(trimmed.slice(at + 2));
    if (paths) return { said: trimmed.slice(0, at), first: path.basename(paths[0]) };
    at = trimmed.lastIndexOf(marker, at - 1);
  }
  return { said: text };
}

// Fixed protocol wrappers pipi prepends or wraps around a prompt. They are
// addressing/context for the agent, never the words a session is titled by.
// The app side keeps the same reading in `lib/doc-wire.ts`.
const PERSONA_WRAPPER = /^<pipi-persona\b[^>]*>[\s\S]*?<\/pipi-persona>\s*/;
const HANDOFF_WRAPPER = /^<conversation_handoff\b[^>]*>[\s\S]*?<\/conversation_handoff>\s*(?:User message:\n)?/;
const PIPI_MESSAGE_WRAPPER = /<pipi-message\b[^>]*>([\s\S]*?)<\/pipi-message>/g;
const PIPI_MESSAGE_OPEN = /^\s*<pipi-message\b[^>]*>\s*/;
const PIPI_MESSAGE_CLOSE = /\s*<\/pipi-message>\s*$/;
const PIPI_MESSAGE_TRUNCATED = /^\s*<pipi-message\b[^>]*$/;
const DOC_EDITOR_CONTEXT = /^<doc_editor_context\b[^>]*>[\s\S]*?<\/doc_editor_context>\s*/;
const DOC_EDITOR_CONTEXT_TRAILING = /\s*<doc_editor_context\b[^>]*>[\s\S]*?<\/doc_editor_context>\s*$/;
const PIPI_REPLY_WRAPPER = /^\s*<pipi-reply\b[^>]*>[\s\S]*?<\/pipi-reply>\s*/;

function withoutProtocolShells(text) {
  let out = text;
  for (let round = 0; round < 4; round++) {
    const before = out;
    out = out.replace(PERSONA_WRAPPER, "");
    out = out.replace(HANDOFF_WRAPPER, "");
    out = out.replace(PIPI_REPLY_WRAPPER, "");
    out = out.replace(PIPI_MESSAGE_WRAPPER, (_tag, body) => body.trim());
    // An old index or external header may already have clipped the envelope
    // before its closing tag: still drop the protocol head and keep what body
    // survived rather than titling the session `<pipi-message from="…"`.
    out = out.replace(PIPI_MESSAGE_OPEN, "").replace(PIPI_MESSAGE_CLOSE, "");
    if (PIPI_MESSAGE_TRUNCATED.test(out)) out = "";
    out = out.replace(DOC_EDITOR_CONTEXT, "").replace(DOC_EDITOR_CONTEXT_TRAILING, "");
    if (out === before) break;
  }
  return out;
}

export function titleWords(text) {
  if (typeof text !== "string") return text;
  text = withoutProtocolShells(text);
  const { said: withoutAttach, first } = stripTrailingAttachments(text);
  const target = withoutAttach.trim() ? withoutAttach : first ?? text;
  if (!target.includes(' path="')) return target;
  const said = target.replace(DOC_BLOCK, "").trim();
  if (said) return said;
  return target.replace(/^\s*<(?:document|selection) path="[^"]*">\s*/, "").replace(/\s*<\/(?:document|selection)>[\s\S]*$/, "");
}

// The personal agent's fresh conversations open with its persona (`withPersona` in
// `sidecar/pipi-daemon.mjs`); the person's words follow it.
const PERSONA_PREFIX = /^<pipi-persona\b[^>]*>[\s\S]*?<\/pipi-persona>\n\n/;

function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return titleWords(content.replace(PERSONA_PREFIX, ""));
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string") return titleWords(withoutImageNotes(block.text.replace(PERSONA_PREFIX, "")));
    }
  }
  return "";
}

const totalOf = (usage) => Number(usage?.totalTokens ?? usage?.total) || 0;

const ZERO = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });

function addUsage(tokens, usage) {
  if (!usage || typeof usage !== "object") return 0;
  tokens.input += Number(usage.input) || 0;
  tokens.output += Number(usage.output) || 0;
  tokens.cacheRead += Number(usage.cacheRead) || 0;
  tokens.cacheWrite += Number(usage.cacheWrite) || 0;
  tokens.total += Number(usage.totalTokens ?? usage.total) || 0;
  return Number(usage.cost?.total) || 0;
}

/** Local YYYY-MM-DD for bucketing — the Usage page is read in the machine's timezone. */
function dayKey(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return undefined;
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function entryMs(entry) {
  const stamp = entry.timestamp ?? entry.message?.timestamp;
  if (typeof stamp === "number") return stamp;
  const ms = Date.parse(stamp || "");
  return Number.isNaN(ms) ? 0 : ms;
}

function blankEntry() {
  return {
    kind: "other",
    id: undefined,
    agent: undefined,
    name: undefined,
    firstMessage: "",
    messageCount: 0,
    created: 0,
    modified: 0,
    counted: false,
    user: 0,
    assistant: 0,
    toolCalls: 0,
    tokens: ZERO(),
    cost: 0,
    unpriced: 0,
    models: {},
    daily: {},
  };
}

/**
 * Reads one `*.jsonl` into the shared entry: `kind` `"pi"` / `"external"` /
 * `"other"`. The usage fields fold the file's own lines only — the caller
 * merges them across files. Returns `undefined` when the file cannot be read
 * at all (not cached — a transient failure re-tries next run).
 */
export async function scanSessionFile(full, stat) {
  let raw;
  try {
    raw = await fsp.readFile(full, "utf8");
  } catch {
    return undefined;
  }
  const entry = blankEntry();
  entry.size = stat.size;
  entry.mtimeMs = stat.mtimeMs;
  const lines = raw.split("\n").filter(Boolean);
  if (!lines.length) return entry;
  let header;
  try {
    header = JSON.parse(lines[0]);
  } catch {
    return entry;
  }
  const isPi = header?.type === "session";
  const isExternal = header?.type === "pipi_external_session";
  if (!isPi && !isExternal) return entry;

  entry.kind = isPi ? "pi" : "external";
  entry.agent = isPi ? "pi" : header.agentId || header.driver || undefined;
  entry.id = header.id || path.basename(full, ".jsonl").replace(/\.pipi-agent$/, "");
  // Before version 2 an external session's messages carried a running total, not their own usage.
  const unread = isExternal && (typeof header.version === "number" ? header.version : 1) < 2;

  if (isPi) {
    entry.created = Date.parse(header.timestamp || "") || stat.birthtimeMs || Date.now();
    entry.modified = Date.parse(header.timestamp || "") || 0;
    entry.firstMessage = "";
  } else {
    entry.created = header.created || Date.now();
    entry.modified = 0;
    entry.name = header.name;
    entry.firstMessage = clip(titleWords(String(header.firstMessage ?? "")));
  }

  for (const line of lines.slice(1)) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    // The list view: name, first message, message count, and the conversation's
    // last-message time (`modified` — not the file's mtime, which non-message
    // rewrites also advance).
    if (isPi) {
      if (record.type === "session_info" && record.name) entry.name = record.name;
      if (record.type === "message") {
        entry.messageCount++;
        if (!entry.firstMessage && record.message?.role === "user") entry.firstMessage = clip(messageText(record.message));
        const at = Date.parse(record.timestamp || "");
        if (at > entry.modified) entry.modified = at;
      }
    } else {
      const at = record?.type === "message" ? record.message?.timestamp : undefined;
      if (typeof at === "number" && at > entry.modified) entry.modified = at;
    }
    // The usage view, exactly `usage-stats.mjs`'s fold.
    const day = dayKey(entryMs(record));
    const touchRecord = (usage, provider, model) => {
      if (!usage || typeof usage !== "object" || unread) return;
      entry.counted = true;
      const cost = addUsage(entry.tokens, usage);
      entry.cost += cost;
      entry.unpriced += usage.unpriced ? totalOf(usage) : 0;
      const named = Array.isArray(usage.models) ? usage.models.filter((part) => part && typeof part.model === "string" && part.model) : [];
      const parts = named.length
        ? named.map((part) => ({ model: part.model, usage: { ...part, cost: { total: Number(part.cost) || 0 } } }))
        : [{ model, usage }];
      for (const part of parts) {
        if (!totalOf(part.usage) && !part.usage.cost?.total) continue;
        const key = provider && part.model ? `${provider}·${part.model}` : "·unknown";
        const bucket = entry.models[key] ?? { provider: provider || "", model: part.model || "", tokens: ZERO(), cost: 0, unpriced: 0, messages: 0 };
        entry.models[key] = bucket;
        bucket.cost += addUsage(bucket.tokens, part.usage);
        if (usage.unpriced) bucket.unpriced += totalOf(part.usage);
        bucket.messages++;
      }
      if (day) {
        const d = entry.daily[day] ?? { tokens: 0, cost: 0 };
        entry.daily[day] = d;
        d.tokens += totalOf(usage);
        d.cost += cost;
      }
    };
    switch (record.type) {
      case "message": {
        const message = record.message;
        if (message?.role === "user") {
          entry.user++;
          entry.counted = true;
        } else if (message?.role === "assistant") {
          entry.assistant++;
          touchRecord(message.usage, message.provider, message.model);
          entry.toolCalls += Array.isArray(message.content) ? message.content.filter((b) => b?.type === "toolCall").length : 0;
        } else if (message?.role === "toolResult" && message.usage) {
          touchRecord(message.usage, message.provider, message.model);
        }
        break;
      }
      case "usage":
      case "compaction":
      case "branch_summary":
        touchRecord(record.usage, record.provider, record.model);
        break;
    }
  }

  if (isExternal) entry.messageCount = Math.max(0, lines.length - 1);
  if (isPi) entry.modified = Math.round(entry.modified) || entry.created;
  else entry.modified = Math.round(entry.modified) || header.modified || header.created || Date.now();
  return entry;
}

/** The index on disk: `{version, files: {path: entry}}`. */
export async function loadIndex() {
  try {
    const parsed = JSON.parse(await fsp.readFile(indexPath(), "utf8"));
    if (parsed?.version === INDEX_VERSION && parsed.files && typeof parsed.files === "object") {
      return { files: parsed.files, dirty: false };
    }
  } catch {}
  return { files: {}, dirty: false };
}

/**
 * The entry for `full`: from cache when (size, mtimeMs) still match, else a
 * fresh scan recorded into `index` (and `index.dirty` set).
 */
export async function indexEntry(index, full) {
  const stat = await fsp.stat(full).catch(() => undefined);
  if (!stat || !stat.isFile()) return undefined;
  const hit = index.files[full];
  if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) return hit;
  const entry = await scanSessionFile(full, stat);
  if (!entry) return undefined;
  index.files[full] = entry;
  index.dirty = true;
  return entry;
}

/**
 * Persists the index, merging over whatever is on disk now — two helpers run
 * at once at boot, and each keeps the other's fresh entries. Entries whose
 * file no longer exists are pruned. No-op when nothing was scanned.
 */
export async function saveIndex(index) {
  if (!index.dirty) return;
  let merged = {};
  try {
    const parsed = JSON.parse(await fsp.readFile(indexPath(), "utf8"));
    if (parsed?.version === INDEX_VERSION && parsed.files && typeof parsed.files === "object") merged = parsed.files;
  } catch {}
  for (const [file, entry] of Object.entries(index.files)) {
    const cur = merged[file];
    if (!cur || Number(entry.mtimeMs) >= Number(cur.mtimeMs)) merged[file] = entry;
  }
  for (const file of Object.keys(merged)) {
    if (!fs.existsSync(file)) delete merged[file];
  }
  const target = indexPath();
  const tmp = `${target}.tmp.${process.pid}`;
  try {
    await fsp.writeFile(tmp, JSON.stringify({ version: INDEX_VERSION, files: merged }), { mode: 0o600 });
    await fsp.rename(tmp, target);
  } catch {}
}
