// The app as the README shows it: the scripted Pi (dev/fake-pi.ts) holding a
// believable day of work — several projects, sessions on many engines, one
// finished exchange on screen. `Promo.test.tsx` photographs it and
// `scripts/render-promo.py` frames the photographs.
//
//   nsh dev Promo.tsx
import { mount, Storage } from "nsh";
import { fakeBackend } from "./dev/fake-pi";
import { tr } from "./lib/i18n";
import type { AgentMessage } from "./pi/protocol";
import type { SessionSummary } from "./pi/sessions";
import { boot } from "./store/app";
import { useBackend } from "./store/backend";
import { Shell } from "./views/Shell";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const now = Date.now();
const CODE = "/Users/pip/code";

export const PROMO_WORKSPACES = [`${CODE}/lumen-api`, `${CODE}/lumen-web`, `${CODE}/infra`, `${CODE}/dotfiles`];

let seq = 0;
/** A saved session: `title` is its name, or its first message when `named` is false. */
const session = (agentId: string, title: string, ago: number, messageCount: number, named = true): SessionSummary => {
  const id = `s${++seq}`;
  return {
    path: `/sessions/${id}.jsonl`,
    id,
    agentId,
    name: named ? title : undefined,
    firstMessage: named ? "" : title,
    messageCount,
    created: now - ago - 20 * MIN,
    modified: now - ago,
  };
};

/** The open session: the file the scripted Pi starts on. */
const open: SessionSummary = { ...session("pi", tr("Fix the flaky rate limiter test", "修复不稳定的限流器测试"), 2 * MIN, 7), path: "/sessions/one.jsonl" };

const workspaceSessions: Record<string, SessionSummary[]> = {
  [PROMO_WORKSPACES[0]]: [
    open,
    session("claude", tr("Add cursor pagination to /v1/events", "给 /v1/events 加游标分页"), 3 * HOUR, 42),
    session("devin", tr("Migrate the job queue to BullMQ", "把任务队列迁到 BullMQ"), 26 * HOUR, 118),
    session("gemini", tr("Why is p99 latency up since Tuesday?", "为什么周二以来 p99 延迟变高了？"), 2 * DAY, 23, false),
    session("copilot", tr("Write OpenAPI specs for the billing routes", "给计费路由写 OpenAPI 规范"), 4 * DAY, 31),
    session("kimi", tr("Explain how the tenant resolver caches lookups", "讲讲租户解析器怎么缓存查找结果"), 6 * DAY, 9, false),
  ],
  [PROMO_WORKSPACES[1]]: [
    session("codex", tr("Dashboard charts re-render on every keystroke", "仪表盘图表每次按键都在重新渲染"), 38 * MIN, 27, false),
    session("cursor", tr("Dark mode for the onboarding flow", "新手引导流程的深色模式"), 5 * HOUR, 54),
    session("opencode", tr("Upgrade to React 19 and fix the hydration warnings", "升级 React 19 并修掉 hydration 警告"), 29 * HOUR, 76),
    session("claude", tr("Accessibility pass on the settings forms", "给设置表单做一轮无障碍检查"), 3 * DAY, 48),
    session("qwen", tr("Translate the empty states into Japanese", "把空状态文案翻成日语"), 5 * DAY, 15),
  ],
  [PROMO_WORKSPACES[2]]: [
    session("amp", tr("Terraform module for the staging database", "给 staging 数据库写 Terraform 模块"), 90 * MIN, 36),
    session("pi", tr("Cut the Docker image from 1.2 GB to 240 MB", "把 Docker 镜像从 1.2 GB 压到 240 MB"), 9 * HOUR, 63),
    session("codex", tr("Alert when the nightly backup is late", "夜间备份晚到就告警"), 2 * DAY + 5 * HOUR, 19),
    session("droid", tr("Rotate the deploy keys and update CI secrets", "轮换部署密钥并更新 CI 密钥"), 7 * DAY, 22),
  ],
  [PROMO_WORKSPACES[3]]: [session("grok", tr("Make the zsh prompt show the kubectl context", "让 zsh 提示符显示 kubectl context"), 8 * DAY, 11, false)],
};

const usage = { input: 18420, output: 1260, cacheRead: 96300, cacheWrite: 0, totalTokens: 115980, cost: { input: 0.055, output: 0.019, cacheRead: 0.029, cacheWrite: 0, total: 0.103 } };
const t0 = now - 4 * MIN;
const assistant = (at: number, content: unknown[], stopReason: "toolUse" | "stop") =>
  ({ role: "assistant", content, provider: "anthropic", model: "claude-sonnet-4-5", usage, stopReason, timestamp: t0 + at }) as unknown as AgentMessage;
const result = (at: number, toolCallId: string, toolName: string, text: string) =>
  ({ role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError: false, timestamp: t0 + at }) as unknown as AgentMessage;

const LIMITER_BEFORE = "  const windowStart = Date.now() - (Date.now() % windowMs);\n  const resetAt = Math.ceil(Date.now() / windowMs) * windowMs;";
const LIMITER_AFTER = "  const now = clock.now();\n  const windowStart = now - (now % windowMs);\n  const resetAt = windowStart + windowMs;";

