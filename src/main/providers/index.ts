import Anthropic from '@anthropic-ai/sdk'
import type { ModelInfo, Provider, TokenUsage } from '@shared/types'
import type { ModelSource } from '@shared/engines'
import { isLastingIssue, type ModelEdit, type ModelEditFields, type ModelsRefresh, type ProviderHealth, type ProviderIssue } from '@shared/providers'
import { describeModelsRefresh, foldDatedAliases } from '@shared/modelSelection'
import { secrets } from '../secrets'
import { store, type ProviderOverride } from '../store'
import { anthropicAdapter } from './adapters/anthropic'
import { ollamaAdapter, ollamaHost } from './adapters/ollama'
import { openaiChatAdapter } from './adapters/openaiChat'
import { openaiResponsesAdapter } from './adapters/openaiResponses'
import { routerAdapter } from './adapters/router'
import { describeErrorBody, ProviderHttpError, retryAfterFrom, type Adapter } from './adapters/types'
import { BUILT_IN, LEGACY_DEFAULT_URLS, providerMeta } from './catalog'
import { anthropicCompat, authHeaders, chatCompat, effortReaches, isMixedApiProvider, isOwnServerUrl, normalizeBaseUrl, requestBase, vendorOf } from './compat'
import { accountFlow, credentialAttempts } from './credentials'
import { classifyProviderError, noModelsIssue, ProviderIssueError } from './errors'
import { findLocalModel, isEmbeddingModel, LOCAL_PROVIDER_ID, localModelInfo, localModels, runtimeModel } from '../llama/models'
import { llamaRuntime } from '../llama/runtime'
import { parseChatGptPlanListing, parseCopilotListing, parseListing } from './listing'
import { catalogFetchedAt, catalogFor, hasCatalog, refreshCatalog } from './modelCatalog'
import { enrichModel, isChatModelId, isOllamaCloudModel, LOCAL_CONTEXT, OPENAI_EFFORTS, prettyLabel } from './models'
import { oauthFlow } from './oauth'
import { COPILOT_API_VERSION } from './oauth/copilot'
import './oauth/flows'
import { providerFetch, sdkFetch } from './safeFetch'

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

/**
 * Eaon's own runtime: load the model into llama-server (first use, or after
 * idling out), then talk to it like any OpenAI-compatible server — its port
 * and key change every time it starts, so they come in per request.
 */
const localRuntimeAdapter: Adapter = {
  ...openaiChatAdapter,
  async turn(request) {
    const model = findLocalModel(request.modelId)
    if (!model) throw new Error(`${request.modelId} isn’t downloaded on this computer. Get it on the Models page.`)
    const target = await llamaRuntime.ensure(runtimeModel(model))
    const keepAlive = setInterval(() => llamaRuntime.touch(), 30_000)
    try {
      return await openaiChatAdapter.turn({ ...request, credentials: { ...request.credentials, apiKey: target.apiKey, baseUrl: target.baseUrl } })
    } finally {
      clearInterval(keepAlive)
      llamaRuntime.touch()
    }
  }
}

type UsageListener = (providerId: string, modelId: string, usage: TokenUsage) => void
const usageListeners = new Set<UsageListener>()

/**
 * Called after every model request Eaon makes for itself, with what the
 * provider billed. Settings → Usage counts these (features/usage).
 */
export function onModelUsage(listener: UsageListener): () => void {
  usageListeners.add(listener)
  return () => usageListeners.delete(listener)
}

function tracked(adapter: Adapter, provider: Provider): Adapter {
  return {
    ...adapter,
    async turn(request) {
      const result = await adapter.turn(request)
      for (const listener of usageListeners) {
        try {
          listener(provider.id, request.modelId, result.usage)
        } catch (error) {
          console.error('[usage] listener failed:', error)
        }
      }
      return result
    }
  }
}

/**
 * The adapter for a provider. `track: false` leaves its requests out of
 * Eaon's usage: the gateway's, which other apps make through Eaon and which
 * are counted as those apps (Claude Code's by Tokn's own CLI), not twice.
 */
