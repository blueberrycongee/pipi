import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

// A session change answers the click, not the agent. On a manual clock with
// agents as slow as real CLIs (`harness.startDelay`), each test reads the chat
// from the press on: what can be shown is shown at once, and what cannot
// leaves the screen as it was until the destination lands.
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

test("a conversation not seen yet keeps the screen as it was until it lands", async () => {
  const app = await launch("welcome");
  await app.waitFor("text:What are we building?");
  await app.press(row(REFACTOR));
  await app.waitUntil(() => shows(app, REFACTOR));

  await app.press(row(NOTES));
  const seen = await frames(app, () => ({ old: shows(app, REFACTOR), next: shows(app, NOTES), texts: app.texts() }));

  // Never both, and nothing in between but the frame the list takes to mount the rows it was handed.
  expect(seen.some((frame) => frame.old && frame.next)).toBe(false);
  expect(seen.filter((frame) => !frame.old && !frame.next).length).toBeLessThanOrEqual(1);
  expect(seen[0].old).toBe(true);
  expect(seen[seen.length - 1].next).toBe(true);
  expect(seen.some((frame) => frame.texts.includes("What are we building?"))).toBe(false);
});

test("a new session's empty chat is on screen with the click, in another project too", async () => {
  const app = await launch("multi");
  await app.waitFor("text:What are we building?");
  await app.press("id:sidebar-recents >> text:Fix QuickJS GC mark phase");
  await app.waitUntil(() => app.texts().includes("Here is the plan."));

  // Another project means another agent process: the chat does not wait for it.
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
  expect(shows(app, REFACTOR)).toBe(false);
  await app.type("label:Message", "and then what");
  await app.submit("label:Message");
  await app.waitUntil(() => app.texts().includes("and then what"), { timeout: DELAY * 4 });
  expect(shows(app, REFACTOR)).toBe(true);
});
