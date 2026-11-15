// The built-in live wallpapers. One sheet, one ink: the page is the app's own
// background, and on it a fixed grid of digits — a 0 or a 1 to each cell,
// never moving. A creature is not drawn on the grid; it passes through it.
// Each is a translucent body, and what a cell shows is how much of that body
// the eye looks through there: the more there is, the more ink its digit
// takes, and past that the paper under it tints. No outline is ever drawn —
// an edge is where the body runs out.

/** What every preset reads: the appearance, the pointer and the last click
 * (0..1 across the window), the click's fading `pulse`, the agent's `energy`,
 * a `phase` added to the clock, and where the window lies in the shader's box
 * (`view*`, in `uv`; `unit` is box points per screen point). */
const UNIFORMS_WGSL = `
struct Uniforms {
  dark: f32,
  mouseX: f32,
  mouseY: f32,
  pulse: f32,
  pingX: f32,
  pingY: f32,
  energy: f32,
  phase: f32,
  unit: f32,
  viewX: f32,
  viewY: f32,
  viewW: f32,
  viewH: f32,
}
`;

/** The sheet: its grid, its two digits, and how a body's depth becomes ink. */
const SHEET_WGSL = `
// The grid's pitch, in screen points: the digits stand in square cells, a
// narrow figure to each, the rows all but touching.
const PITCH: f32 = 9.0;

fn hash21(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, p3.yzx + vec3f(33.33));
  return fract((p3.x + p3.y) * p3.z);
}

fn hash11(x: f32) -> f32 {
  var p = fract(x * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

fn sdSeg(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let h = clamp(dot(pa, ba) / max(dot(ba, ba), 0.000001), 0.0, 1.0);
  return length(pa - ba * h);
}

// Where a point of the box falls on the sheet.
struct Frame {
  cell: vec2f, // the cell's column and row, from the window's corner
  q: vec2f,    // the point inside the cell: -0.5..0.5 across, 0..1 down
  p: vec2f,    // the cell's middle in the scene: the box's height is 1, its middle 0, y down
  ps: f32,     // a cell's side in the scene
  px: f32,     // a device pixel in cells
}

fn frame(uv: vec2f) -> Frame {
  let unit = max(uniforms.unit, 0.01);
  let view = vec2f(uniforms.viewX, uniforms.viewY);
  let sp = (uv - view) * nsh.size / unit;
  let cell = floor(sp / PITCH);
  let mid = view + (cell + vec2f(0.5)) * PITCH * unit / nsh.size;
  return Frame(
    cell,
    sp / PITCH - cell - vec2f(0.5, 0.0),
    (mid - vec2f(0.5)) * nsh.size / max(nsh.size.y, 1.0),
    PITCH * unit / max(nsh.size.y, 1.0),
    1.0 / (PITCH * max(nsh.scale, 1.0))
  );
}

// The scene point of a place in the window (0..1 across it): the pointer, a click.
fn sceneAt(w: vec2f) -> vec2f {
  let at = vec2f(uniforms.viewX, uniforms.viewY) + w * vec2f(uniforms.viewW, uniforms.viewH);
  return (at - vec2f(0.5)) * nsh.size / max(nsh.size.y, 1.0);
}

// The two figures, as the distance to the middle of their strokes: a 0 is an
// oval, a 1 a stem with its flag.
fn digit(one: bool, q: vec2f) -> f32 {
  if (one) {
    return min(
      sdSeg(q, vec2f(-0.20, 0.135), vec2f(0.06, 0.035)),
      sdSeg(q, vec2f(0.06, 0.035), vec2f(0.06, 0.93))
    );
  }
  let r = vec2f(0.265, 0.45);
  let v = (q - vec2f(0.0, 0.485)) / r;
  let l = length(v);
  return abs(l - 1.0) * l / max(length(v / r), 0.0001);
}

// A cell of the sheet under a body of depth d (0 nothing, 1 all there is).
// The digit takes its ink over the lower part of the range; what the body
// has beyond that tints the paper under it. spark: a stray digit's ink where
// there is no body.
fn sheet(f: Frame, d: f32, spark: f32, paper: vec3f, ink: vec3f, wash: vec3f, deep: f32) -> vec3f {
  let n = hash21(f.cell + vec2f(11.0, 47.0));
  let a = max(clamp(d * 2.7, 0.0, 1.0), spark);
  let tint = clamp(d * 0.25 + max(d - 0.28, 0.0) * 1.35, 0.0, 0.84) * deep;
  let s = digit(n > 0.49 && spark <= 0.0, f.q) - 0.074;
  let cov = clamp(0.5 - s / f.px, 0.0, 1.0);
  return mix(mix(paper, wash, tint), ink, cov * a);
}

// The two places a ray (from o along d) crosses an ellipsoid of radii r about
// the origin, nearer first; the first is past the second when it misses.
fn crossing(o: vec3f, d: vec3f, r: vec3f) -> vec2f {
  let oo = o / r;
  let dd = d / r;
  let a = dot(dd, dd);
  let b = dot(oo, dd);
  let disc = b * b - a * (dot(oo, oo) - 1.0);
  if (disc <= 0.0) {
    return vec2f(1.0, -1.0);
  }
  let sq = sqrt(disc);
  return vec2f((-b - sq) / a, (-b + sq) / a);
}
`;