export function adapterFor(provider: Provider, options: { track?: boolean } = {}): Adapter {
  let adapter: Adapter
  const registered = extraAdapters.get(provider.kind)
  if (provider.id === LOCAL_PROVIDER_ID) adapter = localRuntimeAdapter
  else if (registered) adapter = registered
  else if (provider.kind === 'anthropic') {
    adapter = anthropicCompat(provider, provider.baseUrl, '', undefined).firstParty ? anthropicAdapter : anthropicCompatibleAdapter
  } else if (isMixedApiProvider(provider)) adapter = routerAdapter
  else adapter = openaiChatAdapter
  if (provider.auth === 'oauth') adapter = withFreshCredentials(adapter)
  return options.track === false ? adapter : tracked(adapter, provider)
}

/**
 * Plan listings say what the account may use (Copilot hides models its
 * policy turns off; the ChatGPT plan lists its own set), so once one exists
 * it bounds the catalog. Everywhere else a listing only adds to it.
 */
const LISTING_IS_ENTITLEMENT = new Set(['github-copilot', 'chatgpt'])

/**
 * Of those, the plans whose list is kept apart from the catalog by marking,
 * not hiding: the ChatGPT plan's list lags new models (GPT-6.1 Sol was
 * nowhere on an account that could use it), so catalog models it leaves out
 * stay offered as `outsidePlan`, after the listed ones. Copilot's list is
 * its policy, and a model it leaves out is switched off.
 */
const MARKS_OUTSIDE_PLAN = new Set(['chatgpt'])

/** Saves from before overlays kept the whole list in `models`; it was the last listing. */
const listedOf = (override: ProviderOverride): ModelInfo[] => override.listed ?? override.models ?? []

/**
 * A provider's models, built in layers like Pi's model registry: the catalog
 * (corrected limits and effort levels) first, newest first; then whatever the
 * provider's own `/models` returned that the catalog lacks; then models the
 * user added by id. The user's renames apply on top, and models they removed
 * are set aside in `hiddenModels` rather than lost, so nothing removed by
 * accident is gone for good and an app update can still add new models.
 */
function composeModels(provider: Provider, seed: ModelInfo[], override: ProviderOverride): Pick<Provider, 'models' | 'hiddenModels'> {
  const listed = listedOf(override)
  const catalog = hasCatalog(provider.id) ? catalogFor(provider.id) : seed.map((m) => ({ ...m, source: SHIPPED }))
  // A plan listing bounds the catalog once one was fetched, even an empty one: an account whose plan allows nothing has nothing.
  const allowed = LISTING_IS_ENTITLEMENT.has(provider.id) && (listed.length > 0 || override.listedAt !== undefined) ? new Set(listed.map((m) => m.id)) : null
  const listedSource = listingSource(override)
  const byId = new Map<string, ModelInfo>()
  for (const model of catalog) {
    if (!allowed || allowed.has(model.id)) byId.set(model.id, model)
    else if (MARKS_OUTSIDE_PLAN.has(provider.id)) byId.set(model.id, { ...model, outsidePlan: true })
  }
  for (const model of listed) {
    const known = byId.get(model.id)
    // The catalog's limits and effort levels are corrected; the listing only fills gaps. The
    // listing is what says the provider serves it now, so its freshness is the model's.
    byId.set(model.id, known ? { ...model, ...known, source: listedSource } : { ...model, source: listedSource })
  }
  for (const model of override.custom ?? []) if (!byId.has(model.id)) byId.set(model.id, { ...model, custom: true, source: { kind: 'custom', retrievedAt: null } })

  const hidden = new Set(override.hidden ?? [])
  const labels = override.labels ?? {}
  const edits = override.edits ?? {}
  const models: ModelInfo[] = []
  const hiddenModels: ModelInfo[] = []
  const listedIds = new Set(listed.map((m) => m.id))
  // A listing's dated snapshot next to the catalog's alias is one model, not two,
  // and the snapshot being listed vouches for the alias.
  for (const folded of foldDatedAliases([...byId.values()])) {
    const raw = !listedIds.has(folded.id) && folded.aliases?.some((id) => listedIds.has(id)) ? { ...folded, source: listedSource } : folded
    const model = enrichModel({ ...raw, providerId: provider.id, ...(labels[raw.id] ? { label: labels[raw.id] } : {}) })
    if (edits[raw.id]) applyModelEdit(model, edits[raw.id])
    if (labels[raw.id] || edits[raw.id]) model.edited = true
    if (model.efforts?.length && !effortReaches(provider, model.id, model)) model.efforts = []
    ;(hidden.has(model.id) ? hiddenModels : models).push(model)
  }
  // The plan's own models first, so its default and the first choice are ones it serves. (Stable sort.)
  models.sort((a, b) => Number(Boolean(a.outsidePlan)) - Number(Boolean(b.outsidePlan)))
  return { models, hiddenModels }
}

