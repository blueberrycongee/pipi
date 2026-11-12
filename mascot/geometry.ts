/**
 * Pip — pipi's mascot — as data.
 *
 * Pip is a little ghost: a sheet with ears, a scalloped hem, a tail on its
 * right, two eyes. It is line art — a coat under one round outline, drawn on
 * a 64-unit grid — and it comes in two species: the cat has pointy ears, a
 * curled tail and whiskers; the dog has folded ears that droop beside the
 * head, a raised tail and a nose. Each species wears its own coats: the cat
 * as a cow cat, a calico, a ginger, ...; the dog as a shiba, a husky, ...
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
 * caps and joins). A `clip` path is a coat marking: drawn only inside the body.
 */
export interface Path {
  kind: "path";
  d: Cmd[];
  fill?: Paint;
  stroke?: Paint;
  width?: number;
  clip?: boolean;
}

/** A filled ellipse (the eyes; the dog's nose). `lid` marks an eye: its height scales with the blink. */
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

/** The width of Pip's outline, in grid units. */
export const LINE = 3.2;

/** The sheet: two ears, round flanks that flare to a scalloped hem. Closed; the coat fills it, the line outlines it. */
export const BODY: Path = {
  kind: "path",
  stroke: LINE_PAINT,
  width: LINE,
  d: [
    ["M", 15, 22],
    // Left ear: up the outer edge to a soft tip, down into the head.
    ["C", 15.4, 16, 16.8, 11, 19.4, 9.9],
    ["C", 21.6, 9, 24, 11.6, 26, 14.6],
    // The crown between the ears.
    ["Q", 32, 13.2, 38, 14.6],
    // Right ear.
    ["C", 40, 11.6, 42.4, 9, 44.6, 9.9],
    ["C", 47.2, 11, 48.6, 16, 49, 22],
    // Right flank, flaring out to the hem's corner.
    ["C", 51.8, 25, 52.6, 30, 53.2, 35.5],
    ["C", 53.8, 41, 55.4, 44, 56.4, 46.6],
    ["C", 57.4, 49.4, 55, 52, 51.8, 51.2],
    // The hem: two scallops.
    ["C", 47.4, 50.2, 45, 54.2, 40, 54.2],
    ["C", 35, 54.2, 33.6, 50.4, 29, 50.4],
    ["C", 24.4, 50.4, 23, 54.2, 18, 54.2],
    ["C", 13.4, 54.2, 11, 50.8, 7.8, 51.2],
    ["C", 4.8, 51.6, 3.8, 48.6, 5.4, 45.8],
    // Left flank, back up to the ear.
    ["C", 7.4, 42.4, 9, 39, 10, 34],
    ["C", 11, 28.6, 12.2, 25, 15, 22],
    ["Z"],
  ],
};

/** The tail: a loop out of the right flank and back. Stroke only; it wags about `TAIL_PIVOT`. */
export const TAIL: Path = {
  kind: "path",
  stroke: LINE_PAINT,
  width: LINE,
  d: [
    ["M", 53.4, 37],
    ["C", 55.6, 33.4, 61.8, 33.6, 61.6, 38.6],
    ["C", 61.4, 42.2, 58.8, 44.4, 56.6, 46],
  ],
};

/** Where the tail meets the body: the point it wags about. */
export const TAIL_PIVOT = [55, 41.5] as const;

