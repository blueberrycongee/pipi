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

  // While Pip is working: wait until the active Pip avatar is visible, then sample frames through the run.
  await app.waitFor("id:pip-active-avatar");
  let hoveredDuringRun = false;
  let sawLiveCard = false;
  let sawLivePhase = false;
  let sawToolWallDuringRun = false;
  let sawCommentaryDuringRun = false;
  let sawWorkingHeaderDuringRun = false;

  for (let elapsed = 0; elapsed < 60_000; elapsed += 16) {
    const stillRunning = !app.shows("label:Send");
    if (stillRunning) {
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

  // Main chat stream stayed completely clean during Pip's run.
  expect(sawWorkingHeaderDuringRun).toBe(false);
  expect(sawToolWallDuringRun).toBe(false);
  expect(sawCommentaryDuringRun).toBe(false);

  // Hovering the active Pip avatar surfaced the live status card with real-time state.
  expect(sawLiveCard).toBe(true);
  expect(sawLivePhase).toBe(true);

  // Move pointer away so the working hover card dismisses cleanly.
  await app.hover("id:sidebar-pip");
  await app.wait(300);

  // Once settled, the complete IM message lands whole alongside Pip's message avatar.
  // The stream itself carries no process pill: it stays clean, the steps stay hidden.
  await app.waitUntil(() => showsInChat(app, "Everything else is as it was, and the tests pass."), { timeout: 10_000 });
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
  await app.hover("id:pip-active-avatar");
  await app.waitFor("id:pip-status-card");
  expect(app.count("id:pip-status-card >> text:Waiting on 1 session")).toBeGreaterThan(0);
  expect(app.count("id:pip-status-card >> text:Refactor login module")).toBeGreaterThan(0);

  // Switch back to a normal coding session and verify full streaming + process header remain unchanged.
  await app.press("id:sidebar-new-session");
  await app.waitFor("text:What are we building?");
  await app.type("label:Message", "make a plan in steps");
  await app.submit("label:Message");
  await app.waitFor("text:Working");
  await app.waitUntil(() => showsInChat(app, "Reading package.json"), { timeout: 15_000 });
});
