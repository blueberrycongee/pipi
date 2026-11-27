import { effect } from "nsh";
import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";
import { fakeBackend } from "./dev/fake-pi";
import { advanceElemVeil, beginVeilPass, clearVeils, finishVeilPass, reseedVeils, rowVeil } from "./lib/veil";
import { parseSessionSnapshot } from "./pi/session-file";
import { sameVisualRows, Transcript } from "./pi/transcript";
import {
  boot,
  conversationKey,
  currentView,
  isLeavingSession,
  isRunning,
  isSnapshotPending,
  openSession,
  refreshSessions,
  savedSessions,
  transcriptRows,
  workspaceSessions,
} from "./store/app";
import { useBackend } from "./store/backend";
import { proseRows } from "./views/Prose";
import { enterConversation } from "./views/Rows";

// A session change answers the click, not the agent. On a manual clock with
// agents as slow as real CLIs (`harness.startDelay`), each test reads the chat
// from the press on: a conversation seen before, a fresh session's empty chat,
// and a saved session's own file are all shown at once — what the file holds is
// the destination's last settled state — and the agent's own history confirms
// or replaces it invisibly as it lands.
//
//   nsh test Switch.test.tsx
//
// `press` runs the clock some 400ms on its own, so the delay is longer than that.

const DELAY = 1500;

const launch = (scenario: string) =>
  open("./Harness.tsx", {
    width: 1180,
    height: 780,
    platform: "macos",
    locale: "en-US",
    clock: {},
    storage: { "harness.scenario": scenario, "harness.startDelay": String(DELAY), "harness.distinct": "1" },
  });

/** What `probe` reads at each frame, until the agent has surely settled. */
async function frames<T>(app: App, probe: () => T): Promise<T[]> {
  const seen: T[] = [probe()];
  for (let elapsed = 0; elapsed < DELAY * 2; elapsed += 16) {
    await app.wait(16);
    seen.push(probe());
  }
  return seen;
}

const REFACTOR = "Refactor the transcript reducer";
const NOTES = "Release notes for 0.1";
const row = (title: string) => `id:sidebar-recents >> text:${title}`;
/** Whether the conversation that opens with `title` is in the chat (each scripted session opens on its title, asked). */
const shows = (app: App, title: string) => app.count(`label:Conversation >> text:${title}`) > 0;

test("returning from an empty session docks the composer without a waking hero over the conversation", async () => {
  const app = await open("./Harness.tsx", {
    width: 1180,
    height: 780,
    platform: "macos",
    locale: "en-US",
    clock: {},
    storage: {
      "harness.scenario": "history",
      "harness.startDelay": String(DELAY),
      "harness.dies": "5000",
      "harness.then": "4000:new;8000:/sessions/one.jsonl",
    },
  });
  await app.waitFor("text:Here is the plan.");
  await app.wait(6000);
  await app.waitFor("text:What are we building?");
  let returned = false;
  const seen = await frames(app, () => {
    if (!app.shows("label:Conversation")) return true;
    returned = true;
    return !app.texts().some((text) => text.includes("Waking Pi")) && app.shows("id:composer-docked") && !app.shows("id:composer-hero");
  });
  expect(returned).toBe(true);
  expect(seen.every(Boolean)).toBe(true);
}, 120000);

test("a conversation seen before is on screen with the click", async () => {
  const app = await launch("welcome");
  await app.waitFor("text:What are we building?");
  await app.press(row(REFACTOR));
  await app.waitUntil(() => shows(app, REFACTOR));
  await app.press(row(NOTES));
  await app.waitUntil(() => shows(app, NOTES));

  // Back to the first: there before the agent has had time to load anything, and never away again.
  await app.press(row(REFACTOR));
  const seen = await frames(app, () => shows(app, REFACTOR) && !shows(app, NOTES));
  expect(seen.every(Boolean)).toBe(true);
});

