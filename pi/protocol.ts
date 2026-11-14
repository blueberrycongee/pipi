/**
 * The slice of Pi's RPC protocol this client speaks, as types.
 *
 * These mirror `docs/pi/rpc-commands.md`, `docs/pi/json.md`,
 * `docs/pi/message-types.md` and `docs/pi/rpc-extension-ui.md` (and the
 * pinned package's `dist/modes/rpc/rpc-types.d.ts`). They are written out
 * here, narrowed to what the client reads, so the app's bundle and type check
 * do not depend on the Node package's module graph. Unknown fields and unknown
 * record types must be tolerated: Pi adds them between releases.
 */

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type QueueMode = "all" | "one-at-a-time";

// ── Messages ────────────────────────────────────────────────────────────────

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  redacted?: boolean;
}

export interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Kept running across `agent_settled` as a background task / subagent. */
  background?: boolean;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  /** The bridge's (`sidecar/agent-usage.mjs`): the engine reported these tokens and no cost. */
  unpriced?: boolean;
  /** The bridge's: the models the engine says did the work, when it names them. */
  models?: { model: string; input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: number }[];
}

export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}

export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";

export interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  provider: string;
  model: string;
  usage: Usage;
  stopReason: StopReason;
  errorMessage?: string;
  /** Opens a new visual turn without a preceding user message (e.g., an autonomous wake turn). */
  turnStart?: boolean;
  timestamp: number;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: unknown;
  isError: boolean;
  timestamp: number;
}

export interface BashExecutionMessage {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
  excludeFromContext?: boolean;
  timestamp: number;
}

export interface CustomMessage {
  role: "custom";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  display: boolean;
  timestamp: number;
}

export interface BranchSummaryMessage {
  role: "branchSummary";
  summary: string;
  timestamp: number;
}

export interface CompactionSummaryMessage {
  role: "compactionSummary";
  summary: string;
  tokensBefore: number;
  timestamp: number;
}

export interface SystemMessage {
  role: "system";
  timestamp: number;
}

/** Every message role Pi documents; a consumer still tolerates roles it does not know. */
export type AgentMessage =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | BashExecutionMessage
  | CustomMessage
  | BranchSummaryMessage
  | CompactionSummaryMessage;

// ── Models and state ────────────────────────────────────────────────────────

