// Pressing elsewhere closes what the composer opened — the chips' pickers and
// the slash menu — and the press still lands where it went. The engine's own
// menus are `Overlay`s and get this for free; the slash menu is anchored to the
// composer's column, so what it opens over is dismissed by a press outside it.
//
//   nsh test PickerDismiss.test.tsx
import { expect, open, test } from "nsh/test";

const launch = (scenario = "history", locale = "en-US") =>
  open("./Harness.tsx", { width: 1180, height: 780, platform: "macos", locale, storage: { "harness.scenario": scenario } });

const MESSAGE = "label:Message";
const MENU = "label:Commands";

test("the agent picker closes on a press in the conversation", async () => {
  const app = await launch();
  await app.waitFor("text:Here is the plan.");
  await app.press("id:agent-chip");
  await app.waitFor("id:agent-picker");
  await app.press("text:Finished in under 1 second");
  await app.waitUntil(() => app.count("id:agent-picker") === 0);
});

test("the sidebar closes the model picker", async () => {
  const app = await launch();
  await app.waitFor("text:Here is the plan.");
  await app.type(MESSAGE, "/model");
  await app.submit(MESSAGE);
  await app.waitFor("text:Search models");
  await app.press("text:Workspaces");
  await app.waitUntil(() => app.count("text:Search models") === 0);
});

test("the slash menu closes on a press in the conversation, and stays closed until a new slash", async () => {
  const app = await launch();
  await app.waitFor("text:Here is the plan.");
  await app.type(MESSAGE, "/mod");
  await app.waitFor(MENU);
  await app.press("text:Finished in under 1 second");
  await app.waitUntil(() => app.count(MENU) === 0);
  // The draft is left as it was, as Escape leaves it: the line sends as written.
  expect(app.value(MESSAGE)).toBe("/mod");
  await app.type(MESSAGE, "e");
  await app.wait(300);
  expect(app.count(MENU)).toBe(0);
  await app.clear(MESSAGE);
  await app.type(MESSAGE, "/");
  await app.waitFor(MENU);
});

test("opening a composer picker closes the slash menu under it", async () => {
  const app = await launch("welcome");
  await app.waitFor("text:What are we building?");
  await app.type(MESSAGE, "/");
  await app.waitFor(MENU);
  await app.press("id:agent-chip");
  await app.waitFor("id:agent-picker");
  await app.waitUntil(() => app.count(MENU) === 0);
});
