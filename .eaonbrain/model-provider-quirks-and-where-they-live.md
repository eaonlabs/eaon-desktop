---
title: Model provider quirks and where they live
tags: [eaon-desktop, providers, adapters, compat, openai-compatible, ollama]
created: 2026-09-24T13:44:37.000Z
updated: 2026-09-29T14:29:40.172Z
---

# Model provider quirks and where they live

The provider layer is four adapters (`anthropic`, `openaiChat`, `openaiResponses`,
`ollama`) plus a `router` for providers that mix wire formats. Everything
provider-specific is decided in **`src/main/providers/compat.ts`**, keyed on the
provider id *or the host* — so a custom endpoint pointed at `api.deepseek.com`
gets DeepSeek's treatment. Source of truth for the rules was Eaon Code
(`~/Downloads/eaon-code-main/packages/ai/src/api/openai-completions.ts`
`detectCompat` and `providers/data/*.json`). Model lists are no longer hand
seeds in `catalog.ts`: they are generated from Pi's data and models.dev, see
[[Model catalog: generated from Pi and models.dev, with user overlays]].
`efforts: []` means "this endpoint takes no effort for this model" and hides
the picker; `effortReaches` in `compat.ts` enforces it per endpoint.

## Quirks that break things if you forget them

- **Thinking switches differ per host**: DeepSeek/Xiaomi/Kimi K2 `thinking:{type:'enabled'}`,
  Z.ai `thinking:{type:'enabled', clear_thinking:false}` + `tool_stream`, DashScope
  `enable_thinking`, Together `reasoning:{enabled}`, OpenRouter `reasoning:{effort}`.
- **`reasoning_content` must go back on assistant messages** for DeepSeek, Xiaomi
  MiMo and Kimi K3 (empty string across turns, the real text within a turn via
  `replay`), or tool-call turns 400.
- **Gemini 3 on the OpenAI endpoint** returns `extra_content.google.thought_signature`
  on tool calls and rejects replayed calls without one. Calls from earlier turns or
  other models get Google's documented placeholder `skip_thought_signature_validator`.
- **OpenRouter** needs `reasoning_details` replayed within a turn (Gemini signatures,
  encrypted OpenAI reasoning ride in it).
- **vLLM-backed hosts** (Together, Fireworks, Baseten, DeepInfra, Novita…) reject
  prompt + `max_tokens` > window, and catalogs often list output cap = window —
  `clampOutputToWindow` in `adapters/types.ts`.
- **Dotted Claude ids** (`claude-opus-4.8` on Copilot/OpenCode/Cloudflare) fell into the
  budget family and got `budget_tokens`, which 4.7+ rejects. `models.ts` hyphenates
  versions before family detection — but only for Claude; `gpt-4.1`/`gemini-2.5`
  regexes need the dots, so don't hyphenate globally.
- **Third-party Anthropic-compatible hosts** (MiniMax, Kimi For Coding, Copilot) get no
  betas and no top-level `cache_control`; caching falls back to a breakpoint on the last
  block, and `adapterFor` gives them `managesContext: false` so the loop still prunes.
- **Inline `<think>` tags** are split by `adapters/thinkTags.ts`, only when the block
  opens the reply (a coding answer mentioning the tag stays text).
- **Azure** takes the key as `api-key`; every URL shape normalises to `/openai/v1`.
  **Cloudflare AI Gateway** takes the token as `cf-aig-authorization` and must not see
  an `Authorization` header (it would forward it upstream).
- **Hyperbolic's serverless inference is decommissioned** (checked 2026-09-24: every
  chat call returns "This inference endpoint has been decommissioned"), so it is not
  in the catalog. Probe a host (`curl -X POST .../chat/completions`) before adding it.

## Ollama: why the native adapter

Ollama's `/v1/chat/completions` cannot set `num_ctx`, so agent prompts were silently
truncated to the model's small default window. `adapters/ollama.ts` posts to
`/api/chat` with `options.num_ctx = contextWindowFor(...)`; `refreshModels` reads
`/api/show` so each model's window is `min(trained, LOCAL_CONTEXT=32768)` (cloud
models: full window, no num_ctx) and capabilities (`tools`, `thinking`, `vision`,
and non-`completion` models dropped). gpt-oss takes `think: 'low'|'medium'|'high'`,
others `true`. Note `prompt_eval_count` excludes KV-cache-reused tokens, so Ollama
input usage under-reports on later rounds.

Related: [[Subscription sign-in: ChatGPT, Copilot and OpenRouter]], [[Eaon Desktop architecture]], [[Local model hub (Models page)]]

Related: [[Provider adapter gotchas: retry-after, image tokens and timeouts]]

Related: [[Local API Server: origin rules and never routing to itself]]
