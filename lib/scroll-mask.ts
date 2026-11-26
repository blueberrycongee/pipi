const MASK_STEPS = 6;
const FADE_GAIN = 12;
const FADE_DEPTH = 16;

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const smooth = (t: number) => t * t * (3 - 2 * t);

function alphaHex(alpha: number): string {
  return Math.round(clamp01(alpha) * 255)
    .toString(16)
    .padStart(2, "0");
}

export function maskRamp(from: number, to: number, start: number, end: number): string[] {
  const stops: string[] = [];
  for (let i = 0; i <= MASK_STEPS; i++) {
    const t = i / MASK_STEPS;
    const at = Math.round((start + (end - start) * t) * 10) / 10;
    stops.push(`#000000${alphaHex(from + (to - from) * smooth(t))} ${at}px`);
  }
  return stops;
}

export function edgeFadeMask(height: number, hiddenAbove: number, hiddenBelow: number): string | undefined {
  if (height <= 0) return undefined;
  const topVisible = 1 - clamp01(hiddenAbove / FADE_GAIN);
  const bottomVisible = 1 - clamp01(hiddenBelow / FADE_GAIN);
  if (topVisible >= 1 && bottomVisible >= 1) return undefined;
  const depth = Math.min(FADE_DEPTH, height / 3);
  const stops = [
    ...maskRamp(topVisible, 1, 0, depth),
    ...maskRamp(1, bottomVisible, height - depth, height),
  ];
  return `linear-gradient(to bottom, ${stops.join(", ")})`;
}
