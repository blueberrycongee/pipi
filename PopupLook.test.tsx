import { open, test } from "nsh/test";

test("composer popups over the welcome screen", async () => {
  for (const colorScheme of ["light", "dark"] as const) {
    const app = await open("./Harness.tsx", {
      width: 1180, height: 780, platform: "linux", locale: "en-US", colorScheme,
      storage: { "harness.scenario": "welcome" },
    });
    await app.waitFor("text:What are we building?");
    await app.press("text:Claude Sonnet 4.5");
    await app.waitFor("text:Search models");
    await app.wait(500);
    await app.screenshot(`.nsh/shots/popup-models-${colorScheme}.png`);
    await app.keyboard.press("escape");
    await app.press("id:agent-chip");
    await app.waitFor("id:agent-picker");
    await app.wait(500);
    await app.screenshot(`.nsh/shots/popup-agents-${colorScheme}.png`);
  }
}, 30000);
