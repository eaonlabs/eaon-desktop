---
title: Provider adapter gotchas: retry-after, image tokens and timeouts
tags: [eaon-desktop, providers, adapters, gotcha]
created: 2026-09-29T14:29:03.062Z
updated: 2026-09-29T14:29:03.062Z
---

Adapter-level traps found in the Sep 2026 bug pass (`src/main/providers/adapters/`). See [[Model provider quirks and where they live]] for per-vendor rules and [[Truncated provider streams are errors]] for stream completeness.

- **`Number(null)` is 0.** Anthropic 429/529 without a `retry-after` header produced a 0 ms wait — three instant retries, then failure. Use `retryAfterFrom(headers)`. The SDK's `APIError.message` is status plus raw JSON; `APIError.error` is the parsed body — build messages from that ("529: Overloaded").
- **Count images at 1,600 tokens**, as `agent/context.ts` does (`estimateRequestTokens`). Counting base64 as text made four screenshots "fill" a 200k window and clamp every reply to 1,024 tokens.
- **`model_context_window_exceeded` maps to `max_tokens`.** The SDK fills a half-streamed tool input from partial JSON, so treating it as `tool_use` could execute a truncated `write_file`.
- **Tool arguments go through `toolInput()`**: `"null"`, double-encoded JSON or a non-object otherwise reached the loop and threw.
- **Only a numeric `index` identifies a streamed tool call**; `index: null` merged parallel calls into one.
- **DeepSeek `insufficient_system_resource`** is an interrupted reply → overloaded error (retried), not a finish.
- **Credential fallback** also moves on for 402, OpenAI `insufficient_quota` and Anthropic "credit balance is too low", not just 401/403.
- **Node's fetch abandons a request with no response headers after 5 minutes** (`cause.code === 'UND_ERR_HEADERS_TIMEOUT'`). A local model on CPU can spend that long reading a long prompt. It is the same "fetch failed" as a server that isn't running, so `isHeadersTimeout()` tells them apart; local providers report `HEADERS_TIMEOUT_MESSAGE` instead of "Couldn't reach … Start it", and are not retried. Raising the limit would need an undici dispatcher (`undici` is not a dependency).
- Our own ollama/openaiChat adapters mint deterministic call ids; the loop de-duplicates them (see [[Agent loop cancellation and tool robustness]]).

Still open: ChatGPT/Copilot token refresh and Anthropic model listing have no timeout; any Codex 429 without `rate_limit_exceeded` becomes a non-retryable "usage limit"; discovery on window focus resets user-renamed local model labels.
