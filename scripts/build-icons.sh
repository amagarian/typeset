#!/usr/bin/env bash
#
# Regenerate every Typeset app icon from the two source PNGs:
#   src-tauri/icons/source/typeset_light.png  (black-on-cream)
#   src-tauri/icons/source/typeset_dark.png   (cream-on-black)
#
# Outputs:
#   1. src-tauri/icons/AppIcon.xcassets/AppIcon.appiconset/
#        - icon_<size>.png  (light, default appearance)
#        - icon_<size>_dark.png  (dark, luminosity=dark appearance)
#        - Contents.json  (10 size×scale combos × 2 appearance variants)
#   2. Legacy fallback icons used by Tauri's bundle.icon array, all
#      regenerated from the LIGHT squircle variant via `npx tauri icon`:
#        - src-tauri/icons/icon.icns
#        - src-tauri/icons/icon.ico
#        - src-tauri/icons/icon.png
#        - src-tauri/icons/{32x32,128x128,128x128@2x}.png
#        - Windows StoreLogo / Square*Logo.png + iOS / Android variants
#
# Squircle pre-processing happens once per variant via scripts/make-squircle.py
# (Pillow). Per-size downsizing uses macOS's built-in `sips` so we don't need
# ImageMagick at build time.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ICONS_DIR="$PROJECT_DIR/src-tauri/icons"
SOURCE_DIR="$ICONS_DIR/source"
LIGHT_SRC="$SOURCE_DIR/typeset_light.png"
DARK_SRC="$SOURCE_DIR/typeset_dark.png"
APPICON_SET="$ICONS_DIR/AppIcon.xcassets/AppIcon.appiconset"
SQUIRCLE_SCRIPT="$SCRIPT_DIR/make-squircle.py"

if [ ! -f "$LIGHT_SRC" ] || [ ! -f "$DARK_SRC" ]; then
  echo "ERROR: Source icons not found in $SOURCE_DIR" >&2
  echo "  expected: typeset_light.png, typeset_dark.png" >&2
  exit 1
fi

if ! command -v sips >/dev/null 2>&1; then
  echo "ERROR: sips is required (macOS built-in tool)" >&2
  exit 1
fi

mkdir -p "$APPICON_SET"

# --- Phase 1: squircle-mask each source at 1024×1024 --------------------
LIGHT_SQUIRCLE="$SOURCE_DIR/typeset_light_squircle.png"
DARK_SQUIRCLE="$SOURCE_DIR/typeset_dark_squircle.png"

echo "==> Squircle-masking light variant -> $LIGHT_SQUIRCLE"
python3 "$SQUIRCLE_SCRIPT" "$LIGHT_SRC" "$LIGHT_SQUIRCLE"
echo "==> Squircle-masking dark variant  -> $DARK_SQUIRCLE"
python3 "$SQUIRCLE_SCRIPT" "$DARK_SRC" "$DARK_SQUIRCLE"

# --- Phase 2: emit per-size PNGs into the .appiconset --------------------
# size_name <- the "size" the appiconset entry uses
# pixel_size <- actual width=height of the rasterized PNG
# scale <- "1x" / "2x"
#
# Order matters only for legibility; actool reads Contents.json, not file order.
APPICON_SIZES=(
  "16x16  16  1x"
  "16x16  32  2x"
  "32x32  32  1x"
  "32x32  64  2x"
  "128x128 128 1x"
  "128x128 256 2x"
  "256x256 256 1x"
  "256x256 512 2x"
  "512x512 512 1x"
  "512x512 1024 2x"
)

resize_to() {
  # resize_to <src> <pixels> <dst>
  local src="$1" px="$2" dst="$3"
  sips --setProperty format png \
       --resampleHeightWidth "$px" "$px" \
       "$src" --out "$dst" >/dev/null
}

filename_for() {
  # filename_for <size_name> <scale> <variant_suffix>
  # variant_suffix is "" for light, "_dark" for dark.
  local size="$1" scale="$2" suffix="$3"
  if [ "$scale" = "1x" ]; then
    echo "icon_${size}${suffix}.png"
  else
    echo "icon_${size}@${scale}${suffix}.png"
  fi
}

echo "==> Generating per-size PNGs in $APPICON_SET"
for entry in "${APPICON_SIZES[@]}"; do
  read -r size_name pixel_size scale <<<"$entry"
  light_name="$(filename_for "$size_name" "$scale" "")"
  dark_name="$(filename_for "$size_name" "$scale" "_dark")"
  resize_to "$LIGHT_SQUIRCLE" "$pixel_size" "$APPICON_SET/$light_name"
  resize_to "$DARK_SQUIRCLE"  "$pixel_size" "$APPICON_SET/$dark_name"
done

# --- Phase 3: write Contents.json ---------------------------------------
echo "==> Writing $APPICON_SET/Contents.json"
python3 - "$APPICON_SET/Contents.json" <<'PYEOF'
import json
import sys

OUT = sys.argv[1]

SIZES = [
    ("16x16",   "1x"),
    ("16x16",   "2x"),
    ("32x32",   "1x"),
    ("32x32",   "2x"),
    ("128x128", "1x"),
    ("128x128", "2x"),
    ("256x256", "1x"),
    ("256x256", "2x"),
    ("512x512", "1x"),
    ("512x512", "2x"),
]


def filename(size: str, scale: str, dark: bool) -> str:
    suffix = "_dark" if dark else ""
    if scale == "1x":
        return f"icon_{size}{suffix}.png"
    return f"icon_{size}@{scale}{suffix}.png"


images = []
for size, scale in SIZES:
    images.append({
        "idiom": "mac",
        "scale": scale,
        "size": size,
        "filename": filename(size, scale, dark=False),
    })
    images.append({
        "idiom": "mac",
        "scale": scale,
        "size": size,
        "filename": filename(size, scale, dark=True),
        "appearances": [
            {"appearance": "luminosity", "value": "dark"}
        ],
    })

contents = {
    "images": images,
    "info": {"author": "xcode", "version": 1},
}

with open(OUT, "w", encoding="utf-8") as fh:
    json.dump(contents, fh, indent=2)
    fh.write("\n")

print(f"wrote {OUT} with {len(images)} image entries")
PYEOF

# --- Phase 4: regenerate legacy fallback icons via tauri icon -----------
# `npx tauri icon` rebuilds .icns / .ico / per-platform PNGs from a single
# 1024×1024 source. We feed it the LIGHT squircle so systems that ignore
# the Asset Catalog (older macOS, Windows, Linux, iOS, Android) still get a
# reasonable-looking icon.
echo "==> Rebuilding legacy fallback icons from light squircle..."
( cd "$PROJECT_DIR" && npx tauri icon "$LIGHT_SQUIRCLE" --output src-tauri/icons )

echo ""
echo "==> Done."
echo "    AppIcon.appiconset:    $APPICON_SET"
echo "    Light squircle source: $LIGHT_SQUIRCLE"
echo "    Dark squircle source:  $DARK_SQUIRCLE"
