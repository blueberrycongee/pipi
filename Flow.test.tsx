import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

// The run as the conversation says it, frame by frame: each thing is said once,
// said whole, and what is counted is what is concluded.
//
//   nsh test Flow.test.tsx
//
// On a manual clock, looking every 16ms: a word that is on screen for a frame
// or two is exactly what this is for, and `waitFor` would walk past it.

const launch = () =>
  open("./Harness.tsx", {
    width: 1180,
    height: 1500,
    platform: "macos",
    locale: "en-US",
    clock: {},
    storage: { "harness.scenario": "stream" },
  });

/** Whether `text` is in the conversation (the sidebar and the composer say some of the same words). */
const shows = (app: App, text: string) => app.count(`label:Conversation >> text:${text}`) > 0;

/** What the conversation shows under the prompt, in order. The composer's model chip ends it: the title
 * bar is mounted after the chat and says the prompt again, as the sidebar does before it. */
function said(app: App): string[] {
  const texts = app.texts();
  const to = texts.indexOf("Claude Sonnet 4.5");
  const chat = to < 0 ? texts : texts.slice(0, to);
  const from = chat.lastIndexOf("make a plan in steps");
  return from < 0 ? [] : chat.slice(from + 1);
}

/** Every frame of a run in steps, from the send until the composer offers Send again. */
async function filmRun(app: App): Promise<string[][]> {
  await app.waitFor("text:What are we building?");
  await app.type("label:Message", "make a plan in steps");
  await app.submit("label:Message");
  const frames: string[][] = [];
  for (let elapsed = 0; elapsed < 60_000; elapsed += 16) {
    frames.push(said(app));
    if (elapsed > 2000 && app.shows("label:Send")) break;
    await app.wait(16);
  }
  // And the frames after it settled: the fold, Pip's leave.
  for (let elapsed = 0; elapsed < 800; elapsed += 16) {
    await app.wait(16);
    frames.push(said(app));
  }
  // The film saw the run: its header working, and its answer.
  expect(frames.some((frame) => frame.includes("Working"))).toBe(true);
  expect(frames.some((frame) => frame.includes("Everything else is as it was, and the tests pass."))).toBe(true);
  return frames;
}

test("what the run is doing is said once: Pip's line does not restate the row above it", async () => {
  const frames = await filmRun(await launch());
  const everSaid = new Set(frames.flat());
  // The steps are said by their rows ("Reading package.json"), not again under them by tool name.
  expect([...everSaid].filter((text) => /^Running (read|grep|bash|edit)$/.test(text))).toEqual([]);
  expect(everSaid.has("Reading package.json")).toBe(true);
  // The reply being written is its own evidence.
  expect(everSaid.has("Writing")).toBe(false);
  // With the run's header on screen, "Thinking" is the reasoning row's own label, not a second one under it:
  // Pip's words from before the first row fade out as it lands (a fade is not a frame), and never come back.
  const working = frames.filter((frame) => frame.includes("Working"));
  const doubled = working.map((frame) => frame.filter((text) => text === "Thinking").length > 1);
  const lastDoubled = doubled.lastIndexOf(true);
  expect(lastDoubled === -1 || lastDoubled < 12).toBe(true);
  // Once the answer stands nothing says the run is still at something.
  const answered = frames.findIndex((frame) => frame.some((text) => text.startsWith("Finished in")));
  expect(answered).toBeGreaterThan(0);
  for (const frame of frames.slice(answered)) {
    expect(frame.filter((text) => text === "Thinking" || text === "Writing" || text === "Working")).toEqual([]);
  }
});

test("a step is said whole: no placeholder line that the next delta rewrites", async () => {
  const frames = await filmRun(await launch());
  const everSaid = new Set(frames.flat());
  for (const placeholder of ["Reading file", "Read file", "Searching", "Searched", "Running a command", "Ran a command", "Updating file", "Updated file"]) {
    expect(everSaid.has(placeholder)).toBe(false);
  }
});