const ANSWER = tr(
  `The flake was a window-boundary race in the limiter itself, not a CI problem.

## Root cause

\`consume()\` read the clock once to pick the window and again to compute its reset. A request landing within a millisecond of the boundary got the old window's counter with the new window's expiry.

## What changed

- \`src/middleware/rateLimit.ts\` reads the clock once and derives both values from it
- \`tests/rate_limit.test.ts\` runs on fake timers, with a new case that lands exactly on the boundary

\`\`\`ts
const now = clock.now();
const windowStart = now - (now % windowMs);
const resetAt = windowStart + windowMs;
\`\`\`

All 42 tests pass, and the limiter suite ran 200 times in a row without a failure.`,
  `这个 flake 是限流器自身的窗口边界竞态，不是 CI 的问题。

## 根因

\`consume()\` 读了一次时钟来选窗口，又读了一次来算重置时间。落在边界一毫秒内的请求，会拿到旧窗口的计数器配上新窗口的过期时间。

## 改动内容

- \`src/middleware/rateLimit.ts\` 只读一次时钟，两个值都由它推出
- \`tests/rate_limit.test.ts\` 改用假定时器，并新增了一个正好压在边界上的用例

\`\`\`ts
const now = clock.now();
const windowStart = now - (now % windowMs);
const resetAt = windowStart + windowMs;
\`\`\`

全部 42 个测试通过，限流器套件连跑 200 次无一失败。`,
);

const history: AgentMessage[] = [
  {
    role: "user",
    content: tr("tests/rate_limit.test.ts fails about one run in five on CI but never on my machine. Find out why and fix it.", "tests/rate_limit.test.ts 在 CI 上大约五次挂一次，我本地却从不失败。查下原因并修好它。"),
    timestamp: t0,
  },
  assistant(
    6_000,
    [
      { type: "thinking", thinking: tr("Intermittent and CI-only usually means timing. Reproduce it in a loop first, then read the limiter.", "偶发且只在 CI 出现，多半是时序问题。先循环复现，再读限流器。") },
      { type: "text", text: tr("I'll reproduce it in a loop first, then read the limiter.", "我先循环跑它几十遍复现，再看限流器的实现。") },
      { type: "toolCall", id: "c1", name: "bash", arguments: { command: "for i in $(seq 40); do npx vitest run tests/rate_limit.test.ts --silent || echo FAIL; done | grep -c FAIL" } },
      { type: "toolCall", id: "c2", name: "read", arguments: { path: "src/middleware/rateLimit.ts" } },
      { type: "toolCall", id: "c3", name: "read", arguments: { path: "tests/rate_limit.test.ts" } },
    ],
    "toolUse",
  ),
  result(31_000, "c1", "bash", "7"),
  result(31_400, "c2", "read", `export function consume(key: string, limit: number, windowMs: number) {\n${LIMITER_BEFORE}\n  ...\n}`),
  result(31_800, "c3", "read", 'it("rejects the 11th request in a window", async () => { ... })'),
  assistant(
    44_000,
    [
      { type: "text", text: tr("It reproduces locally: 7 failures in 40 runs. The limiter reads the clock more than once per request, so the window and its reset can disagree.", "本地复现了：40 次里挂了 7 次。限流器在一次请求里读了不止一次时钟，窗口和它的重置时间可能对不上。") },
      { type: "toolCall", id: "c4", name: "edit", arguments: { path: "src/middleware/rateLimit.ts", oldText: LIMITER_BEFORE, newText: LIMITER_AFTER } },
      {
        type: "toolCall",
        id: "c5",
        name: "edit",
        arguments: {
          path: "tests/rate_limit.test.ts",
          oldText: "beforeEach(() => store.clear());",
          newText: 'beforeEach(() => {\n  vi.useFakeTimers();\n  store.clear();\n});\n\nit("keeps one window for a request on the boundary", () => {\n  vi.setSystemTime(59_999);\n  expect(consume("k", 1, 60_000).resetAt).toBe(60_000);\n});',
        },
      },
    ],
    "toolUse",
  ),
  result(45_000, "c4", "edit", "ok"),
  result(45_500, "c5", "edit", "ok"),
  assistant(
    52_000,
    [{ type: "toolCall", id: "c6", name: "bash", arguments: { command: "for i in $(seq 200); do npx vitest run tests/rate_limit.test.ts --silent || echo FAIL; done | grep -c FAIL; npm test" } }],
    "toolUse",
  ),
  result(96_000, "c6", "bash", "0\n\n Test Files  9 passed (9)\n      Tests  42 passed (42)"),
  assistant(104_000, [{ type: "text", text: ANSWER }], "stop"),
];

/** Engines the promo's machine has installed: every one a listed session ran on. */
const INSTALLED: Record<string, string> = {
  cursor: "2026.01.14",
  opencode: "1.1.36",
  gemini: "0.24.0",
  copilot: "0.0.394",
  devin: "1.8.2",
  amp: "0.0.1768",
  kimi: "1.4.0",
  qwen: "0.7.1",
  droid: "0.46.0",
  grok: "1.0.9",
};

Storage.getItem("promo.ready").then(() => {
  const fake = fakeBackend({ history, sessions: workspaceSessions[PROMO_WORKSPACES[0]], workspaceSessions });
  useBackend({
    ...fake,
    async probeAgents(options) {
      const found = (await fake.probeAgents?.(options)) ?? [];
      return found.map((agent) => {
        const version = INSTALLED[agent.id];
        return version
          ? { ...agent, available: true, binaryPath: `/Users/pip/.local/bin/${agent.id}`, version, statusText: `CLI ready · ${version}` }
          : agent;
      });
    },
  });
  void boot();
});

mount(Shell);
