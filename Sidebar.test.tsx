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

  // What was on screen stays (dimmed) until the destination lands; nothing else passes through.
  const passing = ["Connect a model to begin", "Pi is not running", "Connect a model provider to start", "No model"];
  expect(passing.filter((text) => seen.some((frame) => frame.includes(text)))).toEqual([]);
  expect(app.texts()).not.toContain("What are we building?");
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

test("a running session shows Pip on every row it has unless both its folder and Recent are folded", async () => {
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

  // A "long" run streams for far longer than any action below can possibly pump.
  await app.type("label:Message", "long check alignment");
  await app.submit("label:Message");
  // The draft's folder row and its Recent row both carry the mark.
  expect(app.count("id:sidebar-draft-running")).toBe(2);
  // Expanded active folder and inactive folders never duplicate Pip.
  expect(app.count("id:sidebar-project-running")).toBe(0);

  // Folding both the active folder and Recent hands the running Pip up to the folded project row.
  await app.press("label:Collapse pipi");
  await app.press("label:Collapse Recent");
  expect(app.count("id:sidebar-project-running")).toBe(1);
});

test("a run parked by a session switch keeps its mark on every row the session has", async () => {
  const app = await open("./Harness.tsx", {
    width: 1180,
    height: 780,
    platform: "macos",
    locale: "en-US",
    clock: {},
    storage: { "harness.scenario": "multi-slow" },
  });
  await app.waitFor("text:What are we building?");

  // Open a session from Recent and set it working. Recent owns the highlight,
  // but the on-screen run still marks the session's folder row as well.
  await app.press("id:sidebar-recents >> text:Refactor the transcript reducer");
  await app.waitUntil(() => app.texts().includes("Here is the plan."));
  await app.type("label:Message", "keep working in the background");
  await app.submit("label:Message");
  await app.waitUntil(() => app.count("id:sidebar-recents >> id:sidebar-session-running") === 1);
  expect(app.count("id:sidebar-workspaces >> id:sidebar-session-running")).toBe(1);

  // Switching away through the folder parks the run; the session's folder row
  // and its Recent row both keep the running mark.
  await app.press("id:sidebar-workspaces >> text:Look around and tell me what this project is");
  await app.waitUntil(() => app.count("id:sidebar-workspaces >> id:sidebar-session-running") === 1);
  expect(app.count("id:sidebar-recents >> id:sidebar-session-running")).toBe(1);
  expect(app.count("id:sidebar-workspaces >> id:sidebar-session-running")).toBe(1);
});

test("a folded project row marks a run still working inside, whichever project is open", async () => {
  const app = await open("./Harness.tsx", {
    width: 1180,
    height: 780,
    platform: "macos",
    locale: "en-US",
    clock: {},
    storage: { "harness.scenario": "multi-slow" },
  });
  await app.waitFor("text:What are we building?");

  // A run in pipi is parked when a session in another folder takes the screen.
  await app.press("id:sidebar-recents >> text:Refactor the transcript reducer");
  await app.waitUntil(() => app.texts().includes("Here is the plan."));
  await app.type("label:Message", "keep working in the background");
  await app.submit("label:Message");
  await app.waitUntil(() => app.count("id:sidebar-recents >> id:sidebar-session-running") === 1);
  await app.press("id:sidebar-workspaces >> text:Fix QuickJS GC mark phase");
  await app.waitUntil(() => app.count("id:sidebar-workspaces >> id:sidebar-session-running") === 1);

  // Fold its folder and Recent: the folded project row still says the run is on,
  // even though pipi is not the open workspace.
  await app.press("label:Collapse pipi");
  await app.press("label:Collapse Recent");
  expect(app.count("id:sidebar-project-running")).toBe(1);
});