/** The dog's sheet: the same flanks and scalloped hem, but a round crown and two folded ears that droop beside the head. */
export const DOG_BODY: Path = {
  kind: "path",
  stroke: LINE_PAINT,
  width: LINE,
  d: [
    ["M", 14.5, 27],
    // Left ear: inner edge down to the drooping tip, outer edge back up to the crown.
    ["C", 13.8, 31.5, 11.5, 35.3, 8, 35.5],
    ["C", 4.5, 35.7, 3, 30, 3.8, 23.5],
    ["C", 4.6, 16.5, 9.5, 12.5, 16, 13.8],
    // The crown between the ears.
    ["Q", 32, 10.8, 48, 13.8],
    // Right ear: outer edge down to the tip, inner edge back to the cheek.
    ["C", 54.5, 12.5, 59.4, 16.5, 60.2, 23.5],
    ["C", 61, 30, 59.5, 35.7, 56, 35.5],
    ["C", 52.5, 35.3, 50.2, 31.5, 49.5, 27],
    // Right flank, flaring out to the hem's corner.
    ["C", 51.8, 30, 52.6, 33.5, 53.2, 36.5],
    ["C", 53.8, 41.5, 55.4, 44.2, 56.4, 46.6],
    ["C", 57.4, 49.4, 55, 52, 51.8, 51.2],
    // The hem: two scallops.
    ["C", 47.4, 50.2, 45, 54.2, 40, 54.2],
    ["C", 35, 54.2, 33.6, 50.4, 29, 50.4],
    ["C", 24.4, 50.4, 23, 54.2, 18, 54.2],
    ["C", 13.4, 54.2, 11, 50.8, 7.8, 51.2],
    ["C", 4.8, 51.6, 3.8, 48.6, 5.4, 45.8],
    // Left flank, back up to the ear.
    ["C", 7.4, 42.4, 9, 39, 10, 34.5],
    ["C", 11, 30.5, 12.8, 28.6, 14.5, 27],
    ["Z"],
  ],
};

/** The folds where the dog's ears bend down from the crown. Stroke only. */
export const DOG_FOLDS: Path = {
  kind: "path",
  stroke: LINE_PAINT,
  width: 2.2,
  d: [
    ["M", 15, 15.5],
    ["C", 12.2, 18.5, 11.6, 22.5, 12, 26],
    ["M", 49, 15.5],
    ["C", 51.8, 18.5, 52.4, 22.5, 52, 26],
  ],
};

/** The dog's tail: held high, tip curled forward. Stroke only; wags about `DOG_TAIL_PIVOT`. */
export const DOG_TAIL: Path = {
  kind: "path",
  stroke: LINE_PAINT,
  width: LINE,
  d: [
    ["M", 53.4, 38],
    ["C", 56.5, 36, 59.8, 33, 60.8, 29],
    ["C", 61.6, 26, 60.8, 23.2, 58.8, 22.4],
  ],
};

/** Where the dog's tail meets the body: the point it wags about. */
export const DOG_TAIL_PIVOT = [54, 37.5] as const;

/** The dog's nose, between and below the eyes, in the line paint. */
export const DOG_NOSE: Ellipse = { kind: "ellipse", fill: LINE_PAINT, cx: 32, cy: 36.8, rx: 2.5, ry: 1.8 };

/** The whiskers, two on each cheek. */
export const WHISKERS: Path = {
  kind: "path",
  width: 2,
  d: [
    ["M", 15.6, 28.4],
    ["L", 19.2, 29],
    ["M", 15.9, 32.6],
    ["L", 19.2, 31.4],
    ["M", 44.8, 29],
    ["L", 48.4, 28.4],
    ["M", 44.8, 31.4],
    ["L", 48.1, 32.6],
  ],
};

/** The centers of the eyes. */
export const EYES = { left: [27, 29.5], right: [37, 29.5] } as const;

const line = (paint: Paint, width: number, ...points: [number, number][]): Path => ({
  kind: "path",
  stroke: paint,
  width,
  d: points.map(([x, y], i) => (i ? ["L", x, y] : ["M", x, y])),
});

/** One eye of a mood in the color `ink`, around the center `[cx, cy]`. */
export function eye(mood: Mood, [cx, cy]: readonly [number, number], ink: Paint = "#16161D"): Shape[] {
  switch (mood) {
    case "think":
      // Looking up and ahead, toward the tail.
      return [{ kind: "ellipse", fill: ink, cx: cx + 1.4, cy: cy - 1.6, rx: 1.6, ry: 1.7, lid: true }];
    case "write":
      // Looking down at the page.
      return [{ kind: "ellipse", fill: ink, cx, cy: cy + 1.4, rx: 1.7, ry: 1.8, lid: true }];
    case "happy":
      return [{ kind: "path", stroke: ink, width: 2.2, d: [["M", cx - 2.2, cy + 1], ["Q", cx, cy - 3.2, cx + 2.2, cy + 1]] }];
    case "error":
      return [line(ink, 2.2, [cx - 1.8, cy - 1.8], [cx + 1.8, cy + 1.8]), line(ink, 2.2, [cx + 1.8, cy - 1.8], [cx - 1.8, cy + 1.8])];
    case "sleep":
      return [line(ink, 2.2, [cx - 2, cy + 1], [cx + 2, cy + 1])];
    default:
      return [{ kind: "ellipse", fill: ink, cx, cy, rx: 2.7, ry: 4, lid: true }];
  }
}

