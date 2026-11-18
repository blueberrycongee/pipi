import { expect, open, test } from "nsh/test";

// The document: a page of one's own words, with the agents a key away.
//
// Writing: the `/` menu answers Enter, Tab and the arrows (and `、`, what a
// Chinese input method types for the same key); an input method composes in
// place. Keeping: a document is in 最近 beside the sessions from the press
// that made it, a press away once its tab is closed, and gone when nobody
// wrote in it. Going to a session: ⌘↵ attaches it to the composer's message —
// the passage selected, else all of it; sent without a word it is the
// message, with one it rides behind the words. Coming back: what an agent
// writes to the file is in the open document, and undo takes it out again.
//
//   nsh test Docs.test.tsx

// Notes are real files: one data folder per launch keeps each scenario blank.
let seq = 0;
const freshDir = () => `/tmp/pipi-docs-${Date.now()}-${++seq}`;
const launch = (options: { dir?: string; files?: Record<string, string>; tabs?: string[] } = {}) =>
  open("./Harness.tsx", {
    width: 1180,
    height: 780,
    platform: "macos",
    locale: "en-US",
    storage: {
      "harness.scenario": "welcome",
      "harness.distinct": "1",
      "harness.dataDir": options.dir ?? freshDir(),
      "harness.files": JSON.stringify(options.files ?? {}),
      "pipi.prefs.v1": JSON.stringify({ openTabs: (options.tabs ?? []).map((ref) => ({ kind: "doc", ref })) }),
    },
  });

type Launched = Awaited<ReturnType<typeof launch>>;
const EDITOR = "label:Document";
const COMPOSER = "label:Message";
const RECENT = "id:sidebar-recents";
const said = (app: Launched, text: string) => app.texts().includes(text);
const mentions = (app: Launched, text: string) => app.texts().some((line) => line.includes(text));

async function newNote(app: Launched) {
  await app.waitFor("text:What are we building?");
  await app.keyboard.press("mod+shift+n");
  await app.waitFor(EDITOR);
}

/** What the last message was sent as: the bubble's Copy puts the wire text on the clipboard. */
async function sentText(app: Launched) {
  await app.rightClick("label:Conversation >> id:message-doc");
  await app.chooseMenuItem("Copy");
  return app.clipboard() ?? "";
}

// ── Writing ─────────────────────────────────────────────────────────────────

test("'/' lists blocks; the arrows move and Enter picks — every time", async () => {
  const app = await launch();
  await newNote(app);
  await app.type(EDITOR, "/");
  await app.waitFor("id:doc-slash-menu");
  await app.keyboard.press("down");
  await app.keyboard.press("enter");
  await app.waitUntil(() => app.count("id:doc-slash-menu") === 0);
  await app.type(EDITOR, "Plan");
  // The typed `/` is gone and the text is the picked block's (it names the note's tab).
  await app.waitUntil(() => said(app, "Plan"));
  expect(said(app, "/")).toBe(false);
  // The second row is Heading 2: the words are set as a heading's.
  expect(app.spanStyle("id:doc-editor >> text:Plan").fontWeight).toBeGreaterThanOrEqual(600);

  // Again, in a new block: the menu opens fresh — the last Enter is not replayed.
  await app.keyboard.press("enter");
  await app.type(EDITOR, "/");
  await app.waitFor("id:doc-slash-menu");
  await app.wait(100);
  expect(app.count("id:doc-slash-menu")).toBe(1);
  await app.keyboard.press("escape");
  await app.waitUntil(() => app.count("id:doc-slash-menu") === 0);
});

test("a query narrows the list, Tab picks, and nothing to offer gives Enter back", async () => {
  const app = await launch();
  await newNote(app);
  await app.type(EDITOR, "/quo");
  await app.waitFor("id:doc-slash-menu");
  expect(said(app, "Quote")).toBe(true);
  expect(said(app, "Table")).toBe(false);
  await app.keyboard.press("tab");
  await app.waitUntil(() => app.count("id:doc-slash-menu") === 0);
  await app.type(EDITOR, "said");
  await app.waitUntil(() => said(app, "said"));
  expect(said(app, "/quo")).toBe(false);

  // Nothing matches: the menu is gone, and Enter is the text's again — a new line.
  await app.keyboard.press("enter");
  await app.keyboard.press("enter");
  await app.type(EDITOR, "/zzz");
  await app.wait(100);
  expect(app.count("id:doc-slash-menu")).toBe(0);
  await app.keyboard.press("enter");
  await app.type(EDITOR, "next");
  await app.waitUntil(() => said(app, "next"));
  expect(said(app, "/zzz")).toBe(true);
});

