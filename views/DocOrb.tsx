import {
  Animated,
  batch,
  Canvas,
  cleanup,
  Clipboard,
  colorScheme,
  computed,
  createAnimatedValue,
  effect,
  keymap,
  platform,
  reduceMotion,
  Scroll,
  signal,
  Text,
  token,
  untracked,
  View,
  type CompositeAnimation,
  type InputRef,
  type ScrollRef,
} from "nsh";
import { Button as BaseButton, Command, type CommandItem, Input, Popover } from "nsh/base";
import { runtimeModeRank } from "../agents/catalog";
import type { RuntimeMode } from "../agents/types";
import { splitDocMessage } from "../lib/doc-wire";
import { activeLanguage, formatAgentMeta, runtimeModeIcon, runtimeModeText, thinkingText, tr } from "../lib/i18n";
import { topBarHeight } from "../lib/layout";
import { Pip } from "../mascot/Pip";
import type { ExtensionUiAnswer, ExtensionUiDialog, Model } from "../pi/protocol";
import { providerName } from "../pi/providers";
import type { Row, ToolRow } from "../pi/transcript";
import { describeToolCall, elapsedSeconds, reasoningPreview } from "../pi/turns";
import { availableAgents, currentRuntimeCeiling, showAgentSettings } from "../store/app";
import { backend } from "../store/backend";
import { ensureDocAssistant, type DocAssistant, type DocSelection } from "../store/doc-assistant";
import { applyDocEdit, undoDoc, type DocUpdateEvent, type MarkdownDoc } from "../store/docs";
import { AgentLogo } from "../ui/AgentLogo";
import { Chip, IconButton } from "../ui/Button";
import { Icon } from "../ui/Icon";
import {
  BREATH_MS,
  delayedFade,
  DURATION,
  EASING,
  keepLast,
  LayerActive,
  popupHiddenStyle,
  popupLeavingStyle,
  popupStyle,
  Presence,
  Reveal,
  useBreathingOpacity,
} from "../ui/motion";
import { RollingText } from "../ui/RollingText";
import { FOCUS_RING, GLASS_REGULAR, POPUP, PRESS, PRESS_SCALE } from "../ui/styles";
import { tip } from "../ui/Tip";
import { uiHeight, uiMinHeight, uiRowHeight, uiType } from "../ui/typography";
import { ProseBlock, proseRows } from "./Prose";

const ORB_SIZE = 46;
const ORB_RIGHT_INSET = 20;
const BAR_MIN_W = 360;
const BAR_MAX_W = 500;
const INPUT_MIN_H = 24;
const INPUT_MAX_H = 112;
const TOOLBAR_H = 46;
const INPUT_ROW_PAD_V = 14;
const SELECTION_ROW_EXTRA_H = 26;
const LEAVE_GRACE_MS = 280;
const HOVER_EDGE_PAD = 6;
const UPDATE_PILL_TTL_MS = 5500;
const UPDATE_PILL_LINGER_MS = 1400;

const RUNTIME_MODES: readonly RuntimeMode[] = ["approval-required", "auto-accept-edits", "full-access"];
const modelKey = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;

type OrbPickerId = "agent" | "model" | "thinking" | "permission";

/** Critically damped spring physics for the orb ↔ mini-composer 2D bloom (velocity-preserving, zero bounce). */
const MORPH_STIFFNESS = 420;
const MORPH_DAMPING = 38;
const MORPH_MASS = 0.88;

/** Liquid Glass capsule surface matching `COMPOSER_SURFACE`, using `transition-colors` so native transitions never fight the JS width spring. */
const ORB_SURFACE =
  "border-[0.5px] border-hairline bg-card/65 shadow-composer transition-colors duration-200 ease-out-quint hover:border-hairline-hover focus-within:border-hairline-focus focus-within:bg-card/78 focus-within:shadow-composer-focus dark:bg-card/58 dark:shadow-composer-dark dark:hover:border-hairline-hover dark:focus-within:border-hairline-focus dark:focus-within:bg-card/72 dark:focus-within:shadow-composer-dark-focus motion-reduce:transition-none";

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Lightweight pane-level pointer bridge connecting `DocEditor` to `DocFloatingOrb`.
 * On macOS AppKit, hovering or mounting the native multiline `<Input>` inside the
 * morphing capsule fires a spurious `onMouseLeave` on its direct `<View>` wrapper
 * while the enclosing pane continues receiving accurate `onMouseMove` / `onMouseLeave`.
 */
export interface DocOrbPointerBridge {
  onPaneMove: (e: { position: { x: number; y: number }; pressedButton?: unknown }) => void;
  onPaneLeave: () => void;
  setDraggingSelection: (dragging: boolean) => void;
  bind: (handlers: {
    onMove: (x: number, y: number, pressed: boolean) => void;
    onLeave: () => void;
    onDragChange: (dragging: boolean) => void;
  }) => () => void;
}

export function createDocOrbPointerBridge(): DocOrbPointerBridge {
  let listener:
    | { onMove: (x: number, y: number, pressed: boolean) => void; onLeave: () => void; onDragChange: (dragging: boolean) => void }
    | undefined;
  return {
    onPaneMove(e) {
      listener?.onMove(e.position.x, e.position.y, e.pressedButton != null);
    },
    onPaneLeave() {
      listener?.onLeave();
    },
    setDraggingSelection(dragging) {
      listener?.onDragChange(dragging);
    },
    bind(handlers) {
      listener = handlers;
      return () => {
        if (listener === handlers) listener = undefined;
      };
    },
  };
}

/** Smooth staggered breathing bar for skeletons (compositor-driven, honors reduceMotion). */
function ShimmerBar(props: { width: `${number}%` | number; height?: number; delay?: number; class?: string }) {
  const opacity = createAnimatedValue(0.65);
  let anim: CompositeAnimation | null = null;

  effect(() => {
    const reduced = reduceMotion();
    untracked(() => {
      anim?.stop();
      anim = null;
      if (reduced) {
        opacity.set(0.55);
        return;
      }
      opacity.set(0.35);
      anim = Animated.keyframes(opacity, {
        keyframes: [
          { offset: 0, value: 0.35, easing: "easeInOut" },
          { offset: 0.5, value: 0.85, easing: "easeInOut" },
          { offset: 1, value: 0.35 },
        ],
        duration: BREATH_MS,
        delay: props.delay ?? 0,
        iterations: "infinite",
      });
      void anim.start();
    });
  });
  cleanup(() => {
    anim?.stop();
    void opacity.stop();
  });

  return (
    <View
      class={`rounded-full bg-foreground/[0.08] dark:bg-foreground/[0.10] ${props.class ?? ""}`}
      style={{ width: props.width, height: props.height ?? 10, opacity }}
    />
  );
}

/**
 * Smart delayed document skeleton: never flashes for fast local disk reads (<180ms),
 * and softly breathes in with matching 720pt reading-column proportions if a large
 * or remote file takes longer to load.
 */
export function DocSkeleton(props: { show: () => boolean }) {
  const opacity = delayedFade(180, 260);
  cleanup(() => void opacity.stop());
  return (
    <If when={props.show()}>
      <View
        testID="doc-skeleton"
        class="pointer-events-none absolute inset-0"
        style={{ opacity, paddingTop: topBarHeight() + 34 }}
      >
        <View class="mx-auto w-full max-w-180 gap-4 px-10">
          <ShimmerBar width="42%" height={22} delay={0} class="rounded-lg corner-squircle" />
          <View class="mt-2 gap-2.5">
            <ShimmerBar width="94%" height={11} delay={80} />
            <ShimmerBar width="86%" height={11} delay={160} />
            <ShimmerBar width="64%" height={11} delay={240} />
          </View>
          <ShimmerBar width="28%" height={16} delay={180} class="mt-4 rounded-md corner-squircle" />
          <View class="gap-2.5">
            <ShimmerBar width="90%" height={11} delay={240} />
            <ShimmerBar width="78%" height={11} delay={320} />
            <ShimmerBar width="52%" height={11} delay={400} />
          </View>
        </View>
      </View>
    </If>
  );
}

/** Soft cobalt linear wash matching the active theme token. */
function brandLinearWash(direction: string, peakAlpha: number, midStop = false): string {
  colorScheme();
  let hex = String(token("brand")).trim();
  if (hex.length === 4 && hex.startsWith("#")) {
    hex = `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
  }
  const base = hex.slice(0, 7);
  const a = (alpha: number) =>
    Math.round(Math.max(0, Math.min(1, alpha)) * 255)
      .toString(16)
      .padStart(2, "0");
  if (midStop) {
    return `linear-gradient(${direction}, ${base}00 0%, ${base}${a(peakAlpha)} 50%, ${base}00 100%)`;
  }
  return `linear-gradient(${direction}, ${base}${a(peakAlpha)} 0%, ${base}${a(peakAlpha * 0.35)} 45%, ${base}00 100%)`;
}

/** Descending cobalt refresh-curtain gradient with a luminous leading edge and soft glow halo below it. */
function brandRefreshBeamWash(): string {
  const dark = colorScheme() === "dark";
  let hex = String(token("brand")).trim();
  if (hex.length === 4 && hex.startsWith("#")) {
    hex = `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
  }
  const base = hex.slice(0, 7);
  const a = (alpha: number) =>
    Math.round(Math.max(0, Math.min(1, alpha)) * 255)
      .toString(16)
      .padStart(2, "0");
  const tail = dark ? 0.08 : 0.05;
  const mid = dark ? 0.18 : 0.12;
  const crest = dark ? 0.30 : 0.20;
  const halo = dark ? 0.12 : 0.08;
  return `linear-gradient(to bottom, ${base}00 0%, ${base}${a(tail)} 28%, ${base}${a(mid)} 66%, ${base}${a(crest)} 84%, ${base}${a(halo)} 92%, ${base}00 100%)`;
}

/**
 * Quiet breathing page skeleton shown inside an empty writable document while
 * the inline assistant is actively drafting into it. Delayed 180ms so fast
 * replies never blink, and fades out smoothly the instant fresh content lands.
 */
