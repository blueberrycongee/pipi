import { expect, test } from "nsh/test";
import manifest from "../nsh.json";
import { DIRECT_NODE_COMMANDS, SidecarError, startError } from "./sidecar";

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
