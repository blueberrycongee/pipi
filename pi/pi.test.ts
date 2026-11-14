import { expect, test } from "nsh/test";
import { PiClient, type Transport } from "./client";
import { createLineSplitter } from "./jsonl";
import { Transcript, toolSummary, withoutImageNotes } from "./transcript";
import { type ActivityRow, buildDisplayRows, classifyTool, describeActivity, displayRowIds, type TurnHeaderRow } from "./turns";

test("splits records on LF only, across chunks, keeping U+2028", () => {
  const lines: string[] = [];
  const splitter = createLineSplitter((line) => lines.push(line));
  splitter.push('{"a":"x\u2028y"}\r\n{"b"');
  splitter.push(':1}\n\n{"c":2}');
  expect(lines).toEqual(['{"a":"x\u2028y"}', '{"b":1}']);
  splitter.push("\n");
  expect(lines).toHaveLength(3);
});

function pipe() {
  const written: string[] = [];
  let out: (chunk: string) => void = () => undefined;
  let exit: (e: { code: number }) => void = () => undefined;
  const transport: Transport = {
    write: (text) => void written.push(text),
    onStdout: (handler) => void (out = handler),
    onStderr: () => undefined,
    onExit: (handler) => void (exit = handler),
    end: () => undefined,
    kill: () => undefined,
  };
  return { transport, written, say: (record: object) => out(`${JSON.stringify(record)}\n`), die: () => exit({ code: 1 }) };
}

test("correlates responses by id, out of order, and rejects failures", async () => {
  const { transport, written, say, die } = pipe();
  const events: string[] = [];
  const client = new PiClient(transport, { onEvent: (event) => events.push(event.type), onUiRequest: () => undefined, onExit: () => undefined });
  const state = client.request("get_state");
  const model = client.request("set_model", { provider: "x", modelId: "y" });
  const ids = written.map((line) => JSON.parse(line).id);
  say({ type: "agent_start" });
  say({ id: ids[1], type: "response", command: "set_model", success: false, error: "Model not found: x/y" });
  say({ id: ids[0], type: "response", command: "get_state", success: true, data: { sessionId: "s" } });
  expect((await state).sessionId).toBe("s");
  await expect(model).rejects.toThrow("Model not found");
  expect(events).toEqual(["agent_start"]);
  const pending = client.request("get_messages");
  die();
  await expect(pending).rejects.toThrow("exited");
});

test("rebuilds a streamed turn into rows and joins tool results to their calls", () => {
  const t = new Transcript();
  const update = (assistantMessageEvent: object) => t.apply({ type: "message_update", assistantMessageEvent } as never);
  t.apply({ type: "message_start", message: { role: "user", content: "hi", timestamp: 1 } });
  t.apply({ type: "message_start", message: { role: "assistant", content: [] } as never });
  update({ type: "thinking_start", contentIndex: 0 });
  update({ type: "thinking_delta", contentIndex: 0, delta: "hm" });
  update({ type: "toolcall_start", contentIndex: 1, id: "c1", toolName: "read" });
  update({ type: "toolcall_delta", contentIndex: 1, delta: '{"path":"src/a' });
  let rows = t.rows();
  expect(rows.map((row) => row.kind)).toEqual(["user", "thinking", "tool"]);
  expect(rows[2]).toMatchObject({ status: "call", args: { path: "src/a" } });
  t.apply({ type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: { path: "src/a.ts" } });
  t.apply({ type: "tool_execution_end", toolCallId: "c1", toolName: "read", result: { content: [{ type: "text", text: "ok" }] }, isError: false });
  rows = t.rows();
  expect(rows[2]).toMatchObject({ status: "done", output: "ok", args: { path: "src/a.ts" } });
  expect(rows).toHaveLength(3);
});

test("a turn's process folds once, when its answer is known, and prose never changes place before", () => {
  const t = new Transcript();
  const update = (assistantMessageEvent: object) => t.apply({ type: "message_update", assistantMessageEvent } as never);
  const shown = () => buildDisplayRows(t.rows(), true).map((row) => row.kind);
  const assistant = (content: object[]) => ({ role: "assistant", content, timestamp: 1 }) as never;
  t.apply({ type: "message_start", message: { role: "user", content: "hi", timestamp: 1 } });

  // A message of prose and two calls: the prose is part of the process, the calls one row.
  t.apply({ type: "message_start", message: assistant([]) });
  update({ type: "text_start", contentIndex: 0 });
  expect(shown()).toEqual(["user", "turn"]); // prose with nothing to read yet takes no row
  update({ type: "text_delta", contentIndex: 0, delta: "Looking." });
  expect(shown()).toEqual(["user", "turn", "text"]);
  update({ type: "toolcall_start", contentIndex: 1, id: "c1", toolName: "read" });
  update({ type: "toolcall_start", contentIndex: 2, id: "c2", toolName: "bash" });
  expect(shown()).toEqual(["user", "turn", "text", "activity"]);
  const calls = [
    { type: "toolCall", id: "c1", name: "read", arguments: {} },
    { type: "toolCall", id: "c2", name: "bash", arguments: {} },
  ];
  t.apply({ type: "message_end", message: assistant([{ type: "text", text: "Looking." }, ...calls]) });
  t.apply({ type: "tool_execution_end", toolCallId: "c1", toolName: "read", result: { content: [] }, isError: false });
  t.apply({ type: "tool_execution_end", toolCallId: "c2", toolName: "bash", result: { content: [] }, isError: false });

  // The last message streams where the earlier prose did; the process stays open under it.
  t.apply({ type: "message_start", message: assistant([]) });
  update({ type: "text_delta", contentIndex: 0, delta: "Done" });
  expect(shown()).toEqual(["user", "turn", "text", "activity", "text"]);
  expect(buildDisplayRows(t.rows(), true)[1]).toMatchObject({ kind: "turn", running: true, open: true });

  // It ends having called nothing: it is the answer, and the process folds under the header.
  t.apply({ type: "message_end", message: assistant([{ type: "text", text: "Done." }]) });
  const rows = buildDisplayRows(t.rows(), true);
  expect(rows.map((row) => row.kind)).toEqual(["user", "turn", "text"]);
  expect(rows[1]).toMatchObject({ kind: "turn", running: false, open: false, hasDetails: true });
  expect(rows[2]).toMatchObject({ kind: "text", text: "Done.", final: true });
  // The reader's toggle shows it again, in order.
  expect(buildDisplayRows(t.rows(), false, { chosen: () => true }).map((row) => row.kind)).toEqual(["user", "turn", "text", "activity", "text"]);
});

