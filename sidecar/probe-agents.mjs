// Fast, non-intrusive probe of built-in and custom external coding agents:
//
//   node sidecar/probe-agents.mjs [json-payload]
//
// Never triggers browser OAuth popups or project hooks.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentDirPath, childEnv, execBinary, readAuthStore, resolveAgentApiKey, resolveBinary } from "./env-paths.mjs";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

// Agents report a single honest pre-connect entry: the engine's own default.
// Real catalogs are adopted at runtime (ACP `models`/`configOptions`), never fabricated.
function defaultModelEntry(provider, name) {
  return [
    {
      id: "default",
      name: `${name} Default`,
      api: provider,
      provider,
      reasoning: false,
      input: ["text"],
      cost: zeroCost,
    },
  ];
}

async function readVersion(bin, args = ["--version"]) {
  try {
    const { stdout, stderr } = await execBinary(bin, args, { env: childEnv(), timeout: 2500 });
    const line = (stdout || stderr || "").trim().split("\n")[0]?.trim() || "";
    return line.slice(0, 80);
  } catch {
    return undefined;
  }
}

function checkPiAuth() {
  const auth = readAuthStore();
  if (Object.keys(auth).some((k) => !k.startsWith("agent:"))) return "Signed in (~/.pi/agent/auth.json)";
  if (fs.existsSync(agentDirPath())) return "CLI ready";
  return "Installed (run `pi` to configure)";
}

function checkClaudeAuth() {
  const key = resolveAgentApiKey("claude", "ANTHROPIC_API_KEY");
  if (key || process.env.CLAUDE_CODE_OAUTH_TOKEN) return key?.source === "auth" ? "API key saved" : "API key in env";
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const jsonFile = path.join(os.homedir(), ".claude.json");
  if (fs.existsSync(dir) || fs.existsSync(jsonFile)) return "Signed in";
  return "Installed (run `claude` to sign in)";
}

function checkCodexAuth() {
  const key = resolveAgentApiKey("codex", "OPENAI_API_KEY");
  if (key) return key.source === "auth" ? "API key saved" : "OPENAI_API_KEY in env";
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  if (fs.existsSync(path.join(codexHome, "auth.json"))) return "Signed in (~/.codex/auth.json)";
  if (fs.existsSync(codexHome)) return "CLI ready";
  return "Installed (run `codex login` to sign in)";
}

function checkDevinAuth() {
  const key = resolveAgentApiKey("devin", "DEVIN_API_KEY");
  if (key) return key.source === "auth" ? "API key saved" : "DEVIN_API_KEY in env";
  if (fs.existsSync(path.join(os.homedir(), ".devin")) || fs.existsSync(path.join(os.homedir(), ".config", "devin"))) return "Signed in";
  return "ACP ready";
}

function checkGenericAuth(id, envVar, configDir) {
  return () => {
    const key = envVar ? resolveAgentApiKey(id, envVar) : undefined;
    if (key) return key.source === "auth" ? "API key saved" : `${envVar} in env`;
    if (configDir && fs.existsSync(configDir)) return "Signed in";
    return "CLI ready";
  };
}

let input = { overrides: {}, customAgents: [] };
if (process.argv[2]) {
  try {
    input = { ...input, ...JSON.parse(process.argv[2]) };
  } catch {}
}

const overrides = input.overrides || {};
const customAgents = Array.isArray(input.customAgents) ? input.customAgents : [];