export interface Model {
  id: string;
  name: string;
  api: string;
  provider: string;
  baseUrl?: string;
  reasoning: boolean;
  input: string[];
  /** Only set when the engine itself reports them — never assumed per catalog. */
  effortLevels?: string[];
  /** Only set when the engine itself reports it — never assumed per catalog. */
  contextWindow?: number;
  maxTokens?: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface SessionState {
  model?: Model;
  thinkingLevel: ThinkingLevel;
  isStreaming: boolean;
  isCompacting: boolean;
  steeringMode: QueueMode;
  followUpMode: QueueMode;
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  autoCompactionEnabled: boolean;
  messageCount: number;
  pendingMessageCount: number;
}

export interface SessionStats {
  sessionFile?: string;
  sessionId: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;
  /** The bridge's: `false` when the engine reports tokens and no cost — there is none to show. Pi always has one. */
  costReported?: boolean;
  contextUsage?: { tokens: number | null; contextWindow: number | null; percent: number | null };
}

export interface SlashCommand {
  name: string;
  description?: string;
  /** Pi's three kinds; `agent` is the bridge's, for a command another engine reports as its own. */
  source: "extension" | "prompt" | "skill" | "agent";
  /** What follows the name. Only set when the engine itself reports it (the bridge). */
  argumentHint?: string;
}

export interface CompactionResult {
  summary: string;
  tokensBefore: number;
  estimatedTokensAfter?: number;
}

export interface BashResult {
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
}

// ── Commands ────────────────────────────────────────────────────────────────

/** Each command's fields (besides `type` and `id`) and the `data` of its successful response. */
export interface Commands {
  prompt: { args: { message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }; data: { disposition: "started" | "queued" | "handled" } };
  steer: { args: { message: string; images?: ImageContent[] }; data: { disposition: "queued" | "handled" } };
  follow_up: { args: { message: string; images?: ImageContent[] }; data: { disposition: "queued" | "handled" } };
  abort: { args: {}; data: undefined };
  clear_queue: { args: {}; data: { steering: string[]; followUp: string[] } };
  new_session: { args: { parentSession?: string }; data: { cancelled: boolean } };
  get_state: { args: {}; data: SessionState };
  get_messages: { args: {}; data: { messages: AgentMessage[] } };
  set_model: { args: { provider: string; modelId: string }; data: Model };
  get_available_models: { args: {}; data: { models: Model[] } };
  set_thinking_level: { args: { level: ThinkingLevel }; data: undefined };
  get_available_thinking_levels: { args: {}; data: { levels: ThinkingLevel[] } };
  set_steering_mode: { args: { mode: QueueMode }; data: undefined };
  set_follow_up_mode: { args: { mode: QueueMode }; data: undefined };
  compact: { args: { customInstructions?: string }; data: CompactionResult };
  set_auto_compaction: { args: { enabled: boolean }; data: undefined };
  set_auto_retry: { args: { enabled: boolean }; data: undefined };
  abort_retry: { args: {}; data: undefined };
  bash: { args: { command: string; excludeFromContext?: boolean }; data: BashResult };
  abort_bash: { args: {}; data: undefined };
  get_session_stats: { args: {}; data: SessionStats };
  export_html: { args: { outputPath?: string }; data: { path: string } };
  switch_session: { args: { sessionPath: string }; data: { cancelled: boolean } };
  fork: { args: { entryId: string }; data: { text?: string; cancelled: boolean } };
  clone: { args: {}; data: { cancelled: boolean } };
  get_fork_messages: { args: {}; data: { messages: { entryId: string; text: string }[] } };
  get_last_assistant_text: { args: {}; data: { text: string | null } };
  set_session_name: { args: { name: string }; data: undefined };
  get_commands: { args: {}; data: { commands: SlashCommand[] } };
}

export type CommandType = keyof Commands;

// ── Records from Pi ─────────────────────────────────────────────────────────

export interface ResponseRecord {
  type: "response";
  id?: string;
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

/** The nested event of a `message_update`: one content block's progress (deltas only on the wire). */
export type AssistantMessageEvent =
  | { type: "text_start"; contentIndex: number }
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "text_end"; contentIndex: number; content: string }
  | { type: "thinking_start"; contentIndex: number }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "thinking_end"; contentIndex: number; content: string }
  | { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
  | { type: "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall }
  | { type: "start" }
  | { type: "done" }
  | { type: "error" };

export interface ToolResult {
  content?: (TextContent | ImageContent)[];
  details?: unknown;
}

/** The session events the client acts on (`docs/pi/json.md`). */
export type SessionEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; willRetry?: boolean }
  | { type: "agent_settled"; aborted?: boolean }
  | { type: "turn_start" }
  | { type: "turn_end" }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; usage?: Usage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; partialResult?: ToolResult }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result?: ToolResult; isError: boolean; durationMs?: number }
  | { type: "queue_update"; steering: string[]; followUp: string[] }
  | { type: "session_info_changed"; name?: string }
  | { type: "models_changed" }
  | { type: "commands_changed" }
  | { type: "thinking_level_changed"; level: ThinkingLevel }
  | { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
  | { type: "compaction_end"; reason: string; result?: CompactionResult; aborted: boolean; willRetry?: boolean; errorMessage?: string }
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
  | { type: "bash_execution_update"; id?: string; delta: string }
  | { type: "extension_error"; extensionPath: string; event: string; error: string };

/** A request from an extension's `ctx.ui` (`docs/pi/rpc-extension-ui.md`). */
export type ExtensionUiRequest =
  | { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "input"; title: string; placeholder?: string; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
  | { type: "extension_ui_request"; id: string; method: "notify"; message: string; notifyType?: "info" | "warning" | "error" }
  | { type: "extension_ui_request"; id: string; method: "setStatus"; statusKey: string; statusText?: string }
  | { type: "extension_ui_request"; id: string; method: "setWidget"; widgetKey: string; widgetLines?: string[]; widgetPlacement?: "aboveEditor" | "belowEditor" }
  | { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
  | { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };

/** The dialog requests: the ones that block Pi until the client answers. */
export type ExtensionUiDialog = Extract<ExtensionUiRequest, { method: "select" | "confirm" | "input" | "editor" }>;

export type ExtensionUiAnswer = { value: string } | { confirmed: boolean } | { cancelled: true };
