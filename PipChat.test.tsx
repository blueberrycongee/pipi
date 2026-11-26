import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

// Pip (Personal Agent, persona: true) non-streaming IM interaction + avatar hover live status:
//
//   nsh test PipChat.test.tsx
//
// Verifies that:
// 1. While Pip is thinking, calling tools, and streaming text, the main conversation stays clean
//    (no streaming half-sentences, no "Working" header, no tool log wall).
// 2. A quiet active Pip avatar appears at the bottom; hovering it reveals a real-time status card
//    describing what Pip is doing right now (and any active child sessions).
// 3. When Pip finishes a turn, the complete message lands cleanly as an IM message with Pip's
//    avatar (which shares the same hover status card) and a quiet collapsed process disclosure.
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

  // While Pip is working: wait until the active Pip avatar + iMessage typing bubble are visible, then sample frames through the run.
  await app.waitFor("id:pip-active-avatar");
  await app.waitFor("id:pip-typing-bubble");
  let hoveredDuringRun = false;
  let sawLiveCard = false;
  let sawLivePhase = false;
  let sawTypingBubbleDuringRun = false;
  let sawReadReceiptDuringRun = false;
  let sawToolWallDuringRun = false;
  let sawCommentaryDuringRun = false;
  let sawWorkingHeaderDuringRun = false;

  for (let elapsed = 0; elapsed < 60_000; elapsed += 16) {
    const stillRunning = !app.shows("label:Send");
    if (stillRunning) {
      if (app.shows("id:pip-typing-bubble")) sawTypingBubbleDuringRun = true;
      if (app.shows("id:sms-receipt")) sawReadReceiptDuringRun = true;
      if (showsInChat(app, "Working")) sawWorkingHeaderDuringRun = true;
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

  // Main chat stream stayed completely clean during Pip's run while showing the SMS typing bubble & read receipt.
  expect(sawTypingBubbleDuringRun).toBe(true);
  expect(sawReadReceiptDuringRun).toBe(true);
  expect(sawWorkingHeaderDuringRun).toBe(false);
  expect(sawToolWallDuringRun).toBe(false);
  expect(sawCommentaryDuringRun).toBe(false);

  // Hovering the active Pip avatar surfaced the live status card with real-time state.
  expect(sawLiveCard).toBe(true);
  expect(sawLivePhase).toBe(true);

  // Move pointer away so the working hover card dismisses cleanly.
  await app.hover("id:sidebar-pip");
  await app.wait(300);

  // Once settled, the typing bubble disappears and the reply lands as iMessage SMS bubbles alongside Pip's avatar.
  // The stream itself carries no process pill: it stays clean, the steps stay hidden until opened from the avatar's card.
  await app.waitUntil(() => showsInChat(app, "Everything else is as it was, and the tests pass."), { timeout: 10_000 });
  expect(app.shows("id:pip-typing-bubble")).toBe(false);
  expect(app.count("id:pip-sms-bubble")).toBeGreaterThanOrEqual(1);
  expect(app.count("id:pip-message-avatar")).toBeGreaterThanOrEqual(1);
  expect(app.count("id:pip-process-toggle")).toBe(0);
  expect(showsInChat(app, "The list follows by hand. Let me check the tests before changing it.")).toBe(false);

  // Hovering the delivered message's Pip avatar opens the consistent status card (idle + turn summary),
  // which carries the one door to the turn's process.
  await app.hover("id:pip-message-avatar");
  await app.waitFor("id:pip-status-card");
  expect(app.count("id:pip-status-card >> text:Ready")).toBeGreaterThan(0);

  // Pressing it unfolds the process into the stream while the card stays open; pressing it again folds it back.
  await app.press("id:pip-process-toggle");
  await app.waitUntil(() => showsInChat(app, "The list follows by hand. Let me check the tests before changing it."));
  await app.press("id:pip-process-toggle");
  await app.waitUntil(() => !showsInChat(app, "The list follows by hand. Let me check the tests before changing it."));
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

test("edited Pip messages show only the latest SMS bubbles, with bounded scrollable version history", async () => {
  const versions = Array.from({ length: 9 }, (_, i) => ({ content: `Progress version ${i}\n${"Earlier details. ".repeat(15)}`, at: 1000 + i * 1000 }));
  const latest = "All tasks finished.\n\nReady for review.";
  versions[8].content = latest;
  const app = await launch({ "harness.scenario": "history", "harness.history": JSON.stringify([
    { role: "user", content: "Coordinate these tasks", timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: latest }], provider: "test", model: "test", timestamp: 2, stopReason: "stop", editKey: "summary", versions },
  ]) });
  await app.waitFor("id:sidebar-pip");
  await app.press("id:sidebar-pip");
  await app.waitFor("id:pip-message-edited");
  expect(app.count("id:pip-sms-bubble")).toBe(2);
  expect(app.shows(`text:${versions[0].content}`)).toBe(false);
  expect(app.shows("id:pip-edit-history")).toBe(false);
  await app.press("id:pip-message-edited");
  await app.waitFor("id:pip-edit-history");
  expect(app.count("id:pip-sms-bubble")).toBe(2);
  expect(app.count(`id:pip-edit-history >> text:${versions[7].content}`)).toBeGreaterThan(0);
  await app.scroll("id:pip-edit-history", -4000);
  expect(app.count(`id:pip-edit-history >> text:${versions[0].content}`)).toBeGreaterThan(0);
  await app.keyboard.press("escape");
  expect(app.count("id:pip-sms-bubble")).toBe(2);
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