const SPECS = [
  {
    id: "pi",
    name: "Pi",
    driver: "pi",
    protocol: "rpc",
    binary: "pi",
    description: "Pi coding agent driven over its native JSONL RPC, sharing your Pi providers, sessions, and extensions.",
    models: [],
    supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
    supportsResume: true,
    installCommand: "npm install -g --ignore-scripts @earendil-works/pi-coding-agent",
    docsUrl: "https://pi.dev",
    category: "featured",
    authFn: checkPiAuth,
  },
  {
    id: "claude",
    name: "Claude Code",
    driver: "claude",
    protocol: "cli",
    binary: "claude",
    description: "Anthropic's Claude Code CLI agent (uses your Claude subscription or ANTHROPIC_API_KEY).",
    models: defaultModelEntry("claude-code", "Claude Code"),
    supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
    supportsResume: true,
    envVar: "ANTHROPIC_API_KEY",
    installCommand: "npm install -g @anthropic-ai/claude-code",
    docsUrl: "https://code.claude.com/docs/en/setup",
    category: "featured",
    authFn: checkClaudeAuth,
  },
  {
    id: "codex",
    name: "Codex",
    driver: "codex",
    protocol: "cli",
    binary: "codex",
    description: "OpenAI's Codex CLI agent (uses your ChatGPT sign-in or OPENAI_API_KEY).",
    models: defaultModelEntry("codex", "Codex"),
    supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
    supportsResume: true,
    envVar: "OPENAI_API_KEY",
    installCommand: "npm install -g @openai/codex",
    docsUrl: "https://developers.openai.com/codex/cli",
    category: "featured",
    authFn: checkCodexAuth,
  },
  {
    id: "devin",
    name: "Devin",
    driver: "acp",
    protocol: "acp",
    binary: "devin",
    description: "Cognition's Devin coding engineer driven natively over ACP (`devin acp`).",
    models: defaultModelEntry("devin", "Devin"),
    supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
    envVar: "DEVIN_API_KEY",
    installCommand: "curl -fsSL https://cli.devin.ai/install.sh | sh",
    docsUrl: "https://docs.devin.ai/cli",
    category: "featured",
    authFn: checkDevinAuth,
  },
  {
    id: "cursor",
    name: "Cursor",
    driver: "cursor",
    protocol: "cli",
    binary: "cursor-agent",
    description: "Cursor CLI coding agent (`cursor-agent`) driven over stream-json.",
    models: defaultModelEntry("cursor", "Cursor"),
    supportedRuntimeModes: ["approval-required", "full-access"],
    envVar: "CURSOR_API_KEY",
    installCommand: "curl https://cursor.com/install -fsS | bash",
    docsUrl: "https://cursor.com/docs/cli/acp",
    category: "featured",
    authFn: checkGenericAuth("cursor", "CURSOR_API_KEY", path.join(os.homedir(), ".cursor")),
  },
  {
    id: "opencode",
    name: "OpenCode",
    driver: "opencode",
    protocol: "cli",
    binary: "opencode",
    description: "OpenCode terminal coding agent driven over JSON event stream.",
    models: defaultModelEntry("opencode", "OpenCode"),
    supportedRuntimeModes: ["auto-accept-edits", "full-access"],
    envVar: "OPENCODE_API_KEY",
    installCommand: "npm install -g opencode-ai",
    docsUrl: "https://opencode.ai/docs",
    category: "featured",
    authFn: checkGenericAuth("opencode", "OPENCODE_API_KEY", path.join(os.homedir(), ".local", "share", "opencode")),
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    driver: "acp",
    protocol: "acp",
    binary: "gemini",
    description: "Google's Gemini CLI coding agent connected over native ACP stdio.",
    models: defaultModelEntry("gemini", "Gemini CLI"),
    supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
    envVar: "GEMINI_API_KEY",
    installCommand: "npm install -g @google/gemini-cli",
    docsUrl: "https://github.com/google-gemini/gemini-cli",
    category: "featured",
    authFn: checkGenericAuth("gemini", "GEMINI_API_KEY", path.join(os.homedir(), ".gemini")),
  },
  {
    id: "copilot",
    name: "GitHub Copilot",
    driver: "acp",
    protocol: "acp",
    binary: "copilot",
    description: "GitHub Copilot CLI agent (`copilot --acp`) using your Copilot subscription.",
    models: defaultModelEntry("copilot", "GitHub Copilot"),
    supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
    envVar: "COPILOT_GITHUB_TOKEN",
    installCommand: "npm install -g @github/copilot",
    docsUrl: "https://docs.github.com/en/copilot/how-tos/copilot-cli",
    category: "featured",
    authFn: checkGenericAuth("copilot", "COPILOT_GITHUB_TOKEN", path.join(os.homedir(), ".copilot")),
  },
  {
    id: "grok",
    name: "Grok",
    driver: "acp",
    protocol: "acp",
    binary: "grok",
    description: "xAI's Grok coding agent CLI driven over stdio agent protocol.",
    models: defaultModelEntry("grok", "Grok"),
    supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
    envVar: "XAI_API_KEY",
    installCommand: "npm install -g @xai-org/grok",
    docsUrl: "https://docs.x.ai",
    category: "acp",
    authFn: checkGenericAuth("grok", "XAI_API_KEY", path.join(os.homedir(), ".grok")),
  },
  {
    id: "goose",
    name: "Goose",
    driver: "acp",
    protocol: "acp",
    binary: "goose",
    description: "Block's open-source Goose engineering agent (`goose acp`).",
    models: defaultModelEntry("goose", "Goose"),
    supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
    installCommand: "brew install block-goose-cli",
    docsUrl: "https://block.github.io/goose/docs/quickstart",
    category: "acp",
    authFn: checkGenericAuth("goose", undefined, path.join(os.homedir(), ".config", "goose")),
  },
  {
    id: "kimi",
    name: "Kimi CLI",
    driver: "acp",
    protocol: "acp",
    binary: "kimi",
    description: "Moonshot AI's Kimi CLI coding agent (`kimi acp`).",
    models: defaultModelEntry("kimi", "Kimi CLI"),
    supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
    envVar: "MOONSHOT_API_KEY",
    installCommand: "uv tool install kimi-cli",
    docsUrl: "https://github.com/MoonshotAI/kimi-cli",
    category: "acp",
    authFn: checkGenericAuth("kimi", "MOONSHOT_API_KEY", path.join(os.homedir(), ".kimi")),
  },
  {
    id: "qwen",
    name: "Qwen Code",
    driver: "acp",
    protocol: "acp",
    binary: "qwen",
    description: "Alibaba Qwen Code CLI coding agent (`qwen --acp`).",
    models: defaultModelEntry("qwen", "Qwen Code"),
    supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
    envVar: "DASHSCOPE_API_KEY",
    installCommand: "npm install -g @qwen-code/qwen-code",
    docsUrl: "https://github.com/QwenLM/qwen-code",
    category: "acp",
    authFn: checkGenericAuth("qwen", "DASHSCOPE_API_KEY", path.join(os.homedir(), ".qwen")),
  },
  {
    id: "dsh",
    name: "DeepSeek Harness",
    driver: "acp",
    protocol: "acp",
    binary: "dsh",
    description: "DeepSeek Harness CLI coding agent (`dsh --profile acp`).",
    models: defaultModelEntry("dsh", "DeepSeek Harness"),
    supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
    supportsResume: true,
    envVar: "DEEPSEEK_API_KEY",
    installCommand: "npm install -g @deepseek-ai/dsh",
    docsUrl: "https://github.com/deepseek-ai/deepseek-harness",
    category: "acp",
    authFn: checkGenericAuth("dsh", "DEEPSEEK_API_KEY", path.join(os.homedir(), ".dsh")),
  },
  {
    id: "antigravity",
    name: "Antigravity",
    driver: "acp",
    protocol: "acp",
    binary: "agy",
    fallbackBinaries: ["agy_acp_server"],
    description: "Google Antigravity agent harness (`agy acp` / `agy_acp_server`).",
    models: defaultModelEntry("antigravity", "Antigravity"),
    supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
    supportsResume: true,
    docsUrl: "https://antigravity.google/docs/ide/extensions",
    category: "acp",
    authFn: checkGenericAuth("antigravity", undefined, path.join(os.homedir(), ".gemini", "antigravity-cli")),
  },
  {
    id: "hermes",
    name: "Hermes",
    driver: "acp",
    protocol: "acp",
    binary: "hermes",
    description: "Nous Research's Hermes autonomous coding agent (`hermes acp`).",
    models: defaultModelEntry("hermes", "Hermes"),
    supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
    docsUrl: "https://hermes-agent.nousresearch.com/docs/user-guide/features/acp",
    category: "acp",
    authFn: checkGenericAuth("hermes", undefined, path.join(os.homedir(), ".hermes")),
  },
  {
    id: "kiro",
    name: "Kiro",
    driver: "acp",
    protocol: "acp",
    binary: "kiro-cli",
    fallbackBinaries: ["kiro"],
    description: "AWS Kiro spec-driven coding agent (`kiro-cli acp`).",
    models: defaultModelEntry("kiro", "Kiro"),
    supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
    docsUrl: "https://kiro.dev/cli",
    category: "acp",
    authFn: checkGenericAuth("kiro", undefined, path.join(os.homedir(), ".kiro")),
  },
  {
    id: "droid",
    name: "Factory Droid",
    driver: "acp",
    protocol: "acp",
    binary: "droid",
    description: "Factory's Droid software engineering agent (`droid acp`).",
    models: defaultModelEntry("droid", "Factory Droid"),
    supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
    envVar: "FACTORY_API_KEY",
    installCommand: "curl -fsSL https://app.factory.ai/cli | sh",
    docsUrl: "https://docs.factory.ai/cli",
    category: "acp",
    authFn: checkGenericAuth("droid", "FACTORY_API_KEY", path.join(os.homedir(), ".factory")),
  },
  {
    id: "amp",
    name: "Amp",
    driver: "acp",
    protocol: "acp",
    binary: "amp-acp",
    description: "Sourcegraph's Amp frontier coding agent (`amp-acp` adapter).",
    models: defaultModelEntry("amp", "Amp"),
    supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
    supportsResume: true,
    envVar: "AMP_API_KEY",
    installCommand: "npm install -g amp-acp",
    docsUrl: "https://github.com/tao12345666333/amp-acp",
    category: "acp",
    authFn: checkGenericAuth("amp", "AMP_API_KEY", path.join(os.homedir(), ".config", "amp")),
  },
];

