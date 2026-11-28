import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { sidecarFingerprint } from "./daemon-client.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function copySidecarTree(destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const name of fs.readdirSync(__dirname)) {
    if (name.endsWith(".mjs") && !name.endsWith(".test.mjs")) {
      fs.copyFileSync(path.join(__dirname, name), path.join(destination, name));
    }
  }
}

test("sidecarFingerprint changes with the sidecar directory and with its contents", (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-fingerprint-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const one = path.join(tmp, "one");
  const two = path.join(tmp, "two");
  copySidecarTree(one);
  copySidecarTree(two);

  const first = sidecarFingerprint(one);
  assert.notEqual(sidecarFingerprint(two), first, "the same bytes under another directory are another runtime");
  assert.equal(sidecarFingerprint(one), first, "the fingerprint is deterministic");

  fs.appendFileSync(path.join(one, "pipi-daemon.mjs"), "// changed\n");
  assert.notEqual(sidecarFingerprint(one), first, "new sidecar code changes the fingerprint");
});
