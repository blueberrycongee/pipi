import { expect, test } from "nsh/test";
import { defaultAgentStatuses, resolveRuntimeMode } from "./catalog";
import { buildPortableHandoff, prependHandoffToPrompt, utf8ByteLength } from "./handoff";
import {
  createTranslatorState,
  finalizeTurn,
  normalizeToolName,
  translateAcpSessionUpdate,
  translateClaudeStreamRecord,
  translateCodexExecRecord,
} from "./normalizer";
import { Transcript, type Row } from "../pi/transcript";

test("enforces non-escalating runtime permission ceiling on delegated sub-agents", () => {
  expect(resolveRuntimeMode("full-access", "inherit")).toBe("full-access");
  expect(resolveRuntimeMode("auto-accept-edits", undefined)).toBe("auto-accept-edits");
  expect(resolveRuntimeMode("full-access", "approval-required")).toBe("approval-required");

  // Clamps inherited mode to the highest mode supported by target agent (e.g. Cursor supports approval-required & full-access)
  expect(resolveRuntimeMode("auto-accept-edits", "inherit", ["approval-required", "full-access"])).toBe("approval-required");

  // Rejects explicit escalation above parent ceiling
  expect(() => resolveRuntimeMode("approval-required", "full-access")).toThrow();
  expect(() => resolveRuntimeMode("auto-accept-edits", "full-access")).toThrow();
});

test("lists custom ACP agents alongside the built-ins", () => {
  const list = defaultAgentStatuses([
    { id: "acp-goose", name: "Goose ACP", driver: "acp", command: "goose", args: ["acp"], defaultModel: "goose-v1" },
  ]);
  expect(list.some((a) => a.id === "claude")).toBe(true);
  expect(list.some((a) => a.id === "codex")).toBe(true);
  const custom = list.find((a) => a.id === "acp-goose");
  expect(custom?.available).toBe(true);
  expect(custom?.models[0]?.id).toBe("goose-v1");
});

test("budgets portable context handoffs by priority and omits private thinking", () => {
  expect(utf8ByteLength("hello")).toBe(5);
  expect(utf8ByteLength("中文")).toBe(6);

  const rows: Row[] = [
    { kind: "user", id: "r1", text: "Original goal: build multi-agent orchestration", images: 1 },
    { kind: "thinking", id: "r2", text: "Secret internal chain of thought", streaming: false, redacted: false },
    { kind: "text", id: "r3", text: "Middle filler ".repeat(200), streaming: false },
    { kind: "tool", id: "r4", name: "read", args: { path: "store/app.ts" }, output: "export function boot() {}", images: 0, status: "done" },
    { kind: "user", id: "r5", text: "Latest user question: switch to Claude Code and add tests", images: 0 },
    { kind: "text", id: "r6", text: "Latest assistant answer: ready to switch.", streaming: false },
  ];

  // Tight budget (~1.3 KB) keeps priority items (latest user, latest assistant, original user) and drops large middle filler
  const handoff = buildPortableHandoff({
    rows,
    fromAgentName: "Pi",
    toAgentName: "Claude Code",
    budgetBytes: 1400,
  });

  expect(handoff.formattedContext).toContain('<conversation_handoff from="Pi" to="Claude Code">');
  expect(handoff.formattedContext).toContain("Latest user question: switch to Claude Code and add tests");
  expect(handoff.formattedContext).toContain("Latest assistant answer: ready to switch.");
  expect(handoff.formattedContext).toContain("Original goal: build multi-agent orchestration");
  expect(handoff.formattedContext).not.toContain("Secret internal chain of thought");
  expect(handoff.omittedCount).toBeGreaterThan(0);

  const wire = prependHandoffToPrompt(handoff.formattedContext, "Now implement the reviewer step.");
  expect(wire.endsWith("User message:\nNow implement the reviewer step.")).toBe(true);
});

