// An ordered list's numbers past one digit stay on one line: "10." beside its
// item, never broken into "1" over "0.".
//
//   nsh test ListMarker.test.tsx --target macos   # writes .nsh/shots/list-marker.png
import { expect, open, test } from "nsh/test";

const REPLY = `**2. 茶楼 & 粤菜**

8. **常来小聚 / 常来饭店**
   - 中山三路店（中平里 5 号）/ 建设六马路店
9. **大鸽饭**
   - 棠下旗舰店（总店）/ 北京路店（西湖路）
10. **炳胜系**
    - **炳胜品味**：海印总店（海珠东晓路 33 号）/ 天河东店
    - **炳胜公馆**：珠江新城（冼村路 2 号 5 楼）

**3. 肠粉 & 冰室**

11. **银记肠粉**：文昌北路总店 / 文明路店
12. **华辉拉肠**：惠福东路店 / 永庆坊店
13. **九龙冰室**：正佳广场店 / 北京路店

And past a hundred:

98. ninety-eight
99. ninety-nine
100. one hundred
`;

test("ordered list markers past one digit stay on one line", async () => {
  const app = await open("./Harness.tsx", {
    width: 990,
    height: 780,
    platform: "macos",
    locale: "zh-Hans-CN",
    colorScheme: "light",
    storage: { "harness.scenario": "stream", "harness.reply": REPLY },
  });
  await app.waitFor("text:今天要构建什么？", { timeout: 20000 });
  await app.type("label:消息", "list please");
  await app.submit("label:消息");
  await app.waitFor("label:复制回复", { timeout: 90000 });
  await app.wait(600);
  await app.screenshot(".nsh/shots/list-marker.png");
  expect(app.shows("text:10.")).toBe(true);
  expect(app.shows("text:100.")).toBe(true);
}, 150000);

const BASELINE_REPLY = `1. **不硬塞** \`image\` **block**，避免上游直接 400 把任务打挂；
   1. 嵌套有序列表的纯中文首行
2. **自动降级为路径 + 元数据透传**（文件名、路径、尺寸、大小...）；
3. \`session_start\` / \`session_send\` **显式返回降级回执 / \`warnings\`**...

- 无序纯中文首行
  - 嵌套无序中文首行
- [ ] 任务复选框首行对齐
- [x] 已完成任务首行对齐
`;

function layoutOf(app: Awaited<ReturnType<typeof open>>, query: string) {
  const box = app.layout(query);
  if (!box) throw new Error(`missing layout for ${query}`);
  return box;
}

function boxY(app: Awaited<ReturnType<typeof open>>, query: string): number {
  return layoutOf(app, query).y;
}

test("ordered and unordered list markers align with the first body line", async () => {
  const app = await open("./Harness.tsx", {
    width: 990,
    height: 780,
    platform: "macos",
    locale: "zh-Hans-CN",
    colorScheme: "light",
    storage: { "harness.scenario": "stream", "harness.reply": BASELINE_REPLY },
  });
  await app.waitFor("text:今天要构建什么？", { timeout: 20000 });
  await app.type("label:消息", "baseline please");
  await app.submit("label:消息");
  await app.waitFor("label:复制回复", { timeout: 90000 });
  await app.wait(600);
  await app.screenshot(".nsh/shots/prose-list-first-line.png");

  // With the same explicit point line height, matching top edges also match
  // first baselines. Inline-code-first rows exercise the nested 0.9em span
  // that used to recompute the whole paragraph line height.
  expect(Math.abs(boxY(app, "text:2.") - boxY(app, "text:自动降级为路径 + 元数据透传（文件名、路径、尺寸、大小...）；"))).toBeLessThanOrEqual(0.5);
  expect(Math.abs(boxY(app, "text:3.") - boxY(app, "text:session_start / session_send 显式返回降级回执 / warnings..."))).toBeLessThanOrEqual(0.5);
  expect(Math.abs(boxY(app, "text:◦") - boxY(app, "text:嵌套无序中文首行"))).toBeLessThanOrEqual(0.5);
  for (const query of ["text:2.", "text:自动降级为路径 + 元数据透传（文件名、路径、尺寸、大小...）；", "text:session_start / session_send 显式返回降级回执 / warnings..."]) {
    expect(Math.abs(layoutOf(app, query).height - 23)).toBeLessThanOrEqual(0.5);
  }
}, 150000);

