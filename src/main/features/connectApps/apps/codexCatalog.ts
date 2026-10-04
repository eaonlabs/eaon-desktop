import type { GatewayInfo, GatewayModel } from '@shared/gateway'
import type { EffortLevel } from '@shared/types'
import { clampEffort, orderEfforts, WIRE_EFFORT } from '@shared/effort'
import { CODEX_BASE_INSTRUCTIONS } from './codexInstructions'

/**
 * A Codex model catalog (the file `model_catalog_json` names) listing the
 * user's chosen Eaon models.
 *
 * Codex, and the ChatGPT app's Codex mode, fill their model picker from this
 * catalog and nothing else: a custom provider's own model list is never
 * fetched, and a `model` the catalog doesn't list is used but never shown.
 * Without one the ChatGPT app offers only OpenAI's models, or whatever another
 * tool's catalog lists (`ollama launch codex` leaves its own behind).
 *
 * The entries are Codex's ModelInfo (`codex debug models --bundled` prints
 * OpenAI's). A catalog Codex can't parse makes it ignore the *whole*
 * config.toml ("Invalid configuration; using defaults"), so every entry keeps
 * to fields and values Codex 0.155 accepts, and mirrors what Codex falls back
 * to for a model it doesn't know: unified exec, no freeform apply_patch, its
 * generic prompt.
 */

/** When Eaon doesn't know a model's window: small enough that Codex compacts before a real limit. */
const DEFAULT_CONTEXT_WINDOW = 128_000

const EFFORT_TEXT: Record<EffortLevel, string> = {
  none: 'No thinking',
  minimal: 'As little thinking as possible',
  light: 'Fast responses with lighter thinking',
  medium: 'Balances speed and thinking depth',
  high: 'Greater thinking depth for complex tasks',
  'extra-high': 'Extra high thinking depth',
  ultra: 'Maximum thinking depth'
}

function entry(model: GatewayModel, priority: number): Record<string, unknown> {
  const efforts = orderEfforts(model.efforts ?? [])
  const fallback = clampEffort('medium', efforts)
  return {
    slug: model.id,
    display_name: model.label,
    description: `${model.providerName}, through Eaon`,
    default_reasoning_level: fallback ? WIRE_EFFORT[fallback] : null,
    supported_reasoning_levels: efforts.map((level) => ({ effort: WIRE_EFFORT[level], description: EFFORT_TEXT[level] })),
    shell_type: 'unified_exec',
    visibility: 'list',
    supported_in_api: true,
    priority,
    base_instructions: CODEX_BASE_INSTRUCTIONS,
    model_messages: null,
    supports_reasoning_summaries: false,
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: null,
    truncation_policy: { mode: 'tokens', limit: 10_000 },
    supports_parallel_tool_calls: true,
    context_window: model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: model.vision ? ['text', 'image'] : ['text']
  }
}

/** The catalog file's text: `ids` in order (the default first), each one Eaon still has. */
export function codexCatalog(info: GatewayInfo, ids: string[]): string {
  const models = ids.flatMap((id) => info.models.find((m) => m.id === id) ?? [])
  return `${JSON.stringify({ models: models.map(entry) }, null, 2)}\n`
}

/** The model ids a catalog file lists, or null when it isn't one (missing, or not a catalog). */
export function catalogSlugs(text: string | null): string[] | null {
  if (!text) return null
  try {
    const data = JSON.parse(text) as { models?: unknown }
    if (!Array.isArray(data.models)) return null
    return data.models.map((m) => String((m as { slug?: unknown }).slug ?? ''))
  } catch {
    return null
  }
}
