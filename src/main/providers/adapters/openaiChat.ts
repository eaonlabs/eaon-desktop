import { createHash } from 'node:crypto'
import type { EffortLevel } from '@shared/types'
import { inferEfforts, maxOutputFor } from '../models'
import {
  describeErrorBody,
  emptyUsage,
  parseRetryAfter,
  ProviderHttpError,
  type Adapter,
  type NeutralMessage,
  type NeutralToolCall,
  type TurnRequest,
  type TurnResult
} from './types'

/**
 * OpenAI chat-completions, the lingua franca: OpenAI itself, every gateway
 * (OpenRouter, Vercel, Cloudflare), most inference hosts and every local
 * runtime.
 *
 * "OpenAI-compatible" covers a lot of small disagreements, and each one below
 * was a real way a provider broke the agent loop:
 *
 * - Tool calls arrive with `finish_reason: "stop"` (Ollama, several gateways)
 *   or no finish reason at all — calls are detected by their presence, not by
 *   the finish reason.
 * - Tool-call deltas without an `index` (some Gemini and vLLM builds), or with
 *   the whole call in one chunk, or with an empty id.
 * - Mistral requires tool-call ids of exactly nine alphanumerics and rejects
 *   ids minted by anyone else, which breaks a chat that switched models.
 * - Gemini's endpoint rejects JSON-schema keywords outside its subset, which
 *   MCP servers use freely.
 * - Local models whose template cannot do tools answer "does not support
 *   tools" — the turn is retried without them rather than failed.
 * - `reasoning_effort` is sent only to models that take it; the old
 *   send-then-retry-on-400 cost an extra failed request per round elsewhere.
 */

const EFFORT_TO_OPENAI: Record<EffortLevel, string> = {
  light: 'low',
  medium: 'medium',
  high: 'high',
  'extra-high': 'high',
  ultra: 'high'
}

interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null | { type: string; text?: string; image_url?: { url: string } }[]
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

/** Mistral accepts only `[a-zA-Z0-9]{9}` tool-call ids; map any id onto one deterministically. */
function mistralId(id: string): string {
  if (/^[a-zA-Z0-9]{9}$/.test(id)) return id
  return createHash('sha256').update(id).digest('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 9).padEnd(9, '0')
}

const GEMINI_UNSUPPORTED = new Set([
  '$schema',
  '$id',
  '$ref',
  '$defs',
  'definitions',
  'additionalProperties',
  'patternProperties',
  'unevaluatedProperties',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'const',
  'examples',
  'default',
  'if',
  'then',
  'else',
  'not',
  'dependentRequired',
  'dependentSchemas',
  'contentEncoding',
  'contentMediaType',
  'readOnly',
  'writeOnly',
  'deprecated'
])

/**
 * Strips the JSON-schema keywords Gemini's OpenAI endpoint refuses, and
 * collapses type arrays (`["string","null"]`) it cannot express to their first
 * non-null member.
 */
function sanitizeForGemini(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeForGemini)
  if (!schema || typeof schema !== 'object') return schema
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (GEMINI_UNSUPPORTED.has(key)) continue
    if (key === 'type' && Array.isArray(value)) {
      out.type = value.find((t) => t !== 'null') ?? 'string'
      continue
    }
    if (key === 'format' && typeof value === 'string' && !['enum', 'date-time'].includes(value)) continue
    out[key] = sanitizeForGemini(value)
  }
  // An object schema with no properties is rejected outright.
  if (out.type === 'object' && (!out.properties || Object.keys(out.properties as object).length === 0)) {
    delete out.required
    out.properties = { _: { type: 'string', description: 'Unused' } }
  }
  return out
}

function isGemini(request: TurnRequest): boolean {
  const base = request.credentials.baseUrl ?? request.provider.baseUrl
  return request.provider.id === 'gemini' || /generativelanguage\.googleapis\.com/.test(base)
}

