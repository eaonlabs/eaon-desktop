---
title: Background mode: LaunchAgent, tray and single instance
tags: [eaon-desktop, scheduler, macos, windows, launchd, electron, gotcha]
created: 2026-09-28T01:16:18.072Z
updated: 2026-09-28T01:16:18.072Z
---

# Background mode: LaunchAgent, tray and single instance

Scheduled tasks only fire while the main process lives. `src/main/background.ts` adds opt-in background running. The setting is `settings.background.enabled`. It is set from **Scheduled → Keep running in the background** and from **General → Launch at login**, which was a dead toggle until this; both call `background:set`.

- **macOS**: writes `~/Library/LaunchAgents/dev.eaon.desktop.background.plist`.
  - `RunAtLoad`, `KeepAlive` false, Aqua session, args `--background`.
  - Not a login item: on macOS 13+ SMAppService login items get no arguments and ignore "open hidden".
  - Turning it off only **removes the file**, never `launchctl bootout`, which would kill a launchd-started Eaon that is running.
  - At startup, when enabled, the plist is rewritten only if it changed (app moved).
- **Windows**: `app.setLoginItemSettings({ openAtLogin, path, args: ['--background'] })`. `window-all-closed` no longer quits when background is on; a tray icon (`app.getFileIcon(execPath)`) offers Open/Quit.
- `--background` launch: no `createWindow()`. The Dock icon (macOS) or second launch opens it via `activate` / `second-instance`.
- A dev build's command is Electron + an **absolute** entry script, since launchd starts agents from `/`. A `--user-data-dir=` argument is carried into the plist.

**Single-instance lock** (`app.requestSingleInstanceLock`, except under `EAON_CAPTURE`). There was none: two instances ran every task twice and wrote the same JSON store. `before-quit` returns early in the losing instance.

## Verified on macOS (isolated profile)
1. With `--background`, 0 on-screen windows; a task fired at its slot + 26 ms.
2. A second launch exited immediately and the first opened its window.
3. After a quit, `launchctl bootstrap` of the written plist started Eaon; startup took 1.4 s; the missed slot ran once and the grid continued.
4. The first-ever launchd start of the Electron binary took ~34 s. It wasn't Eaon: an instrumented rerun measured 1.4 s, most of it the login-shell PATH lookup. It looks like a one-time OS first-launch cost.

## Gotchas
- **Always test with `--user-data-dir=<tmp>`**. `app.setName('Eaon')` makes dev, capture and the installed app share `~/Library/Application Support/Eaon`, and `EAON_CAPTURE` wipes chats. Electron honours `--user-data-dir` even with setName.
- The plist path is global, so an isolated test profile with background on overwrites the real agent. Remove it after testing.
- macOS has no GNU `timeout`; `timeout 60 cmd | grep` fails silently.

Links: [[Scheduled tasks engine and headless runs]].
