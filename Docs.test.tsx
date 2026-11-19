import { expect, open, test } from "nsh/test";

// Documents inside a Coding Agent: quiet, transparent local Markdown files
// tucked into their own sidebar group (never crowding New session or Recent),
// with explicit AI handoffs (never a blind ⌘↵ into a hidden chat) and `@`
// mentions right from the composer.
//
//   nsh test Docs.test.tsx

// Notes are real files: one data folder per launch keeps each scenario blank.
let seq = 0;
const freshDir = () => `/tmp/pipi-docs-${Date.now()}-${++seq}`;
const launch = (
  options: {
    dir?: string;
    files?: Record<string, string>;
    tabs?: string[];
    pickedFolder?: string;
    pickedSaveFile?: string;
  } = {},
) =>
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
      ...(options.pickedFolder ? { "harness.pickedFolder": options.pickedFolder } : {}),
      ...(options.pickedSaveFile ? { "harness.pickedSaveFile": options.pickedSaveFile } : {}),
      "pipi.prefs.v1": JSON.stringify({ openTabs: (options.tabs ?? []).map((ref) => ({ kind: "doc", ref })) }),
    },
  });

type Launched = Awaited<ReturnType<typeof launch>>;
const EDITOR = "label:Document";
const COMPOSER = "label:Message";
const RECENT = "id:sidebar-recents";
const DOCS = "id:sidebar-docs";
const said = (app: Launched, text: string) => app.texts().includes(text);
const mentions = (app: Launched, text: string) => app.texts().some((line) => line.includes(text));

async function newNote(app: Launched) {
  await app.waitFor("text:What are we building?");
  await app.keyboard.press("mod+shift+n");
  await app.waitFor(EDITOR);
}

/** Picks the primary destination ("New Session" or "Current Draft") from the document footer menu. */
async function discussInPrimary(app: Launched) {
  await app.press("id:doc-chat-trigger");
  await app.waitFor("id:doc-chat-menu");
  await app.press("id:doc-target-new");
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
  await app.waitUntil(() => said(app, "Plan"));
  expect(said(app, "/")).toBe(false);
  expect(app.spanStyle("id:doc-editor >> text:Plan").fontWeight).toBeGreaterThanOrEqual(600);

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
  await app.wait(500);
  expect(app.count(`${DOCS} >> text:标题`)).toBe(1);
  expect(app.count(`${RECENT} >> text:标题`)).toBe(0);
  expect(mentions(app, "2 words")).toBe(true);
  await app.compose(EDITOR, "");
  await app.type(EDITOR, "写点自己的话");
  await app.waitFor(`${DOCS} >> text:标题 写点自己的话`);
  await app.waitUntil(() => mentions(app, "8 words"));
});

// ── Sidebar & Storage ───────────────────────────────────────────────────────

test("sidebar top stays pure (New session only); documents live in their own group, not Recent", async () => {
  const app = await launch();
  await app.waitFor("text:What are we building?");
  expect(app.count("id:sidebar-new-session")).toBe(1);
  expect(app.count("id:sidebar-new-doc")).toBe(0);

  await app.press("id:sidebar-docs-action");
  await app.waitFor(EDITOR);
  await app.waitFor(`${DOCS} >> text:Untitled`);
  expect(app.count(`${RECENT} >> text:Untitled`)).toBe(0);

  // Asking twice reuses the single blank note.
  await app.hover("id:sidebar-docs-action");
  await app.press("id:sidebar-docs-action");
  await app.wait(300);
  expect(app.count(`${DOCS} >> text:Untitled`)).toBe(1);
  expect(app.count("id:tab-2")).toBe(0);
  expect(app.enabled("id:doc-chat-trigger")).toBe(false);
});

test("a document whose tab is closed stays in Documents, a press away", async () => {
  const app = await launch();
  await newNote(app);
  await app.type(EDITOR, "Reading list");
  await app.waitFor(`${DOCS} >> text:Reading list`);
  expect(app.count(`${RECENT} >> text:Reading list`)).toBe(0);

  await app.press("id:tab-1 >> label:Close tab");
  await app.waitUntil(() => app.count("id:tab-1") === 0);
  await app.wait(300);
  expect(app.count(`${DOCS} >> text:Reading list`)).toBe(1);

  await app.press(`${DOCS} >> text:Reading list`);
  await app.waitFor(EDITOR);
  await app.waitUntil(() => mentions(app, "2 words"));
});

