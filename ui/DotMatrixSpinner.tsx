import { Animated, Canvas, cleanup, createAnimatedValue, Easing as NativeEasing, effect, reduceMotion, token, View } from "nsh";

/**
 * A neutral dot-matrix loader: eight dots on the outer ring of a 3×3 matrix,
 * stepping clockwise in 90ms frames. It is vector-drawn on Canvas (replayed by
 * the platform at screen resolution), so the dots stay sharp on Retina screens.
 * Reduced motion holds one clean static frame.
 */
export function DotMatrixSpinner(props: { size?: number; class?: string }) {
  const size = props.size ?? 14;
  const frames = 8;
  const phase = createAnimatedValue(0);

  effect(() => {
    if (reduceMotion()) {
      void phase.stop();
      phase.set(0);
      return;
    }
    phase.set(0);
    const animation = Animated.keyframes(phase, {
      keyframes: [0, frames],
      duration: frames * 90,
      easing: NativeEasing.steps(frames, "jump-end"),
      iterations: "infinite",
      frameRate: 15,
    });
    void animation.start();
    cleanup(() => animation.stop());
  });
  cleanup(() => void phase.stop());

  // Clockwise from top-center. `distance` is how many steps behind the live dot
  // this dot is: full ink, then a short two-dot tail, then the quiet matrix.
  const dots = [
    [1, 0],
    [2, 0],
    [2, 1],
    [2, 2],
    [1, 2],
    [0, 2],
    [0, 1],
    [0, 0],
  ] as const;
  const opacities = dots.map((_, index) =>
    Animated.modulo(Animated.subtract(phase, index), frames).interpolate({
      inputRange: [0, 1, 2, 3, frames - 0.001, frames],
      outputRange: [1, 0.58, 0.34, 0.2, 0.2, 1],
      extrapolate: "clamp",
    }),
  );

  return (
    <View class={props.class} style={{ width: size, height: size }} accessibilityElementsHidden>
      <Canvas
        style={{ width: size, height: size }}
        draw={(cx, { width }) => {
          const scale = width / 14;
          cx.scale(scale, scale);
          cx.fillStyle = token("muted-foreground");
          for (let i = 0; i < dots.length; i++) {
            const [col, row] = dots[i];
            cx.globalAlpha = opacities[i];
            cx.beginPath();
            cx.arc(3 + col * 4, 3 + row * 4, 1.18, 0, Math.PI * 2);
            cx.fill();
          }
          cx.globalAlpha = 1;
        }}
      />
    </View>
  );
}
