import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

// Pip (Personal Agent, persona: true) non-streaming IM interaction + avatar hover live status:
//
//   nsh test PipChat.test.tsx
//
// Verifies that:
// 1. While Pip is thinking, calling tools, and streaming text, the main conversation stays clean
//    (no streaming half-sentences, no "Working" header, no tool log wall); each prose block lands
//    as a complete SMS bubble as soon as the block itself finishes.
// 2. A quiet active Pip avatar appears at the bottom; hovering it reveals a real-time status card
//    describing what Pip is doing right now (and any active child sessions).
// 3. When Pip finishes a turn, the complete messages stand as IM messages with Pip's avatar
//    (which shares the same hover status card) and a quiet collapsed process disclosure.
// 4. Normal coding sessions remain 100% unchanged (streaming + live process rows).

const launch = (storage: Record<string, string> = {}) =>
  open("./Harness.tsx", {
    width: 1180,
    height: 1100,
    platform: "macos",
    locale: "en-US",
    clock: {},
    storage: { "harness.scenario": "stream", ...storage },
  });

const showsInChat = (app: App, text: string) => app.count(`label:Conversation >> text:${text}`) > 0;
const textVisible = (app: App, text: string) => {
  const box = app.layout(`text:${text}`);
  return Boolean(box && !box.hidden && !box.clipped);
};

test("Pip delivers completed IM messages without streaming jitter, while avatar hover reveals live status", async () => {
  const app = await launch();
  await app.waitFor("text:What are we building?");

  // Open Pip (persona: true) from its pinned sidebar row.
  await app.press("id:sidebar-pip");
  await app.waitFor("text:Hey, what's up?");

  // Send a multi-step prompt (thinking + commentary + read/grep/bash/edit tools + streaming reply).
  await app.type("label:Message", "make a plan in steps");
  await app.submit("label:Message");
  await app.waitFor("text:make a plan in steps");

  // While Pip is working: the quiet status label carries thinking/tool phases, and the iMessage
  // typing bubble appears only once Pip is writing. Sample frames through the whole run.
  await app.waitFor("id:pip-active-avatar");
  let hoveredDuringRun = false;
  let sawLiveCard = false;
  let sawLivePhase = false;
  let sawThinkingLabelDuringRun = false;
  let sawWorkingLabelDuringRun = false;
  let sawTypingBubbleDuringRun = false;
  let sawReadReceiptDuringRun = false;
  let sawToolWallDuringRun = false;
  let sawCommentaryDuringRun = false;
  let sawWorkingHeaderDuringRun = false;

  for (let elapsed = 0; elapsed < 60_000; elapsed += 16) {
    const stillRunning = !app.shows("label:Send");
    if (stillRunning) {
      if (app.shows("id:pip-typing-bubble")) sawTypingBubbleDuringRun = true;
      if (app.count("id:pip-working-label >> text:Thinking") > 0) sawThinkingLabelDuringRun = true;
      if (app.count("id:pip-working-label >> text:Working") > 0) sawWorkingLabelDuringRun = true;
      if (app.shows("id:sms-receipt")) sawReadReceiptDuringRun = true;
      if (app.count("id:turn-process-header") > 0) sawWorkingHeaderDuringRun = true;
      if (showsInChat(app, "Reading package.json")) sawToolWallDuringRun = true;
      if (showsInChat(app, "The list follows by hand. Let me check the tests before changing it.")) {
        sawCommentaryDuringRun = true;
      }
      if (!hoveredDuringRun && elapsed >= 600 && app.shows("id:pip-active-avatar")) {
        hoveredDuringRun = true;
        await app.hover("id:pip-active-avatar");
      }
      if (app.shows("id:pip-status-card")) {
        sawLiveCard = true;
        if (
          app.count("id:pip-status-card >> text:Thinking") > 0 ||
          app.count("id:pip-status-card >> text:Working") > 0 ||
          app.count("id:pip-status-card >> text:Writing reply") > 0
        ) {
          sawLivePhase = true;
        }
      }
    } else if (elapsed > 2000) {
      break;
    }
    await app.wait(16);
  }

  // Main chat stream stayed clean of process rows and half-written prose. Thinking and tool
  // work used the quiet label; completed commentary landed as soon as its own block finished.
  expect(sawThinkingLabelDuringRun).toBe(true);
  expect(sawWorkingLabelDuringRun).toBe(true);
  expect(sawTypingBubbleDuringRun).toBe(true);
  expect(sawReadReceiptDuringRun).toBe(true);
  expect(sawWorkingHeaderDuringRun).toBe(false);
  expect(sawToolWallDuringRun).toBe(false);
  expect(sawCommentaryDuringRun).toBe(true);

  // Hovering the active Pip avatar surfaced the live status card with real-time state.
  expect(sawLiveCard).toBe(true);
  expect(sawLivePhase).toBe(true);

  // Move pointer away so the working hover card dismisses cleanly.
  await app.hover("id:sidebar-pip");
  await app.wait(300);

  // Once settled, the typing bubble disappears and every completed block stands as iMessage SMS
  // bubbles alongside Pip's avatar. The stream itself carries no process pill: steps stay hidden
  // until opened from the avatar's card.
  await app.waitUntil(() => showsInChat(app, "Everything else is as it was, and the tests pass."), { timeout: 10_000 });
  expect(app.shows("id:pip-typing-bubble")).toBe(false);
  expect(app.count("id:pip-sms-bubble")).toBeGreaterThanOrEqual(1);
  expect(app.count("id:pip-message-avatar")).toBeGreaterThanOrEqual(1);
  expect(app.count("id:pip-process-toggle")).toBe(0);
  expect(showsInChat(app, "The list follows by hand. Let me check the tests before changing it.")).toBe(true);

  // Hovering the delivered message's Pip avatar opens the consistent status card (idle + turn summary),
  // which carries the one door to the turn's process.
  await app.hover("id:pip-message-avatar");
  await app.waitFor("id:pip-status-card");
  expect(app.count("id:pip-status-card >> text:Ready")).toBeGreaterThan(0);

  // Pressing it unfolds the process into the stream while the card stays open; pressing it again folds it back.
  await app.press("id:pip-process-toggle");
  await app.waitUntil(() => showsInChat(app, "View reasoning"));
  await app.press("id:pip-process-toggle");
  await app.waitUntil(() => !showsInChat(app, "View reasoning"));
});

