import type { ImageContent } from "../pi/protocol";

export interface ImageDimensions {
  width: number;
  height: number;
}

const sizeCache = new WeakMap<object, ImageDimensions | null>();

function readUint16BE(bytes: Uint8Array, at: number) {
  return (bytes[at] << 8) | bytes[at + 1];
}

function readUint16LE(bytes: Uint8Array, at: number) {
  return bytes[at] | (bytes[at + 1] << 8);
}

function readUint32BE(bytes: Uint8Array, at: number) {
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}

function readUint32LE(bytes: Uint8Array, at: number) {
  return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
}

/** Reads EXIF orientation (1..8) from an APP1 Exif payload, or `undefined` when absent. */
function jpegExifOrientation(bytes: Uint8Array, start: number, end: number): number | undefined {
  // "Exif\0\0" + 8-byte TIFF header
  if (end - start < 14) return undefined;
  if (
    bytes[start] !== 0x45 ||
    bytes[start + 1] !== 0x78 ||
    bytes[start + 2] !== 0x69 ||
    bytes[start + 3] !== 0x66 ||
    bytes[start + 4] !== 0x00 ||
    bytes[start + 5] !== 0x00
  ) {
    return undefined;
  }
  const tiff = start + 6;
  const little = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49;
  const big = bytes[tiff] === 0x4d && bytes[tiff + 1] === 0x4d;
  if (!little && !big) return undefined;
  const u16 = (at: number) => (little ? readUint16LE(bytes, at) : readUint16BE(bytes, at));
  const u32 = (at: number) => (little ? readUint32LE(bytes, at) : readUint32BE(bytes, at));
  if (u16(tiff + 2) !== 42) return undefined;
  const ifdOffset = u32(tiff + 4);
  const ifd = tiff + ifdOffset;
  if (ifd + 2 > end) return undefined;
  const entries = u16(ifd);
  for (let i = 0; i < entries; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) break;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : undefined;
    }
  }
  return undefined;
}

/** Parses natural pixel dimensions from PNG, GIF, WebP or JPEG header bytes. */
export function parseImageSize(bytes: Uint8Array): ImageDimensions | undefined {
  const n = bytes.length;
  // PNG: 8-byte signature + IHDR chunk (width @ 16, height @ 20).
  if (n >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const width = readUint32BE(bytes, 16);
    const height = readUint32BE(bytes, 20);
    return width > 0 && height > 0 ? { width, height } : undefined;
  }
  // GIF: "GIF8" + logical screen width @ 6, height @ 8.
  if (n >= 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    const width = readUint16LE(bytes, 6);
    const height = readUint16LE(bytes, 8);
    return width > 0 && height > 0 ? { width, height } : undefined;
  }
  // WebP: "RIFF" .... "WEBP" + VP8 / VP8L / VP8X chunk.
  if (
    n >= 30 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    const c0 = bytes[12];
    const c1 = bytes[13];
    const c2 = bytes[14];
    const c3 = bytes[15];
    if (c0 === 0x56 && c1 === 0x50 && c2 === 0x38) {
      // "VP8 " (lossy)
      if (c3 === 0x20 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
        const width = readUint16LE(bytes, 26) & 0x3fff;
        const height = readUint16LE(bytes, 28) & 0x3fff;
        return width > 0 && height > 0 ? { width, height } : undefined;
      }
      // "VP8L" (lossless)
      if (c3 === 0x4c && bytes[20] === 0x2f) {
        const bits = readUint32LE(bytes, 21);
        const width = (bits & 0x3fff) + 1;
        const height = ((bits >> 14) & 0x3fff) + 1;
        return width > 0 && height > 0 ? { width, height } : undefined;
      }
      // "VP8X" (extended)
      if (c3 === 0x58) {
        const width = (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)) + 1;
        const height = (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) + 1;
        return width > 0 && height > 0 ? { width, height } : undefined;
      }
    }
    return undefined;
  }
  // JPEG: SOI (FF D8), then scan segments for SOF0..SOF15 (and APP1 EXIF orientation).
  if (n >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let pos = 2;
    let orientation: number | undefined;
    while (pos + 1 < n) {
      while (pos < n && bytes[pos] !== 0xff) pos++;
      while (pos < n && bytes[pos] === 0xff) pos++;
      if (pos >= n) break;
      const marker = bytes[pos++];
      if (marker === 0xd9 || marker === 0xda) break; // EOI / SOS
      if ((marker >= 0xd0 && marker <= 0xd8) || marker === 0x01) continue;
      if (pos + 2 > n) break;
      const len = readUint16BE(bytes, pos);
      if (len < 2 || pos + len > n) break;
      if (marker === 0xe1 && orientation === undefined) {
        orientation = jpegExifOrientation(bytes, pos + 2, pos + len);
      }
      const isSof =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isSof && len >= 7) {
        const height = readUint16BE(bytes, pos + 3);
        const width = readUint16BE(bytes, pos + 5);
        if (width > 0 && height > 0) {
          const swapped = orientation !== undefined && orientation >= 5 && orientation <= 8;
          return swapped ? { width: height, height: width } : { width, height };
        }
        return undefined;
      }
      pos += len;
    }
  }
  return undefined;
}