async function probeBuiltin(spec) {
  const enabled = overrides[spec.id]?.enabled !== false;
  const hasApiKey = spec.envVar ? !!resolveAgentApiKey(spec.id, spec.envVar) : false;
  const customWanted = overrides[spec.id]?.binaryPath;
  let resolved = customWanted ? resolveBinary(customWanted) : resolveBinary(spec.binary);
  if (!resolved && !customWanted && Array.isArray(spec.fallbackBinaries)) {
    for (const alt of spec.fallbackBinaries) {
      resolved = resolveBinary(alt);
      if (resolved) break;
    }
  }

  if (!resolved) {
    const wanted = customWanted || spec.binary;
    return {
      id: spec.id,
      name: spec.name,
      driver: spec.driver,
      protocol: spec.protocol,
      description: spec.description,
      available: false,
      enabled,
      binaryPath: undefined,
      statusText: hasApiKey ? `API key saved · install ${wanted}` : `Not installed (${wanted} not found on PATH)`,
      models: spec.models,
      supportedRuntimeModes: spec.supportedRuntimeModes,
      supportsWorktree: true,
      supportsResume: !!spec.supportsResume,
      envVar: spec.envVar,
      hasApiKey,
      installCommand: spec.installCommand,
      docsUrl: spec.docsUrl,
      category: spec.category,
    };
  }

  const binBase = path.basename(resolved).replace(/\.(exe|cmd|bat|ps1)$/i, "");
  const version = spec.skipVersion || binBase === "agy_acp_server" ? undefined : await readVersion(resolved);
  const authNote = spec.authFn ? spec.authFn() : "CLI ready";
  return {
    id: spec.id,
    name: spec.name,
    driver: spec.driver,
    protocol: spec.protocol,
    description: spec.description,
    available: true,
    enabled,
    binaryPath: resolved,
    version,
    statusText: version ? `${authNote} · ${version}` : authNote,
    models: spec.models,
    supportedRuntimeModes: spec.supportedRuntimeModes,
    supportsWorktree: true,
    supportsResume: !!spec.supportsResume,
    envVar: spec.envVar,
    hasApiKey,
    installCommand: spec.installCommand,
    docsUrl: spec.docsUrl,
    category: spec.category,
  };
}

