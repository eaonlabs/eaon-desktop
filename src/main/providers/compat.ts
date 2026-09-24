import type { EffortLevel, ModelInfo, Provider } from '@shared/types'
import { inferEfforts } from './models'

/**
 * Per-provider quirks, in one place.
 *
 * "OpenAI-compatible" is a family resemblance, not a spec: each host turns
 * thinking on differently, caps output in a different field, and some reject
 * requests the next one accepts. Every rule here was taken from Eaon Code's
 * provider compat tables (`packages/ai/src/api/openai-completions.ts`
 * `detectCompat`, the per-model data files) and is keyed on the provider id
 * *or* the host, so a custom endpoint pointed at, say, api.deepseek.com gets
 * the same treatment as the built-in entry.
 */

export type Vendor =
  | 'openai'
  | 'azure'
  | 'openrouter'
  | 'deepseek'
  | 'moonshot'
  | 'kimi-coding'
  | 'zai'
  | 'qwen'
  | 'xiaomi'
  | 'minimax'
  | 'together'
  | 'groq'
  | 'cerebras'
  | 'xai'
  | 'mistral'
  | 'gemini'
  | 'nvidia'
  | 'fireworks'
  | 'baseten'
  | 'copilot'
  | 'codex'
  | 'opencode'
  | 'vercel'
  | 'cloudflare-workers'
  | 'cloudflare-gateway'
  | 'perplexity'
  | 'ollama'
  | 'other'

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

const HOSTS: [RegExp, Vendor][] = [
  [/(^|\.)api\.openai\.com$/, 'openai'],
  [/\.(openai\.azure\.com|cognitiveservices\.azure\.com|ai\.azure\.com)$/, 'azure'],
  [/(^|\.)openrouter\.ai$/, 'openrouter'],
  [/(^|\.)deepseek\.com$/, 'deepseek'],
  [/(^|\.)moonshot\.(ai|cn)$/, 'moonshot'],
  [/(^|\.)kimi\.com$/, 'kimi-coding'],
  [/(^|\.)(z\.ai|bigmodel\.cn)$/, 'zai'],
  [/(^|\.)aliyuncs\.com$/, 'qwen'],
  [/(^|\.)xiaomimimo\.com$/, 'xiaomi'],
  [/(^|\.)(minimax\.io|minimaxi\.com)$/, 'minimax'],
  [/(^|\.)together\.(ai|xyz)$/, 'together'],
  [/(^|\.)groq\.com$/, 'groq'],
  [/(^|\.)cerebras\.ai$/, 'cerebras'],
  [/(^|\.)x\.ai$/, 'xai'],
  [/(^|\.)mistral\.ai$/, 'mistral'],
  [/(^|\.)generativelanguage\.googleapis\.com$/, 'gemini'],
  [/(^|\.)nvidia\.com$/, 'nvidia'],
  [/(^|\.)fireworks\.ai$/, 'fireworks'],
  [/(^|\.)baseten\.co$/, 'baseten'],
  [/(^|\.)githubcopilot\.com$/, 'copilot'],
  [/(^|\.)chatgpt\.com$/, 'codex'],
  [/(^|\.)opencode\.ai$/, 'opencode'],
  [/(^|\.)ai-gateway\.vercel\.sh$/, 'vercel'],
  [/^api\.cloudflare\.com$/, 'cloudflare-workers'],
  [/^gateway\.ai\.cloudflare\.com$/, 'cloudflare-gateway'],
  [/(^|\.)perplexity\.ai$/, 'perplexity']
]

const IDS: Record<string, Vendor> = {
  openai: 'openai',
  'openai-codex': 'codex',
  'github-copilot': 'copilot',
  azure: 'azure',
  openrouter: 'openrouter',
  deepseek: 'deepseek',
  moonshot: 'moonshot',
  'moonshot-cn': 'moonshot',
  'kimi-coding': 'kimi-coding',
  zai: 'zai',
  'zai-coding': 'zai',
  'zai-cn': 'zai',
  'zai-coding-cn': 'zai',
  qwen: 'qwen',
  'qwen-cn': 'qwen',
  'qwen-token-plan': 'qwen',
  'qwen-token-plan-cn': 'qwen',
  xiaomi: 'xiaomi',
  'xiaomi-token-plan': 'xiaomi',
  minimax: 'minimax',
  'minimax-cn': 'minimax',
  together: 'together',
  groq: 'groq',
  cerebras: 'cerebras',
  xai: 'xai',
  mistral: 'mistral',
  gemini: 'gemini',
  'nvidia-nim': 'nvidia',
  fireworks: 'fireworks',
  baseten: 'baseten',
  opencode: 'opencode',
  'opencode-go': 'opencode',
  vercel: 'vercel',
  'cloudflare-workers-ai': 'cloudflare-workers',
  'cloudflare-ai-gateway': 'cloudflare-gateway',
  perplexity: 'perplexity',
  ollama: 'ollama'
}

