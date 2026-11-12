import type { Model, ThinkingLevel } from "../pi/protocol";
import type { Row } from "../pi/transcript";

/**
 * External & built-in agent harnesses pipi can drive and orchestrate.
 *
 * Synthesizes t3code's `ProviderAdapter` + `AcpAdapter` + `OrchestratorMcpService`
 * with a rich built-in engine catalog:
 * - Dedicated drivers: `pi` (the user's `pi` CLI over JSONL RPC), `claude` (Claude Code CLI),
 *   `codex` (OpenAI Codex CLI), `opencode` (OpenCode CLI), `cursor` (Cursor Agent CLI).
 * - First-class & custom ACP driver: `acp` (Devin, Gemini CLI, GitHub Copilot CLI,
 *   Grok, Goose, Kimi CLI, Qwen Code, DeepSeek Harness, Antigravity, Hermes, Kiro,
 *   Factory Droid, Amp, plus any custom binary / npx / uvx ACP stdio harness).
 */
export type AgentDriver = "pi" | "claude" | "codex" | "opencode" | "cursor" | "acp";

export type AgentProtocol = "rpc" | "cli" | "acp";

export type AcpDistribution = "binary" | "npx" | "uvx";

/**
 * Runtime permission policy shared across all agent harnesses and enforced
 * non-escalatingly across delegated child tasks (`resolveRuntimeMode`).
 */
export type RuntimeMode = "approval-required" | "auto-accept-edits" | "full-access";

export type DelegateRole = "general" | "researcher" | "planner" | "implementer" | "reviewer";

export type WorkspaceIsolation = "shared" | "worktree";

/** User-configured custom ACP / CLI agent stored in preferences. */
export interface CustomAgentConfig {
  id: string;
  name: string;
  driver: "acp";
  command: string;
  args: string[];
  /** Launch mode: local executable (`binary`), Node package (`npx`), or Python tool (`uvx`). */
  distribution?: AcpDistribution;
  /** Optional package spec when `distribution` is `"npx"` or `"uvx"`. */
  packageName?: string;
  /** Optional environment variable name for this harness's API key (stored in `auth.json`). */
  envVar?: string;
  /** Optional model identifier advertised by or passed to this agent. */
  defaultModel?: string;
}

/** Per-harness binary override, enabled flag, or extra launch flags stored in preferences. */
export interface AgentOverride {
  enabled?: boolean;
  binaryPath?: string;
  extraArgs?: string[];
  defaultModel?: string;
}

/** Probed status and capabilities of an agent harness on this machine. */
export interface AgentHarnessStatus {
  id: string;
  name: string;
  driver: AgentDriver;
  protocol?: AgentProtocol;
  description: string;
  /** Whether the agent binary/runtime is installed and callable. */
  available: boolean;
  /** Whether this harness is enabled in composer/orchestration pickers (defaults to true). */
  enabled?: boolean;
  /** Resolved executable path for the harness binary. */
  binaryPath?: string;
  version?: string;
  /** Short human-readable readiness note (e.g. "Signed in", "CLI ready", "Not installed"). */
  statusText: string;
  models: Model[];
  supportedRuntimeModes: RuntimeMode[];
  supportsWorktree: boolean;
  supportsResume: boolean;
  isCustom?: boolean;
  /** Environment variable checked/injected for API-key authentication (e.g. `DEVIN_API_KEY`). */
  envVar?: string;
  /** Whether an API key is configured in `auth.json` or environment for this harness. */
  hasApiKey?: boolean;
  /** One-line shell install snippet for quick setup when not installed yet. */
  installCommand?: string;
  /** Official CLI / ACP setup documentation URL. */
  docsUrl?: string;
  /** Catalog grouping for Settings filtering. */
  category?: "featured" | "acp" | "custom";
}

/** Options passed when starting an agent harness transport. */
export interface StartAgentOptions {
  cwd: string;
  agentId: string;
  driver?: AgentDriver;
  runtimeMode?: RuntimeMode;
  binaryPath?: string;
  extraArgs?: string[];
  customAgent?: CustomAgentConfig;
  orchestratorUrl?: string;
  orchestratorToken?: string;
  isSubagent?: boolean;
}

/** Git worktree info for isolated parallel / delegated agent runs. */
export interface WorktreeInfo {
  path: string;
  branch: string;
  baseBranch?: string;
  headCommit?: string;
  dirty?: boolean;
  diffStat?: string;
}

/** Input to spawn a delegated child agent task (from coordinator tool or UI). */
export interface DelegateTaskInput {
  title?: string;
  task: string;
  agentId: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  role?: DelegateRole;
  runtimeMode?: RuntimeMode | "inherit";
  isolation?: WorkspaceIsolation;
  mode?: "sync" | "async";
  /** Parent runtime mode ceiling: child may never escalate beyond this. */
  parentRuntimeMode?: RuntimeMode;
}

/** Live or finished state of a delegated sub-agent / orchestrated run. */
export interface DelegatedTask {
  id: string;
  /** Optional grouping id when launched together (Parallel Compare or Pipeline). */
  groupId?: string;
  workflowKind?: "delegate" | "parallel" | "pipeline";
  stepIndex?: number;
  title: string;
  task: string;
  role: DelegateRole;
  agentId: string;
  agentName: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  runtimeMode: RuntimeMode;
  isolation: WorkspaceIsolation;
  cwd: string;
  worktree?: WorktreeInfo;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  activityLabel: string;
  rows: Row[];
  summary: string;
  error?: string;
  startedAt: number;
  completedAt?: number;
}
