import { cleanup, createAnimatedValue, effect, Image, reduceMotion, signal, Text, untracked, View } from "nsh";
import type { KeyEvent, PinchEvent, PressEvent, ViewRef, WheelEvent } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { tr } from "../lib/i18n";
import type { ImageDimensions } from "../lib/image-size";
import { clampPan, clampZoom, maxZoom, sampleBezier, stepZoom, toggleZoom, wheelScale, zoomAtPoint, zoomPercent } from "../lib/image-zoom";
import { IconButton } from "../ui/Button";
import { POPUP, PRESS, PRESS_SCALE } from "../ui/styles";
import { tip } from "../ui/Tip";
import { uiType } from "../ui/typography";

/**
 * The zoom layer's image viewer: the picture in a fixed viewport it exactly
 * fits, magnified and panned inside it —
 *
 * - the wheel or a pinch zooms at the pointer, continuously;
 * - a drag pans what no longer fits;
 * - a double press dives to the picture's own pixels and back to the fit;
 * - the pill at the foot steps out and in and says the scale — its middle
 *   resets to the fit — and `+` / `−` / `0` and the arrows play the keyboard.
 *
 * The transform is the compositor's (`scale` + `translate` on animated values,
 * origin the top left corner: `screen = content × z + t`); gestures only set
 * values, so a stream of wheel or pinch events never re-renders — the
 * readout's one text aside.
 */

const ZOOM_MS = 180;
/** The curve zoom transitions play, sampled in `interrupt` with the same math. */
const ZOOM_EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];
/** A press this soon after a drag ended is the drag's tail, not a click. */
const DRAG_TAIL_MS = 250;
/** Two presses within this long and this far are a double press. */
const DOUBLE_MS = 350;
const DOUBLE_PT = 8;
/** A drag starts past this many points, so a clicking hand's tremor pans nothing. */
const DRAG_PT = 3;

export function ZoomImage(props: { src: string; title?: string; natural?: ImageDimensions; box: ImageDimensions }) {
  const box = untracked(() => props.box);
  /** What the picture itself said on load, for when no metadata knew it. */
  let measured: ImageDimensions | undefined;
  const natural = () => untracked(() => props.natural) ?? measured;
  const naturalScale = () => {
    const n = natural();
    return n && n.width > 0 && box.width > 0 ? n.width / box.width : 1;
  };
  const fitScale = () => {
    const n = natural();
    return n && n.width > 0 ? box.width / n.width : 1;
  };
  const maxZ = () => maxZoom(naturalScale());

  const zv = createAnimatedValue(1);
  const txv = createAnimatedValue(0);
  const tyv = createAnimatedValue(0);
  /** The zoom as it stands — the target while a transition is flying. */
  let z = 1;
  let tx = 0;
  let ty = 0;
  const percent = signal(zoomPercent(1, fitScale()));
  const zoomed = signal(false);
  const panning = signal(false);

  function readout() {
    percent.set(zoomPercent(z, fitScale()));
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
    const z1 = clampZoom(z1raw, maxZ());
    land(zoomAtPoint({ z, tx, ty }, z1, ax, ay, box), animated);
  }

  const center = () => ({ x: box.width / 2, y: box.height / 2 });

  function stepBy(dir: 1 | -1) {
    const z1 = stepZoom(z, dir, naturalScale(), maxZ());
    if (z1 === z) return;
    const c = center();
    applyZoom(z1, c.x, c.y, true);
    viewportRef?.focus();
  }

  function resetToFit() {
    if (z === 1) return;
    interrupt();
    land(clampPan({ z: 1, tx: 0, ty: 0 }, box), true);
    viewportRef?.focus();
  }

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
    const next = clampPan({ z, tx: tx1, ty: ty1 }, box);
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
      const z1 = toggleZoom(z, naturalScale(), maxZ());
      applyZoom(z1, e.position.x, e.position.y, true);
      return;
    }
    lastPressAt = now;
    lastPressX = e.position.x;
    lastPressY = e.position.y;
  }

  function onKeyDown(e: KeyEvent) {
    const key = e.key;
    if (key === "+" || key === "=") return stepBy(1);
    if (key === "-" || key === "_") return stepBy(-1);
    if (key === "0") return resetToFit();
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
      }, ms)
    );
    cleanup(() => timers.forEach(clearTimeout));
  });

  const cursor = () => (panning() ? "grabbing" : zoomed() ? "grab" : "zoom-in");
  const showPill = box.width >= 220 && box.height >= 140;

  return (
    <View class="w-full items-center justify-center">
      <View
        ref={(r) => {
          viewportRef = r;
        }}
        testID="zoom-image-viewport"
        focusable
        captureKeys={["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]}
        accessibilityLabel={props.title ?? tr("Image preview", "图片预览")}
        class="overflow-hidden rounded-lg corner-squircle bg-sunken"
        style={{ width: box.width, height: box.height, cursor: cursor() }}
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
            width: box.width,
            height: box.height,
            transformOrigin: "top left",
            scale: zv,
            translate: [txv, tyv],
          }}
        >
          <Image
            src={props.src}
            style={{ width: box.width, height: box.height, objectFit: "contain" }}
            accessibilityLabel={props.title}
            onLoad={(e) => {
              if (untracked(() => props.natural) || measured) return;
              measured = { width: e.size.width, height: e.size.height };
              readout();
            }}
          />
        </View>
        <If when={showPill}>
          <View class="pointer-events-none absolute inset-x-0 bottom-2 items-center">
            <View class={`pointer-events-auto flex-row items-center gap-0.5 rounded-full px-1 py-0.5 ${POPUP}`} testID="zoom-controls">
              <IconButton icon="minus" size="sm" label={tr("Zoom out", "缩小")} disabled={!zoomed()} onPress={() => stepBy(-1)} />
              <BaseButton
                onPress={resetToFit}
                disabled={!zoomed()}
                accessibilityLabel={tr("Reset zoom", "重置缩放")}
                tooltip={tip(tr("Reset zoom", "重置缩放"))}
                class={`rounded-md corner-squircle px-1.5 py-0.5 ${PRESS} ${PRESS_SCALE} hover:bg-accent/45 disabled:opacity-65`}
              >
                <Text class={`${uiType("xs")} tabular-nums text-muted-foreground`}>{`${percent()}%`}</Text>
              </BaseButton>
              <IconButton icon="plus" size="sm" label={tr("Zoom in", "放大")} disabled={percent() >= zoomPercent(maxZ(), fitScale())} onPress={() => stepBy(1)} />
            </View>
          </View>
        </If>
      </View>
    </View>
  );
}
