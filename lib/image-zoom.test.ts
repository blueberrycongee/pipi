import { expect, test } from "nsh/test";
import { clampPan, clampZoom, maxZoom, sampleBezier, stepZoom, toggleZoom, wheelScale, zoomAtPoint, zoomPercent } from "./image-zoom";

// The zoom layer image viewer's math: the anchor that holds, the edges that
// win, the steps that snap to the fit and the picture's own pixels.
//
//   nsh test lib/image-zoom.test.ts

const BOX = { width: 400, height: 300 };

test("the fit is centered and immovable: no pan range at z 1", () => {
  expect(clampPan({ z: 1, tx: 30, ty: -20 }, BOX)).toEqual({ z: 1, tx: 0, ty: 0 });
});

test("zoomed in, the pan clamps so the content never leaves a gap", () => {
  // z 2 in a 400×300 box: content 800×600, x in [-400, 0], y in [-300, 0].
  expect(clampPan({ z: 2, tx: 50, ty: 0 }, BOX).tx).toBe(0);
  expect(clampPan({ z: 2, tx: -500, ty: -400 }, BOX)).toEqual({ z: 2, tx: -400, ty: -300 });
  expect(clampPan({ z: 2, tx: -200, ty: -150 }, BOX)).toEqual({ z: 2, tx: -200, ty: -150 });
});

test("the content point under the anchor stays under it through a zoom", () => {
  // Anchor the middle of the box, zoom 1 → 2: the middle content point (200,150)
  // must land under the middle again — translation goes to (-200,-150).
  const next = zoomAtPoint({ z: 1, tx: 0, ty: 0 }, 2, 200, 150, BOX);
  expect(next.z).toBe(2);
  expect(Math.abs(next.tx + 200)).toBeLessThan(0.001);
  expect(Math.abs(next.ty + 150)).toBeLessThan(0.001);
  // And back: zooming out to 1 at the same point recenters exactly.
  const back = zoomAtPoint(next, 1, 200, 150, BOX);
  expect(back).toEqual({ z: 1, tx: 0, ty: 0 });
});

test("an anchor at the corner holds there until the edge wins", () => {
  // Zoom into the top-left corner: the corner is content point (0,0), the
  // translation stays 0 — no pan correction needed at the edge.
  const corner = zoomAtPoint({ z: 1, tx: 0, ty: 0 }, 2, 0, 0, BOX);
  expect(Math.abs(corner.tx)).toBeLessThan(0.001);
  expect(Math.abs(corner.ty)).toBeLessThan(0.001);
  // Anchored at the bottom-right corner (400,300): content point there is the
  // corner of the picture; zooming to 2 wants tx -400 — exactly the clamp.
  const far = zoomAtPoint({ z: 1, tx: 0, ty: 0 }, 2, 400, 300, BOX);
  expect(Math.abs(far.tx + 400)).toBeLessThan(0.001);
  expect(Math.abs(far.ty + 300)).toBeLessThan(0.001);
});

test("the edge wins over the anchor, never leaving a gap", () => {
  // Panned to the right edge already (tx 0 at z 2 means the left edges meet),
  // zooming out a little with the anchor at the right edge can't keep it:
  // the clamp pulls the content back flush.
  const next = zoomAtPoint({ z: 2, tx: 0, ty: -150 }, 1.5, 400, 150, BOX);
  expect(next.tx).toBeLessThanOrEqual(0);
  expect(next.tx).toBeGreaterThanOrEqual(-200);
});

test("the wheel zooms out scrolling down and in scrolling up, either mode", () => {
  expect(wheelScale(1, "lines")).toBeLessThan(1);
  expect(wheelScale(-1, "lines")).toBeGreaterThan(1);
  expect(wheelScale(40, "points")).toBeLessThan(1);
  expect(wheelScale(-40, "points")).toBeGreaterThan(1);
  // One notch is a small step, not a leap.
  expect(Math.abs(wheelScale(-1, "lines") - 1.25)).toBeLessThan(0.0001);
  // A huge single event is capped.
  expect(wheelScale(-10000, "points")).toBeLessThan(2);
});

