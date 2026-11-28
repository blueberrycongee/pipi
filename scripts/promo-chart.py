#!/usr/bin/env python3
"""Draws the duplicate-consumption chart Pip presents in the README's personal-agent shot.

    python3 scripts/promo-chart.py   # rewrites dev/promo-chart.ts

The PNG travels as a base64 `data:` URI inside the scripted session history
(`present_files` media), so no fixture file has to exist on disk when the look
test runs. Needs Pillow (`pip install pillow`).
"""
import base64
import io
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "dev" / "promo-chart.ts"

# Display size in the bubble is 400x150pt; the PNG is drawn at 2x. A wide, short
# card keeps the README's chat shot inside one window height.
W, H = 800, 300
SS = 2  # supersample, then downscale for crisp edges

INK = (32, 34, 40)
SUB = (110, 114, 126)
FAINT = (150, 154, 168)
GRID = (228, 230, 236)
AXIS = (205, 208, 216)
ACCENT = (122, 102, 240)  # pipi brand-ish purple
AMBER = (235, 158, 52)


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    candidates = [
        "/System/Library/Fonts/SFNS.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
    ]
    for path in candidates:
        try:
            return ImageFont.truetype(path, size * SS)
        except OSError:
            continue
    return ImageFont.load_default()


def draw() -> Image.Image:
    img = Image.new("RGBA", (W * SS, H * SS), (255, 255, 255, 0))
    d = ImageDraw.Draw(img)

    f_title = font(14, bold=True)
    f_label = font(10)
    f_small = font(9)

    # Card.
    pad = 26 * SS
    d.rounded_rectangle([pad, pad, W * SS - pad, H * SS - pad], radius=14 * SS, fill=(255, 255, 255, 255), outline=(226, 228, 234, 255), width=SS)

    tx = pad + 22 * SS
    d.text((tx, pad + 14 * SS), "Duplicated deliveries by partition", font=f_title, fill=INK)
    sub = "argus-consumer · 04:10–04:20 · after 0.9.4 rollout"
    d.text((W * SS - pad - 22 * SS - d.textlength(sub, font=f_label), pad + 17 * SS), sub, font=f_label, fill=SUB)

    # Plot geometry.
    plot_l = tx + 16 * SS
    plot_r = W * SS - pad - 26 * SS
    plot_t = pad + 50 * SS
    plot_b = H * SS - pad - 44 * SS

    # Duplicate counts per minute bucket, per partition (partition 2, 5, 7).
    minutes = ["04:12", "04:13", "04:14", "04:15", "04:16", "04:17", "04:18"]
    series = {
        "p2": [1200, 3400, 5100, 4200, 1800, 300, 0],
        "p5": [800, 2600, 3800, 3100, 1400, 200, 0],
        "p7": [0, 900, 1500, 1200, 500, 0, 0],
    }
    colors = {"p2": ACCENT, "p5": AMBER, "p7": (110, 160, 224)}
    ymax = 5600

    # Grid + y labels.
    for frac in (0, 0.5, 1.0):
        y = plot_b - frac * (plot_b - plot_t)
        d.line([(plot_l, y), (plot_r, y)], fill=GRID if frac else AXIS, width=SS)
        label = f"{int(ymax * frac / 1000)}k" if frac else "0"
        lw = d.textlength(label, font=f_small)
        d.text((plot_l - 7 * SS - lw, y - 5 * SS), label, font=f_small, fill=FAINT)

    # Highlight band over the rebalance window (04:13–04:16).
    group_w = (plot_r - plot_l) / len(minutes)
    x0 = plot_l + 1 * group_w
    x1 = plot_l + 4 * group_w
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    od.rectangle([x0, plot_t, x1, plot_b], fill=(122, 102, 240, 22), outline=(122, 102, 240, 90), width=SS)
    img.alpha_composite(overlay)
    label = "rebalance window"
    lw = d.textlength(label, font=f_small)
    d.text(((x0 + x1) / 2 - lw / 2, plot_t - 14 * SS), label, font=f_small, fill=ACCENT)

    # Grouped bars.
    bar_w = group_w * 0.2
    gap = bar_w * 0.18
    for gi, minute in enumerate(minutes):
        gx = plot_l + gi * group_w + group_w * 0.18
        for si, (name, values) in enumerate(series.items()):
            v = values[gi]
            if v <= 0:
                continue
            h = (v / ymax) * (plot_b - plot_t)
            x = gx + si * (bar_w + gap)
            d.rounded_rectangle([x, plot_b - h, x + bar_w, plot_b - 1], radius=3 * SS, fill=colors[name])
        lw = d.textlength(minute, font=f_small)
        d.text((plot_l + gi * group_w + group_w / 2 - lw / 2, plot_b + 7 * SS), minute, font=f_small, fill=FAINT)

    # Legend, right-aligned on the axis line.
    lx = plot_r
    ly = H * SS - pad - 14 * SS
    entries = list(colors.items())
    widths = [d.textlength(f"partition {n} (dup)", font=f_small) for n, _ in entries]
    total = sum(widths) + len(entries) * (10 + 8) * SS + (len(entries) - 1) * 22 * SS
    lx -= total
    for (name, color), lw in zip(entries, widths):
        d.rounded_rectangle([lx, ly - 9 * SS, lx + 9 * SS, ly], radius=2.5 * SS, fill=color)
        d.text((lx + 13 * SS, ly - 10 * SS), f"partition {name} (dup)", font=f_small, fill=SUB)
        lx += lw + (13 + 22) * SS
    return img


def main() -> None:
    img = draw().resize((W, H), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True)
    b64 = base64.b64encode(buf.getvalue()).decode()
    OUT.write_text(
        "// Generated by scripts/promo-chart.py — regenerate with `python3 scripts/promo-chart.py`.\n"
        "// The chart Pip's scripted `present_files` call carries into the README shot.\n"
        f'export const PROMO_CHART_DATA_URI = "data:image/png;base64,{b64}";\n'
        f"export const PROMO_CHART_WIDTH = {W // 2};\n"
        f"export const PROMO_CHART_HEIGHT = {H // 2};\n"
    )
    print(f"{OUT}  ({len(buf.getvalue())} bytes png, {len(b64)} chars b64)")


if __name__ == "__main__":
    main()