const SHIPPED: ModelSource = { kind: 'shipped', retrievedAt: null }

/** The provider's own listing: live when the last fetch worked, the kept copy when a later one failed. */
function listingSource(override: ProviderOverride): ModelSource {
  const at = override.listedAt ?? null
  const failedSince = override.listFailedAt !== undefined && (at === null || override.listFailedAt > at)
  return { kind: at === null || failedSince ? 'cache' : 'provider-live', retrievedAt: at }
}

/** The user's Edit model settings, over what the catalog and the listing said. */
function applyModelEdit(model: ModelInfo, edit: ModelEditFields): void {
  if (typeof edit.contextWindow === 'number' && edit.contextWindow > 0) model.contextWindow = edit.contextWindow
  if (typeof edit.maxOutput === 'number' && edit.maxOutput > 0) model.maxOutput = edit.maxOutput
  if (typeof edit.tools === 'boolean') model.tools = edit.tools
  if (typeof edit.vision === 'boolean') model.vision = edit.vision
  if (typeof edit.reasoning === 'boolean') {
    model.reasoning = edit.reasoning
    // Thinking is what the effort control is for; a model newly marked as
    // thinking gets the common three levels unless it already knows its own.
    if (!edit.reasoning) model.efforts = []
    else if (!model.efforts?.length) model.efforts = ['light', 'medium', 'high']
    // The user said so: no longer a guess from the id.
    const inferred = model.inferred?.filter((field) => field !== 'reasoning' && field !== 'efforts')
    if (inferred?.length) model.inferred = inferred
    else delete model.inferred
  }
}

function builtInProvider(seed: (typeof BUILT_IN)[number], override: ProviderOverride): Provider {
  const auth = seed.auth ?? (seed.local ? 'none' : 'key')
  const flow = auth === 'oauth' ? oauthFlow(seed.oauthFlow) : undefined
  const signedIn = auth === 'oauth' ? Boolean(flow?.isSignedIn()) : undefined
  // An untouched old default for a provider whose endpoint moved is not a user choice.
  const overrideUrl = override.baseUrl
  const baseUrl = overrideUrl && !LEGACY_DEFAULT_URLS[seed.id]?.includes(overrideUrl) ? overrideUrl : seed.baseUrl
  const provider: Provider = {
    ...seed,
    auth,
    local: seed.local ?? false,
    baseUrl,
    enabled: override.enabled ?? seed.enabled,
    models: [],
    // A key provider signed in with the account (Hugging Face) is usable without a key.
    hasKey: auth === 'oauth' ? Boolean(signedIn) : secrets.has(seed.id) || Boolean(accountFlow(seed.id)),
    signedIn,
    fallbackCount: auth === 'oauth' ? 0 : secrets.getFallbacks(seed.id).length,
    ...(override.health ? { health: override.health } : {}),
    modelsListedAt: override.listedAt ?? null
  }
  if (seed.id === LOCAL_PROVIDER_ID) {
    provider.models = localModels().filter((m) => !isEmbeddingModel(m)).map(localModelInfo)
    return provider
  }
  return { ...provider, ...composeModels(provider, seed.models, override) }
}