/** Which service a provider really is — by built-in id first, then by the host it points at. */
export function vendorOf(provider: Pick<Provider, 'id' | 'kind' | 'baseUrl'>, baseUrl = provider.baseUrl): Vendor {
  const byId = IDS[provider.id]
  if (byId) return byId
  if (provider.kind === 'ollama') return 'ollama'
  const host = hostOf(baseUrl)
  for (const [pattern, vendor] of HOSTS) if (pattern.test(host)) return vendor
  return 'other'
}

/* --------------------------------------------------------------- effort */

const WIRE_EFFORT: Record<EffortLevel, string> = {
  light: 'low',
  medium: 'medium',
  high: 'high',
  'extra-high': 'xhigh',
  ultra: 'max'
}

const ORDER: EffortLevel[] = ['light', 'medium', 'high', 'extra-high', 'ultra']

/** The model's effort levels: from the catalog, else inferred from its id. */
export function effortsFor(modelId: string, model: ModelInfo | undefined): EffortLevel[] {
  return model?.efforts ?? inferEfforts(modelId) ?? []
}

/**
 * The level to actually request: the chosen one if the model takes it,
 * otherwise the nearest level below it the model does take (a model that stops
 * at "high" gets "high" for "ultra", not its lowest setting).
 */
export function clampEffort(requested: EffortLevel, efforts: EffortLevel[]): EffortLevel | undefined {
  if (efforts.length === 0) return undefined
  if (efforts.includes(requested)) return requested
  for (let i = ORDER.indexOf(requested); i >= 0; i--) if (efforts.includes(ORDER[i])) return ORDER[i]
  return efforts[0]
}

/**
 * The string a provider expects for a level. Almost everyone speaks
 * low/medium/high/xhigh/max; Groq's older Qwen models only know "default".
 */
export function wireEffort(level: EffortLevel, vendor: Vendor, modelId: string): string {
  if (vendor === 'groq' && /qwen3(\.[0-6])?([-/]|$)|qwen3-32b/.test(modelId.toLowerCase())) return 'default'
  return WIRE_EFFORT[level]
}

/* --------------------------------------------------------- chat compat */

export type ThinkingFormat = 'openai' | 'openrouter' | 'deepseek' | 'zai' | 'qwen' | 'together'

export interface ChatCompat {
  vendor: Vendor
  /** Field the output cap goes in. */
  maxTokensField: 'max_tokens' | 'max_completion_tokens'
  /** How reasoning is switched on for models that reason. */
  thinking: ThinkingFormat
  /** False where `reasoning_effort` is rejected outright (xAI and Copilot chat, NVIDIA, Perplexity). */
  sendsEffort: boolean
  /**
   * DeepSeek-style APIs (DeepSeek, Xiaomi MiMo, Kimi K3) require
   * `reasoning_content` on every replayed assistant message once thinking is
   * on, and reject tool-call turns without it.
   */
  reasoningOnEveryAssistant: boolean
  /** OpenAI routes requests sharing this key to the same cache shard. */
  promptCacheKey: boolean
  /** z.ai only streams tool-call arguments when asked; otherwise they arrive at the end. */
  toolStream: boolean
  /** Groq returns Qwen reasoning inline in <think> tags unless asked to parse it out. */
  parsedReasoning: boolean
  /** How the key is sent. */
  auth: 'bearer' | 'api-key' | 'cf-aig'
  /** Header carrying the conversation key for prefix-cache routing, where the host uses one. */
  sessionHeader?: string
}

