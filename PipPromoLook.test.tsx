// The README's personal-agent pictures, on the scripted app in `Harness.tsx`:
//
//   nsh test PipPromoLook.test.tsx --target macos   # .nsh/shots/promo-pip-*.png, promo-docs-*.png
//   python3 scripts/render-promo.py                  # frames them into assets/promo/
//
// Scene 1 (`promo-pip*`): a seeded Pip conversation with real shape — iMessage
// bubbles over two turns, an edited answer, a `present_files` chart, two
// delegated session chips (one still running), and Pip's quiet "waiting on 1
// session" footer over the composer.
// Scene 2 (`promo-docs*`): a release-notes document with the DocOrb
// mini-composer bloomed — one instruction sent, the rewritten document's
// update pill and the reply settled.
//
// Only a real platform draws the app, so headless runs skip screenshots.
import { open, test } from "nsh/test";
import { PROMO_CHART_DATA_URI, PROMO_CHART_HEIGHT, PROMO_CHART_WIDTH } from "./dev/promo-chart";

const VARIANTS = [
  { suffix: "", locale: "en-US", colorScheme: "light" },
  { suffix: "-zh", locale: "zh-Hans-CN", colorScheme: "light" },
  { suffix: "-dark", locale: "en-US", colorScheme: "dark" },
  { suffix: "-zh-dark", locale: "zh-Hans-CN", colorScheme: "dark" },
] as const;

const RUN = `/tmp/pipi-pip-promo-${Date.now()}`;
const AGENT = { provider: "anthropic", model: "claude-sonnet-4-5" };

// ── Scripted conversation ──────────────────────────────────────────────────────

const script = (zh: boolean) =>
  zh
    ? {
        user1: "consumer 又抛 OFFSET_OUT_OF_RANGE，查一下，后续分头做",
        bubble1:
          "看了，不是老毛病 —— 0.9.4 调了 rebalance 和 offset 提交顺序：分区没 rejoin 完，`commit_sync` 就先提交了 —— p2、p5、p7 重复消费约 2.1 万条。",
        bubble3: "重复区间拉成图了 —— 两个会话分头做：Codex 算到条，Pi 写测试。",
        edited1: "先直接回滚 0.9.4 吧，重复消费面还在扩，止损要紧。",
        edited2: "影响面比报警看着大，建议先回滚，我再核各分区的重复量。",
        mediaTitle: "重复消费窗口 · 按分区",
        mediaCaption: "argus-consumer · 04:12–04:18",
        task1: "核算重复消费区间",
        task2: "offset 提交顺序回归测试",
        grepOut: 'logs/consumer-04.log:1927:[04:12:31] offset commit before rejoin finished (partition 2)\nlogs/consumer-04.log:2104:[04:13:58] offset commit before rejoin finished (partition 5)\nlogs/consumer-04.log:2331:[04:14:12] offset commit before rejoin finished (partition 7)',
        readPath: "consumer/commit.py",
      }
    : {
        user1: "OFFSET_OUT_OF_RANGE is back — dig in, split the follow-ups",
        bubble1:
          "Not the old bug — 0.9.4 swapped rebalance and offset commits; `commit_sync` flushed before rejoin — p2, p5, p7 replayed ~21k.",
        bubble3: "Chart below — Codex on the numbers, Pi on the test.",
        edited1: "Roll back 0.9.4 right away — the replay surface is still growing, cut losses first.",
        edited2: "The blast radius looks bigger than the alerts; roll back first, I'll recompute the per-partition replay.",
        mediaTitle: "Replay window · by partition",
        mediaCaption: "argus-consumer · 04:12–04:18",
        task1: "Replay window audit",
        task2: "Commit-order regression test",
        grepOut: 'logs/consumer-04.log:1927:[04:12:31] offset commit before rejoin finished (partition 2)\nlogs/consumer-04.log:2104:[04:13:58] offset commit before rejoin finished (partition 5)\nlogs/consumer-04.log:2331:[04:14:12] offset commit before rejoin finished (partition 7)',
        readPath: "consumer/commit.py",
      };

