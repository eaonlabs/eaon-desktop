# How to push a release to GitHub and go live — the actual steps

This is the hands-on runbook for cutting a macOS release the way it was
actually done for 2026.1.9 / 2026.2.0 / 2026.3.0 — including the two things
that trip you up: the **macOS build currently fails in `build-installer.sh`**
(a SwiftTerm/Metal issue on Xcode 26+, workaround below), and the live
update only reaches users once you **flip the hosted manifest**.

For the *design* of the update system (how the app checks, what
`SelfUpdateInstaller` does, hosting constraints) see `RELEASING-UPDATES.md`.
This file is the step-by-step "what I ran."

---

## The mental model — a release is 4 independent things

1. **Source** — commit the version bump + changelog, push to `origin/main`.
2. **Binaries** — build the macOS `.dmg` + `.zip`.
3. **GitHub release** — publish/attach those binaries to a `v<VERSION>` release.
4. **Live manifest** — point `downloads.eaon.dev/update-manifest.json` at the
   new `.zip`. **This is the global on/off switch.** Until you flip it, every
   installed app says "you're up to date" on the *old* version, no matter what
   is on GitHub.

Any of these can already be done (e.g. CI publishes the GitHub release with
Windows/Linux, or a parallel session bumped the version). Check first, do only
what's missing.

## Where things live

