import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Provider } from '@shared/types'
import type { GatewayModel, GatewayScope, LocalGatewayModel } from '@shared/gateway'
import { isProviderUsable } from '@shared/modelSelection'
import { LOCAL_PROVIDER_ID } from '../llama/models'
import { listProviders } from '../providers'
import { isOwnServerUrl } from '../providers/compat'
import { store } from '../store'
import { secrets } from '../secrets'

/**
 * Which models the gateway serves, how a model name in a request is resolved
 * to one of them, and the install's token.
 */

/**
 * Providers the gateway can route to: usable, and never one that points back
 * at this server. The local scope is the downloaded models alone, whether or
 * not "On this computer" is switched on for the chat's picker.
 */
export function gatewayProviders(scope: GatewayScope = 'all'): Provider[] {
  if (scope === 'local') return listProviders().filter((p) => p.id === LOCAL_PROVIDER_ID)
  return listProviders().filter((p) => isProviderUsable(p) && !isOwnServerUrl(p.baseUrl))
}

export function gatewayModels(scope: GatewayScope = 'all'): GatewayModel[] {
  return gatewayProviders(scope).flatMap((provider) =>
    provider.models.map((model) => ({
      id: `${provider.id}/${model.id}`,
      label: model.label || model.id,
      provider: provider.id,
      providerName: provider.name,
      ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
      ...(model.vision !== undefined ? { vision: model.vision } : {}),
      ...(model.efforts?.length ? { efforts: model.efforts } : {})
    }))
  )
}

export interface ResolvedModel {
  providerId: string
  modelId: string
  /** The id the gateway reports back: `provider/model`. */
  id: string
  /** True when the name in the request wasn't one of Eaon's and the default stood in for it. */
  mapped: boolean
}

/**
 * Model names apps send on their own when nobody configured one: Claude
 * Code asks for `claude-sonnet-4-5` and `claude-haiku-…`, Codex for `gpt-5`.
 * A small-sounding one goes to the small slot.
 */
const SMALL_NAME = /haiku|mini\b|-mini|nano|small|fast|flash-lite|lite\b/i

/** A `provider/model` or bare model id, found among the gateway's models. */
function find(name: string, providers: Provider[]): { providerId: string; modelId: string } | null {
  const trimmed = name.trim()
  if (!trimmed) return null
  // `provider/model`, where the model id may itself contain slashes (OpenRouter's `anthropic/claude…`).
  const slash = trimmed.indexOf('/')
  if (slash > 0) {
    const provider = providers.find((p) => p.id === trimmed.slice(0, slash))
    const model = provider?.models.find((m) => m.id === trimmed.slice(slash + 1))
    if (provider && model) return { providerId: provider.id, modelId: model.id }
  }
  // A bare id: the first provider that has it, in Eaon's provider order.
  for (const provider of providers) {
    const model = provider.models.find((m) => m.id === trimmed)
    if (model) return { providerId: provider.id, modelId: model.id }
  }
  return null
}

/** `/local/v1/models`: the downloaded chat models, each under its own id (no provider prefix). */
export function localGatewayModels(): LocalGatewayModel[] {
  const created = Math.floor(Date.now() / 1000)
  return gatewayProviders('local').flatMap((provider) =>
    provider.models.map((model) => ({
      id: model.id,
      object: 'model' as const,
      created,
      owned_by: provider.id,
      name: model.label || model.id,
      context_window: model.contextWindow ?? 32_768,
      capabilities: { tools: model.tools !== false, vision: Boolean(model.vision), reasoning: Boolean(model.reasoning) }
    }))
  )
}

/**
 * The model a request gets: the one it names when Eaon has it, else the
 * default for its slot (small names → the small model, else the default),
 * else the first model Eaon has. Null only when there are no models at all.
 *
 * In the local scope only a downloaded model will do: the one named, or the
 * first one when none is named, and null for a name Eaon hasn't downloaded.
 */
export function resolveGatewayModel(requested: string | undefined | null, scope: GatewayScope = 'all'): ResolvedModel | null {
  const providers = gatewayProviders(scope)
  const settings = store.getSettings().localServer
  const done = (hit: { providerId: string; modelId: string }, mapped: boolean): ResolvedModel => ({
    ...hit,
    id: `${hit.providerId}/${hit.modelId}`,
    mapped
  })

  if (requested) {
    const hit = find(requested, providers)
    if (hit) return done(hit, false)
  }
  if (scope === 'local') {
    const first = providers.find((p) => p.models.length > 0)
    return !requested && first ? done({ providerId: first.id, modelId: first.models[0].id }, true) : null
  }
  const slots = requested && SMALL_NAME.test(requested) ? [settings.smallModelId, settings.defaultModelId] : [settings.defaultModelId]
  for (const slot of slots) {
    const hit = slot ? find(slot, providers) : null
    if (hit) return done(hit, true)
  }
  const first = providers.find((p) => p.models.length > 0)
  return first ? done({ providerId: first.id, modelId: first.models[0].id }, true) : null
}