export function DocDraftingSkeleton(props: { show: () => boolean; hasContent?: () => boolean }) {
  const mounted = signal(false);
  const backdropOpacity = createAnimatedValue(0);
  const barsOpacity = createAnimatedValue(0);
  let delayTimer: ReturnType<typeof setTimeout> | undefined;
  let exitTimer: ReturnType<typeof setTimeout> | undefined;
  let seq = 0;

  effect(() => {
    const on = props.show();
    const reduced = reduceMotion();
    untracked(() => {
      const mine = ++seq;
      clearTimeout(delayTimer);
      clearTimeout(exitTimer);
      void backdropOpacity.stop();
      void barsOpacity.stop();
      if (on) {
        delayTimer = setTimeout(() => {
          if (seq !== mine || !untracked(props.show)) return;
          if (reduced) {
            batch(() => {
              backdropOpacity.set(1);
              barsOpacity.set(1);
              mounted.set(true);
            });
            return;
          }
          if (!mounted()) {
            batch(() => {
              backdropOpacity.set(0);
              barsOpacity.set(0);
              mounted.set(true);
            });
          }
          void backdropOpacity.timing(1, { duration: 240, easing: EASING.entrance });
          void barsOpacity.timing(1, { duration: 240, easing: EASING.entrance });
        }, 180);
      } else if (mounted()) {
        if (reduced) {
          backdropOpacity.set(0);
          barsOpacity.set(0);
          mounted.set(false);
        } else if (props.hasContent?.()) {
          // Content just landed: drop skeleton bars immediately so they never
          // double-expose over fresh headings, and dissolve the page veil cleanly.
          barsOpacity.set(0);
          backdropOpacity.set(0.68);
          void backdropOpacity.timing(0, { duration: 150, easing: EASING.exit });
          exitTimer = setTimeout(() => {
            if (seq === mine) mounted.set(false);
          }, 160);
        } else {
          void backdropOpacity.timing(0, { duration: 170, easing: EASING.exit });
          void barsOpacity.timing(0, { duration: 170, easing: EASING.exit });
          exitTimer = setTimeout(() => {
            if (seq === mine) mounted.set(false);
          }, 180);
        }
      }
    });
  });

  cleanup(() => {
    clearTimeout(delayTimer);
    clearTimeout(exitTimer);
    void backdropOpacity.stop();
    void barsOpacity.stop();
  });

  return (
    <If when={mounted()}>
      <View
        testID="doc-drafting-skeleton"
        class="pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-background"
        style={{ top: topBarHeight(), opacity: backdropOpacity, paddingTop: 52 }}
      >
        <View class="mx-auto w-full max-w-180 gap-4 px-10" style={{ opacity: barsOpacity }}>
          <ShimmerBar width="38%" height={24} delay={0} class="rounded-lg corner-squircle bg-brand/[0.11] dark:bg-brand/[0.16]" />
          <View class="mt-2 gap-2.5">
            <ShimmerBar width="92%" height={11} delay={80} />
            <ShimmerBar width="84%" height={11} delay={160} />
            <ShimmerBar width="60%" height={11} delay={240} />
          </View>
          <ShimmerBar width="26%" height={16} delay={180} class="mt-4 rounded-md corner-squircle bg-brand/[0.09] dark:bg-brand/[0.14]" />
          <View class="gap-2.5">
            <ShimmerBar width="88%" height={11} delay={260} />
            <ShimmerBar width="74%" height={11} delay={340} />
            <ShimmerBar width="48%" height={11} delay={420} />
          </View>
        </View>
      </View>
    </If>
  );
}

const REFRESH_BEAM_H = 220;
const REFRESH_SWEEP_MS = 760;

/**
 * Tactile page-refresh choreography whenever the open document updates from an
 * AI edit or disk sync: a brief translucent ink-settle veil swept cleanly
 * top-to-bottom by a luminous cobalt shimmer curtain and hairline crest over
 * the 720pt reading column. Purely compositor-driven (`opacity` + `translateY`),
 * zero layout shift, and skipped cleanly under reduced motion.
 */
export function DocRefreshSweep(props: { doc: MarkdownDoc }) {
  const active = signal(false);
  const paneH = signal(720);
  const veilOpacity = createAnimatedValue(0);
  const beamOpacity = createAnimatedValue(0);
  const beamY = createAnimatedValue(-REFRESH_BEAM_H);
  let lastSeq = untracked(() => props.doc.updateSeq());
  let doneTimer: ReturnType<typeof setTimeout> | undefined;
  let seq = 0;

  effect(() => {
    const updateSeq = props.doc.updateSeq();
    const reduced = reduceMotion();
    if (updateSeq <= lastSeq) return;
    lastSeq = updateSeq;
    untracked(() => {
      const mine = ++seq;
      clearTimeout(doneTimer);
      void veilOpacity.stop();
      void beamOpacity.stop();
      void beamY.stop();
      if (reduced) {
        active.set(false);
        return;
      }
      const h = Math.max(360, paneH());
      const startY = topBarHeight() - REFRESH_BEAM_H * 0.78;
      batch(() => {
        veilOpacity.set(0);
        beamOpacity.set(0);
        beamY.set(startY);
        active.set(true);
      });
      void veilOpacity.keyframes([0, 0.34, 0], { duration: 460, easing: EASING.entrance });
      void beamOpacity.keyframes([0, 1, 1, 0.9, 0], { duration: REFRESH_SWEEP_MS, easing: "linear" });
      void beamY.timing(h + 24, { duration: REFRESH_SWEEP_MS, easing: "easeInOut" });
      doneTimer = setTimeout(() => {
        if (seq === mine) active.set(false);
      }, REFRESH_SWEEP_MS + 40);
    });
  });

  cleanup(() => {
    clearTimeout(doneTimer);
    void veilOpacity.stop();
    void beamOpacity.stop();
    void beamY.stop();
  });

  return (
    <View
      onLayout={(e) => {
        const h = Math.round(e.bounds.size.height);
        if (h > 0 && Math.abs(h - untracked(paneH)) > 16) paneH.set(h);
      }}
      class="pointer-events-none absolute inset-0 z-10 overflow-hidden"
    >
      <If when={active()}>
        <View testID="doc-refresh-sweep" class="pointer-events-none absolute inset-0 overflow-hidden">
          {/* Crisp refresh veil settling fresh text smoothly into full contrast without blanking */}
          <View class="pointer-events-none absolute inset-0 bg-background" style={{ opacity: veilOpacity }} />

          {/* Luminous cobalt shimmer curtain + razor-clean leading crest gliding steadily top-to-bottom */}
          <View
            class="pointer-events-none absolute inset-x-0 top-0"
            style={{
              height: REFRESH_BEAM_H,
              opacity: beamOpacity,
              transform: [{ translateY: beamY }],
              backgroundImage: brandRefreshBeamWash(),
            }}
          >
            <View class="mx-auto h-full w-full max-w-180 justify-end px-10 pb-8">
              <View
                class="h-[2px] w-full rounded-full"
                style={{
                  backgroundImage: brandLinearWash("90deg", colorScheme() === "dark" ? 0.88 : 0.72, true),
                }}
              />
            </View>
          </View>
        </View>
      </If>
    </View>
  );
}

/**
 * Ultra-subtle 2px live activity ribbon under the title bar while an agent is
 * actively working on this document. Fades smoothly in/out; honors reduceMotion.
 */
export function DocActivityRibbon(props: { active: () => boolean }) {
  const initially = untracked(props.active);
  const mounted = signal(initially);
  const containerOpacity = createAnimatedValue(initially ? 1 : 0);
  const sweepX = createAnimatedValue(-180);
  const paneW = signal(720);
  let sweepAnim: CompositeAnimation | null = null;
  let exitTimer: ReturnType<typeof setTimeout> | undefined;
  let seq = 0;

  const startSweep = (w: number) => {
    sweepAnim?.stop();
    sweepAnim = null;
    if (untracked(reduceMotion)) {
      sweepX.set(0);
      return;
    }
    const barW = Math.max(160, Math.round(w * 0.36));
    sweepX.set(-barW);
    sweepAnim = Animated.keyframes(sweepX, {
      keyframes: [
        { offset: 0, value: -barW, easing: "easeInOut" },
        { offset: 1, value: w + 40 },
      ],
      duration: BREATH_MS,
      iterations: "infinite",
    });
    void sweepAnim.start();
  };

  effect(() => {
    const on = props.active();
    const w = paneW();
    const reduced = reduceMotion();
    untracked(() => {
      const mine = ++seq;
      clearTimeout(exitTimer);
      void containerOpacity.stop();
      if (on) {
        mounted.set(true);
        if (reduced) {
          containerOpacity.set(0.7);
          sweepAnim?.stop();
          sweepAnim = null;
        } else {
          void containerOpacity.timing(1, { duration: 220, easing: EASING.entrance });
          startSweep(w);
        }
      } else if (mounted()) {
        if (reduced) {
          containerOpacity.set(0);
          mounted.set(false);
        } else {
          void containerOpacity.timing(0, { duration: 260, easing: EASING.exit });
          exitTimer = setTimeout(() => {
            if (seq === mine) {
              sweepAnim?.stop();
              sweepAnim = null;
              mounted.set(false);
            }
          }, 270);
        }
      }
    });
  });

  cleanup(() => {
    clearTimeout(exitTimer);
    sweepAnim?.stop();
    void containerOpacity.stop();
    void sweepX.stop();
  });

  return (
    <If when={mounted()}>
      <View
        onLayout={(e) => {
          const nextW = Math.round(e.bounds.size.width);
          if (nextW > 0 && Math.abs(nextW - untracked(paneW)) > 12) paneW.set(nextW);
        }}
        class="pointer-events-none absolute inset-x-0 z-20 h-[2px] overflow-hidden"
        style={{ top: topBarHeight(), opacity: containerOpacity }}
      >
        <If
          when={!reduceMotion()}
          else={<View class="h-full w-full bg-brand/35" />}
        >
          <View
            class="h-full"
            style={{
              width: Math.max(160, Math.round(paneW() * 0.36)),
              backgroundImage: brandLinearWash("90deg", 0.72, true),
              transform: [{ translateX: sweepX }],
            }}
          />
        </If>
      </View>
    </If>
  );
}

/**
 * Floating "Document Updated · Undo" pill whenever the document updates from
 * disk or from an applied AI reply.
 */
export function DocUpdatePill(props: { doc: MarkdownDoc }) {
  const current = () => props.doc.lastUpdate();
  const shown = keepLast<DocUpdateEvent>(current);
  const mounted = signal(Boolean(untracked(current)));
  const opacity = createAnimatedValue(untracked(current) ? 1 : 0);
  const translateY = createAnimatedValue(untracked(current) ? 0 : -8);
  const scale = createAnimatedValue(untracked(current) ? 1 : 0.96);

  let exitTimer: ReturnType<typeof setTimeout> | undefined;
  let autoTimer: ReturnType<typeof setTimeout> | undefined;
  let hovered = false;
  let lastSeenId = untracked(current)?.id ?? 0;
  let seq = 0;

  const scheduleAutoDismiss = (ms: number) => {
    clearTimeout(autoTimer);
    if (hovered) return;
    autoTimer = setTimeout(() => {
      autoTimer = undefined;
      props.doc.dismissUpdate();
    }, ms);
  };

  effect(() => {
    const ev = current();
    const reduced = reduceMotion();
    untracked(() => {
      const mine = ++seq;
      clearTimeout(exitTimer);
      clearTimeout(autoTimer);
      if (ev) {
        const isFresh = ev.id !== lastSeenId;
        lastSeenId = ev.id;
        void opacity.stop();
        void translateY.stop();
        void scale.stop();
        if (reduced) {
          batch(() => {
            opacity.set(1);
            translateY.set(0);
            scale.set(1);
            mounted.set(true);
          });
        } else {
          if (!mounted()) {
            batch(() => {
              opacity.set(0);
              translateY.set(-8);
              scale.set(0.96);
              mounted.set(true);
            });
          } else if (isFresh) {
            scale.set(0.97);
          }
          void opacity.timing(1, { duration: DURATION.fast, easing: EASING.entrance });
          void translateY.timing(0, { duration: 210, easing: EASING.signature });
          void scale.timing(1, { duration: 210, easing: EASING.signature });
        }
        scheduleAutoDismiss(UPDATE_PILL_TTL_MS);
      } else if (mounted()) {
        if (reduced) {
          opacity.set(0);
          mounted.set(false);
        } else {
          void opacity.stop();
          void translateY.stop();
          void scale.stop();
          void opacity.timing(0, { duration: 140, easing: EASING.exit });
          void translateY.timing(-6, { duration: 140, easing: EASING.exit });
          void scale.timing(0.97, { duration: 140, easing: EASING.exit });
          exitTimer = setTimeout(() => {
            if (seq === mine) mounted.set(false);
          }, 145);
        }
      }
    });
  });

  cleanup(() => {
    clearTimeout(exitTimer);
    clearTimeout(autoTimer);
    void opacity.stop();
    void translateY.stop();
    void scale.stop();
  });

  const label = () => {
    const ev = shown();
    if (!ev) return "";
    const base =
      ev.source === "replace"
        ? tr("Replaced selection", "已替换选中内容")
        : ev.source === "insert"
          ? tr("Inserted into document", "已插入文档")
          : ev.source === "append"
            ? tr("Appended to document", "已追加到末尾")
            : tr("Document updated", "文档已更新");
    if (ev.deltaWords === 0) return base;
    const sign = ev.deltaWords > 0 ? "+" : "";
    const unit = tr(Math.abs(ev.deltaWords) === 1 ? "word" : "words", "字");
    return `${base} · ${sign}${ev.deltaWords} ${unit}`;
  };

  return (
    <If when={mounted()}>
      <View
        class="absolute inset-x-0 z-20"
        style={{ top: topBarHeight() + 10, pointerEvents: "box-none" }}
      >
        <View class="mx-auto w-full max-w-180 items-start px-10" style={{ pointerEvents: "box-none" }}>
          <View
            testID="doc-update-pill"
            onMouseEnter={() => {
              hovered = true;
              clearTimeout(autoTimer);
            }}
            onMouseLeave={() => {
              hovered = false;
              if (untracked(current)) scheduleAutoDismiss(UPDATE_PILL_LINGER_MS);
            }}
            class={`${uiHeight(32)} flex-row items-center gap-2 rounded-full border-[0.5px] border-hairline bg-popover/85 pl-3 pr-1.5 shadow-popover dark:bg-popover/80 ${current() ? "" : "pointer-events-none"}`}
            style={{
              ...GLASS_REGULAR,
              opacity,
              transform: [{ translateY }, { scale }],
            }}
          >
            <Icon name="sparkle" size={13} tone="brand-text" class="shrink-0" />
            <Text class={`${uiType("xs")} font-medium tabular-nums text-foreground`}>{label()}</Text>
            <If when={!props.doc.readOnly()}>
              <View class="h-3.5 w-px bg-border" />
              <BaseButton
                testID="doc-update-undo"
                onPress={() => void undoDoc(props.doc.path)}
                tooltip={tip(tr("Undo update", "撤销更新"), "mod+z", "bottom")}
                class={`${uiHeight(24)} flex-row items-center rounded-full px-2 ${PRESS} ${PRESS_SCALE} ${FOCUS_RING} hover:bg-accent`}
              >
                <Text class={`${uiType("xs")} font-medium text-brand-text`}>{tr("Undo", "撤销")}</Text>
              </BaseButton>
            </If>
            <BaseButton
              testID="doc-update-dismiss"
              onPress={() => props.doc.dismissUpdate()}
              accessibilityLabel={tr("Dismiss", "关闭")}
              class={`size-5 items-center justify-center rounded-full ${PRESS} ${FOCUS_RING} hover:bg-accent`}
            >
              <Icon name="x" size={11} tone="subtle" />
            </BaseButton>
          </View>
        </View>
      </View>
    </If>
  );
}

