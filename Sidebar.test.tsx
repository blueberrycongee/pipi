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

  // Starting a new session from the collapsed folder's + button — which only
  // shows (and only answers a press) while its row sits under the pointer.
  await app.hover("label:New session in pipi");
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

  await app.hover("id:sidebar-recents-action");
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
  await app.hover("id:sidebar-recents-action");
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
  await quiet.hover("id:sidebar-recents-action");
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
  await app.hover("id:sidebar-recents-action");
  await app.press("id:sidebar-recents-action");
  await app.waitUntil(() => app.texts().includes("What are we building?"));
  await app.type("label:Message", "a task of today");
  await app.submit("label:Message");
  await frames(app, () => 0);
  expect(recent()).toEqual(titles);
});

test("a child session archives from its row in the tree, and comes back when restored", async () => {
  const app = await launch("welcome");
  await app.waitFor("text:What are we building?");
  await app.press("id:sidebar-recents >> text:Refactor the transcript reducer");
  await app.waitUntil(() => app.texts().includes("Here is the plan."));
  const roots = app.count("id:sidebar-workspaces >> label:Archive");

  await app.keyboard.press("mod+shift+o");
  await app.waitFor("text:Compare Agents");
  await app.type("label:Comparison task", "Audit security and add rate limiting");
  await app.press("text:Launch Comparison");
  const title = "Claude Code · Audit security and add rate limiting";
  const sibling = "Pi · Audit security and add rate limiting";
  await app.waitUntil(() => app.count(`id:sidebar-workspaces >> text:${title}`) === 1);
  // Its transcript is what the archive keeps: each child's row offers Archive once it has one.
  await app.waitUntil(() => app.count("id:sidebar-workspaces >> label:Archive") === roots + 3, { timeout: 20000 });

  // The children hang under the second saved row, in the order started: Pi, Claude Code, Codex.
  // The action shows (and only answers a press) while its row sits under the pointer.
  await app.hover(`id:sidebar-workspaces >> text:${title}`);
  await app.press("id:sidebar-workspaces >> label:Archive >> nth=3");
  await app.waitUntil(() => app.count(`id:sidebar-workspaces >> text:${title}`) === 0);
  // It left both trees, its siblings stay, and it is in the archive.
  expect(app.count(`id:sidebar-recents >> text:${title}`)).toBe(0);
  expect(app.count(`id:sidebar-workspaces >> text:${sibling}`)).toBe(1);
  expect(app.count(`id:sidebar-recents >> text:${sibling}`)).toBe(1);
  // In the archive it keeps the same real daemon title its tree row had.
  await app.waitFor("text:Archived");
  const saved = `id:sidebar-archived >> text:${title}`;
  if (app.count(saved) === 0) await app.press("text:Archived");
  await app.waitUntil(() => app.count(saved) === 1);

  // Restored from the archive, it hangs under its parent again.
  await app.hover(saved);
  await app.press("id:sidebar-archived >> label:Unarchive");
  await app.waitUntil(() => app.count(`id:sidebar-workspaces >> text:${title}`) === 1);
  expect(app.count(`id:sidebar-recents >> text:${title}`)).toBe(1);
  expect(app.count(saved)).toBe(0);
}, 60000);

