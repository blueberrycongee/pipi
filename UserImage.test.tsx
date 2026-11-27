// Sent images render as real previews right above a text-only user bubble
// (and with no empty bubble when sent alone), and pressing any preview opens
// the zoom layer.
//
//   nsh test UserImage.test.tsx --target macos   # writes .nsh/shots/user-image-*.png
import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

let drawn = true;
async function shot(app: App, name: string) {
  if (!drawn) return;
  await app.wait(350);
  try {
    await app.screenshot(`.nsh/shots/${name}.png`);
  } catch {
    drawn = false;
  }
}

test("composer image thumbnails open the zoom preview while remove only removes", async () => {
  const app = await open("./Harness.tsx", {
    width: 1080,
    height: 760,
    platform: "macos",
    locale: "en-US",
    colorScheme: "dark",
    storage: { "harness.scenario": "welcome", "harness.reply": "Got it." },
  });
  await app.waitFor("text:What are we building?");

  await app.paste("label:Message", { files: ["icon.png", "assets/brand/dmg-background@2x.png"] });
  await app.waitFor("label:Attachments");
  await app.waitUntil(() => app.count("id:composer-image") === 2);
  await app.waitUntil(() => app.count("label:Remove image") === 2);

  // The thumbnail body is a preview control: the two waiting images form the gallery.
  await app.press("id:composer-image >> nth=0");
  await app.waitFor("label:Close preview");
  await app.waitFor("text:1 / 2");
  await shot(app, "composer-image-zoom-dark");
  await app.press("label:Next image");
  await app.waitFor("text:2 / 2");
  await app.waitFor("text:1320 × 840");
  await app.keyboard.press("escape");
  await app.waitUntil(() => app.count("label:Close preview") === 0);

  // The small × removes its own attachment and never falls through to the thumbnail's preview.
  await app.press("label:Remove image >> nth=0");
  await app.waitUntil(() => app.count("label:Remove image") === 1);
  await app.wait(150);
  expect(app.count("label:Close preview")).toBe(0);

  // The first attachment is the one that left: the remaining preview is the second image.
  await app.press("id:composer-image >> nth=0");
  await app.waitFor("label:Close preview");
  await app.waitFor("text:1320 × 840");
  expect(app.count("text:1 / 2")).toBe(0);
  await app.keyboard.press("escape");
  await app.waitUntil(() => app.count("label:Close preview") === 0);
}, 60000);

test("sent images render previews above a text-only bubble, omit the bubble when sent alone, and zoom on press", async () => {
  for (const scheme of ["dark", "light"] as const) {
    const app = await open("./Harness.tsx", {
      width: 1080,
      height: 760,
      platform: "macos",
      locale: "en-US",
      colorScheme: scheme,
      storage: { "harness.scenario": "welcome", "harness.reply": "Got it — I can see the screenshot clearly." },
    });
    await app.waitFor("text:What are we building?");

    // 1. Single landscape image + text: preview sits above the text bubble; bubble has text only (no "1 image" label).
    await app.paste("label:Message", { files: ["assets/brand/dmg-background@2x.png"] });
    await app.waitFor("label:Attachments");
    await app.type("label:Message", "Can you refine the spacing on this window?");
    await app.submit("label:Message");
    await app.waitFor("text:Got it — I can see the screenshot clearly.");
    expect(app.count("id:message-image")).toBe(1);
    expect(app.count("id:message-bubble")).toBe(1);
    expect(app.count("text:1 image")).toBe(0);

    // 2. Multiple images + text: right-aligned thumbnail strip above the text bubble.
    await app.paste("label:Message", { files: ["icon.png", "assets/brand/dmg-background@2x.png", "icon.png"] });
    await app.waitFor("label:Attachments");
    await app.type("label:Message", "Compare these three versions for me.");
    await app.submit("label:Message");
    await app.waitUntil(() => app.count("id:message-image") === 4);
    expect(app.count("id:message-bubble")).toBe(2);
    expect(app.count("text:3 images")).toBe(0);
    await shot(app, `user-image-pair-${scheme}`);

    // 3. Image only (no text): renders the image preview with NO empty text bubble below it.
    await app.paste("label:Message", { files: ["icon.png"] });
    await app.waitFor("label:Attachments");
    await app.submit("label:Message");
    await app.waitUntil(() => app.count("id:message-image") === 5);
    expect(app.count("id:message-bubble")).toBe(2);

    await shot(app, `user-image-${scheme}`);

    // 4. Pressing an image opens the zoom preview layer; Escape closes it.
    if (scheme === "dark") {
      await app.press("id:message-image >> nth=0");
      await app.waitFor("label:Close preview");
      await shot(app, "user-image-zoom-dark");
      await app.keyboard.press("escape");
      await app.waitUntil(() => app.count("label:Close preview") === 0);
    }
  }
}, 120000);
