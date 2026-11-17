import { open, test } from "nsh/test";

// The end of a run, frame by frame, for review: the Copy line fades into a
// seat the streaming reply already took — the answer does not move — and the
// fold leaves once the last word is lit, not while it is still arriving
// ("tight" lands the end records inside the last word's fade, as a fast
// stream's do).
//
//   nsh test SettleLook.test.tsx --target macos   # writes .nsh/shots/settle-*.png
//
// The send is the harness's own (`harness.then`), not a `press`: a press
// resolves once the app is quiet, which hides the frames that matter. The
// film starts when the answer's last line stands and covers the settle, the
// fill, the fold and Pip's leave. A frame takes ~100ms to shoot, so a fault
// of a single frame can fall between two: film it again.

test("films a tight run settling: the seat fills, then the fold leaves", async () => {
  const app = await open("./Harness.tsx", {
    width: 1180,
    height: 780,
    platform: "macos",
    locale: "en-US",
    storage: {
      "harness.scenario": "stream",
      "harness.then": "3500:draft:make a plan in steps tight;4500:send:",
    },
  });
  // The seat under the reply while it is written: empty, already the Copy line's height.
  await app.waitFor("text:The list now follows the reply natively.", { timeout: 120000 });
  for (let i = 0; i < 8; i++) await app.screenshot(`.nsh/shots/settle-stream-${String(i).padStart(2, "0")}.png`);
  await app.waitFor("text:Everything else is as it was, and the tests pass.", { timeout: 120000 });
  for (let i = 0; i < 30; i++) await app.screenshot(`.nsh/shots/settle-${String(i).padStart(2, "0")}.png`);
}, 180000);