/** Crisp rotating cobalt arc drawn around the resting orb while the AI is working in the background. */
function OrbHalo(props: { active: () => boolean }) {
  const angle = createAnimatedValue(0);
  let spin: CompositeAnimation | null = null;

  effect(() => {
    const on = props.active();
    const reduced = reduceMotion();
    untracked(() => {
      spin?.stop();
      spin = null;
      if (!on || reduced) {
        angle.set(0);
        return;
      }
      angle.set(0);
      spin = Animated.keyframes(angle, {
        keyframes: [
          { offset: 0, value: 0, easing: "linear" },
          { offset: 1, value: 360 },
        ],
        duration: 1100,
        iterations: "infinite",
      });
      void spin.start();
    });
  });

  cleanup(() => {
    spin?.stop();
    void angle.stop();
  });

  return (
    <Presence show={props.active()} duration={160} scaleFrom={0.94} class="pointer-events-none absolute bottom-0 right-0">
      <Canvas
        style={{ width: ORB_SIZE, height: ORB_SIZE, rotate: angle }}
        accessibilityElementsHidden
        draw={(cx, { width, height }) => {
          colorScheme();
          const r = Math.min(width, height) / 2 - 1.25;
          const cx0 = width / 2;
          const cy0 = height / 2;
          cx.strokeStyle = token("brand");
          cx.lineWidth = 1.75;
          cx.lineCap = "round";
          cx.beginPath();
          cx.arc(cx0, cy0, r, -Math.PI / 2, reduceMotion() ? Math.PI * 1.5 : -Math.PI / 2 + Math.PI * 0.62);
          cx.stroke();
        }}
      />
    </Presence>
  );
}

/** Skeleton placeholder inside the floating reply card while waiting for the first prose token. */
function ReplySkeleton(props: { label: () => string }) {
  const breath = useBreathingOpacity(() => true);
  return (
    <View testID="doc-orb-skeleton" class="gap-2.5 py-0.5">
      <View class="flex-row items-center gap-2" style={{ opacity: breath }}>
        <Icon name="sparkle" size={13} tone="brand-text" class="shrink-0" />
        <View class="min-w-0 flex-1">
          <RollingText text={props.label} pace class={`${uiType("xs")} font-medium text-muted-foreground`} />
        </View>
      </View>
      <View class="gap-2 pl-5">
        <ShimmerBar width="88%" height={9} delay={0} />
        <ShimmerBar width="70%" height={9} delay={130} />
        <ShimmerBar width="46%" height={9} delay={260} />
      </View>
    </View>
  );
}

/** Collapsible process summary (thinking + tools) inside one turn of the floating reply card. */
function TurnProcessPill(props: {
  thinking: Extract<Row, { kind: "thinking" }>[];
  tools: ToolRow[];
  running: boolean;
}) {
  const open = signal(false);
  const lang = activeLanguage();
  const summary = () => {
    const parts: string[] = [];
    if (props.thinking.length) {
      const ms = props.thinking.reduce((acc, t) => acc + (t.durationMs ?? 0), 0);
      const sec = elapsedSeconds(ms);
      parts.push(
        props.running && props.thinking.some((t) => t.streaming)
          ? tr("Thinking…", "思考中…")
          : sec > 0
            ? tr(`Thought ${sec}s`, `思考 ${sec}s`)
            : tr("Thought", "已思考"),
      );
    }
    if (props.tools.length) {
      const active = props.tools.find((t) => t.status === "running" || t.status === "call");
      if (active) {
        const desc = describeToolCall(active, lang);
        parts.push(desc.target ? `${desc.verb} ${desc.target}` : desc.verb);
      } else {
        const n = props.tools.length;
        parts.push(tr(n === 1 ? "1 tool" : `${n} tools`, `${n} 个工具`));
      }
    }
    return parts.join(" · ");
  };

  return (
    <View class="gap-1">
      <BaseButton
        onPress={() => open.update((v) => !v)}
        class={`${uiHeight(24)} self-start flex-row items-center gap-1.5 rounded-md corner-squircle px-1.5 ${PRESS} ${FOCUS_RING} hover:bg-accent`}
      >
        <Icon name={open() ? "chevronDown" : "chevronRight"} size={11} tone="subtle" />
        <Text class={`truncate ${uiType("xs")} text-muted-foreground`}>{summary()}</Text>
      </BaseButton>
      <Reveal open={open()}>
        <View class="ml-2 gap-1.5 border-l border-border pl-2.5 py-1">
          <Each of={props.thinking} key={(t) => t.id}>
            {(t) => (
              <Text class={`${uiType("xs")} leading-relaxed text-subtle`}>
                {t().redacted ? tr("Redacted reasoning", "已隐藏思考过程") : reasoningPreview(t().text, 220)}
              </Text>
            )}
          </Each>
          <Each of={props.tools} key={(t) => t.id}>
            {(t) => {
              const info = () => describeToolCall(t(), lang);
              return (
                <View class="flex-row items-center gap-1.5">
                  <Icon
                    name={t().status === "error" ? "alert" : info().icon}
                    size={12}
                    tone={t().status === "error" ? "destructive" : "subtle"}
                    class="shrink-0"
                  />
                  <Text class={`${uiType("xs")} font-medium text-muted-foreground`}>{info().verb}</Text>
                  <If when={Boolean(info().target)}>
                    <Text class={`min-w-0 flex-1 truncate font-mono ${uiType("xs")} text-subtle`}>{info().target}</Text>
                  </If>
                </View>
              );
            }}
          </Each>
        </View>
      </Reveal>
    </View>
  );
}

/** Inline approval bar inside the floating reply card when an agent pauses on `confirm` / `select`. */
function InlineApproval(props: { dialog: ExtensionUiDialog; onAnswer: (id: string, answer: ExtensionUiAnswer) => void }) {
  const message = () => (props.dialog.method === "confirm" ? props.dialog.message : "");
  const options = (): string[] => (props.dialog.method === "select" ? props.dialog.options : []);
  return (
    <View class="gap-2 rounded-xl corner-squircle border border-border bg-muted/60 p-2.5">
      <View class="flex-row items-center gap-1.5">
        <Icon name="clock" size={13} tone="warning" class="shrink-0" />
        <Text class={`min-w-0 flex-1 truncate ${uiType("xs")} font-medium text-foreground`}>
          {props.dialog.title || tr("Approval needed", "需要确认")}
        </Text>
      </View>
      <If when={Boolean(message())}>
        <Text class={`max-h-20 font-mono ${uiType("2xs")} leading-relaxed text-muted-foreground`}>{message()}</Text>
      </If>
      <If
        when={props.dialog.method === "confirm"}
        else={
          <If when={options().length > 0}>
            <View class="flex-row flex-wrap gap-1.5">
              <Each of={options()} key={(opt) => opt}>
                {(opt) => (
                  <BaseButton
                    onPress={() => props.onAnswer(props.dialog.id, { value: opt() })}
                    class={`${uiHeight(28)} items-center justify-center rounded-md corner-squircle border border-hairline bg-secondary px-2.5 ${PRESS} ${PRESS_SCALE} hover:bg-accent`}
                  >
                    <Text class={`${uiType("xs")} font-medium text-foreground`}>{opt()}</Text>
                  </BaseButton>
                )}
              </Each>
            </View>
          </If>
        }
      >
        <View class="flex-row items-center justify-end gap-1.5">
          <BaseButton
            onPress={() => props.onAnswer(props.dialog.id, { confirmed: false })}
            class={`${uiHeight(28)} items-center justify-center rounded-md corner-squircle border border-hairline bg-secondary px-2.5 ${PRESS} ${PRESS_SCALE} hover:bg-accent`}
          >
            <Text class={`${uiType("xs")} font-medium text-muted-foreground`}>{tr("Decline", "拒绝")}</Text>
          </BaseButton>
          <BaseButton
            onPress={() => props.onAnswer(props.dialog.id, { confirmed: true })}
            class={`${uiHeight(28)} items-center justify-center rounded-md corner-squircle bg-primary px-3 ${PRESS} ${PRESS_SCALE} hover:bg-primary/90`}
          >
            <Text class={`${uiType("xs")} font-medium text-brand-foreground`}>{tr("Allow", "允许")}</Text>
          </BaseButton>
        </View>
      </If>
    </View>
  );
}

