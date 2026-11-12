// Renders pipi's brand assets from the mascot's geometry (mascot/geometry.ts):
//
//   node scripts/render-brand.mjs
//
// Writes icon.png (the 1024 px app icon nsh.json names), assets/brand/pip.svg,
// assets/brand/pip-<mood>.svg and assets/brand/coat-<coat>.svg, and proofs
// (sizes, moods, coats) under assets/brand/proof/.
// It needs nothing but Node 22.18+ (it imports the .ts geometry directly): the
// rasterizer below is a small signed-distance renderer, enough for Bézier
// paths (flattened to polylines), ellipses and a squircle.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { BOUNDS, COATS, COAT_IDS, GRID, LINE_COLORS, LINE_PAINT, pip, SPECIES, svgPath } from "../mascot/geometry.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = (...parts) => {
  const path = join(root, ...parts);
  mkdirSync(dirname(path), { recursive: true });
  return path;
};

// ── SVG ─────────────────────────────────────────────────────────────────────

const color = (paint, line) => (paint === LINE_PAINT ? line : paint);

function svgShape(s, line) {
  if (s.kind === "ellipse") return `<ellipse fill="${color(s.fill, line)}" cx="${s.cx}" cy="${s.cy}" rx="${s.rx}" ry="${s.ry}"/>`;
  const fill = s.fill ? color(s.fill, line) : "none";
  const stroke = s.stroke ? ` stroke="${color(s.stroke, line)}" stroke-width="${s.width ?? 2}" stroke-linecap="round" stroke-linejoin="round"` : "";
  return `<path fill="${fill}"${stroke}${s.clip ? ' clip-path="url(#body)"' : ""} d="${svgPath(s.d)}"/>`;
}

function svg(mood, coat = "ghost", { size = 256, line = LINE_COLORS.light } = {}) {
  const body = pip(mood, coat).map((s) => svgShape(s, line)).join("");
  const clip = `<defs><clipPath id="body"><path d="${svgPath(SPECIES[COATS[coat].species].body.d)}"/></clipPath></defs>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${GRID} ${GRID}"><title>Pip</title>${clip}${body}</svg>\n`;
}

// ── Raster ──────────────────────────────────────────────────────────────────

const hex = (color) => [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) / 255);
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

/** A path's commands as polylines, curves flattened; each knows whether it was closed. */
function flatten(d) {
  const lines = [];
  let pts = null;
  let at = [0, 0];
  const N = 16;
  for (const [op, ...n] of d) {
    if (op === "M") {
      pts = [[n[0], n[1]]];
      lines.push({ pts, closed: false });
      at = [n[0], n[1]];
    } else if (op === "L") {
      pts.push([n[0], n[1]]);
      at = [n[0], n[1]];
    } else if (op === "Q") {
      const [x0, y0] = at;
      for (let i = 1; i <= N; i++) {
        const t = i / N;
        const u = 1 - t;
        pts.push([u * u * x0 + 2 * u * t * n[0] + t * t * n[2], u * u * y0 + 2 * u * t * n[1] + t * t * n[3]]);
      }
      at = [n[2], n[3]];
    } else if (op === "C") {
      const [x0, y0] = at;
      for (let i = 1; i <= N; i++) {
        const t = i / N;
        const u = 1 - t;
        pts.push([
          u ** 3 * x0 + 3 * u * u * t * n[0] + 3 * u * t * t * n[2] + t ** 3 * n[4],
          u ** 3 * y0 + 3 * u * u * t * n[1] + 3 * u * t * t * n[3] + t ** 3 * n[5],
        ]);
      }
      at = [n[4], n[5]];
    } else {
      lines[lines.length - 1].closed = true;
      pts.push(pts[0]);
    }
  }
  return lines;
}

/** Distance from a point to a segment. */
function dSegment(px, py, [ax, ay], [bx, by]) {
  const l = (bx - ax) ** 2 + (by - ay) ** 2;
  const t = l ? Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / l)) : 0;
  return Math.hypot(px - ax - (bx - ax) * t, py - ay - (by - ay) * t);
}

