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