test("returning to a running session never doubles Pip under its turn", async () => {
  const app = await open("./Harness.tsx", {
    width: 1180,
    height: 780,
    platform: "macos",
    locale: "en-US",
    clock: {},
    storage: {
      "harness.scenario": "stream",
      "harness.distinct": "1",
      "harness.then": "1000:/sessions/one.jsonl;2500:send:make a plan in steps;7000:/sessions/two.jsonl;7800:/sessions/one.jsonl",
    },
  });

  // The switchback lands on a turn whose own header is on screen. Since that header
  // already anchors the one working Pip, the footer's first frame must not add another.
  let left = false;
  let returned = false;
  const pips: number[] = [];
  for (let elapsed = 0; elapsed < 10000 && pips.length < 32; elapsed += 16) {
    await app.wait(16);
    if (shows(app, REFACTOR) && app.texts().includes("Ask Pi…")) left = true;
    const back =
      left &&
      shows(app, "make a plan in steps") &&
      app.count("label:Conversation >> text:Working") > 0 &&
      app.texts().includes("Steer Pi…");
    if (!returned && back) returned = true;
    if (returned) pips.push(app.count("label:Conversation >> label:pipi"));
  }
  expect(returned).toBe(true);
  expect(pips.length).toBeGreaterThan(0);
  expect(Math.max(...pips)).toBeLessThanOrEqual(1);
});

test("a conversation not seen yet lands from its file at once and never moves again", async () => {
  const app = await launch("welcome");
  await app.waitFor("text:What are we building?");
  await app.press(row(REFACTOR));
  await app.waitUntil(() => shows(app, REFACTOR));

  await app.press(row(NOTES));
  const seen = await frames(app, () => ({ old: shows(app, REFACTOR), next: shows(app, NOTES), texts: app.texts() }));

  // The saved file answers the click, not the agent's load: the destination is
  // there inside the first frames, the agent's own history confirms it later.
  const firstNext = seen.findIndex((frame) => frame.next);
  expect(firstNext).toBeGreaterThanOrEqual(0);
  expect(firstNext * 16).toBeLessThan(DELAY);
  // Never both, and nothing in between but the frame the list takes to mount the rows it was handed.
  expect(seen.some((frame) => frame.old && frame.next)).toBe(false);
  expect(seen.filter((frame) => !frame.old && !frame.next).length).toBeLessThanOrEqual(1);
  // What landed stays landed: the late agent history replaces nothing the reader can see.
  expect(seen.slice(firstNext).every((frame) => frame.next && !frame.old)).toBe(true);
  expect(seen.some((frame) => frame.texts.includes("What are we building?"))).toBe(false);
});

test("a new session's empty chat is on screen with the click, in another project too", async () => {
  const app = await launch("multi");
  await app.waitFor("text:What are we building?");
  await app.press("id:sidebar-recents >> text:Fix QuickJS GC mark phase");
  await app.waitUntil(() => app.texts().includes("Here is the plan."));

  // Another project means another agent process: the chat does not wait for it.
  await app.hover("label:New session in pipi");
  await app.press("label:New session in pipi");
  const seen = await frames(app, () => app.texts());
  expect(seen.every((frame) => frame.includes("What are we building?"))).toBe(true);
  expect(seen.some((frame) => frame.includes("Here is the plan."))).toBe(false);
  expect(seen.some((frame) => frame.includes("No model"))).toBe(false);
});

test("a message written during the change is sent where it lands", async () => {
  const app = await launch("welcome");
  await app.waitFor("text:What are we building?");

  await app.press(row(REFACTOR));
  await app.type("label:Message", "and then what");
  await app.submit("label:Message");
  await app.waitUntil(() => app.texts().includes("and then what"), { timeout: DELAY * 4 });
  expect(shows(app, REFACTOR)).toBe(true);
});

test("multiple messages submitted during a slow session change are delivered in order without dropping any", async () => {
  const app = await launch("welcome");
  await app.waitFor("text:What are we building?");

  await app.press(row(REFACTOR));
  await app.type("label:Message", "first in flight");
  await app.submit("label:Message");
  expect(app.value("label:Message") ?? "").toBe("");
  await app.type("label:Message", "second in flight");
  await app.submit("label:Message");
  expect(app.value("label:Message") ?? "").toBe("");

  await app.waitUntil(
    () => app.texts().includes("first in flight") && app.texts().includes("second in flight"),
    { timeout: DELAY * 6 },
  );
  const texts = app.texts();
  expect(shows(app, REFACTOR)).toBe(true);
  expect(texts.indexOf("first in flight")).toBeLessThan(texts.indexOf("second in flight"));
});