test("a turn held in one message (the bridge's play of ACP harnesses) marks its answer final, live and on reload", () => {
  const t = new Transcript();
  const update = (assistantMessageEvent: object) => t.apply({ type: "message_update", assistantMessageEvent } as never);
  // One assistant message holding the whole turn: reasoning, commentary and a
  // call, then the answer — how external agents arrive over `get_messages` too.
  const merged = (answer: string) =>
    ({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Let me look." },
        { type: "text", text: "Checking first." },
        { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
        { type: "thinking", thinking: "Found it." },
        { type: "text", text: answer },
      ],
      stopReason: "stop",
      timestamp: 2,
    }) as never;

  // Live: the process stays open while the turn works; once the message ends,
  // the prose after its last step is the answer and the process folds.
  t.apply({ type: "message_start", message: { role: "user", content: "hi", timestamp: 1 } });
  t.apply({ type: "message_start", message: { role: "assistant", content: [] } as never });
  update({ type: "thinking_start", contentIndex: 0 });
  update({ type: "thinking_end", contentIndex: 0, content: "Let me look." });
  update({ type: "text_start", contentIndex: 1 });
  update({ type: "text_end", contentIndex: 1, content: "Checking first." });
  update({ type: "toolcall_start", contentIndex: 2, id: "c1", toolName: "read" });
  update({ type: "toolcall_end", contentIndex: 2, toolCall: { id: "c1", name: "read", arguments: { path: "a.ts" } } });
  t.apply({ type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: { path: "a.ts" } });
  t.apply({ type: "tool_execution_end", toolCallId: "c1", toolName: "read", result: { content: [{ type: "text", text: "ok" }] }, isError: false });
  update({ type: "thinking_start", contentIndex: 3 });
  update({ type: "thinking_end", contentIndex: 3, content: "Found it." });
  update({ type: "text_start", contentIndex: 4 });
  update({ type: "text_end", contentIndex: 4, content: "The answer." });
  t.apply({ type: "message_end", message: merged("The answer.") });

  expect(t.rows()).toMatchObject([
    { kind: "user" },
    { kind: "thinking" },
    { kind: "text", text: "Checking first." },
    { kind: "tool" },
    { kind: "thinking" },
    { kind: "text", text: "The answer.", final: true },
  ]);
  const projected = buildDisplayRows(t.rows(), false);
  expect(projected.map((row) => row.kind)).toEqual(["user", "turn", "text"]);
  expect(projected[1]).toMatchObject({ open: false, hasDetails: true });

  // Reloaded from `get_messages`: a settled turn before the last one never reopens.
  const t2 = new Transcript();
  t2.load([
    { role: "user", content: "hi", timestamp: 1 },
    { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 2 } as never,
    merged("The answer."),
    { role: "user", content: "next", timestamp: 3 },
    { role: "assistant", content: [{ type: "text", text: "Second answer." }], stopReason: "stop", timestamp: 4 } as never,
  ]);
  const reloaded = buildDisplayRows(t2.rows(), false);
  expect(reloaded.map((row) => row.kind)).toEqual(["user", "turn", "text", "user", "turn", "text"]);
  expect(reloaded.filter((row) => row.kind === "turn")).toMatchObject([{ open: false }, { open: false }]);
});

test("tool results read ahead of the merged message do not scramble its blocks on reload", () => {
  // The bridge writes a turn's tool results as their own messages, ahead of the
  // one assistant message holding every block (calls included). A result waits
  // for its call's row instead of minting one at the head of the turn — or the
  // turn's prose would settle out of order and commentary land in the answer.
  const result = (id: string) =>
    ({ role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text: `out ${id}` }], isError: false, timestamp: 2 }) as never;
  const merged = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "look first" },
      { type: "text", text: "Checking." },
      { type: "toolCall", id: "c1", name: "bash", arguments: {} },
      { type: "thinking", thinking: "more" },
      { type: "text", text: "Between the steps." },
      { type: "toolCall", id: "c2", name: "bash", arguments: {} },
      { type: "text", text: "The answer." },
    ],
    stopReason: "stop",
    timestamp: 3,
  } as never;

  const t = new Transcript();
  t.load([{ role: "user", content: "go", timestamp: 1 } as never, result("c1"), result("c2"), merged]);
  expect(t.rows()).toMatchObject([
    { kind: "user" },
    { kind: "thinking" },
    { kind: "text", text: "Checking." },
    { kind: "tool", id: "c1", status: "done", output: "out c1" },
    { kind: "thinking" },
    { kind: "text", text: "Between the steps." },
    { kind: "tool", id: "c2", status: "done", output: "out c2" },
    { kind: "text", text: "The answer.", final: true },
  ]);
  const projected = buildDisplayRows(t.rows(), false);
  expect(projected.map((row) => row.kind)).toEqual(["user", "turn", "text"]);
  expect(projected[2]).toMatchObject({ kind: "text", text: "The answer.", final: true });

  // A result whose call was never recorded still stands as a row, where the transcript caught up with it.
  const t2 = new Transcript();
  t2.load([
    { role: "user", content: "go", timestamp: 1 } as never,
    result("orphan"),
    { role: "user", content: "next", timestamp: 4 } as never,
  ]);
  expect(t2.rows()).toMatchObject([{ kind: "user" }, { kind: "tool", id: "orphan", status: "done", output: "out orphan" }, { kind: "user" }]);
});