test("a document nobody wrote in leaves nothing behind", async () => {
  const app = await launch();
  await newNote(app);
  await app.waitFor(`${DOCS} >> text:Untitled`);
  await app.type(EDITOR, "# ");
  await app.wait(1000);
  await app.press("id:tab-1 >> label:Close tab");
  await app.waitUntil(() => app.count("id:tab-1") === 0);
  await app.wait(400);
  expect(app.count(`${DOCS} >> text:Untitled`)).toBe(0);
});

test("a tab on a note nobody wrote in does not come back with the app", async () => {
  const dir = freshDir();
  const app = await launch({ dir, tabs: [`${dir}/docs/note-2020-01-01.md`] });
  await app.waitFor("text:What are we building?");
  await app.waitUntil(() => app.count("id:tab-1") === 0);
  expect(app.count(`${DOCS} >> text:Untitled`)).toBe(0);
});

test("a reply is kept as a document inside Documents", async () => {
  const app = await launch();
  await app.waitFor("text:What are we building?");
  await app.press(`${RECENT} >> text:Refactor the transcript reducer`);
  await app.waitFor("id:reply-to-note");
  await app.press("id:reply-to-note");
  await app.waitFor(EDITOR);
  await app.waitUntil(() => app.count(`${DOCS} >> text:Here is the plan.`) > 0 || app.count("id:doc-editor") > 0);
  expect(app.count("id:tab-1")).toBe(1);
});

test("Settings shows the documents folder, switches to a custom folder, and resets", async () => {
  const dir = freshDir();
  const custom = `${dir}/my-articles`;
  const app = await launch({
    dir,
    pickedFolder: custom,
    files: {
      [`${dir}/docs/note-2026-01-01.md`]: "# Default Note\n\nInside default.\n",
      [`${custom}/architecture.md`]: "# Architecture Notes\n\nInside custom folder.\n",
    },
  });
  await app.waitFor("text:What are we building?");
  await app.waitFor(`${DOCS} >> text:Default Note`);

  // Open Settings -> General -> Documents folder.
  await app.keyboard.press("mod+,");
  await app.waitFor("id:settings-docs-folder-pick");
  expect(mentions(app, `${dir}/docs`)).toBe(true);
  await app.press("id:settings-docs-folder-pick");
  await app.waitFor("id:settings-docs-folder-reset");
  expect(mentions(app, custom)).toBe(true);

  await app.keyboard.press("escape");
  await app.waitFor(`${DOCS} >> text:Architecture Notes`);
  expect(app.count(`${DOCS} >> text:Default Note`)).toBe(0);

  // Reset restores the default folder.
  await app.keyboard.press("mod+,");
  await app.waitFor("id:settings-docs-folder-reset");
  await app.press("id:settings-docs-folder-reset");
  await app.waitUntil(() => app.count("id:settings-docs-folder-reset") === 0);
  await app.keyboard.press("escape");
  await app.waitFor(`${DOCS} >> text:Default Note`);
});

test("Save As writes the document with front matter intact to the chosen path", async () => {
  const dir = freshDir();
  const post = `${dir}/draft.md`;
  const exported = `${dir}/exported/final-post.md`;
  const app = await launch({
    dir,
    pickedSaveFile: exported,
    files: { [post]: "---\ntitle: Draft\n---\n\n# My Post\n\nBody.\n" },
    tabs: [post],
  });
  await app.waitFor("text:What are we building?");
  await app.press("id:tab-0");
  await app.waitFor(EDITOR);
  await app.keyboard.press("mod+down");
  await app.type(EDITOR, " Polished.");

  await app.rightClick("id:tab-0");
  await app.chooseMenuItem("Save As…");
  await app.waitUntil(() => mentions(app, "Saved as final-post.md"));

  await app.keyboard.press("mod+l");
  await app.type(COMPOSER, `recite ${exported}`);
  await app.submit(COMPOSER);
  await app.waitUntil(() => mentions(app, "title: Draft") && mentions(app, "Body. Polished."), { timeout: 8000 });
});

// ── Explicit AI handoffs & composer @ pull ──────────────────────────────────

test("⌘↵ in a document does nothing — never jumps to a hidden session", async () => {
  const app = await launch();
  await app.waitFor("text:What are we building?");
  await app.press(`${RECENT} >> text:Refactor the transcript reducer`);
  await app.waitFor("label:Conversation >> text:Refactor the transcript reducer");

  await app.keyboard.press("mod+shift+n");
  await app.waitFor(EDITOR);
  await app.type(EDITOR, "Quiet technical article draft");
  await app.keyboard.press("mod+enter");
  await app.wait(400);
  // Still writing peacefully in the document; nothing attached or sent.
  expect(app.count("id:doc-editor")).toBe(1);
  expect(app.count("id:composer-doc")).toBe(0);
});

