---
title: Eaon Desktop architecture
tags: [eaon-desktop, electron, react, byok, architecture]
created: 2026-08-20T00:00:00.000Z
updated: 2026-08-20T00:00:00.000Z
---

# Eaon Desktop architecture

ChatGPT-style desktop client with bring-your-own-key model access, built to
match a set of 26 Figma frames supplied by the user.

## Stack

electron-vite + Electron 33 + React 18 + TypeScript + zustand. Plain CSS with
custom properties — no Tailwind, because the frames needed exact metric control.
Icons are `lucide-react`, which is the same icon set the frames were drawn with
(square-pen, panel-left, at-sign, hand are all unmistakably Lucide).

## Process split

- `src/main` — window, menu, JSON store (`store.ts`), encrypted key vault
  (`secrets.ts`), and all model traffic (`providers.ts`). Nothing network-facing
  runs in the renderer, which sidesteps CORS entirely.
- `src/preload` — `contextBridge` surface under `window.api`. API keys are never
  exposed to the renderer; it only learns `hasKey: boolean`.
- `src/renderer` — the UI. One zustand store in `state/store.ts`.

## BYOK model

Two client shapes cover everything:

- Anthropic goes through the official `@anthropic-ai/sdk`
  (`client.messages.stream`), with `thinking: {type:'adaptive', display:'summarized'}`
  and `output_config.effort`.
- Everything else (OpenAI, Gemini's OpenAI-compatible endpoint, OpenRouter,
  Groq, Ollama, plus user-added custom endpoints) uses one `fetch` SSE reader
  against `/chat/completions`.

The UI's five effort levels map 1:1 onto Anthropic's:
`light→low, medium→medium, high→high, extra-high→xhigh, ultra→max`.
For OpenAI-compatible providers `reasoning_effort` is sent optimistically and
the request is retried without it on a 400 that mentions the parameter — many
gateways reject it.

Model lists are seeded per provider and refreshed live from `/models`
(`client.models.list()` for Anthropic), so a new key immediately populates the
picker.

## Theming

The Appearance page exposes exactly four values per theme — accent, background,
foreground, contrast — and every surface in the app is derived from them with
`color-mix()` in `tokens.css` (`--u: calc(var(--contrast) * 0.055%)`, surfaces
are `--bg` lifted by multiples of `--u`). Changing the background hex or dragging
contrast re-tones the whole UI coherently instead of breaking it.
