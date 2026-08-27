import { randomUUID } from 'node:crypto'
import Anthropic from '@anthropic-ai/sdk'
import type { EffortLevel, McpTool, ModelInfo, Provider, StreamEvent, StreamRequest } from '@shared/types'
import { secrets } from './secrets'
import { store } from './store'
import { callMcpTool, getTools } from './mcp'
import { describeToolCall, isLocalTool, isMutatingTool, localToolsFor, runLocalTool } from './localTools'
import { isWebSearchTool, runWebSearch, webSearchTools } from './webSearch'

/**
 * Bring-your-own-key model access. Every provider is either Anthropic (served by
 * the official SDK) or speaks the OpenAI chat-completions wire format, which
 * covers OpenAI, OpenRouter, Groq, and most other hosted or local endpoints.
 */

/** UI effort names map 1:1 onto the API's effort levels. */
const EFFORT_TO_ANTHROPIC: Record<EffortLevel, 'low' | 'medium' | 'high' | 'xhigh' | 'max'> = {
  light: 'low',
  medium: 'medium',
  high: 'high',
  'extra-high': 'xhigh',
  ultra: 'max'
}

const EFFORT_TO_OPENAI: Record<EffortLevel, string> = {
  light: 'low',
  medium: 'medium',
  high: 'high',
  'extra-high': 'high',
  ultra: 'high'
}

const ALL_EFFORTS: EffortLevel[] = ['light', 'medium', 'high', 'extra-high', 'ultra']

/**
 * OpenAI's `reasoning_effort` only accepts low/medium/high, so offering the two
 * extra tiers there would be a lie — both would collapse to "high" on the wire.
 */
const OPENAI_EFFORTS: EffortLevel[] = ['light', 'medium', 'high']

/**
 * Which effort levels a model actually accepts. Returning `undefined` means the
 * model has no effort control at all, and the UI hides the picker rather than
 * offering a setting the request would reject or silently ignore.
 */
export function inferEfforts(modelId: string): EffortLevel[] | undefined {
  const id = modelId.toLowerCase()

  if (id.includes('claude')) {
    // Effort is rejected on the 4.5-era Sonnet/Haiku models.
    if (/haiku-4-5|haiku-4\.5|sonnet-4-5|sonnet-4\.5/.test(id)) return undefined
    if (/opus-5|sonnet-5|fable-5|mythos-5|opus-4-8|opus-4-7|opus-4-6|sonnet-4-6|opus-4-5/.test(id)) {
      return ALL_EFFORTS
    }
    return undefined
  }

  // OpenAI reasoning families.
  if (/^o[1-9](-|$)/.test(id) || id.startsWith('gpt-5')) return OPENAI_EFFORTS

  // Anything else (gpt-4o, gemini, llama, …) has no effort knob we can rely on.
  return undefined
}

type SeedProvider = Omit<Provider, 'hasKey' | 'local' | 'fallbackCount'> & { local?: boolean }

