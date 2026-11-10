import { isCliEngine, type EngineId } from './engines'
import { EFFORT_ORDER } from './effort'
import type { EffortLevel } from './types'
import { DEFAULT_SHAPE, isWorkerShape, type WorkerShape } from './workerLook'
import {
  normalizeBudget,
  normalizeRetry,
  normalizeSites,
  normalizeToolRules,
  type SiteRules,
  type ToolRules,
  type WorkerBudget,
  type WorkerRetry
} from './workerLimits'
import { MAX_PLAYBOOK_CHARS, MAX_PLAYBOOKS, MAX_ROUTINES, type Worker, type WorkerAccess, type WorkerDraft } from './workers'

/**
 * A worker's setup as data: what its Edit dialog sets (`WorkerSettings`),
 * which is also what a saved version keeps and what Duplicate copies, and the
 * file Export writes and Import reads (`WorkerSetup`: the settings plus the
 * routines it runs and the playbooks it follows).
 *
 * What is never in either: sign-ins and linked apps, a trading account, a
 * purchase schedule, tokens and keys, its goal and notes, and its messages.
 * A file is read through a whitelist (`parseWorkerSetup`), so whatever else it
 * carries is dropped and named in the preview rather than imported.
 */

/** What the Edit dialog sets, and what a version keeps. */
export interface WorkerSettings {
  name: string
  color: string
  shape: WorkerShape
  personality: string
  purpose: string
  model: { providerId: string; modelId: string } | null
  engine: EngineId
  effort: EffortLevel | null
  access: WorkerAccess
  /** Plugin (MCP server) ids it may use; null for every connected one. */
  plugins: string[] | null
  budget: WorkerBudget | null
  retry: WorkerRetry | null
  sites: SiteRules | null
  toolRules: ToolRules | null
}

/** A plugin a setup file names, by the name it had where it was exported: ids don't travel between computers. */
export interface SetupPlugin {
  id: string
  name: string
  /** The plugin catalog's id, when it came from there. */
  pluginId?: string
}

export interface SetupRoutine {
  name: string
  task: string
  /** Repeat interval, or null for a daily routine. */
  everyMs: number | null
  /** "HH:MM" for a daily routine. */
  daily: string | null
  marketHours: boolean
}

export interface SetupPlaybook {
  name: string
  summary: string
  steps: string
}

/** The file Export writes. */
export interface WorkerSetup extends Omit<WorkerSettings, 'plugins'> {
  plugins: SetupPlugin[] | null
  routines: SetupRoutine[]
  playbooks: SetupPlaybook[]
}

export const SETUP_KIND = 'eaon-worker'
export const SETUP_VERSION = 1
/** The most a setup file may be; a worker's setup is a few kilobytes. */
export const MAX_SETUP_BYTES = 1024 * 1024
/** The file extension Export suggests. */
export const SETUP_EXTENSION = 'eaonworker.json'

const ACCESS: WorkerAccess[] = ['read-only', 'safe', 'autonomous']
/** From most to least restricted; an import never starts above `safe`. */
const ACCESS_RANK: Record<WorkerAccess, number> = { 'read-only': 0, safe: 1, autonomous: 2 }

/** The more restricted of two access levels. */
export const lowerAccess = (a: WorkerAccess, b: WorkerAccess): WorkerAccess => (ACCESS_RANK[a] <= ACCESS_RANK[b] ? a : b)

/** What a file's freedom level starts as when it is imported: never above Careful, until the user raises it after reading the setup. */
export const importAccess = (access: WorkerAccess): WorkerAccess => lowerAccess(access, 'safe')

/* ------------------------------------------------------------------ settings */

/** What a worker's Edit dialog holds now. */
export function settingsOf(worker: Worker): WorkerSettings {
  return {
    name: worker.name,
    color: worker.color,
    shape: worker.shape,
    personality: worker.personality,
    purpose: worker.purpose,
    model: worker.model ? { providerId: worker.model.providerId, modelId: worker.model.modelId } : null,
    engine: worker.engine,
    effort: worker.effort,
    access: worker.access,
    plugins: worker.plugins ? [...worker.plugins] : null,
    budget: worker.budget ? { ...worker.budget } : null,
    retry: worker.retry ? { ...worker.retry } : null,
    sites: worker.sites ? { allow: [...worker.sites.allow], deny: [...worker.sites.deny] } : null,
    toolRules: worker.toolRules ? { ...worker.toolRules } : null
  }
}

