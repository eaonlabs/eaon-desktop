---
title: Workers' own browser: BetterWright on Electron 33
tags: [eaon-desktop, workers, browser, betterwright, gotchas]
created: 2026-10-01T00:18:41.297Z
updated: 2026-10-01T00:18:41.297Z
---

The co-founder asked for "betterwright direct integration so it can drive its own web browser". `src/main/features/workers/browser.ts` gives every worker a hidden `BrowserWindow` in its own `persist:worker-<id>` session (so it keeps its own logins), driven by BetterWright 2.8.8 (`betterwright/electron`, MIT, pinned exactly). It is exposed as one tool, `web_browser`, with actions open, snapshot, find, click, type, press, scroll, back, read and screenshot, rather than raw Playwright code: small local models drive actions reliably, and each action can be judged before it runs (`catastrophic`: typing into password or card fields, or clicking spend-money buttons, as named in the latest snapshot). The worker page has a "Browser" fact that shows the window (to watch, or to sign the worker in somewhere); closing the window only hides it.

## Installing it
BetterWright declares `peerOptional electron >=43.4.1`; Eaon is on 33. It was installed with `--legacy-peer-deps`. **Never install with `--omit=optional`**: that strips every package's optional deps, including esbuild's platform binary, and broke the build until `npm install --legacy-peer-deps` restored them. Its optional `rookie-cookies*` (per-arch native) and `patchright-core` are excluded from the app in electron-builder `files`. `configureElectronNetwork()` is just two switches (`disable-quic`, `force-webrtc-ip-handling-policy=disable_non_proxied_udp`) that must be set before ready; `main/index.ts` sets them directly, so BetterWright only loads on first use.

## What breaks on Electron 33, and the workarounds (all in browser.ts)
- **Navigations to another site go stale for Playwright.** After a click to another origin (a renderer process swap), `page.evaluate` sees the new page, but `snapshot()` fails with 'Selector "body" does not match any element', and `waitForLoadState` / `page.goto` / `goBack` wait out their timeouts. Fix: navigate through Electron (`webContents.loadURL`, `goBack`), compare `getURL()` before and after a click, and on change call `landed()`, which closes BetterWright and reattaches to the same window. The fresh connection sees the new page; the page, session and logins are untouched.
- **BetterWright's guard proxy carries the page's traffic.** With no connection attached, nothing loads; an Electron `loadURL` made while disconnected stalled for 30–46 s. So: connect (`run('return 1')`) *before* navigating, and in `landed()` reattach immediately, then wait for readiness through the new connection (`waitForFunction(readyState !== 'loading')`). Waiting first and reconnecting second hung, because `executeJavaScript` on a swapped page blocks until the reattach.
- **Wait for "usable", not "loaded."** `dom-ready` alone was sometimes never seen, and `did-finish-load` never fires on pages with a blocked tracker. `open()` settles on the first of did-navigate / dom-ready / did-stop-loading.
- **Some pages can't be snapshotted at all** (iana.org is XHTML, where Playwright's `body` locator matches nothing). In that case the tool falls back to the page's text and suggests `find`.
- **Big pages.** Snapshot is capped at 20000 chars, and Wikipedia's interactive snapshot is 150k. `find {text}` tags matching elements with `data-eaon-find` and returns refs like `find-3` (locator `[data-eaon-find="3"]`). Refs from scoped `snapshot({selector})` calls went stale, so don't use those.
- BetterWright returns long results as `{truncated, preview}`; `resultText` unwraps them.

## Verified
11 steps (open, cross-site click, read, back, Wikipedia + find + click, search box type + submit, screenshot) pass reliably in about 18 s (dev Electron). In the packaged app, a worker on local MiniCPM5 2B opened example.com in its own browser and reported the title.

## Guests
Chat-app guests (Discord/Telegram/WhatsApp) can't use `web_browser`, `browser` or `computer` unless the user trusts them fully (`PRIVATE` in `workers/guests.ts`): the worker's browser holds the user's logins. See [[Chat apps: Workers in Discord, Telegram and WhatsApp]].

Related: [[Worker autonomy: access levels, routines, memory and approve-once]]
