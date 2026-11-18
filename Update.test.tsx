// The update card, state by state — the scripted updater has it appear,
// download and ready, so a look can be taken of each:
//
//   nsh test Update.test.tsx --target macos      # writes .nsh/shots/update-*.png
//
// Only a real platform draws the app, so headless runs check the texts and skip the shots.
import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

const OUT = ".nsh/shots";
let drawn = true;
async function shot(app: App, name: string) {
  if (!drawn) return;
  try {
    await app.screenshot(`${OUT}/${name}.png`);
  } catch {
    drawn = false;
  }
}

const UPDATE = {
  version: "0.3.0",
  // Like the real release notes (`release.yml`): Markdown with bolds and code spans.
  notes: "**macOS**: signed and notarized by Apple; the disk image and `pipi.app` inside it carry stapled tickets.\n\n**Windows**: unpack `pipi-*-windows-x64.zip` and run `pipi.exe`.\n\n**Linux**: unpack `pipi-*-linux-x64.tar.gz` and run `pipi`.",
  bytes: 48_000_000,
  rate: 7_000,
};

test("update card: found, downloading, ready", async () => {
  const app = await open("./Harness.tsx", {
    width: 1180,
    height: 780,
    platform: "macos",
    locale: "en-US",
    storage: { "harness.update": JSON.stringify(UPDATE) },
  });
  await app.waitFor("text:What are we building?");

  // The checker's first pass lands the card a few seconds after boot.
  await app.waitFor("text:pipi 0.3.0 is available", { timeout: 8000 });
  await app.wait(400);
  await shot(app, "update-available");

  // The download takes ~7s: mid-flight the fill is partway and Pip rides it
  // under the dimmed block waiting at the end.
  await app.press("text:Update");
  await app.waitFor("text:Downloading pipi 0.3.0");
  await app.wait(1800);
  await shot(app, "update-downloading");

  // Done, the card offers the restart — Pip's happy jump knocks the block
  // awake at its peak, so "Restart" itself takes a beat to appear.
  await app.waitFor("text:pipi 0.3.0 is ready", { timeout: 9000 });
  await app.waitFor("text:Restart", { timeout: 3000 });
  await shot(app, "update-ready");

  // Restarting leaves the installing line on screen (the fake never returns, as the app quits first).
  await app.press("text:Restart");
  await app.waitFor("text:Restarting pipi 0.3.0");
  await shot(app, "update-installing");
});

test("update card: the code package is the download the check prefers", async () => {
  const app = await open("./Harness.tsx", {
    width: 1180,
    height: 780,
    platform: "macos",
    locale: "en-US",
    // The manifest offers both: the 48 MB archive and a 480 KB signed package of
    // the code. A shell that runs packages takes the small one.
    storage: { "harness.update": JSON.stringify({ ...UPDATE, package: true, bytes: 480_000, rate: 200 }) },
  });
  await app.waitFor("text:What are we building?");

  // The package's size names it before a byte moves: kilobytes, not the archive's megabytes.
  await app.waitFor("text:pipi 0.3.0 is available", { timeout: 8000 });
  expect(app.texts()).toContain("A new version is out · 480 KB");
  await app.press("text:Update");
  await app.waitFor("text:Downloading pipi 0.3.0");
  await app.waitUntil(() => app.texts().some((t) => t.includes("/ 480 KB")));
  await shot(app, "update-package");

  // Ready, it restarts into the package — the same card the archive's restart lands on.
  await app.waitFor("text:pipi 0.3.0 is ready", { timeout: 9000 });
  await app.waitFor("text:Restart", { timeout: 3000 });
  await app.press("text:Restart");
  await app.waitFor("text:Restarting pipi 0.3.0");
});

test("update card: indeterminate track", async () => {
  const app = await open("./Harness.tsx", {
    width: 1180,
    height: 780,
    platform: "macos",
    locale: "en-US",
    storage: { "harness.update": JSON.stringify({ ...UPDATE, unknownSize: true }) },
  });
  await app.waitFor("text:What are we building?");
  await app.waitFor("text:pipi 0.3.0 is available", { timeout: 8000 });
  await app.press("text:Update");
  await app.waitFor("text:Downloading pipi 0.3.0");
  await app.wait(1200);
  await shot(app, "update-indeterminate");
});
