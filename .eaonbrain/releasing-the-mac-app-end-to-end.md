---
title: Releasing the Mac app end to end
tags: [desktop-app, release, deployment]
created: 2026-08-07T23:21:59.139Z
updated: 2026-08-07T23:21:59.139Z
---

Every step, in order. Missing any one of them ships a release nobody receives.

1. **Bump the version.** `AppVersion.current` in `Eaon-desktop/Services/UpdateChecker.swift`. `build-installer.sh` reads it with sed, so the artifacts, the Info.plist and the manifest all take their version from that one line.
2. **Update `CHANGELOG.md`.** The GitHub release body is generated from the section for that version.
3. **`./build-installer.sh`.** Builds universal, signs, notarizes, staples, and produces `dist/Eaon-<v>.dmg` and `dist/Eaon-<v>.zip`. Takes 10–15 minutes, most of it waiting on Apple. See [[Signing and notarizing the Mac app]].
4. **Commit to a `release/<version>` branch** and push. `main` has historically lagged badly — see the warning at the bottom.
5. **Tag and create the GitHub release** on `sanscreates/eaon-desktop`, attaching **both** artifacts. The tag name is not obvious: see [[Mac release tags are prefixed mac-v]].
6. **Update the update manifest.** Nothing reaches existing users until this is done — [[The update manifest and how the self-updater works]].

## The .dmg and the .zip are not interchangeable

The `.dmg` is the website download. The `.zip` is what the in-app self-updater fetches, and `SelfUpdateInstaller` expects the `.app` as the archive's top-level entry, which is why the script uses `ditto --keepParent`. Upload both to the release; point the manifest's `downloadURL` at the `.zip`.

## Verifying a build

```
spctl -a -vvv -t install dist/Eaon.app     # expect: accepted, source=Notarized Developer ID
xcrun stapler validate dist/Eaon-<v>.dmg
codesign -dv --verbose=4 dist/Eaon.app     # expect flags=0x10000(runtime) and a Timestamp
```

## main is a long way behind

As of 2026.4.0, `main` sat at `2730d96` while 2026.3.5, 2026.3.6 and 2026.4.0 all lived on unmerged `release/*` branches. The merge is genuinely hard — around 36 conflicting files, with `chat.rs` differing by ~649 lines because both sides independently rebuilt eaon-tauri. Do not start a release assuming `main` is current.
