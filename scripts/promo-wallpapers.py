#!/usr/bin/env python3
"""Fetch wallpaper images and render promo screenshots.

    python3 scripts/promo-wallpapers.py fetch [--filter <set-id>] [--force]
    nsh test PromoWallpaper.test.tsx --target macos [--filter <set-id>]
    python3 scripts/promo-wallpapers.py render [--filter <set-id>]

fetch   Downloads each picture from its artvee /dl/ page (resolving the
        signed S3 link) or a direct src URL, center-crops it to 3072x1920
        respecting the picture's focalX/focalY, and saves it as
        /tmp/pipi-wallpapers/{id}.jpg.

render  Reads app screenshots from .nsh/shots/wall-{set}-{id}[.suffix].png,
        composites each (clean corners, drop shadow, hairline rim) over its
        wallpaper laid as a blurred, dimmed full-bleed backdrop, and writes
        the framed images to .nsh/promo/.

Needs Pillow (pip install pillow). Only artvee pages need the page scrape;
everything else uses a direct image URL in the manifest's `src` field.
"""
from __future__ import annotations

import argparse
import io
import json
import re
import sys
import time
import urllib.request
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "dev" / "promo-wallpapers.json"
PICTURES = Path("/tmp/pipi-wallpapers")
SHOTS = ROOT / ".nsh" / "shots"
OUT = ROOT / ".nsh" / "promo"
TARGET_W, TARGET_H = 3072, 1920

UA_ARTVEE = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
UA_WIKI = "pipi-promo-fetch/0.1 (https://github.com/blueberrycongee/pipi) python-urllib"

# ── Fetch ────────────────────────────────────────────────────────────────────

def artvee_download_url(page_url: str) -> str | None:
    """Scrape the signed SDL/HDL image URL from an artvee /dl/ page."""
    req = urllib.request.Request(page_url, headers={"User-Agent": UA_ARTVEE})
    r = urllib.request.urlopen(req, timeout=20)
    html = r.read().decode("utf-8", "ignore")
    m = re.findall(r"(https://mdl\.artvee\.com/(?:hdl|sdl)/[^\'\"\s]+)", html)
    return m[0] if m else None


def download(url: str, ua: str) -> bytes:
    """Download url and return bytes.  Strips only utm_* params (Wikimedia analytics)."""
    import urllib.parse
    parsed = urllib.parse.urlparse(url)
    if parsed.query and "wikimedia" in parsed.netloc:
        # Remove utm_* tracking params but keep any real query params
        qs = "&".join(p for p in parsed.query.split("&") if not p.lower().startswith("utm_"))
        url = urllib.parse.urlunparse(parsed._replace(query=qs))
    req = urllib.request.Request(url, headers={"User-Agent": ua})
    r = urllib.request.urlopen(req, timeout=120)
    return r.read()


def crop_cover(img: Image.Image, focal_x: float = 0.5, focal_y: float = 0.5) -> Image.Image:
    """Resize img to cover TARGET_W×TARGET_H, then crop at the focal point (0–1)."""
    w, h = img.size
    if w * TARGET_H > h * TARGET_W:   # image is wider than the target ratio
        new_h, new_w = TARGET_H, round(w * TARGET_H / h)
    else:
        new_w, new_h = TARGET_W, round(h * TARGET_W / w)
    img = img.resize((new_w, new_h), Image.LANCZOS)
    left = max(0, min(round(focal_x * (new_w - TARGET_W)), new_w - TARGET_W))
    top  = max(0, min(round(focal_y * (new_h - TARGET_H)), new_h - TARGET_H))
    return img.crop((left, top, left + TARGET_W, top + TARGET_H))


def cmd_fetch(args) -> None:
    manifest = json.loads(MANIFEST.read_text())
    PICTURES.mkdir(parents=True, exist_ok=True)
    for s in manifest["sets"]:
        if args.filter and s["id"] != args.filter:
            continue
        print(f"\n── {s['title']} ──")
        for pic in s["pictures"]:
            dest = PICTURES / f"{pic['id']}.jpg"
            if dest.exists() and not args.force:
                print(f"  skip  {pic['id']:<20}  ({dest.stat().st_size // 1024}KB already in {PICTURES})")
                continue
            print(f"  fetch {pic['id']:<20} ...", end=" ", flush=True)
            try:
                if "page" in pic:
                    src = artvee_download_url(pic["page"])
                    if not src:
                        print("no download link found — skip"); continue
                    ua = UA_ARTVEE
                else:
                    src = pic["src"]
                    ua = UA_WIKI if "wikimedia" in src else UA_ARTVEE
                data = download(src, ua)
                img = Image.open(io.BytesIO(data)).convert("RGB")
                img = crop_cover(img, pic.get("focalX", 0.5), pic.get("focalY", 0.5))
                img.save(dest, "JPEG", quality=95, optimize=True)
                print(f"ok  ({len(data) // 1024}KB raw → {TARGET_W}×{TARGET_H})")
                time.sleep(0.8)
            except Exception as e:
                print(f"error: {e}")

