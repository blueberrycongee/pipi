import { expect, open, test } from "nsh/test";

// The top strip follows Obsidian's tab rule: the reader owns their tabs. A
// plain click in the sidebar navigates inside the current tab (never spawning
// unasked-for tabs, even after sending a message). Opening another tab is
// always explicit: "+", ⌘T, ⌘-click, middle-click, or "Open in New Tab". There
// is no italic preview seat. Each tab returns to its surface with its state
// intact, and the strip's own gestures — close, cycle, drag reorder, context
// menu, file drop, a new document — work on it.
//
//   nsh test Tabs.test.tsx

// Fresh prefs per launch: a persisted strip from an earlier app in the run (or
// an earlier `nsh test` on this machine — storage outlives the process) would
// restore its tabs into every scenario here.
const launch = (scenario = "welcome") =>
  open("./Harness.tsx", {
    width: 1180,
    height: 780,
    platform: "macos",
    locale: "en-US",
    storage: { "harness.scenario": scenario, "harness.distinct": "1", "pipi.prefs.v1": "{}" },
  });

const REFACTOR = "Refactor the transcript reducer";
const NOTES = "Release notes for 0.1";
const LINUX = "Why does the build fail on Linux?";
const row = (title: string) => `id:sidebar-recents >> text:${title}`;
/** Whether the conversation that opens with `title` is in the chat (each scripted session opens on its title, asked). */
const shows = (app: { count: (s: string) => number }, title: string) => app.count(`label:Conversation >> text:${title}`) > 0;

type Launched = Awaited<ReturnType<typeof launch>>;
/** Two tabs opened explicitly: Refactor in tab-0, Release notes opened in a new tab beside it. */
async function twoTabs(app: Launched) {
  await app.waitFor("text:What are we building?");
  await app.press(row(REFACTOR));
  await app.waitFor("label:Refactor the transcript reducer");
  await app.rightClick(row(NOTES));
  await app.chooseMenuItem("Open in New Tab");
  await app.waitFor("id:tab-1");
  await app.waitFor("label:Release notes for 0.1");
}

test("clicking in the sidebar switches inside the current tab without adding tabs, even after sending", async () => {
  const app = await launch();
  await app.waitFor("text:What are we building?");
  expect(app.count("id:tab-0")).toBe(1);
  expect(app.count("id:tab-1")).toBe(0);

  await app.press(row(REFACTOR));
  await app.waitFor("label:Refactor the transcript reducer");
  expect(app.count("id:tab-1")).toBe(0);
  // No italic preview seat and no "Keep Open" menu item.
  expect(app.spanStyle("id:tab-0 >> text:Refactor the transcript reducer").italic).toBe(false);
  await app.rightClick("id:tab-0");
  expect(app.menu()?.some((item) => item.label === "Keep Open")).toBe(false);
  await app.closeMenu();

  // Sending a message does not cause subsequent sidebar clicks to spawn extra tabs.
  await app.type("label:Message", "carry on");
  await app.submit("label:Message");
  await app.waitFor("text:carry on");

  await app.press(row(NOTES));
  await app.waitFor("label:Release notes for 0.1");
  expect(app.count("id:tab-1")).toBe(0);
  expect(app.count("label:Refactor the transcript reducer")).toBe(0);
});

test("clicking '+' or pressing ⌘T opens a new tab; sidebar clicks navigate inside the active tab", async () => {
  const app = await launch();
  await app.waitFor("text:What are we building?");
  await app.press(row(REFACTOR));
  await app.waitFor("label:Refactor the transcript reducer");
  expect(app.count("id:tab-1")).toBe(0);

  // '+' opens a second tab with a fresh session.
  await app.press("id:tab-new");
  await app.waitFor("id:tab-1");
  await app.waitFor("text:What are we building?");
  expect(app.count("label:Refactor the transcript reducer")).toBe(1);

  // Clicking a session in the sidebar replaces only the active tab (tab-1), keeping tab-0 intact.
  await app.press(row(NOTES));
  await app.waitFor("label:Release notes for 0.1");
  expect(app.count("id:tab-1")).toBe(1);
  expect(app.count("id:tab-2")).toBe(0);
  expect(app.count("label:Refactor the transcript reducer")).toBe(1);

  // Clicking an already-open session switches to its existing tab rather than duplicating it.
  await app.press(row(REFACTOR));
  await app.waitUntil(() => shows(app, REFACTOR));
  expect(app.count("id:tab-1")).toBe(1);
  expect(app.count("id:tab-2")).toBe(0);

  // ⌘T opens a third tab; clicking another session populates it.
  await app.keyboard.press("mod+t");
  await app.waitFor("id:tab-2");
  await app.waitFor("text:What are we building?");
  await app.press(row(LINUX));
  await app.waitFor(`label:${LINUX}`);
  expect(app.count("id:tab-2")).toBe(1);
  expect(app.count("id:tab-3")).toBe(0);
});

