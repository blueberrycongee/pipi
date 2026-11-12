import { expect, open, test } from "nsh/test";
import type { OpenOptions } from "nsh/test";

/** Opens the app on the scripted Pi (Harness.tsx) as a desktop window. */
const launch = (scenario = "welcome", options: OpenOptions = {}) =>
  open("./Harness.tsx", { width: 1180, height: 780, platform: "macos", locale: "en-US", storage: { "harness.scenario": scenario }, ...options });

test("greets with Pip and lists the folder's sessions", async () => {
  const app = await launch();
  await app.waitFor("text:What are we building?");
  expect(app.count("label:pipi")).toBeGreaterThan(0);
  expect(app.texts()).toContain("Refactor the transcript reducer");
  expect(app.texts()).not.toContain("Today");
  expect(app.texts()).toContain("Claude Sonnet 4.5");
});

test("streams a run: thinking, a tool call, then the reply", async () => {
  const app = await launch();
  await app.waitFor("text:What are we building?");
  await app.type("label:Message", "make a plan");
  await app.submit("label:Message");
  await app.waitFor("text:make a plan");
  await app.waitFor("text:Steps");
  // Once the answer is known, the turn's process folds under its header.
  await app.waitFor("text:Send", { timeout: 200 }).catch(() => undefined);
  await app.waitFor("label:Send");
  expect(app.count("label:Stop")).toBe(0);
  expect(app.texts()).not.toContain("package.json");
  // The header unfolds its grouped process; unfolding the group shows the reasoning and the tool call in order.
  await app.press("text:Finished in under 1 second");
  await app.waitFor("text:Read package.json");
  expect(app.texts()).not.toContain("View reasoning");
  await app.press("text:Read package.json");
  await app.waitFor("text:View reasoning");
  await app.waitFor("text:package.json");
});

test("a turn's process unfolds to its prose and grouped tool calls, and a call to its output", async () => {
  const app = await launch("history");
  await app.waitFor("text:Here is the plan.");
  expect(app.texts()).not.toContain("ls -la");
  expect(app.texts()).not.toContain("App.tsx\nnsh.json\npackage.json");
  // The turn's header unfolds its process: what it wrote on the way, and its calls as one row.
  await app.press("text:Finished in under 1 second");
  await app.waitFor("text:Let me take a look around.");
  // The row of calls unfolds to each call, and a call to its output.
  await app.press("text:Ran ls, Read package.json");
  await app.waitFor("text:ls -la");
  await app.press("text:ls -la");
  await app.waitFor("text:App.tsx\nnsh.json\npackage.json");
});

test("pastes a screenshot and copied files as attachments, not paths", async () => {
  const pngBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  // Copied local files are `file:` URLs the app reads itself: the read is stubbed.
  const app = await launch("welcome", {
    modules: { "fs/promises": { readFile: (path: string) => (path.endsWith(".png") ? pngBytes : new Uint8Array([104, 101, 108, 108, 111])) } },
  });
  await app.waitFor("text:What are we building?");

  // A screenshot paste brings its bytes: a thumbnail in the tray, nothing in the text.
  await app.paste("label:Message", { files: ["icon.png"] });
  await app.waitFor("label:icon.png");
  expect(app.value("label:Message") ?? "").toBe("");

  // An image copied in a file manager arrives as a file: URL — it attaches too,
  // rather than turning into a path in the input.
  await app.press("label:Remove image");
  await app.paste("label:Message", { uris: ["file:///Users/pip/shot.png"], text: "/Users/pip/shot.png" });
  await app.waitFor("label:shot.png");
  expect(app.value("label:Message") ?? "").toBe("");

  // A copied non-image file goes in as its path: a reference the agent reads with tools.
  await app.paste("label:Message", { uris: ["file:///Users/pip/notes.txt"], text: "file:///Users/pip/notes.txt" });
  await app.waitUntil(() => app.value("label:Message") === "/Users/pip/notes.txt");

  // Plain text still pastes as text.
  await app.clear("label:Message");
  await app.paste("label:Message", { text: "two\nlines" });
  await app.waitUntil(() => app.value("label:Message") === "two\nlines");
});

