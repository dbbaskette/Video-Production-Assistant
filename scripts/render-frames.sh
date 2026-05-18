#!/usr/bin/env bash
# Rasterize device-frame SVG sources to PNG (full-res frame + thumbnail).
# Reads every *.svg under apps/server/assets/device-frames/sources/ and writes:
#   frames/<name>.png        (full canvas size)
#   thumbnails/<name>.png    (160 px wide, aspect-preserved)
#
# Requires librsvg's rsvg-convert (brew install librsvg).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ASSETS_DIR="$SCRIPT_DIR/../apps/server/assets/device-frames"
SRC_DIR="$ASSETS_DIR/sources"
FRAMES_DIR="$ASSETS_DIR/frames"
THUMBS_DIR="$ASSETS_DIR/thumbnails"

if ! command -v rsvg-convert >/dev/null 2>&1; then
  echo "Error: rsvg-convert not found. Install with: brew install librsvg" >&2
  exit 1
fi

mkdir -p "$FRAMES_DIR" "$THUMBS_DIR"

count=0
for svg in "$SRC_DIR"/*.svg; do
  [ -e "$svg" ] || continue
  name="$(basename "$svg" .svg)"
  rsvg-convert "$svg" -o "$FRAMES_DIR/$name.png"
  rsvg-convert "$svg" --width 160 --keep-aspect-ratio -o "$THUMBS_DIR/$name.png"
  echo "rendered $name"
  count=$((count + 1))
done

echo "done — $count frames"
