---
title: Eaon desktop app map
tags: [desktop-app, architecture]
created: 2026-08-07T23:26:34.567Z
updated: 2026-08-07T23:27:05.766Z
---

Orientation note for the macOS app. Start here, then follow the links.

## Layout

- `Eaon-desktop/Services/` — models and logic. `ChatViewModel` lives in `ViewModels/` and is the centre of gravity (~3,900 lines): sessions, streaming, the agent tool loop, swarm invocation.
- `Eaon-desktop/Views/` — SwiftUI. `ChatHomeView` is the transcript, `ChatComposer` the input, `SettingsRootView` the settings shell.
- `Eaon-desktop/Theme/ThemeColors.swift` — every colour token. No raw hex in views.
- `Tests/EaonDesktopAgentTests/` and `Tests/EaonDesktopSecurityTests/` — `swift test`, currently 57 tests.
- Also in this repo: `eaon-cli/` (TypeScript, bundled into the app), `eaon-tauri/` (Windows/Linux), `browser-extension/` (Chrome, for `BrowserBridge`).

## Per-conversation state

`GenerationSession` (a **`final class`**, `fileprivate` in `ChatViewModel`) holds everything about one in-flight turn: `task`, `loadingStatusText`, `agentActivityText`, `agentSteps`, `liveSwarmTranscript`. Top-level computed properties like `isGenerating` read the **currently visible** conversation, so a background chat generating never affects the composer's busy state. See [[Agent step trail is derived, not reported]].

## Model routing

Three backends behind one interface: Eaon-hosted, BYOK/custom OpenAI-compatible providers, and local (Ollama, llama.cpp, MLX — all spawned as **separate processes**, never linked in). `BackgroundCompletion.requestRaw` is the "ask the model something, get text back, whichever backend" primitive used by titling, compression and [[Agent Swarm architecture]].

Local backend discovery does a fast directory scan, then asks the user's **login shell** where the binary is — `pip install mlx-lm` puts console scripts in venvs, conda, pyenv and pipx, none of which a fixed path list finds.

## Streaming

SSE. Terminal signals are `[DONE]` **and** `finish_reason` — accepting only the first caused replies to be cut off. `StreamContinuity` retries a dropped connection up to 3 times with backoff.

## Chat vs Work

Two modes with different system prompts, different tools and **separate histories**. `chatIdentityPrompt` (~103 tokens) is always sent in Chat mode; `usesCompactPrompt(modelId:)` picks a smaller prompt for small models, checked in order: parameter count, then tier names (`nano`, `mini`, `haiku`, `flash-lite`, `gemma`, `phi-3`…), then whether `LocalAIManager` owns the model. Without this, small models invented their own tasks and Chat mode behaved like a coding agent.

## Conventions

- Titles are written by the model after the first exchange (`ConversationTitler`), never the truncated first message, and never overwrite a title the user set.
- Optional `Bool`s on persisted models (`hasModelTitle`, `isPinned`) are optional **for decode safety** — a non-optional with a default makes every previously-saved record fail to decode and vanish.
- UI: [[Settings page layout conventions]], and verify visually via [[Verifying SwiftUI views by rendering them headlessly]].
- Shipping: [[Releasing the Mac app end to end]].
- Careful: [[Other sessions edit this repo concurrently]].

Related: [[Cloud Sync end to end]]