test("the fold leaves once the reply's last word is lit, not while it is still arriving", async () => {
  const app = await launch();
  await app.waitFor("text:What are we building?");
  // "tight": the last delta and the end records land inside the last word's fade, as a fast stream's do.
  await app.type("label:Message", "make a plan in steps tight");
  await app.submit("label:Message");
  // The Copy line's seat is taken under the reply while it is written, but nothing sits in it yet.
  await app.waitFor("text:Working");
  expect(app.shows("label:Copy reply")).toBe(false);
  await app.waitUntil(() => shows(app, "Everything else is as it was, and the tests pass."), { timeout: 60000 });
  await app.waitFor("label:Copy reply");
  // The mid-run commentary is a process row: a fold that left with the settle takes it inside ~80ms;
  // one that waits for the last word holds it the whole of the veil (~200ms more).
  const held = [];
  for (let elapsed = 0; elapsed < 400; elapsed += 16) {
    held.push(shows(app, "The list follows by hand. Let me check the tests before changing it."));
    await app.wait(16);
  }
  // It stands through the last word's fade, then it does fold.
  expect(held.findIndex((shown) => !shown)).toBeGreaterThanOrEqual(12);
});

test("the turn ends on the seconds its timer counted", async () => {
  const frames = await filmRun(await launch());
  const counted = frames
    .map((frame) => (frame.includes("Working") ? frame.find((text) => /^\d+s$/.test(text)) : undefined))
    .filter((text): text is string => text !== undefined)
    .map((text) => Number(text.slice(0, -1)));
  const header = frames.flat().find((text) => /^Finished in \d+ seconds?$/.test(text));
  expect(counted.length).toBeGreaterThan(0);
  expect(header).toBeDefined();
  // The count never runs backwards, and the figure the turn ends on is the last one it showed.
  for (let i = 1; i < counted.length; i++) expect(counted[i]).toBeGreaterThanOrEqual(counted[i - 1]);
  expect(Number(header!.match(/\d+/)![0])).toBe(counted[counted.length - 1]);
});

test("aggregated toolcall bursts stay calm: no partial-arg stutters, no running/settled ping-pong, paced cadence", async () => {
  const app = await launch();
  await app.waitFor("text:What are we building?");
  await app.type("label:Message", "run a burst of tool calls");
  await app.submit("label:Message");

  const frames: { at: number; texts: string[] }[] = [];
  for (let elapsed = 0; elapsed < 20_000; elapsed += 16) {
    const all = app.texts();
    const to = all.indexOf("Claude Sonnet 4.5");
    const chat = to < 0 ? all : all.slice(0, to);
    const from = chat.lastIndexOf("run a burst of tool calls");
    frames.push({ at: elapsed, texts: from < 0 ? [] : chat.slice(from + 1) });
    if (elapsed > 1000 && app.shows("label:Send")) break;
    await app.wait(16);
  }

  const everSaid = new Set(frames.flatMap((f) => f.texts));
  // 1. Mid-token partial arguments never stutter onto screen.
  for (const fragment of ["Reading Ro", "Reading Rows.ts", "Searching Roll", "Running git", "Reading file"]) {
    expect(everSaid.has(fragment)).toBe(false);
  }
  // 2. Parallel reads finishing out of order never bounce through every file or flash an intermediate settled summary across the 90ms gap.
  expect([...everSaid]).toContain("Reading Rows.tsx");
  expect(everSaid.has("Read 4 files")).toBe(false);
  expect(everSaid.has("Reading turns.ts")).toBe(false);
  expect(everSaid.has("Reading RollingText.tsx")).toBe(false);
  expect(everSaid.has("Reading Chat.tsx")).toBe(false);
  // 3. Later sustained steps (grep + bash) appear cleanly once whole, and the final settled summary lands once prose seals the group.
  expect(everSaid.has("Searching RollingText")).toBe(true);
  expect(everSaid.has("Running git status --short")).toBe(true);
  expect(everSaid.has("Read 4 files, Searched RollingText, Ran git")).toBe(true);
  // 4. Consecutive active label introductions stay paced (>= 350ms apart — never high-frequency strobing).
  const activeLabels = ["Reading Rows.tsx", "Searching RollingText", "Running git status --short"];
  const firstSeen = activeLabels.map((label) => frames.find((f) => f.texts.includes(label))!.at);
  expect(firstSeen[1] - firstSeen[0]).toBeGreaterThanOrEqual(350);
  expect(firstSeen[2] - firstSeen[1]).toBeGreaterThanOrEqual(350);
});
