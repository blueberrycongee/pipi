// Shared Node utilities for pipi sidecar helpers (`sidecar/*.mjs`):
// PATH expansion for GUI/Dock launches, binary resolution across Homebrew/NVM/Bun/uv/local,
// `<agent-dir>/auth.json` secret injection, and external session storage paths.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export function expandedPathEnv() {
  const home = os.homedir();
  const existing = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const extra = [path.dirname(process.execPath)];

  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    extra.push(
      path.join(programFiles, "nodejs"),
      path.join(programFilesX86, "nodejs"),
      path.join(localAppData, "Programs", "nodejs"),
      path.join(appData, "npm"),
      path.join(localAppData, "pnpm"),
      path.join(home, "scoop", "shims"),
      path.join(home, ".bun", "bin"),
      path.join(home, ".local", "bin"),
      path.join(home, ".cargo", "bin"),
      path.join(home, ".opencode", "bin"),
      path.join(home, ".cursor", "bin"),
      path.join(home, ".devin", "bin"),
      path.join(home, ".grok", "bin"),
      path.join(home, ".hermes", "bin"),
      path.join(home, ".kiro", "bin"),
      path.join(home, ".amp", "bin"),
      path.join(home, ".factory", "bin"),
      path.join(home, ".volta", "bin"),
      path.join(localAppData, "Volta", "bin"),
      path.join(localAppData, "fnm_multishells"),
      path.join(localAppData, "mise", "shims"),
      path.join(home, ".asdf", "shims"),
      path.join(localAppData, "nvs", "default"),
      path.join(programFiles, "Git", "cmd"),
      path.join(programFiles, "Git", "bin"),
      path.join(localAppData, "Programs", "Antigravity", "bin"),
    );
    // nvm-windows symlinks its active Node into `NVM_SYMLINK` (usually C:\nvm4w\nodejs).
    for (const dir of [process.env.NVM_SYMLINK, process.env.NVM_HOME && path.join(process.env.NVM_HOME, "nodejs")]) {
      if (dir) extra.unshift(dir);
    }
    // fnm on Windows materializes the active install under `fnm_multishells/<pid>_<ts>`.
    try {
      const fnmRoot = path.join(localAppData, "fnm_multishells");
      if (fs.existsSync(fnmRoot)) {
        const dirs = fs.readdirSync(fnmRoot).sort().reverse();
        for (const d of dirs) extra.unshift(path.join(fnmRoot, d));
      }
    } catch {}
    // mise on Windows installs Node under `%LOCALAPPDATA%\mise\installs\node\<ver>`.
    try {
      const miseNode = path.join(localAppData, "mise", "installs", "node");
      if (fs.existsSync(miseNode)) {
        const dirs = fs.readdirSync(miseNode).sort().reverse();
        for (const d of dirs) extra.unshift(path.join(miseNode, d));
      }
    } catch {}
  } else {
    extra.push(
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      "/usr/local/bin",
      path.join(home, ".local", "bin"),
      path.join(home, "bin"),
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
    );
    if (process.platform === "linux") {
      extra.push("/snap/bin", "/var/lib/flatpak/exports/bin", path.join(home, ".local", "share", "flatpak", "exports", "bin"));
    }
    // Discover NVM node bins if present (`~/.nvm/versions/node/*/bin`)
    try {
      const nvmVersions = path.join(home, ".nvm", "versions", "node");
      if (fs.existsSync(nvmVersions)) {
        const dirs = fs.readdirSync(nvmVersions).sort().reverse();
        for (const d of dirs) extra.unshift(path.join(nvmVersions, d, "bin"));
      }
    } catch {}
  }

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
  if (process.platform === "darwin") {
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
  } else if (process.platform === "win32") {
    const now = Date.now();
    if (!cachedSystemProxy || now - cachedSystemProxyAt > SYSTEM_PROXY_TTL_MS) {
      cachedSystemProxy = readWindowsSystemProxy();
      cachedSystemProxyAt = now;
    }
  } else {
    return {};
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
    ...(process.platform === "win32" ? { USERPROFILE: process.env.USERPROFILE || os.homedir() } : {}),
    PATH: expandedPathEnv(),
    ...extra,
  };
}

/** File extensions Windows treats as runnable when a bare name resolves on PATH. */
const WINDOWS_EXTS = [".exe", ".cmd", ".bat", ".ps1", ""];

