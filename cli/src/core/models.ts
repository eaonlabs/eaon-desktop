import type { EffortLevel, ModelInfo, Provider, Settings } from '@shared/types'
import { clampEffort, EFFORT_LABEL, EFFORT_ORDER } from '@shared/effort'
import { isProviderUsable, resolveSelection, type ResolvedSelection } from '@shared/modelSelection'
import { listProviders } from '@main/providers'
import { store } from '@main/store'

/**
 * The models the CLI can use, and which one each job runs on.
 *
 * The app picks a model in a few places: the chat (and so every turn the
 * user starts), trading sessions, swarm sub-agents and plugin routing. The
 * model picker shows them as one table of "roles" — the CLI's version of
 * the desktop's model menu plus the trading desk's model setting.
 */

/**
 * Listing providers reads their files and the catalog; the screen asks
 * several times a frame, so the answer is kept for a moment.
 */
let cached: { at: number; providers: Provider[] } | null = null
const CACHE_MS = 1500

export function invalidateModels(): void {
  cached = null
}

export function usableProviders(): Provider[] {
  const now = Date.now()
  if (!cached || now - cached.at > CACHE_MS) cached = { at: now, providers: listProviders().filter(isProviderUsable) }
  return cached.providers
}

/** Every model the user can pick, provider by provider. */
export function availableModels(): ModelInfo[] {
  return usableProviders().flatMap((p) => p.models)
}

/**
 * Settings for drawing. The store reads and merges its file on every call,
 * and the screen asks many times a frame, so this answer is kept for a
 * quarter of a second. Anything that acts on settings reads the store.
 */
let shown: { at: number; settings: Settings } | null = null
export function viewSettings(): Settings {
  const now = Date.now()
  if (!shown || now - shown.at > 250) shown = { at: now, settings: store.getSettings() }
  return shown.settings
}

/**
 * What the chat's model choice resolves to, by the desktop's rules
 * (shared/modelSelection): the saved choice, a default when there is none,
 * or why the saved one can't be used. Never another model in its place.
 */
export function chatSelection(settings: Settings = viewSettings()): ResolvedSelection {
  return resolveSelection({ providerId: settings.selectedProviderId, modelId: settings.selectedModelId }, listProviders(), {
    favorites: settings.favoriteModels,
    recents: settings.recentModels
  })
}

/** The chat's model, or null when nothing usable is chosen (see `chatSelection` for why). */
export function chatModel(settings: Settings = viewSettings(), _models?: ModelInfo[]): ModelInfo | null {
  return chatSelection(settings).model
}

/** Why there is no chat model, as one line for the terminal. */
export function noModelReason(settings: Settings = viewSettings()): string {
  const selection = chatSelection(settings)
  if (selection.status === 'unavailable') {
    return `${selection.wanted?.label ?? 'The chosen model'} is unavailable: ${selection.reason ?? 'its provider can’t be used now.'} Pick another with /model, or fix it with /keys or /login.`
  }
  return 'No usable model is connected. Run /import to bring your keys over from Eaon Desktop, /key to paste an API key, or /login to sign in.'
}

export function providerName(providerId: string): string {
  return (usableProviders().find((p) => p.id === providerId) ?? listProviders().find((p) => p.id === providerId))?.name ?? providerId
}

/** "gpt-5.6 · OpenAI" style label. */
export function modelLabel(model: Pick<ModelInfo, 'id' | 'label' | 'providerId'> | null | undefined): string {
  if (!model) return 'no model'
  return model.label && model.label !== model.id ? model.label : model.id
}

export function effortLabel(level: EffortLevel | undefined): string {
  return level ? EFFORT_LABEL[level] : 'n/a'
}

/** What the model will actually be sent for the chosen effort, or undefined when it takes none. */
export function effectiveEffort(model: ModelInfo | null | undefined, wanted: EffortLevel): EffortLevel | undefined {
  return clampEffort(wanted, model?.efforts)
}

/** The levels the model takes, lowest first; empty when it has no effort setting. */
export function effortsOf(model: ModelInfo | null | undefined): EffortLevel[] {
  return model?.efforts?.length ? EFFORT_ORDER.filter((e) => model.efforts!.includes(e)) : []
}

export type ModelRole = 'chat' | 'trading' | 'subagents' | 'routing'

export interface RoleRow {
  role: ModelRole
  label: string
  description: string
  /** Null when the role follows the chat's model. */
  model: ModelInfo | null
  /** What it runs on right now, after following the chat. */
  effective: ModelInfo | null
  effort: EffortLevel | undefined
  /** The user picked a model for this role rather than letting it follow the chat. */
  override: boolean
}

export const ROLE_INFO: Record<ModelRole, { label: string; description: string }> = {
  chat: { label: 'chat', description: 'Every chat turn, and anything that follows the chat model.' },
  trading: { label: 'trading-sessions', description: 'The agent that trades during a session: one turn every few minutes.' },
  subagents: { label: 'swarm-subagents', description: 'Sub-agents a swarm starts to work in parallel.' },
  routing: { label: 'plugin-routing', description: 'Picks which plugin tools a turn needs, when smart routing is on.' }
}

function findModel(models: ModelInfo[], providerId: string | null | undefined, modelId: string | null | undefined): ModelInfo | null {
  if (!modelId) return null
  return models.find((m) => m.id === modelId && (!providerId || m.providerId === providerId)) ?? models.find((m) => m.id === modelId) ?? null
}

export function roleRows(tradingModel: { providerId: string; modelId: string } | null, settings: Settings = store.getSettings()): RoleRow[] {
  const models = availableModels()
  const chat = chatModel(settings, models)
  const effort = settings.effort
  const row = (role: ModelRole, model: ModelInfo | null): RoleRow => {
    const effective = model ?? chat
    return { role, ...ROLE_INFO[role], model, effective, effort: effectiveEffort(effective, effort), override: role === 'chat' ? Boolean(settings.selectedModelId) : model !== null }
  }
  return [
    row('chat', chat),
    row('trading', findModel(models, tradingModel?.providerId, tradingModel?.modelId)),
    row('subagents', findModel(models, null, settings.work.subagentModelId)),
    row('routing', settings.mcp.useDedicatedRoutingModel ? findModel(models, null, settings.mcp.routingModelId) : null)
  ]
}
