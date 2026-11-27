import { cleanup, createAnimatedValue, effect, Image, platform, reduceMotion, Scroll, signal, Text, untracked, View, windowSize } from "nsh";
import type { KeyEvent, PinchEvent, PressEvent, ViewRef, WheelEvent } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { tr } from "../lib/i18n";
import { fitImageBox, type ImageDimensions } from "../lib/image-size";
import { clampPan, clampZoom, maxZoom, sampleBezier, stepZoom, toggleZoom, wheelScale, zoomAtPoint, zoomPercent } from "../lib/image-zoom";
import { IconButton } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { FOCUS_RING, GLASS_REGULAR, POPUP, PRESS, PRESS_SCALE } from "../ui/styles";
import { tip } from "../ui/Tip";
import { uiType } from "../ui/typography";

/**
 * The zoom layer's image viewer: either a fixed-box viewport (for standalone
 * stages and tests) or a full-stage lightbox filling the window sheet —
 *
 * - opens fitted cleanly to the live stage, resizing with the window;
 * - the wheel or a pinch zooms at the pointer, continuously, expanding across
 *   the full stage when magnified;
 * - a drag pans what no longer fits;
 * - a double press dives to the picture's own pixels and back to the fit;
 * - when viewing a photo from a multi-image stream, `←` / `→` (at fit, or
 *   with Cmd/Ctrl / `[` / `]`), side chevrons, and the bottom thumbnail
 *   filmstrip switch smoothly between neighboring photos;
 * - `+` / `−` / `0` and the bottom zoom pill step, read out, and reset scale
 *   without ever covering image pixels in stage mode.
 *
 * The transform is the compositor's (`scale` + `translate` on animated values,
 * origin the top left corner: `screen = content × z + t`); gestures only set
 * values, so a stream of wheel or pinch events never re-renders — the
 * readout's one text aside.
 */

const ZOOM_MS = 180;
/** Subtle settle when switching between gallery photos. */
const SWITCH_MS = 110;
/** The curve zoom transitions play, sampled in `interrupt` with the same math. */
const ZOOM_EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];
/** A press this soon after a drag ended is the drag's tail, not a click. */
const DRAG_TAIL_MS = 250;
/** Two presses within this long and this far are a double press. */
const DOUBLE_MS = 350;
const DOUBLE_PT = 8;
/** A drag starts past this many points, so a clicking hand's tremor pans nothing. */
const DRAG_PT = 3;

export interface ZoomGalleryEntry {
  id: string;
  src: string;
  title?: string;
}

function estimateStageSize(hasGallery: boolean): ImageDimensions {
  const win = untracked(windowSize);
  const w = Math.max(320, (win.width || 1120) - 24);
  const topPad = platform.os === "macos" ? 44 : 12;
  const footerH = hasGallery ? 56 : 44;
  const h = Math.max(240, (win.height || 820) - topPad - 12 - 44 - footerH);
  return { width: w, height: h };
}

