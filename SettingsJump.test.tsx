// Temporary: capture frames while switching Settings -> Agents to find the
// search-field text jump. Run: nsh test SettingsJump.test.tsx --target macos
import { open, test } from "nsh/test";

const OUT = ".nsh/shots/agents-frames";

test("agents search placeholder jump", async () => {
  const app = await open("./Harness.tsx", {
    width: 1180,
    height: 780,
    platform: "macos",
    locale: "zh-Hans-CN",
    colorScheme: "dark",
    storage: { "harness.scenario": "history" },
  });
  await app.waitFor("text:Here is the plan.");
  await app.press("label:设置");
  await app.wait(800);
  const pressing = app.press("id:settings-nav-agents");
  // waitFor polls each frame: it resolves as soon as the page shows, mid-animation.
  await app.waitFor("text:编码智能体引擎");
  for (let i = 0; i < 20; i++) {
    await app.screenshot(`${OUT}/agents-${String(i).padStart(2, "0")}.png`);
  }
  await pressing;
}, 60000);
