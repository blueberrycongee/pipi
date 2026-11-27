import { expect, open, test } from "nsh/test";

// Personal Agent quote-reply, tapback and sticker interactions.
//
//   nsh test PipReply.test.tsx

const launch = (storage: Record<string, string> = {}) =>
  open("./Harness.tsx", {
    width: 1180,
    height: 1100,
    platform: "macos",
    locale: "en-US",
    clock: {},
    storage: { "harness.scenario": "stream", "harness.reply": "Target answer.", ...storage },
  });

const openPipWithReply = async (app: Awaited<ReturnType<typeof launch>>) => {
  // Opening is asynchronous; a second press joins the in-flight persona start rather than duplicating it.
  await app.press("id:sidebar-pip");
  await app.press("id:sidebar-pip");
  await app.waitFor("text:Hey, what's up?");
  await app.type("label:Message", "first question");
  await app.submit("label:Message");
  await app.waitFor("text:Target answer.");
  await app.waitUntil(() => !app.shows("id:pip-typing-bubble"));
};

test("reply enters blur-focus, Escape and backdrop cancel, and sending restores a clean quote card", async () => {
  const app = await launch();
  await openPipWithReply(app);

  await app.rightClick("id:pip-sms-bubble");
  await app.waitFor("id:pip-message-menu");
  expect(app.shows("id:pip-tapback-row")).toBe(true);
  await app.press("id:pip-menu-reply");
  await app.waitFor("id:pip-reply-focus-layer");
  expect(app.shows("id:pip-reply-focus-bubble")).toBe(true);
  expect(app.shows("id:composer-reply-strip")).toBe(true);
  expect(app.shows("text:Reply…")).toBe(true);

  await app.keyboard.press("escape");
  await app.waitUntil(() => !app.shows("id:pip-reply-focus-layer"));
  expect(app.shows("id:composer-reply-strip")).toBe(false);

  await app.rightClick("id:pip-sms-bubble");
  await app.waitFor("id:pip-message-menu");
  await app.press("id:pip-menu-reply");
  await app.waitFor("id:pip-reply-focus-layer");
  await app.press("id:composer-reply-cancel");
  await app.waitUntil(() => !app.shows("id:pip-reply-focus-layer"));

  await app.rightClick("id:pip-sms-bubble");
  await app.waitFor("id:pip-message-menu");
  await app.press("id:pip-menu-reply");
  await app.waitFor("id:pip-reply-focus-layer");
  await app.type("label:Message", "plain answer back");
  await app.submit("label:Message");

  await app.waitFor("id:pip-quote-preview");
  await app.waitFor("text:plain answer back");
  expect(app.shows("id:pip-reply-focus-layer")).toBe(false);
  expect(app.shows("id:composer-reply-strip")).toBe(false);
  expect(app.count("text:<pipi-reply")).toBe(0);
  expect(app.count("text:pipi-reply")).toBe(0);
  expect(app.count("id:pip-quote-preview >> text:Target answer.")).toBeGreaterThan(0);

  await app.press("id:pip-sms-bubble >> id:pip-message-actions");
  await app.waitFor("id:pip-message-menu");
  await app.keyboard.press("escape");
  await app.waitUntil(() => !app.shows("id:pip-message-menu"));
});

test("a quote reply in a reloaded persona history is restored without exposing the wire tag", async () => {
  const wire = '<pipi-reply target="a:1#b0" author="Pip" side="left">Target answer.</pipi-reply>\n\nrestored reply words';
  const history = JSON.stringify([
    { role: "assistant", content: [{ type: "text", text: "Target answer." }], provider: "test", model: "test", timestamp: 1, stopReason: "stop" },
    { role: "user", content: wire, timestamp: 2 },
    { role: "assistant", content: [{ type: "text", text: "Understood." }], provider: "test", model: "test", timestamp: 3, stopReason: "stop" },
  ]);
  const app = await launch({ "harness.scenario": "history", "harness.history": history });
  await app.press("id:sidebar-pip");
  await app.waitFor("id:pip-quote-preview");
  expect(app.shows("text:restored reply words")).toBe(true);
  expect(app.count("text:pipi-reply")).toBe(0);
  await app.press("id:pip-quote-preview");
  expect(app.shows("text:Target answer.")).toBe(true);
});