/** A shape prepared for sampling: `fill(x, y)` and `stroke(x, y)` give signed distances in grid units (or Infinity). */
function prepare(shape) {
  if (shape.kind === "ellipse") {
    const { cx, cy, rx, ry } = shape;
    const fill = (x, y) => (Math.hypot((x - cx) / rx, (y - cy) / ry) - 1) * Math.min(rx, ry);
    return {
      fill,
      fillPaint: shape.fill,
      stroke: () => Infinity,
      minX: cx - rx - 4,
      maxX: cx + rx + 4,
      minY: cy - ry - 4,
      maxY: cy + ry + 4,
    };
  }
  const lines = flatten(shape.d);
  const segs = lines.flatMap(({ pts }) => pts.slice(1).map((p, i) => [pts[i], p]));
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const { pts } of lines) {
    for (const [x, y] of pts) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const pad = (shape.width ?? 2) / 2 + 4;
  const edge = (x, y) => {
    let m = Infinity;
    for (let i = 0; i < segs.length; i++) {
      const d = dSegment(x, y, segs[i][0], segs[i][1]);
      if (d < m) m = d;
    }
    return m;
  };
  const inside = (x, y) => {
    let w = 0;
    for (const { pts, closed } of lines) {
      if (!closed) continue;
      for (let i = 0; i + 1 < pts.length; i++) {
        const [ax, ay] = pts[i];
        const [bx, by] = pts[i + 1];
        if ((ay <= y) !== (by <= y) && x < ax + ((y - ay) * (bx - ax)) / (by - ay)) w ^= 1;
      }
    }
    return w === 1;
  };
  return {
    fill: shape.fill ? (x, y) => (inside(x, y) ? -1 : 1) * edge(x, y) : () => Infinity,
    fillPaint: shape.fill,
    stroke: shape.stroke ? (x, y) => edge(x, y) - (shape.width ?? 2) / 2 : () => Infinity,
    strokePaint: shape.stroke,
    clip: shape.clip,
    minX: minX - pad,
    maxX: maxX + pad,
    minY: minY - pad,
    maxY: maxY + pad,
  };
}

/** Coverage of a pixel whose center is `d` pixels from an edge. */
const cover = (d) => Math.max(0, Math.min(1, 0.5 - d));

/** A canvas of straight-alpha RGBA floats. */
function canvas(width, height = width) {
  const px = new Float64Array(width * height * 4);
  return {
    width,
    height,
    px,
    /** Draws `color` over what is there with coverage `a`. */
    over(i, color, a) {
      const o = i * 4;
      const ba = px[o + 3];
      const oa = a + ba * (1 - a);
      if (oa <= 0) return;
      for (let c = 0; c < 3; c++) px[o + c] = (color[c] * a + px[o + c] * ba * (1 - a)) / oa;
      px[o + 3] = oa;
    },
  };
}

