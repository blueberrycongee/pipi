import { open, test } from "nsh/test";

const OUT = ".nsh/shots";

test("stacked toasts over the transcript — no rows ghost through", async () => {
  const app = await open("./Harness.tsx", {
    width: 1180,
    height: 780,
    platform: "macos",
    locale: "en-US",
    storage: { "harness.scenario": "stream" },
  });
  await app.waitFor("text:What are we building?");

  // Open a session and start a run that keeps going (long reply × 150ms pace).
  await app.press("text:Refactor the transcript reducer >> nth=0");
  await app.type("label:Message", "long");
  await app.submit("label:Message");
  await app.waitFor("text:Steps", { timeout: 4000 }).catch(() => undefined);

  // Toast 1: archiving a running conversation raises the warning toast.
  await app.keyboard.press("mod+k");
  await app.waitFor("text:Archive Session", { timeout: 3000 });
  await app.press("text:Archive Session");
  await app.waitFor("text:Archive anyway", { timeout: 3000 });

  // Toast 2 while toast 1 is settled: the stack sits over scrolled rows.
  await app.keyboard.press("mod+u");
  await app.waitFor("text:Set a wallpaper folder in Settings → General first.", { timeout: 3000 });
  await new Promise((resolve) => setTimeout(resolve, 800));
  await app.screenshot(`${OUT}/toast-stack.png`);
});
