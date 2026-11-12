// Lists both Pi sessions AND external coding agent sessions (`*.pipi-agent.jsonl`)
// for one or more working directories as JSON on stdout:
//
//   node sidecar/list-sessions.mjs <cwd>             -> SessionSummary[]
//   node sidecar/list-sessions.mjs <cwd1> <cwd2> ... -> Record<string, SessionSummary[]>
//
// Pi sessions are read straight from `<agent-dir>/sessions/--<cwd>--/*.jsonl` in the
// documented format (`docs/pi/session-format.md`) — no Pi install required.
import fsp from "node:fs/promises";
import path from "node:path";
import { agentDirPath, externalSessionsDir } from "./env-paths.mjs";

const clip = (text) => (text.length > 240 ? `${text.slice(0, 240)}…` : text);

// `~/.pi/agent/sessions/--<path>--/` — leading separators removed, `/`, `\`, `:` become `-`.
function piSessionsDir(cwd) {
  const base = process.env.PI_CODING_AGENT_SESSION_DIR || path.join(agentDirPath(), "sessions");
  const encoded = path.resolve(cwd).replace(/^[\\/]+/, "").replace(/[\\/:]/g, "-");
  return path.join(base, `--${encoded}--`);
}

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

function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string") return withoutImageNotes(block.text);
    }
  }
  return "";
}

/** Reads one Pi session `.jsonl` into the SessionSummary shape the sidebar lists. */
async function readPiSession(full) {
  const raw = await fsp.readFile(full, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  if (!lines.length) return undefined;
  const header = JSON.parse(lines[0]);
  if (header?.type !== "session") return undefined;
  let name;
  let firstMessage = "";
  let messageCount = 0;
  // `modified` is the last message's time — not the file's mtime: non-message
  // entries (session_info renames, model/thinking changes, compactions, labels,
  // extension `custom`/`usage` records, v1→v3 migration rewrites) rewrite the
  // file without advancing the conversation, and must not re-rank the sidebar.
  let modified = Date.parse(header.timestamp || "") || 0;
  for (const line of lines.slice(1)) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === "session_info" && entry.name) name = entry.name;
    if (entry.type !== "message") continue;
    messageCount++;
    if (!firstMessage && entry.message?.role === "user") firstMessage = messageText(entry.message);
    const at = Date.parse(entry.timestamp || "");
    if (at > modified) modified = at;
  }
  const stat = await fsp.stat(full).catch(() => undefined);
  const created = Date.parse(header.timestamp || "") || stat?.birthtimeMs || Date.now();
  return {
    path: full,
    id: header.id || path.basename(full, ".jsonl"),
    name,
    firstMessage: clip(firstMessage),
    messageCount,
    created,
    modified: Math.round(modified) || created,
    agentId: "pi",
  };
}

async function listOne(cwd) {
  const mappedPi = [];
  try {
    const files = await fsp.readdir(piSessionsDir(cwd));
    await Promise.all(
      files
        .filter((file) => file.endsWith(".jsonl"))
        .map(async (file) => {
          try {
            const summary = await readPiSession(path.join(piSessionsDir(cwd), file));
            if (summary) mappedPi.push(summary);
          } catch {}
        }),
    );
  } catch {}

  const extDir = externalSessionsDir(cwd);
  const mappedExt = [];
  try {
    const files = await fsp.readdir(extDir);
    for (const file of files) {
      if (!file.endsWith(".pipi-agent.jsonl")) continue;
      const full = path.join(extDir, file);
      try {
        const raw = await fsp.readFile(full, "utf8");
        const lines = raw.split("\n").filter(Boolean);
        if (!lines.length) continue;
        const header = JSON.parse(lines[0]);
        if (header.type !== "pipi_external_session") continue;
        // As with Pi sessions: `modified` follows the last message, not the last
        // file write — `header.modified` advances on header-only saves (e.g.
        // `set_session_name`) that add nothing to the conversation.
        let modified = 0;
        for (const line of lines.slice(1)) {
          try {
            const entry = JSON.parse(line);
            const at = entry?.type === "message" ? entry.message?.timestamp : undefined;
            if (typeof at === "number" && at > modified) modified = at;
          } catch {}
        }
        mappedExt.push({
          path: full,
          id: header.id || path.basename(file, ".pipi-agent.jsonl"),
          name: header.name,
          firstMessage: clip(header.firstMessage ?? ""),
          messageCount: Math.max(0, lines.length - 1),
          created: header.created || Date.now(),
          modified: Math.round(modified) || header.modified || header.created || Date.now(),
          agentId: header.agentId || header.driver || "claude",
        });
      } catch {}
    }
  } catch {}

  return [...mappedPi, ...mappedExt].sort((a, b) => b.modified - a.modified);
}

const cwds = process.argv.slice(2);
if (cwds.length <= 1) {
  const cwd = cwds[0] ?? process.cwd();
  process.stdout.write(JSON.stringify(await listOne(cwd)));
} else {
  const entries = await Promise.all(cwds.map(async (cwd) => [cwd, await listOne(cwd)]));
  process.stdout.write(JSON.stringify(Object.fromEntries(entries)));
}
