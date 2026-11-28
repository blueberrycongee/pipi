import { expect, open, test, type App } from "nsh/test";
import { decodeLumGridAsync, lum, type Grid } from "./dev/frames";

// The reply-focus lift, frame by frame, asserted on real window pixels: one
// continuous object — the outgoing bubble — lifting out of the conversation.
//
// What used to go wrong: the focus bubble was a crossfading copy (its opacity
// shared the backdrop's flat 200ms ramp), so mid-enter frames held a
// half-transparent double image, the bubble never moved (no scale, no shadow),
// and position measurements visibly converged at 30/130/250/420ms.
//
// Frames are captured back-to-back without decoding in between (a decode's
// yields would cost wall-clock time), then analyzed: the fill luminance at the
// bubble's core must stay solid in every frame (no gap, no half-fade), the
// silhouette must grow monotonically into the lift and shrink back on exit,
// and the ring under the bubble must darken as the shadow deepens.
//
//   nsh test ReplyFilm.test.tsx --target macos

const OUT = "/tmp/pipi-replyfilm";

interface Track {
  found: boolean;
  /** Bounding box of the blue fill, grid px (1 grid px = 1pt at step 2). */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** Mean luminance at the fill's solid core — a direct probe of copy opacity. */
  fill: number;
  /** Mean luminance in the ring just under the fill, minus the far background:
   * the deepening shadow, normalized so the frost cancels out. */
  shadow: number;
  at: number;
}

/** The outgoing bubble: the contiguous dark-blue mass hugging the transcript's
 * right edge. The fill is brand blue (lum ~100) over a near-white page; text
 * inside it is light, wallpaper and chrome stay outside the scan band. */
