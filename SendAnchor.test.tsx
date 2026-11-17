// Natural Reading Physics: sending a prompt lets the conversation grow upward
// naturally without injecting a blank runway or flinging short replies to the
// top. Long replies pause gently once the prompt reaches the reading horizon
// below the title bar (never yanking to the bottom on settle); any upward
// scroll immediately cancels auto-follow with zero bounce-back jitter.
//
//   nsh test SendAnchor.test.tsx --target macos    # on the real list
import { expect, open, test } from "nsh/test";

const PILL = "label:Scroll to bottom";
const JUMP = "label:Back to the prompt";

const LONG_REPLY = Array.from(
  { length: 12 },
  (_, i) => `### Part ${i + 1} of the reply\n\nSection ${i + 1} explains a step of the work in a few lines, so the reply grows past the viewport while it streams.`,
).join("\n\n");

test("a long reply grows naturally to the reading horizon, holds the prompt in view, and never yanks to the bottom on settle", async () => {
  const app = await open("./Harness.tsx", {
    width: 1180,
    height: 780,
    platform: "macos",
    locale: "en-US",
    storage: {
      "harness.scenario": "stream",
      "harness.long": "1",
      "harness.then": "3000:/sessions/two.jsonl",
      "harness.reply": LONG_REPLY,
    },
  });
  await app.waitFor("text:Part 24 of the plan", { timeout: 20000 });
  await app.type("label:Message", "keep going on the plan");
  await app.submit("label:Message");

  // Once the long reply settles, the prompt stays calmly held at the reading
  // horizon rather than yanking the reader to the bottom.
  await app.waitFor("label:Send", { timeout: 60000 });
  await app.waitFor(PILL, { timeout: 5000 });
  expect(app.shows(JUMP)).toBe(false);

  // Pressing the bottom pill takes the reader to the end, leaving the prompt above.
  await app.press(PILL);
  await app.waitFor(PILL, { state: "gone", timeout: 5000 });
  await app.waitFor(JUMP, { timeout: 5000 });
}, 90000);

test("a short reply stays at rest with zero dead runway and zero settle jump", async () => {
  const app = await open("./Harness.tsx", {
    width: 1180,
    height: 780,
    platform: "macos",
    locale: "en-US",
    storage: { "harness.scenario": "stream", "harness.distinct": "1", "harness.reply": "On it." },
  });
  await app.waitFor("text:What are we building?", { timeout: 20000 });
  await app.press("id:sidebar-recents >> text:Refactor the transcript reducer");
  await app.waitFor("text:Here is the plan.", { timeout: 20000 });

  await app.type("label:Message", "and then what");
  await app.submit("label:Message");
  await app.waitFor("text:On it.", { timeout: 20000 });
  await app.waitFor("label:Send", { timeout: 20000 });

  for (let i = 0; i < 20; i++) {
    expect(app.texts().some((t) => t.includes("and then what"))).toBe(true);
    expect(app.shows(PILL)).toBe(false);
    await app.wait(16);
  }

  // Zero dead runway below: attempting to scroll further down cannot push the prompt off-screen.
  await app.scroll("label:Conversation", 2000).catch(() => {});
  await app.wait(200);
  expect(app.shows(JUMP)).toBe(false);
}, 90000);

test("an upward scroll immediately cancels auto-follow without bounce-back jitter and holds as the reply grows", async () => {
  const app = await open("./Harness.tsx", {
    width: 1180,
    height: 780,
    platform: "macos",
    locale: "en-US",
    storage: { "harness.scenario": "stream", "harness.distinct": "1", "harness.reply": LONG_REPLY },
  });
  await app.waitFor("text:What are we building?", { timeout: 20000 });
  await app.press("id:sidebar-recents >> text:Refactor the transcript reducer");
  await app.waitFor("text:Here is the plan.", { timeout: 20000 });

  await app.type("label:Message", "and then what");
  await app.submit("label:Message");
  await app.waitFor("text:Part 3 of the reply", { timeout: 20000 });

  await app.scroll("label:Conversation", -60);
  await app.waitFor(PILL, { timeout: 2000 });

  // As the rest of the reply streams in, the reader's upward intent holds without snapping back.
  for (let i = 0; i < 20; i++) {
    expect(app.shows(PILL)).toBe(true);
    await app.wait(120);
  }
}, 90000);
