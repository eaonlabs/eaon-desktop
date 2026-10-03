---
title: Re-hosting real Eaon UI in videos and docs
tags: [eaon-desktop, marketing, video, css, screenshots, hyperframes]
created: 2026-09-28T04:05:52.000Z
updated: 2026-10-02T12:54:42.499Z
---

# Re-hosting real Eaon UI in videos and docs

For the 2026.6 launch film (HyperFrames project at `~/Downloads/eaon-launch-video`)
and the 2026.6.0 release film (`~/Downloads/eaon-2026-6-release`, see
[[Eaon 2026.6 release film (Apple style): how it is built]]), both kept out of this
repo, every app screen is the **real renderer DOM**, not a mockup:

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
   orphans SVG gradients (black sprites, blank cubes). The film's `build-frames.mjs`
   then suffixes the prefix per inclusion so a fragment used twice stays unique.
   Tool screenshots use the app's `eaon-file://` scheme — point them at copies.

The result renders identically to the screenshots and can be animated live
(typing into the real textarea, streaming words, toggling `data-highlight` on
menu rows, flipping `.switch[data-on]`).

Gotchas:

- **The window is translucent on macOS.** With a vibrant theme the body has
  `data-translucent="on"` and paints `--canvas` at **82% over transparent**; the
  real window shows the dark `sidebar` vibrancy material through it. Capture PNGs
  therefore have alpha (main area `rgba(13,13,13,209)`) and look grey or black
  depending on the viewer. Re-hosted, give the host element an opaque backing that
  stands in for the material (`#26262A` works) or the page behind shows through.
  CDP screencast recordings composite the transparency onto black, so recorded
  windows read a touch darker than re-hosted ones.
- **Kill `transition` inside re-hosted DOM** — frame-by-frame renders change
  attributes out of wall-clock order, so transitions make frames non-deterministic.
- **Kill entrance keyframes** (`chip-in`, `nav-row-in`, `msg-in`, `tool-in`, `pop`,
  `fade`, `card-in`, `sched-in`, `block-resolve`…) or they replay at the start of every
  shot. Replay any you need (worker-face `wf-*`, shimmer, caret) with GSAP using the
  keyframes' own values.
- `:hover` and `:focus-within` can't apply; emulate with an attribute plus the app's
  own rule values (e.g. `.composer:focus-within` → `box-shadow: 0 0 0 1px var(--border-strong)`).
- The thinking orb and the ADE's xterm terminals are `<canvas>` and snapshot blank.
  Save terminal buffers as text at capture time (`term.buffer.active`) if you need to
  re-typeset them; the orb can be redrawn with `ThinkingOrb.tsx`'s own code.
- macOS draws the traffic lights, so no capture has them: add them at
  `trafficLightPosition {x: 20, y: 20}`, 12px, 8px apart.
- Switch knobs snap once transitions are off — tween `.switch__knob` x after flipping
  `data-on` so it slides.
- Don't alias a repeated `<img>` with `?n=2` to dodge the duplicate-media lint: the
  alias 404s in snapshots. Copy the file instead.
- In a HyperFrames frame, never set an element's `visibility` to `'visible'` — it
  overrides the hidden sub-composition host and the element shows during other
  frames. Use `''`.
- Keep personal data off screen: the model picker lists the user's own Ollama
  models (personal names), and Claude Code's first-run trust prompt and shell
  prompts print the macOS username and full path.

Real app layout quirks seen while capturing (not fixed in the app as of rc.1):

- 2026.6 build: in a Work chat with a goal banner or checklist, `.composer-dock`
  puts `.composer-dock__pinned` *beside* the composer instead of above it (needs
  `flex-direction: column; align-items: center`).
- rc.1 at 1270px: the trading chart's "Table" button draws over the "All" range
  button; four composer chips including "Full autonomy" truncate; worker question
  cards are wider than the composer; the browser panel's "Start browsing" empty
  state is centred on the window, not the panel.

Links: [[Eaon 2026.6 feature map]], [[Coloured themes, text fade and on-accent]]

Related: [[Launch film: frame 07 browser and computer use, live transcript gotchas]]

Related: [[Launch film: frame 09 montage and re-hosted SVG gradient gotcha]]
