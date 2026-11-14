import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

// What folds, and who says so. A turn that is over shows its header and its
// answer, the process folded — however it ended, and however the reader came to
// it. A turn still working shows its process. Past that the folds are the
// reader's: what they pressed stays as they left it through the run going on
// and ending, the next message, and a change of session and back.
//
//   nsh test Fold.test.tsx
//
// On a manual clock, so a run is as far along as the test moved it. The window
// is tall: the list mounts only the rows near its viewport, and a row that is
// not mounted would pass for a folded one.

const DELAY = 1500;

const launch = (scenario: string, storage: Record<string, string> = {}) =>
  open("./Harness.tsx", {
    width: 1180,
    height: 1500,
    platform: "macos",
    locale: "en-US",
    clock: {},
    storage: { "harness.scenario": scenario, ...storage },
  });

const REFACTOR = "Refactor the transcript reducer";
const NOTES = "Release notes for 0.1";
const LOOK = "Look around and tell me what this project is";
const session = (title: string) => `id:sidebar-recents >> text:${title}`;
/** Whether `text` is in the conversation (the sidebar and the composer say some of the same words). */
const shows = (app: App, text: string) => app.count(`label:Conversation >> text:${text}`) > 0;
/** The header of a turn that took a while: each reads its own length, so it names one turn. */
const finished = (app: App) => app.texts().filter((text) => /^Finished in \d+ seconds?$/.test(text));

async function say(app: App, text: string) {
  await app.type("label:Message", text);
  await app.submit("label:Message");
}

/** What `probe` reads at each frame for `ms`: nothing passes between two looks. */
async function frames<T>(app: App, ms: number, probe: () => T): Promise<T[]> {
  const seen: T[] = [probe()];
  for (let elapsed = 0; elapsed < ms; elapsed += 16) {
    await app.wait(16);
    seen.push(probe());
  }
  return seen;
}

// What the scripted run in steps writes on its way (`dev/fake-pi.ts`), and its answer.
const FIRST = "I'll start by looking at how the project is laid out.";
const SECOND = "The list follows by hand. Let me check the tests before changing it.";
const ANSWER = "Everything else is as it was, and the tests pass.";
// And a saved session's turn: what it wrote on the way, and its answer.
const LOOKED = "Let me take a look around.";
const PLAN = "Here is the plan.";

test("a turn that is over is folded however it ended, and opens to a press alone", async () => {
  // Each saved session opens on three turns that got no answer — one a message was sent into, one stopped,
  // one that failed — and then the finished one.
  const app = await launch("welcome", { "harness.cut": "1" });
  await app.waitFor("text:What are we building?");
  await app.press(session(REFACTOR));
  await app.waitUntil(() => shows(app, PLAN));

  for (const written of ["Looking at the sidebar first.", "Switching to the composer.", "Opening the settings.", LOOKED]) {
    expect(shows(app, written)).toBe(false);
  }
  expect(app.count("label:Conversation >> text:Finished in under 1 second")).toBe(4);
  // The failure is said where it happened, outside the fold.
  expect(shows(app, "The model returned an error")).toBe(true);

  // The reader's press opens the one they pressed, and no other.
  await app.press("label:Conversation >> text:Finished in under 1 second >> nth=0");
  await app.waitUntil(() => shows(app, "Looking at the sidebar first."));
  expect(shows(app, "Switching to the composer.")).toBe(false);
  expect(shows(app, "Opening the settings.")).toBe(false);
  expect(shows(app, LOOKED)).toBe(false);
});

