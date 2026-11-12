import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

// Session changes restart or reload an agent, which real CLIs take a while to
// do; the sidebar must go straight from where it was to where it lands, with
// no half-started state in between. On a manual clock, each test reads the
// sidebar frame by frame through the change (`open` and `press` run the clock
// some 400ms on their own, so the delay is longer than that).

const DELAY = 1500;

const launch = (scenario: string) =>
  open("./Harness.tsx", {
    width: 1180,
    height: 780,
    platform: "macos",
    locale: "en-US",
    clock: {},
    storage: { "harness.scenario": scenario, "harness.startDelay": String(DELAY) },
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

const DRAFT = "id:sidebar-workspaces >> text:New session";
const RECENT_DRAFT = "id:sidebar-recents >> text:New session";
const weight = (app: App, selector: string) => (app.count(selector) ? app.spanStyle(selector).fontWeight : 0);

test("switching the engine keeps the open draft's row in place", async () => {
  const app = await launch("welcome");
  await app.waitFor("text:What are we building?");
  await app.waitUntil(() => app.count(DRAFT) === 1);

  await app.press("id:agent-chip");
  await app.waitFor("id:agent-picker");
  await app.press("id:agent-picker >> text:Claude Code");
  const drafts = await frames(app, () => app.count(DRAFT));

  expect(drafts.every((count) => count === 1)).toBe(true);
  expect(app.texts()).toContain("Claude Code · ~");
});

test("opening a recent session in another folder goes straight to it", async () => {
  const app = await launch("multi");
  await app.waitFor("text:What are we building?");
  const target = "id:sidebar-recents >> text:Fix QuickJS GC mark phase";

  await app.press(target);
  const seen = await frames(app, () => ({ drafts: app.count(DRAFT), weight: weight(app, target) }));

  // No passing draft row while the new process starts, and the clicked row is marked from the first frame.
  expect(seen.every((frame) => frame.drafts === 0)).toBe(true);
  expect(seen.every((frame) => frame.weight > 400)).toBe(true);
  expect(app.texts()).toContain("Here is the plan.");
});

test("opening a session in another folder shows no passing state in the chat", async () => {
  const app = await launch("multi");
  await app.waitFor("text:What are we building?");

  await app.press("id:sidebar-recents >> text:Fix QuickJS GC mark phase");
  const seen = await frames(app, () => app.texts());

  const passing = ["What are we building?", "Connect a model to begin", "Pi is not running", "Connect a model provider to start"];
  expect(passing.filter((text) => seen.some((frame) => frame.includes(text)))).toEqual([]);
  // The title bar names the destination from the first frame (the sidebar's button says "New session" throughout).
  const untitled = (frame: string[]) => frame.filter((text) => text === "New session").length;
  expect(seen.filter((frame) => untitled(frame) > untitled(app.texts())).length).toBe(0);
  expect(app.texts()).toContain("Here is the plan.");
});

test("opening a session from Recent leaves the current one's mark where it is", async () => {
  const app = await launch("welcome");
  await app.waitFor("text:What are we building?");
  await app.press("id:sidebar-workspaces >> text:Refactor the transcript reducer");
  await app.waitFor("text:Here is the plan.");
  await app.waitUntil(() => weight(app, "id:sidebar-workspaces >> text:Refactor the transcript reducer") > 400);

  await app.press("id:sidebar-recents >> text:Look around and tell me what this project is");
  const seen = await frames(app, () => weight(app, "id:sidebar-recents >> text:Refactor the transcript reducer"));

  expect(seen.every((w) => w <= 400)).toBe(true);
  expect(weight(app, "id:sidebar-recents >> text:Look around and tell me what this project is")).toBeGreaterThan(400);
});

test("starting a new session lists and marks the draft under Recent", async () => {
  const app = await launch("multi");
  await app.waitFor("text:What are we building?");
  expect(app.count(RECENT_DRAFT)).toBe(1);

  // With the active project collapsed, Recent's draft row carries the active mark.
  await app.press("label:Collapse pipi");
  await app.waitUntil(() => app.count(DRAFT) === 0);
  expect(app.count(RECENT_DRAFT)).toBe(1);
  expect(weight(app, RECENT_DRAFT)).toBeGreaterThan(400);

  // Opening a recent session clears the draft row; starting a new session puts it right back at the top of Recent.
  await app.press("id:sidebar-recents >> text:Fix QuickJS GC mark phase");
  await app.waitUntil(() => app.texts().includes("Here is the plan."));
  expect(app.count(RECENT_DRAFT)).toBe(0);

  await app.press("id:sidebar-new-session");
  await app.waitUntil(() => app.texts().includes("What are we building?"));
  expect(app.count(RECENT_DRAFT)).toBe(1);
  expect(weight(app, RECENT_DRAFT)).toBeGreaterThan(400);
});

test("clicking New session in a collapsed folder leaves it collapsed and lists draft under Recent", async () => {
  const app = await launch("multi");
  await app.waitFor("text:What are we building?");

  // Collapse pipi
  await app.press("label:Collapse pipi");
  await app.waitUntil(() => app.count(DRAFT) === 0);

  // Open a saved session
  await app.press("id:sidebar-recents >> text:Fix QuickJS GC mark phase");
  await app.waitUntil(() => app.texts().includes("Here is the plan."));
  expect(app.count(RECENT_DRAFT)).toBe(0);

  // Starting a new session from the collapsed folder's + button
  await app.press("label:New session in pipi");
  await app.waitUntil(() => app.texts().includes("What are we building?"));

  // The folder remains collapsed (no draft in workspaces)
  expect(app.count(DRAFT)).toBe(0);
  expect(app.count("label:Expand pipi")).toBe(1);
  // And the draft appears under Recent
  expect(app.count(RECENT_DRAFT)).toBe(1);
  expect(weight(app, RECENT_DRAFT)).toBeGreaterThan(400);
});

test("Recent's own New session action highlights Recent's draft and keeps it once saved", async () => {
  const app = await launch("welcome");
  await app.waitFor("text:What are we building?");
  await app.press("id:sidebar-workspaces >> text:Refactor the transcript reducer");
  await app.waitUntil(() => app.texts().includes("Here is the plan."));

  await app.press("id:sidebar-recents-action");
  await app.waitUntil(() => app.texts().includes("What are we building?"));
  expect(weight(app, RECENT_DRAFT)).toBeGreaterThan(400);
  expect(weight(app, DRAFT)).toBeLessThanOrEqual(400);

  await app.type("label:Message", "brand new recent task");
  await app.submit("label:Message");
  await app.waitUntil(() => app.texts().includes("Steps"));
  // Graduating from draft to saved swaps in place immediately with no duplicate row.
  expect(app.count("id:sidebar-recents >> text:brand new recent task")).toBe(1);
  expect(weight(app, "id:sidebar-recents >> text:brand new recent task")).toBeGreaterThan(400);
  expect(weight(app, "id:sidebar-workspaces >> text:brand new recent task")).toBeLessThanOrEqual(400);
});

test("reopening a draft while its reveal is closing keeps the draft row alive", async () => {
  const app = await open("./Harness.tsx", {
    width: 1180,
    height: 780,
    platform: "macos",
    locale: "en-US",
    clock: {},
    storage: { "harness.scenario": "welcome" },
  });
  await app.waitFor("text:What are we building?");
  expect(app.count(RECENT_DRAFT)).toBe(1);

  // Abandon the draft (starts ~265ms close reveal), then re-create a draft mid-close (at 80ms)
  // and advance past the original close timeout (400ms): the draft row must stay open.
  await app.press("id:sidebar-recents >> text:Refactor the transcript reducer");
  await app.wait(80);
  await app.press("id:sidebar-recents-action");
  await app.wait(400);
  expect(app.count(RECENT_DRAFT)).toBe(1);
  expect(weight(app, RECENT_DRAFT)).toBeGreaterThan(400);

  // Reduced motion also opens and closes the draft cleanly.
  const quiet = await open("./Harness.tsx", {
    width: 1180,
    height: 780,
    platform: "macos",
    locale: "en-US",
    reducedMotion: true,
    storage: { "harness.scenario": "welcome" },
  });
  await quiet.waitFor("text:What are we building?");
  expect(quiet.count(RECENT_DRAFT)).toBe(1);
  await quiet.press("id:sidebar-recents >> text:Refactor the transcript reducer");
  expect(quiet.count(RECENT_DRAFT)).toBe(0);
  await quiet.press("id:sidebar-recents-action");
  expect(quiet.count(RECENT_DRAFT)).toBe(1);
});

test("only the running session row shows Pip unless both its folder and Recent are folded", async () => {
  const app = await open("./Harness.tsx", {
    width: 1180,
    height: 780,
    platform: "macos",
    locale: "en-US",
    clock: {},
    storage: { "harness.scenario": "multi-slow" },
  });
  await app.waitFor("text:What are we building?");
  expect(app.count("id:sidebar-project-running")).toBe(0);
  expect(app.count("id:sidebar-draft-running")).toBe(0);
  expect(app.count("id:sidebar-session-running")).toBe(0);

  await app.type("label:Message", "check alignment");
  await app.submit("label:Message");
  expect(app.count("id:sidebar-draft-running")).toBe(1);
  // Expanded active folder and inactive folders never duplicate Pip.
  expect(app.count("id:sidebar-project-running")).toBe(0);

  // Folding both the active folder and Recent hands the running Pip up to the folded project row.
  await app.press("label:Collapse pipi");
  await app.press("label:Collapse Recent");
  expect(app.count("id:sidebar-project-running")).toBe(1);
});
