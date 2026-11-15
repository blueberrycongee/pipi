// The prompt-jump bubble at the pane's right edge, in .nsh/shots/jump-*.png:
// a long prompt's words stay inside the bubble — ellipsized at its width, never
// drawn past its edge onto the window's.
//
//   nsh test JumpLook.test.tsx --target macos
import { open, test } from "nsh/test";

const CAPSULE = "label:Back to the prompt";

test("a long prompt's words stay inside the bubble", async () => {
  const app = await open("./Harness.tsx", { width: 1180, height: 780, platform: "macos", locale: "en-US" });
  await app.waitFor("text:What are we building?");
  await app.type(
    "label:Message",
    "make a long plan for the migration of the entire billing subsystem across all three environments including rollback strategy",
  );
  await app.submit("label:Message");
  const deadline = Date.now() + 30000;
  for (;;) {
    await app.scroll("label:Conversation", 4000).catch(() => {});
    try {
      await app.waitFor(CAPSULE, { timeout: 4000 });
      break;
    } catch (e) {
      if (Date.now() > deadline) throw e;
    }
  }
  await app.wait(500);
  await app.screenshot(".nsh/shots/jump-long.png");
}, 60000);

test("read to the top: the bubble names the last prompt below, arrow down", async () => {
  const app = await open("./Harness.tsx", { width: 1180, height: 780, platform: "macos", locale: "en-US" });
  await app.waitFor("text:What are we building?");
  await app.type("label:Message", "make a long plan");
  await app.submit("label:Message");
  await app.waitFor("text:Part 1 of the plan", { timeout: 20000 });
  await app.type("label:Message", "make a plan");
  await app.submit("label:Message");
  // To the top: once the last prompt is left below the view, the bubble turns.
  const deadline = Date.now() + 30000;
  for (;;) {
    await app.scroll("label:Conversation", -4000).catch(() => {});
    try {
      await app.waitFor("label:Forward to the last prompt", { timeout: 2000 });
      break;
    } catch (e) {
      if (Date.now() > deadline) throw e;
    }
  }
  await app.wait(500);
  await app.screenshot(".nsh/shots/jump-below.png");
}, 60000);