function windowsExtensions() {
  const pathext = (process.env.PATHEXT || "").split(";").filter(Boolean);
  const merged = [...WINDOWS_EXTS];
  for (const ext of pathext) {
    const lower = ext.toLowerCase();
    if (!merged.includes(lower)) merged.push(lower);
  }
  return merged;
}

function isExecutable(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return false;
    if (process.platform === "win32") return true;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveBinary(nameOrPath) {
  if (!nameOrPath) return undefined;
  const expanded = nameOrPath.startsWith("~/") || nameOrPath.startsWith("~\\") ? path.join(os.homedir(), nameOrPath.slice(2)) : nameOrPath;
  const hasSeparator = expanded.includes("/") || expanded.includes("\\") || /^[a-zA-Z]:/.test(expanded);
  if (hasSeparator) {
    if (isExecutable(expanded)) return expanded;
    if (process.platform === "win32" && !path.extname(expanded)) {
      for (const ext of windowsExtensions()) {
        if (ext && isExecutable(expanded + ext)) return expanded + ext;
      }
    }
    return undefined;
  }
  const dirs = expandedPathEnv().split(path.delimiter);
  const names = process.platform === "win32" && !path.extname(expanded) ? windowsExtensions().map((ext) => expanded + ext) : [expanded];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

/** True when Windows can only run `file` through `cmd.exe` (`.cmd`/`.bat` shims, e.g. npm-installed CLIs). */
export function needsCmdShim(file) {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(file);
}

/**
 * Spawns a resolved binary, routing `.cmd`/`.bat` shims through `cmd.exe` and
 * `.ps1` scripts through PowerShell on Windows. Use this instead of a bare
 * `spawn(bin, ...)`, which fails there with EINVAL.
 */
export function spawnBinary(bin, args = [], options = {}) {
  if (process.platform === "win32") {
    if (/\.ps1$/i.test(bin)) {
      const shell = resolveBinary("pwsh") || "powershell.exe";
      return spawn(shell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", bin, ...args], options);
    }
    if (needsCmdShim(bin)) {
      return spawn(bin, args, { ...options, shell: true });
    }
  }
  return spawn(bin, args, options);
}

/**
 * `execFile` equivalent that also runs `.cmd`/`.bat` shims on Windows
 * (plain `execFile` refuses them). Resolves `{ stdout, stderr, code }`,
 * rejecting only on spawn failure.
 */
export function execBinary(bin, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnBinary(bin, args, {
        ...options,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = options.timeout
      ? setTimeout(() => {
          try {
            child.kill();
          } catch {}
        }, options.timeout)
      : undefined;
    child.on("error", reject);
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}

/** The shell used for user-facing `bash` command execution: `$SHELL -lc` on POSIX, `cmd /c` on Windows. */
export function shellForCommand(command) {
  if (process.platform === "win32") {
    return { file: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", command] };
  }
  return { file: process.env.SHELL || "/bin/sh", args: ["-lc", command] };
}

/** Reads the Windows system proxy (HKCU Internet Settings) into standard proxy env vars. */
function readWindowsSystemProxy() {
  const out = {};
  try {
    const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
    const query = (value) => {
      const raw = execFileSync("reg.exe", ["query", key, "/v", value], {
        encoding: "utf8",
        timeout: 800,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const m = new RegExp(`${value}\\s+REG_[A-Z_]+\\s+(.+)`, "i").exec(raw);
      return m ? m[1].trim() : "";
    };
    if (query("ProxyEnable") === "0x1" || query("ProxyEnable") === "1") {
      const server = query("ProxyServer");
      if (server) {
        const url = server.includes("://") ? server : `http://${server}`;
        out.HTTP_PROXY = url;
        out.http_proxy = url;
        out.HTTPS_PROXY = url;
        out.https_proxy = url;
      }
      const override = query("ProxyOverride");
      const noProxy = ["127.0.0.1", "localhost", "::1"];
      if (override) {
        for (const item of override.split(";")) {
          const trimmed = item.trim();
          if (trimmed && trimmed !== "<local>") noProxy.push(trimmed.startsWith("*.") ? trimmed.slice(1) : trimmed);
        }
      }
      out.NO_PROXY = noProxy.join(",");
      out.no_proxy = out.NO_PROXY;
    }
  } catch {
    return {};
  }
  return out;
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
