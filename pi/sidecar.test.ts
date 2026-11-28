import fs from "fs/promises";
import os from "os";
import { expect, test } from "nsh/test";
import { BUILTIN_AGENTS } from "../agents/catalog";
import manifest from "../nsh.json";
import { PROVIDERS } from "./providers";
import {
  DIRECT_NODE_COMMANDS,
  SIDECAR_ASSETS,
  SidecarError,
  materializeSidecarFiles,
  sidecarMaterialKey,
  startError,
} from "./sidecar";

// What nsh rejects a launch with, as its macOS host says it (nsh 0.5): the same
// `code` for a command the manifest does not grant and for a folder outside it.
const denied = (permission: string, resource: string, message: string) =>
  Object.assign(new Error(message), { code: "ERR_ACCESS_DENIED", permission, resource });

test("every command started by name is one nsh.json grants", () => {
  const granted: string[] = manifest.capabilities.process.execute;
  for (const command of DIRECT_NODE_COMMANDS) expect(granted).toContain(command);
  // The host shell starts a Node found by its path, and looks for the system-wide ones.
  expect(granted).toContain("sh");
  expect(granted).toContain("cmd");
  // Helpers reach these by bare name too: lookups, dialogs, launchers, permissions.
  for (const helper of ["where", "osascript", "powershell", "pwsh", "zenity", "kdialog", "chmod", "git", "npx", "uvx", "uv", "bun"]) {
    expect(granted).toContain(helper);
  }
});

test("a variable an agent or provider reads is one nsh.json passes on", () => {
  const env: string[] = manifest.capabilities.process.env;
  for (const agent of BUILTIN_AGENTS) {
    if (agent.envVar) expect(env).toContain(agent.envVar);
  }
  for (const provider of PROVIDERS) {
    expect(env).toContain(provider.env);
  }
});

test("a folder outside the home directory is said as the folder", () => {
  const error = startError(denied("fs", "/usr", "cwd `/usr`: filesystem write is not granted by capabilities.fs"), "Pi");
  expect(error instanceof SidecarError).toBe(true);
  expect(error.message).toBe("This folder is outside what pipi may open");
  expect(error.hint).toBe("pipi can work in folders under your home directory.");
});

test("a command the manifest does not grant is not blamed on the folder", () => {
  const refusal = "`/opt/homebrew/bin/node` is not granted by capabilities.process.execute";
  const error = startError(denied("process", "/opt/homebrew/bin/node", refusal), "Pi");
  expect(error.message).toBe("Pi could not start");
  expect(error.hint).toBe(refusal);
});

test("any other failure names the agent, and a reason already put in words passes through", () => {
  const error = startError(Object.assign(new Error("spawn failed"), { code: "EACCES" }), "claude");
  expect(error.message).toBe("claude could not start");
  expect(error.hint).toBe("spawn failed");
  const said = new SidecarError("Node.js was not found", "pipi requires Node.js 22.19 or newer installed on this machine.");
  expect(startError(said, "Pi")).toBe(said);
});

const ascii = (text: string) => new Uint8Array(Array.from(text, (ch) => ch.charCodeAt(0)));
const tmpdir = (name: string) => `${os.homedir().replace(/[\\/]+$/, "")}/.pipi-sidecar-${name}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

async function removeTree(path: string) {
  const stat = await fs.stat(path).catch(() => undefined);
  if (!stat) return;
  if (!stat.isDirectory()) {
    await fs.unlink(path).catch(() => undefined);
    return;
  }
  for (const name of await fs.readdir(path).catch(() => [] as string[])) await removeTree(`${path}/${name}`);
  await fs.rmdir(path).catch(() => undefined);
}

test("materialized sidecar trees are content-keyed, complete, reusable and race-safe", async () => {
  const dataDir = tmpdir("materialize");
  try {
    const files = [
      { name: "one.mjs", bytes: ascii("one") },
      { name: "two.mjs", bytes: ascii("two") },
    ];
    const key = sidecarMaterialKey("0.2.39", 24, files);
    expect(key).not.toBe(sidecarMaterialKey("0.2.39", 24, [{ ...files[0], bytes: ascii("changed") }, files[1]]));
    const [first, second] = await Promise.all([
      materializeSidecarFiles(dataDir, key, files),
      materializeSidecarFiles(dataDir, key, files),
    ]);
    expect(second).toBe(first);
    expect(first).toBe(`${dataDir}/sidecar/ota-${key}`);
    expect(await fs.readFile(`${first}/one.mjs`, "utf8")).toBe("one");
    expect(await fs.readFile(`${first}/.complete`, "utf8")).toBe(`${key}\n`);
    const names = await fs.readdir(`${dataDir}/sidecar`);
    expect(names.filter((name) => name.startsWith(".ota-"))).toEqual([]);
  } finally {
    await removeTree(dataDir);
  }
});

test("cache cleanup never removes the sidecar tree the live daemon is executing", async () => {
  const dataDir = tmpdir("cleanup");
  try {
    const live = `${dataDir}/sidecar/ota-live`;
    await fs.mkdir(live, { recursive: true });
    await fs.writeFile(`${live}/one.mjs`, "live");
    await fs.mkdir(`${dataDir}/daemon`, { recursive: true });
    await fs.writeFile(`${dataDir}/daemon/daemon.json`, JSON.stringify({ sidecarDir: live }));
    for (let index = 0; index < 10; index += 1) await fs.mkdir(`${dataDir}/sidecar/ota-old-${index}`, { recursive: true });
    const files = [{ name: "one.mjs", bytes: ascii("new") }];
    await materializeSidecarFiles(dataDir, sidecarMaterialKey("0.2.40", 25, files), files);
    expect(await fs.exists(`${live}/one.mjs`)).toBe(true);
  } finally {
    await removeTree(dataDir);
  }
});

test("the sidecar asset manifest maps each helper to its own bundled asset URL", () => {
  for (const [name, url] of Object.entries(SIDECAR_ASSETS)) expect(url).toBe(`asset:/sidecar/${name}`);
  for (const name of [
    "daemon-link.mjs",
    "daemon-client.mjs",
    "pipi-daemon.mjs",
    "external-agent.mjs",
    "launch-pi.mjs",
    "message-edits.mjs",
    "env-paths.mjs",
    "pipi-orchestrator-extension.mjs",
    "pipi-mcp-stdio.mjs",
    "worktree.mjs",
  ]) {
    expect(Object.keys(SIDECAR_ASSETS)).toContain(name);
  }
});
