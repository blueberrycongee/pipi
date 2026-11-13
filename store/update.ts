import { signal } from "nsh";
import type { AppUpdate } from "nsh/updater";
import { tr } from "../lib/i18n";
import { backend } from "./backend";
import { toast } from "./app";

/**
 * The app's own auto-update, on nsh's updater (`nsh.json` → `updater.github`
 * points at the public releases; `nsh update-manifest`'s `latest.json` in each
 * release says what is newer). Everything surfaces through `views/UpdateCard.tsx`
 * — a found update shows the card, a failure goes to a toast, like every app
 * error. In development and headless runs the backend reports no update, so
 * this all stays quiet.
 */

export type AppUpdateState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "available"; update: AppUpdate }
  | { phase: "downloading"; update: AppUpdate; received: number; total?: number | null }
  | { phase: "ready"; update: AppUpdate }
  | { phase: "installing"; update: AppUpdate };

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
 * Asks the update source for a newer version. `manual` is the user's own ask
 * (About → Check for Updates): its failure is an error toast and a quiet
 * "up to date" is said; a background check's failure is a warning and its
 * quiet result says nothing.
 */
export async function checkForAppUpdate(manual = false) {
  const check = backend().checkAppUpdate;
  if (!check) {
    if (manual) toast("info", tr("Updates are not available in this build", "此构建不支持自动更新"));
    return;
  }
  if (state().phase === "checking") return;
  if (inFlight()) {
    if (manual) dismissedVersion.set(undefined);
    return;
  }
  // A background check while the card is up only blinks it out and back — the
  // card already says what the last check found.
  if (!manual && state().phase === "available") return;
  state.set({ phase: "checking" });
  try {
    const update = await check();
    if (update) {
      state.set({ phase: "available", update });
      dismissedVersion.set(undefined);
    } else {
      state.set({ phase: "idle" });
      if (manual) toast("success", tr("pipi is up to date", "pipi 已是最新版本"));
    }
  } catch (error) {
    state.set({ phase: "idle" });
    toast(manual ? "error" : "warning", `${tr("Could not check for updates", "无法检查更新")}: ${errorMessage(error)}`);
  }
}

/** Starts the download of a found update; progress lands on the card. */
export async function beginAppUpdate() {
  const download = backend().downloadAppUpdate;
  const s = state();
  if (!download || s.phase !== "available") return;
  const update = s.update;
  state.set({ phase: "downloading", update, received: 0 });
  try {
    await download((progress) => {
      const now = state();
      if (now.phase === "downloading" && now.update.version === update.version) {
        state.set({ ...now, received: progress.received, total: progress.total ?? undefined });
      }
    });
    const now = state();
    if (now.phase === "downloading" && now.update.version === update.version) {
      state.set({ phase: "ready", update });
    }
  } catch (error) {
    if (state().phase === "downloading") state.set({ phase: "available", update });
    toast("error", `${tr("Could not download the update", "无法下载更新")}: ${errorMessage(error)}`);
  }
}

/** Swaps the downloaded build in and relaunches; only a failure returns here. */
export async function installAppUpdate() {
  const install = backend().installAppUpdate;
  const s = state();
  if (!install || s.phase !== "ready") return;
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
  if (!backend().checkAppUpdate) return;
  const t = timers();
  t.delay = setTimeout(() => {
    t.delay = undefined;
    void checkForAppUpdate();
  }, CHECK_DELAY_MS);
  t.interval = setInterval(() => void checkForAppUpdate(), CHECK_INTERVAL_MS);
}
