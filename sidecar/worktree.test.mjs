// A delegated task checkout names the primary repository it belongs to, so the
// app can file it there instead of listing the temporary worktree as a project.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKTREE = path.join(__dirname, "worktree.mjs");

test("worktree create reports the primary repository as baseCwd", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-worktree-test-"));
  const repo = path.join(tmp, "repo");
  fs.mkdirSync(repo);
  const git = (args, cwd = repo) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git(["init"]);
  fs.writeFileSync(path.join(repo, "README.md"), "test\n");
  git(["add", "README.md"]);
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"], { cwd: repo });

  const out = JSON.parse(execFileSync(process.execPath, [WORKTREE, "create", repo, "task"], { encoding: "utf8" }));
  assert.equal(out.baseCwd, repo);
  assert.equal(fs.realpathSync(out.baseCwd), fs.realpathSync(repo));
  assert.ok(out.path.includes(`${path.sep}.pipi-worktrees${path.sep}`));
  assert.ok(fs.existsSync(out.path));

  // Even when the caller is already inside a linked task checkout, a nested
  // task still belongs to — and is laid out beside — the primary repository.
  const nested = JSON.parse(execFileSync(process.execPath, [WORKTREE, "create", out.path, "nested"], { encoding: "utf8" }));
  assert.equal(nested.baseCwd, repo);
  assert.equal(fs.realpathSync(nested.baseCwd), fs.realpathSync(repo));
  assert.equal(nested.path.split(`${path.sep}.pipi-worktrees${path.sep}`)[0], out.path.split(`${path.sep}.pipi-worktrees${path.sep}`)[0]);
  assert.ok(!nested.path.startsWith(`${out.path}${path.sep}`));
});
