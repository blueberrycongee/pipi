// Lists both Pi sessions AND external coding agent sessions (`*.pipi-agent.jsonl`)
// for one or more working directories as JSON on stdout:
//
//   node sidecar/list-sessions.mjs <cwd>             -> SessionSummary[]
//   node sidecar/list-sessions.mjs <cwd1> <cwd2> ... -> Record<string, SessionSummary[]>
//
// Pi sessions are read straight from `<agent-dir>/sessions/--<cwd>--/*.jsonl` in the
// documented format (`docs/pi/session-format.md`) — no Pi install required. The parse
// itself rides on `session-index.mjs`: one pass per file, cached across runs, so only
// sessions that changed since the last list are read at all.
import fsp from "node:fs/promises";
import path from "node:path";
import { agentDirPath, externalSessionsDir } from "./env-paths.mjs";
import { indexEntry, loadIndex, saveIndex } from "./session-index.mjs";

// `~/.pi/agent/sessions/--<path>--/` — leading separators removed, `/`, `\`, `:` become `-`.
function piSessionsDir(cwd) {
  const base = process.env.PI_CODING_AGENT_SESSION_DIR || path.join(agentDirPath(), "sessions");
  const encoded = path.resolve(cwd).replace(/^[\\/]+/, "").replace(/[\\/:]/g, "-");
  return path.join(base, `--${encoded}--`);
}

/** The SessionSummary a scanned index entry reads as, or `undefined` for other kinds/non-session files. */
function summaryOf(full, entry, kind) {
  if (!entry || entry.kind !== kind) return undefined;
  return {
    path: full,
    id: entry.id,
    name: entry.name,
    firstMessage: entry.firstMessage,
    messageCount: entry.messageCount,
    created: entry.created,
    modified: entry.modified,
    agentId: entry.agent ?? (kind === "external" ? "claude" : "pi"),
  };
}

async function listOne(cwd, index) {
  const mappedPi = [];
  try {
    const dir = piSessionsDir(cwd);
    const files = await fsp.readdir(dir);
    await Promise.all(
      files
        .filter((file) => file.endsWith(".jsonl"))
        .map(async (file) => {
          const summary = summaryOf(path.join(dir, file), await indexEntry(index, path.join(dir, file)), "pi");
          if (summary) mappedPi.push(summary);
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
      const summary = summaryOf(full, await indexEntry(index, full), "external");
      if (summary) mappedExt.push(summary);
    }
  } catch {}

  return [...mappedPi, ...mappedExt].sort((a, b) => b.modified - a.modified);
}

const cwds = process.argv.slice(2);
const index = await loadIndex();
if (cwds.length <= 1) {
  const cwd = cwds[0] ?? process.cwd();
  process.stdout.write(JSON.stringify(await listOne(cwd, index)));
} else {
  const entries = await Promise.all(cwds.map(async (cwd) => [cwd, await listOne(cwd, index)]));
  process.stdout.write(JSON.stringify(Object.fromEntries(entries)));
}
await saveIndex(index);
