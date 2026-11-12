// PNG screenshots thinned into a luminance grid for pixel assertions
// (`app.screenshot()` buffers OOM the test VM at full resolution).
import { inflateSync } from "zlib";

export interface Grid {
  width: number;
  height: number;
  /** One luminance byte per pixel, every `step`-th source pixel. */
  step: number;
  data: Uint8Array;
}

/** PNG decode keeping only every `step`-th pixel's luminance (8-bit RGBA/RGB/gray, all filters). */
export function decodeLumGrid(bytes: Uint8Array, step: number): Grid {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = dv.getUint32(16);
  const height = dv.getUint32(20);
  const colorType = bytes[25];
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 4;
  const parts: Uint8Array[] = [];
  let pos = 8;
  while (pos + 8 <= bytes.length) {
    const len = dv.getUint32(pos);
    if (dv.getUint32(pos + 4) === 0x49444154) parts.push(bytes.subarray(pos + 8, pos + 8 + len));
    pos += 12 + len;
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const packed = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    packed.set(p, o);
    o += p.length;
  }
  const raw = inflateSync(packed) as unknown as Uint8Array;
  const stride = width * bpp;
  const gw = Math.ceil(width / step);
  const gh = Math.ceil(height / step);
  const data = new Uint8Array(gw * gh);
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = row[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 0xff;
    }
    if (y % step !== 0) {
      prev.set(cur);
      continue;
    }
    for (let x = 0; x < width; x += step) {
      const i = x * bpp;
      data[(y / step) * gw + x / step] = bpp === 1 ? cur[i] : (cur[i] * 30 + cur[i + 1] * 59 + cur[i + 2] * 11) / 100;
    }
    prev.set(cur);
  }
  return { width: gw, height: gh, step, data };
}

export const lum = (g: Grid, x: number, y: number) => g.data[y * g.width + x];

/** Share of pixels differing by more than `tol` luminance inside `x0..x1 × y0..y1`. */
export function pixelDiff(a: Grid, b: Grid, x0: number, x1: number, y0: number, y1: number, tol = 24): number {
  let changed = 0;
  let total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      total++;
      if (Math.abs(lum(a, x, y) - lum(b, x, y)) > tol) changed++;
    }
  }
  return changed / total;
}