test("switches sessions and starts a new one", async () => {
  const app = await launch();
  await app.waitFor("text:What are we building?");
  await app.press("id:sidebar-workspaces >> text:Refactor the transcript reducer");
  await app.waitFor("text:Here is the plan.");
  await app.press("id:sidebar-new-session");
  await app.waitFor("text:What are we building?");
});

test("without a provider, leads to the agent's providers and connects one", async () => {
  const app = await launch("connect");
  await app.waitFor("text:Connect a model to begin");
  await app.press("text:Configure Pi");
  await app.waitFor("text:Anthropic");
  await app.press("text:Add Key >> nth=0");
  await app.type("label:Anthropic API key", "sk-ant-test");
  await app.press("text:Save");
  await app.waitFor("text:Key saved. The provider's models are ready.");
  expect(app.texts().some((text) => text.startsWith("API key · "))).toBe(true);
});

test("Settings keeps the same sections whichever agent is active; Pi's providers sit under Agents", async () => {
  const app = await launch();
  await app.waitFor("text:What are we building?");
  const sections = ["general", "agents", "archive", "usage", "about"];
  const shown = () => sections.map((id) => app.count(`id:settings-nav-${id}`));

  // On Pi: no section of its own; its providers open from its row and lead back to the list.
  await app.press("label:Settings");
  await app.waitFor("id:settings-nav-agents");
  expect(shown()).toEqual([1, 1, 1, 1, 1]);
  expect(app.count("id:settings-nav-providers")).toBe(0);
  await app.press("id:settings-nav-agents");
  await app.waitFor("text:Coding Agent Harnesses");
  await app.press("text:Providers");
  await app.waitFor("text:Anthropic");
  expect(app.texts()).toContain("Steering messages");
  await app.press("id:settings-back");
  await app.waitFor("text:Coding Agent Harnesses");
  await app.press("label:Settings");
  await app.waitUntil(() => app.count("id:settings-nav-agents") === 0);

  // On another agent: the same sections, and Pi's keys still there to manage.
  await app.press("id:agent-chip");
  await app.press("id:agent-picker >> text:Claude Code");
  await app.waitFor("text:Claude Code Default");
  await app.press("label:Settings");
  await app.waitFor("id:settings-nav-agents");
  expect(shown()).toEqual([1, 1, 1, 1, 1]);
  await app.press("id:settings-nav-agents");
  await app.waitFor("text:Coding Agent Harnesses");
  await app.press("text:Providers");
  await app.waitFor("text:Anthropic");
  // The run knobs belong to a running Pi session: here they give way to the switch.
  expect(app.texts()).not.toContain("Steering messages");
  expect(app.texts()).toContain("Switch to Pi");
});

test("changes the model from the composer", async () => {
  const app = await launch();
  await app.waitFor("text:What are we building?");
  await app.press("text:Claude Sonnet 4.5");
  await app.press("text:GPT-5.1");
  // The list closes, and the chip names the model Pi switched to.
  await app.waitUntil(() => !app.texts().includes("DeepSeek Chat"));
  expect(app.texts()).toContain("GPT-5.1");
  expect(app.texts()).not.toContain("Claude Sonnet 4.5");
});

test("remembers the chosen model and thinking depth for the next session", async () => {
  const app = await launch();
  await app.waitFor("text:What are we building?");
  // Pick a different model and a deeper thinking level.
  await app.press("text:Claude Sonnet 4.5");
  await app.press("text:GPT-5.1");
  await app.waitUntil(() => !app.texts().includes("DeepSeek Chat"));
  await app.press("text:Medium");
  await app.press("text:High");
  await app.waitUntil(() => app.texts().includes("High"));
  // A fresh session opens on the engine's own default; pipi puts the picks back.
  await app.press("id:sidebar-new-session");
  await app.waitFor("text:What are we building?");
  await app.waitUntil(() => app.texts().includes("GPT-5.1"));
  expect(app.texts()).toContain("High");
  expect(app.texts()).not.toContain("Claude Sonnet 4.5");
});

test("restores the last picks on the fresh session of a relaunch", async () => {
  const app = await open("./Harness.tsx", {
    width: 1180,
    height: 780,
    platform: "macos",
    locale: "en-US",
    storage: {
      "harness.scenario": "welcome",
      "pipi.prefs.v1": JSON.stringify({
        agentSessionChoices: { pi: { model: { provider: "openai", id: "gpt-5.1" }, thinkingLevel: "high" } },
      }),
    },
  });
  await app.waitFor("text:What are we building?");
  await app.waitUntil(() => app.texts().includes("GPT-5.1"));
  expect(app.texts()).toContain("High");
  expect(app.texts()).not.toContain("Claude Sonnet 4.5");
});

