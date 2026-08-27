---
title: Migrating updates from the old Swift Eaon to this Electron app
tags: [eaon-desktop, updater, electron-builder, release, macos, gotcha]
created: 2026-08-27T01:10:07.862Z
updated: 2026-08-27T02:08:22.024Z
---

# Migrating updates from the old Swift Eaon to this Electron app

Goal: make the previously-shipped app's updater accept this Electron build as
an update. Achievable on macOS. Details below were verified against source, the
live server, and a handoff brief the user supplied (dated 2026-08-19).

## There are THREE separate updaters — do not confuse them

1. **macOS app** — hand-rolled JSON manifest + `.zip` swap. Native **Swift**.
2. **Bundled `eaon-cli`** — copies a payload out of the app bundle. **No network
   at all**; the CLI updates purely as a side effect of the app updating.
3. **Windows/Linux (`eaon-tauri/`)** — Tauri updater plugin, Ed25519-signed
   `latest.json`. Migrating that side needs the original
   `TAURI_SIGNING_PRIVATE_KEY` (an Actions secret), which is not in this repo.

The `.sig` files and `latest.json` on the GitHub releases belong to #3 and are
easy to mistake for Electron metadata. **No release has ever carried
`latest-mac.yml`**, so electron-updater has never had a feed there.

## The macOS path (#1)

- Manifest: `https://downloads.eaon.dev/update-manifest.json`, hardcoded at
  `UpdateChecker.manifestURL`. Hosted on a **Cloudflare Pages project
  `eaon-downloads`, direct upload, no git provider** — a deploy *replaces
  everything*, so redeploy `robots.txt` alongside it or it vanishes:
  `npx wrangler pages deploy <dir> --project-name eaon-downloads --branch main --commit-dirty=true`.
  Edge may serve the old file ~30s; verify with a cache-buster before concluding
  a deploy failed.
- Checks on launch and every 6h; 10s timeout; ignores local cache.
  Background failures are a **silent no-op** by policy — only the manual check
  reports an outcome.
- Version compare is component-wise integer on dot-split parts, zero-padded, so
  `0.8.10 > 0.8.3` and `1.0 == 1.0.0`. CalVer `YYYY.MINOR.PATCH`, **not semver**.
  PATCH is the default bump; MINOR is reserved for a visual overhaul.
- `sha256` in the manifest is **optional, but enforced when present**, streamed
  in 1MB chunks. Consequence: never replace a release asset in place, and ship
  fixes as a new version rather than re-uploading a tag.

## The three hard requirements (verified in `SelfUpdateInstaller.swift`)

`validate(appAt:)` rejects any download unless:

1. `Contents/MacOS/Eaon` is executable. electron-builder names the executable
   after `productName`, so **`productName` must be exactly `Eaon`** (was
   `Eaon Desktop`, which yields `Contents/MacOS/Eaon Desktop`).
2. `CFBundleIdentifier == "dev.eaon.desktop"` exactly — from `appId`, which was
   `ai.eaon.desktop`.
3. The `.zip` has the `.app` as its **top-level entry** (the installer takes the
   first `*.app` at the scratch root; the Swift build used
   `ditto -c -k --sequesterRsrc --keepParent` for this).

Plus `latestVersion` must beat the installed `AppVersion.current` (currently
`2026.4.5`), so `package.json` went `0.1.0` → **`2026.4.6`**.

Changing `appId` does **not** move user data: `index.ts` calls
`app.setName('Eaon')` before ready and `getPath('userData')` follows the app
*name*, so the store stays at `~/Library/Application Support/Eaon/store`.

## Repo ownership — the brief is stale here

The brief says binaries live on `sanscreates/eaon-desktop`. **Verified
2026-08-26: that redirects to `eaonlabs/eaon-desktop`** — the repo was
transferred. `gh repo view sanscreates/eaon-desktop` reports
`nameWithOwner: eaonlabs/eaon-desktop`. `publish` is set to `eaonlabs`. The old
URLs in the live manifest still resolve via GitHub's redirect.

(The brief itself flags that `RELEASING-UPDATES.md` is stale in three other
places — the `eaon-releases` repo is *not* what's used, builds *are* Developer
ID-signed and notarized, and the real tag prefix is `mac-v`, not `v`.)

## Tag prefix collision — unresolved, flag before publishing

macOS releases use the **`mac-v<version>`** tag prefix because the plain
`v<version>` namespace in the same repo is taken by the Tauri product.
**electron-builder cannot produce that prefix** — its GitHub publisher only
offers `vPrefixedTagName: true|false`, i.e. `v2026.4.6` or `2026.4.6`. So
`--publish always` would create a tag in the Tauri product's namespace. Either
publish the release manually with the `mac-v` tag (attaching artifacts *and*
`latest-mac.yml`), or consciously accept `v` tags for Electron mac builds.

## One-way door

Once a user crosses to the Electron app they update via electron-updater, which
needs `latest-mac.yml` in **every** subsequent release. No existing release has
one. Until the first electron-builder release exists, this app's own check
errors with "Cannot find latest-mac.yml" — expected, and handled as an error
state.

Links: [[Auto-updater (GitHub releases)]], [[Eaon Desktop architecture]]
