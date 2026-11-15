// The send button's mode menu: the chevron picks what a send press does —
// the Enter default, an interrupt, or a queue — and the choice holds for the
// button and Enter alike until changed again.
import { expect, open, test } from "nsh/test";

const launch = (scenario = "welcome") =>
  open("./Harness.tsx", { width: 1180, height: 780, platform: "macos", locale: "en-US", storage: { "harness.scenario": scenario } });

test("the send button's menu picks how a message goes out, and Enter follows", async () => {
  const app = await launch("slow");
  await app.waitFor("text:What are we building?");
  await app.type("label:Message", "do it in steps");
  await app.submit("label:Message");
  await app.waitFor("text:Working", { timeout: 10000 });

  // Queue: the message waits out the run — the same as ⌘↵.
  await app.type("label:Message", "also update the readme");
  await app.press("label:Send options");
  await app.waitFor("text:Interrupt & send");
  await app.press("text:Queue");
  await app.waitFor("text:also update the readme");
  await app.waitUntil(() => app.count("label:Conversation >> text:Queued") === 1);

  // The choice holds: Enter now queues too.
  await app.type("label:Message", "and the changelog");
  await app.submit("label:Message");
  await app.waitUntil(() => app.count("label:Conversation >> text:Queued") === 2);

  // Interrupt: the run stops and the message takes over, while the queue
  // comes back to the composer rather than going in with it.
  await app.type("label:Message", "do this instead");
  await app.press("label:Send options");
  await app.waitFor("text:Interrupt & send");
  await app.press("text:Interrupt & send");
  await app.waitFor("text:do this instead", { timeout: 15000 });
  await app.waitUntil(() => app.count("label:Conversation >> text:Queued") === 0);
  expect(app.texts()).toContain("do this instead");
}, 90000);
