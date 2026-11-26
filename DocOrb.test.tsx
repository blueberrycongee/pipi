import { expect, open, test } from "nsh/test";

// The document's floating AI orb: circular Pip orb at rest, silky hover bloom
// into a bottom-right mini-composer with engine/model/effort/permission pickers,
// skeleton shimmer into veiled streaming replies, live document update pill +
// undo, in-place replace/insert, and seamless handoff to a full chat session.
//
//   nsh test DocOrb.test.tsx

let seq = 0;
const freshDir = () => `/tmp/pipi-doc-orb-${Date.now()}-${++seq}`;

const launch = (
  options: {
    dir?: string;
    files?: Record<string, string>;
    tabs?: string[];
    scenario?: string;
    reply?: string;
    clock?: Record<string, never>;
  } = {},
) =>
  open("./Harness.tsx", {
    width: 1180,
    height: 780,
    platform: "macos",
    locale: "en-US",
    ...(options.clock ? { clock: options.clock } : {}),
    storage: {
      "harness.scenario": options.scenario ?? "welcome",
      "harness.distinct": "1",
      "harness.dataDir": options.dir ?? freshDir(),
      "harness.files": JSON.stringify(options.files ?? {}),
      ...(options.reply !== undefined ? { "harness.reply": options.reply } : {}),
      "pipi.prefs.v1": JSON.stringify({ openTabs: (options.tabs ?? []).map((ref) => ({ kind: "doc", ref })) }),
    },
  });

type Launched = Awaited<ReturnType<typeof launch>>;
const EDITOR = "label:Document";
const ORB = "id:doc-orb";
const ORB_TRIGGER = "id:doc-orb-trigger";
const ORB_INPUT = "id:doc-orb-input";
const mentions = (app: Launched, text: string) => app.texts().some((line) => line.includes(text));

async function openNewDoc(app: Launched) {
  await app.waitFor("text:What are we building?");
  await app.keyboard.press("mod+shift+n");
  await app.waitFor(EDITOR);
  await app.waitFor(ORB);
}

test("floating orb morphs smoothly to pill input bar on hover and collapses back on leave", async () => {
  const app = await launch();
  await openNewDoc(app);

  // At rest: compact circular orb, input not mounted.
  expect(app.count(ORB)).toBe(1);
  expect(app.count(ORB_INPUT)).toBe(0);
  expect(app.count("id:doc-orb-send")).toBe(0);

  // Hovering morphs into the horizontal pill input bar and stays rock-solid while resting over the input or controls.
  await app.hover(ORB);
  await app.waitFor(ORB_INPUT);
  await app.waitFor("id:doc-orb-send");
  await app.hover(ORB_INPUT);
  await app.wait(650);
  expect(app.count(ORB_INPUT)).toBe(1);
  expect(app.count("id:doc-orb-send")).toBe(1);

  // Moving pointer away into the document editor collapses cleanly back into the orb.
  await app.hover(EDITOR);
  await app.waitUntil(() => app.count(ORB_INPUT) === 0, { timeout: 3000 });
  expect(app.count("id:doc-orb-send")).toBe(0);

  // Re-hovering over the input and moving out of the pane into the sidebar collapses cleanly too.
  await app.hover(ORB);
  await app.waitFor(ORB_INPUT);
  await app.hover(ORB_INPUT);
  await app.wait(450);
  expect(app.count(ORB_INPUT)).toBe(1);
  await app.hover("id:sidebar-new-session");
  await app.waitUntil(() => app.count(ORB_INPUT) === 0, { timeout: 3000 });
  expect(app.count("id:doc-orb-send")).toBe(0);
});

test("clicking orb focuses input, locks open while typing, and Escape collapses without floating quick chips", async () => {
  const app = await launch();
  await openNewDoc(app);
  await app.type(EDITOR, "Architecture notes on smooth native motion.");

  await app.press(ORB_TRIGGER);
  await app.waitFor(ORB_INPUT);
  expect(app.count("id:doc-orb-chips")).toBe(0);

  // Typing keeps the bar locked open even when pointer leaves.
  await app.type(ORB_INPUT, "Make this tighter");
  await app.hover("text:Workspaces");
  await app.wait(600);
  expect(app.count(ORB_INPUT)).toBe(1);
  expect(app.value(ORB_INPUT)).toBe("Make this tighter");

  // Pressing Escape collapses cleanly back into the resting orb (while keeping any draft safely preserved).
  await app.keyboard.press("escape");
  await app.waitUntil(() => app.count(ORB_INPUT) === 0, { timeout: 3000 });

  // Hovering back brings the preserved draft right back; clearing and escaping returns to the orb.
  await app.hover(ORB);
  await app.waitFor(ORB_INPUT);
  expect(app.value(ORB_INPUT)).toBe("Make this tighter");
  await app.clear(ORB_INPUT);
  await app.hover("text:Workspaces");
  await app.keyboard.press("escape");
  await app.waitUntil(() => app.count(ORB_INPUT) === 0, { timeout: 3000 });
});