/** One assistant reply's quiet action row: Replace selection / Insert / Append (when not already synced to disk) + Copy. */
function ReplyActions(props: {
  doc: MarkdownDoc;
  text: string;
  selection?: DocSelection;
  alreadyEdited?: boolean;
  onApplied: () => void;
}) {
  const copied = signal(false);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  cleanup(() => clearTimeout(copyTimer));

  const copy = () => {
    void Clipboard.writeText(props.text);
    copied.set(true);
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => copied.set(false), 1500);
  };

  return (
    <View class="mt-1 flex-row flex-wrap items-center gap-1">
      <If when={!props.doc.readOnly() && !props.alreadyEdited}>
        <If when={Boolean(props.selection && props.selection.to > props.selection.from)}>
          <BaseButton
            testID="doc-orb-replace"
            onPress={() => {
              if (applyDocEdit(props.doc.path, "replace", props.text, props.selection)) props.onApplied();
            }}
            class={`${uiHeight(24)} flex-row items-center gap-1 rounded-md corner-squircle bg-brand-soft px-2 ${PRESS} ${PRESS_SCALE} ${FOCUS_RING} hover:bg-brand/20`}
          >
            <Icon name="fileEdit" size={12} tone="brand-text" />
            <Text class={`${uiType("xs")} font-medium text-brand-text`}>{tr("Replace selection", "替换选中")}</Text>
          </BaseButton>
        </If>
        <BaseButton
          testID="doc-orb-insert"
          onPress={() => {
            if (applyDocEdit(props.doc.path, "insert", props.text)) props.onApplied();
          }}
          class={`${uiHeight(24)} flex-row items-center gap-1 rounded-md corner-squircle border-[0.5px] border-hairline bg-secondary/80 px-2 ${PRESS} ${PRESS_SCALE} ${FOCUS_RING} hover:bg-accent`}
        >
          <Icon name="plus" size={12} tone="foreground" />
          <Text class={`${uiType("xs")} font-medium text-foreground`}>{tr("Insert", "插入")}</Text>
        </BaseButton>
        <BaseButton
          testID="doc-orb-append"
          onPress={() => {
            if (applyDocEdit(props.doc.path, "append", props.text)) props.onApplied();
          }}
          class={`${uiHeight(24)} flex-row items-center gap-1 rounded-md corner-squircle px-2 ${PRESS} ${PRESS_SCALE} ${FOCUS_RING} hover:bg-accent`}
        >
          <Text class={`${uiType("xs")} text-muted-foreground`}>{tr("Append", "追加末尾")}</Text>
        </BaseButton>
      </If>
      <BaseButton
        testID="doc-orb-copy"
        onPress={copy}
        class={`${uiHeight(24)} flex-row items-center gap-1 rounded-md corner-squircle px-2 ${PRESS} ${PRESS_SCALE} ${FOCUS_RING} hover:bg-accent`}
      >
        <Icon name={copied() ? "check" : "copy"} size={12} tone={copied() ? "success" : "muted-foreground"} />
        <Text class={`${uiType("xs")} ${copied() ? "text-success" : "text-muted-foreground"}`}>
          {copied() ? tr("Copied", "已复制") : tr("Copy", "复制")}
        </Text>
      </BaseButton>
    </View>
  );
}

interface InlineTurn {
  id: string;
  userText: string;
  userExcerpt: boolean;
  thinking: Extract<Row, { kind: "thinking" }>[];
  tools: ToolRow[];
  answer?: Extract<Row, { kind: "text" }>;
  notices: Extract<Row, { kind: "notice" }>[];
}

/** Groups flat `Transcript` rows into clean user→assistant turns for the compact floating card. */
function groupTurns(rows: readonly Row[], pending?: { text: string; excerpt: boolean }): InlineTurn[] {
  const turns: InlineTurn[] = [];
  let cur: InlineTurn | undefined;
  for (const row of rows) {
    if (row.kind === "user") {
      const split = splitDocMessage(row.text);
      const userText = split.said.trim() || split.docs[0]?.text.trim() || row.text.trim();
      cur = {
        id: row.id,
        userText,
        userExcerpt: split.docs.some((d) => d.excerpt),
        thinking: [],
        tools: [],
        notices: [],
      };
      turns.push(cur);
      continue;
    }
    if (!cur) {
      cur = { id: row.id, userText: "", userExcerpt: false, thinking: [], tools: [], notices: [] };
      turns.push(cur);
    }
    if (row.kind === "thinking") cur.thinking.push(row);
    else if (row.kind === "tool") cur.tools.push(row);
    else if (row.kind === "text") cur.answer = row;
    else if (row.kind === "notice") cur.notices.push(row);
  }
  if (pending) {
    turns.push({
      id: "pending-turn",
      userText: pending.text,
      userExcerpt: pending.excerpt,
      thinking: [],
      tools: [],
      notices: [],
    });
  }
  return turns;
}

/**
 * Floating Liquid Glass reply drawer rising directly above the expanded pill bar:
 * shows live skeleton shimmer while waiting, collapsible thinking/tool steps,
 * veiled streaming Markdown prose, document-sync confirmation, and quick apply actions.
 */
function DocReplyCard(props: {
  doc: MarkdownDoc;
  assistant: DocAssistant;
  open: () => boolean;
  width: () => number;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onBounds?: (box: Box | undefined) => void;
  onApplied: () => void;
}) {
  const mounted = signal(untracked(props.open));
  const opacity = createAnimatedValue(untracked(props.open) ? 1 : 0);
  const translateY = createAnimatedValue(untracked(props.open) ? 0 : 12);
  const scale = createAnimatedValue(untracked(props.open) ? 1 : 0.97);
  const scrollRef = signal<ScrollRef | undefined>(undefined);
  const followTail = signal(true);
  const clockNow = signal(Date.now());
  let exitTimer: ReturnType<typeof setTimeout> | undefined;
  let seq = 0;

  // Live elapsed timer tick while running (stops immediately at rest).
  effect(() => {
    if (!props.assistant.running()) return;
    clockNow.set(Date.now());
    const timer = setInterval(() => clockNow.set(Date.now()), 500);
    cleanup(() => clearInterval(timer));
  });

  effect(() => {
    const isOpen = props.open();
    const reduced = reduceMotion();
    untracked(() => {
      const mine = ++seq;
      clearTimeout(exitTimer);
      void opacity.stop();
      void translateY.stop();
      void scale.stop();
      if (isOpen) {
        if (reduced) {
          batch(() => {
            opacity.set(1);
            translateY.set(0);
            scale.set(1);
            mounted.set(true);
          });
          return;
        }
        if (!mounted()) {
          batch(() => {
            opacity.set(0);
            translateY.set(12);
            scale.set(0.97);
            mounted.set(true);
          });
        }
        void opacity.timing(1, { duration: DURATION.fast, easing: EASING.entrance });
        void translateY.timing(0, { duration: 210, easing: EASING.signature });
        void scale.timing(1, { duration: 210, easing: EASING.signature });
      } else if (mounted()) {
        if (reduced) {
          opacity.set(0);
          mounted.set(false);
          props.onBounds?.(undefined);
          return;
        }
        void opacity.timing(0, { duration: 140, easing: EASING.exit });
        void translateY.timing(8, { duration: 140, easing: EASING.exit });
        void scale.timing(0.98, { duration: 140, easing: EASING.exit });
        exitTimer = setTimeout(() => {
          if (seq === mine) {
            mounted.set(false);
            props.onBounds?.(undefined);
          }
        }, 145);
      }
    });
  });

  cleanup(() => {
    clearTimeout(exitTimer);
    props.onBounds?.(undefined);
    void opacity.stop();
    void translateY.stop();
    void scale.stop();
  });

  const turns = computed(() => groupTurns(props.assistant.rows(), props.assistant.pendingPrompt()));

  // Gently follow new messages/streaming output unless the reader scrolled up.
  effect(() => {
    const list = turns();
    const last = list.at(-1);
    const tailLen = last?.answer?.text.length ?? 0;
    const toolCount = last?.tools.length ?? 0;
    const isOpen = props.open();
    if (!isOpen || !untracked(followTail)) return;
    void tailLen;
    void toolCount;
    const scroller = untracked(scrollRef);
    if (!scroller) return;
    queueMicrotask(() => {
      if (untracked(followTail)) scroller.scrollToEnd({ animated: false });
    });
  });

  const headerTitle = () => {
    const model = props.assistant.modelName();
    return model ? `${props.assistant.agentName()} · ${model}` : props.assistant.agentName();
  };

  const liveElapsed = () => {
    if (!props.assistant.running()) return "";
    const secs = elapsedSeconds(clockNow() - props.assistant.runStartedAt());
    return secs > 0 ? `${secs}s` : "";
  };

  const skeletonStatusText = () => {
    const act = props.assistant.activity();
    if (act.kind === "tool") {
      const desc = describeToolCall(
        { kind: "tool", id: "live", name: act.name, args: act.args, status: "running", output: "", images: 0 },
        activeLanguage(),
      );
      return desc.target ? `${desc.verb} ${desc.target}` : desc.verb;
    }
    if (act.kind === "writing") return tr("Writing…", "正在回复…");
    if (act.kind === "retrying") return tr(`Retrying (${act.attempt}/${act.maxAttempts})…`, `重试中 (${act.attempt}/${act.maxAttempts})…`);
    if (act.kind === "compacting") return tr("Compacting context…", "正在压缩上下文…");
    return tr("Thinking…", "正在思考…");
  };

  const breath = useBreathingOpacity(() => props.assistant.running());

  return (
    <If when={mounted()}>
      <View
        testID="doc-orb-reply"
        onLayout={(e) =>
          props.onBounds?.({
            x: e.bounds.origin.x,
            y: e.bounds.origin.y,
            w: e.bounds.size.width,
            h: e.bounds.size.height,
          })
        }
        onMouseEnter={props.onPointerEnter}
        onMouseLeave={props.onPointerLeave}
        class={`mb-2.5 overflow-hidden rounded-2xl corner-squircle border-[0.5px] border-hairline shadow-popover ${
          platform.os === "linux" ? "bg-popover" : "bg-popover/92 dark:bg-popover/90"
        } ${props.open() ? "" : "pointer-events-none"}`}
        style={{
          ...GLASS_REGULAR,
          width: props.width(),
          opacity,
          transform: [{ translateY }, { scale }],
        }}
      >
        {/* Header: stable agent identity (live step is said once inside the body) */}
        <View class={`${uiHeight(36)} flex-row items-center gap-2 border-b border-border pl-3 pr-1.5`}>
          <AgentLogo id={props.assistant.agentId()} size={14} tone="foreground" class="shrink-0" />
          <Text class={`min-w-0 shrink truncate ${uiType("xs")} font-medium text-foreground`}>{headerTitle()}</Text>
          <If when={Boolean(liveElapsed())}>
            <View style={{ opacity: breath }}>
              <Text class={`shrink-0 ${uiType("xs")} tabular-nums text-subtle`}>{liveElapsed()}</Text>
            </View>
          </If>
          <View class="flex-1" />
          <View class="shrink-0 flex-row items-center gap-0.5">
            <If when={Boolean(props.assistant.daemonId())}>
              <IconButton
                testID="doc-orb-open-chat"
                icon="external"
                size="sm"
                tone="muted-foreground"
                label={tr("Open in full session", "在完整会话中打开")}
                tipPlacement="top"
                onPress={() => props.assistant.openInFullChat()}
              />
            </If>
            <If when={turns().length > 0}>
              <IconButton
                testID="doc-orb-clear"
                icon="refresh"
                size="sm"
                tone="muted-foreground"
                label={tr("New thread", "新对话")}
                tipPlacement="top"
                onPress={() => props.assistant.clear()}
              />
            </If>
            <IconButton
              testID="doc-orb-collapse"
              icon="chevronDown"
              size="sm"
              tone="muted-foreground"
              label={tr("Collapse reply", "收起回复")}
              shortcut="escape"
              tipPlacement="top"
              onPress={() => props.assistant.setReplyOpen(false)}
            />
          </View>
        </View>

        {/* Scrollable conversation body */}
        <Scroll
          ref={(node) => scrollRef.set(node ?? undefined)}
          onScroll={(e) => {
            const distFromEnd = e.contentSize.height - (e.offset.y + e.size.height);
            const atBottom = distFromEnd < 28;
            if (atBottom !== untracked(followTail)) followTail.set(atBottom);
          }}
          class="max-h-84"
          contentClass="gap-3 px-3.5 py-3"
        >
          <Each of={turns()} key={(t) => t.id}>
            {(turn, index) => {
              const isLatest = () => index() === turns().length - 1;
              const waitingProse = () => isLatest() && props.assistant.running() && !turn().answer?.text;
              const blocks = computed(() => {
                const ans = turn().answer;
                if (!ans || !ans.text) return [];
                return proseRows({
                  id: `doc-orb:${props.doc.path}:${ans.id}`,
                  text: ans.text,
                  streaming: ans.streaming,
                });
              });
              const editedDoc = () => {
                const t = turn();
                const edited = props.assistant.docEditedRows();
                return Boolean((t.answer?.id && edited[t.answer.id]) || edited[t.id]);
              };
              return (
                <View class="gap-2">
                  <If when={Boolean(turn().userText)}>
                    <View class="items-end">
                      <View class="max-w-[86%] gap-1 rounded-2xl corner-squircle bg-secondary px-3 py-1.5">
                        <Text class={`${uiType("sm")} leading-snug text-secondary-foreground`}>{turn().userText}</Text>
                        <If when={turn().userExcerpt}>
                          <View class="flex-row items-center gap-1">
                            <Icon name="file" size={10} tone="subtle" />
                            <Text class={`${uiType("2xs")} text-subtle`}>{tr("Selection", "选中内容")}</Text>
                          </View>
                        </If>
                      </View>
                    </View>
                  </If>

                  <If when={!waitingProse() && (turn().thinking.length > 0 || turn().tools.length > 0)}>
                    <TurnProcessPill
                      thinking={turn().thinking}
                      tools={turn().tools}
                      running={isLatest() && props.assistant.running()}
                    />
                  </If>

                  <If when={waitingProse()}>
                    <ReplySkeleton label={skeletonStatusText} />
                  </If>

                  <If when={blocks().length > 0}>
                    <View class="gap-1.5">
                      <Each of={blocks()} key={(b) => b.id}>
                        {(block) => <ProseBlock row={block()} />}
                      </Each>
                    </View>
                  </If>

                  <Each of={turn().notices} key={(n) => n.id}>
                    {(n) => (
                      <View
                        class={`flex-row items-start gap-2 rounded-xl corner-squircle border px-2.5 py-2 ${
                          n().tone === "error"
                            ? "border-destructive/25 bg-destructive/10"
                            : "border-border bg-muted/60"
                        }`}
                      >
                        <Icon
                          name={n().tone === "error" ? "alert" : "info"}
                          size={13}
                          tone={n().tone === "error" ? "destructive" : "muted-foreground"}
                          class="mt-0.5 shrink-0"
                        />
                        <View class="min-w-0 flex-1 gap-0.5">
                          <Text class={`${uiType("xs")} font-medium text-foreground`}>{n().title}</Text>
                          <If when={Boolean(n().text)}>
                            <Text class={`${uiType("xs")} text-muted-foreground`}>{n().text}</Text>
                          </If>
                        </View>
                      </View>
                    )}
                  </Each>

                  <If when={editedDoc()}>
                    <View class="flex-row items-center justify-between gap-2 rounded-xl corner-squircle border border-success/25 bg-success/10 px-2.5 py-1.5">
                      <View class="flex-row items-center gap-1.5">
                        <Icon name="check" size={12} tone="success" />
                        <Text class={`${uiType("xs")} font-medium text-foreground`}>
                          {tr("Document updated directly", "已自动同步到文档")}
                        </Text>
                      </View>
                      <If when={!props.doc.readOnly()}>
                        <BaseButton
                          onPress={() => void undoDoc(props.doc.path)}
                          class={`${uiHeight(20, { min: 20 })} items-center justify-center rounded px-1.5 ${PRESS} hover:bg-accent`}
                        >
                          <Text class={`${uiType("xs")} font-medium text-brand-text`}>{tr("Undo", "撤销")}</Text>
                        </BaseButton>
                      </If>
                    </View>
                  </If>

                  <If when={Boolean(turn().answer?.text && !turn().answer!.streaming && !(isLatest() && props.assistant.running()))}>
                    <ReplyActions
                      doc={props.doc}
                      text={turn().answer!.text}
                      selection={isLatest() ? props.assistant.lastPromptSelection() : undefined}
                      alreadyEdited={editedDoc()}
                      onApplied={props.onApplied}
                    />
                  </If>
                </View>
              );
            }}
          </Each>

          <If when={props.assistant.pendingDialog()}>
            {(dialog) => (
              <InlineApproval
                dialog={dialog()}
                onAnswer={(id, answer) => props.assistant.answerDialog(id, answer as never)}
              />
            )}
          </If>
        </Scroll>
      </View>
    </If>
  );
}

