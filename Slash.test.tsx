// The composer's slash menu, as a user meets it: `/` lists what can be run
// here, Enter runs the marked command, Tab fills it in for arguments, Escape
// closes the menu. pipi is a shell over many engines: its own commands are the
// same on each, an engine's own are listed under its name, and a name the
// shell owns is the shell's whatever the engine calls its own.
//
//   nsh test Slash.test.tsx
import { expect, open, test } from "nsh/test";

const launch = (scenario = "welcome", locale = "en-US") =>
  open("./Harness.tsx", { width: 1180, height: 780, platform: "macos", locale, storage: { "harness.scenario": scenario } });
type App = Awaited<ReturnType<typeof launch>>;

const MESSAGE = "label:Message";
const MENU = "label:Commands";
const draft = (app: App) => app.value(MESSAGE) ?? "";
/** The commands the menu lists, in order. */
const listed = (app: App) => app.texts().filter((text) => /^\/\S+$/.test(text));
const closed = (app: App) => app.waitUntil(() => app.count(MENU) === 0);

test("a slash lists pipi's own commands, then the agent's, and none of the plumbing", async () => {
  const app = await launch();
  await app.waitFor("text:What are we building?");
  await app.type(MESSAGE, "/");
  await app.waitFor(MENU);
  expect(listed(app)).toEqual(["/new", "/compact", "/model", "/name", "/copy", "/export", "/delegate", "/parallel", "/settings", "/fix-tests", "/skill:review"]);
  // Each says whose it is, and what it takes.
  expect(app.texts()).toContain("pipi");
  expect(app.texts()).toContain("Prompt");
  expect(app.texts()).toContain("Skill");
  expect(app.texts()).toContain("<agent> <task>");
  // The command pipi's Pi extension registers for itself is not the user's to run.
  expect(app.texts()).not.toContain("/pipi-runtime-mode");

  // Typing narrows it; a path is not a command.
  await app.type(MESSAGE, "fix");
  expect(listed(app)).toEqual(["/fix-tests"]);
  await app.clear(MESSAGE);
  await app.type(MESSAGE, "/Users/pip/notes.txt");
  await closed(app);
});

test("Enter runs the marked command; Tab fills it in for its arguments", async () => {
  const app = await launch();
  await app.waitFor("text:What are we building?");

  await app.type(MESSAGE, "/fix");
  await app.waitFor(MENU);
  await app.keyboard.press("tab");
  expect(draft(app)).toBe("/fix-tests ");
  await closed(app);

  // One Enter sends an agent's command: no second press on a line that was already complete.
  await app.clear(MESSAGE);
  await app.type(MESSAGE, "/fix");
  await app.waitFor(MENU);
  await app.submit(MESSAGE);
  await app.waitUntil(() => draft(app) === "");
  await closed(app);
  await app.waitFor("text:/fix-tests");
});

test("pipi's commands run in the app and are never sent to the agent", async () => {
  const app = await launch("history");
  await app.waitFor("text:Here is the plan.");

  await app.type(MESSAGE, "/settings");
  await app.submit(MESSAGE);
  await app.waitFor("id:settings-nav-agents");
  expect(draft(app)).toBe("");
  await app.press("label:Settings");
  await app.waitUntil(() => app.count("id:settings-nav-agents") === 0);

  await app.type(MESSAGE, "/model");
  await app.submit(MESSAGE);
  await app.waitFor("text:Search models");
  await app.keyboard.press("escape");
  await app.waitUntil(() => app.count("text:Search models") === 0);

  // Arguments follow a Tab; what a command takes is used, not sent as a message.
  await app.type(MESSAGE, "/name");
  await app.keyboard.press("tab");
  await app.type(MESSAGE, "Release plan");
  await app.submit(MESSAGE);
  await app.waitFor("text:Release plan");
  expect(draft(app)).toBe("");

  // A name from another tool finds the command that does it here.
  await app.type(MESSAGE, "/clear");
  await app.waitFor(MENU);
  expect(listed(app)).toEqual(["/new"]);
  await app.submit(MESSAGE);
  await app.waitFor("text:What are we building?");
  expect(app.texts()).not.toContain("/clear");
  expect(app.texts()).not.toContain("/settings");
});

test("Escape closes the menu and leaves the draft; it stays closed until a new slash", async () => {
  const app = await launch();
  await app.waitFor("text:What are we building?");
  await app.type(MESSAGE, "/fi");
  await app.waitFor(MENU);
  await app.keyboard.press("escape");
  await closed(app);
  expect(draft(app)).toBe("/fi");
  await app.type(MESSAGE, "x");
  expect(app.count(MENU)).toBe(0);
  await app.clear(MESSAGE);
  await app.type(MESSAGE, "/");
  await app.waitFor(MENU);
});