/** A custom OpenAI-compatible endpoint the user added themselves. */
function customProvider(id: string, override: ProviderOverride): Provider {
  const provider: Provider = {
    id,
    name: override.name ?? id,
    kind: (override.kind as Provider['kind']) ?? 'openai-compatible',
    baseUrl: override.baseUrl ?? '',
    hasKey: secrets.has(id),
    enabled: override.enabled ?? true,
    builtIn: false,
    local: false,
    auth: 'key',
    category: 'custom',
    fallbackCount: secrets.getFallbacks(id).length,
    models: [],
    ...(override.health ? { health: override.health } : {}),
    modelsListedAt: override.listedAt ?? null
  }
  return { ...provider, ...composeModels(provider, [], override) }
}

export function listProviders(): Provider[] {
  const overrides = store.getProviderConfig()
  const merged = BUILT_IN.map((seed) => builtInProvider(seed, overrides[seed.id] ?? {}))
  for (const [id, override] of Object.entries(overrides)) {
    if (!BUILT_IN.some((p) => p.id === id)) merged.push(customProvider(id, override))
  }
  return merged
}

/** One provider, without building the other sixty (the agent loop asks once per turn). */
export function getProvider(id: string): Provider | undefined {
  const override = store.getProviderConfig()[id]
  const seed = BUILT_IN.find((p) => p.id === id)
  if (seed) return builtInProvider(seed, override ?? {})
  return override ? customProvider(id, override) : undefined
}

export function updateProvider(id: string, patch: Partial<Pick<Provider, 'baseUrl' | 'enabled' | 'name' | 'kind'>>): Provider[] {
  const config = store.getProviderConfig()
  const existing = config[id] ?? {}
  const current = BUILT_IN.find((p) => p.id === id) ?? { id, kind: (patch.kind ?? existing.kind ?? 'openai-compatible') as Provider['kind'], baseUrl: '' }
  config[id] = {
    ...existing,
    ...(patch.baseUrl !== undefined ? { baseUrl: normalizeBaseUrl(current, patch.baseUrl) } : {}),
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.kind !== undefined ? { kind: patch.kind } : {})
  }
  store.saveProviderConfig(config)
  return listProviders()
}

/** Rewrites one provider's overlay, folding a pre-overlay `models` list into `listed` on the way. */
function editOverride(id: string, edit: (override: ProviderOverride) => ProviderOverride): void {
  const config = store.getProviderConfig()
  const { models: legacy, ...existing } = config[id] ?? {}
  config[id] = edit({ ...existing, ...(legacy && !existing.listed ? { listed: legacy } : {}) })
  store.saveProviderConfig(config)
}

/** Stores what the provider's own `/models` returned, as the last list that worked. */
function setListed(id: string, models: ModelInfo[], at = Date.now()): void {
  editOverride(id, (override) => {
    const { listFailedAt: _failed, ...rest } = override
    return { ...rest, listed: models, listedAt: at }
  })
}

/**
 * Records what a check of a provider found. A success clears a failed check;
 * a lasting failure (expired sign-in, rejected key, no credit, no models)
 * makes the provider "Needs attention" until something works again; a
 * passing one (offline, timeout, outage, rate limit) changes nothing.
 * Returns true when the stored state changed.
 */
export function noteProviderHealth(id: string, issue: ProviderIssue | null, at = Date.now()): boolean {
  const current = store.getProviderConfig()[id]?.health
  if (!issue) {
    if (!current || current.ok) return false
    editOverride(id, (override) => ({ ...override, health: { ok: true, issue: null, checkedAt: at } }))
    return true
  }
  if (!isLastingIssue(issue.kind)) return false
  if (current && !current.ok && current.issue?.kind === issue.kind && current.issue.message === issue.message) return false
  const health: ProviderHealth = { ok: false, issue, checkedAt: at }
  editOverride(id, (override) => ({ ...override, health }))
  return true
}

/** Forgets a failed check: after a new key, a sign-in or a sign-out, the old verdict no longer applies. */
export function clearProviderHealth(id: string): void {
  if (!store.getProviderConfig()[id]?.health) return
  editOverride(id, (override) => {
    const { health: _health, ...rest } = override
    return rest
  })
}

/** A listing that failed: the kept list becomes "the last one that worked", and a lasting failure marks the provider. */
function listingFailed(id: string, issue: ProviderIssue, at = Date.now()): void {
  editOverride(id, (override) => ({ ...override, listFailedAt: at }))
  noteProviderHealth(id, issue, at)
}

