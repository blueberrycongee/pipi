// Repro: the reply's last paragraph clipped mid-glyph after the stream settles.
//
//   nsh test Clip.test.tsx --target macos
//
// Streams the exact answer of the session where the clip was seen, then shoots
// the bottom of the transcript to inspect the last paragraph's row.
import { expect, open, test } from "nsh/test";

const OUT = "/tmp/pipi-clip-frames";

const REPLY = `不一定是“变菜”，更像是 **卷子换了、变难了，而且评分更偏真实维护者标准**。

几个原因：

- **FrontierCode 2.0 不是 1.1 的简单延续**：官方说它重建了任务集，132 个任务、更多仓库/类别，加入安全补丁、性能优化等，任务范围更大，合并标准更高。
- **更强调“能不能真的 merge”**：不是只修 bug，而是看正确性、测试质量、范围控制、风格、是否过度/不足修改； blocking criteria 不过会直接 0 分。
- **模型强项不同**：SWE-2 的强项偏 Devin 工作流里的仓库工程、终端/工具使用、成本效率；FrontierCode 2.0 更考验广义代码理解、细致重构、跨仓库泛化，Fable/Opus 这类更占优。
- **1.1 接近是因为任务分布更匹配**：1.1 里 SWE-2 50.0 vs Fable 5.1 50.9；到了 2.0，大家都掉分，但 SWE-2 掉到 ~23.9，Fable 5.1 还有 32.4，Fable 5.2 到 49.1，说明新任务把差距放大了。
- **还受 harness/effort 影响**：榜单自己也说结果受 evaluation harness 影响；同一个模型在 Devin、Claude Code、Codex、Chisel 里跑，分数会不同。

所以准确说：**SWE-2 Max 不是全面弱，而是在 FrontierCode 2.0 这套更难、更偏“可合并 PR 质量”的评测上泛化不如 Fable/Opus/Astra。** 实际用起来还是取决于你的任务类型。
`;

test("last paragraph row keeps its measured height when the run settles", async () => {
  const app = await open("./Harness.tsx", {
    width: 990,
    height: 780,
    platform: "macos",
    locale: "zh-Hans-CN",
    colorScheme: "light",
    storage: { "harness.scenario": "stream", "harness.reply": REPLY },
  });
  await app.waitFor("text:今天要构建什么？", { timeout: 20000 });
  await app.type("label:消息", "run this acp style");
  await app.submit("label:消息");
  // The answer lands when the run settles: thinking folds away and the last
  // paragraph re-parses in the same frame.
  await app.waitFor("label:复制回复", { timeout: 90000 });
  for (let i = 0; i < 30; i++) {
    await app.screenshot(`${OUT}/s${String(i).padStart(2, "0")}.png`);
    await app.wait(120);
  }
  expect(app.shows("label:复制回复")).toBe(true);
}, 150000);

test("last paragraph row grows with its text while streaming", async () => {
  const app = await open("./Harness.tsx", {
    width: 990,
    height: 780,
    platform: "macos",
    locale: "zh-Hans-CN",
    colorScheme: "light",
    storage: { "harness.scenario": "stream", "harness.reply": REPLY },
  });
  await app.waitFor("text:今天要构建什么？", { timeout: 20000 });
  await app.type("label:消息", "run this acp style");
  await app.submit("label:消息");
  for (let i = 0; i < 90; i++) {
    await app.screenshot(`${OUT}/w${String(i).padStart(2, "0")}.png`);
    await app.wait(200);
  }
  expect(app.shows("label:复制回复")).toBe(true);
}, 150000);

for (const [name, prompt] of [
  ["whole", "run this acp whole"],
  ["plain", "run this acp plain"],
  ["whole-plain", "run this acp whole plain"],
  ["split", "run this acp split"],
] as const) {
  test(`settle frames (${name})`, async () => {
    const app = await open("./Harness.tsx", {
      width: 990,
      height: 780,
      platform: "macos",
      locale: "zh-Hans-CN",
      colorScheme: "light",
      storage: { "harness.scenario": "stream", "harness.reply": REPLY },
    });
    await app.waitFor("text:今天要构建什么？", { timeout: 20000 });
    await app.type("label:消息", prompt);
    await app.submit("label:消息");
    await app.waitFor("label:复制回复", { timeout: 90000 });
    for (let i = 0; i < 12; i++) {
      await app.screenshot(`${OUT}/${name}-${String(i).padStart(2, "0")}.png`);
      await app.wait(150);
    }
    expect(app.shows("label:复制回复")).toBe(true);
  }, 150000);
}

test("a small scroll re-measures the clipped paragraph", async () => {
  const app = await open("./Harness.tsx", {
    width: 990,
    height: 780,
    platform: "macos",
    locale: "zh-Hans-CN",
    colorScheme: "light",
    storage: { "harness.scenario": "stream", "harness.reply": REPLY },
  });
  await app.waitFor("text:今天要构建什么？", { timeout: 20000 });
  await app.type("label:消息", "run this acp style");
  await app.submit("label:消息");
  await app.waitFor("label:复制回复", { timeout: 90000 });
  await app.screenshot(`${OUT}/before.png`);
  await app.scroll("label:复制回复", -40);
  await app.wait(400);
  await app.screenshot(`${OUT}/after-scroll.png`);
  await app.scroll("label:复制回复", 40);
  await app.wait(400);
  await app.screenshot(`${OUT}/after-back.png`);
  expect(app.shows("label:复制回复")).toBe(true);
}, 150000);
