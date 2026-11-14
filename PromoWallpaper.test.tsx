// The pictures to post: the day of `Promo.tsx` on its empty chat, in dark, over
// each wallpaper `dev/promo-wallpapers.json` lists — the sidebar open, then
// folded away.
//
//   python3 scripts/promo-wallpapers.py fetch         # the pictures, cut to the window, into /tmp/pipi-wallpapers/
//   nsh test PromoWallpaper.test.tsx --target macos   # writes .nsh/shots/wall-*.png (--filter <set id> for one set)
//   python3 scripts/promo-wallpapers.py render        # finishes them into .nsh/promo/
//
// A wallpaper is a file and a native app takes no relative path, so the
// pictures stand at a fixed place outside the checkout.
// Only a real platform draws the app, so headless runs skip.
import { open, test } from "nsh/test";
import manifest from "./dev/promo-wallpapers.json";

const WORKSPACES = ["/Users/pip/code/lumen-api", "/Users/pip/code/lumen-web", "/Users/pip/code/infra", "/Users/pip/code/dotfiles"];
const PICTURES = "/tmp/pipi-wallpapers";
/** What `scripts/promo-wallpapers.py fetch` cuts every picture to: the window's shape, past its pixels. */
const WIDTH = 3072;
const HEIGHT = 1920;

interface Picture {
  id: string;
  /** The shader the wallpaper is drawn through (`WallpaperEffect`); none when absent. */
  effect?: string;
  /** Pip's coat (`CoatId`); the ghost when absent. */
  coat?: string;
}

const VARIANTS = [
  { suffix: "", sidebarOpen: true },
  { suffix: "-folded", sidebarOpen: false },
] as const;

const launch = (picture: Picture, sidebarOpen: boolean) =>
  open("./Promo.tsx", {
    width: 1440,
    height: 900,
    platform: "macos",
    locale: "en-US",
    colorScheme: "dark",
    storage: {
      "promo.scene": "welcome",
      "pipi.prefs.v1": JSON.stringify({
        workspaces: WORKSPACES,
        activeWorkspace: WORKSPACES[0],
        collapsedWorkspaces: [],
        collapsedGroups: ["workspaces", "archived"],
        sidebarOpen,
        appearance: "dark",
        pipCoat: picture.coat ?? "ghost",
        wallpaper: {
          path: `${PICTURES}/${picture.id}.jpg`,
          name: `${picture.id}.jpg`,
          width: WIDTH,
          height: HEIGHT,
          adjustment: { focalX: 0.5, focalY: 0.5, zoom: 1 },
        },
        wallpaperEffect: picture.effect ?? "none",
      }),
    },
  });

for (const set of manifest.sets) {
  test(`wallpapers: ${set.id}`, async () => {
    for (const picture of set.pictures as Picture[]) {
      for (const variant of VARIANTS) {
        const app = await launch(picture, variant.sidebarOpen);
        await app.waitFor("text:What are we building?");
        await app.wait(1200);
        try {
          await app.screenshot(`.nsh/shots/wall-${set.id}-${picture.id}${variant.suffix}.png`);
        } catch {
          return;
        }
      }
    }
  }, 600000);
}