# ── Render (window framing, adapted from scripts/render-promo.py) ───────────

MARGIN_X, MARGIN_TOP, MARGIN_BOTTOM = 120, 80, 120
OUT_WIDTH = 2400
# (blur radius, drop, opacity): wide ambient, closer, contact line.
SHADOWS = [(80, 56, 0.50), (28, 20, 0.32), (5, 4, 0.22)]
LIGHTS = [((255, 95, 87), (224, 68, 62)), ((254, 188, 46), (222, 161, 35)), ((40, 200, 64), (26, 171, 41))]
SS = 4  # supersampling of the painted traffic lights


def clean_window(raw: Image.Image) -> tuple[Image.Image, Image.Image]:
    """Extract the opaque window and a clean anti-aliased mask with no shadow bleed."""
    a = raw.getchannel("A")
    strict = a.point(lambda v: 255 if v >= 252 else 0)
    box = strict.getbbox() or (0, 0, raw.width, raw.height)
    cropped = raw.crop(box)
    cw, ch = cropped.size
    ca = cropped.getchannel("A").load()
    d = 0
    while d < 40 and ca[d, d] < 252:
        d += 1
    radius = max(20, round(d / 0.292893))
    rgb = cropped.convert("RGB")
    inside = cropped.getchannel("A").point(lambda v: 255 if v >= 250 else 0)
    padded = rgb.copy()
    for _ in range(4):
        padded = Image.composite(padded, padded.filter(ImageFilter.BoxBlur(2)), inside)
    hi = Image.new("L", (cw * SS, ch * SS), 0)
    ImageDraw.Draw(hi).rounded_rectangle([0, 0, cw * SS - 1, ch * SS - 1], radius=radius * SS, fill=255)
    mask = hi.resize((cw, ch), Image.LANCZOS)
    out = padded.convert("RGBA")
    out.putalpha(mask)
    return out, mask


def find_lights(shot: Image.Image):
    """Centers and radius of the three gray title-bar buttons, read from the photo."""
    px = shot.convert("RGB").load()
    for gray in (220, 70, 60):
        is_btn = lambda x, y: all(abs(c - gray) <= 6 for c in px[x, y])
        for y in range(20, 80):
            runs, start = [], None
            for x in range(0, 160):
                on = is_btn(x, y)
                if on and start is None:
                    start = x
                if not on and start is not None:
                    runs.append((start, x - 1)); start = None
            if len(runs) == 3 and all(b - a >= 18 for a, b in runs):
                cx = runs[0][0] + (runs[0][1] - runs[0][0]) // 2
                ys = [yy for yy in range(10, 90) if is_btn(cx, yy)]
                if ys:
                    cy = (ys[0] + ys[-1]) / 2
                    radius = (ys[-1] - ys[0] + 3) / 2
                    return [((a + b) / 2, cy) for a, b in runs], radius
    return [], 0

def paint_lights(shot: Image.Image) -> None:
    centers, radius = find_lights(shot)
    for (cx, cy), (fill, rim) in zip(centers, LIGHTS):
        size = int(radius * 2 + 4)
        dot = Image.new("RGBA", (size * SS, size * SS), (0, 0, 0, 0))
        draw = ImageDraw.Draw(dot)
        mid, r = size * SS / 2, radius * SS
        draw.ellipse([mid - r, mid - r, mid + r, mid + r], fill=rim + (255,))
        draw.ellipse([mid - r + SS, mid - r + SS, mid + r - SS, mid + r - SS], fill=fill + (255,))
        dot = dot.resize((size, size), Image.LANCZOS)
        shot.alpha_composite(dot, (round(cx + 0.5 - size / 2), round(cy + 0.5 - size / 2)))


def tint_layer(size: tuple, rgb: tuple, alpha: Image.Image) -> Image.Image:
    layer = Image.new("RGBA", size, rgb + (0,))
    layer.putalpha(alpha)
    return layer