test("a failed fileless daemon session localizes its title, opens cleanly without bleeding another session, and does not return", async () => {
  const now = Date.now();
  const zombie = {
    id: "s_zombie_1",
    title: "New session",
    cwd: "/Users/pip",
    agentId: "claude",
    agentName: "Claude Code",
    driver: "claude",
    initiator: "user",
    runtimeMode: "full-access",
    status: "interrupted",
    unread: false,
    loaded: false,
    depth: 0,
    createdAt: now - 10_000,
    lastActive: now - 10_000,
  };
  const app = await open("./Harness.tsx", {
    width: 1180,
    height: 780,
    platform: "macos",
    locale: "zh-CN",
    clock: {},
    storage: {
      "harness.scenario": "welcome",
      "harness.startDelay": String(DELAY),
      "harness.distinct": "1",
      "harness.daemonSessions": JSON.stringify([zombie]),
    },
  });
  await app.waitFor("text:今天要构建什么？");

  // Open an existing saved session first so the chat holds another conversation's messages.
  await app.press("id:sidebar-recents >> text:Refactor the transcript reducer");
  await app.waitUntil(() => app.count("label:对话 >> text:Refactor the transcript reducer") > 0);
  await app.wait(DELAY + 200);

  // In zh-CN, the untitled failed daemon row says "新会话" (never raw English "New session") and carries the alert mark.
  expect(app.texts()).not.toContain("New session");
  expect(app.count("id:sidebar-recents >> id:sidebar-child-failed")).toBe(1);

  // Clicking the failed "新会话" row must never bleed or morph into "Refactor the transcript reducer".
  await app.press("id:sidebar-recents >> text:新会话");
  const seen = await frames(app, () => ({
    leaked: app.count("label:对话 >> text:Refactor the transcript reducer") > 0,
    welcome: app.texts().includes("今天要构建什么？"),
    failedMarks: app.count("id:sidebar-recents >> id:sidebar-child-failed"),
  }));
  expect(seen.some((f) => f.leaked)).toBe(false);
  expect(seen.at(-1)?.welcome).toBe(true);
  expect(seen.every((f) => f.failedMarks === 0)).toBe(true);

  // Leaving it untouched for another session retires the recovered zombie instead of bringing the alert row back.
  await app.press("id:sidebar-recents >> text:Release notes for 0.1");
  await app.waitUntil(() => app.count("label:对话 >> text:Release notes for 0.1") > 0);
  await app.wait(DELAY + 200);
  expect(app.count("id:sidebar-recents >> id:sidebar-child-failed")).toBe(0);
  expect(app.count("id:sidebar-workspaces >> id:sidebar-child-failed")).toBe(0);
});

test("failed fileless daemon sessions (root and child) expose Archive and retire cleanly when archived", async () => {
  const now = Date.now();
  const seeded = [
    {
      id: "s_failed_root",
      title: "New session",
      cwd: "/Users/pip",
      agentId: "claude",
      agentName: "Claude Code",
      driver: "claude",
      initiator: "user",
      runtimeMode: "full-access",
      status: "failed",
      unread: false,
      loaded: false,
      depth: 0,
      createdAt: now - 5_000,
      lastActive: now - 5_000,
    },
    {
      id: "s_parent_saved",
      title: "Refactor the transcript reducer",
      cwd: "/Users/pip",
      file: "/sessions/two.jsonl",
      agentId: "pi",
      agentName: "Pi",
      driver: "pi",
      initiator: "user",
      runtimeMode: "full-access",
      status: "idle",
      unread: false,
      loaded: false,
      depth: 0,
      createdAt: now - 20_000,
      lastActive: now - 20_000,
    },
    {
      id: "s_failed_child",
      title: "Codex · Broken worktree setup",
      titleLocked: true,
      cwd: "/Users/pip",
      parentId: "s_parent_saved",
      agentId: "codex",
      agentName: "Codex",
      driver: "codex",
      initiator: "user",
      runtimeMode: "full-access",
      status: "failed",
      unread: false,
      loaded: false,
      depth: 1,
      createdAt: now - 3_000,
      lastActive: now - 3_000,
    },
  ];
  const app = await open("./Harness.tsx", {
    width: 1180,
    height: 780,
    platform: "macos",
    locale: "zh-CN",
    reducedMotion: true,
    storage: {
      "harness.scenario": "welcome",
      "harness.daemonSessions": JSON.stringify(seeded),
    },
  });
  await app.waitFor("text:今天要构建什么？");
  // Move onto a saved session so there is no open draft row sharing the "新会话" label.
  await app.press("id:sidebar-recents >> text:Look around and tell me what this project is");
  await app.waitFor("text:Here is the plan.");

  expect(app.count("id:sidebar-recents >> id:sidebar-child-failed")).toBe(2);
  expect(app.count("id:sidebar-workspaces >> id:sidebar-child-failed")).toBe(2);

  // Archive the failed fileless root row from Recent.
  await app.hover("id:sidebar-recents >> text:新会话");
  await app.press("id:sidebar-recents >> label:归档 >> nth=0");
  await app.waitUntil(() => app.count("id:sidebar-recents >> text:新会话") === 0);
  expect(app.count("id:sidebar-workspaces >> text:新会话")).toBe(0);
  expect(app.texts()).toContain("「新会话」已归档。");

  // Archive the failed fileless child row from Recent too.
  await app.hover("id:sidebar-recents >> text:Codex · Broken worktree setup");
  const childIdx = app
    .texts()
    .slice(app.texts().indexOf("最近") + 1)
    .filter((t) => ["Look around and tell me what this project is", "Refactor the transcript reducer", "Codex · Broken worktree setup"].includes(t))
    .indexOf("Codex · Broken worktree setup");
  await app.press(`id:sidebar-recents >> label:归档 >> nth=${childIdx}`);
  await app.waitUntil(() => app.count("id:sidebar-recents >> text:Codex · Broken worktree setup") === 0);
  expect(app.count("id:sidebar-workspaces >> text:Codex · Broken worktree setup")).toBe(0);
  // Fileless failed sessions have no saved transcript on disk, so they retire cleanly rather than leaving ghosts in Archived.
  expect(app.count("text:已归档")).toBe(0);
});

