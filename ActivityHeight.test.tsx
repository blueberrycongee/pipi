import { expect, open, test } from "nsh/test";

// Use real history and the conversation List: its activity must remain one bounded
// row even when a command opens, without hiding the last step behind a clip.
for (const count of [2, 109]) {
  test(`${count} grouped calls take only the room they need, up to half the reading area`, async () => {
    const calls = Array.from({ length: count }, (_, i) => ({
      type: "toolCall", name: "bash", id: `c${i}`, arguments: { command: `echo step-${i}` },
    }));
    const assistant = { role: "assistant", provider: "test", model: "test", timestamp: 2 };
    const history = [
      { role: "user", content: "Check the steps", timestamp: 1 },
      { ...assistant, content: calls, stopReason: "toolUse" },
      ...calls.map(({ id }, i) => ({ role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text: count > 2 && i === count - 1 ? Array(405).fill("output").join("\n") : `result-${i}` }], isError: false, timestamp: 3 })),
      { ...assistant, content: [{ type: "text", text: "Steps checked." }], stopReason: "stop", timestamp: 4 },
    ];
    const app = await open("./Harness.tsx", {
      width: 1100, height: 780, locale: "en-US", platform: "macos", clock: {},
      storage: { "harness.scenario": "history", "harness.history": JSON.stringify(history) },
    });
    await app.waitFor("text:Steps checked.");
    await app.wait(600);
    await app.press("text:Finished in under 1 second");
    await app.wait(600);
    const summary = `text:Ran ${count} commands`;
    await app.press(summary);
    await app.wait(500);
    const body = "id:activity-details";
    const box = app.layout(body)!;
    expect(box.height).toBeGreaterThan(48);
    if (count === 2) expect(box.height).toBeLessThan(80);
    else {
      const readableHeight = app.layout("id:composer-docked")!.y - app.layout("label:Conversation")!.y - 44;
      expect(box.height).toBeGreaterThan(Math.min(320, readableHeight / 2) - 4);
      expect(box.height).toBeLessThanOrEqual(Math.min(320, readableHeight / 2));
    }
    const summaryY = app.layout(summary)!.y;
    const lastCall = `text:echo step-${count - 1}`;
    if (count > 2) {
      await app.scroll(body, 6000);
      await app.wait(300);
    }
    await app.press(lastCall);
    await app.wait(500);
    if (count > 2) {
      await app.scroll(body, 16000);
      await app.wait(300);
      await app.waitFor("text:5 more lines not shown");
      expect(app.layout(body)!.height).toBe(box.height);
    } else await app.waitFor(`text:result-${count - 1}`);
    expect(app.layout(summary)!.y).toBe(summaryY);
    await app.press(summary);
    await app.wait(500);
    expect(app.count(body)).toBe(0);
  });
}
