---
title: Popover sizing and overflow rules
tags: [eaon-desktop, ui, css, popover, menus, gotchas]
created: 2026-08-26T01:57:30.446Z
updated: 2026-08-26T01:57:36.555Z
---

# Popover sizing and overflow rules

Five bugs (the fifth self-inflicted while fixing the fourth), all triggered by
the same input: a provider with 100+ models and one
very long model id (`nemotron 3 super 120b extended`). Reported from a real
screenshot where the model list filled the window top to bottom and the "Model"
row had lost its own label. See [[Eaon Desktop architecture]].

## 1. `.menu` had no real height ceiling

`max-height: calc(100vh - 24px)` is not a cap — it is permission to become the
whole window. A refreshed OpenRouter/Ollama provider list is well over a hundred
entries, so the surface grew to full height, the placement clamp pinned it to
`margin` (8px), and it ran off the bottom.

Now `max-height: min(340px, calc(100vh - 24px))`. Global, on `.menu`, so no
popover in the app can ever do this. Verified the Add menu (9 rows ≈ 330px)
still renders fully without scrolling, so the cap does not cost anything real.

## 2. `getBoundingClientRect()` lies during the open animation

This is the subtle one and it affected **every** popover, not just this menu.

`Popover.place()` in `ui.tsx` measured the surface with
`getBoundingClientRect()`. That returns the **transformed** box, and `.menu`
opens with `animation: pop` starting at `scale(0.94)`. Measured mid-animation, a
340px menu reports ~320px — so the "does it fit?" test passed when it did not,
and the menu settled 20px past the viewport bottom (measured: `bottom: 809` in a
797px viewport).

`ResizeObserver` cannot save this: it observes the border box, which a transform
never changes, so it never re-fires.

Fix: measure the surface with `offsetWidth`/`offsetHeight` (layout box, ignores
transform). The *trigger* still uses `getBoundingClientRect()` — there we
genuinely want viewport-relative position. After the fix: `top: 449,
bottom: 789` in a 797 viewport, i.e. exactly the 8px margin.

**Rule for the future: never size a popover from a client rect while it
animates. Position from rects, size from offset\*.**

## 3. `.menu__item-hint` had `flex: none`

So a long hint could not shrink and pushed the row's own title clean out of the
flex box — the "Model" row rendered with no "Model" on it, which is exactly what
the user's screenshot showed. Now `flex: 0 1 auto` + `min-width: 0` +
ellipsis + `max-width: 50%`, so the label always wins the space fight.

## 4. `.chip--model` had `white-space: nowrap` and no width cap

Model ids are unbounded, so one long id stretched the chip and deformed the
composer toolbar. Now `max-width: 220px` with the name ellipsizing
(`.chip__model`) and `.chip__effort` pinned `flex: none` — the name gives way,
never the setting the user chose.

## Consequence worth knowing

Capping the menu made a 100+ item list *harder* to navigate (you can no longer
see it all at once), so `ModelSubmenu` was extracted from `ModelMenu` to hold
search state, and shows a `MenuSearch` filter once `models.length > 8`. Below
that threshold there is no filter — a 7-model list does not need one.

`.menu__search` also became `position: sticky; top: -5px` with its own
background, because `.menu` is the scroll container: without it the search field
scrolled away from the long list exactly when it was needed. The negative
`top`/`margin` cancel `.menu`'s 5px padding so the sticky edge sits flush.

## 5. The sticky header bled the list through it (a regression from #4 above)

Making the search header sticky introduced its own bug: it was painted with
`--menu-bg`, which is **deliberately translucent** — its comment in `tokens.css`
literally reads "Translucent so `.menu`'s backdrop-filter has something to
frost." That frosting applies to what is behind the *whole menu*. It does
nothing for the menu's own scrolling children, so ~20% of each list row stayed
legible straight through the search field as it scrolled underneath.

**Giving the header its own `backdrop-filter` does not fix this.** Tried it:
Chromium will not sample same-stacking-context scrolled siblings into a nested
backdrop root, so the ghost text only softened rather than disappearing. Do not
retry that approach.

The fix is an opaque background: `--surface-3`, which is the solid colour
`--menu-bg` is mixed from, so the header reads as the same material while
actually blocking what scrolls beneath. Confirmed opaque in dark theme too
(`color(srgb …)` with no alpha) and visually seamless against the menu.

**Rule: a sticky header over a scroll container must be opaque. A translucent
token that exists to feed `backdrop-filter` is the wrong paint for it.**

Measured on a scrolled list, in the band directly above the search icon and
placeholder (which must be blank background): **7.06% off-background pixels
before, 0.00% after**; luminance went from a 244–255 spread to a flat 254–255.
Note that naive pixel probes here are easy to get wrong — the search icon and
the placeholder text are legitimately dark, and sampling a band that includes
them reports "failure" for a correct render.

## Regression test

`capture.ts` step `34-model-menu-long` seeds a fake provider with 113 models
including the long id, opens the submenu, **scrolls the list so rows pass under
the sticky header** (the only state where bleed-through is visible), and logs a
`MEASURE {...}` line with
each menu's top/bottom/height/scrollable plus the chip width and overflow flag.
It lives at the **end** of STEPS on purpose — it mutates provider state via
`window.__perfStore`, so anywhere earlier it would pollute later screenshots.
Assert `bottom <= viewport` and `chipOverflows === false`. Step
`36-model-menu-dark` repeats it in the dark theme and logs `DARKBAR {...}` with
the header's computed background — assert it has no alpha.

Related: [[Glass-blur popovers and sidebar vibrancy]]
