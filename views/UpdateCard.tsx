import { cleanup, createAnimatedValue, createMotion, effect, openUrl, reduceMotion, signal, Text, untracked, View } from "nsh";
import { tr } from "../lib/i18n";
import { Pip } from "../mascot/Pip";
import { appUpdate, appUpdateVisible, beginAppUpdate, dismissAppUpdate, installAppUpdate } from "../store/update";
import { Button, IconButton } from "../ui/Button";
import { Icon, type IconName } from "../ui/Icon";
import { EASING, Presence, SPRING } from "../ui/motion";
import { POPUP } from "../ui/styles";

/**
 * The update card, floating bottom-right: an update the checker found lands
 * here — its version and notes, and the whole width of the card's foot is the
 * download's track. Pip rides the fill's leading edge toward the right end,
 * where the card's one action sits as a block parked just over a standing
 * Pip's head: "Update", then a dim "Downloading…" it waits under, then — the
 * download done — Pip's happy jump knocks it awake into "Restart".
 *
 * Errors never show here — they go to a toast, like every app error.
 */

const TRACK_W = 320; // the card is w-80 and the track is its whole foot
const TRACK_H = 6;
const PIP_W = 22;
const PIP_H = (PIP_W * 50) / 64;
const BLOB_W = TRACK_W * 0.3;
/** The block's seat: this far in from the track's right end, hovering a hair
    over Pip's head, so a happy jump's peak — ~310ms in — is the frame they meet. */
const SEAT_INSET = 8;
/** The lead-in at the track's start, so a resting Pip is not kissing the corner. */
const LEAD_INSET = 6;
const BLOCK_BOTTOM = TRACK_H + PIP_H + 2;
const SCENE_H = BLOCK_BOTTOM + 24 + 9;
/** The beat of the jump at which Pip's head tops out and strikes the block. */
const BONK_MS = 310;