/** Compact engine picker inside the document floating mini-composer. */
function DocAgentPicker(props: {
  assistant: DocAssistant;
  open: () => boolean;
  onOpenChange: (open: boolean) => void;
  onChosen: () => void;
}) {
  const current = () => props.assistant.agent();
  const pickerAgents = computed(() => {
    const all = availableAgents();
    const activeId = props.assistant.agentId();
    const checking = (a: (typeof all)[number]) => (a.statusText ?? "").toLowerCase().includes("checking");
    return all.filter((a) => a.id === activeId || (a.enabled !== false && (a.available || checking(a))));
  });

  return (
    <Popover
      open={props.open()}
      onOpenChange={(e) => props.onOpenChange(e.open)}
      placement="top"
      align="start"
      offset={8}
      margin={12}
      popupClass={`w-76 p-1 ${POPUP}`}
      popupStyle={popupStyle("top", "start")}
      popupStartingStyle={popupHiddenStyle("top", "start")}
      popupEndingStyle={popupLeavingStyle("top", "start")}
      trigger={
        <Chip
          testID="doc-orb-agent"
          leading={<AgentLogo id={current().id} size={13} />}
          label={current().name}
          class="max-w-32"
        />
      }
    >
      <Scroll class="max-h-72" testID="doc-orb-agent-menu">
        <Each of={pickerAgents()} key={(a) => a.id}>
          {(agent) => {
            const meta = () => formatAgentMeta(agent(), backend().home());
            const selected = () => agent().id === props.assistant.agentId();
            return (
              <BaseButton
                testID={`doc-orb-agent-${agent().id}`}
                selected={selected()}
                onPress={() => {
                  props.onChosen();
                  void props.assistant.chooseAgent(agent().id);
                }}
                class={`${uiMinHeight(36)} flex-row items-center gap-2.5 rounded-md corner-squircle px-2 py-1 ${PRESS} hover:bg-accent focus:bg-accent active:bg-accent`}
              >
                <AgentLogo
                  id={agent().id}
                  size={18}
                  tone={agent().available ? "foreground" : "muted-foreground"}
                  status={agent().available ? "ready" : "off"}
                />
                <View class="min-w-0 flex-1">
                  <View class="min-w-0 flex-row items-center gap-1.5">
                    <Text class={`shrink truncate ${uiType("base")} ${agent().available ? "text-foreground" : "text-muted-foreground"}`}>
                      {agent().name}
                    </Text>
                    <If when={meta().versionBadge}>
                      {(v) => <Text class={`shrink-0 font-mono ${uiType("2xs")} text-subtle`}>{v()}</Text>}
                    </If>
                  </View>
                  <Text class={`truncate ${uiType("xs")} text-subtle`}>{meta().statusLabel}</Text>
                </View>
                <View class="w-4 shrink-0 items-center">
                  {selected() ? <Icon name="check" size={14} tone="brand-text" /> : null}
                </View>
              </BaseButton>
            );
          }}
        </Each>
      </Scroll>
    </Popover>
  );
}

/** Compact searchable model picker inside the document floating mini-composer. */
function DocModelPicker(props: {
  assistant: DocAssistant;
  open: () => boolean;
  onOpenChange: (open: boolean) => void;
  onChosen: () => void;
}) {
  const query = signal("");
  let held = "";

  const label = () => {
    const name = props.assistant.modelName();
    if (!name && props.assistant.loadingCatalog()) return held || tr("Loading…", "加载中…");
    return (held = name || tr("No model", "无模型"));
  };

  const currentKey = () => {
    const m = props.assistant.currentModel();
    return m ? modelKey(m) : "";
  };

  const items = computed<CommandItem[]>(() =>
    props.assistant.availableModels().map((model) => ({
      id: modelKey(model),
      label: model.name || model.id,
      group: providerName(model.provider),
      keywords: [model.id, model.provider],
      checked: modelKey(model) === currentKey(),
    })),
  );

  const byKey = computed(() => new Map<string, Model>(props.assistant.availableModels().map((m) => [modelKey(m), m])));

  return (
    <Popover
      open={props.open()}
      onOpenChange={(e) => {
        if (e.open) {
          query.set("");
          void props.assistant.ensureCatalog();
        }
        props.onOpenChange(e.open);
      }}
      placement="top"
      align="start"
      offset={8}
      margin={12}
      popupClass={`w-80 overflow-hidden ${POPUP}`}
      popupStyle={popupStyle("top", "start")}
      popupStartingStyle={popupHiddenStyle("top", "start")}
      popupEndingStyle={popupLeavingStyle("top", "start")}
      trigger={<Chip testID="doc-orb-model" label={label()} class="max-w-44" />}
    >
      <View testID="doc-orb-model-menu">
        <Command
          items={items()}
          query={query()}
          onQueryChange={(event) => query.set(event.query)}
          placeholder={tr("Search models", "搜索模型")}
          accessibilityLabel={tr("Models", "模型")}
          autoFocus
          onCancel={() => props.onOpenChange(false)}
          onSelect={({ id }) => {
            const model = byKey().get(id);
            props.onChosen();
            if (model) void props.assistant.chooseModel(model);
          }}
          searchBarClass={`${uiHeight(40)} flex-row items-center gap-2 border-b border-border px-3`}
          searchPrefix={<Icon name="search" size={14} tone="subtle" />}
          searchClass={`flex-1 ${uiType("base")} text-foreground caret-brand placeholder:text-subtle`}
          listClass="max-h-72 p-1"
          groupClass={`px-2 pb-1 pt-2 ${uiType("xs")} font-medium text-subtle`}
          separatorClass="mx-1 my-1 h-px bg-border"
          itemClass={`group ${uiHeight(32)} flex-row items-center rounded-md corner-squircle px-2 ${PRESS} focus:bg-accent`}
          empty={
            <View class="items-center gap-3 px-6 py-8">
              <Text class={`text-center ${uiType("sm")} text-muted-foreground`}>
                {props.assistant.loadingCatalog()
                  ? tr("Loading models…", "正在加载模型…")
                  : props.assistant.availableModels().length
                    ? tr(`No models match “${query()}”.`, `没有与“${query()}”匹配的模型。`)
                    : tr("Connect a provider to see its models here.", "连接服务商后即可在此查看其模型。")}
              </Text>
              <If when={!props.assistant.loadingCatalog() && !props.assistant.availableModels().length}>
                <BaseButton
                  onPress={() => {
                    props.onOpenChange(false);
                    showAgentSettings(props.assistant.agentId());
                  }}
                  class={`${uiHeight(28)} justify-center rounded-md corner-squircle bg-secondary px-2.5 ${PRESS} hover:bg-secondary/80`}
                >
                  <Text class={`${uiType("base")} font-medium text-secondary-foreground`}>
                    {tr(`Configure ${props.assistant.agentName()}`, `配置 ${props.assistant.agentName()}`)}
                  </Text>
                </BaseButton>
              </If>
            </View>
          }
          renderItem={(entry) => (
            <View class="flex-1 flex-row items-center gap-2">
              <Text class={`shrink truncate ${uiType("base")} text-foreground`}>{entry.label}</Text>
              {byKey().get(entry.id)?.reasoning ? <Icon name="sparkle" size={12} tone="subtle" /> : null}
              <View class="flex-1" />
              <View class="w-4 items-center">{entry.checked ? <Icon name="check" size={14} tone="brand-text" /> : null}</View>
            </View>
          )}
        />
      </View>
    </Popover>
  );
}