/**
 * The user's changes to a model list. Removing a model hides it (a model added
 * by hand is deleted outright); restoring brings it back; renaming stores a
 * label that survives every refresh.
 */
export function editModels(id: string, edit: ModelEdit): Provider[] {
  // Set inside the edit callback when a hand-added model's id changes.
  const moved: { from: string; to: string }[] = []
  editOverride(id, (override) => {
    const hidden = new Set(override.hidden ?? [])
    let custom = override.custom ?? []
    const labels = { ...override.labels }
    const edits = { ...override.edits }
    if ('remove' in edit) {
      if (custom.some((m) => m.id === edit.remove)) custom = custom.filter((m) => m.id !== edit.remove)
      else hidden.add(edit.remove)
    } else if ('restore' in edit) hidden.delete(edit.restore)
    else if ('restoreAll' in edit) hidden.clear()
    else if ('add' in edit) {
      const modelId = edit.add.trim()
      if (modelId) {
        hidden.delete(modelId)
        if (!custom.some((m) => m.id === modelId)) custom = [...custom, { id: modelId, label: modelId, providerId: id, custom: true }]
      }
    } else if ('rename' in edit) {
      const label = edit.label?.trim()
      if (label) labels[edit.rename] = label
      else delete labels[edit.rename]
    } else if ('update' in edit) {
      let modelId = edit.update
      // A model added by hand can have its id corrected; one from the catalog can't.
      const to = edit.id?.trim()
      if (to && to !== modelId && custom.some((m) => m.id === modelId)) {
        if (custom.some((m) => m.id === to)) throw new Error(`There is already a model "${to}".`)
        custom = custom.map((m) => (m.id === modelId ? { ...m, id: to, label: m.label === modelId ? to : m.label } : m))
        if (labels[modelId]) labels[to] = labels[modelId]
        delete labels[modelId]
        if (edits[modelId]) edits[to] = edits[modelId]
        delete edits[modelId]
        moved.push({ from: modelId, to })
        modelId = to
      }
      if (edit.label !== undefined) {
        const label = edit.label?.trim()
        if (label) labels[modelId] = label
        else delete labels[modelId]
      }
      if (edit.fields) {
        const next: ModelEditFields = { ...edits[modelId] }
        for (const [key, value] of Object.entries(edit.fields)) {
          if (value === null || value === undefined) delete (next as Record<string, unknown>)[key]
          else (next as Record<string, unknown>)[key] = value
        }
        if (Object.keys(next).length > 0) edits[modelId] = next
        else delete edits[modelId]
      }
    } else if ('reset' in edit) {
      delete labels[edit.reset]
      delete edits[edit.reset]
    }
    return { ...override, hidden: [...hidden], custom, labels, edits }
  })
  // A corrected id: the model picker and stars follow it.
  for (const { from, to } of moved) {
    const settings = store.getSettings()
    const key = (model: string): string => `${id}:${model}`
    store.patchSettings({
      ...(settings.selectedProviderId === id && settings.selectedModelId === from ? { selectedModelId: to } : {}),
      ...(settings.favoriteModels?.includes(key(from)) ? { favoriteModels: settings.favoriteModels.map((f) => (f === key(from) ? key(to) : f)) } : {})
    })
  }
  return listProviders()
}

export function removeProvider(id: string): Provider[] {
  const config = store.getProviderConfig()
  delete config[id]
  store.saveProviderConfig(config)
  secrets.clear(id)
  return listProviders()
}

