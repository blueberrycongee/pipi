import type { Model } from "../pi/protocol";
import type {
  AgentDriver,
  AgentHarnessStatus,
  AgentOverride,
  AgentProtocol,
  CustomAgentConfig,
  DelegateRole,
  RuntimeMode,
} from "./types";

/** Built-in coding agent harnesses known to pipi out of the box (no manual setup required). */
export interface BuiltinAgentSpec {
  id: string;
  name: string;
  driver: AgentDriver;
  protocol: AgentProtocol;
  binary: string;
  /** Optional alternate executable names probed in order if `binary` is absent. */
  fallbackBinaries?: readonly string[];
  /** Built-in stdio ACP launch flags when `driver === "acp"`. */
  acpArgs?: readonly string[];
  descriptionEn: string;
  descriptionZh: string;
  supportedRuntimeModes: RuntimeMode[];
  supportsResume?: boolean;
  defaultModels: Model[];
  /** Primary API key environment variable (also injectable via `<agent-dir>/auth.json`). */
  envVar?: string;
  /** One-click shell install snippet shown when the CLI is not yet installed. */
  installCommand?: string;
  /** Official CLI / ACP documentation URL. */
  docsUrl?: string;
  category: "featured" | "acp";
}

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function makeModel(provider: string, id: string, name: string, image = true, cost = zeroCost): Model {
  return {
    id,
    name,
    api: provider,
    provider,
    reasoning: true,
    input: image ? ["text", "image"] : ["text"],
    cost,
  };
}

/**
 * A harness's only honest pre-connect model: "whatever the engine itself is
 * configured to use". Real model catalogs are discovered at runtime — ACP
 * agents advertise them on `session/new` (`models.availableModels` or
 * Devin-style `configOptions`), and CLI drivers take an explicit model via
 * `extraArgs`. No fabricated lists.
 */
function defaultEngineModels(provider: string, name: string): Model[] {
  const model = makeModel(provider, "default", `${name} Default`, false);
  model.reasoning = false;
  return [model];
}