test("submitting shows skeleton shimmer, streams reply, and supports collapse, unread badge, and reopen", async () => {
  const app = await launch({ scenario: "stream", clock: {} });
  await openNewDoc(app);
  await app.type(EDITOR, "Draft memo for Friday.");

  await app.press(ORB_TRIGGER);
  await app.waitFor(ORB_INPUT);
  await app.type(ORB_INPUT, "Give me a plan");
  await app.submit(ORB_INPUT);

  let sawSkeleton = false;
  let sawReply = false;
  for (let ms = 0; ms < 10_000; ms += 16) {
    if (app.count("id:doc-orb-skeleton") > 0) sawSkeleton = true;
    if (mentions(app, "Here is the plan.")) sawReply = true;
    if (sawReply && app.count("id:doc-orb-copy") > 0) break;
    await app.wait(16);
  }
  expect(sawSkeleton).toBe(true);
  expect(sawReply).toBe(true);
  expect(app.count("id:doc-orb-skeleton")).toBe(0);

  // Collapse and reopen the reply drawer cleanly.
  await app.press("id:doc-orb-collapse");
  await app.waitUntil(() => app.count("id:doc-orb-reply") === 0, { timeout: 2000 });
  await app.hover(ORB);
  await app.waitFor("id:doc-orb-toggle-reply");
  await app.press("id:doc-orb-toggle-reply");
  await app.waitFor("id:doc-orb-reply");
  expect(mentions(app, "Here is the plan.")).toBe(true);
});

test("direct agent file rewrite updates document live with floating update pill and one-click undo", async () => {
  const app = await launch();
  await openNewDoc(app);
  await app.type(EDITOR, "A draft of the plan");
  await app.wait(200);

  await app.press(ORB_TRIGGER);
  await app.waitFor(ORB_INPUT);
  await app.type(ORB_INPUT, "rewrite this");
  await app.submit(ORB_INPUT);

  // Document updates live on screen, update pill appears, and reply notes the direct sync (without redundant Insert/Append).
  await app.waitUntil(() => mentions(app, "A final of the plan"), { timeout: 8000 });
  await app.waitFor("id:doc-update-pill");
  await app.waitUntil(() => mentions(app, "Document updated directly"), { timeout: 8000 });
  expect(app.count("id:doc-orb-copy")).toBe(1);
  expect(app.count("id:doc-orb-insert")).toBe(0);
  expect(app.count("id:doc-orb-append")).toBe(0);

  // One-click Undo on the floating pill restores the original text immediately.
  await app.press("id:doc-update-undo");
  await app.waitUntil(() => mentions(app, "A draft of the plan"), { timeout: 4000 });
  await app.waitUntil(() => app.count("id:doc-update-pill") === 0, { timeout: 2000 });
});

test("selection bubble quick-AI captures selection chip and replaces selection in-place", async () => {
  const app = await launch({ reply: "Refine this smoothly." });
  await openNewDoc(app);
  await app.type(EDITOR, "Keep this. Polish that");
  for (let i = 0; i < 11; i++) await app.keyboard.press("shift+left");
  await app.waitFor("id:doc-bubble-quick-ai");
  await app.press("id:doc-bubble-quick-ai");

  await app.waitFor("id:doc-orb-selection-chip");
  expect(mentions(app, "2 words selected")).toBe(true);
  await app.type(ORB_INPUT, "Reword this");
  await app.submit(ORB_INPUT);

  await app.waitFor("id:doc-orb-replace");
  await app.press("id:doc-orb-replace");
  await app.waitUntil(() => app.texts().join("").includes("Keep this. Refine this smoothly."), { timeout: 4000 });
  await app.waitFor("id:doc-update-pill");
  await app.press("id:doc-update-undo");
  await app.waitUntil(() => mentions(app, "Keep this. Polish that"), { timeout: 4000 });
});

test("open in full chat hands the live inline session cleanly to the main chat surface", async () => {
  const app = await launch();
  await openNewDoc(app);
  await app.type(EDITOR, "Release notes outline");

  await app.press(ORB_TRIGGER);
  await app.waitFor(ORB_INPUT);
  await app.type(ORB_INPUT, "Review my outline");
  await app.submit(ORB_INPUT);
  await app.waitUntil(() => mentions(app, "Here is the plan."), { timeout: 8000 });

  await app.press("id:doc-orb-open-chat");
  await app.waitFor("label:Conversation >> text:Here is the plan.");
});