test("tapbacks toggle locally and Pip, emoji, and custom image stickers attach and remove without sending anything", async () => {
  const stickerFile = "/tmp/pipi-sticker-source.png";
  const app = await launch({
    "harness.pickedImage": stickerFile,
    "harness.dataDir": "/tmp/pipi-reply-test-data",
    "harness.files": JSON.stringify({ [stickerFile]: "fake png bytes for copy" }),
  });
  await openPipWithReply(app);
  const bubblesBefore = app.count("id:message-bubble");

  await app.rightClick("id:pip-sms-bubble");
  await app.waitFor("id:pip-message-menu");
  await app.press("id:pip-tapback-❤️");
  await app.waitFor("id:pip-message-tapback");
  await app.waitUntil(() => !app.shows("id:pip-message-menu"));

  await app.rightClick("id:pip-sms-bubble");
  await app.waitFor("id:pip-message-menu");
  await app.press("id:pip-tapback-❤️");
  await app.waitUntil(() => !app.shows("id:pip-message-tapback"));

  await app.rightClick("id:pip-sms-bubble");
  await app.waitFor("id:pip-message-menu");
  await app.press("id:pip-menu-stickers");
  await app.waitFor("id:pip-sticker-panel");
  await app.press("id:pip-sticker-mood-happy");
  await app.waitFor("id:pip-message-sticker");
  await app.waitUntil(() => !app.shows("id:pip-message-menu"));
  await app.press("id:pip-message-sticker");
  await app.waitUntil(() => !app.shows("id:pip-message-sticker"));

  await app.rightClick("id:pip-sms-bubble");
  await app.waitFor("id:pip-message-menu");
  await app.press("id:pip-menu-stickers");
  await app.press("id:pip-sticker-emoji-😂");
  await app.waitFor("id:pip-message-sticker");
  await app.waitUntil(() => !app.shows("id:pip-message-menu"));

  await app.rightClick("id:pip-sms-bubble");
  await app.waitFor("id:pip-message-menu");
  await app.press("id:pip-menu-stickers");
  await app.press("id:pip-sticker-add-custom");
  await app.waitUntil(() => app.count("id:pip-message-sticker") >= 2);

  const stored = JSON.parse(app.storage()["pipi.message-interactions.v1"] ?? "{}") as {
    messages?: Record<string, Record<string, { stickers?: unknown[] }>>;
    customStickers?: { path?: string }[];
  };
  expect(Object.keys(stored.messages ?? {}).length).toBeGreaterThan(0);
  expect(stored.customStickers?.[0]?.path?.includes("/stickers/")).toBe(true);
  expect(app.count("id:message-bubble")).toBe(bubblesBefore);

});


test("pure image user messages expose persona actions and focus without an empty text bubble", async () => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const history = JSON.stringify([
    { role: "user", content: [{ type: "image", data: png, mimeType: "image/png" }], timestamp: 1 },
  ]);
  const app = await launch({ "harness.scenario": "history", "harness.history": history });
  await app.press("id:sidebar-pip");
  await app.waitFor("id:message-image");
  expect(app.count("id:pip-message-actions")).toBeGreaterThan(0);

  await app.rightClick("id:message-image");
  await app.waitFor("id:pip-message-menu");
  await app.press("id:pip-tapback-❤️");
  await app.waitFor("id:pip-message-tapback");
  await app.waitUntil(() => !app.shows("id:pip-message-menu"));

  await app.rightClick("id:message-image");
  await app.waitFor("id:pip-message-menu");
  await app.press("id:pip-menu-reply");
  await app.waitFor("id:pip-reply-focus-layer");
  expect(app.shows("id:pip-reply-focus-text-bubble")).toBe(false);
  await app.keyboard.press("escape");
});


