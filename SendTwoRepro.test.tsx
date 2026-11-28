import { open, test, type App } from "nsh/test";
import { decodeLumGridAsync, lum, type Grid } from "./dev/frames";

// A film of a follow-up sent to Pip while Pip is still answering: the second
// message goes in with ⌘↵, so the engine holds it until the run ends. Pip's
// conversation shows no queue (`views/Rows.tsx`, `pi/turns.ts`): the held
// bubble is born and stays at full ink, wears no "Queued" seat, and the run
// ending — the engine letting it go — changes nothing on screen.
//
// What used to go wrong: the held bubble was dimmed to 0.6 under a "Queued"
// label and brightened when the queue let go (a second entrance), and the
// label row's swap for the receipt could yank the transcript. At ~1.4s a
// frame this film judges ink and seats, not smoothness (`PipBurst.test.tsx`
// reads every display frame for that).
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

/** Spread (max - min) of `cy` across frames that found the bubble. */
function spread(t: Track[]): number {
  const ys = t.filter((s) => s.found).map((s) => s.cy);
  return ys.length ? Math.max(...ys) - Math.min(...ys) : 0;
}

/** No interval may move the bubble a teleport's distance while it is held. */
function noTeleport(name: string, t: Track[]) {
  const top = deltas(t).sort((a, b) => b - a)[0] ?? 0;
  if (top >= 30) fail(`[${name}] teleport: one interval moved the bubble ${top.toFixed(1)} grid px`);
}

test("a message Pip's engine holds reads as sent: full ink, no queue seat, and the queue letting go moves nothing", async () => {
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

  // ⌘↵ sends a follow-up: the engine holds it for the rest of the run.
  await app.type("label:Message", "and make it shorter");
  await app.keyboard.press("mod+enter");
  await app.waitFor("text:and make it shorter");
  const noQueueSeat = (when: string) => {
    if (app.shows("text:Queued") || app.shows("label:Remove from queue")) fail(`[${when}] a queue seat showed in Pip's conversation`);
  };
  noQueueSeat("sent");

  // ~10 frames while the engine holds it, ~12 more across the run's end
  // (~28s after the first send): one film of the bubble's whole life.
  const held = await film(app, "held", 10);
  say("held", held);
  noQueueSeat("held");
  const drained = await film(app, "drained", 12);
  say("drained", drained);
  noQueueSeat("drained");

  const all = [...held, ...drained];
  const found = all.filter((s) => s.found);
  if (found.length < 8) fail(`bubble tracked in only ${found.length} frames`);
  if (!app.shows("text:Here is the plan.")) fail("follow-up reply never landed during the film");

  // Full ink from its entrance on: no queue dim, no second brightening.
  const bright = found.findIndex((s) => s.fill < 135);
  if (bright < 0) fail(`bubble never at full ink (last fill=${found[found.length - 1].fill.toFixed(1)})`);
  if (bright > 2) fail(`bubble took ${bright + 1} frames to reach full ink — dimmed, not sent`);
  const dim = found.slice(bright).find((s) => s.fill > 150);
  if (dim) fail(`bubble dimmed after its entrance: fill=${dim.fill.toFixed(1)} @${dim.at}ms`);

  // In an empty Pip chat the two user bubbles sit near the top while turn 1
  // runs; Pip's non-streaming 24-part reply lands whole above the follow-up and
  // fills the viewport (one downward shift to the tail), and turn 2's settled
  // SMS bubble later lands whole below it (one upward shift). Within each
  // phase the bubble must hold steady, and once turn 1's reply has filled the
  // viewport the bubble may never drop again (no seat collapse or rebound).
  const turn1At = found.findIndex((s, i) => i > 0 && s.cy - found[i - 1].cy > 8);
  const heldPhase = turn1At > 0 ? found.slice(0, turn1At) : found;
  if (heldPhase.length < 5) fail(`[held] bubble stayed held for only ${heldPhase.length} frames`);
  noTeleport("held", heldPhase);
  const heldSeat = heldPhase.slice(1);
  const heldSpread = spread(heldSeat);
  if (heldSpread > 10) fail(`[held] held bubble drifting: cy spread ${heldSpread.toFixed(1)}px over ${heldSeat.length} frames`);

  const afterTurn1 = turn1At > 0 ? found.slice(turn1At) : found;
  for (let i = 1; i < afterTurn1.length; i++) {
    if (afterTurn1[i].cy - afterTurn1[i - 1].cy > 8) {
      fail(`[drained] bubble dropped ${(afterTurn1[i].cy - afterTurn1[i - 1].cy).toFixed(1)}px @${afterTurn1[i].at}ms — content below it shrank or rebounded`);
    }
  }
  const turn2At = afterTurn1.findIndex((s, i) => i > 0 && afterTurn1[i - 1].cy - s.cy > 8);
  if (turn2At > 0) {
    // Between turn 1's reply landing and turn 2's reply landing, the engine
    // releases the follow-up and runs it: nothing on screen may shift or jitter.
    const draining = afterTurn1.slice(0, turn2At);
    const drainSpread = spread(draining);
    if (drainSpread > 8) fail(`[drained] bubble moved while queue drained: cy spread ${drainSpread.toFixed(1)}px`);
  }
  const postSeat = (turn2At > 0 ? afterTurn1.slice(turn2At) : afterTurn1).slice(-4);
  const postSpread = spread(postSeat);
  if (postSpread > 8) fail(`[drained] bubble still jittering after the reply: cy spread ${postSpread.toFixed(1)}px`);
}, 240000);