/** Settings as a save: every field set, so applying a version puts all of them back (a cleared one comes back as null). */
export function settingsDraft(settings: WorkerSettings, id?: string): WorkerDraft {
  return {
    ...(id ? { id } : {}),
    name: settings.name,
    color: settings.color,
    shape: settings.shape,
    personality: settings.personality,
    purpose: settings.purpose,
    model: settings.model,
    engine: settings.engine,
    effort: settings.effort,
    access: settings.access,
    plugins: settings.plugins,
    budget: settings.budget,
    retry: settings.retry,
    sites: settings.sites,
    toolRules: settings.toolRules
  }
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** Whether two sets of settings are the same, as far as running the worker goes. */
export function sameSettings(a: WorkerSettings, b: WorkerSettings): boolean {
  return changedSettings(a, b).length === 0
}

const FIELD_LABELS: [keyof WorkerSettings, string][] = [
  ['name', 'name'],
  ['purpose', 'purpose'],
  ['personality', 'personality'],
  ['model', 'model'],
  ['engine', 'engine'],
  ['effort', 'thinking'],
  ['access', 'freedom'],
  ['plugins', 'plugins'],
  ['budget', 'spend cap'],
  ['retry', 'retries'],
  ['sites', 'websites'],
  ['toolRules', 'tool rules'],
  ['color', 'look'],
  ['shape', 'look']
]

/** The settings that differ, as words for a list of versions ("purpose", "model"). */
export function changedSettings(before: WorkerSettings, after: WorkerSettings): string[] {
  const out: string[] = []
  for (const [key, label] of FIELD_LABELS) if (!same(before[key], after[key]) && !out.includes(label)) out.push(label)
  return out
}

/** "purpose and model", "name, purpose and freedom": a list in words. */
export function listText(items: string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** `name`, or "name copy", "name copy 2" … the first the taken names leave free. Comparison ignores case. */
export function uniqueName(name: string, taken: string[], suffix = 'copy'): string {
  const used = new Set(taken.map((n) => n.toLowerCase()))
  const base = name.trim().slice(0, 40)
  if (!used.has(base.toLowerCase())) return base
  for (let n = 1; n < 1000; n++) {
    const tail = n === 1 ? ` ${suffix}` : ` ${suffix} ${n}`
    const candidate = `${base.slice(0, 40 - tail.length).trimEnd()}${tail}`
    if (!used.has(candidate.toLowerCase())) return candidate
  }
  return base
}

/* -------------------------------------------------------------- the file */

/** The setup a worker exports. `plugins` describes the plugins it may use (null: every connected one). */
export function setupOf(worker: Worker, plugins: SetupPlugin[] | null): WorkerSetup {
  const { plugins: _ids, ...settings } = settingsOf(worker)
  return {
    ...settings,
    plugins,
    // A purchase schedule or order tracking is a spending plan, not a setup; neither goes in a file.
    routines: worker.routines
      .filter((r) => !r.purchase && !r.watch)
      .map((r) => ({ name: r.name, task: r.task, everyMs: r.daily ? null : r.everyMs, daily: r.daily, marketHours: r.marketHours === true })),
    playbooks: worker.playbooks.map((p) => ({ name: p.name, summary: p.summary, steps: p.steps }))
  }
}

/** The file's text. */
export function setupFile(setup: WorkerSetup, now = new Date()): string {
  return `${JSON.stringify({ kind: SETUP_KIND, version: SETUP_VERSION, exportedAt: now.toISOString(), worker: setup }, null, 2)}\n`
}

/** A safe file name for a worker's export ("Data Wrangler" → "Data-Wrangler.eaonworker.json"). */
export function setupFileName(name: string): string {
  const slug = name.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60)
  return `${slug || 'worker'}.${SETUP_EXTENSION}`
}

/** What a file may set at the top of the worker; anything else is left out and reported. */
const KNOWN_KEYS = new Set<string>(['name', 'color', 'shape', 'personality', 'purpose', 'model', 'engine', 'effort', 'access', 'plugins', 'routines', 'playbooks', 'budget', 'retry', 'sites', 'toolRules'])

export type ParsedSetup = { ok: true; setup: WorkerSetup; ignored: string[] } | { ok: false; error: string }

const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.trim().slice(0, max) : '')
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * A setup file, read through a whitelist: only the fields above, each
 * repaired to what the app accepts, with the counts bounded. Whatever else the
 * file carries (an `apps` list, a `token`, an `env`, messages) is never read;
 * its names come back in `ignored` so the preview can say so.
 */
