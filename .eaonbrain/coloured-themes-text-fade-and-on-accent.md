---
title: Coloured themes, text fade and on-accent
tags: [eaon-desktop, appearance, theming, tokens, contrast, testing]
created: 2026-09-24T00:00:00.000Z
updated: 2026-09-24T00:00:00.000Z
---

# Coloured themes, text fade and on-accent

Fourteen coloured themes (Nord, Dracula, Tokyo Night, Catppuccin, Gruvbox,
Solarized, Rosé Pine, One Dark, Everforest, Kanagawa, plus originals Abyss,
Forest, Plum, Synthwave) joined the eight neutral ones. The catalogue now lives
in `src/renderer/src/lib/themes.ts` (`THEMES`, each with a `group`), and
Appearance renders it in two groups.

## No hard-coded neutrals left in tokens.css

Hovers, borders, toggle-off, send button, code-bg, scrollbar, shadows and the
light `--surface-3: #fff` were fixed greys, which looked wrong on a coloured page.
They are now mixed from `--bg`/`--fg`, and `--lift-color` is `--fg` in both
appearances. The mix amounts were **solved against the old values**, so the
neutral themes barely move (light alphas are about 1.11x the old black alphas,
because `--fg` is ~26 levels off black). Pixel diffs before and after on the
home screen and menus came out at 9 levels or less.

## Why `--text-fade` exists (the non-obvious part)

`--text-2` is `color-mix(fg, bg 38%)` (dark) / `34%` (light). That works for
the neutral themes (~18:1 fg/bg). Real coloured palettes are much closer
together (Nord ~9:1, Everforest ~6:1), and **no fixed percentage passes WCAG
AA for both kinds**. Several things were tried and rejected:
- Raising every fg past its palette makes it no longer Nord/Everforest.
- Tying the fade to `--contrast` squashes the surfaces flat.
- Pure CSS can't do it: relative colour syntax only exposes *one* origin's
  channels, so you can't take a max over the text and surface lightness.

So each theme tone carries `textFade` (0–1, default 1) in `lib/themes.ts`,
and `useTheme()` in App.tsx sets `--text-fade` by looking the preset up.
`--text-2/3/4` multiply their mix by it. It is deliberately **not stored in
settings**: the Appearance click strips it, since it belongs to the theme.

## `--on-accent`

Text on accent fills (`.btn--accent`, `.btn--provider`) was `#fff`, which is
about 2:1 on pastel accents. It is now a relative colour in tokens.css:
`oklch(from var(--accent) …)` steps to a deep shade of the accent once its
OKLCH L passes 0.69. Chromium 130 resolves this correctly: the capture probes
logged `oklch(0.22 …)` for Dracula and `oklch(1 0 …)` for Cobalt. A
consequence: the neutral Moss, Ember and Rose dark themes, plus Glacier and
Sand dark, now get dark button text, because white on them was under 3:1.

## The test reads tokens.css itself

`test/themes.test.ts` holds a small interpreter for the token subset (var,
calc, clamp, color-mix in srgb, the relative oklch). It evaluates every theme
in both appearances and asserts that `--text` and `--text-2` reach 4.5:1 on the
canvas, sidebar, surfaces 1–3, the menu (composited) and a hovered row, and
that on-accent reaches 3:1. If you add a theme, tune its `textFade` with it.
The Chromium probes matched its numbers.

## Gotcha: captures show translucent canvases washed out

With translucent sidebar on (the default), `body` paints canvas at 82% over a
transparent offscreen window, so dark captures look greyer than the real app.
This is the same before and after, so compare captures like for like, and
don't "fix" the colours based on it. See [[Glass-blur popovers and sidebar vibrancy]].

Links: [[Theme selector replaces the palette editors]], [[Accent colour tokens and the provider-accent fix]]
