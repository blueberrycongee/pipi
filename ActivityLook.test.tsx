import { open, test } from "nsh/test";

type Scheme = "dark" | "light";

const history = () => {
  const calls = Array.from({ length: 80 }, (_, i) => ({
    type: "toolCall", name: "bash", id: `c${i}`, arguments: { command: `echo step-${i}` },
  }));
  const assistant = { role: "assistant", provider: "test", model: "test", timestamp: 2 };
  return [
    { role: "user", content: "Check the steps", timestamp: 1 },
    { ...assistant, content: calls, stopReason: "toolUse" },
    ...calls.map(({ id }, i) => ({ role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text: `result-${i}` }], isError: false, timestamp: 3 })),
    { ...assistant, content: [{ type: "text", text: "Steps checked." }], stopReason: "stop", timestamp: 4 },
  ];
};

test("activity details fade only toward hidden content", async () => {
  for (const scheme of ["dark", "light"] as Scheme[]) {
    const app = await open("./Harness.tsx", {
      width: 1100, height: 780, locale: "en-US", platform: "macos", colorScheme: scheme, clock: {},
      storage: { "harness.scenario": "history", "harness.history": JSON.stringify(history()) },
    });
    await app.waitFor("text:Steps checked.");
    await app.wait(600);
    await app.press("text:Finished in under 1 second");
    await app.wait(600);
    await app.press("text:Ran 80 commands");
    await app.wait(500);
    const body = "id:activity-details";
    await app.screenshot(`.nsh/shots/activity-fade-start-${scheme}.png`);
    await app.scroll(body, 900);
    await app.wait(300);
    await app.screenshot(`.nsh/shots/activity-fade-middle-${scheme}.png`);
    await app.scroll(body, 16000);
    await app.wait(300);
    await app.screenshot(`.nsh/shots/activity-fade-end-${scheme}.png`);
  }
}, 120000);
