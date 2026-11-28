import { expect, open, test, type App } from "nsh/test";

// Verifies Personal Agent (Pip SMS) bottom-follow reliability and iMessage
// CKThrowAnimationManager-style Throw + Morph send choreography:
//
// 1. Long conversation already at bottom: single send, rapid 3-message burst,
//    and Pip reply all stay 100% pinned to bottom (0 lost bottom-follow).
// 2. Scroll up -> scroll back to bottom -> send within 300ms (inside
//    INPUT_WINDOW_MS): never swallows or loses bottom-follow.
// 3. Send while scrolled up (off-bottom): smoothly returns to bottom.
// 4. Throw + Morph flight: real bubble starts at opacity 0 while floating clone
//    flies continuously from composer input origin to real bubble slot, concurrent
//    burst clones stay alive simultaneously, handoff lands within < 1pt and
//    reveals real bubble at opacity 1 with zero residual clones.
// 5. Reduced Motion and session switching cleanly skip/cancel flights; normal
//    coding sessions never launch SMS throw clones.
//
//   nsh test PipThrow.test.tsx --target macos

interface Sample {
  t: number;
  id: string;
  v: Record<string, number>;
}

const LONG_HISTORY = Array.from({ length: 14 }, (_, i) => [
  { role: "user", content: `Past message ${i + 1}: checking how the thread rests at the bottom.`, timestamp: i * 10 + 1 },
  {
    role: "assistant",
    content: [{ type: "text", text: `Reply ${i + 1}: everything is lined up cleanly and ready for the next step.` }],
    provider: "test",
    model: "test",
    timestamp: i * 10 + 2,
    stopReason: "stop",
  },
]).flat();

async function openPip(storage: Record<string, string> = {}, opts: { reducedMotion?: boolean; clock?: Record<string, never> } = {}) {
  const app = await open("./Harness.tsx", {
    width: 960,
    height: 680,
    platform: "macos",
    locale: "en-US",
    reducedMotion: opts.reducedMotion ?? false,
    ...(opts.clock ? { clock: opts.clock } : {}),
    storage: {
      "harness.scenario": "history",
      "harness.history": JSON.stringify(LONG_HISTORY),
      "harness.pace": "80",
      "harness.reply": "Got all of those — everything stayed pinned right at the bottom.",
      ...storage,
    },
  });
  await app.press("id:sidebar-pip");
  await app.waitFor("text:Reply 14: everything is lined up cleanly and ready for the next step.");
  return app;
}

const isPinnedAtBottom = (app: App, bubbleText: string) => {
  if (app.shows("label:Scroll to bottom")) return false;
  const bubble = app.layout(`text:${bubbleText}`);
  const composer = app.layout("id:composer-docked");
  if (!bubble || !composer) return false;
  // Newest bubble must sit visibly inside the viewport above the composer.
  return !bubble.hidden && bubble.y >= 44 && bubble.y + bubble.height <= composer.y + 4;
};

test("long Pip thread stays 100% pinned at bottom on single send, 3-message burst, and Pip reply", async () => {
  const app = await openPip();
  await app.wait(250);
  expect(app.shows("label:Scroll to bottom")).toBe(false);

  // Single send while already at bottom
  await app.type("label:Message", "Single check message");
  await app.submit("label:Message");
  await app.waitFor("text:Single check message");
  await app.waitUntil(() => app.count("id:pip-throw-clone") === 0, { timeout: 5000 });
  await app.wait(350);
  expect(isPinnedAtBottom(app, "Single check message")).toBe(true);

  // Wait for reply to arrive and confirm still pinned at bottom
  await app.waitFor("text:Got all of those — everything stayed pinned right at the bottom.");
  await app.wait(350);
  expect(isPinnedAtBottom(app, "Got all of those — everything stayed pinned right at the bottom.")).toBe(true);

  // Rapid 3-message burst (no Queued UI, stays pinned at bottom throughout)
  for (const msg of ["Burst alpha", "Burst beta", "Burst gamma"]) {
    await app.type("label:Message", msg);
    await app.submit("label:Message");
    await app.wait(120);
  }
  expect(app.shows("text:Queued")).toBe(false);
  await app.waitFor("text:Burst gamma");
  await app.waitUntil(() => app.count("id:pip-throw-clone") === 0, { timeout: 5000 });
  await app.wait(450);
  expect(isPinnedAtBottom(app, "Burst gamma")).toBe(true);
  expect(app.shows("label:Scroll to bottom")).toBe(false);
}, 120000);

