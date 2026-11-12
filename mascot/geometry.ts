/**
 * Pip — pipi's mascot — as data.
 *
 * Pip is a little ghost: a sheet with ears, a hem of two lobes, a tail drawn
 * as one line on its right, and a face with no mouth. It is line art — a coat
 * under one round outline, drawn on a 64-unit grid.
 *
 * Pip comes as a cat or a dog, and what tells one coat from the next is what
 * tells the real animals apart, not a recolor: the cat looks through slit
 * pupils and the dog through round ones; the ginger is the fat one, the
 * Siamese slim and cross-eyed with a kinked tail, the British blue all
 * cheeks with small ears and copper eyes, the cow cat wears its center
 * parting, the black cat is a void with two lights in it; the shiba smiles
 * under a curled tail, the husky has one blue eye, one brown and its tongue
 * out, the collie's ear tips fold over, the shepherd is mostly ears, the
 * golden's hang, the rottweiler has brow dots and a stub, the dalmatian a
 * whip.
 *
 * This module has no imports on purpose: the app's canvas (`Pip.tsx`) and the
 * Node brand renderer (`scripts/render-brand.mjs`) both draw from it, so the
 * icon, the SVG and the in-app creature can never drift apart.
 */

/** The side of the square grid Pip is drawn on. */
export const GRID = 64;

/**
 * A color: a hex value, or `"line"` — the outline, which is the one color that
 * follows the appearance (the `pip-line` theme token: ink on light, near-white
 * on dark) so Pip's edge always reads against the background.
 */
export type Paint = string;
export const LINE_PAINT = "line";

/** The outline's color in each appearance (theme.json `pip-line`), for renderers without tokens. */
export const LINE_COLORS = { light: "#16161D", dark: "#F1F2F6" } as const;

/** One path command, in SVG's absolute forms. */
export type Cmd =
  | ["M", number, number]
  | ["L", number, number]
  | ["Q", number, number, number, number]
  | ["C", number, number, number, number, number, number]
  | ["Z"];

/**
 * A path; filled with `fill`, then stroked with `stroke` at `width` (round
 * caps and joins). A `clip` path is a coat marking: drawn only inside the
 * body. A `wag` path is the tail: it swings about the coat's `tailPivot`.
 */
export interface Path {
  kind: "path";
  d: Cmd[];
  fill?: Paint;
  stroke?: Paint;
  width?: number;
  clip?: boolean;
  wag?: boolean;
}

/** A filled ellipse (the eyes; the dog's nose). `lid` marks a part of an eye: its height scales with the blink. */
export interface Ellipse {
  kind: "ellipse";
  fill: Paint;
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  lid?: boolean;
}

export type Shape = Path | Ellipse;

/** What Pip is doing; each mood has its own eyes, and `Pip.tsx` gives each its own motion. */
export type Mood = "idle" | "think" | "work" | "write" | "happy" | "error" | "sleep";

/** Which ghost Pip is. */
export type Species = "cat" | "dog";

/** The width of Pip's outline, in grid units. */
export const LINE = 3.2;

/** The axis the body is symmetric about: left of the grid's middle, to leave room for the tail. */
const AX = 30;

type Point = [number, number];
/** A cubic segment: two control points and the end. */
type Curve = [number, number, number, number, number, number];

/** A shape mirrored about the body's axis. */
function mirror<S extends Shape>(shape: S): S {
  if (shape.kind === "ellipse") return { ...shape, cx: 2 * AX - shape.cx };
  return { ...shape, d: shape.d.map((c) => c.map((v, i) => (i % 2 === 1 ? 2 * AX - (v as number) : v)) as Cmd) };
}

/** A shape and its mirror image. */
const both = <S extends Shape>(shape: S): S[] => [shape, mirror(shape)];

// ── The body ────────────────────────────────────────────────────────────────
//
// Shapes below are written as distances from the axis (`dx`), for the right
// half; the left half is the mirror image.

/**
 * The ears, which shape the top of the sheet: the cat's points (`tall`: the
 * Siamese's, larger on a narrower head; `round`: the British blue's), the
 * dog's upright ears (`big`: the shepherd's; `tipped`: the collie's, whose
 * tips fold over), or a plain dome for ears that hang in front of it (`drop`).
 */
