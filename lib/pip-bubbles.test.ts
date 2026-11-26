import { TextView } from "nsh/base";
import { expect, test } from "nsh/test";
import { groupPipMessageBlocks } from "./pip-bubbles";

const groupMarkdown = (md: string) => groupPipMessageBlocks(TextView.parse(md, { streaming: false }).blocks, md);

test("single short paragraph stays one bubble", () => {
  const groups = groupMarkdown("收到，我这就去处理。");
  expect(groups.length).toBe(1);
  expect(groups[0].blocks.length).toBe(1);
  expect(groups[0].copyText).toBe("收到，我这就去处理。");
  expect(groups[0].wide).toBe(false);
});

test("conversational paragraphs split into consecutive SMS bubbles", () => {
  const md = [
    "意思是人工客服工单已经建好了，工单号是 85493",
    "",
    "专员会去后台核查你的兑换链接和额度问题，后续的处理进展和结果会直接发到你的注册邮箱里",
    "",
    "现在等着收邮件就行，有消息了他们在邮件里告诉你",
  ].join("\n");
  const groups = groupMarkdown(md);
  expect(groups.length).toBe(3);
  expect(groups[0].copyText).toContain("85493");
  expect(groups[1].copyText).toContain("注册邮箱");
  expect(groups[2].copyText).toContain("等着收邮件");
});

test("colon lead-in paragraph stays attached to its immediately following list", () => {
  const md = [
    "懂了，是我领会慢了一拍——原来是要我连 `nsh 0.7.1` 一起发，再发 `pipi` 新版。",
    "",
    "已经另开了一个会话 `s_d48b77ae` 进 `nsh` 仓库干活：",
    "",
    "- 先对照 `0.7.0` 的提交和发版流程，确认仓库干净；",
    "- 按同款流程把版本升到 `0.7.1`、提交、打 tag。",
    "",
    "现在两条线并行跑，落地我就接着发新版。",
  ].join("\n");
  const groups = groupMarkdown(md);
  expect(groups.length).toBe(3);
  expect(groups[0].blocks.length).toBe(1);
  expect(groups[1].blocks.length).toBe(2);
  expect(groups[1].blocks[0].type).toBe("paragraph");
  expect(groups[1].blocks[1].type).toBe("list");
  expect(groups[2].blocks.length).toBe(1);
});

test("structured replies with headings stay cohesive in one bubble", () => {
  const md = [
    "## Summary",
    "",
    "First point.",
    "",
    "Second point.",
  ].join("\n");
  const groups = groupMarkdown(md);
  expect(groups.length).toBe(1);
  expect(groups[0].blocks.length).toBe(3);
});

test("long multi-paragraph templates (>5 paragraphs) stay in one bubble", () => {
  const md = ["P1", "P2", "P3", "P4", "P5", "P6"].join("\n\n");
  const groups = groupMarkdown(md);
  expect(groups.length).toBe(1);
  expect(groups[0].blocks.length).toBe(6);
});

test("bubbles containing code blocks mark themselves wide", () => {
  const md = [
    "Run this command:",
    "",
    "```sh",
    "npm run release:macos",
    "```",
  ].join("\n");
  const groups = groupMarkdown(md);
  expect(groups.length).toBe(1);
  expect(groups[0].wide).toBe(true);
});