function png({ width, height, px }) {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width * 4; x++) raw[y * stride + 1 + x] = Math.round(Math.max(0, Math.min(1, px[y * width * 4 + x])) * 255);
  }
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "latin1");
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Draws Pip into `target`, the grid mapped to a square of `side` pixels at `[ox, oy]`, with the outline in `line`. */
function drawPip(target, mood, ox, oy, side, { coat = "ghost", line = LINE_COLORS.light, shadow = false } = {}) {
  const scale = side / GRID;
  const shapes = pip(mood, coat).map(prepare);
  const body = prepare({ ...SPECIES[COATS[coat].species].body, fill: "#000000" });
  const rgb = (paint) => hex(color(paint, line));
  if (shadow) {
    const scx = ox + side * 0.5;
    const scy = oy + side * 0.91;
    const srx = side * 0.31;
    const sry = side * 0.065;
    for (let y = Math.max(0, Math.floor(scy - sry * 2.2)); y < Math.min(target.height, Math.ceil(scy + sry * 2.2)); y++) {
      for (let x = Math.max(0, Math.floor(scx - srx * 2.2)); x < Math.min(target.width, Math.ceil(scx + srx * 2.2)); x++) {
        const dx = (x + 0.5 - scx) / srx;
        const dy = (y + 0.5 - scy) / sry;
        const a = 0.09 * Math.exp(-(dx * dx + dy * dy) * 1.5);
        if (a > 0.002) target.over(y * target.width + x, [0.08, 0.09, 0.14], a);
      }
    }
  }
  for (let y = Math.max(0, Math.floor(oy)); y < Math.min(target.height, Math.ceil(oy + side)); y++) {
    const gy = (y + 0.5 - oy) / scale;
    if (gy < body.minY - 2 || gy > body.maxY + 2) continue;
    for (let x = Math.max(0, Math.floor(ox)); x < Math.min(target.width, Math.ceil(ox + side)); x++) {
      const gx = (x + 0.5 - ox) / scale;
      if (gx < body.minX - 2 || gx > body.maxX + 2) continue;
      const i = y * target.width + x;
      let inside = -1;
      for (const s of shapes) {
        if (gx < s.minX || gx > s.maxX || gy < s.minY || gy > s.maxY) continue;
        if (s.clip && inside < 0) inside = cover(body.fill(gx, gy) * scale);
        const k = s.clip ? inside : 1;
        if (k <= 0) continue;
        if (s.fillPaint) target.over(i, rgb(s.fillPaint), k * cover(s.fill(gx, gy) * scale));
        if (s.strokePaint) target.over(i, rgb(s.strokePaint), k * cover(s.stroke(gx, gy) * scale));
      }
    }
  }
}

/** Pip alone on a transparent square, filling its width: the proofs of small sizes. */
function glyph(size, mood = "idle") {
  const target = canvas(size);
  drawPip(target, mood, 0, 0, size);
  return target;
}

/**
 * The app icon: Pip on a crisp white macOS squircle tile. The tile follows
 * macOS's icon grid (an 824 px squircle in a 1024 px canvas, with the system's
 * soft shadow and subtle rim border) so it sits cleanly in the Dock on both
 * light and dark wallpapers.
 */
function icon(size = 1024) {
  const target = canvas(size);
  const u = size / 1024;
  const tile = { x: 100 * u, y: 100 * u, w: 824 * u, h: 824 * u };
  const half = tile.w / 2;
  const cx = tile.x + half;
  const cy = tile.y + half;
  // A superellipse: the continuous corners of macOS's icon shape.
  const squircle = (px, py, grow = 0) => {
    const nx = Math.abs(px - cx) / (half + grow);
    const ny = Math.abs(py - cy) / (half + grow);
    const k = (nx ** 5 + ny ** 5) ** (1 / 5);
    return (k - 1) * (half + grow) * 0.92;
  };
  const top = hex("#FFFFFF");
  const bottom = hex("#F4F5F8");
  const border = hex("#D8DCE6");
  const pipSide = 620 * u;
  const pipX = cx - pipSide / 2 - 8 * u;
  // The art's middle (grid y 32) sits a little above the tile's.
  const pipY = cy - pipSide / 2 - 20 * u;
  const floor = pipY + ((BOUNDS.y + BOUNDS.h) / GRID) * pipSide;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const i = y * size + x;
      // The Dock's shadow: soft, below the tile.
      const shadow = squircle(px, py - 12 * u, 2 * u);
      target.over(i, [0, 0, 0], 0.22 * Math.max(0, Math.min(1, 1 - (shadow + 6 * u) / (28 * u))) ** 2);
      const d = squircle(px, py);
      const a = cover(d);
      if (a <= 0) continue;
      const t = (py - tile.y) / tile.h;
      let color = mix(top, bottom, t ** 1.1);
      // A crisp hairline border inside the edge so the white tile holds its shape on light backgrounds.
      const edge = Math.max(0, 1 - Math.abs(d + 1.5 * u) / (1.8 * u));
      color = mix(color, border, 0.55 * edge * (0.55 + 0.45 * t));
      target.over(i, color, a);
      // Pip floats: a soft neutral shadow on the floor, clear of the hem.
      const sx = (px - cx) / (210 * u);
      const sy = (py - floor - 46 * u) / (18 * u);
      target.over(i, [0.08, 0.09, 0.14], a * 0.1 * Math.exp(-(sx * sx + sy * sy) * 1.4));
    }
  }
  drawPip(target, "idle", pipX, pipY, pipSide);
  return target;
}

