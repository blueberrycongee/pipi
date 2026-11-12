// A session change, frame by frame, for review: what the chat and the sidebar
// do from the click until the destination has settled in.
//
//   nsh test SwitchFilm.test.tsx --target macos   # writes .nsh/shots/switch-<case>-NN.png
//
// The change is the harness's own (`harness.then`), not a `press`: a press
// resolves once the app is quiet, which hides the frames that matter. Agents
// are as slow as `DELAY` says — below patience (600ms) a change dips and
// lands; above it, Pip waits on the empty pane. The first frames are from
// just before the change. A frame takes ~100ms to shoot, so a fault of a
// single frame can fall between two: film it again.
import { open, test } from "nsh/test";

const DELAY = 300;
/** When the first change happens, after boot: past the first start and its lists. */
const AT = 6000 + DELAY * 3;

async function film(name: string, scenario: string, steps: string[], frames = 24) {
  const started = Date.now();
  const then = steps.map((target, at) => `${AT * (at + 1)}:${target}`).join(";");
  const app = await open("./Harness.tsx", {
    width: 1180,
    height: 780,
    platform: "macos",
    locale: "en-US",
    storage: { "harness.scenario": scenario, "harness.startDelay": String(DELAY), "harness.distinct": "1", "harness.then": then },
  });
  await app.wait(Math.max(0, AT * steps.length - 300 - (Date.now() - started)));
  for (let i = 0; i < frames; i++) await app.screenshot(`.nsh/shots/switch-${name}-${String(i).padStart(2, "0")}.png`);
}

const cases: Record<string, () => Promise<void>> = {
  "welcome-to-session": () => film("welcome-to-session", "welcome", ["/sessions/two.jsonl"]),
  "session-to-session": () => film("session-to-session", "history", ["/sessions/two.jsonl"]),
  "session-to-new": () => film("session-to-new", "history", ["new"]),
  "back-to-a-session-seen": () => film("back-to-a-session-seen", "welcome", ["/sessions/two.jsonl", "/sessions/four.jsonl", "/sessions/two.jsonl"]),
  "another-project": () => film("another-project", "multi", ["/sessions/nsh-1.jsonl@/Users/pip/code/nsh"]),
  "another-engine": () => film("another-engine", "welcome", ["/sessions/two.jsonl", "/sessions/three.jsonl"]),
};

for (const [name, run] of Object.entries(cases)) test(`films ${name}`, run, 120000);
