---
title: Matching the Eaon Desktop Figma frames
tags: [eaon-desktop, design, figma, electron, screenshots, gotchas]
created: 2026-08-20T00:00:00.000Z
updated: 2026-08-20T00:00:00.000Z
---

# Matching the Eaon Desktop Figma frames

## Deriving the scale factor

The frames are 2000x1256 exports. macOS traffic lights are a fixed 12pt across
with 20pt between centres — measuring them in the frame gave ~31.5px spacing,
so the frames are **1.575x** a 1270x797pt window. Every other measurement was
divided by 1.575 to get CSS pixels. Key results:

- sidebar 238px, title bar 36px, nav row 27px
- hero composer 552px wide, docked chat composer 640px
- settings content column 664px, plugin directory column 620px,
  integrations manager column 572px
- hero title 28px, base font 14px

## The font-width trap

Text in the frames is consistently ~16% narrower than the same string rendered
in SF Pro at the same size. Cap heights matched, widths did not — the frames
use a narrower grotesque we cannot ship. **Match cap height, not string width.**
Sizing down to match width makes everything look too small. A global
`letter-spacing: -0.01em` recovers a little of the difference. Some descriptions
that fit one line in the frames wrap to two here; that is a font consequence,
not a layout bug.

## Screenshot harness

`src/main/capture.ts` runs only when `EAON_CAPTURE=<dir>` is set. It drives the
real UI with synthetic clicks and writes one PNG per state.

Two things that cost real time:

1. **`capturePage()` returns stale frames when the window is not frontmost.**
   Screenshots came back N steps behind, which looks exactly like broken
   navigation. Fix: `webPreferences.offscreen = true` in capture mode — offscreen
   painting keeps `capturePage` in sync with the DOM.
2. **The store persists between runs.** A capture step that switches to the
   light theme leaves the next run in light mode. `index.ts` resets theme, chats
   and projects when `EAON_CAPTURE` is set.

Also note `el.textContent` includes text inside inline SVGs, so selecting a
button by exact text fails when it contains a brand icon with a `<text>` glyph
(the PDF tile). Select by class/index instead.

## zustand selector gotcha

`useApp((s) => s.visibleChats())` returns a fresh array each call, so the default
`Object.is` comparison always reports a change — React error #185, blank window.
Any selector returning a new array must be wrapped in `useShallow` from
`zustand/react/shallow`. Selectors that return an element found inside stored
state (`activeChat`, `currentModel`) are stable and do not need it.
