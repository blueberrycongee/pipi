import { expect, open, test } from "nsh/test";

// Visual & motion review of the document's floating AI orb across Light and Dark:
// resting orb, hover bloom into the bottom-right mini-composer, engine/model/effort
// pickers, skeleton loading shimmer, live streaming reply, and document update pill.
//
//   nsh test DocOrbLook.test.tsx --target macos   → .nsh/shots/doc-orb-*.png

const dir = `/tmp/pipi-doc-orb-look-${Date.now()}`;
const sample = `# Launch plan

Some opening draft paragraph that explains our goals clearly and concisely so the reader can scan it quickly.

## Milestones

- Polish the document floating orb motion
- Verify live streaming replies and skeleton shimmer
- Confirm smooth document update highlights and undo
`;

const launch = (colorScheme: "light" | "dark", scenario = "stream", locale = "zh-CN") =>
  open("./Harness.tsx", {
    width: 1180,
    height: 780,
    platform: "macos",
    locale,
    colorScheme,
    storage: {
      "harness.scenario": scenario,
      "harness.distinct": "1",
      "harness.dataDir": `${dir}-${colorScheme}-${locale}`,
      "harness.files": JSON.stringify({
        [`${dir}-${colorScheme}-${locale}/docs/plan.md`]: sample,
      }),
      "pipi.prefs.v1": JSON.stringify({
        appearance: colorScheme,
        openTabs: [{ kind: "doc", ref: `${dir}-${colorScheme}-${locale}/docs/plan.md` }],
      }),
    },
  });

test("doc orb light showcase", async () => {
  const app = await launch("light", "stream", "zh-CN");
  await app.waitFor("id:sidebar-new-session");
  await app.press("id:tab-0");
  await app.waitFor("id:doc-editor");
  await app.wait(600);
  // 1. Resting circular floating orb
  await app.screenshot(".nsh/shots/doc-orb-1-rest-light.png");

  // 2. Hover → expanded horizontal pill input bar
  await app.hover("id:doc-orb");
  await app.waitFor("id:doc-orb-input");
  await app.wait(450);
  await app.screenshot(".nsh/shots/doc-orb-2-hover-light.png");

  // 3. Click/focus → clean focused mini-composer (no floating quick chips)
  await app.press("id:doc-orb-trigger");
  await app.waitFor("id:doc-orb-input");
  await app.wait(250);
  await app.screenshot(".nsh/shots/doc-orb-3-focus-light.png");

  // 3b. Model picker popover open over the mini-composer
  await app.press("id:doc-orb-model");
  await app.waitFor("id:doc-orb-model-menu");
  await app.wait(220);
  await app.screenshot(".nsh/shots/doc-orb-3b-model-picker-light.png");
  await app.press("id:doc-orb-model-menu >> text:GPT-5.1");
  await app.waitUntil(() => app.count("id:doc-orb-model-menu") === 0);
  await app.press("id:doc-orb-thinking");
  await app.waitFor("id:doc-orb-thinking-menu");
  await app.wait(200);
  await app.screenshot(".nsh/shots/doc-orb-3c-effort-picker-light.png");
  await app.press("id:doc-orb-thinking-high");
  await app.waitUntil(() => app.count("id:doc-orb-thinking-menu") === 0);

  // 4. Submit → skeleton shimmer + live activity ribbon, then delayed rewrite triggers live refresh sweep
  await app.type("id:doc-orb-input", "rewrite this slowly and summarize");
  await app.submit("id:doc-orb-input");
  await app.waitFor("id:doc-orb-skeleton");
  await app.wait(120);
  await app.screenshot(".nsh/shots/doc-orb-4-skeleton-light.png");

  // 4b. Mid-refresh sweep as the live document update lands (luminous cobalt wave gliding over prose)
  await app.waitFor("id:doc-refresh-sweep");
  await app.wait(220);
  await app.screenshot(".nsh/shots/doc-orb-4b-refresh-sweep-light.png");

  // 5. Settled reply + live document update pill & highlight sweep
  await app.waitFor("id:doc-update-pill");
  await app.waitFor("id:doc-orb-copy");
  await app.wait(500);
  await app.screenshot(".nsh/shots/doc-orb-5-reply-updated-light.png");

  // 6. Blank new document drafting skeleton (empty placeholder yields cleanly without overlapping skeleton bars)
  await app.keyboard.press("mod+shift+n");
  await app.waitFor("id:doc-orb-trigger");
  await app.press("id:doc-orb-trigger");
  await app.waitFor("id:doc-orb-input");
  await app.type("id:doc-orb-input", "draft doc slowly");
  await app.submit("id:doc-orb-input");
  await app.waitFor("id:doc-drafting-skeleton");
  await app.wait(300);
  await app.screenshot(".nsh/shots/doc-orb-6-drafting-skeleton-light.png");
  // Wait for the drafted text + update pill to land cleanly with no lingering skeleton ghost.
  await app.waitFor("id:doc-update-pill");
  await app.waitFor("id:doc-orb-copy");
  await app.wait(220);
  await app.screenshot(".nsh/shots/doc-orb-6b-drafted-landed-light.png");
});