test("'+' works even from a fresh welcome tab", async () => {
  const app = await launch();
  await app.waitFor("text:What are we building?");
  expect(app.count("id:tab-0")).toBe(1);
  expect(app.count("id:tab-1")).toBe(0);

  await app.press("id:tab-new");
  await app.waitFor("id:tab-1");
  await app.press(row(REFACTOR));
  await app.waitFor("label:Refactor the transcript reducer");
  // Tab 0 remained the fresh draft while tab 1 navigated to Refactor.
  expect(app.count("id:tab-1")).toBe(1);
  await app.press("id:tab-0");
  await app.waitFor("text:What are we building?");
});

test("New session in the sidebar replaces the current tab without growing the strip", async () => {
  const app = await launch();
  await app.waitFor("text:What are we building?");
  await app.press(row(REFACTOR));
  await app.waitFor("label:Refactor the transcript reducer");
  expect(app.count("id:tab-1")).toBe(0);

  await app.press("id:sidebar-new-session");
  await app.waitFor("text:What are we building?");
  expect(app.count("id:tab-0")).toBe(1);
  expect(app.count("id:tab-1")).toBe(0);
});

test("sidebar documents open in the current tab by default and in a new tab when asked", async () => {
  const dir = `/tmp/pipi-tabs-docs-${Date.now()}`;
  const app = await open("./Harness.tsx", {
    width: 1180,
    height: 780,
    platform: "macos",
    locale: "en-US",
    storage: {
      "harness.scenario": "welcome",
      "harness.distinct": "1",
      "harness.dataDir": dir,
      "harness.files": JSON.stringify({
        [`${dir}/docs/a.md`]: "# Alpha Note\n\nBody A.\n",
        [`${dir}/docs/b.md`]: "# Beta Note\n\nBody B.\n",
      }),
      "pipi.prefs.v1": "{}",
    },
  });
  await app.waitFor("text:What are we building?");
  await app.waitFor("id:sidebar-docs >> text:Alpha Note");

  // Plain click replaces the single tab with Alpha Note.
  await app.press("id:sidebar-docs >> text:Alpha Note");
  await app.waitFor("id:doc-editor");
  await app.waitFor("label:Alpha Note");
  expect(app.count("id:tab-1")).toBe(0);
  expect(app.spanStyle("id:tab-0 >> text:Alpha Note").italic).toBe(false);

  // Plain click on Beta Note replaces Alpha Note in place.
  await app.press("id:sidebar-docs >> text:Beta Note");
  await app.waitFor("label:Beta Note");
  expect(app.count("id:tab-1")).toBe(0);
  expect(app.count("label:Alpha Note")).toBe(0);

  // Open in New Tab keeps Beta Note and opens Alpha Note beside it.
  await app.rightClick("id:sidebar-docs >> text:Alpha Note");
  await app.chooseMenuItem("Open in New Tab");
  await app.waitFor("id:tab-1");
  await app.waitFor("label:Alpha Note");
  expect(app.count("label:Beta Note")).toBe(1);

  // Plain click on a session replaces only the active doc tab (Alpha Note), keeping Beta Note.
  await app.press(row(REFACTOR));
  await app.waitFor("label:Refactor the transcript reducer");
  expect(app.count("id:tab-1")).toBe(1);
  expect(app.count("id:tab-2")).toBe(0);
  expect(app.count("label:Beta Note")).toBe(1);
  expect(app.count("label:Alpha Note")).toBe(0);
});

