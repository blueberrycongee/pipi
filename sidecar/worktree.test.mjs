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

function initRepo(root) {
  fs.mkdirSync(root, { recursive: true });
  const git = (args, cwd = root) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git(["init"]);
  fs.writeFileSync(path.join(root, "README.md"), "test\n");
  git(["add", "README.md"]);
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"], { cwd: root });
  return git;
}

test("worktree create reports the primary repository as baseCwd", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-worktree-test-"));
  const repo = path.join(tmp, "repo");
  const git = initRepo(repo);

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
  git(["worktree", "remove", "--force", nested.path], repo);
  git(["worktree", "remove", "--force", out.path], repo);
});

test("a session title like `.nshpkg` or one containing `..` becomes a git-ref-safe branch", (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-worktree-slug-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const repo = path.join(tmp, "repo");
  const git = initRepo(repo);

  const info = JSON.parse(execFileSync(process.execPath, [WORKTREE, "create", repo, ".nshpkg upgrade."], { encoding: "utf8" }));
  assert.match(info.branch, /^pipi\/nshpkg-upgrade-[a-z0-9]+$/);
  assert.equal(info.branch.includes("/."), false, "no branch component starts with a dot");
  git(["check-ref-format", "--branch", info.branch]);
  git(["worktree", "remove", "--force", info.path]);

  const dotted = JSON.parse(execFileSync(process.execPath, [WORKTREE, "create", repo, "release..candidate"], { encoding: "utf8" }));
  assert.match(dotted.branch, /^pipi\/release-candidate-[a-z0-9]+$/);
  assert.equal(dotted.branch.includes(".."), false, "no branch contains consecutive dots");
  git(["check-ref-format", "--branch", dotted.branch]);
  git(["worktree", "remove", "--force", dotted.path]);
});