test("says so when Pi cannot start, and offers a restart", async () => {
  const app = await launch("failed");
  await app.waitFor("text:Pi could not start");
  expect(app.texts()).toContain("spawn node ENOENT");
  expect(app.texts()).toContain("Restart Pi");
});

test("follows a Chinese system locale and switches language live in Settings", async () => {
  const zhApp = await launch("welcome", { locale: "zh-Hans-CN" });
  await zhApp.waitFor("text:今天要构建什么？");
  expect(zhApp.texts()).toContain("工作区");
  expect(zhApp.count("label:设置")).toBeGreaterThan(0);

  const app = await launch("welcome");
  await app.waitFor("text:What are we building?");
  await app.press("label:Settings");
  await app.waitFor("text:General >> nth=0");
  await app.waitFor("text:Language");
  expect(app.texts()).toContain("Wallpaper");
  expect(app.texts()).toContain("Wallpaper folder");
  await app.press("text:中文");
  await app.waitFor("text:语言");
  expect(app.texts()).toContain("主题");
  expect(app.texts()).toContain("壁纸");
  expect(app.texts()).toContain("壁纸文件夹");
  expect(app.texts()).toContain("智能体");
  await app.keyboard.press("escape");
  await app.waitFor("text:今天要构建什么？");
});

test("organizes multiple projects in the sidebar and opens sessions across workspaces", async () => {
  const app = await launch("multi");
  await app.waitFor("text:What are we building?");
  // All three project workspaces appear in the sidebar tree with their sessions
  expect(app.texts()).toContain("pipi");
  expect(app.texts()).toContain("nsh");
  expect(app.texts()).toContain("pi-docs");
  expect(app.texts()).toContain("Fix QuickJS GC mark phase");

  // Clicking a session under another project switches workspaces and loads that session
  await app.press("id:sidebar-workspaces >> text:Fix QuickJS GC mark phase");
  await app.waitFor("text:Here is the plan.");
  expect(app.texts()).toContain("Fix QuickJS GC mark phase");

  // Collapsing a project hides its sessions in the workspace group (最近 keeps its own
  // copy of recent sessions) and shows its count badge while keeping siblings intact
  await app.press("label:Collapse pipi");
  await app.waitUntil(() => app.count("id:sidebar-workspaces >> text:Refactor the transcript reducer") === 0);
  expect(app.texts()).toContain("4");
  expect(app.texts()).toContain("Benchmark native list recycling");

  // Collapsing and re-expanding a subsequent project folder also updates cleanly
  await app.press("label:Collapse nsh");
  await app.waitUntil(() => app.count("id:sidebar-workspaces >> text:Benchmark native list recycling") === 0);
  expect(app.texts()).toContain("2");
  await app.press("label:Expand nsh");
  await app.waitFor("text:Benchmark native list recycling");

  await app.press("label:Expand pipi");
  await app.waitFor("text:Refactor the transcript reducer");

  // Starting a new session directly inside another workspace switches to it cleanly
  await app.press("label:New session in pi-docs");
  await app.waitFor("text:Pi · ~/code/pi-docs");

  // Adding a new project folder adds it to the sidebar tree and opens it
  await app.press("label:Add project folder");
  await app.waitFor("text:Pi · ~/code/new-app");
  expect(app.texts()).toContain("new-app");

  // The 工作区 group folds as a unit while 最近 stays open underneath it
  await app.press("label:Collapse Workspaces");
  await app.waitUntil(() => !app.texts().includes("pi-docs"));
  expect(app.texts()).toContain("Recent");
  expect(app.texts()).toContain("Fix QuickJS GC mark phase");
  await app.press("label:Expand Workspaces");
  await app.waitFor("text:pi-docs");
});