test("during a run, Escape closes the menu and the run goes on", async () => {
  const app = await launch("slow");
  await app.waitFor("text:What are we building?");
  await app.type(MESSAGE, "make a plan");
  await app.submit(MESSAGE);
  await app.waitFor("label:Stop");
  await app.type(MESSAGE, "/");
  await app.waitFor(MENU);
  await app.keyboard.press("escape");
  await closed(app);
  // The key was the menu's, not the run's: with the draft cleared, Stop is still there to press.
  await app.clear(MESSAGE);
  await app.waitFor("label:Stop");
});

test("the arrow keys go around the whole list, and the pointer moves the same mark", async () => {
  const app = await launch();
  await app.waitFor("text:What are we building?");
  await app.type(MESSAGE, "/");
  await app.waitFor(MENU);
  // Up from the first row is the last one, past what the menu shows at once.
  await app.keyboard.press("up");
  await app.keyboard.press("tab");
  expect(draft(app)).toBe("/skill:review ");

  await app.clear(MESSAGE);
  await app.type(MESSAGE, "/");
  await app.waitFor(MENU);
  await app.keyboard.press("down");
  await app.keyboard.press("down");
  await app.keyboard.press("tab");
  expect(draft(app)).toBe("/model ");

  await app.clear(MESSAGE);
  await app.type(MESSAGE, "/");
  await app.waitFor(MENU);
  await app.hover("text:/copy");
  await app.keyboard.press("tab");
  expect(draft(app)).toBe("/copy ");
});

test("/delegate waits for its arguments and offers the agents it can name", async () => {
  const app = await launch();
  await app.waitFor("text:What are we building?");
  await app.type(MESSAGE, "/del");
  await app.waitFor(MENU);
  // Its name alone does nothing: Enter fills it in rather than sending it.
  await app.submit(MESSAGE);
  expect(draft(app)).toBe("/delegate ");
  await app.waitFor("text:Claude Code");
  expect(app.texts()).toContain("codex");
  await app.type(MESSAGE, "cl");
  await app.submit(MESSAGE);
  expect(draft(app)).toBe("/delegate claude ");
  await closed(app);
});

test("the slash key under a Chinese input method opens the menu, and Chinese finds the command", async () => {
  const app = await launch("welcome", "zh-CN");
  await app.waitFor("text:今天要构建什么？");
  await app.type("label:消息", "、");
  await app.waitFor("label:命令");
  expect(app.texts()).toContain("新建会话");
  expect(app.texts()).toContain("<智能体> <任务>");
  await app.type("label:消息", "压缩");
  expect(listed(app)).toEqual(["/compact"]);
  await app.keyboard.press("tab");
  expect(app.value("label:消息")).toBe("/compact ");
});

test("another agent lists its own commands, and only what pipi can do on it", async () => {
  const app = await launch();
  await app.waitFor("text:What are we building?");
  await app.press("id:agent-chip");
  await app.press("id:agent-picker >> text:Claude Code");
  await app.waitFor("text:Claude Code Default");
  await app.type(MESSAGE, "/");
  await app.waitFor(MENU);
  // Compaction and HTML export are Pi's RPC; Pi's prompts are not this agent's. The engine reports a
  // `/clear`, a `/model` and a `/rename` of its own: the session, its name and the model are the shell's,
  // so those are not offered beside pipi's.
  expect(listed(app)).toEqual(["/new", "/model", "/name", "/copy", "/delegate", "/parallel", "/settings", "/security-review"]);
  expect(app.texts()).toContain("[path]");
  expect(app.texts().filter((text) => text === "Claude Code").length).toBeGreaterThan(0);
  await app.type(MESSAGE, "sec");
  await app.submit(MESSAGE);
  await app.waitUntil(() => draft(app) === "");
  await app.waitFor("text:/security-review");
  await app.waitFor("label:Send");

  // The engine's name for it finds the shell's command, and runs it even when typed in full with the menu closed:
  // the engine never gets a `/clear` that would empty its session behind the conversation on screen.
  await app.type(MESSAGE, "/clear");
  await app.waitFor(MENU);
  // (The command just sent is on screen too, as the message and the session's title.)
  expect(listed(app).filter((text) => text !== "/security-review")).toEqual(["/new"]);
  await app.keyboard.press("escape");
  await closed(app);
  await app.submit(MESSAGE);
  await app.waitFor("text:What are we building?");
  expect(draft(app)).toBe("");
  expect(app.texts()).not.toContain("/clear");
});

test("a command nothing here answers to says so, and goes to the agent as written", async () => {
  const app = await launch();
  await app.waitFor("text:What are we building?");
  await app.type(MESSAGE, "/review-pr");
  await app.waitFor("text:No command by that name. Enter sends it to Pi as written.");
  expect(listed(app)).toEqual([]);
  // Escape puts the line away like the rest of the menu.
  await app.keyboard.press("escape");
  await closed(app);
  await app.submit(MESSAGE);
  await app.waitUntil(() => draft(app) === "");
  await app.waitFor("text:/review-pr");
});