const results = await Promise.all([
  ...SPECS.map((spec) => probeBuiltin(spec)),
  ...customAgents.map(async (custom) => {
    const enabled = overrides[custom.id]?.enabled !== false;
    const dist = custom.distribution || "binary";
    const launcher = dist === "npx" ? "npx" : dist === "uvx" ? "uvx" : custom.command;
    const resolved = resolveBinary(launcher);
    const version = resolved && dist === "binary" ? await readVersion(resolved).catch(() => undefined) : undefined;
    const modelId = custom.defaultModel || "default";
    const hasApiKey = custom.envVar ? !!resolveAgentApiKey(custom.id, custom.envVar) : false;
    const cmdPreview =
      dist === "npx"
        ? `npx -y ${custom.packageName || custom.command} ${(custom.args || []).join(" ")}`.trim()
        : dist === "uvx"
          ? `uvx ${custom.packageName || custom.command} ${(custom.args || []).join(" ")}`.trim()
          : `${custom.command} ${(custom.args || []).join(" ")}`.trim();
    return {
      id: custom.id,
      name: custom.name,
      driver: "acp",
      protocol: "acp",
      description: cmdPreview,
      available: !!resolved,
      enabled,
      binaryPath: resolved || launcher,
      version,
      statusText: resolved ? `ACP ready · ${cmdPreview}` : `Command not found: ${launcher}`,
      models: [
        {
          id: modelId,
          name: custom.defaultModel || `${custom.name} Default`,
          api: "acp",
          provider: custom.id,
          reasoning: true,
          input: ["text"],
          cost: zeroCost,
        },
      ],
      supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
      supportsWorktree: true,
      supportsResume: false,
      isCustom: true,
      envVar: custom.envVar,
      hasApiKey,
      category: "custom",
    };
  }),
]);

process.stdout.write(JSON.stringify(results));
