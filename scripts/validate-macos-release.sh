#!/usr/bin/env bash
set -euo pipefail

DMG_PATH="${1:-}"
if [[ -z "$DMG_PATH" || ! -f "$DMG_PATH" ]]; then
  echo "Usage: pnpm validate:mac -- /absolute/path/to/Agent-Deck.dmg" >&2
  exit 64
fi

DMG_PATH="$(cd "$(dirname "$DMG_PATH")" && pwd)/$(basename "$DMG_PATH")"
MOUNT_POINT="$(mktemp -d "${TMPDIR:-/tmp}/agent-deck-dmg.XXXXXX")"
mounted=0

cleanup() {
  if [[ "$mounted" == "1" ]]; then
    hdiutil detach "$MOUNT_POINT" -quiet || true
  fi
  rmdir "$MOUNT_POINT" 2>/dev/null || true
}
trap cleanup EXIT

echo "Verifying DMG structure"
hdiutil verify "$DMG_PATH"

echo "Validating stapled DMG ticket"
xcrun stapler validate "$DMG_PATH"

echo "Assessing DMG with Gatekeeper"
spctl --assess --type open --context context:primary-signature --verbose=4 "$DMG_PATH"

hdiutil attach "$DMG_PATH" -nobrowse -readonly -mountpoint "$MOUNT_POINT" -quiet
mounted=1
APP_PATH="$MOUNT_POINT/Agent Deck.app"
if [[ ! -d "$APP_PATH" ]]; then
  echo "Agent Deck.app is missing from the DMG" >&2
  exit 1
fi

echo "Verifying nested application signatures"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"

echo "Assessing application with Gatekeeper"
spctl --assess --type execute --verbose=4 "$APP_PATH"

echo "Validating stapled application ticket"
xcrun stapler validate "$APP_PATH"

shopt -s nullglob
ADDONS=("$APP_PATH"/Contents/Resources/loop-catalog-native/loop-catalog-native.darwin-*.node)
if [[ "${#ADDONS[@]}" != "1" ]]; then
  echo "Expected exactly one architecture-matched native Loop catalog addon" >&2
  exit 1
fi
ADDON_PATH="${ADDONS[0]}"
case "$ADDON_PATH" in
  *.darwin-arm64.node) ADDON_ARCH=arm64; RUNTIME_ARCH=arm64 ;;
  *.darwin-x64.node) ADDON_ARCH=x86_64; RUNTIME_ARCH=x64 ;;
  *) echo "Unexpected native Loop addon filename" >&2; exit 1 ;;
esac
echo "Verifying native Loop addon architecture and signature"
lipo "$ADDON_PATH" -verify_arch "$ADDON_ARCH"
codesign --verify --strict --verbose=2 "$ADDON_PATH"

echo "Running packaged Electron Loop HTTP CRUD and containment smoke"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node "$SCRIPT_DIR/smoke-packaged-loop-catalog.mjs" "$APP_PATH" darwin "$RUNTIME_ARCH"

echo "Release validation passed: $DMG_PATH"
