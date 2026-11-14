import { expect, open, test } from "nsh/test";
import { decodeLumGrid, pixelDiff } from "./dev/frames";

const OUT = "/tmp/pipi-send-film";

async function filmSend(name: string, storage: Record<string, string>, sendAtMs: number, count = 22) {
  const started = Date.now();
  const app = await open("./Harness.tsx", {
    width: 1180,
    height: 780,
    platform: "macos",
    locale: "zh-Hans-CN",
    colorScheme: "light",
    storage,
  });
  const waitBefore = Math.max(0, sendAtMs - 350 - (Date.now() - started));
  if (waitBefore > 0) await app.wait(waitBefore);
  const frames = [];
  const stamps = [];
  for (let i = 0; i < count; i++) {
    const shot = await app.screenshot(`${OUT}-${name}-${String(i).padStart(2, "0")}.png`);
    frames.push(decodeLumGrid(shot, 4));
    stamps.push(Date.now() - started);
  }
  const x0 = Math.round(frames[0].width * 0.3);
  const x1 = frames[0].width - 10;
  const y1 = Math.round(frames[0].height * 0.72);
  const diffs = [];
  for (let i = 1; i < frames.length; i++) {
    const dPrev = pixelDiff(frames[i - 1], frames[i], x0, x1, 50, y1);
    const d0 = pixelDiff(frames[0], frames[i], x0, x1, 50, y1);
    diffs.push(`f${i}@${stamps[i]}ms(dPrev=${dPrev.toFixed(4)},d0=${d0.toFixed(4)})`);
  }
  console.log(`[${name}]`, diffs.join(" "));
}

test("film real sub-frame send transitions across short, multiline, long, and wallpaper", async () => {
  await filmSend(
    "short-multiline",
    {
      "harness.scenario": "slow",
      "harness.then": "3000:/sessions/one.jsonl;4200:draft:第一行消息\\n第二行消息\\n第三行消息;5000:send:",
    },
    5000,
  );
  await filmSend(
    "long-1line",
    {
      "harness.scenario": "slow",
      "harness.long": "1",
      "harness.then": "3000:/sessions/two.jsonl;4300:draft:继续往下分析下一步架构设计;5000:send:",
    },
    5000,
  );
  await filmSend(
    "welcome-send",
    {
      "harness.scenario": "slow",
      "harness.then": "4200:draft:你好帮我看看这个项目;5000:send:",
    },
    5000,
  );
  expect(true).toBe(true);
}, 180000);
