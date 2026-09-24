import Anthropic from '@anthropic-ai/sdk'
import type { ModelInfo, Provider } from '@shared/types'
import { secrets } from '../secrets'
import { store } from '../store'
import { anthropicAdapter } from './adapters/anthropic'
import { ollamaAdapter, ollamaHost } from './adapters/ollama'
import { openaiChatAdapter } from './adapters/openaiChat'
import { openaiResponsesAdapter } from './adapters/openaiResponses'
import { routerAdapter } from './adapters/router'
import { ProviderHttpError, type Adapter } from './adapters/types'
import { BUILT_IN, LEGACY_DEFAULT_URLS, providerMeta } from './catalog'
import { anthropicCompat, authHeaders, chatCompat, isMixedApiProvider, normalizeBaseUrl, requestBase, vendorOf } from './compat'
import { credentialAttempts } from './credentials'
import { parseCopilotListing, parseListing } from './listing'
import { enrichModel, isChatModelId, isOllamaCloudModel, LOCAL_CONTEXT, OPENAI_EFFORTS, prettyLabel } from './models'
import { oauthFlow } from './oauth'
import { COPILOT_API_VERSION } from './oauth/copilot'
import './oauth/flows'

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
 * Adapters beyond Anthropic and chat-completions register themselves by
 * provider kind, so adding a wire format does not mean editing `adapterFor`.
 */
const extraAdapters = new Map<Provider['kind'], Adapter>()

export function registerAdapter(kind: Provider['kind'], adapter: Adapter): void {
  extraAdapters.set(kind, adapter)
}

registerAdapter('openai-responses', openaiResponsesAdapter)
registerAdapter('ollama', ollamaAdapter)

/** Anthropic-compatible hosts get the same adapter, minus server-side context clearing. */
const anthropicCompatibleAdapter: Adapter = { ...anthropicAdapter, managesContext: false }

/**
 * Subscription tokens expire mid-session (Copilot's after ~30 minutes), and
 * the loop resolves credentials once per turn. Re-resolving before every
 * request is free while the token is fresh, and a 401 gets one forced refresh
 * before it is reported.
 */
function withFreshCredentials(adapter: Adapter): Adapter {
  return {
    ...adapter,
    async turn(request) {
      const flow = oauthFlow(request.provider.oauthFlow)
      if (!flow) return adapter.turn(request)
      const fresh = await flow.credentials(request.provider)
      try {
        return await adapter.turn({ ...request, credentials: { ...request.credentials, ...fresh } })
      } catch (error) {
        if (!(error instanceof ProviderHttpError) || error.status !== 401 || !flow.expire) throw error
        flow.expire()
        const retry = await flow.credentials(request.provider)
        return adapter.turn({ ...request, credentials: { ...request.credentials, ...retry } })
      }
    }
  }
}

export function adapterFor(provider: Provider): Adapter {
  let adapter: Adapter
  const registered = extraAdapters.get(provider.kind)
  if (registered) adapter = registered
  else if (provider.kind === 'anthropic') {
    adapter = anthropicCompat(provider, provider.baseUrl, '', undefined).firstParty ? anthropicAdapter : anthropicCompatibleAdapter
  } else if (isMixedApiProvider(provider)) adapter = routerAdapter
  else adapter = openaiChatAdapter
  return provider.auth === 'oauth' ? withFreshCredentials(adapter) : adapter
}

