---
title: Launch film: frame 11 sign-off and project-wide gotchas
tags: [launch-video, hyperframes, gotcha]
created: 2026-09-28T04:10:20.791Z
updated: 2026-09-28T04:10:20.791Z
---

# Launch film: frame 11 sign-off and project-wide gotchas

The launch video lives in `~/Downloads/eaon-launch-video`, outside this repo. It is an 81.3s HyperFrames film, and each frame is authored in `src-frames/<id>.html` and built with `tools/build-frames.mjs`.

## Music grid
- Kick onsets were measured from `assets/audio/bgm.mp3` with ffmpeg and an energy-flux pass. The beat grid (0.5714s) is anchored on the frame starts: 61.02 and 69.59 both land on kicks.
- The "final hit" at 78.87 (frame 11 local 9.28) is **off-grid**. It lands about 0.14s after beat 16 (9.14), at the end of a drum fill. Land the end card on 9.28 anyway; the other reveals go on k*0.5714 from the frame start.
- Frame 11 local 5.14 (beat 9) is the strongest kick of that section. The scene-2 kinetic line starts there, so its last word ("desktop.") lands on 8.0 and holds for about 1s.

## Gotchas
- (Resolved) kit.css texture URLs once 404'd as `assets/kit/assets/kit/*.png` when kit.css was a linked sheet. **Resolved:** `tools/build-index.mjs` now inlines kit.css into index.html's `<style>`, so its root-relative `url('assets/kit/...')` paths resolve against the project root in preview, check and render alike. Don't switch them to stylesheet-relative paths: HyperFrames lint rejects `../` traversal (`invalid_parent_traversal_in_asset_path`). The textures are also now seamless (periodic blur) — the first mottle tile showed a seam once it actually loaded.
- Two `<img>` tags with the same `src` in one frame trigger lint `duplicate_media_discovery_risk`. For a repeated prop, use a div with a `background` url.
- Stacked cards whose words hide under each other need `data-layout-allow-overlap` and `data-layout-allow-occlusion` on the text element itself. The check does not inherit these from an ancestor. `data-layout-allow-overflow` does work on an ancestor (it uses `closest`).
- Z-seam sign rule (cut-the-curve skill): an oversized 1.25→1 arrival must be preceded by a *receding* exit (1→0.8), not a forward push.
