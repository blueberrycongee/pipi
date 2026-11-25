import { expect, test } from "nsh/test";
import type { DaemonSession } from "../pi/daemon";
import type { Row, ToolRow } from "../pi/transcript";
import { buildDisplayRows, extractDelegatedSessions } from "../pi/turns";
import { derivePipLiveStatus, formatElapsedCompact } from "./pip-status";

function makeDaemon(overrides: Partial<DaemonSession> = {}): DaemonSession {
  return {
    id: "s_child_1",
    title: "Fix login tests",
    cwd: "/Users/pip/code/pipi",
    agentId: "claude",
    agentName: "Claude Code",
    driver: "claude",
    runtimeMode: "full-access",
    status: "working",
    unread: false,
    loaded: true,
    depth: 1,
    createdAt: 1000,
    lastActive: 2000,
    ...overrides,
  };
}

function makeTool(overrides: Partial<ToolRow> = {}): ToolRow {
  return {
    kind: "tool",
    id: "t1",
    name: "read",
    args: { path: "MEMORY.md" },
    status: "running",
    output: "",
    images: 0,
    ...overrides,
  };
}

test("derivePipLiveStatus reflects thinking, active tools, recent steps, and writing phases", () => {
  const t0 = 10_000;
  // 1. Thinking phase
  const thinking = derivePipLiveStatus({
    name: "Pip",
    lang: "en",
    rows: [
      { kind: "user", id: "u1", text: "Check my notes", images: 0 },
      { kind: "thinking", id: "th1", text: "Looking up notes", streaming: true, redacted: false, t0 },
    ],
    running: true,
    activity: { kind: "thinking" },
    childSessions: [],
  });
  expect(thinking.phase).toBe("thinking");
  expect(thinking.active).toBe(true);
  expect(thinking.headline).toBe("Thinking");
  expect(thinking.startedAt).toBe(t0);

  // 2. Active tool call + recent completed tool steps (with a queued user message trailing)
  const working = derivePipLiveStatus({
    name: "Pip",
    lang: "zh",
    rows: [
      { kind: "user", id: "u1", text: "帮我查一下", images: 0 },
      makeTool({ id: "t1", name: "read", args: { path: "MEMORY.md" }, status: "done", t0 }),
      makeTool({ id: "t2", name: "session_start", args: { title: "重构登录模块", agent: "claude" }, status: "running" }),
      { kind: "user", id: "u2", text: "顺便跑下测试", images: 0, queued: true },
    ],
    running: true,
    activity: { kind: "tool", name: "session_start" },
    childSessions: [],
  });
  expect(working.phase).toBe("tool");
  expect(working.active).toBe(true);
  expect(working.headline).toBe("正在协调子会话");
  expect(working.detail).toBe("正在启动子会话 重构登录模块");
  expect(working.recentSteps).toEqual(["已读取 MEMORY.md"]);
  expect(working.startedAt).toBe(t0);

  // 3. Writing reply phase
  const writing = derivePipLiveStatus({
    name: "Pip",
    lang: "zh",
    rows: [
      { kind: "user", id: "u1", text: "总结一下", images: 0 },
      makeTool({ id: "t1", name: "read", args: { path: "MEMORY.md" }, status: "done", t0 }),
      { kind: "text", id: "m1", text: "好的，我刚看了一下", streaming: true },
    ],
    running: true,
    activity: { kind: "writing" },
    childSessions: [],
  });
  expect(writing.phase).toBe("writing");
  expect(writing.headline).toBe("正在整理回复");
  expect(writing.detail).toBeUndefined();
  expect(writing.recentSteps).toEqual(["已读取 MEMORY.md"]);
});