test("'、' — the same key under a Chinese input method — opens the menu too", async () => {
  const app = await launch();
  await newNote(app);
  await app.type(EDITOR, "、");
  await app.waitFor("id:doc-slash-menu");
  await app.keyboard.press("enter");
  await app.waitUntil(() => app.count("id:doc-slash-menu") === 0);
  expect(said(app, "、")).toBe(false);
});

test("an input method's marked text shows in place and is not the document's until it commits", async () => {
  const app = await launch();
  await newNote(app);
  await app.type(EDITOR, "标题 ");
  await app.compose(EDITOR, "xie dian");
  await app.waitUntil(() => mentions(app, "xie dian"));
  // Still composing: the document is named and counted by what is in it.
  await app.wait(500);
  expect(app.count(`${RECENT} >> text:标题`)).toBe(1);
  expect(mentions(app, "2 words")).toBe(true);
  await app.compose(EDITOR, "");
  await app.type(EDITOR, "写点自己的话");
  await app.waitFor(`${RECENT} >> text:标题 写点自己的话`);
  // Counted as the language counts: a character is a word.
  await app.waitUntil(() => mentions(app, "8 words"));
});

// ── Keeping ─────────────────────────────────────────────────────────────────

test("a new document is in Recent from the press that made it; asked for twice it is one", async () => {
  const app = await launch();
  await app.waitFor("text:What are we building?");
  await app.press("id:sidebar-new-doc");
  await app.waitFor(EDITOR);
  await app.waitFor(`${RECENT} >> text:Untitled`);
  await app.press("id:sidebar-new-doc");
  await app.wait(300);
  expect(app.count(`${RECENT} >> text:Untitled`)).toBe(1);
  expect(app.count("id:tab-2")).toBe(0);
  // Nothing in it: nothing to take to a session.
  expect(app.enabled("id:doc-add")).toBe(false);
});

test("a document whose tab is closed is in Recent, a press away", async () => {
  const app = await launch();
  await newNote(app);
  await app.type(EDITOR, "Reading list");
  // Named by its first line, where it stood from the start.
  await app.waitFor(`${RECENT} >> text:Reading list`);
  await app.press("id:tab-1 >> label:Close tab");
  await app.waitUntil(() => app.count("id:tab-1") === 0);
  await app.wait(300);
  expect(app.count(`${RECENT} >> text:Reading list`)).toBe(1);

  await app.press(`${RECENT} >> text:Reading list`);
  await app.waitFor(EDITOR);
  await app.waitUntil(() => mentions(app, "2 words"));
});

test("a document nobody wrote in leaves nothing behind", async () => {
  const app = await launch();
  await newNote(app);
  await app.waitFor(`${RECENT} >> text:Untitled`);
  // A heading typed and taken back is still nothing written.
  await app.type(EDITOR, "# ");
  await app.wait(1000);
  await app.press("id:tab-1 >> label:Close tab");
  await app.waitUntil(() => app.count("id:tab-1") === 0);
  await app.wait(400);
  expect(app.count(`${RECENT} >> text:Untitled`)).toBe(0);
});

test("a reply is kept as a document", async () => {
  const app = await launch();
  await app.waitFor("text:What are we building?");
  await app.press(`${RECENT} >> text:Refactor the transcript reducer`);
  await app.waitFor("id:reply-to-note");
  await app.press("id:reply-to-note");
  await app.waitFor(EDITOR);
  await app.waitUntil(() => app.count(`${RECENT} >> label:Refactor the transcript reducer`) + app.count("id:doc-editor") > 0);
  expect(app.count("id:tab-1")).toBe(1);
});

// ── To a session ────────────────────────────────────────────────────────────

test("⌘↵ attaches the document to the message; sent without a word, it is the message", async () => {
  const app = await launch();
  await newNote(app);
  await app.type(EDITOR, "Ship the tabs on Friday, in snake_case and <xml> as written");
  await app.keyboard.press("mod+enter");
  // The chat comes forward with the document on the composer — its words are not pasted into the field.
  await app.waitFor("id:composer-doc");
  expect(app.value(COMPOSER) ?? "").toBe("");
  expect(mentions(app, "Say what to do with it, or just send")).toBe(true);

  await app.submit(COMPOSER);
  // The bubble is the document's own words, as written: no escapes, no block around them.
  await app.waitFor("label:Conversation >> text:Ship the tabs on Friday, in snake_case and <xml> as written");
  expect(app.count("id:message-doc")).toBe(0);
  expect(app.count("id:composer-doc")).toBe(0);
});

