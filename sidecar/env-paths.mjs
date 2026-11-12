// Shared Node utilities for pipi sidecar helpers (`sidecar/*.mjs`):
// PATH expansion for GUI/Dock launches, binary resolution across Homebrew/NVM/Bun/uv/local,
// `<agent-dir>/auth.json` secret injection, and external session storage paths.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export function expandedPathEnv() {
  const home = os.homedir();
  const existing = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const extra = [
    path.dirname(process.execPath),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    path.join(home, ".local", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".cargo", "bin"),
    path.join(home, ".opencode", "bin"),
    path.join(home, ".cursor", "bin"),
    path.join(home, ".devin", "bin"),
    path.join(home, ".grok", "bin"),
    path.join(home, ".hermes", "bin"),
    path.join(home, ".kiro", "bin"),
    path.join(home, ".amp", "bin"),
    path.join(home, ".factory", "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".volta", "bin"),
    path.join(home, ".fnm", "aliases", "default", "bin"),
    path.join(home, ".asdf", "shims"),
    path.join(home, ".local", "share", "mise", "shims"),
    "/Applications/Antigravity.app/Contents/Resources/app/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  // Discover NVM node bins if present (`~/.nvm/versions/node/*/bin`)
  try {
    const nvmVersions = path.join(home, ".nvm", "versions", "node");
    if (fs.existsSync(nvmVersions)) {
      const dirs = fs.readdirSync(nvmVersions).sort().reverse();
      for (const d of dirs) extra.unshift(path.join(nvmVersions, d, "bin"));
    }
  } catch {}

  const seen = new Set();
  const merged = [];
  for (const dir of [...existing, ...extra]) {
    if (dir && !seen.has(dir)) {
      seen.add(dir);
      merged.push(dir);
    }
  }
  return merged.join(path.delimiter);
}

export function agentDirPath() {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

/** Reads `<agent-dir>/auth.json` safely without throwing when absent. */
export function readAuthStore() {
  try {
    const raw = fs.readFileSync(path.join(agentDirPath(), "auth.json"), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

const PROVIDER_FALLBACKS_BY_ENV = {
  ANTHROPIC_API_KEY: ["anthropic"],
  OPENAI_API_KEY: ["openai"],
  GEMINI_API_KEY: ["google", "gemini"],
  XAI_API_KEY: ["xai"],
  DEEPSEEK_API_KEY: ["deepseek"],
  MOONSHOT_API_KEY: ["moonshot", "kimi"],
  DASHSCOPE_API_KEY: ["qwen", "dashscope"],
  COPILOT_GITHUB_TOKEN: ["github-copilot"],
};

/**
 * Resolves any stored API key for `agentId` / `envVar` from `<agent-dir>/auth.json`
 * (`agent:<agentId>` first, then matching Pi provider entries when `process.env[envVar]` is unset).
 */
export function resolveAgentApiKey(agentId, envVar) {
  if (!envVar) return undefined;
  if (process.env[envVar]) return { key: process.env[envVar], source: "env" };
  const auth = readAuthStore();
  const direct = auth[`agent:${agentId}`];
  if (direct?.type === "api_key" && typeof direct.key === "string" && direct.key.trim()) {
    return { key: direct.key.trim(), source: "auth" };
  }
  for (const alias of PROVIDER_FALLBACKS_BY_ENV[envVar] || []) {
    const entry = auth[alias];
    if (entry?.type === "api_key" && typeof entry.key === "string" && entry.key.trim()) {
      return { key: entry.key.trim(), source: "provider" };
    }
  }
  return undefined;
}

export function agentAuthEnv(agentId, envVar) {
  const found = resolveAgentApiKey(agentId, envVar);
  if (!found || !envVar) return {};
  return { [envVar]: found.key };
}

const SYSTEM_PROXY_TTL_MS = 15_000;
let cachedSystemProxy = undefined;
let cachedSystemProxyAt = 0;

/**
 * Parses `scutil --proxy` output into standard HTTP(S)/SOCKS/NO_PROXY env vars.
 * macOS GUI apps launched from Finder/Dock do not inherit shell proxy exports,
 * while CLI coding agents (`agy`, `claude`, `codex`, `gemini`, `pi`, …) read
 * environment variables rather than CFNetwork's system proxy dictionary.
 */
export function parseScutilProxy(output) {
  if (typeof output !== "string" || !output) return {};
  const scalar = (key) => {
    const m = new RegExp(`^\\s*${key}\\s*:\\s*(.+)\\s*$`, "m").exec(output);
    return m ? m[1].trim() : "";
  };
  const httpUrl =
    scalar("HTTPEnable") === "1" && scalar("HTTPProxy") && scalar("HTTPPort")
      ? `http://${scalar("HTTPProxy")}:${scalar("HTTPPort")}`
      : "";
  const httpsUrl =
    scalar("HTTPSEnable") === "1" && scalar("HTTPSProxy") && scalar("HTTPSPort")
      ? `http://${scalar("HTTPSProxy")}:${scalar("HTTPSPort")}`
      : "";
  const socksUrl =
    scalar("SOCKSEnable") === "1" && scalar("SOCKSProxy") && scalar("SOCKSPort")
      ? `socks5://${scalar("SOCKSProxy")}:${scalar("SOCKSPort")}`
      : "";
  if (!httpUrl && !httpsUrl && !socksUrl) return {};

  const noProxySet = new Set(["127.0.0.1", "localhost", "::1"]);
  const listMatch = /ExceptionsList\s*:\s*<array>\s*\{([\s\S]*?)\}/.exec(output);
  if (listMatch) {
    for (const line of listMatch[1].split("\n")) {
      const item = /^\s*\d+\s*:\s*(.+?)\s*$/.exec(line)?.[1];
      if (!item || item === "<local>") continue;
      noProxySet.add(item.startsWith("*.") ? item.slice(1) : item);
    }
  }
  const noProxy = [...noProxySet].join(",");

  const env = { NO_PROXY: noProxy, no_proxy: noProxy };
  if (httpUrl) {
    env.HTTP_PROXY = httpUrl;
    env.http_proxy = httpUrl;
  }
  if (httpsUrl || httpUrl) {
    env.HTTPS_PROXY = httpsUrl || httpUrl;
    env.https_proxy = httpsUrl || httpUrl;
  }
  if (socksUrl) {
    env.ALL_PROXY = socksUrl;
    env.all_proxy = socksUrl;
  }
  return env;
}

export function systemProxyEnv() {
  if (process.platform !== "darwin") return {};
  const now = Date.now();
  if (!cachedSystemProxy || now - cachedSystemProxyAt > SYSTEM_PROXY_TTL_MS) {
    try {
      const raw = execFileSync("/usr/sbin/scutil", ["--proxy"], {
        encoding: "utf8",
        timeout: 800,
        stdio: ["ignore", "pipe", "ignore"],
      });
      cachedSystemProxy = parseScutilProxy(raw);
    } catch {
      cachedSystemProxy = {};
    }
    cachedSystemProxyAt = now;
  }
  const out = {};
  const has = (upper, lower) => upper in process.env || lower in process.env;
  if (!has("HTTP_PROXY", "http_proxy") && cachedSystemProxy.HTTP_PROXY) {
    out.HTTP_PROXY = cachedSystemProxy.HTTP_PROXY;
    out.http_proxy = cachedSystemProxy.http_proxy;
  }
  if (!has("HTTPS_PROXY", "https_proxy") && cachedSystemProxy.HTTPS_PROXY) {
    out.HTTPS_PROXY = cachedSystemProxy.HTTPS_PROXY;
    out.https_proxy = cachedSystemProxy.https_proxy;
  }
  if (!has("ALL_PROXY", "all_proxy") && cachedSystemProxy.ALL_PROXY) {
    out.ALL_PROXY = cachedSystemProxy.ALL_PROXY;
    out.all_proxy = cachedSystemProxy.all_proxy;
  }
  if (!has("NO_PROXY", "no_proxy") && cachedSystemProxy.NO_PROXY) {
    out.NO_PROXY = cachedSystemProxy.NO_PROXY;
    out.no_proxy = cachedSystemProxy.no_proxy;
  } else if (
    (process.env.HTTP_PROXY || process.env.http_proxy || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy) &&
    !has("NO_PROXY", "no_proxy")
  ) {
    out.NO_PROXY = "127.0.0.1,localhost,::1";
    out.no_proxy = "127.0.0.1,localhost,::1";
  }
  return out;
}

export function childEnv(extra = {}) {
  return {
    ...process.env,
    ...systemProxyEnv(),
    HOME: process.env.HOME || os.homedir(),
    PATH: expandedPathEnv(),
    ...extra,
  };
}

export function resolveBinary(nameOrPath) {
  if (!nameOrPath) return undefined;
  const expanded = nameOrPath.startsWith("~/") ? path.join(os.homedir(), nameOrPath.slice(2)) : nameOrPath;
  if (expanded.includes("/")) {
    try {
      fs.accessSync(expanded, fs.constants.X_OK);
      return expanded;
    } catch {
      return undefined;
    }
  }
  const dirs = expandedPathEnv().split(path.delimiter);
  for (const dir of dirs) {
    const candidate = path.join(dir, expanded);
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile()) {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      }
    } catch {}
  }
  return undefined;
}

export function externalSessionsDir(cwd) {
  const base =
    process.env.PI_CODING_AGENT_SESSION_DIR ||
    path.join(agentDirPath(), "pipi-external-sessions");
  const hash = crypto.createHash("sha1").update(path.resolve(cwd)).digest("hex").slice(0, 14);
  const slug = path.basename(cwd).replace(/[^a-zA-Z0-9._-]+/g, "-") || "root";
  return path.join(base, `${slug}-${hash}`);
}

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}
