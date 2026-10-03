---
title: Traffic light position and the --traffic-clear token
tags: [eaon-desktop, sidebar, titlebar, macos, layout, gotcha]
created: 2026-08-26T03:42:06.877Z
updated: 2026-10-02T03:06:09.331Z
---

# Traffic light position and the window-controls token

**Current (Oct 2 2026, Electron 43):** `TRAFFIC_LIGHTS = { x: 19, y: 19 }` in `src/main/index.ts`, and the CSS token is `--window-controls-left: 89px` in `tokens.css` (it used to be called `--traffic-clear`). Change the two together.

## Why 19, 19 and 89
With an app built against the macOS 26+ SDK (Electron 39 and later; see [[Electron 43 upgrade and the macOS 26 window look]]), the window buttons are **14pt, 23pt apart**. Electron 33 was linked against SDK 14, so macOS 27 drew the old look: 12pt buttons, 20pt apart. They were measured with a throwaway Swift probe built against the macOS 27 SDK. It made `NSWindow`s with `.fullSizeContentView` and a transparent titlebar and printed `standardWindowButton(...).frame`:
- titlebar only: first button at (9, 9)
- unified toolbar: (19, 19)
- unified compact: (12, 13)

(19, 19) is also exactly centred in the 36px titlebar row of the floating sidebar panel, which starts 8px in: row centre 26 = 19 + 14/2. The buttons span x 19..79 (19 + 2×23 + 14), and the token adds 10px of breathing room, which gives 89. `.sidebar__panel .titlebar`, `.titlebar--collapsed`, `.page__bar[data-collapsed]`, `.chat-header[data-collapsed]` and the base `.titlebar` all derive from the token.

## Buttons that jump back "only sometimes"
The co-founder reported the buttons were sometimes misplaced. AppKit lays the titlebar out again on its own after some events, and the buttons could come back at the default corner. Known triggers: leaving full screen, `setVibrancy` (theme switch), a light/dark change (including macOS's automatic one at sunset), a page title change. `pinTrafficLights(window)` calls `setWindowButtonPosition(TRAFFIC_LIGHTS)` on `focus`, `show`, `restore`, `resized`, `leave-full-screen`, `page-title-updated`, `nativeTheme` `updated`, and after every `setVibrancy`. It's cheap. **Not reproduced first-hand**: the terminal has no Screen Recording permission, and offscreen capture never draws native buttons. So the fix covers the known triggers rather than an observed case.

## Verifying is awkward
Native traffic lights are **not drawn in offscreen rendering** (`EAON_CAPTURE`), and `screencapture` needs Screen Recording. Check geometry arithmetically, and check `win.getWindowButtonPosition()` over CDP (the E2E multi-window run read {19,19} for both windows).

## History
Originally the lights sat in the gutter above the panel. The user wanted them inside the rounded panel (as in Jan), so the titlebar row moved into `.sidebar__panel` and the position went (13,13) → (20,20) → (19,19). Moving the position once left three hardcoded header paddings too tight, which is why every header reads the token.

Links: [[Floating curved sidebar]], [[Eaon Desktop architecture]], [[Several Eaon windows: how chats and settings stay in step]]
