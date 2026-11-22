import { expect, test } from "nsh/test";
import { fitImageBox, imageSizeFromBase64, parseImageSize } from "./image-size";

function pngBytes(width: number, height: number): Uint8Array {
  const buf = new Uint8Array(24);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  buf[16] = (width >>> 24) & 0xff;
  buf[17] = (width >>> 16) & 0xff;
  buf[18] = (width >>> 8) & 0xff;
  buf[19] = width & 0xff;
  buf[20] = (height >>> 24) & 0xff;
  buf[21] = (height >>> 16) & 0xff;
  buf[22] = (height >>> 8) & 0xff;
  buf[23] = height & 0xff;
  return buf;
}

function gifBytes(width: number, height: number): Uint8Array {
  const buf = new Uint8Array(10);
  buf.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0);
  buf[6] = width & 0xff;
  buf[7] = (width >>> 8) & 0xff;
  buf[8] = height & 0xff;
  buf[9] = (height >>> 8) & 0xff;
  return buf;
}

function webpVp8Bytes(width: number, height: number): Uint8Array {
  const buf = new Uint8Array(30);
  buf.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  buf.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  buf.set([0x56, 0x50, 0x38, 0x20], 12); // "VP8 "
  buf.set([0x9d, 0x01, 0x2a], 23);
  buf[26] = width & 0xff;
  buf[27] = (width >>> 8) & 0x3f;
  buf[28] = height & 0xff;
  buf[29] = (height >>> 8) & 0x3f;
  return buf;
}

function webpVp8lBytes(width: number, height: number): Uint8Array {
  const buf = new Uint8Array(30);
  buf.set([0x52, 0x49, 0x46, 0x46], 0);
  buf.set([0x57, 0x45, 0x42, 0x50], 8);
  buf.set([0x56, 0x50, 0x38, 0x4c], 12); // "VP8L"
  buf[20] = 0x2f;
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  buf[21] = bits & 0xff;
  buf[22] = (bits >>> 8) & 0xff;
  buf[23] = (bits >>> 16) & 0xff;
  buf[24] = (bits >>> 24) & 0xff;
  return buf;
}

function webpVp8xBytes(width: number, height: number): Uint8Array {
  const buf = new Uint8Array(30);
  buf.set([0x52, 0x49, 0x46, 0x46], 0);
  buf.set([0x57, 0x45, 0x42, 0x50], 8);
  buf.set([0x56, 0x50, 0x38, 0x58], 12); // "VP8X"
  const w = width - 1;
  const h = height - 1;
  buf[24] = w & 0xff;
  buf[25] = (w >>> 8) & 0xff;
  buf[26] = (w >>> 16) & 0xff;
  buf[27] = h & 0xff;
  buf[28] = (h >>> 8) & 0xff;
  buf[29] = (h >>> 16) & 0xff;
  return buf;
}

function jpegBytes(width: number, height: number, orientation?: number): Uint8Array {
  const chunks: number[] = [0xff, 0xd8];
  if (orientation !== undefined) {
    // Minimal APP1 Exif with little-endian TIFF header + 1 IFD entry (tag 0x0112 Orientation)
    const app1Payload = [
      0x45, 0x78, 0x69, 0x66, 0x00, 0x00, // Exif\0\0
      0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, // II, 42, IFD offset 8
      0x01, 0x00, // 1 entry
      0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, orientation & 0xff, 0x00, 0x00, 0x00,
    ];
    const len = app1Payload.length + 2;
    chunks.push(0xff, 0xe1, (len >>> 8) & 0xff, len & 0xff, ...app1Payload);
  }
  // SOF0 segment
  chunks.push(0xff, 0xc0, 0x00, 0x0b, 0x08, (height >>> 8) & 0xff, height & 0xff, (width >>> 8) & 0xff, width & 0xff, 0x01, 0x01, 0x11, 0x00);
  chunks.push(0xff, 0xd9);
  return new Uint8Array(chunks);
}

test("parseImageSize reads PNG, GIF, WebP and JPEG headers (including EXIF orientation)", () => {
  expect(parseImageSize(pngBytes(1920, 1080))).toEqual({ width: 1920, height: 1080 });
  expect(parseImageSize(gifBytes(320, 240))).toEqual({ width: 320, height: 240 });
  expect(parseImageSize(webpVp8Bytes(800, 600))).toEqual({ width: 800, height: 600 });
  expect(parseImageSize(webpVp8lBytes(512, 256))).toEqual({ width: 512, height: 256 });
  expect(parseImageSize(webpVp8xBytes(1440, 900))).toEqual({ width: 1440, height: 900 });
  expect(parseImageSize(jpegBytes(1600, 1200))).toEqual({ width: 1600, height: 1200 });
  expect(parseImageSize(jpegBytes(1600, 1200, 6))).toEqual({ width: 1200, height: 1600 });
  expect(parseImageSize(new Uint8Array([1, 2, 3]))).toBeUndefined();
});

test("imageSizeFromBase64 decodes headers from base64 and caches by object", () => {
  const png = { mimeType: "image/png", data: Buffer.from(pngBytes(1320, 840)).toString("base64") };
  expect(imageSizeFromBase64(png)).toEqual({ width: 1320, height: 840 });
  expect(imageSizeFromBase64(png)).toEqual({ width: 1320, height: 840 });
  const jpeg = { mimeType: "image/jpeg", data: Buffer.from(jpegBytes(1080, 1920)).toString("base64") };
  expect(imageSizeFromBase64(jpeg)).toEqual({ width: 1080, height: 1920 });
  expect(imageSizeFromBase64({ mimeType: "image/png", data: "" })).toBeUndefined();
});

test("fitImageBox preserves aspect ratio within bounds and clamps extreme ratios", () => {
  const preview = { maxWidth: 260, maxHeight: 200, minWidth: 72, minHeight: 72, fallback: { width: 200, height: 150 } };
  expect(fitImageBox({ width: 1920, height: 1080 }, preview)).toEqual({ width: 260, height: 146 });
  expect(fitImageBox({ width: 1024, height: 1024 }, preview)).toEqual({ width: 200, height: 200 });
  expect(fitImageBox({ width: 1080, height: 1920 }, preview)).toEqual({ width: 113, height: 200 });
  expect(fitImageBox({ width: 2500, height: 500 }, preview)).toEqual({ width: 260, height: 72 });
  expect(fitImageBox({ width: 400, height: 2000 }, preview)).toEqual({ width: 72, height: 200 });
  expect(fitImageBox(undefined, preview)).toEqual({ width: 200, height: 150 });

  const zoom = { maxWidth: 880, maxHeight: 520, fallback: { width: 640, height: 420 }, upscale: false };
  expect(fitImageBox({ width: 200, height: 100 }, zoom)).toEqual({ width: 200, height: 100 });
  expect(fitImageBox({ width: 2000, height: 1000 }, zoom)).toEqual({ width: 880, height: 440 });
});