// ── Coats ───────────────────────────────────────────────────────────────────
//
// Every coat dresses one of the two ghosts — the cat or the dog — in a base
// color, markings clipped to that species' body, and the colors of the eyes
// and whiskers that read on that coat. Cats first, then dogs.

/** A marking: a filled blob through `points`, smoothed (a closed Catmull-Rom curve). */
function patch(fill: Paint, ...points: [number, number][]): Path {
  const n = points.length;
  const d: Cmd[] = [["M", ...points[0]]];
  for (let i = 0; i < n; i++) {
    const [p0, p1, p2, p3] = [points[(i - 1 + n) % n], points[i], points[(i + 1) % n], points[(i + 2) % n]];
    d.push(["C", p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6, p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, p2[0], p2[1]]);
  }
  d.push(["Z"]);
  return { kind: "path", fill, clip: true, d };
}

/** A stripe: a round-capped stroke clipped to the body. */
const stripe = (paint: Paint, width: number, ...points: [number, number][]): Path => ({ ...line(paint, width, ...points), clip: true });

export interface Coat {
  /** The name, in English and Chinese. */
  name: { en: string; zh: string };
  /** Which silhouette the coat is cut for. */
  species: Species;
  base: Paint;
  markings: Path[];
  eyes: Paint;
  /** Cats only. */
  whiskers?: Paint;
}

const INK = "#16161D";
const SOOT = "#26262E";
const GINGER = "#F0A04B";

