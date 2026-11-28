import { expect, open, test } from "nsh/test";

// Personal Agent quote-reply, tapback and sticker interactions.
//
//   nsh test PipReply.test.tsx

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

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

const near = (a: number, b: number) => Math.abs(a - b) <= 0.51;

/** The actions seat must touch the bubble and reach through the visible button: no unhovered gap. */
const expectContinuousActionStrip = (app: Awaited<ReturnType<typeof launch>>, bubbleSelector: string, side: "left" | "right") => {
  const bubble = app.layout(bubbleSelector)!;
  const bridge = app.layout(`${bubbleSelector} >> id:pip-message-actions-bridge`)!;
  const action = app.layout(`${bubbleSelector} >> id:pip-message-actions`)!;
  expect(bridge).toBeTruthy();
  expect(action).toBeTruthy();
  expect(bridge.width).toBe(32);
  expect(near(bridge.y, bubble.y)).toBe(true);
  expect(near(bridge.height, bubble.height)).toBe(true);
  if (side === "left") {
    expect(near(bridge.x, bubble.x + bubble.width)).toBe(true);
    expect(near(action.x, bubble.x + bubble.width + 8)).toBe(true);
    expect(near(action.x + action.width, bridge.x + bridge.width)).toBe(true);
  } else {
    expect(near(bridge.x + bridge.width, bubble.x)).toBe(true);
    expect(near(action.x + action.width, bubble.x - 8)).toBe(true);
    expect(near(action.x, bridge.x)).toBe(true);
  }
  expect(near(action.y + action.height / 2, bubble.y + bubble.height / 2)).toBe(true);
};

const expectMediaActionStrip = (app: Awaited<ReturnType<typeof launch>>, mediaSelector: string) => {
  const media = app.layout(mediaSelector)!;
  const bridge = app.layout("id:pip-message-actions-bridge")!;
  const action = app.layout("id:pip-message-actions")!;
  expect(bridge.width).toBe(32);
  expect(near(bridge.x + bridge.width, media.x)).toBe(true);
  expect(near(action.x, bridge.x)).toBe(true);
  expect(near(action.x + action.width, media.x - 8)).toBe(true);
  expect(near(action.y + action.height / 2, bridge.y + bridge.height / 2)).toBe(true);
};