| Thing | Location |
| --- | --- |
| Source repo (public) | `sanscreates/eaon-desktop` — releases now go **here** |
| Older binary repo | `sanscreates/eaon-releases` — used through 2026.2.0, now stale |
| Version constant | `Eaon-desktop/Services/UpdateChecker.swift` → `AppVersion.current` |
| Manifest URL (in app) | `UpdateChecker.manifestURL` = `https://downloads.eaon.dev/update-manifest.json` |
| Manifest host | Cloudflare Pages project **`eaon-downloads`** (custom domain `downloads.eaon.dev`) |
| Manifest deploy context | run `wrangler` from `~/Projects/Eaon` (that's where CF auth is set up) |
| Build script | `build-installer.sh` (⚠️ macOS build step currently broken — see §4) |

## Prerequisites (one-time)

- `gh` authenticated (`gh auth status`) with `repo` scope.
- `wrangler` usable from `~/Projects/Eaon` (`npx wrangler whoami`).
- Xcode installed; the Metal toolchain downloaded once:
  `xcodebuild -downloadComponent MetalToolchain`.

---

## Step 1 — Bump the version

Versioning is `YYYY.MINOR.PATCH`, **not** semver.
- **Default to a PATCH bump** (`2026.2.0` → `2026.2.1`) — bug fixes, new
  features, even a big batch of them.
- Reserve a **MINOR bump** (`2026.2.x` → `2026.3.0`) for a UI overhaul or a
  comparably sweeping change. When unsure, PATCH.

Edit `Eaon-desktop/Services/UpdateChecker.swift`:

```swift
enum AppVersion {
    static let current = "<VERSION>"   // e.g. "2026.3.0"
}
```

Bump it **before** building — the version baked into the binary must match
what the manifest announces, or a freshly-updated app immediately thinks it
needs to update again.

## Step 2 — Write the changelog

Add a `## [<VERSION>] — YYYY-MM-DD` section at the top of `CHANGELOG.md`
(newest first), with `### Added` / `### Changed` / `### Fixed`. You'll reuse
this text for both the GitHub release notes and the manifest's short notes.

## Step 3 — Commit and push the source

```bash
cd "/Users/sanshraychada/Downloads/Coding projects/Aqua Devs chat interface"
git add CHANGELOG.md Eaon-desktop/Services/UpdateChecker.swift
git commit -m "Bump version to <VERSION>"
git push origin main
```

(Commit as yourself — no Co-Authored-By trailer in this repo.)

## Step 4 — Build the macOS installer

### The easy path (try it first)

```bash
./build-installer.sh
```

If it prints `Done: dist/Eaon-<VERSION>.dmg` and `.zip`, skip to Step 5.

### ⚠️ If it fails on `Compile Shaders.metal`

On Xcode 26+ the **universal** `swift build --arch arm64 --arch x86_64` inside
`build-installer.sh` dies with:

```
error: cannot execute tool 'metal' due to missing Metal Toolchain
```

This is a known Xcode build-system bug: it can't reach the Metal toolchain's
cryptex mount to compile SwiftTerm's shader — even though `xcrun metal` works
fine directly. **Each single-arch build only *copies* the shader** (SwiftTerm
compiles it at runtime), so building the two arches separately and `lipo`-ing
them together works. Run this instead of `build-installer.sh`:

```bash
cd "/Users/sanshraychada/Downloads/Coding projects/Aqua Devs chat interface"
VERSION=$(sed -nE 's/.*static let current = "([^"]+)".*/\1/p' Eaon-desktop/Services/UpdateChecker.swift)

# 1. Build each architecture on its own (these succeed; the universal build doesn't)
xcrun swift build -c release --arch arm64
xcrun swift build -c release --arch x86_64

# 2. Assemble the .app with a lipo'd universal binary (mirrors build-installer.sh)
ARM=".build/arm64-apple-macosx/release"
X64=".build/x86_64-apple-macosx/release"
APP="dist/Eaon.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
lipo -create "$ARM/Eaon-desktop" "$X64/Eaon-desktop" -output "$APP/Contents/MacOS/Eaon"
lipo -info "$APP/Contents/MacOS/Eaon"   # should list: x86_64 arm64
cp -R "$ARM/Eaon-desktop_Eaon-desktop.bundle" "$APP/Contents/Resources/"
cp installer/Eaon.icns "$APP/Contents/Resources/Eaon.icns"

# 3. Info.plist (identical to build-installer.sh's, with the version filled in)
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key><string>Eaon</string>
	<key>CFBundleDisplayName</key><string>Eaon</string>
	<key>CFBundleIdentifier</key><string>dev.eaon.desktop</string>
	<key>CFBundleExecutable</key><string>Eaon</string>
	<key>CFBundleIconFile</key><string>Eaon</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleShortVersionString</key><string>$VERSION</string>
	<key>CFBundleVersion</key><string>$VERSION</string>
	<key>LSMinimumSystemVersion</key><string>14.0</string>
	<key>NSPrincipalClass</key><string>NSApplication</string>
	<key>NSHighResolutionCapable</key><true/>
	<key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
	<!-- Both are MANDATORY once voice ships: macOS kills the process the first
	     time it touches the mic/recognizer without them. Keep in sync with
	     build-installer.sh. -->
	<key>NSMicrophoneUsageDescription</key><string>Eaon listens when you talk to the desktop pet. Your voice is transcribed entirely on this Mac and never leaves it.</string>
	<key>NSSpeechRecognitionUsageDescription</key><string>Eaon turns what you say into text using your Mac's built-in on-device recognizer, so your voice is never sent anywhere.</string>
	<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
PLIST
printf 'APPL????' > "$APP/Contents/PkgInfo"

# 4. Ad-hoc sign
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"

# 5. .dmg (drag-to-Applications) and .zip (self-updater payload — Eaon.app must be top level)
STAGING=$(mktemp -d); cp -R "$APP" "$STAGING/"; ln -s /Applications "$STAGING/Applications"
hdiutil create -volname "Eaon" -srcfolder "$STAGING" -ov -format UDZO "dist/Eaon-$VERSION.dmg" > /dev/null
rm -rf "$STAGING"
rm -f "dist/Eaon-$VERSION.zip"
ditto -c -k --sequesterRsrc --keepParent "$APP" "dist/Eaon-$VERSION.zip"
```

**Verify the build before shipping it:**

```bash
/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" dist/Eaon.app/Contents/Info.plist  # == VERSION
codesign --verify --deep --strict dist/Eaon.app && echo "signature OK"
unzip -l dist/Eaon-$VERSION.zip | head -4   # Eaon.app/ must be the top-level entry
```

Note: the build is **ad-hoc signed, not notarized**. First-time `.dmg`
downloaders hit Gatekeeper's "unidentified developer" warning and must
right-click → Open. The self-update `.zip` path doesn't (no quarantine flag).

## Step 5 — Publish (or update) the GitHub release

**If no `v<VERSION>` release exists yet** — create it with the binaries:

```bash
# write the changelog section to a notes file
sed -n '/## \[<VERSION>\]/,/## \[/p' CHANGELOG.md | sed '$d' | tail -n +2 > /tmp/notes.md

gh release create v<VERSION> \
  dist/Eaon-<VERSION>.dmg dist/Eaon-<VERSION>.zip \
  --repo sanscreates/eaon-desktop \
  --title "Eaon <VERSION>" \
  --notes-file /tmp/notes.md \
  --target main
```

**If the release already exists** (e.g. CI already published it with the
Windows/Linux assets) — just attach the macOS files:

```bash
gh release upload v<VERSION> \
  dist/Eaon-<VERSION>.dmg dist/Eaon-<VERSION>.zip \
  --repo sanscreates/eaon-desktop
```

Confirm it's public and downloadable **anonymously** (the app's updater has no
token):

