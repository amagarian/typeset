#!/usr/bin/env bash
#
# Builds TYPESET, code-signs the .app (Developer ID if available, ad-hoc
# otherwise), wraps it for the Tauri auto-updater, and publishes a tagged
# release on GitHub via the gh CLI.
#
# Prerequisites (one-time):
#   1. Tauri minisign signing key at ~/.tauri/typeset.key (no password):
#        npx tauri signer generate -p "" -w ~/.tauri/typeset.key
#      The matching pubkey must already be in src-tauri/tauri.conf.json.
#   2. gh CLI authenticated:
#        brew install gh && gh auth login
#   3. Optional: Developer ID Application cert imported into the login
#      keychain (otherwise the app is ad-hoc signed — fine for personal
#      installs, not Gatekeeper-distributable to other Macs).
#
# Per-release steps:
#   - Bump `version` in src-tauri/tauri.conf.json + package.json + run
#     `npm install --package-lock-only` to update the lockfile.
#   - Run this script: `bash scripts/release.sh`
#
# The script tags off the version string in tauri.conf.json — make sure
# you've committed the version bump so the tag points at a real commit.

set -euo pipefail

REPO="amagarian/typeset"
KEY_PATH="$HOME/.tauri/typeset.key"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

VERSION=$(python3 -c "import json; print(json.load(open('src-tauri/tauri.conf.json'))['version'])")
TAG="v${VERSION}"

echo "==> Releasing TYPESET ${TAG}"

# --- Tauri updater signing key ---
if [ ! -f "$KEY_PATH" ]; then
  echo "ERROR: Tauri signing key not found at $KEY_PATH"
  echo "Generate one with: npx tauri signer generate -p '' -w $KEY_PATH"
  echo "Then update tauri.conf.json's plugins.updater.pubkey to the contents of"
  echo "$KEY_PATH.pub before re-running this script."
  exit 1
fi

export TAURI_SIGNING_PRIVATE_KEY
TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY_PATH")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""

# --- Apple code-signing identity (auto-detected) ---
# Override with `TYPESET_APPLE_SIGNING_IDENTITY="..."` when you want to force
# a specific identity (e.g. on a CI runner with multiple certs installed).
APPLE_SIGNING_IDENTITY="${TYPESET_APPLE_SIGNING_IDENTITY:-}"
if [ -z "$APPLE_SIGNING_IDENTITY" ]; then
  APPLE_SIGNING_IDENTITY=$(security find-identity -p codesigning -v 2>/dev/null \
    | grep "Developer ID Application" \
    | head -1 \
    | sed -E 's/.*"(.+)".*/\1/' \
    || true)
fi

if [ -n "$APPLE_SIGNING_IDENTITY" ]; then
  echo "==> Apple code-signing with: $APPLE_SIGNING_IDENTITY"
  CODESIGN_TARGET="$APPLE_SIGNING_IDENTITY"
else
  echo "==> No 'Developer ID Application' cert found — using ad-hoc signing."
  echo "    The app will install on your Mac (right-click → Open the first time"
  echo "    to clear Gatekeeper) but isn't distributable to other Macs without"
  echo "    a Developer ID + notarization."
  CODESIGN_TARGET="-"
fi

# Eject any stale DMG volumes from prior runs
for vol in /Volumes/dmg.*; do
  [ -d "$vol" ] && hdiutil detach "$vol" 2>/dev/null || true
done

echo "==> Building (npx tauri build)…"
env -u CI npx tauri build

BUNDLE_DIR="$PROJECT_DIR/src-tauri/target/release/bundle"
APP_DIR="$BUNDLE_DIR/macos/TYPESET.app"
DMG="$BUNDLE_DIR/dmg/TYPESET_${VERSION}_aarch64.dmg"

if [ ! -d "$APP_DIR" ]; then
  echo "ERROR: TYPESET.app not found at $APP_DIR"
  exit 1
fi

echo "==> Stripping macOS extended attributes & signing…"
# `xattr -cr` clears every extended attribute recursively. tauri's bundler
# leaves provenance xattrs that break codesign, so this scrub is required.
xattr -cr "$APP_DIR"
codesign --force --deep --sign "$CODESIGN_TARGET" "$APP_DIR"
codesign --verify --deep --strict --verbose=2 "$APP_DIR" || {
  echo "ERROR: codesign verify failed."
  exit 1
}
echo "==> Code-signing OK"

# Recreate the updater tar.gz from the freshly signed app
echo "==> Creating updater archive…"
cd "$BUNDLE_DIR/macos"
COPYFILE_DISABLE=1 tar czf TYPESET.app.tar.gz TYPESET.app
cd "$PROJECT_DIR"

# Tauri-sign the updater archive (produces .sig alongside)
npx tauri signer sign "$BUNDLE_DIR/macos/TYPESET.app.tar.gz"

APP_TAR_GZ="$BUNDLE_DIR/macos/TYPESET.app.tar.gz"
APP_SIG="$BUNDLE_DIR/macos/TYPESET.app.tar.gz.sig"

for f in "$APP_TAR_GZ" "$APP_SIG" "$DMG"; do
  if [ ! -f "$f" ]; then
    echo "ERROR: Expected artifact not found: $f"
    exit 1
  fi
done

echo "==> Found build artifacts"

SIGNATURE=$(cat "$APP_SIG")
NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

cat > /tmp/latest.json <<ENDJSON
{
  "version": "${VERSION}",
  "notes": "TYPESET ${TAG}",
  "pub_date": "${NOW}",
  "platforms": {
    "darwin-aarch64": {
      "signature": "${SIGNATURE}",
      "url": "https://github.com/${REPO}/releases/download/${TAG}/TYPESET.app.tar.gz"
    },
    "darwin-x86_64": {
      "signature": "${SIGNATURE}",
      "url": "https://github.com/${REPO}/releases/download/${TAG}/TYPESET.app.tar.gz"
    }
  }
}
ENDJSON

echo "==> Created latest.json"
cat /tmp/latest.json

cp "$DMG" /tmp/TYPESET.dmg

echo "==> Creating GitHub release ${TAG}…"
gh release create "$TAG" \
  --repo "$REPO" \
  --title "TYPESET ${TAG}" \
  --notes "TYPESET ${TAG}" \
  "$APP_TAR_GZ" \
  "$APP_SIG" \
  /tmp/latest.json \
  /tmp/TYPESET.dmg

cp /tmp/TYPESET.dmg ~/Desktop/TYPESET.dmg

echo ""
echo "==> Release ${TAG} published!"
echo "    https://github.com/${REPO}/releases/tag/${TAG}"
echo "    DMG copied to ~/Desktop/TYPESET.dmg"
