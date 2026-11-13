import { acpDefaultModel, builtinAgentSpec, defaultAgentStatuses } from "../agents/catalog";
import type { AgentHarnessStatus, CustomAgentConfig, RuntimeMode, WorktreeInfo } from "../agents/types";
import type { Exit, Transport } from "../pi/client";
import type { DaemonAttachSpec, DaemonCallbacks, DaemonClient, DaemonSession } from "../pi/daemon";
import type { AgentMessage, ImageContent, Model, SessionState } from "../pi/protocol";
import type { SessionSummary } from "../pi/sessions";
import type { UsageStats } from "../pi/usage";
import type { Backend } from "../store/backend";

/**
 * A scripted Pi for headless tests and the design harness: a `Backend` whose
 * transport answers RPC commands from memory and plays a short run when
 * prompted, in the record shapes of `docs/pi/json.md`. No process, no disk.
 */
export interface FakeOptions {
  /** No provider is connected: no models, as a fresh install. */
  noModels?: boolean;
  /** Pi fails to start. */
  failStart?: boolean;
  /** Messages of the session that is open at the start. */
  history?: AgentMessage[];
  sessions?: SessionSummary[];
  /** Per-workspace saved sessions for multi-project sidebar testing. */
  workspaceSessions?: Record<string, SessionSummary[]>;
  /** Folder path returned when `pickFolder` is called. */
  pickedFolder?: string;
  /** Image path returned when `pickImage` is called. */
  pickedImage?: string;
  /** Milliseconds between streamed records (0: all at once). */
  pace?: number;
  /** Milliseconds an agent takes to start and to load a saved session, as real CLIs do (0: at once). */
  startDelay?: number;
  /** Each saved session opens on a history of its own (its title asked, then answered) instead of the shared sample. */
  distinctHistories?: boolean;
  /** Each saved session's history ends on a reply longer than the window (`LONG_REPLY`): where a conversation lands shows. */
  longHistories?: boolean;
  /** The reply a run streams: the answer text instead of `REPLY`/`STEPS_REPLY`. */
  reply?: string;
  /**
   * The first `times` agent processes go away on their own `after` ms after
   * starting, as one whose input closed does: exit code 0, nothing on stderr.
   */
  dies?: { after: number; times: number };
  /** Only this many agent processes can start; one asked for after that fails as `failStart` does. */
  starts?: number;
  /**
   * An app update for the checker to find: the card comes up on its own.
   * `rate` is the download's speed in bytes per ms; `unknownSize` streams
   * progress without a total, the indeterminate track.
   */
  update?: { version?: string; notes?: string; canInstall?: boolean; bytes?: number; rate?: number; unknownSize?: boolean };
}

const MODELS: Model[] = [
  { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", api: "anthropic-messages", provider: "anthropic", reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 16384, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", api: "anthropic-messages", provider: "anthropic", reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 16384, cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } },
  { id: "gpt-5.1", name: "GPT-5.1", api: "openai-responses", provider: "openai", reasoning: true, input: ["text", "image"], contextWindow: 400000, maxTokens: 32768, cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 } },
  { id: "deepseek-chat", name: "DeepSeek Chat", api: "openai-completions", provider: "deepseek", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 8192, cost: { input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0 } },
];

const DAY = 86_400_000;
const dayKey = (back: number) => {
  const at = new Date(Date.now() - back * DAY);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
};
const tokens = (input: number, output: number, cacheRead: number, cacheWrite: number) => ({ input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite });

/**
 * Usage as the scanner reports it from a machine with each kind of agent: Pi and
 * Claude Code name a cost, Codex reports tokens without one, Kimi reports nothing.
 */
function sampleUsage(): UsageStats {
  const pi = tokens(41_200, 96_400, 3_812_000, 268_000);
  const claude = tokens(1_840, 38_600, 1_944_000, 121_500);
  const codex = tokens(212_000, 18_400, 1_506_000, 0);
  const all = tokens(pi.input + claude.input + codex.input, pi.output + claude.output + codex.output, pi.cacheRead + claude.cacheRead + codex.cacheRead, pi.cacheWrite + claude.cacheWrite + codex.cacheWrite);
  return {
    scannedAt: Date.now(),
    totals: { ...all, cost: 7.42, unpriced: codex.total, sessions: 31, userMessages: 148, assistantMessages: 612, toolCalls: 1_904 },
    agents: [
      { agentId: "pi", sessions: 17, messages: 498, tokens: pi, cost: 4.31, unpriced: 0 },
      { agentId: "claude", sessions: 8, messages: 164, tokens: claude, cost: 3.11, unpriced: 0 },
      { agentId: "codex", sessions: 4, messages: 86, tokens: codex, cost: 0, unpriced: codex.total },
      { agentId: "kimi", sessions: 2, messages: 12, tokens: tokens(0, 0, 0, 0), cost: 0, unpriced: 0 },
    ],
    models: [
      { provider: "anthropic", model: "claude-sonnet-4-5", messages: 402, tokens: pi, cost: 4.31, unpriced: 0 },
      { provider: "claude", model: "claude-opus-4-5", messages: 96, tokens: claude, cost: 3.11, unpriced: 0 },
      { provider: "codex", model: "default", messages: 52, tokens: codex, cost: 0, unpriced: codex.total },
    ],
    daily: [9, 8, 6, 5, 4, 2, 1, 0].map((back, index) => ({ day: dayKey(back), tokens: Math.round((all.total / 36) * (index + 1)), cost: 0.2 * (index + 1) })),
  };
}

const UNKNOWN: Model = { id: "unknown", name: "unknown", api: "unknown", provider: "unknown", reasoning: false, input: [], contextWindow: 0, maxTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

const usage = { input: 1820, output: 180, cacheRead: 0, cacheWrite: 0, totalTokens: 2000, cost: { input: 0.005, output: 0.003, cacheRead: 0, cacheWrite: 0, total: 0.008 } };

export const REPLY = "Here is the plan.\n\n## Steps\n\n1. Read the **manifest**.\n2. Run the tests.\n\n```ts\nconst answer = 42;\n```\n";

/** The answer of the run in steps: the kinds of block a reply mixes. */
export const STEPS_REPLY =
  "The list now follows the reply **natively**.\n\n## What changed\n\n- `Chat.tsx` hands following to the list\n- The fold closes *once*, when the answer is known\n\n```ts\nconst FOLLOW_THRESHOLD = 24;\nlist.scrollToEnd();\n```\n\nEverything else is as it was, and the tests pass.";

/** A reply long enough to scroll a window of test size, for scroll-during-streaming tests. */
export const LONG_REPLY = Array.from(
  { length: 24 },
  (_, i) => `### Part ${i + 1} of the plan\n\nSection ${i + 1} explains a step of the work in a few lines, so the reply grows past the viewport while it streams.`,
).join("\n\n");

/** A finished exchange with thinking, a tool call and prose: a session's history. */
export function sampleHistory(): AgentMessage[] {
  return [
    { role: "user", content: "Look around and tell me what this project is", timestamp: 1 },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "I'll list the directory, then read the manifest." },
        { type: "text", text: "Let me take a look around." },
        { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls -la" } },
        { type: "toolCall", id: "call_2", name: "read", arguments: { path: "package.json" } },
      ],
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      usage,
      stopReason: "toolUse",
      timestamp: 2,
    },
    { role: "toolResult", toolCallId: "call_1", toolName: "bash", content: [{ type: "text", text: "App.tsx\nnsh.json\npackage.json" }], isError: false, timestamp: 3 },
    { role: "toolResult", toolCallId: "call_2", toolName: "read", content: [{ type: "text", text: '{ "name": "pipi" }' }], isError: false, timestamp: 4 },
    { role: "assistant", content: [{ type: "text", text: REPLY }], provider: "anthropic", model: "claude-sonnet-4-5", usage, stopReason: "stop", timestamp: 5 },
  ];
}