test("groups interleaved reasoning and tool calls between commentary boundaries into one collapsed activity row", () => {
  const t = new Transcript();
  const update = (assistantMessageEvent: object) => t.apply({ type: "message_update", assistantMessageEvent } as never);
  const assistant = (content: object[]) => ({ role: "assistant", content, timestamp: 1 }) as never;

  t.apply({ type: "message_start", message: { role: "user", content: "check selection", timestamp: 1 } });

  // Commentary 1 -> [tool, tool]
  t.apply({ type: "message_start", message: assistant([]) });
  update({ type: "text_delta", contentIndex: 0, delta: "First check recent commits." });
  update({ type: "toolcall_start", contentIndex: 1, id: "c1", toolName: "Run command" });
  update({ type: "toolcall_start", contentIndex: 2, id: "c2", toolName: "Read file" });
  t.apply({
    type: "message_end",
    message: assistant([
      { type: "text", text: "First check recent commits." },
      { type: "toolCall", id: "c1", name: "Run command", arguments: { command: "git show HEAD" } },
      { type: "toolCall", id: "c2", name: "Read file", arguments: { path: "views/Prose.tsx" } },
    ]),
  });
  t.apply({ type: "tool_execution_end", toolCallId: "c1", toolName: "Run command", result: { content: [] }, isError: false, durationMs: 1200 });
  t.apply({ type: "tool_execution_end", toolCallId: "c2", toolName: "Read file", result: { content: [] }, isError: false, durationMs: 300 });

  const initialId = buildDisplayRows(t.rows(), true)[3]?.id;
  expect(initialId).toBe("act:c1");

  // Silent intermediate turn 2: [thinking, tool] joins the SAME activity group without creating new rows!
  t.apply({ type: "message_start", message: assistant([]) });
  update({ type: "thinking_start", contentIndex: 0 });
  update({ type: "thinking_delta", contentIndex: 0, delta: "Selection works on View." });
  update({ type: "thinking_end", contentIndex: 0, content: "Selection works on View." });
  update({ type: "toolcall_start", contentIndex: 1, id: "c3", toolName: "Read file" });
  t.apply({
    type: "message_end",
    message: assistant([
      { type: "thinking", thinking: "Selection works on View." },
      { type: "toolCall", id: "c3", name: "Read file", arguments: { path: "types.d.ts" } },
    ]),
  });
  t.apply({ type: "tool_execution_end", toolCallId: "c3", toolName: "Read file", result: { content: [] }, isError: false, durationMs: 500 });

  // Silent intermediate turn 3: trailing thinking + commentary 2 flushes the group and starts a new boundary
  t.apply({ type: "message_start", message: assistant([]) });
  update({ type: "thinking_start", contentIndex: 0 });
  update({ type: "thinking_delta", contentIndex: 0, delta: "Now check TranscriptRow." });
  update({ type: "thinking_end", contentIndex: 0, content: "Now check TranscriptRow." });
  let midRows = buildDisplayRows(t.rows(), true);
  expect(midRows.map((r) => r.kind)).toEqual(["user", "turn", "text", "activity"]);
  const group = midRows[3] as ActivityRow;
  expect(group.id).toBe(initialId);
  expect(group.steps.map((s) => s.kind)).toEqual(["tool", "tool", "thinking", "tool", "thinking"]);
  expect(group.tools).toHaveLength(3);
  // Settled, it says what was done by kind, in the order it first happened.
  expect(describeActivity(group, "zh")).toBe("已运行 git，已读取 2 个文件");
  expect(describeActivity(group, "en")).toBe("Ran git, Read 2 files");
  // While it works it names the one step under way, not a growing tally.
  const thinkingNow = { ...group, running: true, steps: [...group.steps.slice(0, -1), { ...group.steps[group.steps.length - 1], streaming: true }] } as ActivityRow;
  expect(describeActivity(thinkingNow, "zh")).toBe("正在思考");
  const reading = { ...group, running: true, steps: group.steps.slice(0, 4).map((step, at) => (at === 3 && step.kind === "tool" ? { ...step, status: "running" as const } : step)) } as ActivityRow;
  expect(describeActivity(reading, "en")).toBe("Reading types.d.ts");

  // Commentary prose flushes the accumulated process group
  update({ type: "text_delta", contentIndex: 1, delta: "Checking TranscriptRow next." });
  update({ type: "toolcall_start", contentIndex: 2, id: "c4", toolName: "Read file" });
  midRows = buildDisplayRows(t.rows(), true);
  expect(midRows.map((r) => r.kind)).toEqual(["user", "turn", "text", "activity", "text", "activity"]);

  // Consecutive reasoning-only steps also collapse into one activity row and keep their initial id when a tool joins
  const t2 = new Transcript();
  t2.apply({ type: "message_start", message: assistant([{ type: "thinking", thinking: "Step one." }]) });
  t2.apply({ type: "message_end", message: assistant([{ type: "thinking", thinking: "Step one." }]) });
  // (Each message here calls nothing, so it ends its turn: the reader's own unfold shows what the fold holds.)
  const unfolded = () => buildDisplayRows(t2.rows(), true, { chosen: () => true });
  const firstOnly = unfolded()[1] as ActivityRow;
  expect(firstOnly.steps).toHaveLength(1);
  t2.apply({ type: "message_start", message: assistant([{ type: "thinking", thinking: "Step two." }]) });
  t2.apply({ type: "message_end", message: assistant([{ type: "thinking", thinking: "Step two." }]) });
  const twoThinkings = unfolded()[1] as ActivityRow;
  expect(twoThinkings.id).toBe(firstOnly.id);
  expect(twoThinkings.steps).toHaveLength(2);
  expect(describeActivity(twoThinkings, "zh")).toBe("查看思考过程");

  expect(classifyTool("Read file").category).toBe("read");
  expect(classifyTool("Run command").category).toBe("command");
  expect(classifyTool("Edit-file").category).toBe("edit");
});

