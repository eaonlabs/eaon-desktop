import type { EffortLevel, ModelInfo, Provider } from './types'
import type { Capability, EngineId, EngineModels, EngineStatus, ModelSource } from './engines'
import { ENGINE_LABEL } from './engines'
import { isLastingIssue, type ProviderAction } from './providers'
import { orderEfforts } from './effort'

/**
 * Which models can be picked, and what a saved choice resolves to: one set of
 * rules for every model picker (the composer, Workers, scheduled tasks,
 * plugin routing, the Local API Server, the CLI) and for main's own
 * resolution of a task's or worker's model.
 *
 * Before this each surface decided for itself. The composer and scheduled
 * runs quietly fell back to the first model in the list when the chosen one
 * disappeared, so a turn could run on an unrelated model without a word.
 * Here a choice that can't be honoured stays visible as unavailable, with
 * why and what to do; only a user who never chose gets a default.
 *
 * Pure functions over `Provider`/`ModelInfo` and the engine contract, so the
 * renderer, main and the CLI share them and tests drive them directly.
 */

/** Eaon's own llama.cpp runtime (main/llama), which lists what is downloaded rather than what a server serves. */
export const LOCAL_MODEL_PROVIDER = 'eaon-local'

/* ------------------------------------------------------------------ keys */

/** `providerId:modelId`, the form favorites, recents and pickers use. Provider ids never contain ':'; model ids can (`gpt-oss:20b`). */
export const modelKey = (providerId: string, modelId: string): string => `${providerId}:${modelId}`

export function parseModelKey(key: string): { providerId: string; modelId: string } | null {
  const at = key.indexOf(':')
  if (at <= 0 || at === key.length - 1) return null
  return { providerId: key.slice(0, at), modelId: key.slice(at + 1) }
}

/** The key an engine's own model is listed under: `engine:codex:gpt-5.5`. */
export const engineModelKey = (engine: EngineId, modelId: string): string => `engine:${engine}:${modelId}`

/* ------------------------------------------------------------ providers */

/** What a button next to an unavailable model or provider does. */
export type SetupAction =
  | ProviderAction
  /** Start the provider's sign-in for the first time. */
  | 'sign-in'
  /** Open the provider's settings at the key field. */
  | 'add-key'
  /** Switch the provider back on. */
  | 'turn-on'
  /** A local runtime that isn't running: open its settings (base URL) to start it. */
  | 'start-local'
  /** Eaon's own runtime has nothing downloaded: open the Models page. */
  | 'get-local-model'
  /** Nothing is connected at all: Link accounts. */
  | 'connect'

export type ProviderState =
  /** Usable now. */
  | 'ready'
  /** Credentials are stored but the last check failed (expired sign-in, rejected key, no models). */
  | 'attention'
  /** Never set up: no key, not signed in. */
  | 'setup'
  /** Switched off in Model providers. */
  | 'off'
  /** A local runtime that isn't running or has nothing to serve. */
  | 'unavailable'

export interface ProviderReadiness {
  state: ProviderState
  /** A short status for a badge: "Ready", "Needs attention", "No API key". */
  label: string
  /** One sentence saying what's wrong; null when ready. */
  reason: string | null
  action: SetupAction | null
}

/** Signed in, keyed, or local: something to send requests with. */
export function hasCredentials(provider: Provider): boolean {
  return provider.local || provider.hasKey || Boolean(provider.signedIn)
}

/**
 * Switched on and has credentials. The basic test for "its models count", the
 * same one every list of usable models applied before this module existed.
 */
export function isProviderUsable(provider: Provider): boolean {
  return provider.enabled && hasCredentials(provider)
}

/**
 * Whether a provider can be used right now, and if not, why and what fixes
 * it. Stored credentials alone don't make a provider ready: after a check
 * found them expired or rejected it needs attention until a check passes.
 */
