#!/bin/bash
# Builds the distributable release: a universal (Apple Silicon + Intel)
# Eaon.app, packaged two ways:
#   dist/Eaon-<version>.dmg — drag-to-Applications installer, for first-time
#     downloads from the website.
#   dist/Eaon-<version>.zip — what the in-app self-updater (UpdateChecker +
#     SelfUpdateInstaller) downloads and swaps in for existing installs.
#     Must keep the .app as its top-level entry (ditto's --keepParent) since
#     SelfUpdateInstaller looks for exactly that after extracting.
#
# Signing reality, stated plainly: this ad-hoc signs the app (required for
# it to run at all on Apple Silicon). It does NOT Developer ID-sign or
# notarize — that needs a paid Apple Developer account. Until then, people
# who download the .dmg will see Gatekeeper's "unidentified developer"
# warning and must right-click the app → Open the first time. (The .zip
# path, once already installed, doesn't hit that prompt again — the app's
# own downloader doesn't set the quarantine flag a browser download does.)
set -euo pipefail
cd "$(dirname "$0")"

VERSION=$(sed -nE 's/.*static let current = "([^"]+)".*/\1/p' Eaon-desktop/Services/UpdateChecker.swift)
if [[ -z "$VERSION" ]]; then
  echo "Could not read AppVersion.current from UpdateChecker.swift" >&2
  exit 1
fi

echo "== Building Eaon CLI (bundled for in-app install)…"
# Built in an isolated staging copy — never touches eaon-cli/node_modules,
# which is the developer's own dev environment (tsx/typescript included) and
# would break if pruned to production-only deps here.
CLI_STAGE=$(mktemp -d)
mkdir -p "$CLI_STAGE"
cp -R eaon-cli/src eaon-cli/package.json eaon-cli/package-lock.json eaon-cli/tsconfig.json "$CLI_STAGE/"
(cd "$CLI_STAGE" && npm ci && npm run build && npm prune --omit=dev)

echo "== Building Eaon $VERSION (universal release: arm64 + x86_64)…"
swift build -c release --arch arm64 --arch x86_64

PRODUCTS=".build/apple/Products/Release"
APP="dist/Eaon.app"
rm -rf dist
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

echo "== Bundling Eaon CLI into ${APP}…"
mkdir -p "$APP/Contents/Resources/eaon-cli"
cp -R "$CLI_STAGE/dist" "$CLI_STAGE/node_modules" "$CLI_STAGE/package.json" "$APP/Contents/Resources/eaon-cli/"
rm -rf "$CLI_STAGE"

echo "== Assembling ${APP}…"
cp "$PRODUCTS/Eaon-desktop" "$APP/Contents/MacOS/Eaon"
# The SwiftPM resource bundle (fonts, brand logos, curated model catalog).
# The app's own loaders look it up via Bundle.main by exactly this name,
# so it must land in Contents/Resources unrenamed.
cp -R "$PRODUCTS/Eaon-desktop_Eaon-desktop.bundle" "$APP/Contents/Resources/"

if [[ ! -f installer/Eaon.icns ]]; then
  echo "== Regenerating app icon…"
  ICONSET=$(mktemp -d)/Eaon.iconset
  swift installer/make-icon.swift "$ICONSET"
  iconutil -c icns "$ICONSET" -o installer/Eaon.icns
fi
cp installer/Eaon.icns "$APP/Contents/Resources/Eaon.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key>
	<string>Eaon</string>
	<key>CFBundleDisplayName</key>
	<string>Eaon</string>
	<key>CFBundleIdentifier</key>
	<string>dev.eaon.desktop</string>
	<key>CFBundleExecutable</key>
	<string>Eaon</string>
	<key>CFBundleIconFile</key>
	<string>Eaon</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>$VERSION</string>
	<key>CFBundleVersion</key>
	<string>$VERSION</string>
	<key>LSMinimumSystemVersion</key>
	<string>14.0</string>
	<key>NSPrincipalClass</key>
	<string>NSApplication</string>
	<key>NSHighResolutionCapable</key>
	<true/>
	<key>LSApplicationCategoryType</key>
	<string>public.app-category.productivity</string>
	<!-- Talking to the desktop pet. BOTH strings are mandatory: macOS
	     terminates the process outright the first time it touches the
	     microphone or the recognizer without them — a crash, not a denial.
	     The wording says on-device explicitly because that is enforced in
	     code (EaonVoice sets requiresOnDeviceRecognition and refuses to run
	     rather than falling back to Apple's servers). -->
	<key>NSMicrophoneUsageDescription</key>
	<string>Eaon listens when you talk to the desktop pet. Your voice is transcribed entirely on this Mac and never leaves it.</string>
	<key>NSSpeechRecognitionUsageDescription</key>
	<string>Eaon turns what you say into text using your Mac's built-in on-device recognizer, so your voice is never sent anywhere.</string>
	<key>NSAppTransportSecurity</key>
	<dict>
		<!-- Local inference servers (Ollama / llama.cpp / MLX) speak plain
		     http on 127.0.0.1. -->
		<key>NSAllowsLocalNetworking</key>
		<true/>
	</dict>
</dict>
</plist>
PLIST
printf 'APPL????' > "$APP/Contents/PkgInfo"

echo "== Ad-hoc signing…"
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"

echo "== Creating .dmg…"
STAGING=$(mktemp -d)
cp -R "$APP" "$STAGING/"
ln -s /Applications "$STAGING/Applications"
DMG="dist/Eaon-$VERSION.dmg"
hdiutil create -volname "Eaon" -srcfolder "$STAGING" -ov -format UDZO "$DMG" > /dev/null
rm -rf "$STAGING"

echo "== Creating .zip (self-update payload)…"
ZIP="dist/Eaon-$VERSION.zip"
rm -f "$ZIP"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"

echo
echo "Done: $DMG"
echo "      $ZIP"
echo "Upload BOTH — the .dmg is the website download, the .zip is what"
echo "update-manifest.json's downloadURL should point to."
echo "Reminder: unsigned-by-Apple build — downloaders must right-click → Open on first launch."
