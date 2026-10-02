---
title: Launch film: frame 07 browser and computer use, live transcript gotchas
tags: [launch-video, hyperframes, gotcha, browser-extension, computer-use]
created: 2026-09-28T13:39:43.570Z
updated: 2026-09-28T13:39:43.570Z
---

# Launch film: frame 07 browser and computer use

Frame `07-browser-computer` (12.8s, video 48.0–60.8, the music's breakdown) of the 2026.6 launch film (`~/Downloads/eaon-launch-video`, outside this repo). It shows the features working on re-hosted app DOM. See [[Re-hosting real Eaon UI in videos and docs]] and [[Launch film: frame 11 sign-off and project-wide gotchas]].

## What it does
- **Browser (0–6.4):** the `work-browser-top` Work chat builds row by row, one `Browser` call per 0.4s. The active row shows the running orb and no check; a done row gets its icon back and the check pops in. The screenshot row grows its image with a white "camera flash". The screenshot then lifts out of the transcript to become a Chrome-tab card on the desk while the window pans away blurred. The real extension popup (Connected, agent's tab "Tidewater — Coastal stays") lands beside the card, and the pointer clicks "Check availability".
- **Computer use (6.4–12.8):** the `work-computer` chat builds. The real indicator pill slides down at the top of the frame, and its dot pulses on the 1.6s music pulse. The camera zooms to 3.4× into the second screenshot, where a small pointer glides from Export To to PDF… and clicks. The camera then pulls back for the type/key rows and "Done — Q3 numbers.pdf…", pushes in on that phrase, and exits upward on the drop.

## Gotchas
- **The app CSS is `box-sizing: border-box`.** To collapse `.tool-images` and grow it back, restore `height` to the *border-box* height (`getBoundingClientRect().height`), not `clientHeight - padding`. If you don't, every row below it ends up 15px higher than you measured, and cameras and pointers aim at the wrong place.
- Measure everything (scroll targets, thumbnail rects, the `.thread__inner` offset) **before** collapsing or hiding anything. After that, place pointers inside `.thread__inner` (`position: relative`) so they scroll with the content.
- Put `overflow-y: scroll` on the re-hosted `.thread`. Otherwise the transcript jumps 5px sideways when it first overflows, because the scrollbar gutter appears.
- In the snapshot, a repeated `<img>` (which `build-frames` rewrites to `src="…?n=2"`) rendered as a broken image (seen with `cursor.svg`). For repeated props, use a CSS `background` instead.
- The running tool glyph is the ThinkingOrb `<canvas>`. Replay it from `thinking-orb/tool-searching-14-*` as a 48-frame sprite (`assets/app/orb-tool-14.png`, 672×14 background-size). Step `backgroundPosition` from one timeline clock at 40ms per frame. Frame 06 uses the identical sprite.
- The extension popup and the computer-use indicator are **not renderer DOM**. They have their own inline CSS, so they are re-hosted with scoped CSS (`.eaon-ext`, `.eaon-ind`). The popup's `prefers-color-scheme: dark` block is forced, because headless Chrome renders light. Converter: `SP/kit-build/ext-popup-to-fragment.mjs`.
- The extension's Chrome tab group is titled "Eaon" and coloured **blue** (`extension/lib/tabs.js`, `GROUP_COLOR = 'blue'`), not coral.
- HyperFrames lint caps a composition at **300 structural lines**. `<style>` bodies don't count, but inlined fragment markup does. Collapse fragment whitespace and keep the script compact.
