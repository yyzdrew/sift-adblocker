#!/usr/bin/env python3
"""Generate the extension's icon set.

A shield with a diagonal bar through it, drawn at 8x and downsampled so the
edges stay clean at 16px. Kept as a script rather than checked-in binaries that
nobody can regenerate.

Usage:
    py tools/build_icons.py
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "extension" / "icons"

SIZES = [16, 32, 48, 128]
SS = 8  # supersampling factor

ACCENT = (63, 111, 216, 255)
ACCENT_DEEP = (46, 86, 176, 255)
BAR = (255, 255, 255, 255)


def shield_polygon(w: int, h: int) -> list[tuple[float, float]]:
    """A rounded shield outline sized to the canvas."""
    pad = w * 0.10
    top = pad
    left = pad
    right = w - pad
    shoulder = h * 0.52
    tip = h - pad

    pts: list[tuple[float, float]] = [
        (left, top),
        (right, top),
        (right, shoulder),
    ]
    # Curve from the right shoulder down to the tip.
    steps = 28
    for i in range(steps + 1):
        t = i / steps
        # Quadratic bezier: shoulder -> control -> tip
        cx, cy = right, tip
        x = (1 - t) ** 2 * right + 2 * (1 - t) * t * cx + t**2 * (w / 2)
        y = (1 - t) ** 2 * shoulder + 2 * (1 - t) * t * cy + t**2 * tip
        pts.append((x, y))
    # Mirror back up the left side.
    for i in range(steps + 1):
        t = 1 - i / steps
        cx, cy = left, tip
        x = (1 - t) ** 2 * left + 2 * (1 - t) * t * cx + t**2 * (w / 2)
        y = (1 - t) ** 2 * shoulder + 2 * (1 - t) * t * cy + t**2 * tip
        pts.append((x, y))
    pts.append((left, shoulder))
    return pts


def draw_icon(size: int) -> Image.Image:
    big = size * SS
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Two-tone fill: draw both halves on a full canvas, then clip to the shield
    # so the split follows the outline instead of cutting across it.
    fill = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    fd = ImageDraw.Draw(fill)
    fd.rectangle([0, 0, big // 2, big], fill=ACCENT)
    fd.rectangle([big // 2, 0, big, big], fill=ACCENT_DEEP)

    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).polygon(shield_polygon(big, big), fill=255)

    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    img.paste(fill, (0, 0), mask)
    d = ImageDraw.Draw(img)

    # The blocking bar.
    bar_w = max(2, int(big * 0.11))
    d.line(
        [(big * 0.30, big * 0.63), (big * 0.70, big * 0.27)],
        fill=BAR,
        width=bar_w,
    )

    return img.resize((size, size), Image.LANCZOS)


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        path = OUT_DIR / f"icon-{size}.png"
        draw_icon(size).save(path, "PNG", optimize=True)
        print(f"  wrote {path.relative_to(ROOT)}")
    print(f"Generated {len(SIZES)} icons in {OUT_DIR.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
