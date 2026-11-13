// What each engine reports, read into Pi's `usage` shape. The payloads are the
// engines' own, captured from real runs (Claude Code 2.1, Devin and Antigravity
// over ACP) or taken from their documented record shapes (Codex, OpenCode, Cursor).
import assert from "node:assert/strict";
import test from "node:test";
import {
  ZERO_USAGE,
  acpCostPart,
  acpMetaSample,
  acpPromptPart,
  claudeAssistantSample,
  claudeResultParts,
  codexTurnPart,
  cursorResultPart,
  dropLegacyUsage,
  fromUsage,
  openCodeStepPart,
  tally,
  toUsage,
} from "./agent-usage.mjs";

const kinds = (part) => ({ input: part.input, output: part.output, cacheRead: part.cacheRead, cacheWrite: part.cacheWrite });

const CLAUDE_RESULT = {
  type: "result",
  usage: { input_tokens: 2, cache_creation_input_tokens: 14591, cache_read_input_tokens: 0, output_tokens: 4 },
  modelUsage: {
    "claude-fable-5-2": { inputTokens: 2, outputTokens: 4, cacheReadInputTokens: 0, cacheCreationInputTokens: 14591, costUSD: 0.146086, contextWindow: 1000000 },
  },
  total_cost_usd: 0.146086,
};

test("Claude Code: a result's modelUsage is the turn, with the cost Claude named", () => {
  const seen = {};
  const parts = claudeResultParts(CLAUDE_RESULT, seen);
  assert.equal(parts.length, 1);
  assert.deepEqual(kinds(parts[0]), { input: 2, output: 4, cacheRead: 0, cacheWrite: 14591 });
  assert.equal(parts[0].model, "claude-fable-5-2");
  assert.equal(parts[0].cost, 0.146086);
  assert.equal(parts[0].priced, true);

  const usage = toUsage(parts);
  assert.equal(usage.totalTokens, 14597);
  assert.equal(usage.cost.total, 0.146086);
  assert.equal(usage.unpriced, undefined);
  assert.deepEqual(usage.models, [{ model: "claude-fable-5-2", input: 2, output: 4, cacheRead: 0, cacheWrite: 14591, totalTokens: 14597, cost: 0.146086 }]);
});

test("Claude Code: modelUsage is the session's running total — a resumed turn counts only its growth", () => {
  const seen = {};
  claudeResultParts(
    { modelUsage: { "claude-fable-5-2": { inputTokens: 2, outputTokens: 3, cacheReadInputTokens: 0, cacheCreationInputTokens: 14588, costUSD: 0.146016 } }, total_cost_usd: 0.146016 },
    seen,
  );
  // The same session, resumed in a new process (`claude --resume`), as it reported its second turn.
  const resumed = {
    usage: { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 14291, cache_creation_input_tokens: 318 },
    modelUsage: {
      "claude-fable-5-2": { inputTokens: 4, outputTokens: 6, cacheReadInputTokens: 14291, cacheCreationInputTokens: 14906, costUSD: 0.1521902 },
      "claude-haiku-4-5": { inputTokens: 300, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.0004 },
    },
    total_cost_usd: 0.1525902,
  };
  const parts = claudeResultParts(resumed, seen);
  assert.deepEqual(kinds(parts[0]), { input: 2, output: 3, cacheRead: 14291, cacheWrite: 318 });
  assert.ok(Math.abs(parts[0].cost - 0.0061742) < 1e-9);
  assert.deepEqual(kinds(parts[1]), { input: 300, output: 20, cacheRead: 0, cacheWrite: 0 });
  assert.equal(parts[1].model, "claude-haiku-4-5");
  // The same result seen again adds nothing.
  assert.deepEqual(claudeResultParts(resumed, seen), []);
});

test("Claude Code: an assistant record repeats its message's usage per content block — keyed by id", () => {
  const record = {
    type: "assistant",
    message: { id: "msg_011C", model: "claude-fable-5-2", usage: { input_tokens: 2, cache_creation_input_tokens: 14591, cache_read_input_tokens: 0, output_tokens: 4 } },
  };
  const sample = claudeAssistantSample(record);
  assert.equal(sample.id, "msg_011C");
  assert.deepEqual(kinds(sample), { input: 2, output: 4, cacheRead: 0, cacheWrite: 14591 });
  assert.equal(sample.priced, false);
  assert.equal(claudeAssistantSample({ type: "assistant", message: { content: [] } }), undefined);
});

test("Codex: turn.completed is the thread's running total, cached tokens inside input", () => {
  const first = codexTurnPart({ input_tokens: 12000, cached_input_tokens: 9000, output_tokens: 300, reasoning_output_tokens: 120 }, { input: 0, cached: 0, output: 0 });
  assert.deepEqual(kinds(first.part), { input: 3000, output: 300, cacheRead: 9000, cacheWrite: 0 });
  assert.equal(first.part.priced, false);
  const second = codexTurnPart({ input_tokens: 26000, cached_input_tokens: 21000, output_tokens: 450 }, first.total);
  assert.deepEqual(kinds(second.part), { input: 2000, output: 150, cacheRead: 12000, cacheWrite: 0 });
  // A total that went down is a thread that started over: the whole of it is the turn.
  const restarted = codexTurnPart({ input_tokens: 500, cached_input_tokens: 0, output_tokens: 20 }, second.total);
  assert.deepEqual(kinds(restarted.part), { input: 500, output: 20, cacheRead: 0, cacheWrite: 0 });
  assert.equal(codexTurnPart(undefined, first.total), undefined);
});

