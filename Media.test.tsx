// Inline media in the message stream: Markdown images/galleries/audio/deliverables,
// orchestration `present_files` + tool `ImageContent` surviving turn folds, user
// file attachments (`<attachment ... />`), safe remote link cards, and zoom preview.
//
//   nsh test Media.test.tsx --target macos   # writes .nsh/shots/media-*.png
import * as fs from "fs/promises";
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

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function makeSolidPng(width: number, height: number, r: number, g: number, b: number): Uint8Array {
  const rowLen = 1 + width * 4;
  const raw = new Uint8Array(rowLen * height);
  for (let y = 0; y < height; y++) {
    const base = y * rowLen;
    raw[base] = 0; // filter none
    for (let x = 0; x < width; x++) {
      const px = base + 1 + x * 4;
      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
      raw[px + 3] = 255;
    }
  }
  let s1 = 1;
  let s2 = 0;
  for (let i = 0; i < raw.length; i++) {
    s1 = (s1 + raw[i]) % 65521;
    s2 = (s2 + s1) % 65521;
  }
  const adler = ((s2 << 16) | s1) >>> 0;
  const zlib = new Uint8Array(2 + 5 + raw.length + 4);
  const zView = new DataView(zlib.buffer);
  zlib[0] = 0x78;
  zlib[1] = 0x01;
  zlib[2] = 0x01; // final uncompressed DEFLATE block
  zView.setUint16(3, raw.length, true);
  zView.setUint16(5, ~raw.length & 0xffff, true);
  zlib.set(raw, 7);
  zView.setUint32(7 + raw.length, adler, false);

  const ihdr = new Uint8Array(13);
  const iView = new DataView(ihdr.buffer);
  iView.setUint32(0, width);
  iView.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const c1 = pngChunk("IHDR", ihdr);
  const c2 = pngChunk("IDAT", zlib);
  const c3 = pngChunk("IEND", new Uint8Array(0));
  const out = new Uint8Array(sig.length + c1.length + c2.length + c3.length);
  out.set(sig, 0);
  out.set(c1, sig.length);
  out.set(c2, sig.length + c1.length);
  out.set(c3, sig.length + c1.length + c2.length);
  return out;
}

function makeSilentWav(): Uint8Array {
  const sampleCount = 800; // 0.1s at 8kHz mono PCM
  const dataSize = sampleCount * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, 8000, true); // 8kHz
  view.setUint32(28, 16000, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);
  return new Uint8Array(buf);
}

test("inline media renders Markdown galleries, audio/PDF cards, remote link safety, user attachments, and zoom", async () => {
  const tmpDir = `/tmp/pipi-media-test-${Date.now()}`;
  await fs.mkdir(tmpDir, { recursive: true });
  const iconTmp = `${tmpDir}/icon.png`;
  const bannerTmp = `${tmpDir}/banner.png`;
  const wavPath = `${tmpDir}/voice-demo.wav`;
  const pdfPath = `${tmpDir}/release-brief.pdf`;
  const missingPng = `${tmpDir}/missing-preview.png`;

  await fs.writeFile(iconTmp, makeSolidPng(96, 96, 46, 178, 172));
  await fs.writeFile(bannerTmp, makeSolidPng(120, 80, 99, 102, 241));
  await fs.writeFile(wavPath, makeSilentWav());
  await fs.writeFile(pdfPath, "%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

  const markdownReply = [
    "Here are the generated media assets and deliverable files:",
    "",
    `![Icon](${iconTmp}) ![Banner](${bannerTmp})`,
    "",
    `[Voice walkthrough](${wavPath})`,
    "",
    `[Release brief PDF](${pdfPath})`,
    "",
    `![Missing screenshot](${missingPng})`,
    "",
    "![Remote telemetry chart](https://example.com/chart.png)",
  ].join("\n");

  try {
    for (const scheme of ["dark", "light"] as const) {
      const app = await open("./Harness.tsx", {
        width: 1120,
        height: 820,
        platform: "macos",
        locale: "en-US",
        colorScheme: scheme,
        storage: {
          "harness.scenario": "welcome",
          "harness.reply": markdownReply,
        },
      });
      await app.waitFor("text:What are we building?");

      // User pastes local audio + PDF files (Finder `file://` URIs): they become composer file cards, not raw paths.
      await app.paste("label:Message", { uris: [`file://${wavPath}`, `file://${pdfPath}`] });
      await app.waitFor("label:Attachments");
      await app.waitUntil(() => app.count("id:composer-file") === 2);
      await app.type("label:Message", "Review these media deliverables please");
      await app.submit("label:Message");

      await app.waitFor("text:Here are the generated media assets and deliverable files:");
      // Local PNGs render as 2 native image cards; remote https URL never auto-fetches into an image card.
      await app.waitUntil(() => app.count("id:media-image-card") === 2);
      // User audio + assistant Markdown audio = 2 audio cards.
      await app.waitUntil(() => app.count("id:media-audio-card") === 2);
      // User PDF + assistant PDF + missing image fallback + remote https card = 4 file cards.
      await app.waitUntil(() => app.count("id:media-file-card") === 4);
      // Raw wire tags stay hidden from bubble text, and missing file shows honest status.
      expect(app.count("text:<attachment")).toBe(0);
      await app.waitFor("text:PNG · File not found");

      await shot(app, `media-${scheme}`);

      if (scheme === "dark") {
        // Clicking an inline image opens the ZoomLayer with Open / Reveal actions; Escape closes it.
        await app.press("label:Icon");
        await app.waitFor("label:Close preview");
        await shot(app, "media-zoom-dark");
        await app.keyboard.press("escape");
        await app.waitUntil(() => app.count("label:Close preview") === 0);
      }
    }
  } finally {
    await fs.unlink(iconTmp).catch(() => undefined);
    await fs.unlink(bannerTmp).catch(() => undefined);
    await fs.unlink(wavPath).catch(() => undefined);
    await fs.unlink(pdfPath).catch(() => undefined);
    await fs.rmdir(tmpDir).catch(() => undefined);
  }
}, 120000);

test("present_files and tool ImageContent surface outside collapsed turn folds", async () => {
  const tmpDir = `/tmp/pipi-media-present-${Date.now()}`;
  await fs.mkdir(tmpDir, { recursive: true });
  const iconTmp = `${tmpDir}/icon.png`;
  const bannerTmp = `${tmpDir}/banner.png`;
  await fs.writeFile(iconTmp, makeSolidPng(96, 96, 46, 178, 172));
  await fs.writeFile(bannerTmp, makeSolidPng(120, 80, 99, 102, 241));

  try {
    const app = await open("./Harness.tsx", {
      width: 1120,
      height: 820,
      platform: "macos",
      locale: "en-US",
      colorScheme: "dark",
      storage: {
        "harness.scenario": "welcome",
        "harness.reply": "Done — both the curated deliverables and the live screenshot are ready below.",
      },
    });
    await app.waitFor("text:What are we building?");

    await app.type("label:Message", `Please show media: ${iconTmp},${bannerTmp}`);
    await app.submit("label:Message");

    await app.waitFor("text:Done — both the curated deliverables and the live screenshot are ready below.");
    // Curated `present_files` title + its 2 images + `screenshot` tool ImageContent stay visible outside the folded turn!
    await app.waitFor("text:Generated deliverables");
    await app.waitUntil(() => app.count("id:media-image-card") === 3);

    await shot(app, "media-present-dark");
  } finally {
    await fs.unlink(iconTmp).catch(() => undefined);
    await fs.unlink(bannerTmp).catch(() => undefined);
    await fs.rmdir(tmpDir).catch(() => undefined);
  }
}, 120000);
