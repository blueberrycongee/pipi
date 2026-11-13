// The `pipi` command line (`sidecar/pipi-cli.mjs`):
//
//   pipi agents                        list agent harnesses
//   pipi sessions                      list sessions (id, status, title)
//   pipi start --agent claude --title "T" --cwd . "task"   start a session (prints its id)
//   pipi send <id> "message"           message a session (queues while it works)
//   pipi read <id>                     a session's state and last answer
//   pipi stop <id>                     abort its run (and its children's)
//   pipi wait <id>                     block until the session settles; print the answer
//   pipi mcp-config                    print an MCP server config for agents not launched by pipi
//   pipi install                       install `pipi` itself into ~/.local/bin
//
// Every command is one control-channel call against the session daemon
// (`daemon-client.mjs` starts it detached when absent).
import path from "node:path";
import { connectDaemon, daemonHome } from "./daemon-client.mjs";

const argv = process.argv.slice(2);
const homeAt = argv.indexOf("--home");
const home = daemonHome(homeAt >= 0 ? argv[homeAt + 1] : undefined);

const USAGE = `usage:
  pipi agents
  pipi sessions
  pipi start --agent <id> --title <title> [--cwd <dir>] [--worktree] [--mode <mode>] <task>
  pipi send <session> <message>
  pipi read <session>
  pipi stop <session>
  pipi wait <session>
  pipi mcp-config
  pipi install

options:
  --home <dir>   the session daemon's home (the app's daemon is ~/.local/bin/pipi's own)
`;

function flags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--worktree") out.worktree = true;
    else if (arg === "--no-worktree") out.worktree = false;
    else if (arg.startsWith("--")) {
      out[arg.slice(2)] = args[++i];
    } else {
      out._.push(arg);
    }
  }
  return out;
}

let seq = 0;
const pending = new Map();
let channel;

function call(type, payload = {}) {
  const id = `c${++seq}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    channel.send({ id, type, ...payload });
  });
}

const print = (value) => process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
const fail = (error) => {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
  process.exit(1);
};

async function main() {
  const stripped = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--home") i++;
    else stripped.push(argv[i]);
  }
  const [command, ...rest] = stripped;
  const f = flags(rest);
  channel = await connectDaemon({ home, kind: "cli" });
  let ready;
  const readyPromise = new Promise((resolve) => (ready = resolve));
  channel.onLine((msg) => {
    if (msg.type === "hello" && !channel._greeted) {
      channel._greeted = true;
      ready(msg);
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const w = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.type === "error") w.reject(new Error(msg.error));
      else w.resolve(msg);
    }
  });
  channel.conn.on("error", fail);
  await readyPromise;

  switch (command) {
    case "agents": {
      const res = await call("list_agents");
      print(res.agents.map((a) => `${a.id}\t${a.name}\t${a.available === false ? "unavailable" : "ready"}`).join("\n") || "(none)");
      break;
    }
    case "sessions": {
      const res = await call("list");
      print(
        res.sessions
          .map((s) => `${s.id}\t${s.status}${s.unread ? "*" : ""}\t${s.agentName}\t${s.title}${s.parentId ? ` (child of ${s.parentId})` : ""}`)
          .join("\n") || "(none)",
      );
      break;
    }
    case "start": {
      const task = f._.join(" ").trim();
      if (!task) fail(new Error("pipi start needs a task message"));
      const res = await call("start_session", {
        input: {
          title: f.title || task.slice(0, 48),
          agentId: f.agent || "pi",
          cwd: f.cwd ? path.resolve(f.cwd) : process.cwd(),
          message: task,
          worktree: f.worktree === true,
          ...(f.mode ? { runtimeMode: f.mode } : {}),
        },
      });
      print(res.session.id);
      break;
    }
    case "send": {
      const [id, ...words] = f._;
      if (!id || !words.length) fail(new Error("usage: pipi send <session> <message>"));
      await call("send", { sessionId: id, message: words.join(" ") });
      print("sent");
      break;
    }
    case "read": {
      const res = await call("read", { sessionId: f._[0] });
      print(res.session);
      break;
    }
    case "stop": {
      await call("stop", { sessionId: f._[0] });
      print("stopped");
      break;
    }
    case "wait": {
      const res = await call("wait", { sessionId: f._[0] });
      if (res.status !== "idle") print(`status: ${res.status}`);
      print(res.answer ?? "");
      break;
    }
    case "mcp-config": {
      const res = await call("external_token");
      print(
        JSON.stringify(
          {
            mcpServers: {
              pipi: {
                type: "http",
                url: res.url,
                headers: { authorization: `Bearer ${res.token}` },
              },
            },
          },
          null,
          2,
        ),
      );
      break;
    }
    case "install": {
      const res = await call("install_cli");
      print(`installed: ${res.path}`);
      break;
    }
    default:
      process.stdout.write(USAGE);
      process.exit(command ? 1 : 0);
  }
  channel.close();
  process.exit(0);
}

main().catch(fail);