test("renames from the title bar: a press outside commits, Escape cancels", async () => {
  const app = await launch("history");
  await app.waitFor("text:Here is the plan.");

  // Open the inline rename from the title and type a new name.
  await app.press("id:session-title");
  await app.waitFor("label:Session name");
  await app.clear("label:Session name");
  await app.type("label:Session name", "Renamed session");

  // A press outside the field commits it.
  await app.press("label:Collapse Workspaces");
  await app.waitUntil(() => app.texts().includes("Renamed session"));
  expect(app.count("label:Session name")).toBe(0);

  // Escape drops the edit instead.
  await app.press("id:session-title");
  await app.waitFor("label:Session name");
  await app.clear("label:Session name");
  await app.type("label:Session name", "Discarded name");
  await app.keyboard.press("escape");
  await app.waitUntil(() => !app.shows("label:Session name"));
  expect(app.texts()).not.toContain("Discarded name");
  expect(app.texts()).toContain("Renamed session");
});

test("hides and shows the sidebar with its session list intact", async () => {
  const app = await launch();
  await app.waitFor("text:What are we building?");
  expect(app.texts()).toContain("Refactor the transcript reducer");

  // mod+b and the corner button fold the sidebar away; the title bar offers it back.
  await app.press("label:Hide sidebar");
  await app.waitUntil(() => !app.texts().includes("Refactor the transcript reducer"));
  expect(app.count("label:Show sidebar")).toBeGreaterThan(0);

  await app.press("label:Show sidebar");
  await app.waitFor("text:Refactor the transcript reducer");
});

test("switches external coding agent mid-session with portable context handoff", async () => {
  const app = await launch("history");
  await app.waitFor("text:Here is the plan.");

  // Switch active agent harness in the composer from Pi -> Claude Code. Scope
  // both presses: the sidebar's engine line names the same harnesses.
  await app.press("id:agent-chip");
  await app.waitFor("id:agent-picker");
  await app.press("id:agent-picker >> text:Claude Code");

  // Portable Context Handoff divider appears while preserving prior transcript rows, and Claude Code's models load
  await app.waitFor("text:Switched agent from Pi to Claude Code");
  expect(app.texts()).toContain("Claude Code Default");
  expect(app.texts()).toContain("Here is the plan.");
});

test("orchestrates parallel multi-agent runs in isolated worktrees, inspects a sub-agent, and merges its result", async () => {
  const app = await launch("welcome");
  await app.waitFor("text:What are we building?");

  // Open the Multi-Agent Orchestration sheet with its shortcut
  await app.keyboard.press("mod+shift+o");
  await app.waitFor("text:Multi-Agent Orchestration");
  await app.type("label:Orchestration task", "Audit security and add rate limiting");
  await app.press("text:Launch Agents");

  // Sub-agents run in isolated pipi/* worktree branches, complete, and appear in SubagentStrip
  await app.waitFor("text:Merge to Chat >> nth=0");
  expect(app.texts().some((t) => t.startsWith("pipi/"))).toBe(true);

  // Inspect a delegated sub-agent's live transcript and merge its result back to the main chat
  await app.press("label:Inspect sub-agent >> nth=0");
  await app.waitFor("text:Back to Chat");
  await app.press("text:Merge to Chat >> nth=0");
  await app.waitFor("text:Sub-agent result added to conversation context.");
});

test("configures external coding agents and adds a custom ACP agent in Settings", async () => {
  const app = await launch("welcome");
  await app.waitFor("text:What are we building?");

  await app.press("label:Settings");
  await app.waitFor("text:Agents >> nth=0");
  await app.press("text:Agents >> nth=0");
  await app.waitFor("text:Coding Agent Harnesses");
  expect(app.texts()).toContain("Claude Code");
  expect(app.texts()).toContain("Codex");
  expect(app.texts()).toContain("Devin");

  await app.press("text:Add ACP Agent");
  await app.type("label:Agent name", "Custom ACP");
  await app.type("label:Executable command", "custom-acp");
  await app.type("label:Command arguments", "acp");
  await app.press("text:Save ACP Agent");
  await app.waitFor("text:Added custom agent \"Custom ACP\".");
  expect(app.texts()).toContain("Custom ACP");
});

test("the agents search hint is app-rendered text that clears on typing", async () => {
  const app = await launch("welcome");
  await app.waitFor("text:What are we building?");

  await app.press("label:Settings");
  await app.waitFor("text:Agents >> nth=0");
  await app.press("text:Agents >> nth=0");
  await app.waitFor("text:Coding Agent Harnesses");

  // The hint sits in an overlay, not the host input, so it rides the page's
  // entrance as composited texture instead of re-rasterizing host text.
  expect(app.texts()).toContain("Filter engines (Devin, Gemini, Grok…)");
  await app.type("label:Search coding agents", "claude");
  expect(app.texts()).not.toContain("Filter engines (Devin, Gemini, Grok…)");
  expect(app.texts()).toContain("Claude Code");
  expect(app.texts()).not.toContain("Codex");
});

