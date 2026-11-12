import { Canvas, Path2D, token } from "nsh";
import type { Tokens } from "nsh";

/**
 * pipi's icons: one family, drawn for this app on a 16-point grid with a
 * 1.5-point round stroke, so they sit on whole pixels at their natural size.
 * `stroke` icons are outlines; `fill` icons are solid.
 */
const ICONS = {
  plus: { stroke: "M8 3.5v9M3.5 8h9" },
  minus: { stroke: "M3.5 8h9" },
  shuffle: { stroke: "M2.5 5h2.5l6 6h2.5M11.5 9l2 2-2 2M2.5 11h2.5l1.5-1.5M9.5 6.5L11 5h2.5M11.5 3l2 2-2 2" },
  x: { stroke: "M4.25 4.25l7.5 7.5M11.75 4.25l-7.5 7.5" },
  check: { stroke: "M3.5 8.5l3 3 6-7" },
  chevronDown: { stroke: "M4.25 6.25L8 10l3.75-3.75" },
  chevronRight: { stroke: "M6.25 4.25L10 8l-3.75 3.75" },
  chevronsUpDown: { stroke: "M5 6.25L8 3.5l3 2.75M5 9.75L8 12.5l3-2.75" },
  arrowUp: { stroke: "M8 12.75V3.5M4 7.25L8 3.25l4 4" },
  arrowLeft: { stroke: "M12.75 8H3.5M7.25 4L3.25 8l4 4" },
  stop: { fill: "M5.5 4.5h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1z" },
  search: { stroke: "M7.25 11.75a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM10.5 10.5l3 3" },
  folder: { stroke: "M2.5 4.75a1 1 0 0 1 1-1h2.6l1.4 1.5h5a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" },
  folderOpen: { stroke: "M4.35 9.75l.95-1.9a1.3 1.3 0 0 1 1.17-.73h6.98a.8.8 0 0 1 .74 1.1l-1.5 3.7a1.2 1.2 0 0 1-1.1.83H3.5a1 1 0 0 1-1-1V4.75a1 1 0 0 1 1-1h2.6l1.4 1.5h4.4a1 1 0 0 1 1 1z" },
  folderPlus: { stroke: "M2.5 4.75a1 1 0 0 1 1-1h2.6l1.4 1.5h5a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1zM8 7.5v3.5M6.25 9.25h3.5" },
  archive: {
    stroke:
      "M3.25 2.75h9.5a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1h-9.5a1 1 0 0 1-1-1v-1a1 1 0 0 1 1-1zM3.25 5.75v5.5a2 2 0 0 0 2 2h5.5a2 2 0 0 0 2-2v-5.5M6.5 8.5h3",
  },
  unarchive: {
    stroke:
      "M3.25 2.75h9.5a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1h-9.5a1 1 0 0 1-1-1v-1a1 1 0 0 1 1-1zM3.25 5.75v5.5a2 2 0 0 0 2 2h.5M12.75 5.75v5.5a2 2 0 0 1-2 2h-.5M8 13.25V8M6 10l2-2 2 2",
  },
  trash: { stroke: "M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 8.5h6l.5-8.5M6.75 7v3.5M9.25 7v3.5" },
  pencil: { stroke: "M10.25 3.25l2.5 2.5L5.5 13H3v-2.5z" },
  copy: { stroke: "M6.5 6.5h6.25v6.25H6.5zM3.25 9.5V3.25H9.5" },
  terminal: { stroke: "M2.5 3.5h11v9h-11zM5 6.5l2 1.5-2 1.5M8.75 10h2.25" },
  /** The thinking face: a raised brow and a hand at the chin. */
  thinking: { stroke: "M5.2 11.6a5.5 5.5 0 1 1 5.3 1.3M6.2 6.5v.1M10.3 6.5v.1M9.4 4.2l1.8.4M2.5 13.5h3.2l2.6-3.3h1.5" },
  file: { stroke: "M4 2.5h5l3 3v8H4zM9 2.5v3h3" },
  fileEdit: { stroke: "M8.5 2.5H4v11h4M8.5 2.5l3.5 3.5v1.5M9.5 13.5l.4-2 3.1-3.1 1.6 1.6-3.1 3.1z" },
  filePlus: { stroke: "M4 2.5h5l3 3v8H4zM9 2.5v3h3M8 8v3.5M6.25 9.75h3.5" },
  sliders: { stroke: "M2.5 5h4M10.5 5h3M2.5 11h2M8.5 11h5M10 5a1.75 1.75 0 1 1-3.5 0 1.75 1.75 0 0 1 3.5 0zM8 11a1.75 1.75 0 1 1-3.5 0A1.75 1.75 0 0 1 8 11z" },
  gear: {
    stroke:
      "M6.89 4L7.3 2.29A5.75 5.75 0 0 1 8.7 2.29L9.11 4A4.15 4.15 0 0 1 10.04 4.39L11.54 3.47A5.75 5.75 0 0 1 12.53 4.46L11.61 5.96A4.15 4.15 0 0 1 12 6.89L13.71 7.3A5.75 5.75 0 0 1 13.71 8.7L12 9.11A4.15 4.15 0 0 1 11.61 10.04L12.53 11.54A5.75 5.75 0 0 1 11.54 12.53L10.04 11.61A4.15 4.15 0 0 1 9.11 12L8.7 13.71A5.75 5.75 0 0 1 7.3 13.71L6.89 12A4.15 4.15 0 0 1 5.96 11.61L4.46 12.53A5.75 5.75 0 0 1 3.47 11.54L4.39 10.04A4.15 4.15 0 0 1 4 9.11L2.29 8.7A5.75 5.75 0 0 1 2.29 7.3L4 6.89A4.15 4.15 0 0 1 4.39 5.96L3.47 4.46A5.75 5.75 0 0 1 4.46 3.47L5.96 4.39A4.15 4.15 0 0 1 6.89 4zM10.3 8a2.3 2.3 0 1 1-4.6 0a2.3 2.3 0 1 1 4.6 0z",
  },
  github: {
    fill: "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z",
    pad: 1.75,
  },
  more: { fill: "M3.5 6.9a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2zM8 6.9a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2zM12.5 6.9a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2z" },
  alert: { stroke: "M8 2.75l5.75 10H2.25zM8 6.5v3M8 11.4v.1" },
  info: { stroke: "M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM8 7.5v3.25M8 5.2v.1" },
  refresh: { stroke: "M13 8a5 5 0 1 1-1.6-3.65M13 2.75v2.5h-2.5" },
  sidebar: { stroke: "M2.5 3.5h11v9h-11zM6.25 3.5v9" },
  sparkle: { stroke: "M7 3l1.2 3.3L11.5 7.5 8.2 8.7 7 12 5.8 8.7 2.5 7.5l3.3-1.2zM12.25 2.5v2.5M11 3.75h2.5M12.5 11v2M11.5 12h2" },
  bolt: { stroke: "M8.75 2L4 9h3.5L7 14l4.75-7H8.25z" },
  chip: { stroke: "M5 5h6v6H5zM7 2.5V5M9 2.5V5M7 11v2.5M9 11v2.5M2.5 7H5M2.5 9H5M11 7h2.5M11 9h2.5" },
  key: { stroke: "M5.75 10.5a2.75 2.75 0 1 1 0-5.5 2.75 2.75 0 0 1 0 5.5zM8.5 7.75h5.25M11.75 7.75V10" },
  external: { stroke: "M6.5 3.5h-3v9h9v-3M9.25 3h3.75v3.75M13 3L7.5 8.5" },
  download: { stroke: "M8 2.5v8M4.5 7.25L8 10.75l3.5-3.5M3 13.5h10" },
  fork: { stroke: "M5 5.25v5.5M11 5.25v.5a3 3 0 0 1-3 3H5M6.5 3.75a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zM6.5 12.25a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zM12.5 3.75a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z" },
  compact: { stroke: "M3 6.25h10M3 9.75h10M8 1.75v2.5M6.5 3l1.5 1.5L9.5 3M8 14.25v-2.5M6.5 13L8 11.5 9.5 13" },
  image: { stroke: "M2.5 3.5h11v9h-11zM2.5 10.5l3-3 2.5 2.5 2-2 3.5 3.5M10.6 6.1v.1" },
  enter: { stroke: "M12.5 3.5v5.25h-8M7 6.25L4.5 8.75 7 11.25" },
  clock: { stroke: "M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM8 5v3.25l2 1.25" },
  eye: { stroke: "M1.75 8S4 3.75 8 3.75 14.25 8 14.25 8 12 12.25 8 12.25 1.75 8 1.75 8zM9.75 8a1.75 1.75 0 1 1-3.5 0 1.75 1.75 0 0 1 3.5 0z" },
  plug: { stroke: "M6 2.5v3M10 2.5v3M4.5 5.5h7v2a3.5 3.5 0 0 1-7 0zM8 11v2.5" },
  message: { stroke: "M2.5 3.5h11v7.5H7.25l-3 2.5V11H2.5z" },
  command: { stroke: "M6 6h4v4H6zM6 6V4.5A1.5 1.5 0 1 0 4.5 6zM10 6h1.5A1.5 1.5 0 1 0 10 4.5zM6 10H4.5A1.5 1.5 0 1 0 6 11.5zM10 10v1.5a1.5 1.5 0 1 0 1.5-1.5z" },
  steer: { stroke: "M3.5 3.5v4a2 2 0 0 0 2 2h7M9.75 6.75L12.5 9.5l-2.75 2.75" },
  queue: { stroke: "M3 4.5h10M3 8h6.5M3 11.5h4M10.5 11.5h3M12 10v3" },
  dot: { fill: "M8 5.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z" },
  globe: { stroke: "M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM2.5 8h11M8 2.5c-3 3.5-3 7.5 0 11M8 2.5c3 3.5 3 7.5 0 11" },
  wrench: { stroke: "M10.5 2.75a3 3 0 0 0-3.4 4.2L2.75 11.3l1.95 1.95 4.35-4.35a3 3 0 0 0 4.2-3.4L11.5 7.25 9 6.5l-.5-2z" },
  agents: { stroke: "M8 2.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM3.5 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM12.5 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM8 5.5v2.25M8 7.75L4.25 10.5M8 7.75l3.75 2.75" },
  layers: { stroke: "M8 2.5L2.25 5.75 8 9l5.75-3.25zM2.25 9.25L8 12.5l5.75-3.25" },
  shield: { stroke: "M8 2.25l4.75 2v3.5c0 3-2 5.2-4.75 6-2.75-.8-4.75-3-4.75-6v-3.5z" },
  shieldLock: { stroke: "M8 2.25l4.75 2v3.5c0 3-2 5.2-4.75 6-2.75-.8-4.75-3-4.75-6v-3.5zM6.6 8.3V7.15a1.4 1.4 0 0 1 2.8 0V8.3M6.2 8.3h3.6v3.3H6.2z" },
  shieldHalf: { stroke: "M8 2.25l4.75 2v3.5c0 3-2 5.2-4.75 6-2.75-.8-4.75-3-4.75-6v-3.5zM8 2.25v11.5" },
  shieldBolt: { stroke: "M8 2.25l4.75 2v3.5c0 3-2 5.2-4.75 6-2.75-.8-4.75-3-4.75-6v-3.5zM8.7 4.3L5.6 8.6h2.1l-.3 3.2 3.1-4.4H8.4z" },
} as const satisfies Record<string, { stroke: string; pad?: number } | { fill: string; pad?: number }>;