export const COATS = {
  /** The plain ghost: white sheet, ink features. */
  ghost: { name: { en: "Ghost", zh: "小白" }, species: "cat", base: "#FFFFFF", markings: [], eyes: INK, whiskers: INK },
  /** Cow cat: white with black patches — one over the left ear, the right ear tip, a spot on the hem. */
  cow: {
    name: { en: "Cow cat", zh: "奶牛猫" },
    species: "cat",
    base: "#FFFFFF",
    markings: [
      patch(SOOT, [4, 4], [30, 4], [30, 14], [24, 22], [14, 25], [4, 24]),
      patch(SOOT, [40, 4], [62, 4], [60, 17], [50, 17], [43, 13]),
      patch(SOOT, [38, 44], [46, 40], [52, 44], [50, 52], [40, 54]),
      patch(SOOT, [6, 44], [11, 41], [14, 46], [9, 52]),
    ],
    eyes: INK,
    whiskers: INK,
  },
  /** Calico: white, a ginger patch and a black patch on the head, ginger and black on the hem. */
  calico: {
    name: { en: "Calico", zh: "三花" },
    species: "cat",
    base: "#FFFFFF",
    markings: [
      patch(GINGER, [2, 4], [30, 4], [29, 15], [22, 23], [12, 26], [2, 22]),
      patch(SOOT, [36, 4], [62, 4], [60, 22], [52, 24], [44, 18], [38, 13]),
      patch(GINGER, [34, 46], [44, 40], [56, 44], [56, 56], [36, 56]),
      patch(SOOT, [4, 42], [12, 40], [17, 46], [12, 54], [4, 52]),
    ],
    eyes: INK,
    whiskers: INK,
  },
  /** Ginger tabby: orange with darker stripes on the brow and flanks. */
  ginger: {
    name: { en: "Ginger", zh: "橘猫" },
    species: "cat",
    base: "#F5B062",
    markings: [
      stripe("#D9792B", 2.2, [32, 15.5], [32, 21]),
      stripe("#D9792B", 2.2, [28.4, 16.2], [29.4, 20.4]),
      stripe("#D9792B", 2.2, [35.6, 16.2], [34.6, 20.4]),
      stripe("#D9792B", 2.4, [4, 38], [12, 39.5]),
      stripe("#D9792B", 2.4, [4, 43], [11, 44]),
      stripe("#D9792B", 2.4, [60, 38], [52, 39.5]),
      stripe("#D9792B", 2.4, [60, 43], [53, 44]),
    ],
    eyes: "#2A1A0E",
    whiskers: "#2A1A0E",
  },
  /** Black cat: all soot, with yellow eyes and pale whiskers. */
  black: { name: { en: "Black cat", zh: "黑猫" }, species: "cat", base: SOOT, markings: [], eyes: "#F7C948", whiskers: "#C9CAD3" },
  /** British blue: blue-grey, with copper eyes. */
  blue: { name: { en: "British blue", zh: "蓝猫" }, species: "cat", base: "#A3ACBE", markings: [], eyes: "#7A3E12", whiskers: "#2B3040" },
  /** Siamese: cream, with dark points on the ears and a mask over the face; blue eyes. */
  siamese: {
    name: { en: "Siamese", zh: "暹罗" },
    species: "cat",
    base: "#F4E8D6",
    markings: [
      patch("#5A4232", [12, 4], [26, 4], [25, 14], [18, 19], [12, 16]),
      patch("#5A4232", [38, 4], [52, 4], [52, 16], [46, 19], [39, 14]),
      patch("#5A4232", [32, 23], [40, 25], [43, 31], [38, 37], [32, 38.5], [26, 37], [21, 31], [24, 25]),
    ],
    eyes: "#8CC4FF",
    whiskers: "#3A2A20",
  },
  /** Shiba: red sesame, with a cream muzzle and chest, cream brow dots above the eyes. */
  shiba: {
    name: { en: "Shiba", zh: "柴犬" },
    species: "dog",
    base: "#E19A4F",
    markings: [
      patch("#F8F0DE", [18, 30], [46, 30], [50, 38], [40, 44], [24, 44], [14, 38]),
      patch("#F8F0DE", [24.5, 21.6], [29.5, 21.6], [29.5, 25], [24.5, 25]),
      patch("#F8F0DE", [34.5, 21.6], [39.5, 21.6], [39.5, 25], [34.5, 25]),
      patch("#F8F0DE", [25, 44], [39, 44], [41, 52], [23, 52]),
    ],
    eyes: "#2A1A0E",
  },
  /** Husky: grey, with a white blaze up the forehead and a white muzzle and chest; ice-blue eyes. */
  husky: {
    name: { en: "Husky", zh: "哈士奇" },
    species: "dog",
    base: "#6B7686",
    markings: [
      patch("#F5F7F9", [20, 32], [44, 32], [49, 38], [46, 46], [36, 52], [28, 52], [18, 46], [15, 38]),
      patch("#F5F7F9", [31, 20], [33, 20], [34, 27], [30, 27]),
    ],
    eyes: "#8CC4FF",
  },
  /** Border collie: soot, with a white blaze running from the forehead through the muzzle to the chest; amber eyes. */
  border: {
    name: { en: "Collie", zh: "边牧" },
    species: "dog",
    base: SOOT,
    markings: [
      patch("#F5F7F9", [30, 17], [34, 17], [42, 30], [50, 38], [45, 48], [32, 52], [19, 48], [14, 38], [22, 30]),
    ],
    eyes: "#D9A05B",
  },
  /** German shepherd: tan, with a black mask over the face and black ears. */
  shepherd: {
    name: { en: "Shepherd", zh: "德牧" },
    species: "dog",
    base: "#C89456",
    markings: [
      patch(SOOT, [20, 24], [44, 24], [50, 33], [44, 42], [20, 42], [14, 33]),
      patch(SOOT, [4, 14], [14, 13], [15, 24], [8, 33], [3.5, 28]),
      patch(SOOT, [60, 14], [50, 13], [49, 24], [56, 33], [60.5, 28]),
    ],
    eyes: "#E8B96A",
  },
  /** Golden: gold, with darker ears and a cream chest. */
  golden: {
    name: { en: "Golden", zh: "金毛" },
    species: "dog",
    base: "#E5B168",
    markings: [
      patch("#D09A4E", [4, 16], [13, 14], [15, 24], [9, 34], [4, 30]),
      patch("#D09A4E", [60, 16], [51, 14], [49, 24], [55, 34], [60, 30]),
      patch("#F4E4C0", [26, 46], [38, 46], [40, 52], [24, 52]),
    ],
    eyes: "#3A2410",
  },
  /** Rottweiler: soot, with tan muzzle, brow dots and chest; tan eyes. */
  rottweiler: {
    name: { en: "Rottweiler", zh: "罗威纳" },
    species: "dog",
    base: SOOT,
    markings: [
      patch("#C98A4B", [20, 33], [44, 33], [47, 39], [40, 44], [24, 44], [17, 39]),
      patch("#C98A4B", [25, 22.5], [29, 22.5], [29, 25.5], [25, 25.5]),
      patch("#C98A4B", [35, 22.5], [39, 22.5], [39, 25.5], [35, 25.5]),
      patch("#C98A4B", [26, 46], [38, 46], [40, 52], [24, 52]),
    ],
    eyes: "#D9A05B",
  },
  /** Dalmatian: white, with soot ear tips and small round spots. */
  dalmatian: {
    name: { en: "Dalmatian", zh: "斑点狗" },
    species: "dog",
    base: "#FFFFFF",
    markings: [
      patch(SOOT, [4, 20], [11, 18], [13, 25], [8, 33], [4, 30]),
      patch(SOOT, [60, 20], [53, 18], [51, 25], [56, 33], [60, 30]),
      patch(SOOT, [30, 16], [34.5, 16], [34, 21], [30, 20.5]),
      patch(SOOT, [8, 39], [15, 38], [16, 44], [9, 46]),
      patch(SOOT, [45, 39], [53, 40], [52, 47], [44, 46]),
      patch(SOOT, [27, 45], [35, 45], [34, 52], [26, 51]),
    ],
    eyes: INK,
  },
} satisfies Record<string, Coat>;