test("zoom never passes the floor or the ceiling", () => {
  expect(clampZoom(0.5, 4)).toBe(1);
  expect(clampZoom(9, 4)).toBe(4);
});

test("steps snap onto the fit and the picture's own pixels as they cross them", () => {
  const natural = 3; // the picture's pixels are 3× the fit
  // Zooming out from just over the fit lands on it exactly.
  expect(stepZoom(1.2, -1, natural, maxZoom(natural))).toBe(1);
  // Zooming in across the natural scale lands on it exactly.
  expect(stepZoom(2.5, 1, natural, maxZoom(natural))).toBe(3);
  // Within the open range a step is a plain factor.
  expect(Math.abs(stepZoom(1, 1, natural, maxZoom(natural)) - 1.4)).toBeLessThan(0.0001);
  // And the ceiling holds.
  expect(stepZoom(maxZoom(natural), 1, natural, maxZoom(natural))).toBe(maxZoom(natural));
});

test("a double press dives to the picture's pixels and comes back", () => {
  const natural = 3.9;
  const max = maxZoom(natural);
  expect(toggleZoom(1, natural, max)).toBe(3.9);
  expect(toggleZoom(3.9, natural, max)).toBe(1);
  expect(toggleZoom(1.5, natural, max)).toBe(1);
  // A small picture has no deep dive: a plain 2×.
  expect(toggleZoom(1, 1, maxZoom(1))).toBe(2);
});

test("the ceiling is past the picture's own pixels, at least 4× the fit", () => {
  expect(maxZoom(1)).toBe(4);
  expect(maxZoom(4)).toBe(6);
});

test("the readout is the picture's own pixels at 100", () => {
  // fitScale 880/3440 ≈ 0.256: at the fit the readout is the absolute scale.
  expect(zoomPercent(1, 880 / 3440)).toBe(26);
  expect(zoomPercent(3.9, 880 / 3440)).toBe(100);
  // Unknown pixels read as the fit's own hundred.
  expect(zoomPercent(2, 1)).toBe(200);
});

test("the bezier sampler is the curve the compositor plays", () => {
  const ease: [number, number, number, number] = [0.22, 1, 0.36, 1];
  expect(sampleBezier(ease, 0)).toBe(0);
  expect(sampleBezier(ease, 1)).toBe(1);
  // An ease-out: past the linear halfway well before the middle of time.
  expect(sampleBezier(ease, 0.5)).toBeGreaterThan(0.5);
  expect(sampleBezier(ease, 0.3)).toBeGreaterThan(0.5);
  // Monotone through the flight.
  let prev = 0;
  for (let t = 0.05; t <= 1; t += 0.05) {
    const v = sampleBezier(ease, t);
    expect(v).toBeGreaterThan(prev);
    prev = v;
  }
});

test("in a larger stage viewport, fitted content centers and zoomed content expands across the whole stage", () => {
  const content = { width: 600, height: 400 };
  const stage = { width: 1200, height: 700 };
  // At fit (z = 1), content centers inside the wider stage.
  expect(clampPan({ z: 1, tx: 0, ty: 0 }, content, stage)).toEqual({ z: 1, tx: 300, ty: 150 });
  // Zoomed 2× (content 1200×800): width exactly fills the 1200pt stage (tx = 0), height pans in [-100, 0].
  const zoomed = zoomAtPoint({ z: 1, tx: 300, ty: 150 }, 2, 600, 350, content, stage);
  expect(zoomed).toEqual({ z: 2, tx: 0, ty: -50 });
  expect(clampPan({ z: 2, tx: 80, ty: -200 }, content, stage)).toEqual({ z: 2, tx: 0, ty: -100 });
});
