import { expect, open, test } from "nsh/test";

const versions = [
  { content: "First progress version with enough words to wrap into a compact bubble.", at: 1000 },
  { content: "Second progress version, now closer to the latest answer.", at: 2000 },
  { content: "Latest answer.", at: 3000 },
];
const history = [
  ...Array.from({ length: 16 }, (_, i) => [
    { role: "user", content: `Question ${i} with a little more text`, timestamp: i * 10 + 1 },
    { role: "assistant", content: [{ type: "text", text: `Answer ${i}` }], provider: "test", model: "test", timestamp: i * 10 + 2, stopReason: "stop" },
  ]).flat(),
  { role: "user", content: "Coordinate these tasks", timestamp: 200 },
  { role: "assistant", content: [{ type: "text", text: "Latest answer." }], provider: "test", model: "test", timestamp: 201, stopReason: "stop", editKey: "summary", versions },
];

test("macOS edit history collapse, expansion, pinning and Escape", async () => {
  for (const colorScheme of ["light", "dark"] as const) {
    const app = await open("./Harness.tsx", {
      width: 1180,
      height: 780,
      platform: "macos",
      locale: "en-US",
      colorScheme,
      clock: {},
      storage: { "harness.scenario": "history", "harness.history": JSON.stringify(history) },
    });
    await app.press("id:sidebar-pip");
    await app.waitFor("id:pip-message-edited");
    await app.wait(300);
    const edited = "id:pip-message-edited";
    const region = "id:pip-edit-history-region";
    const above = "text:Question 15 with a little more text";
    const editedBefore = app.layout(edited)!;
    const aboveBefore = app.layout(above)!;
    await app.screenshot(`.nsh/shots/pip-edit-history-collapsed-${colorScheme}.png`);

    await app.hover(edited);
    await app.wait(560);
    const editedOpen = app.layout(edited)!;
    const aboveOpen = app.layout(above)!;
    const openRegion = app.layout(region)!;
    await app.screenshot(`.nsh/shots/pip-edit-history-expanded-${colorScheme}.png`);
    console.log(`pip-edit-history-${colorScheme}`, {
      editedBeforeY: editedBefore.y,
      editedOpenY: editedOpen.y,
      aboveBeforeY: aboveBefore.y,
      aboveOpenY: aboveOpen.y,
      regionY: openRegion.y,
      regionHeight: openRegion.height,
    });
    expect(Math.abs(editedOpen.y - editedBefore.y)).toBeLessThanOrEqual(0.75);
    expect(aboveOpen.y).toBeLessThan(aboveBefore.y - 30);
    expect(openRegion.y + openRegion.height).toBeLessThanOrEqual(editedOpen.y + 1);
    expect(app.viewStyle("id:pip-edit-history-version >> nth=0")?.opacity).toBeLessThan(0.6);

    await app.press(edited);
    await app.wait(240);
    await app.hover("id:sidebar-pip");
    await app.wait(360);
    expect(app.layout(region)?.height ?? 0).toBeGreaterThan(40);
    await app.keyboard.press("escape");
    await app.wait(560);
    expect(app.layout(region)?.height ?? 0).toBeLessThanOrEqual(0.75);
  }
}, 120000);
