---
title: Traffic light position and the --traffic-clear token
tags: [eaon-desktop, sidebar, titlebar, macos, layout, gotcha]
created: 2026-08-26T03:42:06.877Z
updated: 2026-08-26T03:42:06.877Z
---

# Traffic light position and the `--traffic-clear` token

When the sidebar became a floating panel ([[Floating curved sidebar]]), the
first version put the titlebar row *outside* the panel so the macOS traffic
lights sat in the gutter above it. The user rejected that — the reference (Jan)
has the lights **inside** the rounded shape.

## The change

- `Sidebar.tsx`: the `.titlebar` row moved *inside* `.sidebar__panel`, and
  `.sidebar` now pads all four sides (`padding: var(--sidebar-gap)`) so the
  panel is inset from the top too.
- `main/index.ts`: `trafficLightPosition` moved from `{x: 13, y: 13}` to
  `{x: 20, y: 20}`. With the panel starting at (8, 8) and a 36px titlebar row,
  that puts the buttons 12pt inside the panel's left and top edges, vertically
  centred in the row `((36 - 12) / 2 = 12)`, and clear of the 14px corner curve.
- The panel's titlebar controls are `justify-content: flex-end` so they sit at
  the far right of the panel instead of crowding the lights — this matches the
  reference and is what the gutter-less layout needs.

## The gotcha this exposed

Moving `trafficLightPosition` silently broke **three other screens**. The lights
are drawn by macOS on top of the web contents, so every header that can sit
behind them reserves left padding — and all of those were hardcoded:

    .titlebar--collapsed                  padding-left: 75px
    .page__bar[data-collapsed='true']     padding-left: 78px
    .chat-header[data-collapsed='true']   padding-left: 78px

The buttons end at `x = trafficLightPosition.x + 2*20 + 12`. That moved from 65
to 72, so every one of those went from ~10-13pt of clearance to 3-6pt, and the
collapsed header's icons ended up jammed against the green button. The user
caught it in the collapsed state, which is easy to miss because the sidebar
panel is not on screen there at all.

All four now derive from one token in `tokens.css`:

    --traffic-clear: 82px;   /* lights end at 72, plus 10px breathing room */

`.sidebar__panel .titlebar` subtracts `--sidebar-gap` (it starts inset from the
window edge); the two collapsed headers add 3px, preserving their original
slightly-wider relationship. **If `trafficLightPosition` ever changes again,
change `--traffic-clear` with it and nothing else needs touching.**

## Verifying this is awkward

Native traffic lights are **not drawn in offscreen rendering**, which is what
`EAON_CAPTURE` uses — so screenshots from the harness show only the reserved
empty space, never the buttons. `screencapture -R` against the live window needs
Screen Recording permission, which this terminal does not have. The geometry is
deterministic though, so verify it arithmetically:
`lights span x = tlp.x .. tlp.x + 52`, and check each header's padding against
that.

Links: [[Floating curved sidebar]], [[Eaon Desktop architecture]]
