// Aggregates token usage and cost across EVERY saved session on this machine —
// Pi sessions under `<agent-dir>/sessions/--<cwd>--/` and external agent sessions
// under `<agent-dir>/pipi-external-sessions/<slug-hash>/` — as JSON on stdout:
//
//   node sidecar/usage-stats.mjs -> UsageStats
//
// Session files are read in the documented format (`docs/pi/session-format.md`):
// assistant `message` entries carry `usage` + `cost`, `usage` entries record
// model-attributed work that left no message (cache warming), and `compaction` /
// `branch_summary` entries carry the usage of their summarizing call.
//
// External sessions are written in the same format by `external-agent.mjs`, from
// what each engine reports (`agent-usage.mjs`), with two additions on `usage`:
// `unpriced` (tokens the engine named no cost for) and `models` (the models that
// did the work, when the engine names them). Nothing here is estimated: an agent
// that reports nothing has sessions and no figures, and `unpriced` tokens are in
// no cost.
//
// The per-file fold is `session-index.mjs`'s — each file's contribution is
// cached by (size, mtimeMs), so a rescan only reads sessions written since the
// last run instead of every byte of history.
import fsp from "node:fs/promises";
import path from "node:path";
import { agentDirPath } from "./env-paths.mjs";
import { indexEntry, loadIndex, saveIndex } from "./session-index.mjs";

const ZERO = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });

function addTokens(tokens, add) {
  tokens.input += add.input;
  tokens.output += add.output;
  tokens.cacheRead += add.cacheRead;
  tokens.cacheWrite += add.cacheWrite;
  tokens.total += add.total;
}

function blankBucket() {
  return { tokens: ZERO(), cost: 0, unpriced: 0, messages: 0, sessions: 0 };
}

/**
 * Folds one file's cached contribution into the totals — the same merge the old
 * full scan did, including its order: an uncounted file drops its owner's bucket
 * when nothing counted for it yet.
 */
function applyContribution(c, into) {
  const owner = c.agent ?? "external";
  const agent = into.agents.get(owner) ?? blankBucket();
  into.agents.set(owner, agent);
  into.total.userMessages += c.user;
  into.total.assistantMessages += c.assistant;
  into.total.toolCalls += c.toolCalls;
  agent.messages += c.user + c.assistant;
  addTokens(into.total.tokens, c.tokens);
  into.total.cost += c.cost;
  into.total.unpriced += c.unpriced;
  addTokens(agent.tokens, c.tokens);
  agent.cost += c.cost;
  agent.unpriced += c.unpriced;
  for (const [key, part] of Object.entries(c.models)) {
    const bucket = into.models.get(key) ?? { provider: part.provider, model: part.model, tokens: ZERO(), cost: 0, unpriced: 0, messages: 0 };
    into.models.set(key, bucket);
    addTokens(bucket.tokens, part.tokens);
    bucket.cost += part.cost;
    bucket.unpriced += part.unpriced;
    bucket.messages += part.messages;
  }
  for (const [day, d] of Object.entries(c.daily)) {
    const bucket = into.daily.get(day) ?? { day, tokens: 0, cost: 0 };
    into.daily.set(day, bucket);
    bucket.tokens += d.tokens;
    bucket.cost += d.cost;
  }
  if (!c.counted) {
    if (!agent.sessions) into.agents.delete(owner);
    return false;
  }
  agent.sessions++;
  return true;
}

async function* sessionFiles() {
  // Both bases hold one directory per working directory; when
  // `PI_CODING_AGENT_SESSION_DIR` is set the two bases are the same directory,
  // so the seen-set also dedupes that case. Any `*.jsonl` file can be either a
  // Pi session or an external one — the header decides, not the suffix.
  const seen = new Set();
  const bases = [
    process.env.PI_CODING_AGENT_SESSION_DIR || path.join(agentDirPath(), "sessions"),
    process.env.PI_CODING_AGENT_SESSION_DIR || path.join(agentDirPath(), "pipi-external-sessions"),
  ];
  for (const base of bases) {
    let entries;
    try {
      entries = await fsp.readdir(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(base, entry.name);
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        if (!seen.has(full)) yield (seen.add(full), full);
        continue;
      }
      if (!entry.isDirectory()) continue;
      let files;
      try {
        files = await fsp.readdir(full);
      } catch {
        continue;
      }
      for (const file of files) {
        const candidate = path.join(full, file);
        if (file.endsWith(".jsonl") && !seen.has(candidate)) yield (seen.add(candidate), candidate);
      }
    }
  }
}

const index = await loadIndex();
const into = {
  total: { tokens: ZERO(), cost: 0, unpriced: 0, userMessages: 0, assistantMessages: 0, toolCalls: 0 },
  agents: new Map(),
  models: new Map(),
  daily: new Map(),
};

let sessions = 0;
for await (const file of sessionFiles()) {
  const entry = await indexEntry(index, file);
  if (entry && entry.kind !== "other" && applyContribution(entry, into)) sessions++;
}
await saveIndex(index);

const sortByCost = (a, b) => b.cost - a.cost || b.tokens.total - a.tokens.total;
process.stdout.write(
  JSON.stringify({
    scannedAt: Date.now(),
    totals: { ...into.total.tokens, cost: into.total.cost, unpriced: into.total.unpriced, userMessages: into.total.userMessages, assistantMessages: into.total.assistantMessages, toolCalls: into.total.toolCalls, sessions },
    agents: [...into.agents.entries()]
      .map(([agentId, a]) => ({ agentId, sessions: a.sessions, messages: a.messages, tokens: a.tokens, cost: a.cost, unpriced: a.unpriced }))
      .sort(sortByCost),
    models: [...into.models.values()].sort(sortByCost),
    daily: [...into.daily.values()].sort((a, b) => a.day.localeCompare(b.day)),
  }),
);