```bash
curl -sL "https://github.com/sanscreates/eaon-desktop/releases/download/v<VERSION>/Eaon-<VERSION>.zip" \
  -o /dev/null -w "HTTP %{http_code}  size %{size_download}\n"   # want 200 + real size
```

## Step 6 — Flip the live manifest (this is what makes users see the update)

Write the manifest into its own folder, then deploy that folder to the
`eaon-downloads` Pages project. Point `downloadURL` at the **`.zip`** from
Step 5.

```bash
mkdir -p /tmp/manifest && cat > /tmp/manifest/update-manifest.json <<'JSON'
{
  "latestVersion": "<VERSION>",
  "downloadURL": "https://github.com/sanscreates/eaon-desktop/releases/download/v<VERSION>/Eaon-<VERSION>.zip",
  "releaseNotes": "• first highlight\n• second highlight\n• …"
}
JSON
python3 -m json.tool /tmp/manifest/update-manifest.json >/dev/null && echo "valid JSON"

cd ~/Projects/Eaon
npx wrangler pages deploy /tmp/manifest \
  --project-name=eaon-downloads --branch=main --commit-dirty=true
```

`releaseNotes` is plain text with `\n` for line breaks. Keep it to ~6 short
bullets of the **Mac-relevant** highlights (the changelog may lead with
Windows/Linux items that don't matter to a Mac updater).

## Step 7 — Verify it's actually live

The `pages.dev` URL updates instantly; the **custom domain** (what the app
hits) can lag ~30–60s. Check both:

```bash
curl -s "https://eaon-downloads.pages.dev/update-manifest.json" | python3 -c "import sys,json;print(json.load(sys.stdin)['latestVersion'])"
sleep 30
curl -s "https://downloads.eaon.dev/update-manifest.json?cb=$(python3 -c 'import time;print(int(time.time()))')" | python3 -m json.tool
```

When `downloads.eaon.dev` reports the new `latestVersion` and the `downloadURL`
returns 200, you're done. In the app: **Settings → General → Check for
Updates** now offers the new version. Every installed copy sees it on its next
launch/periodic check.

---

## Gotchas learned the hard way

- **The manifest is the go-live switch.** Publishing the GitHub release does
  nothing for existing users on its own — they only update when the manifest's
  `latestVersion` exceeds their own. If the app says "up to date" on the old
  version, the manifest wasn't flipped.
- **`build-installer.sh` is broken for macOS on Xcode 26+** (the Metal/SwiftTerm
  issue). Use the §4 workaround until the build is fixed (e.g. metal toolchain
  integration, or building macOS in CI). `xcrun metal` working ≠ the build
  system finding it.
- **`.zip` must have `Eaon.app` at its top level** (`ditto --keepParent`) —
  `SelfUpdateInstaller` looks for exactly that after extracting.
- **Anonymous download must be 200.** A release on a *private* repo 404s for
  the app's tokenless updater. `eaon-desktop` is currently public; if that ever
  changes, host the `.zip` somewhere public and point `downloadURL` there.
- **Custom-domain propagation lag** — don't panic if `downloads.eaon.dev` still
  shows the old version for ~30–60s after deploy; the `pages.dev` URL confirms
  the deploy itself.
- **Coordinate with any parallel session/CI.** Check `git log`, `gh release
  list --repo sanscreates/eaon-desktop`, and the live manifest before acting —
  the version bump, the release, or some assets may already be done.

## Quick reference — the whole thing, in order

```bash
# 1–3  version + changelog + push
#   (edit UpdateChecker.swift AppVersion.current, edit CHANGELOG.md)
git add CHANGELOG.md Eaon-desktop/Services/UpdateChecker.swift
git commit -m "Bump version to <VERSION>" && git push origin main

# 4  build macOS (try ./build-installer.sh; if Metal fails, use the §4 workaround)

# 5  GitHub release (create OR upload)
gh release create v<VERSION> dist/Eaon-<VERSION>.dmg dist/Eaon-<VERSION>.zip \
  --repo sanscreates/eaon-desktop --title "Eaon <VERSION>" --notes-file /tmp/notes.md --target main
#   …or, if it already exists:
gh release upload v<VERSION> dist/Eaon-<VERSION>.dmg dist/Eaon-<VERSION>.zip --repo sanscreates/eaon-desktop

# 6  flip the manifest
cd ~/Projects/Eaon && npx wrangler pages deploy /tmp/manifest \
  --project-name=eaon-downloads --branch=main --commit-dirty=true

# 7  verify
curl -s "https://downloads.eaon.dev/update-manifest.json?cb=$(python3 -c 'import time;print(int(time.time()))')" | python3 -m json.tool
```
