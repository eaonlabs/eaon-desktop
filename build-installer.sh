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
# Signing has two modes, picked automatically from what's in the keychain:
#
#   Developer ID (what users should get) — taken when a "Developer ID
#     Application" identity exists, or when EAON_SIGN_IDENTITY names one.
#     Signs with the hardened runtime and a secure timestamp, then
#     notarizes and staples if a notarytool keychain profile is set up
#     (EAON_NOTARY_PROFILE, default "eaon"). A stapled build opens on a
#     first launch with no Gatekeeper warning at all, on a Mac that has
#     never been online.
#
#   Ad-hoc (fallback) — what this did before a paid account existed. The
#     app runs on Apple Silicon but downloaders get the "unidentified
#     developer" warning and must right-click → Open the first time.
#
# Set EAON_SKIP_NOTARIZE=1 to Developer ID-sign without notarizing, for a
# quick local build (notarization takes a few minutes per submission).
set -euo pipefail
cd "$(dirname "$0")"

NOTARY_PROFILE="${EAON_NOTARY_PROFILE:-eaon}"

# Auto-detect the distribution identity. `security` prints one line per
# identity; the quoted common name is what codesign wants.
#
# Selection is by SHA-1 hash rather than common name: once there's more than
# one Developer ID Application cert (renewing before expiry means there
# always will be, briefly), every one of them shares the identical common
# name, and codesign given an ambiguous name refuses to sign at all.
if [[ -n "${EAON_SIGN_IDENTITY:-}" ]]; then
  IDENTITY="$EAON_SIGN_IDENTITY"