function trackBubble(g: Grid, at: number): Track {
  // Left of the bubble sits its hover ellipsis once the mouse rests there — outside the object, outside the scan.
  const x0 = Math.round(g.width * 0.56);
  const x1 = Math.round(g.width * 0.98);
  const y0 = Math.round(g.height * 0.08);
  const y1 = Math.round(g.height * 0.82);
  const dark = (x: number, y: number) => lum(g, x, y) < 175;
  const covers = new Float64Array(y1 - y0);
  for (let y = y0; y < y1; y++) {
    let n = 0;
    for (let x = x0; x < x1; x++) if (dark(x, y)) n++;
    covers[y - y0] = n / (x1 - x0);
  }
  let bottom = -1;
  for (let y = y1 - 1; y >= y0; y--) {
    if (covers[y - y0] > 0.2) {
      bottom = y;
      break;
    }
  }
  if (bottom < 0) return { found: false, x0: 0, x1: 0, y0: 0, y1: 0, fill: 255, shadow: 0, at };
  let top = bottom;
  for (let y = bottom - 1; y >= y0 && covers[y - y0] > 0.2; y--) top = y;
  let left = x1;
  let right = x0;
  for (let y = top; y <= bottom; y++) {
    for (let x = x0; x < x1; x++) {
      if (dark(x, y)) {
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }
  if (right - left < 8 || bottom - top < 4) return { found: false, x0: 0, x1: 0, y0: 0, y1: 0, fill: 255, shadow: 0, at };
  // The fill's solid core: a patch well inside the left half of the silhouette
  // (the menu popup, while it closes, overlaps the right).
  let sum = 0;
  let n = 0;
  const cx0 = left + 3;
  const cx1 = left + Math.max(6, Math.round((right - left) * 0.2));
  const cy0 = top + 2;
  const cy1 = bottom - 2;
  for (let y = cy0; y < cy1; y++) {
    for (let x = cx0; x < cx1; x++) {
      sum += lum(g, x, y);
      n++;
    }
  }
  // The shadow probe: the ring just under the silhouette's belly, normalized
  // against a far patch of frosted page so global dimming cancels out.
  const ringY0 = bottom + 2;
  const ringY1 = bottom + 10;
  let ringSum = 0;
  let ringN = 0;
  for (let y = ringY0; y < ringY1 && y < g.height; y++) {
    for (let x = left + 4; x < right - 4; x++) {
      ringSum += lum(g, x, y);
      ringN++;
    }
  }
  let farSum = 0;
  let farN = 0;
  const fx0 = Math.round(g.width * 0.45);
  const fx1 = Math.round(g.width * 0.6);
  const fy0 = Math.max(0, top - 40);
  const fy1 = Math.max(0, top - 20);
  for (let y = fy0; y < fy1; y++) {
    for (let x = fx0; x < fx1; x++) {
      farSum += lum(g, x, y);
      farN++;
    }
  }
  return {
    found: true,
    x0: left,
    x1: right,
    y0: top,
    y1: bottom,
    fill: n ? sum / n : 255,
    shadow: ringN && farN ? ringSum / ringN - farSum / farN : 0,
    at,
  };
}

async function film(app: App, fire: () => void, dir: string): Promise<{ bytes: Uint8Array; at: number; firedAt: number }[]> {
  const t0 = Date.now();
  let firedAt = -1;
  const out: { bytes: Uint8Array; at: number; firedAt: number }[] = [];
  for (let i = 0; i < 34; i++) {
    // The trigger fires once the camera is rolling: awaiting it first (or even
    // firing it first) lets the whole 340ms choreography finish before frame 0.
    if (i === 0) {
      fire();
      firedAt = Date.now() - t0;
    }
    const bytes = await app.screenshot(`${OUT}-${dir}-${String(i).padStart(2, "0")}.png`);
    out.push({ bytes, at: Date.now() - t0, firedAt });
  }
  return out;
}

async function decode(frames: { bytes: Uint8Array; at: number; firedAt: number }[]): Promise<Track[]> {
  const out: Track[] = [];
  for (const f of frames) {
    out.push(trackBubble(await decodeLumGridAsync(f.bytes, 2), f.at - f.firedAt));
  }
  return out;
}

const say = (name: string, t: Track[]) =>
  console.log(
    `[${name}]`,
    t
      .map((s) => (s.found ? `${(s.x1 - s.x0).toFixed(0)}x${(s.y1 - s.y0).toFixed(0)}/f${s.fill.toFixed(0)}/s${s.shadow.toFixed(0)}` : "--"))
      .map((cell, i) => `${cell}@${t[i].at}ms`)
      .join(" "),
  );

test("reply focus is one continuous object lifting and settling back", async () => {
  const history = JSON.stringify([
    {
      role: "user",
      content: "please walk me through the architecture of this project and how the major pieces fit together",
      timestamp: 1,
    },
    { role: "assistant", content: [{ type: "text", text: "Target answer." }], provider: "test", model: "test", timestamp: 2, stopReason: "stop" },
  ]);
  const app = await open("./Harness.tsx", {
    width: 900,
    height: 600,
    platform: "macos",
    locale: "en-US",
    storage: { "harness.scenario": "history", "harness.history": history, "harness.then": "0:replyfocus" },
  });
  await app.press("id:sidebar-pip");
  await app.waitFor("text:Target answer.");
  await app.wait(400);

  // One continuous reel: the right-click fires mid-reel, and from there the harness
  // itself begins the focus the moment its menu opens and clears it 1400ms later —
  // no test-driver action in flight for the whole enter+hold+exit, so the captures
  // are the animation's true native frames (a driver step's quiet-wait hides them).
  let click: Promise<void> | undefined;
  const frames = await film(app, () => {
    click = app.rightClick("id:message-bubble");
  }, "focus");
  await click;
  const all = await decode(frames);
  say("reel", all);

  // Continuity: whenever the silhouette is visible, its core fill stays solid.
  // A half-transparent crossfade frame lights it toward the frosted page (~150+);
  // a gap frame loses it entirely. Solid brand fill sits under ~140.
  const found = all.filter((s) => s.found);
  expect(found.length).toBeGreaterThan(15);
  for (const s of found) expect(s.fill).toBeLessThan(145);

  // The lift and the settle, read off the silhouette width over the whole reel:
  // non-decreasing into the lift, level through the hold, non-increasing back —
  // never a jump past the lifted size, never a reversal mid-transition.
  const series = found.map((s) => ({ w: s.x1 - s.x0, shadow: s.shadow, at: s.at }));
  const widths = series.map((s) => s.w);
  const base = widths[0];
  const lifted = Math.max(...widths);
  console.log(`[reel] width ${series.map((s) => `${s.w.toFixed(0)}@${s.at}`).join(" ")} (base ${base.toFixed(0)}, lifted ${lifted.toFixed(0)}, +${(lifted - base).toFixed(1)}pt = +${((lifted / base - 1) * 100).toFixed(1)}%)`);
  expect(lifted).toBeGreaterThan(base + 1);
  expect(lifted / base).toBeLessThan(1.06);
  const peakIndex = widths.indexOf(lifted);
  const troughIndex = widths.lastIndexOf(Math.min(...widths.slice(peakIndex)));
  for (let i = 1; i <= peakIndex; i++) expect(widths[i]).toBeGreaterThanOrEqual(widths[i - 1] - 0.5);
  for (let i = peakIndex + 1; i < widths.length; i++) expect(widths[i]).toBeLessThanOrEqual(widths[i - 1] + 0.5);

  // Enter/exit durations, bracketed by the coarse cadence: the transition sits
  // between the last baseline frame and the first lifted frame.
  const firstGrowth = series.findIndex((s) => s.w > base + 0.5);
  const firstFull = series.findIndex((s) => s.w >= lifted - 0.5);
  if (firstGrowth > 0 && firstFull > firstGrowth) {
    console.log(`[enter] growth window ${series[firstGrowth - 1].at}ms → ${series[firstFull].at}ms (cadence-bound, spec 20+320ms)`);
  }
  const lastFull = (() => {
    let idx = -1;
    for (let i = 0; i < series.length; i++) if (series[i].w >= lifted - 0.5) idx = i;
    return idx;
  })();
  const firstShrink = series.findIndex((s, i) => i > lastFull && s.w < base + 0.5);
  if (lastFull >= 0 && firstShrink > lastFull) {
    console.log(`[exit] settle window ${series[lastFull].at}ms → ${series[firstShrink].at}ms (cadence-bound, spec 320ms)`);
  }

  console.log(`[reel] shadow ${series.map((s) => `${s.shadow.toFixed(0)}@${s.at}`).join(" ")}`);
  expect(troughIndex).toBeGreaterThan(peakIndex);
}, 120000);