test("Pip hover card surfaces active child sessions and error notices never vanish; normal coding sessions keep streaming", async () => {
  const now = Date.now();
  const app = await launch({
    "harness.daemonSessions": JSON.stringify([
      {
        id: "s_pip_1",
        title: "Pip",
        titleLocked: true,
        persona: true,
        cwd: "/Users/pip/.pipi/persona",
        agentId: "pi",
        agentName: "Pi",
        driver: "pi",
        runtimeMode: "full-access",
        status: "idle",
        unread: false,
        loaded: true,
        depth: 0,
        createdAt: now - 60_000,
        lastActive: now - 5_000,
      },
      {
        id: "s_child_live",
        title: "Refactor login module",
        titleLocked: true,
        parentId: "s_pip_1",
        cwd: "/Users/pip/code/pipi",
        agentId: "claude",
        agentName: "Claude Code",
        driver: "claude",
        runtimeMode: "full-access",
        status: "working",
        unread: false,
        loaded: true,
        depth: 1,
        createdAt: now - 30_000,
        lastActive: now - 1_000,
      },
    ]),
  });

  await app.waitFor("text:What are we building?");
  await app.press("id:sidebar-pip");
  await app.waitFor("text:Hey, what's up?");

  // Send a message that errors out ("outage") so the conversation opens and we test error delivery + waiting child session.
  await app.type("label:Message", "trigger outage");
  await app.submit("label:Message");
  await app.waitUntil(() => showsInChat(app, "The model returned an error"), { timeout: 20_000 });
  expect(showsInChat(app, "529 overloaded")).toBe(true);

  // Even after Pip's turn settled, the active child session keeps Pip's active avatar alive at the bottom.
  await app.waitFor("id:pip-active-avatar");
  await app.waitFor("id:pip-waiting-label");
  expect(app.shows("id:pip-typing-bubble")).toBe(false);
  expect(app.count("id:pip-working-label >> text:Waiting on 1 session")).toBeGreaterThan(0);
  await app.wait(200);
  const waitingLayout = app.layout("id:pip-working-label");
  for (let elapsed = 0; elapsed < 2000; elapsed += 16) {
    await app.wait(16);
    expect(app.layout("id:pip-working-label")).toEqual(waitingLayout);
    expect(app.viewStyle("id:pip-working-row")?.opacity).toBe(1);
  }
  await app.hover("id:pip-working-label");
  await app.waitFor("id:pip-status-card");
  expect(app.count("id:pip-status-card >> text:Waiting on 1 session")).toBeGreaterThan(0);
  expect(app.count("id:pip-status-card >> text:Refactor login module")).toBeGreaterThan(0);
  await app.hover("id:sidebar-pip");
  await app.wait(300);
  await app.press("id:pip-working-label");
  await app.waitFor("id:pip-status-child-s_child_live");
  await app.press("id:pip-status-child-s_child_live");
  await app.waitUntil(() => !app.shows("id:pip-status-card"));

  // Switch back to a normal coding session and verify full streaming + process header remain unchanged.
  await app.press("id:sidebar-new-session");
  await app.waitFor("text:What are we building?");
  await app.type("label:Message", "make a plan in steps");
  await app.submit("label:Message");
  await app.waitFor("text:Working");
  await app.waitUntil(() => showsInChat(app, "Reading package.json"), { timeout: 15_000 });
});

