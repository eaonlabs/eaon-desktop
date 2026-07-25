# Eaon for Windows & Linux

The cross-platform Eaon desktop app: a Rust core with a React UI, built on
Tauri 2. This is a ground-up rebuild (2026.3.x was the first generation) —
same product as the native macOS app in `../Eaon-desktop/`, engineered for
Windows and Linux.

## What's here

- **Chat** with Eaon's hosted models (API key or the Free Week trial), any
  OpenAI-compatible / Anthropic / Gemini key you bring, or fully local
  models via Ollama — streaming, reasoning disclosures, vision attachments,
  background generation per conversation.
- **Agent mode** — the model writes real files, runs commands, and searches
  code on your PC, with a Sandboxed/Auto safety model and per-call
  confirmation.
- **Models library** — curated Ollama catalog with hardware-fit estimates,
  live pull progress, verified deletes.
- **Memory, Skills, MCP plugins, web search, image generation** (cloud or
  local Stable Diffusion), **Local API Server** (OpenAI-compatible loopback
  endpoint), custom instructions, per-request sampling parameters, proxy
  support.
- One `state.json` in the app data dir; 2026.3.x data migrates in place.

## Architecture in one paragraph

The webview has **no network access at all** (strict CSP): every HTTP
request, file write, and process spawn happens in the Rust core
(`src-tauri/src/`), exposed as typed commands consumed through one wrapper
file (`src/core/ipc.ts`). Streaming crosses the boundary over Tauri
Channels. The React side is split into framework-free logic (`src/core/`,
`src/chat/`), zustand stores (`src/state/`), and views (`src/ui/`) — no
file over ~400 lines, one component per settings pane.

## Develop

```sh
npm install
npm run tauri dev      # the real app, live reload
npm run check          # TypeScript
(cd src-tauri && cargo test)
```

## Build installers

See [BUILDING.md](./BUILDING.md) — TL;DR: CI builds Windows + Linux
installers on a tag push (or a manual workflow run); local `npm run tauri
build` produces your current platform's bundle.
