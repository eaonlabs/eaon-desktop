---
title: Launch film: frame 09 montage and re-hosted SVG gradient gotcha
tags: [launch-video, hyperframes, gotcha, gsap]
created: 2026-09-28T14:03:50.168Z
updated: 2026-09-28T14:03:50.168Z
---

# Launch film: frame 09 montage (v2 polish) and gotchas

The launch film lives outside this repo (`~/Downloads/eaon-launch-video`; workers edit a copy such as `~/Downloads/eaon-launch-video-09-montage`). Frame `09-montage` runs 16.0s (video 67.2–83.2). Seven shots cut on the 0.8/1.6s grid, and every shot shows the real re-hosted DOM doing something:

- **Scheduled (0–3.2):** base DOM is `scheduled-just-ran`. The Stop button and the "Running · started now" line are cloned from `scheduled-running`. The idle "Succeeded 3 days ago" line is cloned from `scheduled`, so the Next-run text stays the same in every state. Click on 1.6, Succeeded on 2.4.
- **Plugins:** `.page__scroll` scrolls to 2748 (the Zapier to Todoist sign-in rows) while the chip counts from 10 to 67.
- **Skills:** five switches go off → on every 0.4s. Each knob moves x 0→12 by tween (inline transform overrides the CSS `translateX(12px)`), the switch background tweens between the computed on/off colours, and the subtitle "N of 9 on." counts up.
- **Models:** base DOM is `models-downloading`, with a Get button cloned from the MiniCPM card. The progress label and fill, the sidebar ring's `stroke-dashoffset` (dasharray 80.11) and the Downloads panel cloned from `downloads-panel` all follow one pct(t).
- **Providers:** `.providers-list__scroll` runs from 0 to its maximum (all 55).
- **Themes:** six theme windows are stacked, and clip-path `circle(r at 402px 26px)` wipes grow from the mode switch and land on the 0.4 grid.
- **Pets:** push in, then working → happy at 14.8, with the app's own `pet-hop` keyframes replayed in GSAP (svgOrigin `50 92`). Axolotl and slime sprites, cloned from `pets-sprites`, slide out from behind the window onto the desk (they sit under the window in z-order).

A vertical motion blur on the fast scrolls is an SVG `feGaussianBlur stdDeviation="0 σ"`. σ comes from the analytic scroll velocity, and the filter is set only while σ > 0.4.

## Gotchas
- **Re-hosted fragments lose SVG gradient fills.** `to-fragment.mjs` strips every id, so `fill="url(#r0-main)"` (pet fur) and `url(#sk34a..c)` (skill cube icons) point at nothing. The fox renders with a black body and the skill tiles render blank. Also affected: `settings-pets`, `settings-appearance*` (`dock-color`). Frame 09 re-links them at mount, per SVG and in document order, with unique `f09-g*` ids. A proper fix would rename ids with a per-fragment prefix in the converter instead of dropping them.
- **Shared elements driven by several `fromTo` tweens break on backward seeks.** A rewound `fromTo` re-applies its from-values. One click ring reused for three clicks showed up at the wrong spot, fully visible. The pointer, ring and all discrete state are therefore drawn by one pure `render(t)`, called from a single clock tween's `onUpdate` and once at mount. Out-of-order seek screenshots now match forward seeks pixel for pixel.
- HyperFrames lint `composition_file_too_large` caps a composition at **300 structural lines**. `<style>` bodies collapse to one line, but every newline inside an inlined fragment counts (about 3 per fragment).
- In puppeteer, `page.evaluate(() => tl.seek(t))` hangs, because it tries to serialise the returned timeline. Return a primitive instead.
- Kill every CSS animation inside the re-hosted app (`#root .eaon-app * { animation: none !important }`) and drive spinners, the gear and sparkles with GSAP.

Links: [[Re-hosting real Eaon UI in videos and docs]], [[Launch film: frame 11 sign-off and project-wide gotchas]], [[Pets — sprites, moods and the desktop window]]