/** Ollama's native API knows each model's trained context and capabilities; `/v1/models` knows neither. */
async function listOllamaModels(provider: Provider): Promise<ModelInfo[]> {
  const host = ollamaHost(provider.baseUrl)
  let tags: Response
  try {
    tags = await providerFetch(`${host}/api/tags`, { signal: AbortSignal.timeout(5000) })
  } catch (error) {
    // The cause (connection refused, timed out) is what tells "not running" from "slow".
    throw new Error(`Could not reach Ollama at ${host} — make sure it is installed and running.`, { cause: error })
  }
  if (!tags.ok) throw new ProviderHttpError(tags.status, describeErrorBody(tags.status, await tags.text()))
  const names = (((await tags.json()) as { models?: { name?: string }[] }).models ?? []).map((row) => row.name).filter((name): name is string => Boolean(name))

  const models = await Promise.all(
    names.map(async (name): Promise<ModelInfo | null> => {
      let capabilities: string[] | undefined
      let trained: number | undefined
      try {
        const show = await providerFetch(`${host}/api/show`, { method: 'POST', body: JSON.stringify({ model: name }), signal: AbortSignal.timeout(8000) })
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
        // `/api/show` lists what the model can do; an Ollama too old to say leaves it unknown.
        ...(capabilities ? { tools: capabilities.includes('tools'), vision: capabilities.includes('vision') } : {}),
        reasoning: thinks,
        // Ollama's `think` takes levels only for gpt-oss; elsewhere it is on or off.
        efforts: thinks && /gpt-oss/.test(name) ? OPENAI_EFFORTS : [],
        // Without capabilities, "doesn't think" only keeps `think` out of the request; it isn't known.
        ...(capabilities ? {} : { inferred: ['reasoning', 'efforts'] as ModelInfo['inferred'] })
      }
    })
  )
  return models.filter((model): model is ModelInfo => model !== null)
}

/**
 * Ask the provider what it can actually serve, and keep it as the last list
 * that worked. A failure keeps the previous list, marks it as the kept copy,
 * and throws a `ProviderIssueError` saying what went wrong in plain words.
 */
export async function refreshModels(providerId: string): Promise<ModelInfo[]> {
  const provider = getProvider(providerId)
  if (!provider) throw new Error(`Unknown provider ${providerId}`)
  if (isOwnServerUrl(provider.baseUrl)) {
    throw new Error(`${provider.name}'s base URL is Eaon's own Local API Server. Change the port of one of them.`)
  }
  const meta = providerMeta(providerId)

  // Codex, Perplexity and Cloudflare have no listing endpoint; their list is the catalog's.
  if (!meta.listsModels) return provider.models

  let models: ModelInfo[]
  try {
    models = await fetchListing(provider)
  } catch (error) {
    const issue = classifyProviderError(error, provider, 'listing')
    listingFailed(providerId, issue)
    throw new ProviderIssueError(issue)
  }
  setListed(providerId, models)
  noteProviderHealth(providerId, null)
  const after = getProvider(providerId)
  // An empty answer only means "nothing to use" where the listing is the whole list: a plan, or a custom endpoint.
  if (models.length === 0 && after?.models.length === 0 && !provider.local && (LISTING_IS_ENTITLEMENT.has(providerId) || !provider.builtIn)) {
    noteProviderHealth(providerId, noModelsIssue(provider))
  }
  return after?.models ?? []
}

