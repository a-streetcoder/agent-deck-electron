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

echo "Release validation passed: $DMG_PATH"