const history = (zh: boolean) => {
  const s = script(zh);
  const t0 = Date.now() - 3_600_000;
  const media = {
    pipiMedia: true,
    items: [{ path: PROMO_CHART_DATA_URI, kind: "image", title: s.mediaTitle, caption: s.mediaCaption, width: PROMO_CHART_WIDTH, height: PROMO_CHART_HEIGHT }],
  };
  // One turn, as a loaded conversation reads it: the edited analysis bubble,
  // hidden tool work, the chart + delegation line, then the session chips.
  return [
    { role: "user", content: s.user1, timestamp: t0 },
    {
      role: "assistant", turnStart: true, timestamp: t0 + 9_000,
      content: [{ type: "text", text: s.bubble1 }],
      ...AGENT, stopReason: "stop", editKey: "answer",
      versions: [
        { content: s.edited1, at: t0 + 41_000 },
        { content: s.edited2, at: t0 + 49_000 },
        { content: s.bubble1, at: t0 + 58_000 },
      ],
    },
    {
      role: "assistant", timestamp: t0 + 26_000,
      content: [
        { type: "toolCall", id: "call_grep_1", name: "grep", arguments: { pattern: "offset commit before rejoin", path: "logs/" } },
        { type: "toolCall", id: "call_read_1", name: "read", arguments: { path: s.readPath } },
      ],
      ...AGENT, stopReason: "toolUse",
    },
    {
      role: "toolResult", toolCallId: "call_grep_1", toolName: "grep",
      content: [{ type: "text", text: s.grepOut }], isError: false, timestamp: t0 + 27_000,
    },
    {
      role: "toolResult", toolCallId: "call_read_1", toolName: "read",
      content: [{ type: "text", text: "def commit_offsets(self):\n    # commit first, then wait for rejoin\n    self.consumer.commit_sync()\n    self.wait_rejoin()" }], isError: false, timestamp: t0 + 28_000,
    },
    {
      role: "assistant", timestamp: t0 + 58_000,
      content: [{ type: "text", text: s.bubble3 }],
      ...AGENT, stopReason: "stop",
    },
    {
      role: "assistant", timestamp: t0 + 64_000,
      content: [
        { type: "toolCall", id: "call_sess_1", name: "session_start", arguments: { agent: "codex", title: s.task1 } },
        { type: "toolCall", id: "call_sess_2", name: "session_start", arguments: { agent: "pi", title: s.task2 } },
        { type: "toolCall", id: "call_media_1", name: "present_files", arguments: { title: s.mediaTitle, files: [{ path: PROMO_CHART_DATA_URI }] } },
      ],
      ...AGENT, stopReason: "toolUse",
    },
    {
      role: "toolResult", toolCallId: "call_sess_1", toolName: "session_start",
      content: [{ type: "text", text: JSON.stringify({ id: "s_codex_1", title: s.task1 }) }], isError: false, timestamp: t0 + 65_000,
    },
    {
      role: "toolResult", toolCallId: "call_sess_2", toolName: "session_start",
      content: [{ type: "text", text: JSON.stringify({ id: "s_pi_2", title: s.task2 }) }], isError: false, timestamp: t0 + 65_500,
    },
    {
      role: "toolResult", toolCallId: "call_media_1", toolName: "present_files",
      content: [{ type: "text", text: JSON.stringify(media) }], details: media, isError: false, timestamp: t0 + 66_000,
    },
  ];
};

// ── Seeded daemon sessions: Pip idle on top, one child still working, one done ──

const daemonSessions = (zh: boolean) => {
  const s = script(zh);
  const now = Date.now();
  return [
    {
      id: "s_pip_1", title: "Pip", titleLocked: true, persona: true,
      cwd: "/Users/pip/.pipi/persona", agentId: "pi", agentName: "Pi", driver: "pi",
      runtimeMode: "full-access", status: "idle", unread: false, loaded: true,
      depth: 0, createdAt: now - 3 * 86_400_000, lastActive: now - 60_000,
    },
    {
      id: "s_codex_1", title: s.task1, titleLocked: true, parentId: "s_pip_1",
      cwd: "/Users/pip/code/argus", agentId: "codex", agentName: "Codex", driver: "codex",
      runtimeMode: "full-access", status: "working", unread: false, loaded: true,
      depth: 1, createdAt: now - 4 * 60_000, lastActive: now - 5_000,
    },
    {
      id: "s_pi_2", title: s.task2, titleLocked: true, parentId: "s_pip_1",
      cwd: "/Users/pip/code/argus", agentId: "pi", agentName: "Pi", driver: "pi",
      runtimeMode: "full-access", status: "idle", unread: false, loaded: true,
      depth: 1, createdAt: now - 4 * 60_000, lastActive: now - 45_000,
    },
  ];
};

// ── Documents ─────────────────────────────────────────────────────────────────

