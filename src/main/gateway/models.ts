import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Provider } from '@shared/types'
import type { GatewayModel } from '@shared/gateway'
import { listProviders } from '../providers'
import { isOwnServerUrl } from '../providers/compat'
import { store } from '../store'

/**
 * Which models the gateway serves, how a model name in a request is resolved
 * to one of them, and the install's token.
 */

/** Providers the gateway can route to: usable, and never one that points back at this server. */
export function gatewayProviders(): Provider[] {
  return listProviders().filter((p) => p.enabled && (p.hasKey || p.local) && !isOwnServerUrl(p.baseUrl))
}

export function gatewayModels(): GatewayModel[] {
  return gatewayProviders().flatMap((provider) =>
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

/**
 * The model a request gets: the one it names when Eaon has it, else the
 * default for its slot (small names → the small model, else the default),
 * else the first model Eaon has. Null only when there are no models at all.
 */
export function resolveGatewayModel(requested: string | undefined | null): ResolvedModel | null {
  const providers = gatewayProviders()
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
  const slots = requested && SMALL_NAME.test(requested) ? [settings.smallModelId, settings.defaultModelId] : [settings.defaultModelId]
  for (const slot of slots) {
    const hit = slot ? find(slot, providers) : null
    if (hit) return done(hit, true)
  }
  const first = providers.find((p) => p.models.length > 0)
  return first ? done({ providerId: first.id, modelId: first.models[0].id }, true) : null
}

/** This install's key for the server, made the first time anything asks for it. */
export function gatewayToken(): string {
  const saved = store.getSettings().localServer.token
  if (saved) return saved
  const token = `eaon-${randomBytes(24).toString('base64url')}`
  store.patchSettings({ localServer: { ...store.getSettings().localServer, token } })
  return token
}

/** The key a request sent, as a Bearer token or `x-api-key`; empty when none. */
export function sentToken(headers: { authorization?: string; 'x-api-key'?: string | string[] }): string {
  const bearer = /^Bearer\s+(.+)$/i.exec(headers.authorization ?? '')?.[1]?.trim()
  const apiKey = Array.isArray(headers['x-api-key']) ? headers['x-api-key'][0] : headers['x-api-key']
  return bearer || apiKey?.trim() || ''
}

/** Compared in constant time, so the key can't be guessed a character at a time from response timings. */
function sameToken(sent: string, token: string): boolean {
  const a = createHash('sha256').update(sent).digest()
  const b = createHash('sha256').update(token).digest()
  return timingSafeEqual(a, b)
}

/**
 * Whether a request may use the server. A key that isn't this install's is
 * refused. No key at all is let through for programs (CLIs and SDKs, which
 * send no Origin), as before there was a key; a browser page or extension
 * (anything with an Origin) must send it. Origin rules alone let every
 * extension the user installed, and any page served from localhost (a dev
 * server running someone else's code), spend the user's API keys.
 */
export function tokenAllowed(headers: { authorization?: string; 'x-api-key'?: string | string[]; origin?: string }): 'ok' | 'missing' | 'wrong' {
  const sent = sentToken(headers)
  if (!sent) return headers.origin === undefined ? 'ok' : 'missing'
  return sameToken(sent, gatewayToken()) ? 'ok' : 'wrong'
}
