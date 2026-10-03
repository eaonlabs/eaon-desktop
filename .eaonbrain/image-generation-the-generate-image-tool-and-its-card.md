---
title: Image generation: the generate_image tool and its card
tags: [eaon-desktop, agent, tools, images, transcript]
created: 2026-10-02T23:18:53.430Z
updated: 2026-10-02T23:18:53.430Z
---

Since Oct 2 2026 the agent (Chat, workers) can make images: `generate_image`, in `src/main/features/images/` (`generate.ts` for the providers and saving, `tool.ts` for the tool and its registration). It's registered from `agent/sources.ts`.

## Providers: the user's own keys, OpenAI first
- **OpenAI** `gpt-image-1` with `secrets.get('openai')`. `POST /v1/images/generations` takes JSON `{ model, prompt, n, size }`; edits go to `POST /v1/images/edits` as multipart with `image[]` per file. The response is `data[].b64_json`. Sizes are only `1024x1024` / `1536x1024` / `1024x1536`; `openaiSize()` maps any requested shape to the nearest one.
- **Gemini** `gemini-2.5-flash-image` with `secrets.get('gemini')`, used when there's no OpenAI key. `POST /v1beta/models/<model>:generateContent` with header `x-goog-api-key`. Parts are the text plus `inline_data` per image to edit; `generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio } }`. The image is in `candidates[0].content.parts[].inlineData`, parsed in both camel and snake case. One image per request, so `count` requests run side by side. When no picture comes back, the reason is in a text part, `promptFeedback.blockReason` or `finishReason`.
- As of Oct 2026, Google's docs show the newer models (`gemini-3.1-flash-image`, `gemini-3-pro-image`) only through a newer **Interactions API** (`POST /v1beta/interactions`). `generateContent` is still documented, and the 2.5 model is listed as legacy. Nothing here was run against the real APIs (each call costs money), so check the request shapes against a real key before relying on them, and consider moving to Interactions for the newer models.
- No key at all → `NO_KEY`, which names both keys and Settings → Model providers. A 401/403 says to check the key; other errors pass the API's own message through.

## How it behaves as a tool
- `mutating: true` (it writes files): plan mode leaves it out, Ask first asks, Auto-approve runs it, and scheduled runs follow their policy. It isn't `risky` or `catastrophic`; `describe()` says "billed to your OpenAI or Gemini key". It's offered only in `work` mode at depth 0: never to swarm sub-agents (parallel billing) or plain chat mode (no folder to save into).
- Files go to `<cwd>/images/<slug>[-n].png`, the worker's own folder for a worker, and are never overwritten (`-2`, `-3`…). The result text lists each path on a `- /abs/path` line; the card parses those (`components/agent/imageResults.ts`). The model gets a ≤1024px JPEG of each image via `nativeImage` (falling back to the original), not the full PNG.
- `ctx.progress()` stages ("Asking OpenAI (gpt-image-1) for 2 images…", "Image 2 of 3 ready…", "Saving…") show on the card.

## The card (`components/agent/ImageGeneration.tsx`, `styles/imagegen.css`)
An original design. One tile per image at the requested shape (`aspectRatio()` in `@shared/images`, shared with main), so the picture lands where the placeholder was. While running, each tile "develops": a blurred field of two accent radial gradients drifting (7.5s, alternate, staggered per tile), SVG-turbulence film grain stepping in place, and a light band sweeping across every 2.6s. The current stage sits in a frosted pill on the first tile, and elapsed time is in the header. Once the files exist, each image resolves from `blur(18px) saturate(.4) brightness(1.18) scale(1.035)` to sharp over 820ms, 90ms apart. Hovering shows Copy path and Show in Finder; a click opens the image full size in the app's `Modal`. Error and denied states show the reason in a soft danger strip. Tokens only, so it works in light and dark, and reduced motion stops the loops.

`turnItems.ts` gives `generate_image` its own row (`OWN_ROW`, like `spawn_agents`) so finished images never fold into a collapsed run. `ToolCall` hands the part to `ImageGeneration`.

## Testing
`test/imageGeneration.test.ts` uses a fake `fetch` for the request shape per provider, edits, saving, no-overwrite, the no-key and error messages, the Gemini no-image reason, where it's offered, and the card's result parsing. A visual check (running, revealing, done, hover, modal, error; light and dark) pushed fake chats over CDP with `chats:changed` into an isolated capture-harness profile.

See [[Agent transcript: activity lines and the files-changed card]] and [[Chat Markdown renderer: what it covers and the streaming rule]].