const BUILT_IN: SeedProvider[] = [
  // ---- Local runtimes: no key required, endpoint points at a port on this machine ----
  {
    id: 'llama-cpp',
    name: 'Llama.cpp',
    kind: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:8080/v1',
    enabled: true,
    builtIn: true,
    local: true,
    models: []
  },
  {
    id: 'mlx',
    name: 'MLX',
    kind: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:8080/v1',
    enabled: true,
    builtIn: true,
    local: true,
    models: []
  },
  {
    id: 'ollama',
    name: 'Ollama',
    kind: 'ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    enabled: true,
    builtIn: true,
    local: true,
    models: []
  },

  // ---- Remote, hosted providers ----
  {
    id: 'openai',
    name: 'OpenAI',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    enabled: true,
    builtIn: true,
    models: [
      { id: 'gpt-5', label: 'gpt-5', providerId: 'openai', efforts: OPENAI_EFFORTS, tools: true, vision: true },
      { id: 'gpt-5-mini', label: 'gpt-5-mini', providerId: 'openai', efforts: OPENAI_EFFORTS, tools: true, vision: true },
      { id: 'gpt-4.1', label: 'gpt-4.1', providerId: 'openai', tools: true, vision: true },
      { id: 'gpt-4o', label: 'gpt-4o', providerId: 'openai', tools: true, vision: true },
      { id: 'gpt-4o-mini', label: 'gpt-4o-mini', providerId: 'openai', tools: true, vision: true },
      { id: 'o3-mini', label: 'o3-mini', providerId: 'openai', efforts: OPENAI_EFFORTS, tools: true },
      { id: 'gpt-4-turbo', label: 'gpt-4-turbo', providerId: 'openai', tools: true, vision: true }
    ]
  },
  {
    id: 'azure',
    name: 'Azure',
    kind: 'openai-compatible',
    baseUrl: '',
    enabled: true,
    builtIn: true,
    models: []
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    enabled: true,
    builtIn: true,
    models: [
      { id: 'claude-opus-5', label: 'Opus 5', providerId: 'anthropic', efforts: ALL_EFFORTS, contextWindow: 1_000_000, tools: true, vision: true },
      { id: 'claude-sonnet-5', label: 'Sonnet 5', providerId: 'anthropic', efforts: ALL_EFFORTS, contextWindow: 1_000_000, tools: true, vision: true },
      { id: 'claude-haiku-4-5', label: 'Haiku 4.5', providerId: 'anthropic', contextWindow: 200_000, tools: true, vision: true },
      { id: 'claude-opus-4-8', label: 'Opus 4.8', providerId: 'anthropic', efforts: ALL_EFFORTS, contextWindow: 1_000_000, tools: true, vision: true },
      { id: 'claude-fable-5', label: 'Fable 5', providerId: 'anthropic', efforts: ALL_EFFORTS, contextWindow: 1_000_000, tools: true, vision: true }
    ]
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    kind: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    enabled: true,
    builtIn: true,
    models: []
  },
  {
    id: 'mistral',
    name: 'Mistral',
    kind: 'openai-compatible',
    baseUrl: 'https://api.mistral.ai/v1',
    enabled: true,
    builtIn: true,
    models: []
  },
  {
    id: 'groq',
    name: 'Groq',
    kind: 'openai-compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
    enabled: true,
    builtIn: true,
    models: []
  },
  {
    id: 'xai',
    name: 'xAI',
    kind: 'openai-compatible',
    baseUrl: 'https://api.x.ai/v1',
    enabled: true,
    builtIn: true,
    models: []
  },
  {
    id: 'gemini',
    name: 'Gemini',
    kind: 'openai-compatible',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    enabled: true,
    builtIn: true,
    models: [
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', providerId: 'gemini', tools: true, vision: true },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', providerId: 'gemini', tools: true, vision: true }
    ]
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    kind: 'openai-compatible',
    baseUrl: 'https://api.minimax.chat/v1',
    enabled: true,
    builtIn: true,
    models: []
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    kind: 'openai-compatible',
    baseUrl: 'https://router.huggingface.co/v1',
    enabled: true,
    builtIn: true,
    models: []
  },
  {
    id: 'nvidia-nim',
    name: 'NVIDIA NIM',
    kind: 'openai-compatible',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    enabled: true,
    builtIn: true,
    models: []
  }
]

