// A child's stdin under nsh's quota: `ChildProcess.write` keeps at most 1 MiB
// of text waiting for the pipe and throws `ERR_NSH_QUOTA_EXCEEDED` past it —
// and a prompt carrying screenshots runs to several times that. Oversized
// writes therefore go out in slices small enough to sit in the queue, a
// runloop turn apart so the runtime can drain, retried while it stays full.
// Writes keep their order: one write's slices never interleave another's.

/** A slice stays well under the runtime's 1 MiB stdin queue. */
const SLICE = 192 * 1024;

/** How many times a full queue is retried before a write gives up (~4s). */
const RETRIES = 60;

const realPace = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const queueFull = (error: unknown) => {
  const { code, message } = (error ?? {}) as { code?: string; message?: string };
  return code === "ERR_NSH_QUOTA_EXCEEDED" || (message ?? String(error)).includes("stdin queue exceeded");
};

export interface StdinWriter {
  /**
   * Queues text for the child's stdin. Up to `SLICE` bytes it is the child's
   * own synchronous `write`, throwing as it does. Larger text returns a
   * promise resolving once every slice is queued, rejecting on failure.
   */
  write(text: string): Promise<void> | void;
  /** Resolves once everything written so far has been handed to the child. */
  settled(): Promise<void>;
}

/**
 * Wraps `ChildProcess.write` so commands of any size reach the child.
 * `gone` reports the process dead; a write that keeps finding the queue full
 * after `RETRIES` pauses, or one landing on a dead child, rejects.
 */
export function stdinWriter(write: (text: string) => void, gone: () => boolean, pace = realPace): StdinWriter {
  let tail: Promise<void> | undefined;

  const deliver = async (text: string) => {
    for (let attempt = 0; ; attempt++) {
      try {
        write(text);
        return;
      } catch (error) {
        if (!queueFull(error) || gone() || attempt >= RETRIES) throw error;
        await pace(Math.min(200, 10 * (attempt + 1)));
      }
    }
  };

  const pump = async (text: string) => {
    const bytes = Buffer.from(text, "utf8");
    for (let start = 0; start < bytes.length; ) {
      let end = Math.min(start + SLICE, bytes.length);
      while (end < bytes.length && end > start && (bytes[end] & 0xc0) === 0x80) end--;
      await deliver(bytes.toString("utf8", start, end));
      start = end;
      if (start < bytes.length) await pace(0);
    }
  };

  return {
    write(text) {
      if (!tail && Buffer.byteLength(text, "utf8") <= SLICE) {
        try {
          write(text);
          return;
        } catch (error) {
          // A full queue (earlier writes still draining) retries below, in order.
          if (!queueFull(error) || gone()) throw error;
        }
      }
      const run = (tail ?? Promise.resolve()).then(() => pump(text));
      const marker = run.then(
        () => {
          if (tail === marker) tail = undefined;
        },
        () => {
          if (tail === marker) tail = undefined;
        },
      );
      tail = marker;
      return run;
    },
    settled: () => tail ?? Promise.resolve(),
  };
}
