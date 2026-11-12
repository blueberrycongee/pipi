// An ACP harness names its calls by their titles ("Search for 'veil|fold'"):
// each call stays one line, its icon and words centered on the row, and the
// split-flap words keep their spaces (a piece never ends in one: a text's
// measured width leaves trailing whitespace out, and the piece wraps).
//
//   nsh test ToolTitles.test.tsx --target macos
import { expect, open, test } from "nsh/test";
import { decodeLumGrid, lum } from "./dev/frames";

test("titled calls sit on one line", async () => {
  const app = await open("./Harness.tsx", {
    width: 910,
    height: 800,
    platform: "macos",
    locale: "zh-Hans-CN",
    colorScheme: "light",
    storage: { "harness.scenario": "stream" },
  });
  await app.waitFor("text:今天要构建什么？", { timeout: 20000 });
  await app.type("label:消息", "acp: titled calls");
  await app.submit("label:消息");
  await app.wait(1000);
  await app.screenshot("/tmp/pipi-tool-titles-running.png");
  await app.waitFor("label:复制回复", { timeout: 60000 });
  await app.press("text:秒");
  await app.wait(600);
  await app.press("text:具");
  await app.wait(600);
  await app.screenshot("/tmp/pipi-tool-titles.png");
  const texts = app.texts();
  expect(texts).toContain("Search for 'veil|fold'");
  expect(texts).toContain("ls views pi lib store");
  expect(texts.some((text) => text.length > 1 && text.endsWith("\u00a0"))).toBe(false);
}, 120000);

test("overlong titled calls stay inside the right margin and truncate on one line", async () => {
  const app = await open("./Harness.tsx", {
    width: 980,
    height: 760,
    platform: "macos",
    locale: "zh-Hans-CN",
    colorScheme: "light",
    storage: { "harness.scenario": "slow" },
  });
  await app.waitFor("text:今天要构建什么？", { timeout: 20000 });
  await app.type("label:消息", "acp: long-titled");
  await app.submit("label:消息");
  // Wait until the ACP tool call is actively running (`pace: 400` holds `tool_execution_start` open).
  await app.waitUntil(() => app.texts().some((t) => t.includes("README.md")), { timeout: 20000 });
  await app.wait(200);
  const png = await app.screenshot("/tmp/pipi-long-titled-running.png");
  const grid = decodeLumGrid(png, 2);

  // Right `px-6` (24pt) gutter of the conversation pane (above the composer, below the title bar):
  // nothing from `ProcessLine` or `ActivityLine` may bleed into the right margin.
  const gutterX0 = grid.width - 10; // last 20px (~20pt at 1x / 10pt inside 24pt gutter at 2x thinned by 2)
  const y0 = Math.round(grid.height * 0.12);
  const y1 = Math.round(grid.height * 0.8);
  let darkInGutter = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = gutterX0; x < grid.width - 2; x++) {
      if (lum(grid, x, y) < 180) darkInGutter++;
    }
  }
  expect(darkInGutter).toBe(0);
}, 120000);
