---
title: Building installers on an Apple silicon Mac (no Rosetta)
tags: [release, build, windows, macos, eaon-desktop]
created: 2026-09-30T14:47:58.021Z
updated: 2026-09-30T14:47:58.021Z
---

These notes come from shipping 2026.6.0-beta.1 from an Apple silicon Mac on macOS 27 without Rosetta. `npm run dist:mac` (scripts/release-mac.sh) and `npm run dist:win` both failed several times before working. Each fix is now in `electron-builder.yml`, with a comment explaining it.

## Mac (universal, signed, notarized)
- **`npmRebuild: false`**: electron-builder tried to recompile node-pty from source for x64. node-pty's bundled gyp imports `distutils`, which current Python no longer has (`ModuleNotFoundError: No module named 'distutils'`). The rebuild isn't needed anyway: node-pty 1.1 ships N-API prebuilds for darwin-x64/arm64 and win32-x64/arm64, and its loader tries `build/Release`, then `prebuilds/<platform>-<arch>`. node-pty is the only native dependency.
- **`mac.x64ArchFiles: '**/node_modules/node-pty/prebuilds/**'`**: the universal merge lipos Mach-O files that differ between the two passes. The same per-arch prebuild folders ship in both passes, so they are kept as they are.
- **`files` lists only `out/main`, `out/preload` and `out/renderer`.** It used to be `out/**`, which shipped ~60 MB of test builds (`out/test`, `out/workers-full`…) inside the asar. It also broke the universal merge ("Detected unique file out/test-all … not covered by allowList") when a test run wrote to `out/` between the x64 and arm64 passes. **Don't run `npm run test:main` while a Mac build is packaging.**
- Notarization credentials come from the login keychain entry `eaon-notarize`. The script signs, notarizes and staples both the .app and the DMG, then prints `spctl` verdicts.

## Windows, built on the Mac
Both of electron-builder's Windows tools on macOS are **Intel binaries**: rcedit runs under its bundled wine64, and it ships its own `nsis-3.0.4.1/mac/makensis`. Without Rosetta they fail with "bad CPU type in executable" / spawn error -86. Installing Rosetta needs sudo.
- **`win.signAndEditExecutable: false` plus `afterPack: scripts/win-exe-resources.cjs`**: the hook stamps the icon and version strings into each `Eaon.exe` with **resedit**, the pure-JS PE editor that @electron/packager uses. It is already present as a dependency of app-builder-lib. electron-builder still adds the ASAR integrity resource itself. Verified by reading the resources back: seven icons, the version strings and INTEGRITY are present.
- **NSIS**: `brew install makensis` (native arm64, 3.13). Point electron-builder at a folder with `mac/makensis` linked to it and `Stubs/Plugins/Include/Contrib/Bin/nsisconf.nsh` linked to `$(brew --prefix makensis)/share/nsis`, plus `elevate.exe` copied from the cached 3.0.4.1 bundle: `ELECTRON_BUILDER_NSIS_DIR=<that folder> npm run dist:win`. electron-builder's extra plugins (nsis7z, UAC, StdUtils…) come from its separate `nsis-resources` download, so nothing else is needed.
- **`nsis.warningsAsErrors: false`**: NSIS 3.13 warns about Finnish MultiUser strings that the templates leave out, and electron-builder passes `-WX`.
- On macOS Catalina and later, the uninstaller is extracted by `UninstallerReader` (pure JS) rather than run under wine, and it works with 3.13-built installers.
- Not testable here: the installer never runs on this Mac. Check it structurally with `file` (it should say "Nullsoft Installer") and by reading the exe resources. There is **no win32-ia32 node-pty prebuild**, so on 32-bit Windows the ADE terminal view can't start shells; the rest of the app is unaffected.

## Publishing a beta
A prerelease version (`2026.6.0-beta.1`) makes electron-updater allow prereleases in *that* build only. Stable builds fetch `releases/latest`, which skips pre-releases, so a beta on GitHub isn't pushed to existing users. Upload `latest.yml`, `latest-mac.yml`, the zip and the blockmaps with the installers, so the beta can update itself to the next beta.

A beta build finds updates by walking the GitHub release feed (electron-updater 6.8 `GitHubProvider`). It skips any tag that isn't valid semver, so **tag betas `v2026.6.0-beta.N`**. A `mac-v…`-style tag, as used for the 2026.4/2026.5 Mac releases, is invisible to a beta build, and so is a stable release tagged that way. See [[Auto-updater (GitHub releases)]].

## "Installer integrity check has failed" on Windows
A Windows tester hit this NSIS error with the 2026.6.0-beta.1 setup.exe. That installer is fine: it is byte-identical to the local build (same SHA-256) and passes NSIS's own CRC. The error comes from the copy on the tester's machine: a partial or interrupted 270 MB download, a download manager, antivirus, or a chat app re-sending the file. Have them check `Get-FileHash` against the release's SHA-256 and re-download.

How to verify an NSIS installer from a Mac: find the firstheader at a 512-byte boundary (`0xDEADBEEF` + "NullsoftInst"), read `length_of_all_following_data` at header+24, and compute `crc32(file[512 : header + length − 4])`. The result must equal the 4 bytes stored at `header + length − 4`. The CRC skips the first 512 bytes (the PE header) unless NSIS_CONFIG_CRC_ANAL is set. Covering the whole file, or starting at the header, gives a "mismatch" even for good installers, which is how 2026.5.0 looked broken until the range was right. A smaller x64-only installer would make broken downloads less likely.
