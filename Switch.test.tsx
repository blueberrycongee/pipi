import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

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