test("read-only document still supports inline AI replies without exposing edit actions", async () => {
  const dir = freshDir();
  const readme = `${dir}/README.md`;
  const app = await launch({
    dir,
    files: { [readme]: '# Project\n\n<img src="logo.png" width="80">\n\nOverview paragraph.\n' },
    tabs: [readme],
  });
  await app.waitFor("text:What are we building?");
  await app.press("id:tab-0");
  await app.waitFor(EDITOR);
  await app.waitUntil(() => mentions(app, "Read-only"));

  await app.press(ORB_TRIGGER);
  await app.waitFor(ORB_INPUT);
  await app.type(ORB_INPUT, "Summarize this");
  await app.submit(ORB_INPUT);
  await app.waitUntil(() => mentions(app, "Here is the plan."), { timeout: 8000 });

  expect(app.count("id:doc-orb-copy")).toBe(1);
  expect(app.count("id:doc-orb-insert")).toBe(0);
  expect(app.count("id:doc-orb-append")).toBe(0);
});

test("inline mini-composer adjusts model, thinking effort, and permission mode independently of main chat", async () => {
  const app = await launch();
  await openNewDoc(app);
  await app.type(EDITOR, "Draft specification for inline controls.");

  // Expand via hover/click: engine, model, thinking effort, and permission controls are immediately visible.
  await app.press(ORB_TRIGGER);
  await app.waitFor(ORB_INPUT);
  await app.waitFor("id:doc-orb-agent");
  await app.waitFor("id:doc-orb-model");
  await app.waitFor("id:doc-orb-thinking");
  await app.waitFor("id:doc-orb-permission");
  expect(mentions(app, "Claude Sonnet 4.5")).toBe(true);
  expect(mentions(app, "Medium")).toBe(true);

  // Opening a picker keeps the orb locked open even if the pointer moves away.
  await app.press("id:doc-orb-thinking");
  await app.waitFor("id:doc-orb-thinking-menu");
  await app.hover("id:sidebar-new-session");
  await app.wait(450);
  expect(app.count("id:doc-orb-thinking-menu")).toBe(1);
  expect(app.count(ORB_INPUT)).toBe(1);

  // Selecting "High" updates the effort chip and returns focus to the input.
  await app.press("id:doc-orb-thinking-high");
  await app.waitUntil(() => app.count("id:doc-orb-thinking-menu") === 0);
  expect(mentions(app, "High")).toBe(true);

  // Switching to a non-reasoning model hides the thinking effort chip; switching back restores it.
  await app.press("id:doc-orb-model");
  await app.waitFor("id:doc-orb-model-menu");
  await app.press("id:doc-orb-model-menu >> text:DeepSeek Chat");
  await app.waitUntil(() => app.count("id:doc-orb-model-menu") === 0);
  await app.waitUntil(() => app.count("id:doc-orb-thinking") === 0, { timeout: 2000 });
  expect(mentions(app, "DeepSeek Chat")).toBe(true);

  await app.press("id:doc-orb-model");
  await app.waitFor("id:doc-orb-model-menu");
  await app.press("id:doc-orb-model-menu >> text:GPT-5.1");
  await app.waitUntil(() => app.count("id:doc-orb-model-menu") === 0);
  await app.waitFor("id:doc-orb-thinking");
  expect(mentions(app, "GPT-5.1")).toBe(true);
  expect(mentions(app, "High")).toBe(true);

  // Permission mode picker updates the inline session mode cleanly.
  await app.press("id:doc-orb-permission");
  await app.waitFor("id:doc-orb-permission-menu");
  await app.press("id:doc-orb-permission-auto-accept-edits");
  await app.waitUntil(() => app.count("id:doc-orb-permission-menu") === 0);

  // Submitting uses the chosen model (reflected in the reply card header) and preserves choices on New Thread.
  await app.type(ORB_INPUT, "Check this spec");
  await app.submit(ORB_INPUT);
  await app.waitUntil(() => mentions(app, "Here is the plan."), { timeout: 8000 });
  await app.waitUntil(() => mentions(app, "Pi · GPT-5.1"));

  await app.press("id:doc-orb-clear");
  await app.waitUntil(() => app.count("id:doc-orb-reply") === 0, { timeout: 2000 });
  await app.press(ORB_TRIGGER);
  await app.waitFor("id:doc-orb-model");
  expect(mentions(app, "GPT-5.1")).toBe(true);
  expect(mentions(app, "High")).toBe(true);

  // Main chat tab stays completely untouched on its own original model and effort.
  await app.press("id:tab-0");
  await app.waitFor("text:What are we building?");
  expect(mentions(app, "Claude Sonnet 4.5")).toBe(true);
  expect(mentions(app, "Medium")).toBe(true);
});

