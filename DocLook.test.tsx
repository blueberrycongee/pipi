import { open, test } from "nsh/test";

// The document as it is drawn, and its way to a session and back: a full
// document, an empty one, the `/` menu, a passage selected, the card it is on
// the composer, the message it rode on, a draft long enough to be offered a
// document.
//
//   nsh test DocLook.test.tsx --target macos   → .nsh/shots/doc-*.png

const dir = `/tmp/pipi-doclook-${Date.now()}`;
const sample = `# Launch plan

Some opening paragraph that runs long enough to wrap onto a second line so we can see what the line height and measure feel like in the editor.

## Goals

- First bullet with **bold** and *italic* and \`code\`
- Second bullet
  - Nested bullet

1. Numbered one
2. Numbered two

- [ ] A task to do
- [x] A task done

> A quote that someone said once.

\`\`\`ts
const a = 1;
function hello() { return a; }
\`\`\`

| Name | Value |
| --- | --- |
| a | 1 |
| b | 2 |

---

### 中文段落

这是一段中文，用来看看中文排版的行高与字距是否合适，以及中英文 mixed 的效果。
`;
const launch = (locale = "en-US") =>
  open("./Harness.tsx", {
    width: 1180, height: 780, platform: "macos", locale,
    storage: {
      "harness.scenario": "welcome", "harness.distinct": "1", "harness.dataDir": dir,
      "harness.files": JSON.stringify({
        [`${dir}/sample.md`]: sample,
        [`${dir}/docs/note-a.md`]: "# Tab strip brief\n\nWhat the strip is for.\n",
        [`${dir}/docs/note-b.md`]: "Questions for the review\n\n- one\n",
      }),
      "pipi.prefs.v1": JSON.stringify({ openTabs: [{ kind: "doc", ref: `${dir}/sample.md` }] }),
    },
  });
const EDITOR = "label:Document";

test("look", async () => {
  const app = await launch();
  await app.waitFor("text:What are we building?");
  await app.press("id:tab-0");
  await app.waitFor("id:doc-editor");
  await app.wait(800);
  await app.screenshot(".nsh/shots/doc-full.png");

  // A new document from the sidebar: a blank page, and its row in Recent already.
  await app.press("id:sidebar-new-doc");
  await app.waitFor("text:Untitled");
  await app.wait(500);
  await app.screenshot(".nsh/shots/doc-empty.png");
  await app.keyboard.press("/");
  await app.waitFor("id:doc-slash-menu");
  await app.wait(300);
  await app.screenshot(".nsh/shots/doc-slash.png");
  await app.keyboard.press("escape");
  await app.keyboard.press("backspace");

  // A document looked at from Recent: the strip's preview seat, its name in italics.
  await app.press("id:sidebar-recents >> text:Tab strip brief");
  await app.wait(500);
  await app.screenshot(".nsh/shots/doc-note-preview.png");

  // A passage selected: the bubble offers it to the session, and the foot says what will go.
  await app.keyboard.press("mod+down");
  for (let i = 0; i < 13; i++) await app.keyboard.press("shift+left");
  await app.waitFor("id:doc-bubble-add");
  await app.wait(400);
  await app.screenshot(".nsh/shots/doc-selection.png");
  await app.keyboard.press("right");

  // Taken to the session: a card on the composer, the words still in the document.
  await app.keyboard.press("mod+enter");
  await app.waitFor("id:composer-doc");
  await app.wait(600);
  await app.screenshot(".nsh/shots/doc-card.png");

  // Sent with a word about it: the bubble says the word and names the document.
  await app.type("label:Message", "Tighten this, keep my voice");
  await app.submit("label:Message");
  await app.waitFor("id:message-doc");
  await app.wait(1500);
  await app.screenshot(".nsh/shots/doc-sent.png");
});

test("a long draft is offered a document", async () => {
  const app = await launch("zh-CN");
  await app.waitFor("id:sidebar-new-session");
  await app.wait(400);
  await app.type(
    "label:消息",
    "我们现在在一个分支上做了这样的一件事，就是增加了一个文档的编写，以及加上了一个 tabbar。但是其实这个功能我觉得还不成熟，我自己没有很想清楚这个功能的动线，合适的情况是如何的。我想你以用户视角思考，这个实际的价值在什么地方。我想做这个的初衷是，现在的 AI 写文章写的很烂，一股 AI 味，我有时候想写点啥，但是感觉来个 obsidian 不是很好。",
  );
  await app.wait(600);
  await app.screenshot(".nsh/shots/doc-long-draft.png");
  await app.press("id:composer-to-doc");
  await app.waitFor("id:doc-editor");
  await app.wait(800);
  await app.screenshot(".nsh/shots/doc-from-draft.png");

  // And back: the document on the composer, then the message it rode on.
  await app.keyboard.press("mod+enter");
  await app.waitFor("id:composer-doc");
  await app.wait(600);
  await app.screenshot(".nsh/shots/doc-card-zh.png");
  await app.submit("label:消息");
  await app.wait(1500);
  await app.screenshot(".nsh/shots/doc-sent-zh.png");
});

test("a file the editor cannot keep whole is shown read-only", async () => {
  const readme = `${dir}/README.md`;
  const app = await open("./Harness.tsx", {
    width: 1180, height: 780, platform: "macos", locale: "en-US",
    storage: {
      "harness.scenario": "welcome", "harness.distinct": "1", "harness.dataDir": `${dir}-ro`,
      "harness.files": JSON.stringify({ [readme]: '# Project\n\n<img src="logo.png" width="80">\n\nWhat it is, in a paragraph.\n' }),
      "pipi.prefs.v1": JSON.stringify({ openTabs: [{ kind: "doc", ref: readme }] }),
    },
  });
  await app.waitFor("text:What are we building?");
  await app.press("id:tab-0");
  await app.waitFor("id:doc-editor");
  await app.wait(600);
  await app.screenshot(".nsh/shots/doc-readonly.png");
});
