---
title: Computer use setup: macOS permissions, who owns them, and relaunch
tags: [computer-use, macos, permissions, gotcha]
created: 2026-10-01T02:34:36.511Z
updated: 2026-10-02T03:07:12.341Z
---

How Settings → Computer use walks a user through Accessibility and Screen Recording, and the macOS behaviour behind it. Tool design is in [[Computer use: how the computer tool sees and drives the screen]].

## The page
On macOS, while either permission is missing, a **Setup** section sits above Access: numbered rows (1 Accessibility, 2 Screen Recording), each with one "Open settings" button that asks macOS first and then opens the exact pane. The next step's button is `btn--primary`. Once both are allowed, the checklist goes away and a single "Permissions · Ready" row shows under **Status**, so nothing appears twice. Windows and Linux never see the setup. Switching "Enable computer use" on with setup unfinished replays a short accent wash on the next step (`data-attention`, re-keyed so it replays) and scrolls the setup into view. Focus stays where it is.

## "Accessibility is off" while the Eaon switch is on (Oct 2026)
A tester had Eaon rc.1 report Accessibility missing while System Settings showed an enabled "Eaon" entry. **The likely cause is a stale TCC entry.** TCC keeps **one entry per bundle id** and checks it against the code requirement (csreq) of whichever copy asked first. Every Eaon build, including the old Swift and Tauri apps, uses `dev.eaon.desktop`, and the old ones are **ad-hoc signed**, so their designated requirement is a bare `cdhash`. If one of those asked first, the entry stays tied to that cdhash. The Developer ID–signed Electron Eaon then fails the check, and the switch still looks on. Turning it off and on doesn't change the stored requirement; removing the entry does.
- The co-founder's own Mac has about 13 such copies (`mdfind 'kMDItemCFBundleIdentifier == "dev.eaon.desktop"'`, then `codesign -d -r-` on each): `/Applications/Eaon-backup-old.app` (2026.3.2), Tauri `target/*/bundle` builds, and old `dist/` folders. Beta 1 and rc.1 have the same Developer ID requirement, so an old Beta 1 copy alone does no harm.
- `mac.ts`: `differentlySignedCopies()` (Spotlight plus codesign, cached) and `resetAccessibility()` (`tccutil reset Accessibility <bundle id>`, no sudo needed). `status()` adds `otherCopies` while Accessibility is denied and Eaon owns its permissions. The page explains the shared switch, names a copy, and offers **Reset and ask again**. That calls `computer-use:reset-accessibility`, then `isTrustedAccessibilityClient(true)` to re-add Eaon, then opens the pane.
- TCC.db can't be read without Full Disk Access, so the stale entry was inferred from those copies, not seen. A copy deleted since can leave the same entry behind without showing in Spotlight, which is why the reset button shows whenever Accessibility is denied.

## Gotchas
- **A privacy list only shows apps that have asked.** Accessibility: `systemPreferences.isTrustedAccessibilityClient(true)` adds Eaon. Screen Recording: Electron has no request API, so `requestScreenAccess()` in `capture.ts` calls `desktopCapturer.getSources` with a **1×1** thumbnail. At 0×0 Electron skips the capture, and with it the TCC request.
- **Who the permission belongs to.** TCC charges the "responsible" process. Opened from Finder or the Dock, Eaon's parent is launchd (`process.ppid === 1`) and the switch is Eaon's. Started from a shell (`npm run dev`), it is the **terminal's**. `permissionOwner()` in `mac.ts` walks `ps` up to the outermost `.app` ancestor, and returns `name: null` when the chain reaches launchd first (tmux, or a backgrounded `node_modules/.bin/electron`). The JXA helper (`osascript`) is Eaon's child, so its `AXIsProcessTrusted` is charged to the same owner.
- **Screen Recording applies only after a relaunch.** `getMediaAccessStatus('screen')` keeps reading "denied" in the running process. Main keeps `screenRequested`, and once it's set the step offers "Quit & reopen Eaon". There's no probe for "on, waiting for a restart": older macOS returns a wallpaper-only image from `screencapture` instead of failing.
- **Relaunch** = `app.relaunch(); app.quit()`, never `app.exit()`, so the held quit in [[Quitting: held before-quit, will-quit and app.exit]] still saves chats. It's refused when `!app.isPackaged`.
- Accessibility (`AXIsProcessTrusted` in the JXA helper) takes effect live, so that step needs no restart.

## Tool errors
`tool.ts` (Accessibility) and `capture.ts` (`ScreenCaptureDenied`) tell the model the exact pane, the owner's name, and that Settings → Computer use has the step-by-step setup. The page's Test button maps `ScreenCaptureDenied` to its own short message.
