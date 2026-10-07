#!/usr/bin/env bash
#
# Builds "Install Eaon Beta" for macOS: an app, in a signed and notarized disk
# image, that puts this build's Eaon in place of the Eaon already on the Mac
# (found, quit, replaced, reopened) without anyone uninstalling it first. The
# installer's code is scripts/mac-installer/main.swift.
#
# An app rather than a .pkg because a .pkg needs a "Developer ID Installer"
# certificate, and Eaon's team only has "Developer ID Application".
#
# Run after ./scripts/release-mac.sh, whose signed and notarized Eaon.app it
# embeds. Notarization uses the same keychain entry as that script.
#
# Usage:
#   ./scripts/build-mac-installer.sh                 # dist/installer/Install-Eaon-<version>.dmg
#   ./scripts/build-mac-installer.sh --no-notarize   # signed only, for trying it out locally
#   ./scripts/build-mac-installer.sh --app <path>    # embed another Eaon.app

set -euo pipefail
cd "$(dirname "$0")/.."

CRED_SERVICE="eaon-notarize"
TEAM_ID="W9MHT9V982"
NAME="Install Eaon Beta"
APP="dist/mac-universal/Eaon.app"
NOTARIZE=1

while [ $# -gt 0 ]; do
  case "$1" in
    --no-notarize) NOTARIZE=0 ;;
    --app) APP="$2"; shift ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

[ -d "$APP" ] || { echo "error: no $APP — run ./scripts/release-mac.sh first." >&2; exit 1; }
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
IDENTITY="$(security find-identity -v -p codesigning | awk -v team="($TEAM_ID)" '/Developer ID Application/ && index($0, team) {print $2; exit}')"
[ -n "$IDENTITY" ] || { echo "error: no Developer ID Application certificate for team $TEAM_ID in the keychain." >&2; exit 1; }

OUT="dist/installer"
BUNDLE="$OUT/$NAME.app"
DMG="$OUT/Install-Eaon-$VERSION.dmg"
rm -rf "$OUT"
mkdir -p "$BUNDLE/Contents/MacOS" "$BUNDLE/Contents/Resources"

echo "== Building $NAME for Eaon $VERSION =="
for arch in arm64 x86_64; do
  # No back-deployment shims: the Command Line Tools ship them for arm64 only,
  # and the installer uses nothing they provide.
  swiftc -O -swift-version 5 -runtime-compatibility-version none -target "$arch-apple-macos12.0" -o "$OUT/installer-$arch" scripts/mac-installer/main.swift
done
lipo -create -output "$BUNDLE/Contents/MacOS/$NAME" "$OUT/installer-arm64" "$OUT/installer-x86_64"
rm "$OUT/installer-arm64" "$OUT/installer-x86_64"

cat > "$BUNDLE/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>dev.eaon.desktop.beta-installer</string>
  <key>CFBundleName</key><string>$NAME</string>
  <key>CFBundleDisplayName</key><string>$NAME</string>
  <key>CFBundleExecutable</key><string>$NAME</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST
cp resources/icon.icns "$BUNDLE/Contents/Resources/AppIcon.icns"
# Eaon goes in as it was signed and notarized; the installer checks its signature before using it.
ditto "$APP" "$BUNDLE/Contents/Resources/Eaon.app"

codesign --force --options runtime --timestamp --sign "$IDENTITY" "$BUNDLE"
codesign --verify --deep --strict "$BUNDLE"

STAGE="$OUT/stage"
mkdir -p "$STAGE"
ditto "$BUNDLE" "$STAGE/$NAME.app"
hdiutil create -quiet -volname "$NAME" -srcfolder "$STAGE" -format UDZO -ov "$DMG"
rm -rf "$STAGE"
codesign --force --sign "$IDENTITY" --timestamp "$DMG"

if [ "$NOTARIZE" = 1 ]; then
  APPLE_ID="$(security find-generic-password -s "$CRED_SERVICE" 2>/dev/null | awk -F'"' '/"acct"/ {print $4}')"
  APPLE_APP_SPECIFIC_PASSWORD="$(security find-generic-password -s "$CRED_SERVICE" -w 2>/dev/null)"
  [ -n "$APPLE_ID" ] && [ -n "$APPLE_APP_SPECIFIC_PASSWORD" ] || { echo "error: no '$CRED_SERVICE' keychain entry (see release-mac.sh)." >&2; exit 1; }
  echo "== Notarizing $DMG =="
  RESULT="$(xcrun notarytool submit "$DMG" --apple-id "$APPLE_ID" --team-id "$TEAM_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --wait 2>&1)"
  echo "$RESULT" | tail -3
  echo "$RESULT" | grep -q "status: Accepted" || { echo "error: notarization was not accepted." >&2; exit 1; }
  xcrun stapler staple "$DMG"
fi

echo
echo "== Verification =="
echo "  architectures: $(lipo -archs "$BUNDLE/Contents/MacOS/$NAME")"
echo "  embedded Eaon: $VERSION"
spctl -a -vvv -t open --context context:primary-signature "$DMG" 2>&1 | sed 's/^/  dmg: /' || true
echo "  sha256: $(shasum -a 256 "$DMG" | awk '{print $1}')"
