import { expect, open, test } from "nsh/test";

// The top strip is the desk; the sidebar is the shelf. A session looked at from
// the sidebar sits in the strip's one preview seat, and the next one looked at
// takes that seat — looking around does not pile tabs up. A tab is kept once
// it is worked on (a message sent, a document written in) or the reader says
// so ("Keep Open", a double press, a drag). Each tab returns to its surface
// with its state intact, and the strip's own gestures — close, cycle, context
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
const row = (title: string) => `id:sidebar-recents >> text:${title}`;
/** Whether the conversation that opens with `title` is in the chat (each scripted session opens on its title, asked). */
const shows = (app: { count: (s: string) => number }, title: string) => app.count(`label:Conversation >> text:${title}`) > 0;

type Launched = Awaited<ReturnType<typeof launch>>;
/** Says a tab stays (what a double press on it says). */
async function keep(app: Launched, tab: string) {
  await app.rightClick(tab);
  await app.chooseMenuItem("Keep Open");
}
/** Two kept-apart tabs: the first session kept, the second looked at beside it. */
async function twoTabs(app: Launched) {
  await app.waitFor("text:What are we building?");
  await app.press(row(REFACTOR));
  await app.waitFor("label:Refactor the transcript reducer");
  await keep(app, "id:tab-0");
  await app.press(row(NOTES));
  await app.waitFor("id:tab-1");
}

test("looking around the sidebar reuses one seat; a kept tab stays", async () => {
  const app = await launch();
  await app.waitFor("text:What are we building?");
  expect(app.count("id:tab-0")).toBe(1);
  expect(app.count("id:tab-1")).toBe(0);

  await app.press(row(REFACTOR));
  // Still one pill — now the session's, carrying its name.
  await app.waitFor("label:Refactor the transcript reducer");
  expect(app.count("id:tab-1")).toBe(0);

  // Only looked at: the next session looked at takes the same seat.
  await app.press(row(NOTES));
  await app.waitFor("label:Release notes for 0.1");
  expect(app.count("id:tab-1")).toBe(0);
  expect(app.count("label:Refactor the transcript reducer")).toBe(0);

  // Kept, it stays, and the next look sits beside it.
  await keep(app, "id:tab-0");
  await app.press(row(REFACTOR));
  await app.waitFor("id:tab-1");
  await app.waitFor("label:Refactor the transcript reducer");

  await app.press("id:tab-0");
  await app.waitUntil(() => shows(app, NOTES));
});

test("a message sent in a session keeps its tab", async () => {
  const app = await launch();
  await app.waitFor("text:What are we building?");
  await app.press(row(REFACTOR));
  await app.waitFor("label:Refactor the transcript reducer");
  await app.type("label:Message", "carry on");
  await app.submit("label:Message");
  await app.waitFor("text:carry on");

  await app.press(row(NOTES));
  await app.waitFor("id:tab-1");
  await app.waitFor("label:Refactor the transcript reducer");
});

test("closing the front tab opens its neighbour", async () => {
  const app = await launch();
  await twoTabs(app);

  await app.press("id:tab-1 >> label:Close tab");
  await app.waitUntil(() => app.count("id:tab-1") === 0);
  // The neighbour is on — its transcript was already seen, so it shows at once.
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
