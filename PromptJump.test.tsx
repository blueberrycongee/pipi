// The bubble at the pane's top-right: while the last prompt sent is out of
// view — run off the top by a long reply, or left below by a read into old
// history — it names that prompt in the prompt's own words, and a press lands
// the view back on it, just under the title bar.
//
// A sent prompt rests at the top while its reply streams below it, so the
// capsule is for the reader who has scrolled into the answer — the tests scroll
// there first. Row texts can't carry the assertions: a real list keeps every
// row bound (on-screen or not) and a headless one only the viewable — but the
// capsule mounts only for a prompt that is genuinely above the viewport, so its
// label and its words are what the tests read.
//
//   nsh test PromptJump.test.tsx
//   nsh test PromptJump.test.tsx --target macos
import { expect, open, test } from "nsh/test";

const CAPSULE = "label:Back to the prompt";
/** The same bubble when the last prompt sits below the view. */
const CAPSULE_BELOW = "label:Forward to the last prompt";
/** The prompt the capsule names: the text inside it, not the (always bound) rows. */
const naming = (prompt: string) => `${CAPSULE} >> text:${prompt}`;

const launch = () => open("./Harness.tsx", { width: 1180, height: 780, platform: "macos", locale: "en-US" });

type App = Awaited<ReturnType<typeof launch>>;

async function longPlan(app: App) {
  await app.waitFor("text:What are we building?");
  await app.type("label:Message", "make a long plan");
  await app.submit("label:Message");
}

/** Read into the answer until the capsule names `prompt`: a real platform anchors a
 * sent prompt at the top, so scrolling moves it off; a run already at the end
 * can't take the scroll (it rejects) and needs none. While the answer is still
 * growing one drag may not reach the part the prompt is above, so it repeats. */
async function readInto(app: App, prompt: string) {
  const deadline = Date.now() + 30000;
  for (;;) {
    await app.scroll("label:Conversation", 4000).catch(() => {});
    try {
      await app.waitFor(naming(prompt), { timeout: 4000 });
      return;
    } catch (e) {
      if (Date.now() > deadline) throw e;
    }
  }
}

test("a reply that outgrew its prompt floats it at the right edge; a press lands on it", async () => {
  const app = await launch();
  await longPlan(app);

  // The prompt scrolls off the top and the capsule names it.
  await readInto(app, "make a long plan");

  // The press lands the prompt under the title bar, and with nothing above it
  // the capsule leaves.
  await app.press(CAPSULE);
  await app.waitFor(CAPSULE, { state: "gone", timeout: 5000 });
}, 60000);

test("only the last prompt is named: landed, the capsule leaves instead of walking up", async () => {
  const app = await launch();
  await longPlan(app);
  await app.type("label:Message", "make a long second answer");
  await app.submit("label:Message");

  // Read into the second answer: the capsule names the second (last) prompt.
  await readInto(app, "make a long second answer");

  // The press lands on it — visible now, the capsule leaves; the first prompt
  // above is never offered a turn of its own.
  await app.press(CAPSULE);
  await app.waitFor(CAPSULE, { state: "gone", timeout: 5000 });
}, 90000);

test("read to the top of history: the capsule names the last prompt below", async () => {
  const app = await launch();
  await longPlan(app);
  await app.type("label:Message", "make a long second answer");
  await app.submit("label:Message");
  await readInto(app, "make a long second answer");

  // Up past the last prompt: it is left below the view and the capsule turns forward.
  const deadline = Date.now() + 30000;
  for (;;) {
    await app.scroll("label:Conversation", -4000).catch(() => {});
    try {
      await app.waitFor(`${CAPSULE_BELOW} >> text:make a long second answer`, { timeout: 4000 });
      break;
    } catch (e) {
      if (Date.now() > deadline) throw e;
    }
  }

  // Back down at the last prompt, nothing below to chase: the capsule leaves.
  await app.press(CAPSULE_BELOW);
  await app.waitFor(CAPSULE_BELOW, { state: "gone", timeout: 5000 });
}, 90000);

test("a short reply keeps its prompt in view: no capsule", async () => {
  const app = await launch();
  await app.waitFor("text:What are we building?");
  await app.type("label:Message", "make a plan");
  await app.submit("label:Message");
  await app.waitFor("text:Here is the plan.", { timeout: 20000 });
  await app.wait(400);
  expect(app.shows(CAPSULE)).toBe(false);
}, 60000);

test("a persona conversation never floats its prompt, however far the reader scrolls", async () => {
  const app = await launch();
  await app.waitFor("text:What are we building?");
  await app.press("id:sidebar-pip");
  await app.waitFor("text:Hey, what's up?");

  await app.type("label:Message", "make a long plan");
  await app.submit("label:Message");
  await app.waitFor("text:Part 24 of the plan", { timeout: 30000 });
  await app.waitFor("label:Send", { timeout: 30000 });

  // Up through the thread and back down: the capsule never appears either way.
  for (let i = 0; i < 6; i++) {
    await app.scroll("label:Conversation", -4000).catch(() => {});
    await app.wait(300);
    expect(app.shows(CAPSULE)).toBe(false);
    expect(app.shows(CAPSULE_BELOW)).toBe(false);
  }
  for (let i = 0; i < 6; i++) {
    await app.scroll("label:Conversation", 4000).catch(() => {});
    await app.wait(300);
    expect(app.shows(CAPSULE)).toBe(false);
    expect(app.shows(CAPSULE_BELOW)).toBe(false);
  }
}, 90000);
