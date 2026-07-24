#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="$ROOT_DIR/build/icon-source.png"
ICONSET="$(mktemp -d)/AgentDeck.iconset"

cleanup() {
  rm -rf "$(dirname "$ICONSET")"
}
trap cleanup EXIT

if ! command -v magick >/dev/null 2>&1; then
  echo "ImageMagick is required (brew install imagemagick)." >&2
  exit 1
fi
if ! command -v iconutil >/dev/null 2>&1; then
  echo "iconutil is required and is available on macOS." >&2
  exit 1
fi

mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  magick "$SOURCE" -filter Lanczos -resize "${size}x${size}" "$ICONSET/icon_${size}x${size}.png"
  double=$((size * 2))
  magick "$SOURCE" -filter Lanczos -resize "${double}x${double}" "$ICONSET/icon_${size}x${size}@2x.png"
done

cp "$SOURCE" "$ROOT_DIR/build/icon.png"
magick "$SOURCE" -define icon:auto-resize=256,128,64,48,32,24,16 "$ROOT_DIR/build/icon.ico"
iconutil --convert icns --output "$ROOT_DIR/build/icon.icns" "$ICONSET"

echo "Generated macOS, Windows, and Linux icons from build/icon-source.png"
