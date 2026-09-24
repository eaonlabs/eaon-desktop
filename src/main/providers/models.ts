import type { EffortLevel, ModelInfo, Provider } from '@shared/types'

/**
 * What the app knows about a model from its id alone.
 *
 * Provider `/models` endpoints return little beyond ids, so capabilities that
 * change request shape — whether effort is accepted, which thinking config a
 * Claude model takes, how many output tokens are allowed — are inferred here.
 * Getting these wrong is not cosmetic: sending `output_config.effort` to a
 * model that rejects it, or `budget_tokens` to one that removed it, fails the
 * whole request.
 */

export const ALL_EFFORTS: EffortLevel[] = ['light', 'medium', 'high', 'extra-high', 'ultra']

/**
 * OpenAI's `reasoning_effort` only accepts low/medium/high on most models, so
 * offering the two extra tiers there would be a lie — both would collapse to
 * "high" on the wire.
 */
export const OPENAI_EFFORTS: EffortLevel[] = ['light', 'medium', 'high']

/** Claude families by how they take thinking and effort. */
type ClaudeFamily =
  | 'always-adaptive' // Fable 5/5.1, Mythos, Opus 5.5: thinking cannot be turned off
  | 'adaptive' // Opus 5, Sonnet 5, Opus 4.6–4.8, Sonnet 4.6
  | 'budget' // Haiku 4.5, Sonnet/Opus 4.5 and older 4.x, Sonnet 3.7
  | 'none' // 3.5 and older

/**
 * GitHub Copilot, OpenCode and Cloudflare write versions with dots
 * (`claude-opus-4.8`) where Anthropic writes hyphens (`claude-opus-4-8`).
 * Without normalising, a dotted Opus 4.8 falls through to the budget family
 * and is sent `budget_tokens`, which it rejects.
 */
const hyphenateVersions = (id: string): string => id.replace(/(\d)\.(\d)/g, '$1-$2')

function claudeFamily(raw: string): ClaudeFamily {
  const id = hyphenateVersions(raw)
  if (/fable|mythos|opus-5-5/.test(id)) return 'always-adaptive'
  if (/opus-5|sonnet-5|opus-4-[678]|sonnet-4-6/.test(id)) return 'adaptive'
  if (/haiku-4|sonnet-4|opus-4|3-7-sonnet|sonnet-3-7/.test(id)) return 'budget'
  return 'none'
}

/**
 * Which effort levels a model actually accepts. Returning `undefined` means the
 * model has no effort control at all, and the UI hides the picker rather than
 * offering a setting the request would reject or silently ignore.
 */
export function inferEfforts(modelId: string): EffortLevel[] | undefined {
  const id = hyphenateVersions(modelId.toLowerCase())

  if (id.includes('claude')) {
    const family = claudeFamily(id)
    if (family === 'always-adaptive') return ALL_EFFORTS
    if (family === 'adaptive') {
      // `xhigh` arrived with Opus 4.7; the 4.6 generation stops at high → max.
      return /4-6/.test(id) ? ['light', 'medium', 'high', 'ultra'] : ALL_EFFORTS
    }
    // Opus 4.5 takes low/medium/high; the rest of the budget family rejects effort.
    if (/opus-4-5/.test(id)) return OPENAI_EFFORTS
    return undefined
  }

  // OpenAI reasoning families, however a gateway prefixes them.
  const tail = modelId.toLowerCase().slice(modelId.lastIndexOf('/') + 1)
  if (/^o[1-9](-|$)/.test(tail) || /^gpt-[56]/.test(tail) || /^codex/.test(tail) || /gpt-oss/.test(tail)) {
    return OPENAI_EFFORTS
  }
  // Grok 3 mini and Grok 4 reasoning accept low/high; treat as the OpenAI trio.
  if (/grok-(3-mini|4)/.test(tail)) return OPENAI_EFFORTS
  // Gemini 2.5+/3 accept reasoning_effort on the OpenAI-compatible endpoint.
  if (/gemini-(2\.5|3)/.test(tail)) return OPENAI_EFFORTS

  return undefined
}

/** True for models that reason before answering, so the UI can show the thinking trace. */
export function inferReasoning(modelId: string): boolean {
  const id = modelId.toLowerCase()
  if (id.includes('claude')) return claudeFamily(id) !== 'none'
  return (
    inferEfforts(id) !== undefined ||
    /deepseek-(r1|reasoner|v3\.[12]|v4)|deepseek-flash|qwq|qwen3|thinking|reason|kimi-k[23]|glm-4\.[5-9]|glm-5|minimax-m|magistral|phi-4-reasoning|nemotron|mimo|gemma-?4|sonar-reasoning|sonar-deep-research|command-a-reasoning/.test(
      id
    )
  )
}

const BUDGETS: Record<EffortLevel, number> = {
  light: 2048,
  medium: 6000,
  high: 12000,
  'extra-high': 20000,
  ultra: 28000
}

/**
 * Budget-style thinking (`{type: 'enabled', budget_tokens}`), sized from the
 * effort and kept strictly below `max_tokens` as the Messages API requires.
 * Used for budget-era Claude models and for non-Claude models on
 * Anthropic-compatible endpoints that take a budget (MiniMax).
 */