test("starting a new session in another project keeps the chosen model without flashing defaults or waking", async () => {
  const app = await launch("multi");
  await app.waitFor("text:What are we building?");

  // Pick a non-default model so the new CLI process boots on a different default first.
  await app.press("text:Claude Sonnet 4.5");
  await app.press("text:GPT-5.1");
  await app.waitUntil(() => app.texts().includes("GPT-5.1") && !app.texts().includes("Claude Sonnet 4.5"));

  await app.press("id:sidebar-recents >> text:Fix QuickJS GC mark phase");
  await app.waitUntil(() => app.texts().includes("Here is the plan."));

  await app.hover("label:New session in pipi");
  await app.press("label:New session in pipi");
  const seen = await frames(app, () => app.texts());
  expect(seen.every((frame) => frame.includes("What are we building?"))).toBe(true);
  expect(seen.some((frame) => frame.includes("Waking Pi"))).toBe(false);
  expect(seen.some((frame) => frame.includes("No model"))).toBe(false);
  expect(seen.some((frame) => frame.includes("Claude Sonnet 4.5"))).toBe(false);
  expect(seen[seen.length - 1]).toContain("GPT-5.1");
});

test("starting a new session again while a new-session switch is still in flight stays on welcome", async () => {
  const app = await launch("multi");
  await app.waitFor("text:What are we building?");
  await app.press("id:sidebar-recents >> text:Fix QuickJS GC mark phase");
  await app.waitUntil(() => app.texts().includes("Here is the plan."));

  await app.hover("label:New session in pipi");
  await app.press("label:New session in pipi");
  await app.press("id:sidebar-new-session");
  const seen = await frames(app, () => app.texts());
  expect(seen.every((frame) => frame.includes("What are we building?"))).toBe(true);
  expect(seen.some((frame) => frame.includes("Waking Pi"))).toBe(false);
  expect(seen.some((frame) => frame.includes("No model"))).toBe(false);
});

test("sending a borderline CJK + emoji message in a settled session never flashes fold state or loses follow", async () => {
  const app = await launch("welcome");
  await app.waitFor("text:What are we building?");
  await app.press(row(REFACTOR));
  await app.waitUntil(() => shows(app, REFACTOR));
  // Let the session finish attaching so the send runs in an ordinary settled session.
  await app.wait(DELAY + 200);

  // ~200 CJK chars + ZWJ family emojis: previously overestimated >6 lines on Frame 1 (`Expand message`) before un-clamping.
  const borderline = `${"这是一段用于测试聊天气泡折行精度的中文消息文本，包含常见标点符号。".repeat(6)}${"👨‍👩‍👧‍👦".repeat(6)}`;
  await app.paste("label:Message", { text: borderline });
  await app.submit("label:Message");

  const seen = await frames(app, () => ({
    hasRefactor: shows(app, REFACTOR),
    hasSent: app.texts().some((t) => t.includes("这是一段用于测试聊天气泡折行精度的中文消息文本")),
    folded: app.shows("label:Expand message"),
    pill: app.shows("label:Scroll to bottom"),
  }));
  expect(seen.every((f) => f.hasRefactor && f.hasSent)).toBe(true);
  expect(seen.some((f) => f.folded)).toBe(false);
  expect(seen.some((f) => f.pill)).toBe(false);
});

test("welcome-to-dock first message send transitions cleanly across every frame even from a multiline draft", async () => {
  const app = await launch("welcome");
  await app.waitFor("text:What are we building?");

  const multiline = "First line of prompt\nSecond line of prompt\nThird line of prompt\nFourth line of prompt";
  await app.paste("label:Message", { text: multiline });
  await app.submit("label:Message");
  expect(app.value("label:Message") ?? "").toBe("");

  const seen = await frames(app, () => ({
    hasPrompt: app.texts().some((t) => t.includes("First line of prompt")),
    folded: app.shows("label:Expand message"),
    pill: app.shows("label:Scroll to bottom"),
    waking: app.texts().some((t) => t.includes("Waking Pi")),
  }));
  expect(seen.every((f) => f.hasPrompt)).toBe(true);
  expect(seen.some((f) => f.folded)).toBe(false);
  expect(seen.some((f) => f.pill)).toBe(false);
  expect(seen.some((f) => f.waking)).toBe(false);
});

test("switching project from the welcome project popover keeps the draft and settles cleanly", async () => {
  const app = await launch("multi");
  await app.waitFor("text:What are we building?");
  await app.press("label:Collapse nsh");
  await app.type("label:Message", "package a new build");

  await app.press("label:Project this session works in");
  await app.waitFor("text:~/code/nsh");
  await app.press("text:~/code/nsh");

  const seen = await frames(app, () => app.texts());
  expect(seen.every((frame) => frame.includes("What are we building?"))).toBe(true);
  expect(seen.some((frame) => frame.includes("Waking Pi"))).toBe(false);
  expect(app.texts()).toContain("Pi · ~/code/nsh");
  expect(app.value("label:Message")).toBe("package a new build");
});

