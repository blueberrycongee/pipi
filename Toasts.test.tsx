import { expect, open, test } from "nsh/test";

test("a toast the pointer rests on outlives its time, and leaves once it does", async () => {
  const app = await open("./Harness.tsx", {
    width: 1180,
    height: 780,
    platform: "macos",
    locale: "en-US",
    storage: { "harness.scenario": "welcome" },
  });
  await app.waitFor("text:What are we building?");

  // No wallpaper folder is set: ⌘U warns for ~4s.
  await app.keyboard.press("mod+u");
  await app.waitFor("text:Set a wallpaper folder in Settings → General first.");

  // Held by the pointer, it cannot vanish mid-reach.
  await app.hover("text:Set a wallpaper folder in Settings → General first.");
  await new Promise((resolve) => setTimeout(resolve, 5000));
  expect(app.texts()).toContain("Set a wallpaper folder in Settings → General first.");

  // The pointer leaving it starts what was left of its clock.
  await app.hover("label:Message");
  await app.waitUntil(() => !app.texts().includes("Set a wallpaper folder in Settings → General first."), { timeout: 6000 });
});