test("a message sent into the run folds the work so far, and the run goes on open", async () => {
  const app = await launch("stream");
  await app.waitFor("text:What are we building?");
  await say(app, "make a plan in steps");
  await app.waitUntil(() => shows(app, FIRST));

  await say(app, "focus on the tests");
  await app.waitUntil(() => shows(app, "focus on the tests"), { timeout: 20000 });
  // What was done before the message is a turn that is over: folded, under how long it took.
  await app.waitUntil(() => !shows(app, FIRST));
  expect(finished(app)).toHaveLength(1);
  // The run goes on under the message, its process open as any working turn's.
  await app.waitUntil(() => shows(app, SECOND), { timeout: 20000 });
  expect(app.shows("label:Stop")).toBe(true);
  expect(shows(app, "Working")).toBe(true);
  expect(shows(app, FIRST)).toBe(false);

  // And folds in its turn once it has answered.
  await app.waitUntil(() => shows(app, ANSWER), { timeout: 60000 });
  await app.waitFor("label:Send", { timeout: 20000 });
  await app.waitUntil(() => !shows(app, SECOND));
  expect(shows(app, FIRST)).toBe(false);
  expect(finished(app)).toHaveLength(2);
});

test("a working turn the reader folded stays folded as the run goes on past a message", async () => {
  const app = await launch("stream");
  await app.waitFor("text:What are we building?");
  await say(app, "make a plan in steps");
  await app.waitUntil(() => shows(app, FIRST));

  await app.press("label:Conversation >> text:Working");
  await app.waitUntil(() => !shows(app, FIRST));

  // The message makes what follows a turn of its own. It is the same work going on: at no frame does it show.
  await say(app, "focus on the tests");
  const seen: boolean[] = [];
  const watch = async (until: () => boolean) => {
    for (let elapsed = 0; elapsed < 60000 && !until(); elapsed += 100) {
      await app.wait(100);
      seen.push(shows(app, SECOND));
    }
  };
  await watch(() => finished(app).length === 1);
  expect(shows(app, "focus on the tests")).toBe(true);
  expect(shows(app, FIRST)).toBe(false);

  // A look inside the part that is over opens that part alone: the work under way stays folded.
  const [part] = finished(app);
  await app.press(`label:Conversation >> text:${part}`);
  await app.waitUntil(() => shows(app, FIRST));
  await watch(() => seen.length > 12);
  expect(app.shows("label:Stop")).toBe(true);
  await app.press(`label:Conversation >> text:${part}`);
  await app.waitUntil(() => !shows(app, FIRST));

  await watch(() => shows(app, ANSWER));
  expect(shows(app, ANSWER)).toBe(true);
  expect(seen.length).toBeGreaterThan(12);
  expect(seen.some(Boolean)).toBe(false);

  // The reader's press opens it again, as it does any turn.
  await app.waitFor("label:Send", { timeout: 20000 });
  const headers = finished(app);
  await app.press(`label:Conversation >> text:${headers[headers.length - 1]}`);
  await app.waitUntil(() => shows(app, SECOND));
  expect(shows(app, FIRST)).toBe(false);
});

test("opening and closing a turn that is over says nothing on the run after it", async () => {
  const app = await launch("stream");
  await app.waitFor("text:What are we building?");
  await say(app, "make a plan in steps");
  await app.waitUntil(() => shows(app, FIRST));
  await app.waitUntil(() => app.texts().some((text) => text.startsWith("Searching")), { timeout: 20000 });
  await app.press("label:Stop");
  await app.waitFor("label:Send", { timeout: 20000 });
  await app.waitUntil(() => !shows(app, FIRST));

  // A look inside the stopped turn, and out again: it is folded as it was, by nobody's say.
  const [header] = finished(app);
  await app.press(`label:Conversation >> text:${header}`);
  await app.waitUntil(() => shows(app, FIRST));
  await app.press(`label:Conversation >> text:${header}`);
  await app.waitUntil(() => !shows(app, FIRST));

  // So the next run is not work the reader folded: its process shows, as any working turn's.
  await say(app, "make a plan in steps");
  await app.waitUntil(() => shows(app, FIRST), { timeout: 20000 });
  expect(shows(app, "Working")).toBe(true);
  expect(finished(app)).toEqual([header]);
});