const PIP_OVERFLOW_REPLY = `机器人认可核心修复方向，提了 3 条偏维护者口味的意见：

1. **新增并行公开 API：\`set_updater_transport_with_redirects\` / \`UpdaterHost::get_with_redirects\` 与原接口并列**；建议合并或由维护者定夺。
   - 我的判断：当初没改原签名是为了保 \`nsh-compat\`（确实绿了），这里不需要硬改破坏兼容；若要收敛可以把旧入口标成 deprecated 并写迁移说明，但不要在这个 PR 里顺手改掉所有调用方。
2. **新依赖 \`same-file\` + 拆出 \`.part.lock\` 改造**：机器人指出 \`same-file\` 需维护者审批，且 \`.part.lock\` inode 重构和 URL 修复是两件事，建议拆 PR。
   - 我的判断：这条很有价值。开源仓库维护者对「顺手加新 crate 依赖 + 混两件事」通常最犹豫；如果把依赖审批、锁文件 inode 重构和 URL 修复塞在一个 PR 里，审查成本会明显变高，最好拆成两个可独立回滚的变更。
`;

test("Pip SMS list markers stay on first lines and nested items wrap inside the bubble", async () => {
  const app = await open("./Harness.tsx", {
    width: 1180,
    height: 1100,
    platform: "macos",
    locale: "zh-Hans-CN",
    colorScheme: "light",
    storage: {
      "harness.scenario": "history",
      "harness.history": JSON.stringify([
        { role: "user", content: "按截图复现列表排版", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: PIP_OVERFLOW_REPLY }], provider: "test", model: "test", timestamp: 2, stopReason: "stop" },
      ]),
    },
  });
  await app.waitFor("id:sidebar-pip", { timeout: 20000 });
  await app.press("id:sidebar-pip");
  await app.waitFor("text:机器人认可核心修复方向，提了 3 条偏维护者口味的意见：", { timeout: 20000 });
  await app.wait(600);
  await app.screenshot(".nsh/shots/pip-list-overflow-repro.png");

  const firstItem = "新增并行公开 API：set_updater_transport_with_redirects / UpdaterHost::get_with_redirects 与原接口并列；建议合并或由维护者定夺。";
  const firstNested = "我的判断：当初没改原签名是为了保 nsh-compat（确实绿了），这里不需要硬改破坏兼容；若要收敛可以把旧入口标成 deprecated 并写迁移说明，但不要在这个 PR 里顺手改掉所有调用方。";
  const secondItem = "新依赖 same-file + 拆出 .part.lock 改造：机器人指出 same-file 需维护者审批，且 .part.lock inode 重构和 URL 修复是两件事，建议拆 PR。";
  const secondNested = "我的判断：这条很有价值。开源仓库维护者对「顺手加新 crate 依赖 + 混两件事」通常最犹豫；如果把依赖审批、锁文件 inode 重构和 URL 修复塞在一个 PR 里，审查成本会明显变高，最好拆成两个可独立回滚的变更。";
  const bubble = layoutOf(app, "id:pip-sms-bubble");
  const first = layoutOf(app, `text:${firstItem}`);
  const second = layoutOf(app, `text:${secondItem}`);
  const nested1 = layoutOf(app, `text:${firstNested}`);
  const nested2 = layoutOf(app, `text:${secondNested}`);
  const one = layoutOf(app, "text:1.");
  const two = layoutOf(app, "text:2.");
  const bullet1 = layoutOf(app, "text:◦ >> nth=0");
  const bullet2 = layoutOf(app, "text:◦ >> nth=1");

  // The reproduction really is multi-line: both ordered items wrap to three
  // lines, and their nested judgments wrap inside the bubble rather than
  // escaping it as one max-content line.
  expect(first.height).toBeGreaterThan(46);
  expect(second.height).toBeGreaterThan(46);
  expect(nested1.height).toBeGreaterThan(23);
  expect(nested2.height).toBeGreaterThan(23);
  expect(Math.abs(one.y - first.y)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(two.y - second.y)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(bullet1.y - nested1.y)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(bullet2.y - nested2.y)).toBeLessThanOrEqual(0.5);
  const contentRight = bubble.x + bubble.width - 16;
  expect(nested1.x + nested1.width).toBeLessThanOrEqual(contentRight + 0.5);
  expect(nested2.x + nested2.width).toBeLessThanOrEqual(contentRight + 0.5);
  expect(nested1.clipped).toBe(false);
  expect(nested2.clipped).toBe(false);
}, 150000);