test("starting a new session from a saved session detaches onto a fresh draft without mutating or duplicating the saved row", async () => {
  const app = await launch("welcome");
  await app.waitFor("text:What are we building?");

  await app.press("id:sidebar-recents >> text:Refactor the transcript reducer");
  await app.waitUntil(() => app.texts().includes("Here is the plan."));

  // Pressing New session must detach into a fresh draft instead of resetting the saved session to "New session".
  await app.press("id:sidebar-new-session");
  await app.waitFor("text:What are we building?");

  expect(app.count("id:sidebar-recents >> text:Refactor the transcript reducer")).toBe(1);
  expect(app.count("id:sidebar-workspaces >> text:Refactor the transcript reducer")).toBe(1);
  expect(app.count("id:sidebar-recents >> text:New session")).toBe(1);
  expect(app.count("id:sidebar-workspaces >> text:New session")).toBe(1);

  // Sending in the new draft never replaces or duplicates the saved session.
  await app.type("label:Message", "unrelated fresh draft");
  await app.submit("label:Message");
  await app.waitUntil(() => app.count("id:sidebar-recents >> text:unrelated fresh draft") === 1);
  expect(app.count("id:sidebar-recents >> text:Refactor the transcript reducer")).toBe(1);
  expect(app.count("id:sidebar-workspaces >> text:Refactor the transcript reducer")).toBe(1);

  // Opening the saved session again still shows its intact conversation.
  await app.press("id:sidebar-recents >> text:Refactor the transcript reducer");
  await app.waitUntil(() => app.texts().includes("Here is the plan."));
});

