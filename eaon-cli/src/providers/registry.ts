// Provider-merged model catalog: Aqua → BYOK custom providers → local
// Ollama, same precedence and key scheme ("aqua:x", "ollama:x",
// "custom:<id>:<x>") as the Mac app and Tauri core, so a nickname or a
// saved --model value means the same thing across all three surfaces.

import type { CustomProviderFormat, EaonConfig, ModelEntry } from "../types.js";
import { resolveAquaApiKey, resolveOllamaBaseUrl } from "../config.js";
import { EAON_HOSTED_CATALOG, fetchEaonHostedModels, hostedBaseUrlForKey } from "./eaon-hosted.js";
import { fetchOllamaTags } from "./ollama.js";

export interface CatalogResult {
  models: ModelEntry[];
  ollamaReachable: boolean;
  aquaError: string | null;
}

export async function buildCatalog(config: EaonConfig): Promise<CatalogResult> {
  const models: ModelEntry[] = [];
  let aquaError: string | null = null;

  const aquaKey = resolveAquaApiKey(config);
  if (aquaKey) {
    try {
      const aquaModels = await fetchEaonHostedModels(aquaKey);
      for (const m of aquaModels) {
        models.push({ key: `aqua:${m.id}`, requestId: m.id, display: m.name, provider: { kind: "aqua" }, tier: m.tier, supportsTools: true });
      }
    } catch (e) {
      aquaError = e instanceof Error ? e.message : String(e);
    }
  }

  for (const custom of config.customProviders) {
    for (const modelId of custom.modelIDs) {
      models.push({
        key: `custom:${custom.id}:${modelId}`,
        requestId: modelId,
        display: `${modelId} (${custom.displayName})`,
        provider: { kind: "custom", id: custom.id, displayName: custom.displayName },
        // Native tool-calling is only offered on the OpenAI-compatible
        // wire shape (see chat.ts's streamChat doc comment) — Anthropic/
        // Gemini custom providers still work for chat and coding, just
        // through the text-fence fallback instead of a function-call API.
        supportsTools: (custom.format ?? "openAICompatible") === "openAICompatible",
      });
    }
  }

  let ollamaReachable = false;
  try {
    const ollamaModels = await fetchOllamaTags(resolveOllamaBaseUrl(config));
    ollamaReachable = true;
    for (const m of ollamaModels) {
      models.push({ key: `ollama:${m.name}`, requestId: m.name, display: m.name, provider: { kind: "ollama" }, supportsTools: m.supportsTools });
    }
  } catch {
    ollamaReachable = false;
  }

  return { models, ollamaReachable, aquaError };
}

export function endpointFor(entry: ModelEntry, config: EaonConfig): { baseUrl: string; apiKey: string | null; format: CustomProviderFormat } {
  const provider = entry.provider;
  switch (provider.kind) {
    case "aqua": {
      // Resolve the host FROM the key, exactly as the model listing does —
      // if these two ever disagree you get the bug this fixed: a catalog
      // that loads fine followed by a 401 on the first real message.
      const key = resolveAquaApiKey(config);
      return { baseUrl: hostedBaseUrlForKey(key), apiKey: key, format: "openAICompatible" };
    }
    case "ollama":
      return { baseUrl: `${resolveOllamaBaseUrl(config)}/v1`, apiKey: null, format: "openAICompatible" };
    case "custom": {
      const cfg = config.customProviders.find((c) => c.id === provider.id);
      return { baseUrl: cfg?.baseURL ?? "", apiKey: cfg?.apiKey || null, format: cfg?.format ?? "openAICompatible" };
    }
  }
}

/** A display label naming both the model and where it runs. */
/**
 * The provider name shown beside the model in the composer, dimmed — the
 * reference puts "OpenCode Go" after "DeepSeek V4 Pro" the same way. Returns
 * null when the label would be noise (a BYOK connection already names itself in
 * `display`).
 */
export function providerLabelFor(entry: ModelEntry): string | null {
  switch (entry.provider.kind) {
    case "aqua":
      return "Eaon";
    case "ollama":
      return "Ollama";
    case "custom":
      return entry.provider.displayName ?? null;
  }
}

export function describeEntry(entry: ModelEntry): string {
  switch (entry.provider.kind) {
    case "aqua": return `${entry.display} · Eaon`;
    case "ollama": return `${entry.display} · Local (Ollama)`;
    case "custom": return `${entry.display}`;
  }
}

export function findModel(models: ModelEntry[], key: string): ModelEntry | undefined {
  return models.find((m) => m.key === key || m.requestId === key || m.display === key);
}

export { EAON_HOSTED_CATALOG };
