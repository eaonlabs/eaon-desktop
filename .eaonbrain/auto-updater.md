---
title: Auto-updater (GitHub releases)
tags: [eaon-desktop, electron, updater, release]
created: 2026-08-20T00:00:00.000Z
updated: 2026-08-20T00:00:00.000Z
---

# Auto-updater (GitHub releases)

`electron-updater` was already a dependency (see [[Eaon Desktop architecture]])
but unused. Wired it up against `github.com/sanscreates/eaon-desktop`.

## Shape

- `src/main/updater.ts` owns the `autoUpdater` singleton: `autoDownload: true`,
  `autoInstallOnAppQuit: true`. Broadcasts a `UpdateStatus` union (idle /
  checking / available / not-available / downloading{percent} /
  downloaded{version} / error{message}) to the renderer over
  `updater:status`, and only polls (`initUpdater`, 10s after launch then every
  4h) when `app.isPackaged` — dev builds have no update feed and would just
  throw.
- `checkForUpdates({ interactive })` — the `interactive` flag is what
  distinguishes the "Check for Updates…" app-menu item (shows a native
  `dialog.showMessageBox` when there's nothing new or it errors, since the
  user isn't necessarily looking at any persistent UI) from the Settings
  button and the background poll (both silent; Settings renders `status`
  live instead).
- IPC: `updater:status` / `updater:check` / `updater:install`, mirrored in
  preload as `window.api.updater`. UI lives in the new "Software update"
  section at the bottom of `General.tsx`.
- `electron-builder.yml` got a top-level `publish: {provider: github, owner:
  sanscreates, repo: eaon-desktop}`. The mac target already listed `zip`
  alongside `dmg` — required, because electron-updater's Mac mechanism
  (Squirrel.Mac) reads `latest-mac.yml` + a `.zip` asset from the GitHub
  release, not the `.dmg`.
- `package.json` gained `release:mac` (`--publish always`) alongside the
  existing `dist:mac` (`--publish never`, unchanged, still just builds
  locally).

## Two things this doesn't solve by itself

- **Publishing needs `GH_TOKEN`** — a GitHub PAT with `repo` scope, set as an
  env var when running `npm run release:mac`. Without it electron-builder
  can't create the release or upload assets.
- **Installing needs the app code-signed.** Squirrel.Mac refuses to apply an
  update to an unsigned app — checking for updates works either way, but the
  actual install step will fail silently-ish until there's a real Developer
  ID Application certificate in play (electron-builder picks it up from the
  keychain or `CSC_LINK`/`CSC_KEY_PASSWORD`, not from anything in
  `electron-builder.yml` itself — `hardenedRuntime`/entitlements were already
  there but that's necessary, not sufficient).