/** What a request that resolved to no model is told. */
export function noModelMessage(scope: GatewayScope, requested?: string | null): string {
  if (scope === 'all') return 'No model available. Add an API key in Eaon → Settings → Model providers.'
  const have = localGatewayModels().map((m) => m.id)
  if (have.length === 0) return 'No open-source models are downloaded in Eaon. Download one on the Models page.'
  return `${requested ? `"${requested}" isn't` : "That model isn't"} downloaded in Eaon. Downloaded: ${have.join(', ')}.`
}

/** This install's key for the server, made the first time anything asks for it. */
export function gatewayToken(): string {
  const saved = store.getSettings().localServer.token
  if (saved) return saved
  const token = `eaon-${randomBytes(24).toString('base64url')}`
  store.patchSettings({ localServer: { ...store.getSettings().localServer, token } })
  return token
}

const CONTROL_VAULT_ID = 'local-api:control'
/** Used for this run only when the keychain can't keep one. */
let ephemeralControlToken: string | null = null

/**
 * The key for Eaon's control API (`/control`), which can drive the app:
 * read chats, message workers, open terminals. It is not the model key above,
 * which Connect Apps writes into other apps' config files; this one goes only
 * to Eaon CLI panes, and lives in the encrypted vault rather than settings.
 * It works on the model routes too, so Eaon CLI needs only one key.
 */
export function controlToken(): string {
  const saved = secrets.get(CONTROL_VAULT_ID)
  if (saved) return saved
  if (ephemeralControlToken) return ephemeralControlToken
  const token = `eaonc-${randomBytes(24).toString('base64url')}`
  try {
    secrets.set(CONTROL_VAULT_ID, token)
  } catch {
    ephemeralControlToken = token
  }
  return token
}

const CLAUDE_CODE_VAULT_ID = 'local-api:claude-code'

/**
 * The key in Claude Code's MCP entry for Eaon (connectApps/claudeTools.ts).
 * It opens the control API and nothing else: not the model routes, so Claude
 * Code can't spend tokens through Eaon with it. It is its own key so that
 * disconnecting can delete it, which shuts out a copy left in Claude Code's
 * settings. Null when there is none; `create` makes one, and throws when the
 * vault can't keep it (a key that changes every run would only go stale).
 */
export function claudeCodeToken(create = false): string | null {
  const saved = secrets.get(CLAUDE_CODE_VAULT_ID)
  if (saved || !create) return saved ?? null
  const token = `eaoncc-${randomBytes(24).toString('base64url')}`
  secrets.set(CLAUDE_CODE_VAULT_ID, token)
  return token
}

export function forgetClaudeCodeToken(): void {
  secrets.clear(CLAUDE_CODE_VAULT_ID)
}

/** Constant time, and the same for every length: both sides are hashed first. */
export function sameToken(sent: string, expected: string): boolean {
  if (!sent || !expected) return false
  const digest = (text: string): Buffer => createHash('sha256').update(text).digest()
  return timingSafeEqual(digest(sent), digest(expected))
}

/** The key a request sent, as a Bearer token or `x-api-key`; empty when none. */
export function sentToken(headers: { authorization?: string; 'x-api-key'?: string | string[] }): string {
  const bearer = /^Bearer\s+(.+)$/i.exec(headers.authorization ?? '')?.[1]?.trim()
  const apiKey = Array.isArray(headers['x-api-key']) ? headers['x-api-key'][0] : headers['x-api-key']
  return bearer || apiKey?.trim() || ''
}

/**
 * Whether a request may use the server. A key that is neither this install's
 * model key nor its control key is refused. No key at all is let through for
 * programs (CLIs and SDKs, which send no Origin), as before there was a key,
 * unless `requireKey` (the user's setting or the organization's policy); a
 * browser page or extension (anything with an Origin) must always send it.
 * Origin rules alone let every extension the user installed, and any page
 * served from localhost (a dev server running someone else's code), spend
 * the user's API keys.
 */
export function tokenAllowed(
  headers: { authorization?: string; 'x-api-key'?: string | string[]; origin?: string },
  requireKey = false
): 'ok' | 'missing' | 'wrong' {
  const sent = sentToken(headers)
  if (!sent) return headers.origin === undefined && !requireKey ? 'ok' : 'missing'
  return sameToken(sent, gatewayToken()) || sameToken(sent, controlToken()) ? 'ok' : 'wrong'
}
