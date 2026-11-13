import fs from "fs/promises";
import os from "os";
import process from "process";
import type { ChildProcess, CommandOutput } from "process";
import { fileURLToPath } from "url";
import type { StartAgentOptions } from "../agents/types";
import { env } from "../lib/env";
import { tr } from "../lib/i18n";
import type { Exit, Transport } from "./client";
import { stdinWriter } from "./stdin";

// Keep all sidecar Node helpers referenced as URL assets so `nsh package` ships
// every `sidecar/*.mjs` file inside `Contents/Resources/nsh/assets/sidecar/`.
import agentUsageAsset from "../sidecar/agent-usage.mjs?url";
import daemonClientAsset from "../sidecar/daemon-client.mjs?url";
import daemonLinkAsset from "../sidecar/daemon-link.mjs?url";
import envPathsAsset from "../sidecar/env-paths.mjs?url";
import externalAgentAsset from "../sidecar/external-agent.mjs?url";
import launchPiAsset from "../sidecar/launch-pi.mjs?url";
import listSessionsAsset from "../sidecar/list-sessions.mjs?url";
import pipiCliAsset from "../sidecar/pipi-cli.mjs?url";
import pipiDaemonAsset from "../sidecar/pipi-daemon.mjs?url";
import pipiMcpStdioAsset from "../sidecar/pipi-mcp-stdio.mjs?url";
import pipiOrchestratorExtensionAsset from "../sidecar/pipi-orchestrator-extension.mjs?url";
import probeAgentsAsset from "../sidecar/probe-agents.mjs?url";
import usageStatsAsset from "../sidecar/usage-stats.mjs?url";
import worktreeAsset from "../sidecar/worktree.mjs?url";

void [
  agentUsageAsset,
  daemonClientAsset,
  daemonLinkAsset,
  envPathsAsset,
  externalAgentAsset,
  launchPiAsset,
  listSessionsAsset,
  pipiCliAsset,
  pipiDaemonAsset,
  pipiMcpStdioAsset,
  pipiOrchestratorExtensionAsset,
  probeAgentsAsset,
  usageStatsAsset,
  worktreeAsset,
];

/**
 * The Pi & external agent sidecars:
 * - Pi is the user's own `pi` CLI run in `--mode rpc` via `sidecar/launch-pi.mjs`
 *   (which injects `sidecar/pipi-orchestrator-extension.mjs` + runtime/orchestrator
 *   config), so pipi shares the user's providers, credentials, sessions, and Pi extensions.
 * - External CLI coding agents (`Claude Code`, `Codex`, `OpenCode`, `Cursor`,
 *   custom `ACP`) run through `sidecar/external-agent.mjs`, speaking the exact
 *   same LF-delimited JSONL RPC protocol back to `PiClient`.
 */

