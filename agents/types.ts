import type { Model } from "../pi/protocol";

/**
 * External & built-in agent harnesses pipi can drive and orchestrate.
 *
 * Built-in engine catalog:
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
 * non-escalatingly down each session tree: a child session's mode never
 * exceeds its parent's (the daemon's `clampMode` — same rule as
 * `resolveRuntimeMode`).
 */
export type RuntimeMode = "approval-required" | "auto-accept-edits" | "full-access";

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
  /** Session-daemon MCP endpoint + this session's bearer token (the session tools). */
  orchestratorUrl?: string;
  orchestratorToken?: string;
}

/** Git worktree info for isolated compare / child-session runs. */
export interface WorktreeInfo {
  path: string;
  branch: string;
  baseCwd?: string;
  baseBranch?: string;
  headCommit?: string;
  dirty?: boolean;
  diffStat?: string;
}