export function providerReadiness(provider: Provider): ProviderReadiness {
  if (!provider.enabled) return { state: 'off', label: 'Off', reason: `${provider.name} is turned off in Model providers.`, action: 'turn-on' }
  const issue = provider.health && !provider.health.ok ? provider.health.issue : null
  if (!hasCredentials(provider)) {
    // A sign-in that ran out clears its tokens; say it expired rather than "never signed in".
    if (issue && (issue.kind === 'auth-expired' || issue.kind === 'auth-revoked')) {
      return { state: 'attention', label: 'Needs attention', reason: issue.message, action: 'reconnect' }
    }
    return provider.auth === 'oauth'
      ? { state: 'setup', label: 'Not signed in', reason: `You’re not signed in to ${provider.name}.`, action: 'sign-in' }
      : { state: 'setup', label: 'No API key', reason: `${provider.name} has no API key yet.`, action: 'add-key' }
  }
  if (issue && isLastingIssue(issue.kind)) {
    return { state: 'attention', label: 'Needs attention', reason: issue.message, action: issue.action ?? 'open-settings' }
  }
  if (provider.models.length === 0) {
    if (provider.id === LOCAL_MODEL_PROVIDER) {
      return { state: 'unavailable', label: 'No models', reason: 'No model is downloaded on this computer yet.', action: 'get-local-model' }
    }
    if (provider.local) {
      return { state: 'unavailable', label: 'Not running', reason: `${provider.name} isn’t running, or has no models yet.`, action: 'start-local' }
    }
    const reason = provider.hiddenModels?.length
      ? `Every ${provider.name} model is removed from the list.`
      : !provider.builtIn
        ? `${provider.name} has no models yet. Refresh its list or add a model id.`
        : `${provider.name} offers no models Eaon can use on this account.`
    return { state: 'attention', label: 'No models', reason, action: 'open-settings' }
  }
  return { state: 'ready', label: provider.local ? 'Running' : provider.auth === 'oauth' ? 'Signed in' : 'Ready', reason: null, action: null }
}

/* ---------------------------------------------------------- capabilities */

/**
 * What Eaon has evidence for. A field the catalog or the provider's listing
 * left out is unknown (null), and so is one filled in from the model id alone
 * (`inferred`): those still shape requests, but a picker shows no badge.
 */
export function modelCapabilities(model: ModelInfo): { tools: Capability; vision: Capability; reasoning: Capability } {
  const guessed = new Set(model.inferred ?? [])
  const effortsKnown = (model.efforts?.length ?? 0) > 0 && !guessed.has('efforts')
  let reasoning: Capability = model.reasoning === undefined || guessed.has('reasoning') ? null : model.reasoning
  if (effortsKnown) reasoning = true
  return { tools: model.tools ?? null, vision: model.vision ?? null, reasoning }
}

/* ----------------------------------------------------------------- stage */

export type ModelStage = 'preview' | 'deprecated'

export const STAGE_LABEL: Record<ModelStage, string> = { preview: 'Preview', deprecated: 'Deprecated' }

/** An id that calls itself a preview: `gemini-3-pro-preview`, `…-exp-1206`, `…-beta`. Not `expert`. */
const PREVIEW_ID = /(^|[-_.:/ ])(preview|exp|experimental|beta|alpha)([-_.:/ ]|\d|$)/i

/** The model's release stage when something says so: its source, or its own id. Null when nothing does. */
export function modelStage(model: Pick<ModelInfo, 'id' | 'stage'>): ModelStage | null {
  if (model.stage) return model.stage
  return PREVIEW_ID.test(model.id) ? 'preview' : null
}

/* --------------------------------------------------------- dated aliases */

const DATED = /^(.+?)[-@](\d{8}|\d{4}-\d{2}-\d{2})$/

/** `claude-sonnet-4-5-20250929` → `claude-sonnet-4-5`; `gpt-4o-2024-08-06` → `gpt-4o`; null for an undated id. */
export function datedAliasOf(id: string): string | null {
  return DATED.exec(id)?.[1] ?? null
}

/**
 * Folds dated snapshots into their alias when both are listed, so the picker
 * shows one Claude Sonnet 4.5 rather than two. The snapshot's id is kept on
 * the alias (`aliases`), so a choice saved under it still resolves. Models
 * added by hand are never folded.
 */
export function foldDatedAliases(models: ModelInfo[]): ModelInfo[] {
  const byId = new Map(models.map((model) => [model.id, model]))
  const folded = new Map<string, string[]>()
  const kept: ModelInfo[] = []
  for (const model of models) {
    const alias = model.custom ? null : datedAliasOf(model.id)
    if (alias && alias !== model.id && byId.has(alias)) {
      folded.set(alias, [...(folded.get(alias) ?? []), model.id])
      continue
    }
    kept.push(model)
  }
  if (folded.size === 0) return models
  return kept.map((model) => {
    const ids = folded.get(model.id)
    return ids ? { ...model, aliases: [...new Set([...(model.aliases ?? []), ...ids])] } : model
  })
}