const reactAndExpectRoom = async (app: Awaited<ReturnType<typeof launch>>, first: string, second: string) => {
  const before = app.layout(second);
  expect(before).toBeTruthy();
  await app.rightClick(second);
  await app.waitFor("id:pip-message-menu");
  await app.press("id:pip-tapback-❤️");
  await app.waitFor("id:pip-message-tapback");
  await app.waitUntil(() => {
    const box = app.layout(second);
    return Boolean(before && box && box.y - before.y > 8);
  });
  const firstBox = app.layout(first)!;
  const tapback = app.layout("id:pip-message-tapback")!;
  expect(tapback.y).toBeGreaterThanOrEqual(firstBox.y + firstBox.height);
  return before!;
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

test("hover message actions form a continuous strip beside incoming and outgoing bubbles", async () => {
  const app = await launch();
  await openPipWithReply(app);

  expectContinuousActionStrip(app, "id:pip-sms-bubble", "left");
  expectContinuousActionStrip(app, "id:message-bubble", "right");

  await app.hover("id:pip-sms-bubble");
  expect(app.viewStyle("id:pip-sms-bubble >> id:pip-message-actions")?.effectiveOpacity).toBe(1);
  await app.hover("id:pip-sms-bubble >> id:pip-message-actions");
  expect(app.viewStyle("id:pip-sms-bubble >> id:pip-message-actions")?.effectiveOpacity).toBe(1);
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
  const png = PNG_1X1;
  const history = JSON.stringify([
    { role: "user", content: [{ type: "image", data: png, mimeType: "image/png" }], timestamp: 1 },
  ]);
  const app = await launch({ "harness.scenario": "history", "harness.history": history });
  await app.press("id:sidebar-pip");
  await app.waitFor("id:message-image");
  expect(app.count("id:pip-message-actions")).toBeGreaterThan(0);
  expectMediaActionStrip(app, "id:message-image");

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
  expectMediaActionStrip(app, "id:media-file-card");

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

test("a tapback opening on a clustered bubble makes enough vertical room and removing it restores the cluster", async () => {
  const history = JSON.stringify([
    {
      role: "assistant",
      content: [{ type: "text", text: "First bubble.\n\nSecond bubble.\n\nThird bubble." }],
      provider: "test",
      model: "test",
      timestamp: 1,
      stopReason: "stop",
    },
  ]);
  const app = await launch({ "harness.scenario": "history", "harness.history": history });
  await app.press("id:sidebar-pip");
  await app.waitFor("text:Third bubble.");
  const first = "id:pip-sms-bubble >> nth=0";
  const second = "id:pip-sms-bubble >> nth=1";
  const before = await reactAndExpectRoom(app, first, second);

  await app.rightClick(second);
  await app.waitFor("id:pip-message-menu");
  await app.press("id:pip-tapback-❤️");
  await app.waitUntil(() => !app.shows("id:pip-message-tapback"));
  await app.waitUntil(() => {
    const box = app.layout(second);
    return Boolean(before && box && Math.abs(box.y - before.y) < 1);
  });
});

test("a tapback opening on a consecutive outgoing bubble makes enough vertical room", async () => {
  const history = JSON.stringify([
    { role: "user", content: "First outgoing.", timestamp: 1 },
    { role: "user", content: "Second outgoing.", timestamp: 2 },
  ]);
  const app = await launch({ "harness.scenario": "history", "harness.history": history });
  await app.press("id:sidebar-pip");
  await app.waitFor("text:Second outgoing.");
  const second = "id:message-bubble >> nth=1";
  await reactAndExpectRoom(app, "id:message-bubble >> nth=0", second);
});

test("a tapback opening on a consecutive media bubble makes enough vertical room", async () => {
  const png = PNG_1X1;
  const image = (alt: string) => `![${alt}](data:image/png;base64,${png})`;
  const history = JSON.stringify([
    {
      role: "assistant",
      content: [{ type: "text", text: `${image("one")}\n\n${image("two")}` }],
      provider: "test",
      model: "test",
      timestamp: 1,
      stopReason: "stop",
    },
  ]);
  const app = await launch({ "harness.scenario": "history", "harness.history": history });
  await app.press("id:sidebar-pip");
  await app.waitUntil(() => app.count("id:pip-sms-bubble") >= 2);
  const first = "id:pip-sms-bubble >> nth=0";
  const second = "id:pip-sms-bubble >> nth=1";
  await reactAndExpectRoom(app, first, second);
});

test("a tapback opening on a consecutive outgoing media bubble makes enough vertical room", async () => {
  const image = { type: "image", data: PNG_1X1, mimeType: "image/png" };
  const history = JSON.stringify([
    { role: "user", content: [image], timestamp: 1 },
    { role: "user", content: [image], timestamp: 2 },
  ]);
  const app = await launch({ "harness.scenario": "history", "harness.history": history });
  await app.press("id:sidebar-pip");
  await app.waitUntil(() => app.count("id:message-image") >= 2);
  const first = "id:message-image >> nth=0";
  const second = "id:message-image >> nth=1";
  await reactAndExpectRoom(app, first, second);
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

test("focus veils the original, coincides with it exactly, and restores it on exit", async () => {
  const app = await launch();
  await openPipWithReply(app);
  expect(app.count("id:pip-sms-bubble")).toBe(1);
  const before = app.layout("id:pip-sms-bubble")!;
  expect(before.hidden).toBe(false);

  await app.rightClick("id:pip-sms-bubble");
  await app.waitFor("id:pip-message-menu");
  await app.press("id:pip-menu-reply");
  await app.waitFor("id:pip-reply-focus-layer");

  // One object: the transcript original is veiled while its replica carries the focus —
  // the bubble's test id leaves the tree entirely, and the replica sits exactly where it sat.
  expect(app.count("id:pip-sms-bubble")).toBe(0);
  const copy = app.layout("id:pip-reply-focus-bubble")!;
  expect(copy).toBeTruthy();
  expect(Math.abs(copy.x - before.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(copy.y - before.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(copy.width - before.width)).toBeLessThanOrEqual(1);
  expect(app.shows("id:pip-reply-focus-text-bubble")).toBe(true);

  await app.keyboard.press("escape");
  await app.waitUntil(() => !app.shows("id:pip-reply-focus-layer"));
  expect(app.count("id:pip-sms-bubble")).toBe(1);
  const restored = app.layout("id:pip-sms-bubble")!;
  expect(Math.abs(restored.y - before.y)).toBeLessThanOrEqual(1);
});

test("the focus replica tracks the conversation when it scrolls", async () => {
  const messages: unknown[] = [
    { role: "assistant", content: [{ type: "text", text: "The very first answer." }], provider: "test", model: "test", timestamp: 1, stopReason: "stop" },
  ];
  for (let i = 0; i < 20; i++) {
    messages.push(
      { role: "user", content: `filler question ${i}`, timestamp: 10 + i * 3 },
      { role: "assistant", content: [{ type: "text", text: `filler answer ${i}\n\n${"Enough words to fill the conversation. ".repeat(4)}` }], provider: "test", model: "test", timestamp: 11 + i * 3, stopReason: "stop" },
    );
  }
  const app = await launch({ "harness.scenario": "history", "harness.history": JSON.stringify(messages) });
  await app.press("id:sidebar-pip");
  await app.waitFor("text:filler answer 19");
  const count = app.count("id:pip-sms-bubble");
  expect(count).toBeGreaterThan(10);
  const target = `id:pip-sms-bubble >> nth=${count - 1}`;

  await app.rightClick(target);
  await app.waitFor("id:pip-message-menu");
  await app.press("id:pip-menu-reply");
  await app.waitFor("id:pip-reply-focus-layer");
  expect(app.count("id:pip-sms-bubble")).toBe(count - 1);

  // The replica moves with the scrolled conversation by the same delta as a sibling row.
  const copyBefore = app.layout("id:pip-reply-focus-bubble")!;
  const refBefore = (app.layout("text:filler answer 15") ?? app.layout("text:filler question 15"))!;
  expect(refBefore).toBeTruthy();
  await app.scroll("label:Conversation", -160);
  await app.waitUntil(() => {
    const moved = app.layout("text:filler answer 15") ?? app.layout("text:filler question 15");
    return Boolean(moved && refBefore && Math.abs(moved.y - refBefore.y) > 40);
  });
  const copyAfter = app.layout("id:pip-reply-focus-bubble")!;
  const refAfter = (app.layout("text:filler answer 15") ?? app.layout("text:filler question 15"))!;
  const copyDelta = copyAfter.y - copyBefore.y;
  const refDelta = refAfter.y - refBefore.y;
  expect(Math.abs(copyDelta)).toBeGreaterThan(40);
  expect(Math.abs(copyDelta - refDelta)).toBeLessThanOrEqual(2);

  const veiledCount = app.count("id:pip-sms-bubble");
  await app.keyboard.press("escape");
  await app.waitUntil(() => !app.shows("id:pip-reply-focus-layer"));
  expect(app.count("id:pip-sms-bubble")).toBe(veiledCount + 1);
});

test("reduced motion focuses and restores instantly with the same continuity state", async () => {
  const app = await open("./Harness.tsx", {
    width: 1180,
    height: 1100,
    platform: "macos",
    locale: "en-US",
    clock: {},
    reducedMotion: true,
    storage: { "harness.scenario": "stream", "harness.reply": "Target answer." },
  });
  await openPipWithReply(app);
  await app.rightClick("id:pip-sms-bubble");
  await app.waitFor("id:pip-message-menu");
  await app.press("id:pip-menu-reply");
  await app.waitFor("id:pip-reply-focus-layer");
  expect(app.count("id:pip-sms-bubble")).toBe(0);
  expect(app.shows("id:composer-reply-strip")).toBe(true);
  await app.keyboard.press("escape");
  await app.waitUntil(() => !app.shows("id:pip-reply-focus-layer"));
  expect(app.count("id:pip-sms-bubble")).toBe(1);
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
