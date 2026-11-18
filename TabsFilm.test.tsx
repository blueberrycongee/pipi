// The strip and the document layer in motion, frame by frame, for review:
// a document coming forward over the chat (a cross-fade of two whole
// surfaces), and a tab closing (the pills beside it flow to their new slots,
// the "+" with them).
//
//   nsh test TabsFilm.test.tsx --target macos   # writes .nsh/shots/tabs-<case>-NN.png
//
// The change is the harness's own (`harness.then`), not a `press`: a press
// resolves once the app is quiet, which hides the frames that matter. A frame
// takes ~100ms to shoot, so a fault of a single frame can fall between two:
// film it again.
import { open, test } from "nsh/test";

const DIR = "/tmp/pipi-tabsfilm";
const AT = 5000;
const doc = (name: string) => ({ kind: "doc", ref: `${DIR}/${name}.md` });

async function film(name: string, step: string, frames = 10) {
  const started = Date.now();
  const app = await open("./Harness.tsx", {
    width: 1180,
    height: 780,
    platform: "macos",
    locale: "en-US",
    storage: {
      "harness.scenario": "history",
      "harness.dataDir": DIR,
      "harness.then": `${AT}:${step}`,
      "pipi.prefs.v1": JSON.stringify({ openTabs: [doc("brief"), doc("plan"), doc("review")] }),
    },
  });
  await app.wait(Math.max(0, AT - 150 - (Date.now() - started)));
  for (let i = 0; i < frames; i++) await app.screenshot(`.nsh/shots/tabs-${name}-${String(i).padStart(2, "0")}.png`);
}

test("films a document coming forward", () => film("doc-forward", "tab:1"), 60000);
test("films a tab closing", () => film("close", "closetab:0"), 60000);

// The strip is a browser's: more pills than fit squeeze to share the
// viewport, and a close with the pointer over it holds their width — the
// next close button lands under it — until the pointer leaves and the pills
// take the room back. Nine restored documents squeeze; two closes hold; a
// hover over the sidebar lets them grow.
test("films squeezed pills holding their width through closes", async () => {
  const started = Date.now();
  const app = await open("./Harness.tsx", {
    width: 1180,
    height: 780,
    platform: "macos",
    locale: "en-US",
    storage: {
      "harness.scenario": "history",
      "harness.dataDir": DIR,
      "harness.then": `${AT}:closetab:4;${AT + 500}:closetab:4`,
      "pipi.prefs.v1": JSON.stringify({ openTabs: [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => doc(`notes-${i}`)) }),
    },
  });
  // The pointer rests in the strip before the closes land.
  await app.hover("id:tab-5");
  await app.wait(Math.max(0, AT - 150 - (Date.now() - started)));
  for (let i = 0; i < 10; i++) await app.screenshot(`.nsh/shots/tabs-lag-${String(i).padStart(2, "0")}.png`);
  // Pointer off the strip: the pills take the freed room back.
  await app.hover("id:sidebar-recents");
  for (let i = 10; i < 14; i++) await app.screenshot(`.nsh/shots/tabs-lag-${String(i).padStart(2, "0")}.png`);
}, 60000);