/** A sheet of the glyph at the sizes that matter, on both appearances: the proof it reads at 16 px. */
function proof() {
  const sizes = [16, 20, 24, 32, 48, 64, 128];
  const pad = 24;
  const width = sizes.reduce((w, s) => w + s + pad, pad);
  const height = (128 + pad * 2) * 2;
  const target = canvas(width, height);
  const grounds = [hex("#FAFBFD"), hex("#14161B")];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) target.over(y * width + x, grounds[y < height / 2 ? 0 : 1], 1);
  grounds.forEach((_, row) => {
    let x = pad;
    for (const size of sizes) {
      drawPip(target, "idle", x, row * (height / 2) + pad + (128 - size), size, { line: row ? LINE_COLORS.dark : LINE_COLORS.light });
      x += size + pad;
    }
  });
  return target;
}

/** Every mood side by side, to review the expressions. */
function moods() {
  const all = ["idle", "think", "work", "write", "happy", "error", "sleep"];
  const cell = 160;
  const width = cell * all.length;
  const target = canvas(width, cell);
  for (let y = 0; y < cell; y++) for (let x = 0; x < width; x++) target.over(y * width + x, hex("#14161B"), 1);
  all.forEach((mood, i) => drawPip(target, mood, i * cell + 24, 24, cell - 48, { line: LINE_COLORS.dark }));
  return target;
}

/** Every coat, on both appearances. */
function coats() {
  const cell = 150;
  const width = cell * COAT_IDS.length;
  const height = cell * 2;
  const target = canvas(width, height);
  const grounds = [hex("#FAFBFD"), hex("#14161B")];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) target.over(y * width + x, grounds[y < cell ? 0 : 1], 1);
  for (const row of [0, 1]) {
    COAT_IDS.forEach((coat, i) => drawPip(target, "idle", i * cell + 19, row * cell + 19, cell - 38, { coat, line: row ? LINE_COLORS.dark : LINE_COLORS.light }));
  }
  return target;
}

/**
 * macOS DMG installer background (660 × 420 pt):
 * - Left (`x = 162, y = 204`): soft pedestal where `pipi.app` sits.
 * - Center (`x = 248..304, y = 204`): drag-to-install chevron arrow.
 * - Right (`x = 468, y = 206`): `Applications` folder surrounded in a circle by
 *   all 14 of pipi's cats and dogs (alternating species around the ring).
 */
