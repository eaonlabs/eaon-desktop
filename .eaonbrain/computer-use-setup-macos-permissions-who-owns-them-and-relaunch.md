---
title: Computer use setup: macOS permissions, who owns them, and relaunch
tags: [computer-use, macos, permissions, gotcha]
created: 2026-10-01T02:34:36.511Z
updated: 2026-10-01T02:34:36.511Z
---

How Settings → Computer use walks a user through Accessibility and Screen Recording, and the macOS behaviour behind it. Tool design is in [[Computer use: how the computer tool sees and drives the screen]].

## The page
On macOS, while either permission is missing, a **Setup** section sits above Access: numbered rows (1 Accessibility, 2 Screen Recording), each with one "Open settings" button that asks macOS first and then opens the exact pane. The next step's button is `btn--primary`. Once both are allowed, the checklist goes away and a single "Permissions · Ready" row shows under **Status**, so nothing appears twice. Windows and Linux never see the setup. Switching "Enable computer use" on with setup unfinished replays a short accent wash on the next step (`data-attention`, re-keyed so it replays) and scrolls the setup into view. Focus stays where it is.

## Gotchas
- **A privacy list only shows apps that have asked.** Accessibility: `systemPreferences.isTrustedAccessibilityClient(true)` adds Eaon. Screen Recording: Electron has no request API, so `requestScreenAccess()` in `capture.ts` calls `desktopCapturer.getSources` with a **1×1** thumbnail. At 0×0 Electron skips the capture, and with it the TCC request. On a Mac that has never been asked, macOS shows its own prompt at that moment, which is fine.
- **Who the permission belongs to.** TCC charges the "responsible" process. Opened from Finder or the Dock, Eaon's parent is launchd (`process.ppid === 1`) and the switch is Eaon's. Started from a shell (`npm run dev`), it is the **terminal's**, and turning on Eaon or Electron does nothing. `permissionOwner()` in `mac.ts` walks `ps -axww -o pid=,ppid=,comm=` up to the nearest `.app` ancestor and uses the outermost bundle in that path, so VS Code shows as "Visual Studio Code" rather than "Code Helper (Plugin)". It returns `name: null` when the chain reaches launchd first. That happens under tmux, and also when `node_modules/.bin/electron` (a node wrapper) was backgrounded and its shell exited. The page and the tool errors both name the owner.
- **Screen Recording applies only after a relaunch.** `getMediaAccessStatus('screen')` keeps reading "denied" in the running process. The main process therefore keeps `screenRequested` (set by the setup button, kept across page visits). Once it is set, the step offers "Quit & reopen Eaon" next to "Open settings". There is no probe for "switched on, waiting for a restart": a 1-px `screencapture` was considered, but older macOS returns a wallpaper-only image instead of failing, so it would report a grant that isn't there.
- **Relaunch** = `app.relaunch(); app.quit()`, never `app.exit()`, so the held quit in [[Quitting: held before-quit, will-quit and app.exit]] still saves chats and closes MCP servers. The relaunch fires when the process finally exits. The handler refuses when `!app.isPackaged`, because the electron-vite dev server would not come back. Dev copy tells the user to restart Eaon (and the terminal if needed) instead.
- Accessibility (`AXIsProcessTrusted` in the JXA helper) takes effect live, so that step needs no restart.

## Tool errors
`tool.ts` (Accessibility) and `capture.ts` (`ScreenCaptureDenied`) tell the model the exact pane ("Privacy & Security → Accessibility" / "Screen & System Audio Recording"), the owner's name, and that Settings → Computer use has the step-by-step setup. The page's Test button maps `ScreenCaptureDenied` to its own short message. The model-facing text would sound odd on the page itself.
