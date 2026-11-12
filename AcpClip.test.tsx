// Repro + regression: an ACP harness's answer (Devin's) clipped and ghosted as
// the run settles — `LayoutAnimation.configureNext` keyed to run state animated
// the settle layout pass, and the list's cells were left at interpolated frames
// (see AGENTS.md "Never key it to run state").
//
//   nsh test AcpClip.test.tsx --target macos
//
// Assertions are on the pixels: `app.screenshot()` returns the PNG, decoded
// below into a thinned luminance grid (full buffers OOM the test VM). Two
// failures are possible and each has a check:
//   - transient damage (rows ghosted/shifted by the animation, healed by the
//     next pass): the settle frame differs from the settled one;
//   - a clipped last paragraph (its second line gone or cut): the reply's last
//     paragraph must draw two full text lines.
import { expect, open, test } from "nsh/test";
import { inflateSync } from "zlib";

const OUT = "/tmp/pipi-acp-frames";

const REPLY = `有，三处未提交的改动：

**已修改**

- \`Clip.test.tsx\` — 重写了截图时机：不再在运行过程中连拍 90 张，而是等 \`复制回复\` 出现（run 落定）后再拍 30 张，断言也改为检查该 label。
- \`dev/fake-pi.ts\` — fake-pi 在收到自定义 \`reply\` 选项时会带上一段 \`thinking\` 文本。

**新文件（未跟踪）**

- \`Vanish.test.tsx\`

看起来是同一组工作的改动：给 fake-pi 加了 thinking 输出，并围绕"落定帧"调整/新增测试。需要我看一下 \`Vanish.test.tsx\` 的内容，或者帮你提交吗？`;

interface Grid {
  width: number;
  height: number;
  /** One luminance byte per pixel, every `step`-th source pixel. */
  step: number;
  data: Uint8Array;
}

/** PNG decode keeping only every `step`-th pixel's luminance (8-bit RGBA/RGB/gray, all filters). */
function decodeLumGrid(bytes: Uint8Array, step: number): Grid {
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

const lum = (g: Grid, x: number, y: number) => g.data[y * g.width + x];

/** Text rows: runs of rows with enough dark pixels across the transcript column. */
function textBands(g: Grid, x0: number, x1: number, yMax: number): { s: number; e: number; max: number }[] {
  const bands: { s: number; e: number; max: number }[] = [];
  let y = 0;
  while (y < yMax) {
    let dark = 0;
    for (let x = x0; x < x1; x++) if (lum(g, x, y) < 140) dark++;
    if (dark > 2) {
      const s = y;
      let max = dark;
      while (y < yMax) {
        dark = 0;
        for (let x = x0; x < x1; x++) if (lum(g, x, y) < 140) dark++;
        if (dark <= 2) break;
        if (dark > max) max = dark;
        y++;
      }
      if (y - s >= 2) bands.push({ s, e: y, max });
    } else {
      y++;
    }
  }
  return bands;
}

test("an ACP answer settles in place", async () => {
  const app = await open("./Harness.tsx", {
    width: 910,
    height: 1045,
    platform: "macos",
    locale: "zh-Hans-CN",
    colorScheme: "light",
    storage: { "harness.scenario": "stream", "harness.reply": REPLY },
  });
  await app.waitFor("text:今天要构建什么？", { timeout: 20000 });
  await app.type("label:消息", "acp: anything uncommitted?");
  await app.submit("label:消息");
  await app.waitFor("label:复制回复", { timeout: 60000 });
  const first = decodeLumGrid(await app.screenshot(`${OUT}/settle.png`), 2);
  await app.wait(250);
  const second = decodeLumGrid(await app.screenshot(`${OUT}/settle+250.png`), 2);
  await app.wait(1000);
  const last = decodeLumGrid(await app.screenshot(`${OUT}/settled.png`), 2);
  for (let i = 0; i < 12; i++) {
    await app.screenshot(`${OUT}/f${String(i).padStart(2, "0")}.png`);
    await app.wait(100);
  }
  expect(app.shows("label:复制回复")).toBe(true);

  // The transcript region (right of the sidebar, above the composer).
  const x0 = Math.round(last.width * 0.35);
  const x1 = last.width - 20;
  const y1 = Math.round(last.height * 0.78);

  // Transient damage: the settle frame must already look settled. A veil chunk
  // still fading or the header's seconds ticking changes well under 1% of the
  // pixels; an animated settle pass ghosts whole rows (~a third of them).
  const pixelDiff = (a: Grid, b: Grid) => {
    let changed = 0;
    let total = 0;
    for (let y = 60; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        total++;
        if (Math.abs(lum(a, x, y) - lum(b, x, y)) > 24) changed++;
      }
    }
    return changed / total;
  };
  expect(pixelDiff(first, last)).toBeLessThan(0.06);
  expect(pixelDiff(second, last)).toBeLessThan(0.06);

  // The reply's last paragraph is two visual lines ("…需要我看一下 Vanish.test.tsx
  // 的内容，或者帮你提交吗？" wraps): the last two wide text bands are its lines,
  // ~one line-height apart. A clipped paragraph leaves one band, or a second
  // band cut short — or, in the ghosted run, bands doubled over one another.
  const bands = textBands(last, x0, x1, y1).filter((b) => b.max > 30 && b.s > 50);
  const para = bands[bands.length - 2];
  const paraTail = bands[bands.length - 1];
  expect(paraTail).toBeDefined();
  expect(para).toBeDefined();
  // Two real lines of this paragraph: adjacent starts and full height.
  expect(paraTail.s - para.s).toBeLessThanOrEqual(30);
  expect(paraTail.e - paraTail.s).toBeGreaterThanOrEqual(7);
  expect(para.e - para.s).toBeGreaterThanOrEqual(7);
}, 180000);