test("scrolling back to bottom and sending within 300ms never loses bottom-follow, and sending from off-bottom returns to bottom", async () => {
  const app = await openPip();
  await app.wait(250);

  // 1. Scroll up into history, then scroll back down to bottom, then immediately send (<300ms)
  await app.scroll("label:Conversation", -320);
  await app.waitUntil(() => app.shows("label:Scroll to bottom"), { timeout: 3000 });
  await app.scroll("label:Conversation", 600);
  await app.wait(180);
  await app.type("label:Message", "Quick send after scroll back");
  await app.submit("label:Message");
  await app.waitFor("text:Quick send after scroll back");
  await app.waitUntil(() => app.count("id:pip-throw-clone") === 0, { timeout: 5000 });
  await app.wait(400);
  expect(isPinnedAtBottom(app, "Quick send after scroll back")).toBe(true);
  expect(app.shows("label:Scroll to bottom")).toBe(false);

  // 2. Scroll far up (off-bottom) and send -> must return to bottom cleanly
  await app.scroll("label:Conversation", -520);
  await app.waitUntil(() => app.shows("label:Scroll to bottom"), { timeout: 3000 });
  await app.type("label:Message", "Return from history");
  await app.submit("label:Message");
  await app.waitFor("text:Return from history");
  await app.waitUntil(() => app.count("id:pip-throw-clone") === 0, { timeout: 5000 });
  await app.wait(500);
  expect(isPinnedAtBottom(app, "Return from history")).toBe(true);
  expect(app.shows("label:Scroll to bottom")).toBe(false);
}, 120000);

test("Throw + Morph hides real bubble during flight, moves clone continuously from composer to target within < 1pt, and hands off cleanly", async () => {
  const SEND = 2400;
  const app = await open("./Harness.tsx", {
    width: 960,
    height: 680,
    platform: "macos",
    locale: "en-US",
    storage: {
      "harness.scenario": "history",
      "harness.history": JSON.stringify(LONG_HISTORY),
      "harness.pace": "120",
      "harness.trace": `${SEND - 200}:1400`,
      "harness.then": `${SEND}:send:First flying bubble;${SEND + 150}:send:Second concurrent bubble`,
    },
  });
  await app.press("id:sidebar-pip");
  await app.waitUntil(() => Boolean(app.storage()["harness.traceOut"]), { timeout: 30000 });
  const samples = JSON.parse(app.storage()["harness.traceOut"]) as Sample[];

  const rootSamples = samples.filter((s) => s.id === "throw-root" && s.v.x !== undefined);
  expect(rootSamples.length).toBeGreaterThan(0);
  const rootX = rootSamples[0].v.x;
  const rootY = rootSamples[0].v.y;

  const throwIds = [...new Set(samples.filter((s) => s.id.startsWith("throw:")).map((s) => s.id))];
  expect(throwIds.length).toBe(2);

  // Confirm both clones flew concurrently at some timestamp
  const framesWithTwoClones = new Map<number, number>();
  for (const s of samples) {
    if (s.id.startsWith("throw:")) framesWithTwoClones.set(s.t, (framesWithTwoClones.get(s.t) ?? 0) + 1);
  }
  const maxConcurrent = Math.max(...framesWithTwoClones.values());
  expect(maxConcurrent).toBe(2);

  for (const tid of throwIds) {
    const rowId = tid.slice("throw:".length);
    const flight = samples.filter((s) => s.id === tid && s.v.x !== undefined && s.v.y !== undefined);
    expect(flight.length).toBeGreaterThanOrEqual(5);

    const first = flight[0];
    const last = flight[flight.length - 1];
    // Starts in lower-left (composer input area) and moves rightward & upward toward the right-aligned bubble slot
    expect(last.v.x).toBeGreaterThan(first.v.x + 80);
    expect(last.v.y).toBeLessThan(first.v.y - 20);
    // Blue pill morph blooms monotonically from near-0 to 1
    expect(first.v.bg).toBeLessThan(0.35);
    expect(last.v.bg).toBeGreaterThan(0.98);

    // Compare clone's final frame position against the real bubble's exact measured coordinates at handoff
    const bubbleFrames = samples.filter((s) => s.id === rowId && s.v.x !== undefined && s.v.y !== undefined);
    const nearEnd = bubbleFrames.reduce((best, cur) =>
      Math.abs(cur.t - last.t) < Math.abs(best.t - last.t) ? cur : best,
    );
    const targetX = nearEnd.v.x - rootX;
    const targetY = nearEnd.v.y - rootY;
    const landErr = Math.hypot(last.v.x - targetX, last.v.y - targetY);
    console.log(`[throw ${rowId}] start=(${first.v.x},${first.v.y}) end=(${last.v.x},${last.v.y}) target=(${targetX.toFixed(1)},${targetY.toFixed(1)}) err=${landErr.toFixed(2)}pt frames=${flight.length}`);
    expect(landErr).toBeLessThan(1.0);
  }

  // After flight finishes, zero clones remain and real bubbles are at full opacity 1
  await app.waitUntil(() => app.count("id:pip-throw-clone") === 0, { timeout: 5000 });
  expect(app.count("id:pip-throw-clone")).toBe(0);
  expect(app.viewStyle("text:First flying bubble")?.effectiveOpacity ?? 1).toBe(1);
  expect(app.viewStyle("text:Second concurrent bubble")?.effectiveOpacity ?? 1).toBe(1);
}, 120000);

