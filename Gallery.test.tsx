// Renders the mascot and icon gallery for review:
//
//   nsh test Gallery.test.tsx --target macos    # writes .nsh/shots/gallery-*.png
import { expect, open, test } from "nsh/test";

test("gallery shows every mood of Pip", async () => {
  for (const colorScheme of ["dark", "light"] as const) {
    const app = await open("./Gallery.tsx", { width: 900, height: 860, colorScheme, platform: "macos" });
    await app.wait(700);
    expect(app.texts()).toContain("sleep");
    // Only a real platform draws the app; headless runs have nothing to picture.
    await app.screenshot(`.nsh/shots/gallery-${colorScheme}.png`).catch(() => undefined);
  }
});
