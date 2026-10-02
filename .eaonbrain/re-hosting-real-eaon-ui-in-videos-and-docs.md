---
title: Re-hosting real Eaon UI in videos and docs
tags: [eaon-desktop, marketing, video, css, screenshots, hyperframes]
created: 2026-09-28T04:05:52.000Z
updated: 2026-09-28T14:03:53.658Z
---

# Re-hosting real Eaon UI in videos and docs

For the 2026.6 launch film (HyperFrames project at `~/Downloads/eaon-launch-video`,
kept out of this repo) every app screen is the **real renderer DOM**, not a mockup:

1. Drive the built app with the capture harness (isolated profile — see
   [[Capture harness wipes the real profile unless --user-data-dir is set]]) and save
   `document.documentElement.outerHTML` per state alongside the PNG.
2. Scope the compiled `out/renderer/assets/index-*.css` under `.eaon-app` with
   postcss: `:root`/`html` → `.eaon-app`, leading `[data-theme]` → `.eaon-app[data-theme]`,
   `body` → `.eaon-app .eaon-body`, `#root` → `.eaon-app .eaon-root`, everything else
   prefixed. Pin `vh/vw` to the 1270×797 window. `.eaon-app { contain: layout paint }`
   makes it the containing block for the app's `position: fixed` menus.
3. Convert each snapshot: `<html>` attrs (theme vars, `data-theme`) onto
   `div.eaon-app`, `<body>` attrs onto `div.eaon-body`, drop scripts/CSP, rewrite
   `./assets/*` and `file:///…/out/renderer/assets/*` image URLs. **Keep ids but
   prefix them** (`xf-<fragment>-…`) and rewrite `url(#…)` / `href="#…"`: dropping ids
   orphans the SVG gradients in pet sprites and skill icons (black pets, blank
   cubes). The film's `build-frames.mjs` then suffixes the prefix per inclusion so a
   fragment used twice stays unique. Tool screenshots use the app's `eaon-file://`
   scheme — point them at copies of the images.

The result renders pixel-identical to the screenshots and can be animated live
(typing into the real textarea, streaming words, toggling `data-highlight` on
menu rows, flipping `.switch[data-on]`).

Gotchas:

- **Kill `transition` inside re-hosted DOM** — frame-by-frame renders change
  attributes out of wall-clock order, so transitions make frames non-deterministic.
- **Kill entrance keyframes** (`nav-row-in`, `msg-in`, `tool-in`, `pop`, `fade`,
  `sched-in`, `block-resolve`…) or they replay at the start of every shot. Keep
  `spin`, `shimmer`, `caret-blink` and the `pet-*` loops.
- The thinking orb is a `<canvas>` and snapshots blank (the film animates a strip of
  its real frames instead).
- Switch knobs snap once transitions are off — tween `.switch__knob` x after flipping
  `data-on` so it slides.
- Don't alias a repeated `<img>` with `?n=2` to dodge the duplicate-media lint: the
  alias 404s in snapshots. Copy the file instead.
- **Real app layout bug (2026.6 build):** in a Work chat with a goal banner or
  checklist, `.composer-dock` (a flex row in `chat.css`) puts `.composer-dock__pinned`
  *beside* the composer instead of above it. The intended layout needs
  `flex-direction: column; align-items: center` on `.composer-dock`. The launch
  film's captures injected that fix (so marketing shows the intended layout);
  the app itself still needs it.
- The Work home composer (552px) truncates the model chip to "Opus… High" —
  about 11px too narrow.

Links: [[Eaon 2026.6 feature map]], [[Coloured themes, text fade and on-accent]]

Related: [[Launch film: frame 07 browser and computer use, live transcript gotchas]]

Related: [[Launch film: frame 09 montage and re-hosted SVG gradient gotcha]]
