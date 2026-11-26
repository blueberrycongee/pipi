import assert from "node:assert/strict";
import test from "node:test";
import { meaningfulFormMessage, parseAcpForm } from "./acp-form.mjs";

test("a single field's repeated description is not shown again as the form intro", () => {
  const question = "可以联网只读查询 GitHub 上 #3423 的 PR 信息、评审和提交，并按需 fetch 到本地吗？";
  const fields = parseAcpForm({
    type: "object",
    title: "GitHub 访问",
    required: ["access"],
    properties: {
      access: {
        type: "string",
        title: "GitHub 访问",
        description: question,
        enum: ["yes", "no"],
      },
    },
  });

  assert.equal(meaningfulFormMessage(question, "GitHub 访问", fields), "");
  assert.equal(meaningfulFormMessage("线上的仓库状态需要确认。", "GitHub 访问", fields), "线上的仓库状态需要确认。");
});
