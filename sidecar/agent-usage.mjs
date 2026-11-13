// What each engine says a turn cost, read into one tally and written in Pi's
// `usage` shape (`docs/pi/session-format.md`), so `usage-stats.mjs` and the
// session stats read every engine the same way.
//
// A tally keeps the four token kinds apart, the way Pi does: `input` is what
// was sent uncached, `cacheRead` / `cacheWrite` what went through the cache,
// `output` what came back (reasoning included). Only what the engine reported
// is counted — nothing is estimated from the conversation's text, and a cost
// is a cost the engine named (`priced`), never one worked out from a price list.
//
// Where the figures come from, each checked against the engine's own output:
// - Claude Code: the `result` record's `modelUsage`, the session's running
//   total per model (resumes included) — a turn is the growth since the last
//   one; a run cut short has only its `assistant` records.
// - Codex: `turn.completed.usage`, the thread's running total (resumes
//   included) — a turn is the growth since the last one.
// - OpenCode: `step_finish` parts, one per model request.
// - Cursor: the `result` record's `usage`.
// - ACP: `session/prompt`'s `usage` for the turn; Devin instead reports each
//   model request in `usage_update._meta`. `usage_update.cost` is the
//   session's running cost.

const num = (value) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
const int = (value) => Math.trunc(num(value));
const KINDS = ["input", "output", "cacheRead", "cacheWrite"];

export function tally(model = "") {
  return { model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, priced: false };
}

export const tokensOf = (part) => part.input + part.output + part.cacheRead + part.cacheWrite;

/** Nothing reported: no tokens, and no cost named either. */
export const isBlank = (part) => tokensOf(part) === 0 && part.cost === 0 && !part.priced;

export function addInto(into, part) {
  for (const kind of KINDS) into[kind] += part[kind];
  into.cost += part.cost;
  into.priced = into.priced || part.priced;
  return into;
}

export const ZERO_USAGE = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }),
});

/**
 * Parts of one turn as a Pi `usage` object. Two things Pi's own lacks:
 * `unpriced` when tokens were reported without a cost, and `models` when the
 * engine named the models that did the work (the message's own `model` is the
 * one picked in pipi, often just "default").
 */
export function toUsage(parts) {
  const byModel = new Map();
  const total = tally();
  for (const part of parts) {
    if (!part || isBlank(part)) continue;
    addInto(total, part);
    addInto(byModel.get(part.model) ?? byModel.set(part.model, tally(part.model)).get(part.model), part);
  }
  const totalTokens = tokensOf(total);
  if (totalTokens === 0 && total.cost === 0) return ZERO_USAGE;
  const usage = {
    input: total.input,
    output: total.output,
    cacheRead: total.cacheRead,
    cacheWrite: total.cacheWrite,
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: total.cost },
  };
  if (!total.priced) usage.unpriced = true;
  const named = [...byModel.values()].filter((part) => part.model);
  if (named.length) {
    usage.models = named.map((part) => ({
      model: part.model,
      input: part.input,
      output: part.output,
      cacheRead: part.cacheRead,
      cacheWrite: part.cacheWrite,
      totalTokens: tokensOf(part),
      cost: part.cost,
    }));
  }
  return usage;
}

/** A saved `usage` object back as a tally. */
export function fromUsage(usage) {
  const part = tally();
  if (!usage || typeof usage !== "object") return part;
  for (const kind of KINDS) part[kind] = int(usage[kind]);
  part.cost = num(usage.cost?.total);
  part.priced = !usage.unpriced && (tokensOf(part) > 0 || part.cost > 0);
  return part;
}

/**
 * Session files written before usage was read per turn (header `version` 1)
 * stamped every assistant message with a running total that left the cache out
 * and counted a Claude message once per content block. None of it can be stood
 * behind, so none of it is counted.
 */
export function dropLegacyUsage(messages) {
  for (const message of messages) {
    if (message?.role === "assistant" && message.usage) message.usage = ZERO_USAGE;
  }
  return messages;
}