function dmgBackground(scale = 1) {
  const W = 660 * scale;
  const H = 420 * scale;
  const target = canvas(W, H);
  const top = hex("#FAFBFD");
  const bottom = hex("#F1F4FA");
  const ringTint = hex("#E5EAF4");
  const dashColor = hex("#CED6E6");
  const arrowColor = hex("#7E89A1");
  const appCx = 162 * scale;
  const appCy = 204 * scale;
  const dirCx = 468 * scale;
  const dirCy = 206 * scale;
  const ringR = 136 * scale;

  for (let y = 0; y < H; y++) {
    const ty = y / H;
    const baseRow = mix(top, bottom, ty ** 1.05);
    for (let x = 0; x < W; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const i = y * W + x;
      let c = baseRow;
      // Soft radial glow around the Applications ring on the right.
      const dr = Math.hypot(px - dirCx, py - dirCy);
      const glowR = Math.exp(-((dr / (148 * scale)) ** 2) * 1.3);
      c = mix(c, [1, 1, 1], 0.55 * glowR);
      // Soft inner halo behind the Applications folder.
      const innerD = dr - 74 * scale;
      const innerA = cover(innerD);
      if (innerA > 0) c = mix(c, ringTint, 0.22 * innerA);
      // Soft pedestal halo behind pipi.app on the left.
      const dl = Math.hypot(px - appCx, py - appCy);
      const leftA = cover(dl - 66 * scale);
      if (leftA > 0) c = mix(c, ringTint, 0.22 * leftA);
      target.over(i, c, 1);

      // Subtle dashed circular track connecting the cats & dogs around Applications.
      const trackDist = Math.abs(dr - ringR) - 0.9 * scale;
      const trackA = cover(trackDist);
      if (trackA > 0) {
        const angle = Math.atan2(py - dirCy, px - dirCx);
        const wave = Math.cos(angle * 42);
        if (wave > 0) target.over(i, dashColor, 0.55 * trackA * Math.min(1, wave * 3));
      }
    }
  }

  // Drag arrow between pipi.app (left) and the Applications circle (right).
  const arrowShape = prepare({
    kind: "path",
    stroke: "#7E89A1",
    width: 2.8 * scale,
    d: [
      ["M", 252 * scale, 204 * scale],
      ["L", 296 * scale, 204 * scale],
      ["M", 285 * scale, 193 * scale],
      ["L", 297 * scale, 204 * scale],
      ["L", 285 * scale, 215 * scale],
    ],
  });
  for (const dx of [-18, -9]) {
    const dotCx = (252 + dx) * scale;
    const dotCy = 204 * scale;
    const dotR = 2 * scale;
    for (let y = Math.floor(dotCy - dotR - 2); y <= Math.ceil(dotCy + dotR + 2); y++) {
      for (let x = Math.floor(dotCx - dotR - 2); x <= Math.ceil(dotCx + dotR + 2); x++) {
        const a = cover(Math.hypot(x + 0.5 - dotCx, y + 0.5 - dotCy) - dotR);
        if (a > 0) target.over(y * W + x, arrowColor, 0.45 * a);
      }
    }
  }
  for (let y = Math.floor(arrowShape.minY); y <= Math.ceil(arrowShape.maxY); y++) {
    for (let x = Math.floor(arrowShape.minX); x <= Math.ceil(arrowShape.maxX); x++) {
      const a = cover(arrowShape.stroke(x + 0.5, y + 0.5));
      if (a > 0) target.over(y * W + x, arrowColor, 0.72 * a);
    }
  }

  // All 14 coats (7 cats and 7 dogs, alternating around the circle) surrounding Applications.
  const ring = [
    ["ghost", "happy"],
    ["shiba", "idle"],
    ["calico", "idle"],
    ["husky", "think"],
    ["ginger", "happy"],
    ["golden", "idle"],
    ["cow", "write"],
    ["border", "happy"],
    ["siamese", "idle"],
    ["dalmatian", "idle"],
    ["blue", "sleep"],
    ["shepherd", "idle"],
    ["black", "think"],
    ["rottweiler", "happy"],
  ];
  const pipSize = 44 * scale;
  ring.forEach(([coat, mood], idx) => {
    const theta = -Math.PI / 2 + (idx * 2 * Math.PI) / ring.length;
    const cx = dirCx + ringR * Math.cos(theta);
    const cy = dirCy + ringR * Math.sin(theta);
    drawPip(target, mood, cx - pipSize / 2, cy - pipSize / 2, pipSize, {
      coat,
      line: LINE_COLORS.light,
      shadow: true,
    });
  });

  return target;
}

writeFileSync(out("icon.png"), png(icon(1024)));
writeFileSync(out("assets", "brand", "pip.svg"), svg("idle"));
for (const mood of ["think", "write", "happy", "error", "sleep"]) writeFileSync(out("assets", "brand", `pip-${mood}.svg`), svg(mood));
for (const size of [16, 32, 64]) writeFileSync(out("assets", "brand", "proof", `pip-${size}.png`), png(glyph(size)));
writeFileSync(out("assets", "brand", "proof", "sizes.png"), png(proof()));
writeFileSync(out("assets", "brand", "proof", "moods.png"), png(moods()));
for (const coat of COAT_IDS) writeFileSync(out("assets", "brand", `coat-${coat}.svg`), svg("idle", coat));
writeFileSync(out("assets", "brand", "proof", "coats.png"), png(coats()));
writeFileSync(out("assets", "brand", "dmg-background.png"), png(dmgBackground(1)));
writeFileSync(out("assets", "brand", "dmg-background@2x.png"), png(dmgBackground(2)));
console.log("brand assets written: icon.png, assets/brand/");
