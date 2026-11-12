import { expect, open, test } from "nsh/test";

const launch = () =>
  open("./Harness.tsx", { width: 1180, height: 780, platform: "macos", locale: "en-US", storage: { "harness.scenario": "welcome" } });

const storedWidth = (app: { storage(): Record<string, string> }) => {
  const prefs = app.storage()["pipi.prefs.v1"];
  return prefs ? (JSON.parse(prefs) as { sidebarWidth?: number }).sidebarWidth : undefined;
};

test("dragging the sidebar sash resizes the sidebar", async () => {
  const app = await launch();
  await app.waitFor("text:What are we building?");
  expect(app.count("label:Sidebar width")).toBe(1);
  await app.drag("label:Sidebar width", { x: 60 });
  await app.waitUntil(() => storedWidth(app) !== 264);
  expect(storedWidth(app)).toBe(324);
});

test("dragging the sash left past the fold collapses the sidebar", async () => {
  const app = await launch();
  await app.waitFor("text:What are we building?");
  await app.drag("label:Sidebar width", { x: -300 });
  await app.waitUntil(() => app.count("label:Show sidebar") > 0);
});