const fmtBytes = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`;

function shortNotes(notes: string | null | undefined): string {
  if (!notes) return "";
  const first = notes.replace(/\s+/g, " ").trim();
  return first.length > 140 ? `${first.slice(0, 140).trimEnd()}…` : first;
}

/** One spark of the struck-block burst, popping then gone at its own delay. */
function Spark(props: { x: number; y: number; delay: number; size?: number }) {
  const m = createMotion();
  effect(() => {
    // Under reduceMotion this lands at its last frame — opacity 0, invisible.
    void m.play({
      keyframes: { opacity: [0, 1, 1, 0], scale: [0.2, 1.2, 1, 0.9], translateY: [3, 0, -1, -4] },
      duration: 640,
      delay: props.delay,
      easing: EASING.smoothOut,
    });
  });
  return (
    <View class="pointer-events-none absolute" style={[{ left: props.x, top: props.y }, m.style]}>
      <Icon name="sparkle" size={props.size ?? 12} tone="brand" />
    </View>
  );
}

export function UpdateCard() {
  const enter = createMotion({
    enter: {
      keyframes: { opacity: [0, 1], translateY: [10, 0], scale: [0.97, 1] },
      duration: 220,
      easing: EASING.smoothOut,
    },
  });
  /** The known-total fill, 0..1. */
  const fill = createAnimatedValue(0);
  /** Where Pip stands on the track, in points — driven the way the bar is. */
  const pipPos = createAnimatedValue(LEAD_INSET);
  /** The indeterminate drift, 0..1 ping-ponging while a download's size is unknown. */
  const blob = createAnimatedValue(0);
  let blobRunning = false;
  /** The block's jolt when Pip's head strikes it at the jump's peak: it kicks
      up with a squash, and that frame flips it from its dim seat to "Restart". */
  const bump = createMotion();
  let bumpFired = false;
  /** Flips the block from its dim placeholder to "Restart" on the striking frame. */
  const woke = signal(false);
  let bumpTimer: ReturnType<typeof setTimeout> | undefined;

  /** Where the track's right end puts Pip: tucked under the block's seat. */
  const END_X = TRACK_W - PIP_W - SEAT_INSET;
  /** Pip's ride on the drifting blob: the blob's trailing end, either way it drifts. */
  const TAIL_LO = BLOB_W - PIP_W;
  const TAIL_HI = TRACK_W - PIP_W;
  const blobFillX = blob.mul(TRACK_W - BLOB_W);

  const stopBlob = () => {
    if (!blobRunning) return;
    blobRunning = false;
    void blob.stop();
    void pipPos.stop();
  };

  effect(() => {
    const s = appUpdate();
    const reduced = reduceMotion();
    untracked(() => {
      if (s.phase !== "downloading") {
        stopBlob();
        if (s.phase === "ready" || s.phase === "installing") {
          if (reduced) {
            fill.set(1);
            pipPos.set(END_X);
          } else {
            void fill.spring(1, SPRING.snappy);
            void pipPos.spring(END_X, SPRING.snappy);
          }
        }
        // The block wakes on the frame Pip's head reaches it (~310ms into the
        // 620ms happy jump); under reduceMotion it is simply awake already.
        if (s.phase === "ready") {
          if (reduced) woke.set(true);
          else if (!bumpFired) {
            bumpFired = true;
            bumpTimer = setTimeout(() => {
              woke.set(true);
              void bump.play({
                keyframes: { translateY: [0, -8, 1.5, 0], scale: [1, 1.08, 0.96, 1] },
                duration: 380,
                easing: EASING.smoothOut,
              });
            }, BONK_MS);
          }
        } else {
          bumpFired = false;
          woke.set(false);
        }
        return;
      }
      if (s.total && s.total > 0) {
        stopBlob();
        const frac = Math.min(1, s.received / s.total);
        const x = LEAD_INSET + frac * (END_X - LEAD_INSET);
        if (reduced) {
          fill.set(frac);
          pipPos.set(x);
        } else {
          void fill.spring(frac, SPRING.gentle);
          void pipPos.spring(x, SPRING.gentle);
        }
      } else if (!blobRunning) {
        if (reduced) {
          blob.set(0.5);
          pipPos.set((TAIL_LO + TAIL_HI) / 2);
        } else {
          blobRunning = true;
          void blob.keyframes([0, 1, 0], { duration: 2600, easing: "easeInOut", iterations: "infinite" });
          void pipPos.keyframes([TAIL_LO, TAIL_HI, TAIL_LO], { duration: 2600, easing: "easeInOut", iterations: "infinite" });
        }
      }
    });
  });
  cleanup(() => {
    stopBlob();
    void fill.stop();
    void pipPos.stop();
    if (bumpTimer !== undefined) clearTimeout(bumpTimer);
  });

  const phase = () => appUpdate().phase;
  const update = () => {
    const s = appUpdate();
    return "update" in s ? s.update : undefined;
  };
  const indeterminate = () => {
    const s = appUpdate();
    return s.phase === "downloading" && !(s.total && s.total > 0);
  };

  const title = () => {
    const v = update()?.version ?? "";
    switch (phase()) {
      case "downloading":
        return tr(`Downloading pipi ${v}`, `正在下载 pipi ${v}`);
      case "ready":
        return tr(`pipi ${v} is ready`, `pipi ${v} 已就绪`);
      case "installing":
        return tr(`Restarting pipi ${v}`, `正在重启 pipi ${v}`);
      default:
        return tr(`pipi ${v} is available`, `pipi ${v} 已发布`);
    }
  };

  const subtitle = () => {
    const s = appUpdate();
    if (s.phase === "downloading") {
      if (s.total && s.total > 0) {
        const pct = Math.min(100, Math.round((s.received / s.total) * 100));
        return `${fmtBytes(s.received)} / ${fmtBytes(s.total)} · ${pct}%`;
      }
      return `${fmtBytes(s.received)} · ${tr("downloading…", "下载中…")}`;
    }
    if (s.phase === "ready") return tr("Restart to finish updating", "重启即可完成更新");
    if (s.phase === "installing") return tr("See you in a moment", "稍后见");
    return tr("A new version is out", "新版本可用");
  };

  const mood = () => {
    switch (phase()) {
      case "downloading":
        return "work" as const;
      case "ready":
        return "happy" as const;
      case "installing":
        return "sleep" as const;
      default:
        return "idle" as const;
    }
  };

  const dismissable = () => phase() === "available" || phase() === "ready";

  /**
   * The block's word by phase — one seat over the track's end for all of them,
   * so the card's height never changes through the update.
   */
  const action = (): { label: string; icon?: IconName; disabled?: boolean; run?: () => void } | undefined => {
    const s = appUpdate();
    switch (s.phase) {
      case "available":
        return s.update.canInstall
          ? { label: tr("Update", "更新"), icon: "download", run: () => void beginAppUpdate() }
          : { label: tr("Download", "下载"), icon: "external", run: () => void openUrl(s.update.url) };
      case "downloading":
        return { label: tr("Downloading…", "下载中…"), disabled: true };
      case "ready":
        // Until Pip's jump knocks it awake, the block keeps its dim seat.
        return woke()
          ? { label: tr("Restart", "重启"), icon: "refresh", run: () => void installAppUpdate() }
          : { label: tr("Downloading…", "下载中…"), disabled: true };
      case "installing":
        return { label: tr("Restarting…", "正在重启…"), disabled: true };
      default:
        return undefined;
    }
  };

  return (
    <View class="pointer-events-none absolute bottom-6 right-8">
      <Presence show={appUpdateVisible()} duration={220}>
        <View
          testID="update-card"
          class={`pointer-events-auto w-80 gap-2.5 p-4 pb-0 ${POPUP} overflow-hidden`}
          style={enter.style}
          role="alert"
        >
          {/* Head: the version line, and the ways to put the card off while it may wait. */}
          <View class="flex-row items-start justify-between gap-2">
            <View class="min-w-0 flex-1 gap-0.5">
              <Text class="shrink text-sm font-medium text-foreground">{title()}</Text>
              <Text class="text-xs text-muted-foreground">{subtitle()}</Text>
            </View>
            <If when={dismissable()}>
              <View class="flex-row items-center gap-0.5">
                <Button label={tr("Later", "稍后")} variant="ghost" size="sm" onPress={dismissAppUpdate} />
                <IconButton icon="x" size="sm" label={tr("Dismiss", "关闭")} onPress={dismissAppUpdate} />
              </View>
            </If>
          </View>

          <If when={shortNotes(update()?.notes)}>
            <Text class="text-xs leading-4 text-muted-foreground">{shortNotes(update()?.notes)}</Text>
          </If>

          {/* The stage: the track is the card's whole foot, flush with its bottom
              edge; the block sits over the track's right end and Pip walks it. */}
          <View class="relative -mx-4" style={{ height: SCENE_H }}>
            <View class="absolute inset-x-0 bottom-0 h-1.5 bg-input" />
            <If when={indeterminate()}>
              <View
                class="absolute bottom-0 left-0 h-1.5 rounded-full bg-primary"
                style={{ width: BLOB_W, transform: [{ translateX: blobFillX }] }}
              />
            </If>
            <If when={!indeterminate()}>
              <View
                class="absolute bottom-0 left-0 h-1.5 bg-primary"
                style={{ width: TRACK_W, transformOrigin: "left center", transform: [{ scaleX: fill }] }}
              />
            </If>
            <View
              class="pointer-events-none absolute"
              style={{ bottom: TRACK_H - 1, transform: [{ translateX: pipPos }] }}
            >
              <Pip size={PIP_W} mood={mood()} />
            </View>
            <View class="absolute" style={{ right: SEAT_INSET, bottom: BLOCK_BOTTOM }}>
              <View style={[{ transformOrigin: "center bottom" }, bump.style]}>
                <If when={action()}>
                  <Button
                    label={action()!.label}
                    icon={action()!.icon}
                    disabled={action()!.disabled}
                    variant="primary"
                    size="sm"
                    onPress={() => action()?.run?.()}
                  />
                </If>
              </View>
            </View>
            <If when={woke()}>
              <Spark x={TRACK_W - 26} y={30} delay={0} size={10} />
              <Spark x={TRACK_W - 50} y={0} delay={90} />
              <Spark x={TRACK_W - 86} y={8} delay={180} size={10} />
            </If>
          </View>
        </View>
      </Presence>
    </View>
  );
}
