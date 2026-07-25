# Building Eaon for Windows and Linux

Eaon's Windows and Linux app is this Tauri project: a Rust core (all
networking, persistence, agent tools, the local API server) with a React
webview UI. This document is the full answer to "how do I produce a Windows
build" — including the paths that don't require owning a Windows machine.

## TL;DR — the three ways to get a Windows `.exe`

| Path | Needs | Produces |
| --- | --- | --- |
| **1. CI release (recommended)** | push a `v*` tag to GitHub | Draft GitHub Release with `Eaon_<v>_x64-setup.exe` + Linux `.AppImage`/`.deb`/`.rpm` attached |
| **2. CI dry run** | press *Run workflow* on the Release action | Same installers as build artifacts, no release created |
| **3. Local build on a Windows PC** | Windows 10/11 + toolchain below | `src-tauri/target/release/bundle/nsis/*.exe` |

Tauri cannot cross-compile: a macOS or Linux machine **cannot** produce the
Windows installer locally. That's what the CI matrix is for — `.github/
workflows/release.yml` builds on real `windows-latest` and `ubuntu-22.04`
runners.

## Path 1/2 — CI (from any machine)

```sh
# Dry run: build installers without releasing anything
gh workflow run "Release (Windows + Linux)" --repo sanscreates/eaon-desktop
gh run watch   # artifacts: eaon-Windows-installers / eaon-Linux-installers

# Real release: tag = version (the workflow stamps it into tauri.conf.json)
git tag v2026.4.0 && git push origin v2026.4.0
# → review the DRAFT release on GitHub, then press Publish
```

## Path 3 — building locally on Windows

One-time setup (in an elevated PowerShell, or use the linked installers):

```powershell
# 1. Microsoft C++ Build Tools (the MSVC linker Rust needs)
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
# 2. Rust (MSVC toolchain)
winget install Rustlang.Rustup
# 3. Node.js 20+
winget install OpenJS.NodeJS.LTS
# WebView2 is preinstalled on Windows 11 / current Windows 10.
```

Then:

```powershell
cd eaon-tauri
npm ci
npm run stage:cli      # bundles Eaon CLI into the installer — see below
npm run tauri dev      # live-reload development app
npm run tauri build    # → src-tauri\target\release\bundle\nsis\Eaon_*_x64-setup.exe
```

## Building locally on Linux

```sh
sudo apt-get install libwebkit2gtk-4.1-dev libappindicator3-dev \
  librsvg2-dev patchelf build-essential file   # Debian/Ubuntu names
cd eaon-tauri
npm ci
npm run stage:cli      # bundles Eaon CLI into the installer — see below
npm run tauri build    # → bundle/appimage/*.AppImage, bundle/deb/*.deb, bundle/rpm/*.rpm
```

### Bundling Eaon CLI

Settings → Tools → Eaon CLI's "Install Now" button copies a pre-built
`eaon-cli` payload out of the app itself — nothing is downloaded at install
time. That payload isn't part of the app's own source tree; `npm run
stage:cli` (`scripts/stage-cli.mjs`) builds `eaon-cli` in an isolated temp
copy (`npm ci && npm run build && npm prune --omit=dev`, mirroring the Mac
app's own `build-installer.sh`) and drops the result in `resources/eaon-cli/`,
which `tauri.conf.json`'s `bundle.resources` then copies into the installer.

Skipping this step is fine for a quick UI check — `tauri dev`/`tauri build`
both work either way, since `resources/eaon-cli/` only ever needs to exist
(a tracked `.gitkeep` guarantees that) — but the Install button won't have
anything to offer until you run it at least once. The release CI workflow
(`.github/workflows/release.yml`) runs it automatically before every real
build, on both platforms.

## Development on macOS (this repo's home machine)

macOS can't produce the Windows/Linux installers, but it compiles and runs
the identical cross-platform code — this is the everyday dev loop:

```sh
cd eaon-tauri
npm install
npm run check          # TypeScript
(cd src-tauri && cargo test)   # Rust core tests
npm run tauri dev      # run the real app in a window
```

## Gotchas that already cost time (don't rediscover these)

- **Windows bundles NSIS only.** MSI/WiX refuses the CalVer major version
  ("2026" > 255), so `tauri.windows.conf.json` pins `targets: ["nsis"]`.
  Don't add "msi" back.
- **Unsigned builds trip SmartScreen.** "Windows protected your PC" →
  More info → Run anyway. Goes away only with a paid code-signing
  certificate (or EV/Azure Trusted Signing) wired into CI later.
- **rustls, not OpenSSL.** `reqwest` is built with `rustls-tls` so Windows
  and the Linux runners never need an OpenSSL toolchain. Keep it that way.
- **Linux needs the WebKitGTK 4.1 dev packages** listed above at build time;
  end users of the `.deb`/`.rpm` get them as dependencies, and the
  `.AppImage` carries its own.
- **The version is stamped from the git tag in CI** — `tauri.conf.json`'s
  checked-in version only matters for local builds.

## Where user data lives (support answers)

- Windows: `%APPDATA%\dev.eaon.desktop\state.json` (+ `attachments\`)
- Linux: `~/.local/share/dev.eaon.desktop/state.json`
- The 2026.3.x releases used the same location; the rebuilt app migrates
  that state (`aquaApiKey` → `eaonApiKey`, key prefixes) on first launch.