def render_shot(shot_path: Path, wallpaper_path: Path | None, out_path: Path) -> None:
    raw = Image.open(shot_path).convert("RGBA")
    shot, mask = clean_window(raw)
    paint_lights(shot)
    w, h = shot.size

    # Scale so the app fits within OUT_WIDTH minus margins.
    scale = (OUT_WIDTH - 2 * MARGIN_X) / w
    app_w, app_h = round(w * scale), round(h * scale)
    shot_sc = shot.resize((app_w, app_h), Image.LANCZOS)
    mask_sc = mask.resize((app_w, app_h), Image.LANCZOS)

    canvas_w = OUT_WIDTH
    canvas_h = app_h + MARGIN_TOP + MARGIN_BOTTOM

    # Backdrop: wallpaper blurred + dimmed, or plain black.
    if wallpaper_path and wallpaper_path.exists():
        wp = Image.open(wallpaper_path).convert("RGB")
        wp_scale = max(canvas_w / wp.width, canvas_h / wp.height)
        wp_w, wp_h = round(wp.width * wp_scale), round(wp.height * wp_scale)
        wp = wp.resize((wp_w, wp_h), Image.LANCZOS)
        left = (wp_w - canvas_w) // 2
        top  = (wp_h - canvas_h) // 2
        wp = wp.crop((left, top, left + canvas_w, top + canvas_h))
        wp = wp.filter(ImageFilter.GaussianBlur(18))
        dark = Image.new("RGB", (canvas_w, canvas_h), (0, 0, 0))
        canvas = Image.blend(wp, dark, 0.42).convert("RGBA")
        canvas.putalpha(255)
    else:
        canvas = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))

    # Drop shadow layers.
    for blur, drop, opacity in SHADOWS:
        shape = Image.new("L", (canvas_w, canvas_h), 0)
        shape.paste(mask_sc, (MARGIN_X, MARGIN_TOP + round(drop * scale)))
        shape = shape.filter(ImageFilter.GaussianBlur(blur)).point(lambda a: round(a * opacity))
        canvas = Image.alpha_composite(canvas, tint_layer((canvas_w, canvas_h), (0, 0, 0), shape))

    # App window.
    win = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
    clipped = shot_sc.copy(); clipped.putalpha(mask_sc)
    win.paste(clipped, (MARGIN_X, MARGIN_TOP))
    canvas = Image.alpha_composite(canvas, win)

    # Hairline specular rim on the dark window.
    outer = Image.new("L", (canvas_w, canvas_h), 0)
    outer.paste(mask_sc.filter(ImageFilter.MaxFilter(3)), (MARGIN_X, MARGIN_TOP))
    inner = Image.new("L", (canvas_w, canvas_h), 0)
    inner.paste(mask_sc, (MARGIN_X, MARGIN_TOP))
    core = Image.new("L", (canvas_w, canvas_h), 0)
    core.paste(mask_sc.filter(ImageFilter.MinFilter(3)), (MARGIN_X, MARGIN_TOP))
    spec = ImageChops.subtract(inner, core).point(lambda a: round(a * 0.14))
    canvas = Image.alpha_composite(canvas, tint_layer((canvas_w, canvas_h), (255, 255, 255), spec))

    out_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out_path, optimize=True)
    print(f"  {out_path.name}  {canvas.width}×{canvas.height}")


def cmd_render(args) -> None:
    manifest = json.loads(MANIFEST.read_text())
    done = 0
    for s in manifest["sets"]:
        if args.filter and s["id"] != args.filter:
            continue
        print(f"\n── {s['title']} ──")
        for pic in s["pictures"]:
            wp_path = PICTURES / f"{pic['id']}.jpg"
            pattern = f"wall-{s['id']}-{pic['id']}*.png"
            shots = sorted(SHOTS.glob(pattern))
            if not shots:
                print(f"  no shots for {s['id']}/{pic['id']}  (run nsh test PromoWallpaper.test.tsx first)")
                continue
            for shot_path in shots:
                suffix = shot_path.stem[len(f"wall-{s['id']}-{pic['id']}"):]
                out_path = OUT / f"{s['id']}-{pic['id']}{suffix}.png"
                render_shot(shot_path, wp_path, out_path)
                done += 1
    print(f"\n{done} image{'s' if done != 1 else ''} written to {OUT}")


# ── Main ─────────────────────────────────────────────────────────────────────

def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("fetch", help="Download wallpaper images to /tmp/pipi-wallpapers/")
    f.add_argument("--filter", metavar="ID", help="Process only this set ID")
    f.add_argument("--force", action="store_true", help="Re-download even if file exists")
    r = sub.add_parser("render", help="Render promo images from app screenshots")
    r.add_argument("--filter", metavar="ID", help="Process only this set ID")
    args = p.parse_args()
    (cmd_fetch if args.cmd == "fetch" else cmd_render)(args)


if __name__ == "__main__":
    main()