export const BUILTIN_AGENTS: readonly BuiltinAgentSpec[] = [
  {
    id: "pi",
    name: "Pi",
    driver: "pi",
    protocol: "rpc",
    binary: "pi",
    descriptionEn: "Pi coding agent over its native JSONL RPC — shares your Pi providers, sessions, and extensions.",
    descriptionZh: "Pi 编码智能体，通过原生 JSONL RPC 驱动，复用你本机的 Pi 提供商、会话与扩展。",
    supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
    supportsResume: true,
    defaultModels: [],
    installCommand: "npm install -g --ignore-scripts @earendil-works/pi-coding-agent",
    docsUrl: "https://pi.dev",
    category: "featured",
  },
  {
    id: "claude",
    name: "Claude Code",
    driver: "claude",
    protocol: "cli",
    binary: "claude",
    descriptionEn: "Anthropic's Claude Code CLI agent (uses your Claude subscription or ANTHROPIC_API_KEY).",
    descriptionZh: "Anthropic 官方 Claude Code 智能体（复用本地订阅登录或 API 密钥）。",
    supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
    supportsResume: true,
    defaultModels: defaultEngineModels("claude-code", "Claude Code"),
    envVar: "ANTHROPIC_API_KEY",
    installCommand: "npm install -g @anthropic-ai/claude-code",
    docsUrl: "https://code.claude.com/docs/en/setup",
    category: "featured",
  },
  {
    id: "codex",
    name: "Codex",
    driver: "codex",
    protocol: "cli",
    binary: "codex",
    descriptionEn: "OpenAI's Codex CLI agent (uses your ChatGPT sign-in or OPENAI_API_KEY).",
    descriptionZh: "OpenAI 官方 Codex 智能体（复用本地 ChatGPT 登录或 API 密钥）。",
    supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
    supportsResume: true,
    defaultModels: defaultEngineModels("codex", "Codex"),
    envVar: "OPENAI_API_KEY",
    installCommand: "npm install -g @openai/codex",
    docsUrl: "https://developers.openai.com/codex/cli",
    category: "featured",
  },
  {
    id: "devin",
    name: "Devin",
    driver: "acp",
    protocol: "acp",
    binary: "devin",
    acpArgs: ["acp"],
    descriptionEn: "Cognition's Devin coding engineer driven natively over ACP (`devin acp`).",
    descriptionZh: "Cognition 官方 Devin 研发智能体，通过原生 ACP 协议（`devin acp`）开箱即用。",
    supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
    defaultModels: defaultEngineModels("devin", "Devin"),
    envVar: "DEVIN_API_KEY",
    installCommand: "curl -fsSL https://cli.devin.ai/install.sh | sh",
    docsUrl: "https://docs.devin.ai/cli",
    category: "featured",
  },
  {
    id: "cursor",
    name: "Cursor",
    driver: "cursor",
    protocol: "cli",
    binary: "cursor-agent",
    descriptionEn: "Cursor CLI coding agent (`cursor-agent`) driven over stream-json.",
    descriptionZh: "Cursor 官方 CLI 编码智能体（`cursor-agent`），通过流式 JSON 驱动。",
    supportedRuntimeModes: ["approval-required", "full-access"],
    defaultModels: defaultEngineModels("cursor", "Cursor"),
    envVar: "CURSOR_API_KEY",
    installCommand: "curl https://cursor.com/install -fsS | bash",
    docsUrl: "https://cursor.com/docs/cli/acp",
    category: "featured",
  },
  {
    id: "opencode",
    name: "OpenCode",
    driver: "opencode",
    protocol: "cli",
    binary: "opencode",
    descriptionEn: "OpenCode terminal coding agent driven over JSON event stream.",
    descriptionZh: "OpenCode 开源终端编码智能体，通过 JSON 事件流驱动。",
    supportedRuntimeModes: ["auto-accept-edits", "full-access"],
    defaultModels: defaultEngineModels("opencode", "OpenCode"),
    envVar: "OPENCODE_API_KEY",
    installCommand: "npm install -g opencode-ai",
    docsUrl: "https://opencode.ai/docs",
    category: "featured",
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    driver: "acp",
    protocol: "acp",
    binary: "gemini",
    acpArgs: ["--experimental-acp"],
    descriptionEn: "Google's Gemini CLI coding agent connected over native ACP stdio.",
    descriptionZh: "Google 官方 Gemini CLI 编码智能体，通过原生 ACP 接入。",
    supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
    defaultModels: defaultEngineModels("gemini", "Gemini CLI"),
    envVar: "GEMINI_API_KEY",
    installCommand: "npm install -g @google/gemini-cli",
    docsUrl: "https://github.com/google-gemini/gemini-cli",
    category: "featured",
  },
  {
    id: "copilot",
    name: "GitHub Copilot",
    driver: "acp",
    protocol: "acp",
    binary: "copilot",
    acpArgs: ["--acp"],
    descriptionEn: "GitHub Copilot CLI agent (`copilot --acp`) using your Copilot subscription.",
    descriptionZh: "GitHub Copilot 官方 CLI 智能体（`copilot --acp`），复用 Copilot 订阅。",
    supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
    defaultModels: defaultEngineModels("copilot", "GitHub Copilot"),
    envVar: "COPILOT_GITHUB_TOKEN",
    installCommand: "npm install -g @github/copilot",
    docsUrl: "https://docs.github.com/en/copilot/how-tos/copilot-cli",
    category: "featured",
  },
  {
    id: "grok",
    name: "Grok",
    driver: "acp",
    protocol: "acp",
    binary: "grok",
    acpArgs: ["--no-auto-update", "agent", "--no-leader", "stdio"],
    descriptionEn: "xAI's Grok coding agent CLI driven over stdio agent protocol.",
    descriptionZh: "xAI 官方 Grok 编码智能体 CLI，通过 stdio 协议驱动。",
    supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
    defaultModels: defaultEngineModels("grok", "Grok"),
    envVar: "XAI_API_KEY",
    installCommand: "npm install -g @xai-org/grok",
    docsUrl: "https://docs.x.ai",
    category: "acp",
  },
  {
    id: "goose",
    name: "Goose",
    driver: "acp",
    protocol: "acp",
    binary: "goose",
    acpArgs: ["acp"],
    descriptionEn: "Block's open-source Goose engineering agent (`goose acp`).",
    descriptionZh: "Block 开源 Goose 工程智能体（`goose acp`）。",
    supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
    defaultModels: defaultEngineModels("goose", "Goose"),
    installCommand: "brew install block-goose-cli",
    docsUrl: "https://block.github.io/goose/docs/quickstart",
    category: "acp",
  },
  {
    id: "kimi",
    name: "Kimi CLI",
    driver: "acp",
    protocol: "acp",
    binary: "kimi",
    acpArgs: ["acp"],
    descriptionEn: "Moonshot AI's Kimi CLI coding agent (`kimi acp`).",
    descriptionZh: "月之暗面 Kimi 官方编码智能体（`kimi acp`）。",
    supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
    defaultModels: defaultEngineModels("kimi", "Kimi CLI"),
    envVar: "MOONSHOT_API_KEY",
    installCommand: "uv tool install kimi-cli",
    docsUrl: "https://github.com/MoonshotAI/kimi-cli",
    category: "acp",
  },
  {
    id: "qwen",
    name: "Qwen Code",
    driver: "acp",
    protocol: "acp",
    binary: "qwen",
    acpArgs: ["--acp"],
    descriptionEn: "Alibaba Qwen Code CLI coding agent (`qwen --acp`).",
    descriptionZh: "通义千问 Qwen Code 官方编码智能体（`qwen --acp`）。",
    supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
    defaultModels: defaultEngineModels("qwen", "Qwen Code"),
    envVar: "DASHSCOPE_API_KEY",
    installCommand: "npm install -g @qwen-code/qwen-code",
    docsUrl: "https://github.com/QwenLM/qwen-code",
    category: "acp",
  },
  {
    id: "dsh",
    name: "DeepSeek Harness",
    driver: "acp",
    protocol: "acp",
    binary: "dsh",
    acpArgs: ["--profile", "acp"],
    descriptionEn: "DeepSeek Harness CLI coding agent (`dsh --profile acp`).",
    descriptionZh: "DeepSeek Harness 编码智能体（`dsh --profile acp`）。",
    supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
    supportsResume: true,
    defaultModels: defaultEngineModels("dsh", "DeepSeek Harness"),
    envVar: "DEEPSEEK_API_KEY",
    installCommand: "npm install -g @deepseek-ai/dsh",
    docsUrl: "https://github.com/deepseek-ai/deepseek-harness",
    category: "acp",
  },
  {
    id: "antigravity",
    name: "Antigravity",
    driver: "acp",
    protocol: "acp",
    binary: "agy_acp_server",
    fallbackBinaries: ["agy"],
    acpArgs: [],
    descriptionEn: "Google Antigravity agent harness (`agy_acp_server` / `agy acp`).",
    descriptionZh: "Google Antigravity 编码智能体（`agy_acp_server` / `agy acp`）。",
    supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
    supportsResume: true,
    defaultModels: defaultEngineModels("antigravity", "Antigravity"),
    docsUrl: "https://antigravity.google/docs/ide/extensions",
    category: "acp",
  },
  {
    id: "hermes",
    name: "Hermes",
    driver: "acp",
    protocol: "acp",
    binary: "hermes",
    acpArgs: ["acp"],
    descriptionEn: "Nous Research's Hermes autonomous coding agent (`hermes acp`).",
    descriptionZh: "Nous Research Hermes 自主研发智能体（`hermes acp`）。",
    supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
    defaultModels: defaultEngineModels("hermes", "Hermes"),
    docsUrl: "https://hermes-agent.nousresearch.com/docs/user-guide/features/acp",
    category: "acp",
  },
  {
    id: "kiro",
    name: "Kiro",
    driver: "acp",
    protocol: "acp",
    binary: "kiro-cli",
    fallbackBinaries: ["kiro"],
    acpArgs: ["acp"],
    descriptionEn: "AWS Kiro spec-driven coding agent (`kiro-cli acp`).",
    descriptionZh: "AWS Kiro 规范驱动编码智能体（`kiro-cli acp`）。",
    supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
    defaultModels: defaultEngineModels("kiro", "Kiro"),
    docsUrl: "https://kiro.dev/cli",
    category: "acp",
  },
  {
    id: "droid",
    name: "Factory Droid",
    driver: "acp",
    protocol: "acp",
    binary: "droid",
    acpArgs: ["acp"],
    descriptionEn: "Factory's Droid software engineering agent (`droid acp`).",
    descriptionZh: "Factory Droid 软件工程智能体（`droid acp`）。",
    supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
    defaultModels: defaultEngineModels("droid", "Factory Droid"),
    envVar: "FACTORY_API_KEY",
    installCommand: "curl -fsSL https://app.factory.ai/cli | sh",
    docsUrl: "https://docs.factory.ai/cli",
    category: "acp",
  },
  {
    id: "amp",
    name: "Amp",
    driver: "acp",
    protocol: "acp",
    binary: "amp",
    acpArgs: ["acp"],
    descriptionEn: "Sourcegraph's Amp frontier coding agent (`amp acp`).",
    descriptionZh: "Sourcegraph Amp 编码智能体（`amp acp`）。",
    supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
    defaultModels: defaultEngineModels("amp", "Amp"),
    envVar: "AMP_API_KEY",
    installCommand: "npm install -g @sourcegraph/amp",
    docsUrl: "https://ampcode.com/manual",
    category: "acp",
  },
];