export type Ears = "cat" | "tall" | "round" | "prick" | "big" | "tipped" | "drop";

/** How a coat is built: its ears, and half its width at the ears' base (`h`), at the flanks (`m`) and at the hem (`w`). */
export interface Build {
  ears: Ears;
  h: number;
  m: number;
  w: number;
}

/** The top of the right half, from the crown on the axis (at height `top`) round the ear to its base at `(h, 22)`. */
function crown(ears: Ears, h: number): { top: number; right: Curve[] } {
  switch (ears) {
    case "tall":
      return {
        top: 15,
        right: [
          [2, 15, 2.8, 15.2, 3.6, 15.8],
          [5.4, 12.4, h - 5.6, 8.5, h - 3.3, 9.1],
          [h - 0.9, 9.9, h + 0.4, 16, h, 22],
        ],
      };
    case "round":
      return {
        top: 13.6,
        right: [
          [4, 13.6, 6.4, 13.9, 8.2, 15.2],
          [9, 12.2, 11.4, 10.3, h - 3.8, 10.4],
          [h - 0.7, 10.6, h + 0.4, 16.6, h, 22],
        ],
      };
    case "prick":
      return {
        top: 13.8,
        right: [
          [2.4, 13.8, 3.8, 14, 5, 14.6],
          [6, 11.8, 8.4, 8.5, h - 5.6, 8.9],
          [h - 2.6, 9.5, h - 0.5, 15.5, h, 22],
        ],
      };
    case "big":
      return {
        top: 15.2,
        right: [
          [1.4, 15.2, 2.2, 15.4, 3, 16],
          [4, 12.6, 6.6, 8.4, h - 6.3, 8.8],
          [h - 2.6, 9.6, h + 0.2, 15.5, h, 22],
        ],
      };
    case "tipped":
      return {
        top: 13.8,
        right: [
          [2.4, 13.8, 3.8, 14, 5, 14.6],
          // Up to the bend, over it, and out to the tip that hangs past the head.
          [5.8, 12.4, 7.2, 9.6, 9.8, 9.3],
          [12.6, 9, 16.6, 10.8, 18.6, 14.4],
          [17, 15, 15.6, 15.6, 14.8, 16.8],
          [15.8, 18, h - 0.2, 19.8, h, 22],
        ],
      };
    case "drop":
      return { top: 13.4, right: [[h * 0.5, 13.4, h - 2.2, 16, h, 22]] };
    default:
      return {
        top: 13.9,
        right: [
          [2.6, 13.9, 4.2, 14.1, 5.6, 14.7],
          [7.6, 11.6, h - 6.4, 8.7, h - 4.1, 9.4],
          [h - 1.5, 10.3, h - 0.4, 16, h, 22],
        ],
      };
  }
}

/** The sheet of a build: ears, flanks that flare to the hem's corner, and a hem of two lobes. Closed. */
function sheet({ ears, h, m, w }: Build): Path {
  const { top, right } = crown(ears, h);
  const lobe = (w - 4.6) / 2;
  const half: Curve[] = [
    ...right,
    // The flank, flaring out to the hem's corner.
    [h + 2.6, 24.8, m - 0.6, 30, m, 35.5],
    [m + 0.6, 41, w - 1, 44, w, 46.6],
    [w + 1, 49.4, w - 1.4, 52, w - 4.6, 51.2],
    // The hem: one lobe, then up to the axis.
    [w - 9, 50.2, lobe + 5, 54.2, lobe, 54.2],
    [lobe - 5, 54.2, 4.6, 50.4, 0, 50.4],
  ];
  const d: Cmd[] = [["M", AX, top], ...half.map((c): Cmd => ["C", AX + c[0], c[1], AX + c[2], c[3], AX + c[4], c[5]])];
  // The left half: the right half mirrored and walked backwards, up to the crown.
  const ends: Point[] = [[0, top], ...half.map((c): Point => [c[4], c[5]])];
  for (let i = half.length - 1; i >= 0; i--) {
    const [ax, ay, bx, by] = half[i];
    d.push(["C", AX - bx, by, AX - ax, ay, AX - ends[i][0], ends[i][1]]);
  }
  d.push(["Z"]);
  return { kind: "path", stroke: LINE_PAINT, width: LINE, d };
}