test("file-only user messages never quote or focus their attachment wire markup", async () => {
  const attachment = '<attachment path="/tmp/review.png" kind="image" mime="image/png" size="12" />';
  const history = JSON.stringify([{ role: "user", content: attachment, timestamp: 1 }]);
  const app = await launch({ "harness.scenario": "history", "harness.history": history });
  await app.press("id:sidebar-pip");
  await app.waitFor("id:media-file-card");
  expect(app.count("id:pip-message-actions")).toBeGreaterThan(0);

  await app.press("id:pip-message-actions");
  await app.waitFor("id:pip-message-menu");
  await app.press("id:pip-menu-reply");
  await app.waitFor("id:pip-reply-focus-layer");
  expect(app.shows("id:composer-reply-strip")).toBe(true);
  expect(app.count("text:<attachment")).toBe(0);
  expect(app.shows("id:pip-reply-focus-text-bubble")).toBe(false);
  await app.keyboard.press("escape");
});

test("stored tapbacks and stickers are restored when a persona conversation is opened again", async () => {
  const stored = JSON.stringify({
    version: 1,
    messages: {
      "default:s_fake_2": {
        "a:1#b0": {
          tapback: "❤️",
          stickers: [{ id: "restored", kind: "emoji", emoji: "😂", rotation: -3 }],
        },
      },
    },
    customStickers: [],
  });
  const history = JSON.stringify([
    { role: "assistant", content: [{ type: "text", text: "Target answer." }], provider: "test", model: "test", timestamp: 1, stopReason: "stop" },
  ]);
  const app = await launch({ "harness.scenario": "history", "harness.history": history, "pipi.message-interactions.v1": stored });
  await app.press("id:sidebar-pip");
  await app.waitFor("text:Target answer.");
  await app.waitFor("id:pip-message-tapback");
  expect(app.shows("id:pip-message-sticker")).toBe(true);
});

test("clicking a quote preview scrolls the anchored original message back into view", async () => {
  const messages: unknown[] = [
    { role: "assistant", content: [{ type: "text", text: "Original target answer." }], provider: "test", model: "test", timestamp: 1, stopReason: "stop" },
  ];
  for (let i = 0; i < 28; i++) {
    messages.push(
      { role: "user", content: `filler question ${i}`, timestamp: 10 + i * 3 },
      { role: "assistant", content: [{ type: "text", text: `filler answer ${i}\n\n${"Enough words to fill the conversation. ".repeat(4)}` }], provider: "test", model: "test", timestamp: 11 + i * 3, stopReason: "stop" },
    );
  }
  messages.push({
    role: "user",
    content: '<pipi-reply target="a:1#b0" author="Pip" side="left">Original target answer.</pipi-reply>\n\nback to the first answer',
    timestamp: 200,
  });
  const app = await launch({ "harness.scenario": "history", "harness.history": JSON.stringify(messages) });
  await app.press("id:sidebar-pip");
  await app.waitFor("id:pip-quote-preview");
  const before = app.layout("text:Original target answer.");
  expect(before).toBeTruthy();
  await app.press("id:pip-quote-preview");
  await app.waitUntil(() => {
    const after = app.layout("text:Original target answer.");
    return Boolean(after && before && after.y < before.y - 160);
  });
});

test("ordinary coding sessions keep their native menu and no persona interaction chrome", async () => {
  const app = await launch();
  await app.waitFor("text:What are we building?");
  await app.type("label:Message", "plain coding message");
  await app.submit("label:Message");
  await app.waitFor("text:plain coding message");
  await app.rightClick("id:message-bubble");
  expect(app.shows("id:pip-message-menu")).toBe(false);
  expect(app.shows("id:composer-reply-strip")).toBe(false);
});
