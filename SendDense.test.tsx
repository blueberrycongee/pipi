import { expect, open, test } from "nsh/test";
import { decodeLumGrid, pixelDiff, type Grid } from "./dev/frames";

// A dense film of the frames a send crosses — every ~35ms from just before the
// key goes down until the reply's first rows land. Where a coarser film can
// only say something moved, consecutive frames here say what: a column of the
// chat going blank for one frame, or the list jumping down and back.
//
//   nsh test SendDense.test.tsx --target macos

const OUT = "/tmp/pipi-send-dense";

async function film(name: string, then: string, sendAt: number, frames = 34) {
  const started = Date.now();
  const maxList = { name, diff: 0 };
  const app = await open("./Harness.tsx", {
    width: 1180,
    height: 780,
    platform: "macos",
    locale: "zh-Hans-CN",
    colorScheme: "light",
    storage: {
      "harness.scenario": "slow",
      "harness.distinct": "1",
      "harness.then": then,
    },
  });
  const waitBefore = Math.max(0, sendAt - 250 - (Date.now() - started));
  if (waitBefore > 0) await app.wait(waitBefore);
  const grids: Grid[] = [];
  const stamps: number[] = [];
  const rows: { at: number; list: string; foot: string; shot: string }[] = [];
  for (let i = 0; i < frames; i++) {
    const shot = `${OUT}-${name}-${String(i).padStart(2, "0")}.png`;
    grids.push(decodeLumGrid(await app.screenshot(shot), 4));
    stamps.push(Date.now() - started);
  }
  const g0 = grids[0];
  // The conversation body (right of the sidebar, above the composer) and the
  // composer's own band under it — the two places a send's motion shows.
  const listX0 = Math.round(g0.width * 0.3);
  const listY0 = Math.round(g0.height * 0.12);
  const listY1 = Math.round(g0.height * 0.68);
  const footY0 = Math.round(g0.height * 0.68);
  const footY1 = Math.round(g0.height * 0.98);
  for (let i = 1; i < grids.length; i++) {
    const dl = pixelDiff(grids[i - 1], grids[i], listX0, g0.width - 6, listY0, listY1);
    const df = pixelDiff(grids[i - 1], grids[i], listX0, g0.width - 6, footY0, footY1);
    maxList.diff = Math.max(maxList.diff, dl);
    rows.push({ at: stamps[i], list: dl.toFixed(4), foot: df.toFixed(4), shot: `${OUT}-${name}-${String(i).padStart(2, "0")}.png` });
  }
  console.log(`[${name}]`);
  for (const r of rows) console.log(`  ${r.at}ms list=${r.list} foot=${r.foot} ${r.shot}`);
  return maxList;
}

test("dense frames across a send", async () => {
  const runs = [
    await film("multiline", "3000:/sessions/one.jsonl;4200:draft:第一行消息\\n第二行消息\\n第三行消息\\n第四行内容;5000:send:", 5000),
    await film("oneline", "3000:/sessions/two.jsonl;4300:draft:继续往下分析下一步架构设计;5000:send:", 5000),
  ];
  // A flash paints a column away and back: that pair shows as a single-frame
  // diff of a whole band. Growth and entrance passes are a few percent a frame.
  expect(Math.max(...runs.map(({ diff }) => diff))).toBeLessThan(0.12);
}, 120000);