/** The app's directory on disk, or `undefined` where modules are not files (headless tests, phones, the web). */
export function appDir(): string | undefined {
  try {
    const url = new URL("..", import.meta.url);
    if (url.protocol !== "file:") return undefined;
    let dir = fileURLToPath(url).replace(/[\\/]+$/, "");
    // nsh's fileURLToPath leaves a POSIX-style `/C:/...` on Windows; the fs
    // capability grants compare against the native `C:\...` form.
    if (process.platform === "windows" && /^\/[A-Za-z]:/.test(dir)) {
      dir = dir.slice(1).replace(/\//g, "\\");
    }
    return dir;
  } catch {
    return undefined;
  }
}

const SIDECAR_DIR_KEY = "__pipiSidecarDir";
const NODE_LAUNCHER_KEY = "__pipiNodeLauncher";

/**
 * Resolves the directory containing `sidecar/*.mjs`:
 * - `nsh dev` / checkout: `<appDir>/sidecar`
 * - `nsh package` `.app`: `<appDir>/assets/sidecar`
 */
async function sidecarDir(): Promise<string | undefined> {
  const dir = appDir();
  if (!dir) return undefined;
  const g = globalThis as Record<string, unknown>;
  const cached = g[SIDECAR_DIR_KEY] as string | undefined;
  if (cached) return cached;
  const candidates = [`${dir}/sidecar`, `${dir}/assets/sidecar`];
  for (const candidate of candidates) {
    if (await fs.exists(`${candidate}/env-paths.mjs`)) {
      g[SIDECAR_DIR_KEY] = candidate;
      return candidate;
    }
  }
  return `${dir}/sidecar`;
}

const isWindows = process.platform === "windows";
const isMac = process.platform === "macos";

/**
 * `node` as the host PATH has it. Bare names only: they are all `nsh.json` grants
 * (`capabilities.process.execute`), and a path it does not grant is refused
 * (`ERR_ACCESS_DENIED`), not missing (`ENOENT`).
 */
export const DIRECT_NODE_COMMANDS: string[] = isWindows ? ["node", "node.exe"] : ["node"];

/**
 * System-wide installs the OS's short PATH leaves out (an app opened from Finder or a
 * dock). Absolute paths are not execute grants (bare names only), so the host
 * shell looks for them (`firstExecutable`) and starts the one it finds
 * (`spawnWithLauncher`).
 */
const SYSTEM_NODE_PATHS: string[] = isMac
  ? ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/opt/local/bin/node"]
  : ["/usr/bin/node", "/usr/local/bin/node", "/snap/bin/node"];

const FIRST_EXECUTABLE_SCRIPT = 'for p in "$@"; do if [ -x "$p" ]; then printf "%s\\n" "$p"; exit 0; fi; done; exit 1';

type NodeLauncher = { kind: "direct"; command: string } | { kind: "shell"; path: string };

const SHELL_EXEC_SCRIPT = 'node="$1"; shift; exec "$node" "$@"';

/**
 * `cmd /d /s /c` argv for a discovered absolute executable path. The outer quotes are
 * stripped by `/s`; each argument is quoted, with inner `"` doubled so Node's argv
 * parser reads them back as literal quotes (the JSON payload contains quotes).
 */
function windowsCmdArgv(executable: string, args: string[]): string[] {
  const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;
  return ["/d", "/s", "/c", `"${[executable, ...args].map(quote).join(" ")}"`];
}

/** Why the sidecar could not start, in words for the person at the screen. */
export class SidecarError extends Error {
  constructor(
    message: string,
    readonly hint: string,
  ) {
    super(message);
    this.name = "SidecarError";
  }
}

type Coded = { code?: string; message?: string; permission?: string };

/**
 * Why an agent process could not be started. nsh refuses two things with
 * `ERR_ACCESS_DENIED`: a working folder outside `capabilities.fs.write` (`permission`
 * `"fs"`) and a command `capabilities.process.execute` does not grant (`"process"`).
 * Only the first is about the folder the person chose.
 */
export function startError(error: unknown, agent: string): SidecarError {
  if (error instanceof SidecarError) return error;
  const { code, permission, message } = error as Coded;
  if (code === "ERR_ACCESS_DENIED" && permission === "fs")
    return new SidecarError(
      tr("This folder is outside what pipi may open", "此文件夹超出 pipi 可打开的范围"),
      tr("pipi can work in folders under your home directory.", "pipi 可以在主目录下的文件夹中工作。"),
    );
  return new SidecarError(tr(`${agent} could not start`, `${agent} 无法启动`), message ?? String(error));
}

function desktopOnlyError(): SidecarError {
  return new SidecarError(
    tr("pipi runs on desktops only", "pipi 仅支持桌面端运行"),
    tr("This platform cannot start local agent processes.", "当前平台无法启动本地智能体进程。"),
  );
}

function nodeMissingError(): SidecarError {
  return new SidecarError(
    tr("Node.js was not found", "未找到 Node.js"),
    tr(
      "pipi requires Node.js 22.19 or newer installed on this machine.",
      "pipi 需要安装 Node.js 22.19 或更高版本。",
    ),
  );
}

function parseSemver(tag: string): [number, number, number] | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(tag.trim());
  if (!m) return undefined;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareSemverDesc(a: string, b: string): number {
  const va = parseSemver(a);
  const vb = parseSemver(b);
  if (va && vb) {
    if (vb[0] !== va[0]) return vb[0] - va[0];
    if (vb[1] !== va[1]) return vb[1] - va[1];
    return vb[2] - va[2];
  }
  if (va) return -1;
  if (vb) return 1;
  return b.localeCompare(a);
}

async function sortedVersionBins(versionsRoot: string, binSubpath = isWindows ? "node.exe" : "bin/node"): Promise<string[]> {
  try {
    if (!(await fs.exists(versionsRoot))) return [];
    const entries = await fs.readdir(versionsRoot);
    entries.sort(compareSemverDesc);
    const found: string[] = [];
    for (const entry of entries) {
      const candidate = `${versionsRoot}/${entry}/${binSubpath}`;
      if (await fs.exists(candidate)) found.push(candidate);
    }
    return found;
  } catch {
    return [];
  }
}

/** The first of `paths` that is an executable file, asked of the host shell: they are not the app's to read. */
async function firstExecutable(paths: string[]): Promise<string | undefined> {
  try {
    const probe = await process.run("sh", ["-c", FIRST_EXECUTABLE_SCRIPT, "sh", ...paths], { timeoutMs: 4000 });
    const found = probe.stdout.trim();
    return probe.code === 0 && found.startsWith("/") ? found : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Discovers user-space Node.js installations (NVM, Volta, fnm, mise, asdf, Scoop, login
 * shell) when the OS launches pipi with a minimal PATH (Finder/Dock on macOS, the Start
 * menu on Windows).
 */
async function discoverUserNodePath(): Promise<string | undefined> {
  let home = "";
  try {
    home = os.homedir();
  } catch {
    return undefined;
  }
  if (home && isWindows) {
    const localAppData = env("LOCALAPPDATA") || `${home}\\AppData\\Local`;
    const appData = env("APPDATA") || `${home}\\AppData\\Roaming`;
    const nvmSymlink = env("NVM_SYMLINK") || "C:\\nvm4w\\nodejs";
    const miseBins = await sortedVersionBins(`${localAppData}\\mise\\installs\\node`);
    const fnmShells = await sortedVersionBins(`${localAppData}\\fnm_multishells`);
    const candidates = [
      ...fnmShells,
      ...miseBins,
      `${nvmSymlink}\\node.exe`,
      `${localAppData}\\Programs\\nodejs\\node.exe`,
      "C:\\Program Files\\nodejs\\node.exe",
      "C:\\Program Files (x86)\\nodejs\\node.exe",
      `${home}\\scoop\\shims\\node.exe`,
      `${home}\\scoop\\apps\\nodejs\\current\\node.exe`,
      `${home}\\.volta\\bin\\node.exe`,
      `${localAppData}\\Volta\\bin\\node.exe`,
      `${home}\\.asdf\\shims\\node.exe`,
      `${appData}\\nvm\\nodejs\\node.exe`,
      `${localAppData}\\nvs\\default\\node.exe`,
      `${appData}\\npm\\node.exe`,
      `${home}\\.local\\bin\\node.exe`,
    ];
    for (const candidate of candidates) {
      try {
        if (await fs.exists(candidate)) return candidate;
      } catch {}
    }
    try {
      const probe = await process.run("where", ["node"], { timeoutMs: 4000 });
      const resolved = probe.stdout.trim().split(/\r?\n/).map((l) => l.trim()).find((l) => l.endsWith(".exe"));
      if (probe.code === 0 && resolved) return resolved;
    } catch {}
    return undefined;
  }
  const system = await firstExecutable(SYSTEM_NODE_PATHS);
  if (system) return system;
  if (home) {
    const nvmBins = await sortedVersionBins(`${home}/.nvm/versions/node`);
    const miseBins = await sortedVersionBins(`${home}/.local/share/mise/installs/node`);
    const asdfBins = await sortedVersionBins(`${home}/.asdf/installs/nodejs`);
    const candidates = [
      ...nvmBins,
      `${home}/.volta/bin/node`,
      `${home}/.fnm/aliases/default/bin/node`,
      `${home}/.local/share/fnm/aliases/default/bin/node`,
      `${home}/Library/Application Support/fnm/aliases/default/bin/node`,
      ...miseBins,
      `${home}/.local/share/mise/shims/node`,
      ...asdfBins,
      `${home}/.asdf/shims/node`,
      `${home}/.local/bin/node`,
      `${home}/bin/node`,
    ];
    for (const candidate of candidates) {
      try {
        if (await fs.exists(candidate)) return candidate;
      } catch {}
    }
  }
  try {
    const probe = await process.run("sh", ["-lc", "command -v node"], { timeoutMs: 4000 });
    const resolved = probe.stdout.trim().split("\n").pop()?.trim();
    if (probe.code === 0 && resolved && resolved.startsWith("/")) return resolved;
  } catch {}
  return undefined;
}

/** Runs `launch` with each direct `node`, moving on only when that one is not installed. */
export function withNode<T>(launch: (node: string) => T): T {
  for (const node of DIRECT_NODE_COMMANDS) {
    try {
      return launch(node);
    } catch (error) {
      const code = (error as Coded).code;
      if (code === "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM") throw desktopOnlyError();
      if (code !== "ENOENT") throw error;
    }
  }
  throw nodeMissingError();
}

function cachedLauncher(): NodeLauncher | undefined {
  return (globalThis as Record<string, unknown>)[NODE_LAUNCHER_KEY] as NodeLauncher | undefined;
}

function setCachedLauncher(launcher: NodeLauncher | undefined) {
  const g = globalThis as Record<string, unknown>;
  if (launcher) g[NODE_LAUNCHER_KEY] = launcher;
  else delete g[NODE_LAUNCHER_KEY];
}

function spawnWithLauncher(
  launcher: NodeLauncher,
  args: string[],
  options: { cwd?: string; stdin?: "pipe" | "null" },
): ChildProcess {
  if (launcher.kind === "direct") {
    return process.spawn(launcher.command, args, options);
  }
  // Only bare executable names are granted on every platform (absolute paths are
  // platform-specific), so a discovered absolute node path goes through the host
  // shell — `sh -c exec` on POSIX, `cmd /c` on Windows — the same way it does on
  // macOS today.
  if (isWindows) {
    return process.spawn("cmd", windowsCmdArgv(launcher.path, args), options);
  }
  return process.spawn("sh", ["-c", SHELL_EXEC_SCRIPT, "sh", launcher.path, ...args], options);
}

function runWithLauncher(
  launcher: NodeLauncher,
  args: string[],
  options: { cwd?: string; timeoutMs?: number },
): Promise<CommandOutput> {
  if (launcher.kind === "direct") {
    return process.run(launcher.command, args, options);
  }
  if (isWindows) {
    return process.run("cmd", windowsCmdArgv(launcher.path, args), options);
  }
  return process.run("sh", ["-c", SHELL_EXEC_SCRIPT, "sh", launcher.path, ...args], options);
}

const LIVE_CHILDREN_KEY = "__pipiLiveChildren";
const HELPER_SEM_KEY = "__pipiHelperSem";
const HELPER_CONCURRENCY = 4;

interface HelperSemaphore {
  active: number;
  queue: Array<() => void>;
}

/** Tracks every live `ChildProcess` across hot-reload module evaluations in the same QuickJS VM. */
function liveChildren(): Set<ChildProcess> {
  const g = globalThis as Record<string, unknown>;
  let set = g[LIVE_CHILDREN_KEY] as Set<ChildProcess> | undefined;
  if (!set) {
    set = new Set<ChildProcess>();
    g[LIVE_CHILDREN_KEY] = set;
  }
  return set;
}

function helperSemaphore(): HelperSemaphore {
  const g = globalThis as Record<string, unknown>;
  let sem = g[HELPER_SEM_KEY] as HelperSemaphore | undefined;
  if (!sem) {
    sem = { active: 0, queue: [] };
    g[HELPER_SEM_KEY] = sem;
  }
  return sem;
}

async function withHelperSlot<T>(fn: () => Promise<T>): Promise<T> {
  const sem = helperSemaphore();
  if (sem.active >= HELPER_CONCURRENCY) {
    await new Promise<void>((resolve) => sem.queue.push(resolve));
  }
  sem.active++;
  try {
    return await fn();
  } finally {
    sem.active--;
    sem.queue.shift()?.();
  }
}

/** Terminates any sidecar child processes still alive in this QuickJS VM (e.g. across `nsh dev` hot reloads). */
export function killAllSidecars() {
  const tracked = liveChildren();
  for (const child of [...tracked]) {
    tracked.delete(child);
    try {
      child.kill();
    } catch {}
  }
}

const isChildLimitError = (error: unknown) => {
  const msg = (error as Coded)?.message ?? String(error);
  return msg.includes("may run at most") && msg.includes("children");
};

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Spawns `node` with `args`, discovering user-installed Node (NVM/Volta/fnm/mise) when needed. */
async function spawnNode(args: string[], options: { cwd?: string; stdin?: "pipe" | "null" }): Promise<ChildProcess> {
  for (let attempt = 0; ; attempt++) {
    try {
      const cached = cachedLauncher();
      if (cached) {
        try {
          return spawnWithLauncher(cached, args, options);
        } catch (error) {
          if ((error as Coded).code !== "ENOENT") throw error;
          setCachedLauncher(undefined);
        }
      }
      for (const command of DIRECT_NODE_COMMANDS) {
        try {
          const child = process.spawn(command, args, options);
          setCachedLauncher({ kind: "direct", command });
          return child;
        } catch (error) {
          const code = (error as Coded).code;
          if (code === "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM") throw desktopOnlyError();
          if (code !== "ENOENT") throw error;
        }
      }
      const discovered = await discoverUserNodePath();
      if (discovered) {
        const launcher: NodeLauncher = { kind: "shell", path: discovered };
        const child = spawnWithLauncher(launcher, args, options);
        setCachedLauncher(launcher);
        return child;
      }
      throw nodeMissingError();
    } catch (error) {
      if (attempt < 3 && isChildLimitError(error)) {
        await wait(150);
        continue;
      }
      throw error;
    }
  }
}

/** Runs `node` to completion with `args`, using the same direct + user-space Node discovery as `spawnNode`. */
async function runNode(args: string[], options: { cwd?: string; timeoutMs?: number }): Promise<CommandOutput> {
  const cached = cachedLauncher();
  if (cached) {
    try {
      return await runWithLauncher(cached, args, options);
    } catch (error) {
      if ((error as Coded).code !== "ENOENT") throw error;
      setCachedLauncher(undefined);
    }
  }
  for (const command of DIRECT_NODE_COMMANDS) {
    try {
      const out = await process.run(command, args, options);
      setCachedLauncher({ kind: "direct", command });
      return out;
    } catch (error) {
      const code = (error as Coded).code;
      if (code === "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM") throw desktopOnlyError();
      if (code !== "ENOENT") throw error;
    }
  }
  const discovered = await discoverUserNodePath();
  if (discovered) {
    const launcher: NodeLauncher = { kind: "shell", path: discovered };
    const out = await runWithLauncher(launcher, args, options);
    setCachedLauncher(launcher);
    return out;
  }
  throw nodeMissingError();
}

function childToTransport(child: ChildProcess): Transport {
  const tracked = liveChildren();
  tracked.add(child);
  let exited: Exit | undefined;
  let disposed = false;
  const exitHandlers: Array<(exit: Exit) => void> = [];

  child.on("exit", (result) => {
    tracked.delete(child);
    exited = result as Exit;
    for (const handler of exitHandlers.splice(0)) {
      try {
        handler(exited);
      } catch {}
    }
    queueMicrotask(() => {
      if (disposed) return;
      disposed = true;
      try {
        child.dispose();
      } catch {}
    });
  });

  const stdin = stdinWriter(
    (text) => child.write(text),
    () => disposed || exited !== undefined,
  );

  return {
    write: (text) => {
      if (disposed || exited) throw new Error("Process has exited");
      return stdin.write(text);
    },
    onStdout: (handler) => {
      if (!disposed) child.on("stdout", handler);
    },
    onStderr: (handler) => {
      if (!disposed) child.on("stderr", handler);
    },
    onExit: (handler) => {
      if (exited) queueMicrotask(() => handler(exited!));
      else exitHandlers.push(handler);
    },
    end: () => {
      if (disposed || exited) return;
      // Slices still in flight must reach the child before its stdin closes.
      void stdin.settled().then(() => {
        try {
          child.end();
        } catch {}
      });
    },
    kill: () => {
      tracked.delete(child);
      if (disposed || exited) return;
      try {
        child.kill();
      } catch {}
    },
  };
}

/** Starts Pi or an external coding agent harness in RPC mode in `options.cwd`. */
export async function startAgent(options: StartAgentOptions): Promise<Transport> {
  const dir = await sidecarDir();
  if (!dir) throw desktopOnlyError();
  const { cwd, agentId } = options;
  const driver = options.driver ?? (agentId === "pi" ? "pi" : (agentId as StartAgentOptions["driver"]) ?? "pi");
  if (!(await fs.exists(cwd))) throw new SidecarError(tr("The folder no longer exists", "文件夹已不存在"), cwd);

  if (driver === "pi") {
    const launcher = `${dir}/launch-pi.mjs`;
    const payload = JSON.stringify({
      binaryPath: options.binaryPath,
      runtimeMode: options.runtimeMode ?? "full-access",
      orchestratorUrl: options.orchestratorUrl,
      orchestratorToken: options.orchestratorToken,
      extraArgs: options.extraArgs,
    });
    try {
      const child = await spawnNode([launcher, payload], { cwd, stdin: "pipe" });
      return childToTransport(child);
    } catch (error) {
      throw startError(error, "Pi");
    }
  }

  // External coding agent (`Claude Code`, `Codex`, `OpenCode`, `Cursor`, or custom `ACP`)
  const bridge = `${dir}/external-agent.mjs`;
  const payload = JSON.stringify({
    cwd,
    agentId,
    driver,
    runtimeMode: options.runtimeMode ?? "full-access",
    binaryPath: options.binaryPath,
    extraArgs: options.extraArgs,
    customAgent: options.customAgent,
    orchestratorUrl: options.orchestratorUrl,
    orchestratorToken: options.orchestratorToken,
  });
  try {
    const child = await spawnNode([bridge, payload], { cwd, stdin: "pipe" });
    return childToTransport(child);
  } catch (error) {
    throw startError(error, agentId);
  }
}

/** Starts Pi in RPC mode in `cwd`, the session's working directory. */
export async function startPi(cwd: string): Promise<Transport> {
  return startAgent({ cwd, agentId: "pi", driver: "pi" });
}

/** Spawns a long-lived Node helper (`sidecar/*.mjs`) as a JSONL transport. */
export async function spawnHelperTransport(script: string, args: string[] = []): Promise<Transport> {
  const dir = await sidecarDir();
  if (!dir) throw desktopOnlyError();
  const child = await spawnNode([`${dir}/${script}`, ...args], { stdin: "pipe" });
  return childToTransport(child);
}

/** Runs one of the app's Node helpers (`sidecar/*.mjs`) to its end and returns its stdout. */
export async function runHelper(script: string, args: string[]): Promise<string> {
  const dir = await sidecarDir();
  if (!dir) throw desktopOnlyError();
  const result = await withHelperSlot(() => runNode([`${dir}/${script}`, ...args], { timeoutMs: 20_000 }));
  if (result.code !== 0) throw new Error(result.stderr.trim() || `${script} exited with ${result.code}`);
  return result.stdout;
}