const JELLY_WGSL = `
${UNIFORMS_WGSL}
${SHEET_WGSL}

// A swim stroke, in seconds.
const STROKE: f32 = 4.6;

// Which way a jellyfish heads (0 is up, turning clockwise), wandering.
fn heading(t: f32, seed: f32) -> f32 {
  return 0.17 * sin(0.090 * t + seed * 40.0) + 0.10 * sin(0.041 * t + seed * 70.0);
}

// How much of the bell's wall a ray along d passes where it crosses it at p:
// a veil, so all but nothing seen square on and the most where the eye looks
// along it — the edge of the form. Eight ribs run from under the crown to
// the lip, which lies a little under the bell's widest and so turns in; the
// wall thickens in the band above it.
fn wall(p: vec3f, d: vec3f, r: vec3f, spin: f32) -> f32 {
  let y0 = -0.22 * r.y;
  if (p.y < y0) {
    return 0.0;
  }
  let n = normalize(p / (r * r));
  let h = (p.y - y0) / (r.y - y0);
  let rib = pow(0.5 + 0.5 * cos(8.0 * (atan2(p.z, p.x) + spin)), 6.0) * smoothstep(0.97, 0.55, h);
  return (1.0 + 2.6 * rib + 1.2 * smoothstep(0.20, 0.0, h)) / max(abs(dot(n, d)), 0.15);
}

// A jellyfish: how much of it a ray through p passes, as an optical depth.
// c: the middle of its bell's mouth, R: the bell's radius (scene units),
// turn: its heading over the wander, tip: how far its crown tips away from
// the eye (so the mouth shows), squeeze: a stroke asked for from outside,
// live: how hard it works (0..1).
fn jelly(p: vec2f, c: vec2f, R: f32, turn: f32, tip: f32, seed: f32, t: f32, ps: f32, squeeze: f32, live: f32) -> f32 {
  let s2 = (p - c) / R;
  let al = heading(t, seed) + turn;
  let us = dot(s2, vec2f(cos(al), sin(al)));   // across the body
  let ua = dot(s2, vec2f(sin(al), -cos(al)));  // toward the crown
  let w = -ua;                                 // down the trailing parts
  if (abs(us) > 2.2 || w < -1.3 || w > 3.4) {
    return 0.0;
  }

  // the stroke: the bell closes fast and opens slowly
  let ph = fract(t / STROKE + seed);
  let k = clamp((1.0 + 0.35 * live) * smoothstep(0.0, 0.20, ph) * (1.0 - smoothstep(0.20, 0.92, ph)) + squeeze, 0.0, 1.3);
  let r3 = vec3f(1.0 - 0.18 * k, 0.86 + 0.17 * k, 1.0 - 0.18 * k);
  let a = r3.x;

  let sb = sin(tip);
  let cb = cos(tip);
  let o = vec3f(us, ua * cb, -ua * sb);
  let d = vec3f(0.0, sb, cb);
  let spin = 0.05 * t + seed * 20.0;
  var tau = 0.0;

  // the bell: the near wall, and the far one seen through it or through the mouth
  let x = crossing(o, d, r3);
  if (x.y > x.x) {
    tau += 0.15 * (wall(o + d * x.x, d, r3, spin) + 0.8 * wall(o + d * x.y, d, r3, spin));
    // what it carries under the crown
    let cs = crossing(o - vec3f(0.0, 0.46 * r3.y, 0.0), d, vec3f(0.36 * a, 0.22 * r3.y, 0.36 * a));
    tau += 0.7 * max(cs.y - cs.x, 0.0);
  }

  // what trails keeps the heading the bell had when it passed there
  let lag = max(w, 0.0);
  let bend = w * (heading(t, seed) - heading(t - 1.1 * lag, seed));
  let beat = 6.2832 * (t / STROKE + seed);
  let sway = 1.0 + 0.5 * live;

  // the four arms: ribbons that leave the mouth together and fan out,
  // twisting as they hang — wide and faint where they face the eye, narrow
  // and dense where they turn their edge to it, frilled along their length
  for (var i = 0; i < 4; i++) {
    let fi = f32(i);
    let len = 1.8 + 0.40 * sin(fi * 2.1 + seed * 9.0);
    if (w > -0.20 && w < len) {
      let h = clamp((w + 0.20) / (len + 0.20), 0.0, 1.0);
      let xc = (0.05 + 0.40 * pow(h, 0.8)) * a * cos(fi * 1.5708 + spin + 0.4)
             + (0.02 + 0.14 * h) * sway * sin(2.4 * w - beat + fi * 1.7) + bend;
      let hw = 0.04 + 0.11 * pow(sin(3.14159 * pow(h, 0.6)), 0.8);
      let th = fi * 0.9 + 2.0 * w - 0.5 * t + 0.7 * sin(6.0 * w - 1.5 * t + fi * 2.0);
      let face = max(abs(cos(th)), 0.30);
      let half = hw * face * (1.0 + 0.22 * sin(19.0 * w - 2.3 * t + fi * 4.0)) + 0.01;
      tau += 0.34 / face * (1.0 - smoothstep(half - 0.045, half + 0.045, abs(us - xc)))
           * (1.0 - 0.6 * h) * smoothstep(-0.20, 0.12, w);
    }
  }

  // the tentacles: a fine line from each station round the lip
  let sig = max(0.60 * ps / R, 0.02);
  for (var i = 0; i < 16; i++) {
    let fi = f32(i);
    let phi = fi * 0.39270 + spin + 0.2;
    let sn = sin(phi);
    let v = w - 0.22 * r3.y * cb - a * sn * sb;
    let len = 1.7 + 1.4 * hash11(fi * 3.7 + seed * 91.0);
    if (v > 0.0 && v < len) {
      let h = v / len;
      let xc = a * cos(phi) * (1.0 - 0.34 * h)
             + (0.015 + 0.15 * h) * sway * sin(3.1 * v - beat - 0.6 + fi * 1.3) + bend;
      let dx = (us - xc) / sig;
      tau += 0.50 * exp(-dx * dx) * pow(1.0 - h, 1.1) * (0.55 + 0.45 * (0.5 - 0.5 * sn));
    }
  }
  return tau;
}

fn shade(uv: vec2f) -> vec4f {
  let f = frame(uv);
  let t = nsh.time + uniforms.phase;
  let dark = uniforms.dark > 0.5;
  let live = clamp(uniforms.energy, 0.0, 1.0);
  let paper = select(vec3f(0.987, 0.990, 0.995), vec3f(0.055, 0.062, 0.074), dark);
  let ink = select(vec3f(0.123, 0.178, 0.781), vec3f(0.742, 0.816, 1.000), dark);
  let wash = select(vec3f(0.506, 0.610, 0.891), vec3f(0.135, 0.223, 0.632), dark);

  // the one in front keeps to the open water at the window's right, clear of
  // what stands in the middle; the pointer is a current it leans away from,
  // and a click is a stroke it takes at once
  let m = sceneAt(vec2f(uniforms.mouseX, uniforms.mouseY));
  var c = vec2f(0.50 + 0.04 * sin(0.050 * t), -0.22 + 0.035 * sin(0.037 * t + 1.0));
  let stroke = fract(t / STROKE + 0.13);
  let hd = heading(t, 0.13) - 0.20;
  c += vec2f(sin(hd), -cos(hd)) * 0.022 * sin(6.2832 * (stroke - 0.16));
  let away = c - m;
  let near = smoothstep(0.42, 0.0, length(away));
  c += away / max(length(away), 0.001) * 0.05 * near;
  let turn = -0.20 + 0.5 * near * clamp(away.x * 4.0, -1.0, 1.0);
  let tip = 0.36 + 0.08 * sin(0.07 * t + 1.0);

  var tau = jelly(f.p, c, 0.165, turn, tip, 0.13, t, f.ps, clamp(uniforms.pulse, 0.0, 1.0), live);
  // another, farther off: smaller, and less of it to look through
  tau += 0.7 * jelly(f.p, vec2f(-0.31 + 0.04 * sin(0.043 * t + 2.0), 0.25 + 0.035 * sin(0.031 * t)), 0.074, 0.26, 0.30, 0.57, t, f.ps, 0.0, live);
  let depth = 1.0 - exp(-tau);

  // a digit left standing here and there in the open water, more of them
  // while the agent works
  let n = hash21(f.cell + vec2f(3.0, 71.0));
  var spark = 0.0;
  if (depth < 0.004 && n > 0.9972 - 0.004 * live) {
    let s = sin(t * 0.7 + n * 4000.0);
    spark = 0.04 + 0.08 * s * s;
  }

  return vec4f(sheet(f, depth, spark, paper, ink, wash, select(1.0, 0.8, dark)), 1.0);
}
`;