const releaseNotes = (zh: boolean) =>
  zh
    ? `# 0.9.4 Release notes

Status: draft

## Highlights

- offset 提交等 rejoin 完成再走，rebalance 期间不再重复消费（draft）
- 委派会话有实时状态卡片，点一下直达会话
- 文档里 DocOrb 就地改写，一键可撤

## Fixes

- 子会话退出后侧边栏的工作状态不再残留
- 修复暗色模式下媒体气泡边框过亮

## Known issues

- Windows 下视频壁纸偶现首帧黑屏（#412）
`
    : `# 0.9.4 Release notes

Status: draft

## Highlights

- Offset commits now wait for rejoin to finish — no replayed batches during rebalance (draft)
- Delegated sessions get live status chips that jump straight to the session
- Documents get inline rewrites from the orb, with one-click undo

## Fixes

- The sidebar no longer keeps a stale working badge after a child session exits
- Media bubbles pick up the right border tone in dark mode

## Known issues

- Video wallpapers can flash a black first frame on Windows (#412)
`;

const prefs = (dataDir: string, docPath: string, openDocTab: boolean) => ({
  workspaces: ["/Users/pip/code/argus"],
  collapsedGroups: ["archived"],
  sidebarOpen: true,
  personalAgentId: "pi",
  personaSessionChoices: { default: { agentId: "pi", model: { provider: "anthropic", id: "claude-sonnet-4-5" }, thinkingLevel: "high" } },
  openTabs: openDocTab ? [{ kind: "doc", ref: docPath }] : [],
});

// ── Scene 1: the Pip conversation ──────────────────────────────────────────────

test("promo pip conversation", async () => {
  for (const variant of VARIANTS) {
    const zh = variant.locale.startsWith("zh");
    const dataDir = `${RUN}-chat-${variant.suffix || "-en"}`;
    const docPath = `${dataDir}/docs/release-notes.md`;
    const app = await open("./Harness.tsx", {
      width: 1240,
      height: 860,
      platform: "macos",
      locale: variant.locale,
      colorScheme: variant.colorScheme,
      clock: {},
      storage: {
        "harness.scenario": "history",
        "harness.history": JSON.stringify(history(zh)),
        "harness.daemonSessions": JSON.stringify(daemonSessions(zh)),
        "harness.sessions": "[]",
        "harness.dataDir": dataDir,
        "harness.files": JSON.stringify({ [docPath]: releaseNotes(zh) }),
        "pipi.prefs.v1": JSON.stringify({ ...prefs(dataDir, docPath, false), appearance: variant.colorScheme }),
      },
    });
    await app.waitFor("id:sidebar-pip");
    await app.press("id:sidebar-pip");
    await app.waitFor("id:pip-delegated-sessions", { timeout: 20_000 });
    await app.wait(1600);
    await app.screenshot(`.nsh/shots/promo-pip${variant.suffix}.png`);
  }
}, 240_000);

// ── Scene 2: DocOrb over the release notes ─────────────────────────────────────

test("promo doc orb", async () => {
  for (const variant of VARIANTS) {
    const zh = variant.locale.startsWith("zh");
    const dataDir = `${RUN}-docs-${variant.suffix || "-en"}`;
    const docPath = `${dataDir}/docs/release-notes.md`;
    const app = await open("./Harness.tsx", {
      width: 1240,
      height: 840,
      platform: "macos",
      locale: variant.locale,
      colorScheme: variant.colorScheme,
      clock: {},
      storage: {
        "harness.scenario": "stream",
        "harness.daemonSessions": JSON.stringify(daemonSessions(zh)),
        "harness.sessions": "[]",
        "harness.dataDir": dataDir,
        "harness.files": JSON.stringify({ [docPath]: releaseNotes(zh) }),
        "harness.reply": zh
          ? "好了 —— draft 标记翻成了 final，Highlights 第一条也顺手收短了。文档里高亮的就是改动，不满意一键撤回。"
          : "Done — the draft markers are final now and the first Highlight reads tighter. The change is highlighted in the doc, one click undoes it.",
        "pipi.prefs.v1": JSON.stringify({ ...prefs(dataDir, docPath, true), appearance: variant.colorScheme }),
      },
    });
    await app.waitFor("id:sidebar-docs >> text:0.9.4 Release notes", { timeout: 20_000 });
    await app.press("id:sidebar-docs >> text:0.9.4 Release notes");
    await app.waitFor("id:doc-editor", { timeout: 20_000 });
    await app.wait(600);
    await app.press("id:doc-orb-trigger");
    await app.waitFor("id:doc-orb-input");
    await app.type(
      "id:doc-orb-input",
      zh ? "rewrite —— 把 draft 标记翻成定稿，Highlights 的措辞顺手收一收" : "rewrite — flip the draft markers to final and tighten the Highlights",
    );
    await app.submit("id:doc-orb-input");
    await app.waitFor("id:doc-update-pill", { timeout: 30_000 });
    await app.waitFor("id:doc-orb-copy", { timeout: 30_000 });
    await app.wait(800);
    await app.screenshot(`.nsh/shots/promo-docs${variant.suffix}.png`);
  }
}, 240_000);
