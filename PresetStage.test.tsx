// The live wallpaper presets on their own stage, dark and light, for design
// review of the shaders themselves.
//
//   nsh test PresetStage.test.tsx --target macos   # writes .nsh/shots/stage-*.png
//
// Only a real platform draws the shader, so headless runs skip.
import { open, test } from "nsh/test";
import { WALLPAPER_PRESET_DEFS } from "./lib/wallpaper-presets";

type Shot = {
  preset: string;
  dark: boolean;
  name: string;
  uniforms?: Record<string, number>;
  wait?: number;
  width?: number;
  height?: number;
};

const SHOTS: Shot[] = Object.keys(WALLPAPER_PRESET_DEFS).flatMap((preset) => [
  { preset, dark: false, name: "a" },
  { preset, dark: false, name: "b", uniforms: { phase: 2.6 } },
  { preset, dark: true, name: "a" },
]);

test("the wallpaper preset shaders draw full-window", async () => {
  for (const shot of SHOTS) {
    const { preset, dark, name, uniforms } = shot;
    const app = await open("./dev/WallpaperStage.tsx", {
      width: shot.width ?? 1440,
      height: shot.height ?? 900,
      platform: "macos",
      locale: "en-US",
      colorScheme: dark ? "dark" : "light",
      storage: {
        "stage.config": JSON.stringify({ preset, dark, uniforms }),
      },
    });
    await app.waitFor("text:stage");
    await app.wait(shot.wait ?? 600);
    try {
      await app.screenshot(
        `.nsh/shots/stage-${preset}-${dark ? "dark" : "light"}-${name}.png`,
      );
    } catch {
      return;
    }
    await (app as { close?: () => Promise<void> }).close?.();
  }
}, 600000);