test("a run the reader stops folds, as one that answered does", async () => {
  const app = await launch("stream");
  await app.waitFor("text:What are we building?");
  await say(app, "make a plan in steps");
  await app.waitUntil(() => shows(app, FIRST));
  // Stopped on a call: nothing it wrote stands as an answer.
  await app.waitUntil(() => app.texts().some((text) => text.startsWith("Searching")), { timeout: 20000 });

  await app.press("label:Stop");
  await app.waitFor("label:Send", { timeout: 20000 });
  await app.waitUntil(() => !shows(app, FIRST));
  expect(finished(app)).toHaveLength(1);
  expect(shows(app, "Working")).toBe(false);

  // Nor does the next message open it again on its way out (the run it starts is not that turn going on).
  await app.type("label:Message", "make a plan");
  await app.submit("label:Message");
  const seen = await frames(app, 3000, () => shows(app, FIRST));
  expect(seen.some(Boolean)).toBe(false);
});

test("what the reader unfolded stays unfolded through the next message and its run", async () => {
  const app = await launch("stream");
  await app.waitFor("text:What are we building?");
  await app.press(session(REFACTOR));
  await app.waitUntil(() => shows(app, PLAN));

  // The turn's process, and inside it the group of calls.
  await app.press("label:Conversation >> text:Finished in under 1 second");
  await app.waitUntil(() => shows(app, LOOKED));
  await app.press("label:Conversation >> text:Ran ls, Read package.json");
  await app.waitUntil(() => shows(app, "ls -la"));

  await say(app, "make a plan in steps");
  const seen: boolean[] = [];
  for (let elapsed = 0; elapsed < 60000 && !shows(app, ANSWER); elapsed += 100) {
    await app.wait(100);
    seen.push(shows(app, LOOKED) && shows(app, "ls -la"));
  }
  await app.waitFor("label:Send", { timeout: 20000 });
  expect(seen.length).toBeGreaterThan(10);
  expect(seen.every(Boolean)).toBe(true);
  // The run's own process folded at its answer; the reader's unfold is as they left it.
  await app.waitUntil(() => !shows(app, SECOND));
  expect(shows(app, LOOKED)).toBe(true);
  expect(shows(app, "ls -la")).toBe(true);
});

test("what the reader unfolded is there with the click when they come back", async () => {
  const app = await launch("stream", { "harness.startDelay": String(DELAY), "harness.distinct": "1" });
  await app.waitFor("text:What are we building?");
  await app.press(session(REFACTOR));
  await app.waitUntil(() => shows(app, REFACTOR), { timeout: DELAY * 4 });

  // A turn run here, then unfolded: its rows were made as it streamed, and the session's file holds them anew.
  await say(app, "make a plan");
  await app.waitUntil(() => shows(app, "Steps"), { timeout: 60000 });
  await app.waitFor("label:Send", { timeout: 20000 });
  const [header] = finished(app);
  await app.press(`label:Conversation >> text:${header}`);
  await app.waitUntil(() => shows(app, "Read package.json"));
  await app.press("label:Conversation >> text:Read package.json");
  await app.waitUntil(() => shows(app, "View reasoning"));
  // The saved turn above it stays as it was: folded.
  expect(shows(app, LOOKED)).toBe(false);

  await app.press(session(NOTES));
  await app.waitUntil(() => shows(app, NOTES), { timeout: DELAY * 4 });
  expect(shows(app, "View reasoning")).toBe(false);

  // Back: as the reader left it from the click on, through the agent loading the session behind it, and after.
  await app.press(session(REFACTOR));
  const seen = await frames(app, DELAY * 3, () => shows(app, REFACTOR) && shows(app, "View reasoning") && !shows(app, LOOKED));
  expect(seen.every(Boolean)).toBe(true);

  // And the folds are still the reader's to press.
  await app.press("label:Conversation >> text:Read package.json");
  await app.waitUntil(() => !shows(app, "View reasoning"));
  expect(shows(app, "Read package.json")).toBe(true);
});

