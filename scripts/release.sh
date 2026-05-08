#!/usr/bin/env bash
#
# Builds Typeset, code-signs the .app (Developer ID if available, ad-hoc
# otherwise), wraps it for the Tauri auto-updater, and publishes a tagged
# release on GitHub via the gh CLI.
#
# We deliberately build into /tmp (via CARGO_TARGET_DIR) instead of the
# in-tree `src-tauri/target` directory because the project lives under
# ~/Desktop, which on most modern Macs is iCloud-synced. iCloud Drive
# continuously re-stamps files inside synced folders with metadata xattrs
# (`com.apple.FinderInfo`, `com.apple.metadata:_kMDItemUserTags`, etc.),
# which `codesign --verify --strict` refuses to ignore. Moving the bundle
# out of iCloud's reach makes signing deterministic.
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
#     `npm install --package-lock-only` to update the lockfile, commit, push.
#   - Run this script: `bash scripts/release.sh`

set -euo pipefail

REPO="amagarian/typeset"
KEY_PATH="$HOME/.tauri/typeset.key"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

VERSION=$(python3 -c "import json; print(json.load(open('src-tauri/tauri.conf.json'))['version'])")
TAG="v${VERSION}"

echo "==> Releasing Typeset ${TAG}"

# --- Out-of-iCloud build location ---------------------------------------
# Anything under /tmp is on a tmpfs/local volume and not synced anywhere,
# so xattrs and resource forks don't get re-added by iCloud or Spotlight
# between codesign passes.
BUILD_DIR="/tmp/typeset-build-$$"
SIGN_STAGE="/tmp/typeset-sign-$$"
mkdir -p "$BUILD_DIR" "$SIGN_STAGE"
trap 'rm -rf "$BUILD_DIR" "$SIGN_STAGE"' EXIT
export CARGO_TARGET_DIR="$BUILD_DIR"

# --- Tauri updater signing key ------------------------------------------
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

# --- Apple code-signing identity (auto-detected) ------------------------
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
  CODESIGN_TARGET="-"
fi

# Eject any stale DMG volumes from prior runs (cover both the new
# 'Typeset' volume name and the legacy 'TYPESET' from <= v0.3.0).
for vol in /Volumes/dmg.* /Volumes/Typeset /Volumes/TYPESET; do
  [ -d "$vol" ] && hdiutil detach "$vol" 2>/dev/null || true
done

# `--bundles app` skips Tauri's bundle_dmg.sh, which is fragile on recent
# macOS (AppleScript / Finder automation in non-interactive shells fails
# with exit 1). We rebuild the DMG ourselves with hdiutil below.
echo "==> Building (npx tauri build --bundles app, output -> $BUILD_DIR)..."
env -u CI npx tauri build --bundles app

BUNDLE_DIR="$BUILD_DIR/release/bundle"
RAW_APP="$BUNDLE_DIR/macos/Typeset.app"

if [ ! -d "$RAW_APP" ]; then
  echo "ERROR: Typeset.app not found at $RAW_APP"
  exit 1
fi

# --- Sign the .app in /tmp ----------------------------------------------
# `ditto --noextattr --noacl --norsrc` copies the bundle without any
# extended attributes, ACLs, or resource forks. Even though the source is
# already in /tmp this is a belt-and-suspenders move.
echo "==> Code-signing in $SIGN_STAGE..."
SIGNED_APP="$SIGN_STAGE/Typeset.app"
ditto --noextattr --noacl --norsrc "$RAW_APP" "$SIGNED_APP"
xattr -cr "$SIGNED_APP"
codesign --force --deep --options runtime --sign "$CODESIGN_TARGET" "$SIGNED_APP"
codesign --verify --deep --strict --verbose=2 "$SIGNED_APP" 2>&1 | tail -5
echo "==> Code-signing OK"

# --- Build the DMG with the signed app ----------------------------------
# Tauri's own bundle_dmg.sh is skipped via --bundles app above (it breaks
# on Sequoia+ in non-interactive shells). We assemble a clean DMG here from
# the signed app plus an /Applications shortcut so users can drag-install.
DMG_STAGE="/tmp/typeset-dmg-$$"
mkdir -p "$DMG_STAGE"
ditto --noextattr --noacl --norsrc "$SIGNED_APP" "$DMG_STAGE/Typeset.app"
ln -s /Applications "$DMG_STAGE/Applications"

DMG="$BUNDLE_DIR/dmg/Typeset_${VERSION}_aarch64.dmg"
mkdir -p "$(dirname "$DMG")"
rm -f "$DMG"
echo "==> Building DMG with signed app..."
hdiutil create \
  -volname "Typeset" \
  -srcfolder "$DMG_STAGE" \
  -fs HFS+ \
  -format UDZO \
  -ov \
  "$DMG" >/dev/null
rm -rf "$DMG_STAGE"

# --- Updater archive (signed app, tar.gz, then minisign signature) ------
echo "==> Creating updater archive from signed app..."
APP_TAR_GZ="$BUNDLE_DIR/macos/Typeset.app.tar.gz"
mkdir -p "$(dirname "$APP_TAR_GZ")"
# Replace the unsigned .app from the original bundle with the signed one
# before tarring so the updater payload is signed.
rm -rf "$RAW_APP"
ditto --noextattr --noacl --norsrc "$SIGNED_APP" "$RAW_APP"
( cd "$BUNDLE_DIR/macos" && COPYFILE_DISABLE=1 tar czf Typeset.app.tar.gz Typeset.app )

# Tauri-sign the updater archive (produces .sig alongside).
npx tauri signer sign "$APP_TAR_GZ"
APP_SIG="${APP_TAR_GZ}.sig"

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
  "notes": "Typeset ${TAG}",
  "pub_date": "${NOW}",
  "platforms": {
    "darwin-aarch64": {
      "signature": "${SIGNATURE}",
      "url": "https://github.com/${REPO}/releases/download/${TAG}/Typeset.app.tar.gz"
    },
    "darwin-x86_64": {
      "signature": "${SIGNATURE}",
      "url": "https://github.com/${REPO}/releases/download/${TAG}/Typeset.app.tar.gz"
    }
  }
}
ENDJSON

echo "==> Created latest.json"
cat /tmp/latest.json

cp "$DMG" /tmp/Typeset.dmg

echo "==> Creating GitHub release ${TAG}..."
gh release create "$TAG" \
  --repo "$REPO" \
  --title "Typeset ${TAG}" \
  --notes "Typeset ${TAG}" \
  "$APP_TAR_GZ" \
  "$APP_SIG" \
  /tmp/latest.json \
  /tmp/Typeset.dmg

# APFS on the data volume is case-insensitive but case-preserving, so
# `cp Typeset.dmg over an existing TYPESET.dmg keeps the old uppercase
# filename. Force-remove any prior case variant before copying so the
# Desktop entry takes the new "Typeset" casing.
rm -f ~/Desktop/Typeset.dmg ~/Desktop/TYPESET.dmg
cp /tmp/Typeset.dmg ~/Desktop/Typeset.dmg

echo ""
echo "==> Release ${TAG} published!"
echo "    https://github.com/${REPO}/releases/tag/${TAG}"
echo "    DMG copied to ~/Desktop/Typeset.dmg"
