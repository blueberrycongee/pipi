// The README's pictures, from the scripted app in `Promo.tsx`:
//
//   nsh test Promo.test.tsx --target macos      # writes .nsh/shots/promo-*.png
//   python3 scripts/render-promo.py             # frames them into assets/promo/
//
// Only a real platform draws the app, so headless runs skip.
import { open, test } from "nsh/test";

const WORKSPACES = ["/Users/pip/code/lumen-api", "/Users/pip/code/lumen-web", "/Users/pip/code/infra", "/Users/pip/code/dotfiles"];

// The README ships English on light; the -zh and -dark variants photograph the
// same day localized and dark.
const VARIANTS = [
  { suffix: "", locale: "en-US", colorScheme: "light" },
  { suffix: "-zh", locale: "zh-Hans-CN", colorScheme: "light" },
  { suffix: "-dark", locale: "en-US", colorScheme: "dark" },
  { suffix: "-zh-dark", locale: "zh-Hans-CN", colorScheme: "dark" },
] as const;

const launch = (variant: (typeof VARIANTS)[number], prefs: Record<string, unknown> = {}) =>
  open("./Promo.tsx", {
    width: 1240,
    height: 840,
    platform: "macos",
    locale: variant.locale,
    colorScheme: variant.colorScheme,
    storage: {
      "pipi.prefs.v1": JSON.stringify({
        workspaces: WORKSPACES,
        activeWorkspace: WORKSPACES[0],
        collapsedWorkspaces: [],
        // The picture is of 最近: sessions of every project and engine in one list.
        collapsedGroups: ["workspaces", "archived"],
        sidebarOpen: true,
        ...prefs,
      }),
    },
  });

test("promo", async () => {
  for (const variant of VARIANTS) {
    const zh = variant.locale.startsWith("zh");
    const rootCause = `text:${zh ? "根因" : "Root cause"}`;
    let app = await launch(variant);
    await app.waitFor(rootCause);
    await app.wait(800);
    try {
      await app.screenshot(`.nsh/shots/promo-chat${variant.suffix}.png`);
    } catch {
      return;
    }

    app = await launch(variant, { pipCoat: "shiba" });
    await app.waitFor(rootCause);
    await app.press(`label:${zh ? "设置" : "Settings"}`);
    await app.waitFor(`text:${zh ? "狗" : "Dogs"}`);
    await app.wait(800);
    await app.screenshot(`.nsh/shots/promo-settings${variant.suffix}.png`);
  }
}, 120000);
