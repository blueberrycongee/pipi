// A selection dropped in the thin strip between a reply's blocks keeps going:
// drops target glyph line boxes only — a taller gap clamps the caret back to
// the block before — so the room between blocks stays under a line's leading.
//
//   nsh test SelectGap.test.tsx --target macos    # on the real list
//
// What a drag reached is read from the copy, pasted into the composer (`⌘L`, `⌘V`).
import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

/** What `⌘C` takes of the selection, read where a paste puts it (the composer, `⌘L`). */
async function copied(app: App) {
  await app.keyboard.press("mod+c");
  await app.keyboard.press("mod+l");
  await app.clear("label:消息");
  await app.keyboard.press("mod+v");
  await app.waitUntil(() => (app.value("label:消息") ?? "").length > 0);
  const text = app.value("label:消息") ?? "";
  await app.clear("label:消息");
  return text;
}

const REPLY = `已接入完成 ✅

你的本机 Claude Code 其实早就配置好了这个端点（\`~/.claude/settings.json\` 里已有 ANTHROPIC_BASE_URL），只是之前默认模型是 claude-opus-5-5。我做了以下更新：

- 第一项 ANTHROPIC_MODEL 改为 \`claude-fable-5-2\`
- 第二项说明

结束段落`;

test("a drag ending around the paragraph/list boundary reaches the list", async () => {
  const app = await open("./Harness.tsx", {
    width: 910,
    height: 1045,
    platform: "macos",
    locale: "zh-Hans-CN",
    colorScheme: "light",
    storage: { "harness.scenario": "stream", "harness.reply": REPLY },
  });
  await app.waitFor("text:今天要构建什么？", { timeout: 20000 });
  await app.type("label:消息", "sel");
  await app.submit("label:消息");
  await app.waitFor("label:复制回复", { timeout: 60000 });
  await app.wait(600);

  // From the first paragraph's middle down past the paragraph above the list:
  // every landing spot reaches into the list, none dead-ends on the paragraph.
  for (const dy of [76, 80, 84]) {
    await app.drag("text:已接入完成 ✅", { x: 60, y: dy });
    await app.wait(250);
    const copy = await copied(app);
    expect(copy).toContain("第一项 ANTHROPIC_MODEL");
    await app.drag("text:已接入完成 ✅", { x: 0, y: 0 });
    await app.wait(150);
  }
}, 120000);
