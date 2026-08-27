---
title: Model Providers page: real local-runtime logos and type alignment
tags: [eaon-desktop, providers, logos, css, design-system, settings]
created: 2026-08-26T01:57:30.279Z
updated: 2026-08-26T01:57:30.279Z
---

# Model Providers page: real local-runtime logos and type alignment

Two changes to the Model providers settings page, from one user request: add the
real Ollama and llama.cpp marks, and stop the page looking like it came from a
different app.

## Logos

`LlamaCppIcon` and `OllamaIcon` in `icons/brand.tsx` were hand-drawn SVG
approximations; they are now `ImageTile`s over real assets, like the other model
providers. Source images needed work first:

- **Ollama** — the supplied file was a 1200×630 **social/OG card**, so the
  llama's body runs off the bottom edge (content bbox reached y=629 of 630).
  Cropped to the llama (352×465) and pasted **flush to the bottom** of a 505²
  white canvas, so the tile's own edge hides the cut and the ears still get
  clearance at the top. A tight square crop on the head was tried first and
  looked cramped — same failure as the earlier NVIDIA logo, where a tight crop
  clipped the eye's tail. Pad, don't crop tight.
- **llama.cpp** — already square with a transparent background, but the glyph
  touched the top and bottom edges, which the tile's rounded corners would clip.
  Padded onto a 620² transparent canvas. Alpha is kept and the tile passes
  `bg="#ffffff"` (same approach as Mistral), since the mark is orange on
  transparency and would vanish on a dark tile.

The block comment above these icons claimed everything in the file is drawn
inline with "no third-party artwork in the bundle". That stopped being true when
the real provider logos landed; it now describes the split honestly.

## Type and surface alignment

The page had its own scale that appears nowhere else in Eaon. Fixed against the
conventions in [[Eaon Desktop architecture]]:

| Element | Was | Now (and what it matches) |
|---|---|---|
| `.provider-detail__name` ("OpenAI") | 24px / 600 / -0.01em | `var(--fs-title)` / 400 / -0.02em — same as `.settings__h1` |
| `.provider-detail__section-title` ("API keys") | 16px / 600 | `var(--fs-h2)` / 600 |
| `.providers-list__group` ("Local"/"Remote") | `--fs-xxs` / **700** / +0.08em | `--fs-sm` / regular / `--text-3` — same as `.sidebar__section`, `.settings__group`, `.settings__section-label` |
| `.providers-list__title` ("Model Providers") | `--fs-sm` / **700** / +0.06em / `--text-2` | `--fs-h2` / 600 / -0.01em / `--text` — a pane title, same voice as the sidebar's own |
| `.provider-row[data-active]` | `var(--surface-3)` | `var(--surface-2)` — same as `.nav-item[data-active]` |

The `--surface-3` selection was the "theme doesn't match" part: it is **pure
`#ffffff`** in the light theme and much lighter than `--surface-2` in dark, so
the selected provider read far brighter than every other selected row in the app.

`.settings__h1` was also tokenised from a hardcoded `28px` to `var(--fs-title)`
(same value) so the two headings that now have to match cannot drift apart. The
hardcoded px were also why this page ignored the Appearance font-size setting
while its neighbours followed it.

## Gotcha worth remembering

Do **not** point the `EAON_CAPTURE` harness at the real user-data dir to check a
UI change — it resets chats and projects. Run it with
`--user-data-dir=<throwaway>` instead; that also gives a clean default state.
Seeding a `settings.json` to get a specific theme does **not** work at all: the
harness force-writes `mode: 'dark'` at startup — see [[Floating curved sidebar]]
for the exact code and the false bug hunt it caused. Use a capture step after
`26-light-theme` instead.

Links: [[Eaon Desktop architecture]], [[Matching the Eaon Desktop Figma frames]]
