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
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON = path.join(__dirname, "pipi-daemon.mjs");

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
 * Opens the daemon's control channel, starting the daemon detached when the
 * instance file is missing or its ports refuse a connection.
 */
export async function connectDaemon({ home, kind = "ui", timeoutMs = 8000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let data = await readInstance(home);
  let spawned = false;
  for (;;) {
    if (data) {
      try {
        const conn = await tryConnect(data);
        return wire(conn, data.token, kind);
      } catch {
        data = undefined; // stale instance file — the daemon is gone
      }
    }
    if (!spawned) {
      spawnDaemon(home || defaultHome());
      spawned = true;
    }
    if (Date.now() > deadline) throw new Error("pipi daemon did not come up");
    await new Promise((resolve) => setTimeout(resolve, 150));
    data = await readInstance(home);
  }
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
