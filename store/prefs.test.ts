// Per-field reactivity isolation and no-op write guards for `store/prefs.ts`.
//
//   nsh test store/prefs.test.ts
import { effect, Storage } from "nsh";
import { expect, test } from "nsh/test";
import {
  archivedSessions,
  collapsedWorkspaces,
  docRankOverrides,
  docsFolder,
  isGroupCollapsed,
  isSessionArchived,
  isWorkspaceCollapsed,
  lastActiveWorkspace,
  loadPrefs,
  recentRankOverrides,
  recentWorkspaces,
  rememberWorkspace,
  sessionRankOverrides,
  setDocRankOverrides,
  setDocsFolderPref,
  setGroupCollapsed,
  setOpenTabs,
  setSessionArchived,
  setWorkspaceCollapsed,
  storedOpenTabs,
} from "./prefs";

function track<T>(read: () => T) {
  let runs = 0;
  effect(() => {
    read();
    runs++;
  });
  return {
    get runs() {
      return runs;
    },
    reset() {
      runs = 0;
    },
  };
}

test("setOpenTabs isolates unrelated pref slices and skips identical writes", () => {
  const workspaces = track(() => recentWorkspaces());
  const collapsedWs = track(() => collapsedWorkspaces());
  const wsCollapsed = track(() => isWorkspaceCollapsed("/Users/pip/code/pipi"));
  const groupCollapsed = track(() => isGroupCollapsed("recents"));
  const archived = track(() => archivedSessions());
  const sessionArchived = track(() => isSessionArchived("/sessions/one.jsonl"));
  const recentRanks = track(() => recentRankOverrides());
  const sessionRanks = track(() => sessionRankOverrides("/Users/pip/code/pipi"));
  const docRanks = track(() => docRankOverrides());
  const docs = track(() => docsFolder());
  const tabs = track(() => storedOpenTabs());

  // Reset after initial synchronous subscription runs.
  for (const probe of [workspaces, collapsedWs, wsCollapsed, groupCollapsed, archived, sessionArchived, recentRanks, sessionRanks, docRanks, docs, tabs]) {
    probe.reset();
  }

  setOpenTabs([{ kind: "chat", ref: "/sessions/one.jsonl", file: "/sessions/one.jsonl" }]);
  expect(tabs.runs).toBe(1);
  expect(workspaces.runs).toBe(0);
  expect(collapsedWs.runs).toBe(0);
  expect(wsCollapsed.runs).toBe(0);
  expect(groupCollapsed.runs).toBe(0);
  expect(archived.runs).toBe(0);
  expect(sessionArchived.runs).toBe(0);
  expect(recentRanks.runs).toBe(0);
  expect(sessionRanks.runs).toBe(0);
  expect(docRanks.runs).toBe(0);
  expect(docs.runs).toBe(0);

  // Writing the exact same tab list is a no-op.
  tabs.reset();
  setOpenTabs([{ kind: "chat", ref: "/sessions/one.jsonl", file: "/sessions/one.jsonl" }]);
  expect(tabs.runs).toBe(0);
});

test("rememberWorkspace skips no-op writes and isolates unrelated slices", () => {
  const workspaces = track(() => recentWorkspaces());
  const activeWs = track(() => lastActiveWorkspace());
  const archived = track(() => archivedSessions());
  const docRanks = track(() => docRankOverrides());
  const tabs = track(() => storedOpenTabs());

  rememberWorkspace("/Users/pip/code/pipi");
  for (const probe of [workspaces, activeWs, archived, docRanks, tabs]) probe.reset();

  // Calling rememberWorkspace again for the already-listed active workspace does nothing.
  rememberWorkspace("/Users/pip/code/pipi");
  expect(workspaces.runs).toBe(0);
  expect(activeWs.runs).toBe(0);
  expect(archived.runs).toBe(0);
  expect(docRanks.runs).toBe(0);
  expect(tabs.runs).toBe(0);

  // Switching active workspace to another already-listed folder leaves workspaces array untouched.
  rememberWorkspace("/Users/pip/code/nsh");
  workspaces.reset();
  activeWs.reset();
  archived.reset();
  docRanks.reset();
  rememberWorkspace("/Users/pip/code/pipi");
  expect(workspaces.runs).toBe(0);
  expect(activeWs.runs).toBe(1);
  expect(archived.runs).toBe(0);
  expect(docRanks.runs).toBe(0);
});

