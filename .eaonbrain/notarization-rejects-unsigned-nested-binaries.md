---
title: Notarization rejects unsigned nested binaries
tags: [desktop-app, release, gotcha]
created: 2026-08-07T23:23:07.423Z
updated: 2026-08-07T23:23:07.423Z
---

Apple's notary service rejects the whole submission if **any** Mach-O inside the bundle is unsigned, lacks a secure timestamp, or lacks the hardened runtime. The failure arrives minutes later as `status: Invalid`, and the only way to see why is:

```
xcrun notarytool log <submission-id> --keychain-profile "eaon"
```

## Find them by content, never by extension

The first attempt at 2026.4.0 was rejected for exactly one file:

```
Eaon.app/Contents/Resources/eaon-cli/node_modules/trash/lib/macos-trash
  "The binary is not signed."
```

`macos-trash` is a prebuilt helper with **no file extension at all**, so an allowlist of `*.node` / `*.dylib` / `*.so` matched nothing — the nested-signing loop had never run on anything. (`fsevents.node`, the binary that allowlist was written for, isn't even in the bundle: `npm prune --omit=dev` drops it.)

npm dependencies ship prebuilt executables under arbitrary names, so content is the only reliable test:

```bash
while IFS= read -r candidate; do
  file -b "$candidate" | grep -q "Mach-O" || continue
  codesign --force --options runtime --timestamp --sign "$IDENTITY" "$candidate"
done < <(find "$APP/Contents/Resources" -type f)
```

## Sign inside-out, not --deep

`--deep` is deprecated and applies the app's entitlements to nested code that should not have them. Sign each nested Mach-O first, then the app bundle with `--entitlements`.

## Staple before packaging

The `.app` is notarized and stapled **before** the `.dmg` and `.zip` are built, so the ticket travels inside both. This matters for the `.zip`: a zip cannot carry a staple itself, so the only reason the self-updater's payload works offline is that the `.app` inside it was stapled first. The `.dmg` is then notarized separately and stapled in its own right, so Gatekeeper clears it at mount time.

Part of [[Signing and notarizing the Mac app]].