test("Pip SMS bubbles display malformed strong emphasis edge whitespace as bold text", async () => {
  const reply = [
    "Here are the directions:",
    "",
    "4. ** prototype 方向**",
    "5. **release 计划 **",
    "6. ** final 验收 **",
  ].join("\n");
  const app = await launch({
    "harness.scenario": "history",
    "harness.history": JSON.stringify([
      { role: "user", content: "show malformed emphasis", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: reply }], provider: "test", model: "test", timestamp: 2, stopReason: "stop" },
    ]),
  });
  await app.press("id:sidebar-pip");
  await app.waitUntil(() => showsInChat(app, "Here are the directions:"));

  expect(showsInChat(app, "** prototype 方向**")).toBe(false);
  expect(showsInChat(app, "**release 计划 **")).toBe(false);
  expect(showsInChat(app, "** final 验收 **")).toBe(false);
  expect(showsInChat(app, "prototype 方向")).toBe(true);
  expect(showsInChat(app, "release 计划")).toBe(true);
  expect(showsInChat(app, "final 验收")).toBe(true);
});

test("edited Pip messages expand older versions inline above the latest bubble without moving Edited", async () => {
  const versions = [
    { content: "## Version one\n\nFirst progress version with enough words to wrap into a compact bubble.", at: 1000 },
    { content: "## Version two\n\nSecond progress version, now closer to the latest answer.", at: 2000 },
    { content: "Latest answer.", at: 3000 },
  ];
  const history = [
    ...Array.from({ length: 14 }, (_, i) => [
      { role: "user", content: `Question ${i} with a little more text`, timestamp: i * 10 + 1 },
      { role: "assistant", content: [{ type: "text", text: `Answer ${i}` }], provider: "test", model: "test", timestamp: i * 10 + 2, stopReason: "stop" },
    ]).flat(),
    { role: "user", content: "Coordinate these tasks", timestamp: 200 },
    { role: "assistant", content: [{ type: "text", text: "Latest answer." }], provider: "test", model: "test", timestamp: 201, stopReason: "stop", editKey: "summary", versions },
  ];
  const app = await launch({ "harness.scenario": "history", "harness.history": JSON.stringify(history) });
  await app.press("id:sidebar-pip");
  await app.waitFor("id:pip-message-edited");
  await app.wait(200);
  const region = "id:pip-edit-history-region";
  const edited = "id:pip-message-edited";
  const above = "text:Question 13 with a little more text";
  const closedHeight = () => app.layout(region)?.height ?? 0;
  const waitClosed = () => app.waitUntil(() => closedHeight() <= 0.6, { timeout: 3000 });

  expect(closedHeight()).toBeLessThanOrEqual(0.6);
  await app.hover("text:Latest answer.");
  await app.wait(260);
  expect(closedHeight()).toBeLessThanOrEqual(0.6);
  const editedBefore = app.layout(edited)!;
  const aboveBefore = app.layout(above)!;

  await app.hover(edited);
  await app.waitFor(region);
  await app.wait(320);
  const editedOpen = app.layout(edited)!;
  const aboveOpen = app.layout(above)!;
  const first = app.layout("id:pip-edit-history-version >> nth=0")!;
  const second = app.layout("id:pip-edit-history-version >> nth=1")!;
  const bubble = app.layout("text:Latest answer.")!;
  expect(Math.abs(editedOpen.y - editedBefore.y)).toBeLessThanOrEqual(1);
  expect(aboveOpen.y).toBeLessThan(aboveBefore.y - 30);
  expect(first.y).toBeLessThan(second.y);
  expect(second.y + second.height).toBeLessThanOrEqual(bubble.y + 1);
  expect(app.viewStyle("id:pip-edit-history-version >> nth=0")?.opacity).toBeLessThan(0.6);
  expect(app.viewStyle("id:pip-edit-history-version >> nth=0")?.opacity).toBeGreaterThan(0.4);
  expect(app.viewStyle("text:Latest answer.")?.effectiveOpacity ?? 1).toBe(1);

  await app.hover("text:Latest answer.");
  await app.wait(260);
  expect(app.layout(region)?.height ?? 0).toBeGreaterThan(40);
  await app.hover(region);
  await app.wait(360);
  expect(app.layout(region)?.height ?? 0).toBeGreaterThan(40);
  await app.hover("id:sidebar-pip");
  await waitClosed();
  expect(Math.abs((app.layout(edited)?.y ?? 0) - editedBefore.y)).toBeLessThanOrEqual(0.75);
  expect(Math.abs((app.layout(above)?.y ?? 0) - aboveBefore.y)).toBeLessThanOrEqual(1);

  await app.press(edited);
  await app.waitFor(region);
  await app.wait(320);
  await app.hover("id:sidebar-pip");
  await app.wait(360);
  expect(app.layout(region)?.height ?? 0).toBeGreaterThan(40);
  await app.press(edited);
  await waitClosed();

});

