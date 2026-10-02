---
title: Worker faces: eyes-only animation and derived moods
tags: [eaon-desktop, workers, svg, animation, ui]
created: 2026-09-30T02:42:36.463Z
updated: 2026-09-30T02:42:36.463Z
---

# Worker faces: eyes-only animation and derived moods

`components/workers/WorkerFace.tsx` + the "Faces" block of `styles/workers.css`. The design spec fixes the look: a flat circle in the user's colour with two soft rounded-rectangle eyes; **the body never moves, only the eyes may**. Expressions from the spec: neutral (pills), happy (dome top, lower edge lifted into an arc), serious / fed up (flat lid, rounded bottom), angry (lid slanting down toward the nose), asleep (thin lines), dead / task failed (X eyes).

## Geometry

100×100 viewBox measured off the spec slides: eyes centred at x 33.3 / 66.7, y 40, 13.5 wide, ~25 tall. Shapes are drawn once for the left eye in eye-local coordinates; the right eye is the same path under `scale(-1 1)`, which is what makes the angry slant point inward on both sides. Eye colour flips to near-black when the body luminance > 0.62 (a white or yellow worker would lose white eyes). Asleep's line width is `max(2.2, 120/size)` so it stays ≥ ~1.2 px at the 18 px sidebar size.

## Moods are derived, not stored

`workerMood(worker, now)` in `shared/workers.ts`: paused → asleep, failed → dead, a `moodHint` the worker set with `set_status` (30 min) wins next, working → serious, a good turn → happy for 10 min, `asleep` status or 15 min idle with nothing scheduled → asleep, else neutral. Views re-evaluate via `useWorkers().now`, which ticks every 20 s, so moods expire without any main-process event.

## Animation gotchas

- **A CSS animation beats an inline style.** Eyes following the pointer write `transform` inline on `.wf-look`; the idle glance is a keyframe animation on the same element, which silently won. The follow hook sets `data-following` and CSS drops the animation while it is present.
- **Blink into a new expression**: the eye group is keyed by mood, so a mood change remounts it and replays `wf-open` (scaleY 0.1 → 1) — no path morphing needed.
- `transform-box: fill-box` on `.wf-eye` so the blink pivots on each eye, not the viewBox.
- **Reduce motion**: the app-wide rule shrinks durations to ~0, which makes *infinite* loops flicker every frame (same trap as [[Pets — sprites, moods and the desktop window]]). `.wf *` and the pulsing `.status-dot` get `animation: none !important` instead.
- `follow` adds one `pointermove` listener per face, so it is only on the big faces (team cards, profile, editor preview), never the 18 px sidebar ones.

Related: [[Eaon Workers engine: threads, heartbeats and mail]], [[Chat, Workers and ADE: the three tabs and Chat as the agent]]