export type CoatId = keyof typeof COATS;
export const COAT_IDS = Object.keys(COATS) as CoatId[];
export const isCoat = (id: unknown): id is CoatId => typeof id === "string" && id in COATS;

/** Which ghost Pip is: cat (pointy ears, curled tail, whiskers) or dog (folded drooping ears, raised tail, nose). */
export type Species = "cat" | "dog";

/** The parts of a species' silhouette: the body markings clip to, the tail that wags, and the line-art face over the coat. */
export interface SpeciesParts {
  body: Path;
  tail: Path;
  tailPivot: readonly [number, number];
  face: (coat: Coat) => Shape[];
}

export const SPECIES: Record<Species, SpeciesParts> = {
  cat: {
    body: BODY,
    tail: TAIL,
    tailPivot: TAIL_PIVOT,
    face: (c) => [{ ...WHISKERS, stroke: c.whiskers ?? LINE_PAINT }],
  },
  dog: {
    body: DOG_BODY,
    tail: DOG_TAIL,
    tailPivot: DOG_TAIL_PIVOT,
    face: () => [DOG_FOLDS, DOG_NOSE],
  },
};

/** Every shape of Pip in a mood and coat, back to front, at rest. */
export function pip(mood: Mood = "idle", coat: CoatId = "ghost"): Shape[] {
  const c: Coat = COATS[coat];
  const s = SPECIES[c.species];
  return [s.tail, { ...s.body, fill: c.base, stroke: undefined }, ...c.markings, s.body, ...s.face(c), ...eye(mood, EYES.left, c.eyes), ...eye(mood, EYES.right, c.eyes)];
}

/** Pip's bounds on the grid, outline included: the full width, y 7–57. */
export const BOUNDS = { x: 0, y: 7, w: 64, h: 50 } as const;

/** A path as SVG path data. */
export const svgPath = (d: Cmd[]) => d.map(([op, ...n]) => op + n.map((v) => +(+v).toFixed(2)).join(" ")).join("");