/** A message that works on: prose, then a call (its result follows). */
const working = (id: string, text: string, at = 2) =>
  ({ role: "assistant", content: [{ type: "text", text }, { type: "toolCall", id, name: "read", arguments: {} }], stopReason: "toolUse", timestamp: at }) as never;
const called = (id: string, at = 3) => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: "ok" }], isError: false, timestamp: at }) as never;
const asked = (text: string, at = 1) => ({ role: "user", content: text, timestamp: at }) as never;
const answer = (text: string, at = 5) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: at }) as never;
const turnsOf = (rows: ReturnType<typeof buildDisplayRows>) => rows.filter((row) => row.kind === "turn") as TurnHeaderRow[];

test("a turn that is over is folded however it ended: answered, cut by a message, stopped, failed", () => {
  const t = new Transcript();
  t.load([
    // A message was sent into the run: what came before it never got an answer.
    asked("one"),
    working("c1", "Looking."),
    called("c1"),
    asked("steer", 4),
    working("c2", "Looking elsewhere."),
    called("c2"),
    answer("Done."),
    // Stopped on a call.
    asked("two", 6),
    working("c3", "Trying."),
    called("c3"),
    // Failed with nothing written.
    asked("three", 8),
    working("c4", "Again."),
    called("c4"),
    { role: "assistant", content: [], stopReason: "error", errorMessage: "529 overloaded", timestamp: 9 } as never,
  ]);
  // At rest, and with the session working on something else (its sub-sessions): none of them is the run's.
  for (const running of [false, true]) {
    const rows = buildDisplayRows(t.rows(), running);
    expect(rows.map((row) => row.kind)).toEqual(["user", "turn", "user", "turn", "text", "user", "turn", "user", "turn", "notice"]);
    expect(turnsOf(rows)).toMatchObject([
      { open: false, running: false, hasDetails: true },
      { open: false, running: false, hasDetails: true },
      { open: false, running: false, hasDetails: true },
      { open: false, running: false, hasDetails: true },
    ]);
  }
});

test("the turn the run is on shows its process; one a run left closed is not it, though it is the last", () => {
  const t = new Transcript();
  const update = (assistantMessageEvent: object) => t.apply({ type: "message_update", assistantMessageEvent } as never);
  t.apply({ type: "message_start", message: asked("go") });
  t.apply({ type: "message_start", message: { role: "assistant", content: [] } as never });
  update({ type: "text_delta", contentIndex: 0, delta: "Looking." });
  update({ type: "toolcall_start", contentIndex: 1, id: "c1", toolName: "read" });
  expect(turnsOf(buildDisplayRows(t.rows(), true))).toMatchObject([{ running: true, open: true }]);

  // Stopped: the turn is closed with no answer, and folds.
  t.apply({ type: "agent_settled", aborted: true });
  expect(turnsOf(buildDisplayRows(t.rows(), false))).toMatchObject([{ running: false, open: false }]);
  // The next message is sent — the session runs — and its row is not here yet: that turn does not start working again.
  expect(turnsOf(buildDisplayRows(t.rows(), true))).toMatchObject([{ running: false, open: false }]);
  t.apply({ type: "message_start", message: asked("again", 2) });
  t.apply({ type: "message_start", message: { role: "assistant", content: [] } as never });
  update({ type: "text_delta", contentIndex: 0, delta: "Once more." });
  expect(turnsOf(buildDisplayRows(t.rows(), true))).toMatchObject([
    { running: false, open: false },
    { running: true, open: true },
  ]);

  // A turn a message closed that goes on without a word from the reader is working again, its length not known yet.
  const t2 = new Transcript();
  t2.apply({ type: "message_start", message: asked("go") });
  t2.apply({ type: "message_start", message: { role: "assistant", content: [] } as never });
  t2.apply({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "Hm." }], stopReason: "stop", timestamp: 2 } as never });
  expect(turnsOf(buildDisplayRows(t2.rows(), true))).toMatchObject([{ running: false, open: false }]);
  t2.apply({ type: "message_start", message: { role: "assistant", content: [] } as never });
  t2.apply({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id: "c9", toolName: "read" } } as never);
  const [again] = turnsOf(buildDisplayRows(t2.rows(), true));
  expect(again).toMatchObject({ running: true, open: true });
  expect(again.durationMs).toBeUndefined();
});