/** A model in a list by its id or one of its aliases. */
export function findModel(models: ModelInfo[] | undefined, modelId: string): ModelInfo | undefined {
  if (!models) return undefined
  return models.find((m) => m.id === modelId) ?? models.find((m) => m.aliases?.includes(modelId))
}

/* ---------------------------------------------------------------- options */

export type ModelAvailability = 'ready' | 'attention' | 'unavailable'

/** One row in a model picker, whichever engine or provider it comes from. */
export interface ModelOption {
  /** `providerId:modelId` for provider models, `engine:<id>:<model>` for an engine's own. */
  key: string
  engine: EngineId
  /** Null for an engine's own models. */
  providerId: string | null
  modelId: string
  label: string
  /** What the row is grouped under: a provider id or an engine id. */
  groupId: string
  groupLabel: string
  efforts: EffortLevel[]
  tools: Capability
  vision: Capability
  reasoning: Capability
  contextWindow: number | null
  stage: ModelStage | null
  source: ModelSource | null
  /** The engine's own default model. */
  isDefault: boolean
  availability: ModelAvailability
  /** Why it can't be used, or what needs attention; null when ready. */
  reason: string | null
  action: SetupAction | null
  /** The provider model behind the row; null for engine models and for unavailable placeholders. */
  model: ModelInfo | null
}

/** A provider model as a picker row. */
export function providerOption(model: ModelInfo, provider: Provider, readiness: ProviderReadiness = providerReadiness(provider)): ModelOption {
  const caps = modelCapabilities(model)
  const availability: ModelAvailability = readiness.state === 'ready' ? 'ready' : readiness.state === 'attention' ? 'attention' : 'unavailable'
  return {
    key: modelKey(provider.id, model.id),
    engine: 'native',
    providerId: provider.id,
    modelId: model.id,
    label: model.label || model.id,
    groupId: provider.id,
    groupLabel: provider.name,
    efforts: orderEfforts(model.efforts ?? []),
    ...caps,
    contextWindow: model.contextWindow ?? null,
    stage: modelStage(model),
    source: model.source ?? null,
    isDefault: false,
    availability,
    reason: readiness.reason,
    action: readiness.action,
    model
  }
}

/**
 * Every provider model a picker on Eaon's own engine offers, in the
 * providers list's order. Providers that are switched off or not set up are
 * left out (they are not connected); one that needs attention stays, marked,
 * so its models don't vanish the moment a sign-in expires.
 */
export function nativeOptions(providers: Provider[]): ModelOption[] {
  const out: ModelOption[] = []
  for (const provider of providers) {
    if (!isProviderUsable(provider)) continue
    const readiness = providerReadiness(provider)
    for (const model of provider.models) out.push(providerOption(model, provider, readiness))
  }
  return out
}

/** Whether an engine can run turns now, and if not why. */
export function engineReadiness(engine: EngineId, status: EngineStatus | null): ProviderReadiness {
  const name = status?.name ?? ENGINE_LABEL[engine]
  if (engine === 'native') return { state: 'ready', label: 'Built in', reason: null, action: null }
  if (!status) return { state: 'unavailable', label: 'Not checked', reason: `Eaon hasn’t checked for ${name} yet.`, action: 'retry' }
  if (!status.installed) return { state: 'unavailable', label: 'Not installed', reason: `${name} isn’t installed on this computer.`, action: null }
  if (status.outdated) {
    return { state: 'unavailable', label: 'Update needed', reason: `${name} ${status.version ?? ''} is too old for Eaon. ${status.updateHint ?? 'Update it.'}`.replace(/\s+/g, ' ').trim(), action: null }
  }
  switch (status.auth.state) {
    case 'signed-in':
    case 'not-required':
      return { state: 'ready', label: status.auth.plan ? `Signed in · ${status.auth.plan}` : 'Signed in', reason: null, action: null }
    case 'expired':
      return { state: 'attention', label: 'Needs attention', reason: `Your ${name} sign-in expired. Sign in again.`, action: 'reconnect' }
    case 'signed-out':
      return { state: 'setup', label: 'Not signed in', reason: `Sign in to ${name} to use its models.`, action: 'sign-in' }
    default:
      return { state: 'attention', label: 'Not checked', reason: status.error ?? `Eaon couldn’t tell whether ${name} is signed in.`, action: 'retry' }
  }
}

