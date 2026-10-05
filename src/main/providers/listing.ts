import type { ModelInfo } from '@shared/types'
import { EFFORT_FROM_WIRE, orderEfforts } from '@shared/effort'
import type { Vendor } from './compat'
import { isChatModelId, OPENAI_EFFORTS, prettyLabel } from './models'

/**
 * Reads a provider's `/models` listing into catalog entries.
 *
 * Every host shapes its listing differently, and the useful fields — context
 * window, output cap, whether a model takes tools or images — live under a
 * different name on each. What each field is called where:
 *
 * - context: `context_length` (OpenRouter, Together, SambaNova, DeepInfra's
 *   `metadata`), `context_window` (Vercel, Groq), `context_size` (Novita),
 *   `max_context_length` (Mistral), `max_model_len` (vLLM), per-provider
 *   `context_length` (Hugging Face's router).
 * - output cap: `top_provider.max_completion_tokens` (OpenRouter),
 *   `max_completion_tokens`, `max_output_tokens`, `max_tokens`.
 * - non-chat models are flagged by `type` (Vercel "embedding", Together
 *   "image"), `model_type` (Novita), tags (DeepInfra), output modalities
 *   (OpenRouter), or only by their id.
 */

interface Row {
  id?: string
  name?: string
  type?: string
  model_type?: string
  context_length?: number
  context_window?: number
  context_size?: number
  max_context_length?: number
  max_model_len?: number
  max_input_tokens?: number
  max_tokens?: number
  max_completion_tokens?: number
  max_output_tokens?: number
  top_provider?: { context_length?: number | null; max_completion_tokens?: number | null }
  architecture?: { input_modalities?: string[]; output_modalities?: string[] }
  input_modalities?: string[]
  supported_parameters?: string[]
  tags?: string[]
  features?: string[]
  capabilities?: { function_calling?: boolean; vision?: boolean; completion_chat?: boolean }
  metadata?: { context_length?: number | null; max_tokens?: number | null; tags?: string[] } | null
  providers?: { context_length?: number; supports_tools?: boolean }[]
  /** Mistral: the date a model is retired, or null. */
  deprecation?: string | null
}

const CHAT_TYPES = /^(language|chat|llm|text|code|text-generation|model)$/i
const NON_CHAT_TAGS = /^(embeddings?|tts|text-to-speech|text-to-image|text-to-video|image-generation|video|speech|transcription|automatic-speech-recognition|rerank(ing)?|asr|stt)$/i

const num = (...values: (number | null | undefined)[]): number | undefined => {
  for (const value of values) if (typeof value === 'number' && value > 0) return value
  return undefined
}

/** "Anthropic: Claude Opus 5.5" → "Claude Opus 5.5". */
const tidyName = (name: string): string => name.replace(/^[^:]{1,40}:\s+/, '').trim()

export function parseListing(body: unknown, providerId: string, vendor: Vendor): ModelInfo[] {
  const root = body as { data?: Row[]; models?: Row[] } | Row[]
  const rows: Row[] = Array.isArray(root) ? root : (root.data ?? root.models ?? [])
  const out: ModelInfo[] = []
  const seen = new Set<string>()

  for (const row of rows) {
    const id = row.id ?? row.name
    if (!id || seen.has(id) || !isChatModelId(id)) continue
    const type = row.type ?? row.model_type
    if (type && !CHAT_TYPES.test(type)) continue
    const tags = row.tags ?? row.metadata?.tags
    if (tags?.length && !tags.includes('chat') && tags.some((tag) => NON_CHAT_TAGS.test(tag))) continue
    const outputs = row.architecture?.output_modalities
    if (outputs && !outputs.includes('text')) continue
    seen.add(id)

    const inputs = row.architecture?.input_modalities ?? row.input_modalities
    const contextWindow = num(
      row.context_length,
      row.context_window,
      row.context_size,
      row.max_context_length,
      row.max_model_len,
      row.max_input_tokens,
      row.top_provider?.context_length,
      row.metadata?.context_length,
      ...(row.providers ?? []).map((p) => p.context_length)
    )
    const maxOutput = num(row.top_provider?.max_completion_tokens, row.max_completion_tokens, row.max_output_tokens, row.max_tokens, row.metadata?.max_tokens)

    let tools: boolean | undefined
    if (row.supported_parameters) tools = row.supported_parameters.includes('tools')
    else if (vendor === 'vercel' && tags) tools = tags.includes('tool-use')
    else if (row.features) tools = row.features.includes('function-calling')
    else if (row.capabilities?.function_calling !== undefined) tools = row.capabilities.function_calling
    else if (row.providers?.length) tools = row.providers.some((p) => p.supports_tools)

    const reasoning =
      row.supported_parameters?.includes('reasoning') || tags?.includes('reasoning') || row.features?.includes('reasoning') ? true : undefined

    // OpenRouter normalises `reasoning.effort` across every model that reasons;
    // DeepInfra tags the models whose effort can be set.
    let efforts: ModelInfo['efforts']
    if (vendor === 'openrouter' && row.supported_parameters) efforts = reasoning ? OPENAI_EFFORTS : []
    else if (tags?.includes('reasoning_effort')) efforts = OPENAI_EFFORTS

    out.push({
      id,
      label: row.name && row.name !== id && vendor !== 'other' ? tidyName(row.name) : prettyLabel(id),
      providerId,
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxOutput && (!contextWindow || maxOutput <= contextWindow) ? { maxOutput } : {}),
      ...(inputs?.includes('image') || tags?.includes('vision') || row.capabilities?.vision ? { vision: true } : inputs ? { vision: false } : {}),
      ...(tools !== undefined ? { tools } : {}),
      ...(reasoning ? { reasoning } : {}),
      ...(efforts ? { efforts } : {}),
      ...(row.deprecation ? { stage: 'deprecated' as const } : {})
    })
  }
  return out
}

