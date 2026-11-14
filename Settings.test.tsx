// Regression: opening Settings and switching sections/subpages inside it
// must settle immediately without replaying stagger entrances, leaking hidden
// panes, re-mounting canvas-heavy tabs, or flashing Usage's empty state.
//
//   nsh test Settings.test.tsx
//   nsh test Settings.test.tsx --target macos
import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";
import { decodeLumGridAsync, pixelDiff } from "./dev/frames";

const OUT = ".nsh/shots/settings";

async function tryShotBytes(app: App, path: string): Promise<Uint8Array | null> {
  try {
    return await app.screenshot(path);
  } catch {
    return null;
  }
}

test("Settings switches sections and subpages without remounting or leaking hidden panes", async () => {
  const app = await open("./Harness.tsx", {
    width: 1180,
    height: 780,
    platform: "macos",
    locale: "en-US",
    storage: { "harness.scenario": "welcome" },
  });
  await app.waitFor("text:What are we building?");

  await app.press("label:Settings");
  await app.waitFor("id:settings-nav-agents");

  // Switching to Agents allows filtering by search and by Segmented filter (native Tabs).
  await app.press("id:settings-nav-agents");
  await app.waitFor("text:Coding Agent Harnesses");
  await app.type("label:Search coding agents", "claude");
  expect(app.texts()).toContain("Claude Code");
  expect(app.texts()).not.toContain("Codex");

  await app.clear("label:Search coding agents");
  await app.press("text:ACP");
  await app.waitUntil(() => app.texts().includes("Devin") && !app.texts().includes("Claude Code"));
  await app.press("text:/^All \\(/");
  await app.waitFor("text:Claude Code");

  // Drill into Pi Providers: hidden Agents pane must stay out of visible texts while preserving state.
  await app.type("label:Search coding agents", "pi");
  await app.press("text:Providers");
  await app.waitFor("text:Anthropic");
  expect(app.texts()).toContain("Steering messages");
  expect(app.texts()).not.toContain("Coding Agent Harnesses");

  // Returning to Agents restores the visited pane with its search filter still intact.
  await app.press("id:settings-back");
  await app.waitFor("text:Coding Agent Harnesses");
  expect(app.value("label:Search coding agents")).toBe("pi");

  // Visiting Usage never flashes the false-empty copy when saved sessions already report usage.
  await app.press("id:settings-nav-usage");
  await app.waitFor("text:By agent");
  expect(app.texts()).not.toContain("No usage reported yet");

  // Escape from Usage (after Agents search input had focus) triggers close;
  // re-opening mid-close reverses smoothly without unmounting visited panes.
  await app.keyboard.press("escape");
  await app.wait(20);
  const midClose = app.count("id:settings-nav-agents") > 0;
  await app.press("label:Settings");
  await app.waitFor("text:Appearance");
  if (midClose) {
    await app.press("id:settings-nav-agents");
    await app.waitFor("text:Coding Agent Harnesses");
    expect(app.value("label:Search coding agents")).toBe("pi");
  }

  // Escape also closes Settings cleanly while a visible TextField inside Settings holds focus.
  await app.press("id:settings-nav-agents");
  await app.waitFor("text:Coding Agent Harnesses");
  await app.type("label:Search coding agents", "x");
  await app.keyboard.press("escape");
  await app.waitUntil(() => app.count("id:settings-nav-agents") === 0);
});

test("Settings section switches land settled on the first frame", async () => {
  const app = await open("./Harness.tsx", {
    width: 1180,
    height: 780,
    platform: "macos",
    locale: "en-US",
    colorScheme: "dark",
    storage: { "harness.scenario": "history" },
  });
  await app.waitFor("text:Here is the plan.");

  await app.press("label:Settings");
  await app.waitFor("id:settings-nav-agents");
  await app.wait(300);

  const checkSwitch = async (label: string, targetSelector: string, readyText: string) => {
    const pressing = app.press(targetSelector);
    let landed = false;
    for (let i = 0; i < 120; i++) {
      if (app.texts().includes(readyText)) {
        landed = true;
        break;
      }
      await app.wait(10);
    }
    expect(landed).toBe(true);
    const b0 = await tryShotBytes(app, `${OUT}-${label}-f0.png`);
    const b1 = await tryShotBytes(app, `${OUT}-${label}-f1.png`);
    await pressing;
    await app.wait(500);
    const bs = await tryShotBytes(app, `${OUT}-${label}-settled.png`);
    if (b0 && b1 && bs) {
      const f0 = await decodeLumGridAsync(b0, 8);
      const f1 = await decodeLumGridAsync(b1, 8);
      const settled = await decodeLumGridAsync(bs, 8);
      const x0 = Math.round(settled.width * 0.35);
      const x1 = Math.round(settled.width * 0.82);
      const y0 = Math.round(settled.height * 0.15);
      const y1 = Math.round(settled.height * 0.85);
      expect(pixelDiff(f0, settled, x0, x1, y0, y1)).toBeLessThan(0.02);
      expect(pixelDiff(f1, settled, x0, x1, y0, y1)).toBeLessThan(0.02);
    }
  };

  await checkSwitch("general-to-agents", "id:settings-nav-agents", "Coding Agent Harnesses");
  await checkSwitch("agents-to-usage", "id:settings-nav-usage", "By agent");
  await checkSwitch("usage-to-general", "id:settings-nav-general", "Appearance");
}, 60000);