export function chatCompat(provider: Provider, baseUrl: string, modelId: string): ChatCompat {
  const vendor = vendorOf(provider, baseUrl)
  const id = modelId.toLowerCase()
  const maxTokensField: ChatCompat['maxTokensField'] =
    vendor === 'openai' || vendor === 'azure' ? 'max_completion_tokens' : 'max_tokens'

  let thinking: ThinkingFormat = 'openai'
  if (vendor === 'openrouter') thinking = 'openrouter'
  else if (vendor === 'deepseek' || vendor === 'xiaomi') thinking = 'deepseek'
  // Kimi K2.x toggles thinking DeepSeek-style; K3 takes a plain reasoning_effort.
  else if (vendor === 'moonshot') thinking = /k3/.test(id) ? 'openai' : 'deepseek'
  else if (vendor === 'zai') thinking = 'zai'
  else if (vendor === 'qwen') thinking = 'qwen'
  else if (vendor === 'together' && !/gpt-oss/.test(id)) thinking = 'together'

  return {
    vendor,
    maxTokensField,
    thinking,
    sendsEffort: !['xai', 'copilot', 'nvidia', 'perplexity', 'cloudflare-gateway'].includes(vendor),
    reasoningOnEveryAssistant:
      vendor === 'deepseek' || vendor === 'xiaomi' || (vendor === 'moonshot' && /k3/.test(id)),
    promptCacheKey: vendor === 'openai' || vendor === 'azure',
    toolStream: vendor === 'zai',
    parsedReasoning: vendor === 'groq' && /qwen|deepseek-r1/.test(id),
    auth: vendor === 'azure' ? 'api-key' : vendor === 'cloudflare-gateway' ? 'cf-aig' : 'bearer',
    // (OpenCode's own session header is added by the router, for every API it serves.)
    sessionHeader:
      vendor === 'cloudflare-workers' || vendor === 'fireworks' ? 'x-session-affinity' : vendor === 'openrouter' ? 'x-session-id' : undefined
  }
}

/**
 * Request headers carrying the key, in the form the host expects. Azure takes
 * `api-key`; Cloudflare's AI Gateway authenticates the gateway itself through
 * `cf-aig-authorization` and must not see an upstream `Authorization` header,
 * which it would forward to the model provider.
 */
export function authHeaders(auth: ChatCompat['auth'], apiKey: string | undefined): Record<string, string> {
  if (!apiKey) return {}
  if (auth === 'api-key') return { 'api-key': apiKey }
  if (auth === 'cf-aig') return { 'cf-aig-authorization': `Bearer ${apiKey}` }
  return { Authorization: `Bearer ${apiKey}` }
}

/* ----------------------------------------------------------- base URLs */

/**
 * Azure resource URLs come in several shapes — the bare resource, `/openai`,
 * a full `/openai/v1/chat/completions` endpoint, a legacy deployment URL, an
 * AI Foundry project URL. The v1 API lives at `/openai/v1` on all of them and
 * takes the deployment name as the model id, so every form collapses to that.
 */
