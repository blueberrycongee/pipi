import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";
import { decodeLumGrid, pixelDiff, type Grid } from "./dev/frames";

type Scheme = "light" | "dark";

const LONG_PERSONA_REPLY = Array.from(
  { length: 22 },
  (_, i) => `### Part ${i + 1}\n\nSection ${i + 1} carries enough prose to keep the persona conversation scrolling under its centered identity.`,
).join("\n\n");

const PERSONA_HISTORY = JSON.stringify([
  { role: "user", content: "Write the long review", timestamp: 1 },
  {
    role: "assistant",
    content: [{ type: "text", text: LONG_PERSONA_REPLY }],
    provider: "test",
    model: "test",
    timestamp: 2,
    stopReason: "stop",
  },
]);

const launch = (colorScheme: Scheme, withWallpaper: boolean) =>
  open("./Harness.tsx", {
    width: 1180,
    height: 780,
    platform: "macos",
    locale: "en-US",
    colorScheme,
    clock: {},
    storage: {
      "harness.scenario": "history",
      "harness.history": PERSONA_HISTORY,
      "pipi.prefs.v1": JSON.stringify({ appearance: colorScheme }),
      ...(withWallpaper ? { "harness.wallpaper": "{}" } : {}),
    },
  });

function transcriptProbeBoxes(capsule: { x: number; y: number; width: number; height: number }, grid: Grid) {
  const y0 = Math.max(0, Math.floor(capsule.y - 2));
  const y1 = Math.min(grid.height, Math.ceil(capsule.y + capsule.height + 18));
  const reach = 220;
  const gap = 10;
  const left = {
    x0: Math.max(0, Math.floor(capsule.x - reach)),
    x1: Math.max(0, Math.floor(capsule.x - gap)),
    y0,
    y1,
  };
  const right = {
    x0: Math.min(grid.width, Math.ceil(capsule.x + capsule.width + gap)),
    x1: Math.min(grid.width, Math.ceil(capsule.x + capsule.width + reach)),
    y0,
    y1,
  };
  return [left, right].filter((box) => box.x1 > box.x0 && box.y1 > box.y0);
}

async function expectCompactCapsuleOverTranscript(app: App) {
  const capsule = app.layout("id:persona-header-capsule")!;
  expect(capsule.height).toBeLessThanOrEqual(36);
  expect(capsule.width).toBeLessThan(240);
  expect(capsule.width).toBeGreaterThan(72);

  expect(app.count("id:persona-header-capsule >> id:persona-avatar-button")).toBe(1);
  expect(app.count("id:persona-header-capsule >> id:persona-name-button")).toBe(1);
  expect(app.count("id:persona-header-capsule >> id:persona-actions-button")).toBe(1);

  const material = app.viewStyle("id:persona-header-capsule") as { backgroundColor?: string } | undefined;
  const alpha = material?.backgroundColor?.match(/^#[0-9a-f]{6}([0-9a-f]{2})$/i)?.[1];
  expect(alpha).not.toBeUndefined();
  expect(parseInt(alpha!, 16)).toBeGreaterThan(200);
  expect(parseInt(alpha!, 16)).toBeLessThan(255);

  const before = decodeLumGrid(await app.screenshot(), 2);
  const boxes = transcriptProbeBoxes(capsule, before);
  expect(boxes.length).toBeGreaterThan(0);
  let moved = 0;

  for (const delta of [-420, -360, -300]) {
    await app.scroll("label:Conversation", delta);
    await app.wait(120);
    expect(app.layout("id:persona-header-capsule")).toEqual(capsule);
    const frame = decodeLumGrid(await app.screenshot(), 2);
    for (const box of boxes) {
      moved = Math.max(moved, pixelDiff(before, frame, box.x0, box.x1, box.y0, box.y1, 4));
    }
  }
  expect(moved).toBeGreaterThan(0);
}

for (const colorScheme of ["light", "dark"] as const) {
  for (const withWallpaper of [false, true]) {
    test(`Persona identity is a compact material capsule over the transcript ${colorScheme} ${withWallpaper ? "wallpaper" : "plain"}`, async () => {
      const app = await launch(colorScheme, withWallpaper);
      await app.waitFor("id:sidebar-pip");
      await app.press("id:sidebar-pip");
      await app.waitFor("text:Part 22");
      await app.waitFor("id:persona-header-capsule");
      await expectCompactCapsuleOverTranscript(app);
      await app.screenshot(`.nsh/shots/persona-header-${withWallpaper ? "wallpaper" : "plain"}-${colorScheme}.png`);
    }, 120000);
  }
}
