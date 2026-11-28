import { open, test, type App } from "nsh/test";
import { decodeLumGridAsync, lum, type Grid } from "./dev/frames";

// A frame-exact film of a plain persona send's bubble life. The report: a
// persona (Devin) session's outgoing bubble enters in two stages — it pops
// in, then jumps or replays once. The queued-send fix (48d77ea) covered ⌘↵
// into a live run; this films the everyday Enter send with a viewport full of
// history on a manual clock, through the reply's own bubble mounts — every
// lift the sent bubble takes is measured.
//
//   nsh test PersonaSendRepro.test.tsx --target macos

const OUT = "/tmp/pipi-persona-send";

interface Track {
  found: boolean;
  cy: number;
  fill: number;
  at: number;
}

function trackBubble(g: Grid, at: number): Track {
  // The outgoing bubble is flush right: a row belongs to it when its right-most
  // dark pixel sits past ~90% of the grid width. Narrow bubbles ("say hi")
  // cover little of a wide band, so lock on the right edge, not coverage.
  const x0 = Math.round(g.width * 0.5), x1 = Math.round(g.width * 0.965);
  const edge = Math.round(g.width * 0.9);
  const y0 = Math.round(g.height * 0.08), y1 = Math.round(g.height * 0.86);
  const rows = new Uint8Array(y1 - y0);
  for (let y = y0; y < y1; y++) {
    let rightmost = -1,
      dark = 0;
    for (let x = x0; x < x1; x++) {
      if (lum(g, x, y) < 205) {
        dark++;
        if (x > rightmost) rightmost = x;
      }
    }
    rows[y - y0] = rightmost >= edge && dark >= 6 ? 1 : 0;
  }
  // The receipt line under the bubble is flush right too — walk up from the
  // end and take the first run tall enough to be a bubble (≥14px), not its
  // single-line caption (~9px).
  let top = -1,
    bottom = -1;
  for (let y = y1 - 1; y >= y0; y--) {
    if (!rows[y - y0]) continue;
    let runTop = y;
    while (runTop - 1 >= y0 && rows[runTop - 1 - y0]) runTop--;
    if (y - runTop + 1 >= 14) {
      bottom = y;
      top = runTop;
      break;
    }
    y = runTop - 1;
  }
  if (bottom < 0) return { found: false, cy: 0, fill: 255, at };
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

const say = (name: string, t: Track[]) =>
  console.log(`[${name}]`, t.map((s) => `${s.found ? `${s.cy.toFixed(0)}cy/${s.fill.toFixed(0)}lum` : "--"}@${s.at}ms`).join(" "));

test("a plain persona send enters once — no replay, no yank", async () => {
  const SEND_AT = 12000;
  const app = await open("./Harness.tsx", {
    width: 760,
    height: 560,
    platform: "macos",
    locale: "en-US",
    clock: {},
    storage: {
      // `stream`: an empty persona conversation — no history above the sent
      // bubble, so the list stays bottom-pinned through the run, the way a
      // fresh "hi" to Pip does. `pace` keeps the run streaming; the reply's
      // bubble still mounts whole at its `message_end` — a single ~300px
      // insert under the pin, the moment a bottom-followed view snaps.
      "harness.scenario": "stream",
      "harness.pace": "60",
      "harness.reply": "Here is the plan.\n\n## Steps\n\n1. Read the manifest carefully and note every entry point it declares.\n2. Run the tests.\n3. Write the migration notes for each step, keeping the original wording where it still fits.\n4. Send the summary.\n\nThe details stay in the file — this is only the outline.",
      "harness.then": `${SEND_AT}:send:say hi`,
    },
  });
  await app.press("id:sidebar-pip");
  await app.wait(11000);
  const sent: Track[] = [];
  for (let i = 0; i < 190; i++) {
    try {
      const shot = await app.screenshot(`${OUT}-send-${String(i).padStart(3, "0")}.png`);
      sent.push(trackBubble(await decodeLumGridAsync(shot, 4), 11000 + i * 40));
    } catch (err) {
      console.log(`[send] frame ${i} lost: ${String(err).split("\n")[0]}`);
      sent.push({ found: false, cy: 0, fill: 255, at: 11000 + i * 40 });
    }
    await app.wait(40);
  }
  say("send", sent);

  // Lock onto the sent bubble: it stages within ~100ms of the send and is the
  // bottom-right-most dark run from then on — the first found frame after
  // `mountFrom` tracks it; later moves are its own.
  const mountFrom = Math.max(1, Math.ceil((SEND_AT + 200 - 11000) / 40));
  const lock = sent.findIndex((s, i) => i >= mountFrom && s.found);
  if (lock < 0) throw new Error("[send] sent bubble never appeared in the tracked band");
  for (let i = lock + 1; i < sent.length; i++) {
    if (!sent[i].found || !sent[i - 1].found) continue;
    const dy = sent[i].cy - sent[i - 1].cy;
    if (dy <= -16) throw new Error(`[send] lifted ${(-dy).toFixed(1)}px between frames ${i - 1} and ${i} @${sent[i].at}ms — a hard scroll or a mount shoving it`);
    if (dy >= 24) throw new Error(`[send] dropped ${dy.toFixed(1)}px between frames ${i - 1} and ${i} @${sent[i].at}ms`);
  }

  const found = sent.filter((s) => s.found);
  if (found.length < 8) throw new Error(`[send] bubble tracked in only ${found.length} frames`);
  // Fill reads opacity: once bright it must never visibly re-dim — a second
  // entrance would show as a luminance ramp after settling.
  const brightAt = found.findIndex((s) => s.fill < 135);
  if (brightAt < 0) throw new Error(`[send] bubble never reached delivered luminance (last ${found[found.length - 1].fill.toFixed(0)})`);
  const reDim = found.slice(brightAt + 1).find((s) => s.fill > 160);
  if (reDim) throw new Error(`[send] bubble re-dimmed after brightening: fill=${reDim.fill.toFixed(0)} @${reDim.at}ms — a second entrance`);
}, 480000);
