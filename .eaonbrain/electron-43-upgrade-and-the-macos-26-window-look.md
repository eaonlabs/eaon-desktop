---
title: Electron 43 upgrade and the macOS 26 window look
tags: [eaon-desktop, electron, macos, build, gotcha]
created: 2026-10-02T03:06:18.401Z
updated: 2026-10-02T03:06:18.401Z
---

Eaon moved from Electron 33.4 to **43.7.7** on Oct 2 2026. The co-founder asked for the window buttons to have "the new look" on macOS 27.

## Why the look needed an Electron upgrade
macOS 26 and later give an app the new window chrome (14pt traffic lights, new spacing and corners) only when its binary was **linked against the macOS 26 SDK**. Older links keep the old look. Check with:
`otool -l "node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Framework.framework/Electron Framework" | grep -A4 LC_BUILD_VERSION`
Measured: Electron 33.4 → sdk 14.0 (old look). 39.8 → sdk 26.0. 43.7 → sdk 26.5, minos 12.0. 44.5 → sdk 26.5, minos 13.0. Electron 33 also has the macOS 26 "whole system lags while an Electron app is open" WindowServer bug, fixed in 36.9.2 / 37.6 / 38.2+.

## Why 43 and not 44
**Electron 44 removes Windows 32-bit (ia32)** and macOS 12, and moves `clipboard` out of the renderer. Eaon ships an ia32 Windows installer, so 43 (still supported) was the safe step. Revisit when ia32 can go.

## What changed for the code
- Electron 42+ **no longer downloads its binary in postinstall**. `require('electron')` (what electron-vite uses) downloads it on first use, or run `npx install-electron --no`. `npm install` alone leaves `node_modules/electron/dist` empty.
- `console-message` takes one event object now: `({ level, message, lineNumber, sourceId })`, and `level` is a string.
- Offscreen rendering (the capture harness) defaults to 1x scale since 42. `index.ts` passes `offscreen: { deviceScaleFactor: screen.getPrimaryDisplay().scaleFactor }`.
- macOS notifications use `UNNotification` since 42, which wants a signed app. Unsigned dev builds may not show notifications.
- betterwright's optional peer wants `electron >=43.4.1`, so that warning is gone. Still install with `--legacy-peer-deps` to match the lockfile.
- The node-pty N-API prebuilds keep working; electron-builder 25.1.8 packages 43 fine.

The full suite (713 tests) and an E2E run (two windows, chat and settings sync, no console errors) passed on 43. See [[Traffic light position and the --traffic-clear token]] for the button geometry and [[Building installers on an Apple silicon Mac (no Rosetta)]] for packaging.
