// The queue's tray over the composer while a long reply streams: what stands at
// the foot of the conversation, and that the reply ends clear of it.
//
//   nsh test QueueLook.test.tsx --target macos   # writes .nsh/shots/queue-*.png
import { open, test } from "nsh/test";

type Scheme = "dark" | "light";
const launch = (colorScheme: Scheme) =>
  open("./Harness.tsx", { width: 1180, height: 780, platform: "macos", locale: "en-US", colorScheme, storage: { "harness.scenario": "slow" } });

test("queue over a streaming reply", async () => {
  for (const scheme of ["dark", "light"] as Scheme[]) {
    const app = await launch(scheme);
    await app.waitFor("text:What are we building?");
    await app.type("label:Message", "make a long plan");
    await app.submit("label:Message");
    await app.waitFor("text:Part 3 of the plan", { timeout: 60000 });
    // Each step here takes the driver some seconds while the reply streams: the queue is made in few.
    const queue = async (text: string) => {
      await app.type("label:Message", text);
      await app.keyboard.press("mod+enter");
    };
    await queue("also update the readme");
    await app.screenshot(`.nsh/shots/queue-1-${scheme}.png`);
    await app.type("label:Message", "and keep the changelog in step with it, every entry dated, the newest first, nothing left out");
    await app.submit("label:Message");
    await queue("then run the tests");
    await app.screenshot(`.nsh/shots/queue-3-${scheme}.png`);
    await queue("and tag the release");
    await app.paste("label:Message", { files: ["icon.png"] });
    await app.screenshot(`.nsh/shots/queue-more-${scheme}.png`);
    await app.press("label:Edit queued messages");
    await app.wait(400);
    await app.screenshot(`.nsh/shots/queue-recalled-${scheme}.png`);
  }
}, 180000);