test("opening an uncached agent's empty task session flushes the outgoing conversation and lands on welcome without flashing No model", async () => {
  const now = Date.now();
  const emptyTask = {
    id: "s_task_empty",
    title: "Gemini CLI · Fresh audit task",
    titleLocked: true,
    cwd: "/Users/pip",
    agentId: "gemini",
    agentName: "Gemini CLI",
    driver: "acp",
    initiator: "user",
    runtimeMode: "full-access",
    status: "failed",
    unread: false,
    loaded: false,
    depth: 0,
    createdAt: now - 2_000,
    lastActive: now - 2_000,
  };
  const app = await open("./Harness.tsx", {
    width: 1180,
    height: 780,
    platform: "macos",
    locale: "en-US",
    clock: {},
    storage: {
      "harness.scenario": "welcome",
      "harness.startDelay": String(DELAY),
      "harness.distinct": "1",
      "harness.daemonSessions": JSON.stringify([emptyTask]),
    },
  });
  await app.waitFor("text:What are we building?");
  await app.press(row(REFACTOR));
  await app.waitUntil(() => shows(app, REFACTOR));
  await app.wait(DELAY + 200);

  // `gemini` is uncached in `agentHasModel`, so `headFor` exercises the `leaving` -> `landHistory([])`
  // path: once settled, `REFACTOR` must be gone and Welcome must stand without flashing `No model`.
  await app.press(row("Gemini CLI · Fresh audit task"));
  const seen = await frames(app, () => ({
    old: shows(app, REFACTOR),
    welcome: app.texts().includes("What are we building?"),
    noModel: app.texts().includes("Connect a model to begin") || app.texts().includes("No model"),
  }));
  expect(seen.some((f) => f.noModel)).toBe(false);
  expect(seen.at(-1)?.old).toBe(false);
  expect(seen.at(-1)?.welcome).toBe(true);
  // And the named task keeps its own highlighted row in Recent rather than collapsing into an untitled draft.
  expect(app.count("id:sidebar-recents >> text:Gemini CLI · Fresh audit task")).toBe(1);
});

test("picking a model during a slow new-session switch updates immediately and lands on the chosen model", async () => {
  const app = await launch("multi");
  await app.waitFor("text:What are we building?");
  await app.press("id:sidebar-recents >> text:Fix QuickJS GC mark phase");
  await app.waitUntil(() => app.texts().includes("Here is the plan."));

  // Start a slow new session in another project — while the agent process is still starting, pick GPT-5.1.
  await app.hover("label:New session in pipi");
  await app.press("label:New session in pipi");
  await app.press("text:Claude Sonnet 4.5");
  await app.press("text:GPT-5.1");

  // Updates immediately on screen with no error toast, and holds once the new process finishes connecting.
  expect(app.texts()).toContain("GPT-5.1");
  expect(app.texts().some((t) => t.includes("Could not switch model"))).toBe(false);
  await app.wait(DELAY * 2);
  expect(app.texts()).toContain("GPT-5.1");
  expect(app.texts().some((t) => t.includes("Could not switch model"))).toBe(false);
});

test("cold switch with fast disk snapshot lands at steady opacity without leaving dip or Welcome Waking flash", async () => {
  // 1) Welcome -> cold saved session via `harness.then` (captures Frame 0 on the click):
  //    never flashes "Waking Pi" while the fast disk snapshot resolves.
  const app = await open("./Harness.tsx", {
    width: 1180,
    height: 780,
    platform: "macos",
    locale: "en-US",
    clock: {},
    storage: {
      "harness.scenario": "welcome",
      "harness.startDelay": String(DELAY),
      "harness.distinct": "1",
      "harness.then": "2000:/sessions/two.jsonl",
    },
  });
  await app.waitFor("text:What are we building?");
  await app.wait(1950);
  const welcomeFrames = await frames(app, () => ({
    welcome: app.texts().includes("What are we building?"),
    next: shows(app, REFACTOR),
    waking: app.texts().some((t) => t.includes("Waking Pi")),
  }));
  expect(welcomeFrames.some((f) => f.waking)).toBe(false);
  expect(welcomeFrames.some((f) => f.next)).toBe(true);
  expect(welcomeFrames.at(-1)?.next).toBe(true);

  // 2) Direct store check: Session A -> unvisited Session B with fast snapshot never sets `isLeavingSession()` true.
  const now = Date.now();
  const list = [
    { path: "/sessions/a.jsonl", id: "a", name: "Session A", firstMessage: "", messageCount: 2, created: now - 60_000, modified: now - 60_000 },
    { path: "/sessions/b.jsonl", id: "b", name: "Session B", firstMessage: "", messageCount: 2, created: now - 30_000, modified: now - 30_000 },
  ];
  useBackend(fakeBackend({ sessions: list, distinctHistories: true, startDelay: 80 }));
  await boot();
  await openSession("/sessions/a.jsonl");
  expect(transcriptRows().length).toBeGreaterThan(0);

  let everLeft = false;
  let everSnapPending = false;
  let watching = true;
  effect(() => {
    const l = isLeavingSession();
    const s = isSnapshotPending();
    if (!watching) return;
    if (l) everLeft = true;
    if (s) everSnapPending = true;
  });
  try {
    await openSession("/sessions/b.jsonl");
    expect(everSnapPending).toBe(true);
    expect(everLeft).toBe(false);
    expect(isLeavingSession()).toBe(false);
    expect(isSnapshotPending()).toBe(false);
  } finally {
    watching = false;
  }
});