test("long edited history is bounded, starts at the previous version, and scrolls to the oldest", async () => {
  const versions = Array.from({ length: 9 }, (_, i) => ({
    content: `## Progress version ${i}\n\n${"Earlier details in a bounded version bubble. ".repeat(10)}`,
    at: 1000 + i * 1000,
  }));
  const latest = "All tasks finished.\n\nReady for review.";
  versions[8].content = latest;
  const app = await launch({ "harness.scenario": "history", "harness.history": JSON.stringify([
    { role: "user", content: "Coordinate these tasks", timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: latest }], provider: "test", model: "test", timestamp: 2, stopReason: "stop", editKey: "summary", versions },
  ]) });
  await app.press("id:sidebar-pip");
  await app.waitFor("id:pip-message-edited");
  expect(app.count("id:pip-sms-bubble")).toBe(2);
  expect(textVisible(app, "Progress version 0")).toBe(false);

  await app.press("id:pip-message-edited");
  await app.waitFor("id:pip-edit-history-region");
  await app.wait(320);
  expect(app.count("id:pip-sms-bubble")).toBe(2);
  expect(app.layout("id:pip-edit-history-region")!.height).toBeLessThanOrEqual(296);
  expect(textVisible(app, "Progress version 7")).toBe(true);
  expect(textVisible(app, "Progress version 0")).toBe(false);
  await app.scroll("id:pip-edit-history", -4000);
  await app.waitUntil(() => textVisible(app, "Progress version 0"), { timeout: 3000 });
  expect(app.count("id:pip-sms-bubble")).toBe(2);
  await app.press("id:pip-message-edited");
  await app.waitUntil(() => (app.layout("id:pip-edit-history-region")?.height ?? 0) <= 0.6, { timeout: 3000 });
});

test("edit history expansion stays keyed to its own row across recycled list cells", async () => {
  const editVersions = (label: string, latest: string) => [
    { content: `## ${label} older\n\n${label} first text.`, at: 1000 },
    { content: latest, at: 2000 },
  ];
  const firstLatest = "First edited latest.";
  const secondLatest = "Second edited latest.";
  const history = [
    { role: "user", content: "first edited question", timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: firstLatest }], provider: "test", model: "test", timestamp: 2, stopReason: "stop", editKey: "first", versions: editVersions("First", firstLatest) },
    ...Array.from({ length: 18 }, (_, i) => [
      { role: "user", content: `middle question ${i}`, timestamp: 10 + i * 10 + 1 },
      { role: "assistant", content: [{ type: "text", text: `middle answer ${i}` }], provider: "test", model: "test", timestamp: 10 + i * 10 + 2, stopReason: "stop" },
    ]).flat(),
    { role: "user", content: "second edited question", timestamp: 300 },
    { role: "assistant", content: [{ type: "text", text: secondLatest }], provider: "test", model: "test", timestamp: 301, stopReason: "stop", editKey: "second", versions: editVersions("Second", secondLatest) },
  ];
  const app = await launch({ "harness.scenario": "history", "harness.history": JSON.stringify(history) });
  await app.press("id:sidebar-pip");
  await app.waitFor("text:second edited question");
  await app.waitFor("id:pip-message-edited");
  await app.press("id:pip-message-edited");
  await app.waitFor("text:Second first text.");
  await app.wait(320);

  for (let i = 0; i < 5; i++) await app.scroll("label:Conversation", -1200).catch(() => undefined);
  await app.waitFor("text:first edited question", { timeout: 5000 });
  expect(textVisible(app, "First first text.")).toBe(false);
  await app.press("id:pip-message-edited");
  await app.waitUntil(() => textVisible(app, "First first text."), { timeout: 3000 });
  expect(textVisible(app, "Second first text.")).toBe(false);

  for (let i = 0; i < 5; i++) await app.scroll("label:Conversation", 1200).catch(() => undefined);
  await app.waitFor("text:second edited question", { timeout: 5000 });
  expect(textVisible(app, "Second first text.")).toBe(true);
  await app.press("id:pip-message-edited");
});

