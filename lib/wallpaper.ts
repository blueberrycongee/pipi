import type { Theme } from "nsh";
import themeJson from "../theme.json";

export type WallpaperEffect = "none" | "dither" | "ascii" | "halftone" | "scanlines";

export const WALLPAPER_EFFECTS: readonly WallpaperEffect[] = [
  "none",
  "dither",
  "ascii",
  "halftone",
  "scanlines",
] as const;

export function isWallpaperEffect(v: unknown): v is WallpaperEffect {
  return typeof v === "string" && (WALLPAPER_EFFECTS as readonly string[]).includes(v);
}

export interface WallpaperAdjustment {
  /** Normalized horizontal focal point in `0.0..=1.0` (`0.5` = centered). */
  focalX: number;
  /** Normalized vertical focal point in `0.0..=1.0` (`0.5` = centered). */
  focalY: number;
  /** Zoom multiplier on top of cover scale in `1.0..=4.0` (`1.0` = no extra zoom). */
  zoom: number;
}

export const MIN_WALLPAPER_ZOOM = 1.0;
export const MAX_WALLPAPER_ZOOM = 4.0;

export const DEFAULT_WALLPAPER_ADJUSTMENT: WallpaperAdjustment = {
  focalX: 0.5,
  focalY: 0.5,
  zoom: 1.0,
};

export interface WallpaperConfig {
  /** Managed image path stored under `<dataDir>/new-thread-backgrounds/`. */
  path: string;
  /** Original filename for display in Settings. */
  name: string;
  /** Intrinsic image width in pixels. */
  width: number;
  /** Intrinsic image height in pixels. */
  height: number;
  /** Crop / pan / zoom adjustment. */
  adjustment: WallpaperAdjustment;
  /** Optional extracted dominant hex color (`#rrggbb`) for theme tinting. */
  dominantColor?: string;
}