test("inline mini-composer switches engine before and mid-thread with portable handoff, and Escape closes popover before orb", async () => {
  const app = await launch();
  await openNewDoc(app);
  await app.type(EDITOR, "Engine handoff test document.");

  await app.press(ORB_TRIGGER);
  await app.waitFor("id:doc-orb-agent");

  // Escape closes an open picker popover first without collapsing the mini-composer.
  await app.press("id:doc-orb-agent");
  await app.waitFor("id:doc-orb-agent-menu");
  await app.keyboard.press("escape");
  await app.waitUntil(() => app.count("id:doc-orb-agent-menu") === 0);
  expect(app.count(ORB_INPUT)).toBe(1);

  // Switch engine to Claude Code before sending: model updates and non-reasoning default hides effort chip.
  await app.press("id:doc-orb-agent");
  await app.waitFor("id:doc-orb-agent-claude");
  await app.press("id:doc-orb-agent-claude");
  await app.waitUntil(() => app.count("id:doc-orb-agent-menu") === 0);
  await app.waitUntil(() => mentions(app, "Claude Code Default"), { timeout: 4000 });
  await app.waitUntil(() => app.count("id:doc-orb-thinking") === 0, { timeout: 2000 });

  // Send a first prompt on Claude Code.
  await app.type(ORB_INPUT, "First pass on Claude");
  await app.submit(ORB_INPUT);
  await app.waitUntil(() => mentions(app, "Here is the plan."), { timeout: 8000 });
  expect(mentions(app, "Claude Code · Claude Code Default")).toBe(true);

  // Switch engine mid-thread back to Pi: shows handoff notice and keeps conversation intact.
  await app.press("id:doc-orb-agent");
  await app.waitFor("id:doc-orb-agent-pi");
  await app.press("id:doc-orb-agent-pi");
  await app.waitUntil(() => app.count("id:doc-orb-agent-menu") === 0);
  await app.waitUntil(() => mentions(app, "Switched to Pi"), { timeout: 4000 });
  await app.waitFor("id:doc-orb-thinking");
  expect(mentions(app, "Here is the plan.")).toBe(true);

  // Follow-up runs on Pi with the handoff carried over.
  await app.type(ORB_INPUT, "Second pass on Pi");
  await app.submit(ORB_INPUT);
  await app.waitUntil(() => mentions(app, "Pi · Claude Sonnet 4.5"), { timeout: 8000 });
});

test("blank document shows drafting skeleton, writes directly via edit context, triggers refresh sweep, and stays clean of wire tags", async () => {
  const app = await launch({ scenario: "stream", clock: {} });
  await openNewDoc(app);

  // Blank newly created document: prompt from the floating orb materializes the file and tells the agent to edit it directly.
  await app.press(ORB_TRIGGER);
  await app.waitFor(ORB_INPUT);
  await app.type(ORB_INPUT, "draft doc slowly");
  await app.submit(ORB_INPUT);

  let sawDraftingSkeleton = false;
  let placeholderHiddenDuringSkeleton = false;
  let sawRefreshSweep = false;
  for (let ms = 0; ms < 10_000; ms += 16) {
    if (app.count("id:doc-drafting-skeleton") > 0) {
      sawDraftingSkeleton = true;
      if (!mentions(app, "Write a brief")) placeholderHiddenDuringSkeleton = true;
    }
    if (app.count("id:doc-refresh-sweep") > 0) sawRefreshSweep = true;
    if (mentions(app, "Generated Plan") && app.count("id:doc-update-pill") > 0 && app.count("id:doc-orb-copy") > 0) break;
    await app.wait(16);
  }

  expect(sawDraftingSkeleton).toBe(true);
  expect(placeholderHiddenDuringSkeleton).toBe(true);
  expect(sawRefreshSweep).toBe(true);
  expect(mentions(app, "Generated Plan")).toBe(true);
  expect(mentions(app, "Written directly into this live document")).toBe(true);
  expect(mentions(app, "Document updated directly")).toBe(true);
  // Raw wire context never leaks into the user bubble or title.
  expect(mentions(app, "doc_editor_context")).toBe(false);
  // Already synced directly to the document: Copy stays, redundant Insert/Append stay hidden.
  expect(app.count("id:doc-orb-copy")).toBe(1);
  expect(app.count("id:doc-orb-insert")).toBe(0);
  expect(app.count("id:doc-orb-append")).toBe(0);

  // Refresh sweep settles cleanly after its ~720ms run.
  await app.wait(900);
  expect(app.count("id:doc-refresh-sweep")).toBe(0);
  expect(app.count("id:doc-drafting-skeleton")).toBe(0);
});
