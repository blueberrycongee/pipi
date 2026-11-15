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
