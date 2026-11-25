// Shared client for pipi's session daemon (`sidecar/daemon-client.mjs`):
//
//   const conn = await connectDaemon({ home, kind: "ui" });
//   conn.send({ id: "1", type: "attach", session: {...} });
//   conn.onLine((msg) => ...);
//
// `connectDaemon` reads `<home>/daemon.json`; when it is absent or stale it
// starts `pipi-daemon.mjs` detached (the daemon outlives whichever app asked
// for it) and retries until the instance file reports live ports. The
// returned `conn` is a line channel over the daemon's TCP control channel:
// `send` writes one record, `onLine` receives each one the daemon pushes.
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON = path.join(__dirname, "pipi-daemon.mjs");

const FINGERPRINT_FILES = [
  "pipi-daemon.mjs",
  "daemon-client.mjs",
  "external-agent.mjs",
  "launch-pi.mjs",
  "pipi-orchestrator-extension.mjs",
  "pipi-mcp-stdio.mjs",
  "acp-form.mjs",
  "agent-usage.mjs",
  "env-paths.mjs",
  "session-index.mjs",
  "worktree.mjs",
];

/**
 * Deterministic fingerprint of the sidecar runtime code and directory.
 * Lets a newly updated UI detect when an older detached `pipi-daemon` from a
 * previous install/package is still listening on `daemon.json`.
 */