test("dynamic wallpaper entry points are hidden in Settings and Command Palette, and stored dynamic prefs are cleared", async () => {
  const app = await open("./Harness.tsx", {
    width: 1180,
    height: 780,
    platform: "macos",
    locale: "en-US",
    storage: {
      "harness.scenario": "welcome",
      "pipi.prefs.v1": JSON.stringify({
        workspaces: ["/Users/pip/code/pipi"],
        activeWorkspace: "/Users/pip/code/pipi",
        wallpaper: {
          path: "preset:aurora",
          name: "Aurora Borealis",
          width: 1920,
          height: 1080,
          adjustment: { focalX: 0.5, focalY: 0.5, zoom: 1 },
          kind: "shader",
          preset: "aurora",
        },
        wallpaperEffect: "ripple",
        wallpaperInteractive: true,
        wallpaperAgentReactive: true,
      }),
    },
  });
  await app.waitFor("text:What are we building?");

  await app.press("label:Settings");
  await app.waitFor("text:Appearance");
  const settingsTexts = app.texts();
  expect(settingsTexts).toContain("Choose image");
  expect(settingsTexts).not.toContain("Live wallpaper presets");
  expect(settingsTexts).not.toContain("Aurora");
  expect(settingsTexts).not.toContain("Interactive wallpaper");
  expect(settingsTexts).not.toContain("React to agent activity");
  expect(settingsTexts).not.toContain("Auto-pause");
  expect(settingsTexts).not.toContain("Ripple");
  expect(settingsTexts).not.toContain("Rain");

  await app.keyboard.press("escape");
  await app.waitUntil(() => app.count("id:settings-nav-agents") === 0);

  await app.keyboard.press("mod+k");
  await app.waitFor("text:Random Wallpaper");
  const paletteTexts = app.texts();
  expect(paletteTexts.some((t) => t.includes("Live Wallpaper"))).toBe(false);
  expect(paletteTexts).not.toContain("Pause Dynamic Wallpaper");
  expect(paletteTexts).not.toContain("Resume Dynamic Wallpaper");
  await app.keyboard.press("escape");

  // With a static image wallpaper, static shader effects and color matching still appear,
  // while dynamic effects and controls stay hidden.
  const staticApp = await open("./Harness.tsx", {
    width: 1180,
    height: 780,
    platform: "macos",
    locale: "en-US",
    storage: {
      "harness.scenario": "welcome",
      "harness.wallpaper": "{}",
      "pipi.prefs.v1": JSON.stringify({
        workspaces: ["/Users/pip/code/pipi"],
        activeWorkspace: "/Users/pip/code/pipi",
        wallpaperEffect: "ripple",
        wallpaperInteractive: true,
        wallpaperAgentReactive: true,
      }),
    },
  });
  await staticApp.waitFor("text:What are we building?");
  await staticApp.press("label:Settings");
  await staticApp.waitFor("text:Wallpaper effect");
  const staticTexts = staticApp.texts();
  expect(staticTexts).toContain("Replace image");
  expect(staticTexts).toContain("Dither");
  expect(staticTexts).toContain("ASCII");
  expect(staticTexts).toContain("Halftone");
  expect(staticTexts).toContain("Scanlines");
  expect(staticTexts).toContain("Match wallpaper colors");
  expect(staticTexts).not.toContain("Ripple");
  expect(staticTexts).not.toContain("Rain");
  expect(staticTexts).not.toContain("Live wallpaper presets");
  expect(staticTexts).not.toContain("Interactive wallpaper");
  expect(staticTexts).not.toContain("React to agent activity");
  expect(staticTexts).not.toContain("Video click action");
  expect(staticTexts).not.toContain("Auto-pause");
  expect(staticTexts).not.toContain("Pause");
  expect(staticTexts).not.toContain("Mute");
});