test("⌘↵ in a document sends nothing: what the composer already held is the word about it", async () => {
  const app = await launch();
  await app.waitFor("text:What are we building?");
  await app.type(COMPOSER, "half a thought");
  await app.press("id:sidebar-new-doc");
  await app.waitFor(EDITOR);
  await app.type(EDITOR, "The rest of it");
  await app.keyboard.press("mod+enter");
  await app.waitFor("id:composer-doc");
  await app.wait(400);
  expect(app.value(COMPOSER)).toBe("half a thought");
  expect(app.count("label:Conversation >> text:half a thought")).toBe(0);
});

test("a tab on a note nobody wrote in does not come back with the app", async () => {
  const dir = freshDir();
  const app = await launch({ dir, tabs: [`${dir}/docs/note-2020-01-01.md`] });
  await app.waitFor("text:What are we building?");
  await app.waitUntil(() => app.count("id:tab-1") === 0);
  expect(app.count(`${RECENT} >> text:Untitled`)).toBe(0);
});

test("sent with a word about it, the document rides behind the words and names its file", async () => {
  const dir = freshDir();
  const app = await launch({ dir });
  await newNote(app);
  await app.type(EDITOR, "Launch brief");
  await app.keyboard.press("mod+enter");
  await app.waitFor("id:composer-doc");
  await app.type(COMPOSER, "Tighten this");
  await app.submit(COMPOSER);
  // The bubble says the word and names the document; the session is titled by the word.
  await app.waitFor("label:Conversation >> text:Tighten this");
  await app.waitFor("id:message-doc >> text:Launch brief");
  const wire = await sentText(app);
  expect(wire.startsWith(`Tighten this\n\n<document path="${dir}/docs/note-`)).toBe(true);
  expect(wire.endsWith(`.md">\nLaunch brief\n</document>`)).toBe(true);
  await app.waitFor(`${RECENT} >> text:Tighten this`);

  // The card on the message leads back to the document.
  await app.press("id:message-doc");
  await app.waitFor(EDITOR);
});

test("a passage selected goes alone; what is written after attaching is sent too", async () => {
  const app = await launch();
  await newNote(app);
  await app.type(EDITOR, "Keep this. Polish that");
  for (let i = 0; i < 11; i++) await app.keyboard.press("shift+left");
  // The bubble offers the passage, and the foot says what will go.
  await app.waitFor("id:doc-bubble-add");
  await app.waitUntil(() => said(app, "Add Selection to Chat"));
  await app.press("id:doc-bubble-add");
  await app.waitFor("id:composer-doc >> text:Selection");
  await app.type(COMPOSER, "Reword");
  await app.submit(COMPOSER);
  await app.waitFor("id:message-doc");
  const wire = await sentText(app);
  expect(wire.includes(`">\nPolish that\n</selection>`)).toBe(true);
  expect(wire.includes("Keep this")).toBe(false);
});

test("a document attached is sent as it reads when sent", async () => {
  const app = await launch();
  await newNote(app);
  await app.type(EDITOR, "First thought");
  await app.keyboard.press("mod+enter");
  await app.waitFor("id:composer-doc");
  // Back to the document for one more line, then to the chat without attaching again.
  await app.press("id:composer-doc >> label:First thought");
  await app.waitFor(EDITOR);
  await app.type(EDITOR, ", and a second");
  await app.keyboard.press("mod+l");
  await app.waitFor("id:composer-doc");
  await app.submit(COMPOSER);
  await app.waitFor("label:Conversation >> text:First thought, and a second");
});

test("a long draft goes on as a document, and comes back attached", async () => {
  const app = await launch();
  await app.waitFor("text:What are we building?");
  // Short: the field is enough, and nothing is offered.
  await app.type(COMPOSER, "A brief.");
  expect(app.count("id:composer-to-doc")).toBe(0);
  await app.keyboard.press("mod+e");
  await app.waitFor(EDITOR);
  // Moved, not copied: the document has the words, the field has none.
  await app.waitUntil(() => mentions(app, "A brief."));
  await app.type(EDITOR, " With room to go on.");
  await app.keyboard.press("mod+enter");
  await app.waitFor("id:composer-doc");
  expect(app.value(COMPOSER) ?? "").toBe("");
  await app.submit(COMPOSER);
  await app.waitFor("label:Conversation >> text:A brief. With room to go on.");
});