export function parseWorkerSetup(raw: string): ParsedSetup {
  if (raw.length > MAX_SETUP_BYTES) return { ok: false, error: 'That file is too big to be a worker’s setup.' }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, error: 'That isn’t a worker setup file: it isn’t valid JSON.' }
  }
  if (!isObject(parsed) || parsed.kind !== SETUP_KIND) return { ok: false, error: 'That isn’t a worker setup file. Export one from a worker’s ⋯ menu.' }
  if (typeof parsed.version !== 'number' || parsed.version > SETUP_VERSION) return { ok: false, error: 'That file was made by a newer Eaon. Update Eaon to read it.' }
  const w = parsed.worker
  if (!isObject(w)) return { ok: false, error: 'That setup file has no worker in it.' }
  const name = text(w.name, 40).replace(/\s+/g, ' ')
  if (!name) return { ok: false, error: 'That setup file’s worker has no name.' }

  const model = isObject(w.model) && text(w.model.providerId, 200) && text(w.model.modelId, 200) ? { providerId: text(w.model.providerId, 200), modelId: text(w.model.modelId, 200) } : null
  const engine: EngineId = isCliEngine(w.engine) ? w.engine : 'native'
  const effort = typeof w.effort === 'string' && EFFORT_ORDER.includes(w.effort as EffortLevel) ? (w.effort as EffortLevel) : null
  const plugins = Array.isArray(w.plugins)
    ? w.plugins
        .filter(isObject)
        .map((p): SetupPlugin => ({ id: text(p.id, 200), name: text(p.name, 80), ...(text(p.pluginId, 80) ? { pluginId: text(p.pluginId, 80) } : {}) }))
        .filter((p) => p.id || p.name)
        .slice(0, 100)
    : null
  const routines = (Array.isArray(w.routines) ? w.routines : []).filter(isObject).flatMap((r): SetupRoutine[] => {
    const routineName = text(r.name, 60)
    const task = text(r.task, 600)
    const daily = typeof r.daily === 'string' && /^([01]?\d|2[0-3]):[0-5]\d$/.test(r.daily.trim()) ? r.daily.trim().padStart(5, '0') : null
    const everyMs = typeof r.everyMs === 'number' && Number.isFinite(r.everyMs) && r.everyMs > 0 ? r.everyMs : null
    if (!routineName || !task || (!daily && !everyMs)) return []
    return [{ name: routineName, task, everyMs: daily ? null : everyMs, daily, marketHours: r.marketHours === true }]
  })
  const playbooks = (Array.isArray(w.playbooks) ? w.playbooks : []).filter(isObject).flatMap((p): SetupPlaybook[] => {
    const playbookName = text(p.name, 80).replace(/\s+/g, ' ')
    const steps = text(p.steps, MAX_PLAYBOOK_CHARS)
    return playbookName && steps ? [{ name: playbookName, summary: text(p.summary, 200).replace(/\s+/g, ' '), steps }] : []
  })

  const setup: WorkerSetup = {
    name,
    color: typeof w.color === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(w.color.trim()) ? w.color.trim() : '#3E86C6',
    shape: isWorkerShape(w.shape) ? w.shape : DEFAULT_SHAPE,
    personality: text(w.personality, 600),
    purpose: text(w.purpose, 2000),
    model,
    engine,
    effort,
    access: typeof w.access === 'string' && ACCESS.includes(w.access as WorkerAccess) ? (w.access as WorkerAccess) : 'safe',
    plugins,
    budget: normalizeBudget(w.budget),
    retry: normalizeRetry(w.retry),
    sites: normalizeSites(w.sites),
    toolRules: normalizeToolRules(w.toolRules),
    routines: routines.slice(0, MAX_ROUTINES),
    playbooks: playbooks.slice(0, MAX_PLAYBOOKS)
  }
  if (!setup.purpose) return { ok: false, error: 'That setup file’s worker has no purpose (what it is for).' }
  return { ok: true, setup, ignored: Object.keys(w).filter((key) => !KNOWN_KEYS.has(key)) }
}

/* ------------------------------------------------------------------- plugins */

export interface LocalPlugin {
  id: string
  name: string
  pluginId?: string
}

export interface PluginMatch {
  wanted: SetupPlugin
  /** The plugin connected here that stands for it; null when there isn't one. */
  here: LocalPlugin | null
}

/** Which of the plugins a setup names are connected on this computer: by catalog id, then by name. */
export function matchPlugins(wanted: SetupPlugin[], local: LocalPlugin[]): PluginMatch[] {
  return wanted.map((plugin) => ({
    wanted: plugin,
    here:
      local.find((l) => plugin.pluginId && l.pluginId === plugin.pluginId) ??
      local.find((l) => plugin.name && l.name.toLowerCase() === plugin.name.toLowerCase()) ??
      null
  }))
}

/** The plugin ids this computer can give a setup: null (every plugin) when the file says so, else the ones that matched. */
export function pluginIdsFor(setup: WorkerSetup, local: LocalPlugin[]): string[] | null {
  if (setup.plugins === null) return null
  return [...new Set(matchPlugins(setup.plugins, local).flatMap((m) => (m.here ? [m.here.id] : [])))]
}

/* ------------------------------------------------------------------- preview */

/** "every 30 min", "daily at 08:30", "every 2 h while the market is open": a routine's timing in words. */
export function routineWhen(routine: Pick<SetupRoutine, 'everyMs' | 'daily' | 'marketHours'>): string {
  const base = routine.daily
    ? `daily at ${routine.daily}`
    : routine.everyMs && routine.everyMs % 3_600_000 === 0
      ? `every ${routine.everyMs / 3_600_000} h`
      : `every ${Math.max(1, Math.round((routine.everyMs ?? 60_000) / 60_000))} min`
  return routine.marketHours ? `${base} while the market is open` : base
}

/** What a file never brings, for the line under the preview. */
export const SETUP_LEAVES_OUT =
  'Never imported: sign-ins and linked apps, tokens and keys, a trading account, purchase schedules, its goal and notes, and its messages.'