/**
 * `/v1/models` under "Sign in with ChatGPT": `{ models: [{ slug, display_name,
 * visibility }] }`. Only `visibility: "list"` models are meant to be offered;
 * `slug` is what requests name.
 *
 * Capabilities come from the row when it states them (Codex's model rows
 * carry `input_modalities`, `supported_reasoning_levels`, `shell_type`), and
 * are otherwise left unknown: the catalog knows the established models, and a
 * new one shouldn't get an Images badge on the strength of its name.
 */
export function parseChatGptPlanListing(body: unknown, providerId: string): ModelInfo[] {
  type Row = {
    slug?: string
    id?: string
    display_name?: string
    visibility?: string
    context_window?: number
    input_modalities?: string[]
    supported_reasoning_levels?: (string | { effort?: string })[]
    shell_type?: string
  }
  const rows = ((body as { models?: Row[]; data?: Row[] }).models ?? (body as { data?: Row[] }).data ?? []) as Row[]
  const out: ModelInfo[] = []
  for (const row of rows) {
    const id = row.slug ?? row.id
    if (!id || (row.visibility && row.visibility !== 'list') || out.some((m) => m.id === id)) continue
    const levels = (row.supported_reasoning_levels ?? []).map((level) => (typeof level === 'string' ? level : level?.effort)).filter((level): level is string => Boolean(level))
    const efforts = orderEfforts(levels.flatMap((level) => (EFFORT_FROM_WIRE[level] ? [EFFORT_FROM_WIRE[level]] : [])))
    out.push({
      id,
      label: row.display_name ?? prettyLabel(id),
      providerId,
      ...(row.shell_type ? { tools: true } : {}),
      ...(row.input_modalities ? { vision: row.input_modalities.includes('image') } : {}),
      ...(row.supported_reasoning_levels ? { reasoning: efforts.length > 0, efforts } : {}),
      ...(row.context_window ? { contextWindow: row.context_window } : {})
    })
  }
  return out
}

/** Copilot's `/models`: only models the account may pick, and only ones that can call tools. */
export function parseCopilotListing(body: unknown): ModelInfo[] {
  type CopilotRow = {
    id?: string
    name?: string
    model_picker_enabled?: boolean
    policy?: { state?: string }
    capabilities?: {
      type?: string
      supports?: { tool_calls?: boolean; vision?: boolean }
      limits?: { max_context_window_tokens?: number; max_prompt_tokens?: number; max_output_tokens?: number }
    }
  }
  const rows = ((body as { data?: CopilotRow[] }).data ?? []).filter(
    (row) => row.id && row.capabilities?.supports?.tool_calls !== false && (!row.capabilities?.type || row.capabilities.type === 'chat')
  )
  const picker = rows.filter((row) => row.model_picker_enabled && row.policy?.state !== 'disabled')
  // Some Individual accounts report no picker flags at all; fall back to enabled policies.
  const chosen = picker.length > 0 ? picker : rows.filter((row) => row.policy?.state === 'enabled')
  const seen = new Set<string>()
  const out: ModelInfo[] = []
  for (const row of chosen) {
    if (seen.has(row.id!)) continue
    seen.add(row.id!)
    const limits = row.capabilities?.limits
    const contextWindow = num(limits?.max_context_window_tokens, limits?.max_prompt_tokens)
    const maxOutput = num(limits?.max_output_tokens)
    const supports = row.capabilities?.supports
    out.push({
      id: row.id!,
      label: row.name ?? prettyLabel(row.id!),
      providerId: 'github-copilot',
      // Rows that say nothing about tool calls are kept (some plans omit the flags) but not badged.
      ...(supports?.tool_calls === true ? { tools: true } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxOutput ? { maxOutput } : {}),
      ...(typeof supports?.vision === 'boolean' ? { vision: supports.vision } : {})
    })
  }
  return out
}
