import { expect, open, test } from "nsh/test";
import type { OpenOptions } from "nsh/test";

const runningDaemonSession = () => {
  const now = Date.now();
  return {
    id: "s_active_run",
    title: "Background build task",
    titleLocked: true,
    cwd: "/Users/pip/code/pipi",
    agentId: "pi",
    agentName: "Pi",
    driver: "pi",
    initiator: "user",
    runtimeMode: "full-access",
    status: "working",
    unread: false,
    loaded: true,
    depth: 0,
    createdAt: now - 5_000,
    lastActive: now - 1_000,
  };
};

const launch = (options: OpenOptions = {}) =>
  open("./Harness.tsx", {
    width: 1180,
    height: 780,
    platform: "macos",
    locale: "en-US",
    storage: { "harness.scenario": "welcome" },
    ...options,
  });

test("macOS close hides the main window and reopen restores it with live state intact", async () => {
  const app = await launch();
  await app.waitFor("text:What are we building?");
  await app.type("label:Message", "keep this draft across hide and reopen");
  expect(app.value("label:Message")).toBe("keep this draft across hide and reopen");

  const main = app.window("main");
  expect(main.state()?.visible).toBe(true);

  await main.pressClose();
  expect(app.quit()).toBe(false);
  expect(app.windowIds()).toContain("main");
  expect(main.state()?.visible).toBe(false);

  await app.reopen();
  expect(app.quit()).toBe(false);
  expect(main.state()?.visible).toBe(true);
  expect(main.state()?.focused).toBe(true);
  expect(app.value("label:Message")).toBe("keep this draft across hide and reopen");
});

test("macOS close hides while sessions run, and quitRequest reveals the window to confirm", async () => {
  const app = await launch({
    storage: {
      "harness.scenario": "welcome",
      "harness.daemonSessions": JSON.stringify([runningDaemonSession()]),
    },
  });
  await app.waitFor("text:What are we building?");

  const main = app.window("main");
  // Closing the window on macOS hides it without stopping runs, prompting, or quitting.
  await main.pressClose();
  expect(app.quit()).toBe(false);
  expect(main.state()?.visible).toBe(false);
  expect(app.dialogs().length).toBe(0);

  // Triggering Quit while hidden brings the window back and shows the confirmation dialog.
  // Cancelling keeps the app alive.
  app.onDialog(() => "Cancel");
  await app.quitRequest();
  await app.waitUntil(() => app.dialogs().length === 1);
  expect(app.dialogs()[0]?.title).toBe("1 session is still running.");
  expect(main.state()?.visible).toBe(true);
  expect(app.quit()).toBe(false);

  // Choosing "Keep Running in Background" approves the quit request, persists the preference, and exits.
  app.onDialog(() => "Keep Running in Background");
  await app.quitRequest();
  await app.waitUntil(() => app.quit());
  expect(app.dialogs().length).toBe(2);
  expect(app.quit()).toBe(true);
  const stored = JSON.parse(app.storage()["pipi.prefs.v1"] ?? "{}") as { runInBackground?: boolean };
  expect(stored.runInBackground).toBe(true);
});

test("macOS quitRequest exits cleanly when no daemon session is active", async () => {
  const app = await launch();
  await app.waitFor("text:What are we building?");
  await app.quitRequest();
  await app.waitUntil(() => app.quit());
  expect(app.quit()).toBe(true);
});

test("Windows close quits when idle and confirms when a daemon session is active", async () => {
  const idle = await launch({ platform: "windows" });
  await idle.waitFor("text:What are we building?");
  await idle.window("main").pressClose();
  await idle.waitUntil(() => idle.quit());
  expect(idle.quit()).toBe(true);

  const busy = await launch({
    platform: "windows",
    storage: {
      "harness.scenario": "welcome",
      "harness.daemonSessions": JSON.stringify([runningDaemonSession()]),
    },
  });
  await busy.waitFor("text:What are we building?");

  // Cancelling close keeps the Windows window open.
  busy.onDialog(() => "Cancel");
  await busy.window("main").pressClose();
  await busy.waitUntil(() => busy.dialogs().length === 1);
  expect(busy.dialogs()[0]?.title).toBe("1 session is still running.");
  expect(busy.quit()).toBe(false);

  // Stopping all sessions closes the window and exits.
  busy.onDialog(() => "Stop All & Quit");
  await busy.window("main").pressClose();
  await busy.waitUntil(() => busy.quit());
  expect(busy.quit()).toBe(true);
});

test("sidebar resize drag and chat stream callbacks never throw titleBar() outside render", async () => {
  const app = await launch({
    storage: {
      "harness.scenario": "history",
      "harness.long": "1",
    },
  });
  await app.waitFor("label:Sidebar width");

  // Exercise the sidebar resize sash's mouse-down / mouse-move / mouse-up path
  // (which reads `effectiveSidebarMinWidth` -> `titleBarArea().left` outside render).
  const sash = app.layout("label:Sidebar width");
  expect(sash).not.toBeNull();
  await app.drag("label:Sidebar width", { x: 48, y: 0 });
  const after = app.layout("label:Sidebar width");
  expect(after).not.toBeNull();
  if (sash && after) {
    expect(after.x).toBeGreaterThan(sash.x);
  }

  // Send a prompt to exercise `checkHorizon` / `horizonInset` async measure callbacks.
  await app.type("label:Message", "write a detailed checklist");
  await app.submit("label:Message");
  await app.waitFor("text:write a detailed checklist");
  await app.waitFor("label:Send");
});
