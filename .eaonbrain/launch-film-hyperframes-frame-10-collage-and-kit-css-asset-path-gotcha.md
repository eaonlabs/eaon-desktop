---
title: Launch film (HyperFrames): frame 10 collage and kit.css asset-path gotcha
tags: [launch-video, hyperframes, gotcha]
created: 2026-09-28T04:14:34.444Z
updated: 2026-09-28T04:14:34.444Z
---

# Launch film: frame 10 collage and a kit.css gotcha

The launch video lives outside this repo at `~/Downloads/eaon-launch-video`. It is built as one HyperFrames sub-composition per frame (`src-frames/<id>.html`, then `node tools/build-frames.mjs`, then `node tools/build-index.mjs <id>`). Workers copy the project to `~/Downloads/eaon-launch-video-<id>` and edit only their copy.

## Frame 10 "10-collage" (61.02–69.59, 8.57s)
- Ten real screenshots from `assets/shots/` sit as window cards in a 4-2-4 ring around the "eaon" + mark-tile lockup: 4 on top, 1 each side, 4 on the bottom. Twelve cards at 380–500px made a wall of screens at 1920×1080, so two were dropped. `work-thread-end` went because `pets-working` is the same thread with the fox added. `work-plan` went because frame 6 already covers Plan.
- Every caption note sits on its card's bottom-left corner. Line breaks are set by hand with `<br>`, because `text-wrap: balance` keeps the box at max-width and leaves empty padding. Notes on cards that bleed off-frame are clamped to x ≥ 30.
- "14 coloured themes" is a fan: `theme-light` sits behind `theme-synthwave`. The pets card is zoomed 1.45× from the bottom-right corner so the fox reads.
- The props (ruler, pencil, ruled card) are static inside the world, so the t=0 zoom-through has something to carry. With nothing else on screen at t=0, the entry was invisible.
- Motion: screens land in pairs on beats 0–4 (corners, then sides, then the cards nearest the wordmark), and each note lands half a beat after its screen. Everything is down by about 3.1s, then it holds. The exit zooms ×1.2 about the "eaon" word centre (842, 572).

## Gotcha (resolved): kit.css texture URLs 404
While kit.css was a linked stylesheet, its `url('assets/kit/…')` textures resolved relative to the sheet and 404'd. **Resolved:** `tools/build-index.mjs` now inlines kit.css into index.html's `<style>`, so its root-relative `url('assets/kit/...')` paths resolve against the project root in preview, check and render alike. Don't switch them to stylesheet-relative paths: HyperFrames lint rejects `../` traversal (`invalid_parent_traversal_in_asset_path`). The textures are also now seamless (periodic blur) — the first mottle tile showed a seam once it actually loaded.