test("doc orb dark showcase", async () => {
  const app = await launch("dark", "welcome", "zh-CN");
  await app.waitFor("id:sidebar-new-session");
  await app.press("id:tab-0");
  await app.waitFor("id:doc-editor");
  await app.wait(600);
  await app.screenshot(".nsh/shots/doc-orb-1-rest-dark.png");

  await app.press("id:doc-orb-trigger");
  await app.waitFor("id:doc-orb-input");
  await app.wait(350);
  await app.screenshot(".nsh/shots/doc-orb-3-focus-dark.png");

  await app.press("id:doc-orb-agent");
  await app.waitFor("id:doc-orb-agent-menu");
  await app.wait(220);
  await app.screenshot(".nsh/shots/doc-orb-3b-agent-picker-dark.png");
  await app.keyboard.press("escape");
  await app.waitUntil(() => app.count("id:doc-orb-agent-menu") === 0);

  await app.type("id:doc-orb-input", "rewrite this slowly");
  await app.submit("id:doc-orb-input");
  await app.waitFor("id:doc-refresh-sweep");
  await app.wait(220);
  await app.screenshot(".nsh/shots/doc-orb-4b-refresh-sweep-dark.png");
  await app.waitFor("id:doc-update-pill");
  await app.waitFor("id:doc-orb-copy");
  await app.wait(500);
  await app.screenshot(".nsh/shots/doc-orb-5-reply-updated-dark.png");
});

test("doc orb hover holds steady over native macOS input without twitching", async () => {
  const app = await launch("light", "welcome", "zh-CN");
  await app.waitFor("id:sidebar-new-session");
  await app.press("id:tab-0");
  await app.waitFor("id:doc-editor");
  await app.waitFor("id:doc-orb");
  await app.wait(350);

  // Hover resting orb: morphs open and stays expanded past multiple leave-grace windows without jittering.
  await app.hover("id:doc-orb");
  await app.waitFor("id:doc-orb-input");
  for (let i = 0; i < 8; i++) {
    await app.wait(120);
    expect(app.count("id:doc-orb-input")).toBe(1);
  }

  // Sweeping across trigger, native multiline input, and send button stays steadily expanded.
  await app.hover("id:doc-orb-trigger");
  await app.hover("id:doc-orb-input");
  await app.wait(450);
  expect(app.count("id:doc-orb-input")).toBe(1);
  await app.hover("id:doc-orb-send");
  await app.hover("id:doc-orb-input");
  await app.wait(450);
  expect(app.count("id:doc-orb-input")).toBe(1);

  // Leaving directly from the input into the editor or sidebar collapses cleanly.
  await app.hover("text:Milestones");
  await app.waitUntil(() => app.count("id:doc-orb-input") === 0, { timeout: 2000 });

  await app.hover("id:doc-orb");
  await app.waitFor("id:doc-orb-input");
  await app.hover("id:doc-orb-input");
  await app.wait(350);
  expect(app.count("id:doc-orb-input")).toBe(1);
  await app.hover("id:sidebar-new-session");
  await app.waitUntil(() => app.count("id:doc-orb-input") === 0, { timeout: 2000 });

  // Pressing Escape while pointer rests over the input stays collapsed instead of bouncing open on unmount.
  await app.press("id:doc-orb-trigger");
  await app.waitFor("id:doc-orb-input");
  await app.hover("id:doc-orb-input");
  await app.wait(200);
  await app.keyboard.press("escape");
  await app.waitUntil(() => app.count("id:doc-orb-input") === 0, { timeout: 2000 });
  await app.wait(500);
  expect(app.count("id:doc-orb-input")).toBe(0);
});
