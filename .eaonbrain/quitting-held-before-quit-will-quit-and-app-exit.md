---
title: Quitting: held before-quit, will-quit and app.exit
tags: [eaon-desktop, electron, persistence, gotcha]
created: 2026-09-29T14:27:48.812Z
updated: 2026-09-29T14:27:48.812Z
---

How `src/main/index.ts` quits without losing the last chat save or orphaning MCP servers, and the Electron behaviour that shaped it.

## The sequence

1. **before-quit** (first time): runs cleanup once (`shutDown` flag) — cancels model downloads, starts `shutdownMcp()`, stops the local server, disposes features. Then `preventDefault()` and waits for `store.flushWrites()` (3 s cap) **and** MCP shutdown (4.5 s cap), then calls `app.quit()` again.
2. **before-quit** (second time): `flushedBeforeClose` is set, so it lets the quit through; the windows close. Closing fires the renderer's `pagehide`, which cancels any running chat turn and sends one last `chats:save` (including a save still inside its 250 ms debounce).
3. **will-quit**: `preventDefault()`, wait for that last save, then **`app.exit(0)`**.

## Gotcha: `app.quit()` is ignored after will-quit was prevented

Electron 33 does nothing on `app.quit()` once `will-quit` has been prevented — no second before-quit, no exit. The app sat with zero windows forever (verified by instrumenting the events over `--inspect`: `before-quit(prevented)`, `before-quit`, `will-quit(prevented)`, then nothing). By then cleanup has run and the windows are gone, so `app.exit(0)` is correct. Holding **before-quit** and re-issuing `app.quit()` does work.

## Why the MCP cap is 4.5 s

The MCP SDK's stdio `close()` ends stdin, waits 2 s, sends SIGTERM, waits 2 s, then SIGKILL. A fire-and-forget `void shutdownMcp()` at quit never reached the kill, so servers that ignore stdin EOF were orphaned. A server that exits on EOF costs no wait.

## Updates

`updater:install` flushes writes itself and sets both flags, so neither hold delays electron-updater's quit-and-relaunch.

Related: [[Scheduled tasks engine and headless runs]] (background mode keeps the app alive with no window), [[Smoke-testing the built app with a fake provider over CDP]] (how the hang was found).