test("Pip's delegated sessions stand beside user sessions in both groups while coding descendants stay nested", async () => {
  const now = Date.now();
  const base = {
    cwd: "/Users/pip", agentId: "pi", agentName: "Pi", driver: "pi",
    runtimeMode: "full-access", status: "idle", unread: false, loaded: true,
    createdAt: now, lastActive: now,
  };
  const app = await open("./Harness.tsx", {
    width: 1180, height: 900, platform: "macos", reducedMotion: true,
    storage: {
      "harness.scenario": "welcome",
      "harness.daemonSessions": JSON.stringify([
        { ...base, id: "s_pip", persona: true, title: "Pip", titleLocked: true, cwd: "/Users/pip/.pipi/persona", depth: 0 },
        { ...base, id: "s_saved", title: "Refactor the transcript reducer", file: "/sessions/two.jsonl", parentId: "s_pip", initiator: "s_pip", depth: 1 },
        { ...base, id: "s_job", title: "Pip delegated job", cwd: "/Users/pip/.pipi-worktrees/job", worktree: { baseCwd: "/Users/pip" }, parentId: "s_pip", initiator: "s_pip", depth: 1, status: "blocked" },
        { ...base, id: "s_nested", title: "Nested coding task", parentId: "s_saved", depth: 2, status: "failed" },
      ]),
    },
  });
  await app.waitFor("text:What are we building?");
  for (const group of ["sidebar-workspaces", "sidebar-recents"]) {
    expect(app.count(`id:${group} >> text:Refactor the transcript reducer`)).toBe(1);
    expect(app.count(`id:${group} >> text:Pip delegated job`)).toBe(1);
    expect(app.count(`id:${group} >> text:Nested coding task`)).toBe(1);
    expect(app.count(`id:${group} >> text:Pip`)).toBe(0);
    expect(app.count(`id:${group} >> id:sidebar-child-failed`)).toBe(1);
    expect(app.count(`id:${group} >> id:sidebar-child-blocked`)).toBe(1);
    const user = app.layout(`id:${group} >> text:Look around and tell me what this project is`)!;
    const saved = app.layout(`id:${group} >> text:Refactor the transcript reducer`)!;
    const job = app.layout(`id:${group} >> text:Pip delegated job`)!;
    const nested = app.layout(`id:${group} >> text:Nested coding task`)!;
    expect(saved.x).toBe(user.x);
    expect(job.x).toBe(user.x);
    expect(nested.x).toBeGreaterThan(saved.x);
  }
  await app.press("id:sidebar-recents >> text:Refactor the transcript reducer");
  await app.waitFor("text:Here is the plan.");
  await app.press("id:sidebar-pip");
  await app.waitFor("text:Hey, what's up?");
  for (const group of ["sidebar-workspaces", "sidebar-recents"]) {
    expect(app.count(`id:${group} >> text:Pip delegated job`)).toBe(1);
    expect(app.count(`id:${group} >> text:Pip`)).toBe(0);
  }
  await app.hover("id:sidebar-workspaces >> text:Refactor the transcript reducer");
  await app.press("id:sidebar-workspaces >> label:Archive >> nth=1");
  await app.waitUntil(() => app.count("id:sidebar-recents >> text:Refactor the transcript reducer") === 0);
  for (const group of ["sidebar-workspaces", "sidebar-recents"]) {
    expect(app.count(`id:${group} >> text:Nested coding task`)).toBe(0);
    expect(app.count(`id:${group} >> text:Pip delegated job`)).toBe(1);
  }
  await app.waitFor("text:Archived");
  const archived = "id:sidebar-archived >> text:Refactor the transcript reducer";
  if (!app.count(archived)) await app.press("text:Archived");
  await app.hover(archived);
  await app.press("id:sidebar-archived >> label:Unarchive");
  await app.waitUntil(() => app.count("id:sidebar-workspaces >> text:Refactor the transcript reducer") === 1);
  expect(app.count("id:sidebar-recents >> text:Nested coding task")).toBe(1);
});