test("Pip restores independent engine/model/thinking preferences and keeps them across /new and engine handoff", async () => {
  const app = await launch({
    "pipi.prefs.v1": JSON.stringify({
      defaultAgentId: "claude",
      personalAgentId: "pi",
      agentSessionChoices: { "persona:pi": { model: { provider: "openai", id: "gpt-5.1" }, thinkingLevel: "high" } },
    }),
  });
  await app.waitFor("text:Claude Code Default");
  await app.press("id:sidebar-pip");
  await app.waitFor("text:Hey, what's up?");
  await app.waitFor("text:GPT-5.1");
  expect(app.texts()).toContain("High");
  await app.type("label:Message", "hello Pip");
  await app.submit("label:Message");
  await app.waitFor("label:Send");
  await app.press("text:GPT-5.1");
  await app.press("text:Claude Sonnet 4.5");
  await app.waitUntil(() => !app.texts().includes("DeepSeek Chat"));
  await app.press("text:High");
  await app.press("text:Low");
  await app.waitFor("text:Low");
  await app.type("label:Message", "/new");
  await app.keyboard.press("escape");
  await app.submit("label:Message");
  await app.waitFor("text:Hey, what's up?");
  expect(app.texts()).toContain("Claude Sonnet 4.5");
  expect(app.texts()).toContain("Low");
  await app.press("id:agent-chip");
  await app.press("id:agent-picker >> text:Claude Code");
  await app.waitFor("text:Claude Code Default");
  expect(app.count("id:sidebar-pip")).toBe(1);
  await app.wait(500);
  const saved = JSON.parse(app.storage()["pipi.prefs.v1"]);
  expect(saved.personalAgentId).toBe("claude");
  expect(saved.defaultAgentId).toBe("claude");
  expect(saved.agentSessionChoices["persona:pi"].thinkingLevel).toBe("low");
  expect(saved.agentSessionChoices["persona:pi"].model.id).toBe("claude-sonnet-4-5");
  await app.press("id:agent-chip");
  await app.press("id:agent-picker >> text:Pi");
  await app.waitFor("text:Claude Sonnet 4.5");
  expect(app.texts()).toContain("Low");
  expect(app.count("id:sidebar-pip")).toBe(1);
  await app.wait(500);
  const cold = await launch({ "pipi.prefs.v1": app.storage()["pipi.prefs.v1"] });
  await cold.waitFor("text:Claude Code Default");
  await cold.press("id:sidebar-pip");
  await cold.waitFor("text:Hey, what's up?");
  await cold.waitFor("text:Claude Sonnet 4.5");
  expect(cold.texts()).toContain("Low");
});

test("switching Pip's engine during a run preserves the visible conversation and never creates a coding-session Pip", async () => {
  const app = await launch();
  await app.waitFor("text:What are we building?");
  await app.press("id:sidebar-pip");
  await app.waitFor("text:Hey, what's up?");
  await app.type("label:Message", "make a plan in steps");
  await app.submit("label:Message");
  await app.waitFor("id:pip-typing-bubble");
  await app.press("id:agent-chip");
  await app.press("id:agent-picker >> text:Claude Code");
  await app.waitFor("text:Claude Code Default");
  await app.waitFor("text:Switched agent from Pi to Claude Code");
  expect(showsInChat(app, "make a plan in steps")).toBe(true);
  expect(app.count("id:sidebar-pip")).toBe(1);
  await app.waitFor("label:Send");
  await app.type("label:Message", "continue Pip");
  await app.submit("label:Message");
  await app.waitFor("id:pip-typing-bubble");
});

const REVEAL_REPLY = "Alpha one.\n\nBeta two.\n\nGamma three.";
const orderOf = (app: App, parts: string[]) => {
  const texts = app.texts();
  return parts.map((part) => texts.indexOf(part));
};

