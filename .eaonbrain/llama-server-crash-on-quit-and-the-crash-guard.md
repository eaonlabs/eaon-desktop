---
title: llama-server crash on quit and the crash guard
tags: [eaon-desktop, llama.cpp, runtime, gotchas, process]
created: 2026-10-01T04:23:10.874Z
updated: 2026-10-01T04:23:10.874Z
---

The co-founder reported "the app is sometimes crashing" (Sept 30 2026). The only native crash reports on their Mac were `~/Library/Logs/DiagnosticReports/llama-server-*.ips`: SIGABRT, `ggml_abort` ← `ggml_metal_rsets_free` ← `ggml_metal_device_free` ← `exit`. Eaon itself had none, and a crash hunt over a copy of their real profile found no JS errors, blank screens or process deaths.

## Why llama-server aborted
llama.cpp's server treats a **second** SIGINT/SIGTERM during shutdown as "terminating immediately" and calls `exit(1)` from inside the signal handler. The static destructors then free the Metal device while it is still in use, and that aborts. One signal is fine.

The second signal came from the process group. `llama-server` used to be spawned without `detached`, so it shared Eaon's group. When Eaon runs from a terminal (`npm run dev`, `electron .`, an ADE pane) and that terminal gets Ctrl+C or is closed, the terminal signals the whole foreground group. Eaon quits and its `llamaRuntime.shutdown()` sends SIGTERM, on top of the SIGINT llama-server already got from the terminal. Reproduced with the real binary and model: group SIGINT plus one SIGTERM gives SIGABRT and a new .ips every time; in its own group, exit 0 and no report.

## The fix (`src/main/llama/runtime.ts`)
- `spawn(..., { detached: process.platform !== 'win32' })`, so the server leads its own process group and a terminal's Ctrl+C never reaches it. On Windows, `detached` would open a console window, and there are no group signals anyway.
- `LlamaServer.stop()` is idempotent: a `stopping` flag means one SIGTERM, then SIGKILL after 3 s if it is still there.
- Detached children can outlive a crashed Eaon (stdio pipes only kill one that is writing). Live pids go to `<userData>/llama-servers.json`. `llamaRuntime.reapOrphans()` runs from `modelLibraryFeature.register` at launch and SIGTERMs recorded pids, but only if `ps -o comm=` still says `llama-server`; a reused pid is left alone. It is POSIX only. `process.on('exit')` also stops any server still running.
- Tests: `test/llama-signals.test.ts`. The stand-in records every signal it gets and exits 134 on the second one. The wrapper uses `#!/bin/bash` with `exec -a "$0" node fake.cjs`, because without `exec -a` `ps` reports the process as `node` and the orphan check would not recognise it.

## Crash guard (`src/main/crashGuard.ts`)
`installCrashGuard()` runs at module load in `index.ts`, for the primary instance only.
- **Log file.** Everything goes to `<userData>/logs/crashes.log`, rotated to `crashes.old.log` past 1 MB. Help → Show Crash Log reveals the file.
- **Native crashes.** `crashReporter.start({ uploadToServer: false })` keeps minidumps locally.
- **Main-process errors.** `uncaughtException` and `unhandledRejection` are logged instead of showing Electron's "A JavaScript error occurred in the main process" dialog, and the app carries on.
- **Renderer crashes.** `render-process-gone` reloads Eaon's own windows (type `window`, or `offscreen` under the capture harness). It never reloads webviews or `clean-exit`. After 3 reloads in 5 minutes it asks Reload / Show Crash Log / Quit, so a page that crashes on load cannot loop.
- **Helper processes and hangs.** `child-process-gone`, `unresponsive` and `responsive` are logged.
- **Renderer error reporting.** `components/CrashScreen.tsx` is a React error boundary around `<App/>`: it shows "Something went wrong" with a Reload button instead of a blank window. `reportRendererErrors()` forwards `error` and `unhandledrejection` events over `app:report-error`, deduplicated by message, capped at 20 per page load, and ignoring the benign "ResizeObserver loop" notice.

## The crash log's first catch: sending to a closing window
Within an hour of shipping, `crashes.log` on the co-founder's Mac recorded `[main: uncaught exception] TypeError: Object has been destroyed`. The path was `discordPresence.setConnection` ← `sync(null)` ← the sender's `'destroyed'` listener.
- **Cause:** while a window closes, its `webContents` is destroyed *before* the BrowserWindow is. The shared `ctx.send` checked only `mainWindow.isDestroyed()`, so a last status update to the closing page threw.
- **Effect before the guard:** with Discord presence on, every close or quit put up Electron's "A JavaScript error occurred in the main process" dialog. That is a likely source of the "sometimes crashing" reports.
- **Fix:** every send in `index.ts` goes through `liveContents()`, which also checks `webContents.isDestroyed()`. `updater.ts` has the same check.
- **Repro:** `scratchpad/e2e/close-window.mjs`. Run the app with `TMPDIR` set to an empty folder, so Discord RPC can't find the real Discord's socket (state `no-discord`). Call `api.discord.sync(snapshot)`, close the window, and look at the profile's crashes.log.

Gotchas found while testing:
- **`webContents.getType()` is `'offscreen'` under `EAON_CAPTURE`** (the harness sets `offscreen: true`). A guard that checked only `'window'` logged the crash in E2E but never reloaded.
- **CDP `executeJavaScript` on a crashed renderer never settles.** Give every probe in a crash test its own timeout.
- **In node:test, `process.emit('uncaughtException')` reaches the runner's own listener and fails the test.** Call the guard's own listener directly instead (see `test/crashGuard.test.ts`).

Related: [[Eaon's own llama.cpp runtime (no Ollama)]], [[MCP server lifecycle and SDK gotchas]] (the same restart-budget idea), [[Main-process test harness gotchas]].
