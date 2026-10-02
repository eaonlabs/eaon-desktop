---
title: Swift-era Eaon browser extension (HTTP on 8823)
tags: [eaon-desktop, browser, chrome-extension, migration, gotcha]
created: 2026-09-30T14:58:49.433Z
updated: 2026-09-30T14:58:49.433Z
---

# Swift-era Eaon browser extension (HTTP on 8823)

The old Swift Eaon (see [[Migrating updates from the old Swift Eaon to this Electron app]]) had its own "Eaon Browser Control" extension. It has the **same name, and version 1.0.0**, like this app's first extension. Its copy is at `~/Downloads/Coding projects/Aqua Devs chat interface/browser-extension/` and its source is `BrowserBridge.swift`. It long-polls plain HTTP on `127.0.0.1:8823` (then 8824–8827) with `GET /health`, `POST /poll` and `POST /result`, sending an `x-eaon-token` header. It has an Options page and no icons.

It can never talk to this app's WebSocket bridge. A user who still has it installed sees an extension that "is outdated and won't connect", and the app previously said nothing. This was the user's actual bug in Sep 2026: listening on 8823 for 40 s caught 13 `/health` polls from their browser.

`src/main/features/browser/legacy.ts` (`LegacyExtensionDetector`) listens on 8823 while browser control is on. It counts only requests with `x-eaon-token` and no web Origin (a page can't produce one without a CORS preflight), and answers 410 with "out of date". Settings → Browser extension then shows an amber banner. It has steps plus "Open extensions page" buttons, and says to remove the one with no Eaon logo and an Options page. It clears after a minute of silence. If the port is taken, the detector quietly doesn't run.

The fix for a user is manual, because an extension can't be removed from outside the browser: remove the old one, then Load unpacked the new `extension/` folder and pair. From 1.1.0 on it updates itself. See [[Browser extension bridge]].