/**
 * An engine's own models (Codex's `model/list`) as picker rows, marked with
 * the engine's sign-in state: a signed-out Codex lists what it last offered,
 * unavailable, rather than nothing.
 */
export function engineOptions(engine: EngineId, list: EngineModels | null, status: EngineStatus | null): ModelOption[] {
  if (engine === 'native' || !list) return []
  const readiness = engineReadiness(engine, status)
  const availability: ModelAvailability = readiness.state === 'ready' ? 'ready' : readiness.state === 'attention' ? 'attention' : 'unavailable'
  const groupLabel = status?.name ?? ENGINE_LABEL[engine]
  return list.models.map((model) => ({
    key: engineModelKey(engine, model.id),
    engine,
    providerId: null,
    modelId: model.id,
    label: model.label || model.id,
    groupId: engine,
    groupLabel,
    efforts: orderEfforts(model.efforts),
    tools: null,
    vision: model.vision,
    reasoning: model.efforts.length > 0 ? true : null,
    contextWindow: null,
    stage: modelStage({ id: model.id }),
    source: model.source,
    isDefault: model.isDefault,
    availability,
    reason: readiness.reason ?? (list.staleBecause ? `Showing the last list: ${list.staleBecause}` : null),
    action: readiness.action,
    model: null
  }))
}

/* -------------------------------------------------------------- resolving */

export interface Selection {
  providerId: string | null
  modelId: string | null
}

export type SelectionStatus =
  /** The user's choice, usable. */
  | 'selected'
  /** Nothing was chosen; this is the default a turn would use. */
  | 'default'
  /** Something was chosen and can't be used now: `reason` says why. Never replaced by another model. */
  | 'unavailable'
  /** Nothing chosen and nothing usable connected. */
  | 'none'

export interface ResolvedSelection {
  status: SelectionStatus
  /** The model a turn would run on; null for 'unavailable' and 'none'. */
  model: ModelInfo | null
  provider: Provider | null
  /** What the user chose, for showing it when it is unavailable. */
  wanted: { providerId: string | null; modelId: string; label: string; providerName: string | null } | null
  /** Why it can't be used, or why nothing can; null otherwise. */
  reason: string | null
  action: SetupAction | null
  /** The choice works but its provider needs attention (a rejected key that may be fixed by now). */
  attention: string | null
}

export interface SelectionPrefs {
  favorites?: string[]
  recents?: string[]
}

const result = (fields: Partial<ResolvedSelection> & Pick<ResolvedSelection, 'status'>): ResolvedSelection => ({
  model: null,
  provider: null,
  wanted: null,
  reason: null,
  action: null,
  attention: null,
  ...fields
})

/** A label for a model id from any provider that knows it, listed or removed. */
function labelFor(providers: Provider[], providerId: string | null, modelId: string): string {
  const pool = providerId ? providers.filter((p) => p.id === providerId) : providers
  for (const provider of pool) {
    const found = findModel(provider.models, modelId) ?? findModel(provider.hiddenModels, modelId)
    if (found?.label) return found.label
  }
  return modelId
}

/** The model a user who never chose gets: a ready favorite, then a recent one, then the first ready provider's first model. */
export function defaultModel(providers: Provider[], prefs: SelectionPrefs = {}): { model: ModelInfo; provider: Provider } | null {
  const ready = providers.filter((p) => isProviderUsable(p) && providerReadiness(p).state === 'ready')
  const byKey = (key: string): { model: ModelInfo; provider: Provider } | null => {
    const parsed = parseModelKey(key)
    const provider = parsed && ready.find((p) => p.id === parsed.providerId)
    const model = provider && parsed ? findModel(provider.models, parsed.modelId) : undefined
    return provider && model ? { model, provider } : null
  }
  for (const key of [...(prefs.favorites ?? []), ...(prefs.recents ?? [])]) {
    const hit = byKey(key)
    if (hit) return hit
  }
  const provider = ready.find((p) => p.models.length > 0)
  return provider ? { model: provider.models[0], provider } : null
}

