import type { CustomAgentConfig, RuntimeMode, WorktreeInfo } from "../agents/types";
import type { Exit, Transport } from "./client";
import { createLineSplitter } from "./jsonl";

/**
 * One session as the daemon reports it: the registry entry every client
 * (sidebar, agent tools, CLI) reads. `status` is daemon-owned truth, never
 * inferred: a session's own stream says `working`/`blocked`, its exit says
 * `failed`, a replayed registry says `interrupted`.
 */
export interface DaemonSession {
  id: string;
  title: string;
  cwd: string;
  file?: string;
  agentId: string;
  agentName: string;
  driver: string;
  parentId?: string;
  initiator?: string;
  runtimeMode: RuntimeMode;
  worktree?: WorktreeInfo;
  status: "idle" | "working" | "blocked" | "failed" | "interrupted";
  unread: boolean;
  loaded: boolean;
  depth: number;
  createdAt: number;
  lastActive: number;
}

export interface DaemonAttachSpec {
  id?: string;
  file?: string;
  title?: string;
  cwd: string;
  agentId: string;
  agentName?: string;
  driver?: string;
  runtimeMode?: RuntimeMode;
  binaryPath?: string;
  extraArgs?: string[];
  customAgent?: CustomAgentConfig;
}

export interface DaemonCallbacks {
  onSession(session: DaemonSession): void;
  onExit?(): void;
}

interface VirtualTransport extends Transport {
  sessionId: string;
}

interface VirtualStream {
  out: Array<(chunk: string) => void>;
  err: Array<(chunk: string) => void>;
  exit: Array<(e: Exit) => void>;
}

/**
 * The app's handle on the session daemon: one NDJSON line channel (through
 * `daemon-link.mjs`) multiplexing every session the app has attached. Each
 * attached session hands back a `Transport`-shaped view — `write` becomes an
 * `in` frame, `out`/`err`/`exit` frames become its callbacks — so `PiClient`
 * keeps speaking the one internal protocol, engine-agnostic, while the daemon
 * owns every process. `end`/`kill` detach rather than end the process: the
 * daemon's sessions are meant to outlive the window looking at them.
 */
export class DaemonClient {
  private seq = 0;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private streams = new Map<string, Set<VirtualStream>>();
  private sessions = new Map<string, DaemonSession>();

  private constructor(
    private transport: Transport,
    private callbacks: DaemonCallbacks,
  ) {}

  static async connect(transport: Transport, callbacks: DaemonCallbacks): Promise<DaemonClient> {
    const client = new DaemonClient(transport, callbacks);
    const ready = new Promise<void>((resolve, reject) => {
      client._hello = { resolve, reject };
    });
    const splitter = createLineSplitter((line) => {
      try {
        client.onRecord(JSON.parse(line) as Record<string, unknown>);
      } catch {}
    });
    transport.onStdout((chunk) => splitter.push(chunk));
    transport.onStderr((chunk) => {
      client.lastError = (client.lastError + chunk).slice(-4000);
    });
    transport.onExit((exit) => {
      for (const [, w] of client.pending) w.reject(new Error("daemon link stopped"));
      client.pending.clear();
      for (const set of client.streams.values()) {
        for (const stream of set) {
          for (const h of stream.exit.splice(0)) h(exit);
        }
      }
      client.streams.clear();
      client._hello?.reject(new Error(client.lastError || `daemon link exited (${exit.code ?? exit.signal})`));
      callbacks.onExit?.();
    });
    // The link sends the daemon's `hello` first thing; nothing to write.
    await ready;
    return client;
  }

  private _hello?: { resolve: () => void; reject: (e: Error) => void };
  private lastError = "";