export function ZoomImage(props: {
  src: string;
  title?: string;
  natural?: ImageDimensions;
  /** Explicit fixed viewport box (standalone stage mode). Omit to fill the live lightbox stage. */
  box?: ImageDimensions;
  /** Optional ordered image strip for multi-image navigation in stage mode. */
  gallery?: readonly ZoomGalleryEntry[];
  activeIndex?: number;
  canPrev?: boolean;
  canNext?: boolean;
  onPrev?: () => void;
  onNext?: () => void;
  onSelectIndex?: (index: number) => void;
  onMeasureNatural?: (dims: ImageDimensions) => void;
  onClose?: () => void;
}) {
  const isStage = () => props.box === undefined;
  const hasGallery = () => (props.gallery?.length ?? 0) > 1;
  const stageSize = signal<ImageDimensions>(estimateStageSize(untracked(hasGallery)));
  /** What the picture itself said on load, for when no metadata knew it. */
  const measured = signal<ImageDimensions | undefined>(undefined);

  const natural = () => props.natural ?? measured();

  const contentBox = (): ImageDimensions => {
    if (props.box) return props.box;
    const s = stageSize();
    // Reserve clean side gutters for circular prev/next buttons so controls never cover the fitted photo.
    const padX = hasGallery() ? 120 : 36;
    const padY = 28;
    const maxWidth = Math.max(160, Math.floor(s.width - padX));
    const maxHeight = Math.max(120, Math.floor(s.height - padY));
    return fitImageBox(natural(), {
      maxWidth,
      maxHeight,
      fallback: { width: Math.min(maxWidth, 840), height: Math.min(maxHeight, 560) },
      upscale: false,
    });
  };

  const viewBox = (): ImageDimensions => props.box ?? stageSize();

  const naturalScale = () => {
    const n = natural();
    const c = contentBox();
    return n && n.width > 0 && c.width > 0 ? n.width / c.width : 1;
  };
  const fitScale = () => {
    const n = natural();
    const c = contentBox();
    return n && n.width > 0 ? c.width / n.width : 1;
  };
  const maxZ = () => maxZoom(naturalScale());

  const initialPose = clampPan({ z: 1, tx: 0, ty: 0 }, untracked(contentBox), untracked(viewBox));
  const zv = createAnimatedValue(initialPose.z);
  const txv = createAnimatedValue(initialPose.tx);
  const tyv = createAnimatedValue(initialPose.ty);
  const imageOpacity = createAnimatedValue(1);
  /** The zoom as it stands — the target while a transition is flying. */
  let z = initialPose.z;
  let tx = initialPose.tx;
  let ty = initialPose.ty;
  const percent = signal(zoomPercent(1, untracked(fitScale)));
  const zoomed = signal(false);
  const panning = signal(false);

  function readout() {
    percent.set(zoomPercent(z, untracked(fitScale)));
    zoomed.set(z > 1.001);
  }

  // ── Zoom state transitions ────────────────────────────────────────────────

  let viewportRef: ViewRef | undefined;
  let anim: { z0: number; tx0: number; ty0: number; at: number } | undefined;

  /** Interrupts a running zoom transition where it visibly is, so what comes next picks it up without a jump. */
  function interrupt() {
    if (!anim) return;
    const t = Math.min(1, (Date.now() - anim.at) / ZOOM_MS);
    const e = sampleBezier(ZOOM_EASE, t);
    const zNow = anim.z0 + (z - anim.z0) * e;
    const txNow = anim.tx0 + (tx - anim.tx0) * e;
    const tyNow = anim.ty0 + (ty - anim.ty0) * e;
    anim = undefined;
    void zv.stop();
    void txv.stop();
    void tyv.stop();
    z = zNow;
    tx = txNow;
    ty = tyNow;
    zv.set(z);
    txv.set(tx);
    tyv.set(ty);
  }

  /** Lands the zoom at `next`: at once for a gesture, in a short settle for buttons, keys and double presses. */
  function land(next: { z: number; tx: number; ty: number }, animated: boolean) {
    const z0 = z;
    const tx0 = tx;
    const ty0 = ty;
    z = next.z;
    tx = next.tx;
    ty = next.ty;
    if (animated && !untracked(reduceMotion)) {
      anim = { z0, tx0, ty0, at: Date.now() };
      void zv.timing(z, { duration: ZOOM_MS, easing: ZOOM_EASE });
      void txv.timing(tx, { duration: ZOOM_MS, easing: ZOOM_EASE });
      void tyv.timing(ty, { duration: ZOOM_MS, easing: ZOOM_EASE });
    } else {
      anim = undefined;
      zv.set(z);
      txv.set(tx);
      tyv.set(ty);
    }
    readout();
  }

  /** Zooms to `z1` keeping the content point under (`ax`, `ay`) there. */
  function applyZoom(z1raw: number, ax: number, ay: number, animated: boolean) {
    interrupt();
    const z1 = clampZoom(z1raw, untracked(maxZ));
    land(zoomAtPoint({ z, tx, ty }, z1, ax, ay, untracked(contentBox), untracked(viewBox)), animated);
  }

  const center = () => {
    const v = untracked(viewBox);
    return { x: v.width / 2, y: v.height / 2 };
  };

  function focusViewport() {
    viewportRef?.focus();
    queueMicrotask(() => viewportRef?.focus());
  }

  function stepBy(dir: 1 | -1) {
    const z1 = stepZoom(z, dir, untracked(naturalScale), untracked(maxZ));
    if (z1 === z) return;
    const c = center();
    applyZoom(z1, c.x, c.y, true);
    focusViewport();
  }

  function resetToFit() {
    if (z === 1) return;
    interrupt();
    land(clampPan({ z: 1, tx: 0, ty: 0 }, untracked(contentBox), untracked(viewBox)), true);
    focusViewport();
  }

  // Reset zoom cleanly when switching images, while keeping `viewportRef` mounted & focused.
  let trackedSrc = untracked(() => props.src);
  effect(() => {
    const nextSrc = props.src;
    if (nextSrc === trackedSrc) return;
    trackedSrc = nextSrc;
    untracked(() => {
      interrupt();
      drag = undefined;
      panning.set(false);
      measured.set(undefined);
      const nextPose = clampPan({ z: 1, tx: 0, ty: 0 }, contentBox(), viewBox());
      z = nextPose.z;
      tx = nextPose.tx;
      ty = nextPose.ty;
      zv.set(z);
      txv.set(tx);
      tyv.set(ty);
      readout();
      if (!reduceMotion()) {
        void imageOpacity.stop();
        imageOpacity.set(0.72);
        void imageOpacity.timing(1, { duration: SWITCH_MS, easing: ZOOM_EASE });
      }
    });
  });

  // Re-center / re-clamp seamlessly when stage size or natural dimensions update.
  effect(() => {
    const c = contentBox();
    const v = viewBox();
    // Subscribe to natural() so readout updates as soon as metadata or onLoad arrives.
    natural();
    untracked(() => {
      if (anim) return;
      const clamped = clampPan({ z: clampZoom(z, maxZ()), tx, ty }, c, v);
      if (Math.abs(clamped.z - z) > 0.0005 || Math.abs(clamped.tx - tx) > 0.5 || Math.abs(clamped.ty - ty) > 0.5) {
        z = clamped.z;
        tx = clamped.tx;
        ty = clamped.ty;
        zv.set(z);
        txv.set(tx);
        tyv.set(ty);
      }
      readout();
    });
  });

  // ── Gestures ──────────────────────────────────────────────────────────────

  function onWheel(e: WheelEvent) {
    const factor = wheelScale(e.delta.y, e.deltaMode);
    if (factor === 1) return;
    applyZoom(z * factor, e.position.x, e.position.y, false);
  }

  function onPinch(e: PinchEvent) {
    if (!e.delta) return;
    applyZoom(z * (1 + e.delta), e.position.x, e.position.y, false);
  }

  let drag: { x: number; y: number; tx: number; ty: number; moved: boolean } | undefined;
  let lastDragEndAt = 0;
  let lastPressAt = 0;
  let lastPressX = 0;
  let lastPressY = 0;

  function panTo(tx1: number, ty1: number) {
    const next = clampPan({ z, tx: tx1, ty: ty1 }, untracked(contentBox), untracked(viewBox));
    tx = next.tx;
    ty = next.ty;
    txv.set(tx);
    tyv.set(ty);
  }

  function moveDrag(x: number, y: number) {
    if (!drag) return;
    const dx = x - drag.x;
    const dy = y - drag.y;
    if (!drag.moved && Math.abs(dx) < DRAG_PT && Math.abs(dy) < DRAG_PT) return;
    if (!drag.moved) {
      drag.moved = true;
      panning.set(true);
    }
    panTo(drag.tx + dx, drag.ty + dy);
  }

  function endDrag() {
    if (!drag) return;
    if (drag.moved) {
      lastDragEndAt = Date.now();
      panning.set(false);
    }
    drag = undefined;
  }

  function onPress(e: PressEvent) {
    if (drag?.moved) return;
    const now = Date.now();
    if (now - lastDragEndAt < DRAG_TAIL_MS) {
      lastPressAt = 0;
      return;
    }
    const near = Math.abs(e.position.x - lastPressX) < DOUBLE_PT && Math.abs(e.position.y - lastPressY) < DOUBLE_PT;
    if (lastPressAt && now - lastPressAt < DOUBLE_MS && near) {
      lastPressAt = 0;
      const z1 = toggleZoom(z, untracked(naturalScale), untracked(maxZ));
      applyZoom(z1, e.position.x, e.position.y, true);
      return;
    }
    lastPressAt = now;
    lastPressX = e.position.x;
    lastPressY = e.position.y;
  }

  function onKeyDown(e: KeyEvent) {
    const key = e.key;
    if (key === "Escape") {
      props.onClose?.();
      return;
    }
    if (key === "+" || key === "=") return stepBy(1);
    if (key === "-" || key === "_") return stepBy(-1);
    if (key === "0") return resetToFit();
    const navChord = e.modifiers.platform || e.modifiers.control;
    if (key === "[" || (key === "ArrowLeft" && (z <= 1.001 || navChord))) {
      if (props.canPrev) props.onPrev?.();
      return;
    }
    if (key === "]" || (key === "ArrowRight" && (z <= 1.001 || navChord))) {
      if (props.canNext) props.onNext?.();
      return;
    }
    if (key === "Home" && z <= 1.001 && hasGallery()) {
      props.onSelectIndex?.(0);
      return;
    }
    if (key === "End" && z <= 1.001 && hasGallery()) {
      props.onSelectIndex?.((props.gallery?.length ?? 1) - 1);
      return;
    }
    const step = e.modifiers.shift ? 240 : 80;
    if (key === "ArrowLeft") return panBy(step, 0);
    if (key === "ArrowRight") return panBy(-step, 0);
    if (key === "ArrowUp") return panBy(0, step);
    if (key === "ArrowDown") return panBy(0, -step);
  }

  function panBy(dx: number, dy: number) {
    if (z <= 1) return;
    interrupt();
    panTo(tx + dx, ty + dy);
  }

  // The keyboard plays on the viewport: it takes the focus as the layer opens.
  // The window's own focus chain is only ready a beat after mount (an earlier
  // `focus()` reports yet types nowhere), so the ask repeats until it lands.
  let focused = false;
  effect(() => {
    const timers = [0, 80, 200, 400].map((ms) =>
      setTimeout(() => {
        if (!focused) viewportRef?.focus();
      }, ms),
    );
    cleanup(() => timers.forEach(clearTimeout));
  });

  cleanup(() => {
    void zv.stop();
    void txv.stop();
    void tyv.stop();
    void imageOpacity.stop();
  });

  const cursor = () => (panning() ? "grabbing" : zoomed() ? "grab" : "zoom-in");
  const atMaxZoom = () => percent() >= zoomPercent(maxZ(), fitScale());

  const zoomPill = (surfaceClass: string) => (
    <View class={`flex-row items-center gap-0.5 rounded-full px-1 py-0.5 ${surfaceClass}`} testID="zoom-controls">
      <IconButton icon="minus" size="sm" label={tr("Zoom out", "缩小")} disabled={!zoomed()} onPress={() => stepBy(-1)} />
      <BaseButton
        onPress={resetToFit}
        disabled={!zoomed()}
        accessibilityLabel={tr("Reset zoom", "重置缩放")}
        tooltip={tip(tr("Reset zoom", "重置缩放"), "0", isStage() ? "top" : "bottom")}
        class={`rounded-md corner-squircle px-1.5 py-0.5 ${PRESS} ${PRESS_SCALE} hover:bg-accent/45 disabled:opacity-65`}
      >
        <Text class={`${uiType("xs")} tabular-nums text-muted-foreground`}>{`${percent()}%`}</Text>
      </BaseButton>
      <IconButton icon="plus" size="sm" label={tr("Zoom in", "放大")} disabled={atMaxZoom()} onPress={() => stepBy(1)} />
    </View>
  );

  // ── Standalone Fixed-Box Mode (ZoomStage / unit stages) ───────────────────

  if (!isStage()) {
    const fixedBox = props.box!;
    const showPill = fixedBox.width >= 220 && fixedBox.height >= 140;
    return (
      <View class="w-full items-center justify-center">
        <View
          ref={(r) => {
            viewportRef = r;
          }}
          testID="zoom-image-viewport"
          focusable
          captureKeys={["Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]}
          accessibilityLabel={props.title ?? tr("Image preview", "图片预览")}
          class="overflow-hidden rounded-lg corner-squircle bg-sunken"
          style={{ width: fixedBox.width, height: fixedBox.height, cursor: cursor() }}
          onWheel={onWheel}
          onPinch={onPinch}
          onPress={onPress}
          onPressDown={(e) => {
            interrupt();
            drag = { x: e.position.x, y: e.position.y, tx, ty, moved: false };
          }}
          onMouseUp={endDrag}
          onMouseMove={(e) => {
            if (!drag) return;
            if (e.pressedButton !== "left") return endDrag();
            moveDrag(e.position.x, e.position.y);
          }}
          onKeyDown={onKeyDown}
          onFocus={() => {
            focused = true;
          }}
          onBlur={() => {
            focused = false;
          }}
        >
          <View
            style={{
              width: fixedBox.width,
              height: fixedBox.height,
              transformOrigin: "top left",
              scale: zv,
              translate: [txv, tyv],
            }}
          >
            <Image
              src={props.src}
              style={{ width: fixedBox.width, height: fixedBox.height, objectFit: "contain" }}
              accessibilityLabel={props.title}
              onLoad={(e) => {
                if (untracked(() => props.natural) || untracked(measured)) return;
                if (e.size.width > 0 && e.size.height > 0) {
                  measured.set({ width: e.size.width, height: e.size.height });
                }
              }}
            />
          </View>
          <If when={showPill}>
            <View class="pointer-events-none absolute inset-x-0 bottom-2 items-center">
              <View class="pointer-events-auto">{zoomPill(POPUP)}</View>
            </View>
          </If>
        </View>
      </View>
    );
  }

  // ── Full-Stage Lightbox Mode ──────────────────────────────────────────────

  return (
    <View class="min-h-0 size-full">
      <View
        class="relative min-h-0 w-full flex-1 bg-sunken/55"
        onLayout={(e) => {
          const w = Math.round(e.bounds.size.width);
          const h = Math.round(e.bounds.size.height);
          if (w > 0 && h > 0) {
            const cur = untracked(stageSize);
            if (cur.width !== w || cur.height !== h) stageSize.set({ width: w, height: h });
          }
        }}
      >
        <View
          ref={(r) => {
            viewportRef = r;
          }}
          testID="zoom-image-viewport"
          focusable
          captureKeys={["Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]}
          accessibilityLabel={props.title ?? tr("Image preview", "图片预览")}
          class="size-full overflow-hidden"
          style={{ cursor: cursor() }}
          onWheel={onWheel}
          onPinch={onPinch}
          onPress={onPress}
          onPressDown={(e) => {
            interrupt();
            drag = { x: e.position.x, y: e.position.y, tx, ty, moved: false };
          }}
          onMouseUp={endDrag}
          onMouseMove={(e) => {
            if (!drag) return;
            if (e.pressedButton !== "left") return endDrag();
            moveDrag(e.position.x, e.position.y);
          }}
          onKeyDown={onKeyDown}
          onFocus={() => {
            focused = true;
          }}
          onBlur={() => {
            focused = false;
          }}
        >
          <View
            class="overflow-hidden rounded-lg corner-squircle border-[0.5px] border-hairline-hover bg-card/30 shadow-sm"
            style={{
              width: contentBox().width,
              height: contentBox().height,
              transformOrigin: "top left",
              scale: zv,
              translate: [txv, tyv],
              opacity: imageOpacity,
            }}
          >
            <Image
              src={props.src}
              style={{ width: contentBox().width, height: contentBox().height, objectFit: "contain" }}
              accessibilityLabel={props.title}
              onLoad={(e) => {
                if (e.size.width > 0 && e.size.height > 0) {
                  const dims = { width: e.size.width, height: e.size.height };
                  measured.set(dims);
                  props.onMeasureNatural?.(dims);
                }
              }}
            />
          </View>
        </View>

        <If when={hasGallery()}>
          <View class="pointer-events-none absolute inset-y-0 left-3 justify-center">
            <BaseButton
              testID="zoom-prev"
              disabled={!props.canPrev}
              onPress={() => {
                props.onPrev?.();
                focusViewport();
              }}
              accessibilityLabel={tr("Previous image", "上一张图片")}
              tooltip={props.canPrev ? tip(tr("Previous", "上一张"), "ArrowLeft", "right") : undefined}
              class={`pointer-events-auto size-9 items-center justify-center rounded-full border-[0.5px] border-hairline-hover bg-popover/85 shadow-sm hover:bg-popover disabled:opacity-25 ${PRESS} ${PRESS_SCALE} ${FOCUS_RING}`}
              style={GLASS_REGULAR}
            >
              <Icon name="chevronLeft" size={16} tone="foreground" />
            </BaseButton>
          </View>
          <View class="pointer-events-none absolute inset-y-0 right-3 justify-center">
            <BaseButton
              testID="zoom-next"
              disabled={!props.canNext}
              onPress={() => {
                props.onNext?.();
                focusViewport();
              }}
              accessibilityLabel={tr("Next image", "下一张图片")}
              tooltip={props.canNext ? tip(tr("Next", "下一张"), "ArrowRight", "left") : undefined}
              class={`pointer-events-auto size-9 items-center justify-center rounded-full border-[0.5px] border-hairline-hover bg-popover/85 shadow-sm hover:bg-popover disabled:opacity-25 ${PRESS} ${PRESS_SCALE} ${FOCUS_RING}`}
              style={GLASS_REGULAR}
            >
              <Icon name="chevronRight" size={16} tone="foreground" />
            </BaseButton>
          </View>
        </If>
      </View>

      <If
        when={hasGallery()}
        else={
          <View class="h-11 shrink-0 flex-row items-center justify-center border-t-[0.5px] border-hairline px-3.5">
            {zoomPill("border-[0.5px] border-hairline bg-secondary/70")}
          </View>
        }
      >
        <View class="h-14 shrink-0 flex-row items-center gap-3 border-t-[0.5px] border-hairline px-3.5">
          <Scroll horizontal class="min-w-0 flex-1" contentClass="flex-row items-center gap-1.5 py-2">
            <Each of={props.gallery ?? []} key={(item) => item.id}>
              {(item, i) => {
                const active = () => i() === props.activeIndex;
                return (
                  <BaseButton
                    testID="zoom-thumb"
                    onPress={() => {
                      props.onSelectIndex?.(i());
                      focusViewport();
                    }}
                    accessibilityLabel={item().title || tr(`Image ${i() + 1}`, `第 ${i() + 1} 张图片`)}
                    tooltip={active() ? undefined : tip(item().title || tr(`Image ${i() + 1}`, `第 ${i() + 1} 张图片`), undefined, "top")}
                    class={`relative h-9 w-12 shrink-0 overflow-hidden rounded-md corner-squircle bg-sunken ${PRESS} ${PRESS_SCALE} ${FOCUS_RING} ${
                      active() ? "opacity-100 ring-2 ring-foreground/70" : "border-[0.5px] border-hairline opacity-55 hover:opacity-90"
                    }`}
                  >
                    <Image src={item().src} class="size-full" style={{ objectFit: "cover" }} accessibilityElementsHidden />
                  </BaseButton>
                );
              }}
            </Each>
          </Scroll>
          <View class="shrink-0">{zoomPill("border-[0.5px] border-hairline bg-secondary/70")}</View>
        </View>
      </If>
    </View>
  );
}
