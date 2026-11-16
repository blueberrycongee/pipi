import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

// Drag-to-reorder in the sidebar: a held row dragged past a few points follows
// the pointer, a drop line marks where it lands, and its release writes the
// order to prefs — workspaces as the new folder order, Recent's and each
// folder's sessions as ranks over their natural standing. A press that never
// travels stays a press.

const launch = (scenario: string) =>
  open("./Harness.tsx", {
    width: 1180,
    height: 780,
    platform: "macos",
    locale: "en-US",
    clock: {},
    storage: { "harness.scenario": scenario },
  });

/** 最近's session rows, top to bottom: the known titles in the order they appear. */
const recentOrder = (app: App, titles: string[]) => {
  const texts = app.texts();
  const rows = texts.slice(texts.indexOf("Recent") + 1);
  return titles.filter((title) => rows.includes(title)).sort((a, b) => rows.indexOf(a) - rows.indexOf(b));
};

test("dragging a recent row reorders Recent; a tap still opens the session", async () => {
  const app = await launch("welcome");
  await app.waitFor("text:What are we building?");
  const titles = [
    "Look around and tell me what this project is",
    "Refactor the transcript reducer",
    "Why does the build fail on Linux?",
    "Release notes for 0.1",
  ];
  expect(recentOrder(app, titles)).toEqual(titles);

  // A wiggle that never travels stays a wiggle: nothing moves.
  await app.drag("id:sidebar-recents >> text:Look around and tell me what this project is", { x: 3, y: 3 });
  expect(recentOrder(app, titles)).toEqual(titles);
  expect(app.count("id:sidebar-drop-line")).toBe(0);

  // Held mid-drag, the row lifts above the list and the drop line marks
  // where it would land.
  await app.dragAndHold("id:sidebar-recents >> text:Look around and tell me what this project is", { x: 30, y: 40 });
  expect(app.count("id:sidebar-drag-lift")).toBe(1);
  expect(app.count("id:sidebar-drop-line")).toBe(1);
  await app.drop();
  expect(app.count("id:sidebar-drag-lift")).toBe(0);
  expect(recentOrder(app, titles)).toEqual([
    "Refactor the transcript reducer",
    "Look around and tell me what this project is",
    "Why does the build fail on Linux?",
    "Release notes for 0.1",
  ]);

  // The order holds once the drop settles, and a plain press still opens the row.
  await app.wait(100);
  expect(recentOrder(app, titles)[0]).toBe("Refactor the transcript reducer");
  await app.press("id:sidebar-recents >> text:Refactor the transcript reducer");
  await app.waitUntil(() => app.texts().includes("Here is the plan."));
});

test("a held press lifts without moving, and a drop in place leaves the order", async () => {
  const app = await launch("welcome");
  await app.waitFor("text:What are we building?");
  const titles = [
    "Look around and tell me what this project is",
    "Refactor the transcript reducer",
    "Why does the build fail on Linux?",
    "Release notes for 0.1",
  ];

  // The finger rests: past the hold the row is lifted, and a 10pt move that
  // does not cross the next row's middle leaves the order as it was.
  await app.dragAndHold("id:sidebar-recents >> text:Look around and tell me what this project is", { x: 10, y: 10 });
  await app.wait(120);
  expect(app.count("id:sidebar-drag-lift")).toBe(1);
  expect(app.count("id:sidebar-drop-line")).toBe(0);
  await app.drop();
  await app.wait(200);
  expect(recentOrder(app, titles)).toEqual(titles);
});

test("Escape hands a drag back where it started", async () => {
  const app = await launch("welcome");
  await app.waitFor("text:What are we building?");
  const titles = [
    "Look around and tell me what this project is",
    "Refactor the transcript reducer",
    "Why does the build fail on Linux?",
    "Release notes for 0.1",
  ];

  await app.dragAndHold("id:sidebar-recents >> text:Look around and tell me what this project is", { x: 30, y: 40 });
  expect(app.count("id:sidebar-drop-line")).toBe(1);
  await app.keyboard.press("escape");
  expect(app.count("id:sidebar-drop-line")).toBe(0);
  expect(app.count("id:sidebar-drag-lift")).toBe(0);
  await app.drop();
  await app.wait(200);
  expect(recentOrder(app, titles)).toEqual(titles);
});

test("dragging a project row reorders the workspaces", async () => {
  const app = await launch("multi");
  await app.waitFor("text:What are we building?");
  const names = ["pipi", "nsh", "pi-docs"];
  /** The project rows' names, top to bottom. */
  const order = () => {
    const texts = app.texts();
    const rows = texts.slice(texts.indexOf("Workspaces") + 1, texts.indexOf("Recent"));
    return names.filter((name) => rows.includes(name)).sort((a, b) => rows.indexOf(a) - rows.indexOf(b));
  };
  expect(order()).toEqual(names);

  // Fold the folders so the rows sit next to each other for the drag.
  await app.press("label:Collapse pipi");
  await app.press("label:Collapse nsh");

  await app.drag("id:sidebar-workspaces >> text:nsh", { x: 30, y: -40 });
  expect(order()).toEqual(["nsh", "pipi", "pi-docs"]);
});

test("dragging a session reorders its folder's sessions only", async () => {
  const app = await launch("multi");
  await app.waitFor("text:What are we building?");
  const sessions = [
    "Look around and tell me what this project is",
    "Refactor the transcript reducer",
    "Why does the build fail on Linux?",
    "Release notes for 0.1",
  ];
  /** pipi's session rows in the workspaces group, top to bottom. */
  const folder = () => {
    const texts = app.texts();
    const rows = texts.slice(texts.indexOf("pipi") + 1, texts.indexOf("nsh"));
    return sessions.filter((title) => rows.includes(title)).sort((a, b) => rows.indexOf(a) - rows.indexOf(b));
  };
  expect(folder()).toEqual(sessions);

  // Up past the row above's middle.
  await app.drag("id:sidebar-workspaces >> text:Why does the build fail on Linux?", { x: 30, y: -40 });
  expect(folder()).toEqual([
    "Look around and tell me what this project is",
    "Why does the build fail on Linux?",
    "Refactor the transcript reducer",
    "Release notes for 0.1",
  ]);
});