/** The right ear of a drop-eared dog: a flap from the crown that hangs beside the head down to `tip`, in front of the body. */
function flap(h: number, tip: number, fill: Paint): Path {
  const x = (dx: number) => AX + dx + h - 17;
  const y = (v: number) => 14.6 + ((v - 14.6) * (tip - 14.6)) / 20.4;
  return {
    kind: "path",
    fill,
    stroke: LINE_PAINT,
    width: LINE,
    d: [
      ["M", x(8.5), y(14.6)],
      ["C", x(13.5), y(13.2), x(20.6), y(16), x(21.4), y(23)],
      ["C", x(22), y(28.6), x(21.4), y(34.4), x(18.4), y(35)],
      ["C", x(15.4), y(35.6), x(13.8), y(30.6), x(13.2), y(26)],
      ["C", x(12.7), y(21.6), x(11.2), y(17.4), x(8.5), y(14.6)],
      ["Z"],
    ],
  };
}

// ── The tail ────────────────────────────────────────────────────────────────

/**
 * The tail: one line out of the right flank. `handle` loops back to the hem
 * (the plain cat's); `stout` is the same, shorter (the ginger's); `hook`
 * stands up and curls at the tip; `kink` stands up and bends (the Siamese's);
 * `curl` winds over the back (the shiba's); `sickle` arcs over it (the
 * husky's); `plume` is raised; `low` is carried out behind (the shepherd's); `stub` is a nub;
 * `whip` is long and straight.
 */
export type Tail = "handle" | "stout" | "hook" | "kink" | "curl" | "sickle" | "plume" | "low" | "stub" | "whip";

function tail(kind: Tail, { m, w }: Build): Path {
  // Where the flank and the hem's corner are.
  const o = AX + m;
  const b = AX + w;
  const lines: Record<Tail, Cmd[]> = {
    handle: [
      ["M", o + 0.3, 37],
      ["C", o + 2.5, 33.4, o + 8.7, 33.6, o + 8.5, 38.6],
      ["C", o + 8.3, 42.2, b + 2.6, 44.4, b + 0.4, 46],
    ],
    stout: [
      ["M", o + 0.2, 38.4],
      ["C", o + 2, 35.6, o + 6.6, 35.8, o + 6.4, 40],
      ["C", o + 6.2, 43, b + 2.4, 44.8, b + 0.4, 46.2],
    ],
    hook: [
      ["M", o + 0.6, 43],
      ["C", o + 4.8, 44.6, o + 7.6, 41.6, o + 7.4, 36],
      ["C", o + 7.2, 31.5, o + 9, 26, o + 6, 25.8],
      ["C", o + 4.2, 25.7, o + 3.6, 27.6, o + 4.2, 29.2],
    ],
    kink: [
      ["M", o + 0.5, 43],
      ["C", o + 5, 44.6, o + 8.2, 41.4, o + 8, 35.6],
      ["L", o + 8.4, 29.6],
      ["L", o + 11, 26.4],
    ],
    curl: [
      ["M", o + 0.4, 40.4],
      ["C", o + 4.4, 41.2, o + 9.2, 38.8, o + 9.2, 34],
      ["C", o + 9.2, 29.8, o + 3.8, 29.4, o + 3.8, 33.2],
      ["C", o + 3.8, 35.4, o + 6.4, 35.8, o + 6.6, 33.8],
    ],
    sickle: [
      ["M", o + 0.4, 40.6],
      ["C", o + 4.6, 41.2, o + 9, 37.6, o + 8.6, 32.4],
      ["C", o + 8.3, 29, o + 5.6, 27.8, o + 4, 29.6],
    ],
    plume: [
      ["M", o + 0.4, 41.4],
      ["C", o + 4, 42, o + 7.6, 39, o + 9, 31.6],
    ],
    low: [
      ["M", o + 0.3, 40.6],
      ["C", o + 3.6, 42.2, o + 8, 42.4, o + 10, 38.2],
    ],
    stub: [
      ["M", o + 0.2, 40.6],
      ["C", o + 1.6, 39.8, o + 2.8, 38.8, o + 3.6, 37.6],
    ],
    whip: [
      ["M", o + 0.3, 41.4],
      ["C", o + 3.6, 42.2, o + 7, 39.4, o + 8.4, 34],
      ["C", o + 9.2, 31, o + 9.6, 28.6, o + 10.6, 26.6],
    ],
  };
  return { kind: "path", stroke: LINE_PAINT, width: LINE, wag: true, d: lines[kind] };
}