test("derivePipLiveStatus handles child sessions, confirmations, retries, errors, and idle", () => {
  const childWorking = makeDaemon({ id: "s_1", title: "Refactor auth", status: "working" });
  const childBlocked = makeDaemon({ id: "s_2", title: "Run migrations", status: "blocked" });
  const childIdle = makeDaemon({ id: "s_3", title: "Old task", status: "idle" });

  // Waiting on child sessions while Pip itself is idle
  const waiting = derivePipLiveStatus({
    name: "Pip",
    lang: "en",
    rows: [],
    running: false,
    activity: { kind: "idle" },
    childSessions: [childWorking, childIdle],
  });
  expect(waiting.phase).toBe("waiting_sessions");
  expect(waiting.active).toBe(true);
  expect(waiting.headline).toBe("Waiting on 1 session");
  expect(waiting.activeChildren.map((c) => c.id)).toEqual(["s_1"]);

  // Blocked child takes priority in headline
  const waitingBlocked = derivePipLiveStatus({
    name: "Pip",
    lang: "zh",
    rows: [],
    running: false,
    activity: { kind: "idle" },
    childSessions: [childWorking, childBlocked],
  });
  expect(waitingBlocked.phase).toBe("waiting_sessions");
  expect(waitingBlocked.headline).toBe("有子会话等待确认");
  expect(waitingBlocked.activeChildren.map((c) => c.id)).toEqual(["s_1", "s_2"]);

  // Direct pending confirmation dialog
  const confirm = derivePipLiveStatus({
    name: "Pip",
    lang: "en",
    rows: [],
    running: true,
    activity: { kind: "tool", name: "bash" },
    pendingDialog: { method: "confirm", title: "Allow bash?" },
    childSessions: [],
  });
  expect(confirm.phase).toBe("waiting_user");
  expect(confirm.headline).toBe("Waiting for confirmation");
  expect(confirm.detail).toBe("Allow bash?");

  // Retrying
  const retrying = derivePipLiveStatus({
    name: "Pip",
    lang: "en",
    rows: [],
    running: true,
    activity: { kind: "retrying", attempt: 2, maxAttempts: 3, reason: "529 overloaded" },
    childSessions: [],
  });
  expect(retrying.phase).toBe("retrying");
  expect(retrying.headline).toBe("Retrying (2/3)");
  expect(retrying.detail).toBe("529 overloaded");

  // Idle with engine label
  const idle = derivePipLiveStatus({
    name: "Pip",
    lang: "en",
    rows: [],
    running: false,
    activity: { kind: "idle" },
    childSessions: [childIdle],
    engineLabel: "Pi · Claude Sonnet 4.5",
  });
  expect(idle.phase).toBe("idle");
  expect(idle.active).toBe(false);
  expect(idle.headline).toBe("Ready");
  expect(idle.engineLabel).toBe("Pi · Claude Sonnet 4.5");
  expect(idle.activeChildren).toEqual([]);

  expect(formatElapsedCompact(8400)).toBe("8s");
  expect(formatElapsedCompact(74_000)).toBe("1m 14s");
  expect(formatElapsedCompact(3_720_000)).toBe("1h 2m");
});

