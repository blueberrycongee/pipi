import { signal } from "nsh";
import { tr } from "../lib/i18n";
import { backend, type Backend } from "./backend";
import { toast } from "./app";

/**
 * The app's own auto-update, on nsh's updater (`nsh.json` → `updater.github`
 * points at the public releases; `nsh update-manifest`'s `latest.json` in each
 * release says what is newer). A release offers two things: a signed package
 * of the app's code — the incremental download, a `.nshpkg` of kilobytes
 * instead of the whole installer — which a shell trusting the package roots
 * runs from its next start, and the full app archives for when the runtime
 * itself must change. The check asks for the package first; a shell too old
 * for it (or a release without one) falls back to the archive. Everything
 * surfaces through `views/UpdateCard.tsx` — a found update shows the card, a
 * failure goes to a toast, like every app error. In development and headless
 * runs the backend reports no update, so this all stays quiet.
 */

/** What a check found, whichever channel offered it. */
export interface FoundUpdate {
  version: string;
  notes?: string | null;
  /** "package": a signed code package, the small incremental download; "app": the whole installer. */
  kind: "package" | "app";
  build?: number;
  /** The download's size, when the manifest says it (packages always carry one). */
  size?: number | null;
  /** Full-app updates: where the user gets it by hand when it cannot install here. */
  url?: string;
  /** Full-app updates: whether `downloadUpdate`/`installAndRestart` work here. */
  canInstall?: boolean;
}

export type AppUpdateState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "available"; update: FoundUpdate }
  | { phase: "downloading"; update: FoundUpdate; received: number; total?: number | null }
  | { phase: "ready"; update: FoundUpdate }
  | { phase: "installing"; update: FoundUpdate };

const state = signal<AppUpdateState>({ phase: "idle" });
/** The card the user closed for this run; a different version found later shows again. */
const dismissedVersion = signal<string | undefined>(undefined);

export const appUpdate = () => state();

/** Whether the update card is on screen: a found update, in flight or ready, not dismissed. */
export const appUpdateVisible = () => {
  const s = state();
  if (s.phase === "available" || s.phase === "downloading" || s.phase === "ready" || s.phase === "installing") {
    return dismissedVersion() !== s.update.version;
  }
  return false;
};

const inFlight = () => {
  const s = state();
  return s.phase === "downloading" || s.phase === "ready" || s.phase === "installing";
};

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * What the update source offers this run, best first: the code package when
 * the shell runs packages and one's newer than the running build, else the
 * app archive — skipping a `shell: true` archive, which means the running
 * code package is already at that version or later and only the outer app
 * shell is behind. A package check that errors falls back to the archive
 * check — but when the archive check finds nothing while the package check
 * failed, the release meant this run to have something it could not fetch:
 * that error is the one to report.
 */
async function findUpdate(b: Backend): Promise<FoundUpdate | null> {
  let packageError: unknown;
  if (b.checkAppPackage) {
    try {
      const pkg = await b.checkAppPackage();
      if (pkg) {
        return { version: pkg.version, notes: pkg.notes, kind: "package", build: pkg.build, size: pkg.size };
      }
    } catch (error) {
      packageError = error;
    }
  }
  const app = b.checkAppUpdate ? await b.checkAppUpdate() : null;
  if (app && !app.shell) {
    return { version: app.version, notes: app.notes, kind: "app", url: app.url, canInstall: app.canInstall };
  }
  if (packageError) throw packageError;
  return null;
}

const sameOffer = (a: FoundUpdate, b: FoundUpdate) => a.version === b.version && a.kind === b.kind && a.build === b.build;

let activeCheck: Promise<void> | undefined;

async function performCheck(b: Backend, manual: boolean, quietFailure = false) {
  const before = state();
  if (inFlight()) {
    if (manual) dismissedVersion.set(undefined);
    return;
  }
  const previous = before.phase === "available" ? before.update : undefined;
  if (manual || !previous) state.set({ phase: "checking" });
  try {
    const update = await findUpdate(b);
    if (update) {
      const changed = !previous || !sameOffer(previous, update);
      state.set({ phase: "available", update });
      if (changed) dismissedVersion.set(undefined);
    } else {
      state.set({ phase: "idle" });
      dismissedVersion.set(undefined);
      if (manual) toast("success", tr("pipi is up to date", "pipi 已是最新版本"));
    }
  } catch (error) {
    state.set(previous ? { phase: "available", update: previous } : { phase: "idle" });
    if (!quietFailure) {
      toast(manual ? "error" : "warning", `${tr("Could not check for updates", "无法检查更新")}: ${errorMessage(error)}`);
    }
  }
}

function requestCheck(b: Backend, manual: boolean, quietFailure = false): Promise<void> {
  if (activeCheck) return activeCheck;
  const tracked = performCheck(b, manual, quietFailure);
  activeCheck = tracked;
  void tracked.then(
    () => {
      if (activeCheck === tracked) activeCheck = undefined;
    },
    () => {
      if (activeCheck === tracked) activeCheck = undefined;
    },
  );
  return tracked;
}