// ── The face ────────────────────────────────────────────────────────────────

const INK = "#16161D";

/**
 * An eye, as ellipses one inside the next, outermost first: one for an eye
 * that is all pupil, or an iris and its pupil (`dx` moves a layer toward the
 * axis: the Siamese's squint).
 */
export type Eye = { rx: number; ry: number; fill: Paint; dx?: number }[];

/** The cat's eye: a slit. */
const slit = (fill: Paint = INK): Eye => [{ rx: 2.9, ry: 4.5, fill }];
/** The dog's eye: round. */
const round = (fill: Paint = INK): Eye => [{ rx: 2.9, ry: 2.9, fill }];

const line = (paint: Paint, width: number, ...points: Point[]): Path => ({
  kind: "path",
  stroke: paint,
  width,
  d: points.map(([x, y], i): Cmd => (i ? ["L", x, y] : ["M", x, y])),
});

/**
 * One eye of a mood around the center `[cx, cy]`; `side` is -1 for the left
 * eye and 1 for the right. `hunt`: at work the pupil opens wide, as a cat's
 * does on a hunt.
 */
export function eye(mood: Mood, [cx, cy]: readonly [number, number], layers: Eye, side: -1 | 1 = 1, hunt = false): Shape[] {
  const ink = layers[0].fill;
  switch (mood) {
    case "think":
      // Looking up and ahead, toward the tail.
      return [{ kind: "ellipse", fill: ink, cx: cx + 1.4, cy: cy - 1.6, rx: 1.8, ry: 1.9, lid: true }];
    case "write":
      // Looking down at the page.
      return [{ kind: "ellipse", fill: ink, cx, cy: cy + 1.4, rx: 1.9, ry: 2, lid: true }];
    case "happy":
      return [{ kind: "path", stroke: ink, width: 2.2, d: [["M", cx - 2.6, cy + 1], ["Q", cx, cy - 3.4, cx + 2.6, cy + 1]] }];
    case "error":
      return [line(ink, 2.2, [cx - 2, cy - 2], [cx + 2, cy + 2]), line(ink, 2.2, [cx + 2, cy - 2], [cx - 2, cy + 2])];
    case "sleep":
      return [line(ink, 2.2, [cx - 2.3, cy + 1], [cx + 2.3, cy + 1])];
    default:
      return layers.map((l, i): Ellipse => {
        // The whole eye rounds out, and a pupil inside an iris goes from a slit to an oval.
        const wide = hunt && mood === "work";
        const rx = !wide ? l.rx : i ? l.rx * 1.9 : l.rx * (layers.length > 1 ? 1.18 : 1.3);
        const ry = wide && !i && layers.length === 1 ? l.ry * 0.94 : l.ry;
        return { kind: "ellipse", fill: l.fill, cx: cx - side * (wide ? 0 : (l.dx ?? 0)), cy, rx, ry, lid: true };
      });
  }
}

/** The cat's whiskers, two on each cheek, for a head `h` wide. */
function whiskers(paint: Paint, h: number): Path[] {
  const k = h / 16.5;
  return both({
    kind: "path",
    stroke: paint,
    width: 2,
    d: [
      ["M", AX + 12.6 * k, 29.4],
      ["L", AX + 16.2 * k, 28.8],
      ["M", AX + 12.6 * k, 31.8],
      ["L", AX + 15.9 * k, 33],
    ],
  });
}

/** What a dog has under its nose: nothing, a smile, a smile with the tongue out, or the tongue out of one side. */
export type Mouth = "smile" | "tongue" | "blep";

const TONGUE = "#F4849F";

