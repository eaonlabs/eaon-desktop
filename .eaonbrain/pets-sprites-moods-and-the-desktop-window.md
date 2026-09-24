---
title: Pets — sprites, moods and the desktop window
tags: [eaon-desktop, pets, svg, animation, electron, gotchas]
created: 2026-09-24T00:00:00.000Z
updated: 2026-09-24T00:00:00.000Z
---

# Pets: sprites, moods and the desktop window

## Layout

- `components/pets/species.tsx`: six hand-drawn SVG species (fox, cat,
  axolotl, owl, slime, dragon). All sit on one 100×100 grid (ground y≈91) and
  share a `Face` (glossy eyes, brows, mouths, blush), so one stylesheet can
  animate all of them. Outlines use a dark shade of each body hue rather than
  black, which keeps them readable on light and dark themes.
- `PetSprite.tsx` swaps the face and effects by mood. `pets.css` animates the
  named groups (`.pet-tail`, `.pet-ear--l/r`, `.pet-head`, `.pet-wing`,
  `.pet-breathe`, `.pet-move`, `.pet-pose`) keyed on `data-mood`.
- `Pet.tsx` handles hover (name tag), click-to-pat, drag reported as
  screen-pixel deltas, and `useStroll`. `usePetActivity.ts` maps the store to
  a mood: streaming → thinking; running tool part or pending approval →
  working; turn ended → happy (2.6 s) or concerned (7 s if `message.error`);
  2 min without input → asleep.
- `PetLayer.tsx` (in-app) is also the **source of truth for the desktop pet**:
  only the main renderer can see activity, so it sends `PetSnapshot`s through
  `window.api.pets.sync`. `features/pets.ts` relays them to a transparent
  window that loads the same bundle with `#pet` (branch in `main.tsx` →
  `DesktopPet.tsx`).

## Gotchas

- **Reduce motion.** The app-wide rule sets `animation-duration: 0.001ms`,
  which makes *infinite* loops flicker through their keyframes on every frame.
  pets.css sets `animation: none !important` for the sprite instead. Effects
  are designed to be fully visible at rest, so they just sit still.
- **transform-box specificity.** The generic `g { transform-box: view-box }`
  rule has to go through `:where(.pet-svg) g`. Otherwise it beats
  `.pet-eye { transform-box: fill-box }` and the blinks pivot on the wrong point.
- Groups that have a `transform=` attribute (effects placed with translate and
  scale) must not get `fill-box` centre origins, or the scale moves them.
  Only the animated leaves get fill-box.
- The art faces slightly left with the tail trailing right, so walking *right*
  is the mirrored pose (`data-facing='right'` flips).
- **The desktop window closes with the main window.** It hooks `closed` on the
  window that asked for it. On macOS the app outlives its window, and
  `app.on('activate')` only reopens Eaon when zero windows exist, so an
  orphaned pet window would stop the Dock icon from reopening the app.
- `setVisibleOnAllWorkspaces(..., { skipTransformProcessType: true })`.
  Without it the Dock icon blinks out on macOS.
- `focusable: false`, so patting the pet never steals focus from the app
  you're typing in.

## How it was verified

- **Art.** A scratch contact sheet (esbuild bundles the real `PetSprite` +
  pets.css, and an offscreen Electron window captures it after
  `document.getAnimations().forEach(a => { a.pause(); a.currentTime = T })`).
  It is the fastest way to review every species × mood at any size, including
  with `body[data-reduce-motion='on']`.
- **Desktop window.** The capture harness only captures the main window, so
  verification used a temporary hook in `openWindow` (offscreen when
  `EAON_CAPTURE` is set, `capturePage` after 2.5 s, logging bounds and DOM),
  since removed. Result: `#pet`, one `.pet`, no `.app`, transparent body,
  alwaysOnTop, not focusable, 250×218 for Large, and it closed when the
  setting went off.

Links: [[Eaon Desktop architecture]], [[Matching the Eaon Desktop Figma frames]]