export interface FittedWallpaperGeometry {
  scaledWidth: number;
  scaledHeight: number;
  offsetX: number;
  offsetY: number;
  overflowX: number;
  overflowY: number;
  scale: number;
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

export function clampAdjustment(adj?: Partial<WallpaperAdjustment> | null): WallpaperAdjustment {
  return {
    focalX: clamp(adj?.focalX ?? 0.5, 0.0, 1.0),
    focalY: clamp(adj?.focalY ?? 0.5, 0.0, 1.0),
    zoom: clamp(adj?.zoom ?? 1.0, MIN_WALLPAPER_ZOOM, MAX_WALLPAPER_ZOOM),
  };
}

export function isDefaultAdjustment(adj?: WallpaperAdjustment | null): boolean {
  if (!adj) return true;
  const c = clampAdjustment(adj);
  return (
    Math.abs(c.focalX - 0.5) < 0.001 &&
    Math.abs(c.focalY - 0.5) < 0.001 &&
    Math.abs(c.zoom - 1.0) < 0.001
  );
}

/**
 * Compute the cover-fit + zoom + focal-point geometry for rendering a wallpaper
 * inside a viewport of `viewportWidth` x `viewportHeight`.
 */
export function fittedGeometry(
  imageWidth: number,
  imageHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  adjustment: WallpaperAdjustment = DEFAULT_WALLPAPER_ADJUSTMENT,
): FittedWallpaperGeometry {
  const imgW = Math.max(imageWidth, 1);
  const imgH = Math.max(imageHeight, 1);
  const vpW = Math.max(viewportWidth, 1);
  const vpH = Math.max(viewportHeight, 1);
  const adj = clampAdjustment(adjustment);

  const baseScale = Math.max(vpW / imgW, vpH / imgH);
  const scale = baseScale * adj.zoom;
  const scaledWidth = Math.max(imgW * scale, vpW);
  const scaledHeight = Math.max(imgH * scale, vpH);
  const overflowX = Math.max(scaledWidth - vpW, 0);
  const overflowY = Math.max(scaledHeight - vpH, 0);
  const offsetX = overflowX > 0 ? -overflowX * adj.focalX : 0;
  const offsetY = overflowY > 0 ? -overflowY * adj.focalY : 0;

  return {
    scaledWidth,
    scaledHeight,
    offsetX,
    offsetY,
    overflowX,
    overflowY,
    scale,
  };
}

/**
 * Translate a pointer drag `(deltaX, deltaY)` in viewport coordinates into an updated
 * `WallpaperAdjustment`, matching `pan_adjustment`.
 */
export function panAdjustment(
  imageWidth: number,
  imageHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  current: WallpaperAdjustment,
  deltaX: number,
  deltaY: number,
): WallpaperAdjustment {
  const clamped = clampAdjustment(current);
  const geom = fittedGeometry(imageWidth, imageHeight, viewportWidth, viewportHeight, clamped);
  const nextOffsetX = clamp(geom.offsetX + deltaX, -geom.overflowX, 0);
  const nextOffsetY = clamp(geom.offsetY + deltaY, -geom.overflowY, 0);
  const focalX = geom.overflowX > 0.0001 ? -nextOffsetX / geom.overflowX : 0.5;
  const focalY = geom.overflowY > 0.0001 ? -nextOffsetY / geom.overflowY : 0.5;
  return clampAdjustment({
    focalX,
    focalY,
    zoom: clamped.zoom,
  });
}

/**
 * Zoom around a specific `(anchorX, anchorY)` point inside the viewport so the image
 * point under the anchor stays pinned during zoom changes.
 */
export function zoomAdjustmentAround(
  imageWidth: number,
  imageHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  current: WallpaperAdjustment,
  targetZoom: number,
  anchorX: number,
  anchorY: number,
): WallpaperAdjustment {
  const clamped = clampAdjustment(current);
  const nextZoom = clamp(targetZoom, MIN_WALLPAPER_ZOOM, MAX_WALLPAPER_ZOOM);
  const vpW = Math.max(viewportWidth, 1);
  const vpH = Math.max(viewportHeight, 1);
  const ax = clamp(anchorX, 0, vpW);
  const ay = clamp(anchorY, 0, vpH);

  const before = fittedGeometry(imageWidth, imageHeight, vpW, vpH, clamped);
  const imageU = clamp((ax - before.offsetX) / Math.max(before.scaledWidth, 1), 0, 1);
  const imageV = clamp((ay - before.offsetY) / Math.max(before.scaledHeight, 1), 0, 1);

  const after = fittedGeometry(imageWidth, imageHeight, vpW, vpH, {
    ...clamped,
    zoom: nextZoom,
  });
  const desiredOffsetX = clamp(ax - imageU * after.scaledWidth, -after.overflowX, 0);
  const desiredOffsetY = clamp(ay - imageV * after.scaledHeight, -after.overflowY, 0);
  const focalX = after.overflowX > 0.0001 ? -desiredOffsetX / after.overflowX : 0.5;
  const focalY = after.overflowY > 0.0001 ? -desiredOffsetY / after.overflowY : 0.5;

  return clampAdjustment({
    focalX,
    focalY,
    zoom: nextZoom,
  });
}

// ---------------------------------------------------------------------------
// Wallpaper folder rotation & history
// ---------------------------------------------------------------------------

export const WALLPAPER_HISTORY_LIMIT = 8;

export const SUPPORTED_WALLPAPER_EXTENSIONS = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "tif",
  "tiff",
] as const;

export function isSupportedWallpaperPath(filePath: string): boolean {
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) return false;
  const ext = filePath.slice(dot + 1).toLowerCase();
  return (SUPPORTED_WALLPAPER_EXTENSIONS as readonly string[]).includes(ext);
}

/**
 * Record `path` at the end of `history`, deduplicating any earlier occurrence
 * and trimming to `WALLPAPER_HISTORY_LIMIT`.
 */
export function rememberWallpaperHistory(history: readonly string[], path: string): string[] {
  if (!path) return [...history].slice(-WALLPAPER_HISTORY_LIMIT);
  const next = history.filter((item) => item !== path);
  next.push(path);
  if (next.length > WALLPAPER_HISTORY_LIMIT) {
    return next.slice(next.length - WALLPAPER_HISTORY_LIMIT);
  }
  return next;
}

