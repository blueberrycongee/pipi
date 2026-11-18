// Regression: opening Settings and switching sections/subpages inside it
// must settle immediately without replaying stagger entrances, leaking hidden
// panes, re-mounting canvas-heavy tabs, or flashing Usage's empty state.
//
//   nsh test Settings.test.tsx
//   nsh test Settings.test.tsx --target macos
import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";
import { decodeLumGridAsync, pixelDiff } from "./dev/frames";
import { WALLPAPER_PRESET_META, WALLPAPER_PRESETS } from "./lib/wallpaper";

const PRESET = WALLPAPER_PRESETS[0];
const PRESET_META = WALLPAPER_PRESET_META[PRESET];

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

test("Shortcuts lists the app's keys as platform caps", async () => {
  const app = await open("./Harness.tsx", {
    width: 1180,
    height: 780,
    platform: "macos",
    locale: "en-US",
    storage: { "harness.scenario": "welcome" },
  });
  await app.waitFor("text:What are we building?");

  await app.press("label:Settings");
  await app.waitFor("id:settings-nav-shortcuts");
  await app.press("id:settings-nav-shortcuts");
  await app.waitFor("text:Complete the highlighted command");

  const texts = app.texts();
  for (const row of ["New session", "Compare agents", "Stop", "Send", "Queue a follow-up", "Slash commands", "Command palette", "Escape"]) {
    expect(texts).toContain(row);
  }
  // On macOS a `keymap.label` cap renders with ⌘; literal caps stay literal.
  for (const cap of ["⌘N", "⇧⌘O", "⌘.", "⌘↩", "/", "!", "!!", "⌘K", "⌘,"]) {
    expect(texts).toContain(cap);
  }
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

test("dynamic wallpaper entry points show in Settings and Command Palette, and stored dynamic prefs survive a reload", async () => {
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
          path: `preset:${PRESET}`,
          name: PRESET_META.name,
          width: 1920,
          height: 1080,
          adjustment: { focalX: 0.5, focalY: 0.5, zoom: 1 },
          kind: "shader",
          preset: PRESET,
        },
        wallpaperEffect: "ripple",
        wallpaperInteractive: true,
        wallpaperAgentReactive: true,
        wallpaperPaused: true,
      }),
    },
  });
  await app.waitFor("text:What are we building?");

  await app.press("label:Settings");
  await app.waitFor("text:Appearance");
  const settingsTexts = app.texts();
  // A stored live shader wallpaper loads as itself — not normalized away.
  expect(settingsTexts).toContain("Live wallpaper presets");
  expect(settingsTexts).toContain(PRESET_META.en);
  expect(settingsTexts).toContain("Interactive wallpaper");
  expect(settingsTexts).toContain("React to agent activity");
  expect(settingsTexts).toContain("Auto-pause");
  // The stored overlay effect is masked on a live shader — the picker is a
  // still image's own control and stays out of dynamic kinds.
  expect(settingsTexts).not.toContain("Wallpaper effect");
  // The stored pause survived too: a pausable wallpaper offers Resume.
  expect(settingsTexts).toContain("Resume");

  await app.keyboard.press("escape");
  await app.waitUntil(() => app.count("id:settings-nav-agents") === 0);

  await app.keyboard.press("mod+k");
  await app.waitFor("text:Random Wallpaper");
  // The list draws the rows in view: asked for by name, the wallpaper's are among them wherever they stand in it.
  await app.type("label:Commands", "wallpaper");
  await app.waitUntil(() => app.texts().some((t) => t.includes("Live Wallpaper")));
  const paletteTexts = app.texts();
  expect(paletteTexts.some((t) => t.includes("Live Wallpaper"))).toBe(true);
  expect(paletteTexts).toContain("Resume Dynamic Wallpaper");
  await app.keyboard.press("escape");

  // With a still image and no animated effect, the dynamic controls exist but
  // pause/mute stay away — nothing on it can pause.
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
        wallpaperEffect: "none",
      }),
    },
  });
  await staticApp.waitFor("text:What are we building?");
  await staticApp.press("label:Settings");
  await staticApp.waitFor("text:Wallpaper effect");
  const staticTexts = staticApp.texts();
  expect(staticTexts).toContain("Replace");
  expect(staticTexts).toContain("Dither");
  expect(staticTexts).toContain("ASCII");
  expect(staticTexts).toContain("Halftone");
  expect(staticTexts).toContain("Scanlines");
  expect(staticTexts).toContain("Ripple");
  expect(staticTexts).toContain("Rain");
  expect(staticTexts).toContain("Live wallpaper presets");
  expect(staticTexts).toContain("Interactive wallpaper");
  expect(staticTexts).toContain("React to agent activity");
  expect(staticTexts).toContain("Auto-pause");
  expect(staticTexts).toContain("Match wallpaper colors");
  expect(staticTexts).not.toContain("Pause");
  expect(staticTexts).not.toContain("Resume");
  expect(staticTexts).not.toContain("Mute");
  expect(staticTexts).not.toContain("Video click action");
});
