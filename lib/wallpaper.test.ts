import { expect, test } from "nsh/test";
import {
  AVAILABLE_WALLPAPER_EFFECTS,
  DEFAULT_WALLPAPER_ADJUSTMENT,
  DYNAMIC_WALLPAPER_ENABLED,
  inspectVideoBytes,
  inspectWallpaperBytes,
  isAvailableWallpaperEffect,
  isDynamicWallpaperConfig,
  isSupportedWallpaperPath,
  isVideoWallpaperPath,
  parseWallpaperEngineProject,
  WALLPAPER_EFFECTS,
  WALLPAPER_PRESET_SHADERS,
  WALLPAPER_PRESETS,
  WALLPAPER_SHADERS,
  wallpaperPresetUniforms,
  wallpaperShaderUniforms,
} from "./wallpaper";

function makeMp4WithTkhd(width: number, height: number): Uint8Array {
  const buf = new Uint8Array(128);
  // Box 1: 24-byte 'ftyp'
  buf[3] = 24;
  buf[4] = 0x66; // 'f'
  buf[5] = 0x74; // 't'
  buf[6] = 0x79; // 'y'
  buf[7] = 0x70; // 'p'
  // Box 2 at offset 24: 92-byte 'tkhd' (version 0)
  const off = 24;
  buf[off + 3] = 92;
  buf[off + 4] = 0x74; // 't'
  buf[off + 5] = 0x6b; // 'k'
  buf[off + 6] = 0x68; // 'h'
  buf[off + 7] = 0x64; // 'd'
  buf[off + 8] = 0; // version 0
  // width at off + 76 (16.16 fixed point)
  buf[off + 76] = (width >>> 8) & 0xff;
  buf[off + 77] = width & 0xff;
  // height at off + 80 (16.16 fixed point)
  buf[off + 80] = (height >>> 8) & 0xff;
  buf[off + 81] = height & 0xff;
  return buf;
}

test("dynamic wallpapers are disabled on the frontend while static images and static effects remain supported", () => {
  expect(DYNAMIC_WALLPAPER_ENABLED).toBe(false);

  expect(isSupportedWallpaperPath("/wallpapers/scene.png")).toBe(true);
  expect(isSupportedWallpaperPath("/wallpapers/photo.jpg")).toBe(true);
  expect(isSupportedWallpaperPath("/wallpapers/loop.mp4")).toBe(false);
  expect(isSupportedWallpaperPath("/wallpapers/loop.MOV")).toBe(false);
  expect(isSupportedWallpaperPath("/wallpapers/loop.webm")).toBe(false);
  expect(isSupportedWallpaperPath("/wallpapers/loop.m4v")).toBe(false);
  expect(isSupportedWallpaperPath("/wallpapers/project.json")).toBe(false);
  expect(isVideoWallpaperPath("/wallpapers/loop.mp4")).toBe(true);
  expect(isVideoWallpaperPath("/wallpapers/scene.png")).toBe(false);

  expect(AVAILABLE_WALLPAPER_EFFECTS).toEqual(["none", "dither", "ascii", "halftone", "scanlines"]);
  expect(isAvailableWallpaperEffect("dither")).toBe(true);
  expect(isAvailableWallpaperEffect("ascii")).toBe(true);
  expect(isAvailableWallpaperEffect("ripple")).toBe(false);
  expect(isAvailableWallpaperEffect("rain")).toBe(false);

  expect(
    isDynamicWallpaperConfig({
      path: "/wallpapers/scene.png",
      kind: "image",
    }),
  ).toBe(false);
  expect(
    isDynamicWallpaperConfig({
      path: "/wallpapers/loop.mp4",
    }),
  ).toBe(true);
  expect(
    isDynamicWallpaperConfig({
      path: "preset:aurora",
    }),
  ).toBe(true);
  expect(
    isDynamicWallpaperConfig({
      path: "preset:cosmos",
      kind: "shader",
      preset: "cosmos",
    }),
  ).toBe(true);
  expect(DEFAULT_WALLPAPER_ADJUSTMENT.zoom).toBe(1);
});

test("inspectVideoBytes extracts dimensions and dominant color from MP4 and WebM headers", () => {
  const mp4 = makeMp4WithTkhd(3840, 2160);
  const info = inspectVideoBytes(mp4, "/wallpapers/cyberpunk.mp4");
  expect(info).toBeDefined();
  expect(info?.kind).toBe("video");
  expect(info?.format).toBe("mp4");
  expect(info?.width).toBe(3840);
  expect(info?.height).toBe(2160);
  expect(info?.dominantColor).toMatch(/^#[0-9a-f]{6}$/);

  const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01]);
  const webmInfo = inspectWallpaperBytes(webm, "/wallpapers/rain.webm");
  expect(webmInfo?.kind).toBe("video");
  expect(webmInfo?.format).toBe("webm");
  expect(webmInfo?.width).toBe(1920);
  expect(webmInfo?.height).toBe(1080);
});

test("parseWallpaperEngineProject parses file, title, and normalized schemecolor", () => {
  const json = JSON.stringify({
    file: "neotokyo_loop.mp4",
    title: "Neo Tokyo Rain 4K",
    type: "video",
    general: {
      properties: {
        schemecolor: {
          order: 0,
          text: "ui_browse_properties_scheme_color",
          type: "color",
          value: "0.18 0.62 0.94",
        },
      },
    },
  });
  const parsed = parseWallpaperEngineProject(json);
  expect(parsed).toBeDefined();
  expect(parsed?.file).toBe("neotokyo_loop.mp4");
  expect(parsed?.title).toBe("Neo Tokyo Rain 4K");
  expect(parsed?.type).toBe("video");
  expect(parsed?.dominantColor).toMatch(/^#[0-9a-f]{6}$/);
});

test("dynamic shader effects and procedural presets provide WGSL sources and uniforms", () => {
  expect(WALLPAPER_EFFECTS).toContain("ripple");
  expect(WALLPAPER_EFFECTS).toContain("rain");
  expect(WALLPAPER_SHADERS.ripple).toContain("sample_content");
  expect(WALLPAPER_SHADERS.rain).toContain("sample_content");

  const rippleU = wallpaperShaderUniforms("ripple", true, 0.85);
  expect(rippleU.dark).toBe(1);
  expect(rippleU.energy).toBe(0.85);
  expect(rippleU.mouseX).toBe(0.5);

  for (const preset of WALLPAPER_PRESETS) {
    expect(WALLPAPER_PRESET_SHADERS[preset]).toContain("fn shade(uv: vec2f) -> vec4f");
  }
  const presetU = wallpaperPresetUniforms(false, 0.55);
  expect(presetU.dark).toBe(0);
  expect(presetU.energy).toBe(0.55);
});
