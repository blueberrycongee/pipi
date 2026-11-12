import { expect, test } from "nsh/test";
import { stdinWriter } from "./stdin";

// `stdinWriter` against a fake child holding nsh's rule: at most `limit` bytes
// may wait for the pipe; past that `write` throws `ERR_NSH_QUOTA_EXCEEDED`
// ("stdin queue exceeded 1 MB") and queues nothing.

const LIMIT = 1024 * 1024;

const quotaError = () => {
  const error = new Error("stdin queue exceeded 1 MB") as Error & { code?: string };
  error.code = "ERR_NSH_QUOTA_EXCEEDED";
  return error;
};

/** A child whose queue drains between tasks, as the runtime's does. */
function fakeChild() {
  const received: string[] = [];
  let queued = 0;
  const write = (text: string) => {
    const bytes = Buffer.byteLength(text, "utf8");
    if (queued + bytes > LIMIT) throw quotaError();
    queued += bytes;
    received.push(text);
    queueMicrotask(() => (queued = 0));
  };
  return { received, write };
}

test("a small write is the child's own synchronous write", () => {
  const { received, write } = fakeChild();
  const stdin = stdinWriter(write, () => false);
  expect(stdin.write('{"type":"abort"}\n')).toBeUndefined();
  expect(received).toEqual(['{"type":"abort"}\n']);
});

test("an oversized write reaches the child whole, in queue-sized slices", async () => {
  const { received, write } = fakeChild();
  const stdin = stdinWriter(write, () => false);
  // ~1.6 MiB with multibyte characters landing on slice boundaries.
  const payload = `{"images":[{"data":"${"x😀".repeat(320_000)}"}]}\n`;
  const run = stdin.write(payload);
  expect(run instanceof Promise).toBe(true);
  // A write issued while the big one is in flight queues behind it.
  void stdin.write('{"type":"abort"}\n');
  await run;
  await stdin.settled();
  expect(received.length).toBeGreaterThan(1);
  for (const slice of received) {
    expect(Buffer.byteLength(slice, "utf8")).toBeLessThanOrEqual(LIMIT);
    expect(slice).not.toContain("�");
  }
  expect(received.slice(0, -1).join("")).toBe(payload);
  expect(received[received.length - 1]).toBe('{"type":"abort"}\n');
});

test("a full queue is retried until it drains, then gives up", async () => {
  const received: string[] = [];
  let queued = LIMIT;
  let refused = 0;
  const stdin = stdinWriter(
    (text) => {
      if (queued > LIMIT - 1) {
        if (++refused === 3) queueMicrotask(() => (queued = 0));
        throw quotaError();
      }
      queued += Buffer.byteLength(text, "utf8");
      received.push(text);
    },
    () => false,
    () => Promise.resolve(),
  );
  await stdin.write("small\n");
  expect(refused).toBe(3);
  expect(received).toEqual(["small\n"]);

  queued = LIMIT;
  const run = stdin.write("again\n") as Promise<void>;
  await expect(run).rejects.toThrow("stdin queue exceeded");
  // The chain survives a failed write: the next one is still delivered.
  queued = 0;
  await stdin.write("after\n");
  expect(received).toEqual(["small\n", "after\n"]);
});

test("a dead child's write rejects instead of retrying", async () => {
  const stdin = stdinWriter(
    () => {
      const error = new Error("write EPIPE") as Error & { code?: string };
      error.code = "EPIPE";
      throw error;
    },
    () => true,
    () => Promise.resolve(),
  );
  const run = stdin.write(`${"x".repeat(400_000)}\n`) as Promise<void>;
  await expect(run).rejects.toThrow("EPIPE");
});