export function listProviders(): Provider[] {
  const overrides = store.getProviderConfig()
  const merged: Provider[] = BUILT_IN.map((provider) => {
    const override = overrides[provider.id] ?? {}
    const auth = provider.auth ?? (provider.local ? 'none' : 'key')
    const flow = auth === 'oauth' ? oauthFlow(provider.oauthFlow) : undefined
    const signedIn = auth === 'oauth' ? Boolean(flow?.isSignedIn()) : undefined
    // An untouched old default for a provider whose endpoint moved is not a user choice.
    const overrideUrl = override.baseUrl as string | undefined
    const baseUrl = overrideUrl && !LEGACY_DEFAULT_URLS[provider.id]?.includes(overrideUrl) ? overrideUrl : provider.baseUrl
    return {
      ...provider,
      auth,
      local: provider.local ?? false,
      baseUrl,
      enabled: (override.enabled as boolean) ?? provider.enabled,
      models: ((override.models as ModelInfo[]) ?? provider.models).map(enrichModel),
      hasKey: auth === 'oauth' ? Boolean(signedIn) : secrets.has(provider.id),
      signedIn,
      fallbackCount: auth === 'oauth' ? 0 : secrets.getFallbacks(provider.id).length
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
  const current = BUILT_IN.find((p) => p.id === id) ?? { id, kind: (patch.kind ?? existing.kind ?? 'openai-compatible') as Provider['kind'], baseUrl: '' }
  config[id] = {
    ...existing,
    ...(patch.baseUrl !== undefined ? { baseUrl: normalizeBaseUrl(current, patch.baseUrl) } : {}),
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
 * Keeps what the seed list knew (context window, output cap, effort levels,
 * vision) when a refreshed listing returns the same id with less. Anything
 * the listing does report — OpenRouter's `context_length`, say — wins, since
 * it is the provider's own current answer.
 */
function mergeWithSeed(providerId: string, fresh: ModelInfo[]): ModelInfo[] {
  const seed = BUILT_IN.find((p) => p.id === providerId)?.models ?? []
  const byId = new Map(seed.map((model) => [model.id, model]))
  return fresh.map((model) => {
    const known = byId.get(model.id)
    return enrichModel({ ...known, ...model, ...(known?.label ? { label: known.label } : {}) })
  })
}

/** Ollama's native API knows each model's trained context and capabilities; `/v1/models` knows neither. */
async function listOllamaModels(provider: Provider): Promise<ModelInfo[]> {
  const host = ollamaHost(provider.baseUrl)
  let tags: Response
  try {
    tags = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(5000) })
  } catch {
    throw new Error(`Could not reach Ollama at ${host} — make sure it is installed and running.`)
  }
  if (!tags.ok) throw new Error(`${tags.status} ${(await tags.text()).slice(0, 200)}`)
  const names = (((await tags.json()) as { models?: { name?: string }[] }).models ?? []).map((row) => row.name).filter((name): name is string => Boolean(name))

  const models = await Promise.all(
    names.map(async (name): Promise<ModelInfo | null> => {
      let capabilities: string[] | undefined
      let trained: number | undefined
      try {
        const show = await fetch(`${host}/api/show`, { method: 'POST', body: JSON.stringify({ model: name }), signal: AbortSignal.timeout(8000) })
        if (show.ok) {
          const body = (await show.json()) as { capabilities?: string[]; model_info?: Record<string, unknown> }
          capabilities = body.capabilities
          const key = Object.keys(body.model_info ?? {}).find((k) => k.endsWith('.context_length'))
          trained = key ? Number(body.model_info?.[key]) || undefined : undefined
        }
      } catch {
        /* keep the model with defaults */
      }
      // Embedding and image models list alongside chat models.
      if (capabilities ? !capabilities.includes('completion') : !isChatModelId(name)) return null
      const cloud = isOllamaCloudModel(name)
      const contextWindow = cloud ? (trained ?? 131_072) : Math.min(trained ?? LOCAL_CONTEXT, LOCAL_CONTEXT)
      const thinks = capabilities?.includes('thinking') ?? false
      return {
        id: name,
        // Ollama tags are what people type (`gpt-oss:20b`); prettifying them only obscures them.
        label: name,
        providerId: provider.id,
        contextWindow,
        tools: capabilities ? capabilities.includes('tools') : true,
        ...(capabilities?.includes('vision') ? { vision: true } : {}),
        reasoning: thinks,
        // Ollama's `think` takes levels only for gpt-oss; elsewhere it is on or off.
        efforts: thinks && /gpt-oss/.test(name) ? OPENAI_EFFORTS : []
      }
    })
  )
  return models.filter((model): model is ModelInfo => model !== null)
}

/** Ask the provider what it can actually serve. Falls back to the seed list. */
export async function refreshModels(providerId: string): Promise<ModelInfo[]> {
  const provider = getProvider(providerId)
  if (!provider) throw new Error(`Unknown provider ${providerId}`)
  const meta = providerMeta(providerId)

  // Codex, Perplexity and Cloudflare have no listing endpoint; their list is the catalog's.
  if (!meta.listsModels) return provider.models

  if (provider.kind === 'ollama') {
    const models = (await listOllamaModels(provider)).map(enrichModel)
    updateProvider(providerId, { models })
    return models
  }

  const [credentials] = await credentialAttempts(provider)
  const vendor = vendorOf(provider, credentials.baseUrl ?? provider.baseUrl)

  if (provider.kind === 'anthropic') {
    const client = new Anthropic({
      apiKey: credentials.apiKey ?? null,
      baseURL: requestBase(provider, credentials.baseUrl),
      defaultHeaders: { ...provider.headers, ...credentials.headers },
      maxRetries: 0
    })
    const models: ModelInfo[] = []
    for await (const model of client.models.list()) {
      const info = model as typeof model & { max_input_tokens?: number; max_tokens?: number }
      models.push({
        id: model.id,
        label: model.display_name ?? prettyLabel(model.id),
        providerId,
        tools: true,
        ...(model.id.includes('claude') ? { vision: true } : {}),
        ...(info.max_input_tokens ? { contextWindow: info.max_input_tokens } : {}),
        ...(info.max_tokens ? { maxOutput: Math.min(info.max_tokens, 64_000) } : {})
      })
    }
    const merged = mergeWithSeed(providerId, models)
    updateProvider(providerId, { models: merged })
    return merged
  }

  const base = requestBase(provider, credentials.baseUrl)
  const auth = chatCompat(provider, base, '').auth
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...provider.headers,
    ...credentials.headers,
    ...authHeaders(auth, credentials.apiKey),
    ...(vendor === 'copilot' ? { 'X-GitHub-Api-Version': COPILOT_API_VERSION } : {})
  }
  const response = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 300)}`)
  const body = (await response.json()) as unknown
  const models = vendor === 'copilot' ? parseCopilotListing(body) : parseListing(body, providerId, vendor)
  const merged = mergeWithSeed(providerId, models)
  updateProvider(providerId, { models: merged })
  return merged
}

export async function testProvider(providerId: string): Promise<{ ok: boolean; message: string }> {
  const provider = getProvider(providerId)
  if (provider && !providerMeta(providerId).listsModels) {
    // Nothing to list; saying so beats a 404 from an endpoint that never existed.
    if (!provider.hasKey && !provider.local) return { ok: false, message: 'Add an API key first.' }
    return {
      ok: true,
      message:
        provider.auth === 'oauth'
          ? `Signed in — ${provider.models.length} models available`
          : 'Saved. This provider has no model list to check against, so the key is verified on first use.'
    }
  }
  try {
    const models = await refreshModels(providerId)
    return { ok: true, message: `Connected — ${models.length} model${models.length === 1 ? '' : 's'} available` }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}