export function sidecarFingerprint(dir = __dirname) {
  if (process.env.PIPI_DAEMON_FINGERPRINT) return String(process.env.PIPI_DAEMON_FINGERPRINT);
  const hash = crypto.createHash("sha256");
  hash.update(path.resolve(dir));
  hash.update("\0");
  for (const name of FINGERPRINT_FILES) {
    hash.update(name);
    hash.update("\0");
    try {
      hash.update(fs.readFileSync(path.join(dir, name)));
    } catch {}
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

const defaultHome = () => path.join(process.env.HOME || process.env.USERPROFILE || ".", ".pipi");
const instanceFile = (home) => path.join(home || defaultHome(), "daemon.json");

async function readInstance(home) {
  try {
    const data = JSON.parse(await fsp.readFile(instanceFile(home), "utf8"));
    if (data?.controlPort && data?.token) return data;
  } catch {}
  return undefined;
}

function tryConnect(data) {
  return new Promise((resolve, reject) => {
    const onErr = (err) => reject(err);
    const conn = net.createConnection({ host: "127.0.0.1", port: data.controlPort }, () => {
      conn.removeListener("error", onErr);
      resolve(conn);
    });
    conn.once("error", onErr);
  });
}

function spawnDaemon(home) {
  const child = spawn(process.execPath, [DAEMON, "--home", home], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
}

/**
 * Waits until a stale daemon has actually closed its control port or removed
 * its `daemon.json` entry so the replacement never races on the instance file.
 */
async function waitForDaemonGone(home, oldData, timeoutMs = 3000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const current = await readInstance(home);
    if (!current || current.pid !== oldData.pid || current.controlPort !== oldData.controlPort) return;
    const stillListening = await tryConnect(oldData).then(
      (probe) => {
        probe.destroy();
        return true;
      },
      () => false,
    );
    if (!stillListening) return;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
}

/**
 * When a UI client connects to an older detached daemon (mismatched sidecar
 * fingerprint), gracefully replaces it if no sessions are actively running,
 * or keeps the live connection intact so running agents are never interrupted.
 */
async function probeAndMaybeUpgrade(conn, data, home, kind) {
  const channel = wire(conn, data.token, kind);
  const bufferedBeforeCaller = [];
  const waitMessage = (pred, ms) =>
    new Promise((resolve) => {
      let done = false;
      const fn = (msg) => {
        if (!pred(msg)) return;
        finish(msg);
      };
      const finish = (val) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const at = channel._handlers.indexOf(fn);
        if (at >= 0) channel._handlers.splice(at, 1);
        resolve(val);
      };
      const timer = setTimeout(() => finish(undefined), ms);
      timer.unref?.();
      channel._handlers.push(fn);
    });

  // Capture every message arriving while we inspect `hello` so nothing is lost
  // if we decide to keep this connection (active runs in flight).
  const capture = (msg) => bufferedBeforeCaller.push(msg);
  channel._handlers.push(capture);
  const hello = await waitMessage((m) => m?.type === "hello", 2000);
  if (!hello) {
    channel._handlers.splice(channel._handlers.indexOf(capture), 1);
    return { upgraded: false, channel, replay: bufferedBeforeCaller };
  }

  const upgradeReqId = `u_up_${Date.now()}`;
  const sessions = Array.isArray(hello.sessions) ? hello.sessions : [];
  const hasRunning = sessions.some((s) => s?.loaded !== false && (s?.status === "working" || s?.status === "blocked"));

  const replyPromise = waitMessage((m) => m?.id === upgradeReqId, 1500);
  channel.send({ id: upgradeReqId, type: "shutdown_if_idle" });
  const reply = await replyPromise;

  // Strip our internal probe reply so callers never see an unsolicited response.
  const captureAt = channel._handlers.indexOf(capture);
  if (captureAt >= 0) channel._handlers.splice(captureAt, 1);
  const replay = bufferedBeforeCaller.filter((m) => m?.id !== upgradeReqId);

  if (reply?.type === "ok" && reply.shuttingDown === true) {
    channel.close();
    await waitForDaemonGone(home, data);
    return { upgraded: true };
  }
  if (reply?.type === "ok" && reply.shuttingDown === false) {
    // New daemon reported active runs (or backgroundWatch) and deferred upgrade.
    return { upgraded: false, channel, replay };
  }
  // Legacy daemon (pre-fingerprint / no `shutdown_if_idle` op): only recycle via
  // SIGTERM when no sessions are working or blocked.
  if (!hasRunning && Number.isInteger(data.pid) && data.pid > 0 && data.pid !== process.pid) {
    channel.close();
    try {
      process.kill(data.pid, "SIGTERM");
    } catch {}
    await waitForDaemonGone(home, data);
    return { upgraded: true };
  }
  return { upgraded: false, channel, replay };
}

/**
 * Opens the daemon's control channel, starting the daemon detached when the
 * instance file is missing or its ports refuse a connection. When a desktop UI
 * connects to a stale daemon from an older app version and no sessions are
 * active, the stale daemon is cleanly replaced before returning.
 */
export async function connectDaemon({ home, kind = "ui", timeoutMs = 8000 } = {}) {
  const resolvedHome = home || defaultHome();
  const expectedFingerprint = kind === "ui" ? sidecarFingerprint(__dirname) : undefined;
  const deadline = Date.now() + timeoutMs;
  let data = await readInstance(resolvedHome);
  let spawned = false;
  let upgradedOnce = false;
  for (;;) {
    if (data) {
      try {
        const conn = await tryConnect(data);
        if (expectedFingerprint && !upgradedOnce && data.fingerprint !== expectedFingerprint) {
          upgradedOnce = true;
          const res = await probeAndMaybeUpgrade(conn, data, resolvedHome, kind);
          if (res.upgraded) {
            data = await readInstance(resolvedHome);
            if (!data || data.fingerprint !== expectedFingerprint) {
              data = undefined;
              spawned = false;
            }
            continue;
          }
          return attachReplayBuffer(res.channel, res.replay);
        }
        return wire(conn, data.token, kind);
      } catch {
        data = undefined; // stale instance file — the daemon is gone
      }
    }
    if (!spawned) {
      spawnDaemon(resolvedHome);
      spawned = true;
    }
    if (Date.now() > deadline) throw new Error("pipi daemon did not come up");
    await new Promise((resolve) => setTimeout(resolve, 150));
    data = await readInstance(resolvedHome);
  }
}

function attachReplayBuffer(channel, replay) {
  const origOnLine = channel.onLine;
  channel.onLine = (handler) => {
    for (const msg of replay.splice(0)) {
      try {
        handler(msg);
      } catch {}
    }
    origOnLine(handler);
  };
  return channel;
}

function wire(conn, token, kind) {
  conn.setEncoding("utf8");
  conn.on("error", () => {});
  const buffered = [];
  const channel = {
    conn,
    send(record) {
      if (!conn.destroyed) conn.write(`${JSON.stringify(record)}\n`);
    },
    close() {
      conn.destroy();
    },
    _handlers: [],
    onLine(handler) {
      channel._handlers.push(handler);
      if (buffered.length) {
        const early = buffered.splice(0);
        for (const msg of early) {
          try {
            handler(msg);
          } catch {}
        }
      }
    },
  };
  conn.write(`${JSON.stringify({ type: "hello", token, kind })}\n`);
  let buf = "";
  conn.on("data", (chunk) => {
    buf += chunk;
    let at = buf.indexOf("\n");
    while (at !== -1) {
      const line = buf.slice(0, at).replace(/\r$/, "");
      buf = buf.slice(at + 1);
      at = buf.indexOf("\n");
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (channel._handlers.length === 0) {
        buffered.push(msg);
        continue;
      }
      for (const handler of channel._handlers) {
        try {
          handler(msg);
        } catch {}
      }
    }
  });
  return channel;
}

export function daemonHome(home) {
  return home || defaultHome();
}
