import { open, test, type App } from "nsh/test";
import { decodeLumGridAsync, lum, type Grid } from "./dev/frames";

// A film of a queued send's bubble life, asserted on what survives coarse
// sampling: the second message goes in with ⌘↵ (follow-up), so it is born
// already dim in the queue's 0.6 coat — its entrance moves transform only —
// and it stays dim until the queue lets it go, when it brightens in one quick
// flip while its label's seat becomes the receipt's without moving the bubble.
//
// What used to go wrong: the queued bubble's entrance faded toward 1 while the
// queue held it at 0.6 (a literal two-stage fade), the label row collapsing at
// dequeue yanked the transcript, and the send's return to the reader was an
// un-animated position snapshot mid-entrance. The first two are visible in
// these frames; the third is guaranteed by there being no un-animated scroll
// call left on the send path — at ~1.4s a frame a snap and a glide land inside
// the same interval, so smoothness itself is not what this test can judge.
//
//   nsh test SendTwoRepro.test.tsx --target macos

const OUT = "/tmp/pipi-send2";

interface Track {
  found: boolean;
  /** The bubble's on-screen centre, grid px (1 grid px = 4 device px = 2pt). */
  cy: number;
  /** Mean luminance of the bubble's solid fill — a direct probe of its opacity
   * (lower = more opaque; ~107 delivered, ~165 under the queue's dim). */
  fill: number;
  /** ms since the film started. */
  at: number;
}

/** The newest outgoing bubble: the lowest solid block hugging the transcript's
 * right edge. A row of the bubble is mostly brand fill; wallpaper, labels and
 * sparse text stay under the cover threshold. */
function trackBubble(g: Grid, at: number): Track {
  const x0 = Math.round(g.width * 0.8), x1 = Math.round(g.width * 0.965);
  const y0 = Math.round(g.height * 0.08), y1 = Math.round(g.height * 0.86);
  const covers = new Float64Array(y1 - y0);
  for (let y = y0; y < y1; y++) {
    let dark = 0;
    for (let x = x0; x < x1; x++) if (lum(g, x, y) < 205) dark++;
    covers[y - y0] = dark / (x1 - x0);
  }
  let bottom = -1;
  for (let y = y1 - 1; y >= y0; y--) {
    if (covers[y - y0] > 0.34) {
      bottom = y;
      break;
    }
  }
  if (bottom < 0) return { found: false, cy: 0, fill: 255, at };
  let top = bottom;
  for (let y = bottom - 1; y >= y0 && covers[y - y0] > 0.34; y--) top = y;
  if (bottom - top + 1 < 6) return { found: false, cy: 0, fill: 255, at };
  let sumY = 0,
    sumL = 0,
    n = 0;
  for (let y = top; y <= bottom; y++) {
    for (let x = x0; x < x1; x++) {
      const l = lum(g, x, y);
      if (l < 205) {
        sumY += y;
        sumL += l;
        n++;
      }
    }
  }
  return { found: true, cy: n ? sumY / n : 0, fill: n ? sumL / n : 255, at };
}

async function film(app: App, name: string, count: number): Promise<Track[]> {
  const t0 = Date.now();
  const out: Track[] = [];
  for (let i = 0; i < count; i++) {
    const shot = await app.screenshot(`${OUT}-${name}-${String(i).padStart(2, "0")}.png`);
    out.push(trackBubble(await decodeLumGridAsync(shot, 4), Date.now() - t0));
  }
  return out;
}

const fail = (msg: string): never => {
  throw new Error(msg);
};

const say = (name: string, t: Track[]) =>
  console.log(`[${name}]`, t.map((s) => `${s.found ? `${s.cy.toFixed(0)}cy/${s.fill.toFixed(0)}lum` : "--"}@${s.at}ms`).join(" "));

/** Consecutive-frame |Δcy| over pairs where both frames found the bubble. */
function deltas(t: Track[]): number[] {
  const dys: number[] = [];
  for (let i = 1; i < t.length; i++) if (t[i].found && t[i - 1].found) dys.push(Math.abs(t[i].cy - t[i - 1].cy));
  return dys;
}

/** No interval may move the bubble a teleport's distance; the reply streaming
 * under it steps it a few grid px at a time. */