/** The dog's nose, and its mouth in a mood: asleep the tongue is in, and after an error nobody smiles. */
function muzzle(mood: Mood, c: Coat): Shape[] {
  const ink = c.nose ?? INK;
  const parts: Shape[] = [];
  if (c.mouth && mood !== "error") {
    if (c.mouth === "tongue" && mood !== "sleep") {
      parts.push({ kind: "path", fill: TONGUE, stroke: ink, width: 1.3, d: [["M", AX - 2, 41.2], ["C", AX - 2, 46, AX + 2, 46, AX + 2, 41.2], ["Z"]] });
    }
    if (c.mouth === "blep" && mood !== "sleep") {
      parts.push({ kind: "path", fill: TONGUE, stroke: ink, width: 1.3, d: [["M", AX + 0.4, 40.6], ["C", AX + 0.2, 45.2, AX + 4.6, 45.6, AX + 4.2, 40.4], ["Z"]] });
    }
    parts.push({ kind: "path", stroke: ink, width: 1.8, d: [["M", AX - 3.4, 39.6], ["Q", AX, 42.6, AX + 3.4, 39.6]] });
  }
  parts.push({ kind: "ellipse", fill: ink, cx: AX, cy: 36.4, rx: 2.6, ry: 1.85 });
  return parts;
}

// ── Coats ───────────────────────────────────────────────────────────────────
//
// Every coat is a breed: a build and a tail, a base color, markings clipped
// to the body, and its own eyes. Cats first, then dogs. Markings are written
// as distances from the axis, like the body.

/** A marking: a filled blob through `points`, smoothed (a closed Catmull-Rom curve). */
function patch(fill: Paint, ...points: Point[]): Path {
  const p = points.map(([dx, y]): Point => [AX + dx, y]);
  const n = p.length;
  const d: Cmd[] = [["M", ...p[0]]];
  for (let i = 0; i < n; i++) {
    const [p0, p1, p2, p3] = [p[(i - 1 + n) % n], p[i], p[(i + 1) % n], p[(i + 2) % n]];
    d.push(["C", p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6, p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, p2[0], p2[1]]);
  }
  d.push(["Z"]);
  return { kind: "path", fill, clip: true, d };
}

/** A marking: an oval. */
function oval(fill: Paint, dx: number, cy: number, rx: number, ry: number): Path {
  const cx = AX + dx;
  const kx = rx * 0.5523;
  const ky = ry * 0.5523;
  return {
    kind: "path",
    fill,
    clip: true,
    d: [
      ["M", cx + rx, cy],
      ["C", cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry],
      ["C", cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy],
      ["C", cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry],
      ["C", cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy],
      ["Z"],
    ],
  };
}

/** A marking: a round-capped stripe. */
const stripe = (paint: Paint, width: number, ...points: Point[]): Path => ({ ...line(paint, width, ...points.map(([dx, y]): Point => [AX + dx, y])), clip: true });

/** A marking: everything below `y` — the paws of the hem. */
const socks = (fill: Paint, y: number): Path => ({ kind: "path", fill, clip: true, d: [["M", 0, y], ["L", GRID, y], ["L", GRID, GRID], ["L", 0, GRID], ["Z"]] });

export interface Coat {
  /** The name, in English and Chinese. */
  name: { en: string; zh: string };
  species: Species;
  build: Build;
  tail: Tail;
  /** The coat's color. */
  base: Paint;
  /** Clipped to the body, under the outline and the face. */
  markings: Path[];
  /** The eyes: both, or the left and the right when they differ. */
  eyes: Eye | { left: Eye; right: Eye };
  /** How far each eye is from the axis, when not the species' usual. */
  apart?: number;
  /** Cats: the whiskers' color. */
  whiskers?: Paint;
  /** Dogs: the color of the nose and mouth (ink when absent), and the mouth. */
  nose?: Paint;
  mouth?: Mouth;
  /** Drop-eared dogs: the ears' color and how far down they hang. */
  ear?: { fill: Paint; tip: number };
}

const WHITE = "#FFFFFF";
const SOOT = "#26262E";
const GINGER = "#F0A04B";
const RUST = "#D9792B";
const CREAM = "#F8F0DE";
const SNOW = "#F5F7F9";
const SEAL = "#5A4232";
const TAN = "#C98A4B";
const BROWN = "#2A1A0E";

/** The build of the plain cat, and of the plain dog. */
const CAT: Build = { ears: "cat", h: 16.5, m: 21, w: 25 };
const DOG: Build = { ears: "prick", h: 17, m: 21, w: 25 };

