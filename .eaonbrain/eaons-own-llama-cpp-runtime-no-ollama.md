---
title: Eaon's own llama.cpp runtime (no Ollama)
tags: [eaon-desktop, models, llama.cpp, runtime, release]
created: 2026-10-01T00:18:26.869Z
updated: 2026-10-01T00:18:26.869Z
---

Since Sept 30 2026 local models run on a `llama-server` built into Eaon, not Ollama. The co-founder asked for this ("should NOT use ollama… a custom fork native to eaon"); the trigger was K2 Horizon, which no Ollama could load. This supersedes the Ollama parts of [[Curated model library and Ollama pulls]] and [[Local model hub (Models page)]].

## The "fork" is a recipe, not a GitHub fork
`native/llama-fork.json` names an upstream base commit plus the pull requests to merge, each with a `resolve` map (file → `base` | `pr`) for known conflicts and the reason. `scripts/build-llama.sh [arm64|x64|all]` clones into `native/llama.cpp` (git-ignored), merges the PRs, applies `native/llama-patches/*.patch`, builds `llama-server` only, and writes `resources/llama/darwin-<arch>/{llama-server,build.json}`. `build.json` records the PRs, and the Models page reads it: `LibraryModel.requires: {pull, architecture}` disables Get on a runtime without that PR (`runtimeGap`). Nothing was published; if the team wants a real fork, push `native/llama.cpp` to eaonlabs.
- As of Sept 30, the only PR is ggml-org/llama.cpp#29535 (K2 Horizon). It conflicts in `common/jinja/value.cpp` (superseded by #29574), `conversion/base.py` and `tests/test-jinja.cpp`; keep the base side of all three. The model code under `src/` merges cleanly. Verified: K2-Horizon-1B answers tool calls on our build. Drop the PR once it merges upstream and the base moves past it.
- Build flags that matter:
  - `GGML_NATIVE=OFF`, otherwise the binary is tuned to the build Mac (M5) and can crash on older Macs.
  - Static (`BUILD_SHARED_LIBS=OFF`) with `GGML_METAL_EMBED_LIBRARY`, giving one 21 MB file.
  - `CMAKE_OSX_DEPLOYMENT_TARGET=13.3`, matching upstream.
  - x64 is CPU only with AVX2/FMA, cross-built on Apple silicon. It can't be run without Rosetta, so its `--version` check fails at build time; that's expected.
  - `LLAMA_CURL` is deprecated upstream, and `LLAMA_OPENSSL=OFF` is fine because Eaon downloads the models itself.
- The first scripted merge failed silently because stderr went to /dev/null. The script now verifies `MERGE_HEAD` exists before trying to resolve conflicts.
- Windows can't be compiled from a Mac. `scripts/fetch-llama-windows.sh` ships upstream's prebuilt `llama-server` (Vulkan on x64, CPU on arm64; nothing for ia32) with `build.json` `pulls: []`, so K2 Horizon shows "Not supported yet" there.

## Runtime (`src/main/llama/`)
- `runtime.ts`: `llamaRuntime.ensure(model, 'chat'|'embedding')` starts one llama-server per slot, on a random loopback port with a random `--api-key`. Flags: `-c` min(32768, model ctx), `-ngl 999`, `--jinja`, `-fa auto`, `--mmproj` when present, `--no-webui`; `--embedding` for embeddings. It is ready when `/health` returns 200 (503 while loading); a server that exits early is turned into a sentence by `explainFailure` (unknown architecture, out of memory, bad file). Servers unload after 15 idle minutes, and `shutdown()` (Feature.shutdown) kills them on quit (verified: none left behind). Each server runs in its own process group and gets exactly one SIGTERM, and orphans are reaped at launch; a second signal makes llama.cpp abort in Metal teardown — see [[llama-server crash on quit and the crash guard]]. `EAON_LLAMA_SERVER` overrides the binary for development and tests.
- `models.ts`: the registry is `downloaded-models.json` (`DownloadedModel`, now with `mmprojPath`, `library`, `label`, `capabilities`). Picker ids are `<libraryId>:<variantId>`, or `<repo>:<quant>` for Browse Hugging Face files.
- Provider `eaon-local` ("On this computer", in the Local group): its models are the downloads, and `adapterFor` wraps the chat adapter so each turn runs `ensure()` first, then uses that server's baseUrl and key.
- Embeddings: downloaded embedding models appear in the code index's list (`embeddingModels()`) and run on the embedding slot.

## Catalog
Every variant is a `hf()` source: repo, the exact files (model shards, then mmproj) and their summed size. All of these were read from the Hugging Face tree API. `node scripts/verify-model-library.mjs` re-checks every file and size. Source preference: the model's own org, then ggml-org, unsloth, LiquidAI, ibm-granite, bartowski. Gotchas:
- Exclude speculative-decoding drafts (`MTP/…`, `mtp-…`, `dflash-…`) when picking a repo's main file.
- Unsloth publishes "UD-" quants; a UD-Q4_K_XL can outgrow a memory tier (Muse Glimmer moved to lmstudio-community's Q4_K_M for that reason).
- Ollama-era sizes were about 890 B larger (template layers).

Verified end to end in the packaged app: Get MiniCPM5 2B (1.56 GB, 56 s) → it appears in the picker → a chat loads it in about 10 s and calls tools.

Related: [[Building installers on an Apple silicon Mac (no Rosetta)]]