test("switching between two running sessions across collapsed workspaces keeps both folders collapsed", async () => {
  const switchDelay = 600;
  const app = await open("./Harness.tsx", {
    width: 1180,
    height: 780,
    platform: "macos",
    locale: "en-US",
    clock: {},
    storage: { "harness.scenario": "multi-slow", "harness.startDelay": String(switchDelay) },
  });
  await app.waitFor("text:What are we building?");

  const pipiSession = "id:sidebar-recents >> text:Refactor the transcript reducer";
  const nshSession = "id:sidebar-recents >> text:Fix QuickJS GC mark phase";

  // Start a long run in pipi, then switch to nsh and start a second long run there.
  await app.press(pipiSession);
  await app.waitUntil(() => app.texts().includes("Here is the plan."));
  await app.type("label:Message", "long work in pipi");
  await app.submit("label:Message");
  await app.waitUntil(() => app.count("id:sidebar-recents >> id:sidebar-session-running") === 1);

  await app.press(nshSession);
  await app.waitUntil(() => app.texts().includes("Here is the plan."));
  await app.type("label:Message", "long work in nsh");
  await app.submit("label:Message");
  await app.waitUntil(() => app.count("id:sidebar-recents >> id:sidebar-session-running") === 2);

  // Collapse both workspaces in the sidebar.
  await app.press("label:Collapse pipi");
  await app.press("label:Collapse nsh");
  await app.waitUntil(() => app.count("id:sidebar-workspaces >> text:Refactor the transcript reducer") === 0);
  await app.waitUntil(() => app.count("id:sidebar-workspaces >> text:Fix QuickJS GC mark phase") === 0);

  const probe = () => ({
    pipiCollapsed: app.count("label:Expand pipi"),
    nshCollapsed: app.count("label:Expand nsh"),
    workspaceRows:
      app.count("id:sidebar-workspaces >> text:Refactor the transcript reducer") +
      app.count("id:sidebar-workspaces >> text:Fix QuickJS GC mark phase"),
    recentRunning: app.count("id:sidebar-recents >> id:sidebar-session-running"),
    pipiWeight: weight(app, pipiSession),
    nshWeight: weight(app, nshSession),
  });

  // Switch from nsh's running session to pipi's running session.
  await app.press(pipiSession);
  const toPipi = [probe()];
  for (let elapsed = 0; elapsed < switchDelay * 2; elapsed += 16) {
    await app.wait(16);
    toPipi.push(probe());
  }
  expect(toPipi.every((f) => f.pipiCollapsed === 1 && f.nshCollapsed === 1 && f.workspaceRows === 0)).toBe(true);
  expect(toPipi.every((f) => f.recentRunning === 2)).toBe(true);
  expect(toPipi.every((f) => f.pipiWeight > 400 && f.nshWeight <= 400)).toBe(true);

  // Switch right back to nsh's running session: both folders still stay collapsed.
  await app.press(nshSession);
  const toNsh = [probe()];
  for (let elapsed = 0; elapsed < switchDelay * 2; elapsed += 16) {
    await app.wait(16);
    toNsh.push(probe());
  }
  expect(toNsh.every((f) => f.pipiCollapsed === 1 && f.nshCollapsed === 1 && f.workspaceRows === 0)).toBe(true);
  expect(toNsh.every((f) => f.recentRunning === 2)).toBe(true);
  expect(toNsh.every((f) => f.nshWeight > 400 && f.pipiWeight <= 400)).toBe(true);
});

test("sessions a draft started nest under its row in Recent too", async () => {
  const app = await launch("welcome");
  await app.waitFor("text:What are we building?");

  // The compare sheet starts sibling sessions under the open one — the draft here.
  await app.keyboard.press("mod+shift+o");
  await app.waitFor("text:Compare Agents");
  await app.type("label:Comparison task", "Audit security and add rate limiting");
  await app.press("text:Launch Comparison");
  await app.waitUntil(() => app.count("id:sidebar-workspaces >> text:Pi · Audit security and add rate limiting") === 1);

  // The same tree nests under Recent's draft row — one row in each group.
  expect(app.count("id:sidebar-recents >> text:Pi · Audit security and add rate limiting")).toBe(1);
  expect(app.count("id:sidebar-recents >> text:Claude Code · Audit security and add rate limiting")).toBe(1);
  expect(app.count("id:sidebar-recents >> text:Codex · Audit security and add rate limiting")).toBe(1);
});

test("children of a saved session nest under its row in Recent too", async () => {
  const app = await launch("welcome");
  await app.waitFor("text:What are we building?");
  await app.press("id:sidebar-recents >> text:Refactor the transcript reducer");
  await app.waitUntil(() => app.texts().includes("Here is the plan."));

  await app.keyboard.press("mod+shift+o");
  await app.waitFor("text:Compare Agents");
  await app.type("label:Comparison task", "Audit security and add rate limiting");
  await app.press("text:Launch Comparison");
  await app.waitUntil(() => app.count("id:sidebar-recents >> text:Pi · Audit security and add rate limiting") === 1);

  // The children hang under the parent's row in both groups, marks and all.
  expect(app.count("id:sidebar-workspaces >> text:Pi · Audit security and add rate limiting")).toBe(1);
  await app.waitUntil(() => app.count("id:sidebar-recents >> id:sidebar-child-unread") >= 3);
  expect(app.count("id:sidebar-workspaces >> id:sidebar-child-unread")).toBeGreaterThanOrEqual(3);
});

test("a session in Recent keeps its place when it takes a message; only a new one goes on top", async () => {
  const app = await launch("welcome");
  await app.waitFor("text:What are we building?");
  const saved = [
    "Look around and tell me what this project is",
    "Refactor the transcript reducer",
    "Why does the build fail on Linux?",
    "Release notes for 0.1",
  ];
  const titles = ["a task of today", ...saved];
  /** Recent's session rows, top to bottom: the texts after its heading, which the chat's follow. */
  const recent = () => {
    const texts = app.texts();
    const rows = texts.slice(texts.indexOf("Recent") + 1);
    return titles.filter((title) => rows.includes(title)).sort((a, b) => rows.indexOf(a) - rows.indexOf(b));
  };
  expect(recent()).toEqual(saved);

  // The oldest session takes a message: its last activity is now the newest of all.
  await app.press("id:sidebar-recents >> text:Release notes for 0.1");
  await app.waitUntil(() => app.texts().includes("Here is the plan."));
  await app.type("label:Message", "one more note");
  await app.submit("label:Message");
  const orders = await frames(app, () => recent().join(" | "));
  expect(orders.every((order) => order === saved.join(" | "))).toBe(true);

  // A session the list has not shown before lands on top, where its draft row was.
  await app.press("id:sidebar-recents-action");
  await app.waitUntil(() => app.texts().includes("What are we building?"));
  await app.type("label:Message", "a task of today");
  await app.submit("label:Message");
  await frames(app, () => 0);
  expect(recent()).toEqual(titles);
});
