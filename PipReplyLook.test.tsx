import { expect, open, test } from "nsh/test";

// Personal Agent's macOS Messages-style reply and bubble interactions.
//
//   nsh test PipReplyLook.test.tsx --target macos

for (const colorScheme of ["light", "dark"] as const) {
  test(`quote reply focus, Liquid Glass menu, tapbacks and stickers ${colorScheme}`, async () => {
    const app = await open("./Harness.tsx", {
      width: 1180,
      height: 780,
      platform: "macos",
      locale: "en-US",
      colorScheme,
      clock: {},
      storage: { "harness.scenario": "stream", "harness.reply": "Target answer." },
    });
    await app.press("id:sidebar-pip");
    await app.waitFor("text:Hey, what's up?");
    await app.type("label:Message", "first question");
    await app.submit("label:Message");
    await app.waitFor("text:Target answer.");
    await app.waitUntil(() => !app.shows("id:pip-typing-bubble"));
    await app.wait(250);

    await app.press("id:pip-sms-bubble >> id:pip-message-actions");
    await app.waitFor("id:pip-message-menu");
    await app.wait(180);
    await app.screenshot(`.nsh/shots/pip-message-menu-${colorScheme}.png`);

    await app.press("id:pip-tapback-❤️");
    await app.waitFor("id:pip-message-tapback");
    await app.waitUntil(() => !app.shows("id:pip-message-menu"));
    await app.press("id:pip-sms-bubble >> id:pip-message-actions");
    await app.waitFor("id:pip-message-menu");
    await app.press("id:pip-menu-stickers");
    await app.waitFor("id:pip-sticker-panel");
    await app.wait(160);
    await app.screenshot(`.nsh/shots/pip-sticker-panel-${colorScheme}.png`);
    await app.press("id:pip-sticker-mood-happy");
    await app.waitFor("id:pip-message-sticker");
    await app.waitUntil(() => !app.shows("id:pip-message-menu"));

    await app.press("id:pip-sms-bubble >> id:pip-message-actions");
    await app.waitFor("id:pip-message-menu");
    await app.press("id:pip-menu-reply");
    await app.waitFor("id:pip-reply-focus-layer");
    await app.wait(480);
    await app.screenshot(`.nsh/shots/pip-reply-focus-${colorScheme}.png`);
    expect(app.shows("id:composer-reply-strip")).toBe(true);

    await app.type("label:Message", "plain answer back");
    await app.submit("label:Message");
    await app.waitFor("id:pip-quote-preview");
    await app.waitUntil(() => !app.shows("id:pip-typing-bubble"));
    expect(app.count("text:pipi-reply")).toBe(0);

    await app.screenshot(`.nsh/shots/pip-reply-thread-${colorScheme}.png`);
  }, 60000);

  test(`a tapback keeps its corner room in a consecutive bubble cluster ${colorScheme}`, async () => {
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
    const app = await open("./Harness.tsx", {
      width: 1180,
      height: 780,
      platform: "macos",
      locale: "en-US",
      colorScheme,
      clock: {},
      storage: {
        "harness.scenario": "history",
        "harness.history": history,
      },
    });
    await app.press("id:sidebar-pip");
    await app.waitFor("text:Third bubble.");
    await app.press("id:pip-message-actions >> nth=1");
    await app.waitFor("id:pip-message-menu");
    await app.press("id:pip-tapback-❤️");
    await app.waitFor("id:pip-message-tapback");
    await app.waitUntil(() => !app.shows("id:pip-message-menu"));
    await app.wait(250);
    expect(app.count("id:pip-sms-bubble")).toBe(3);
    await app.screenshot(`.nsh/shots/pip-tapback-cluster-${colorScheme}.png`);
  }, 60000);
}
