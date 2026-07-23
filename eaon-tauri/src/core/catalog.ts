// Shared constants: endpoints, the hosted model catalog, appearance options.
// The hosted base URL is a wire value only — user-facing text always says
// "Eaon", never the vendor host name.

export const EAON_HOSTED_BASE_URL = "https://api.aquadevs.com/v1";
export const EAON_TRIAL_BASE_URL = "https://api.eaon.dev/v1";
export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
export const UPDATE_MANIFEST_URL = "https://downloads.eaon.dev/update-manifest.json";
export const RELEASES_PAGE_URL = "https://github.com/sanscreates/eaon-desktop/releases";

/** Eaon's hand-maintained hosted chat allowlist (id → display name) — the
 *  live /models list is filtered against this so experimental server-side
 *  entries never leak into the picker. */
export const EAON_HOSTED_CATALOG: Record<string, string> = {
  "agnes": "Agnes 2.0 Flash", "deepseek-v3": "DeepSeek V3", "deepseek-v3.1": "DeepSeek V3.1 Terminus",
  "deepseek-v3.2": "DeepSeek V3.2", "deepseek-v4": "DeepSeek V4 Flash", "deepseek-v4-pro": "DeepSeek V4 Pro",
  "diffusion-gemma": "Diffusion Gemma 26B", "gemini-3": "Gemini 3.0 Flash",
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

/** Accent options. Chrome stays monochrome (the Mac design rule) — the
 *  accent tints selection highlights and the send button only. */
export const ACCENT_OPTIONS: Array<{ id: string; color: string }> = [
  { id: "default", color: "#8E8E9C" }, { id: "eaon", color: "#F17455" }, { id: "white", color: "#FFFFFF" },
  { id: "red", color: "#e03e3e" }, { id: "orange", color: "#e8a838" }, { id: "yellow", color: "#c4b500" },
  { id: "lime", color: "#55a630" }, { id: "green", color: "#2d9f4f" }, { id: "mint", color: "#30b08c" },
  { id: "teal", color: "#2ec4b6" }, { id: "blue", color: "#3b82f6" }, { id: "indigo", color: "#5c6bc0" },
  { id: "purple", color: "#9b59b6" }, { id: "pink", color: "#e91e90" },
];

/** Bundled UI fonts. Space Grotesk is the app's default face (matches the
 *  Mac app); IBM Plex Mono renders code regardless of the UI choice. */
export const FONT_OPTIONS: Array<{ id: string; label: string; stack: string }> = [
  { id: "space-grotesk", label: "Space Grotesk", stack: '"Space Grotesk", "IBM Plex Sans", system-ui, sans-serif' },
  { id: "ibm-plex", label: "IBM Plex Sans", stack: '"IBM Plex Sans", system-ui, sans-serif' },
  { id: "system", label: "System", stack: "system-ui, sans-serif" },
];

/** `eaon-local-` + 24 random alphanumerics — the Local API Server's
 *  generated bearer key format. */
export function generateLocalServerKey(): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let key = "eaon-local-";
  for (let i = 0; i < 24; i++) key += chars[Math.floor(Math.random() * chars.length)];
  return key;
}

/** Rough context-window table for the badge — Ollama models report theirs
 *  live; hosted/BYOK fall back to family knowledge (chars/4 estimator). */
export function contextWindowFor(modelId: string): number {
  const id = modelId.toLowerCase();
  if (/claude|opus|sonnet|haiku|fable/.test(id)) return 200_000;
  if (/gemini/.test(id)) return 1_000_000;
  if (/gpt-5|gpt-4/.test(id)) return 128_000;
  if (/deepseek|glm|kimi|qwen|minimax|grok/.test(id)) return 128_000;
  if (/gemma/.test(id)) return 8_000;
  return 32_000;
}