else
  DEVID_HASHES=$(security find-identity -v -p codesigning 2>/dev/null \
    | sed -nE 's/^[[:space:]]*[0-9]+\)[[:space:]]+([0-9A-F]+)[[:space:]]+"Developer ID Application: .*/\1/p')
  DEVID_COUNT=$(printf '%s' "$DEVID_HASHES" | grep -c . || true)

  if [[ "$DEVID_COUNT" -le 1 ]]; then
    IDENTITY="$DEVID_HASHES"
  else
    # Pick the one that stays valid longest, so a freshly-issued replacement
    # wins over the cert it was created to replace. Signing with the
    # about-to-expire one would still produce a working build today and then
    # fail silently on the next release.
    BEST_HASH=""; BEST_EPOCH=0
    while IFS= read -r hash; do
      [[ -z "$hash" ]] && continue
      # `-Z` prefixes each PEM with its hashes, so the block after the
      # matching "SHA-1 hash:" line is the certificate for this identity.
      expiry=$(security find-certificate -Z -a -c "Developer ID Application" -p 2>/dev/null \
        | awk -v h="$hash" '
            /^SHA-1 hash: /   { want = ($3 == h); next }
            /^SHA-256 hash: / { next }
            want              { print }
            /END CERTIFICATE/ { if (want) exit }' \
        | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
      [[ -z "$expiry" ]] && continue
      epoch=$(date -j -f "%b %d %T %Y %Z" "$expiry" +%s 2>/dev/null || echo 0)
      if [[ "$epoch" -gt "$BEST_EPOCH" ]]; then BEST_EPOCH="$epoch"; BEST_HASH="$hash"; fi
    done <<< "$DEVID_HASHES"

    if [[ -n "$BEST_HASH" ]]; then
      IDENTITY="$BEST_HASH"
      echo "== $DEVID_COUNT Developer ID certs found; using the longest-lived ($BEST_HASH)."
      echo "   Override with EAON_SIGN_IDENTITY=<sha1> if that's not the one you want."
    else
      echo "!! Multiple Developer ID certs found but none could be read." >&2
      echo "   Set EAON_SIGN_IDENTITY to the SHA-1 of the one to use:" >&2
      security find-identity -v -p codesigning | grep "Developer ID Application" >&2
      exit 1
    fi
  fi
fi

# A cert nearing expiry still signs a valid build today (the secure
# timestamp keeps it valid forever), but the NEXT release will fail. Say so
# now rather than at the point it breaks.
if [[ -n "$IDENTITY" && "${IDENTITY}" != "-" ]]; then
  CERT_END=$(security find-certificate -c "Developer ID Application" -p 2>/dev/null \
    | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
  if [[ -n "$CERT_END" ]]; then
    END_EPOCH=$(date -j -f "%b %d %T %Y %Z" "$CERT_END" +%s 2>/dev/null || echo 0)
    NOW_EPOCH=$(date +%s)
    DAYS_LEFT=$(( (END_EPOCH - NOW_EPOCH) / 86400 ))
    if [[ "$END_EPOCH" -gt 0 && "$DAYS_LEFT" -lt 200 ]]; then
      echo "!! Signing cert expires in $DAYS_LEFT days ($CERT_END)."
      echo "   This build stays valid forever, but renew before the next release."
    fi
  fi
fi

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
# Built one architecture at a time and lipo'd together, rather than the more
# obvious `swift build --arch arm64 --arch x86_64`. A multi-arch invocation
# routes through Xcode's build system, which as of Xcode 26 cannot reach the
# Metal toolchain — it now ships as a separately-downloaded cryptex, and
# xcbuild fails with "cannot execute tool 'metal'" even when
# `xcrun metal --version` works and `xcodebuild -showComponent` reports it
# installed. SwiftTerm has a .metal shader, so the whole build dies on it.
# Single-arch builds use SwiftPM's own build system, which finds metal fine.
swift build -c release --arch arm64
swift build -c release --arch x86_64

ARM_PRODUCTS=".build/arm64-apple-macosx/release"
X86_PRODUCTS=".build/x86_64-apple-macosx/release"
APP="dist/Eaon.app"
rm -rf dist
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

echo "== Bundling Eaon CLI into ${APP}…"
mkdir -p "$APP/Contents/Resources/eaon-cli"
cp -R "$CLI_STAGE/dist" "$CLI_STAGE/node_modules" "$CLI_STAGE/package.json" "$APP/Contents/Resources/eaon-cli/"
rm -rf "$CLI_STAGE"

echo "== Assembling ${APP} (lipo: arm64 + x86_64)…"
lipo -create -output "$APP/Contents/MacOS/Eaon" \
  "$ARM_PRODUCTS/Eaon-desktop" "$X86_PRODUCTS/Eaon-desktop"
lipo -info "$APP/Contents/MacOS/Eaon"

# The SwiftPM resource bundles. The app's own loaders look these up via
# Bundle.main / Bundle.module by exactly these names, so they must land in
# Contents/Resources unrenamed. Taken from the arm64 build because bundle
# contents are resources, not code — the one compiled artifact among them,
# SwiftTerm's default.metallib, is already built for every GPU family.
#
# SwiftTerm's bundle is copied too. It wasn't before, which would trap the
# first user to open the terminal view: SwiftPM's generated `Bundle.module`
# accessor calls fatalError when it can't find its resource bundle, so that
# is a hard crash rather than a missing texture.
cp -R "$ARM_PRODUCTS/Eaon-desktop_Eaon-desktop.bundle" "$APP/Contents/Resources/"
cp -R "$ARM_PRODUCTS/SwiftTerm_SwiftTerm.bundle" "$APP/Contents/Resources/"

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

DMG="dist/Eaon-$VERSION.dmg"
ZIP="dist/Eaon-$VERSION.zip"

if [[ -z "$IDENTITY" ]]; then
  echo "== Ad-hoc signing (no Developer ID Application identity found)…"
  codesign --force --deep --sign - "$APP"
  codesign --verify --deep --strict "$APP"
  NOTARIZED=no
else
  echo "== Signing with: $IDENTITY"
  # Signed inside-out, deepest first. `--deep` is deprecated and, worse,
  # applies the app's entitlements to nested code that shouldn't have them;
  # signing each nested Mach-O explicitly is what Apple's notary service
  # expects.
  #
  # Detection is by file content, never by extension. The one binary in here
  # today is `trash`'s macos-trash helper, which has no extension at all —
  # an extension allowlist (.node/.dylib/.so) silently matched nothing and
  # the first notarization attempt was rejected for it. npm dependencies
  # ship prebuilt executables under arbitrary names, so content is the only
  # reliable test.
  NESTED_COUNT=0
  while IFS= read -r candidate; do
    file -b "$candidate" 2>/dev/null | grep -q "Mach-O" || continue
    echo "   nested: ${candidate#"$APP/"}"
    codesign --force --options runtime --timestamp --sign "$IDENTITY" "$candidate"
    NESTED_COUNT=$((NESTED_COUNT + 1))
  done < <(find "$APP/Contents/Resources" -type f 2>/dev/null)
  echo "   ($NESTED_COUNT nested binaries signed)"

  codesign --force --options runtime --timestamp \
    --entitlements installer/Eaon.entitlements \
    --sign "$IDENTITY" "$APP"
  codesign --verify --deep --strict --verbose=2 "$APP"

  if [[ "${EAON_SKIP_NOTARIZE:-0}" == "1" ]]; then
    echo "== Skipping notarization (EAON_SKIP_NOTARIZE=1)."
    NOTARIZED=no
  elif ! xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1; then
    echo "!! No notarytool profile \"$NOTARY_PROFILE\" — signed but NOT notarized."
    echo "   Create one with:"
    echo "     xcrun notarytool store-credentials \"$NOTARY_PROFILE\" \\"
    echo "       --apple-id \"chadavishnu@outlook.com\" --team-id W9MHT9V982 \\"
    echo "       --password \"<app-specific password>\""
    NOTARIZED=no
  else
    # The .app is notarized and stapled BEFORE packaging, so the ticket
    # travels inside both artifacts. This matters for the .zip: a zip can't
    # carry a staple itself, so the only way the self-updater's payload
    # works offline is if the .app inside it was already stapled here.
    echo "== Notarizing the app… (a few minutes)"
    NOTARIZE_ZIP=$(mktemp -d)/Eaon-notarize.zip
    ditto -c -k --sequesterRsrc --keepParent "$APP" "$NOTARIZE_ZIP"
    xcrun notarytool submit "$NOTARIZE_ZIP" --keychain-profile "$NOTARY_PROFILE" --wait
    xcrun stapler staple "$APP"
    rm -f "$NOTARIZE_ZIP"
    NOTARIZED=yes
  fi
fi

echo "== Creating .dmg…"
STAGING=$(mktemp -d)
cp -R "$APP" "$STAGING/"
ln -s /Applications "$STAGING/Applications"
hdiutil create -volname "Eaon" -srcfolder "$STAGING" -ov -format UDZO "$DMG" > /dev/null
rm -rf "$STAGING"

# The disk image is a separate distributable and gets its own ticket, so
# Gatekeeper clears it at mount time rather than only clearing the app after
# it's been dragged out.
if [[ "$NOTARIZED" == "yes" ]]; then
  echo "== Notarizing the .dmg…"
  xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$DMG"
fi

echo "== Creating .zip (self-update payload)…"
rm -f "$ZIP"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"

echo
echo "Done: $DMG"
echo "      $ZIP"
echo "Upload BOTH — the .dmg is the website download, the .zip is what"
echo "update-manifest.json's downloadURL should point to."
if [[ "$NOTARIZED" == "yes" ]]; then
  echo "Signed, notarized and stapled — opens with no Gatekeeper warning."
  echo "Verify with: spctl -a -vvv -t install \"$APP\""
elif [[ -n "$IDENTITY" ]]; then
  echo "Signed but NOT notarized — downloaders will still see a warning."
else
  echo "Reminder: unsigned-by-Apple build — downloaders must right-click → Open on first launch."
fi
