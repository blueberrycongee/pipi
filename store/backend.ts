import os from "os";
import process from "process";
import { checkForUpdate, downloadUpdate, installAndRestart, type AppUpdate, type UpdateProgress } from "nsh/updater";
import { defaultAgentStatuses } from "../agents/catalog";
import type {
  AgentHarnessStatus,
  AgentOverride,
  CustomAgentConfig,
  RuntimeMode,
  StartAgentOptions,
  WorktreeInfo,
} from "../agents/types";
import type { Transport } from "../pi/client";
import { type CredentialKind, removeCredential, saveApiKey, storedCredentials } from "../pi/credentials";
import { DaemonClient, type DaemonCallbacks } from "../pi/daemon";
import { deleteSession, listSessions, listWorkspaceSessions, type SessionSummary } from "../pi/sessions";
import { usageStats, type UsageStats } from "../pi/usage";
import { runHelper, spawnHelperTransport, startAgent, startPi } from "../pi/sidecar";

/**
 * Everything the store asks of the machine: the Pi & external agent processes,
 * session files, credential store, external agent discovery, git worktrees,
 * multi-agent orchestrator, and folder panel.
 */
export interface Backend {
  /** The user's home directory. */
  home(): string;
  /** The app's own data directory (its storage and preferences live there). */
  dataDir(): string;
  startPi(cwd: string): Promise<Transport>;
  startAgent?(options: StartAgentOptions): Promise<Transport>;
  probeAgents?(options?: { overrides?: Record<string, AgentOverride>; customAgents?: CustomAgentConfig[] }): Promise<AgentHarnessStatus[]>;
  /** Connects to the session daemon (through `daemon-link.mjs`, starting it detached when absent). */
  connectDaemon?(callbacks: DaemonCallbacks): Promise<DaemonClient>;
  worktreeStatus?(cwd: string): Promise<{ isGitRepo: boolean; root?: string; branch?: string; headCommit?: string; dirty?: boolean; worktrees?: WorktreeInfo[] }>;
  createWorktree?(cwd: string, label: string): Promise<WorktreeInfo>;
  removeWorktree?(cwd: string, worktreePath: string): Promise<void>;
  listSessions(cwd: string): Promise<SessionSummary[]>;
  listWorkspaceSessions?(cwds: string[]): Promise<Record<string, SessionSummary[]>>;
  /** Token use and cost across every saved session on this machine. */
  usageStats?(): Promise<UsageStats>;
  deleteSession(path: string): Promise<void>;
  storedCredentials(): Promise<Record<string, CredentialKind>>;
  saveApiKey(provider: string, key: string): Promise<void>;
  removeCredential(provider: string): Promise<void>;
  /** Shows the system's folder panel; resolves with the folder, or `undefined` when cancelled or unavailable. Throws `NoPickerError` when no picker tool exists. */
  pickFolder(prompt: string): Promise<string | undefined>;
  /** Shows the system's image file picker; resolves with the selected image path, or `undefined` when cancelled. Throws `NoPickerError` when no picker tool exists. */
  pickImage?(prompt: string): Promise<string | undefined>;
  /** Asks the app's update source (`nsh.json` → `updater`) for a newer version; `null` when up to date or updates don't apply here. */
  checkAppUpdate?(): Promise<AppUpdate | null>;
  /** Downloads the update the last check found; rejects when there is none or it cannot install here. */
  downloadAppUpdate?(onProgress?: (progress: UpdateProgress) => void): Promise<void>;
  /** Replaces the app with the downloaded update and relaunches; settles only on failure. */
  installAppUpdate?(): Promise<void>;
}

/**
 * Thrown by the desktop pickers when no picker tool could be launched at all
 * (Linux without zenity or kdialog) — distinct from a cancelled pick, which
 * resolves `undefined`.
 */
export class NoPickerError extends Error {
  constructor() {
    super("no desktop picker available");
    this.name = "NoPickerError";
  }
}

/** Tries each `[command, args]` picker in order, returning its chosen path or `""`. */
async function runDesktopPicker(candidates: Array<[string, string[]]>): Promise<string> {
  let launched = false;
  for (const [command, args] of candidates) {
    try {
      const { code, stdout } = await process.run(command, args, { timeoutMs: 600_000 });
      launched = true;
      const path = stdout.trim().split(/\r?\n/).pop()?.trim() ?? "";
      if (code === 0 && path) return path;
    } catch {
      // Picker binary not installed — try the next one.
    }
  }
  if (!launched) throw new NoPickerError();
  return "";
}

