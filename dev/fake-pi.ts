import { acpDefaultModel, builtinAgentSpec, defaultAgentStatuses } from "../agents/catalog";
import type { AgentHarnessStatus, DelegatedTask, RuntimeMode, WorktreeInfo } from "../agents/types";
import type { Exit, Transport } from "../pi/client";
import type { AgentMessage, ImageContent, Model, SessionState } from "../pi/protocol";
import type { SessionSummary } from "../pi/sessions";
import type { Backend, OrchestratorCallbacks, OrchestratorHandle } from "../store/backend";

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
  /** The reply a run streams: the answer text instead of `REPLY`/`STEPS_REPLY`. */
  reply?: string;
}

const MODELS: Model[] = [
  { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", api: "anthropic-messages", provider: "anthropic", reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 16384, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", api: "anthropic-messages", provider: "anthropic", reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 16384, cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } },
  { id: "gpt-5.1", name: "GPT-5.1", api: "openai-responses", provider: "openai", reasoning: true, input: ["text", "image"], contextWindow: 400000, maxTokens: 32768, cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 } },
  { id: "deepseek-chat", name: "DeepSeek Chat", api: "openai-completions", provider: "deepseek", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 8192, cost: { input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0 } },
];

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

  /** One agent process: its own session, messages and stream state, as Pi has per process. */
  const transport = (cwd: string, agentId: string, initial: AgentMessage[], custom?: { id: string; name: string; defaultModel?: string }): Transport => {
    // A fresh session opens on the engine's configured default, like Pi — not on the last pick.
    const engineModel = defaultModel;
    const engineThinking = defaultThinking;
    let messages = initial;
    let sessionFile: string | undefined = initial.length ? "/sessions/one.jsonl" : undefined;
    let sessionName: string | undefined;
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
    const emit = (record: object) => out(`${JSON.stringify(record)}\n`);
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
      const tools = plain
        ? []
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
      if (!(byWorkspace[cwd] ?? sessions).some((s) => s.path === sessionFile)) {
        const entry = { path: sessionFile, id: sessionId, firstMessage: prompt, messageCount: 1, created: Date.now(), modified: Date.now() };
        if (byWorkspace[cwd]) byWorkspace[cwd] = [entry, ...byWorkspace[cwd]];
        else sessions = [entry, ...sessions];
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
          return { commands: [{ name: "fix-tests", description: "Fix failing tests", source: "prompt" }, { name: "skill:review", description: "Review a change", source: "skill" }] };
        case "get_session_stats":
          return { sessionId, sessionFile, userMessages: 1, assistantMessages: 2, toolCalls: 2, toolResults: 2, totalMessages: messages.length, tokens: { input: 4570, output: 360, cacheRead: 0, cacheWrite: 0, total: 4930 }, cost: 0.016, contextUsage: { tokens: 24000, contextWindow: 200000, percent: 12 } };
        case "prompt":
          if (options.noModels) throw new Error("No API key found for the selected model.");
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
        case "clear_queue":
          queued.steering.length = 0;
          queued.followUp.length = 0;
          emit({ type: "queue_update", steering: [], followUp: [] });
          return { steering: [], followUp: [] };
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
          messages = sessionMessages.get(sessionFile) ?? sampleHistory();
          sessionMessages.set(sessionFile, messages);
          const allKnown = [...sessions, ...Object.values(byWorkspace).flat()];
          sessionName = allKnown.find((s) => s.path === command.sessionPath)?.name;
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

    return {
      write(text) {
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
      end: () => setTimeout(() => exit({ code: 0 }), 0),
      kill: () => exit({ code: null, signal: "SIGKILL" }),
    };
  };

  const startup = () => (options.startDelay ? new Promise<void>((resolve) => setTimeout(resolve, options.startDelay)) : Promise.resolve());
  let stored: Record<string, "api_key" | "oauth"> = options.noModels ? {} : { anthropic: "api_key", openai: "oauth" };
  let activeAgent = "pi";
  let worktreeSeq = 1;
  let taskSeq = 1;
  const fakeWorktrees: WorktreeInfo[] = [];

  const modelsForAgent = (agentId: string, custom?: { id: string; name: string; defaultModel?: string }): Model[] => {
    if (options.noModels) return [];
    if (custom) return [acpDefaultModel(custom as Parameters<typeof acpDefaultModel>[0])];
    const spec = builtinAgentSpec(agentId);
    if (spec) return spec.defaultModels.length ? spec.defaultModels : MODELS;
    return MODELS;
  };

  return {
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
      if (options.failStart) throw new Error("spawn node ENOENT");
      await startup();
      activeCwd = cwd;
      activeAgent = "pi";
      defaultModel = options.noModels ? UNKNOWN : MODELS[0];
      defaultThinking = options.noModels ? "off" : "medium";
      return transport(cwd, "pi", options.history ?? []);
    },
    async startAgent(startOpts) {
      if (options.failStart) throw new Error("spawn node ENOENT");
      await startup();
      activeCwd = startOpts.cwd;
      activeAgent = startOpts.agentId;
      defaultModel = modelsForAgent(startOpts.agentId, startOpts.customAgent)[0] ?? UNKNOWN;
      defaultThinking = defaultModel.reasoning ? "medium" : "off";
      return transport(startOpts.cwd, startOpts.agentId, startOpts.agentId === "pi" ? (options.history ?? []) : [], startOpts.customAgent);
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
    async createWorktree(_cwd, label) {
      const idx = worktreeSeq++;
      const clean = label.replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
      const wt: WorktreeInfo = {
        path: `/Users/pip/code/.pipi-worktrees/${clean}-${idx}`,
        branch: `pipi/${clean}-${idx}`,
        headCommit: "abc1234",
      };
      fakeWorktrees.push(wt);
      return wt;
    },
    async removeWorktree(_cwd, wtPath) {
      const i = fakeWorktrees.findIndex((w) => w.path === wtPath);
      if (i >= 0) fakeWorktrees.splice(i, 1);
    },
    async startOrchestrator(callbacks: OrchestratorCallbacks): Promise<OrchestratorHandle> {
      const runningTasks = new Map<string, Omit<DelegatedTask, "rows">>();
      return {
        url: "http://127.0.0.1:49999/mcp",
        token: "fake-orch-token",
        configure() {},
        async delegate(input) {
          const id = `task_${taskSeq++}`;
          const agentNames: Record<string, string> = { pi: "Pi", claude: "Claude Code", codex: "Codex" };
          const agentName = agentNames[input.agentId ?? "pi"] ?? input.agentId ?? "Pi";
          const wt: WorktreeInfo | undefined =
            input.isolation === "worktree"
              ? {
                  path: `/Users/pip/code/.pipi-worktrees/${input.agentId ?? "pi"}-${id}`,
                  branch: `pipi/${input.agentId ?? "pi"}-${id}`,
                  headCommit: "def5678",
                }
              : undefined;
          const startedAt = Date.now();
          const task: Omit<DelegatedTask, "rows"> = {
            id,
            groupId: input.groupId,
            workflowKind: input.workflowKind ?? "delegate",
            stepIndex: input.stepIndex,
            title: input.title || `${agentName} · Subtask`,
            task: input.task,
            agentId: input.agentId ?? "pi",
            agentName,
            model: input.model ?? (input.agentId === "claude" ? "claude-sonnet-4-6" : input.agentId === "codex" ? "gpt-5.3-codex" : "claude-sonnet-4-5"),
            role: input.role ?? "general",
            runtimeMode: (input.runtimeMode ?? "full-access") as RuntimeMode,
            isolation: input.isolation ?? "shared",
            cwd: wt ? wt.path : (input.cwd ?? activeCwd),
            worktree: wt,
            status: "running",
            startedAt,
            summary: "",
            activityLabel: `Running ${agentName}…`,
          };
          runningTasks.set(id, task);
          callbacks.onTaskStarted({ ...task });

          const finishTask = async () => {
            await new Promise<void>((r) => setTimeout(r, options.pace ? Math.min(options.pace, 50) : 10));
            const cur = runningTasks.get(id);
            if (!cur || cur.status === "cancelled") return;
            const summaryText = `${agentName} completed (${cur.role}): Verified changes${wt ? ` in branch ${wt.branch}` : ""}.`;
            const assistantMsg: AgentMessage = {
              role: "assistant",
              content: [{ type: "text", text: summaryText }],
              provider: cur.agentId,
              model: cur.model ?? "model",
              usage,
              stopReason: "stop",
              timestamp: Date.now(),
            };
            callbacks.onTaskEvent(id, { type: "agent_start" });
            callbacks.onTaskEvent(id, { type: "message_start", message: { ...assistantMsg, content: [], stopReason: "pending" } });
            callbacks.onTaskEvent(id, { type: "message_update", usage, assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
            callbacks.onTaskEvent(id, { type: "message_update", usage, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: summaryText } });
            callbacks.onTaskEvent(id, { type: "message_update", usage, assistantMessageEvent: { type: "text_end", contentIndex: 0, content: summaryText } });
            callbacks.onTaskEvent(id, { type: "message_end", message: assistantMsg });
            callbacks.onTaskEvent(id, { type: "agent_settled", aborted: false });
            cur.status = "completed";
            cur.completedAt = Date.now();
            cur.summary = summaryText;
            cur.activityLabel = "Completed";
            callbacks.onTaskUpdated({ ...cur });
          };

          if (input.mode === "sync") {
            await finishTask();
            return { ...runningTasks.get(id)! };
          }
          void finishTask();
          return { ...task };
        },
        async cancel(taskId) {
          const cur = runningTasks.get(taskId);
          if (cur) {
            cur.status = "cancelled";
            cur.completedAt = Date.now();
            cur.activityLabel = "Cancelled";
            callbacks.onTaskUpdated({ ...cur });
          }
        },
        respondUi() {},
        close() {},
      };
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
  };
}