  private onRecord(msg: Record<string, unknown>) {
    switch (msg.type) {
      case "hello": {
        const list = (msg.sessions as DaemonSession[]) ?? [];
        this.sessions = new Map(list.map((s) => [s.id, s]));
        for (const session of list) this.callbacks.onSession(session);
        this._hello?.resolve();
        this._hello = undefined;
        return;
      }
      case "session": {
        const session = msg.session as DaemonSession;
        this.sessions.set(session.id, session);
        this.callbacks.onSession(session);
        return;
      }
      case "out": {
        const set = this.streams.get(String(msg.sessionId));
        if (set) {
          for (const stream of [...set]) {
            for (const h of stream.out) h(`${msg.line}\n`);
          }
        }
        return;
      }
      case "err": {
        const set = this.streams.get(String(msg.sessionId));
        if (set) {
          for (const stream of [...set]) {
            for (const h of stream.err) h(String(msg.text));
          }
        }
        return;
      }
      case "exit": {
        const sessionId = String(msg.sessionId);
        const set = this.streams.get(sessionId);
        if (set) {
          this.streams.delete(sessionId);
          for (const stream of [...set]) {
            for (const h of stream.exit.splice(0)) h({ code: msg.code as number | null, signal: msg.signal as string | undefined });
          }
        }
        return;
      }
      case "detached": {
        return;
      }
      default: {
        if (typeof msg.id === "string" && this.pending.has(msg.id)) {
          const w = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.type === "error") w.reject(new Error(String(msg.error ?? "daemon error")));
          else w.resolve(msg);
        }
      }
    }
  }

  private call<T>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
    const id = `a${++this.seq}`;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (msg) => resolve(msg as T),
        reject,
      });
      try {
        void Promise.resolve(this.transport.write(`${JSON.stringify({ id, type, ...payload })}\n`)).catch((error) => {
          this.pending.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private notify(type: string, payload: Record<string, unknown> = {}) {
    try {
      void Promise.resolve(this.transport.write(`${JSON.stringify({ type, ...payload })}\n`)).catch(() => {});
    } catch {}
  }

  /** A session by daemon id (from the last push the app saw). */
  session(id: string | undefined): DaemonSession | undefined {
    return id ? this.sessions.get(id) : undefined;
  }

  async list(): Promise<DaemonSession[]> {
    const res = await this.call<{ sessions: DaemonSession[] }>("list");
    return res.sessions;
  }

  /**
   * Joins a daemon session — spawning its process on first attach, adopting it
   * live when it is already loaded — and returns the virtual transport to
   * drive it with plus the session record.
   */
  async attach(spec: DaemonAttachSpec): Promise<{ transport: VirtualTransport; session: DaemonSession }> {
    const res = await this.call<{ session: DaemonSession }>("attach", { session: spec });
    const session = res.session;
    const client = this;
    const stream: VirtualStream = { out: [], err: [], exit: [] };
    let set = this.streams.get(session.id);
    if (!set) {
      set = new Set();
      this.streams.set(session.id, set);
    }
    set.add(stream);
    let ended = false;
    let writeBuf = "";
    const detachStream = () => {
      if (ended) return;
      ended = true;
      const active = client.streams.get(session.id);
      if (active) {
        active.delete(stream);
        if (active.size === 0) {
          client.streams.delete(session.id);
          client.notify("detach", { sessionId: session.id });
        }
      }
      for (const h of stream.exit.splice(0)) h({ code: 0 });
    };
    const virtual: VirtualTransport = {
      sessionId: session.id,
      write(text) {
        if (ended) throw new Error("Session detached");
        writeBuf += text;
        let at = writeBuf.indexOf("\n");
        while (at !== -1) {
          const line = writeBuf.slice(0, at).replace(/\r$/, "");
          writeBuf = writeBuf.slice(at + 1);
          at = writeBuf.indexOf("\n");
          if (line) client.notify("in", { sessionId: session.id, line });
        }
      },
      onStdout: (handler) => void stream.out.push(handler),
      onStderr: (handler) => void stream.err.push(handler),
      onExit: (handler) => void stream.exit.push(handler),
      end: detachStream,
      kill: detachStream,
    };
    return { transport: virtual, session };
  }

  /** Ends the session's process (the record survives; the next attach revives it). */
  async killSession(sessionId: string): Promise<void> {
    await this.call("kill", { sessionId });
  }

  /** Aborts the session's current turn and every run under it. */
  async stopTree(sessionId: string): Promise<void> {
    await this.call("stop", { sessionId });
  }

  /** Aborts every running session tree in the daemon. */
  async stopAll(): Promise<void> {
    await this.call("stop_all");
  }

  markRead(sessionId: string) {
    this.notify("mark_read", { sessionId });
  }

  /** The session chip's pick — the daemon stores it as this session's ceiling. */
  setRuntimeMode(sessionId: string, mode: RuntimeMode) {
    this.notify("set_runtime_mode", { sessionId, mode });
  }

  /** Tells the daemon which session file an attached process is on now. */
  reportFile(sessionId: string, file: string | undefined) {
    if (file) this.notify("file", { sessionId, file });
  }

  /** Starts a detached-or-child session (the compare flow): its answer goes to the user. */
  async startSession(input: {
    title: string;
    agentId: string;
    cwd: string;
    message?: string;
    parentId?: string;
    runtimeMode?: RuntimeMode;
    worktree?: boolean;
  }): Promise<DaemonSession> {
    const res = await this.call<{ session: DaemonSession }>("start_session", { input });
    return res.session;
  }

  configure(config: {
    agents?: unknown[];
    overrides?: Record<string, unknown>;
    customAgents?: CustomAgentConfig[];
    allowAgentTools?: boolean;
    sendScope?: string;
    maxDepth?: number;
    maxRunning?: number;
    worktreeDefault?: boolean;
    linger?: boolean;
  }) {
    this.notify("config", config as Record<string, unknown>);
  }

  async externalMcp(): Promise<{ url: string; token: string }> {
    const res = await this.call<{ url: string; token: string }>("external_token");
    return res;
  }

  async installCli(): Promise<string> {
    const res = await this.call<{ path: string }>("install_cli");
    return res.path;
  }

  close() {
    this.transport.kill();
  }
}