/**
 * What a saved choice resolves to. The rules:
 * - Nothing chosen: the default (see `defaultModel`), or 'none' when nothing is usable.
 * - A choice whose provider is off, signed out, removed, or no longer lists
 *   it: 'unavailable', with the reason and the fix. It is not swapped for
 *   another model, not even one with the same id elsewhere.
 * - A choice from before provider ids were saved: the first usable provider
 *   that has it.
 */
export function resolveSelection(selection: Selection, providers: Provider[], prefs: SelectionPrefs = {}): ResolvedSelection {
  const modelId = selection.modelId?.trim() || null
  if (!modelId) {
    const hit = defaultModel(providers, prefs)
    if (hit) return result({ status: 'default', model: hit.model, provider: hit.provider })
    // Nothing usable: say what would fix the closest thing to working.
    const broken = providers.find((p) => p.enabled && providerReadiness(p).state === 'attention')
    if (broken) {
      const readiness = providerReadiness(broken)
      return result({ status: 'none', provider: broken, reason: readiness.reason, action: readiness.action })
    }
    return result({
      status: 'none',
      reason: 'No usable model is connected. Sign in to a supported account, add an API key, or choose a local model.',
      action: 'connect'
    })
  }

  if (!selection.providerId) {
    for (const provider of providers) {
      if (!isProviderUsable(provider)) continue
      const model = findModel(provider.models, modelId)
      if (model) return result({ status: 'selected', model, provider })
    }
    return result({
      status: 'unavailable',
      wanted: { providerId: null, modelId, label: labelFor(providers, null, modelId), providerName: null },
      reason: 'No connected provider offers it now.',
      action: 'choose-model'
    })
  }

  const provider = providers.find((p) => p.id === selection.providerId) ?? null
  const wanted = {
    providerId: selection.providerId,
    modelId,
    label: labelFor(providers, selection.providerId, modelId),
    providerName: provider?.name ?? null
  }
  if (!provider) return result({ status: 'unavailable', wanted, reason: 'Its provider was removed from Model providers.', action: 'choose-model' })

  const readiness = providerReadiness(provider)
  if (readiness.state === 'off' || readiness.state === 'setup' || !hasCredentials(provider)) {
    return result({ status: 'unavailable', provider, wanted, reason: readiness.reason, action: readiness.action })
  }

  const model = findModel(provider.models, modelId)
  if (model) {
    return result({
      status: 'selected',
      model,
      provider,
      ...(readiness.state === 'attention' ? { attention: readiness.reason, action: readiness.action } : {})
    })
  }
  if (findModel(provider.hiddenModels, modelId)) {
    return result({ status: 'unavailable', provider, wanted, reason: `You removed it from ${provider.name}’s model list.`, action: 'open-settings' })
  }
  if (readiness.state === 'unavailable') return result({ status: 'unavailable', provider, wanted, reason: readiness.reason, action: readiness.action })
  return result({ status: 'unavailable', provider, wanted, reason: `${provider.name} doesn’t offer it any more.`, action: 'choose-model' })
}

/** What an engine model choice resolves to, by the same rules: never another model in its place. */
export function resolveEngineSelection(
  engine: EngineId,
  modelId: string | null,
  list: EngineModels | null,
  status: EngineStatus | null
): { status: SelectionStatus; option: ModelOption | null; reason: string | null; action: SetupAction | null } {
  const readiness = engineReadiness(engine, status)
  const options = engineOptions(engine, list, status)
  const name = status?.name ?? ENGINE_LABEL[engine]
  const chosen = modelId ? (options.find((o) => o.modelId === modelId) ?? null) : (options.find((o) => o.isDefault) ?? options[0] ?? null)
  if (readiness.state !== 'ready' && readiness.state !== 'attention') {
    return { status: modelId ? 'unavailable' : 'none', option: chosen, reason: readiness.reason, action: readiness.action }
  }
  if (!modelId) {
    return chosen
      ? { status: 'default', option: chosen, reason: null, action: null }
      : { status: 'default', option: null, reason: `${name} picks its own default model.`, action: null }
  }
  if (chosen) return { status: 'selected', option: chosen, reason: readiness.state === 'attention' ? readiness.reason : null, action: readiness.state === 'attention' ? readiness.action : null }
  if (!list) return { status: 'selected', option: null, reason: `Eaon hasn’t read ${name}’s model list yet.`, action: null }
  return { status: 'unavailable', option: null, reason: `${name} doesn’t offer ${modelId} to this account any more.`, action: 'choose-model' }
}

