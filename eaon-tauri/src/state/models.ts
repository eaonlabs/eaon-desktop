// The merged model catalog: Eaon hosted ∩ live list, BYOK connections, and
// installed Ollama models — resolved into ModelEntry rows the picker and
// routing share. Refreshes are event-driven (launch, settings changes,
// Models page visits), never polled.

import { create } from "zustand";
import type { ModelEntry, OllamaModel, ProviderModel, PullState } from "../core/types";
import { EAON_HOSTED_BASE_URL, EAON_HOSTED_CATALOG } from "../core/catalog";
import { fetchProviderModels, ollamaTags } from "../core/ipc";
import { useSettings } from "./settings";

interface ModelsStore {
  /** Hosted models the gateway currently serves (∩ catalog allowlist). */
  hostedModels: ProviderModel[];
  hostedError: string | null;
  /** Hosted image-type models (picker's Image generation group). */
  hostedImageModels: ProviderModel[];
  /** Installed local models from Ollama's /api/tags. */
  ollamaModels: OllamaModel[];
  ollamaReachable: boolean;
  /** Live pull progress per model tag (Models page). */
  pulls: Record<string, PullState>;
  selectedModelKey: string | null;

  refreshHosted: () => Promise<void>;
  refreshOllama: () => Promise<void>;
  setSelected: (key: string | null) => void;
  setPull: (model: string, state: PullState | null) => void;

  /** The merged, ordered catalog (favorites float in the picker itself).
   *  `includeManaged` skips the hidden/disabled filters — the per-provider
   *  Settings page needs every model visible so hiding/disabling is
   *  reversible from there, not just a one-way picker action. */
  entries: (opts?: { includeManaged?: boolean }) => ModelEntry[];
  /** Resolve a picker key back to an entry (selection, routing). */
  entryFor: (key: string | null) => ModelEntry | null;
}

/** Vision heuristics for hosted/BYOK ids where no capability tags exist. */
function guessVision(id: string): boolean {
  return /gpt-5|gemini|opus|sonnet|fable|haiku|llama-4|vision|vl/i.test(id);
}

/** The settings.disabledProviders key for a ModelEntry's connection —
 *  "eaon", "ollama", or a CustomProvider's own id. */
export function providerDisableKey(provider: ModelEntry["provider"]): string {
  return provider.kind === "custom" ? provider.configId : provider.kind;
}

export const useModels = create<ModelsStore>((set, get) => ({
  hostedModels: [],
  hostedError: null,
  hostedImageModels: [],
  ollamaModels: [],
  ollamaReachable: false,
  pulls: {},
  selectedModelKey: null,

  refreshHosted: async () => {
    const { settings } = useSettings.getState();
    const key = settings.eaonApiKey || settings.trialCredential?.key || "";
    try {
      const models = await fetchProviderModels(EAON_HOSTED_BASE_URL, key || null);
      set({
        hostedModels: models.filter(
          (m) => (m.modelType ?? "text").toLowerCase() === "text" && EAON_HOSTED_CATALOG[m.id],
        ),
        hostedImageModels: models.filter(
          (m) => (m.modelType ?? "").toLowerCase() === "image",
        ),
        hostedError: null,
      });
    } catch (e) {
      set({ hostedError: String(e), hostedModels: [], hostedImageModels: [] });
    }
  },

  refreshOllama: async () => {
    const { settings } = useSettings.getState();
    try {
      const models = await ollamaTags(settings.ollamaBaseUrl);
      set({ ollamaModels: models, ollamaReachable: true });
    } catch {
      set({ ollamaModels: [], ollamaReachable: false });
    }
  },

  setSelected: (key) => set({ selectedModelKey: key }),

  setPull: (model, state) =>
    set((s) => {
      const pulls = { ...s.pulls };
      if (state === null) delete pulls[model];
      else pulls[model] = state;
      return { pulls };
    }),

  entries: (opts) => {
    const { settings } = useSettings.getState();
    const { hostedModels, ollamaModels } = get();
    const nickname = (key: string, fallback: string) => settings.nicknames[key] ?? fallback;
    const rows: ModelEntry[] = [];

    for (const m of hostedModels) {
      const key = `eaon:${m.id}`;
      rows.push({
        key,
        requestId: m.id,
        display: nickname(key, m.name ?? EAON_HOSTED_CATALOG[m.id] ?? m.id),
        provider: { kind: "eaon" },
        tier: m.tier ?? null,
        supportsVision: guessVision(m.id),
      });
    }
    // Free Trial mirrors the same hosted catalog under its own provider
    // identity — a fully independent, always-present option (its own picker
    // keys and nicknames) rather than a fallback silently living inside the
    // "eaon" rows above, so it stays selectable whether or not an Eaon API
    // key exists (and disabling/hiding it never touches the "eaon" rows).
    for (const m of hostedModels) {
      const key = `freeTrial:${m.id}`;
      rows.push({
        key,
        requestId: m.id,
        display: nickname(key, m.name ?? EAON_HOSTED_CATALOG[m.id] ?? m.id),
        provider: { kind: "freeTrial" },
        tier: m.tier ?? null,
        supportsVision: guessVision(m.id),
      });
    }
    for (const provider of settings.customProviders) {
      for (const id of provider.modelIDs) {
        const key = `custom:${provider.id}:${id}`;
        rows.push({
          key,
          requestId: id,
          display: nickname(key, id),
          provider: { kind: "custom", configId: provider.id, configName: provider.displayName },
          supportsVision: guessVision(id),
        });
      }
    }
    for (const m of ollamaModels) {
      // Diffusion models live in the image pipeline, not the chat picker.
      if (m.capabilities?.includes("image")) continue;
      const key = `ollama:${m.name}`;
      rows.push({
        key,
        requestId: m.name,
        display: nickname(key, m.name),
        provider: { kind: "ollama" },
        supportsVision: m.capabilities?.includes("vision") ?? false,
      });
    }
    if (opts?.includeManaged) return rows;
    return rows.filter(
      (r) =>
        !settings.hiddenModelKeys.includes(r.key) &&
        !settings.disabledProviders.includes(providerDisableKey(r.provider)),
    );
  },

  entryFor: (key) => {
    if (!key) return null;
    return get().entries().find((e) => e.key === key) ?? null;
  },
}));
