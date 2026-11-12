import type { AssistantMessage, SessionEvent, ToolCall } from "../pi/protocol";

/**
 * Pure protocol normalizers that translate external coding agent event streams
 * (`Claude Code` stream-json, `Codex` exec --json / app-server, `OpenCode` JSON,
 * and `ACP` Agent Client Protocol `session/update`) into Pi's canonical
 * `SessionEvent` stream.
 *
 * Kept pure and dependency-free so both `sidecar/external-agent.mjs` (Node)
 * and `agents/agents.test.ts` (QuickJS unit tests) can exercise the exact logic.
 */

const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export interface StreamTranslatorState {
  provider: string;
  model: string;
  sessionId?: string;
  started: boolean;
  messageOpen: boolean;
  nextIndex: number;
  textIndex?: number;
  textBuffer: string;
  thinkingIndex?: number;
  thinkingBuffer: string;
  blocks: AssistantMessage["content"];
  openTools: Map<string, { index: number; name: string; args: Record<string, unknown>; startedAt: number }>;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
}

export function createTranslatorState(provider: string, model: string): StreamTranslatorState {
  return {
    provider,
    model,
    started: false,
    messageOpen: false,
    nextIndex: 0,
    textBuffer: "",
    thinkingBuffer: "",
    blocks: [],
    openTools: new Map(),
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCost: 0,
  };
}

function ensureMessageOpen(state: StreamTranslatorState, out: SessionEvent[]) {
  if (!state.started) {
    state.started = true;
    out.push({ type: "agent_start" }, { type: "turn_start" });
  }
  if (!state.messageOpen) {
    state.messageOpen = true;
    state.nextIndex = 0;
    state.textIndex = undefined;
    state.textBuffer = "";
    state.thinkingIndex = undefined;
    state.thinkingBuffer = "";
    state.blocks = [];
    out.push({
      type: "message_start",
      message: {
        role: "assistant",
        content: [],
        provider: state.provider,
        model: state.model,
        usage: zeroUsage,
        stopReason: "pending",
        timestamp: Date.now(),
      },
    });
  }
}

export function appendThinkingDelta(state: StreamTranslatorState, delta: string, out: SessionEvent[]) {
  if (!delta) return;
  ensureMessageOpen(state, out);
  if (state.thinkingIndex === undefined) {
    state.thinkingIndex = state.nextIndex++;
    state.thinkingBuffer = "";
    out.push({
      type: "message_update",
      usage: zeroUsage,
      assistantMessageEvent: { type: "thinking_start", contentIndex: state.thinkingIndex },
    });
  }
  state.thinkingBuffer += delta;
  out.push({
    type: "message_update",
    usage: zeroUsage,
    assistantMessageEvent: { type: "thinking_delta", contentIndex: state.thinkingIndex, delta },
  });
}

export function closeThinkingIfOpen(state: StreamTranslatorState, out: SessionEvent[]) {
  if (state.thinkingIndex === undefined) return;
  const idx = state.thinkingIndex;
  const content = state.thinkingBuffer;
  state.thinkingIndex = undefined;
  state.blocks.push({ type: "thinking", thinking: content });
  out.push({
    type: "message_update",
    usage: zeroUsage,
    assistantMessageEvent: { type: "thinking_end", contentIndex: idx, content },
  });
}

export function appendTextDelta(state: StreamTranslatorState, delta: string, out: SessionEvent[]) {
  if (!delta) return;
  ensureMessageOpen(state, out);
  closeThinkingIfOpen(state, out);
  if (state.textIndex === undefined) {
    state.textIndex = state.nextIndex++;
    state.textBuffer = "";
    out.push({
      type: "message_update",
      usage: zeroUsage,
      assistantMessageEvent: { type: "text_start", contentIndex: state.textIndex },
    });
  }
  state.textBuffer += delta;
  out.push({
    type: "message_update",
    usage: zeroUsage,
    assistantMessageEvent: { type: "text_delta", contentIndex: state.textIndex, delta },
  });
}

