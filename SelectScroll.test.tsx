// A selection dragged to an edge of the conversation scrolls it on, as text
// does everywhere: up against the title bar it goes back (and the view is
// released), down against the composer it goes on to the end (and follows
// again); a drag that stays in the text scrolls nothing.
//
//   nsh test SelectScroll.test.tsx --target macos    # on the real list
//
// What a drag reached is read from the copy: a part that was off screen when
// the drag began is in it only if the conversation scrolled under the pointer.
import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

/** What `⌘C` takes of the selection, read where a paste puts it (the composer, `⌘L`). */
async function copied(app: App) {
  await app.keyboard.press("mod+c");
  await app.keyboard.press("mod+l");
  await app.clear("label:Message");
  await app.keyboard.press("mod+v");
  await app.waitUntil(() => (app.value("label:Message") ?? "").length > 0);
  const text = app.value("label:Message") ?? "";
  await app.clear("label:Message");
  return text;
}

const PILL = "label:Scroll to bottom";

test("a selection dragged past the edges of the conversation scrolls it", async () => {
  const app = await open("./Harness.tsx", { width: 1180, height: 780, platform: "macos", locale: "en-US", storage: { "harness.scenario": "stream" } });
  await app.waitFor("text:What are we building?");
  await app.type("label:Message", "make a long plan");
  await app.submit("label:Message");
  await app.waitFor("text:Part 24 of the plan", { timeout: 60000 });
  await app.wait(3000); // the run settles
  expect(app.shows(PILL)).toBe(false); // at the end, following

  // Within the text: the selection grows, the conversation stays.
  await app.drag("text:Part 20 of the plan", { y: -200 });
  await app.wait(400);
  expect(app.shows(PILL)).toBe(false);
  let copy = await copied(app);
  expect(copy).toContain("Part 18 of the plan");
  expect(copy).not.toContain("Part 5 of the plan");

  // Up past the title bar: it scrolls back as far as the drag goes on, here to the start.
  await app.drag("text:Part 20 of the plan", { y: -1600 });
  await app.waitFor(PILL, { timeout: 2000 });
  copy = await copied(app);
  expect(copy).toContain("Part 1 of the plan");
  expect(copy).toContain("Part 20 of the plan");

  // Down past the composer: on to the end, where the view follows again.
  await app.drag("text:Part 3 of the plan", { y: 2400 });
  await app.wait(600);
  expect(app.shows(PILL)).toBe(false);
  copy = await copied(app);
  expect(copy).toContain("Part 4 of the plan");
  expect(copy).toContain("Part 24 of the plan");
}, 180000);
