---
title: Truncated provider streams are errors
tags: [eaon-desktop, providers, adapters, streaming, gotcha, testing]
created: 2026-09-28T01:15:58.837Z
updated: 2026-09-28T01:15:58.837Z
---

# Truncated provider streams are errors

A stream that closes before the provider says it finished is **not an answer**. Before 2026-09, three adapters returned whatever had arrived:

- `openaiChat.ts` broke out of the read loop on `done` and never checked for `finish_reason` or `[DONE]`. It also dropped a last `data:` line with no trailing newline.
- `ollama.ts` never checked for the `done: true` chunk.
- `anthropic.ts` is subtler. In `@anthropic-ai/sdk` 0.120 a message is only recorded on `message_stop`, so a cut **before** it already threw `stream ended without producing a Message with role=assistant`. The loop just didn't recognise that text as retryable. A `message_stop` **without** a `message_delta` (no `stop_reason`) did slip through, with a cut-off tool input filled in by the SDK's partial-JSON parser — a call that looks whole.

Now:
- OpenAI-chat requires `finish_reason` **or** `[DONE]`.
- Ollama requires the `done` chunk.
- Anthropic normalises the SDK error and refuses a null `stop_reason`.
- All three throw `The response stream ended before it finished. Try again.`
- `loop.ts isRetryable` matches `stream ended before`, so a cut-off with nothing on screen is retried (note says "The reply was cut off"). One that already streamed text surfaces as an error rather than duplicating text.

This matches Eaon Code's `packages/ai` (every api/*.ts throws "stream ended without …"; `supportsFinishReason` defaults true).

**Audit lesson:** a sub-agent audit claimed the Anthropic path accepted a stream cut before `message_stop`. It did not — the "without fix" test failed only on the error wording. Always run the new test against the old code and read *why* it fails.

**Test gotcha:** a failing `assert.rejects(...)` before `server.close()` leaves the HTTP server open and `node --test` hangs forever. Close servers in `finally` / `.finally()`.

Tests: `test/openaiChat.test.ts`, `test/ollama.test.ts`, `test/anthropic.test.ts`, and "a reply cut off before anything was shown is retried" in `test/loop.test.ts`. See [[Model provider quirks and where they live]].
