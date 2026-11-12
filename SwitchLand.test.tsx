// Regression: a session switch replayed the aggregated tool-call row's entrance
// — `markRowsSeen` named the transcript's raw ids while the display projection
// mints `turn:`/`act:`/`#actions` ids, so they mounted unseen and slid in after
// the switch. A landing now marks every row it can project
// (`displayRowIds`), so the frame the new conversation appears on is already
// its settled one.
//
//   nsh test SwitchLand.test.tsx --target macos
//
// `harness.startDelay` makes the scripted switch take 1.5s; the poll catches
// the answer's first frame and the shots right after it must already be the
// settled conversation — a replayed entrance leaves them mid-fade.
import { expect, open, test } from "nsh/test";
import { decodeLumGrid, type Grid, pixelDiff } from "./dev/frames";

const OUT = "/tmp/pipi-switch";

test("a session switch lands settled", async () => {
  const app = await open("./Harness.tsx", {
    width: 1180,
    height: 780,
    platform: "macos",
    locale: "en-US",
    storage: { "harness.scenario": "welcome", "harness.startDelay": "1500" },
  });
  await app.waitFor("text:What are we building?", { timeout: 20000 });

  await app.press("id:sidebar-recents >> text:Refactor the transcript reducer");
  // Poll without filming: the answer text is the rows' mount instant.
  let landed = false;
  for (let i = 0; i < 600; i++) {
    if (app.texts().includes("Here is the plan.")) {
      landed = true;
      break;
    }
    await app.wait(10);
  }
  expect(landed).toBe(true);
  const shots: Grid[] = [decodeLumGrid(await app.screenshot(`${OUT}-f0.png`), 8), decodeLumGrid(await app.screenshot(`${OUT}-f1.png`), 8)];
  await app.wait(1200);
  const settled = decodeLumGrid(await app.screenshot(`${OUT}-settled.png`), 8);

  // The transcript column: right of the sidebar, above the composer.
  const x0 = Math.round(settled.width * 0.3);
  const x1 = settled.width - 4;
  const y1 = Math.round(settled.height * 0.8);

  // Entrance replays fade or shift whole rows over ~200ms; a landing has none.
  for (const shot of shots) expect(pixelDiff(shot, settled, x0, x1, 2, y1)).toBeLessThan(0.03);
}, 120000);

// Regression: a conversation opened from the empty chat landed at its start.
// The empty chat is held, dimmed, until its successor is whole, so the scroll
// to the end that comes with the landing found no list to scroll, and the list
// made right after opened at offset 0. A list made anew now opens at its end.
// `harness.long` ends each history on a reply longer than the window: the list
// mounts only the rows near its viewport, so the reply's last part is on screen
// (in `texts()`) only at the end.
for (const delay of [0, 1500]) {
  test(`a long conversation opened from the empty chat lands at its end (agent delay ${delay}ms)`, async () => {
    const app = await open("./Harness.tsx", {
      width: 1180,
      height: 780,
      platform: "macos",
      locale: "en-US",
      storage: { "harness.scenario": "welcome", "harness.distinct": "1", "harness.long": "1", "harness.startDelay": String(delay) },
    });
    await app.waitFor("text:What are we building?", { timeout: 20000 });

    // Not seen in this run: nothing of it to show until the agent has loaded it.
    await app.press("id:sidebar-recents >> text:Refactor the transcript reducer");
    await app.waitFor("label:Conversation", { timeout: 20000 });
    await app.wait(600);
    expect(app.shows("text:Part 24 of the plan")).toBe(true);
    expect(app.shows("label:Scroll to bottom")).toBe(false);

    // And so does the next one, landing in the list already there.
    await app.press("id:sidebar-recents >> text:Release notes for 0.1");
    await app.wait(delay + 1200);
    expect(app.shows("text:Part 24 of the plan")).toBe(true);
    expect(app.shows("label:Scroll to bottom")).toBe(false);

    // It follows from there: a reader's scroll up releases it, as in any conversation
    // (and up at its start is the question this one opens on: it is the one asked for).
    await app.scroll("label:Conversation", -4000);
    await app.waitFor("label:Scroll to bottom", { timeout: 2000 });
    await app.waitFor("label:Conversation >> text:Release notes for 0.1", { timeout: 2000 });
  }, 120000);
}

// Regression: the same landing also replayed every status line's split-flap —
// `RollingText` marked all of a line's first tokens born, so "Finished in …"
// and the tool rows dropped in letter by letter. A line's first look now
// shows it whole (`id:rolling-born` marks the born flaps a live line still
// gets when it grows).
test("a session switch lands its status lines whole", async () => {
  // Chinese status words are one flap piece per glyph, so a live line's growth
  // shows the born flaps an English line (one piece per run) would not.
  const app = await open("./Harness.tsx", {
    width: 1180,
    height: 780,
    platform: "macos",
    locale: "zh-Hans-CN",
    // "stream" paces the records, so the run's status lines visibly grow.
    storage: { "harness.scenario": "stream", "harness.startDelay": "1500" },
  });
  await app.waitFor("text:今天要构建什么？", { timeout: 20000 });

  await app.press("id:sidebar-recents >> text:Refactor the transcript reducer");
  await app.waitUntil(() => app.texts().includes("Here is the plan."), { timeout: 30000 });
  await app.wait(400);
  expect(app.count("id:rolling-born")).toBe(0);

  // A live line still flaps as it grows: the next turn's header lands whole,
  // then born flaps carry it to its finished words.
  await app.type("label:消息", "and then what");
  await app.submit("label:消息");
  await app.waitUntil(() => app.count("id:rolling-born") > 0, { timeout: 30000 });
}, 120000);