/** Compact reasoning/effort picker inside the document floating mini-composer (shown only for models that reason). */
function DocThinkingPicker(props: {
  assistant: DocAssistant;
  open: () => boolean;
  onOpenChange: (open: boolean) => void;
  onChosen: () => void;
}) {
  const levels = () => props.assistant.thinkingLevels();
  const level = () => props.assistant.thinkingLevel();
  return (
    <Presence show={levels().length > 1} scaleFrom={0.92}>
      <Popover
        open={props.open()}
        onOpenChange={(e) => props.onOpenChange(e.open)}
        placement="top"
        align="start"
        offset={8}
        margin={12}
        popupClass={`w-56 p-1 ${POPUP}`}
        popupStyle={popupStyle("top", "start")}
        popupStartingStyle={popupHiddenStyle("top", "start")}
        popupEndingStyle={popupLeavingStyle("top", "start")}
        trigger={<Chip testID="doc-orb-thinking" label={thinkingText(level()).label} class="shrink-0 text-subtle" />}
      >
        <View testID="doc-orb-thinking-menu">
          <Text class={`px-2 pb-1 pt-1.5 ${uiType("xs")} font-medium text-subtle`} role="header">
            {tr("Thinking", "思考深度")}
          </Text>
          <Each of={levels()}>
            {(option) => (
              <BaseButton
                testID={`doc-orb-thinking-${option()}`}
                selected={option() === level()}
                onPress={() => {
                  props.onChosen();
                  void props.assistant.chooseThinkingLevel(option());
                }}
                class={`${uiHeight(32)} flex-row items-center gap-2 rounded-md corner-squircle px-2 ${PRESS} hover:bg-accent focus:bg-accent active:bg-accent`}
              >
                <Text class={`${uiType("base")} text-foreground`}>{thinkingText(option()).label}</Text>
                <Text class={`flex-1 truncate ${uiType("xs")} text-subtle`}>{thinkingText(option()).hint}</Text>
                <View class="w-4 items-center">{option() === level() ? <Icon name="check" size={14} tone="brand-text" /> : null}</View>
              </BaseButton>
            )}
          </Each>
        </View>
      </Popover>
    </Presence>
  );
}

/** Compact runtime permission mode picker inside the document floating mini-composer. */
function DocPermissionPicker(props: {
  assistant: DocAssistant;
  open: () => boolean;
  onOpenChange: (open: boolean) => void;
  onChosen: () => void;
}) {
  const mode = () => props.assistant.runtimeMode();
  const ceiling = () => currentRuntimeCeiling();
  const supported = () => props.assistant.agent().supportedRuntimeModes;
  return (
    <Popover
      open={props.open()}
      onOpenChange={(e) => props.onOpenChange(e.open)}
      placement="top"
      align="end"
      offset={8}
      margin={12}
      popupClass={`w-64 p-1 ${POPUP}`}
      popupStyle={popupStyle("top", "end")}
      popupStartingStyle={popupHiddenStyle("top", "end")}
      popupEndingStyle={popupLeavingStyle("top", "end")}
      trigger={
        <Chip
          testID="doc-orb-permission"
          icon={runtimeModeIcon(mode())}
          iconOnly
          label={`${runtimeModeText(mode()).label} — ${runtimeModeText(mode()).hint}`}
          tipText={`${runtimeModeText(mode()).label} — ${runtimeModeText(mode()).hint}`}
        />
      }
    >
      <View testID="doc-orb-permission-menu">
        <Text class={`px-2 pb-1 pt-1.5 ${uiType("xs")} font-medium text-subtle`} role="header">
          {tr("Permissions", "运行权限")}
        </Text>
        <Each of={RUNTIME_MODES}>
          {(option) => {
            const allowed = () =>
              (supported().length === 0 || supported().includes(option())) &&
              runtimeModeRank(option()) <= runtimeModeRank(ceiling());
            return (
              <BaseButton
                testID={`doc-orb-permission-${option()}`}
                disabled={!allowed()}
                selected={option() === mode()}
                onPress={() => {
                  props.onChosen();
                  void props.assistant.chooseRuntimeMode(option());
                }}
                class={`${uiMinHeight(36)} flex-row items-center gap-2 rounded-md corner-squircle px-2 py-1 ${PRESS} hover:bg-accent focus:bg-accent active:bg-accent disabled:opacity-45`}
              >
                <Icon name={runtimeModeIcon(option())} size={15} tone={option() === mode() ? "foreground" : "muted-foreground"} />
                <View class="min-w-0 flex-1">
                  <Text class={`truncate ${uiType("base")} text-foreground`}>{runtimeModeText(option()).label}</Text>
                  <Text class={`truncate ${uiType("xs")} text-subtle`}>{runtimeModeText(option()).hint}</Text>
                </View>
                <View class="w-4 shrink-0 items-center">{option() === mode() ? <Icon name="check" size={14} tone="brand-text" /> : null}</View>
              </BaseButton>
            );
          }}
        </Each>
      </View>
    </Popover>
  );
}

/**
 * The document's floating AI orb that morphs smoothly on hover into a Liquid Glass
 * mini-composer anchored bottom-right to Pip, with engine/model/effort/permission
 * pickers, live streaming replies, skeleton loading, and direct document editing.
 */
