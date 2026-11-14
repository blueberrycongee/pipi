// The built-in live wallpapers themselves, dark and light, for design review.
//
//   nsh test PresetLook.test.tsx --target macos   # writes .nsh/shots/preset-*.png
//
// Only a real platform draws the shader, so headless runs skip.
import { open, test } from "nsh/test";
import { WALLPAPER_PRESET_META, WALLPAPER_PRESETS } from "./lib/wallpaper";

test("the live wallpaper presets render", async () => {
  for (const preset of WALLPAPER_PRESETS) {
    for (const scheme of ["dark", "light"] as const) {
      const app = await open("./Harness.tsx", {
        width: 1440,
        height: 900,
        platform: "macos",
        locale: "en-US",
        colorScheme: scheme,
        storage: {
          "harness.scenario": "welcome",
          "pipi.prefs.v1": JSON.stringify({
            workspaces: ["/Users/pip/code/pipi"],
            activeWorkspace: "/Users/pip/code/pipi",
            appearance: scheme,
            wallpaper: {
              path: `preset:${preset}`,
              name: WALLPAPER_PRESET_META[preset].name,
              width: 1920,
              height: 1080,
              adjustment: { focalX: 0.5, focalY: 0.5, zoom: 1 },
              kind: "shader",
              preset,
            },
          }),
        },
      });
      await app.waitFor("text:What are we building?");
      await app.wait(1500);
      try {
        await app.screenshot(`.nsh/shots/preset-${preset}-${scheme}.png`);
      } catch {
        return;
      }
      await (app as { close?: () => Promise<void> }).close?.();
    }
  }
}, 600000);
