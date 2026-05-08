#!/usr/bin/env python3
"""
Apply an Apple-style squircle mask to a square source image and emit a
1024x1024 RGBA PNG suitable for `npx tauri icon`.

Apple's app icon shape is a superellipse with continuous (G2) corners,
not a simple rounded rectangle. We approximate it with the standard
parametrization

    x(t) = sign(cos t) * |cos t|^(2/n)
    y(t) = sign(sin t) * |sin t|^(2/n)

with n ~ 5, which matches macOS Big Sur / Sequoia app icons closely.
The mask is rasterized at 4x and downsampled with Lanczos for
anti-aliased edges.
"""

import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw

SIZE = 1024            # final icon size
SCALE = 4              # supersampling factor for AA edges
N = 5.0                # squircle exponent (5 ~ Apple's app icon)
SAMPLES = 2048         # polygon points around the squircle


def squircle_mask(size: int, scale: int, n: float, samples: int) -> Image.Image:
    """Build an L-mode alpha mask of the squircle, supersampled then downsized."""
    big_size = size * scale
    pts = []
    for i in range(samples):
        theta = 2 * math.pi * i / samples
        c, s = math.cos(theta), math.sin(theta)
        px = math.copysign(abs(c) ** (2.0 / n), c)
        py = math.copysign(abs(s) ** (2.0 / n), s)
        pts.append((
            (px + 1.0) / 2.0 * big_size,
            (py + 1.0) / 2.0 * big_size,
        ))
    big = Image.new("L", (big_size, big_size), 0)
    ImageDraw.Draw(big).polygon(pts, fill=255)
    return big.resize((size, size), Image.LANCZOS)


def main() -> int:
    if len(sys.argv) != 3:
        print(f"usage: {sys.argv[0]} <input.png> <output.png>", file=sys.stderr)
        return 2

    src_path = Path(sys.argv[1]).expanduser().resolve()
    out_path = Path(sys.argv[2]).expanduser().resolve()

    if not src_path.is_file():
        print(f"error: source file not found: {src_path}", file=sys.stderr)
        return 1

    src = Image.open(src_path).convert("RGBA")
    if src.size != (SIZE, SIZE):
        src = src.resize((SIZE, SIZE), Image.LANCZOS)

    mask = squircle_mask(SIZE, SCALE, N, SAMPLES)

    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    canvas.paste(src, (0, 0), mask)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out_path, "PNG")
    print(f"wrote {out_path} ({SIZE}x{SIZE})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