/**
 * Choose a random wallpaper path from `candidates`, avoiding the current wallpaper
 * and recent history when possible.
 *
 * `randomIndex(len)` defaults to `Math.floor(Math.random() * len)`.
 */
export function chooseRandomWallpaperCandidate(
  candidates: readonly string[],
  currentSource: string | undefined,
  history: readonly string[],
  randomIndex: (len: number) => number = (len) => Math.floor(Math.random() * len),
): string | undefined {
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];

  const nonCurrent = currentSource
    ? candidates.filter((p) => p !== currentSource)
    : [...candidates];
  const basePool = nonCurrent.length > 0 ? nonCurrent : [...candidates];

  const cooldownCount = Math.min(history.length, Math.max(basePool.length - 1, 0));
  const recentSet = new Set(cooldownCount > 0 ? history.slice(history.length - cooldownCount) : []);
  const freshPool = basePool.filter((p) => !recentSet.has(p));
  const activePool = freshPool.length > 0 ? freshPool : basePool;

  const idx = clamp(randomIndex(activePool.length), 0, activePool.length - 1);
  return activePool[idx];
}

// ---------------------------------------------------------------------------
// Image header inspection & dominant color extraction (wallpaper_colors.rs)
// ---------------------------------------------------------------------------

export interface ImageInspection {
  format: string;
  width: number;
  height: number;
  dominantColor?: string;
}

function readU16BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function readU16LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readU32BE(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] ?? 0) << 24) |
      ((bytes[offset + 1] ?? 0) << 16) |
      ((bytes[offset + 2] ?? 0) << 8) |
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

function readU32LE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  );
}

/**
 * Inspect raw image file bytes to verify format and extract dimensions (`width`, `height`)
 * plus an optional dominant color.
 */