test("Reduced Motion skips Throw + Morph, session switch cancels in-flight clones, and coding sessions never throw", async () => {
  // 1. Reduced Motion: zero clones, immediate full opacity
  const reducedApp = await openPip({}, { reducedMotion: true, clock: {} });
  await reducedApp.type("label:Message", "Instant reduced motion send");
  await reducedApp.submit("label:Message");
  await reducedApp.waitFor("text:Instant reduced motion send");
  expect(reducedApp.count("id:pip-throw-clone")).toBe(0);
  expect(reducedApp.viewStyle("text:Instant reduced motion send")?.effectiveOpacity ?? 1).toBe(1);

  // 2. Normal motion: trigger send via harness.then (no submit quiet-wait) so we catch
  //    the clone live mid-air, verify real bubble opacity === 0, and cancel via session switch.
  const SEND = 2200;
  const app = await open("./Harness.tsx", {
    width: 960,
    height: 680,
    platform: "macos",
    locale: "en-US",
    storage: {
      "harness.scenario": "history",
      "harness.history": JSON.stringify(LONG_HISTORY),
      "harness.pace": "120",
      "harness.then": `${SEND}:send:Mid-flight check`,
    },
  });
  await app.press("id:sidebar-pip");
  await app.waitFor("text:Reply 14: everything is lined up cleanly and ready for the next step.");
  await app.waitUntil(() => app.count("id:pip-throw-clone") === 1, { timeout: 6000 });
  expect(app.count("id:pip-throw-clone")).toBe(1);
  const bubbleCount = app.count("id:message-bubble");
  const lastBubbleStyle = app.viewStyle(`id:message-bubble >> nth=${bubbleCount - 1}`);
  expect(lastBubbleStyle?.opacity).toBe(0);

  // Switch away to a normal coding session mid-flight -> clone cancels immediately
  await app.press("id:sidebar-new-session");
  await app.waitFor("text:What are we building?");
  expect(app.count("id:pip-throw-clone")).toBe(0);

  // Coding session send never launches a Pip throw clone
  await app.type("label:Message", "Ordinary coding prompt");
  await app.submit("label:Message");
  expect(app.count("id:pip-throw-clone")).toBe(0);
}, 120000);
