---
title: Curated model library and Ollama pulls
tags: [eaon-desktop, models, ollama, huggingface, catalog, gotcha]
created: 2026-09-24T00:00:00.000Z
updated: 2026-09-24T00:00:00.000Z
---

# Curated model library and Ollama pulls

> **Superseded (Sept 30 2026):** downloads and running moved from Ollama to Eaon's own llama.cpp. See [[Eaon's own llama.cpp runtime (no Ollama)]]. The fit model and the per-tier picks below still apply; the Ollama pull, registry and digest parts don't.

The Models page's default tab is a hand-curated catalog of current local
models (`src/main/modelLibrary/catalog.ts`, 22 entries as of Sept 2026), with
"Suggested for this Mac", category chips, one-click Get, an Installed tab and
per-model detail. Browse Hugging Face (the older hub, see
[[Local model hub (Models page)]]) is the third tab.

## Where things live

- `src/shared/modelLibrary.ts` — types plus all the pure logic: `fitFor`,
  `pickVariant` (RAM tier → variant), `suggestFor`, `findInstalled`,
  `pullRef`. Shared so the tests cover exactly what the badges show.
- `src/main/modelLibrary/` — `catalog.ts` (data), `ollama.ts` (admin API,
  `PullTracker`, `startOllama`), `index.ts` (state, pull, cancel, delete).
  IPC lives in `features/modelLibrary.ts`; bridge `window.api.modelLibrary`.
- Renderer: `components/models/*` with its own zustand store
  (`libraryStore.ts`) — actions live there, not in components, because a pull
  outlives the page and its finish must still clear the Downloads row and
  refresh the provider.

## Decisions

- **Every Get goes through `POST /api/pull`**, including Hugging Face-only
  models, as `hf.co/<repo>:<quant>`. Hugging Face serves an Ollama-compatible
  registry that resolves the quant to a file and adds the chat template and
  the vision projector (mmproj). One progress stream, one copy on disk, no
  template guessing. The old download-then-`/api/create` path is kept only for
  arbitrary files picked in Browse Hugging Face.
- **Progress reuses `models:download-progress`** and the store's
  `modelDownloads`, keyed `library/<Model Name>::<pull ref>` — the Downloads
  panel titles rows with the part of `repoId` after the first slash. The
  renderer clears the row itself via `useApp.setState` when the pull settles,
  so no change to `store.ts` was needed.
- **Fit model**: need = size × 1.1 + 0.75 GiB; *Fits well* if under 72 % of
  RAM (Metal's default GPU working set — Ollama reports 17.8 GiB on a 24 GB
  M5), *Tight* under 85 %, else *Too big* (Get disabled). Recommended tiers are
  curated per model, and a test asserts each tier's pick is at least Tight at
  that tier.
- **Installed matching** is by normalised name *or* the 12-hex manifest digest
  (`ollama list`'s ID), so a model pulled under a sibling tag
  (`gemma4:e2b-it-q4_K_M` vs `gemma4:e2b`) still shows as installed.

## Gotchas found the hard way

- `registry.ollama.ai` returns **401 to a `User-Agent: ollama/...`** (it wants
  the CLI's signed requests); any other UA gets public manifests.
  `/v2/library/<name>/tags/list` is **404 for every model** — list tags by
  scraping `ollama.com/library/<name>/tags`, verify one by fetching its
  manifest.
- sha256 of the raw manifest bytes, first 12 hex = the digest `ollama list`
  shows. Sum of layer sizes + config size = the exact pull size.
- **K2 Horizon (IFM) doesn't run in Ollama 0.30.4**: pulling
  `hf.co/IFM/K2-Horizon-0.9B-GGUF:Q4_K_M` succeeds but loading fails with
  `unknown model architecture: 'k2-horizon'` (llama.cpp PR still open per the
  GGUF card). The entry carries `unsupported`, which disables Get. Remove it
  once a released Ollama loads the 0.9B.
- `isChatModelId` in `providers/models.ts` doesn't catch `embeddinggemma:*` or
  `qwen3-embedding:*`, so pulled embedding models appear in the chat picker.
- Checking "is the catalog still right": `node scripts/verify-model-library.mjs`
  (HF repos + siblings, hf.co manifests vs files, Ollama digests and sizes).
