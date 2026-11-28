import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("every runtime sidecar helper is registered for OTA materialization", () => {
  const runtimeHelpers = fs
    .readdirSync(__dirname)
    .filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs"))
    .sort();
  const source = fs.readFileSync(path.join(__dirname, "../pi/sidecar.ts"), "utf8");
  const registered = [...source.matchAll(/^  "([^"]+\.mjs)": \w+,$/gm)].map((match) => match[1]).sort();
  assert.deepEqual(registered, runtimeHelpers);
  for (const name of runtimeHelpers) {
    assert.match(source, new RegExp(`\\.\\./sidecar/${name.replaceAll(".", "\\.")}\\?url`), `${name} is imported as a bundled asset`);
  }
});