export function inspectImageBytes(bytes: Uint8Array): ImageInspection | null {
  if (bytes.length < 10) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A + IHDR at offset 8
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    const width = readU32BE(bytes, 16);
    const height = readU32BE(bytes, 20);
    if (width > 0 && height > 0) {
      return {
        format: "png",
        width,
        height,
        dominantColor: extractDominantColorFromFileBytes(bytes, "png"),
      };
    }
  }

  // GIF: "GIF87a" or "GIF89a"
  if (
    bytes.length >= 10 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    const width = readU16LE(bytes, 6);
    const height = readU16LE(bytes, 8);
    if (width > 0 && height > 0) {
      return {
        format: "gif",
        width,
        height,
        dominantColor: extractDominantColorFromFileBytes(bytes, "gif"),
      };
    }
  }

  // BMP: "BM"
  if (bytes.length >= 26 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    const dibSize = readU32LE(bytes, 14);
    let width = 0;
    let height = 0;
    if (dibSize === 12) {
      width = readU16LE(bytes, 18);
      height = readU16LE(bytes, 20);
    } else if (dibSize >= 40) {
      width = readU32LE(bytes, 18) | 0;
      height = Math.abs(readU32LE(bytes, 22) | 0);
    }
    if (width > 0 && height > 0) {
      return {
        format: "bmp",
        width,
        height,
        dominantColor: extractDominantColorFromFileBytes(bytes, "bmp"),
      };
    }
  }

  // WebP: "RIFF" .... "WEBP"
  if (
    bytes.length >= 30 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    const chunk = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);
    if (chunk === "VP8X" && bytes.length >= 30) {
      const width = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16));
      const height = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16));
      if (width > 0 && height > 0) {
        return {
          format: "webp",
          width,
          height,
          dominantColor: extractDominantColorFromFileBytes(bytes, "webp"),
        };
      }
    } else if (chunk === "VP8 " && bytes.length >= 30) {
      const width = readU16LE(bytes, 26) & 0x3fff;
      const height = readU16LE(bytes, 28) & 0x3fff;
      if (width > 0 && height > 0) {
        return {
          format: "webp",
          width,
          height,
          dominantColor: extractDominantColorFromFileBytes(bytes, "webp"),
        };
      }
    } else if (chunk === "VP8L" && bytes.length >= 25) {
      const b0 = bytes[21]!;
      const b1 = bytes[22]!;
      const b2 = bytes[23]!;
      const b3 = bytes[24]!;
      const width = 1 + (((b1 & 0x3f) << 8) | b0);
      const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
      if (width > 0 && height > 0) {
        return {
          format: "webp",
          width,
          height,
          dominantColor: extractDominantColorFromFileBytes(bytes, "webp"),
        };
      }
    }
  }

  // JPEG: FF D8
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset++;
        continue;
      }
      while (offset < bytes.length && bytes[offset] === 0xff) offset++;
      if (offset >= bytes.length) break;
      const marker = bytes[offset]!;
      offset++;

      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        continue;
      }
      if (offset + 2 > bytes.length) break;
      const segLen = readU16BE(bytes, offset);
      if (segLen < 2 || offset + segLen > bytes.length) break;

      // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15
      const isSof =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isSof && segLen >= 7) {
        const height = readU16BE(bytes, offset + 3);
        const width = readU16BE(bytes, offset + 5);
        if (width > 0 && height > 0) {
          return {
            format: "jpeg",
            width,
            height,
            dominantColor: extractDominantColorFromFileBytes(bytes, "jpeg"),
          };
        }
      }
      offset += segLen;
    }
  }

  // TIFF: "II*\0" (little-endian) or "MM\0*" (big-endian)
  if (
    bytes.length >= 8 &&
    ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) ||
      (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a))
  ) {
    const le = bytes[0] === 0x49;
    const u16 = (off: number) => (le ? readU16LE(bytes, off) : readU16BE(bytes, off));
    const u32 = (off: number) => (le ? readU32LE(bytes, off) : readU32BE(bytes, off));
    const ifdOffset = u32(4);
    if (ifdOffset + 2 <= bytes.length) {
      const entries = u16(ifdOffset);
      let width = 0;
      let height = 0;
      for (let i = 0; i < entries; i++) {
        const entryOff = ifdOffset + 2 + i * 12;
        if (entryOff + 12 > bytes.length) break;
        const tag = u16(entryOff);
        const fieldType = u16(entryOff + 2);
        const val = fieldType === 3 ? u16(entryOff + 8) : u32(entryOff + 8);
        if (tag === 256) width = val;
        if (tag === 257) height = val;
      }
      if (width > 0 && height > 0) {
        return {
          format: "tiff",
          width,
          height,
          dominantColor: extractDominantColorFromFileBytes(bytes, "tiff"),
        };
      }
    }
  }

  return null;
}

/**
 * Extract the dominant color from RGBA pixel bytes using a 12-bit quantized
 * saturation-weighted histogram.
 */
export function extractDominantColorFromRgba(rgba: Uint8Array): string | undefined {
  if (rgba.length < 4) return undefined;
  const weights = new Float64Array(4096);
  const sumR = new Float64Array(4096);
  const sumG = new Float64Array(4096);
  const sumB = new Float64Array(4096);

  const totalPixels = Math.floor(rgba.length / 4);
  const step = Math.max(1, Math.floor(totalPixels / 4096));

  for (let p = 0; p < totalPixels; p += step) {
    const idx = p * 4;
    const r = rgba[idx]!;
    const g = rgba[idx + 1]!;
    const b = rgba[idx + 2]!;
    const a = rgba[idx + 3]!;
    if (a < 32) continue;

    const rf = r / 255;
    const gf = g / 255;
    const bf = b / 255;
    const max = Math.max(rf, gf, bf);
    const min = Math.min(rf, gf, bf);
    if (max < 0.08 || min > 0.95) continue;

    const saturation = max <= 0.001 ? 0 : (max - min) / max;
    const weight = (0.2 + saturation * saturation) * (a / 255);
    const bin = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    weights[bin]! += weight;
    sumR[bin]! += rf * weight;
    sumG[bin]! += gf * weight;
    sumB[bin]! += bf * weight;
  }

  let bestBin = -1;
  let bestWeight = 0;
  for (let i = 0; i < 4096; i++) {
    if (weights[i]! > bestWeight) {
      bestWeight = weights[i]!;
      bestBin = i;
    }
  }

  if (bestBin < 0 || bestWeight <= 0) return undefined;
  const w = weights[bestBin]!;
  const normalized = normalizeAccentRgb(sumR[bestBin]! / w, sumG[bestBin]! / w, sumB[bestBin]! / w);
  return rgbToHex(normalized[0], normalized[1], normalized[2]);
}