test("Pip's pinned row opens the one personal agent, whose folder of notes never joins the projects", async () => {
  const app = await launch("multi");
  await app.waitFor("text:What are we building?");
  const PIP = "id:sidebar-pip >> text:Pip";
  expect(app.count(PIP)).toBe(1);
  expect(weight(app, PIP)).toBeLessThan(500);

  await app.press("id:sidebar-pip");
  await app.waitUntil(() => weight(app, PIP) > 400);
  expect(app.count("id:sidebar-workspaces >> text:persona")).toBe(0);
  expect(app.count(RECENT_DRAFT)).toBe(0);
  expect(app.count(DRAFT)).toBe(0);

  // Talking to Pip leaves it Pip, not its first words.
  await app.type("label:Message", "remember the sidebar check");
  await app.submit("label:Message");
  await app.waitFor("text:remember the sidebar check");
  expect(app.count("id:tab-0 >> text:Pip")).toBe(1);
  expect(app.count("id:tab-0 >> text:remember the sidebar check")).toBe(0);

  // Away and back: the same Pip, not a second one.
  await app.press("id:sidebar-recents >> text:Fix QuickJS GC mark phase");
  await app.waitUntil(() => weight(app, PIP) < 500 && weight(app, "id:sidebar-recents >> text:Fix QuickJS GC mark phase") > 400);
  await app.press("id:sidebar-pip");
  await app.waitUntil(() => weight(app, PIP) > 400);
  expect(app.texts().filter((t) => t.includes("already runs as"))).toEqual([]);
  expect(app.count("id:sidebar-workspaces >> text:persona")).toBe(0);

  // A new session started from Pip works in a project, not in Pip's notes.
  await app.press("id:sidebar-new-session");
  await app.type("label:Message", "work started from pip");
  await app.submit("label:Message");
  await app.waitUntil(() => app.count("id:sidebar-recents >> text:work started from pip") === 1);
  expect(app.count("id:sidebar-workspaces >> text:work started from pip")).toBe(1);
  expect(app.count("id:sidebar-workspaces >> text:persona")).toBe(0);
  expect(app.count(PIP)).toBe(1);
});

test("cross-workspace session switch preserves row hover reveal and leaves Documents and Archived untouched", async () => {
  const dir = `/tmp/pipi-sidebar-isolation-${Date.now()}`;
  const notePath = `${dir}/docs/checklist.md`;
  const app = await open("./Harness.tsx", {
    width: 1180,
    height: 780,
    platform: "macos",
    locale: "en-US",
    clock: {},
    storage: {
      "harness.scenario": "multi",
      "harness.startDelay": String(DELAY),
      "harness.dataDir": dir,
      "harness.files": JSON.stringify({ [notePath]: "# Release checklist\n\nVerify sidebar isolation.\n" }),
    },
  });
  await app.waitFor("text:What are we building?");
  await app.waitFor("id:sidebar-docs >> text:Release checklist");

  // Archive one session in pipi so the Archived section is populated and visible.
  await app.hover("id:sidebar-workspaces >> text:Release notes for 0.1");
  await app.press("id:sidebar-workspaces >> label:Archive >> nth=3");
  await app.waitFor("text:Archived");

  // Open a saved session in pipi first and let its startup settle completely.
  await app.press("id:sidebar-workspaces >> text:Refactor the transcript reducer");
  await app.waitUntil(() => app.texts().includes("Here is the plan."));
  await app.waitUntil(() => weight(app, "id:sidebar-workspaces >> text:Refactor the transcript reducer") > 400);
  await app.wait(DELAY * 2);

  // Hovering a row in nsh clears pointerResting; pressing it switches cross-workspace (pipi -> nsh).
  const nshRow = "id:sidebar-workspaces >> text:Fix QuickJS GC mark phase";
  const nshArchive = "id:sidebar-workspaces >> label:Archive >> nth=3";
  await app.hover(nshRow);
  await app.press(nshRow);
  const seen = await frames(app, () => ({
    docCount: app.count("id:sidebar-docs >> text:Release checklist"),
    docWeight: weight(app, "id:sidebar-docs >> text:Release checklist"),
    archivedHeading: app.count("text:Archived"),
    nshWeight: weight(app, nshRow),
    pipiWeight: weight(app, "id:sidebar-workspaces >> text:Refactor the transcript reducer"),
  }));

  expect(seen.every((f) => f.docCount === 1 && f.docWeight <= 400)).toBe(true);
  expect(seen.every((f) => f.archivedHeading === 1)).toBe(true);
  expect(seen.filter((f) => !(f.nshWeight > 400 && f.pipiWeight <= 400))).toEqual([]);

  // Without re-hovering, the hover-only Archive action on the clicked nsh row remains interactive
  // (pointerResting stayed false because rowSignature did not change across the cross-workspace switch).
  await app.press(nshArchive);
  await app.waitUntil(() => app.count(nshRow) === 0);
  expect(app.count("id:sidebar-docs >> text:Release checklist")).toBe(1);
});