// ── And back ────────────────────────────────────────────────────────────────

test("what an agent writes to the file is in the open document, and undo takes it out", async () => {
  const app = await launch();
  await newNote(app);
  await app.type(EDITOR, "A draft of the plan");
  await app.keyboard.press("mod+enter");
  await app.waitFor("id:composer-doc");
  // The scripted agent rewrites the file it was handed: "draft" becomes "final".
  await app.type(COMPOSER, "rewrite this");
  await app.submit(COMPOSER);
  await app.waitFor("id:message-doc");
  await app.waitFor("id:reply-to-note");

  await app.press("id:message-doc");
  await app.waitFor(EDITOR);
  await app.waitUntil(() => mentions(app, "A final of the plan"));
  // Words that changed without the writer's hand are said, with the way back.
  await app.waitUntil(() => mentions(app, "This document was updated from its file"));
  // The agent's change is one step the writer can take back.
  await app.keyboard.press("mod+z");
  await app.waitUntil(() => mentions(app, "A draft of the plan"));
});

test("typed while the agent writes: both stand, on screen and on disk", async () => {
  const dir = freshDir();
  const note = `${dir}/docs/note-plan.md`;
  const app = await launch({ dir, files: { [note]: "# Plan\n\nThe draft opening.\n\nThe closing.\n" } });
  await app.waitFor("text:What are we building?");
  await app.press(`${RECENT} >> text:Plan`);
  await app.waitFor(EDITOR);
  await app.keyboard.press("mod+enter");
  await app.waitFor("id:composer-doc");
  await app.type(COMPOSER, "rewrite this slowly");
  await app.submit(COMPOSER);
  await app.waitFor("id:message-doc");
  // Back in the document at once, writing at its end while the agent's change lands on the opening.
  await app.press("id:message-doc");
  await app.waitFor(EDITOR);
  await app.keyboard.press("mod+down");
  await app.type(EDITOR, " Typed meanwhile.");
  await app.waitUntil(() => mentions(app, "The final opening."), { timeout: 8000 });
  expect(mentions(app, "The closing. Typed meanwhile.")).toBe(true);

  // The file holds both, once the save lands.
  await app.wait(1200);
  await app.keyboard.press("mod+l");
  await app.type(COMPOSER, `recite ${note}`);
  await app.submit(COMPOSER);
  await app.waitUntil(() => mentions(app, "The final opening.") && mentions(app, "The closing. Typed meanwhile."), { timeout: 8000 });
});

// ── Files from elsewhere ────────────────────────────────────────────────────

test("a file's front matter is kept as written through an edit", async () => {
  const dir = freshDir();
  const post = `${dir}/post.md`;
  const app = await launch({ dir, files: { [post]: "---\ntitle: Hello\ntags: [a, b]\n---\n\n# Hello\n\nBody.\n" }, tabs: [post] });
  await app.waitFor("text:What are we building?");
  await app.press("id:tab-0");
  await app.waitFor(EDITOR);
  // The editor shows the document, not its front matter.
  expect(mentions(app, "title: Hello")).toBe(false);
  await app.keyboard.press("mod+down");
  await app.type(EDITOR, " More.");
  await app.wait(1200);
  await app.keyboard.press("mod+l");
  await app.type(COMPOSER, `recite ${post}`);
  await app.submit(COMPOSER);
  await app.waitUntil(() => mentions(app, "title: Hello\ntags: [a, b]\n---\n\n# Hello\n\nBody. More."), { timeout: 8000 });
});

test("a file holding what the editor cannot keep is shown, not rewritten", async () => {
  const dir = freshDir();
  const readme = `${dir}/README.md`;
  const app = await launch({ dir, files: { [readme]: '# Project\n\n<img src="logo.png" width="80">\n\nText.\n' }, tabs: [readme] });
  await app.waitFor("text:What are we building?");
  await app.press("id:tab-0");
  await app.waitFor(EDITOR);
  await app.waitUntil(() => mentions(app, "Read-only"));
  await app.keyboard.press("mod+down");
  await app.type(EDITOR, " typed");
  await app.wait(1200);
  expect(mentions(app, "Text. typed")).toBe(false);
  // It still goes to a session.
  expect(app.enabled("id:doc-add")).toBe(true);
});