test("closing the front tab opens its neighbour", async () => {
  const app = await launch();
  await twoTabs(app);

  await app.press("id:tab-1 >> label:Close tab");
  await app.waitUntil(() => app.count("id:tab-1") === 0);
  // The neighbour is on — its transcript was already seen, so it shows at once.
  await app.waitUntil(() => shows(app, REFACTOR));
});

test("double pressing a tab closes it instead of renaming it", async () => {
  const app = await launch();
  await twoTabs(app);

  await app.press("id:tab-1");
  await app.press("id:tab-1");
  await app.waitUntil(() => app.count("id:tab-1") === 0);
  expect(app.count("label:Session name")).toBe(0);
  await app.waitUntil(() => shows(app, REFACTOR));
});

test("⌘⇧] and ⌘⇧[ walk the strip", async () => {
  const app = await launch();
  await twoTabs(app);
  await app.waitUntil(() => shows(app, NOTES));

  await app.keyboard.press("mod+shift+[");
  await app.waitUntil(() => shows(app, REFACTOR));
  await app.keyboard.press("mod+shift+[");
  await app.waitUntil(() => shows(app, NOTES));
  await app.keyboard.press("mod+shift+]");
  await app.waitUntil(() => shows(app, REFACTOR));
});

test("dragging a tab reorders the strip", async () => {
  const app = await launch();
  await twoTabs(app);

  // Drag the first pill past the second's center; the strip trades their places.
  // The pill lifts (its shadow plate mounts) while the finger is still down.
  await app.dragAndHold("id:tab-0", { x: 200, y: 0 });
  await app.waitFor("id:tab-drag-lift");
  await app.drop();
  await app.waitUntil(() => {
    const texts = app.texts();
    return texts.lastIndexOf(NOTES) < texts.lastIndexOf(REFACTOR);
  });
  // The drag was a reorder, not a select: the notes session is still the open one.
  expect(shows(app, NOTES)).toBe(true);
});

test("Escape mid-drag hands the pill back: the order stands", async () => {
  const app = await launch();
  await twoTabs(app);

  await app.dragAndHold("id:tab-0", { x: 200, y: 0 });
  await app.waitFor("id:tab-drag-lift");
  await app.keyboard.press("escape");
  await app.waitUntil(() => app.count("id:tab-drag-lift") === 0);
  await app.drop();
  // Refactor is still the first pill, and notes is still the open session.
  const texts = app.texts();
  expect(texts.lastIndexOf(REFACTOR) < texts.lastIndexOf(NOTES)).toBe(true);
  expect(shows(app, NOTES)).toBe(true);
});

// The dropped file is real disk: a previous run's save would land its heading
// in this run's tab title. One scratch folder per run keeps each launch blank.
const scratch = `/tmp/pipi-tabs-${Date.now()}`;
const dropMd = (app: { dropFiles: (s: string, u: string[]) => Promise<void> }, name: string) =>
  app.dropFiles("id:tab-0", [`file://${scratch}/${name}.md`]);

test("a dropped .md file opens as a document tab", async () => {
  const app = await launch();
  await app.waitFor("text:What are we building?");
  await dropMd(app, "field%20notes");
  await app.waitFor("id:doc-editor");
  // The tab took the file's name, and the strip kept the session beside it.
  await app.waitFor("label:field notes");
  expect(app.count("id:tab-1")).toBe(1);
});

test("typing a heading into the editor renames its tab", async () => {
  const app = await launch();
  await app.waitFor("text:What are we building?");
  await dropMd(app, "scratch%20pad");
  await app.waitFor("id:doc-editor");
  await app.waitFor("label:scratch pad");
  await app.type("id:doc-editor", "# Field Notes");
  // The tab renames to the first heading once the debounced save lands.
  await app.waitFor("label:Field Notes", { timeout: 3000 });
});

test("the right-click menu closes a tab", async () => {
  const app = await launch();
  await app.waitFor("text:What are we building?");
  await app.press(row(REFACTOR));
  await app.waitFor("label:Refactor the transcript reducer");

  await app.rightClick("id:tab-0");
  await app.chooseMenuItem("Close Tab");
  // The last tab gone, a fresh draft takes the strip back.
  await app.waitFor("text:What are we building?");
  await app.waitUntil(() => app.count("id:tab-0") === 1);
});
