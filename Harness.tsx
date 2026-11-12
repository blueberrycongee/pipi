// The app on a scripted Pi (dev/fake-pi.ts): what the headless tests open, and
// a way to see any state without a model provider:
//
//   nsh dev Harness.tsx
//
// The scenario comes from storage (`harness.scenario`), which tests set:
// "welcome" (default), "history", "connect" (no provider), "failed", "slow",
// "multi" (several projects), "multi-slow" (the same, with paced records), and
// "stream" (150ms between records: a run that is still going when a test looks).
// `harness.startDelay` (ms) makes agents start and load sessions as slowly as real CLIs.
import { mount, Storage } from "nsh";
import { fakeBackend, sampleHistory } from "./dev/fake-pi";
import { boot, showSettings, type SettingsSection } from "./store/app";
import { useBackend } from "./store/backend";
import { Shell } from "./views/Shell";

const now = Date.now();
const sessions = [
  { path: "/sessions/one.jsonl", id: "1", firstMessage: "Look around and tell me what this project is", messageCount: 5, created: now - 60_000, modified: now - 60_000 },
  { path: "/sessions/two.jsonl", id: "2", name: "Refactor the transcript reducer", firstMessage: "", messageCount: 18, created: now - 4 * 3_600_000, modified: now - 3 * 3_600_000 },
  // One session per engine, so the sidebar's engine line has more than Pi to draw.
  { path: "/sessions/three.jsonl", id: "3", firstMessage: "Why does the build fail on Linux?", messageCount: 9, created: now - 30 * 3_600_000, modified: now - 30 * 3_600_000, agentId: "claude" },
  { path: "/sessions/four.jsonl", id: "4", name: "Release notes for 0.1", firstMessage: "", messageCount: 6, created: now - 9 * 86_400_000, modified: now - 9 * 86_400_000, agentId: "dsh" },
];

const workspaceSessions = {
  "/Users/pip/code/pipi": sessions,
  "/Users/pip/code/nsh": [
    { path: "/sessions/nsh-1.jsonl", id: "n1", name: "Fix QuickJS GC mark phase", firstMessage: "", messageCount: 14, created: now - 15 * 60_000, modified: now - 15 * 60_000 },
    { path: "/sessions/nsh-2.jsonl", id: "n2", firstMessage: "Benchmark native list recycling", messageCount: 7, created: now - 5 * 3_600_000, modified: now - 5 * 3_600_000 },
  ],
  "/Users/pip/code/pi-docs": [],
};

Storage.getItem("harness.scenario").then(async (scenario) => {
  const startDelay = Number((await Storage.getItem("harness.startDelay")) ?? 0);
  const reply = (await Storage.getItem("harness.reply")) || undefined;
  if (scenario === "multi" || scenario === "multi-slow") {
    const existing = await Storage.getItem("pipi.prefs.v1");
    if (!existing) {
      await Storage.setItem(
        "pipi.prefs.v1",
        JSON.stringify({
          workspaces: ["/Users/pip/code/pipi", "/Users/pip/code/nsh", "/Users/pip/code/pi-docs"],
          activeWorkspace: "/Users/pip/code/pipi",
          collapsedWorkspaces: [],
          sidebarOpen: true,
        }),
      );
    }
  }
  useBackend(
    fakeBackend({
      noModels: scenario === "connect",
      failStart: scenario === "failed",
      history: scenario === "history" ? sampleHistory() : [],
      sessions: scenario === "connect" || scenario === "failed" ? [] : sessions,
      workspaceSessions: scenario === "multi" || scenario === "multi-slow" ? workspaceSessions : undefined,
      pickedFolder: "/Users/pip/code/new-app",
      pace: scenario === "slow" ? 400 : scenario === "stream" || scenario === "multi-slow" ? 150 : 0,
      startDelay,
      reply,
    }),
  );
  void boot();
  // "harness.settings": open Settings on this section shortly after mount, so a
  // test can photograph the page entrance mid-animation.
  const section = await Storage.getItem("harness.settings");
  if (section) setTimeout(() => showSettings(section as SettingsSection), 600);
});

mount(Shell);
