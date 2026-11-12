// Copy from the conversation (`⌘C`) and paste into the composer (`⌘V`) on the
// real macOS host (`pasteBehavior="report"` cannot rely on `insertText` there,
// and selection spans across list items and settled `TextView` code blocks):
//
//   nsh test CopyPaste.test.tsx --target macos
import { expect, open, test } from "nsh/test";

const launch = () =>
  open("./Harness.tsx", {
    width: 1180,
    height: 780,
    platform: "macos",
    locale: "en-US",
    storage: { "harness.scenario": "history" },
  });

test("selects across list items and code blocks, copies with ⌘C, and pastes into the composer with ⌘V", async () => {
  const app = await launch();
  await app.waitFor("text:Here is the plan.");

  // Drag from the ordered-list marker `1.` across both items and into the code block.
  await app.drag("text:1.", { x: 220, y: 90 });
  await app.keyboard.press("mod+c");

  // Focus the composer (`⌘L`) and paste (`⌘V`): the copied prose lands in the draft.
  await app.keyboard.press("mod+l");
  await app.keyboard.press("mod+v");
  await app.waitUntil(() => (app.value("label:Message") ?? "").includes("Read the manifest."));

  const pasted = app.value("label:Message") ?? "";
  expect(pasted).toContain("Read the manifest.");
  expect(pasted).toContain("2.\tRun the tests.");
  expect(pasted).toContain("const answer = 42;");

  // Typing and pasting again appends at the caret instead of dropping the paste.
  await app.clear("label:Message");
  await app.type("label:Message", "Quote: ");
  await app.keyboard.press("mod+v");
  await app.waitUntil(() => (app.value("label:Message") ?? "").startsWith("Quote: ") && (app.value("label:Message") ?? "").length > 7);
  expect(app.value("label:Message")).toContain("Quote: ");
  expect(app.value("label:Message")).toContain("Read the manifest.");
});
