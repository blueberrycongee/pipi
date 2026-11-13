// A sent message taller than a few lines folds to a preview inside its bubble:
// a press on it — or on the chevron at its foot — opens it, and the chevron
// folds it back.
//
//   nsh test UserFold.test.tsx --target macos   # writes .nsh/shots/userfold-*.png
import { open, test } from "nsh/test";
import type { App } from "nsh/test";

const LONG = Array.from({ length: 24 }, (_, i) => `Step ${i + 1}: fold the part of this message that runs past a few lines.`).join("\n");

let drawn = true;
async function shot(app: App, name: string) {
  if (!drawn) return;
  try {
    await app.screenshot(`.nsh/shots/${name}.png`);
  } catch {
    drawn = false;
  }
}

test("a long user message folds and unfolds", async () => {
  const app = await open("./Harness.tsx", {
    width: 960,
    height: 720,
    platform: "macos",
    locale: "en-US",
    colorScheme: "light",
    storage: { "harness.scenario": "welcome" },
  });
  await app.waitFor("text:What are we building?");
  await app.paste("label:Message", { text: LONG });
  await app.submit("label:Message");
  await app.waitFor("label:Expand message");
  await shot(app, "userfold-folded");
  // A press on the folded message opens it too.
  await app.press("label:Conversation >> text:/Step 3/");
  await app.waitFor("label:Collapse message");
  await app.wait(300);
  await shot(app, "userfold-open");
  // The fold's chevron stands at the bubble's foot: bring the end of the conversation into view to reach it.
  await app.press("label:Scroll to bottom");
  await app.press("label:Collapse message");
  await app.waitFor("label:Expand message");
  await shot(app, "userfold-refolded");
}, 60000);