export function closeTextIfOpen(state: StreamTranslatorState, out: SessionEvent[]) {
  if (state.textIndex === undefined) return;
  const idx = state.textIndex;
  const content = state.textBuffer;
  state.textIndex = undefined;
  state.blocks.push({ type: "text", text: content });
  out.push({
    type: "message_update",
    usage: zeroUsage,
    assistantMessageEvent: { type: "text_end", contentIndex: idx, content },
  });
}

export function emitToolStart(
  state: StreamTranslatorState,
  toolId: string,
  toolName: string,
  args: Record<string, unknown>,
  out: SessionEvent[],
) {
  if (state.openTools.has(toolId)) return;
  ensureMessageOpen(state, out);
  closeThinkingIfOpen(state, out);
  closeTextIfOpen(state, out);
  const idx = state.nextIndex++;
  const normalizedName = normalizeToolName(toolName);
  const toolCall: ToolCall = { type: "toolCall", id: toolId, name: normalizedName, arguments: args };
  state.blocks.push(toolCall);
  state.openTools.set(toolId, { index: idx, name: normalizedName, args, startedAt: Date.now() });
  out.push(
    {
      type: "message_update",
      usage: zeroUsage,
      assistantMessageEvent: { type: "toolcall_start", contentIndex: idx, id: toolId, toolName: normalizedName },
    },
    {
      type: "message_update",
      usage: zeroUsage,
      assistantMessageEvent: { type: "toolcall_end", contentIndex: idx, toolCall },
    },
    {
      type: "tool_execution_start",
      toolCallId: toolId,
      toolName: normalizedName,
      args,
    },
  );
}

export function emitToolEnd(
  state: StreamTranslatorState,
  toolId: string,
  outputText: string,
  isError: boolean,
  out: SessionEvent[],
  details?: unknown,
) {
  const existing = state.openTools.get(toolId);
  const toolName = existing?.name ?? "tool";
  const durationMs = existing ? Math.max(1, Date.now() - existing.startedAt) : undefined;
  state.openTools.delete(toolId);
  const content = [{ type: "text" as const, text: outputText }];
  out.push(
    {
      type: "tool_execution_end",
      toolCallId: toolId,
      toolName,
      result: { content, ...(details !== undefined ? { details } : {}) },
      isError,
      durationMs,
    },
    {
      type: "message_end",
      message: {
        role: "toolResult",
        toolCallId: toolId,
        toolName,
        content,
        ...(details !== undefined ? { details } : {}),
        isError,
        timestamp: Date.now(),
      },
    },
  );
}

export function finalizeTurn(
  state: StreamTranslatorState,
  stopReason: AssistantMessage["stopReason"],
  out: SessionEvent[],
  errorMessage?: string,
): AssistantMessage | undefined {
  closeThinkingIfOpen(state, out);
  closeTextIfOpen(state, out);
  let assistantMsg: AssistantMessage | undefined;
  if (state.messageOpen) {
    state.messageOpen = false;
    assistantMsg = {
      role: "assistant",
      content: state.blocks.slice(),
      provider: state.provider,
      model: state.model,
      usage: {
        input: state.totalInputTokens,
        output: state.totalOutputTokens,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: state.totalInputTokens + state.totalOutputTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: state.totalCost },
      },
      stopReason,
      ...(errorMessage ? { errorMessage } : {}),
      timestamp: Date.now(),
    };
    out.push({ type: "message_end", message: assistantMsg });
  }
  if (state.started) {
    state.started = false;
    out.push({ type: "turn_end" });
  }
  return assistantMsg;
}

/** Maps Claude Code / Codex / ACP tool names to pipi's clean tool icons & summaries where obvious. */
export function normalizeToolName(raw: string): string {
  const lower = raw.trim();
  switch (lower) {
    case "Bash":
    case "shell":
    case "command_execution":
    case "execute_command":
      return "bash";
    case "Read":
    case "read_file":
      return "read";
    case "Write":
    case "write_file":
      return "write";
    case "Edit":
    case "MultiEdit":
    case "file_change":
      return "edit";
    case "Grep":
      return "grep";
    case "Glob":
      return "find";
    case "LS":
      return "ls";
    default:
      return lower.replace(/^mcp__(?:pipi|t3[-_]code)__/, "");
  }
}

