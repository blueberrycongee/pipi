// The zoom layer's image viewer on its stage (`dev/ZoomStage.tsx`): the wheel
// and a pinch zoom at the pointer, a drag pans, a double press dives to the
// picture's own pixels and back, the pill steps and resets, the keys play.
// What the harness cannot drive (wheel, pinch) is the same `applyZoom` the
// buttons and double presses take.
//
//   nsh test ZoomImage.test.tsx --target macos   # writes .nsh/shots/zoomimg-*.png
import * as fs from "fs/promises";
import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";
import zlib from "zlib";

let drawn = true;
async function shot(app: App, name: string) {
  if (!drawn) return;
  await app.wait(350);
  try {
    await app.screenshot(`.nsh/shots/${name}.png`);
  } catch {
    drawn = false;
  }
}

// The headless engine types into inputs and menu shortcuts but never plain keys
// into views; the desktop targets do. Probed once at the open — the probe itself
// is the keyboard-at-open check where keys play.
let keysWork: boolean | undefined;
async function keysPlayAtOpen(app: App): Promise<boolean> {
  if (keysWork !== undefined) return keysWork;
  await app.keyboard.press("plus");
  await app.wait(250);
  keysWork = app.texts().includes("70%");
  if (keysWork) {
    await app.keyboard.press("0");
    await app.waitFor("text:50%");
  }
  return keysWork;
}

const PATTERN = "/tmp/pipi-zoom-pattern.png";

/** A 1200×800 test pattern: colored corners, a center cross, text-like bars, a grid. */
async function writePattern() {
  const W = 1200;
  const H = 800;
  const raw = Buffer.alloc(H * (1 + W * 4));
  for (let y = 0; y < H; y++) {
    const row = y * (1 + W * 4);
    raw[row] = 0;
    for (let x = 0; x < W; x++) {
      const px = row + 1 + x * 4;
      let r = 245;
      let g = 245;
      let b = 245;
      if (x % 100 < 2 || y % 100 < 2) {
        r = 180;
        g = 180;
        b = 200;
      }
      if (x < 60 && y < 60) {
        r = 220;
        g = 40;
        b = 40;
      }
      if (x >= W - 60 && y < 60) {
        r = 40;
        g = 180;
        b = 40;
      }
      if (x < 60 && y >= H - 60) {
        r = 40;
        g = 80;
        b = 220;
      }
      if (x >= W - 60 && y >= H - 60) {
        r = 230;
        g = 200;
        b = 30;
      }
      if (Math.abs(x - W / 2) < 3 || Math.abs(y - H / 2) < 3) {
        r = 20;
        g = 20;
        b = 20;
      }
      if (y > 350 && y < 360 && x > 400 && x < 800) {
        r = 60;
        g = 60;
        b = 60;
      }
      if (y > 380 && y < 386 && x > 400 && x < 720) {
        r = 60;
        g = 60;
        b = 60;
      }
      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
      raw[px + 3] = 255;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crcBuf = Buffer.alloc(4);
    let c = 0xffffffff;
    for (const byte of body) {
      c ^= byte;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    crcBuf.writeUInt32BE((c ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, body, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const compressed = zlib.deflateSync(raw, { level: 0 });
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", compressed), chunk("IEND", Buffer.alloc(0))]);
  await fs.writeFile(PATTERN, png);
}

test("the viewer zooms, pans and resets", async () => {
  await writePattern();
  const app = await open("./dev/ZoomStage.tsx", { width: 800, height: 600, platform: "macos", colorScheme: "light", locale: "en-US" });
  await app.waitFor("id:zoom-image-viewport");

  // At the fit the readout is the absolute scale: 600/1200 → 50%. And the keys
  // play from the moment the layer opens, no click first — the viewport takes
  // the focus as it mounts (where the engine types into views at all).
  await app.waitFor("text:50%");
  const keys = await keysPlayAtOpen(app);
  await shot(app, "zoomimg-fit");

  // The pill's plus steps in (×1.4 → 70%), and again (×1.96 → 98%), and a
  // third time snaps onto the picture's own pixels (2× the fit → exactly 100%).
  await app.press("label:Zoom in");
  await app.waitFor("text:70%");
  await app.press("label:Zoom in");
  await app.waitFor("text:98%");
  await app.press("label:Zoom in");
  await app.waitFor("text:100%");
  await shot(app, "zoomimg-stepped");

  // Minus steps back out — off the snapped peak the way down is its own
  // (2 ÷ 1.4, never retracing the way up); the reset lands on the fit in one press.
  await app.press("label:Zoom out");
  await app.waitFor("text:71%");
  await app.press("label:Reset zoom");
  await app.waitFor("text:50%");

  // A double press on the top-left corner dives to the picture's pixels
  // (naturalScale 2 → 100%), the corner staying where it was pressed.
  await app.press("id:zoom-image-viewport", { position: { x: 60, y: 60 } });
  await app.press("id:zoom-image-viewport", { position: { x: 60, y: 60 } });
  await app.waitFor("text:100%");
  await shot(app, "zoomimg-dove-corner");

  // A double press again returns to the fit.
  await app.press("id:zoom-image-viewport", { position: { x: 300, y: 200 } });
  await app.press("id:zoom-image-viewport", { position: { x: 300, y: 200 } });
  await app.waitFor("text:50%");
  await shot(app, "zoomimg-back-fit");

  // Zoomed in, a drag pans and never double-fires the press toggle.
  await app.press("label:Zoom in");
  await app.waitFor("text:70%");
  await app.drag("id:zoom-image-viewport", { x: -120, y: -80 });
  await app.wait(200);
  // The drag is no double press: the scale did not toggle.
  expect(app.texts()).toContain("70%");
  await shot(app, "zoomimg-panned");

  // The keys play too: "+" in, the arrows pan (the scale unchanged), "0" back to the fit.
  if (keys) {
    await app.keyboard.press("plus");
    await app.waitFor("text:98%");
    await app.keyboard.press("ArrowLeft");
    await app.keyboard.press("ArrowUp");
    await app.wait(200);
    expect(app.texts()).toContain("98%");
    await shot(app, "zoomimg-keys-panned");
    await app.keyboard.press("0");
    await app.waitFor("text:50%");
  }
}, 60000);
