#!/usr/bin/env python3
"""Regenerate the NonSlop extension icons.

The mark is a trash can with a play triangle punched out of it — "throw this
video away" — matching the 🗑️ motif the extension's own UI already uses.

Everything is drawn once at 1024px and downsampled with LANCZOS, which keeps
the 16px toolbar icon from turning to mush. Shapes are deliberately chunky
for the same reason: thin strokes and fine detail disappear at that size.

    pip install Pillow
    python3 tools/make_icons.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

SIZES = (16, 48, 128)
CANVAS = 1024
RED = (255, 78, 69, 255)  # #ff4e45, the accent used throughout the UI
WHITE = (255, 255, 255, 255)

OUT_DIR = Path(__file__).resolve().parent.parent / "extension" / "icons"


def draw_icon() -> Image.Image:
    img = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Rounded-square field.
    d.rounded_rectangle([0, 0, CANVAS - 1, CANVAS - 1], radius=int(CANVAS * 0.22), fill=RED)

    # Trash can: lid handle, lid, then a slightly tapered body.
    d.rounded_rectangle([430, 196, 594, 258], radius=26, fill=WHITE)
    d.rounded_rectangle([256, 274, 768, 366], radius=40, fill=WHITE)
    d.polygon([(326, 400), (698, 400), (664, 828), (360, 828)], fill=WHITE)

    # Play triangle knocked out of the body in the background colour.
    d.polygon([(452, 500), (452, 726), (630, 613)], fill=RED)

    return img


def main() -> None:
    icon = draw_icon()
    for size in SIZES:
        path = OUT_DIR / f"icon{size}.png"
        icon.resize((size, size), Image.LANCZOS).save(path)
        print(f"wrote {path.relative_to(OUT_DIR.parent.parent)}")


if __name__ == "__main__":
    main()