test("a live multi-bubble Pip reply lands whole at once, in order, without a performed reveal", async () => {
  const app = await launch({ "harness.reply": REVEAL_REPLY });
  await app.press("id:sidebar-pip");
  await app.waitFor("text:Hey, what's up?");
  await app.type("label:Message", "plain reveal");
  await app.submit("label:Message");

  // The completed message lands as it is: every bubble present in the same commit,
  // in reading order, with no typing bubble performing a backlog and no hidden tail.
  await app.waitFor("text:Alpha one.");
  expect(app.count("id:pip-sms-bubble")).toBe(3);
  expect(showsInChat(app, "Beta two.")).toBe(true);
  expect(showsInChat(app, "Gamma three.")).toBe(true);
  const order = orderOf(app, ["Alpha one.", "Beta two.", "Gamma three."]);
  expect(order[0]).toBeLessThan(order[1]);
  expect(order[1]).toBeLessThan(order[2]);
  await app.waitFor("label:Copy reply");
  await app.waitUntil(() => !app.shows("id:pip-typing-bubble"));
});

test("a steering message lands after the reply it did not shape, in causal reading order", async () => {
  const app = await launch({ "harness.reply": REVEAL_REPLY });
  await app.press("id:sidebar-pip");
  await app.waitFor("text:Hey, what's up?");
  await app.type("label:Message", "plain cross reveal");
  await app.submit("label:Message");
  await app.waitFor("text:wait, one more thing");
  expect(showsInChat(app, "wait, one more thing")).toBe(true);

  // The reply answers the first message only: it lands whole, ahead of the steering note
  // that will shape the next turn. No rearrangement, no persisted crossing anchors.
  await app.waitFor("text:Alpha one.");
  expect(app.count("id:pip-sms-bubble")).toBe(3);
  const order = orderOf(app, ["plain cross reveal", "Alpha one.", "Beta two.", "Gamma three.", "wait, one more thing"]);
  expect(order[0]).toBeLessThan(order[1]);
  expect(order[1]).toBeLessThan(order[2]);
  expect(order[2]).toBeLessThan(order[3]);
  expect(order[3]).toBeLessThan(order[4]);
  expect(app.storage()["pipi.interleaves.v1"]).toBeUndefined();
});

test("history and Reduced Motion render every Pip bubble at once in order", async () => {
  const history = await launch({
    "harness.scenario": "history",
    "harness.history": JSON.stringify([
      { role: "user", content: "plain reveal", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: REVEAL_REPLY }], provider: "test", model: "test", timestamp: 2, stopReason: "stop" },
    ]),
  });
  await history.press("id:sidebar-pip");
  await history.waitFor("text:Alpha one.");
  expect(history.count("id:pip-sms-bubble")).toBe(3);
  expect(history.shows("id:pip-typing-bubble")).toBe(false);

  const reduced = await open("./Harness.tsx", {
    width: 1180,
    height: 1100,
    platform: "macos",
    locale: "en-US",
    clock: {},
    reducedMotion: true,
    storage: { "harness.scenario": "stream", "harness.reply": REVEAL_REPLY },
  });
  await reduced.press("id:sidebar-pip");
  await reduced.waitFor("text:Hey, what's up?");
  await reduced.type("label:Message", "plain reveal");
  await reduced.submit("label:Message");
  await reduced.waitFor("text:Alpha one.");
  expect(reduced.count("id:pip-sms-bubble")).toBe(3);
  await reduced.wait(500);
  expect(reduced.shows("id:pip-typing-bubble")).toBe(false);
});

test("leaving Pip and returning shows every bubble statically", async () => {
  const app = await launch({ "harness.reply": REVEAL_REPLY });
  await app.press("id:sidebar-pip");
  await app.waitFor("text:Hey, what's up?");
  await app.type("label:Message", "plain reveal");
  await app.submit("label:Message");
  await app.waitFor("text:Alpha one.");
  expect(app.count("id:pip-sms-bubble")).toBe(3);

  await app.press("id:sidebar-recents >> text:Refactor the transcript reducer");
  await app.waitFor("label:Conversation");
  await app.press("id:sidebar-pip");
  await app.waitFor("text:Alpha one.");
  expect(app.count("id:pip-sms-bubble")).toBe(3);
  expect(showsInChat(app, "Beta two.")).toBe(true);
  expect(showsInChat(app, "Gamma three.")).toBe(true);
  expect(app.shows("id:pip-typing-bubble")).toBe(false);
});