/** Translates one Claude Code `--output-format stream-json` record into `SessionEvent[]`. */
export function translateClaudeStreamRecord(state: StreamTranslatorState, record: Record<string, unknown>): SessionEvent[] {
  const out: SessionEvent[] = [];
  const type = record.type;
  if (typeof record.session_id === "string" && record.session_id) {
    state.sessionId = record.session_id;
  }
  if (type === "stream_event" && record.event && typeof record.event === "object") {
    const ev = record.event as Record<string, unknown>;
    if (ev.type === "content_block_delta" && ev.delta && typeof ev.delta === "object") {
      const delta = ev.delta as Record<string, unknown>;
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        appendTextDelta(state, delta.text, out);
      } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
        appendThinkingDelta(state, delta.thinking, out);
      }
    }
    return out;
  }

  if (type === "assistant" && record.message && typeof record.message === "object") {
    const msg = record.message as { content?: unknown[]; model?: string; usage?: Record<string, number> };
    if (typeof msg.model === "string") state.model = msg.model;
    if (msg.usage) {
      state.totalInputTokens = Math.max(state.totalInputTokens, Number(msg.usage.input_tokens ?? 0));
      state.totalOutputTokens = Math.max(state.totalOutputTokens, Number(msg.usage.output_tokens ?? 0));
    }
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (b.type === "thinking" && typeof b.thinking === "string" && state.thinkingIndex === undefined && !state.blocks.some((x) => x.type === "thinking")) {
          appendThinkingDelta(state, b.thinking, out);
          closeThinkingIfOpen(state, out);
        } else if (b.type === "text" && typeof b.text === "string" && state.textIndex === undefined && !state.blocks.some((x) => x.type === "text" && x.text === b.text)) {
          // Only emit full text if partial deltas didn't already stream it
          if (!state.textBuffer) {
            appendTextDelta(state, b.text, out);
            closeTextIfOpen(state, out);
          }
        } else if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
          const args = b.input && typeof b.input === "object" ? (b.input as Record<string, unknown>) : {};
          emitToolStart(state, b.id, b.name, args, out);
        }
      }
    }
    return out;
  }

  if (type === "user" && record.message && typeof record.message === "object") {
    const msg = record.message as { content?: unknown[] };
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
          const text =
            typeof b.content === "string"
              ? b.content
              : Array.isArray(b.content)
                ? b.content
                    .map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
                    .filter(Boolean)
                    .join("\n")
                : "";
          emitToolEnd(state, b.tool_use_id, text, b.is_error === true, out);
        }
      }
    }
    return out;
  }

  if (type === "result") {
    if (typeof record.total_cost_usd === "number") state.totalCost = record.total_cost_usd;
    const isErr = record.is_error === true;
    const errText = isErr && typeof record.result === "string" ? record.result : undefined;
    if (!isErr && typeof record.result === "string" && record.result && state.blocks.length === 0 && !state.textBuffer) {
      appendTextDelta(state, record.result, out);
    }
    finalizeTurn(state, isErr ? "error" : "stop", out, errText);
  }
  return out;
}

