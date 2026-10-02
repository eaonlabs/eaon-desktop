---
title: Pets — sprites, moods and the desktop window
tags: [eaon-desktop, pets, removed, electron, gotchas]
created: 2026-09-24T00:00:00.000Z
updated: 2026-10-01T02:23:26.580Z
---

# Pets: removed on 2026-09-30

The pets feature (six SVG companions in Settings → Pets, an in-app `PetLayer`
and an optional always-on-top desktop window) was **deleted** at the
co-founder's request ("delete pets"). It had never shipped: its only CHANGELOG
entry was under Unreleased 2026.6. See also
[[Pets are not an official feature — keep them out of marketing]].

## What went

`components/pets/*` (species, PetSprite, Pet, PetLayer, DesktopPet,
usePetActivity), `styles/pets.css`, `src/shared/pets.ts`,
`src/main/features/pets.ts` (+ its entry in `features/index.ts`),
`src/preload/features/pets.ts` (+ `window.api.pets`), Settings → Pets
(`pages/Pets.tsx`, nav entry, `Cat` icon), the `#pet` branch in `main.tsx`,
and `Settings.pets` in `shared/types.ts` / `defaultSettings`.

## What stayed, and where

- **The activity hook lives on for Discord.** `usePetActivity` became
  `useAppActivity()` in `components/discord/useAppActivity.ts`, returning an
  `AppActivity` (`idle | thinking | working | happy | concerned | asleep`)
  directly. The pet-only `poke()` is gone. See [[Discord Rich Presence]].
- **Old settings files.** `store.merge()` copies unknown keys straight through,
  so a removed feature's key would be read and written back forever.
  `store.getSettings()` deletes the keys listed in `REMOVED_SETTINGS`
  (`['pets']`) before merging. Add a key there when you delete a settings
  block. A stale `settingsPage === 'pets'` is harmless:
  `PAGES[id] ?? GeneralPage`.
- Leftover renderer localStorage `eaon.pet.offset` and userData
  `pet-window.json` are orphaned and ignored. Nothing cleans them up.

## Lessons still worth knowing for any new floating window

- **Reduce motion.** The app-wide rule sets `animation-duration: 0.001ms`,
  which makes *infinite* loops flicker every frame. Use `animation: none
  !important` instead (worker faces do this in `workers.css`).
- A window that outlives the main window breaks `app.on('activate')` if it
  counts all windows. Close it with the main window, and check `mainWindow`
  itself in `activate`.
- `setVisibleOnAllWorkspaces(..., { skipTransformProcessType: true })`, or the
  Dock icon blinks out on macOS. `focusable: false` keeps clicks from stealing
  focus.

Links: [[Eaon Desktop architecture]]
