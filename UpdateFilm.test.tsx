// Films the update card for a GIF: frames into .nsh/shots/film/, stitched
// with ffmpeg afterwards. Not part of the suite — macOS only:
//
//   nsh test UpdateFilm.test.tsx --target macos
import { open, test } from "nsh/test";
import type { App } from "nsh/test";

let n = 0;
async function frame(app: App) {
  await app.screenshot(`.nsh/shots/film/f-${String(n++).padStart(3, "0")}.png`);
}

const UPDATE = {
  version: "0.3.0",
  notes: "A shinier coat, a steadier step, and everything a little quicker.",
  bytes: 48_000_000,
  rate: 5_000, // ~10s of download, enough runway for frames
};

test("film the update card", async () => {
  const app = await open("./Harness.tsx", {
    width: 1180,
    height: 780,
    platform: "macos",
    locale: "en-US",
    storage: { "harness.update": JSON.stringify(UPDATE) },
  });
  await app.waitFor("text:What are we building?");
  await app.waitFor("text:pipi 0.3.0 is available", { timeout: 8000 });

  // Entrance and a held beat on "available".
  for (let i = 0; i < 8; i++) {
    await frame(app);
    await app.wait(90);
  }

  // Download: Pip rides the fill; keep shooting until "ready" has been on
  // screen for a few frames so the sparkle burst and the jump land on film.
  await app.press("text:Update");
  let readyFrames = 0;
  for (let i = 0; i < 140 && readyFrames < 10; i++) {
    await frame(app);
    await app.wait(80);
    readyFrames = app.texts().some((t) => t.includes("is ready")) ? readyFrames + 1 : 0;
  }
}, 60_000);
