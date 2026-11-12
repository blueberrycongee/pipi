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

function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string") return block.text;
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
  if (stat && stat.mtimeMs > modified) modified = stat.mtimeMs;
  return {
    path: full,
    id: header.id || path.basename(full, ".jsonl"),
    name,
    firstMessage: clip(firstMessage),
    messageCount,
    created: Date.parse(header.timestamp || "") || stat?.birthtimeMs || Date.now(),
    modified: Math.round(modified) || Date.now(),
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
        mappedExt.push({
          path: full,
          id: header.id || path.basename(file, ".pipi-agent.jsonl"),
          name: header.name,
          firstMessage: clip(header.firstMessage ?? ""),
          messageCount: Math.max(0, lines.length - 1),
          created: header.created || Date.now(),
          modified: header.modified || Date.now(),
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