/** A patch over a hem lobe and the flank above it. */
const hemPatch = (fill: Paint): Path => patch(fill, [7, 45], [14, 41.6], [22, 42.6], [28, 48], [26, 58], [9, 58], [4.6, 51]);

export const COATS = {
  /** The plain ghost: white sheet, ink features. */
  ghost: { name: { en: "Ghost", zh: "小白" }, species: "cat", build: CAT, tail: "handle", base: WHITE, markings: [], eyes: slit(), whiskers: INK },
  /** Cow cat: white, under black hair parted in the middle; a black patch on the hem. */
  cow: {
    name: { en: "Cow cat", zh: "奶牛猫" },
    species: "cat",
    build: CAT,
    tail: "handle",
    base: WHITE,
    markings: [
      ...both(patch(SOOT, [1.3, 9], [1.7, 15], [4.6, 20.6], [9.6, 24.2], [15.5, 25.6], [23, 25], [25, 13], [14, 3], [4, 3])),
      hemPatch(SOOT),
      oval(SOOT, -17, 44.6, 3.6, 3),
    ],
    eyes: slit(),
    whiskers: INK,
  },
  /** Calico: white, a ginger patch over one ear and a black one over the other, ginger and black on the hem. */
  calico: {
    name: { en: "Calico", zh: "三花" },
    species: "cat",
    build: CAT,
    tail: "handle",
    base: WHITE,
    markings: [
      patch(GINGER, [-28, 3], [-3.4, 3], [-2.4, 12.6], [-4.8, 19], [-10.4, 24], [-18, 26.2], [-28, 24]),
      patch(SOOT, [3.6, 3], [28, 3], [27, 19], [19.4, 23.6], [11, 21.2], [5.4, 15.4]),
      hemPatch(GINGER),
      patch(SOOT, [-28, 41], [-19.5, 39.6], [-14.6, 45], [-18.6, 52.6], [-28, 52]),
    ],
    eyes: slit(),
    whiskers: INK,
  },
  /** Ginger tabby: the fat one. Orange, with the tabby's "M" on the brow and stripes down the flanks. */
  ginger: {
    name: { en: "Ginger", zh: "橘猫" },
    species: "cat",
    build: { ears: "cat", h: 17.5, m: 24, w: 26.5 },
    tail: "stout",
    base: "#F5B062",
    markings: [
      stripe(RUST, 2.2, [0, 15.6], [0, 21]),
      stripe(RUST, 2.2, [-3.7, 16.3], [-2.8, 20.4]),
      stripe(RUST, 2.2, [3.7, 16.3], [2.8, 20.4]),
      ...both(stripe(RUST, 2.4, [29, 37.4], [19.6, 38.8])),
      ...both(stripe(RUST, 2.4, [30, 42.2], [20.8, 43.2])),
      ...both(stripe(RUST, 2.4, [30, 47], [22.6, 47.4])),
    ],
    eyes: slit(BROWN),
    whiskers: BROWN,
  },
  /** Black cat: a void with two lights in it. Sleek, with yellow eyes, pale whiskers and its tail up. */
  black: {
    name: { en: "Black cat", zh: "黑猫" },
    species: "cat",
    build: { ears: "cat", h: 15.5, m: 20, w: 24 },
    tail: "hook",
    base: SOOT,
    markings: [],
    eyes: [
      { rx: 3.1, ry: 4.4, fill: "#F7C948" },
      { rx: 1, ry: 3.4, fill: INK },
    ],
    whiskers: "#C9CAD3",
  },
  /** British blue: all cheeks. Blue-grey and broad, with small round ears and round copper eyes. */
  blue: {
    name: { en: "British blue", zh: "蓝猫" },
    species: "cat",
    build: { ears: "round", h: 18, m: 22.5, w: 25.5 },
    tail: "handle",
    base: "#A3ACBE",
    markings: [],
    eyes: [
      { rx: 3.9, ry: 4.1, fill: "#E08A2E" },
      { rx: 1.3, ry: 3.2, fill: INK },
    ],
    apart: 6.8,
    whiskers: "#2B3040",
  },
  /** Siamese: slim, with large ears and a kinked tail. Cream, with dark points — ears, mask, paws — and blue eyes that squint. */
  siamese: {
    name: { en: "Siamese", zh: "暹罗" },
    species: "cat",
    build: { ears: "tall", h: 15, m: 18.5, w: 22.5 },
    tail: "kink",
    base: "#F4E8D6",
    markings: [...both(patch(SEAL, [3.4, 3], [24, 3], [24, 15], [16, 19.4], [9.6, 17.6], [4.6, 15.8])), oval(SEAL, 0, 32.6, 11, 8.6), socks(SEAL, 51.7)],
    eyes: [
      { rx: 3, ry: 4.2, fill: "#8CC4FF" },
      { rx: 1, ry: 3, fill: INK, dx: 0.9 },
    ],
    whiskers: "#3A2A20",
  },
  /** Shiba: red, with cream cheeks, muzzle and chest, cream brow dots, a smile and a curled tail. */
  shiba: {
    name: { en: "Shiba", zh: "柴犬" },
    species: "dog",
    build: { ears: "prick", h: 17.5, m: 22.5, w: 25 },
    tail: "curl",
    base: "#E19A4F",
    markings: [...both(oval(CREAM, 9.4, 36.8, 7.6, 5.4)), oval(CREAM, 0, 37.4, 7, 5.6), oval(CREAM, 0, 50, 9.5, 6.5), ...both(oval(CREAM, 6.6, 24.8, 2, 1.35))],
    eyes: round(BROWN),
    nose: BROWN,
    mouth: "smile",
  },
  /** Husky: a grey hood over a white face that comes to a peak between the eyes — one blue, one brown — and the tongue out of one side. */
  husky: {
    name: { en: "Husky", zh: "哈士奇" },
    species: "dog",
    build: DOG,
    tail: "sickle",
    base: "#6B7686",
    markings: [patch(SNOW, [-28, 36], [-18.5, 30.6], [-11, 26], [-6.4, 24.9], [-2.6, 27.2], [0, 30.2], [2.6, 27.2], [6.4, 24.9], [11, 26], [18.5, 30.6], [28, 36], [28, 62], [-28, 62])],
    eyes: {
      left: [
        { rx: 3.2, ry: 3.2, fill: INK },
        { rx: 2.3, ry: 2.3, fill: "#7CCBFF" },
        { rx: 1, ry: 1, fill: INK },
      ],
      right: [
        { rx: 3.2, ry: 3.2, fill: INK },
        { rx: 2.3, ry: 2.3, fill: "#A8703A" },
        { rx: 1, ry: 1, fill: INK },
      ],
    },
    mouth: "blep",
  },
  /** Border collie: black, with ear tips that fold over and a white blaze from the crown through the muzzle to the chest; amber eyes. */
  border: {
    name: { en: "Collie", zh: "边牧" },
    species: "dog",
    build: { ears: "tipped", h: 16.5, m: 21, w: 25 },
    tail: "plume",
    base: SOOT,
    markings: [
      patch(SNOW, [-1.7, 9], [1.7, 9], [2.3, 22], [2.6, 27.5], [3.2, 31.5], [8, 36.4], [8, 41], [12, 46], [15, 62], [-15, 62], [-12, 46], [-8, 41], [-8, 36.4], [-3.2, 31.5], [-2.6, 27.5], [-2.3, 22]),
    ],
    eyes: [
      { rx: 3, ry: 3, fill: "#E2A44F" },
      { rx: 1.5, ry: 1.5, fill: INK },
    ],
    apart: 7.2,
  },
  /** German shepherd: mostly ears. Tan, with black ears and a black muzzle, and a tail that hangs. */
  shepherd: {
    name: { en: "Shepherd", zh: "德牧" },
    species: "dog",
    build: { ears: "big", h: 16.5, m: 21, w: 25 },
    tail: "low",
    base: "#C89456",
    markings: [...both(patch(SOOT, [1.6, 3], [24, 3], [24, 14], [16.6, 18.6], [9, 17.4], [3.4, 16.6])), oval("#4A3F3A", 0, 37.4, 7.4, 5.4)],
    eyes: round(BROWN),
  },
  /** Golden: gold, with darker ears that hang, a cream chest, and its tongue out. */
  golden: {
    name: { en: "Golden", zh: "金毛" },
    species: "dog",
    build: { ears: "drop", h: 17, m: 21.5, w: 25 },
    tail: "plume",
    base: "#E5B168",
    markings: [oval("#F4E4C0", 0, 51, 9, 6)],
    eyes: round("#3A2410"),
    nose: "#3A2410",
    mouth: "tongue",
    ear: { fill: "#D09A4E", tip: 35 },
  },
  /** Rottweiler: broad and black, with a tan muzzle, tan brow dots and chest, small ears and a stub of a tail. */
  rottweiler: {
    name: { en: "Rottweiler", zh: "罗威纳" },
    species: "dog",
    build: { ears: "drop", h: 18, m: 23, w: 26 },
    tail: "stub",
    base: SOOT,
    markings: [oval(TAN, 0, 37.6, 8, 5.8), ...both(oval(TAN, 6.6, 24.8, 1.9, 1.3)), ...both(oval(TAN, 6.2, 50.6, 3.6, 3))],
    eyes: [
      { rx: 2.9, ry: 2.9, fill: "#D9A05B" },
      { rx: 1.5, ry: 1.5, fill: INK },
    ],
    ear: { fill: SOOT, tip: 29 },
  },
  /** Dalmatian: lean and white, with black ears, round black spots and a whip of a tail. */
  dalmatian: {
    name: { en: "Dalmatian", zh: "斑点狗" },
    species: "dog",
    build: { ears: "drop", h: 16, m: 20, w: 24 },
    tail: "whip",
    base: WHITE,
    markings: [
      oval(SOOT, -6.6, 19.4, 2.3, 2),
      oval(SOOT, 3, 23, 1.5, 1.3),
      oval(SOOT, -12.6, 34.4, 1.7, 1.5),
      oval(SOOT, -15, 43, 2.5, 2.2),
      oval(SOOT, 13.4, 44.4, 2.9, 2.5),
      oval(SOOT, -4.4, 47.4, 2, 1.8),
      oval(SOOT, 5.4, 51.6, 1.7, 1.5),
    ],
    eyes: round(),
    ear: { fill: SOOT, tip: 32 },
  },
} satisfies Record<string, Coat>;