test("the reader's say on a turn holds; folding a working turn folds the work as it goes on past a message", () => {
  const t = new Transcript();
  const update = (assistantMessageEvent: object) => t.apply({ type: "message_update", assistantMessageEvent } as never);
  const turn = new Map<string, boolean>();
  const work = new Map<string, boolean>();
  const shown = (running = true) => turnsOf(buildDisplayRows(t.rows(), running, { chosen: (id) => turn.get(id), said: (id) => work.get(id) }));
  /** The reader's press on a turn's header: on the one the run is on, it is their say on the work too. */
  const press = (row: TurnHeaderRow) => {
    turn.set(row.id, !row.open);
    if (row.running) work.set(row.id, !row.open);
  };
  const more = (id: string, text: string) => {
    t.apply({ type: "message_start", message: { role: "assistant", content: [] } as never });
    update({ type: "text_delta", contentIndex: 0, delta: text });
    update({ type: "toolcall_start", contentIndex: 1, id, toolName: "read" });
    t.apply({ type: "message_end", message: working(id, text) });
    t.apply({ type: "tool_execution_end", toolCallId: id, toolName: "read", result: { content: [] }, isError: false });
  };
  t.apply({ type: "message_start", message: asked("go") });
  more("c1", "Looking.");
  expect(shown()).toMatchObject([{ running: true, open: true }]);

  // Folded by the reader while it works: it stays folded, working or over.
  press(shown()[0]);
  expect(shown()).toMatchObject([{ running: true, open: false }]);

  // A message sent into the run: the work goes on as a turn of its own, folded as the reader had it — twice over.
  t.apply({ type: "message_start", message: asked("steer", 2) });
  more("c2", "Looking elsewhere.");
  expect(shown()).toMatchObject([{ running: false, open: false }, { running: true, open: false }]);
  t.apply({ type: "message_start", message: asked("steer again", 3) });
  more("c3", "And here.");
  expect(shown()).toMatchObject([{ open: false }, { open: false }, { running: true, open: false }]);

  // A look inside a part that is over opens that part alone, and closing it again changes nothing either.
  press(shown()[0]);
  expect(shown()).toMatchObject([{ open: true }, { open: false }, { running: true, open: false }]);
  press(shown()[0]);
  expect(shown()).toMatchObject([{ open: false }, { open: false }, { running: true, open: false }]);

  // Their press on the working one opens it, and the work shows from there on.
  press(shown()[2]);
  expect(shown()).toMatchObject([{ open: false }, { open: false }, { running: true, open: true }]);
  t.apply({ type: "message_start", message: asked("steer once more", 4) });
  more("c4", "And there.");
  expect(shown()).toMatchObject([{ open: false }, { open: false }, { running: false, open: true }, { running: true, open: true }]);
  // What they opened stays open once over; what they said nothing on folds.
  t.apply({ type: "message_start", message: { role: "assistant", content: [] } as never });
  t.apply({ type: "message_end", message: answer("Done.") });
  t.apply({ type: "agent_settled", aborted: false });
  expect(shown(false)).toMatchObject([{ open: false }, { open: false }, { open: true }, { running: false, open: false }]);

  // An answer ends the work: the next run's turn shows its process, whatever was folded before.
  work.set(shown(false)[3].id, false);
  t.apply({ type: "message_start", message: asked("next", 6) });
  more("c5", "A new thing.");
  expect(shown().at(-1)).toMatchObject({ running: true, open: true });

  // Not so a run that was stopped: what comes next carries on work that got no answer, folded if the reader folded it.
  press(shown().at(-1)!);
  t.apply({ type: "agent_settled", aborted: true });
  t.apply({ type: "message_start", message: asked("go on", 7) });
  more("c6", "Going on.");
  expect(shown().slice(-2)).toMatchObject([{ running: false, open: false }, { running: true, open: false }]);
});

test("a conversation loaded again keeps its rows' ids, so what is kept by row finds them", () => {
  // As it streamed: the rows the reader folded and unfolded.
  const live = new Transcript();
  const update = (assistantMessageEvent: object) => live.apply({ type: "message_update", assistantMessageEvent } as never);
  const first = { role: "assistant", content: [{ type: "thinking", thinking: "Hm." }, { type: "text", text: "Looking." }, { type: "toolCall", id: "c1", name: "read", arguments: {} }], stopReason: "toolUse", timestamp: 2 } as never;
  live.apply({ type: "message_start", message: asked("go") });
  live.apply({ type: "message_start", message: { role: "assistant", content: [] } as never });
  update({ type: "thinking_start", contentIndex: 0 });
  update({ type: "thinking_end", contentIndex: 0, content: "Hm." });
  update({ type: "text_delta", contentIndex: 1, delta: "Looking." });
  update({ type: "toolcall_start", contentIndex: 2, id: "c1", toolName: "read" });
  live.apply({ type: "message_end", message: first });
  live.apply({ type: "tool_execution_end", toolCallId: "c1", toolName: "read", result: { content: [{ type: "text", text: "ok" }] }, isError: false, durationMs: 12 });
  live.apply({ type: "message_start", message: { role: "assistant", content: [] } as never });
  update({ type: "text_delta", contentIndex: 0, delta: "Do" });
  const ids = (rows: { id: string }[]) => rows.map((row) => row.id);
  const displayed = (t: Transcript, running: boolean) => ids(buildDisplayRows(t.rows(), running, { chosen: () => true }));

  // The session's file, read while the run goes on: the answer is further along there than it was on screen.
  const history = [asked("go"), first, called("c1"), answer("Done.")];
  const fresh = new Transcript();
  fresh.load(history);
  expect(ids(fresh.rows())).not.toEqual(ids(live.rows()));
  fresh.adopt(live.rows());
  expect(ids(fresh.rows())).toEqual(ids(live.rows()));
  // The same rows, as the file has them: the measured times of a live run are not on file, and nothing streams.
  expect(fresh.rows()).toMatchObject([{ kind: "user" }, { kind: "thinking" }, { kind: "text" }, { kind: "tool", status: "done" }, { kind: "text", text: "Done.", final: true, streaming: false }]);
  // So the turn, its groups and the reply's actions are named as they were.
  expect(displayed(fresh, false)).toEqual(displayed(live, true));
  expect(displayRowIds(fresh.rows())).toEqual(displayRowIds(live.rows()));

  // It goes on from there under ids of its own: none of the adopted ones is handed out twice.
  fresh.apply({ type: "message_start", message: asked("more", 6) });
  fresh.apply({ type: "message_start", message: { role: "assistant", content: [] } as never });
  fresh.apply({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "More." } } as never);
  expect(new Set(ids(fresh.rows())).size).toBe(fresh.rows().length);

  // What only one of them holds pairs with nothing and breaks no pair after it: a notice of the client's own,
  // an attempt the agent retried and did not keep, a message the file gained since.
  const noted = new Transcript();
  noted.load([asked("go"), answer("Half an ans", 2), answer("Done.", 3)]);
  noted.note("info", "A note of the client's own");
  const reloaded = new Transcript();
  reloaded.load([asked("go"), answer("Done.", 3), asked("and then", 4), answer("Then this.", 5)]);
  reloaded.adopt(noted.rows());
  const before = noted.rows();
  expect(reloaded.rows().map((row) => row.id).slice(0, 2)).toEqual([before[0].id, before[2].id]);
  expect(reloaded.rows().slice(2).some((row) => before.some((old) => old.id === row.id))).toBe(false);

  // Words repeated in a conversation pair in order, each once.
  const twice = new Transcript();
  twice.load([asked("continue"), answer("Ok."), asked("continue", 6), answer("Ok.", 7)]);
  const twiceAgain = new Transcript();
  twiceAgain.load([asked("continue"), answer("Ok."), asked("continue", 6), answer("Ok.", 7)]);
  twiceAgain.adopt(twice.rows());
  expect(ids(twiceAgain.rows())).toEqual(ids(twice.rows()));
});

