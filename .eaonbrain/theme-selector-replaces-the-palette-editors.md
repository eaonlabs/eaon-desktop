---
title: Theme selector replaces the palette editors
tags: [eaon-desktop, appearance, theming, tokens, settings]
created: 2026-08-26T02:15:15.048Z
updated: 2026-08-26T02:15:15.048Z
---

# Theme selector replaces the palette editors

The Appearance page used to carry two big cards ("Light theme" / "Dark theme")
with raw Accent / Background / Foreground colour chips, a contrast slider, a
dead **Import** button and a `preset` dropdown that only applied to one
appearance at a time. The user asked to remove them and get a theme selector
that actually changes how the app looks.

## The important discovery

`--accent` appeared in exactly **one** CSS rule in the whole app
(`app.css:87`). Every toggle, link and focus ring was a hardcoded blue —
`--toggle-on: #0a84ff`, `--link: #4a9eff`, `--focus-ring: rgba(10,132,255,.9)`.
So the pre-existing preset dropdown technically "worked" and changed almost
nothing visible. A theme picker on top of that would have been theatre.

Fixed in `tokens.css` — those three now derive from the accent in both blocks:

    --toggle-on: var(--accent);
    --link: color-mix(in srgb, var(--accent), #ffffff 26%);   /* dark  */
    --link: color-mix(in srgb, var(--accent), #000000 18%);   /* light */
    --focus-ring: color-mix(in srgb, var(--accent), transparent 10%);

`--provider-accent` (the warm Model Providers orange) is deliberately left fixed
— see the comment on it in tokens.css.

**Consequence for existing installs:** the shipped default accent was
`#339CFF` light / `#0169CC` dark, which is *not* the blue the toggles used.
`defaultSettings` is now `#0A84FF` for both so a fresh install looks exactly as
before, but an install with the old accent stored will show slightly deeper blue
toggles until any theme is clicked once.

## How a theme works

Every surface, border and text tone is mixed from `--bg`, `--fg` and
`--contrast` (see the derivation block in tokens.css), so a theme only needs
**four values per appearance** — accent, background, foreground, contrast — to
restyle the entire interface. `THEMES` in `Appearance.tsx` holds eight: Codex,
Graphite, Nord, Indigo, Moss, Ember, Rose, Sand.

Clicking one writes **both** appearances at once
(`{ light: {preset, ...}, dark: {preset, ...} }`), so switching Light/Dark never
drops you into a different theme. Active state is `a.light.preset === name`.

Previews are painted in each theme's own colours via `color-mix()` in inline
styles (Chromium 130 supports it), rendered for the *resolved* appearance —
`useResolvedTone()` mirrors `useTheme`'s system/light/dark logic with a
`matchMedia` listener, so on `system` the swatches show what you would actually
get right now rather than an arbitrary half.

Verified by seeding the Ember palette into an isolated user-data dir and diffing
pixels against Codex: canvas `(37,37,37) → (42,38,38)`, sidebar
`(17,17,17) → (20,16,16)`, toggle `(10,128,247) → (247,104,59)`.

## Kept, not deleted

**UI font** and **Translucent sidebar** lived inside the removed cards. They are
app preferences rather than palette colours, so they moved into the existing
Preferences card and now write to both appearances at once (a different UI font
per appearance was never useful). Deleting the translucent-sidebar toggle would
have silently removed the feature in [[Glass-blur popovers and sidebar vibrancy]].

## Gotcha that cost time

Deleting `ThemeEditor` by slicing from its `function` keyword to the start of
`luminance` also swallowed **`DockGlyph`**, which sat between them — and this
repo **has no git commits**, so there was nothing to restore from. It was
recovered from `out/renderer/assets/index-*.js`: the production bundle is *not*
minified, so the previous version of any component can be read straight out of
it and re-transcribed to JSX. Worth remembering as the recovery path here, and a
reason to check what sits between two functions before deleting a range.

Links: [[Eaon Desktop architecture]], [[Glass-blur popovers and sidebar vibrancy]]
