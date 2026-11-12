import { open, test } from "nsh/test";

const OUT = ".nsh/shots";

test("reproduce fold then unfold disappearing text", async () => {
  // 1. History: open -> close -> re-open
  const app = await open("./Harness.tsx", {
    width: 960,
    height: 720,
    platform: "macos",
    locale: "en-US",
    colorScheme: "light",
    storage: { "harness.scenario": "history" },
  });
  await app.waitFor("text:Here is the plan.");
  await app.wait(300);
  await app.screenshot(`${OUT}/1-hist-closed.png`);

  await app.press("text:Finished in under 1 second");
  await app.wait(400);
  await app.screenshot(`${OUT}/2-hist-open1.png`);

  await app.press("text:Finished in under 1 second");
  await app.wait(400);
  await app.screenshot(`${OUT}/3-hist-closed2.png`);

  await app.press("text:Finished in under 1 second");
  await app.wait(400);
  await app.screenshot(`${OUT}/4-hist-reopened.png`);

  // 2. Running turn (exact match to user screenshot): starts open -> fold -> unfold
  const live = await open("./Harness.tsx", {
    width: 960,
    height: 720,
    platform: "macos",
    locale: "zh-Hans-CN",
    colorScheme: "light",
    storage: { "harness.scenario": "slow" },
  });
  await live.waitFor("text:今天要构建什么？");
  await live.type("label:消息", "make a plan in steps");
  await live.submit("label:消息");
  await live.waitFor("text:正在处理");
  await live.wait(1800);
  await live.screenshot(`${OUT}/5-live-initial-open.png`);

  // Fold while running
  await live.press("text:正在处理");
  await live.wait(350);
  await live.screenshot(`${OUT}/6-live-folded.png`);

  // Expand again while running
  await live.press("text:正在处理");
  await live.wait(400);
  await live.screenshot(`${OUT}/7-live-reopened.png`);
}, 60000);