const system: Backend = {
  home: () => {
    try {
      return os.homedir();
    } catch {
      return "/";
    }
  },
  dataDir: () => {
    try {
      // Read the global like lib/env.ts: under hot reload the `process`
      // module's default import is its namespace, which has no `dataDir`.
      return (globalThis as { process?: { dataDir?: string | null } }).process?.dataDir ?? os.homedir();
    } catch {
      return os.homedir();
    }
  },
  startPi,
  startAgent,
  async probeAgents(options) {
    try {
      const out = await runHelper("probe-agents.mjs", [JSON.stringify(options ?? {})]);
      const parsed: unknown = JSON.parse(out || "[]");
      return Array.isArray(parsed) ? (parsed as AgentHarnessStatus[]) : defaultAgentStatuses(options?.customAgents);
    } catch {
      return defaultAgentStatuses(options?.customAgents);
    }
  },
  async connectDaemon(callbacks) {
    // `${dataDir()}/daemon` keeps the app's daemon state (instance file,
    // session registry) in its sandboxed data directory; the daemon itself is
    // started detached by `daemon-link.mjs` so sessions outlive the window.
    const transport = await spawnHelperTransport("daemon-link.mjs", ["--home", `${system.dataDir()}/daemon`]);
    return DaemonClient.connect(transport, callbacks);
  },
  async worktreeStatus(cwd) {
    try {
      const out = await runHelper("worktree.mjs", ["status", cwd]);
      return JSON.parse(out || '{"isGitRepo":false}');
    } catch {
      return { isGitRepo: false };
    }
  },
  async createWorktree(cwd, label) {
    const out = await runHelper("worktree.mjs", ["create", cwd, label]);
    return JSON.parse(out) as WorktreeInfo;
  },
  async removeWorktree(cwd, worktreePath) {
    await runHelper("worktree.mjs", ["remove", cwd, worktreePath]);
  },
  listSessions,
  listWorkspaceSessions,
  usageStats,
  deleteSession,
  storedCredentials,
  saveApiKey,
  removeCredential,
  async pickFolder(prompt) {
    try {
      if (process.platform === "macos") {
        const { code, stdout } = await process.run("osascript", ["-e", `POSIX path of (choose folder with prompt ${JSON.stringify(prompt)})`], { timeoutMs: 600_000 });
        const path = stdout.trim().replace(/\/$/, "");
        return code === 0 && path ? path : undefined;
      }
      if (process.platform === "windows") {
        const script = [
          "Add-Type -AssemblyName System.Windows.Forms",
          `$d = New-Object System.Windows.Forms.FolderBrowserDialog`,
          `$d.Description = ${JSON.stringify(prompt)}`,
          `$d.ShowNewFolderButton = $true`,
          `if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }`,
        ].join("; ");
        const { code, stdout } = await process.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", script], { timeoutMs: 600_000 });
        const path = stdout.trim().split(/\r?\n/).pop()?.trim() ?? "";
        return code === 0 && path ? path : undefined;
      }
      if (process.platform === "linux") {
        const out = await runDesktopPicker([
          ["zenity", ["--file-selection", "--directory", `--title=${prompt}`]],
          ["kdialog", ["--getexistingdirectory", ".", "--title", prompt]],
        ]);
        return out || undefined;
      }
      return undefined;
    } catch (error) {
      if (error instanceof NoPickerError) throw error;
      return undefined;
    }
  },
  async pickImage(prompt) {
    try {
      if (process.platform === "macos") {
        const script = `POSIX path of (choose file of type {"png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "public.image"} with prompt ${JSON.stringify(prompt)})`;
        const { code, stdout } = await process.run("osascript", ["-e", script], { timeoutMs: 600_000 });
        const path = stdout.trim();
        return code === 0 && path ? path : undefined;
      }
      if (process.platform === "windows") {
        const script = [
          "Add-Type -AssemblyName System.Windows.Forms",
          `$d = New-Object System.Windows.Forms.OpenFileDialog`,
          `$d.Title = ${JSON.stringify(prompt)}`,
          `$d.Filter = 'Images|*.png;*.jpg;*.jpeg;*.gif;*.webp;*.bmp;*.tif;*.tiff|All files|*.*'`,
          `if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.FileName }`,
        ].join("; ");
        const { code, stdout } = await process.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", script], { timeoutMs: 600_000 });
        const path = stdout.trim().split(/\r?\n/).pop()?.trim() ?? "";
        return code === 0 && path ? path : undefined;
      }
      if (process.platform === "linux") {
        const out = await runDesktopPicker([
          ["zenity", ["--file-selection", `--title=${prompt}`, "--file-filter=Images | *.png *.jpg *.jpeg *.gif *.webp *.bmp *.tif *.tiff", "--file-filter=All files | *"]],
          ["kdialog", ["--getopenfilename", ".", "*.png *.jpg *.jpeg *.gif *.webp *.bmp *.tif *.tiff|Images", "--title", prompt]],
        ]);
        return out || undefined;
      }
      return undefined;
    } catch (error) {
      if (error instanceof NoPickerError) throw error;
      return undefined;
    }
  },
  checkAppUpdate: checkForUpdate,
  downloadAppUpdate: (onProgress) => downloadUpdate(onProgress),
  installAppUpdate: () => installAndRestart(),
};

let current = system;

/** The backend in use. */
export const backend = () => current;

/** Replaces the backend: call before `boot()`. */
export function useBackend(next: Backend) {
  current = next;
}