/* ---------------------------------------------------------------- groups */

export interface ModelGroup {
  /** A provider or engine id, or `starred` / `recent`. */
  id: string
  kind: 'starred' | 'recent' | 'provider' | 'engine'
  label: string
  options: ModelOption[]
}

/**
 * Rows grouped for a picker: starred, then recent (minus starred), then one
 * group per provider or engine in the order the rows came. Nothing is cut
 * off; a long group scrolls.
 */
export function groupOptions(options: ModelOption[], prefs: SelectionPrefs = {}): ModelGroup[] {
  const byKey = new Map(options.map((o) => [o.key, o]))
  const starred = (prefs.favorites ?? []).map((k) => byKey.get(k)).filter((o): o is ModelOption => Boolean(o))
  const starredKeys = new Set(starred.map((o) => o.key))
  const recent = (prefs.recents ?? [])
    .filter((k) => !starredKeys.has(k))
    .map((k) => byKey.get(k))
    .filter((o): o is ModelOption => Boolean(o))
  const groups: ModelGroup[] = []
  if (starred.length) groups.push({ id: 'starred', kind: 'starred', label: 'Starred', options: starred })
  if (recent.length) groups.push({ id: 'recent', kind: 'recent', label: 'Recent', options: recent })
  const order: string[] = []
  const rows = new Map<string, ModelOption[]>()
  for (const option of options) {
    if (!rows.has(option.groupId)) {
      order.push(option.groupId)
      rows.set(option.groupId, [])
    }
    rows.get(option.groupId)!.push(option)
  }
  for (const id of order) {
    const list = rows.get(id)!
    groups.push({ id, kind: list[0].engine === 'native' ? 'provider' : 'engine', label: list[0].groupLabel, options: list })
  }
  return groups
}

/* ---------------------------------------------------------------- search */

const words = (text: string): string[] => text.toLowerCase().split(/[\s\-_./:()·]+/).filter(Boolean)

/** True when `needle`'s letters appear in `hay` in order ("gpt55" in "gpt-5.5"). */
function subsequence(needle: string, hay: string): boolean {
  let i = 0
  for (const char of hay) if (char === needle[i] && ++i === needle.length) return true
  return needle.length === 0
}

/** How well one query token matches a row; 0 for no match. */
function tokenScore(token: string, option: ModelOption): number {
  const label = option.label.toLowerCase()
  const id = option.modelId.toLowerCase()
  const group = option.groupLabel.toLowerCase()
  if (label === token || id === token) return 100
  if (label.startsWith(token)) return 80
  if (id.startsWith(token) || id.slice(id.lastIndexOf('/') + 1).startsWith(token)) return 75
  if (words(option.label).some((w) => w.startsWith(token)) || words(option.modelId).some((w) => w.startsWith(token))) return 60
  if (label.includes(token)) return 45
  if (id.includes(token)) return 40
  if (group.startsWith(token) || words(option.groupLabel).some((w) => w.startsWith(token))) return 25
  if (token.length >= 3 && (subsequence(token, label.replace(/[^a-z0-9]/g, '')) || subsequence(token, id.replace(/[^a-z0-9]/g, '')))) return 10
  return 0
}

/**
 * Rows matching every word of the query, best first: an exact name, then
 * names and ids that start with it, then word starts, then anywhere, then the
 * provider's name, then letters in order. Ties keep starred, then recent,
 * then ready rows first, then the list's own order. Every match is returned.
 */