export type IconName = keyof typeof ICONS;

/** The theme colors an icon takes: a role, never a literal. */
export type Tone = Extract<
  keyof Tokens,
  "foreground" | "muted-foreground" | "subtle" | "brand" | "brand-text" | "brand-foreground" | "destructive" | "success" | "warning"
>;

const paths = new Map<IconName, Path2D>();
const path = (name: IconName) => {
  let made = paths.get(name);
  if (!made) {
    const icon = ICONS[name];
    made = new Path2D("stroke" in icon ? icon.stroke : icon.fill);
    paths.set(name, made);
  }
  return made;
};

/** An icon of the family, `size` points square (16 by default), in a theme color (`tone`). */
export function Icon(props: { name: IconName; size?: number; tone?: Tone; class?: string }) {
  return (
    <Canvas
      class={props.class}
      style={{ width: props.size ?? 16, height: props.size ?? 16 }}
      accessibilityElementsHidden
      draw={(cx, { width }) => {
        const name = props.name;
        const color = token(props.tone ?? "muted-foreground");
        cx.scale(width / 16, width / 16);
        const pad = "pad" in ICONS[name] ? Number(ICONS[name].pad) : 0;
        if (pad) {
          cx.translate(pad, pad);
          cx.scale((16 - pad * 2) / 16, (16 - pad * 2) / 16);
        }
        if ("stroke" in ICONS[name]) {
          cx.strokeStyle = color;
          cx.lineWidth = 1.5;
          cx.lineCap = "round";
          cx.lineJoin = "round";
          cx.stroke(path(name));
        } else {
          cx.fillStyle = color;
          cx.fill(path(name));
        }
      }}
    />
  );
}
