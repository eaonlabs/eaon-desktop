---
title: Provider logos: Lobe Icons tiles and where they map
tags: [providers, logos, eaon-desktop]
created: 2026-09-30T13:57:59.913Z
updated: 2026-09-30T13:57:59.913Z
---

Most provider logos (and the ADE terminal agent marks) are square SVG tiles generated from Lobe Icons (`@lobehub/icons-static-svg` 1.95.1, MIT) by `scripts/make-provider-tiles.py` into `src/renderer/src/assets/providers/`. The licence text is in `assets/providers/NOTICE.md`. Older hand-sourced PNGs (openai, anthropic, gemini, groq, ollama…) and `mistral.svg` predate this; see [[Model Providers page: real local-runtime logos and type alignment]].

## Regenerating
`npm pack @lobehub/icons-static-svg@1.95.1 && tar xzf *.tgz && python3 scripts/make-provider-tiles.py package/icons`. Colour marks (`*-color.svg`) go on white. Single-colour marks are drawn in white on the brand colour. Their `currentColor` must be replaced with a concrete colour, because an `<img>` has no inherited colour and the mark vanishes.

## Gotchas
- **Kimi's mark is white-on-transparent.** On the default white tile it was invisible, so it gets a black background.
- Check new tiles on a contact sheet in both light and dark themes before wiring them. A tile can look fine alone and disappear against the list background.

## Mapping
In `icons/brand.tsx`, `LOGOS` holds one `ImageTile` per asset, and `BRAND_ICONS` maps provider ids to them. Regional and plan variants share a mark: `moonshot`/`moonshot-cn`/`kimi-coding` → kimi; `qwen*` → qwen; `xiaomi*` → xiaomimimo; `zai`/`zai-coding` → zai, while `zai-cn`/`zai-coding-cn` (BigModel) → zhipu. `github-copilot` uses the Copilot mark, not the GitHub cat. Anything unmapped falls back to `MonogramIcon`. The terminal panes use `AGENT_LOGOS` in `TerminalWorkspace.tsx`, and a plain shell keeps the lucide terminal icon.

## Scope
The logos appear only in Settings → Model providers and the ADE terminal. The model picker shows no provider logos.

## Trademarks
The MIT licence covers the drawings, not the marks. Showing a logo to identify a provider is the intended use; anything like marketing needs the owner's permission. Anthropic's guidelines say so explicitly.