test("cached switch avoids double prose rebuild, preserves session list refs, and guards chat view notifications", async () => {
  const now = Date.now();
  const list = [
    { path: "/sessions/a.jsonl", id: "a", name: "Alpha task", firstMessage: "", messageCount: 4, created: now - 60_000, modified: now - 60_000 },
    { path: "/sessions/b.jsonl", id: "b", name: "Beta task", firstMessage: "", messageCount: 4, created: now - 30_000, modified: now - 30_000 },
  ];
  useBackend(fakeBackend({ sessions: list, distinctHistories: true, startDelay: 20 }));
  await boot();
  await refreshSessions();
  await openSession("/sessions/a.jsonl");
  await openSession("/sessions/b.jsonl");

  const savedBefore = savedSessions();
  const wsBefore = workspaceSessions();
  let watching = true;
  let viewNotifications = 0;
  effect(() => {
    currentView();
    if (watching) viewNotifications++;
  });
  let keyChanges = 0;
  effect(() => {
    conversationKey();
    if (watching) keyChanges++;
  });
  viewNotifications = 0;
  keyChanges = 0;

  try {
    // Refreshing unchanged session lists preserves exact array & map references.
    await refreshSessions();
    expect(savedSessions()).toBe(savedBefore);
    expect(workspaceSessions()).toBe(wsBefore);

    // Switching back to cached Session A fires zero redundant `currentView` updates and one `conversationKey` swap.
    await openSession("/sessions/a.jsonl");
    expect(viewNotifications).toBe(0);
    expect(keyChanges).toBe(1);

    // Synchronous `enterConversation(key)` before `proseRows()` keeps exact `ProseRow` refs across subsequent reads.
    const key = conversationKey();
    enterConversation(key);
    const textRow = transcriptRows().find((r): r is Extract<typeof r, { kind: "text" }> => r.kind === "text");
    expect(textRow).toBeDefined();
    const first = proseRows(textRow!);
    const second = proseRows(textRow!);
    expect(second).toBe(first);
  } finally {
    watching = false;
  }
});

test("background-completed session invalidates stale visited cache and lands settled without streaming+idle mismatch", async () => {
  const app = await open("./Harness.tsx", {
    width: 1180,
    height: 780,
    platform: "macos",
    locale: "en-US",
    clock: {},
    storage: {
      "harness.scenario": "stream",
      "harness.startDelay": "300",
      "harness.distinct": "1",
    },
  });
  await app.waitFor("text:What are we building?");

  // Open Session A and start a multi-step streamed run.
  await app.press(row(REFACTOR));
  await app.waitUntil(() => shows(app, REFACTOR));
  await app.wait(400);
  await app.type("label:Message", "please do this in steps");
  await app.submit("label:Message");
  await app.wait(300);

  // Switch away to Session B while Session A is still streaming (stashing Session A mid-run).
  await app.press(row(NOTES));
  await app.waitUntil(() => shows(app, NOTES));

  // Wait long enough on the manual clock for Session A's ~13s streamed background run to complete on the daemon.
  await app.wait(16000);

  // Switch back to Session A: must land on the completed answer cleanly without showing a running stop button.
  await app.press(row(REFACTOR));
  const seen = await frames(app, () => ({
    hasRefactor: shows(app, REFACTOR),
    hasFinal: app.texts().some((t) => t.includes("Everything else is as it was")),
    stopping: app.shows("label:Stop"),
  }));
  expect(seen.some((f) => f.stopping)).toBe(false);
  expect(seen.every((f) => f.hasRefactor && f.hasFinal)).toBe(true);
}, 120000);

