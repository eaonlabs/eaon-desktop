---
title: Launch film: frame 06 modes (v2) — live app states and check gotchas
tags: [launch-video, hyperframes, gotcha]
created: 2026-09-28T13:27:13.738Z
updated: 2026-09-28T13:27:13.738Z
---

# Launch film: frame 06 "06-modes" (v2 polish pass)

Frame 06 runs 14.4s (video 33.6–48.0): three panels of 4.8s for Plan, Swarm and Goal. Each panel has the serif mode word on the paper at the left and a 1.34× crop of the real Work transcript (app px 421..1101 × 124..797) at the right. The source is `src-frames/06-modes.html` in the worker copy `~/Downloads/eaon-launch-video-06-modes`. See [[Re-hosting real Eaon UI in videos and docs]] for how the app DOM is captured.

## How the app is made to act
- **One live layer per panel.** The *finished* capture is the base (`work-swarm-done`, `work-goal-done`). The parts that only exist in the running capture are cloned out of a hidden `work-swarm` or `work-goal` copy: the `send--stop` button, the `Loader2` spinner, and the active goal banner. The hidden copy is then removed at setup. The two banners overlap in `grid-area: 1/1` inside `.composer-dock__pinned` and crossfade.
- **Discrete state is a pure function of panel time.** A proxy tween (`o.t` from 0 to 4.8) calls `fn(t)` from `onUpdate`, `onComplete` and `onReverseComplete`. `fn` sets the row status, activity text, step counts, orb frame, spinner rotation, `scrollTop`, the counter value and stop/send. This makes the frame seek-safe in both directions. The HyperFrames renderer does fire `onUpdate` on seek.
- **ThinkingOrb.** The running tool glyph is a canvas that re-hosts blank. `assets/app/orb-tool-14.png` is a sprite of the 48 real `thinking-orb/tool-searching-14` frames: 1344×28, shown at 672×14, one frame per 40ms. It is a CSS background, so repeating it does not trip the duplicate-`<img>` lint.
- **Spinners.** Set `#root .spinner { animation: none !important }`, then rotate the svg at 400°/s from the driver (the app's 900ms turn).
- **Plan card.** It grows as its steps arrive. Card heights for k steps, for all steps plus actions, and for the approved state are measured at setup, and `height` is tweened with `overflow: hidden`. On approval, `data-status="approved"` is set and the `plan-card__badge` is rebuilt from PlanCard's markup (Check 12/2.4 plus "Approved"). A cloned user row carries the real `approvePlan` text: "Approved — carry out the plan. Keep the checklist updated as you go."
- **Camera.** A `#f06-world` wrapper holds the paper, props and panels. The paper sits inside it with a bleed of `inset: -540px -960px`, so a push never shows its edge. Plan opens pushed in (1.45×) on the research rows and pulls back at 1.6s as the card rises. Swarm pushes in (1.5×) at 0.6s so the 12px agent rows are legible, then pulls back at 3.2s when the findings merge.

## Gotchas (lint / check)
- **`composition_file_too_large`.** The limit is 300 physical lines of the *built* `compositions/frames/<id>.html`. `<style>` blocks collapse to one line. Each `<!--@frag-->` adds 4–7 lines, so a frame script around 250 lines needs compact code.
- **Contrast.** The check treats the coral ✱ in the kicker as text (2.06:1, fail). Render it with `.kicker::before { content: '\2731' }` instead. Coral `#F68A66` on paper is about 2.05:1, which also fails the 3:1 large-text rule. For coral *text*, use `#C87053`; the check suggested that value.
- **`content_overlap`.** A mono label above a 220px EB Garamond number collides with the number's ascent box. Put `data-layout-allow-overlap` on both text elements.
- **Seam pop.** When a later panel is shown with `tl.set(panel, {opacity:1}, a)` and its entrance `fromTo` runs `immediateRender:false` with a small offset, the word shows at rest for one or two frames. Use `immediateRender: true` on a panel's entrance tweens; it is safe when each element has only one `fromTo`.

Related: [[Launch film: frame 11 sign-off and project-wide gotchas]], [[Work modes: plan, goal and swarm]].
