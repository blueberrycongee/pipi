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

const INDEX_VERSION = 1;

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

export function titleWords(text) {
  if (typeof text !== "string" || !text.includes(' path="')) return text;
  const said = text.replace(DOC_BLOCK, "").trim();
  if (said) return said;
  return text.replace(/^\s*<(?:document|selection) path="[^"]*">\s*/, "").replace(/\s*<\/(?:document|selection)>[\s\S]*$/, "");
}

function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return titleWords(content);
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string") return titleWords(withoutImageNotes(block.text));
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
    entry.firstMessage = clip(header.firstMessage ?? "");
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
