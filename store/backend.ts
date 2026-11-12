import os from "os";
import process from "process";
import { defaultAgentStatuses } from "../agents/catalog";
import type {
  AgentHarnessStatus,
  AgentOverride,
  CustomAgentConfig,
  DelegatedTask,
  DelegateTaskInput,
  RuntimeMode,
  StartAgentOptions,
  WorktreeInfo,
} from "../agents/types";
import type { Transport } from "../pi/client";
import { type CredentialKind, removeCredential, saveApiKey, storedCredentials } from "../pi/credentials";
import { createLineSplitter } from "../pi/jsonl";
import type { ExtensionUiAnswer, ExtensionUiRequest, SessionEvent } from "../pi/protocol";
import { deleteSession, listSessions, listWorkspaceSessions, type SessionSummary } from "../pi/sessions";
import { usageStats, type UsageStats } from "../pi/usage";
import { runHelper, spawnHelperTransport, startAgent, startPi } from "../pi/sidecar";

export interface OrchestratorCallbacks {
  onTaskStarted(task: Omit<DelegatedTask, "rows">): void;
  onTaskUpdated(task: Omit<DelegatedTask, "rows">): void;
  onTaskEvent(taskId: string, event: SessionEvent): void;
  onSubagentUiRequest(taskId: string, request: ExtensionUiRequest): void;
  onExit?(): void;
}

export interface OrchestratorHandle {
  url: string;
  token: string;
  configure(config: {
    cwd?: string;
    runtimeMode?: RuntimeMode;
    overrides?: Record<string, AgentOverride>;
    customAgents?: CustomAgentConfig[];
  }): void;
  delegate(input: DelegateTaskInput & { cwd?: string; groupId?: string; workflowKind?: DelegatedTask["workflowKind"]; stepIndex?: number }): Promise<Omit<DelegatedTask, "rows">>;
  cancel(taskId: string): Promise<void>;
  respondUi(compositeId: string, answer: ExtensionUiAnswer): void;
  close(): void;
}

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
  startOrchestrator?(callbacks: OrchestratorCallbacks): Promise<OrchestratorHandle>;
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
  /** Shows the system's folder panel; resolves with the folder, or `undefined` when cancelled or unavailable. */
  pickFolder(prompt: string): Promise<string | undefined>;
  /** Shows the system's image file picker; resolves with the selected image path, or `undefined` when cancelled. */
  pickImage?(prompt: string): Promise<string | undefined>;
}

/** Tries each `[command, args]` picker in order, returning its chosen path or `""`. */
async function runDesktopPicker(candidates: Array<[string, string[]]>): Promise<string> {
  for (const [command, args] of candidates) {
    try {
      const { code, stdout } = await process.run(command, args, { timeoutMs: 600_000 });
      const path = stdout.trim().split(/\r?\n/).pop()?.trim() ?? "";
      if (code === 0 && path) return path;
    } catch {
      // Picker binary not installed — try the next one.
    }
  }
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
  async startOrchestrator(callbacks) {
    const transport = await spawnHelperTransport("orchestrator-daemon.mjs");
    let seq = 1;
    const pending = new Map<string, { resolve: (data: unknown) => void; reject: (err: Error) => void }>();

    let readyResolve: ((info: { url: string; token: string }) => void) | undefined;
    let readyReject: ((err: Error) => void) | undefined;
    const readyPromise = new Promise<{ url: string; token: string }>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });

    const splitter = createLineSplitter((line) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        if (msg.type === "ready" && typeof msg.url === "string" && typeof msg.token === "string") {
          readyResolve?.({ url: msg.url, token: msg.token });
          readyResolve = undefined;
        } else if (msg.type === "response" && typeof msg.id === "string") {
          const w = pending.get(msg.id);
          if (w) {
            pending.delete(msg.id);
            if (msg.success) w.resolve(msg.data);
            else w.reject(new Error(typeof msg.error === "string" ? msg.error : "Orchestrator error"));
          }
        } else if (msg.type === "task_started" && msg.task) {
          callbacks.onTaskStarted(msg.task as Omit<DelegatedTask, "rows">);
        } else if (msg.type === "task_updated" && msg.task) {
          callbacks.onTaskUpdated(msg.task as Omit<DelegatedTask, "rows">);
        } else if (msg.type === "task_event" && typeof msg.taskId === "string" && msg.event) {
          callbacks.onTaskEvent(msg.taskId, msg.event as SessionEvent);
        } else if (msg.type === "subagent_ui_request" && typeof msg.taskId === "string" && msg.request) {
          callbacks.onSubagentUiRequest(msg.taskId, msg.request as ExtensionUiRequest);
        }
      } catch {}
    });

    transport.onStdout((chunk) => splitter.push(chunk));

    transport.onExit((exit) => {
      if (readyReject) {
        readyReject(new Error(exit.error || `Orchestrator daemon exited (${exit.code ?? exit.signal})`));
        readyReject = undefined;
      }
      for (const [, w] of pending) w.reject(new Error("Orchestrator daemon stopped"));
      pending.clear();
      callbacks.onExit?.();
    });

    const { url, token } = await readyPromise;

    const send = (payload: Record<string, unknown>) =>
      void Promise.resolve(transport.write(`${JSON.stringify(payload)}\n`)).catch((error: unknown) =>
        console.warn("orchestrator: the command could not be written", error),
      );

    const call = <T>(type: string, payload: Record<string, unknown>): Promise<T> => {
      const id = `orch_${seq++}`;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (data: unknown) => void, reject });
        const failed = (error: unknown) => {
          pending.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        };
        try {
          void Promise.resolve(transport.write(`${JSON.stringify({ id, type, ...payload })}\n`)).catch(failed);
        } catch (error) {
          failed(error);
        }
      });
    };

    return {
      url,
      token,
      configure(config) {
        send({ type: "configure", ...config });
      },
      delegate(input) {
        return call<Omit<DelegatedTask, "rows">>("delegate", { input });
      },
      async cancel(taskId) {
        await call("cancel", { taskId });
      },
      respondUi(compositeId, answer) {
        send({ type: "subagent_ui_response", compositeId, answer });
      },
      close() {
        transport.kill();
      },
    };
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
    } catch {
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
    } catch {
      return undefined;
    }
  },
};

let current = system;

/** The backend in use. */
export const backend = () => current;

/** Replaces the backend: call before `boot()`. */
export function useBackend(next: Backend) {
  current = next;
}