test("OpenCode: a step_finish part is one model request, with its cost", () => {
  const part = openCodeStepPart({ type: "step-finish", cost: 0.0123, tokens: { input: 900, output: 80, reasoning: 40, cache: { read: 7000, write: 150 } } });
  assert.deepEqual(kinds(part), { input: 900, output: 120, cacheRead: 7000, cacheWrite: 150 });
  assert.equal(part.cost, 0.0123);
  assert.equal(part.priced, true);
  assert.equal(openCodeStepPart({ type: "step-finish" }), undefined);
});

test("Cursor: the result record's usage, no cost", () => {
  const part = cursorResultPart({ type: "result", usage: { inputTokens: 1200, outputTokens: 60, cacheReadTokens: 5000, cacheWriteTokens: 30 } });
  assert.deepEqual(kinds(part), { input: 1200, output: 60, cacheRead: 5000, cacheWrite: 30 });
  assert.equal(part.priced, false);
  assert.equal(cursorResultPart({ type: "result" }), undefined);
});

test("ACP: Devin's prompt usage counts the cache inside the input", () => {
  const part = acpPromptPart({ totalTokens: 11295, inputTokens: 11263, outputTokens: 32, cachedReadTokens: 9792 });
  assert.deepEqual(kinds(part), { input: 1471, output: 32, cacheRead: 9792, cacheWrite: 0 });
});

test("ACP: Antigravity's prompt usage counts the cache on top of the input", () => {
  const part = acpPromptPart({ inputTokens: 12678, outputTokens: 193, cachedReadTokens: 12547, cachedWriteTokens: 0, thoughtTokens: 104, totalTokens: 25418 });
  assert.deepEqual(kinds(part), { input: 12678, output: 193, cacheRead: 12547, cacheWrite: 0 });
  // A cache larger than the input cannot be inside it, total or not.
  const small = acpPromptPart({ inputTokens: 2138, outputTokens: 13, cachedReadTokens: 6526 });
  assert.deepEqual(kinds(small), { input: 2138, output: 13, cacheRead: 6526, cacheWrite: 0 });
});

test("ACP: Devin reports each model request in usage_update._meta, twice over", () => {
  const first = acpMetaSample({ "cognition.ai/inputTokens": 11263, "cognition.ai/outputTokens": 32, "cognition.ai/cachedReadTokens": 9792 });
  const again = acpMetaSample({
    "cognition.ai/inputTokens": 11263,
    "cognition.ai/outputTokens": 32,
    "cognition.ai/cachedReadTokens": 9792,
    "cognition.ai/subagent_context": { parentAgentId: "root" },
  });
  const next = acpMetaSample({ "cognition.ai/inputTokens": 11323, "cognition.ai/outputTokens": 24, "cognition.ai/cachedReadTokens": 11264 });
  assert.deepEqual(kinds(first), { input: 1471, output: 32, cacheRead: 9792, cacheWrite: 0 });
  assert.equal(first.sig, again.sig);
  assert.notEqual(first.sig, next.sig);
  assert.equal(acpMetaSample(undefined), undefined);
  assert.equal(acpMetaSample({ "cognition.ai/subagent_context": {} }), undefined);
});

test("ACP: usage_update.cost is the session's running cost, in dollars", () => {
  const first = acpCostPart({ amount: 0.12, currency: "USD" }, undefined);
  assert.equal(first.part.cost, 0.12);
  assert.equal(first.part.priced, true);
  const second = acpCostPart({ amount: 0.2, currency: "USD" }, first.total);
  assert.ok(Math.abs(second.part.cost - 0.08) < 1e-9);
  assert.equal(acpCostPart({ amount: 3, currency: "EUR" }, undefined), undefined);
  assert.equal(acpCostPart(undefined, undefined), undefined);
});

test("tokens an engine named no cost for are marked unpriced; nothing reported is nothing", () => {
  const part = acpPromptPart({ totalTokens: 11295, inputTokens: 11263, outputTokens: 32, cachedReadTokens: 9792 });
  const usage = toUsage([part]);
  assert.equal(usage.unpriced, true);
  assert.equal(usage.totalTokens, 11295);
  assert.equal(usage.cost.total, 0);
  assert.equal(usage.models, undefined);
  assert.equal(toUsage([]), ZERO_USAGE);
  assert.equal(toUsage([tally(), undefined]), ZERO_USAGE);

  const back = fromUsage(usage);
  assert.deepEqual(kinds(back), kinds(part));
  assert.equal(back.priced, false);
  assert.equal(fromUsage(toUsage(claudeResultParts(CLAUDE_RESULT))).priced, true);
});

test("a session saved before usage was read per turn keeps none of its running totals", () => {
  const messages = [
    { role: "user", content: "hi" },
    { role: "assistant", usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { total: 0 } } },
    { role: "assistant", usage: { input: 240, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 290, cost: { total: 0 } } },
  ];
  dropLegacyUsage(messages);
  assert.equal(messages[1].usage, ZERO_USAGE);
  assert.equal(messages[2].usage, ZERO_USAGE);
});
