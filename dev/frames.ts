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

interface PngDecodeState {
  width: number;
  height: number;
  bpp: number;
  stride: number;
  step: number;
  gw: number;
  gh: number;
  raw: Uint8Array;
  data: Uint8Array;
  prev: Uint8Array;
  cur: Uint8Array;
}

function inflatePng(bytes: Uint8Array, step: number): PngDecodeState {
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
  return {
    width,
    height,
    bpp,
    stride,
    step,
    gw,
    gh,
    raw,
    data: new Uint8Array(gw * gh),
    prev: new Uint8Array(stride),
    cur: new Uint8Array(stride),
  };
}

function decodeRows(state: PngDecodeState, yStart: number, yEnd: number): void {
  const { width, bpp, stride, step, gw, raw, data } = state;
  let { prev, cur } = state;
  const rowSpan = stride + 1;
  for (let y = yStart; y < yEnd; y++) {
    const base = y * rowSpan;
    const filter = raw[base];
    const row = raw.subarray(base + 1, base + rowSpan);
    if (filter === 0) {
      cur.set(row);
    } else if (filter === 1) {
      for (let x = 0; x < bpp; x++) cur[x] = row[x];
      for (let x = bpp; x < stride; x++) cur[x] = (row[x] + cur[x - bpp]) & 0xff;
    } else if (filter === 2) {
      for (let x = 0; x < stride; x++) cur[x] = (row[x] + prev[x]) & 0xff;
    } else if (filter === 3) {
      for (let x = 0; x < bpp; x++) cur[x] = (row[x] + (prev[x] >> 1)) & 0xff;
      for (let x = bpp; x < stride; x++) cur[x] = (row[x] + ((cur[x - bpp] + prev[x]) >> 1)) & 0xff;
    } else if (filter === 4) {
      for (let x = 0; x < bpp; x++) cur[x] = (row[x] + prev[x]) & 0xff;
      for (let x = bpp; x < stride; x++) {
        const a = cur[x - bpp];
        const b = prev[x];
        const c = prev[x - bpp];
        const pa = b >= c ? b - c : c - b;
        const pb = a >= c ? a - c : c - a;
        const d = a + b - (c << 1);
        const pc = d >= 0 ? d : -d;
        cur[x] = (row[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
    } else {
      cur.set(row);
    }
    if (y % step === 0) {
      let out = ((y / step) | 0) * gw;
      if (bpp === 1) {
        for (let x = 0; x < width; x += step, out++) data[out] = cur[x];
      } else {
        for (let x = 0; x < width; x += step, out++) {
          const i = x * bpp;
          data[out] = (cur[i] * 30 + cur[i + 1] * 59 + cur[i + 2] * 11) / 100;
        }
      }
    }
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  state.prev = prev;
  state.cur = cur;
}

/** PNG decode keeping only every `step`-th pixel's luminance (8-bit RGBA/RGB/gray, all filters). */
export function decodeLumGrid(bytes: Uint8Array, step: number): Grid {
  const state = inflatePng(bytes, step);
  decodeRows(state, 0, state.height);
  return { width: state.gw, height: state.gh, step, data: state.data };
}

/** Chunked async variant of `decodeLumGrid` that yields every `chunkRows` scanlines so large Retina screenshots never trip QuickJS's 2000ms single-turn budget. */
export async function decodeLumGridAsync(bytes: Uint8Array, step: number, chunkRows = 256): Promise<Grid> {
  const state = inflatePng(bytes, step);
  for (let y = 0; y < state.height; y += chunkRows) {
    decodeRows(state, y, Math.min(state.height, y + chunkRows));
    if (y + chunkRows < state.height) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  return { width: state.gw, height: state.gh, step, data: state.data };
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
