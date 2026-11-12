// Scroll behavior while a reply streams: the view follows the reply until the
// reader scrolls up, then holds where they left it however the reply grows
// (never pulled back to the end); the jump pill, or scrolling back down to the
// end, follows again.
//
//   nsh test Scroll.test.tsx --target macos    # on the real list
//
// The pill shows only for a reader the view has been released to, so it is
// what tells a view that holds from one pulled back to the end.
import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

const launch = (scenario = "stream") =>
  open("./Harness.tsx", { width: 1180, height: 780, platform: "macos", locale: "en-US", storage: { "harness.scenario": scenario } });

const PILL = "label:Scroll to bottom";

async function streamTo(app: App, part: number) {
  await app.waitFor("text:What are we building?");
  await app.type("label:Message", "make a long plan");
  await app.submit("label:Message");
  await app.waitFor(`text:Part ${part} of the plan`, { timeout: 20000 });
}

test("scrolling up while a reply streams releases the view, and it holds", async () => {
  const app = await launch();
  await streamTo(app, 8);
  expect(app.shows(PILL)).toBe(false); // following: at the end

  await app.scroll("label:Conversation", -400);
  await app.waitFor(PILL, { timeout: 2000 });
  // The reply keeps growing; the view is not pulled back.
  for (let i = 0; i < 6; i++) {
    await app.wait(350);
    expect(app.shows(PILL)).toBe(true);
  }

  // The pill goes to the end and follows again: the reply grows, the view stays at its end.
  await app.press(PILL);
  for (let i = 0; i < 4; i++) {
    await app.wait(350);
    expect(app.shows(PILL)).toBe(false);
  }
}, 60000);

test("a small upward scroll also releases the view", async () => {
  const app = await launch();
  await streamTo(app, 6);
  await app.scroll("label:Conversation", -60);
  await app.waitFor(PILL, { timeout: 2000 });
  for (let i = 0; i < 6; i++) {
    await app.wait(350);
    expect(app.shows(PILL)).toBe(true);
  }
}, 60000);

test("a fold pressed while a short reply streams shows no pill: there is nothing below to jump to", async () => {
  const app = await launch("slow");
  await app.waitFor("text:What are we building?");
  await app.type("label:Message", "make a plan");
  await app.submit("label:Message");
  await app.waitFor("text:Read package.json", { timeout: 20000 });
  await app.press("text:Read package.json");
  for (let i = 0; i < 4; i++) {
    await app.wait(350);
    expect(app.shows(PILL)).toBe(false);
  }
}, 60000);

test("scrolling back down to the end follows again", async () => {
  const app = await launch();
  await streamTo(app, 8);
  await app.scroll("label:Conversation", -400);
  await app.waitFor(PILL, { timeout: 2000 });
  await app.wait(400);
  await app.scroll("label:Conversation", 4000);
  for (let i = 0; i < 5; i++) {
    await app.wait(350);
    expect(app.shows(PILL)).toBe(false);
  }
}, 60000);