test("the history of a session still working leaves its last turn open and its calls running", () => {
  const history = [asked("go"), working("c1", "Looking."), called("c1"), working("c2", "Looking elsewhere.", 4)];

  // At rest, a call with no result was interrupted and the turn is over.
  const rest = new Transcript();
  rest.load(history);
  expect(rest.rows().at(-1)).toMatchObject({ kind: "tool", id: "c2", status: "error" });
  expect(turnsOf(buildDisplayRows(rest.rows(), false))).toMatchObject([{ running: false, open: false }]);

  // Working, the call is still to run, and the turn is the run's: open, as if watched from its start.
  const busy = new Transcript();
  busy.load(history, true);
  expect(busy.rows().at(-1)).toMatchObject({ kind: "tool", id: "c2", status: "queued" });
  expect(turnsOf(buildDisplayRows(busy.rows(), true))).toMatchObject([{ running: true, open: true }]);
  // What happens next lands on those rows, and the turn ends as any does.
  busy.apply({ type: "tool_execution_end", toolCallId: "c2", toolName: "read", result: { content: [{ type: "text", text: "ok" }] }, isError: false });
  busy.apply({ type: "message_start", message: { role: "assistant", content: [] } as never });
  busy.apply({ type: "message_end", message: answer("Done.") });
  expect(busy.rows().at(-2)).toMatchObject({ kind: "tool", id: "c2", status: "done", output: "ok" });
  const [turn] = turnsOf(buildDisplayRows(busy.rows(), true));
  expect(turn).toMatchObject({ running: false, open: false });
  expect(turn.durationMs).toBeGreaterThan(0);
});

test("displayRowIds names every row a transcript can project", () => {
  const t = new Transcript();
  const update = (assistantMessageEvent: object) => t.apply({ type: "message_update", assistantMessageEvent } as never);
  const assistant = (content: object[]) => ({ role: "assistant", content, timestamp: 1 }) as never;
  t.apply({ type: "message_start", message: { role: "user", content: "hi", timestamp: 1 } });
  t.apply({ type: "message_start", message: assistant([]) });
  update({ type: "thinking_start", contentIndex: 0 });
  update({ type: "thinking_delta", contentIndex: 0, delta: "hm" });
  update({ type: "toolcall_start", contentIndex: 1, id: "c1", toolName: "read" });
  update({ type: "toolcall_start", contentIndex: 2, id: "c2", toolName: "bash" });
  t.apply({
    type: "message_end",
    message: assistant([
      { type: "thinking", thinking: "hm" },
      { type: "toolCall", id: "c1", name: "read", arguments: {} },
      { type: "toolCall", id: "c2", name: "bash", arguments: {} },
    ]),
  });
  t.apply({ type: "tool_execution_end", toolCallId: "c1", toolName: "read", result: { content: [] }, isError: false });
  t.apply({ type: "tool_execution_end", toolCallId: "c2", toolName: "bash", result: { content: [] }, isError: false });
  t.apply({ type: "message_start", message: assistant([]) });
  update({ type: "text_delta", contentIndex: 0, delta: "Done." });
  t.apply({ type: "message_end", message: assistant([{ type: "text", text: "Done." }]) });

  // A landing marks them all seen: whatever the fold state projects, its id was named.
  const markable = new Set(displayRowIds(t.rows()));
  for (const open of [true, false]) {
    for (const row of buildDisplayRows(t.rows(), false, { chosen: () => open })) {
      expect(markable.has(row.id)).toBe(true);
    }
  }
  // The reply's actions row is minted beside it in views/Rows.tsx.
  const answer = t.rows().find((row) => row.kind === "text")!;
  expect(markable.has(`${answer.id}#actions`)).toBe(true);
});

test("a stopped run leaves nothing streaming or running", () => {
  const t = new Transcript();
  t.apply({ type: "message_start", message: { role: "assistant", content: [] } as never });
  t.apply({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "par" } });
  t.apply({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, id: "c", toolName: "bash" } });
  t.apply({ type: "agent_settled", aborted: true });
  expect(t.rows()).toMatchObject([{ kind: "text", streaming: false }, { kind: "tool", status: "error" }]);
});

/** An assistant message as Pi ends it: `error` set, it failed on that; else it answered `text`. */
const reply = (text: string, error?: string) =>
  ({ role: "assistant", content: text ? [{ type: "text", text }] : [], stopReason: error ? "error" : "stop", errorMessage: error, timestamp: 2 }) as never;

/** Plays one attempt at a reply: the message, then the low-level run ending. */
function attempt(t: Transcript, text: string, error?: string) {
  t.apply({ type: "message_start", message: { role: "assistant", content: [] } as never });
  if (text) t.apply({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text } });
  t.apply({ type: "message_end", message: reply(text, error) });
  t.apply({ type: "turn_end" });
  t.apply({ type: "agent_end", willRetry: false });
}

