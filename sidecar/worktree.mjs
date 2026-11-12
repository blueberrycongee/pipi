// Git worktree isolation helper for delegated tasks:
//
//   node sidecar/worktree.mjs status <cwd>
//   node sidecar/worktree.mjs create <cwd> <label>
//   node sidecar/worktree.mjs diff <worktreePath>
//   node sidecar/worktree.mjs remove <cwd> <worktreePath>
import fsp from "node:fs/promises";
import path from "node:path";
import { childEnv, execBinary, resolveBinary } from "./env-paths.mjs";

const gitBin = resolveBinary("git") || "git";

async function git(cwd, args) {
  const { stdout, stderr, code } = await execBinary(gitBin, args, { cwd, env: childEnv(), timeout: 20_000 });
  if (code !== 0) throw new Error(stderr.trim() || `git ${args[0]} exited with ${code}`);
  return stdout.trim();
}

const action = process.argv[2] || "status";
const cwd = path.resolve(process.argv[3] || process.cwd());

try {
  if (action === "status") {
    let inside = false;
    try {
      inside = (await git(cwd, ["rev-parse", "--is-inside-work-tree"])) === "true";
    } catch {
      inside = false;
    }
    if (!inside) {
      process.stdout.write(JSON.stringify({ isGitRepo: false }));
      process.exit(0);
    }
    const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
    const branch = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "HEAD");
    const headCommit = await git(cwd, ["rev-parse", "--short", "HEAD"]).catch(() => "");
    const porcelain = await git(cwd, ["status", "--porcelain"]).catch(() => "");
    const rawList = await git(cwd, ["worktree", "list", "--porcelain"]).catch(() => "");
    const worktrees = [];
    let current = {};
    for (const line of rawList.split("\n")) {
      if (!line.trim()) {
        if (current.path) worktrees.push(current);
        current = {};
        continue;
      }
      if (line.startsWith("worktree ")) current.path = line.slice(9).trim();
      else if (line.startsWith("HEAD ")) current.headCommit = line.slice(5, 13).trim();
      else if (line.startsWith("branch ")) current.branch = line.slice(7).replace(/^refs\/heads\//, "").trim();
    }
    if (current.path) worktrees.push(current);
    process.stdout.write(
      JSON.stringify({
        isGitRepo: true,
        root,
        branch,
        headCommit,
        dirty: porcelain.length > 0,
        worktrees,
      }),
    );
  } else if (action === "create") {
    const label = (process.argv[4] || "agent").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
    const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
    const baseBranch = await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "HEAD");
    const stamp = Date.now().toString(36).slice(-5);
    const branch = `pipi/${label}-${stamp}`;
    const repoName = path.basename(root);
    const baseDir = path.join(path.dirname(root), ".pipi-worktrees", repoName);
    await fsp.mkdir(baseDir, { recursive: true });
    const wtPath = path.join(baseDir, `${label}-${stamp}`);
    await git(root, ["worktree", "add", "-b", branch, wtPath, "HEAD"]);
    const headCommit = await git(wtPath, ["rev-parse", "--short", "HEAD"]).catch(() => "");
    process.stdout.write(
      JSON.stringify({
        path: wtPath,
        branch,
        baseBranch,
        headCommit,
        dirty: false,
      }),
    );
  } else if (action === "diff") {
    const wtPath = path.resolve(process.argv[3] || process.cwd());
    const stat = await git(wtPath, ["status", "--short"]).catch(() => "");
    const diffStat = await git(wtPath, ["diff", "--stat", "HEAD"]).catch(() => "");
    process.stdout.write(
      JSON.stringify({
        dirty: stat.length > 0,
        statusShort: stat,
        diffStat: diffStat || stat,
      }),
    );
  } else if (action === "remove") {
    const wtPath = path.resolve(process.argv[4] || "");
    if (!wtPath) throw new Error("Missing worktree path");
    const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
    await git(root, ["worktree", "remove", "--force", wtPath]);
    process.stdout.write(JSON.stringify({ removed: true, path: wtPath }));
  } else {
    throw new Error(`Unknown worktree action: ${action}`);
  }
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
