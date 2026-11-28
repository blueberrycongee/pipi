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

const FIRST_USER_TEXT = "Let's check the top of a longer persona chat with both incoming and outgoing bubbles.";
const LAST_REPLY_TEXT =
  "Response 5 spans across the reading column so words pass directly behind Pip's avatar and frosted nameplate while the left and right edges remain crisp and readable right up to the title bar.";

const MIXED_CONVERSATION_HISTORY = JSON.stringify([
  {
    role: "user",
    content: FIRST_USER_TEXT,
    timestamp: 1,
  },
  {
    role: "assistant",
    content: [
      {
        type: "text",
        text: "First reply near the very top of the conversation: when you scroll all the way up, this oldest message should land cleanly below the floating identity badge.",
      },
    ],
    provider: "test",
    model: "test",
    timestamp: 2,
    stopReason: "stop",
  },
  ...Array.from({ length: 5 }, (_, i) => [
    {
      role: "user",
      content: `Round ${i + 1}: keep the side bubbles and text razor sharp outside the floating badge's tight localized halo.`,
      timestamp: 10 + i * 2,
    },
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text:
            i === 4
              ? LAST_REPLY_TEXT
              : `Response ${i + 1} spans across the reading column so words pass directly behind Pip's avatar and frosted nameplate while the left and right edges remain crisp and readable right up to the title bar.`,
        },
      ],
      provider: "test",
      model: "test",
      timestamp: 11 + i * 2,
      stopReason: "stop",
    },
  ]).flat(),
]);

const launch = (
  colorScheme: Scheme,
  withWallpaper: boolean,
  scenario: "history" | "welcome" = "history",
  history = PERSONA_HISTORY,
) =>
  open("./Harness.tsx", {
    width: 1180,
    height: 780,
    platform: "macos",
    locale: "en-US",
    colorScheme,
    clock: {},
    storage: {
      "harness.scenario": scenario,
      ...(scenario === "history" ? { "harness.history": history } : {}),
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
  const scrim = app.layout("id:persona-header-scrim")!;
  // The cushion hugs the floating identity locally instead of spanning the full pane width.
  expect(scrim.width).toBeLessThanOrEqual(frame.width + 80);
  expect(scrim.width).toBeGreaterThan(frame.width);
  expect(Math.abs(centerX(scrim) - centerX(frame))).toBeLessThanOrEqual(1);
  expect(scrim.height).toBeLessThanOrEqual(frame.height + 52);

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

test("mixed persona conversation keeps side bubbles crisp and clears the oldest message at the top", async () => {
  for (const [colorScheme, withWallpaper] of [
    ["light", false],
    ["dark", false],
    ["light", true],
    ["dark", true],
  ] as const) {
    const app = await launch(colorScheme, withWallpaper, "history", MIXED_CONVERSATION_HISTORY);
    await app.waitFor("id:sidebar-pip");
    await app.press("id:sidebar-pip");
    await app.waitFor(`text:${LAST_REPLY_TEXT}`);
    await app.waitFor("id:persona-header-capsule");
    await app.scroll("label:Conversation", -180);
    await app.wait(150);
    await app.screenshot(`.nsh/shots/persona-header-mixed-${withWallpaper ? "wallpaper" : "plain"}-${colorScheme}.png`);

    if (colorScheme === "light" && !withWallpaper) {
      // Scroll all the way to the top: the very first message must clear the floating badge.
      await app.scroll("label:Conversation", -4000);
      await app.wait(300);
      await app.scroll("label:Conversation", -4000);
      await app.wait(300);
      await app.waitFor(`text:${FIRST_USER_TEXT}`);
      const topShot = await app.screenshot(".nsh/shots/persona-header-top-light.png");
      expect(app.shows(`text:${FIRST_USER_TEXT}`)).toBe(true);
      if (topShot.length > 0) {
        // Verify visually on macOS that the band beside the avatar is clean page background
        // (no oldest-message bubble clipped behind the badge) while the first bubble sits below it.
        const grid = decodeLumGrid(topShot, 2);
        const frame = badgeFrame(app);
        const besideX0 = Math.min(grid.width - 1, Math.ceil(frame.x + frame.width + 24));
        const besideX1 = Math.min(grid.width, Math.ceil(frame.x + frame.width + 180));
        const avatarBandY0 = Math.max(0, Math.floor(frame.y + 4));
        const avatarBandY1 = Math.min(grid.height, Math.ceil(frame.y + frame.height - 4));
        const belowBandY0 = Math.min(grid.height - 1, Math.ceil(frame.y + frame.height + 16));
        const belowBandY1 = Math.min(grid.height, Math.ceil(frame.y + frame.height + 84));
        let minBesideLum = 255;
        for (let y = avatarBandY0; y < avatarBandY1; y++) {
          for (let x = besideX0; x < besideX1; x++) {
            minBesideLum = Math.min(minBesideLum, grid.data[y * grid.width + x]);
          }
        }
        let minBelowLum = 255;
        for (let y = belowBandY0; y < belowBandY1; y++) {
          for (let x = besideX0; x < besideX1; x++) {
            minBelowLum = Math.min(minBelowLum, grid.data[y * grid.width + x]);
          }
        }
        expect(minBesideLum).toBeGreaterThan(240);
        expect(minBelowLum).toBeLessThan(180);
      }
    }
  }
}, 180000);