/** A built-in live wallpaper: its title, what its button says, the accent the
 * theme takes from it, and its shader. */
export interface WallpaperPresetDef {
  name: string;
  en: string;
  zh: string;
  dominantColor: string;
  source: string;
}

export const WALLPAPER_PRESET_DEFS = {
  jelly: { name: "Medusa", en: "Jellyfish", zh: "水母", dominantColor: "#3340c8", source: JELLY_WGSL },
} satisfies Record<string, WallpaperPresetDef>;

export type WallpaperPreset = keyof typeof WALLPAPER_PRESET_DEFS;

/** Presets retired from the set map onto their successors, so a stored
 * `preset:` wallpaper upgrades instead of losing its shader. */
export const LEGACY_WALLPAPER_PRESETS: Record<string, WallpaperPreset> = {
  flock: "jelly",
  orbit: "jelly",
  aurora: "jelly",
  fluid: "jelly",
  cosmos: "jelly",
  matrix: "jelly",
  stellar: "jelly",
  ember: "jelly",
  sunset: "jelly",
  dotwave: "jelly",
};

/** Every member of the presets' `struct Uniforms`, at rest: the pointer and
 * the last click in the middle of the window, the window filling the box. */
export function wallpaperPresetUniforms(dark: boolean, energy = 0): Record<string, number> {
  return {
    dark: dark ? 1.0 : 0.0,
    mouseX: 0.5,
    mouseY: 0.5,
    pulse: 0.0,
    pingX: 0.5,
    pingY: 0.5,
    energy,
    phase: 0.0,
    unit: 1.0,
    viewX: 0.0,
    viewY: 0.0,
    viewW: 1.0,
    viewH: 1.0,
  };
}
