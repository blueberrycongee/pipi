#!/usr/bin/env python3
"""Frames the app's photographs for the README.

    nsh test Promo.test.tsx --target macos      # .nsh/shots/promo-*.png
    python3 scripts/render-promo.py             # assets/promo/*.png

Each window is set on a transparent canvas with its own rounded corners, a
crisp rim (subtle dark on light appearances, subtle specular highlight on dark
appearances) and a multi-layered ambient shadow so both light and dark README
themes look native. A window photographed by the test runner is not the key
window, so its traffic lights are gray: they are painted as a focused window
has them. Needs Pillow (`pip install pillow`).
"""
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SHOTS = ROOT / ".nsh" / "shots"
OUT = ROOT / "assets" / "promo"

# In pixels of the 2x photograph.
MARGIN_X, MARGIN_TOP, MARGIN_BOTTOM = 140, 100, 160
OUT_WIDTH = 2200
# (blur radius, drop, opacity): a wide ambient shadow, a closer one, and a contact line.
SHADOWS_LIGHT = [(76, 54, 0.18), (24, 18, 0.11), (4, 3, 0.09)]
SHADOWS_DARK = [(84, 58, 0.48), (28, 20, 0.30), (5, 3, 0.24)]
LIGHTS = [((255, 95, 87), (224, 68, 62)), ((254, 188, 46), (222, 161, 35)), ((40, 200, 64), (26, 171, 41))]
SS = 4  # supersampling of the painted lights


def clean_window(raw: Image.Image) -> tuple[Image.Image, Image.Image]:
    """Extracts the exact opaque window and a clean anti-aliased mask with zero shadow bleed."""
    a = raw.getchannel("A")
    strict = a.point(lambda v: 255 if v >= 252 else 0)
    box = strict.getbbox() or (0, 0, raw.width, raw.height)
    cropped = raw.crop(box)
    cw, ch = cropped.size
    # Measure exact corner inset along the 45-degree diagonal from (0, 0):
    ca = cropped.getchannel("A").load()
    d = 0
    while d < 40 and ca[d, d] < 252:
        d += 1
    # For a circle of radius R, (R - R/sqrt(2)) = d => R = d / (1 - 0.7071)
    radius = max(20, round(d / 0.292893))
    # Bleed interior RGB 3px outward into transparent corner pixels so AA never samples black:
    rgb = cropped.convert("RGB")
    inside = cropped.getchannel("A").point(lambda v: 255 if v >= 250 else 0)
    padded_rgb = rgb.copy()
    for _ in range(4):
        blurred = padded_rgb.filter(ImageFilter.BoxBlur(2))
        padded_rgb = Image.composite(padded_rgb, blurred, inside)
    hi = Image.new("L", (cw * SS, ch * SS), 0)
    ImageDraw.Draw(hi).rounded_rectangle(
        [0, 0, cw * SS - 1, ch * SS - 1],
        radius=radius * SS,
        fill=255,
    )
    mask = hi.resize((cw, ch), Image.LANCZOS)
    out = padded_rgb.convert("RGBA")
    out.putalpha(mask)
    return out, mask


def find_lights(shot: Image.Image):
    """Centers and radius of the three gray title-bar buttons, read from the photograph."""
    px = shot.convert("RGB").load()
    # An unfocused window's lights are flat gray: ~220 on the light title bar,
    # ~60 on the dark — ~70 when the window is dimmed behind the settings sheet.
    for gray in (220, 70, 60):
        is_button = lambda x, y: all(abs(c - gray) <= 6 for c in px[x, y])
        for y in range(20, 80):
            runs, start = [], None
            for x in range(0, 160):
                on = is_button(x, y)
                if on and start is None:
                    start = x
                if not on and start is not None:
                    runs.append((start, x - 1))
                    start = None
            if len(runs) == 3 and all(b - a >= 18 for a, b in runs):
                cx = runs[0][0] + (runs[0][1] - runs[0][0]) // 2
                ys = [yy for yy in range(10, 90) if is_button(cx, yy)]
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


def tint_layer(size: tuple[int, int], rgb: tuple[int, int, int], alpha: Image.Image) -> Image.Image:
    layer = Image.new("RGBA", size, rgb + (0,))
    layer.putalpha(alpha)
    return layer


def frame(name: str) -> None:
    dark = name.endswith("-dark")
    raw = Image.open(SHOTS / f"promo-{name}.png").convert("RGBA")
    shot, mask = clean_window(raw)
    paint_lights(shot)
    w, h = shot.size
    size = (w + 2 * MARGIN_X, h + MARGIN_TOP + MARGIN_BOTTOM)
    canvas = Image.new("RGBA", size, (0, 0, 0, 0))

    for blur, drop, opacity in (SHADOWS_DARK if dark else SHADOWS_LIGHT):
        shape = Image.new("L", size, 0)
        shape.paste(mask, (MARGIN_X, MARGIN_TOP + drop))
        shape = shape.filter(ImageFilter.GaussianBlur(blur)).point(lambda a: round(a * opacity))
        canvas = Image.alpha_composite(canvas, tint_layer(size, (0, 0, 0), shape))

    # Place the window itself with clean straight-alpha clipping.
    win = Image.new("RGBA", size, (0, 0, 0, 0))
    clipped = shot.copy()
    clipped.putalpha(mask)
    win.paste(clipped, (MARGIN_X, MARGIN_TOP))
    canvas = Image.alpha_composite(canvas, win)

    # Hairline rim: subtle dark outside light windows, subtle specular white on dark windows.
    outer = Image.new("L", size, 0)
    outer.paste(mask.filter(ImageFilter.MaxFilter(3)), (MARGIN_X, MARGIN_TOP))
    inner = Image.new("L", size, 0)
    inner.paste(mask, (MARGIN_X, MARGIN_TOP))
    if dark:
        core = Image.new("L", size, 0)
        core.paste(mask.filter(ImageFilter.MinFilter(3)), (MARGIN_X, MARGIN_TOP))
        spec = ImageChops.subtract(inner, core).point(lambda a: round(a * 0.16))
        canvas = Image.alpha_composite(canvas, tint_layer(size, (255, 255, 255), spec))
    else:
        rim = ImageChops.subtract(outer, inner).point(lambda a: round(a * 0.15))
        canvas = Image.alpha_composite(canvas, tint_layer(size, (0, 0, 0), rim))

    out = canvas.resize((OUT_WIDTH, round(canvas.height * OUT_WIDTH / canvas.width)), Image.LANCZOS)
    OUT.mkdir(parents=True, exist_ok=True)
    out.save(OUT / f"{name}.png", optimize=True)
    print(f"assets/promo/{name}.png  {out.width}x{out.height}")


for shot in sorted(SHOTS.glob("promo-*.png")):
    frame(shot.stem[len("promo-"):])
