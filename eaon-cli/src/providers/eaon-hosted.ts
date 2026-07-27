// Eaon's hosted models — same base URL and hand-maintained allowlist as the
// Mac app (EaonHostedModels) and the Tauri core (EAON_HOSTED_CATALOG in
// state.svelte.ts), copied verbatim so a model id means the same thing on
// every Eaon surface.

export const EAON_HOSTED_BASE_URL = "https://api.aquadevs.com/v1";
/** Eaon's own gateway. Account keys issued from an Eaon account (`sk-eaon-…`)
 * authenticate here, NOT against the hosted host above — the two are
 * genuinely separate services (same split as the Mac app / Tauri core).
 * The hosted host URL is a legacy backend hostname; user-facing copy always
 * says Eaon, never Aquadevs. */
export const EAON_GATEWAY_BASE_URL = "https://api.eaon.dev/v1";

/** Picks the host a key actually belongs to.
 *
 * This exists because sending a key to the wrong host produced a genuinely
 * misleading failure: `api.aquadevs.com/v1/models` answers 200 for ANY
 * bearer — it doesn't validate at all (verified: a deliberately truncated
 * 12-character key still listed the full catalog) — while
 * `/chat/completions` on that same host validates properly and returns 401.
 * So an `sk-eaon-` key looked completely fine at startup, filled the model
 * picker, and only failed on the first actual message. Routing by key type
 * keeps listing and chat pointed at the same place, so if a key works at
 * all it works everywhere. */
export function hostedBaseUrlForKey(apiKey: string): string {
  return apiKey.trim().toLowerCase().startsWith("sk-eaon-") ? EAON_GATEWAY_BASE_URL : EAON_HOSTED_BASE_URL;
}

export const EAON_HOSTED_CATALOG: Record<string, string> = {
  "agnes": "Agnes 2.0 Flash", "deepseek-v3": "DeepSeek V3", "deepseek-v3.1": "DeepSeek V3.1 Terminus",
  "deepseek-v3.2": "DeepSeek V3.2", "deepseek-v4": "DeepSeek V4 Flash", "deepseek-v4-pro": "DeepSeek V4 Pro",
  "diffusion-gemma": "Diffusion Gemma 26B", "fable-5": "Claude Fable 5", "gemini-3": "Gemini 3.0 Flash",
  "gemini-3.1-lite": "Gemini 3.1 Flash Lite", "gemini-3.1-pro": "Gemini 3.1 Pro", "gemini-3.5": "Gemini 3.5 Flash",
  "gemma-4": "Gemma 4 31B", "glm-5.1": "GLM 5.1", "glm-5.2": "GLM 5.2", "gpt-5-nano": "GPT 5 Nano",
  "gpt-5.3-codex": "GPT 5.3 Codex", "gpt-5.4": "GPT 5.4", "gpt-5.4-mini": "GPT 5.4 Mini", "gpt-5.5": "GPT 5.5",
  "gpt-oss": "GPT-OSS 120B", "grok": "Grok 4.2 Fast", "grok-4.2-thinking": "Grok 4.2 Reasoning",
  "grok-4.3": "Grok 4.3", "haiku-4.5": "Claude Haiku 4.5", "hermes": "Hermes 4 70B", "kimi-k2.5": "Kimi K2.5",
  "kimi-k2.6": "Kimi K2.6", "kimi-k2.7": "Kimi K2.7 Code", "llama-3.1": "Llama 3.1 8B", "llama-4": "Llama 4 Maverick",
  "mercury": "Mercury 2", "mimo-v2.5": "Mimo V2.5", "mimo-v2.5-pro": "Mimo V2.5 Pro", "minimax-m2.7": "MiniMax M2.7",
  "minimax-m3": "MiniMax M3", "mistral": "Mistral", "mistral-3.5": "Mistral 3.5 128B", "nemotron": "Nemotron 3 Ultra",
  "nova": "Amazon Nova Fast", "opus-4.7": "Claude Opus 4.7", "opus-4.8": "Claude Opus 4.8", "qwen": "Qwen Coder",
  "qwen-3.6": "Qwen 3.6 27B", "qwen-3.7": "Qwen 3.7 Plus", "sonar": "Perplexity Sonar",
  "sonnet-4.6": "Claude Sonnet 4.6", "sonnet-5": "Claude Sonnet 5", "step-3.7": "Step 3.7 Flash",
};

export interface EaonHostedModel {
  id: string;
  name: string;
  tier: string | null;
}

/** GET {base}/models (OpenAI-compatible {data:[{id,name,type,tier}]}),
 * filtered to text models that are on Eaon's own hosted allowlist — the
 * same filter the Tauri core applies (state.svelte.ts refreshAquaModels). */
export async function fetchEaonHostedModels(apiKey: string): Promise<EaonHostedModel[]> {
  if (!apiKey) return [];
  const response = await fetch(`${hostedBaseUrlForKey(apiKey)}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    throw new Error(`Eaon's hosted API returned ${response.status}`);
  }
  const json = (await response.json()) as { data?: Array<{ id: string; name?: string | null; type?: string | null; tier?: string | null }> };
  const entries = json.data ?? [];
  return entries
    .filter((m) => (m.type ?? "text").toLowerCase() === "text" && EAON_HOSTED_CATALOG[m.id])
    .map((m) => ({ id: m.id, name: m.name ?? EAON_HOSTED_CATALOG[m.id] ?? m.id, tier: m.tier ?? null }));
}