export function DocFloatingOrb(props: {
  doc: MarkdownDoc;
  liveSelection: () => DocSelection | undefined;
  readLiveSelection?: () => DocSelection | undefined;
  pointerBridge?: DocOrbPointerBridge;
  onReturnFocus: () => void;
}) {
  const assistant = ensureDocAssistant(props.doc.path);
  const layerActive = LayerActive();
  const hovered = signal(false);
  const focused = signal(false);
  const openPicker = signal<OrbPickerId | null>(null);
  const dismissed = signal(false);
  const composing = signal(false);
  const paneW = signal(720);
  const inputH = signal(INPUT_MIN_H);
  let inputRef: InputRef | undefined;
  let leaveTimer: ReturnType<typeof setTimeout> | undefined;
  let stackBox: Box = { x: 0, y: 0, w: 0, h: 0 };
  let pillBox: Box = { x: 0, y: 0, w: ORB_SIZE, h: ORB_SIZE };
  let replyBox: Box | undefined;
  let lastPanePt: { x: number; y: number } | undefined;
  let pointerOutsidePane = false;
  let pointerPressed = false;
  let editorDragging = false;
  let escapeSuppress = false;
  let escapePt: { x: number; y: number } | undefined;

  const expandedW = computed(() => {
    const avail = Math.max(260, Math.round(paneW() - ORB_RIGHT_INSET * 2));
    return Math.min(BAR_MAX_W, Math.max(Math.min(BAR_MIN_W, avail), avail));
  });
  const replyW = expandedW;
  const hasThread = () => assistant.rows().length > 0 || Boolean(assistant.pendingPrompt());
  const hasText = () => assistant.draft().trim().length > 0;
  const pickerOpen = () => openPicker() !== null;
  const expanded = computed(
    () => hovered() || focused() || pickerOpen() || assistant.replyOpen() || (hasText() && !dismissed()),
  );
  const activeSelection = computed(() => assistant.pinnedSelection() ?? props.liveSelection());
  const estimatedExpandedH = computed(
    () => TOOLBAR_H + INPUT_ROW_PAD_V + inputH() + (activeSelection()?.text ? SELECTION_ROW_EXTRA_H : 0),
  );

  // ── Synchronized 2D critically damped spring morph (0 = resting orb ↔ 1 = expanded mini-composer) ──
  const morph = signal(untracked(expanded) ? 1 : 0);
  let springPos = untracked(morph);
  let springVel = 0;
  let springTarget = springPos;
  let springFrame: number | undefined;
  let springLastAt = 0;
  let measuredExpandedH = untracked(estimatedExpandedH);
  let collapseFromH = measuredExpandedH;

  const stopSpring = () => {
    if (springFrame !== undefined) {
      cancelAnimationFrame(springFrame);
      springFrame = undefined;
    }
  };

  const stepSpring = () => {
    const now = Date.now();
    const dt = Math.min(0.032, Math.max(0.004, (now - springLastAt) / 1000));
    springLastAt = now;
    const force = -MORPH_STIFFNESS * (springPos - springTarget) - MORPH_DAMPING * springVel;
    springVel += (force / MORPH_MASS) * dt;
    springPos += springVel * dt;
    if (springPos < 0) {
      springPos = 0;
      if (springVel < 0) springVel = 0;
    } else if (springPos > 1) {
      springPos = 1;
      if (springVel > 0) springVel = 0;
    }
    if (Math.abs(springPos - springTarget) < 0.001 && Math.abs(springVel) < 0.004) {
      springPos = springTarget;
      springVel = 0;
      springFrame = undefined;
      morph.set(springTarget);
      return;
    }
    morph.set(Math.round(springPos * 1000) / 1000);
    springFrame = requestAnimationFrame(stepSpring);
  };

  const animateMorphTo = (target: 0 | 1) => {
    springTarget = target;
    if (untracked(reduceMotion)) {
      stopSpring();
      springPos = target;
      springVel = 0;
      morph.set(target);
      return;
    }
    if (Math.abs(springPos - target) < 0.001 && Math.abs(springVel) < 0.004) {
      stopSpring();
      springPos = target;
      springVel = 0;
      morph.set(target);
      return;
    }
    if (springFrame === undefined) {
      springLastAt = Date.now();
      springFrame = requestAnimationFrame(stepSpring);
    }
  };

  const settledOpen = () => morph() >= 0.999 && expanded();
  const widthNow = () => {
    const t = morph();
    if (t <= 0) return ORB_SIZE;
    if (t >= 1) return expandedW();
    return Math.round((ORB_SIZE + (expandedW() - ORB_SIZE) * t) * 10) / 10;
  };
  const heightNow = () => {
    const t = morph();
    if (t <= 0) return ORB_SIZE;
    const targetH = expanded() ? estimatedExpandedH() : collapseFromH;
    if (t >= 1) return targetH;
    return Math.round((ORB_SIZE + (targetH - ORB_SIZE) * t) * 10) / 10;
  };

  // Compositor-driven inner reveal (opacity + leftward glide out of Pip) synchronized with the capsule bloom.
  const initiallyExpanded = untracked(expanded);
  const controlsOpacity = createAnimatedValue(initiallyExpanded ? 1 : 0);
  const controlsX = createAnimatedValue(initiallyExpanded ? 0 : 8);
  const rightScale = createAnimatedValue(initiallyExpanded ? 1 : 0.84);
  const pipScale = createAnimatedValue(initiallyExpanded ? 0.88 : 1);
  const orbLiftY = createAnimatedValue(initiallyExpanded ? -1.5 : 0);
  const controlsMounted = signal(initiallyExpanded);
  let controlsHideTimer: ReturnType<typeof setTimeout> | undefined;
  let morphSeq = 0;
  let wasExpanded = initiallyExpanded;

  effect(() => {
    const isExp = expanded();
    const reduced = reduceMotion();
    untracked(() => {
      if (!isExp && wasExpanded) {
        collapseFromH = Math.max(ORB_SIZE, measuredExpandedH || estimatedExpandedH());
      }
      animateMorphTo(isExp ? 1 : 0);
      if (isExp === wasExpanded) return;
      wasExpanded = isExp;
      const mine = ++morphSeq;
      clearTimeout(controlsHideTimer);
      void controlsOpacity.stop();
      void controlsX.stop();
      void rightScale.stop();
      void pipScale.stop();
      void orbLiftY.stop();

      if (reduced) {
        batch(() => {
          controlsMounted.set(isExp);
          controlsOpacity.set(isExp ? 1 : 0);
          controlsX.set(0);
          rightScale.set(1);
          pipScale.set(isExp ? 0.88 : 1);
          orbLiftY.set(0);
        });
        return;
      }

      if (isExp) {
        if (!controlsMounted()) {
          batch(() => {
            controlsOpacity.set(0);
            controlsX.set(8);
            rightScale.set(0.84);
            controlsMounted.set(true);
          });
        }
        void controlsOpacity.timing(1, { duration: 170, delay: 30, easing: EASING.entrance });
        void controlsX.timing(0, { duration: 210, delay: 20, easing: EASING.signature });
        void rightScale.timing(1, { duration: 200, delay: 30, easing: EASING.signature });
        void pipScale.timing(0.88, { duration: 190, easing: EASING.signature });
        void orbLiftY.timing(-1.5, { duration: 200, easing: EASING.signature });
      } else {
        void controlsOpacity.timing(0, { duration: 95, easing: EASING.exit });
        void controlsX.timing(6, { duration: 95, easing: EASING.exit });
        void rightScale.timing(0.84, { duration: 95, easing: EASING.exit });
        void pipScale.timing(1, { duration: 200, easing: EASING.signature });
        void orbLiftY.timing(0, { duration: 200, easing: EASING.signature });
        controlsHideTimer = setTimeout(() => {
          if (morphSeq === mine && !untracked(expanded)) controlsMounted.set(false);
        }, 120);
      }
    });
  });

  // Sync live editor selection when idle; freeze once hovered/focused/picking so moving to the bar never drops it.
  effect(() => {
    const sel = props.liveSelection();
    untracked(() => {
      if (sel) {
        const prev = assistant.pinnedSelection();
        if (!prev || prev.from !== sel.from || prev.to !== sel.to || prev.text !== sel.text) {
          assistant.setPinnedSelection(sel);
        }
      } else if (!focused() && !hovered() && !pickerOpen() && !assistant.replyOpen()) {
        if (assistant.pinnedSelection() !== undefined) {
          assistant.setPinnedSelection(undefined);
        }
      }
    });
  });

  // Reset input height cleanly when draft clears.
  effect(() => {
    if (!assistant.draft()) inputH.set(INPUT_MIN_H);
  });

  const cancelLeave = () => {
    if (leaveTimer !== undefined) {
      clearTimeout(leaveTimer);
      leaveTimer = undefined;
    }
  };

  const scheduleLeave = () => {
    if (!untracked(hovered) || leaveTimer !== undefined) return;
    leaveTimer = setTimeout(() => {
      leaveTimer = undefined;
      hovered.set(false);
    }, LEAVE_GRACE_MS);
  };

  const isPointInOrbRegion = (px: number, py: number): boolean => {
    if (stackBox.w <= 0 || stackBox.h <= 0) return false;
    const pillRight =
      pillBox.w > 0 ? stackBox.x + pillBox.x + pillBox.w : stackBox.x + stackBox.w - ORB_RIGHT_INSET;
    const pillW = Math.max(ORB_SIZE, untracked(widthNow), pillBox.w);
    const pillLeft = pillRight - pillW;
    const pillH = Math.max(ORB_SIZE, untracked(heightNow), pillBox.h);
    const pillBottom = stackBox.y + stackBox.h;
    const pillTop = pillBottom - pillH;
    if (
      px >= pillLeft - HOVER_EDGE_PAD &&
      px <= pillRight + HOVER_EDGE_PAD &&
      py >= pillTop - HOVER_EDGE_PAD &&
      py <= pillBottom + HOVER_EDGE_PAD
    ) {
      return true;
    }
    if (untracked(() => assistant.replyOpen()) && replyBox && replyBox.w > 0 && replyBox.h > 0) {
      const left = stackBox.x + replyBox.x - HOVER_EDGE_PAD;
      const right = stackBox.x + replyBox.x + replyBox.w + HOVER_EDGE_PAD;
      const top = stackBox.y + replyBox.y - HOVER_EDGE_PAD;
      if (px >= left && px <= right && py >= top && py <= pillTop + 4) return true;
    }
    return false;
  };

  const isInsidePillLocal = (pos?: { x: number; y: number }): boolean => {
    if (!pos) return false;
    const w = Math.max(ORB_SIZE, untracked(widthNow), pillBox.w);
    const h = Math.max(ORB_SIZE, untracked(heightNow), pillBox.h);
    return pos.x > 2 && pos.x < w - 2 && pos.y > 2 && pos.y < h - 2;
  };

  if (props.pointerBridge) {
    cleanup(
      props.pointerBridge.bind({
        onMove: (x, y, pressed) => {
          pointerOutsidePane = false;
          pointerPressed = pressed;
          lastPanePt = { x, y };
          if (pressed && !untracked(hovered) && !escapeSuppress) return;
          if (escapeSuppress) {
            const movedFar = escapePt !== undefined && Math.hypot(x - escapePt.x, y - escapePt.y) >= 10;
            if (!isPointInOrbRegion(x, y) || movedFar) {
              escapeSuppress = false;
              escapePt = undefined;
            }
          }
          if (untracked(hovered)) {
            if (isPointInOrbRegion(x, y)) {
              cancelLeave();
            } else if (stackBox.w > 0 && stackBox.h > 0) {
              scheduleLeave();
            }
          }
        },
        onLeave: () => {
          pointerOutsidePane = true;
          pointerPressed = false;
          lastPanePt = undefined;
          escapeSuppress = false;
          escapePt = undefined;
          scheduleLeave();
        },
        onDragChange: (dragging) => {
          editorDragging = dragging;
          if (!dragging) pointerPressed = false;
        },
      }),
    );
  }

  // External focus requests (⌘J or selection bubble button).
  let seenFocusTick = untracked(() => assistant.focusTick());
  effect(() => {
    const tick = assistant.focusTick();
    if (tick === seenFocusTick) return;
    seenFocusTick = tick;
    untracked(() => {
      cancelLeave();
      escapeSuppress = false;
      escapePt = undefined;
      openPicker.set(null);
      dismissed.set(false);
      hovered.set(true);
      focused.set(true);
      controlsMounted.set(true);
      queueMicrotask(() => inputRef?.focus());
      setTimeout(() => inputRef?.focus(), 20);
    });
  });

  // Release focus, popovers, & hover cleanly when this document tab moves behind another tab or Settings.
  effect(() => {
    if (layerActive()) return;
    untracked(() => {
      cancelLeave();
      escapeSuppress = false;
      escapePt = undefined;
      lastPanePt = undefined;
      pointerOutsidePane = false;
      pointerPressed = false;
      editorDragging = false;
      openPicker.set(null);
      hovered.set(false);
      focused.set(false);
      inputRef?.blur();
    });
  });

  // Scoped mod+enter submit when focused inside the floating AI input (never intercepting RichEditor's ⌘↵).
  effect(() => {
    if (!layerActive() || !focused() || pickerOpen()) return;
    cleanup(keymap.bind("mod+enter", submit, { when: "always" }));
  });

  const dismissToOrb = () => {
    cancelLeave();
    const pointerInOrb = lastPanePt !== undefined && isPointInOrbRegion(lastPanePt.x, lastPanePt.y);
    escapeSuppress = pointerInOrb;
    escapePt = pointerInOrb && lastPanePt ? { ...lastPanePt } : undefined;
    openPicker.set(null);
    dismissed.set(true);
    focused.set(false);
    hovered.set(false);
    inputRef?.blur();
    props.onReturnFocus();
  };

  const handleEscape = () => {
    if (untracked(() => assistant.replyOpen())) {
      assistant.setReplyOpen(false);
      if (!untracked(hasText)) dismissToOrb();
      return;
    }
    dismissToOrb();
  };

  // Bind Escape while active (yielding completely while a picker Popover is open so Escape closes only the popover first).
  effect(() => {
    if (!layerActive() || pickerOpen()) return;
    if (!focused() && !assistant.replyOpen() && !(hasText() && !dismissed())) return;
    cleanup(keymap.bind("escape", handleEscape, { when: "always" }));
  });

  cleanup(() => {
    stopSpring();
    cancelLeave();
    clearTimeout(controlsHideTimer);
    void controlsOpacity.stop();
    void controlsX.stop();
    void rightScale.stop();
    void pipScale.stop();
    void orbLiftY.stop();
  });

  const onEnter = () => {
    pointerOutsidePane = false;
    // Never bloom the bottom-right orb while actively dragging a text selection across the editor.
    if (editorDragging || (pointerPressed && !untracked(hovered))) return;
    if (escapeSuppress) {
      const movedAway =
        escapePt !== undefined &&
        lastPanePt !== undefined &&
        Math.hypot(lastPanePt.x - escapePt.x, lastPanePt.y - escapePt.y) >= 10;
      if (!movedAway) return;
      escapeSuppress = false;
      escapePt = undefined;
    }
    cancelLeave();
    dismissed.set(false);
    const liveSel = props.readLiveSelection ? props.readLiveSelection() : untracked(props.liveSelection);
    if (liveSel) assistant.setPinnedSelection(liveSel);
    hovered.set(true);
  };

  const onPillLeave = (e?: { position?: { x: number; y: number } }) => {
    // On macOS, mounting or hovering the native multiline <Input> inside the
    // capsule triggers a spurious onMouseLeave on the parent View with an
    // interior coordinate. Ignore interior leaves; the pane bridge handles exits.
    if (isInsidePillLocal(e?.position)) return;
    scheduleLeave();
  };

  const onSurfaceLeave = () => {
    scheduleLeave();
  };

  const focusInput = () => {
    cancelLeave();
    escapeSuppress = false;
    escapePt = undefined;
    dismissed.set(false);
    const liveSel = props.readLiveSelection ? props.readLiveSelection() : untracked(props.liveSelection);
    if (liveSel) assistant.setPinnedSelection(liveSel);
    hovered.set(true);
    focused.set(true);
    controlsMounted.set(true);
    queueMicrotask(() => inputRef?.focus());
    setTimeout(() => inputRef?.focus(), 20);
  };

  const setPickerOpen = (id: OrbPickerId, open: boolean) => {
    if (open) {
      cancelLeave();
      escapeSuppress = false;
      escapePt = undefined;
      dismissed.set(false);
      openPicker.set(id);
      return;
    }
    if (untracked(openPicker) === id) {
      openPicker.set(null);
      if (pointerOutsidePane || (lastPanePt && !isPointInOrbRegion(lastPanePt.x, lastPanePt.y))) {
        cancelLeave();
        hovered.set(false);
      }
    }
  };

  const onPickerChosen = () => {
    openPicker.set(null);
    focusInput();
  };

  const submit = () => {
    if (untracked(composing)) return;
    const text = untracked(() => assistant.draft()).trim();
    if (!text) return;
    openPicker.set(null);
    void assistant.send(text, untracked(activeSelection));
  };

  const placeholderText = () => {
    const sel = activeSelection();
    if (sel?.text) return tr("Edit or ask about this selection…", "直接修改或询问选中内容…");
    if (props.doc.readOnly()) return tr("Ask AI about this document…", "就这篇文档向 AI 提问…");
    if (assistant.running()) return tr("Steer the edit…", "补充引导指令…");
    return tr("Edit this document or ask Pip…", "直接修改这篇文档，或向 Pip 提问…");
  };

  const showPlaceholder = () => !assistant.draft() && !composing();
  const showUnreadPearl = () => !expanded() && !assistant.running() && assistant.unread();
  const showOrbHalo = () => !expanded() && assistant.running();

  return (
    <View
      onLayout={(e) => {
        stackBox = {
          x: e.bounds.origin.x,
          y: e.bounds.origin.y,
          w: e.bounds.size.width,
          h: e.bounds.size.height,
        };
        const w = Math.round(e.bounds.size.width);
        if (w > 0 && Math.abs(w - untracked(paneW)) > 4) paneW.set(w);
      }}
      class="absolute inset-x-0 bottom-4 z-20 items-end pr-5"
      style={{ pointerEvents: "box-none" }}
    >
      {/* Floating streaming reply panel anchored right above the morphing bar */}
      <DocReplyCard
        doc={props.doc}
        assistant={assistant}
        open={() => assistant.replyOpen()}
        width={replyW}
        onPointerEnter={onEnter}
        onPointerLeave={onSurfaceLeave}
        onBounds={(box) => {
          replyBox = box;
        }}
        onApplied={() => {
          cancelLeave();
          openPicker.set(null);
          focused.set(false);
          hovered.set(false);
        }}
      />

      {/* Stationary hover envelope (never shifts vertically with `orbLiftY`, preventing bottom-edge hover bounce) */}
      <View
        class="relative"
        onLayout={(e) => {
          pillBox = {
            x: e.bounds.origin.x,
            y: e.bounds.origin.y,
            w: e.bounds.size.width,
            h: e.bounds.size.height,
          };
        }}
        onMouseEnter={onEnter}
        onMouseLeave={onPillLeave}
      >
        <View class="relative" style={{ transform: [{ translateY: orbLiftY }] }}>
          <View
            testID="doc-orb"
            accessibilityState={{ expanded: expanded() }}
            class={`relative items-end justify-end overflow-hidden ${ORB_SURFACE} ${
              focused() || pickerOpen() ? "border-hairline-focus shadow-composer-focus dark:shadow-composer-dark-focus" : ""
            }`}
            style={{
              ...GLASS_REGULAR,
              width: widthNow(),
              ...(settledOpen() ? {} : { height: heightNow() }),
              minHeight: ORB_SIZE,
              borderRadius: ORB_SIZE / 2,
              borderCurve: "continuous",
            }}
          >
            {/* Resting/working orbital cobalt progress halo anchored to the right Pip seat */}
            <OrbHalo active={showOrbHalo} />

            {/* Bottom-right anchored fixed-width mini-composer stage: blooms up & left out of Pip with zero text squish */}
            <View
              class="shrink-0"
              onLayout={(e) => {
                const h = Math.round(e.bounds.size.height);
                if (h >= ORB_SIZE && untracked(controlsMounted) && untracked(morph) >= 0.95) {
                  measuredExpandedH = h;
                }
              }}
              style={{ width: controlsMounted() ? expandedW() : ORB_SIZE }}
            >
              {/* Top prompt area: optional selection context chip + spacious full-width multiline input */}
              <If when={controlsMounted()}>
                <View
                  style={{
                    opacity: controlsOpacity,
                    transform: [{ translateX: controlsX }],
                  }}
                >
                  <If when={Boolean(activeSelection()?.text)}>
                    <View class="flex-row items-center pl-3.5 pr-3 pt-2.5">
                      <View
                        testID="doc-orb-selection-chip"
                        class="h-5.5 flex-row items-center gap-1 rounded-full bg-brand-soft pl-2 pr-1"
                      >
                        <Icon name="sparkle" size={11} tone="brand-text" />
                        <Text class={`${uiType("2xs")} font-medium text-brand-text`}>
                          {tr(
                            `${activeSelection()!.words} ${activeSelection()!.words === 1 ? "word" : "words"} selected`,
                            `已选 ${activeSelection()!.words} 字`,
                          )}
                        </Text>
                        <BaseButton
                          testID="doc-orb-clear-selection"
                          onPress={() => assistant.setPinnedSelection(undefined)}
                          accessibilityLabel={tr("Clear selection scope", "取消选中范围")}
                          class="size-4 items-center justify-center rounded-full hover:bg-brand/15"
                        >
                          <Icon name="x" size={10} tone="brand-text" />
                        </BaseButton>
                      </View>
                    </View>
                  </If>

                  <View class={`relative px-4 pb-0.5 ${activeSelection()?.text ? "pt-1.5" : "pt-3"}`}>
                    <Input
                      ref={(node) => {
                        inputRef = node ?? undefined;
                      }}
                      testID="doc-orb-input"
                      multiline
                      scrollbar={false}
                      value={assistant.draft()}
                      onChange={({ value }) => {
                        if (untracked(dismissed)) dismissed.set(false);
                        assistant.setDraft(value);
                      }}
                      onFocus={() => {
                        cancelLeave();
                        escapeSuppress = false;
                        escapePt = undefined;
                        focused.set(true);
                      }}
                      onBlur={() => {
                        focused.set(false);
                        if (
                          !untracked(pickerOpen) &&
                          (pointerOutsidePane || (lastPanePt && !isPointInOrbRegion(lastPanePt.x, lastPanePt.y)))
                        ) {
                          cancelLeave();
                          hovered.set(false);
                        }
                      }}
                      onSubmit={() => submit()}
                      onCompositionChange={({ composing: now }) => composing.set(now)}
                      onContentSizeChange={({ size }) => {
                        const next = Math.min(INPUT_MAX_H, Math.max(INPUT_MIN_H, Math.ceil(size.height)));
                        if (next !== untracked(inputH)) inputH.set(next);
                      }}
                      submitBehavior="submit"
                      autoCapitalize="none"
                      autoCorrect={false}
                      accessibilityLabel={tr("Document AI prompt", "文档 AI 输入框")}
                      class={`${uiType("base")} text-foreground caret-brand`}
                      style={{ height: Math.max(inputH(), uiRowHeight(INPUT_MIN_H)) }}
                    />
                    <If when={showPlaceholder()}>
                      <View
                        class={`pointer-events-none absolute inset-x-4 bottom-0.5 justify-center ${
                          activeSelection()?.text ? "top-1.5" : "top-3"
                        }`}
                      >
                        <Text class={`truncate ${uiType("base")} text-subtle`}>{placeholderText()}</Text>
                      </View>
                    </If>
                  </View>
                </View>
              </If>

              {/* Bottom toolbar row: Engine · Model · Effort left, Permission · Reply · Send/Stop · stationary Pip right */}
              <View class="h-[46px] flex-row items-center justify-end">
                <If when={controlsMounted()}>
                  <View
                    class="min-w-0 flex-1 flex-row items-center justify-between gap-2 pl-2.5 pr-0.5"
                    style={{
                      opacity: controlsOpacity,
                      transform: [{ translateX: controlsX }],
                    }}
                  >
                    <View class="min-w-0 flex-1 flex-row items-center gap-0.5">
                      <DocAgentPicker
                        assistant={assistant}
                        open={() => openPicker() === "agent"}
                        onOpenChange={(open) => setPickerOpen("agent", open)}
                        onChosen={onPickerChosen}
                      />
                      <DocModelPicker
                        assistant={assistant}
                        open={() => openPicker() === "model"}
                        onOpenChange={(open) => setPickerOpen("model", open)}
                        onChosen={onPickerChosen}
                      />
                      <DocThinkingPicker
                        assistant={assistant}
                        open={() => openPicker() === "thinking"}
                        onOpenChange={(open) => setPickerOpen("thinking", open)}
                        onChosen={onPickerChosen}
                      />
                    </View>

                    <View
                      class="shrink-0 flex-row items-center gap-1"
                      style={{ transform: [{ scale: rightScale }] }}
                    >
                      <DocPermissionPicker
                        assistant={assistant}
                        open={() => openPicker() === "permission"}
                        onOpenChange={(open) => setPickerOpen("permission", open)}
                        onChosen={onPickerChosen}
                      />

                      <If when={hasThread()}>
                        <BaseButton
                          testID="doc-orb-toggle-reply"
                          onPress={() => assistant.setReplyOpen(!assistant.replyOpen())}
                          accessibilityLabel={assistant.replyOpen() ? tr("Hide reply", "收起回复") : tr("Show reply", "查看回复")}
                          tooltip={tip(
                            assistant.replyOpen() ? tr("Hide reply", "收起回复") : tr("Show reply", "查看回复"),
                            undefined,
                            "top",
                          )}
                          class={`relative size-7 items-center justify-center rounded-full ${PRESS} ${PRESS_SCALE} ${FOCUS_RING} ${
                            assistant.replyOpen() ? "bg-accent" : "hover:bg-accent"
                          }`}
                        >
                          <Icon name="message" size={14} tone={assistant.replyOpen() ? "foreground" : "muted-foreground"} />
                          <Presence show={assistant.unread()} class="absolute right-1 top-1">
                            <View class="size-1.5 rounded-full bg-brand" />
                          </Presence>
                        </BaseButton>
                      </If>

                      <If
                        when={assistant.running() && !hasText()}
                        else={
                          <BaseButton
                            testID="doc-orb-send"
                            onPress={submit}
                            disabled={!hasText()}
                            accessibilityLabel={tr("Send", "发送")}
                            tooltip={tip(tr("Send", "发送"), "enter", "top")}
                            class={`size-7 items-center justify-center rounded-full ${PRESS} ${PRESS_SCALE} ${FOCUS_RING} ${
                              hasText() ? "bg-primary shadow-sm hover:bg-primary/90" : "bg-muted opacity-70"
                            }`}
                          >
                            <Icon name="arrowUp" size={14} tone={hasText() ? "brand-foreground" : "subtle"} />
                          </BaseButton>
                        }
                      >
                        <BaseButton
                          testID="doc-orb-stop"
                          onPress={() => void assistant.stop()}
                          accessibilityLabel={tr("Stop", "停止")}
                          tooltip={tip(tr("Stop generating", "停止生成"), undefined, "top")}
                          class={`size-7 items-center justify-center rounded-full bg-secondary ${PRESS} ${PRESS_SCALE} ${FOCUS_RING} hover:bg-destructive/15`}
                        >
                          <Icon name="stop" size={13} tone="foreground" />
                        </BaseButton>
                      </If>
                    </View>
                  </View>
                </If>

                {/* Right-anchored Pip orb seat: stays planted in the bottom-right corner throughout the 2D bloom */}
                <BaseButton
                  testID="doc-orb-trigger"
                  onPress={() => {
                    if (!expanded()) {
                      focusInput();
                    } else if (hasThread()) {
                      assistant.setReplyOpen(!assistant.replyOpen());
                    } else {
                      focusInput();
                    }
                  }}
                  accessibilityLabel={tr("Ask Pip", "问问 Pip")}
                  tooltip={
                    !expanded()
                      ? tip(tr("Ask Pip", "问问 Pip"), "mod+j", "top")
                      : hasThread()
                        ? tip(
                            assistant.replyOpen() ? tr("Hide reply", "收起回复") : tr("Show reply", "查看回复"),
                            undefined,
                            "top",
                          )
                        : undefined
                  }
                  class={`h-[46px] w-[46px] shrink-0 items-center justify-center rounded-full ${FOCUS_RING}`}
                >
                  <View style={{ transform: [{ scale: pipScale }] }}>
                    <Pip size={26} mood={assistant.mood()} />
                  </View>
                </BaseButton>
              </View>
            </View>
          </View>

          {/* Unread cobalt pearl resting cleanly on the outer rim of the collapsed orb */}
          <Presence
            show={showUnreadPearl()}
            testID="doc-orb-unread"
            class="pointer-events-none absolute -right-0.5 top-0.5"
          >
            <View class="size-2.5 rounded-full border-2 border-background bg-brand" />
          </Presence>
        </View>
      </View>
    </View>
  );
}