export type CoatId = keyof typeof COATS;
export const COAT_IDS = Object.keys(COATS) as CoatId[];
export const isCoat = (id: unknown): id is CoatId => typeof id === "string" && id in COATS;

const SHEETS = new Map<CoatId, Path>();

/** The body of a coat: the silhouette its markings clip to. */
export function silhouette(coat: CoatId = "ghost"): Path {
  let body = SHEETS.get(coat);
  if (!body) SHEETS.set(coat, (body = sheet((COATS[coat] as Coat).build)));
  return body;
}

/** Where a coat's tail meets its body: the point it wags about. */
export const tailPivot = (coat: CoatId = "ghost"): readonly [number, number] => [AX + (COATS[coat] as Coat).build.m + 0.4, 40.5];

/** Every shape of Pip in a mood and coat, back to front, at rest. */
export function pip(mood: Mood = "idle", coat: CoatId = "ghost"): Shape[] {
  const c: Coat = COATS[coat];
  const body = silhouette(coat);
  const cat = c.species === "cat";
  const { left, right } = "left" in c.eyes ? c.eyes : { left: c.eyes, right: c.eyes };
  const apart = c.apart ?? (cat ? (5.8 * c.build.h) / 16.5 : 6.6);
  const y = cat ? 30.5 : 30.2;
  return [
    tail(c.tail, c.build),
    { ...body, fill: c.base, stroke: undefined },
    ...c.markings,
    body,
    ...(c.ear ? both(flap(c.build.h, c.ear.tip, c.ear.fill)) : []),
    ...eye(mood, [AX - apart, y], left, -1, cat),
    ...eye(mood, [AX + apart, y], right, 1, cat),
    ...(cat ? whiskers(c.whiskers ?? INK, c.build.h) : muzzle(mood, c)),
  ];
}

/** Pip's bounds on the grid, outline included: the full width, y 7–57. */
export const BOUNDS = { x: 0, y: 7, w: 64, h: 50 } as const;

/** A path as SVG path data. */
export const svgPath = (d: Cmd[]) => d.map(([op, ...n]) => op + n.map((v) => +(+v).toFixed(2)).join(" ")).join("");