export function builtinAgentSpec(id: string): BuiltinAgentSpec | undefined {
  return BUILTIN_AGENTS.find((spec) => spec.id === id);
}

export function acpDefaultModel(custom: CustomAgentConfig): Model {
  const id = custom.defaultModel || "default";
  return {
    id,
    name: custom.defaultModel || `${custom.name} Default`,
    api: "acp",
    provider: custom.id,
    reasoning: true,
    input: ["text"],
    cost: zeroCost,
  };
}

/** Fallback catalog before `probe-agents.mjs` finishes or in offline environments. */
export function defaultAgentStatuses(
  customs: readonly CustomAgentConfig[] = [],
  overrides: Record<string, AgentOverride> = {},
): AgentHarnessStatus[] {
  const builtins: AgentHarnessStatus[] = BUILTIN_AGENTS.map((spec) => ({
    id: spec.id,
    name: spec.name,
    driver: spec.driver,
    protocol: spec.protocol,
    description: spec.descriptionEn,
    available: false,
    enabled: overrides[spec.id]?.enabled !== false,
    binaryPath: undefined,
    statusText: "Checking…",
    models: spec.defaultModels,
    supportedRuntimeModes: spec.supportedRuntimeModes,
    supportsWorktree: true,
    supportsResume: !!spec.supportsResume,
    envVar: spec.envVar,
    installCommand: spec.installCommand,
    docsUrl: spec.docsUrl,
    category: spec.category,
  }));
  const customStatuses: AgentHarnessStatus[] = customs.map((custom) => ({
    id: custom.id,
    name: custom.name,
    driver: "acp",
    protocol: "acp",
    description: `${custom.command} ${custom.args.join(" ")}`.trim(),
    available: true,
    enabled: overrides[custom.id]?.enabled !== false,
    binaryPath: custom.command,
    statusText: "ACP command",
    models: [acpDefaultModel(custom)],
    supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
    supportsWorktree: true,
    supportsResume: false,
    isCustom: true,
    envVar: custom.envVar,
    category: "custom",
  }));
  return [...builtins, ...customStatuses];
}

