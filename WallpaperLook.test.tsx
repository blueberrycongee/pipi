// The app under a wallpaper, for design review: every surface the wallpaper
// reaches — the sidebar, the title bar, the empty chat, a conversation,
// Settings — in both appearances.
//
//   nsh test WallpaperLook.test.tsx --target macos   # writes .nsh/shots/wallpaper-*.png
//
// It photographs the repository's own picture; name any image in `PICTURE`
// (an absolute path and its size in pixels) to review another one — a bright
// photo in dark and a dark one in light are the cases to look at.
// Only a real platform draws the app, so headless runs skip.
import { open, test } from "nsh/test";
import type { App } from "nsh/test";

type Scheme = "dark" | "light";

/** `{}`: the repository's picture (`Harness.tsx` → `harness.wallpaper`). */
const PICTURE: { path?: string; width?: number; height?: number } = {};

const launch = (
  scenario: string,
  colorScheme: Scheme,
  prefs: Record<string, unknown> = {},
  extraStorage: Record<string, string> = {},
) =>
  open("./Harness.tsx", {
    width: 1180,
    height: 780,
    platform: "macos",
    locale: "en-US",
    colorScheme,
    storage: {
      "harness.scenario": scenario,
      "harness.wallpaper": JSON.stringify(PICTURE),
      "pipi.prefs.v1": JSON.stringify({ appearance: colorScheme, ...prefs }),
      ...extraStorage,
    },
  });

let drawn = true;
async function shot(app: App, name: string) {
  if (!drawn) return;
  await app.wait(600);
  try {
    await app.screenshot(`.nsh/shots/wallpaper-${name}.png`);
  } catch {
    drawn = false;
  }
}

test("the app under a wallpaper", async () => {
  for (const scheme of ["dark", "light"] as Scheme[]) {
    let app = await launch("welcome", scheme);
    await app.waitFor("text:What are we building?");
    await shot(app, `welcome-${scheme}`);
    if (!drawn) return;

    app = await launch("history", scheme);
    await app.waitFor("text:Here is the plan.");
    await shot(app, `chat-${scheme}`);
    await app.press("label:Settings");
    await shot(app, `settings-${scheme}`);

    // A long conversation scrolled mid-stream: rows pass under both the title bar and the composer.
    app = await launch("history", scheme, {}, { "harness.long": "1", "harness.then": "50:/sessions/two.jsonl" });
    await app.waitFor("text:Part 24 of the plan");
    await app.scroll("label:Conversation", -240);
    await shot(app, `chat-scrolled-${scheme}`);

    // The theme tinted from the picture: the page's wash follows the tinted background.
    app = await launch("history", scheme, { wallpaperThemeColors: true });
    await app.waitFor("text:Here is the plan.");
    await shot(app, `chat-tinted-${scheme}`);

    // The sidebar folded away: the title bar alone carries the picture to the window's edge.
    app = await launch("welcome", scheme, { sidebarOpen: false });
    await app.waitFor("text:What are we building?");
    await shot(app, `welcome-folded-${scheme}`);

    // A shader effect draws the same picture everywhere it shows.
    app = await launch("welcome", scheme, { wallpaperEffect: "halftone" });
    await app.waitFor("text:What are we building?");
    await shot(app, `welcome-halftone-${scheme}`);
  }
}, 240000);