test("an error that is retried is never shown; one that stands is reported once, when the run settles", () => {
  const t = new Transcript();
  const notices = () => t.rows().filter((row) => row.kind === "notice");
  t.apply({ type: "message_start", message: { role: "user", content: "hi", timestamp: 1 } });

  // The first attempt breaks off mid-sentence and Pi retries: no error row comes and goes.
  attempt(t, "Half an ans", "529 overloaded");
  expect(notices()).toEqual([]);
  t.apply({ type: "auto_retry_start", attempt: 1, maxAttempts: 2, delayMs: 2000, errorMessage: "529 overloaded" });
  expect(notices()).toEqual([]);
  // What the failed attempt wrote stays where it was, as part of the process: it is not the answer.
  expect(t.rows()).toMatchObject([{ kind: "user" }, { kind: "text", text: "Half an ans", streaming: false }]);
  expect((t.rows()[1] as { final?: boolean }).final).toBeFalsy();

  // The retry answers: one turn, under one header, and still no error.
  attempt(t, "The whole answer.");
  t.apply({ type: "auto_retry_end", success: true, attempt: 1 });
  t.apply({ type: "agent_settled", aborted: false });
  expect(notices()).toEqual([]);
  expect(buildDisplayRows(t.rows()).filter((row) => row.kind === "turn")).toHaveLength(1);

  // Every retry fails: the failure is said once, by the last attempt's own error, not once per attempt plus a summary.
  t.apply({ type: "message_start", message: { role: "user", content: "again", timestamp: 3 } });
  attempt(t, "", "529 overloaded");
  t.apply({ type: "auto_retry_start", attempt: 1, maxAttempts: 2, delayMs: 2000, errorMessage: "529 overloaded" });
  attempt(t, "", "529 overloaded");
  t.apply({ type: "auto_retry_start", attempt: 2, maxAttempts: 2, delayMs: 4000, errorMessage: "529 overloaded" });
  attempt(t, "", "529 overloaded");
  t.apply({ type: "auto_retry_end", success: false, attempt: 2, finalError: "529 overloaded" });
  expect(notices()).toEqual([]);
  t.apply({ type: "agent_settled", aborted: false });
  expect(notices()).toMatchObject([{ tone: "error", title: "The model returned an error", text: "529 overloaded" }]);
  expect(t.rows().at(-1)).toMatchObject({ kind: "notice" });
});

test("a retry the reader cancels leaves no error, and a failure with no retry keeps what it wrote as the answer", () => {
  const t = new Transcript();
  t.apply({ type: "message_start", message: { role: "user", content: "hi", timestamp: 1 } });
  attempt(t, "", "529 overloaded");
  t.apply({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "529 overloaded" });
  // Stop, while Pi waits to try again.
  t.apply({ type: "auto_retry_end", success: false, attempt: 1, finalError: "Retry cancelled" });
  t.apply({ type: "agent_settled", aborted: false });
  expect(t.rows().map((row) => row.kind)).toEqual(["user"]);

  // No retry (a bad key, retries off): the error follows what was written, which is the answer there is.
  t.apply({ type: "message_start", message: { role: "user", content: "again", timestamp: 3 } });
  attempt(t, "As far as I got", "401 invalid api key");
  t.apply({ type: "agent_settled", aborted: false });
  expect(t.rows().slice(2)).toMatchObject([
    { kind: "text", text: "As far as I got", final: true, streaming: false },
    { kind: "notice", tone: "error", text: "401 invalid api key" },
  ]);

  // The conversation moving on reports it too, in its place: before the next message, not after.
  attempt(t, "", "500 internal error");
  t.apply({ type: "message_start", message: { role: "user", content: "queued", timestamp: 5 } });
  expect(t.rows().slice(-2)).toMatchObject([{ kind: "notice", text: "500 internal error" }, { kind: "user", text: "queued" }]);
});

test("history shows the same errors a live run did: retried attempts none, a failure that stood one", () => {
  const t = new Transcript();
  t.load([
    { role: "user", content: "hi", timestamp: 1 },
    reply("", "529 overloaded"),
    reply("", "529 overloaded"),
    reply("The whole answer."),
    { role: "user", content: "again", timestamp: 3 },
    reply("", "529 overloaded"),
    reply("As far as I got", "401 invalid api key"),
  ]);
  expect(t.rows()).toMatchObject([
    { kind: "user" },
    { kind: "text", text: "The whole answer.", final: true },
    { kind: "user" },
    { kind: "text", text: "As far as I got", final: true },
    { kind: "notice", tone: "error", title: "The model returned an error", text: "401 invalid api key" },
  ]);
});

test("a message shows what the person wrote, not what Pi told the model about its images", () => {
  const scaled = "[Image: original 1914x2040, displayed at 1876x2000. Multiply coordinates by 1.02 to map to original image.]";
  const converted = "[Image converted from image/bmp to image/png.]";
  const omitted = "[Image omitted: could not be resized below the inline image size limit.]";
  const image = { type: "image" as const, data: "", mimeType: "image/png" };

  const t = new Transcript();
  t.load([
    { role: "user", content: [{ type: "text", text: `Too far apart\n\n${converted}\n${scaled}` }, image], timestamp: 1 },
    // An image sent with no words is still a message: the picture alone.
    { role: "user", content: [{ type: "text", text: `\n\n${scaled}` }, image], timestamp: 2 },
  ]);
  expect(t.rows()).toMatchObject([
    { kind: "user", text: "Too far apart", images: 1 },
    { kind: "user", text: "", images: 1 },
  ]);
  // A live message arrives the same way.
  t.apply({ type: "message_start", message: { role: "user", content: [{ type: "text", text: `Two\n\nparagraphs\n\n${scaled}` }, image], timestamp: 3 } });
  expect(t.rows().at(-1)).toMatchObject({ kind: "user", text: "Two\n\nparagraphs", images: 1 });

  // That an image was left out is for the reader too: it stays.
  expect(withoutImageNotes(`Look\n\n${omitted}\n${scaled}`)).toBe(`Look\n\n${omitted}`);
  expect(withoutImageNotes(`Look\n\n${omitted}`)).toBe(`Look\n\n${omitted}`);
  // Only Pi's own lines, at the end, after a blank line: the same words written by hand are the person's.
  expect(withoutImageNotes(`${scaled}\n\nwhat does this note mean?`)).toBe(`${scaled}\n\nwhat does this note mean?`);
  expect(withoutImageNotes(`see\n${scaled}`)).toBe(`see\n${scaled}`);
  expect(withoutImageNotes("Plain\n\n[Image: a cat]")).toBe("Plain\n\n[Image: a cat]");
});

