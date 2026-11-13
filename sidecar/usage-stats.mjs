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
import fsp from "node:fs/promises";
import path from "node:path";
import { agentDirPath } from "./env-paths.mjs";

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

/** Local YYYY-MM-DD for bucketing — the page is read in the machine's timezone. */
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

function blankBucket() {
  return { tokens: ZERO(), cost: 0, unpriced: 0, messages: 0, sessions: 0 };
}

const totalOf = (usage) => Number(usage?.totalTokens ?? usage?.total) || 0;

/** Fold one session file into the totals. Returns false when it isn't a session. */
function scanSession(raw, agentId, into) {
  const lines = raw.split("\n").filter(Boolean);
  if (!lines.length) return false;
  let header;
  try {
    header = JSON.parse(lines[0]);
  } catch {
    return false;
  }
  const isPi = header?.type === "session";
  const isExternal = header?.type === "pipi_external_session";
  if (!isPi && !isExternal) return false;
  const owner = isExternal ? header.agentId || header.driver || "external" : agentId;
  // Before version 2 an external session's messages carried a running total, not their own usage.
  const unread = isExternal && (header.version ?? 1) < 2;

  const agent = into.agents.get(owner) ?? blankBucket();
  into.agents.set(owner, agent);
  let counted = false;

  for (const line of lines.slice(1)) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const day = dayKey(entryMs(entry));
    const touch = (usage, provider, model) => {
      if (!usage || typeof usage !== "object" || unread) return;
      counted = true;
      const cost = addUsage(into.total.tokens, usage);
      const unpriced = usage.unpriced ? totalOf(usage) : 0;
      into.total.cost += cost;
      into.total.unpriced += unpriced;
      addUsage(agent.tokens, usage);
      agent.cost += cost;
      agent.unpriced += unpriced;
      // The models the engine named, else the one on the message. Nothing at all is not a model.
      const named = Array.isArray(usage.models) ? usage.models.filter((part) => part && typeof part.model === "string" && part.model) : [];
      const parts = named.length ? named.map((part) => ({ model: part.model, usage: { ...part, cost: { total: Number(part.cost) || 0 } } })) : [{ model, usage }];
      for (const part of parts) {
        if (!totalOf(part.usage) && !part.usage.cost?.total) continue;
        const key = provider && part.model ? `${provider}·${part.model}` : "·unknown";
        const bucket = into.models.get(key) ?? { provider: provider || "", model: part.model || "", tokens: ZERO(), cost: 0, unpriced: 0, messages: 0 };
        into.models.set(key, bucket);
        bucket.cost += addUsage(bucket.tokens, part.usage);
        if (usage.unpriced) bucket.unpriced += totalOf(part.usage);
        bucket.messages++;
      }
      if (day) {
        const d = into.daily.get(day) ?? { day, tokens: 0, cost: 0 };
        into.daily.set(day, d);
        d.tokens += totalOf(usage);
        d.cost += cost;
      }
    };

    switch (entry.type) {
      case "message": {
        const message = entry.message;
        if (message?.role === "user") {
          into.total.userMessages++;
          agent.messages++;
          counted = true;
        } else if (message?.role === "assistant") {
          into.total.assistantMessages++;
          agent.messages++;
          touch(message.usage, message.provider, message.model);
          const calls = Array.isArray(message.content) ? message.content.filter((b) => b?.type === "toolCall").length : 0;
          into.total.toolCalls += calls;
        } else if (message?.role === "toolResult" && message.usage) {
          touch(message.usage, message.provider, message.model);
        }
        break;
      }
      case "usage":
        touch(entry.usage, entry.provider, entry.model);
        break;
      case "compaction":
      case "branch_summary":
        touch(entry.usage, entry.provider, entry.model);
        break;
    }
  }
  if (!counted) {
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

const into = {
  total: { tokens: ZERO(), cost: 0, unpriced: 0, userMessages: 0, assistantMessages: 0, toolCalls: 0 },
  agents: new Map(),
  models: new Map(),
  daily: new Map(),
};

let sessions = 0;
for await (const file of sessionFiles()) {
  try {
    if (scanSession(await fsp.readFile(file, "utf8"), "pi", into)) sessions++;
  } catch {}
}

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