export function budgetThinking(effort: EffortLevel, maxTokens: number): { type: 'enabled'; budget_tokens: number } | undefined {
  const budget = Math.min(BUDGETS[effort], maxTokens - 1024)
  return budget >= 1024 ? { type: 'enabled', budget_tokens: budget } : undefined
}

/**
 * The Anthropic `thinking` parameter for a model, or undefined to omit it.
 *
 * Budget-era models still need `budget_tokens`, sized from the chosen effort
 * and kept strictly below `max_tokens` as the API requires. Everything from
 * the 4.6 generation on takes adaptive thinking, with a summarised display so
 * the reasoning trace has something to show (the default on newer models is
 * an empty string).
 */
export function anthropicThinking(
  modelId: string,
  effort: EffortLevel,
  maxTokens: number
): { type: 'adaptive'; display: 'summarized' } | { type: 'enabled'; budget_tokens: number } | undefined {
  const family = claudeFamily(modelId.toLowerCase())
  if (family === 'always-adaptive' || family === 'adaptive') return { type: 'adaptive', display: 'summarized' }
  if (family === 'budget') return budgetThinking(effort, maxTokens)
  return undefined
}

/** Largest output a request should ask for. Streaming makes the large values safe. */
export function maxOutputFor(provider: Provider, modelId: string, model: ModelInfo | undefined): number | undefined {
  if (model?.maxOutput) return model.maxOutput
  const id = hyphenateVersions(modelId.toLowerCase())
  if (id.includes('claude')) {
    const family = claudeFamily(id)
    if (family === 'always-adaptive' || family === 'adaptive') return 64_000
    if (/haiku-4|sonnet-4|opus-4-5/.test(id)) return 64_000
    if (/opus-4/.test(id)) return 32_000
    return 8192
  }
  // Local runtimes: leave it to the server rather than overflow a small context.
  if (provider.local) return undefined
  return undefined
}

/**
 * Context window to plan compaction against when the catalog does not say.
 *
 * Conservative on purpose: overestimating means the request fails at the
 * provider, underestimating only means compacting a little early. Local
 * runtimes get the size the app asks Ollama to allocate (see the Ollama
 * adapter), not the model's theoretical maximum.
 */
export function contextWindowFor(provider: Provider, modelId: string, model: ModelInfo | undefined): number {
  if (model?.contextWindow) return model.contextWindow
  if (provider.local) return isOllamaCloudModel(modelId) ? 131_072 : LOCAL_CONTEXT
  const id = modelId.toLowerCase()
  if (id.includes('claude')) return /haiku-4-5|sonnet-4-5|opus-4-[015]|3-/.test(hyphenateVersions(id)) ? 200_000 : 1_000_000
  if (/gpt-5|gpt-4\.1|gemini|llama-4|grok-4|minimax/.test(id)) return 400_000
  if (/gpt-4o|o[1-9]|deepseek|qwen|kimi|glm|mistral|codestral|grok/.test(id)) return 128_000
  return 128_000
}

/**
 * The context size requested from local runtimes (Ollama's `num_ctx`) and
 * planned against by the loop. Big enough for an agent prompt with its tool
 * definitions and a working transcript; small enough that the KV cache of a
 * 20B model still fits next to the weights on a 32 GB machine. A model whose
 * trained context is shorter gets its own length instead (see `refreshModels`).
 */
export const LOCAL_CONTEXT = 32_768

/** Ollama's `:cloud` models run on Ollama's servers, at their full window. */
export function isOllamaCloudModel(modelId: string): boolean {
  return /[:-]cloud$/.test(modelId)
}

/** Turn a raw model id into something short enough for the composer chip. */
export function prettyLabel(id: string): string {
  const tail = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id
  return tail
    .replace(/[-_]/g, ' ')
    .replace(/\b(gpt|llama|qwen|mistral|claude|gemini|glm|oss)\b/gi, (m) => m.toUpperCase())
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Fills in capabilities the provider's `/models` listing did not report, so a
 * freshly refreshed list still knows which models reason and take effort.
 */
export function enrichModel(model: ModelInfo): ModelInfo {
  return {
    ...model,
    efforts: model.efforts ?? inferEfforts(model.id),
    reasoning: model.reasoning ?? inferReasoning(model.id)
  }
}

/**
 * Ids a `/models` listing returns that cannot chat — embeddings, TTS, image
 * generation, moderation. Hiding them keeps a refreshed OpenAI list from
 * burying the dozen chat models under a hundred that would 404 on
 * /chat/completions.
 */
export function isChatModelId(id: string): boolean {
  return !/(^|[-/_.@])(embed|embedding|embeddings|tts|whisper|transcribe|dall-e|gpt-image|image|imagen|moderation|rerank|reranker|audio|realtime|search-preview|davinci|babbage|sora|veo|lyria|speech|clip|vision-embed|guard|flux|stable-diffusion|sdxl|ocr|bge|e5|gte|seedream|seedance|kling|hailuo|recraft|midjourney|upscale|asr|stt)([-/_.:]|\d|$)/i.test(
    id
  )
}