/** The provider's own model list, as its API returns it. Throws whatever the request threw. */
async function fetchListing(provider: Provider): Promise<ModelInfo[]> {
  const providerId = provider.id
  if (provider.kind === 'ollama') return listOllamaModels(provider)

  const [credentials] = await credentialAttempts(provider)
  const vendor = vendorOf(provider, credentials.baseUrl ?? provider.baseUrl)

  if (provider.kind === 'anthropic') {
    const client = new Anthropic({
      apiKey: credentials.apiKey ?? null,
      baseURL: requestBase(provider, credentials.baseUrl),
      defaultHeaders: { ...provider.headers, ...credentials.headers },
      maxRetries: 0,
      // Listing is a quick GET; a hung host must not hold the Refresh button forever.
      timeout: 20_000,
      fetch: sdkFetch
    })
    const models: ModelInfo[] = []
    for await (const model of client.models.list()) {
      type Supported = { supported?: boolean } | undefined
      const info = model as typeof model & { max_input_tokens?: number; max_tokens?: number; capabilities?: { image_input?: Supported } }
      const images = info.capabilities?.image_input?.supported
      models.push({
        id: model.id,
        label: model.display_name ?? prettyLabel(model.id),
        providerId,
        // Only what the listing says; the catalog knows the rest of each Claude model.
        ...(typeof images === 'boolean' ? { vision: images } : {}),
        ...(info.max_input_tokens ? { contextWindow: info.max_input_tokens } : {}),
        ...(info.max_tokens ? { maxOutput: Math.min(info.max_tokens, 64_000) } : {})
      })
    }
    return models
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
  const response = await providerFetch(`${base}/models`, { headers, signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new ProviderHttpError(response.status, describeErrorBody(response.status, await response.text()), retryAfterFrom(response.headers))
  const body = (await response.json()) as unknown
  return vendor === 'copilot'
    ? parseCopilotListing(body)
    : vendor === 'chatgpt-plan'
      ? parseChatGptPlanListing(body, providerId)
      : parseListing(body, providerId, vendor)
}

/** Local discovery: a runtime that is gone, or Eaon's own server on its port, lists nothing. */
export function clearListed(providerId: string): void {
  setListed(providerId, [])
}

/**
 * The Refresh button: re-read models.dev (no key needed, so it works before
 * a provider is set up) and, when the provider is usable, its own `/models`.
 * The answer says what actually happened — new models, models gone, no
 * change, or that the provider couldn't be reached and which list is shown
 * instead — so pressing it never reads as "done" when nothing was checked.
 */
export async function refreshProviderModels(providerId: string, now = (): number => Date.now()): Promise<ModelsRefresh> {
  const provider = getProvider(providerId)
  if (!provider) throw new Error(`Unknown provider ${providerId}`)
  const shownBefore = provider.models
  const known = new Set([...provider.models, ...(provider.hiddenModels ?? [])].map((m) => m.id))

  let catalogFailed = false
  if (hasCatalog(providerId)) {
    try {
      await refreshCatalog()
    } catch {
      catalogFailed = true
    }
  }
  const usable = provider.local || provider.hasKey
  const lists = providerMeta(providerId).listsModels && provider.id !== LOCAL_PROVIDER_ID
  let issue: ProviderIssue | null = null
  if (usable && lists) {
    try {
      await refreshModels(providerId)
    } catch (error) {
      issue = classifyProviderError(error, provider, 'listing')
    }
  }

  const after = getProvider(providerId) ?? provider
  const shownAfter = new Set(after.models.map((m) => m.id))
  const hiddenAfter = new Set((after.hiddenModels ?? []).map((m) => m.id))
  const added = after.models.filter((m) => !known.has(m.id)).map((m) => m.label)
  // Gone from the provider, not just hidden by the user since.
  const removed = shownBefore.filter((m) => !shownAfter.has(m.id) && !hiddenAfter.has(m.id)).map((m) => m.label)
  const checkedAt = now()

  if (issue) {
    return {
      ok: false,
      added,
      removed,
      checkedAt,
      issue,
      message: describeModelsRefresh({ providerName: provider.name, ok: false, added, removed, failure: issue.message, lastGoodAt: after.modelsListedAt ?? null, now: checkedAt })
    }
  }
  if (catalogFailed && !(usable && lists)) {
    return {
      ok: false,
      added,
      removed,
      checkedAt,
      message: describeModelsRefresh({
        providerName: provider.name,
        ok: false,
        added,
        removed,
        checkedProvider: false,
        failure: 'Check your internet connection.',
        lastGoodAt: catalogFetchedAt(),
        now: checkedAt
      })
    }
  }
  let message = describeModelsRefresh({ providerName: provider.name, ok: true, added, removed, lastGoodAt: checkedAt, now: checkedAt })
  // Only the catalog could be checked: say what would check the provider itself.
  if (lists && !usable) message += ` ${provider.auth === 'oauth' ? 'Sign in' : 'Add an API key'} to check ${provider.name}’s own list.`
  return { ok: true, added, removed, checkedAt, message }
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
    const health = getProvider(providerId)?.health
    if (health && !health.ok && health.issue) return { ok: false, message: health.issue.message }
    return { ok: true, message: `Connected — ${models.length} model${models.length === 1 ? '' : 's'} available` }
  } catch (error) {
    return { ok: false, message: provider ? classifyProviderError(error, provider, 'listing').message : error instanceof Error ? error.message : String(error) }
  }
}
