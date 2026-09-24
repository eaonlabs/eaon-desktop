import Anthropic from '@anthropic-ai/sdk'
import type { ModelInfo, Provider } from '@shared/types'
import { secrets } from '../secrets'
import { store } from '../store'
import { anthropicAdapter } from './adapters/anthropic'
import { openaiChatAdapter } from './adapters/openaiChat'
import type { Adapter } from './adapters/types'
import { BUILT_IN } from './catalog'
import { credentialAttempts } from './credentials'
import { enrichModel, isChatModelId, prettyLabel } from './models'
import { oauthFlow } from './oauth'

/**
 * Bring-your-own-key (and sign-in) model access.
 *
 * The provider list is the built-in catalog merged with the user's overrides
 * (base URL, enabled, refreshed model list) and any custom endpoints they
 * added. Requests themselves go through an adapter per wire format — see
 * `adapters/` and `adapterFor` — driven by the agent loop in `agent/loop.ts`.
 */

export { inferEfforts } from './models'

/**
 * Adapters beyond the two built in here (Responses, native Ollama) register
 * themselves by provider kind, so adding a wire format does not mean editing
 * this file.
 */
const extraAdapters = new Map<Provider['kind'], Adapter>()

export function registerAdapter(kind: Provider['kind'], adapter: Adapter): void {
  extraAdapters.set(kind, adapter)
}

export function adapterFor(provider: Provider): Adapter {
  const registered = extraAdapters.get(provider.kind)
  if (registered) return registered
  if (provider.kind === 'anthropic') return anthropicAdapter
  return openaiChatAdapter
}

export function listProviders(): Provider[] {
  const overrides = store.getProviderConfig()
  const merged: Provider[] = BUILT_IN.map((provider) => {
    const override = overrides[provider.id] ?? {}
    const auth = provider.auth ?? (provider.local ? 'none' : 'key')
    return {
      ...provider,
      auth,
      local: provider.local ?? false,
      baseUrl: (override.baseUrl as string) ?? provider.baseUrl,
      enabled: (override.enabled as boolean) ?? provider.enabled,
      models: ((override.models as ModelInfo[]) ?? provider.models).map(enrichModel),
      hasKey: auth === 'oauth' ? Boolean(oauthFlow(provider.oauthFlow)?.isSignedIn()) : secrets.has(provider.id),
      signedIn: auth === 'oauth' ? Boolean(oauthFlow(provider.oauthFlow)?.isSignedIn()) : undefined,
      fallbackCount: secrets.getFallbacks(provider.id).length
    }
  })

  // Custom OpenAI-compatible endpoints the user added themselves.
  for (const [id, override] of Object.entries(overrides)) {
    if (merged.some((p) => p.id === id)) continue
    merged.push({
      id,
      name: (override.name as string) ?? id,
      kind: (override.kind as Provider['kind']) ?? 'openai-compatible',
      baseUrl: (override.baseUrl as string) ?? '',
      hasKey: secrets.has(id),
      enabled: (override.enabled as boolean) ?? true,
      builtIn: false,
      local: false,
      auth: 'key',
      category: 'custom',
      fallbackCount: secrets.getFallbacks(id).length,
      models: ((override.models as ModelInfo[]) ?? []).map(enrichModel)
    })
  }
  return merged
}

export function getProvider(id: string): Provider | undefined {
  return listProviders().find((p) => p.id === id)
}

export function updateProvider(id: string, patch: Partial<Provider>): Provider[] {
  const config = store.getProviderConfig()
  const existing = config[id] ?? {}
  config[id] = {
    ...existing,
    ...(patch.baseUrl !== undefined ? { baseUrl: patch.baseUrl } : {}),
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.models !== undefined ? { models: patch.models } : {}),
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.kind !== undefined ? { kind: patch.kind } : {})
  }
  store.saveProviderConfig(config)
  return listProviders()
}

export function removeProvider(id: string): Provider[] {
  const config = store.getProviderConfig()
  delete config[id]
  store.saveProviderConfig(config)
  secrets.clear(id)
  return listProviders()
}

/**
 * Keeps capabilities the seed list knew (context window, output cap, vision)
 * when a refreshed listing returns the same id with nothing but its name.
 */
function mergeWithSeed(providerId: string, fresh: ModelInfo[]): ModelInfo[] {
  const seed = BUILT_IN.find((p) => p.id === providerId)?.models ?? []
  const byId = new Map(seed.map((model) => [model.id, model]))
  return fresh.map((model) => enrichModel({ ...byId.get(model.id), ...model, ...(byId.get(model.id)?.label ? { label: byId.get(model.id)!.label } : {}) }))
}

/** Ask the provider what it can actually serve. Falls back to the seed list. */
export async function refreshModels(providerId: string): Promise<ModelInfo[]> {
  const provider = getProvider(providerId)
  if (!provider) throw new Error(`Unknown provider ${providerId}`)
  const [credentials] = await credentialAttempts(provider)

  if (provider.kind === 'anthropic') {
    const client = new Anthropic({
      apiKey: credentials.apiKey ?? null,
      baseURL: credentials.baseUrl ?? provider.baseUrl,
      defaultHeaders: { ...provider.headers, ...credentials.headers }
    })
    const models: ModelInfo[] = []
    for await (const model of client.models.list()) {
      const info = model as typeof model & { max_input_tokens?: number; max_tokens?: number }
      models.push({
        id: model.id,
        label: model.display_name ?? prettyLabel(model.id),
        providerId,
        tools: true,
        vision: true,
        ...(info.max_input_tokens ? { contextWindow: info.max_input_tokens } : {}),
        ...(info.max_tokens ? { maxOutput: Math.min(info.max_tokens, 64_000) } : {})
      })
    }
    const merged = mergeWithSeed(providerId, models)
    updateProvider(providerId, { models: merged })
    return merged
  }

  const base = (credentials.baseUrl ?? provider.baseUrl).replace(/\/$/, '')
  if (!base) throw new Error('Set a base URL first')
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...provider.headers, ...credentials.headers }
  if (credentials.apiKey) headers.Authorization = `Bearer ${credentials.apiKey}`
  const response = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 300)}`)
  type Row = { id: string; name?: string; context_length?: number; context_window?: number; max_model_len?: number }
  const body = (await response.json()) as { data?: Row[]; models?: { id?: string; name?: string }[] }
  const rows: Row[] = body.data ?? (body.models ?? []).map((row) => ({ id: row.id ?? row.name ?? '', name: row.name }))
  const models: ModelInfo[] = rows
    .filter((row) => row.id && isChatModelId(row.id))
    .map((row) => ({
      id: row.id,
      label: prettyLabel(row.id),
      providerId,
      ...((row.context_length ?? row.context_window ?? row.max_model_len)
        ? { contextWindow: row.context_length ?? row.context_window ?? row.max_model_len }
        : {})
    }))
  const merged = mergeWithSeed(providerId, models)
  updateProvider(providerId, { models: merged })
  return merged
}

export async function testProvider(providerId: string): Promise<{ ok: boolean; message: string }> {
  try {
    const models = await refreshModels(providerId)
    return { ok: true, message: `Connected — ${models.length} model${models.length === 1 ? '' : 's'} available` }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}
