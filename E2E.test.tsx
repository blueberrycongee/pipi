// End-to-end runs against the real Pi sidecar, on a real platform:
//
//   node dev/mock-llm.mjs &
//   PI_CODING_AGENT_DIR=$PWD/dev/agent nsh test E2E.test.tsx --target macos
//
// Each test opens the app in a window of its own and saves screenshots under
// .nsh/shots/. Headless runs have no processes, so these tests skip there.
import { expect, open, test } from "nsh/test";

const shot = (name: string) => `.nsh/shots/${name}.png`;

async function launch(colorScheme: "dark" | "light" = "dark") {
  const app = await open("./App.tsx", { width: 1180, height: 780, locale: "en-US", colorScheme });
  await app.wait(2500);
  if (app.texts().some((text) => text.includes("desktops only"))) return undefined;
  return app;
}

test("welcome, then a run with tools", async () => {
  const app = await launch();
  if (!app) return;
  await app.waitFor("text:What are we building?", { timeout: 15000 });
  await app.screenshot(shot("01-welcome"));
  await app.type("label:Message", "look around with tools");
  await app.screenshot(shot("02-typed"));
  await app.submit("label:Message");
  await app.wait(1200);
  await app.screenshot(shot("03-streaming"));
  await app.waitFor("text:Summary", { timeout: 20000 });
  await app.wait(1500);
  await app.screenshot(shot("04-done"));
  expect(app.texts().join("\n")).toContain("Summary");
}, 60000);