/** The growth of a running total since `before`; a total that went down started over. */
function growth(now, before, keys) {
  const grew = !!before && keys.every((key) => now[key] >= num(before[key]));
  return Object.fromEntries(keys.map((key) => [key, grew ? now[key] - num(before[key]) : now[key]]));
}

// ── Claude Code ─────────────────────────────────────────────────────────────

const CLAUDE_KEYS = ["input", "output", "cacheRead", "cacheWrite", "cost"];

/**
 * A `result` record's usage. `modelUsage` and `total_cost_usd` run on for the
 * life of the session — a `--resume`d process starts from where the last one
 * ended — so `seen` holds what earlier results already counted, and is updated
 * to measure the next against. Subagents and the small model Claude Code runs
 * on the side are in it, each under its own name.
 */
export function claudeResultParts(rec, seen = {}) {
  const parts = [];
  const models = rec?.modelUsage && typeof rec.modelUsage === "object" ? Object.entries(rec.modelUsage) : [];
  for (const [model, used] of models) {
    if (!used || typeof used !== "object") continue;
    const now = {
      input: int(used.inputTokens),
      output: int(used.outputTokens),
      cacheRead: int(used.cacheReadInputTokens),
      cacheWrite: int(used.cacheCreationInputTokens),
      cost: num(used.costUSD),
    };
    const part = Object.assign(tally(model), growth(now, seen[model], CLAUDE_KEYS), { priced: typeof used.costUSD === "number" });
    seen[model] = now;
    if (tokensOf(part) > 0 || part.cost > 0) parts.push(part);
  }
  if (parts.length || models.length) return parts;
  // A CLI too old for `modelUsage`: the record's own usage, and the process's running cost.
  const used = rec?.usage;
  const part = tally();
  if (used && typeof used === "object") {
    part.input = int(used.input_tokens);
    part.output = int(used.output_tokens);
    part.cacheRead = int(used.cache_read_input_tokens);
    part.cacheWrite = int(used.cache_creation_input_tokens);
  }
  if (typeof rec?.total_cost_usd === "number") {
    const now = { cost: num(rec.total_cost_usd) };
    part.cost = growth(now, seen["*"], ["cost"]).cost;
    part.priced = true;
    seen["*"] = now;
  }
  return isBlank(part) ? [] : [part];
}

/**
 * One `assistant` record's usage. Claude Code writes a record per content block
 * and repeats the message's whole usage on each: key by `id`, keep the last.
 */
export function claudeAssistantSample(rec) {
  const message = rec?.message;
  const used = message?.usage;
  if (!used || typeof used !== "object" || typeof message.id !== "string" || !message.id) return undefined;
  const model = typeof message.model === "string" && message.model !== "<synthetic>" ? message.model : "";
  return Object.assign(tally(model), {
    id: message.id,
    input: int(used.input_tokens),
    output: int(used.output_tokens),
    cacheRead: int(used.cache_read_input_tokens),
    cacheWrite: int(used.cache_creation_input_tokens),
  });
}

// ── Codex ───────────────────────────────────────────────────────────────────

const CODEX_KEYS = ["input", "cached", "output"];

/**
 * `turn.completed.usage` is the thread's total so far, a resumed thread's
 * earlier turns included, and `input_tokens` counts the cached ones. Returns the
 * turn's own share and the total to measure the next turn against. Codex names
 * no cost.
 */
export function codexTurnPart(usage, before) {
  if (!usage || typeof usage !== "object") return undefined;
  const total = { input: int(usage.input_tokens), cached: int(usage.cached_input_tokens), output: int(usage.output_tokens) };
  const turn = growth(total, before, CODEX_KEYS);
  const part = tally();
  part.cacheRead = Math.min(turn.cached, turn.input);
  part.input = turn.input - part.cacheRead;
  part.output = turn.output;
  return { part, total };
}

// ── OpenCode ────────────────────────────────────────────────────────────────

/** A `step_finish` part: one model request, cache and reasoning counted apart from input and output. */
export function openCodeStepPart(step) {
  const tokens = step?.tokens;
  if (!tokens || typeof tokens !== "object") return undefined;
  const part = tally();
  part.input = int(tokens.input);
  part.output = int(tokens.output) + int(tokens.reasoning);
  part.cacheRead = int(tokens.cache?.read);
  part.cacheWrite = int(tokens.cache?.write);
  if (typeof step.cost === "number") {
    part.cost = num(step.cost);
    part.priced = true;
  }
  return part;
}

