import manifest from "../nsh.json";
import { codeSize, FONT_SIZES, readingSize } from "../store/prefs";

const scale = manifest.tailwind.fontSize;

/** Keep the type ladder and its line-height ratios; at the default use the original token verbatim. */
export function readingType(token: keyof typeof scale = "md"): string {
  const ratio = readingSize() / FONT_SIZES.reading.default;
  if (ratio === 1) return `text-${token}`;
  const [points, leading] = scale[token];
  return `text-[${Math.round(points * ratio)}px]/[${leading}]`;
}

export function codeType(): string {
  return codeSize() === FONT_SIZES.code.default ? "text-xs" : `text-[${codeSize()}px]/[${scale.xs[1]}]`;
}