test("normalizes Claude Code stream-json events into Transcript rows", () => {
  const state = createTranslatorState("claude-code", "claude-sonnet-4-6");
  const transcript = new Transcript();
  const feed = (record: Record<string, unknown>) => {
    for (const ev of translateClaudeStreamRecord(state, record)) transcript.apply(ev);
  };

  feed({ type: "system", subtype: "init", session_id: "claude-sess-42" });
  feed({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "Inspecting repo..." } } });
  feed({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Checking files." } } });
  feed({
    type: "assistant",
    message: {
      model: "claude-sonnet-4-6",
      content: [{ type: "tool_use", id: "toolu_1", name: "mcp__pipi__delegate_task", input: { agent: "codex", task: "Run tests" } }],
    },
  });
  feed({
    type: "user",
    message: {
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "Codex passed all tests", is_error: false }],
    },
  });
  feed({ type: "result", is_error: false, total_cost_usd: 0.012 });
  transcript.apply({ type: "agent_settled", aborted: false });

  expect(state.sessionId).toBe("claude-sess-42");
  expect(normalizeToolName("mcp__pipi__delegate_task")).toBe("delegate_task");
  expect(transcript.rows().map((r) => r.kind)).toEqual(["thinking", "text", "tool"]);
  expect(transcript.rows()[2]).toMatchObject({
    kind: "tool",
    name: "delegate_task",
    output: "Codex passed all tests",
    status: "done",
  });
});

test("normalizes Codex exec --json and ACP session/update streams into Transcript rows", () => {
  const codexState = createTranslatorState("codex", "gpt-5.3-codex");
  const codexTranscript = new Transcript();
  const feedCodex = (record: Record<string, unknown>) => {
    for (const ev of translateCodexExecRecord(codexState, record)) codexTranscript.apply(ev);
  };

  feedCodex({ type: "thread.started", thread_id: "th_99" });
  feedCodex({ type: "turn.started" });
  feedCodex({ type: "item.completed", item: { id: "rs_1", type: "reasoning", text: "Planning patch" } });
  feedCodex({ type: "item.started", item: { id: "cmd_1", type: "command_execution", command: "npm test" } });
  feedCodex({ type: "item.completed", item: { id: "cmd_1", type: "command_execution", command: "npm test", aggregated_output: "ok", exit_code: 0 } });
  feedCodex({ type: "item.completed", item: { id: "msg_1", type: "agent_message", text: "All green." } });
  feedCodex({ type: "turn.completed", usage: { input_tokens: 500, output_tokens: 80 } });
  codexTranscript.apply({ type: "agent_settled", aborted: false });

  expect(codexState.sessionId).toBe("th_99");
  expect(codexTranscript.rows().map((r) => r.kind)).toEqual(["thinking", "tool", "text"]);
  expect(codexTranscript.rows()[1]).toMatchObject({ kind: "tool", name: "bash", output: "ok", status: "done" });

  // ACP session/update stream
  const acpState = createTranslatorState("acp-custom", "default");
  const acpTranscript = new Transcript();
  for (const ev of translateAcpSessionUpdate(acpState, { sessionUpdate: "agent_thought_chunk", content: { text: "ACP thinking" } })) {
    acpTranscript.apply(ev);
  }
  for (const ev of translateAcpSessionUpdate(acpState, { sessionUpdate: "tool_call", toolCallId: "tc_1", kind: "Read", rawInput: { path: "README.md" } })) {
    acpTranscript.apply(ev);
  }
  for (const ev of translateAcpSessionUpdate(acpState, { sessionUpdate: "tool_call_update", toolCallId: "tc_1", status: "completed", rawOutput: "# pipi" })) {
    acpTranscript.apply(ev);
  }
  for (const ev of translateAcpSessionUpdate(acpState, { sessionUpdate: "agent_message_chunk", content: { text: "Read complete." } })) {
    acpTranscript.apply(ev);
  }
  const endEvents: Parameters<Transcript["apply"]>[0][] = [];
  finalizeTurn(acpState, "stop", endEvents);
  for (const ev of endEvents) acpTranscript.apply(ev);
  acpTranscript.apply({ type: "agent_settled", aborted: false });

  expect(acpTranscript.rows().map((r) => r.kind)).toEqual(["thinking", "tool", "text"]);
  expect(acpTranscript.rows()[1]).toMatchObject({ kind: "tool", name: "read", output: "# pipi", status: "done" });
});
