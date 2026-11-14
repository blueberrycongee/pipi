import { expect, test } from "nsh/test";
import { parseSessionSnapshot } from "./session-file";

// A saved session file is the switch's first look at the destination: what it
// reads is what the chat shows while the engine is still starting. Pi's files
// are a `session` header plus an id/parentId tree of entries; an external
// engine's are a `pipi_external_session` header plus flat `message` records.
// Both split on LF only, and a writer mid-append leaves a torn last line the
// reader must skip, not choke on.

const PI_HEADER = { type: "session", version: 3, id: "s1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/w" };

const user = (id: string, parentId: string | null, text: string, timestamp = "2026-01-01T00:00:01.000Z") =>
  JSON.stringify({ type: "message", id, parentId, timestamp, message: { role: "user", content: [{ type: "text", text }], timestamp: 1735689601000 } });

const assistant = (id: string, parentId: string | null, text: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "message", id, parentId, timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text }], timestamp: "2026-01-01T00:00:02.000Z", ...extra } });

test("a Pi session reads its messages along the active branch, with model and thinking from it", () => {
  const snap = parseSessionSnapshot(
    [
      JSON.stringify(PI_HEADER),
      JSON.stringify({ type: "model_change", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:00.100Z", provider: "anthropic", modelId: "claude-sonnet-4.5" }),
      JSON.stringify({ type: "thinking_level_change", id: "t1", parentId: "m1", timestamp: "2026-01-01T00:00:00.200Z", thinkingLevel: "high" }),
      JSON.stringify({ type: "session_info", id: "i1", parentId: "t1", timestamp: "2026-01-01T00:00:00.300Z", name: "Refactor the reducer" }),
      JSON.stringify({ type: "message", id: "sys", parentId: "i1", timestamp: "2026-01-01T00:00:00.400Z", message: { role: "system", content: "prompt" } }),
      user("u1", "sys", "hello"),
      // A branch nobody followed, appended before the surviving path went on.
      user("u2", "sys", "a stale branch"),
      assistant("a1", "u1", "hi there"),
    ].join("\n"),
  )!;
  expect(snap.kind).toBe("pi");
  expect(snap.id).toBe("s1");
  expect(snap.agentId).toBe("pi");
  expect(snap.cwd).toBe("/w");
  expect(snap.name).toBe("Refactor the reducer");
  expect(snap.model).toEqual({ id: "claude-sonnet-4.5", provider: "anthropic" });
  expect(snap.thinkingLevel).toBe("high");
  expect(snap.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  expect((snap.messages[0] as { content: { text: string }[] }).content[0].text).toBe("hello");
});

test("a Pi message stamped ISO reads as ms, and an entry's own model names it when nothing changed hands", () => {
  const snap = parseSessionSnapshot(
    [JSON.stringify(PI_HEADER), user("u1", null, "hi"), assistant("a1", "u1", "yo", { model: "m-x", provider: "p-y", thinkingLevel: "low" })].join("\n"),
  )!;
  expect((snap.messages[1] as { timestamp: number }).timestamp).toBe(Date.parse("2026-01-01T00:00:02.000Z"));
  expect(snap.model).toEqual({ id: "m-x", provider: "p-y" });
  expect(snap.thinkingLevel).toBe("low");
});

test("an external session reads its header and flat message records", () => {
  const snap = parseSessionSnapshot(
    [
      JSON.stringify({
        type: "pipi_external_session",
        id: "x1",
        agentId: "claude",
        driver: "claude",
        cwd: "/w",
        name: "Notes",
        model: { id: "claude-opus", provider: "anthropic" },
        thinkingLevel: "medium",
        context: { tokens: 1200, window: 200000 },
      }),
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "look" }], timestamp: "2026-01-01T00:00:01.000Z" } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }),
    ].join("\n"),
  )!;
  expect(snap.kind).toBe("external");
  expect(snap.id).toBe("x1");
  expect(snap.agentId).toBe("claude");
  expect(snap.driver).toBe("claude");
  expect(snap.name).toBe("Notes");
  expect(snap.model?.id).toBe("claude-opus");
  expect(snap.thinkingLevel).toBe("medium");
  expect(snap.context).toEqual({ tokens: 1200, window: 200000 });
  expect(snap.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  expect((snap.messages[0] as { timestamp: number }).timestamp).toBe(Date.parse("2026-01-01T00:00:01.000Z"));
});

test("a stale background flag on a saved tool call does not survive the read", () => {
  const snap = parseSessionSnapshot(
    [
      JSON.stringify({ type: "pipi_external_session", agentId: "claude" }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", background: true, arguments: {} }] },
      }),
    ].join("\n"),
  )!;
  const block = (snap.messages[0] as { content: { background?: boolean }[] }).content[0];
  expect(block.background).toBeUndefined();
});

test("CRLF endings parse, U+2028 inside a string is not a break, and a torn tail is skipped", () => {
  const good = [JSON.stringify(PI_HEADER), user("u1", null, "one\u2028two"), assistant("a1", "u1", "fine")];
  const raw = `${good.join("\r\n")}\r\n{"type":"message","id":"cut","paren`;
  const snap = parseSessionSnapshot(raw)!;
  expect(snap.messages).toHaveLength(2);
  expect((snap.messages[0] as { content: { text: string }[] }).content[0].text).toBe("one\u2028two");
});

test("anything unrecognized or empty reads as nothing", () => {
  expect(parseSessionSnapshot("")).toBeUndefined();
  expect(parseSessionSnapshot('{"type":"other"}\n{"type":"message"}')).toBeUndefined();
  expect(parseSessionSnapshot("not json\nstill not")).toBeUndefined();
});
