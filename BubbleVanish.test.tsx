// Repro: a user bubble's text painted blank after folds/session switches (the
// bubble keeps its height; the image chip below still paints). Streams a run
// below the bubble, lets it fold itself when the answer lands, hammers the
// fold, then switches between sessions so the list rebinds every cell.
// AX/texts() still lists the text when it fails — only the pixels show it.
//
//   nsh test BubbleVanish.test.tsx --target macos
import { expect, open, test } from "nsh/test";

const OUT = "/tmp/pipi-bubble-frames";

test("text+image bubble keeps its text through fold cycles and session switches", async () => {
  const app = await open("./Harness.tsx", {
    width: 986,
    height: 900,
    platform: "macos",
    locale: "zh-Hans-CN",
    colorScheme: "light",
    storage: { "harness.scenario": "stream" },
  });
  await app.waitFor("text:今天要构建什么？", { timeout: 20000 });
  await app.type("label:消息", "这个折叠展开之后 就消失了文字了 解决一下");
  await app.paste("label:消息", { files: ["icon.png"] });
  await app.submit("label:消息");
  await app.wait(1200);
  await app.screenshot(`${OUT}/0-streaming.png`);

  // The answer lands: the process folds itself for the following reader.
  await app.waitFor("label:复制回复", { timeout: 90000 });
  await app.wait(400);
  await app.screenshot(`${OUT}/1-settled.png`);

  for (let i = 0; i < 8; i++) {
    await app.press("text:/^用时/");
    await app.wait(140);
    await app.screenshot(`${OUT}/2-fold-${String(i).padStart(2, "0")}.png`);
    await app.press("text:/^用时/");
    await app.wait(300);
    await app.screenshot(`${OUT}/2-open-${String(i).padStart(2, "0")}.png`);
  }

  // Scroll the bubble's cell out and back: recycling through another bind.
  for (let i = 0; i < 4; i++) {
    await app.scroll("label:对话", -1400);
    await app.wait(200);
    await app.screenshot(`${OUT}/3-up-${i}.png`);
    await app.scroll("label:对话", 1400);
    await app.wait(200);
    await app.screenshot(`${OUT}/3-down-${i}.png`);
  }

  // Switch to another session and back: the whole list rebinds (the buggy
  // session's bubble was blank right after it was opened).
  for (let i = 0; i < 8; i++) {
    await app.press("text:/^Look around and tell me/ >> nth=0");
    await app.wait(500);
    await app.screenshot(`${OUT}/4-away-${i}.png`);
    await app.press("text:/^这个折叠展开之后/ >> nth=0");
    await app.wait(500);
    await app.screenshot(`${OUT}/4-back-${i}.png`);
  }

  expect(app.shows("text:/^这个折叠展开之后/")).toBe(true);
}, 240000);
