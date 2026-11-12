import { Canvas, cleanup, createAnimatedValue, createMotion, effect, reduceMotion, token, View } from "nsh";
import type { CanvasRenderingContext2D } from "nsh";
import { pipCoat } from "../store/prefs";
import { BOUNDS, COATS, GRID, LINE_PAINT, pip, SPECIES, type CoatId, type Mood, type Paint, type Path, type Shape } from "./geometry";

export type { CoatId, Mood } from "./geometry";

/**
 * Pip, drawn from `geometry.ts` on a canvas `size` points wide (its height
 * follows the art: 50/64 of the width).
 *
 * The drawing is recorded once per mood; everything that moves is an animated
 * value the platform reads while it draws, so Pip blinks, floats, wags and breathes
 * on the UI thread with none of the app's code running per frame. `still`
 * draws Pip at rest with no loops, for marks that should not move (a title
 * bar, a list row). `coat` defaults to the one chosen in Settings.
 */
export function Pip(props: { size: number; mood?: Mood; coat?: CoatId; still?: boolean; class?: string }) {
  // How open the eyes are (1 open, 0 shut) and the tail's angle about its root, in radians.
  const lids = createAnimatedValue(1);
  const tail = createAnimatedValue(0);
  const body = createMotion();
  const mood = () => props.mood ?? "idle";
  let blinkTimer: ReturnType<typeof setTimeout> | undefined;

  const blink = () => {
    lids.keyframes([1, 0.08, 1], { duration: 170, easing: "easeInOut" });
    blinkTimer = setTimeout(blink, 2600 + Math.random() * 3200);
  };

  const rest = () => {
    clearTimeout(blinkTimer);
    lids.set(1);
    tail.set(0);
    body.reset();
  };

  effect(() => {
    const now = mood();
    const size = props.size;
    rest();
    if (props.still || reduceMotion()) return;
    const wag = (angle: number, duration: number, iterations: number | "infinite" = "infinite") =>
      tail.keyframes([0, -angle, 0, angle * 0.6, 0], { duration, easing: "easeInOut", iterations });
    switch (now) {
      case "idle":
        blinkTimer = setTimeout(blink, 1200 + Math.random() * 2000);
        body.play({ duration: 3600, iterations: "infinite", easing: "easeInOut", keyframes: { scaleY: [1, 1.03, 1] } });
        wag(0.12, 3600);
        break;
      case "think":
        blinkTimer = setTimeout(blink, 2000);
        body.play({ duration: 2200, iterations: "infinite", easing: "easeInOut", keyframes: { translateY: [0, -size * 0.045, 0], rotate: [0, -2.5, 0] } });
        break;
      case "work":
        // A ghost does not walk: it bobs, and the tail keeps time.
        wag(0.35, 620);
        body.play({ duration: 620, iterations: "infinite", easing: "easeInOut", keyframes: { translateY: [0, -size * 0.05, 0] } });
        break;
      case "write":
        wag(0.18, 300);
        body.play({ duration: 300, iterations: "infinite", easing: "easeInOut", keyframes: { translateY: [0, -size * 0.015, 0] } });
        break;
      case "happy":
        wag(0.4, 310, 2);
        body.play({
          duration: 620,
          keyframes: [
            { translateY: 0, scaleY: 1, scaleX: 1 },
            { offset: 0.18, translateY: 0, scaleY: 0.86, scaleX: 1.06, easing: "easeOut" },
            { offset: 0.5, translateY: -size * 0.2, scaleY: 1.06, scaleX: 0.97, easing: "easeIn" },
            { offset: 0.82, translateY: 0, scaleY: 0.92, scaleX: 1.04, easing: "easeOut" },
            { translateY: 0, scaleY: 1, scaleX: 1 },
          ],
        });
        break;
      case "error":
        body.play("headShake");
        break;
      case "sleep":
        body.play({ duration: 4200, iterations: "infinite", easing: "easeInOut", keyframes: { scaleY: [1, 1.045, 1] } });
        break;
    }
  });
  cleanup(rest);

  const paint = (p: Paint) => (p === LINE_PAINT ? token("pip-line") : p);

  const trace = (cx: CanvasRenderingContext2D, d: Extract<Shape, { kind: "path" }>["d"]) => {
    cx.beginPath();
    for (const c of d) {
      if (c[0] === "M") cx.moveTo(c[1], c[2]);
      else if (c[0] === "L") cx.lineTo(c[1], c[2]);
      else if (c[0] === "Q") cx.quadraticCurveTo(c[1], c[2], c[3], c[4]);
      else if (c[0] === "C") cx.bezierCurveTo(c[1], c[2], c[3], c[4], c[5], c[6]);
      else cx.closePath();
    }
  };

  const draw = (cx: CanvasRenderingContext2D, shape: Shape, silhouette: Path) => {
    if (shape.kind === "ellipse") {
      // An eye closes about its own middle: the lids scale its height.
      cx.beginPath();
      cx.ellipse(shape.cx, shape.cy, shape.rx, shape.lid ? lids.mul(shape.ry) : shape.ry, 0, 0, Math.PI * 2);
      cx.fillStyle = paint(shape.fill);
      cx.fill();
      return;
    }
    if (shape.clip) {
      // A coat marking: only inside the body.
      cx.save();
      trace(cx, silhouette.d);
      cx.clip();
    }
    trace(cx, shape.d);
    if (shape.fill) {
      cx.fillStyle = paint(shape.fill);
      cx.fill();
    }
    if (shape.stroke) {
      cx.strokeStyle = paint(shape.stroke);
      cx.lineWidth = shape.width ?? 2;
      cx.lineCap = "round";
      cx.lineJoin = "round";
      cx.stroke();
    }
    if (shape.clip) cx.restore();
  };

  const height = (props.size * BOUNDS.h) / GRID;
  return (
    <View class={props.class} style={{ width: props.size, height }} accessibilityLabel="Pip" role="image">
      <Canvas
        style={{ width: props.size, height, transformOrigin: "bottom", transform: body.transform }}
        draw={(cx, { width }) => {
          const scale = width / GRID;
          cx.scale(scale, scale);
          cx.translate(0, -BOUNDS.y);
          const coat = props.coat ?? pipCoat();
          const parts = SPECIES[COATS[coat].species];
          for (const shape of pip(mood(), coat)) {
            if (shape !== parts.tail) {
              draw(cx, shape, parts.body);
              continue;
            }
            // The tail swings about its root, behind the body.
            cx.save();
            cx.translate(parts.tailPivot[0], parts.tailPivot[1]);
            cx.rotate(tail);
            cx.translate(-parts.tailPivot[0], -parts.tailPivot[1]);
            draw(cx, parts.tail, parts.body);
            cx.restore();
          }
        }}
      />
    </View>
  );
}