export function normalizeAzureUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  let url: URL
  try {
    url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`)
  } catch {
    return trimmed
  }
  if (!/\.(openai\.azure\.com|cognitiveservices\.azure\.com|ai\.azure\.com)$/.test(url.hostname)) return trimmed
  const path = url.pathname.replace(/\/+$/, '')
  if (
    path === '' ||
    path === '/openai' ||
    /^\/openai\/v1(\/|$)/.test(path) ||
    /^\/openai\/deployments\//.test(path) ||
    /^\/api\/projects\//.test(path)
  ) {
    url.pathname = '/openai/v1'
    url.search = ''
  }
  return url.toString().replace(/\/+$/, '')
}

/** Normalizes a base URL on save, for providers whose URLs users paste in several shapes. */
export function normalizeBaseUrl(provider: Pick<Provider, 'id' | 'kind' | 'baseUrl'>, raw: string): string {
  if (vendorOf(provider, raw) === 'azure') return normalizeAzureUrl(raw)
  return raw.trim()
}

/** Unfilled `{placeholder}`s in a templated base URL (Cloudflare account id, gateway id…). */
export function missingUrlFields(baseUrl: string): string[] {
  return [...baseUrl.matchAll(/\{([a-z_]+)\}/gi)].map((match) => match[1])
}

/**
 * The base URL a request goes to, with a clear error when the user still has
 * to fill part of it in — better than a DNS failure on `{account_id}`.
 */
export function requestBase(provider: Provider, credentialsBase: string | undefined): string {
  const base = (credentialsBase ?? provider.baseUrl).trim().replace(/\/+$/, '')
  if (!base) throw new Error(`No base URL is set for ${provider.name}. Add one in Settings → Model providers.`)
  const missing = missingUrlFields(base)
  if (missing.length > 0) {
    const names = missing.map((key) => key.replace(/_/g, ' ')).join(' and ')
    throw new Error(`Fill in your ${names} for ${provider.name} in Settings → Model providers.`)
  }
  return vendorOf(provider, base) === 'azure' ? normalizeAzureUrl(base) : base
}

/* -------------------------------------------------------------- routing */

/** Wire format of one request. */
export type WireApi = 'anthropic' | 'openai-responses' | 'openai-chat' | 'ollama'

/**
 * Providers that serve different model families over different APIs behind
 * one key: GitHub Copilot and OpenCode Zen/Go put Claude on Anthropic
 * Messages, GPT-5-era OpenAI models on Responses, and everything else on chat
 * completions. The splits follow Eaon Code's per-model catalogs.
 */
export function isMixedApiProvider(provider: Pick<Provider, 'id' | 'kind' | 'baseUrl'>): boolean {
  const vendor = vendorOf(provider)
  return vendor === 'copilot' || vendor === 'opencode'
}

/** OpenCode serves these non-Claude models over Anthropic Messages too. */
const OPENCODE_ANTHROPIC: Record<string, string[]> = {
  opencode: ['qwen3.5-plus', 'qwen3.6-plus'],
  'opencode-go': ['minimax-m3', 'qwen3.8-flash']
}

export function wireApiFor(provider: Provider, modelId: string): WireApi {
  if (provider.kind === 'anthropic') return 'anthropic'
  if (provider.kind === 'ollama') return 'ollama'
  if (provider.kind === 'openai-responses') return 'openai-responses'
  if (!isMixedApiProvider(provider)) return 'openai-chat'

  const id = modelId.toLowerCase()
  if (/^claude/.test(id)) return 'anthropic'
  const vendor = vendorOf(provider)
  if (vendor === 'opencode') {
    const go = provider.id === 'opencode-go' || /\/zen\/go/.test(provider.baseUrl)
    if (OPENCODE_ANTHROPIC[go ? 'opencode-go' : 'opencode'].includes(id)) return 'anthropic'
    if (/^(gpt-|grok-|muse-spark)/.test(id)) return 'openai-responses'
    return 'openai-chat'
  }
  // Copilot: GPT-5 and later, recent Grok and MAI models answer on /responses only.
  if (/^(gpt-5|gpt-6|o[1-9])/.test(id) || /^grok-4\.[5-9]|^mai-/.test(id)) return 'openai-responses'
  return 'openai-chat'
}

/**
 * Base URL for one wire format on a mixed provider. OpenCode serves Anthropic
 * Messages from the root the SDK appends `/v1/messages` to, and everything
 * else under `/v1`.
 */
export function baseForWire(provider: Provider, base: string, wire: WireApi): string {
  if (vendorOf(provider, base) !== 'opencode') return base
  const root = base.replace(/\/v1$/, '')
  return wire === 'anthropic' ? root : `${root}/v1`
}

/* ----------------------------------------------------- anthropic compat */

export interface AnthropicCompat {
  /** api.anthropic.com: betas, server-side context editing and automatic caching are available. */
  firstParty: boolean
  /** How to ask a non-Claude model on an Anthropic-compatible endpoint to think. */
  thinking: 'claude' | 'adaptive' | 'budget' | 'none'
}

export function anthropicCompat(provider: Provider, baseUrl: string, modelId: string, model: ModelInfo | undefined): AnthropicCompat {
  // The built-in Anthropic provider with its URL changed is almost always a
  // proxy in front of Anthropic itself, so it keeps betas and caching; other
  // Anthropic-compatible hosts (MiniMax, Kimi) reject them.
  const firstParty =
    !baseUrl || /(^|\.)api\.anthropic\.com$/.test(hostOf(baseUrl)) || (provider.id === 'anthropic' && provider.builtIn)
  const id = modelId.toLowerCase()
  if (id.includes('claude')) return { firstParty, thinking: 'claude' }
  const vendor = vendorOf(provider, baseUrl)
  // Kimi For Coding only takes adaptive thinking; MiniMax and the rest take a budget.
  if (vendor === 'kimi-coding') return { firstParty, thinking: 'adaptive' }
  return { firstParty, thinking: model?.reasoning ? 'budget' : 'none' }
}
