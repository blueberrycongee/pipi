import { expect, open, test } from "nsh/test";

// How a run's errors reach the reader (`pi/transcript.ts`, `store/app.ts`):
// nothing shows only to be withdrawn, and nothing is said twice.
//
//   nsh test Errors.test.tsx

const launch = (scenario = "welcome") =>
  open("./Harness.tsx", { width: 1180, height: 780, platform: "macos", locale: "en-US", storage: { "harness.scenario": scenario } });

const ERROR = "The model returned an error";
const REASON = "529 overloaded";

test("an error Pi retries never enters the conversation: the status line says so, then the answer comes", async () => {
  const app = await launch("stream");
  await app.waitFor("text:What are we building?");
  await app.type("label:Message", "a flaky plan");
  await app.submit("label:Message");
  await app.waitFor("text:Retrying (1 of 2)", { timeout: 10000 });
  expect(app.texts()).toContain(REASON);
  // Watched all the way to the answer: an error row at no moment, not even one that is taken back.
  let flashed = false;
  await app.waitUntil(
    () => {
      const texts = app.texts();
      if (texts.includes(ERROR)) flashed = true;
      return texts.includes("Back on my feet: here is the plan.") && app.shows("label:Send");
    },
    { timeout: 20000 },
  );
  expect(flashed).toBe(false);
  expect(app.texts()).not.toContain(REASON);
  // The attempts are one turn, under one header.
  expect(app.texts().filter((text) => text.startsWith("Finished in"))).toHaveLength(1);
}, 40000);

test("when the retries run out the failure is said once, and the status line does not flap between attempts", async () => {
  const app = await launch("stream");
  await app.waitFor("text:What are we building?");
  await app.type("label:Message", "an outage");
  await app.submit("label:Message");
  // (The line does say "Thinking" before anything failed: the check below can see it.)
  await app.waitFor("text:Thinking", { timeout: 10000 });
  await app.waitFor("text:Retrying (1 of 2)", { timeout: 10000 });
  // From the first retry to the end the line counts attempts; it does not fall back to "Thinking" each time one starts.
  let flapped = false;
  let second = false;
  await app.waitUntil(
    () => {
      const texts = app.texts();
      if (texts.includes(ERROR)) return true;
      if (texts.includes("Thinking")) flapped = true;
      if (texts.includes("Retrying (2 of 2)")) second = true;
      return false;
    },
    { timeout: 20000 },
  );
  await app.waitFor("label:Send");
  expect(flapped).toBe(false);
  expect(second).toBe(true);
  // Three attempts failed: one notice, with the reason once — not one per attempt and a summary after.
  expect(app.texts().filter((text) => text === ERROR)).toHaveLength(1);
  expect(app.texts().filter((text) => text === REASON)).toHaveLength(1);
  expect(app.texts().some((text) => text.startsWith("Gave up"))).toBe(false);

  // Left and opened again, the conversation reads the same: the notice is the session's own, not the client's.
  await app.press("id:sidebar-workspaces >> text:Refactor the transcript reducer");
  await app.waitFor("text:Here is the plan.");
  await app.press("id:sidebar-workspaces >> text:an outage");
  await app.waitFor(`text:${ERROR}`);
  await app.wait(600);
  expect(app.texts().filter((text) => text === ERROR)).toHaveLength(1);
  expect(app.texts().filter((text) => text === REASON)).toHaveLength(1);
}, 60000);

test("stopping while Pi waits to retry leaves no error behind", async () => {
  const app = await launch("slow");
  await app.waitFor("text:What are we building?");
  await app.type("label:Message", "an outage");
  await app.submit("label:Message");
  await app.waitFor("text:Retrying (1 of 2)", { timeout: 20000 });
  await app.press("label:Stop");
  await app.waitFor("label:Send", { timeout: 10000 });
  await app.wait(400);
  const texts = app.texts();
  expect(texts).toContain("an outage");
  expect(texts).not.toContain(ERROR);
  expect(texts.some((text) => text.includes("Retry cancelled") || text.startsWith("Gave up") || text.includes("Could not stop"))).toBe(false);
}, 60000);

test("a message Pi turns down is said once, in a toast, and comes back to the composer", async () => {
  const app = await launch();
  await app.waitFor("text:What are we building?");
  await app.type("label:Message", "refuse this");
  await app.submit("label:Message");
  const toast = "The message was not sent: No API key found for the selected model.";
  await app.waitFor(`text:${toast}`);
  // Nothing was sent, so nothing joins the conversation: the chat is as it was, with the words to try again.
  await app.waitFor("text:What are we building?");
  expect(app.texts()).not.toContain("The message was not sent");
  expect(app.value("label:Message")).toBe("refuse this");
  // Failing again is the same toast staying, not a second one, nor the first leaving and coming back.
  await app.submit("label:Message");
  await app.wait(300);
  expect(app.texts().filter((text) => text === toast)).toHaveLength(1);
  expect(app.value("label:Message")).toBe("refuse this");
});