// ── Cursor ──────────────────────────────────────────────────────────────────

/** The `result` record's `usage`: cached tokens are counted apart from `inputTokens`. No cost. */
export function cursorResultPart(rec) {
  const used = rec?.usage;
  if (!used || typeof used !== "object") return undefined;
  const part = tally(typeof rec.model === "string" ? rec.model : typeof rec.model?.id === "string" ? rec.model.id : "");
  part.input = int(used.inputTokens ?? used.input_tokens);
  part.output = int(used.outputTokens ?? used.output_tokens);
  part.cacheRead = int(used.cacheReadTokens ?? used.cache_read_input_tokens);
  part.cacheWrite = int(used.cacheWriteTokens ?? used.cache_creation_input_tokens);
  return part;
}

// ── ACP ─────────────────────────────────────────────────────────────────────

/**
 * `session/prompt`'s `usage` for the turn. The protocol leaves open whether
 * `inputTokens` counts the cached ones; `totalTokens` settles it (Devin's total
 * is input + output, Antigravity's adds the cache on top). Without a total,
 * a cache larger than the input cannot be inside it.
 */
export function acpPromptPart(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const input = int(usage.inputTokens);
  const output = int(usage.outputTokens);
  const read = int(usage.cachedReadTokens);
  const write = int(usage.cachedWriteTokens);
  const thought = int(usage.thoughtTokens);
  const total = int(usage.totalTokens);
  const cached = read + write;
  const inside = total > 0 ? total < input + output + cached : cached <= input;
  const part = tally();
  part.cacheRead = inside ? Math.min(read, input) : read;
  part.cacheWrite = inside ? Math.min(write, input - part.cacheRead) : write;
  part.input = inside ? input - part.cacheRead - part.cacheWrite : input;
  // Reasoning is part of the output unless the total shows it was left out.
  part.output = output + (thought > 0 && total === input + output + (inside ? 0 : cached) + thought ? thought : 0);
  return part;
}

/**
 * One model request as Devin reports it, in a `usage_update`'s `_meta`
 * (`<vendor>/inputTokens`, `/outputTokens`, `/cachedReadTokens`; the input
 * counts the cached). `sig` tells a repeat: each update is sent twice.
 */
export function acpMetaSample(meta) {
  if (!meta || typeof meta !== "object") return undefined;
  const read = { inputTokens: undefined, outputTokens: undefined, cachedReadTokens: undefined, cachedWriteTokens: undefined };
  for (const [key, value] of Object.entries(meta)) {
    const slash = key.lastIndexOf("/");
    if (slash <= 0) continue;
    const name = key.slice(slash + 1);
    if (name in read && typeof value === "number") read[name] = value;
  }
  if (read.inputTokens === undefined && read.outputTokens === undefined) return undefined;
  const input = int(read.inputTokens);
  const part = tally();
  part.cacheRead = Math.min(int(read.cachedReadTokens), input);
  part.cacheWrite = Math.min(int(read.cachedWriteTokens), input - part.cacheRead);
  part.input = input - part.cacheRead - part.cacheWrite;
  part.output = int(read.outputTokens);
  part.sig = `${input}:${part.output}:${part.cacheRead}:${part.cacheWrite}`;
  return part;
}

/**
 * `usage_update.cost` is the session's cost so far. Returns what was added
 * since `before` and the amount to measure against next. Only dollars are
 * counted: the totals have one currency.
 */
export function acpCostPart(cost, before) {
  if (!cost || typeof cost !== "object" || typeof cost.amount !== "number" || !Number.isFinite(cost.amount)) return undefined;
  if (typeof cost.currency === "string" && cost.currency && cost.currency.toUpperCase() !== "USD") return undefined;
  const total = { cost: num(cost.amount) };
  const part = tally();
  part.cost = growth(total, before, ["cost"]).cost;
  part.priced = true;
  return { part, total };
}