test("shows tool permission confirmation inline above the composer while keeping chat history visible", async () => {
  const app = await launch("history");
  await app.waitFor("text:Here is the plan.");

  await app.type("label:Message", "run with confirm");
  await app.submit("label:Message");

  // Inline confirmation bar appears above the composer with formatted command (not raw JSON)
  await app.waitFor("text:Allow shell command?");
  const texts = app.texts();
  expect(texts).toContain("Here is the plan.");
  expect(texts).toContain('ls -la thirdparty/ 2>/dev/null && echo "---"');
  expect(texts.some((t) => t.includes('"command":'))).toBe(false);

  // Approving inline resumes execution and completes the reply
  await app.press("text:Allow");
  await app.waitFor("label:Send");

  // Declining inline stops the tool cleanly without hiding the conversation
  await app.type("label:Message", "try another confirm");
  await app.submit("label:Message");
  await app.waitFor("text:Allow shell command?");
  await app.press("text:Deny");
  await app.waitFor("text:Understood, skipped the shell command.");
  expect(app.texts()).toContain("Here is the plan.");
});

test("keeps a run going in the background when switching sessions, and resumes it", async () => {
  const app = await launch("slow");
  await app.waitFor("text:What are we building?");
  await app.type("label:Message", "make a plan");
  await app.submit("label:Message");
  await app.waitFor("text:make a plan");

  // Leave while the reply is still streaming: the sidebar marks the session as running off screen.
  await app.press("id:sidebar-workspaces >> text:Refactor the transcript reducer");
  await app.waitFor("text:Here is the plan.");
  await app.waitUntil(() => app.shows("label:Running in the background"));

  // Coming back mid-run adopts the same process: it is still working, and finishes here.
  await app.press("id:sidebar-workspaces >> text:make a plan");
  await app.waitFor("label:Stop", { timeout: 10000 });
  await app.waitFor("text:Steps", { timeout: 20000 });
  await app.waitFor("label:Send", { timeout: 20000 });

  // A run left alone finishes off screen and reports back without taking the screen.
  await app.type("label:Message", "one more plan");
  await app.submit("label:Message");
  await app.waitFor("text:one more plan");
  await app.press("id:sidebar-workspaces >> text:Refactor the transcript reducer");
  await app.waitFor("text:Here is the plan.");
  await app.waitFor("text:make a plan finished in the background.", { timeout: 30000 });
  await app.waitUntil(() => !app.texts().some((text) => text.includes("finished in the background")));

  // Its reply is waiting, and the agent keeps answering without restarting.
  await app.press("id:sidebar-workspaces >> text:make a plan");
  await app.waitFor("text:one more plan");
  await app.waitFor("label:Send", { timeout: 10000 });
  expect(app.texts()).toContain("Steps");
}, 90000);

test("switches projects while a run works, and comes back to it", async () => {
  const app = await launch("multi-slow");
  await app.waitFor("text:What are we building?");
  await app.type("label:Message", "make a plan");
  await app.submit("label:Message");
  await app.waitFor("text:make a plan");

  // Open a session in another project while the run is going: its process keeps working.
  await app.press("id:sidebar-workspaces >> text:Fix QuickJS GC mark phase");
  await app.waitFor("text:Here is the plan.");
  await app.waitUntil(() => app.shows("label:Running in the background"));

  // The parked run finishes in its own project, and the sidebar still lists it there.
  await app.waitFor("text:make a plan finished in the background.", { timeout: 30000 });
  expect(app.texts()).toContain("pipi");
  await app.waitUntil(() => !app.texts().some((text) => text.includes("finished in the background")));

  // Coming back switches the project and adopts the session with its reply.
  await app.press("id:sidebar-workspaces >> text:make a plan");
  await app.waitFor("text:Steps");
  expect(app.texts()).toContain("make a plan");
  expect(app.shows("label:Running in the background")).toBe(false);
}, 60000);
