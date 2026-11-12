import { expect, open, test } from "nsh/test";

// An agent process that goes away is the app's to put back (`routeExit` in
// `store/app.ts`), on any engine: the session stays on screen and its agent
// starts again under it. The dead-agent screen is for one that will not stay up.
//
//   nsh test Recover.test.tsx

const launch = (scenario: string, storage: Record<string, string> = {}) =>
  open("./Harness.tsx", { width: 1180, height: 780, platform: "macos", locale: "en-US", storage: { "harness.scenario": scenario, ...storage } });

const GONE = "Pi stopped unexpectedly";
const CUT = "Pi stopped mid-run and was restarted. The run was cut short.";

test("coming back to a run that finished off screen keeps its agent, however many runs are parked", async () => {
  const app = await launch("stream");
  await app.waitFor("text:What are we building?");

  // Three runs go off screen, each waiting on an approval: they do not finish.
  for (const name of ["two", "three", "four"]) {
    await app.type("label:Message", `confirm ${name}`);
    await app.submit("label:Message");
    await app.waitFor("text:Allow shell command?", { timeout: 10000 });
    await app.press("id:sidebar-new-session");
    await app.waitFor("text:What are we building?");
  }
  // A fourth ends off screen and stays parked: its reply is waiting there.
  await app.type("label:Message", "make a plan");
  await app.submit("label:Message");
  await app.waitFor("text:make a plan");
  await app.press("id:sidebar-new-session");
  await app.waitFor("text:What are we building?");
  await app.waitFor("text:make a plan finished in the background.", { timeout: 30000 });
  await app.type("label:Message", "confirm five");
  await app.submit("label:Message");
  await app.waitFor("text:Allow shell command?", { timeout: 10000 });

  // Coming back parks the fifth run. Making room for it must not let go of the run being opened.
  await app.press("id:sidebar-workspaces >> text:make a plan");
  await app.waitFor("text:Here is the plan.");
  let said = false;
  for (let waited = 0; waited < 1500; waited += 100) {
    await app.wait(100);
    if (app.texts().some((text) => text.includes("stopped"))) said = true;
  }
  expect(said).toBe(false);
  expect(app.texts()).toContain("Here is the plan.");

  // The same agent answers on: the session it holds still has its first run.
  await app.type("label:Message", "one more plan");
  await app.submit("label:Message");
  await app.waitFor("text:one more plan");
  await app.waitFor("label:Send", { timeout: 20000 });
  expect(app.texts().filter((text) => text.startsWith("Finished in"))).toHaveLength(2);
}, 120000);

test("an agent lost at rest comes back under its session, with nothing said", async () => {
  const app = await launch("history", { "harness.dies": "600" });
  await app.waitFor("text:Here is the plan.");
  await app.type("label:Message", "half a thought");

  // The process goes away while the reader is mid-sentence. The conversation and the draft stay.
  let said = false;
  for (let waited = 0; waited < 2000; waited += 100) {
    await app.wait(100);
    const texts = app.texts();
    if (texts.includes(GONE) || texts.includes("Restart Pi")) said = true;
    expect(texts).toContain("Here is the plan.");
  }
  expect(said).toBe(false);

  // The session has an agent again: the message goes out and is answered.
  await app.submit("label:Message");
  await app.waitFor("text:half a thought");
  await app.waitFor("label:Send", { timeout: 10000 });
  expect(app.texts()).not.toContain(GONE);
});

test("an agent lost at rest on a fresh session leaves the welcome and the draft in place", async () => {
  const app = await launch("welcome", { "harness.dies": "600" });
  await app.waitFor("text:What are we building?");
  await app.type("label:Message", "make a plan");
  await app.wait(1500);
  expect(app.texts()).not.toContain(GONE);
  expect(app.texts()).toContain("What are we building?");

  await app.submit("label:Message");
  await app.waitFor("text:Steps");
  await app.waitFor("label:Send", { timeout: 10000 });
});

test("an agent that dies under a run is started again, and the reader is told the run was cut short", async () => {
  const app = await launch("history");
  await app.waitFor("text:Here is the plan.");
  await app.type("label:Message", "crash the plan");
  await app.submit("label:Message");

  await app.waitFor(`text:${CUT}`);
  expect(app.texts()).not.toContain("Restart Pi");
  expect(app.texts()).not.toContain(GONE);
  // Its session is open again on what it has on file — the message included — and takes the next one.
  expect(app.texts()).toContain("Here is the plan.");
  expect(app.texts()).toContain("crash the plan");
  await app.waitFor("label:Send");
  expect(app.count("label:Stop")).toBe(0);
  await app.type("label:Message", "make a plan");
  await app.submit("label:Message");
  await app.waitFor("text:make a plan");
  await app.waitFor("label:Send", { timeout: 10000 });
  expect(app.texts()).toContain("crash the plan");
});

test("a first run cut short is found again by the file its session got as the run started", async () => {
  const app = await launch("welcome");
  await app.waitFor("text:What are we building?");
  await app.type("label:Message", "crash the plan");
  await app.submit("label:Message");

  await app.waitFor(`text:${CUT}`);
  // The sidebar lists the session twice (its folder, and Recent); the third is the message in the conversation.
  await app.waitUntil(() => app.texts().filter((text) => text === "crash the plan").length >= 3);
  expect(app.texts()).not.toContain("What are we building?");
  expect(app.texts()).not.toContain("Restart Pi");
});

test("an agent that will not stay up is not started for ever: the screen says so and offers a restart", async () => {
  const app = await launch("history", { "harness.dies": "300x20" });
  await app.waitFor(`text:${GONE}`, { timeout: 10000 });
  expect(app.texts()).toContain("Restart Pi");
  // It is left there: nothing starts it again behind the reader's back.
  await app.wait(1500);
  expect(app.texts()).toContain("Restart Pi");
});

test("an agent that cannot be started again says why, and offers a restart", async () => {
  const app = await launch("history", { "harness.dies": "400", "harness.starts": "1" });
  await app.waitFor(`text:${GONE}`, { timeout: 10000 });
  expect(app.texts()).toContain("spawn node ENOENT");
  expect(app.texts()).toContain("Restart Pi");
});