test("buildDisplayRows in persona mode hides in-flight streaming/tools and delivers complete IM turns cleanly", () => {
  const liveRows: Row[] = [
    { kind: "user", id: "u1", text: "Look at the repo", images: 0 },
    { kind: "thinking", id: "th1", text: "Let me check", streaming: false, redacted: false, t0: 1000 },
    { kind: "text", id: "m1", text: "Checking package.json first.", streaming: false, final: false },
    makeTool({ id: "t1", name: "read", args: { path: "package.json" }, status: "done" }),
    { kind: "text", id: "m2", text: "Halfway through typing...", streaming: true },
  ];

  // While running in Pip persona mode: only the user's bubble is shown; no streaming text or tool log wall.
  const pipRunning = buildDisplayRows(liveRows, true, {}, undefined, { persona: true, lang: "en" });
  expect(pipRunning.map((r) => r.kind)).toEqual(["user"]);

  // In normal coding mode (persona omitted/false): turn header, process, and streaming text show as usual.
  const codingRunning = buildDisplayRows(liveRows, true, {}, undefined, { persona: false, lang: "en" });
  expect(codingRunning.some((r) => r.kind === "turn")).toBe(true);
  expect(codingRunning.some((r) => r.kind === "activity")).toBe(true);
  expect(codingRunning.some((r) => r.kind === "text" && r.text === "Halfway through typing...")).toBe(true);

  // Once the turn finishes in Pip persona mode: final message lands whole with Pip avatar slot + quiet collapsed footer.
  const settledRows: Row[] = [
    { kind: "user", id: "u1", text: "Look at the repo", images: 0 },
    { kind: "thinking", id: "th1", text: "Let me check", streaming: false, redacted: false, t0: 1000, turnMs: 4200 },
    { kind: "text", id: "m1", text: "Checking package.json first.", streaming: false, final: false },
    makeTool({ id: "t1", name: "read", args: { path: "package.json" }, status: "done" }),
    makeTool({
      id: "t2",
      name: "session_start",
      args: { title: "Fix login tests", agent: "claude" },
      status: "done",
      output: JSON.stringify({ id: "s_child_9", title: "Fix login tests" }),
    }),
    { kind: "text", id: "m2", text: "All set! I started a session to fix the login tests.", streaming: false, final: true },
  ];

  const pipSettled = buildDisplayRows(settledRows, false, {}, undefined, { persona: true, lang: "en" });
  expect(pipSettled.map((r) => r.kind)).toEqual(["user", "text", "pip-sessions", "pip-footer"]);
  const reply = pipSettled[1];
  expect(reply.kind === "text" && reply.pip?.lead).toBe(true);
  const sessionsRow = pipSettled[2];
  expect(sessionsRow.kind === "pip-sessions" && sessionsRow.sessions[0].sessionId).toBe("s_child_9");
  expect(sessionsRow.kind === "pip-sessions" && sessionsRow.pip?.lead).toBe(false);
  expect(sessionsRow.kind === "pip-sessions" && sessionsRow.pip?.indent).toBe(true);
  const footer = pipSettled[3];
  expect(footer.kind === "pip-footer" && footer.open).toBe(false);
  expect(footer.kind === "pip-footer" && footer.hasDetails).toBe(true);
  expect(footer.kind === "pip-footer" && footer.durationMs).toBe(4200);

  // Explicitly opening the turn's process details reveals the underlying steps cleanly.
  const turnId = footer.kind === "pip-footer" ? footer.turnId : "";
  const processOf = new Map<string, string>();
  const pipExpanded = buildDisplayRows(
    settledRows,
    false,
    { chosen: (id) => (id === turnId ? true : undefined) },
    processOf,
    { persona: true, lang: "en" },
  );
  expect(pipExpanded.some((r) => r.kind === "activity")).toBe(true);
  expect(processOf.size).toBeGreaterThan(0);
});

test("buildDisplayRows in persona mode never drops interrupted fallback text, notices, or deliveries", () => {
  const rows: Row[] = [
    { kind: "user", id: "u1", text: "Start work", images: 0 },
    { kind: "text", id: "m1", text: "I kicked off the build check.", streaming: false, final: false, t0: 1000, turnMs: 2000 },
    makeTool({ id: "t1", name: "bash", args: { command: "npm test" }, status: "error", output: "Stopped before it finished." }),
    { kind: "notice", id: "n1", tone: "error", title: "The model returned an error", text: "529 overloaded" },
    { kind: "delivery", id: "d1", from: "s_child_1", fromTitle: "Fix login tests", agent: "claude", status: "idle", text: "Done." },
  ];

  const projected = buildDisplayRows(rows, false, {}, undefined, { persona: true, lang: "en" });
  expect(projected.some((r) => r.kind === "user" && r.text === "Start work")).toBe(true);
  // Fallback surfaces completed pre-tool prose when no final answer existed in the settled turn.
  expect(projected.some((r) => r.kind === "text" && r.text === "I kicked off the build check.")).toBe(true);
  expect(projected.some((r) => r.kind === "notice" && r.text === "529 overloaded")).toBe(true);
  expect(projected.some((r) => r.kind === "delivery" && r.from === "s_child_1")).toBe(true);

  const delegated = extractDelegatedSessions([
    makeTool({ id: "t_a", name: "mcp__pipi__session_start", args: { title: "Audit API", agent: "codex" }, status: "done", output: '{"id":"s_42"}' }),
    makeTool({ id: "t_b", name: "session_start", args: { title: "Audit API", agent: "codex" }, status: "done", output: '{"id":"s_42"}' }),
  ]);
  expect(delegated).toEqual([{ toolId: "t_a", sessionId: "s_42", title: "Audit API", agent: "codex" }]);
});