/** Decodes a prefix (multiple of 4 base64 chars) into bytes without touching the whole payload. */
function decodeBase64Prefix(data: string, maxChars: number): Uint8Array {
  const cleaned = data.length <= maxChars ? data : data.slice(0, maxChars - (maxChars % 4));
  return Buffer.from(cleaned, "base64");
}

/**
 * Natural pixel dimensions of an `ImageContent` block, parsed from its base64 header and cached
 * on the block object so list recycling and re-renders do zero repeated decoding.
 */
export function imageSizeFromBase64(image: Pick<ImageContent, "data" | "mimeType">): ImageDimensions | undefined {
  if (!image.data) return undefined;
  const cached = sizeCache.get(image);
  if (cached !== undefined) return cached ?? undefined;
  // PNG/GIF/WebP headers live in the first 30 bytes (64 base64 chars = 48 bytes).
  let size = parseImageSize(decodeBase64Prefix(image.data, 64));
  if (!size && (image.mimeType === "image/jpeg" || image.mimeType === "image/jpg" || image.data.startsWith("/9j/"))) {
    // JPEG SOF usually appears within the first 64 KB; fall back to full decode only if past large EXIF/ICC.
    size = parseImageSize(decodeBase64Prefix(image.data, 87_384));
    if (!size && image.data.length > 87_384) {
      size = parseImageSize(Buffer.from(image.data, "base64"));
    }
  }
  sizeCache.set(image, size ?? null);
  return size;
}

/**
 * Fits an image's natural size into a target box while keeping its aspect ratio.
 * When `minWidth` / `minHeight` are given, extreme panoramas or tall strips clamp
 * cleanly so thumbnails stay balanced (`objectFit: "cover"` trims the excess).
 */
export function fitImageBox(
  natural: ImageDimensions | undefined,
  bounds: {
    maxWidth: number;
    maxHeight: number;
    minWidth?: number;
    minHeight?: number;
    fallback: ImageDimensions;
    upscale?: boolean;
  },
): ImageDimensions {
  if (!natural || natural.width <= 0 || natural.height <= 0) return bounds.fallback;
  const rawScale = Math.min(bounds.maxWidth / natural.width, bounds.maxHeight / natural.height);
  const scale = bounds.upscale === false ? Math.min(1, rawScale) : rawScale;
  let width = Math.round(natural.width * scale);
  let height = Math.round(natural.height * scale);
  if (bounds.minWidth !== undefined) width = Math.max(bounds.minWidth, width);
  if (bounds.minHeight !== undefined) height = Math.max(bounds.minHeight, height);
  return {
    width: Math.min(bounds.maxWidth, Math.max(1, width)),
    height: Math.min(bounds.maxHeight, Math.max(1, height)),
  };
}
