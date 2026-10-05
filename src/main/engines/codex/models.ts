import type { EngineModel, EngineModels, ModelSource } from '@shared/engines'
import { EFFORT_FROM_WIRE, WIRE_EFFORT, clampEffort, orderEfforts } from '@shared/effort'
import type { EffortLevel } from '@shared/types'
import type { AppServer } from './appServer'
import type { Model, ModelListResponse } from './protocol'

/**
 * Codex's model list, as Codex itself reports it (`model/list`).
 *
 * That list is the truth for this engine: it follows the user's own Codex
 * setup — their ChatGPT plan, or a `model_catalog_json` pointing Codex at
 * Ollama or another provider — which Eaon could never reconstruct. The last
 * list that worked is kept on disk and shown, marked stale, when Codex can't
 * be asked; a list shipped with Eaon is the floor when there never was one.
 */

/** One model as Eaon keeps it: the picker's view plus the effort names Codex uses on the wire. */
export interface CodexModelRecord {
  id: string
  label: string
  description: string
  /** Eaon level → the exact string Codex reported for it. */
  efforts: { level: EffortLevel; wire: string }[]
  /** Codex's effort names Eaon has no level for (Codex's `ultra`, above max); kept for diagnostics. */
  unmapped: string[]
  defaultEffort: EffortLevel | null
  /** From `inputModalities`; null when the server didn't say. */
  vision: boolean | null
  isDefault: boolean
  upgrade: string | null
}

export interface ModelCache {
  models: CodexModelRecord[]
  retrievedAt: number
  /** The Codex that produced it, so a different install's list isn't passed off as this one's. */
  binary: string | null
  version: string | null
}

const PAGE_SIZE = 100
const MAX_PAGES = 20

/** Every page of `model/list` (picker models only; hidden ones stay hidden). */
export async function fetchModels(server: AppServer, timeoutMs = 20_000): Promise<Model[]> {
  const all: Model[] = []
  const cursors = new Set<string>()
  let cursor: string | null = null
  for (let page = 0; page < MAX_PAGES; page++) {
    const response: ModelListResponse = await server.request<ModelListResponse>('model/list', { cursor, limit: PAGE_SIZE }, timeoutMs)
    if (!response || !Array.isArray(response.data)) throw new Error('Codex sent a model list Eaon could not read.')
    all.push(...response.data.filter((m) => m && typeof m.id === 'string' && !m.hidden))
    cursor = response.nextCursor ?? null
    // A cursor that repeats would loop forever; stop with what we have.
    if (!cursor || cursors.has(cursor)) break
    cursors.add(cursor)
  }
  const seen = new Set<string>()
  return all.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)))
}

export function toRecord(model: Model): CodexModelRecord {
  const efforts: { level: EffortLevel; wire: string }[] = []
  const unmapped: string[] = []
  for (const option of model.supportedReasoningEfforts ?? []) {
    const wire = option?.reasoningEffort
    if (typeof wire !== 'string') continue
    const level = EFFORT_FROM_WIRE[wire]
    if (level && !efforts.some((e) => e.level === level)) efforts.push({ level, wire })
    else if (!level) unmapped.push(wire)
  }
  const ordered = orderEfforts(efforts.map((e) => e.level))
  const sorted = ordered.map((level) => efforts.find((e) => e.level === level)!)
  const defaultWire = model.defaultReasoningEffort ?? null
  const defaultEffort = defaultWire && EFFORT_FROM_WIRE[defaultWire] && ordered.includes(EFFORT_FROM_WIRE[defaultWire]) ? EFFORT_FROM_WIRE[defaultWire] : null
  const modalities = Array.isArray(model.inputModalities) ? model.inputModalities : null
  return {
    id: model.id,
    label: model.displayName?.trim() || model.id,
    description: model.description?.trim() ?? '',
    efforts: sorted,
    unmapped,
    defaultEffort,
    // Only what Codex says: an image modality means it takes images, its absence means it doesn't.
    vision: modalities ? modalities.includes('image') : null,
    isDefault: model.isDefault === true,
    upgrade: model.upgrade ?? null
  }
}

export function toEngineModel(record: CodexModelRecord, source: ModelSource): EngineModel {
  return {
    id: record.id,
    label: record.label,
    ...(record.description ? { description: record.description } : {}),
    efforts: record.efforts.map((e) => e.level),
    defaultEffort: record.defaultEffort,
    vision: record.vision,
    isDefault: record.isDefault,
    upgrade: record.upgrade,
    source
  }
}

/**
 * The effort string to send for a turn: the user's level clamped to what the
 * model takes, in the model's own spelling. Unknown model: Eaon's usual wire
 * name. Null level: none sent, so Codex uses the model's default.
 */
export function wireEffort(level: EffortLevel | null, record: CodexModelRecord | undefined): string | null {
  if (!level) return null
  if (!record || record.efforts.length === 0) return record ? null : WIRE_EFFORT[level]
  const clamped = clampEffort(level, record.efforts.map((e) => e.level))
  return clamped ? (record.efforts.find((e) => e.level === clamped)?.wire ?? null) : null
}

/**
 * Shipped with this build, for a first launch where Codex can't be asked and
 * nothing was ever cached: the models Codex 0.160 lists out of the box for a
 * ChatGPT account (`model/list` with no catalog of its own). Marked `shipped`
 * so a picker can say it may be out of date.
 */
export const SHIPPED_MODELS: CodexModelRecord[] = [
  ['gpt-6.1-sol', 'GPT-6.1-Sol', 'Latest workhorse model for coding and everyday work.', true, null],
  ['gpt-6-astra', 'GPT-6-Astra', 'Frontier intelligence for the most demanding work.', false, null],
  ['gpt-6-sol', 'GPT-6-Sol', 'Previous generation workhorse model.', false, null],
  ['gpt-6-luna', 'GPT-6-Luna', 'Fast and affordable model for easier tasks.', false, null],
  ['gpt-5.5', 'GPT-5.5', 'Legacy coding model.', false, 'gpt-6-sol']
].map(([id, label, description, isDefault, upgrade]) => ({
  id: id as string,
  label: label as string,
  description: description as string,
  efforts: ['low', 'medium', 'high', 'xhigh', ...(id === 'gpt-5.5' ? [] : ['max'])].map((wire) => ({ level: EFFORT_FROM_WIRE[wire], wire })),
  unmapped: [],
  defaultEffort: 'medium' as EffortLevel,
  vision: true,
  isDefault: isDefault as boolean,
  upgrade: upgrade as string | null
}))

/** What `listModels` returns when the live list failed: the cache if there is one, else the shipped list. */
export function fallbackModels(cache: ModelCache | null, reason: string): EngineModels {
  if (cache && cache.models.length > 0) {
    return {
      engine: 'codex',
      models: cache.models.map((m) => toEngineModel(m, { kind: 'cache', retrievedAt: cache.retrievedAt })),
      retrievedAt: cache.retrievedAt,
      staleBecause: reason
    }
  }
  return {
    engine: 'codex',
    models: SHIPPED_MODELS.map((m) => toEngineModel(m, { kind: 'shipped', retrievedAt: null })),
    retrievedAt: null,
    staleBecause: reason
  }
}

export function liveModels(cache: ModelCache): EngineModels {
  return {
    engine: 'codex',
    models: cache.models.map((m) => toEngineModel(m, { kind: 'engine-live', retrievedAt: cache.retrievedAt })),
    retrievedAt: cache.retrievedAt,
    staleBecause: null
  }
}