test("Discuss with AI lets you start a clean New Session or target a named open session", async () => {
  const dir = freshDir();
  const app = await launch({ dir });
  await app.waitFor("text:What are we building?");

  // Open and keep an existing conversation so it stays on the strip beside a New Session.
  await app.press(`${RECENT} >> text:Refactor the transcript reducer`);
  await app.waitFor("label:Conversation >> text:Refactor the transcript reducer");
  await app.rightClick("id:tab-0");
  await app.chooseMenuItem("Keep Open");

  await app.keyboard.press("mod+shift+n");
  await app.waitFor(EDITOR);
  await app.type(EDITOR, "Ship the tabs on Friday, in snake_case and <xml> as written");

  // Open explicit destination menu: offers New Session + the named open session.
  await app.press("id:doc-chat-trigger");
  await app.waitFor("id:doc-chat-menu");
  expect(app.count("id:doc-chat-menu >> text:New Session")).toBe(1);
  expect(app.count("id:doc-chat-menu >> text:Refactor the transcript reducer")).toBe(1);

  // Choose New Session: lands on a clean fresh session (not inside Refactor).
  await app.press("id:doc-target-new");
  await app.waitFor("id:composer-doc");
  await app.waitFor("text:What are we building?");
  expect(app.value(COMPOSER) ?? "").toBe("");
  expect(mentions(app, "Say what to do with it, or just send")).toBe(true);

  await app.submit(COMPOSER);
  await app.waitFor("label:Conversation >> text:Ship the tabs on Friday, in snake_case and <xml> as written");
  expect(app.count("id:message-doc")).toBe(0);
  expect(app.count("id:composer-doc")).toBe(0);

  // Now take the same document explicitly to the named existing session (Refactor stays at tab-0).
  await app.press("id:tab-1");
  await app.waitFor(EDITOR);
  await app.press("id:doc-chat-trigger");
  await app.waitFor("id:doc-chat-menu");
  await app.press("id:doc-target-tab-0");
  await app.waitFor("id:composer-doc");
  await app.waitFor("label:Conversation >> text:Refactor the transcript reducer");
  await app.type(COMPOSER, "Tighten this");
  await app.submit(COMPOSER);
  await app.waitFor("label:Conversation >> text:Tighten this");
  await app.waitFor("id:message-doc");
  const wire = await sentText(app);
  expect(wire.startsWith(`Tighten this\n\n<document path="${dir}/docs/note-`)).toBe(true);
  expect(wire.endsWith(`.md">\nShip the tabs on Friday, in snake_case and <xml> as written\n</document>`)).toBe(true);
});

test("an unsent draft in the composer is offered as Current Draft without losing typed words", async () => {
  const app = await launch();
  await app.waitFor("text:What are we building?");
  await app.type(COMPOSER, "half a thought");
  await app.press("id:sidebar-docs-action");
  await app.waitFor(EDITOR);
  await app.type(EDITOR, "The rest of it");
  await app.press("id:doc-chat-trigger");
  await app.waitFor("id:doc-chat-menu");
  expect(app.count("id:doc-chat-menu >> text:Current Draft")).toBe(1);
  await app.press("id:doc-target-new");
  await app.waitFor("id:composer-doc");
  await app.wait(300);
  expect(app.value(COMPOSER)).toBe("half a thought");
  expect(app.count("label:Conversation >> text:half a thought")).toBe(0);
});

test("a passage selected offers Ask AI with explicit session choices", async () => {
  const app = await launch();
  await newNote(app);
  await app.type(EDITOR, "Keep this. Polish that");
  for (let i = 0; i < 11; i++) await app.keyboard.press("shift+left");
  await app.waitFor("id:doc-bubble-add");
  await app.waitUntil(() => said(app, "Ask AI about Selection"));
  await app.press("id:doc-bubble-add");
  await app.chooseMenuItem("New Session");
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
  await discussInPrimary(app);
  await app.waitFor("id:composer-doc");
  await app.press("id:composer-doc >> label:First thought");
  await app.waitFor(EDITOR);
  await app.type(EDITOR, ", and a second");
  await app.keyboard.press("mod+l");
  await app.waitFor("id:composer-doc");
  await app.submit(COMPOSER);
  await app.waitFor("label:Conversation >> text:First thought, and a second");
});

