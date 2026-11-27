import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";
import { decodeLumGrid, pixelDiff, type Grid } from "./dev/frames";

type Scheme = "light" | "dark";

const LONG_PERSONA_REPLY = Array.from(
  { length: 22 },
  (_, i) => `### Part ${i + 1}\n\nSection ${i + 1} carries enough prose to keep the persona conversation scrolling under its floating identity.`,
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

const launch = (colorScheme: Scheme, withWallpaper: boolean, scenario: "history" | "welcome" = "history") =>
  open("./Harness.tsx", {
    width: 1180,
    height: 780,
    platform: "macos",
    locale: "en-US",
    colorScheme,
    clock: {},
    storage: {
      "harness.scenario": scenario,
      ...(scenario === "history" ? { "harness.history": PERSONA_HISTORY } : {}),
      "pipi.prefs.v1": JSON.stringify({ appearance: colorScheme }),
      ...(withWallpaper ? { "harness.wallpaper": "{}" } : {}),
    },
  });

const centerX = (box: { x: number; width: number }) => box.x + box.width / 2;

function badgeFrame(app: App) {
  const avatar = app.layout("id:persona-avatar-button")!;
  const capsule = app.layout("id:persona-header-capsule")!;
  const x = Math.min(avatar.x, capsule.x);
  const right = Math.max(avatar.x + avatar.width, capsule.x + capsule.width);
  const bottom = Math.max(avatar.y + avatar.height, capsule.y + capsule.height);
  return { x, y: avatar.y, width: right - x, height: bottom - avatar.y, avatar, capsule };
}

function transcriptProbeBoxes(badge: { x: number; y: number; width: number; height: number }, grid: Grid) {
  const y0 = Math.max(0, Math.floor(badge.y - 2));
  const y1 = Math.min(grid.height, Math.ceil(badge.y + badge.height + 18));
  const reach = 220;
  const gap = 10;
  const left = {
    x0: Math.max(0, Math.floor(badge.x - reach)),
    x1: Math.max(0, Math.floor(badge.x - gap)),
    y0,
    y1,
  };
  const right = {
    x0: Math.min(grid.width, Math.ceil(badge.x + badge.width + gap)),
    x1: Math.min(grid.width, Math.ceil(badge.x + badge.width + reach)),
    y0,
    y1,
  };
  return [left, right].filter((box) => box.x1 > box.x0 && box.y1 > box.y0);
}

async function expectFloatingBadgeOverTranscript(app: App) {
  const frame = badgeFrame(app);
  const { avatar, capsule } = frame;
  expect(avatar.width).toBe(48);
  expect(avatar.height).toBe(48);
  expect(capsule.height).toBeLessThanOrEqual(32);
  expect(capsule.width).toBeLessThan(180);
  expect(capsule.width).toBeGreaterThan(56);
  expect(Math.abs(centerX(avatar) - centerX(capsule))).toBeLessThanOrEqual(1);
  expect(capsule.y).toBeLessThan(avatar.y + avatar.height);
  expect(capsule.y).toBeGreaterThanOrEqual(avatar.y + avatar.height - 10);
  expect(app.count("id:persona-header-scrim")).toBe(1);

  const firstShot = await app.screenshot();
  if (firstShot.length === 0) return;
  const before = decodeLumGrid(firstShot, 2);
  const boxes = transcriptProbeBoxes(frame, before);
  expect(boxes.length).toBeGreaterThan(0);
  let moved = 0;

  for (const delta of [-420, -360, -300]) {
    await app.scroll("label:Conversation", delta);
    await app.wait(120);
    expect(app.layout("id:persona-avatar-button")).toEqual(avatar);
    expect(app.layout("id:persona-header-capsule")).toEqual(capsule);
    const shot = await app.screenshot();
    if (shot.length === 0) return;
    const frameNow = decodeLumGrid(shot, 2);
    for (const box of boxes) {
      moved = Math.max(moved, pixelDiff(before, frameNow, box.x0, box.x1, box.y0, box.y1, 4));
    }
  }
  expect(moved).toBeGreaterThan(0);
}

for (const colorScheme of ["light", "dark"] as const) {
  for (const withWallpaper of [false, true]) {
    test(`Persona identity floats as a layered avatar and material nameplate over the transcript ${colorScheme} ${withWallpaper ? "wallpaper" : "plain"}`, async () => {
      const app = await launch(colorScheme, withWallpaper);
      await app.waitFor("id:sidebar-pip");
      await app.press("id:sidebar-pip");
      await app.waitFor("text:Part 22");
      await app.waitFor("id:persona-header-capsule");
      await app.screenshot(`.nsh/shots/persona-header-rest-${withWallpaper ? "wallpaper" : "plain"}-${colorScheme}.png`);
      await expectFloatingBadgeOverTranscript(app);
    }, 120000);
  }
}

test("Persona identity hover lifts the avatar, reveals the edit hint and the quiet overflow action", async () => {
  const app = await launch("light", false);
  await app.waitFor("id:sidebar-pip");
  await app.press("id:sidebar-pip");
  await app.waitFor("text:Part 22");
  await app.waitFor("id:persona-header-hitarea");
  const rest = decodeLumGrid(await app.screenshot(), 2);
  await app.hover("id:persona-header-hitarea");
  await app.wait(220);
  const hovering = decodeLumGrid(await app.screenshot(), 2);
  const capsule = app.layout("id:persona-header-capsule")!;
  const x0 = Math.max(0, Math.floor(capsule.x + capsule.width - 28));
  const x1 = Math.min(rest.width, Math.ceil(capsule.x + capsule.width - 4));
  const y0 = Math.max(0, Math.floor(capsule.y + 4));
  const y1 = Math.min(rest.height, Math.ceil(capsule.y + capsule.height - 4));
  expect(pixelDiff(rest, hovering, x0, x1, y0, y1, 4)).toBeGreaterThan(0);
  await app.screenshot(".nsh/shots/persona-header-hover-light.png");
}, 120000);

test("the blank persona welcome keeps one quiet identity and no duplicate hero Pip", async () => {
  const app = await launch("light", false, "welcome");
  await app.waitFor("id:sidebar-pip");
  await app.press("id:sidebar-pip");
  await app.waitFor("text:Hey, what's up?");
  await app.waitFor("id:persona-header-capsule");
  expect(app.count("id:persona-header-scrim")).toBe(0);
  // The only mascot marks are the pinned sidebar row and the floating identity;
  // the centered hero does not add a second large Pip.
  expect(app.count("label:pipi")).toBeLessThanOrEqual(2);
  expect(app.count("id:persona-actions-button")).toBe(1);
  await app.screenshot(".nsh/shots/persona-header-welcome-light.png");
}, 120000);