/** Translates one Codex `codex exec --json` JSONL event into `SessionEvent[]`. */
export function translateCodexExecRecord(state: StreamTranslatorState, record: Record<string, unknown>): SessionEvent[] {
  const out: SessionEvent[] = [];
  const type = String(record.type ?? "");
  if (type === "thread.started" && typeof record.thread_id === "string") {
    state.sessionId = record.thread_id;
    return out;
  }
  if (type === "turn.started") {
    ensureMessageOpen(state, out);
    return out;
  }
  if ((type === "item.started" || type === "item.updated" || type === "item.completed") && record.item && typeof record.item === "object") {
    const item = record.item as Record<string, unknown>;
    const itemId = typeof item.id === "string" ? item.id : "item";
    const itemType = String(item.type ?? "");
    if (itemType === "reasoning") {
      const text = typeof item.text === "string" ? item.text : "";
      if (type === "item.completed" && text && !state.thinkingBuffer) {
        appendThinkingDelta(state, text, out);
        closeThinkingIfOpen(state, out);
      }
    } else if (itemType === "agent_message") {
      const text = typeof item.text === "string" ? item.text : "";
      if (text) {
        const delta = text.startsWith(state.textBuffer) ? text.slice(state.textBuffer.length) : text;
        appendTextDelta(state, delta, out);
        if (type === "item.completed") closeTextIfOpen(state, out);
      }
    } else if (itemType === "command_execution") {
      const cmd = typeof item.command === "string" ? item.command : "";
      emitToolStart(state, itemId, "bash", { command: cmd }, out);
      if (type === "item.completed") {
        const output = typeof item.aggregated_output === "string" ? item.aggregated_output : "";
        const exitCode = typeof item.exit_code === "number" ? item.exit_code : 0;
        emitToolEnd(state, itemId, output, exitCode !== 0, out);
      }
    } else if (itemType === "file_change") {
      const changes = Array.isArray(item.changes) ? (item.changes as { path?: string; kind?: string }[]) : [];
      const paths = changes.map((c) => c.path).filter(Boolean).join(", ");
      emitToolStart(state, itemId, "edit", { path: paths || "files" }, out);
      if (type === "item.completed") {
        emitToolEnd(state, itemId, changes.map((c) => `${c.kind ?? "modified"}: ${c.path ?? ""}`).join("\n"), false, out);
      }
    } else if (itemType === "mcp_tool_call") {
      const tool = typeof item.tool === "string" ? item.tool : "mcp_tool";
      const args = item.arguments && typeof item.arguments === "object" ? (item.arguments as Record<string, unknown>) : {};
      emitToolStart(state, itemId, tool, args, out);
      if (type === "item.completed") {
        const err = item.error ? JSON.stringify(item.error) : "";
        const res = item.result ? JSON.stringify(item.result) : "";
        emitToolEnd(state, itemId, err || res, !!item.error, out);
      }
    }
    return out;
  }
  if (type === "turn.completed") {
    const usage = record.usage as { input_tokens?: number; output_tokens?: number } | undefined;
    if (usage) {
      state.totalInputTokens += Number(usage.input_tokens ?? 0);
      state.totalOutputTokens += Number(usage.output_tokens ?? 0);
    }
    finalizeTurn(state, "stop", out);
  } else if (type === "turn.failed" || type === "error") {
    const err =
      (record.error && typeof record.error === "object" && typeof (record.error as { message?: unknown }).message === "string"
        ? (record.error as { message: string }).message
        : typeof record.message === "string"
          ? record.message
          : "Codex turn failed");
    finalizeTurn(state, "error", out, err);
  }
  return out;
}

/** Translates one ACP `session/update` notification payload into `SessionEvent[]`. */
export function translateAcpSessionUpdate(state: StreamTranslatorState, update: Record<string, unknown>): SessionEvent[] {
  const out: SessionEvent[] = [];
  const kind = String(update.sessionUpdate ?? update.type ?? "");
  if (kind === "agent_thought_chunk") {
    const chunk = extractAcpContentText(update.content);
    appendThinkingDelta(state, chunk, out);
  } else if (kind === "agent_message_chunk") {
    const chunk = extractAcpContentText(update.content);
    appendTextDelta(state, chunk, out);
  } else if (kind === "tool_call") {
    const id = String(update.toolCallId ?? update.id ?? `acp_tool_${state.nextIndex}`);
    const title = String(update.title ?? update.kind ?? "tool");
    const rawInput = update.rawInput && typeof update.rawInput === "object" ? (update.rawInput as Record<string, unknown>) : { description: title };
    emitToolStart(state, id, String(update.kind ?? title), rawInput, out);
  } else if (kind === "tool_call_update") {
    const id = String(update.toolCallId ?? update.id ?? "");
    const status = String(update.status ?? "");
    if (id && (status === "completed" || status === "failed")) {
      const text = extractAcpContentText(update.content) || (typeof update.rawOutput === "string" ? update.rawOutput : "");
      emitToolEnd(state, id, text, status === "failed", out);
    }
  }
  return out;
}

function extractAcpContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(extractAcpContentText).filter(Boolean).join("\n");
  }
  if (content && typeof content === "object") {
    const obj = content as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
    if (obj.content) return extractAcpContentText(obj.content);
  }
  return "";
}
