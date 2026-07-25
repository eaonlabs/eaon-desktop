// Brand detection + logo lookup — a compact port of the Mac app's
// ModelCatalog.brand(for:) matching, using the same BrandLogos assets
// (copied verbatim into /public/brand-logos). Theme-variant marks
// (openai-dark/-light, etc.) resolve by active theme.

export interface Brand {
  company: string;
  /** file names inside /brand-logos; darkFile used on the dark theme. */
  file?: string;
  darkFile?: string;
}

const B = (company: string, file?: string, darkFile?: string): Brand => ({ company, file, darkFile });

/** Ordered substring rules — first match wins (mirrors the Mac matcher's
 * spirit: check distinctive names before generic ones). */
const RULES: Array<[RegExp, Brand]> = [
  [/claude|opus|sonnet|haiku|fable|anthropic/i, B("Anthropic", "anthropic-light.png", "anthropic-dark.png")],
  [/gpt|openai|o[13]-|codex/i, B("OpenAI", "openai-light.png", "openai-dark.png")],
  [/gemini|gemma|diffusion-gemma|\bgoogle\b/i, B("Google", "google.png")],
  [/deepseek/i, B("DeepSeek", "deepseek.png")],
  [/qwen|qwq/i, B("Qwen", "qwen.png")],
  [/llama|meta/i, B("Meta", "meta.png")],
  [/grok|xai/i, B("xAI", "xai-light.png", "xai-dark.png")],
  [/kimi|moonshot/i, B("Moonshot", "kimi-light.png", "kimi-dark.png")],
  [/glm|zhipu|chatglm/i, B("Zhipu", "zhipu-light.png", "zhipu-dark.png")],
  [/minimax/i, B("MiniMax", "minimax.png")],
  [/mistral|mixtral|magistral|devstral|codestral/i, B("Mistral", "mistral.png")],
  [/nemotron|nvidia/i, B("NVIDIA", "nvidia.png")],
  [/nova|amazon/i, B("Amazon", "amazon.svg")],
  [/hermes|nous/i, B("Nous Research", "nousresearch.svg")],
  [/mimo|xiaomi/i, B("Xiaomi", "xiaomi.png")],
  [/step-/i, B("StepFun", "stepfun.png")],
  [/sonar|perplexity/i, B("Perplexity", "perplexity.png")],
  [/mercury|inception/i, B("Inception", "inception.svg")],
  [/granite/i, B("IBM", "ibm.svg")],
  [/phi[0-9-]/i, B("Microsoft", "microsoft.svg")],
  [/command|aya|cohere/i, B("Cohere", "cohere.svg")],
  [/falcon/i, B("TII", "tii.svg")],
  [/\byi\b|zeroone/i, B("01.AI", "zeroone.svg")],
  [/olmo|allenai/i, B("Allen AI", "allenai.svg")],
  [/dbrx|databricks/i, B("Databricks", "databricks.svg")],
  [/stable|stability/i, B("Stability AI", "stability.svg")],
  [/solar|upstage/i, B("Upstage", "upstage.svg")],
  [/exaone|lg-/i, B("LG", "lg.svg")],
  [/lfm|liquid/i, B("Liquid AI", "liquidai.svg")],
  [/groq/i, B("Groq", "groq.svg")],
  [/cerebras/i, B("Cerebras", "cerebras-light.svg", "cerebras-dark.svg")],
  [/openrouter/i, B("OpenRouter", "openrouter.svg")],
  [/baidu|ernie/i, B("Baidu", "baidu.svg")],
  [/doubao|bytedance|seed/i, B("ByteDance", "bytedance.svg")],
  [/ai21|jamba/i, B("AI21", "ai21.svg")],
  [/intel/i, B("Intel", "intel.svg")],
];

/** The `brand` strings CuratedOllamaModels.json uses → logo files. */
const CATALOG_BRANDS: Record<string, Brand> = {
  meta: B("Meta", "meta.png"),
  qwen: B("Qwen", "qwen.png"),
  google: B("Google", "google.png"),
  deepSeek: B("DeepSeek", "deepseek.png"),
  microsoft: B("Microsoft", "microsoft.svg"),
  cohere: B("Cohere", "cohere.svg"),
  openAI: B("OpenAI", "openai-light.png", "openai-dark.png"),
  zhipu: B("Zhipu", "zhipu-light.png", "zhipu-dark.png"),
  ibm: B("IBM", "ibm.svg"),
  mistral: B("Mistral", "mistral.png"),
  nvidia: B("NVIDIA", "nvidia.png"),
  stabilityAI: B("Stability AI", "stability.svg"),
  nous: B("Nous Research", "nousresearch.svg"),
  intel: B("Intel", "intel.svg"),
  tii: B("TII", "tii.svg"),
  zeroOneAI: B("01.AI", "zeroone.svg"),
  allenAI: B("Allen AI", "allenai.svg"),
  lg: B("LG", "lg.svg"),
  upstage: B("Upstage", "upstage.svg"),
  databricks: B("Databricks", "databricks.svg"),
  liquidAI: B("Liquid AI", "liquidai.svg"),
  anthropic: B("Anthropic", "anthropic-light.png", "anthropic-dark.png"),
};

export function brandForModel(modelId: string): Brand {
  // Strip provider prefixes ("ollama:", "custom:cfg:", "eaon:") before
  // matching (legacy-branded key prefixes are rewritten to "eaon:" by the
  // state migration before they ever reach the picker).
  const bare = modelId.replace(/^ollama:/, "").replace(/^custom:[^:]+:/, "").replace(/^eaon:/, "");
  for (const [re, brand] of RULES) {
    if (re.test(bare)) return brand;
  }
  return B(bare.split(/[:/]/)[0] || "Model");
}

export function brandFromCatalogKey(key: string | null | undefined): Brand | null {
  if (!key) return null;
  return CATALOG_BRANDS[key] ?? null;
}

export function logoPath(brand: Brand, isDark: boolean): string | null {
  const file = isDark && brand.darkFile ? brand.darkFile : brand.file;
  return file ? `/brand-logos/${file}` : null;
}

/** One-call convenience for UI: model/provider name straight to a logo URL
 *  for the active theme (null when the brand has no bundled mark). */
export function logoFor(name: string, theme: "dark" | "light"): string | null {
  return logoPath(brandForModel(name), theme === "dark");
}
