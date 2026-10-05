import type { EffortLevel, ModelInfo } from '@shared/types'
import { EFFORT_FROM_WIRE, EFFORT_ORDER, orderEfforts, WIRE_EFFORT } from '@shared/effort'

/**
 * Where the model catalog comes from, and how each source turns into
 * `ModelInfo`. Pure functions only: `scripts/generate-models.mjs` runs this at
 * build time and `modelCatalog.ts` runs it again at refresh time.
 *
 * The approach is Pi's (`@earendil-works/pi-ai`, which Eaon Code forks): model
 * lists are generated from models.dev — the community catalog of every
 * provider's models, limits and reasoning options — plus Pi's own
 * corrections, rather than typed in by hand. Eaon takes Pi's published data
 * for the providers Pi covers (corrected, so it wins), models.dev directly
 * for the rest, and at runtime re-reads models.dev so a model released after
 * the build still shows up.
 */

/** Eaon provider id → Pi's provider data file (`dist/providers/data/<name>.json`). */
export const PI_SOURCES: Record<string, string> = {
  anthropic: 'anthropic',
  openai: 'openai',
  // Sign in with ChatGPT and the Codex sign-in serve the same plan models.
  chatgpt: 'openai-codex',
  'openai-codex': 'openai-codex',
  'github-copilot': 'github-copilot',
  'kimi-coding': 'kimi-coding',
  // Pi's `zai` is the coding-plan endpoint; the pay-as-you-go one comes from models.dev.
  'zai-coding': 'zai',
  'zai-coding-cn': 'zai-coding-cn',
  'qwen-token-plan': 'qwen-token-plan',
  'qwen-token-plan-cn': 'qwen-token-plan-cn',
  'xiaomi-token-plan': 'xiaomi-token-plan-sgp',
  'xiaomi-token-plan-cn': 'xiaomi-token-plan-cn',
  'opencode-go': 'opencode-go',
  opencode: 'opencode',
  gemini: 'google',
  xai: 'xai',
  mistral: 'mistral',
  deepseek: 'deepseek',
  moonshot: 'moonshotai',
  'moonshot-cn': 'moonshotai-cn',
  minimax: 'minimax',
  'minimax-cn': 'minimax-cn',
  xiaomi: 'xiaomi',
  openrouter: 'openrouter',
  vercel: 'vercel-ai-gateway',
  'cloudflare-ai-gateway': 'cloudflare-ai-gateway',
  'cloudflare-workers-ai': 'cloudflare-workers-ai',
  huggingface: 'huggingface',
  groq: 'groq',
  cerebras: 'cerebras',
  fireworks: 'fireworks',
  together: 'together',
  baseten: 'baseten',
  'nvidia-nim': 'nvidia'
}

/**
 * Eaon provider id → models.dev provider id. Covers every provider models.dev
 * knows, Pi-sourced ones included: at runtime it is how a model newer than
 * the build is found.
 */
export const MODELS_DEV_SOURCES: Record<string, string> = {
  anthropic: 'anthropic',
  openai: 'openai',
  'github-copilot': 'github-copilot',
  'kimi-coding': 'kimi-code-plan-cn',
  'zai-coding': 'zai-coding-plan',
  'zai-coding-cn': 'zhipuai-coding-plan',
  'qwen-token-plan': 'alibaba-token-plan',
  'qwen-token-plan-cn': 'alibaba-token-plan-cn',
  'xiaomi-token-plan': 'xiaomi-token-plan-sgp',
  'xiaomi-token-plan-cn': 'xiaomi-token-plan-cn',
  'opencode-go': 'opencode-go',
  opencode: 'opencode',
  gemini: 'google',
  xai: 'xai',
  mistral: 'mistral',
  deepseek: 'deepseek',
  moonshot: 'moonshotai',
  'moonshot-cn': 'moonshotai-cn',
  zai: 'zai',
  'zai-cn': 'zhipuai',
  qwen: 'alibaba',
  'qwen-cn': 'alibaba-cn',
  minimax: 'minimax',
  'minimax-cn': 'minimax-cn',
  xiaomi: 'xiaomi',
  cohere: 'cohere',
  perplexity: 'perplexity',
  openrouter: 'openrouter',
  poe: 'poe',
  vercel: 'vercel',
  'cloudflare-ai-gateway': 'cloudflare-ai-gateway',
  'cloudflare-workers-ai': 'cloudflare-workers-ai',
  huggingface: 'huggingface',
  groq: 'groq',
  cerebras: 'cerebras',
  fireworks: 'fireworks-ai',
  together: 'togetherai',
  baseten: 'baseten',
  deepinfra: 'deepinfra',
  novita: 'novita-ai',
  nebius: 'nebius',
  'nvidia-nim': 'nvidia'
}

/** Providers whose models answer search questions without tools (Sonar); everywhere else a model must call tools. */
const TOOLLESS_OK = new Set(['perplexity'])

/** A catalog entry before it is filed under a provider. */
export type CatalogModel = Omit<ModelInfo, 'providerId'> & { released?: string }

/* ----------------------------------------------------------------- efforts */

type PiLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
const PI_TO_EAON: Record<PiLevel, EffortLevel> = {
  off: 'none',
  minimal: 'minimal',
  low: 'light',
  medium: 'medium',
  high: 'high',
  xhigh: 'extra-high',
  max: 'ultra'
}

/**
 * Pi's `thinkingLevelMap` → the levels Eaon offers.
 *
 * Pi maps its seven levels to what each model is actually sent; `null` means
 * unsupported, a missing key means the adapter's default (only meaningful for
 * low/medium/high). Eaon offers a level only when it reaches the wire as
 * itself, so a model where Pi folds "minimal" into "low" shows Low once, not
 * both. Off is offered only where the map names a real off value (`none`).
 */