test("a draft expanded with ⌘E remembers its exact origin session and returns straight to it", async () => {
  const app = await launch();
  await app.waitFor("text:What are we building?");
  await app.press(`${RECENT} >> text:Refactor the transcript reducer`);
  await app.waitFor("label:Conversation >> text:Refactor the transcript reducer");

  await app.type(COMPOSER, "A brief.");
  expect(app.count("id:composer-to-doc")).toBe(0);
  await app.keyboard.press("mod+e");
  await app.waitFor(EDITOR);
  await app.waitUntil(() => mentions(app, "A brief."));
  await app.waitFor("id:doc-return-origin");
  expect(mentions(app, "Refactor the transcript reducer")).toBe(true);

  await app.type(EDITOR, " With room to go on.");
  await app.press("id:doc-return-origin");
  await app.waitFor("id:composer-doc");
  await app.waitFor("label:Conversation >> text:Refactor the transcript reducer");
  expect(app.value(COMPOSER) ?? "").toBe("");
  await app.submit(COMPOSER);
  await app.waitFor("label:Conversation >> text:A brief. With room to go on.");
});

test("typing @ in the composer pulls a document into this session; unmatched @ never traps Enter", async () => {
  const dir = freshDir();
  const app = await launch({
    dir,
    files: { [`${dir}/docs/note-arch.md`]: "# Architecture Notes\n\nKeep the surface calm.\n" },
  });
  await app.waitFor("text:What are we building?");
  await app.waitFor(`${DOCS} >> text:Architecture Notes`);

  await app.type(COMPOSER, "Review @Arch");
  await app.waitFor("id:composer-doc-menu");
  expect(app.count("id:composer-doc-menu >> text:Architecture Notes")).toBe(1);
  await app.submit(COMPOSER);
  await app.waitUntil(() => app.count("id:composer-doc-menu") === 0);
  await app.waitFor("id:composer-doc >> text:Architecture Notes");
  expect(app.value(COMPOSER)).toBe("Review");

  await app.submit(COMPOSER);
  await app.waitFor("label:Conversation >> text:Review");
  await app.waitFor("id:message-doc >> text:Architecture Notes");

  // Unmatched @ (e.g. decorator or npm scope) does not open the menu or trap Enter.
  await app.type(COMPOSER, "Check @scope/pkg");
  await app.wait(150);
  expect(app.count("id:composer-doc-menu")).toBe(0);
  await app.submit(COMPOSER);
  await app.waitFor("label:Conversation >> text:Check @scope/pkg");
});

// ── And back ────────────────────────────────────────────────────────────────

test("what an agent writes to the file is in the open document, and undo takes it out", async () => {
  const app = await launch();
  await newNote(app);
  await app.type(EDITOR, "A draft of the plan");
  await discussInPrimary(app);
  await app.waitFor("id:composer-doc");
  await app.type(COMPOSER, "rewrite this");
  await app.submit(COMPOSER);
  await app.waitFor("id:message-doc");
  await app.waitFor("id:reply-to-note");

  await app.press("id:message-doc");
  await app.waitFor(EDITOR);
  await app.waitUntil(() => mentions(app, "A final of the plan"));
  await app.waitUntil(() => mentions(app, "This document was updated from its file"));
  await app.keyboard.press("mod+z");
  await app.waitUntil(() => mentions(app, "A draft of the plan"));
});

test("typed while the agent writes: both stand, on screen and on disk", async () => {
  const dir = freshDir();
  const note = `${dir}/docs/note-plan.md`;
  const app = await launch({ dir, files: { [note]: "# Plan\n\nThe draft opening.\n\nThe closing.\n" } });
  await app.waitFor("text:What are we building?");
  await app.press(`${DOCS} >> text:Plan`);
  await app.waitFor(EDITOR);
  await discussInPrimary(app);
  await app.waitFor("id:composer-doc");
  await app.type(COMPOSER, "rewrite this slowly");
  await app.submit(COMPOSER);
  await app.waitFor("id:message-doc");
  await app.press("id:message-doc");
  await app.waitFor(EDITOR);
  await app.keyboard.press("mod+down");
  await app.type(EDITOR, " Typed meanwhile.");
  await app.waitUntil(() => mentions(app, "The final opening."), { timeout: 8000 });
  expect(mentions(app, "The closing. Typed meanwhile.")).toBe(true);

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
  expect(app.enabled("id:doc-chat-trigger")).toBe(true);
});