function extractDominantColorFromFileBytes(bytes: Uint8Array, format: string): string | undefined {
  // For uncompressed BMP (24-bit or 32-bit), read pixel array directly
  if (format === "bmp" && bytes.length >= 54) {
    const pixelOffset = readU32LE(bytes, 10);
    const bpp = readU16LE(bytes, 28);
    if ((bpp === 24 || bpp === 32) && pixelOffset < bytes.length) {
      const bytesPerPixel = bpp / 8;
      const count = Math.floor((bytes.length - pixelOffset) / bytesPerPixel);
      const sampleCount = Math.min(count, 2048);
      const step = Math.max(1, Math.floor(count / Math.max(sampleCount, 1)));
      const rgba = new Uint8Array(sampleCount * 4);
      let out = 0;
      for (let i = 0; i < count && out + 3 < rgba.length; i += step) {
        const off = pixelOffset + i * bytesPerPixel;
        rgba[out] = bytes[off + 2] ?? 0; // R
        rgba[out + 1] = bytes[off + 1] ?? 0; // G
        rgba[out + 2] = bytes[off] ?? 0; // B
        rgba[out + 3] = bpp === 32 ? (bytes[off + 3] ?? 255) : 255;
        out += 4;
      }
      const dom = extractDominantColorFromRgba(rgba.subarray(0, out));
      if (dom) return dom;
    }
  }

  // For GIF with a global color table, sample the palette entries
  if (format === "gif" && bytes.length >= 13) {
    const packed = bytes[10]!;
    const hasGct = (packed & 0x80) !== 0;
    if (hasGct) {
      const gctSize = 1 << ((packed & 0x07) + 1);
      const gctBytes = gctSize * 3;
      if (13 + gctBytes <= bytes.length) {
        const rgba = new Uint8Array(gctSize * 4);
        for (let i = 0; i < gctSize; i++) {
          rgba[i * 4] = bytes[13 + i * 3]!;
          rgba[i * 4 + 1] = bytes[13 + i * 3 + 1]!;
          rgba[i * 4 + 2] = bytes[13 + i * 3 + 2]!;
          rgba[i * 4 + 3] = 255;
        }
        const dom = extractDominantColorFromRgba(rgba);
        if (dom) return dom;
      }
    }
  }

  // For PNG with PLTE chunk, sample the palette entries
  if (format === "png") {
    let off = 8;
    while (off + 8 <= bytes.length) {
      const len = readU32BE(bytes, off);
      const type = String.fromCharCode(
        bytes[off + 4]!,
        bytes[off + 5]!,
        bytes[off + 6]!,
        bytes[off + 7]!,
      );
      if (type === "PLTE" && len >= 3 && off + 8 + len <= bytes.length) {
        const entries = Math.floor(len / 3);
        const rgba = new Uint8Array(entries * 4);
        for (let i = 0; i < entries; i++) {
          rgba[i * 4] = bytes[off + 8 + i * 3]!;
          rgba[i * 4 + 1] = bytes[off + 8 + i * 3 + 1]!;
          rgba[i * 4 + 2] = bytes[off + 8 + i * 3 + 2]!;
          rgba[i * 4 + 3] = 255;
        }
        const dom = extractDominantColorFromRgba(rgba);
        if (dom) return dom;
      }
      if (type === "IEND") break;
      off += 12 + len;
    }
  }

  // Deterministic fallback hash over payload bytes so compressed PNG/JPEG/WebP files
  // still yield a pleasant, stable accent when native pixel decoding isn't invoked.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const start = Math.min(32, bytes.length);
  const step = Math.max(1, Math.floor((bytes.length - start) / 512));
  for (let i = start; i < bytes.length; i += step) {
    h1 ^= bytes[i]!;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= (bytes[i]! + (i & 0xff)) & 0xff;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  const r = ((h1 >>> 16) & 0xff) / 255;
  const g = ((h1 >>> 8) & 0xff) / 255;
  const b = ((h2 >>> 16) & 0xff) / 255;
  const [nr, ng, nb] = normalizeAccentRgb(r, g, b);
  return rgbToHex(nr, ng, nb);
}

export function normalizeAccentRgb(r: number, g: number, b: number): [number, number, number] {
  const [h, s, v] = rgbToHsv(clamp(r, 0, 1), clamp(g, 0, 1), clamp(b, 0, 1));
  const ns = Math.max(s, 0.25);
  const nv = clamp(v, 0.45, 0.85);
  return hsvToRgb(h, ns, nv);
}

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const h =
    delta <= 0.0001
      ? 0
      : max === r
        ? 60 * (((g - b) / delta + 6) % 6)
        : max === g
          ? 60 * ((b - r) / delta + 2)
          : 60 * ((r - g) / delta + 4);
  const s = max <= 0.0001 ? 0 : delta / max;
  return [h, s, max];
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (h < 60) {
    r1 = c;
    g1 = x;
  } else if (h < 120) {
    r1 = x;
    g1 = c;
  } else if (h < 180) {
    g1 = c;
    b1 = x;
  } else if (h < 240) {
    g1 = x;
    b1 = c;
  } else if (h < 300) {
    r1 = x;
    b1 = c;
  } else {
    r1 = c;
    b1 = x;
  }
  return [clamp(r1 + m, 0, 1), clamp(g1 + m, 0, 1), clamp(b1 + m, 0, 1)];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const toByte = (v: number) =>
    Math.round(clamp(v, 0, 1) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${toByte(r)}${toByte(g)}${toByte(b)}`;
}

export function hexToRgb(hex: string): [number, number, number] | null {
  const clean = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return null;
  const num = parseInt(clean, 16);
  return [((num >> 16) & 0xff) / 255, ((num >> 8) & 0xff) / 255, (num & 0xff) / 255];
}

export function mixHex(baseHex: string, tintHex: string, factor: number): string {
  const b = hexToRgb(baseHex);
  const t = hexToRgb(tintHex);
  if (!b || !t) return baseHex;
  const f = clamp(factor, 0, 1);
  return rgbToHex(
    b[0] * (1 - f) + t[0] * f,
    b[1] * (1 - f) + t[1] * f,
    b[2] * (1 - f) + t[2] * f,
  );
}

/**
 * Build a tinted `nsh` theme object from `theme.json` and the wallpaper's dominant hex color,
 * mirroring `tint_theme_variant`.
 */
export function buildWallpaperTintedTheme(dominantColor: string): Theme | null {
  const rgb = hexToRgb(dominantColor);
  if (!rgb) return null;
  const [nr, ng, nb] = normalizeAccentRgb(rgb[0], rgb[1], rgb[2]);
  const accentHex = rgbToHex(nr, ng, nb);

  const tintPalette = (palette: Record<string, string>, isDark: boolean) => {
    const surfacePct = isDark ? 12 : 8;
    const elevatedPct = isDark ? 16 : 11;
    const borderPct = isDark ? 22 : 16;
    const brandPct = isDark ? 65 : 55;
    const out: Record<string, string> = { ...palette };
    const mixCss = (base: string, pct: number) =>
      base.startsWith("#")
        ? mixHex(base, accentHex, pct / 100)
        : `color-mix(in oklch, ${base}, ${accentHex} ${pct}%)`;

    for (const k of ["background", "sidebar", "card", "popover", "sunken"]) {
      if (out[k]) out[k] = mixCss(out[k]!, surfacePct);
    }
    for (const k of ["secondary", "muted", "accent", "sidebar-accent"]) {
      if (out[k]) out[k] = mixCss(out[k]!, elevatedPct);
    }
    for (const k of ["border", "input", "sidebar-border", "hairline"]) {
      if (out[k]) out[k] = mixCss(out[k]!, borderPct);
    }
    for (const k of ["ring", "sidebar-ring", "brand-text"]) {
      if (out[k]) out[k] = mixCss(out[k]!, brandPct);
    }
    return out;
  };

  const baseBrand = themeJson.cssVars.theme.brand;
  const tintedBrand = mixHex(baseBrand, accentHex, 0.6);

  return {
    cssVars: {
      theme: {
        ...themeJson.cssVars.theme,
        brand: tintedBrand,
      },
      light: tintPalette(themeJson.cssVars.light as Record<string, string>, false),
      dark: tintPalette(themeJson.cssVars.dark as Record<string, string>, true),
    },
  };
}

// ---------------------------------------------------------------------------
// WGSL Shaders for <ShaderEffect>
// ---------------------------------------------------------------------------

const COMMON_WGSL = `
fn luma(c: vec3f) -> f32 {
  return dot(c, vec3f(0.299, 0.587, 0.114));
}

fn paperColor(dark: f32) -> vec3f {
  return select(vec3f(0.973, 0.965, 0.945), vec3f(0.067, 0.067, 0.063), dark > 0.5);
}

fn snapUv(uv: vec2f, size: vec2f, stepPx: vec2f) -> vec2f {
  let grid = max(stepPx, vec2f(1.0, 1.0));
  let cell = floor(uv * size / grid);
  return clamp((cell + vec2f(0.5, 0.5)) * grid / max(size, vec2f(1.0, 1.0)), vec2f(0.0), vec2f(1.0));
}
`;

export const WALLPAPER_SHADERS: Record<Exclude<WallpaperEffect, "none">, string> = {
  dither: `
struct Uniforms {
  pitch: f32,
  strength: f32,
  dark: f32,
}

${COMMON_WGSL}

fn bayer4(p: vec2u) -> f32 {
  let m = array<f32, 16>(
     0.0,  8.0,  2.0, 10.0,
    12.0,  4.0, 14.0,  6.0,
     3.0, 11.0,  1.0,  9.0,
    15.0,  7.0, 13.0,  5.0
  );
  let idx = (p.y & 3u) * 4u + (p.x & 3u);
  return (m[idx] + 0.5) / 16.0;
}

fn shade(uv: vec2f) -> vec4f {
  let pitch = max(uniforms.pitch, 1.0);
  let suv = snapUv(uv, nsh.size, vec2f(pitch, pitch));
  let src = sample_content(suv);
  let pos = uv * nsh.size;
  let cell = vec2u(floor(pos / pitch));
  let threshold = bayer4(cell);
  let lum = luma(src.rgb);
  let paper = paperColor(uniforms.dark);
  let ink = clamp(src.rgb * 1.15, vec3f(0.0), vec3f(1.0));
  let dithered = select(paper, ink, lum > threshold);
  let rgb = mix(src.rgb, dithered, clamp(uniforms.strength, 0.0, 1.0));
  return vec4f(rgb, src.a);
}
`,

  ascii: `
struct Uniforms {
  px: f32,
  threshold: f32,
  strength: f32,
  dark: f32,
}

${COMMON_WGSL}

fn glyphRow(glyph: u32, row: u32) -> u32 {
  switch glyph {
    case 1u: {
      let r = array<u32, 7>(0u, 0u, 0u, 4u, 0u, 0u, 0u);
      return r[row];
    }
    case 2u: {
      let r = array<u32, 7>(0u, 4u, 0u, 0u, 0u, 4u, 0u);
      return r[row];
    }
    case 3u: {
      let r = array<u32, 7>(0u, 0u, 4u, 14u, 4u, 0u, 0u);
      return r[row];
    }
    case 4u: {
      let r = array<u32, 7>(0u, 4u, 4u, 31u, 4u, 4u, 0u);
      return r[row];
    }
    case 5u: {
      let r = array<u32, 7>(0u, 17u, 10u, 4u, 10u, 17u, 0u);
      return r[row];
    }
    case 6u: {
      let r = array<u32, 7>(0u, 10u, 21u, 10u, 21u, 10u, 0u);
      return r[row];
    }
    case 7u: {
      let r = array<u32, 7>(14u, 17u, 17u, 17u, 17u, 17u, 14u);
      return r[row];
    }
    case 8u: {
      let r = array<u32, 7>(10u, 31u, 10u, 10u, 31u, 10u, 0u);
      return r[row];
    }
    case 9u: {
      let r = array<u32, 7>(31u, 21u, 31u, 21u, 31u, 21u, 31u);
      return r[row];
    }
    default: {
      let r = array<u32, 7>(31u, 31u, 31u, 31u, 31u, 31u, 31u);
      return r[row];
    }
  }
}

fn sampleGlyph(glyph: u32, local: vec2u) -> f32 {
  if (glyph == 0u || local.x >= 5u || local.y >= 7u) {
    return 0.0;
  }
  let bits = glyphRow(glyph, local.y);
  let mask = 1u << (4u - local.x);
  return select(0.0, 1.0, (bits & mask) != 0u);
}

fn shade(uv: vec2f) -> vec4f {
  let px = max(uniforms.px, 1.0);
  let cellSize = vec2f(6.0, 8.0) * px;
  let suv = snapUv(uv, nsh.size, cellSize);
  let src = sample_content(suv);
  let lum = clamp(luma(src.rgb), 0.0, 1.0);
  let paper = paperColor(uniforms.dark);
  let pos = uv * nsh.size;

  let level = u32(clamp(floor((lum - uniforms.threshold) / max(1.0 - uniforms.threshold, 0.01) * 10.0), 0.0, 10.0));
  let inCell = floor((pos % cellSize) / px);
  let inkMask = select(0.0, sampleGlyph(level, vec2u(inCell)), lum > uniforms.threshold);
  let inkColor = clamp(src.rgb * 1.2, vec3f(0.0), vec3f(1.0));
  let asciiRgb = mix(paper, inkColor, inkMask);
  let rgb = mix(src.rgb, asciiRgb, clamp(uniforms.strength, 0.0, 1.0));
  return vec4f(rgb, src.a);
}
`,

  halftone: `
struct Uniforms {
  pitch: f32,
  strength: f32,
  dark: f32,
}

${COMMON_WGSL}

fn shade(uv: vec2f) -> vec4f {
  let pitch = max(uniforms.pitch, 2.0);
  let suv = snapUv(uv, nsh.size, vec2f(pitch, pitch));
  let src = sample_content(suv);
  let lum = clamp(luma(src.rgb), 0.0, 1.0);
  let paper = paperColor(uniforms.dark);
  let pos = uv * nsh.size;

  let center = (floor(pos / pitch) + vec2f(0.5, 0.5)) * pitch;
  let dist = length(pos - center);
  let radius = pitch * 0.5 * (0.3 + 0.7 * sqrt(lum));
  let aa = smoothstep(radius + 0.65, max(radius - 0.65, 0.0), dist);
  let dotRgb = mix(paper, clamp(src.rgb * 1.12, vec3f(0.0), vec3f(1.0)), aa);
  let rgb = mix(src.rgb, dotRgb, clamp(uniforms.strength, 0.0, 1.0));
  return vec4f(rgb, src.a);
}
`,

  scanlines: `
struct Uniforms {
  pitch: f32,
  strength: f32,
  dark: f32,
}

${COMMON_WGSL}

fn shade(uv: vec2f) -> vec4f {
  let src = sample_content(uv);
  let pitch = max(uniforms.pitch, 2.0);
  let pos = uv * nsh.size;
  let row = floor(pos.y) % pitch;
  let isLine = select(0.0, 1.0, row < 1.0);
  let paper = paperColor(uniforms.dark);
  let scanned = mix(src.rgb, paper, isLine * clamp(uniforms.strength, 0.0, 1.0));
  return vec4f(scanned, src.a);
}
`,
};

export function wallpaperShaderUniforms(
  effect: Exclude<WallpaperEffect, "none">,
  dark: boolean,
): Record<string, number> {
  const d = dark ? 1.0 : 0.0;
  switch (effect) {
    case "dither":
      return { pitch: 2.0, strength: 0.5, dark: d };
    case "ascii":
      return { px: 1.5, threshold: 0.22, strength: 0.75, dark: d };
    case "halftone":
      return { pitch: 4.0, strength: 0.6, dark: d };
    case "scanlines":
      return { pitch: 3.0, strength: 0.48, dark: d };
  }
}