const PIP_PURE_ORDERED_REPLY = `### 建议下一步

1. **#3586 肯定要修：** 我可以直接派 Devin 修掉 \`nsh-base\` terminal 9 个回归 + 放宽 Linux 单测硬编码 + 按建议精简为 \`#[doc(hidden)]\` 复用 \`ResolvedTextStyle\`，复跑全绿后推上 #3586。
2. **#3585 请你拍板：** 是趁手把 \`same-file\` + \`.part.lock\` 拆出去让它 0 依赖秒合，还是先不动代码、留条简短回复等 \`@huacnlee\` 拍板，也方便 #3586 单独合入？

（另外，刚才派出去查 \`.nshpkg\` 热更 sidecar 路径的 \`s_ijfa0ec0\` 还在跑，有结果我也会立刻报你。）
`;

test("Pip SMS pure multiline ordered list markers stay on their first lines", async () => {
  const app = await open("./Harness.tsx", {
    width: 1180,
    height: 1100,
    platform: "macos",
    locale: "zh-Hans-CN",
    colorScheme: "light",
    storage: {
      "harness.scenario": "history",
      "harness.history": JSON.stringify([
        { role: "user", content: "纯多行有序列表复现", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: PIP_PURE_ORDERED_REPLY }], provider: "test", model: "test", timestamp: 2, stopReason: "stop" },
      ]),
    },
  });
  await app.waitFor("id:sidebar-pip", { timeout: 20000 });
  await app.press("id:sidebar-pip");
  await app.waitFor("text:建议下一步", { timeout: 20000 });
  await app.wait(600);
  await app.screenshot(".nsh/shots/pip-list-pure-ordered.png");

  const firstItem = "#3586 肯定要修： 我可以直接派 Devin 修掉 nsh-base terminal 9 个回归 + 放宽 Linux 单测硬编码 + 按建议精简为 #[doc(hidden)] 复用 ResolvedTextStyle，复跑全绿后推上 #3586。";
  const secondItem = "#3585 请你拍板： 是趁手把 same-file + .part.lock 拆出去让它 0 依赖秒合，还是先不动代码、留条简短回复等 @huacnlee 拍板，也方便 #3586 单独合入？";
  const bubble = layoutOf(app, "id:pip-sms-bubble");
  const first = layoutOf(app, `text:${firstItem}`);
  const second = layoutOf(app, `text:${secondItem}`);
  const one = layoutOf(app, "text:1.");
  const two = layoutOf(app, "text:2.");

  // Both items wrap to at least three lines in the bubble, as in the user's
  // no-nested-list reproduction.
  expect(first.height).toBeGreaterThan(46);
  expect(second.height).toBeGreaterThan(46);
  expect(Math.abs(one.y - first.y)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(two.y - second.y)).toBeLessThanOrEqual(0.5);
  expect(first.x + first.width).toBeLessThanOrEqual(bubble.x + bubble.width - 16 + 0.5);
  expect(second.x + second.width).toBeLessThanOrEqual(bubble.x + bubble.width - 16 + 0.5);
  expect(first.clipped).toBe(false);
  expect(second.clipped).toBe(false);
}, 150000);