test("collapsed workspace running dot stays steady across every 16ms frame during a saved-session switch", async () => {
  const app = await open("./Harness.tsx", {
    width: 1180,
    height: 780,
    platform: "macos",
    locale: "en-US",
    clock: {},
    storage: {
      "harness.scenario": "multi-slow",
      "harness.startDelay": String(DELAY),
      "harness.distinct": "1",
    },
  });
  await app.waitFor("text:What are we building?");

  // Tab 0: open a saved pipi session that will go cold once we switch away.
  await app.press("id:sidebar-workspaces >> text:Look around and tell me what this project is");
  await app.waitUntil(() => weight(app, "id:sidebar-workspaces >> text:Look around and tell me what this project is") > 400);

  // Tab 1: open another pipi session in a new tab and start a long background run.
  await app.rightClick("id:sidebar-workspaces >> text:Refactor the transcript reducer");
  await app.chooseMenuItem("Open in New Tab");
  await app.waitFor("id:tab-1");
  await app.waitUntil(() => weight(app, "id:sidebar-workspaces >> text:Refactor the transcript reducer") > 400);
  await app.type("label:Message", "long work in pipi");
  await app.submit("label:Message");
  await app.waitUntil(() => app.count("id:sidebar-recents >> id:sidebar-session-running") === 1);

  // Tab 2: open an nsh session in a new tab so pipi's run is parked in the background.
  await app.rightClick("id:sidebar-workspaces >> text:Fix QuickJS GC mark phase");
  await app.chooseMenuItem("Open in New Tab");
  await app.waitFor("id:tab-2");
  await app.waitUntil(() => weight(app, "id:sidebar-workspaces >> text:Fix QuickJS GC mark phase") > 400);

  // Collapse both pipi and Recent so the collapsed pipi folder row carries the running dot.
  await app.press("label:Collapse pipi");
  await app.press("label:Collapse Recent");
  await app.waitUntil(() => app.count("id:sidebar-project-running") === 1);

  // Switch back to Tab 0 (cold saved session in pipi): startingHere must not hide the collapsed running dot.
  await app.press("id:tab-0");
  const seen = await frames(app, () => ({
    runningDot: app.count("id:sidebar-project-running"),
    pipiCollapsed: app.count("label:Expand pipi"),
    recentsCollapsed: app.count("label:Expand Recent"),
  }));

  expect(seen.every((f) => f.runningDot === 1)).toBe(true);
  expect(seen.every((f) => f.pipiCollapsed === 1 && f.recentsCollapsed === 1)).toBe(true);
});

