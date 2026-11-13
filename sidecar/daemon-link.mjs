// App ↔ daemon relay (`sidecar/daemon-link.mjs`):
//
//   node sidecar/daemon-link.mjs --home <dir>
//
// The app spawns this like any other sidecar and gets a NDJSON stdio pipe;
// the link forwards every line to the session daemon's TCP control channel
// and every line back. When the daemon is absent the link starts it detached
// (`daemon-client.mjs`), so the app's one child process is this thin relay —
// close the window and only the link dies; the sessions' owner stays up.
import { connectDaemon, daemonHome } from "./daemon-client.mjs";

const argv = process.argv.slice(2);
const homeAt = argv.indexOf("--home");
const home = daemonHome(homeAt >= 0 ? argv[homeAt + 1] : undefined);

let channel;
try {
  channel = await connectDaemon({ home, kind: "ui" });
} catch (error) {
  process.stderr.write(`daemon-link: ${error instanceof Error ? error.message : error}\n`);
  process.exit(1);
}

process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let at = buf.indexOf("\n");
  while (at !== -1) {
    const line = buf.slice(0, at);
    buf = buf.slice(at + 1);
    at = buf.indexOf("\n");
    if (line.trim()) channel.conn.write(`${line}\n`);
  }
});
process.stdin.on("end", () => channel.close());

channel.onLine((msg) => process.stdout.write(`${JSON.stringify(msg)}\n`));
channel.conn.on("close", () => process.exit(0));