test("collapse, archive, and docs prefs only notify their own subscribers", () => {
  const wsCollapsed = track(() => isWorkspaceCollapsed("/Users/pip/code/pipi"));
  const groupCollapsed = track(() => isGroupCollapsed("docs"));
  const archived = track(() => isSessionArchived("/sessions/one.jsonl"));
  const docRanks = track(() => docRankOverrides());
  const docs = track(() => docsFolder());

  for (const probe of [wsCollapsed, groupCollapsed, archived, docRanks, docs]) probe.reset();

  setWorkspaceCollapsed("/Users/pip/code/pipi", true);
  expect(wsCollapsed.runs).toBe(1);
  expect(groupCollapsed.runs).toBe(0);
  expect(archived.runs).toBe(0);
  expect(docRanks.runs).toBe(0);
  expect(docs.runs).toBe(0);

  // No-op collapse does not notify.
  wsCollapsed.reset();
  setWorkspaceCollapsed("/Users/pip/code/pipi", true);
  expect(wsCollapsed.runs).toBe(0);

  // Group collapse, archive, doc ranks, and docs folder each stay isolated.
  setGroupCollapsed("docs", true);
  expect(groupCollapsed.runs).toBe(1);
  expect(wsCollapsed.runs).toBe(0);
  expect(archived.runs).toBe(0);

  setSessionArchived("/sessions/one.jsonl", true, "/Users/pip/code/pipi");
  expect(archived.runs).toBe(1);
  expect(docRanks.runs).toBe(0);
  expect(docs.runs).toBe(0);

  setDocRankOverrides({ "/docs/a.md": 100 });
  expect(docRanks.runs).toBe(1);
  expect(docs.runs).toBe(0);

  setDocsFolderPref("/tmp/custom-docs");
  expect(docs.runs).toBe(1);
  docs.reset();
  setDocsFolderPref("/tmp/custom-docs/");
  expect(docs.runs).toBe(0);
});

test("a pipi task worktree is remembered as its owning repository, never as a project", () => {
  rememberWorkspace("/Users/pip/code/.pipi-worktrees/pipi/pip-task-abcd");
  expect(recentWorkspaces()).toContain("/Users/pip/code/pipi");
  expect(recentWorkspaces().some((path) => path.includes("/.pipi-worktrees/"))).toBe(false);
  expect(lastActiveWorkspace()).toBe("/Users/pip/code/pipi");

  setSessionArchived("/sessions/worktree.jsonl", true, "/Users/pip/code/.pipi-worktrees/pipi/pip-task-abcd");
  expect(archivedSessions()["/sessions/worktree.jsonl"]?.cwd).toBe("/Users/pip/code/pipi");
});

test("stored workspaces are hydrated with historical pipi-worktrees pollution cleaned", async () => {
  await Storage.setItem(
    "pipi.prefs.v1",
    JSON.stringify({
      workspaces: [
        "/Users/pip/code/pipi",
        "/Users/pip/code/.pipi-worktrees/pipi/pip-old-ghost",
        "/Users/pip/code/.pipi-worktrees/nsh/nsh-0-7-1-g553o",
        "/Users/pip/code/.pipi-worktrees/malformed",
        "/Users/pip/code/real-project",
      ],
      activeWorkspace: "/Users/pip/code/.pipi-worktrees/pipi/pip-old-ghost",
      collapsedWorkspaces: ["/Users/pip/code/.pipi-worktrees/nsh/nsh-0-7-1-g553o"],
      sessionRanks: {
        "/Users/pip/code/.pipi-worktrees/pipi/pip-old-ghost": { "/sessions/a.jsonl": 10 },
      },
      archivedSessions: {
        "/sessions/archived.jsonl": { archivedAt: 1, cwd: "/Users/pip/code/.pipi-worktrees/pipi/pip-old-ghost" },
      },
    }),
  );
  await loadPrefs();
  expect(recentWorkspaces()).toEqual(["/Users/pip/code/pipi", "/Users/pip/code/nsh", "/Users/pip/code/real-project"]);
  expect(lastActiveWorkspace()).toBe("/Users/pip/code/pipi");
  expect(collapsedWorkspaces()).toEqual(["/Users/pip/code/nsh"]);
  expect(archivedSessions()["/sessions/archived.jsonl"]?.cwd).toBe("/Users/pip/code/pipi");
  expect(sessionRankOverrides("/Users/pip/code/pipi")["/sessions/a.jsonl"]).toBe(10);
  expect(recentWorkspaces().some((path) => path.includes("/.pipi-worktrees/"))).toBe(false);
  const persisted = JSON.parse((await Storage.getItem("pipi.prefs.v1")) ?? "{}");
  expect(persisted.workspaces).toEqual(["/Users/pip/code/pipi", "/Users/pip/code/nsh", "/Users/pip/code/real-project"]);
  expect(JSON.stringify(persisted).includes("/.pipi-worktrees/")).toBe(false);
});
