---
title: Local model hub (Models page)
tags: [eaon-desktop, models, huggingface, ollama, gguf]
created: 2026-08-22T00:00:00.000Z
updated: 2026-08-22T00:00:00.000Z
---

# Local model hub (Models page)

A "Models" nav item (sidebar, after Plugins) lets you search Hugging Face for
GGUF models, browse variants/quantizations, and download them — modeled after
Jan.ai's Hub feature, but named Models per the user's request. Chosen runtime:
**integrate with Ollama** rather than embedding an inference engine — see the
decision rationale below.

## Shape

- `src/main/modelHub.ts` — all Hugging Face + Ollama logic. `searchModels()`,
  `getModelDetail()`, `downloadModel()`, `getDownloadedModels()`,
  `deleteDownloadedModel()`.
- `src/renderer/src/components/ModelsPage.tsx` — list + detail, toggled via
  `modelsRepo` in the zustand store (`state/store.ts`), **not** local component
  state — see gotcha below for why that matters.
- Downloaded models persist to `downloaded-models.json` via the same
  `store.ts` `readJson`/`writeJson` pattern as everything else (see
  [[Eaon Desktop architecture]]).
- Files land in `app.getPath('userData')/models/<owner>__<repo>/<file>.gguf`.

## Why Ollama, not an embedded engine

Considered three options: (1) integrate with Ollama's existing `/api/create`
to import a downloaded GGUF, (2) embed `node-llama-cpp` for a fully
self-contained local inference engine, (3) ship browsing/download only and
defer "running" entirely. Chose (1) — the app already lists Ollama as a
built-in provider (`kind: 'ollama'` in `providers.ts`), so a downloaded model
just needs registering with the local daemon to show up in the existing model
picker for free. No new native dependency, no separate streaming/GPU-
acceleration path to maintain alongside the existing provider system. Real
tradeoff: users without Ollama installed can browse and download but nothing
will actually run until they install it — the download still succeeds and is
reported as such, with `ollamaError` set so the UI can say so honestly rather
than silently failing.

Ollama's admin API (`/api/create`, `/api/delete`) always lives at
`127.0.0.1:11434` regardless of what the "Ollama" provider's own
OpenAI-compatible `baseUrl` (`.../v1`) has been changed to in Settings — the
two are unrelated, so the port is hardcoded in `modelHub.ts` rather than
derived from the provider config.

## Gotcha: Hugging Face's search endpoint needs `full=true` for `siblings`

`GET /api/models?search=...&filter=gguf` without `full=true` returns id/
author/downloads/tags but **no file listing at all** — `siblings` is simply
absent, not empty. Every list card silently had no size, no Fits badge, no
file count until this was added. Caught this by actually running the feature
against the live API and screenshotting it — the lightweight response looks
completely reasonable in isolation, nothing throws, it just quietly omits the
one field the cards need. `cardData` (which does need `full=true` too) turned
out to be a red herring — it's included but essentially never has a
`description` field. If you're touching this file, always verify against the
real API (`curl "https://huggingface.co/api/models?..."`) rather than
reasoning about param names from memory.

## No curated descriptions from Hugging Face

Jan's actual Hub descriptions ("A 4B parameter math reasoning model...") are
their own hand-written catalog copy — nothing in the HF API returns anything
like it for arbitrary repos. Two different compromises for two different
views:
- **List cards**: no description shown at all rather than a fabricated one.
- **Detail page**: fetches the real `README.md` and extracts the first
  substantial non-heading, non-badge, non-frontmatter line as a description.
  Works surprisingly well in practice (real example: "V3 applies a gentle
  refinement pass on top of V2's complementary blend..."), but it's a
  heuristic over prose, not guaranteed for every repo. Only done on the
  detail page (one repo) — doing this for every card in a 30-item list would
  mean 30 extra README fetches on every search.

## Deleting a downloaded model

`deleteDownloadedModel(repoId, filename)` was already written in `modelHub.ts`
from the start (unlinks the file, best-effort `DELETE /api/delete` against
Ollama if it was registered, rewrites `downloaded-models.json`) but had no UI
until asked for. Wired a trash-icon `icon-btn` into all three places a
downloaded file shows up: the search-list card (next to "Downloaded"), the
dedicated "Downloaded" filter view (which now lists each variant file by name
+ size rather than just a count, since that's where per-file delete actually
needs a target), and the detail page's variants table Action column. All
three call the same `handleDelete` in `ModelsPage`, which awaits the IPC call
then filters the local `downloadedModels` state — no separate refetch needed.

## Gotcha: `modelsRepo` has to live in the store, not `useState`

First cut used local `useState<string | null>` in `ModelsPage` for
list-vs-detail. Caught via the capture harness: clicking "Models" in the
sidebar while already viewing a model's variants did nothing, because
`setView('models')` is a no-op when `view` is already `'models'` — the
component never unmounts, so local state survives. Moved it to the zustand
store instead (`modelsRepo`/`setModelsRepo`), matching the same pattern
already used for `settingsPage`/`pluginsTab`, and made the sidebar's Models
button explicitly reset it on click. Any future full-page view with an
internal list/detail toggle should use this pattern from the start rather
than local state.

## Verifying against the real network from a sandboxed dev environment

The `EAON_CAPTURE` screenshot harness (see
[[Matching the Eaon Desktop Figma frames]]) drives the real app, and its main
process really does have outbound internet access here — `searchModels`/
`getModelDetail` hit the actual Hugging Face API during a capture run, which
is how the `full=true` bug above was caught rather than shipped. Went one
step further and verified an actual end-to-end download (a real ~25MB repo,
picked via a live search for a small, deterministic result) — confirmed the
file landed correctly on disk and `downloaded-models.json` was written
correctly, and confirmed the Ollama-registration failure path reports a clean
error (`Could not reach Ollama — make sure it is installed and running.`)
since no local Ollama daemon exists in this sandbox. That test step was
**not** left in `capture.ts` — unlike every other step, it has real side
effects (network download + a disk write to the user's real
`downloaded-models.json`), which the rest of the suite deliberately avoids.
If you need to re-verify the download path, add a similar step temporarily
and revert it afterward rather than leaving it in.
