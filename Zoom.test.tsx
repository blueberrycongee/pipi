// A table's hover-revealed expand button opens it in the window's zoom layer —
// the table again, roomier, over the scrim — and Escape or its own close
// button leaves it. The layer is the app's one zoom surface (`ui/Zoom.tsx`):
// a picture a `TextView` reports (`onImagePress`) lands in the same place.
//
//   nsh test Zoom.test.tsx --target macos   # writes .nsh/shots/zoom-*.png
import { open, test } from "nsh/test";
import type { App } from "nsh/test";

const REPLY = [
  "Here is the comparison:",
  "",
  "| Form | Problem |",
  "| --- | --- |",
  "| Plain chat | A linear history cannot hold a search tree; hundreds of agents break the one thread |",
  "| IDE | Assumes a person at the keyboard; a run of days is the wrong metaphor |",
  "| Kanban cards | Close, but a card loses which result grew which branch |",
  "| Experiment graph | The right structure, but nobody works inside a topology all day |",
].join("\n");

let drawn = true;
async function shot(app: App, name: string) {
  if (!drawn) return;
  try {
    await app.screenshot(`.nsh/shots/${name}.png`);
  } catch {
    drawn = false;
  }
}

test("a table expands into the zoom layer and leaves it", async () => {
  const app = await open("./Harness.tsx", {
    width: 960,
    height: 720,
    platform: "macos",
    locale: "en-US",
    colorScheme: "light",
    storage: { "harness.scenario": "welcome", "harness.reply": REPLY },
  });
  await app.waitFor("text:What are we building?");
  await app.paste("label:Message", { text: "compare the forms" });
  await app.submit("label:Message");
  await app.waitFor("text:Experiment graph");
  // The button is quiet until the table's group has the pointer.
  await app.hover("text:Experiment graph");
  await shot(app, "zoom-table-hover");
  await app.press("label:Expand");
  await app.waitFor("label:Close preview");
  await shot(app, "zoom-table-open");
  // Escape leaves the layer; the table hears its button again.
  await app.keyboard.press("escape");
  await app.waitUntil(() => app.count("label:Close preview") === 0);
  await app.hover("text:Experiment graph");
  await app.press("label:Expand");
  await app.waitFor("label:Close preview");
  // And so does the layer's own close button (the backdrop takes the same label first).
  await app.press("label:Close preview >> nth=1");
  await app.waitUntil(() => app.count("label:Close preview") === 0);
}, 60000);