// ── Runtime Mode Ceiling ─────────────────────────────────────────────────────

export function runtimeModeRank(mode: RuntimeMode): number {
  switch (mode) {
    case "approval-required":
      return 0;
    case "auto-accept-edits":
      return 1;
    case "full-access":
      return 2;
  }
}

/**
 * Resolves the runtime permission mode for a delegated child agent:
 * - `"inherit"` or `undefined` inherits `parentMode` (clamped to what the target offers).
 * - Explicit escalation above `parentMode` throws an error (`runtime_mode_escalation_denied`).
 */
export function resolveRuntimeMode(
  parentMode: RuntimeMode,
  requested?: RuntimeMode | "inherit",
  supported?: readonly RuntimeMode[],
): RuntimeMode {
  const inherited = requested === undefined || requested === "inherit";
  const candidate = inherited ? parentMode : requested;
  if (runtimeModeRank(candidate) > runtimeModeRank(parentMode)) {
    throw new Error(`Child runtime mode "${candidate}" cannot escalate above parent mode "${parentMode}".`);
  }
  if (!supported || supported.length === 0 || supported.includes(candidate)) {
    return candidate;
  }
  if (!inherited) {
    throw new Error(`Target agent does not support runtime mode "${candidate}". Supported: ${supported.join(", ")}.`);
  }
  const allowed = supported
    .filter((m) => runtimeModeRank(m) <= runtimeModeRank(candidate))
    .sort((a, b) => runtimeModeRank(b) - runtimeModeRank(a));
  return allowed[0] ?? "approval-required";
}

/** Wraps a delegated task prompt with its assigned sub-agent role. */
export function formatRoleTaskPrompt(task: string, role: DelegateRole = "general"): string {
  const trimmed = task.trim();
  switch (role) {
    case "researcher":
      return `Act as the researcher sub-agent for this task. Investigate thoroughly using read-only inspection, cite exact files and symbols, and return a concise, structured report.\n\n${trimmed}`;
    case "planner":
      return `Act as the planner sub-agent for this task. Analyze the codebase, identify constraints and edge cases, and return a concrete step-by-step implementation plan without editing files.\n\n${trimmed}`;
    case "implementer":
      return `Act as the implementer sub-agent for this task. Carry out the requested code changes cleanly, run relevant checks/tests, and summarize what changed.\n\n${trimmed}`;
    case "reviewer":
      return `Act as the reviewer sub-agent for this task. Audit the code or diff critically for bugs, regressions, security issues, and style violations. Report concrete findings.\n\n${trimmed}`;
    default:
      return trimmed;
  }
}