test("a working turn the reader folded is still folded when they come back to it", async () => {
  // "slow": the run is long enough to leave it and come back while it works.
  const app = await launch("slow", { "harness.startDelay": String(DELAY), "harness.distinct": "1" });
  await app.waitFor("text:What are we building?");
  await app.press(session(REFACTOR));
  await app.waitUntil(() => shows(app, REFACTOR), { timeout: DELAY * 4 });

  await say(app, "make a plan in steps");
  await app.waitUntil(() => shows(app, FIRST), { timeout: 20000 });
  await app.press("label:Conversation >> text:Working");
  await app.waitUntil(() => !shows(app, FIRST));

  // Away while it works, and back while it still does: the run went on meanwhile, and the session is loaded anew.
  await app.press(session(LOOK));
  await app.waitUntil(() => shows(app, LOOK) && !shows(app, REFACTOR), { timeout: DELAY * 4 });
  // Long enough for the run to have got further than what was on screen: what comes back is the session's file, not the screen left.
  await app.wait(10000);
  await app.press(session(REFACTOR));
  const seen = await frames(app, DELAY * 3, () => ({ here: shows(app, REFACTOR), open: shows(app, FIRST) || shows(app, SECOND) }));
  expect(seen.every((frame) => frame.here)).toBe(true);
  expect(seen.some((frame) => frame.open)).toBe(false);
  expect(app.shows("label:Stop")).toBe(true);
  expect(shows(app, "Working")).toBe(true);

  // It ends folded, as the reader had it.
  await app.waitUntil(() => shows(app, ANSWER), { timeout: 120000 });
  await app.waitFor("label:Send", { timeout: 20000 });
  expect(shows(app, FIRST)).toBe(false);
  expect(shows(app, SECOND)).toBe(false);
});

test("a turn that ended while the reader was reading its process folds once they move on", async () => {
  const app = await launch("stream");
  await app.waitFor("text:What are we building?");
  await say(app, "make a plan in steps");
  await app.waitUntil(() => shows(app, FIRST));

  // Reading the reasoning: a press in the process lets go of the end.
  await app.press("label:Conversation >> text:View reasoning");
  await app.waitUntil(() => shows(app, "The user wants this done in steps. I will look at the project first."));

  // The answer arrives under a reader who is reading what would fold: it stays for them.
  await app.waitUntil(() => shows(app, ANSWER), { timeout: 60000 });
  await app.waitFor("label:Send", { timeout: 20000 });
  await app.wait(600);
  expect(shows(app, FIRST)).toBe(true);

  // The next message is them moving on: the turn folds as it would have, and stays folded.
  await say(app, "make a plan");
  await app.waitUntil(() => !shows(app, FIRST));
  await app.waitUntil(() => shows(app, "Steps"), { timeout: 60000 });
  await app.waitFor("label:Send", { timeout: 20000 });
  expect(shows(app, FIRST)).toBe(false);
  expect(shows(app, ANSWER)).toBe(true);
});

test("leaving a turn held open for a reader folds it: back from an empty chat, it is as any finished turn", async () => {
  const app = await launch("stream");
  await app.waitFor("text:What are we building?");
  await app.press(session(REFACTOR));
  await app.waitUntil(() => shows(app, PLAN));
  await say(app, "make a plan in steps");
  await app.waitUntil(() => shows(app, FIRST), { timeout: 20000 });
  await app.press("label:Conversation >> text:View reasoning");
  await app.waitUntil(() => shows(app, ANSWER), { timeout: 60000 });
  await app.waitFor("label:Send", { timeout: 20000 });
  await app.wait(600);
  expect(shows(app, FIRST)).toBe(true);

  // An empty chat has no turn to show: nothing there says the reader stopped watching the one they left.
  await app.keyboard.press("mod+n");
  await app.waitFor("text:What are we building?");
  await app.press(session(REFACTOR));
  const seen = await frames(app, 1500, () => shows(app, FIRST));
  expect(shows(app, ANSWER)).toBe(true);
  expect(seen.some(Boolean)).toBe(false);
  // What they opened by their own press inside it is theirs still, under the fold.
  const [header] = finished(app);
  await app.press(`label:Conversation >> text:${header}`);
  await app.waitUntil(() => shows(app, FIRST));
  expect(shows(app, "The user wants this done in steps. I will look at the project first.")).toBe(true);
});