test("titles a tool call from partial argument JSON", () => {
  const t = new Transcript();
  t.apply({ type: "message_start", message: { role: "assistant", content: [] } as never });
  const update = (assistantMessageEvent: object) => t.apply({ type: "message_update", assistantMessageEvent } as never);
  // A string keeps its partial value; a finished primitive lands; a nested value still streaming waits.
  update({ type: "toolcall_start", contentIndex: 0, id: "c0", toolName: "bash" });
  update({ type: "toolcall_delta", contentIndex: 0, delta: '{"command":"sed -n 1,40p","timeout":120,"files":[{"name":"x"' });
  expect((t.rows()[0] as { args: unknown }).args).toEqual({ command: "sed -n 1,40p", timeout: 120 });
  update({ type: "toolcall_start", contentIndex: 1, id: "c1", toolName: "read" });
  update({ type: "toolcall_delta", contentIndex: 1, delta: '{"path":"src/ap' });
  expect((t.rows()[1] as { args: unknown }).args).toEqual({ path: "src/ap" });
});

test("summarizes a tool call by what matters", () => {
  expect(toolSummary("bash", { command: "ls -la" })).toBe("ls -la");
  expect(toolSummary("grep", { pattern: "TODO", path: "src" })).toBe("TODO  in src");
  expect(toolSummary("custom", {})).toBe("");
});

test("close(0) kills transport immediately while normal close waits for grace period", async () => {
  let ended = 0;
  let killed = 0;
  const t: Transport = {
    write: () => undefined,
    onStdout: () => undefined,
    onStderr: () => undefined,
    onExit: () => undefined,
    end: () => void ended++,
    kill: () => void killed++,
  };
  const c = new PiClient(t, { onEvent: () => undefined, onUiRequest: () => undefined, onExit: () => undefined });
  c.close(0);
  expect(ended).toBe(1);
  expect(killed).toBe(1);
});

test("reuses one daemon across workspaces and detaches (not kills) the session on switch", async () => {
  const { fakeBackend } = await import("../dev/fake-pi");
  const { useBackend } = await import("../store/backend");
  const { boot, openWorkspace } = await import("../store/app");

  let daemonConnects = 0;
  let daemonCloses = 0;
  let attaches = 0;

  const base = fakeBackend();
  useBackend({
    ...base,
    async connectDaemon(callbacks) {
      daemonConnects++;
      const client = await base.connectDaemon!(callbacks);
      return {
        ...client,
        async attach(spec) {
          attaches++;
          return client.attach(spec);
        },
        close() {
          daemonCloses++;
          client.close();
        },
      } as typeof client;
    },
  });

  await boot();
  expect(daemonConnects).toBe(1);
  expect(attaches).toBe(1);

  // Switching across workspaces keeps the one daemon; each switch is another attach
  await openWorkspace("/Users/pip/code/nsh");
  await openWorkspace("/Users/pip/code/pi-docs");
  expect(daemonConnects).toBe(1);
  expect(attaches).toBe(3);

  // A hot-reload re-boot lets go of the link (the daemon's sessions are not the app's to stop) and reconnects
  await boot();
  expect(daemonCloses).toBe(1);
  expect(daemonConnects).toBe(2);
  expect(attaches).toBe(4);
});

test("wallpaper crop geometry, pan/zoom adjustment, rotation cooldown, and color extraction", async () => {
  const {
    chooseRandomWallpaperCandidate,
    DEFAULT_WALLPAPER_ADJUSTMENT,
    extractDominantColorFromRgba,
    fittedGeometry,
    inspectImageBytes,
    panAdjustment,
    rememberWallpaperHistory,
    zoomAdjustmentAround,
  } = await import("../lib/wallpaper");

  // 1. Cover geometry & focal point
  const geom = fittedGeometry(1600, 900, 800, 600, DEFAULT_WALLPAPER_ADJUSTMENT);
  expect(geom.scaledHeight).toBe(600);
  expect(Math.round(geom.scaledWidth)).toBe(1067);
  expect(Math.round(geom.offsetX)).toBe(-133);
  expect(geom.offsetY).toBe(0);

  // 2. Panning shifts focalX/focalY within overflow bounds
  const panned = panAdjustment(1600, 900, 800, 600, DEFAULT_WALLPAPER_ADJUSTMENT, -100, 0);
  expect(panned.focalX).toBeGreaterThan(0.5);
  expect(panned.focalY).toBe(0.5);

  // 3. Zooming around anchor point preserves anchor coordinates
  const zoomed = zoomAdjustmentAround(1600, 900, 800, 600, DEFAULT_WALLPAPER_ADJUSTMENT, 2.0, 200, 150);
  expect(zoomed.zoom).toBe(2.0);
  expect(zoomed.focalX).toBeLessThan(0.5);
  expect(zoomed.focalY).toBeLessThan(0.5);

  // 4. Random wallpaper rotation avoids current and recent history cooldown
  const candidates = ["/w/1.png", "/w/2.png", "/w/3.png", "/w/4.png"];
  let history: string[] = [];
  history = rememberWallpaperHistory(history, "/w/1.png");
  history = rememberWallpaperHistory(history, "/w/2.png");
  const picked = chooseRandomWallpaperCandidate(candidates, "/w/3.png", history, () => 0);
  expect(picked).toBe("/w/4.png");

  // 5. PNG header inspection & RGBA dominant color extraction
  const pngBytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x07, 0x80, // width = 1920
    0x00, 0x00, 0x04, 0x38, // height = 1080
    0x08, 0x06, 0x00, 0x00, 0x00,
  ]);
  const info = inspectImageBytes(pngBytes);
  expect(info?.format).toBe("png");
  expect(info?.width).toBe(1920);
  expect(info?.height).toBe(1080);

  const rgba = new Uint8Array(64 * 4);
  for (let i = 0; i < 64; i++) {
    rgba[i * 4] = 52;
    rgba[i * 4 + 1] = 120;
    rgba[i * 4 + 2] = 246;
    rgba[i * 4 + 3] = 255;
  }
  const dom = extractDominantColorFromRgba(rgba);
  expect(dom).toMatch(/^#[0-9a-f]{6}$/);
});


