import { expect, open, test } from "nsh/test";

// Drag-to-split view: dragging a session or document from the sidebar (or a
// tab pill down from the top strip) into the main workspace reveals left/right
// dashed drop zones ("Add left split" / "Add right split"). Dropping opens a
// live concurrent split pane beside the primary view; Escape cancels cleanly.
//
//   nsh test Split.test.tsx

const launch = (scenario = "welcome", extra: Record<string, string> = {}) =>
  open("./Harness.tsx", {
    width: 1220,
    height: 780,
    platform: "macos",
    locale: "en-US",
    storage: { "harness.scenario": scenario, "harness.distinct": "1", "pipi.prefs.v1": "{}", ...extra },
  });

const REFACTOR = "Refactor the transcript reducer";
const NOTES = "Release notes for 0.1";
const row = (title: string) => `id:sidebar-recents >> text:${title}`;

test("dragging a sidebar session into the right drop zone opens a live split chat", async () => {
  const app = await launch();
  await app.waitFor("text:What are we building?");
  await app.press(row(REFACTOR));
  await app.waitFor("label:Refactor the transcript reducer");
  await app.waitFor(`label:Conversation >> text:${REFACTOR}`);

  // Drag another session horizontally from the sidebar into the right drop zone.
  await app.dragAndHold(row(NOTES), { x: 860, y: 120 });
  await app.waitFor("id:split-drop-left");
  await app.waitFor("id:split-drop-right");
  await app.waitFor("text:Add left split");
  await app.waitFor("text:Add right split");

  await app.drop();
  await app.waitFor("id:split-pane");
  await app.waitFor(`id:split-pane >> text:${NOTES}`);

  // Primary conversation stays intact alongside the split pane.
  expect(app.count(`label:Conversation >> text:${REFACTOR}`)).toBeGreaterThan(0);

  // Both panes share the exact same Composer UI (attach file, send options) with independent drafts.
  expect(app.count("id:split-pane >> label:Attach file")).toBe(1);
  expect(app.count("id:split-pane >> label:Send options")).toBe(1);
  await app.type("label:Message", "Draft in primary only");

  // Send a message directly inside the split pane's own composer without touching primary's draft.
  await app.type("id:split-composer-input", "Hello from split pane");
  await app.press("id:split-send");
  await app.waitFor("id:split-pane >> text:Hello from split pane");
  await app.waitFor("id:split-pane >> text:Here is the plan.");
  expect(app.count("text:Draft in primary only")).toBe(1);

  // Swap left/right, then close split cleanly.
  await app.press("id:split-swap");
  await app.waitFor("label:Left split pane");
  await app.press("id:split-close");
  await app.waitUntil(() => app.count("id:split-pane") === 0);
});

test("dragging a sidebar session to the left drop zone opens a left split, and Escape cancels mid-drag", async () => {
  const app = await launch();
  await app.waitFor("text:What are we building?");
  await app.press(row(REFACTOR));
  await app.waitFor("label:Refactor the transcript reducer");

  // Mid-drag Escape cancels without opening a split.
  await app.dragAndHold(row(NOTES), { x: 260, y: 120 });
  await app.waitFor("id:split-drop-left");
  await app.keyboard.press("escape");
  await app.waitUntil(() => app.count("id:split-drop-overlay") === 0);
  await app.drop();
  expect(app.count("id:split-pane")).toBe(0);

  // Dropping in the left zone opens a left split pane.
  await app.dragAndHold(row(NOTES), { x: 260, y: 120 });
  await app.waitFor("id:split-drop-left");
  await app.drop();
  await app.waitFor("label:Left split pane");
  await app.waitFor(`id:split-pane >> text:${NOTES}`);
});

test("dragging a tab pill down into the workspace opens split view", async () => {
  const app = await launch();
  await app.waitFor("text:What are we building?");
  await app.press(row(REFACTOR));
  await app.waitFor("label:Refactor the transcript reducer");
  await app.rightClick(row(NOTES));
  await app.chooseMenuItem("Open in New Tab");
  await app.waitFor("id:tab-1");
  await app.waitFor("label:Release notes for 0.1");

  // Pull tab-0 (Refactor) downward into the right half of the workspace.
  await app.dragAndHold("id:tab-0", { x: 540, y: 260 });
  await app.waitFor("id:split-drop-right");
  await app.drop();
  await app.waitFor("id:split-pane");
  await app.waitFor(`id:split-pane >> text:${REFACTOR}`);
});

test("context menu, toolbar toggle, and ⌘\\ split documents and chats", async () => {
  const dir = `/tmp/pipi-split-docs-${Date.now()}`;
  const app = await launch("welcome", {
    "harness.dataDir": dir,
    "harness.files": JSON.stringify({
      [`${dir}/docs/brief.md`]: "# Split Brief\n\nSide-by-side writing.\n",
    }),
  });
  await app.waitFor("text:What are we building?");
  await app.waitFor("id:sidebar-docs >> text:Split Brief");

  // Right-click a document in the sidebar → Split Right.
  await app.rightClick("id:sidebar-docs >> text:Split Brief");
  await app.chooseMenuItem("Split Right");
  await app.waitFor("id:split-pane");
  await app.waitFor("id:split-pane >> text:Split Brief");

  // TabBar split toggle closes it, and ⌘\ opens a fresh split chat.
  await app.press("id:tabbar-split-toggle");
  await app.waitUntil(() => app.count("id:split-pane") === 0);
  await app.keyboard.press("mod+\\");
  await app.waitFor("id:split-pane");
  await app.waitFor("id:split-composer-input");
  await app.keyboard.press("mod+\\");
  await app.waitUntil(() => app.count("id:split-pane") === 0);
});