export function fakeBackend(options: FakeOptions = {}): Backend & { sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = [];
  let sessions = options.sessions ?? [];
  /** What each session file holds, as Pi's session files do: a session keeps its messages across opens. */
  const sessionMessages = new Map<string, AgentMessage[]>();
  const byWorkspace: Record<string, SessionSummary[]> = { ...(options.workspaceSessions ?? {}) };
  let activeCwd = "/Users/pip";
  // Settings the app changes live; each process reads them, like Pi's shared config.
  let defaultModel: Model = options.noModels ? UNKNOWN : MODELS[0];
  let defaultThinking: SessionState["thinkingLevel"] = options.noModels ? "off" : "medium";
  let steeringMode: SessionState["steeringMode"] = "one-at-a-time";
  let followUpMode: SessionState["followUpMode"] = "one-at-a-time";
  let autoCompactionEnabled = true;
  let sessionSeq = 0;
  let deathsLeft = options.dies?.times ?? 0;
  let startsLeft = options.starts ?? Infinity;

  /** One agent process: its own session, messages and stream state, as Pi has per process. */
  const transport = (cwd: string, agentId: string, initial: AgentMessage[], custom?: { id: string; name: string; defaultModel?: string }): Transport => {
    // A fresh session opens on the engine's configured default, like Pi — not on the last pick.
    const engineModel = defaultModel;
    const engineThinking = defaultThinking;
    let messages = initial;
    let sessionFile: string | undefined = initial.length ? "/sessions/one.jsonl" : undefined;
    // A session opened on history carries the name its file was saved with.
    let sessionName: string | undefined = sessionFile ? sessions.find((s) => s.path === sessionFile)?.name : undefined;
    let sessionId = `session-${++sessionSeq}`;
    let isStreaming = false;
    const queued = { steering: [] as string[], followUp: [] as string[] };
    let isCompacting = false;
    const snapshotState = (): SessionState => ({
      model: defaultModel,
      thinkingLevel: defaultThinking,
      isStreaming,
      isCompacting,
      steeringMode,
      followUpMode,
      sessionId,
      sessionFile,
      sessionName,
      autoCompactionEnabled,
      messageCount: messages.length,
      pendingMessageCount: 0,
    });
    let out: (chunk: string) => void = () => undefined;
    let exit: (exit: Exit) => void = () => undefined;
    let aborted = false;
    /** The process is gone: it writes nothing more, and ends once. */
    let gone = false;
    const die = (how: Exit) => {
      if (gone) return;
      gone = true;
      aborted = true;
      exit(how);
    };
    const emit = (record: object) => {
      if (!gone) out(`${JSON.stringify(record)}\n`);
    };
    const later = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

    /** One run: thinking, a tool call that "executes", then streamed prose. */
    const uiWaiters = new Map<string, (response: Record<string, unknown>) => void>();

    /** A longer run, as agents work: prose between steps, several tool calls at a time, then the answer. */
    async function runSteps(user: AgentMessage, step: (record: object) => Promise<void>, update: (event: object) => Promise<void>) {
      isStreaming = true;
      const pieces = (text: string) => text.match(/[\s\S]{1,24}/g) ?? [];
      const sent: AgentMessage[] = [user];
      let call = 0;
      /** One assistant message: optional thinking, prose, then its tool calls, which run after it ends. */
      const message = async (parts: { thinking?: string; text?: string; tools?: { name: string; args: Record<string, unknown>; out: string }[] }) => {
        const content: Record<string, unknown>[] = [];
        const tools = (parts.tools ?? []).map((tool) => ({ ...tool, id: `call_s${++call}` }));
        const base = { role: "assistant", provider: "anthropic", model: "claude-sonnet-4-5", usage, timestamp: Date.now() };
        await step({ type: "message_start", message: { ...base, content: [], stopReason: "pending" } });
        if (parts.thinking) {
          const at = content.length;
          content.push({ type: "thinking", thinking: parts.thinking });
          await update({ type: "thinking_start", contentIndex: at });
          for (const piece of pieces(parts.thinking)) await update({ type: "thinking_delta", contentIndex: at, delta: piece });
          await update({ type: "thinking_end", contentIndex: at, content: parts.thinking });
        }
        if (parts.text) {
          const at = content.length;
          content.push({ type: "text", text: parts.text });
          await update({ type: "text_start", contentIndex: at });
          for (const piece of pieces(parts.text)) await update({ type: "text_delta", contentIndex: at, delta: piece });
          await update({ type: "text_end", contentIndex: at, content: parts.text });
        }
        for (const tool of tools) {
          const at = content.length;
          const toolCall = { type: "toolCall", id: tool.id, name: tool.name, arguments: tool.args };
          content.push(toolCall);
          await update({ type: "toolcall_start", contentIndex: at, id: tool.id, toolName: tool.name });
          await update({ type: "toolcall_delta", contentIndex: at, delta: JSON.stringify(tool.args) });
          await update({ type: "toolcall_end", contentIndex: at, toolCall });
        }
        const done = { ...base, content, stopReason: tools.length ? "toolUse" : "stop" } as unknown as AgentMessage;
        await step({ type: "message_end", message: done });
        sent.push(done);
        for (const tool of tools) {
          await step({ type: "tool_execution_start", toolCallId: tool.id, toolName: tool.name, args: tool.args });
          await step({ type: "tool_execution_end", toolCallId: tool.id, toolName: tool.name, result: { content: [{ type: "text", text: tool.out }] }, isError: false, durationMs: 40 });
          const result = { role: "toolResult", toolCallId: tool.id, toolName: tool.name, content: [{ type: "text", text: tool.out }], isError: false, timestamp: Date.now() } as unknown as AgentMessage;
          await step({ type: "message_start", message: result });
          await step({ type: "message_end", message: result });
          sent.push(result);
        }
        await step({ type: "turn_end" });
      };
      await step({ type: "agent_start" });
      await step({ type: "turn_start" });
      await step({ type: "message_start", message: user });
      await step({ type: "message_end", message: user });
      await message({
        thinking: "The user wants this done in steps. I will look at the project first.",
        text: "I'll start by looking at how the project is laid out.",
        tools: [
          { name: "read", args: { path: "package.json" }, out: '{ "name": "pipi" }' },
          { name: "read", args: { path: "views/Chat.tsx" }, out: "export function Chat() {}" },
          { name: "grep", args: { pattern: "scrollToEnd", path: "views" }, out: "views/Chat.tsx:12" },
        ],
      });
      await message({
        text: "The list follows by hand. Let me check the tests before changing it.",
        tools: [{ name: "bash", args: { command: "nsh test Scroll.test.tsx" }, out: "2 passed" }],
      });
      await message({
        thinking: "Tests pass. Now make the edit.",
        tools: [
          { name: "edit", args: { path: "views/Chat.tsx", oldText: "a\nb", newText: "c" }, out: "ok" },
          { name: "bash", args: { command: "nsh check ." }, out: "ok" },
        ],
      });
      await message({ thinking: options.reply ? "The user asked a follow-up; let me write the answer in full." : undefined, text: options.reply ?? STEPS_REPLY });
      if (!aborted) {
        messages = [...messages, ...sent];
        if (sessionFile) sessionMessages.set(sessionFile, messages);
      }
      isStreaming = false;
      emit({ type: "agent_end", willRetry: false });
      emit({ type: "agent_settled", aborted });
    }

    /**
     * A run as the external-agent bridge plays an ACP harness's (Devin's): the
     * whole turn is one assistant message — reasoning, calls that run inside
     * it, then the answer — so its prose is final only when the run settles.
     */
    async function runAcp(user: AgentMessage, prompt: string, step: (record: object) => Promise<void>, update: (event: object) => Promise<void>) {
      isStreaming = true;
      const text = options.reply ?? STEPS_REPLY;
      const plain = prompt.includes("plain");
      const thinking = "Let me check the working tree first.";
      // "titled": ACP harnesses name a call by its title, not its tool.
      const tools = plain
        ? []
        : prompt.includes("long-titled")
          ? [
              {
                id: "acp_1",
                name: 'git add README.md README.en.md Promo.tsx scripts/render-promo.py assets/promo/*.png && git commit -m "docs(readme): rewrite Chinese and English READMEs with transparent promo shots"',
                args: { description: 'git add README.md README.en.md Promo.tsx scripts/render-promo.py assets/promo/*.png && git commit -m "docs(readme): rewrite Chinese and English READMEs with transparent promo shots"' },
                out: "[main 37f23d0] docs(readme)",
              },
            ]
          : prompt.includes("titled")
          ? [
              { id: "acp_1", name: "Search for 'animate Layout On|animate Next Layout|Layout Animation'", args: { path: "." }, out: "views/Chat.tsx:12" },
              { id: "acp_2", name: "Search for 'veil|fold'", args: { path: "." }, out: "lib/veil.ts:1" },
              { id: "acp_3", name: "Listed ./views, ./pi, ./lib, ./store", args: { command: "ls views pi lib store" }, out: "views pi lib store" },
            ]
          : [
              { id: "acp_1", name: "bash", args: { command: "git status --short" }, out: " M Clip.test.tsx" },
              { id: "acp_2", name: "bash", args: { command: "git diff --stat" }, out: "2 files changed" },
            ];
      const base = { role: "assistant", provider: "anthropic", model: "claude-sonnet-4-5", usage, timestamp: Date.now() };
      const content: Record<string, unknown>[] = plain ? [] : [{ type: "thinking", thinking }];
      await step({ type: "agent_start" });
      await step({ type: "turn_start" });
      await step({ type: "message_start", message: user });
      await step({ type: "message_end", message: user });
      await step({ type: "message_start", message: { ...base, content: [], stopReason: "pending" } });
      if (!plain) {
        await update({ type: "thinking_start", contentIndex: 0 });
        await update({ type: "thinking_delta", contentIndex: 0, delta: thinking });
        await update({ type: "thinking_end", contentIndex: 0, content: thinking });
      }
      for (const tool of tools) {
        const at = content.length;
        const toolCall = { type: "toolCall", id: tool.id, name: tool.name, arguments: tool.args };
        content.push(toolCall);
        await update({ type: "toolcall_start", contentIndex: at, id: tool.id, toolName: tool.name });
        await update({ type: "toolcall_end", contentIndex: at, toolCall });
        await step({ type: "tool_execution_start", toolCallId: tool.id, toolName: tool.name, args: tool.args });
        const result = { role: "toolResult", toolCallId: tool.id, toolName: tool.name, content: [{ type: "text", text: tool.out }], isError: false, timestamp: Date.now() };
        await step({ type: "tool_execution_end", toolCallId: tool.id, toolName: tool.name, result: { content: result.content }, isError: false, durationMs: 40 });
        await step({ type: "message_end", message: result });
      }
      const at = content.length;
      content.push({ type: "text", text });
      await update({ type: "text_start", contentIndex: at });
      const chunks = prompt.includes("whole") ? [text] : (text.match(/[\s\S]{1,24}/g) ?? []);
      for (const piece of chunks) await update({ type: "text_delta", contentIndex: at, delta: piece });
      await update({ type: "text_end", contentIndex: at, content: text });
      const done = { ...base, content, stopReason: "stop" } as unknown as AgentMessage;
      await step({ type: "message_end", message: done });
      // "split" settles the turn a beat after the text: the fold and the
      // final flip land on a different frame than the last delta.
      if (prompt.includes("split")) await later(400);
      await step({ type: "turn_end" });
      if (!aborted) messages = [...messages, user, done];
      isStreaming = false;
      emit({ type: "agent_end", willRetry: false });
      emit({ type: "agent_settled", aborted });
      aborted = false;
    }

    /** Ends the wait before a retry early (`abort_retry`). */
    let cancelRetry: (() => void) | undefined;

    /**
     * A run through Pi's automatic retry, record for record as Pi 1.5 emits it:
     * a failed attempt ends its low-level run (`agent_end`, `willRetry`), Pi
     * says it will retry and waits, then runs again. "flaky" answers on the
     * second attempt; "outage" fails every attempt until Pi gives up. A retry
     * cancelled while it waits settles as not aborted, as Pi's does.
     */
    async function runRetries(user: AgentMessage, prompt: string, step: (record: object) => Promise<void>, update: (event: object) => Promise<void>) {
      isStreaming = true;
      const outage = prompt.includes("outage");
      const maxAttempts = 2;
      const wait = Math.max(options.pace ?? 0, 50) * 4;
      const error = "529 overloaded";
      const base = { role: "assistant", provider: "anthropic", model: "claude-sonnet-4-5", usage, timestamp: Date.now() };
      const failed = { ...base, content: [], stopReason: "error", errorMessage: error } as unknown as AgentMessage;
      const text = "Back on my feet: here is the plan.";
      const done = { ...base, content: [{ type: "text", text }], stopReason: "stop" } as unknown as AgentMessage;
      let last: AgentMessage | undefined;
      let retries = 0;
      await step({ type: "agent_start" });
      await step({ type: "turn_start" });
      await step({ type: "message_start", message: user });
      await step({ type: "message_end", message: user });
      while (!aborted) {
        if (outage || retries === 0) {
          await step({ type: "message_start", message: { ...failed, stopReason: "pending" } });
          await step({ type: "message_end", message: failed });
          await step({ type: "turn_end" });
          const willRetry = retries < maxAttempts && !aborted;
          emit({ type: "agent_end", willRetry });
          if (!willRetry) {
            // The attempt Pi gives up on stays in its history; the ones it retried do not.
            last = failed;
            if (retries) emit({ type: "auto_retry_end", success: false, attempt: retries, finalError: error });
            break;
          }
          retries++;
          emit({ type: "auto_retry_start", attempt: retries, maxAttempts, delayMs: wait, errorMessage: error });
          const cancelled = await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => resolve(false), wait);
            cancelRetry = () => {
              clearTimeout(timer);
              resolve(true);
            };
          });
          cancelRetry = undefined;
          if (cancelled) {
            emit({ type: "auto_retry_end", success: false, attempt: retries, finalError: "Retry cancelled" });
            break;
          }
          await step({ type: "agent_start" });
          await step({ type: "turn_start" });
          continue;
        }
        await step({ type: "message_start", message: { ...done, content: [], stopReason: "pending" } });
        await update({ type: "text_start", contentIndex: 0 });
        for (const piece of text.match(/[\s\S]{1,24}/g) ?? []) await update({ type: "text_delta", contentIndex: 0, delta: piece });
        await update({ type: "text_end", contentIndex: 0, content: text });
        await step({ type: "message_end", message: done });
        if (!aborted) emit({ type: "auto_retry_end", success: true, attempt: retries });
        await step({ type: "turn_end" });
        emit({ type: "agent_end", willRetry: false });
        last = done;
        break;
      }
      if (!aborted) {
        messages = [...messages, user, ...(last ? [last] : [])];
        if (sessionFile) sessionMessages.set(sessionFile, messages);
      }
      isStreaming = false;
      emit({ type: "agent_settled", aborted });
      aborted = false;
    }

    async function run(prompt: string, images?: ImageContent[]) {
      const pace = options.pace ?? 0;
      const needsConfirm = prompt.includes("confirm");
      const bashCmd = 'ls -la thirdparty/ 2>/dev/null && echo "---"';
      const step = async (record: object) => {
        if (aborted) return;
        emit(record);
        if (pace) await later(pace);
      };
      const update = (event: object) => step({ type: "message_update", usage, assistantMessageEvent: event });
      const user: AgentMessage = { role: "user", content: [{ type: "text", text: prompt }, ...(images ?? [])], timestamp: Date.now() };
      const toolName = needsConfirm ? "bash" : "read";
      const toolArgs = needsConfirm ? { command: bashCmd } : { path: "package.json" };
      const first: AgentMessage = {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "The user wants a plan. I will check the manifest first." },
          { type: "toolCall", id: "call_9", name: toolName, arguments: toolArgs },
        ],
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        usage,
        stopReason: "toolUse",
        timestamp: Date.now(),
      };
      let approved = true;
      const reply = options.reply ?? (prompt.includes("long") ? LONG_REPLY : REPLY);
      if (prompt.includes("steps")) return runSteps(user, step, update);
      if (prompt.includes("acp")) return runAcp(user, prompt, step, update);
      isStreaming = true;
      // Pi writes the session file as soon as the run starts, so a session can be found again.
      if (!sessionFile) sessionFile = `/sessions/${encodeURIComponent(cwd)}-${sessionId}.jsonl`;
      // The listing is newest first by last message (`sidecar/list-sessions.mjs`): a session that takes one leads it.
      const listed = byWorkspace[cwd] ?? sessions;
      const known = listed.find((s) => s.path === sessionFile);
      const entry = known
        ? { ...known, messageCount: known.messageCount + 1, modified: Date.now() }
        : { path: sessionFile, id: sessionId, firstMessage: prompt, messageCount: 1, created: Date.now(), modified: Date.now() };
      const relisted = [entry, ...listed.filter((s) => s.path !== sessionFile)];
      if (byWorkspace[cwd]) byWorkspace[cwd] = relisted;
      else sessions = relisted;
      if (prompt.includes("flaky") || prompt.includes("outage")) return runRetries(user, prompt, step, update);
      // "crash": the process dies under the run. Pi has the message on file by then, as it writes one when it is sent.
      if (prompt.includes("crash")) {
        await step({ type: "agent_start" });
        await step({ type: "turn_start" });
        await step({ type: "message_start", message: user });
        await step({ type: "message_end", message: user });
        messages = [...messages, user];
        sessionMessages.set(sessionFile, messages);
        await later(60);
        return die({ code: 1 });
      }
      await step({ type: "agent_start" });
      await step({ type: "turn_start" });
      await step({ type: "message_start", message: user });
      await step({ type: "message_end", message: user });
      await step({ type: "message_start", message: { ...first, content: [], stopReason: "pending" } });
      await update({ type: "thinking_start", contentIndex: 0 });
      await update({ type: "thinking_delta", contentIndex: 0, delta: "The user wants a plan. " });
      await update({ type: "thinking_delta", contentIndex: 0, delta: "I will check the manifest first." });
      await update({ type: "thinking_end", contentIndex: 0, content: "The user wants a plan. I will check the manifest first." });
      await update({ type: "toolcall_start", contentIndex: 1, id: "call_9", toolName });
      await update({ type: "toolcall_delta", contentIndex: 1, delta: JSON.stringify(toolArgs) });
      await update({ type: "toolcall_end", contentIndex: 1, toolCall: first.content[1] });
      await step({ type: "message_end", message: first });
      await step({ type: "tool_execution_start", toolCallId: "call_9", toolName, args: toolArgs });
      if (needsConfirm && !aborted) {
        const uiId = `ui-${Date.now()}`;
        const response = await new Promise<Record<string, unknown>>((resolve) => {
          uiWaiters.set(uiId, resolve);
          emit({
            type: "extension_ui_request",
            id: uiId,
            method: "confirm",
            title: "Allow bash?",
            message: JSON.stringify({ command: bashCmd }, null, 2),
          });
        });
        approved = response.confirmed === true;
      }
      const outText = approved ? '{ "name": "pipi" }' : "bash was declined by the user in pipi.";
      const result: AgentMessage = { role: "toolResult", toolCallId: "call_9", toolName, content: [{ type: "text", text: outText }], isError: !approved, timestamp: Date.now() };
      const finalReply = approved ? reply : "Understood, skipped the shell command.";
      const second: AgentMessage = { role: "assistant", content: [{ type: "text", text: finalReply }], provider: "anthropic", model: "claude-sonnet-4-5", usage, stopReason: "stop", timestamp: Date.now() };
      await step({ type: "tool_execution_end", toolCallId: "call_9", toolName, result: { content: [{ type: "text", text: outText }] }, isError: !approved, durationMs: 3 });
      await step({ type: "message_start", message: result });
      await step({ type: "message_end", message: result });
      await step({ type: "turn_end" });
      await step({ type: "turn_start" });
      await step({ type: "message_start", message: { ...second, content: [], stopReason: "pending" } });
      await update({ type: "text_start", contentIndex: 0 });
      for (const piece of finalReply.match(/[\s\S]{1,24}/g) ?? []) await update({ type: "text_delta", contentIndex: 0, delta: piece });
      await update({ type: "text_end", contentIndex: 0, content: finalReply });
      await step({ type: "message_end", message: second });
      await step({ type: "turn_end" });
      if (!aborted) {
        messages = [...messages, user, first, result, second];
        if (sessionFile) sessionMessages.set(sessionFile, messages);
      }
      isStreaming = false;
      emit({ type: "agent_end", willRetry: false });
      emit({ type: "agent_settled", aborted });
      aborted = false;
    }

    const answer = (command: Record<string, unknown>): unknown => {
      switch (command.type) {
        case "get_state":
          return snapshotState();
        case "get_messages":
          return { messages };
        case "get_available_models":
          return { models: modelsForAgent(agentId, custom) };
        case "get_available_thinking_levels":
          return { levels: defaultModel.reasoning ? ["off", "minimal", "low", "medium", "high"] : ["off"] };
        case "get_commands":
          // Pi lists the command pipi's own extension registers too (`pipi-runtime-mode`): plumbing the menu must not show.
          // Another engine reports its own commands through the bridge (`source: "agent"`): as Claude Code does,
          // some under the names of things the shell owns (the session, its name, the model).
          return agentId === "pi"
            ? {
                commands: [
                  { name: "pipi-runtime-mode", description: "Set pipi runtime permission mode", source: "extension" },
                  { name: "fix-tests", description: "Fix failing tests", source: "prompt" },
                  { name: "skill:review", description: "Review a change", source: "skill" },
                ],
              }
            : {
                commands: [
                  { name: "clear", description: "Start a new session with empty context", source: "agent", argumentHint: "[name]" },
                  { name: "model", description: "Set the AI model", source: "agent", argumentHint: "<model>" },
                  { name: "rename", description: "Rename the current conversation", source: "agent", argumentHint: "[name]" },
                  { name: "security-review", description: "Review the pending changes for security issues", source: "agent", argumentHint: "[path]" },
                ],
              };
        case "get_session_stats":
          return { sessionId, sessionFile, userMessages: 1, assistantMessages: 2, toolCalls: 2, toolResults: 2, totalMessages: messages.length, tokens: { input: 4570, output: 360, cacheRead: 0, cacheWrite: 0, total: 4930 }, cost: 0.016, contextUsage: { tokens: 24000, contextWindow: 200000, percent: 12 } };
        case "prompt":
          if (options.noModels) throw new Error("No API key found for the selected model.");
          // "refuse": Pi turns the prompt down before any run starts (a key gone missing, a model that left).
          if (String(command.message).includes("refuse")) throw new Error("No API key found for the selected model.");
          if (isStreaming) {
            const bucket = command.streamingBehavior === "steer" ? queued.steering : queued.followUp;
            bucket.push(String(command.message));
            emit({ type: "queue_update", steering: queued.steering, followUp: queued.followUp });
            return { disposition: "queued" };
          }
          void run(String(command.message), command.images as ImageContent[] | undefined);
          return { disposition: "started" };
        case "abort":
          aborted = isStreaming;
          return undefined;
        case "abort_retry":
          cancelRetry?.();
          return undefined;
        case "clear_queue": {
          const cleared = { steering: [...queued.steering], followUp: [...queued.followUp] };
          queued.steering.length = 0;
          queued.followUp.length = 0;
          emit({ type: "queue_update", steering: [], followUp: [] });
          return cleared;
        }
        case "new_session":
          messages = [];
          sessionFile = undefined;
          sessionName = undefined;
          sessionId = `session-${++sessionSeq}`;
          defaultModel = engineModel;
          defaultThinking = engineThinking;
          return { cancelled: false };
        case "switch_session": {
          sessionFile = String(command.sessionPath);
          messages = sessionMessages.get(sessionFile) ?? historyOf(sessionFile);
          sessionMessages.set(sessionFile, messages);
          const allKnown = [...sessions, ...Object.values(byWorkspace).flat()];
          sessionName = allKnown.find((s) => s.path === command.sessionPath)?.name;
          sessionId = `session-${++sessionSeq}`;
          return { cancelled: false };
        }
        case "set_model": {
          const model = modelsForAgent(agentId, custom).find((m) => m.id === command.modelId && m.provider === command.provider);
          if (!model) throw new Error(`Model not found: ${command.provider}/${command.modelId}`);
          defaultModel = model;
          return model;
        }
        case "set_thinking_level":
          defaultThinking = command.level as SessionState["thinkingLevel"];
          return undefined;
        case "set_session_name":
          sessionName = String(command.name);
          sessions = sessions.map((s) => (s.path === sessionFile ? { ...s, name: sessionName } : s));
          for (const list of Object.values(byWorkspace)) {
            const at = list.findIndex((s) => s.path === sessionFile);
            if (at >= 0) list[at] = { ...list[at], name: sessionName };
          }
          return undefined;
        case "set_steering_mode":
          steeringMode = command.mode as SessionState["steeringMode"];
          return undefined;
        case "set_follow_up_mode":
          followUpMode = command.mode as SessionState["followUpMode"];
          return undefined;
        case "set_auto_compaction":
          autoCompactionEnabled = !!command.enabled;
          return undefined;
        case "bash":
          return { output: "hello\n", exitCode: 0, cancelled: false, truncated: false };
        default:
          return undefined;
      }
    };

    if (options.dies && deathsLeft > 0) {
      deathsLeft--;
      setTimeout(() => die({ code: 0 }), options.dies.after);
    }

    return {
      write(text) {
        if (gone) throw new Error("Process has exited");
        for (const line of text.split("\n").filter(Boolean)) {
          const command = JSON.parse(line) as Record<string, unknown>;
          sent.push(command);
          if (command.type === "extension_ui_response") {
            const waiter = uiWaiters.get(String(command.id));
            if (waiter) {
              uiWaiters.delete(String(command.id));
              setTimeout(() => waiter(command), 0);
            }
            continue;
          }
          // Pi answers asynchronously: never inside the write.
          setTimeout(() => {
            try {
              emit({ id: command.id, type: "response", command: command.type, success: true, data: answer(command) });
            } catch (error) {
              emit({ id: command.id, type: "response", command: command.type, success: false, error: (error as Error).message });
            }
          }, command.type === "switch_session" ? (options.startDelay ?? 0) : 0);
        }
      },
      onStdout: (handler) => void (out = handler),
      onStderr: () => undefined,
      onExit: (handler) => void (exit = handler),
      end: () => setTimeout(() => die({ code: 0 }), 0),
      kill: () => die({ code: null, signal: "SIGKILL" }),
    };
  };

  /** What a session file not opened before holds. */
  const historyOf = (file: string): AgentMessage[] => {
    const sample = sampleHistory();
    const history = options.longHistories
      ? sample.map((message, at) => (at === sample.length - 1 ? ({ ...message, content: [{ type: "text", text: LONG_REPLY }] } as AgentMessage) : message))
      : sample;
    if (!options.distinctHistories) return history;
    const summary = [...sessions, ...Object.values(byWorkspace).flat()].find((s) => s.path === file);
    const asked = summary?.name || summary?.firstMessage;
    return asked ? [{ ...history[0], content: asked } as AgentMessage, ...history.slice(1)] : history;
  };

  const startup = () => (options.startDelay ? new Promise<void>((resolve) => setTimeout(resolve, options.startDelay)) : Promise.resolve());
  let stored: Record<string, "api_key" | "oauth"> = options.noModels ? {} : { anthropic: "api_key", openai: "oauth" };
  let activeAgent = "pi";
  let worktreeSeq = 1;
  let daemonSeq = 0;
  let daemonCmdSeq = 0;
  const fakeWorktrees: WorktreeInfo[] = [];

  const modelsForAgent = (agentId: string, custom?: { id: string; name: string; defaultModel?: string }): Model[] => {
    if (options.noModels) return [];
    if (custom) return [acpDefaultModel(custom as Parameters<typeof acpDefaultModel>[0])];
    const spec = builtinAgentSpec(agentId);
    if (spec) return spec.defaultModels.length ? spec.defaultModels : MODELS;
    return MODELS;
  };

  const agentNameOf = (agentId: string) => builtinAgentSpec(agentId)?.name ?? agentId;
  const driverOf = (agentId: string): string => builtinAgentSpec(agentId)?.driver ?? (agentId === "pi" ? "pi" : "acp");

  // ── A scripted session daemon ──────────────────────────────────────────────
  //
  // The in-process counterpart of `pipi-daemon.mjs`: one registry of daemon
  // sessions, each holding the fake agent process the session's attach spawns.
  // Detaching a session only stops forwarding its records — its process keeps
  // running, so a session left mid-run keeps going exactly as under the real
  // daemon (Sidebar/Switch tests lean on that).

  interface FakeDaemonSession extends DaemonSession {
    inner?: Transport;
    viewers?: {
      out: Array<(chunk: string) => void>;
      err: Array<(chunk: string) => void>;
      exit: Array<(e: Exit) => void>;
    };
    custom?: CustomAgentConfig;
  }

  const daemonSessions = new Map<string, FakeDaemonSession>();
  let daemonCallbacks: DaemonCallbacks | undefined;

  const daemonInfo = (s: FakeDaemonSession): DaemonSession => {
    const { inner: _inner, viewers: _viewers, custom: _custom, ...rest } = s;
    return { ...rest };
  };

  const pushDaemon = (s: FakeDaemonSession) => daemonCallbacks?.onSession(daemonInfo(s));

  /**
   * Watches a session's process records the way the real daemon does: run
   * starts and dialogs mark it `working`/`blocked`, a settle marks it `idle`
   * (and `unread` when nobody is attached), an exit `failed`/`interrupted`.
   * The daemon's own bookkeeping (`d_`-numbered commands) is swallowed; every
   * other line fans out to the attached viewers.
   */
  const wireDaemonSession = (s: FakeDaemonSession, inner: Transport) => {
    inner.onStdout((chunk) => {
      for (const line of chunk.split("\n")) {
        if (!line) continue;
        let record: { type?: string; id?: unknown; command?: string; success?: boolean; aborted?: boolean; data?: { sessionFile?: string } } | undefined;
        try {
          record = JSON.parse(line) as typeof record;
        } catch {
          record = undefined;
        }
        if (record?.type === "response" && String(record.id ?? "").startsWith("d_")) {
          if (record.command === "get_state" && record.success && record.data?.sessionFile && s.file !== record.data.sessionFile) {
            s.file = record.data.sessionFile;
            pushDaemon(s);
          }
          continue;
        }
        if (record?.type === "agent_start") {
          s.status = "working";
          s.lastActive = Date.now();
          // A run writes the session file as it starts: the daemon asks the process which one.
          if (!s.file) {
            try {
              inner.write(`${JSON.stringify({ id: `d_${++daemonCmdSeq}`, type: "get_state" })}\n`);
            } catch {}
          }
          pushDaemon(s);
        } else if (record?.type === "message_end") {
          const msg = (record as { message?: { role?: string; content?: unknown } }).message;
          // As the real daemon does: an unnamed session takes its title from its first user message.
          if (msg?.role === "user" && (!s.title || s.title === "New session")) {
            const text = Array.isArray(msg.content)
              ? msg.content.filter((b): b is { type: string; text: string } => (b as { type?: string }).type === "text" && typeof (b as { text?: unknown }).text === "string").map((b) => b.text).join(" ")
              : "";
            if (text.trim() && !text.trimStart().startsWith("<pipi-message")) {
              s.title = text.replace(/\s+/g, " ").trim().slice(0, 48);
              pushDaemon(s);
            }
          }
        } else if (record?.type === "agent_settled") {
          s.status = "idle";
          s.lastActive = Date.now();
          // An aborted turn reports nothing: it stopped because it was told to.
          if (!s.viewers && !record.aborted) s.unread = true;
          pushDaemon(s);
        } else if (record?.type === "extension_ui_request") {
          s.status = "blocked";
          s.lastActive = Date.now();
          pushDaemon(s);
        }
        for (const h of s.viewers?.out ?? []) h(`${line}\n`);
      }
    });
    inner.onStderr((chunk) => {
      for (const h of s.viewers?.err ?? []) h(chunk);
    });
    inner.onExit((e) => {
      s.inner = undefined;
      s.loaded = false;
      s.status = s.status === "working" || s.status === "blocked" ? "failed" : "interrupted";
      pushDaemon(s);
      for (const h of s.viewers?.exit ?? []) h({ code: e.code ?? null, signal: e.signal ?? undefined });
    });
  };

  /** A session's process, as the daemon spawns it: `starts`/`dies`/`failStart`/`startDelay` all apply here. */
  const spawnDaemonProcess = async (s: FakeDaemonSession): Promise<Transport> => {
    if (options.failStart || startsLeft-- <= 0) throw new Error("spawn node ENOENT");
    await startup();
    activeCwd = s.cwd;
    activeAgent = s.agentId;
    defaultModel = modelsForAgent(s.agentId, s.custom)[0] ?? UNKNOWN;
    defaultThinking = defaultModel.reasoning ? "medium" : "off";
    const inner = transport(s.cwd, s.agentId, s.agentId === "pi" ? (options.history ?? []) : [], s.custom);
    wireDaemonSession(s, inner);
    return inner;
  };

  /** A session and every generation under it. */
  const daemonTree = (id: string): FakeDaemonSession[] =>
    [...daemonSessions.values()].filter((s) => s.parentId === id).flatMap((child) => [child, ...daemonTree(child.id)]);

  /** What the daemon sends one of its sessions (`d_` ids keep its responses off the app's screen). */
  const daemonWrite = (s: FakeDaemonSession, record: Record<string, unknown>) => {
    try {
      s.inner?.write(`${JSON.stringify({ id: `d_${++daemonCmdSeq}`, ...record })}\n`);
    } catch {}
  };

  const api: Backend & { sent: Record<string, unknown>[] } = {
    sent,
    home: () => "/Users/pip",
    dataDir: () => "/Users/pip/Library/Application Support/dev.pipi.app",
    async probeAgents(probeOpts) {
      const defaults = defaultAgentStatuses(probeOpts?.customAgents);
      return defaults.map((a): AgentHarnessStatus => {
        if (a.id === "pi")
          return {
            ...a,
            available: true,
            binaryPath: "/Users/pip/.nvm/versions/node/v24.13.0/bin/pi",
            version: "Pi 1.5.0",
            statusText: "Signed in (~/.pi/agent/auth.json) · Pi 1.5.0",
          };
        if (a.id === "claude") return { ...a, available: true, binaryPath: "/Users/pip/.nvm/versions/node/v24.13.0/bin/claude", version: "2.1.302 (Claude Code)", statusText: "CLI ready · 2.1.302 (Claude Code)" };
        if (a.id === "codex") return { ...a, available: true, binaryPath: "/Users/pip/.nvm/versions/node/v24.13.0/bin/codex", version: "codex-cli 0.166.0", statusText: "Signed in (~/.codex/auth.json) · codex-cli 0.166.0" };
        if (a.isCustom) return { ...a, available: true, statusText: `${a.binaryPath ?? "acp"} · Custom ACP` };
        return { ...a, available: false, statusText: "Not installed" };
      });
    },
    async startPi(cwd) {
      if (options.failStart || startsLeft-- <= 0) throw new Error("spawn node ENOENT");
      await startup();
      activeCwd = cwd;
      activeAgent = "pi";
      defaultModel = options.noModels ? UNKNOWN : MODELS[0];
      defaultThinking = options.noModels ? "off" : "medium";
      return transport(cwd, "pi", options.history ?? []);
    },
    async startAgent(startOpts) {
      if (options.failStart || startsLeft-- <= 0) throw new Error("spawn node ENOENT");
      await startup();
      activeCwd = startOpts.cwd;
      activeAgent = startOpts.agentId;
      defaultModel = modelsForAgent(startOpts.agentId, startOpts.customAgent)[0] ?? UNKNOWN;
      defaultThinking = defaultModel.reasoning ? "medium" : "off";
      return transport(startOpts.cwd, startOpts.agentId, startOpts.agentId === "pi" ? (options.history ?? []) : [], startOpts.customAgent);
    },
    async usageStats() {
      return sampleUsage();
    },
    async worktreeStatus(cwd) {
      return {
        isGitRepo: true,
        root: cwd,
        branch: cwd.includes(".pipi-worktrees") ? "pipi/isolated" : "main",
        dirty: false,
        worktrees: fakeWorktrees,
      };
    },
    async createWorktree(cwd, label) {
      const idx = worktreeSeq++;
      const clean = label.replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
      const wt: WorktreeInfo = {
        path: `/Users/pip/code/.pipi-worktrees/${clean}-${idx}`,
        branch: `pipi/${clean}-${idx}`,
        baseCwd: cwd,
        headCommit: "abc1234",
      };
      fakeWorktrees.push(wt);
      return wt;
    },
    async removeWorktree(_cwd, wtPath) {
      const i = fakeWorktrees.findIndex((w) => w.path === wtPath);
      if (i >= 0) fakeWorktrees.splice(i, 1);
    },
    async connectDaemon(callbacks: DaemonCallbacks): Promise<DaemonClient> {
      daemonCallbacks = callbacks;
      const client = {
        session(id?: string) {
          const s = id ? daemonSessions.get(id) : undefined;
          return s ? daemonInfo(s) : undefined;
        },
        async list() {
          return [...daemonSessions.values()].map(daemonInfo);
        },
        async attach(spec: DaemonAttachSpec) {
          let s = (spec.id ? daemonSessions.get(spec.id) : undefined) ?? (spec.file ? [...daemonSessions.values()].find((k) => k.file === spec.file) : undefined);
          if (!s) {
            s = {
              id: `s_fake_${++daemonSeq}`,
              title: spec.title || "New session",
              cwd: spec.cwd,
              file: spec.file,
              agentId: spec.agentId,
              agentName: spec.agentName ?? agentNameOf(spec.agentId),
              driver: spec.driver ?? driverOf(spec.agentId),
              initiator: "user",
              runtimeMode: spec.runtimeMode ?? "full-access",
              worktree: fakeWorktrees.find((w) => spec.cwd === w.path),
              status: "idle",
              unread: false,
              loaded: false,
              depth: 0,
              createdAt: Date.now(),
              lastActive: Date.now(),
              custom: spec.customAgent,
            };
            daemonSessions.set(s.id, s);
            pushDaemon(s);
          }
          if (spec.title) s.title = spec.title;
          const file = spec.file ?? s.file;
          if (!s.inner) {
            const inner = await spawnDaemonProcess(s);
            s.inner = inner;
            if (file) {
              // As the real daemon does: the process is on the session's file before the attach answers.
              inner.write(`${JSON.stringify({ id: `d_${++daemonCmdSeq}`, type: "switch_session", sessionPath: file })}\n`);
              await new Promise<void>((r) => setTimeout(r, (options.startDelay ?? 0) + 1));
            }
          }
          if (file) s.file = file;
          s.loaded = true;
          s.unread = false;
          if (s.status === "failed" || s.status === "interrupted") s.status = "idle";
          pushDaemon(s);
          const viewers = { out: [] as Array<(chunk: string) => void>, err: [] as Array<(chunk: string) => void>, exit: [] as Array<(e: Exit) => void> };
          s.viewers = viewers;
          let ended = false;
          const detach = () => {
            if (ended) return;
            ended = true;
            if (s.viewers === viewers) s.viewers = undefined;
            for (const h of viewers.exit.splice(0)) h({ code: 0 });
          };
          const virtual = {
            sessionId: s.id,
            write(text: string) {
              if (ended) throw new Error("Session detached");
              if (!s.inner) throw new Error("Process has exited");
              // The daemon watches writes too: an answer un-blocks a session waiting on it.
              for (const line of text.split("\n")) {
                if (!line) continue;
                let record: { type?: string } | undefined;
                try {
                  record = JSON.parse(line) as typeof record;
                } catch {
                  record = undefined;
                }
                if (record?.type === "extension_ui_response" && s.status === "blocked") {
                  s.status = "working";
                  pushDaemon(s);
                }
              }
              s.inner.write(text);
            },
            onStdout: (h: (chunk: string) => void) => void viewers.out.push(h),
            onStderr: (h: (chunk: string) => void) => void viewers.err.push(h),
            onExit: (h: (e: Exit) => void) => void viewers.exit.push(h),
            end: detach,
            kill: detach,
          };
          return { transport: virtual as unknown as Transport, session: daemonInfo(s) };
        },
        async killSession(sessionId: string) {
          const s = daemonSessions.get(sessionId);
          s?.inner?.kill();
        },
        async stopTree(sessionId: string) {
          const own = daemonSessions.get(sessionId);
          for (const s of [own, ...daemonTree(sessionId)]) {
            if (s) daemonWrite(s, { type: "abort" });
          }
        },
        async stopAll() {
          for (const s of daemonSessions.values()) {
            daemonWrite(s, { type: "abort" });
          }
        },
        markRead(sessionId: string) {
          const s = daemonSessions.get(sessionId);
          if (s && s.unread) {
            s.unread = false;
            pushDaemon(s);
          }
        },
        setRuntimeMode(sessionId: string, mode: RuntimeMode) {
          const s = daemonSessions.get(sessionId);
          if (s) {
            s.runtimeMode = mode;
            pushDaemon(s);
          }
        },
        reportFile(sessionId: string, file?: string) {
          const s = daemonSessions.get(sessionId);
          if (s && file && s.file !== file) {
            s.file = file;
            pushDaemon(s);
          }
        },
        async startSession(input: { title: string; agentId: string; cwd: string; message?: string; parentId?: string; runtimeMode?: RuntimeMode; worktree?: boolean }) {
          const parent = input.parentId ? daemonSessions.get(input.parentId) : undefined;
          // As the real daemon does: `worktree` asks for an isolated branch under the given cwd.
          const wt = input.worktree && api.createWorktree ? await api.createWorktree(input.cwd, input.agentId) : undefined;
          const s: FakeDaemonSession = {
            id: `s_fake_${++daemonSeq}`,
            title: input.title || "New session",
            cwd: wt?.path ?? input.cwd,
            agentId: input.agentId,
            agentName: agentNameOf(input.agentId),
            driver: driverOf(input.agentId),
            parentId: input.parentId,
            initiator: "user",
            runtimeMode: input.runtimeMode ?? "full-access",
            worktree: wt ?? fakeWorktrees.find((w) => input.cwd === w.path),
            status: "idle",
            unread: false,
            loaded: false,
            depth: parent ? parent.depth + 1 : 0,
            createdAt: Date.now(),
            lastActive: Date.now(),
          };
          daemonSessions.set(s.id, s);
          pushDaemon(s);
          try {
            s.inner = await spawnDaemonProcess(s);
          } catch (error) {
            s.status = "failed";
            pushDaemon(s);
            throw error;
          }
          s.loaded = true;
          pushDaemon(s);
          if (input.message) daemonWrite(s, { type: "prompt", message: input.message });
          return daemonInfo(s);
        },
        configure() {},
        async externalMcp() {
          return { url: "http://127.0.0.1:49999/mcp", token: "fake" };
        },
        async installCli() {
          return "/Users/pip/.local/bin/pipix";
        },
        close() {},
      };
      for (const s of daemonSessions.values()) pushDaemon(s);
      return client as unknown as DaemonClient;
    },
    listSessions: async (cwd) => byWorkspace[cwd] ?? sessions,
    async listWorkspaceSessions(cwds) {
      return Object.fromEntries(cwds.map((cwd) => [cwd, byWorkspace[cwd] ?? sessions]));
    },
    async deleteSession(path) {
      sessions = sessions.filter((s) => s.path !== path);
      for (const cwd of Object.keys(byWorkspace)) {
        byWorkspace[cwd] = byWorkspace[cwd].filter((s) => s.path !== path);
      }
    },
    storedCredentials: async () => stored,
    async saveApiKey(provider) {
      stored = { ...stored, [provider]: "api_key" };
      options.noModels = false;
      defaultModel = MODELS[0];
      defaultThinking = "medium";
    },
    async removeCredential(provider) {
      const { [provider]: _, ...rest } = stored;
      stored = rest;
    },
    pickFolder: async () => options.pickedFolder,
    pickImage: async () => options.pickedImage,
    async checkAppUpdate() {
      const u = options.update;
      if (!u) return null;
      return {
        version: u.version ?? "9.9.9",
        notes: u.notes ?? "A shinier coat, a steadier step, and everything a little quicker.",
        url: "https://github.com/blueberrycongee/pipi/releases",
        canInstall: u.canInstall ?? true,
      };
    },
    async downloadAppUpdate(onProgress) {
      const u = options.update;
      if (!u) throw new Error("no update found");
      const total = u.bytes ?? 24_000_000;
      const rate = u.rate ?? 60_000;
      const totalArg = u.unknownSize ? undefined : total;
      let received = 0;
      while (received < total) {
        await new Promise<void>((resolve) => setTimeout(resolve, 30));
        received = Math.min(total, received + rate * 30);
        onProgress?.({ received, total: totalArg });
      }
    },
    // The real install never resolves: the app restarts first. So does the
    // fake — the "installing" card is what it leaves on screen.
    installAppUpdate: () => new Promise<void>(() => {}),
  };
  return api;
}
