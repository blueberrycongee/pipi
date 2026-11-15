// Regression: static and dynamic wallpapers share one slot — a switch between
// kinds must fully take effect on every reachable path. Pausing belongs to the
// wallpaper it was set on (a newly applied wallpaper always starts playing),
// pause controls exist only where something animates, and configuring a
// rotation folder never replaces the wallpaper already chosen.
//
//   nsh test WallpaperSwitch.test.tsx
import { expect, open, test } from "nsh/test";
import { WALLPAPER_PRESET_META, WALLPAPER_PRESETS } from "./lib/wallpaper";

const VIDEO_WALLPAPER = {
  path: "/wallpapers/loop.mp4",
  name: "loop.mp4",
  width: 3840,
  height: 2160,
  adjustment: { focalX: 0.5, focalY: 0.5, zoom: 1 },
  kind: "video",
};

const PRESET = WALLPAPER_PRESETS[0];
const PRESET_META = WALLPAPER_PRESET_META[PRESET];

const PRESET_WALLPAPER = {
  path: `preset:${PRESET}`,
  name: PRESET_META.name,
  width: 1920,
  height: 1080,
  adjustment: { focalX: 0.5, focalY: 0.5, zoom: 1 },
  kind: "shader",
  preset: PRESET,
};

const prefs = (extra: Record<string, unknown>) =>
  JSON.stringify({
    workspaces: ["/Users/pip/code/pipi"],
    activeWorkspace: "/Users/pip/code/pipi",
    ...extra,
  });

const opts = (storage: Record<string, string>) => ({
  width: 1180,
  height: 780,
  platform: "macos" as const,
  locale: "en-US" as const,
  storage,
});

test("applying a new wallpaper always starts it playing — a pause never leaks onto the next kind", async () => {
  const app = await open(
    "./Harness.tsx",
    opts({
      "harness.scenario": "welcome",
      "pipi.prefs.v1": prefs({ wallpaper: VIDEO_WALLPAPER, wallpaperPaused: true }),
    }),
  );
  await app.waitFor("text:What are we building?");

  await app.press("label:Settings");
  await app.waitFor("text:Appearance");
  // The stored video arrives paused: the row offers Resume.
  expect(app.texts()).toContain("Resume");

  // Picking a live shader applies a new wallpaper — it plays, and its own
  // renderer takes over (a stale video element would still ask for the old src).
  await app.press(`text:${PRESET_META.en}`);
  await app.waitUntil(() => app.texts().includes("Pause") && !app.texts().includes("Resume"));
  expect(app.texts().some((t) => t.includes(PRESET_META.name))).toBe(true);

  // Pausing the shader and picking a preset anew resumes playback too.
  await app.press("text:Pause");
  await app.waitFor("text:Resume");
  await app.press(`text:${PRESET_META.en}`);
  await app.waitUntil(() => app.texts().includes("Pause") && !app.texts().includes("Resume"));
});

test("switching a live shader for a still image drops every dynamic control", async () => {
  const app = await open(
    "./Harness.tsx",
    opts({
      "harness.scenario": "welcome",
      "harness.wallpaper": "{}",
      "pipi.prefs.v1": prefs({
        wallpaper: PRESET_WALLPAPER,
        wallpaperPaused: true,
        wallpaperEffect: "dither",
      }),
    }),
  );
  await app.waitFor("text:What are we building?");

  // The injected image replaces the stored shader before the app boots: what
  // arrives is a still image under a static effect — pausable by nothing.
  await app.press("label:Settings");
  await app.waitFor("text:Appearance");
  const texts = app.texts();
  expect(texts.some((t) => t.includes("dmg-background"))).toBe(true);
  expect(texts).not.toContain("Pause");
  expect(texts).not.toContain("Resume");
  expect(texts).not.toContain("Mute");
  expect(texts).not.toContain("Video click action");

  // Turning an animated overlay on makes the same image pausable; back to a
  // static one removes it again.
  await app.press("text:Rain");
  await app.waitFor("text:Pause");
  await app.press("text:Dither");
  await app.waitUntil(() => !app.texts().includes("Pause"));
});

test("a stored overlay effect never paints over a dynamic wallpaper — it is the image's own", async () => {
  const app = await open(
    "./Harness.tsx",
    opts({
      "harness.scenario": "welcome",
      "pipi.prefs.v1": prefs({ wallpaper: VIDEO_WALLPAPER, wallpaperEffect: "rain" }),
    }),
  );
  await app.waitFor("text:What are we building?");

  await app.press("label:Settings");
  await app.waitFor("text:Appearance");
  // The stored rain would overlay the video as a second animation — instead it
  // is masked: no picker, and the video keeps only its own pause control.
  expect(app.texts()).not.toContain("Wallpaper effect");
  expect(app.texts()).toContain("Pause");

  // A live shader is dynamic too — the picker stays away there as well.
  await app.press(`text:${PRESET_META.en}`);
  await app.waitUntil(() => app.texts().some((t) => t.includes(PRESET_META.name)));
  expect(app.texts()).not.toContain("Wallpaper effect");
});