export function searchOptions(options: ModelOption[], query: string, prefs: SelectionPrefs = {}): ModelOption[] {
  const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return options
  const favorites = new Set(prefs.favorites ?? [])
  const recents = new Map((prefs.recents ?? []).map((k, i) => [k, i]))
  const scored: { option: ModelOption; score: number; index: number }[] = []
  options.forEach((option, index) => {
    let score = 0
    for (const token of tokens) {
      const s = tokenScore(token, option)
      if (s === 0) return
      score += s
    }
    if (favorites.has(option.key)) score += 6
    if (recents.has(option.key)) score += 4 - Math.min(3, recents.get(option.key)!) / 2
    if (option.availability === 'ready') score += 2
    scored.push({ option, score, index })
  })
  return scored.sort((a, b) => b.score - a.score || a.index - b.index).map((s) => s.option)
}

/* -------------------------------------------------------------- keyboard */

/**
 * The highlighted row after a key press in a list of `count` rows, or null
 * when the key isn't a navigation key. Arrows move one, Page keys a page,
 * Home and End jump to the ends; nothing wraps.
 */
export function moveActive(current: number, key: string, count: number, page = 7): number | null {
  if (count <= 0) return null
  const clamp = (i: number): number => Math.max(0, Math.min(count - 1, i))
  switch (key) {
    case 'ArrowDown':
      return clamp(current + 1)
    case 'ArrowUp':
      return clamp(current - 1)
    case 'PageDown':
      return clamp(current + page)
    case 'PageUp':
      return clamp(current - page)
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}

/* ----------------------------------------------------- favorites, recents */

export const RECENT_LIMIT = 8

/** `key` first, without duplicates, at most `limit` long. */
export function withRecent(recents: string[] | undefined, key: string, limit = RECENT_LIMIT): string[] {
  return [key, ...(recents ?? []).filter((k) => k !== key)].slice(0, limit)
}

export function toggleFavorite(favorites: string[] | undefined, key: string): string[] {
  const list = favorites ?? []
  return list.includes(key) ? list.filter((k) => k !== key) : [...list, key]
}

/* -------------------------------------------------------------- freshness */

/** "just now", "5 min ago", "2 h ago", "3 days ago". */
export function ago(at: number, now = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} h ago`
  return `${Math.floor(hours / 24)} days ago`
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

const listNames = (names: string[]): string => (names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`)

/**
 * What a model refresh found, in the words the Refresh button reports:
 * "Updated just now · 3 new models: A, B, C", "No changes · checked just
 * now", or "Couldn't refresh Anthropic — showing the list from 2 h ago."
 * A refresh that changed nothing never claims it did.
 */
export function describeModelsRefresh(input: {
  providerName: string
  /** The listing (or catalog) answered. */
  ok: boolean
  added: string[]
  removed: string[]
  /** Why it failed, already in plain words. */
  failure?: string | null
  /** When the list now shown was last fetched successfully; null if it never was. */
  lastGoodAt: number | null
  now?: number
  /** False when the only thing checked was Eaon's model catalog (no key yet, or no listing endpoint). */
  checkedProvider?: boolean
}): string {
  const now = input.now ?? Date.now()
  if (!input.ok) {
    const shown = input.lastGoodAt ? `showing the list from ${ago(input.lastGoodAt, now)}` : 'showing Eaon’s built-in list'
    const where = input.checkedProvider === false ? 'the model catalog' : input.providerName
    return `Couldn’t refresh ${where} — ${shown}.${input.failure ? ` ${input.failure}` : ''}`
  }
  const parts: string[] = []
  if (input.added.length) parts.push(`${plural(input.added.length, 'new model')}: ${listNames(input.added)}`)
  if (input.removed.length) parts.push(`${plural(input.removed.length, 'model')} no longer offered: ${listNames(input.removed)}`)
  if (parts.length === 0) return 'No changes · checked just now.'
  return `Updated just now · ${parts.join(' · ')}.`
}

/** "From Anthropic, 2 h ago" for a model's source. */
export function describeSource(source: ModelSource | null | undefined, providerName: string, now = Date.now()): string | null {
  if (!source) return null
  const when = source.retrievedAt ? `, ${ago(source.retrievedAt, now)}` : ''
  switch (source.kind) {
    case 'engine-live':
    case 'provider-live':
      return `From ${providerName}${when}`
    case 'cache':
      return `From ${providerName}’s last list${when}`
    case 'remote-catalog':
      return `From the model catalog${when}`
    case 'shipped':
      return 'Built into this version of Eaon'
    case 'custom':
      return 'Added by you'
  }
}
