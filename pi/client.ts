import { createLineSplitter } from "./jsonl";
import type { Commands, CommandType, ExtensionUiAnswer, ExtensionUiRequest, ResponseRecord, SessionEvent } from "./protocol";

/** How a Pi process ended. */
export interface Exit {
  code?: number | null;
  signal?: string | null;
  error?: string | null;
}

/**
 * The pipe to a Pi process in RPC mode: text in, text out. The app's is a
 * child process (`sidecar.ts`); tests script one.
 */
export interface Transport {
  /**
   * Queues text for Pi's stdin. A write too big for the pipe's queue may go
   * out in slices and return a promise settling once it is all queued;
   * delivery failures throw synchronously or reject that promise.
   */
  write(text: string): Promise<void> | void;
  /** Calls `handler` with each piece of stdout, in order. */
  onStdout(handler: (chunk: string) => void): void;
  /** Calls `handler` with each piece of stderr: diagnostics, never protocol. */
  onStderr(handler: (chunk: string) => void): void;
  /** Calls `handler` once, when the process is gone. */
  onExit(handler: (exit: Exit) => void): void;
  /** Closes stdin: Pi's orderly shutdown. */
  end(): void;
  /** Ends the process now. */
  kill(): void;
}

/** A command Pi answered with `success: false`, or one the process never answered. */
export class PiError extends Error {
  constructor(
    readonly command: string,
    message: string,
  ) {
    super(message);
    this.name = "PiError";
  }
}

export interface ClientHandlers {
  /** A session event. */
  onEvent(event: SessionEvent): void;
  /** An extension asks for interaction; dialogs are answered with `respond`. */
  onUiRequest(request: ExtensionUiRequest): void;
  /** The process ended, with the last of its stderr. */
  onExit(exit: Exit, stderr: string): void;
}

const STDERR_KEPT = 8_000;

/**
 * A client of one Pi process: sends commands, correlates each response by
 * `id`, and hands session events and extension UI requests to its handlers.
 * It keeps no session state of its own.
 */
export class PiClient {
  #transport: Transport;
  #pending = new Map<string, { command: string; resolve: (data: unknown) => void; reject: (error: PiError) => void }>();
  #next = 0;
  #stderr = "";
  #closed = false;

  constructor(transport: Transport, handlers: ClientHandlers) {
    this.#transport = transport;
    const lines = createLineSplitter((line) => {
      let record: { type?: string };
      try {
        record = JSON.parse(line);
      } catch {
        // Stdout is reserved for protocol records; a line that is not one is dropped, not fatal.
        console.warn("pi: unparseable record", line.slice(0, 200));
        return;
      }
      if (record.type === "response") this.#settle(record as ResponseRecord);
      else if (record.type === "extension_ui_request") handlers.onUiRequest(record as ExtensionUiRequest);
      else if (record.type) handlers.onEvent(record as SessionEvent);
    });
    transport.onStdout((chunk) => lines.push(chunk));
    transport.onStderr((chunk) => {
      this.#stderr = (this.#stderr + chunk).slice(-STDERR_KEPT);
    });
    transport.onExit((exit) => {
      this.#closed = true;
      for (const { command, reject } of this.#pending.values()) reject(new PiError(command, "Pi exited before answering"));
      this.#pending.clear();
      handlers.onExit(exit, this.#stderr.trim());
    });
  }

  /** Whether the process is gone. */
  get closed() {
    return this.#closed;
  }

  /** Sends a command; resolves with its response's `data`, rejects with a `PiError` when Pi refuses it. */
  request<C extends CommandType>(type: C, ...args: {} extends Commands[C]["args"] ? [args?: Commands[C]["args"]] : [args: Commands[C]["args"]]): Promise<Commands[C]["data"]> {
    if (this.#closed) return Promise.reject(new PiError(type, "Pi is not running"));
    const id = `c${++this.#next}`;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { command: type, resolve: resolve as (data: unknown) => void, reject });
      const failed = (error: unknown) => {
        this.#pending.delete(id);
        reject(new PiError(type, error instanceof Error ? error.message : String(error)));
      };
      try {
        void Promise.resolve(this.#transport.write(`${JSON.stringify({ id, type, ...args[0] })}\n`)).catch(failed);
      } catch (error) {
        failed(error);
      }
    });
  }

  /** The id the next request will carry: `bash` output events repeat it. */
  peekId() {
    return `c${this.#next + 1}`;
  }

  /** Answers an extension's dialog. */
  respond(id: string, answer: ExtensionUiAnswer) {
    if (this.#closed) return;
    void Promise.resolve(this.#transport.write(`${JSON.stringify({ type: "extension_ui_response", id, ...answer })}\n`)).catch((error: unknown) =>
      console.warn("pi: the extension response could not be written", error),
    );
  }

  /** Asks Pi to shut down in order, and ends it if it has not within `graceMs`. */
  close(graceMs = 500) {
    if (this.#closed) return;
    this.#transport.end();
    if (graceMs <= 0) {
      this.#transport.kill();
      return;
    }
    setTimeout(() => {
      if (!this.#closed) this.#transport.kill();
    }, graceMs);
  }

  #settle(record: ResponseRecord) {
    const waiting = record.id ? this.#pending.get(record.id) : undefined;
    if (!waiting || !record.id) {
      if (!record.success) console.warn(`pi: ${record.command} failed: ${record.error}`);
      return;
    }
    this.#pending.delete(record.id);
    if (record.success) waiting.resolve(record.data);
    else waiting.reject(new PiError(record.command, record.error ?? "Unknown error"));
  }
}