test("dropping the animated overlay clears a pause nothing could undo", async () => {
  const app = await open(
    "./Harness.tsx",
    opts({
      "harness.scenario": "welcome",
      "harness.wallpaper": "{}",
      "pipi.prefs.v1": prefs({ wallpaperEffect: "rain", wallpaperPaused: true }),
    }),
  );
  await app.waitFor("text:What are we building?");

  await app.press("label:Settings");
  await app.waitFor("text:Appearance");
  // The image under rain arrives paused — Resume is offered.
  await app.waitFor("text:Resume");

  // Switching to a static overlay leaves nothing to pause on: the stuck pause
  // is cleared together with the control that held it.
  await app.press("text:Dither");
  await app.waitUntil(() => !app.texts().includes("Resume") && !app.texts().includes("Pause"));

  // Picking rain again starts it playing — not frozen on the old pause.
  await app.press("text:Rain");
  await app.waitFor("text:Pause");
});

test("choosing a rotation folder never replaces the current wallpaper", async () => {
  const app = await open(
    "./Harness.tsx",
    opts({
      "harness.scenario": "welcome",
      "harness.pickedFolder": "/Users/pip/Pictures/wallpapers",
      "pipi.prefs.v1": prefs({ wallpaper: PRESET_WALLPAPER }),
    }),
  );
  await app.waitFor("text:What are we building?");

  await app.press("label:Settings");
  await app.waitFor("text:Appearance");
  await app.press("text:Choose folder");
  await app.waitUntil(() => app.texts().some((t) => t.includes("~/Pictures/wallpapers")));
  // The folder is remembered for ⌘U; the live shader stays applied.
  expect(app.texts().some((t) => t.includes(PRESET_META.name))).toBe(true);
});

test("choosing a rotation folder with no wallpaper reaches for one — and toasts when it cannot", async () => {
  const app = await open(
    "./Harness.tsx",
    opts({
      "harness.scenario": "welcome",
      "harness.pickedFolder": "/Users/pip/Pictures/wallpapers",
      "pipi.prefs.v1": prefs({}),
    }),
  );
  await app.waitFor("text:What are we building?");

  await app.press("label:Settings");
  await app.waitFor("text:Appearance");
  await app.press("text:Choose folder");
  // Headless has no native filesystem, so the immediate rotation attempt fails
  // loudly instead of silently leaving the folder half-configured.
  await app.waitUntil(() => app.texts().some((t) => t.startsWith("Could not switch wallpaper")));
  expect(app.texts().some((t) => t.includes("~/Pictures/wallpapers"))).toBe(true);
});

test("a pick that cannot be applied toasts the failure and keeps the current wallpaper", async () => {
  const app = await open(
    "./Harness.tsx",
    opts({
      "harness.scenario": "welcome",
      "harness.pickedImage": "/Users/pip/Pictures/photo.png",
      "pipi.prefs.v1": prefs({ wallpaper: PRESET_WALLPAPER }),
    }),
  );
  await app.waitFor("text:What are we building?");

  await app.press("label:Settings");
  await app.waitFor("text:Appearance");
  await app.press("text:Replace");
  await app.waitUntil(() => app.texts().some((t) => t.startsWith("Could not set wallpaper")));
  expect(app.texts().some((t) => t.includes(PRESET_META.name))).toBe(true);
});

/** mod+k lands while the shell settles now and then; pressing again is the user's own remedy. */
async function openPalette(app: Awaited<ReturnType<typeof open>>) {
  for (let i = 0; i < 3; i++) {
    await app.keyboard.press("mod+k");
    const shown = await app
      .waitFor("text:Random Wallpaper", { timeout: 2500 })
      .then(() => true)
      .catch(() => false);
    if (shown) return;
  }
  throw new Error("command palette never opened");
}

test("pause exists only where something animates — palette and settings agree", async () => {
  const app = await open(
    "./Harness.tsx",
    opts({
      "harness.scenario": "welcome",
      "harness.wallpaper": "{}",
      "pipi.prefs.v1": prefs({ wallpaperEffect: "none" }),
    }),
  );
  await app.waitFor("text:What are we building?");

  // A still image under a static effect: no pause anywhere.
  await openPalette(app);
  expect(app.texts()).not.toContain("Pause Dynamic Wallpaper");
  expect(app.texts()).not.toContain("Resume Dynamic Wallpaper");
  await app.keyboard.press("escape");
  await app.waitUntil(() => app.texts().includes("What are we building?"));

  // Turn on an animated overlay effect: the same image becomes pausable.
  await app.press("label:Settings");
  await app.waitFor("text:Wallpaper effect");
  await app.press("text:Rain");
  await app.keyboard.press("escape");
  await app.waitUntil(() => app.count("id:settings-nav-agents") === 0);

  await openPalette(app);
  expect(app.texts()).toContain("Pause Dynamic Wallpaper");
  await app.keyboard.press("escape");
});
