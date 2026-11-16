// A send pins its prompt under the title bar while the reply fills the room
// reserved under it — the pin is the send's for the run's whole span: it never
// lets go mid-run (a timed cap once cut live holds short, snapping the prompt
// back down), and the view returns to the end on its own when the run is over.
//
//   nsh test SendAnchor.test.tsx --target macos    # on the real list
//
// What tells the held pin from a view back at the end is the prompt-jump
// bubble (`PromptJumpPill`): it can only name the prompt above the viewport
// once the view is no longer the send's. "Working" is the live turn's clock;
// while it runs, the pin must still be holding.
import { expect, open, test } from "nsh/test";

const JUMP = "label:Back to the prompt";

test("a send's pin holds through the run and hands back at its settle", async () => {
  const app = await open("./Harness.tsx", {
    width: 1180,
    height: 780,
    platform: "macos",
    locale: "en-US",
    storage: {
      "harness.scenario": "slow",
      "harness.long": "1",
      "harness.then": "3000:/sessions/two.jsonl",
    },
  });
  await app.waitFor("text:Part 24 of the plan", { timeout: 20000 });
  await app.type("label:Message", "keep going on the plan");
  await app.submit("label:Message");
  // The run's span at this pace is ~11s — longer than the cap that once cut
  // it: while the turn still works, the prompt stays pinned and the bubble
  // that would name it above the viewport stays away.
  for (let i = 0; i < 80 && app.shows("text:Working"); i++) {
    expect(app.shows(JUMP)).toBe(false);
    await app.wait(250);
  }
  // Settled, the view is back at the end on its own: the prompt the bubble
  // names is once again one above what is being read.
  await app.waitFor(JUMP, { timeout: 20000 });
}, 60000);

// Regression: a scroll gesture under a sent prompt's anchor dropped the runway
// reservation whole — the offset it was holding up snapped to the end and every
// row fell with it ("the message gets pulled down"). The reserve is consumable
// scroll room now: released, it stays the reader's to scroll through, going only
// where they cannot see it — the view they release into is the one they scrolled
// to, off the end, and the way back is offered ("Scroll to bottom").
//
//   nsh test SendAnchor.test.tsx
//
// "stream" paces the records, so the run — and the hold — is still on when the
// scroll lands; a short reply keeps the reserve load-bearing (the end without
// it is far above the pin). Before the fix the released offset clamped to that
// end and the pill never showed.

const launchStream = () =>
  open("./Harness.tsx", {
    width: 1180,
    height: 780,
    platform: "macos",
    locale: "en-US",
    storage: { "harness.scenario": "stream", "harness.distinct": "1", "harness.reply": "On it." },
  });

test("a scroll under the anchor leaves the view where the reader put it", async () => {
  const app = await launchStream();
  await app.waitFor("text:What are we building?", { timeout: 20000 });
  await app.press("id:sidebar-recents >> text:Refactor the transcript reducer");
  await app.waitFor("text:Here is the plan.", { timeout: 20000 });

  await app.type("label:Message", "and then what");
  await app.submit("label:Message");
  await app.wait(900); // the entry glide has landed; the pin holds through the stream

  await app.scroll("label:Conversation", -160);
  const frames: { pill: boolean; prompt: boolean }[] = [];
  for (let i = 0; i < 30; i++) {
    frames.push({
      pill: app.shows("label:Scroll to bottom"),
      prompt: app.texts().some((t) => t.includes("and then what")),
    });
    await app.wait(16);
  }
  expect(frames.every((f) => f.prompt)).toBe(true);
  expect(frames.some((f) => f.pill)).toBe(true);
}, 120000);