export function listProviders(): Provider[] {
  const overrides = store.getProviderConfig()
  const merged: Provider[] = BUILT_IN.map((provider) => {
    const override = overrides[provider.id] ?? {}
    return {
      ...provider,
      local: provider.local ?? false,
      baseUrl: (override.baseUrl as string) ?? provider.baseUrl,
      enabled: (override.enabled as boolean) ?? provider.enabled,
      models: (override.models as ModelInfo[]) ?? provider.models,
      hasKey: secrets.has(provider.id),
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
      fallbackCount: secrets.getFallbacks(id).length,
      models: (override.models as ModelInfo[]) ?? []
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

/** Turn a raw model id into something short enough for the composer chip. */
function prettyLabel(id: string): string {
  const tail = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id
  return tail
    .replace(/[-_]/g, ' ')
    .replace(/\b(gpt|llama|qwen|mistral|claude|gemini)\b/gi, (m) => m.toUpperCase())
    .replace(/\s+/g, ' ')
    .trim()
}

/** Ask the provider what it can actually serve. Falls back to the seed list. */
export async function refreshModels(providerId: string): Promise<ModelInfo[]> {
  const provider = getProvider(providerId)
  if (!provider) throw new Error(`Unknown provider ${providerId}`)
  const key = secrets.get(providerId)

  if (provider.kind === 'anthropic') {
    if (!key) throw new Error('Add an API key first')
    const client = new Anthropic({ apiKey: key, baseURL: provider.baseUrl })
    const models: ModelInfo[] = []
    for await (const model of client.models.list()) {
      models.push({
        id: model.id,
        label: model.display_name ?? prettyLabel(model.id),
        providerId,
        efforts: inferEfforts(model.id)
      })
    }
    updateProvider(providerId, { models })
    return models
  }

  if (!provider.baseUrl) throw new Error('Set a base URL first')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (key) headers.Authorization = `Bearer ${key}`
  const response = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/models`, { headers })
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
  const body = (await response.json()) as { data?: { id: string }[] }
  const models: ModelInfo[] = (body.data ?? []).map((m) => ({
    id: m.id,
    label: prettyLabel(m.id),
    providerId,
    efforts: inferEfforts(m.id)
  }))
  updateProvider(providerId, { models })
  return models
}

export async function testProvider(providerId: string): Promise<{ ok: boolean; message: string }> {
  try {
    const models = await refreshModels(providerId)
    return { ok: true, message: `Connected — ${models.length} model${models.length === 1 ? '' : 's'} available` }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

const activeStreams = new Map<string, AbortController>()

export function cancelStream(messageId: string): void {
  activeStreams.get(messageId)?.abort()
  activeStreams.delete(messageId)
  for (const [requestId, pending] of pendingApprovals) {
    if (pending.messageId === messageId) {
      pending.resolve(false)
      pendingApprovals.delete(requestId)
    }
  }
}

/* ----------------------------------------------------------- Tool approval */

interface PendingApproval {
  messageId: string
  resolve: (approved: boolean) => void
}

const pendingApprovals = new Map<string, PendingApproval>()

/** Renderer answers a pending approval prompt shown for a tool call. */
export function resolveApproval(requestId: string, approved: boolean): void {
  pendingApprovals.get(requestId)?.resolve(approved)
  pendingApprovals.delete(requestId)
}

function requestApproval(
  messageId: string,
  tool: string,
  input: Record<string, unknown>,
  emit: (event: StreamEvent) => void
): Promise<boolean> {
  const requestId = randomUUID()
  return new Promise((resolve) => {
    pendingApprovals.set(requestId, { messageId, resolve })
    emit({ type: 'approval-request', messageId, requestId, tool, input })
  })
}

/** True for errors shaped like "this specific key is bad", worth retrying with the next fallback key. */
function isAuthError(error: unknown): boolean {
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) return true
  const message = error instanceof Error ? error.message : String(error)
  return /\b(401|403)\b/.test(message) || /invalid[_ ]api[_ ]key|unauthorized|authentication/i.test(message)
}

export async function runStream(request: StreamRequest, emit: (event: StreamEvent) => void): Promise<void> {
  const provider = getProvider(request.providerId)
  if (!provider) {
    emit({ type: 'error', messageId: request.messageId, error: `Unknown provider "${request.providerId}"` })
    return
  }

  const primary = secrets.get(request.providerId)
  const keys = primary ? [primary, ...secrets.getFallbacks(request.providerId)] : secrets.getFallbacks(request.providerId)
  if (keys.length === 0 && !provider.local) {
    emit({
      type: 'error',
      messageId: request.messageId,
      error: `No API key for ${provider.name}. Add one in Settings → Model providers.`
    })
    return
  }

  const controller = new AbortController()
  activeStreams.set(request.messageId, controller)
  try {
    // Try the primary key, then each fallback in order — only for a key-shaped
    // failure. Anything else (bad model id, network error, refusal) surfaces
    // immediately rather than burning through every configured key.
    const attempts = keys.length > 0 ? keys : [undefined]
    let lastError: unknown
    for (let i = 0; i < attempts.length; i++) {
      try {
        if (provider.kind === 'anthropic') {
          await streamAnthropic(request, provider.baseUrl, attempts[i]!, controller.signal, emit)
        } else {
          await streamOpenAICompatible(request, provider.baseUrl, attempts[i], controller.signal, emit)
        }
        lastError = undefined
        break
      } catch (error) {
        lastError = error
        if (controller.signal.aborted || i === attempts.length - 1 || !isAuthError(error)) throw error
        // else: this key failed auth — loop continues to the next one.
      }
    }
    if (!lastError) emit({ type: 'done', messageId: request.messageId })
  } catch (error) {
    if (controller.signal.aborted) {
      emit({ type: 'done', messageId: request.messageId })
    } else {
      emit({
        type: 'error',
        messageId: request.messageId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  } finally {
    activeStreams.delete(request.messageId)
  }
}


/* ------------------------------------------------------------- MCP tooling */

/**
 * How many tool round-trips before we stop, so a confused model can't loop
 * forever. Agentic coding needs far more headroom than plain chat with MCP
 * tools did — searching, reading, editing and then running tests is easily a
 * dozen rounds on its own — so this is user-tunable rather than a constant.
 */
function maxToolRounds(request: StreamRequest): number {
  if (!request.cwd) return 8
  const configured = store.getSettings().codeIndex.maxToolRounds
  return Number.isFinite(configured) && configured > 0 ? Math.min(configured, 200) : 40
}

/**
 * Tools offered to the model this turn. Smart routing narrows a large tool list
 * down to the servers whose tools look relevant to the conversation, so we don't
 * spend context listing dozens of unrelated schemas.
 */
function selectTools(request: StreamRequest): McpTool[] {
  // Eaon Work's own coding tools are never routed away: they are the agent's
  // hands, and the keyword scoring below would happily drop `codebase_search`
  // just because the user's phrasing didn't happen to overlap its description.
  // Web search is pinned alongside them for the same reason: the model reaches
  // for it precisely when the conversation's vocabulary does *not* already
  // contain the answer, so keyword scoring is the wrong judge of its relevance.
  const pinned = [...localToolsFor(request.cwd), ...webSearchTools()]
  const all = [...getTools(), ...pinned]
  if (all.length === 0) return []

  const { smartRouting } = store.getSettings().mcp
  if (!smartRouting || all.length <= 10) return all

  const routable = getTools()
  if (routable.length === 0) return all

  // Score each tool against the conversation's own words. This is a cheap
  // relevance pass — no extra model call, so it can't add latency or cost.
  const haystack = `${request.system} ${request.messages.map((m) => m.content).join(' ')}`.toLowerCase()
  const words = new Set(haystack.split(/[^a-z0-9]+/).filter((w) => w.length > 3))

  const scored = routable.map((tool) => {
    const text = `${tool.name} ${tool.description}`.toLowerCase()
    let score = 0
    for (const word of words) if (text.includes(word)) score += 1
    return { tool, score }
  })

  const relevant = scored.filter((entry) => entry.score > 0)
  // If nothing matched, the query may just use different vocabulary — fall back
  // to the full list rather than silently giving the model no tools at all.
  if (relevant.length === 0) return all
  return [
    ...relevant
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .map((entry) => entry.tool),
    ...pinned
  ]
}

/**
 * The argument worth showing under a tool call in the thinking trace — the
 * query it searched for, the file it touched, the command it ran. Without this
 * the UI shows a bare list of tool names, which tells the user nothing about
 * what the agent is actually doing.
 */
function toolTrace(name: string, args: Record<string, unknown>): string {
  const detail = isLocalTool(name)
    ? describeToolCall(name, args)
    : String(args.query ?? args.path ?? args.pattern ?? '')
  const summary = detail === name ? String(args.query ?? args.pattern ?? args.path ?? '') : detail
  return summary ? `${summary.split('\n')[0].slice(0, 160)}\n` : ''
}

/**
 * Read-only tools (search, grep, read, list) never prompt — an agent that has
 * to ask before *looking* at anything is unusable. Only tools that change the
 * working tree or run code prompt, and only while the composer is set to "Ask
 * for approval" (settings.approvalMode).
 */
async function runTool(
  request: StreamRequest,
  name: string,
  args: Record<string, unknown>,
  emit: (event: StreamEvent) => void
): Promise<string> {
  try {
    if (isWebSearchTool(name)) return await runWebSearch(args)
    if (isLocalTool(name)) {
      if (!request.cwd) throw new Error('No project folder is set for Eaon Work yet.')
      const needsApproval = isMutatingTool(name) && store.getSettings().approvalMode === 'ask'
      if (needsApproval) {
        const approved = await requestApproval(request.messageId, name, args, emit)
        if (!approved) return 'The user denied this action. Do not repeat it; ask how they would like to proceed instead.'
      }
      return await runLocalTool(name, args, request.cwd)
    }
    const timeout = store.getSettings().mcp.toolCallTimeoutSeconds * 1000
    return await callMcpTool(name, args, timeout)
  } catch (error) {
    // Feed the failure back to the model as a result rather than aborting the
    // turn; models routinely recover by trying different arguments.
    return `Tool error: ${error instanceof Error ? error.message : String(error)}`
  }
}

async function streamAnthropic(
  request: StreamRequest,
  baseURL: string,
  apiKey: string,
  signal: AbortSignal,
  emit: (event: StreamEvent) => void
): Promise<void> {
  const client = new Anthropic({ apiKey, baseURL })
  const tools = selectTools(request)

  const messages: Anthropic.MessageParam[] = request.messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))

  const rounds = maxToolRounds(request)
  for (let round = 0; round < rounds; round++) {
    const stream = client.messages.stream(
      {
        model: request.modelId,
        max_tokens: 64000,
        ...(request.system ? { system: request.system } : {}),
        // Adaptive thinking with a visible summary so the UI can show reasoning.
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort: EFFORT_TO_ANTHROPIC[request.effort] },
        ...(tools.length > 0
          ? {
              tools: tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.inputSchema as Anthropic.Tool['input_schema']
              }))
            }
          : {}),
        messages
      },
      { signal }
    )

    stream.on('text', (text) => emit({ type: 'delta', messageId: request.messageId, text }))
    stream.on('thinking', (delta) => emit({ type: 'reasoning', messageId: request.messageId, text: delta }))

    const final = await stream.finalMessage()
    if (final.stop_reason === 'refusal') {
      const detail = final.stop_details as { explanation?: string } | null
      throw new Error(detail?.explanation ?? 'The model declined this request.')
    }
    if (final.stop_reason !== 'tool_use') return

    const calls = final.content.filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
    if (calls.length === 0) return

    // Echo the assistant turn back verbatim, then answer every tool_use block in
    // a single user message — splitting them teaches the model to stop batching.
    messages.push({ role: 'assistant', content: final.content })
    const results: Anthropic.ToolResultBlockParam[] = []
    for (const call of calls) {
      const input = (call.input ?? {}) as Record<string, unknown>
      emit({ type: 'reasoning', messageId: request.messageId, text: `\n↳ ${call.name}\n${toolTrace(call.name, input)}` })
      const output = await runTool(request, call.name, input, emit)
      results.push({ type: 'tool_result', tool_use_id: call.id, content: output })
    }
    messages.push({ role: 'user', content: results })
  }
}

async function streamOpenAICompatible(
  request: StreamRequest,
  baseUrl: string,
  apiKey: string | undefined,
  signal: AbortSignal,
  emit: (event: StreamEvent) => void
): Promise<void> {
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`
  const tools = selectTools(request)

  interface ChatMessage {
    role: string
    content: string | null
    tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
    tool_call_id?: string
  }

  const messages: ChatMessage[] = [
    ...(request.system ? [{ role: 'system', content: request.system }] : []),
    ...request.messages.map((m) => ({ role: m.role, content: m.content }))
  ]

  const rounds = maxToolRounds(request)
  for (let round = 0; round < rounds; round++) {
    const send = async (withEffort: boolean): Promise<Response> => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`
      return fetch(url, {
        method: 'POST',
        headers,
        signal,
        body: JSON.stringify({
          model: request.modelId,
          messages,
          stream: true,
          ...(tools.length > 0
            ? {
                tools: tools.map((tool) => ({
                  type: 'function',
                  function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.inputSchema
                  }
                }))
              }
            : {}),
          ...(withEffort ? { reasoning_effort: EFFORT_TO_OPENAI[request.effort] } : {})
        })
      })
    }

    // Not every OpenAI-compatible model accepts reasoning_effort; drop it and retry
    // rather than failing the turn.
    let response = await send(true)
    if (!response.ok) {
      const text = await response.text()
      if (response.status === 400 && /reasoning_effort|unsupported|unrecognized/i.test(text)) {
        response = await send(false)
        if (!response.ok) throw new Error(await describeHttpError(response))
      } else {
        throw new Error(describeErrorBody(response.status, text))
      }
    }
    if (!response.body) throw new Error('The provider returned an empty response body.')

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let assistantText = ''
    let finishReason: string | null = null
    // tool_calls arrive as deltas keyed by index; assemble them as we go.
    const pending = new Map<number, { id: string; name: string; args: string }>()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let boundary = buffer.indexOf('\n')
      while (boundary !== -1) {
        const line = buffer.slice(0, boundary).trim()
        buffer = buffer.slice(boundary + 1)
        boundary = buffer.indexOf('\n')
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        try {
          const chunk = JSON.parse(payload) as {
            choices?: {
              delta?: {
                content?: string
                reasoning?: string
                reasoning_content?: string
                tool_calls?: {
                  index: number
                  id?: string
                  function?: { name?: string; arguments?: string }
                }[]
              }
              finish_reason?: string | null
            }[]
            error?: { message?: string }
          }
          if (chunk.error?.message) throw new Error(chunk.error.message)
          const choice = chunk.choices?.[0]
          const delta = choice?.delta
          if (choice?.finish_reason) finishReason = choice.finish_reason

          const reasoning = delta?.reasoning ?? delta?.reasoning_content
          if (reasoning) emit({ type: 'reasoning', messageId: request.messageId, text: reasoning })
          if (delta?.content) {
            assistantText += delta.content
            emit({ type: 'delta', messageId: request.messageId, text: delta.content })
          }
          for (const call of delta?.tool_calls ?? []) {
            const existing = pending.get(call.index) ?? { id: '', name: '', args: '' }
            pending.set(call.index, {
              id: call.id ?? existing.id,
              name: call.function?.name ?? existing.name,
              args: existing.args + (call.function?.arguments ?? '')
            })
          }
        } catch (error) {
          if (error instanceof SyntaxError) continue
          throw error
        }
      }
    }

    if (finishReason !== 'tool_calls' || pending.size === 0) return

    const calls = [...pending.entries()].sort(([a], [b]) => a - b).map(([, call]) => call)
    messages.push({
      role: 'assistant',
      content: assistantText || null,
      tool_calls: calls.map((call) => ({
        id: call.id,
        type: 'function' as const,
        function: { name: call.name, arguments: call.args || '{}' }
      }))
    })

    for (const call of calls) {
      let args: Record<string, unknown> = {}
      try {
        args = call.args ? (JSON.parse(call.args) as Record<string, unknown>) : {}
      } catch {
        // Malformed arguments are the model's mistake — report them back so it
        // can correct itself instead of failing the whole turn.
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: `Tool error: arguments were not valid JSON: ${call.args}`
        })
        continue
      }
      emit({ type: 'reasoning', messageId: request.messageId, text: `\n↳ ${call.name}\n${toolTrace(call.name, args)}` })
      const output = await runTool(request, call.name, args, emit)
      messages.push({ role: 'tool', tool_call_id: call.id, content: output })
    }
  }
}

async function describeHttpError(response: Response): Promise<string> {
  return describeErrorBody(response.status, await response.text())
}

function describeErrorBody(status: number, text: string): string {
  try {
    const body = JSON.parse(text) as { error?: { message?: string } | string }
    const message = typeof body.error === 'string' ? body.error : body.error?.message
    if (message) return `${status}: ${message}`
  } catch {
    /* fall through to the raw body */
  }
  return `${status}: ${text.slice(0, 300) || 'Request failed'}`
}
