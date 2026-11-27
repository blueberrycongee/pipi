// pipi's delegated-task worktrees live beside the repositories they branch from:
//
//   <projects>/<repo>                           — the real project
//   <projects>/.pipi-worktrees/<repo>/<task>    — a temporary task checkout
//
// The temporary checkout is never a project of its own. These paths are pure
// string arithmetic (no disk probe): the sidebar and preferences need the same
// answer even for a worktree since deleted.
const MARKER = "/.pipi-worktrees/";

/** Whether `cwd` is inside pipi's temporary-worktree area. */
export function isPipiWorktreePath(cwd: string | undefined): boolean {
  return typeof cwd === "string" && cwd.includes(MARKER);
}

/** The real repository a pipi worktree path branched from, when its layout says so. */
export function pipiWorktreeBaseCwd(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  const clean = cwd.replace(/\/+$/, "");
  const at = clean.indexOf(MARKER);
  if (at <= 0) return undefined;
  const rest = clean.slice(at + MARKER.length).split("/").filter(Boolean);
  if (rest.length < 2) return undefined;
  const root = clean.slice(0, at);
  return `${root}/${rest[0]}`;
}

/**
 * The only path allowed into the user-facing project list: a pipi worktree
 * becomes its owning repository; a malformed entry inside the worktree area is
 * dropped rather than shown as a project of its own.
 */
export function projectListPath(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  return pipiWorktreeBaseCwd(cwd) ?? (isPipiWorktreePath(cwd) ? undefined : cwd);
}
