#!/usr/bin/env python3
"""
Build a monochrome menu-bar tray icon from a colored source icon.

macOS expects tray icons to be "template images" — pure black on a
transparent background — so the OS can tint them for the active menu
bar (light / dark / vibrant). We derive alpha from darkness: dark
pixels of the source become opaque black, light pixels become
transparent.

Usage: make-tray-icon.py <source.png> <output.png> [size]
"""

import sys
from pathlib import Path

from PIL import Image


DEFAULT_SIZE = 44  # @2x of a 22pt menu bar — sharp on Retina


def main() -> int:
    if len(sys.argv) not in (3, 4):
        print(f"usage: {sys.argv[0]} <source.png> <output.png> [size]",
              file=sys.stderr)
        return 2

    src_path = Path(sys.argv[1]).expanduser().resolve()
    out_path = Path(sys.argv[2]).expanduser().resolve()
    size = int(sys.argv[3]) if len(sys.argv) == 4 else DEFAULT_SIZE

    if not src_path.is_file():
        print(f"error: source file not found: {src_path}", file=sys.stderr)
        return 1

    src = Image.open(src_path).convert("RGBA")
    rgb = src.convert("RGB")
    luminance = rgb.convert("L")

    # alpha = 255 - luminance: dark pixels => opaque, light pixels => transparent
    alpha = luminance.point(lambda v: 255 - v)
    black = Image.new("L", src.size, 0)
    template = Image.merge("RGBA", (black, black, black, alpha))

    template = template.resize((size, size), Image.LANCZOS)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    template.save(out_path, "PNG")
    print(f"wrote {out_path} ({size}x{size}, template image)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