test("a worktree delegation is live under its real project at once, with protocol envelopes never becoming titles", async () => {
  const now = Date.now();
  const baseCwd = "/Users/pip/code/pipi";
  const worktreeCwd = "/Users/pip/code/.pipi-worktrees/pipi/pip-live-task";
  const envelope = (body: string) => `<pipi-message from="s_pip" title="Pip" agent="Pi" status="idle">\n${body}\n</pipi-message>`;
  const summaries = [
    {
      path: "/sessions/delegated.jsonl",
      id: "delegated",
      firstMessage: envelope("Envelope body should not lead"),
      messageCount: 3,
      created: now - 2_000,
      modified: now - 2_000,
    },
    {
      path: "/sessions/legacy.jsonl",
      id: "legacy",
      firstMessage: envelope("Legacy readable task"),
      messageCount: 2,
      created: now - 3_000,
      modified: now - 3_000,
    },
  ];
  const base = {
    agentId: "pi",
    agentName: "Pi",
    driver: "pi",
    runtimeMode: "full-access",
    unread: false,
    loaded: true,
  };
  const seeded = [
    {
      ...base,
      id: "s_pip",
      persona: true,
      title: "Pip",
      titleLocked: true,
      cwd: "/Users/pip/.pipi/persona",
      status: "idle",
      depth: 0,
      createdAt: now - 10_000,
      lastActive: now - 10_000,
    },
    {
      ...base,
      id: "s_delegated_file",
      title: "Delegated registry title",
      titleLocked: true,
      cwd: baseCwd,
      file: "/sessions/delegated.jsonl",
      parentId: "s_pip",
      initiator: "s_pip",
      status: "idle",
      depth: 1,
      createdAt: now - 1_000,
      lastActive: now - 1_000,
    },
    {
      ...base,
      id: "s_legacy_registry",
      title: envelope("Registry envelope task"),
      titleLocked: true,
      cwd: baseCwd,
      parentId: "s_pip",
      initiator: "s_pip",
      status: "idle",
      depth: 1,
      createdAt: now - 500,
      lastActive: now - 500,
    },
    {
      ...base,
      id: "s_live_worktree",
      title: "Live worktree task",
      titleLocked: true,
      cwd: worktreeCwd,
      // Old daemon registry entries have no baseCwd here: the path itself must still file the task under pipi.
      worktree: { path: worktreeCwd, branch: "pipi/live-task" },
      parentId: "s_pip",
      initiator: "s_pip",
      status: "working",
      depth: 1,
      createdAt: now,
      lastActive: now,
    },
  ];
  const app = await open("./Harness.tsx", {
    width: 1180,
    height: 900,
    platform: "macos",
    locale: "en-US",
    reducedMotion: true,
    storage: {
      "harness.scenario": "multi",
      "harness.sessions": JSON.stringify(summaries),
      "harness.daemonSessions": JSON.stringify(seeded),
    },
  });
  await app.waitFor("text:What are we building?");

  for (const group of ["sidebar-recents", "sidebar-workspaces"]) {
    expect(app.count(`id:${group} >> text:Live worktree task`)).toBe(1);
    expect(app.count(`id:${group} >> text:Delegated registry title`)).toBe(1);
    expect(app.count(`id:${group} >> text:Registry envelope task`)).toBe(1);
    expect(app.count(`id:${group} >> text:Legacy readable task`)).toBe(1);
    expect(app.count(`id:${group} >> id:sidebar-child-running`)).toBeGreaterThan(0);
  }
  const liveRecent = app.layout("id:sidebar-recents >> text:Live worktree task")!;
  const legacyRecent = app.layout("id:sidebar-recents >> text:Legacy readable task")!;
  const registryRecent = app.layout("id:sidebar-recents >> text:Registry envelope task")!;
  const liveWorkspace = app.layout("id:sidebar-workspaces >> text:Live worktree task")!;
  const registryWorkspace = app.layout("id:sidebar-workspaces >> text:Registry envelope task")!;
  const legacyWorkspace = app.layout("id:sidebar-workspaces >> text:Legacy readable task")!;
  expect(liveRecent.y).toBeLessThan(registryRecent.y);
  expect(liveRecent.y).toBeLessThan(legacyRecent.y);
  expect(liveWorkspace.y).toBeLessThan(registryWorkspace.y);
  expect(liveWorkspace.y).toBeLessThan(legacyWorkspace.y);
  expect(app.texts().some((text) => text.includes("<pipi-message"))).toBe(false);
  expect(app.texts()).not.toContain("Envelope body should not lead");
  expect(app.texts()).not.toContain("pip-live-task");
  expect(JSON.parse(app.storage()["pipi.prefs.v1"] ?? "{}").workspaces ?? []).not.toContain(worktreeCwd);

  // Opening the fileless worktree session attaches in its checkout, but the
  // project list still records only the repository it belongs to.
  await app.press("id:sidebar-recents >> text:Live worktree task");
  await app.waitUntil(() => app.count("id:tab-0 >> text:Live worktree task") === 1);
  const workspaces = JSON.parse(app.storage()["pipi.prefs.v1"] ?? "{}").workspaces ?? [];
  expect(workspaces).toContain(baseCwd);
  expect(workspaces.some((path: string) => path.includes("/.pipi-worktrees/"))).toBe(false);
  expect(app.texts()).not.toContain("pip-live-task");
});