function toWire(request: TurnRequest): WireMessage[] {
  const mistral = request.provider.id === 'mistral' || /api\.mistral\.ai/.test(request.provider.baseUrl)
  const mapId = (id: string): string => (mistral ? mistralId(id) : id)
  const out: WireMessage[] = []
  if (request.system) out.push({ role: 'system', content: request.system })

  for (const message of request.messages) {
    if (message.role === 'user') {
      const images = message.images ?? []
      out.push({
        role: 'user',
        content:
          images.length === 0
            ? message.text
            : [
                ...images.map((image) => ({
                  type: 'image_url',
                  image_url: { url: `data:${image.mime};base64,${image.data}` }
                })),
                { type: 'text', text: message.text || 'See the attached image.' }
              ]
      })
      continue
    }
    if (message.role === 'assistant') {
      if (message.calls.length === 0) {
        if (message.text) out.push({ role: 'assistant', content: message.text })
        continue
      }
      out.push({
        role: 'assistant',
        content: message.text || null,
        tool_calls: message.calls.map((call) => ({
          id: mapId(call.id),
          type: 'function' as const,
          function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) }
        }))
      })
      continue
    }
    // Chat-completions tool messages are text-only, so any screenshot a tool
    // returned follows as a user message the model reads as that tool's output.
    const images: { mime: string; data: string }[] = []
    for (const result of message.results) {
      out.push({ role: 'tool', tool_call_id: mapId(result.id), content: result.output || '(no output)' })
      images.push(...(result.images ?? []))
    }
    if (images.length > 0) {
      out.push({
        role: 'user',
        content: [
          { type: 'text', text: 'Image returned by the tool call above:' },
          ...images.map((image) => ({ type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.data}` } }))
        ]
      })
    }
  }
  return out
}

interface StreamChunk {
  choices?: {
    index?: number
    delta?: {
      content?: string | { type?: string; text?: string }[] | null
      reasoning?: string | null
      reasoning_content?: string | null
      thinking?: string | null
      tool_calls?: {
        index?: number
        id?: string
        type?: string
        function?: { name?: string; arguments?: string | Record<string, unknown> }
      }[]
    }
    finish_reason?: string | null
  }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number }
    // DeepSeek reports its cache this way.
    prompt_cache_hit_tokens?: number
    prompt_cache_miss_tokens?: number
  } | null
  error?: { message?: string; code?: string | number }
}

export const openaiChatAdapter: Adapter = {
  id: 'openai-chat',
  managesContext: false,

  async turn(request: TurnRequest): Promise<TurnResult> {
    const { provider, credentials } = request
    const base = (credentials.baseUrl ?? provider.baseUrl).replace(/\/$/, '')
    if (!base) throw new Error(`No base URL is set for ${provider.name}. Add one in Settings → Model providers.`)
    const url = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`

    const gemini = isGemini(request)
    const openaiNative = provider.kind === 'openai' || /api\.openai\.com/.test(base)
    const openrouter = provider.id === 'openrouter' || /openrouter\.ai/.test(base)
    const efforts = request.model?.efforts ?? inferEfforts(request.modelId)
    const effort = efforts && efforts.length > 0 ? EFFORT_TO_OPENAI[request.effort] : undefined
    const maxOutput = maxOutputFor(provider, request.modelId, request.model)

    let tools = request.tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: gemini ? sanitizeForGemini(tool.inputSchema) : tool.inputSchema
      }
    }))

    let includeUsage = true
    let sendEffort = Boolean(effort)
    const messages = toWire(request)

    const body = (): Record<string, unknown> => ({
      model: request.modelId,
      messages,
      stream: true,
      ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
      ...(tools.length > 0 ? { tools } : {}),
      ...(sendEffort && effort
        ? openrouter
          ? { reasoning: { effort } }
          : { reasoning_effort: effort }
        : {}),
      ...(maxOutput ? (openaiNative ? { max_completion_tokens: maxOutput } : { max_tokens: maxOutput }) : {}),
      // Routes every request of one conversation to the same cache shard.
      ...(openaiNative ? { prompt_cache_key: request.cacheKey.slice(0, 64) } : {})
    })

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(credentials.apiKey ? { Authorization: `Bearer ${credentials.apiKey}` } : {}),
      ...provider.headers,
      ...credentials.headers
    }

    // Each rejection below is a capability the endpoint lacks, not a failure of
    // the turn: drop the offending field and ask again, at most once per field.
    let response: Response | null = null
    for (let attempt = 0; attempt < 4; attempt++) {
      response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body()), signal: request.signal })
      if (response.ok) break
      const text = await response.text()
      const lower = text.toLowerCase()
      if (response.status >= 400 && response.status < 500 && response.status !== 401 && response.status !== 403 && response.status !== 429) {
        if (sendEffort && /reasoning|effort/.test(lower)) {
          sendEffort = false
          continue
        }
        if (includeUsage && /stream_options|include_usage/.test(lower)) {
          includeUsage = false
          continue
        }
        if (tools.length > 0 && /(does not support|doesn't support|not support|unsupported).{0,40}tool|tool.{0,40}(not supported|unsupported)/.test(lower)) {
          tools = []
          request.onReasoning('\n(This model does not support tools here — answering without them.)\n')
          continue
        }
      }
      if (response.status === 404 && /model/.test(lower)) {
        throw new ProviderHttpError(404, `${describeErrorBody(404, text)} — check the model id, or refresh the model list in Settings → Model providers.`)
      }
      throw new ProviderHttpError(response.status, describeErrorBody(response.status, text), parseRetryAfter(response.headers.get('retry-after')))
    }
    if (!response?.ok) throw new Error('The provider rejected the request.')
    if (!response.body) throw new Error('The provider returned an empty response body.')

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let text = ''
    let finishReason: string | null = null
    const usage = emptyUsage()
    // Keyed by index when the provider sends one, else by id, else by arrival order.
    const pending = new Map<string, { id: string; name: string; args: string; order: number }>()
    let order = 0
    let lastKey: string | null = null

    const handleChunk = (chunk: StreamChunk): void => {
      if (chunk.error) throw new Error(chunk.error.message ?? `Provider error ${chunk.error.code ?? ''}`.trim())
      if (chunk.usage) {
        const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? chunk.usage.prompt_cache_hit_tokens ?? 0
        usage.input = Math.max(0, (chunk.usage.prompt_tokens ?? 0) - cached)
        usage.cacheRead = cached
        usage.cacheWrite = chunk.usage.prompt_tokens_details?.cache_write_tokens ?? 0
        usage.output = chunk.usage.completion_tokens ?? 0
      }
      const choice = chunk.choices?.[0]
      if (!choice) return
      if (choice.finish_reason) finishReason = choice.finish_reason
      const delta = choice.delta
      if (!delta) return

      const reasoning = delta.reasoning_content ?? delta.reasoning ?? delta.thinking
      if (reasoning) request.onReasoning(reasoning)

      const content =
        typeof delta.content === 'string'
          ? delta.content
          : Array.isArray(delta.content)
            ? delta.content.map((part) => part.text ?? '').join('')
            : ''
      if (content) {
        text += content
        request.onText(content)
      }

      for (const call of delta.tool_calls ?? []) {
        const key =
          call.index !== undefined
            ? `i${call.index}`
            : call.id
              ? `id:${call.id}`
              : // No index and no id: a continuation of the previous call.
                (lastKey ?? `n${order}`)
        const existing = pending.get(key) ?? { id: '', name: '', args: '', order: order++ }
        const args = call.function?.arguments
        pending.set(key, {
          id: call.id || existing.id,
          name: call.function?.name || existing.name,
          // A provider that sends arguments as an object sends them whole.
          args: typeof args === 'object' && args !== null ? JSON.stringify(args) : existing.args + (args ?? ''),
          order: existing.order
        })
        lastKey = key
      }
    }

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
        let chunk: StreamChunk
        try {
          chunk = JSON.parse(payload) as StreamChunk
        } catch {
          continue
        }
        handleChunk(chunk)
      }
    }

    const calls: NeutralToolCall[] = []
    for (const call of [...pending.values()].sort((a, b) => a.order - b.order)) {
      if (!call.name) continue
      let input: Record<string, unknown> = {}
      try {
        input = call.args.trim() ? (JSON.parse(call.args) as Record<string, unknown>) : {}
      } catch {
        // Reported back to the model as a tool error by the loop, so it can
        // re-issue the call instead of the whole turn failing.
        input = { __invalid_json: call.args }
      }
      calls.push({
        id: call.id || `call_${createHash('sha1').update(`${call.name}${call.order}${call.args}`).digest('hex').slice(0, 20)}`,
        name: call.name,
        input
      })
    }

    return {
      text,
      calls,
      stop: finishReason === 'length' ? 'max_tokens' : calls.length > 0 ? 'tool_use' : finishReason === 'content_filter' ? 'refusal' : 'end',
      usage,
      ...(finishReason === 'content_filter' ? { refusal: 'The provider filtered this response.' } : {})
    }
  }
}

/** Exposed for the adapter tests. */
export const __test = { toWire, sanitizeForGemini, mistralId }
export type { NeutralMessage }
