---
title: App shell: deferred login-shell PATH, secrets vault and download safety
tags: [eaon-desktop, electron, security, models, gotchas]
created: 2026-09-29T14:29:31.803Z
updated: 2026-09-29T14:29:31.803Z
---

Main-process rules from the Sep 2026 bug pass (`index.ts`, `secrets.ts`, `modelHub.ts`, `updater.ts`, `system.ts`).

## Startup: the login-shell PATH no longer blocks the window

Asking the login shell for PATH takes 0.5 s+ (more with nvm/oh-my-zsh). It now runs while the window loads (`shellPath` promise). Everything that spawns waits for it: `chat:stream`, MCP sync, `github:pull-requests`, and **every feature IPC handler**, through a `Proxy` over `ipcMain` passed to features as `featureContext.ipcMain` (its `handle` awaits `shellPath`). Handlers are still registered immediately, so an early renderer call never finds "no handler". New spawning IPC in `index.ts` must `await shellPath` itself.

## Secrets vault: never write after a failed read

`keys.dat` holds every API key plus OAuth and plugin tokens. A failed decrypt (keychain locked, access denied) used to read as an empty vault, and the next save overwrote everything. Now: both encrypted and plaintext formats decode; while `safeStorage` is unavailable, writes are **refused** with a clear message; a vault that won't decode while the keychain works is moved aside (`keys.dat.unreadable-<ts>`), never deleted; writes are tmp + rename. `secrets.set` can therefore throw — callers that clean up (e.g. `forgetServer`) must catch.

## Windows and destroyed objects

Accessing `webContents` on a closed `BrowserWindow` throws, and `mainWindow` in `index.ts` is never set back to null. Use `featureContext.getWindow()` (checks `isDestroyed`) — the updater's broadcast threw inside electron-updater's event chain and silently stopped all background checks while the window was closed.

## Downloads (Browse Hugging Face)

Use `stream/promises` `pipeline`: an unhandled write-stream `error` is an uncaught main-process exception (Electron's "JavaScript error" dialog) and the download promise never settles. Files are written as `.part` and renamed when complete; free space is checked first; a second click joins the running download; `cancelAllDownloads()` on quit removes partials synchronously. The curated library's Get likewise joins a running pull.

## Polling

`system.ts` no longer calls `execFileSync('sw_vers')` per IPC (it blocked every stream and animation); System Monitor stops polling while the window is hidden. `gh` calls have a 30 s timeout.

Related: [[Quitting: held before-quit, will-quit and app.exit]], [[Eaon Desktop architecture]].
