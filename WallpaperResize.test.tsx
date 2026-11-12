import { expect, open, test } from "nsh/test";

// The wallpaper keeps covering the window across viewport resizes — the
// discrete-resize half of the drag-flicker regression. The first phase holds
// the window while /tmp/dragfast.swift yanks the real resize corner outside,
// photographing what the window actually presents mid-drag.
test("wallpaper stays drawn through a window resize", async () => {
  const app = await open("./Harness.tsx", {
    width: 1000,
    height: 760,
    platform: "macos",
    locale: "en-US",
    storage: {
      "harness.scenario": "welcome",
      // The repository's own picture: a relative path names no file in a native app.
      "harness.wallpaper": "{}",
      "pipi.prefs.v1": JSON.stringify({ wallpaperEffect: "ascii" }),
    },
  });
  await app.waitFor("text:What are we building?");
  await app.screenshot(".nsh/test/frames/base.png");

  // The external drag script waits ~4s, then pulls the corner for ~6.5s;
  // these shots land inside that window.
  const deadline = Date.now() + 14000;
  for (let i = 0; Date.now() < deadline; i++) {
    await app.screenshot(
      `.nsh/test/frames/drag-${String(i).padStart(3, "0")}.png`,
    );
  }

  for (let i = 0; i < 12; i++) {
    await app.setViewport(1000 + i * 25, 760);
    await app.screenshot(`.nsh/test/frames/w${String(i).padStart(2, "0")}.png`);
  }
  for (let i = 0; i < 8; i++) {
    await app.setViewport(1300, 760 + i * 25);
    await app.screenshot(`.nsh/test/frames/h${String(i).padStart(2, "0")}.png`);
  }
  expect(app.texts()).toContain("What are we building?");
}, 120000);