export function effortsFromLevelMap(reasoning: boolean, map: Partial<Record<PiLevel, string | null>> | undefined): EffortLevel[] {
  if (!reasoning || !map) return []
  const levels: EffortLevel[] = []
  for (const [pi, eaon] of Object.entries(PI_TO_EAON) as [PiLevel, EffortLevel][]) {
    const value = map[pi]
    if (value === null) continue
    const wire = value ?? (pi === 'low' || pi === 'medium' || pi === 'high' ? WIRE_EFFORT[eaon] : undefined)
    if (wire === WIRE_EFFORT[eaon]) levels.push(eaon)
  }
  return usable(levels)
}

/** models.dev `reasoning_options` → levels. Toggle- and budget-only models take no effort. */
export function effortsFromReasoningOptions(options: ModelsDevReasoningOption[] | undefined): EffortLevel[] {
  const values = (options ?? []).flatMap((option) => (option.type === 'effort' ? (option.values ?? []) : []))
  return usable(values.flatMap((value) => (value && EFFORT_FROM_WIRE[value] ? [EFFORT_FROM_WIRE[value]] : [])))
}

/** A list that is only "Off" would turn thinking off with no way back on; offer nothing instead. */
function usable(levels: EffortLevel[]): EffortLevel[] {
  const ordered = orderEfforts(levels)
  return ordered.some((level) => EFFORT_ORDER.indexOf(level) > EFFORT_ORDER.indexOf('none')) ? ordered : []
}

/* ---------------------------------------------------------------------- Pi */

export interface PiModel {
  id: string
  name?: string
  reasoning?: boolean
  thinkingLevelMap?: Partial<Record<PiLevel, string | null>>
  input?: string[]
  contextWindow?: number
  maxTokens?: number
}

/** Pi's data file is `{ [api]: { [key]: model } }`; one id can sit under two APIs (keep the first). */
export function fromPiData(data: unknown): CatalogModel[] {
  const out: CatalogModel[] = []
  const seen = new Set<string>()
  for (const group of Object.values((data ?? {}) as Record<string, Record<string, PiModel>>)) {
    if (!group || typeof group !== 'object') continue
    for (const model of Object.values(group)) {
      if (!model?.id || seen.has(model.id)) continue
      seen.add(model.id)
      out.push({
        id: model.id,
        label: tidyLabel(model.name ?? model.id),
        tools: true,
        ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
        ...(model.maxTokens && (!model.contextWindow || model.maxTokens <= model.contextWindow) ? { maxOutput: model.maxTokens } : {}),
        // A known input list without images means the model can't see them; no list means nobody said.
        ...(model.input ? { vision: model.input.includes('image') } : {}),
        reasoning: model.reasoning === true,
        efforts: effortsFromLevelMap(model.reasoning === true, model.thinkingLevelMap)
      })
    }
  }
  return dropDatedDuplicates(out)
}

/* --------------------------------------------------------------- models.dev */

export type ModelsDevReasoningOption = { type: string; values?: (string | null)[] }

interface ModelsDevModel {
  id?: string
  name?: string
  tool_call?: boolean
  reasoning?: boolean
  reasoning_options?: ModelsDevReasoningOption[]
  status?: string
  release_date?: string
  limit?: { context?: number; output?: number }
  modalities?: { input?: string[]; output?: string[] }
}

/** One models.dev provider (`api.json[providerId]`) → catalog entries, newest first. */
export function fromModelsDev(provider: unknown, eaonId: string): CatalogModel[] {
  const models = (provider as { models?: Record<string, ModelsDevModel> } | undefined)?.models ?? {}
  const out: CatalogModel[] = []
  for (const [key, model] of Object.entries(models)) {
    const id = model.id ?? key
    if (model.status === 'deprecated') continue
    if (model.tool_call !== true && !TOOLLESS_OK.has(eaonId)) continue
    // Chat models only: text in, text out (image generators and TTS list here too).
    if (model.modalities?.output && !model.modalities.output.includes('text')) continue
    if (model.modalities?.input && !model.modalities.input.includes('text')) continue
    const context = model.limit?.context
    const output = model.limit?.output
    out.push({
      id,
      label: tidyLabel(model.name ?? id),
      tools: model.tool_call === true,
      ...(context ? { contextWindow: context } : {}),
      ...(output && (!context || output <= context) ? { maxOutput: output } : {}),
      ...(model.modalities?.input ? { vision: model.modalities.input.includes('image') } : {}),
      reasoning: model.reasoning === true,
      efforts: model.reasoning === true ? effortsFromReasoningOptions(model.reasoning_options) : [],
      // models.dev marks models still in testing as alpha or beta.
      ...(model.status === 'alpha' || model.status === 'beta' ? { stage: 'preview' as const } : {}),
      ...(model.release_date ? { released: model.release_date } : {})
    })
  }
  out.sort((a, b) => (b.released ?? '').localeCompare(a.released ?? '') || a.label.localeCompare(b.label))
  return dropDatedDuplicates(out)
}

/* ------------------------------------------------------------------ shared */

/** "Claude Haiku 4.5 (latest)" → "Claude Haiku 4.5": the alias is the one people pick. */
function tidyLabel(name: string): string {
  return name.replace(/\s*\(latest\)\s*$/i, '').trim()
}

/**
 * `claude-haiku-4-5-20251001` next to `claude-haiku-4-5`: the same model
 * twice in the picker. Keep the alias, drop the dated snapshot.
 */
function dropDatedDuplicates(models: CatalogModel[]): CatalogModel[] {
  const ids = new Set(models.map((m) => m.id))
  return models.filter((m) => {
    const alias = m.id.replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, '')
    return alias === m.id || !ids.has(alias)
  })
}