/**
 * Asks the update source for a newer version. `manual` is the user's own ask
 * (About → Check for Updates): its failure is an error toast and a quiet
 * "up to date" is said; a background check's failure is a warning and its
 * quiet result says nothing.
 */
export function checkForAppUpdate(manual = false): Promise<void> {
  const b = backend();
  if (!b.checkAppUpdate && !b.checkAppPackage) {
    if (manual) toast("info", tr("Updates are not available in this build", "此构建不支持自动更新"));
    return Promise.resolve();
  }
  return requestCheck(b, manual);
}

/** Starts the download of a found update; progress lands on the card. */
export async function beginAppUpdate() {
  if (state().phase !== "available") return;
  if (activeCheck) await activeCheck;
  const s = state();
  if (s.phase !== "available") return;
  const original = s.update;
  state.set({ phase: "downloading", update: original, received: 0, total: original.size });

  let update: FoundUpdate;
  try {
    const fresh = await findUpdate(backend());
    if (!fresh) {
      state.set({ phase: "idle" });
      dismissedVersion.set(undefined);
      toast("info", tr("pipi is up to date", "pipi 已是最新版本"));
      return;
    }
    update = fresh;
    state.set({ phase: "downloading", update, received: 0, total: update.size });
  } catch (error) {
    state.set({ phase: "available", update: original });
    toast("error", `${tr("Could not check for updates", "无法检查更新")}: ${errorMessage(error)}`);
    return;
  }

  const download = update.kind === "package" ? backend().downloadAppPackage : backend().downloadAppUpdate;
  if (!download) {
    state.set({ phase: "available", update });
    return;
  }
  try {
    await download((progress) => {
      const now = state();
      if (now.phase === "downloading" && sameOffer(now.update, update)) {
        state.set({ ...now, received: progress.received, total: progress.total ?? now.total });
      }
    });
    const now = state();
    if (now.phase === "downloading" && sameOffer(now.update, update)) {
      state.set({ phase: "ready", update });
    }
  } catch (error) {
    if (state().phase === "downloading") state.set({ phase: "available", update });
    toast("error", `${tr("Could not download the update", "无法下载更新")}: ${errorMessage(error)}`);
    await requestCheck(backend(), false, true);
  }
}

/** Swaps the downloaded build in and relaunches; only a failure returns here. */
export async function installAppUpdate() {
  const s = state();
  if (s.phase !== "ready") return;
  const install = s.update.kind === "package" ? backend().restartToPackage : backend().installAppUpdate;
  if (!install) return;
  state.set({ phase: "installing", update: s.update });
  try {
    await install();
  } catch (error) {
    state.set({ phase: "ready", update: s.update });
    toast("error", `${tr("Could not install the update", "无法安装更新")}: ${errorMessage(error)}`);
  }
}

/** Closes the card; it comes back on the next check that finds something. */
export function dismissAppUpdate() {
  const s = state();
  if (s.phase === "available" || s.phase === "ready") dismissedVersion.set(s.update.version);
}

export function _resetAppUpdateForTests() {
  stopAppUpdateChecks();
  activeCheck = undefined;
  state.set({ phase: "idle" });
  dismissedVersion.set(undefined);
}

// ── Scheduled checks ────────────────────────────────────────────────────────

const CHECK_DELAY_MS = 3500;
const CHECK_INTERVAL_MS = 4 * 3_600_000;
const TIMERS_KEY = "__pipiUpdateTimers";

interface UpdateTimers {
  delay?: ReturnType<typeof setTimeout>;
  interval?: ReturnType<typeof setInterval>;
}

/** The timers, kept on globalThis so a hot-reloaded module cannot double them. */
function timers(): UpdateTimers {
  const g = globalThis as Record<string, unknown>;
  let t = g[TIMERS_KEY] as UpdateTimers | undefined;
  if (!t) {
    t = {};
    g[TIMERS_KEY] = t;
  }
  return t;
}

/** Stops the scheduled checks (boot's own teardown calls this on a hot reload). */
export function stopAppUpdateChecks() {
  const t = timers();
  if (t.delay !== undefined) clearTimeout(t.delay);
  if (t.interval !== undefined) clearInterval(t.interval);
  t.delay = undefined;
  t.interval = undefined;
}

/**
 * Checks for an update shortly after the app is up, then every few hours while
 * it stays open — quietly: only a found update says anything, and that on the
 * card.
 */
export function startAppUpdateChecks() {
  stopAppUpdateChecks();
  if (!backend().checkAppUpdate && !backend().checkAppPackage) return;
  const t = timers();
  t.delay = setTimeout(() => {
    t.delay = undefined;
    void checkForAppUpdate();
  }, CHECK_DELAY_MS);
  t.interval = setInterval(() => void checkForAppUpdate(), CHECK_INTERVAL_MS);
}