function noTeleport(name: string, t: Track[]) {
  const top = deltas(t).sort((a, b) => b - a)[0] ?? 0;
  if (top >= 30) fail(`[${name}] teleport: one interval moved the bubble ${top.toFixed(1)} grid px`);
}

test("a queued bubble is born dim, brightens in one flip, and is never yanked", async () => {
  const app = await open("./Harness.tsx", {
    width: 760,
    height: 560,
    platform: "macos",
    locale: "en-US",
    storage: { "harness.scenario": "stream" },
  });
  await app.waitFor("text:What are we building?");
  await app.press("id:sidebar-pip");
  await app.waitFor("text:Hey, what's up?");

  // A long reply keeps the run live (~28s at pace 150) and rides the prompt to
  // the reading horizon — the posture the second send lands in.
  await app.type("label:Message", "make a long reply");
  await app.submit("label:Message");
  await app.wait(11000);

  // ⌘↵ sends a follow-up: the bubble stages queued for the rest of the run.
  await app.type("label:Message", "and make it shorter");
  await app.keyboard.press("mod+enter");
  await app.waitFor("text:Queued");

  const queued = await film(app, "queued", 10);
  say("queued", queued);

  // Born dim and dim the whole queue: the muted entrance moves transform only,
  // so no frame may catch it fading down from full — or brightening early. The
  // first eight frames land well before the run ends, while the queue holds.
  const found = queued.filter((s) => s.found);
  if (found.length < 5) fail(`[queued] bubble tracked in only ${found.length} frames`);
  for (const s of found.slice(0, 8)) {
    if (s.fill < 125) fail(`[queued] bubble bright while queued: fill=${s.fill.toFixed(1)} @${s.at}ms`);
    if (s.fill > 195) fail(`[queued] bubble fading down while queued: fill=${s.fill.toFixed(1)} @${s.at}ms`);
  }
  // Seated and still: once the entrance settles, the held bubble does not drift.
  const seat = found.slice(-6);
  const spread = Math.max(...seat.map((s) => s.cy)) - Math.min(...seat.map((s) => s.cy));
  if (spread > 10) fail(`[queued] held bubble drifting: cy spread ${spread.toFixed(1)}px over ${seat.length} frames`);
  noTeleport("queued", queued);

  // The queue lets go when the run ends: the label's seat becomes the
  // receipt's — the same height, so the swap must leave the bubble be — and
  // the dim flips to full in ~120ms, a delivery, not a second entrance.
  await app.waitUntil(() => !app.shows("text:Queued"), { timeout: 90000 });
  const drained = await film(app, "drained", 12);
  say("drained", drained);

  const post = drained.filter((s) => s.found);
  if (post.length < 3) fail(`[drained] bubble tracked in only ${post.length} frames`);
  // Bright, and bright for good — the flip, not a ramp that could dip back.
  const bright = post.findIndex((s) => s.fill < 135);
  if (bright < 0) fail(`[drained] bubble never brightened (last fill=${post[post.length - 1].fill.toFixed(1)})`);
  if (bright > 3) fail(`[drained] brighten took ${bright + 1} frames to land — a second fade, not a flip`);
  const redim = post.slice(bright).find((s) => s.fill > 150);
  if (redim) fail(`[drained] bubble dimmed again after brightening: fill=${redim.fill.toFixed(1)} @${redim.at}ms`);
  // Once the follow-up's reply lands, the bubble sits: a live tail, not jitter.
  const postSeat = post.slice(-4);
  const postSpread = Math.max(...postSeat.map((s) => s.cy)) - Math.min(...postSeat.map((s) => s.cy));
  if (postSpread > 8) fail(`[drained] bubble still jittering after the reply: cy spread ${postSpread.toFixed(1)}px`);
  // Its own reply grows below it: the bubble only rises, never drops — a drop
  // is the signature of the label row collapsing under an end-pinned view.
  for (let i = 1; i < drained.length; i++) {
    if (drained[i].found && drained[i - 1].found && drained[i].cy - drained[i - 1].cy > 8) {
      fail(`[drained] bubble dropped ${(drained[i].cy - drained[i - 1].cy).toFixed(1)}px — content below it shrank`);
    }
  }
}, 240000);