test("live streaming re-attach recovers #live mid-message, settles catch-up veils, and aligns snapshot leaf/turnMs", async () => {
  // 1) Transcript `#update` mid-stream `#live` recovery (when Pi `get_entries` omits in-flight assistant message).
  const t = new Transcript();
  t.load([{ role: "user", content: "explain it", timestamp: 1 } as never], true);
  t.apply({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Part one " } });
  t.apply({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "and two." } });
  const streamingRow = t.rows().at(-1);
  expect(streamingRow).toMatchObject({ kind: "text", text: "Part one and two.", streaming: true });
  const liveId = streamingRow!.id;
  t.apply({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Part one and two." }],
      stopReason: "stop",
      timestamp: 2,
    } as never,
  });
  expect(t.rows().filter((r) => r.kind === "text")).toHaveLength(1);
  expect(t.rows().at(-1)?.id).toBe(liveId);

  // 2) `reseedVeils` settles catch-up text on already-initialized streaming rows without 0->1 fade,
  //    while subsequent live deltas still fade smoothly.
  clearVeils();
  const v = rowVeil("live-catchup");
  beginVeilPass(v, 5, true);
  advanceElemVeil(v, "p:0", "Hello", 100);
  finishVeilPass(v);
  expect(v.initialized).toBe(true);
  reseedVeils(["live-catchup"]);
  const v2 = rowVeil("live-catchup");
  expect(v2.seeding).toBe(true);
  expect(advanceElemVeil(v2, "p:0", "Hello plus a full catch-up paragraph from landHistory", 300)).toEqual([]);
  finishVeilPass(v2);
  const nextDelta = advanceElemVeil(v2, "p:0", "Hello plus a full catch-up paragraph from landHistory and new words", 360);
  expect(nextDelta).toHaveLength(1);
  expect(nextDelta[0].start).toBe("Hello plus a full catch-up paragraph from landHistory".length);
  clearVeils();

  // 3) `parseSessionSnapshot` follows recorded `leafId` and `sameVisualRows` tolerates optional `turnMs` skew.
  const branched = [
    JSON.stringify({ type: "session", version: 3, id: "s_br", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/w", leafId: "a1" }),
    JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "q1", timestamp: 1 } }),
    JSON.stringify({ type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "chosen branch" }], stopReason: "stop", timestamp: 2 } }),
    JSON.stringify({ type: "message", id: "a2", parentId: "u1", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "assistant", content: [{ type: "text", text: "abandoned branch" }], stopReason: "stop", timestamp: 3 } }),
  ].join("\n");
  const snap = parseSessionSnapshot(branched)!;
  expect(snap.messages).toHaveLength(2);
  expect((snap.messages[1] as { content: { text: string }[] }).content[0].text).toBe("chosen branch");

  const withTurnMs = [{ kind: "text", id: "t1", text: "done", streaming: false, final: true, turnStart: true, turnMs: 1200 }] as const;
  const withoutTurnMs = [{ kind: "text", id: "t2", text: "done", streaming: false, final: true, turnStart: true }] as const;
  expect(sameVisualRows(withTurnMs, withoutTurnMs)).toBe(true);

  // 4) Headless live re-attach: leave a streaming session and return while it is still streaming;
  //    verify it continues smoothly to completion without clearing.
  const app = await open("./Harness.tsx", {
    width: 1180,
    height: 780,
    platform: "macos",
    locale: "en-US",
    clock: {},
    storage: {
      "harness.scenario": "stream",
      "harness.startDelay": "200",
      "harness.distinct": "1",
    },
  });
  await app.waitFor("text:What are we building?");
  await app.press(row(REFACTOR));
  await app.waitUntil(() => shows(app, REFACTOR));
  await app.wait(300);
  await app.type("label:Message", "please do this in steps");
  await app.submit("label:Message");
  await app.wait(250);

  await app.press(row(NOTES));
  await app.waitUntil(() => shows(app, NOTES));
  await app.wait(250);

  // Return mid-stream and confirm it stays on Session A and streams to completion.
  await app.press(row(REFACTOR));
  expect(shows(app, REFACTOR)).toBe(true);
  await app.waitUntil(() => app.texts().some((t) => t.includes("Everything else is as it was")), { timeout: 15000 });
  expect(shows(app, REFACTOR)).toBe(true);
}, 120000);
