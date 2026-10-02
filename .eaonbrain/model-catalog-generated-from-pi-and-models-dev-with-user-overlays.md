---
title: Model catalog: generated from Pi and models.dev, with user overlays
tags: [eaon-desktop, providers, models, catalog]
created: 2026-10-01T02:39:30.189Z
updated: 2026-10-01T02:40:03.258Z
---

How a provider's model list is built since Sept 30, 2026. Built after the co-founder reported "many models missing (Sonnet 5.5…)", "if I accidentally deleted models I can't get them back", and asked to "do it the way Pi agent does providers, except the special Anthropic one". The Anthropic exception concerns **auth only** (Anthropic stays API-key only with "Open Claude Code in the ADE", see [[Claude plan through the user's own Claude Code (headless provider)]]); its models come from the catalog like everyone else's.

## Sources (the Pi way)
- **Pi's published provider data** — npm `@earendil-works/pi-ai`, `dist/providers/data/<provider>.json` (`{ [api]: { "chat:<id>": Model } }`, with `thinkingLevelMap`). The old `@mariozechner/pi-ai` name is stale (0.73, May 2026); Eaon Code (`~/Downloads/eaon-code-main/packages/ai`) is a fork whose data lags too. Pi data = models.dev + Pi's hand corrections, so it wins for the providers Pi covers.
- **models.dev** (`https://models.dev/api.json`, public, ~5 MB, no key) for providers Pi doesn't cover (cohere, deepinfra, novita, nebius, poe, perplexity, qwen/qwen-cn, zai/zai-cn) and for release dates.
- `src/main/providers/catalogSources.ts` holds both mappings (`PI_SOURCES`, `MODELS_DEV_SOURCES`, Eaon id → source id) and the pure conversion. `npm run generate:models` (`scripts/generate-models.mjs`, esbuild-bundles that file) writes `catalog.generated.json` (~320 KB, ~1,740 models). Run it before a release.
- Hand lists remain in `catalog.ts` only for SambaNova and Amazon Bedrock (mantle endpoint); neither source knows them.

## Runtime
- `modelCatalog.ts`: `catalogFor(id)` = shipped list + cached models.dev (`store/models-dev.json`). Fetched once a day at launch (`refreshCatalogInBackground`, silent offline) and on every Refresh press. For Pi-sourced providers, models.dev only **adds** ids Pi lacks that were released within 30 days of the build or later — older models missing from Pi were left out on purpose. For models.dev-sourced providers the fresh list replaces the shipped one.
- Refresh button → `refreshProviderModels` (IPC `providers:refresh`): models.dev, plus the provider's own `/models` when it has a key / is local, and returns a message saying what it checked and what is new. It works without a key, which is why it used to "do nothing": it was disabled without a key and gave no feedback otherwise.

## Layers (`composeModels` in `providers/index.ts`)
1. catalog (newest first) → 2. the provider's own listing (`override.listed`; adds ids, fills gaps; the catalog's corrected limits/efforts win) → 3. user-added `custom` → renames (`labels`) → `hidden` split into `Provider.hiddenModels`.
- **Remove = hide** (restorable in the UI); a hand-added model is deleted outright. Edits go through `editModels` (IPC `providers:edit-models`, `ModelEdit` in `shared/providers.ts`); `updateProvider` no longer accepts `models`.
- **Migration:** before overlays, `providers.json` kept the whole list in `models`, replaced on every refresh or delete. It is now read as `listed`, so catalog models a user deleted come back; the first edit rewrites it as `listed`.
- Copilot and the ChatGPT plan are **entitlement listings**: once a listing exists it bounds the catalog (Copilot hides models the account's policy disables).
- `effortReaches(provider, model)` in `compat.ts` empties `efforts` where the endpoint drops the field (Copilot/xAI chat-completions, NVIDIA, Perplexity, Ollama except gpt-oss), so the picker is not offered there.
- Cost: `listProviders()` ≈ 4.7 ms and ~340 KB over IPC; `getProvider(id)` builds only that one provider.

Effort conversion rules are in [[Effort levels: old ids, provider names and clamping]]. Wire-format quirks stay in [[Model provider quirks and where they live]].

Related: [[Popover sizing and overflow rules]]
