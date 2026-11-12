// Wrapper launcher for the user's own Pi (`sidecar/launch-pi.mjs`):
//
//   node sidecar/launch-pi.mjs <json-config>
//
// nsh's `process.spawn` does not accept custom per-child `env` overrides, so this
// lightweight wrapper sets `PIPI_RUNTIME_MODE`, `PIPI_ORCHESTRATOR_URL`,
// `PIPI_ORCHESTRATOR_TOKEN`, and an expanded `PATH` on `process.env`, then runs
// the `pi` binary resolved on that PATH (or `binaryPath` from Settings) with
// `stdio: "inherit"` — the JSONL RPC pipes go straight between pipi and Pi, which
// brings the user's own providers, auth.json, sessions, and extensions along.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { childEnv, resolveBinary, spawnBinary } from "./env-paths.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const piExtension = path.join(__dirname, "pipi-orchestrator-extension.mjs");

const cfg = JSON.parse(process.argv[2] || "{}");

Object.assign(process.env, childEnv());
if (cfg.runtimeMode) process.env.PIPI_RUNTIME_MODE = cfg.runtimeMode;
if (cfg.orchestratorUrl) process.env.PIPI_ORCHESTRATOR_URL = cfg.orchestratorUrl;
if (cfg.orchestratorToken) process.env.PIPI_ORCHESTRATOR_TOKEN = cfg.orchestratorToken;
if (cfg.isSubagent) process.env.PIPI_IS_SUBAGENT = "1";

const piBin = resolveBinary(cfg.binaryPath || "pi");
if (!piBin) {
  process.stderr.write(
    "Pi is not installed: `pi` was not found on PATH. Install it with " +
      "`npm install -g --ignore-scripts @earendil-works/pi-coding-agent`, or set a custom path in Settings → Agents.\n",
  );
  process.exit(1);
}

const args = ["--mode", "rpc"];
if (fs.existsSync(piExtension)) {
  args.push("--extension", piExtension);
}
if (Array.isArray(cfg.extraArgs)) {
  args.push(...cfg.extraArgs);
}

const child = spawnBinary(piBin, args, { stdio: "inherit" });
child.on("error", (error) => {
  process.stderr.write(`Pi could not start (${piBin}): ${error.message}\n`);
  process.exit(1);
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
