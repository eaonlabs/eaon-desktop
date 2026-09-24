import { createHash } from 'node:crypto'
import { authHeaders, chatCompat, clampEffort, effortsFor, requestBase, wireEffort, type ChatCompat } from '../compat'
import { contextWindowFor, maxOutputFor } from '../models'
import { ThinkTagSplitter } from './thinkTags'
import {
  clampOutputToWindow,
  describeErrorBody,
  emptyUsage,
  ProviderHttpError,
  retryAfterFrom,
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
 * "OpenAI-compatible" covers a lot of small disagreements. The per-provider
 * ones (how thinking is switched on, which field caps output, how the key is
 * sent) live in `compat.ts`; the ones handled here are about the stream:
 *
 * - Tool calls arrive with `finish_reason: "stop"` (Ollama, several gateways)
 *   or no finish reason at all — calls are detected by their presence, not by
 *   the finish reason.
 * - Tool-call deltas without an `index` (some Gemini and vLLM builds), or with
 *   the whole call in one chunk, or with an empty id.
 * - Reasoning arrives as `reasoning_content` (DeepSeek, Kimi, llama.cpp),
 *   `reasoning` (Ollama, Groq, OpenRouter), `reasoning_text`, or inline in the
 *   content as `<think>…</think>` (anything served without a reasoning parser).
 * - DeepSeek-style APIs need the reasoning sent back on assistant messages;
 *   OpenRouter needs its `reasoning_details` sent back so Gemini's thought
 *   signatures and encrypted OpenAI reasoning survive a tool call.
 * - Mistral requires tool-call ids of exactly nine alphanumerics and rejects
 *   ids minted by anyone else, which breaks a chat that switched models.
 * - Gemini's endpoint rejects JSON-schema keywords outside its subset, which
 *   MCP servers use freely.
 * - A field an endpoint rejects (effort, usage streaming, tools on a model
 *   whose template cannot do them) is dropped and the request retried once,
 *   rather than failing the turn.
 */

type ReasoningField = 'reasoning_content' | 'reasoning' | 'reasoning_text'

interface WireToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
  /** Gemini's thought signature for this call; Gemini 3 rejects a replayed call without one. */
  extra_content?: { google: { thought_signature: string } }
}

interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null | { type: string; text?: string; image_url?: { url: string } }[]
  tool_calls?: WireToolCall[]
  tool_call_id?: string
  reasoning_content?: string
  reasoning?: string
  reasoning_text?: string
  reasoning_details?: ReasoningDetail[]
}

/** One entry of OpenRouter's structured reasoning, replayed verbatim within a turn. */
interface ReasoningDetail {
  type: string
  text?: string
  summary?: string
  data?: string
  signature?: string | null
  id?: string | null
  format?: string
  index?: number
}

/** What a turn hands back for replay within the same turn. */
interface ChatReplay {
  field: ReasoningField | null
  reasoning: string
  details?: ReasoningDetail[]
  /** Gemini thought signatures by tool-call id. */
  signatures?: Record<string, string>
}

/**
 * Gemini's documented placeholder for a function call that has no signature
 * of its own — one from an earlier turn, or made by a different model. Gemini
 * 3 validates signatures on replayed calls and rejects the request without one.
 */
const SKIP_SIGNATURE = 'skip_thought_signature_validator'

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

function toWire(request: TurnRequest, compat: ChatCompat = chatCompat(request.provider, request.provider.baseUrl, request.modelId)): WireMessage[] {
  const mapId = (id: string): string => (compat.vendor === 'mistral' ? mistralId(id) : id)
  const reasons = request.model?.reasoning ?? false
  const gemini3 = compat.vendor === 'gemini' && /gemini-[3-9]/.test(request.modelId)
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
      // Reasoning goes back only to the adapter and model that produced it,
      // and only within the turn (replay is never persisted).
      const replay =
        message.replay?.adapter === 'openai-chat' && message.replay.modelId === request.modelId
          ? (message.replay.data as ChatReplay)
          : undefined
      const wire: WireMessage = { role: 'assistant', content: message.text || null }
      if (message.calls.length > 0) {
        wire.tool_calls = message.calls.map((call) => {
          const signature = replay?.signatures?.[call.id] ?? (gemini3 ? SKIP_SIGNATURE : undefined)
          return {
            id: mapId(call.id),
            type: 'function' as const,
            function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) },
            ...(compat.vendor === 'gemini' && signature ? { extra_content: { google: { thought_signature: signature } } } : {})
          }
        })
      }
      if (replay?.details?.length) wire.reasoning_details = replay.details
      else if (replay?.field && replay.reasoning) wire[replay.field] = replay.reasoning
      if (compat.reasoningOnEveryAssistant && reasons && wire.reasoning_content === undefined) {
        wire.reasoning_content = replay?.reasoning ?? ''
      }
      if (!wire.content && !wire.tool_calls) continue
      out.push(wire)
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

/**
 * OpenRouter streams `reasoning_details` as deltas: consecutive text or
 * summary pieces belong to one logical entry, encrypted entries are opaque
 * and stay separate.
 */
function appendDetail(details: ReasoningDetail[], detail: ReasoningDetail): void {
  const last = details[details.length - 1]
  if (last && detail.type === last.type && (detail.type === 'reasoning.text' || detail.type === 'reasoning.summary')) {
    if (detail.type === 'reasoning.text') last.text = (last.text ?? '') + (detail.text ?? '')
    else last.summary = (last.summary ?? '') + (detail.summary ?? '')
    last.signature ||= detail.signature
    last.id ??= detail.id
    last.format ||= detail.format
    last.index ??= detail.index
    return
  }
  details.push({ ...detail })
}

interface StreamChunk {
  choices?: {
    index?: number
    delta?: {
      content?: string | { type?: string; text?: string }[] | null
      reasoning?: string | null
      reasoning_content?: string | null
      reasoning_text?: string | null
      thinking?: string | null
      reasoning_details?: ReasoningDetail[]
      tool_calls?: {
        index?: number
        id?: string
        type?: string
        function?: { name?: string; arguments?: string | Record<string, unknown> }
        extra_content?: { google?: { thought_signature?: string } }
      }[]
    }
    finish_reason?: string | null
    usage?: Usage | null
  }[]
  usage?: Usage | null
  error?: { message?: string; code?: string | number; metadata?: { raw?: string; provider_name?: string } }
}

interface Usage {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number }
  // DeepSeek reports its cache this way; Kimi puts cached_tokens at the top level.
  prompt_cache_hit_tokens?: number
  cached_tokens?: number
}

/** Rough token count of a request body, for fitting the output cap into the window. */
const estimateTokens = (value: unknown): number => Math.ceil(JSON.stringify(value).length / 3.6)

export const openaiChatAdapter: Adapter = {
  id: 'openai-chat',
  managesContext: false,

  async turn(request: TurnRequest): Promise<TurnResult> {
    const { provider, credentials, model } = request
    const base = requestBase(provider, credentials.baseUrl)
    const url = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`
    const compat = chatCompat(provider, base, request.modelId)

    const gemini = compat.vendor === 'gemini'
    const reasons = model?.reasoning ?? false
    const level = clampEffort(request.effort, effortsFor(request.modelId, model))
    const effort = compat.sendsEffort && level ? wireEffort(level, compat.vendor, request.modelId) : undefined
    const messages = toWire(request, compat)
    const window = contextWindowFor(provider, request.modelId, model)
    const maxOutput = clampOutputToWindow(maxOutputFor(provider, request.modelId, model), window, estimateTokens(messages))

    // Models the catalog marks as tool-less (Perplexity's Sonar) are not offered tools at all.
    let tools =
      model?.tools === false
        ? []
        : request.tools.map((tool) => ({
            type: 'function' as const,
            function: {
              name: tool.name,
              description: tool.description,
              parameters: gemini ? sanitizeForGemini(tool.inputSchema) : tool.inputSchema
            }
          }))

    let includeUsage = true
    let sendEffort = Boolean(effort)
    let sendThinking = reasons
    let sendCap = Boolean(maxOutput)

    const thinkingFields = (): Record<string, unknown> => {
      const out: Record<string, unknown> = {}
      if (sendThinking) {
        if (compat.thinking === 'deepseek') out.thinking = { type: 'enabled' }
        else if (compat.thinking === 'zai') out.thinking = { type: 'enabled', clear_thinking: false }
        else if (compat.thinking === 'qwen') out.enable_thinking = true
        else if (compat.thinking === 'together') out.reasoning = { enabled: true }
      }
      if (sendEffort && effort) {
        if (compat.thinking === 'openrouter') out.reasoning = { effort }
        else out.reasoning_effort = effort
      }
      if (compat.parsedReasoning) out.reasoning_format = 'parsed'
      return out
    }

    const body = (): Record<string, unknown> => ({
      model: request.modelId,
      messages,
      stream: true,
      ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
      ...(tools.length > 0 ? { tools, ...(compat.toolStream ? { tool_stream: true } : {}) } : {}),
      ...thinkingFields(),
      ...(sendCap && maxOutput ? { [compat.maxTokensField]: maxOutput } : {}),
      // Routes every request of one conversation to the same cache shard.
      ...(compat.promptCacheKey ? { prompt_cache_key: request.cacheKey.slice(0, 64) } : {})
    })

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...authHeaders(compat.auth, credentials.apiKey),
      ...(compat.sessionHeader ? { [compat.sessionHeader]: request.cacheKey } : {}),
      ...provider.headers,
      ...credentials.headers
    }

    // Each rejection below is a capability the endpoint lacks, not a failure of
    // the turn: drop the offending field and ask again, at most once per field.
    let response: Response | null = null
    for (let attempt = 0; attempt < 6; attempt++) {
      response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body()), signal: request.signal })
      if (response.ok) break
      const text = await response.text()
      const lower = text.toLowerCase()
      if (response.status >= 400 && response.status < 500 && response.status !== 401 && response.status !== 403 && response.status !== 429) {
        if (sendEffort && /reasoning|effort/.test(lower)) {
          sendEffort = false
          continue
        }
        if (sendThinking && compat.thinking !== 'openai' && /thinking|enable_thinking|reasoning/.test(lower)) {
          sendThinking = false
          continue
        }
        if (includeUsage && /stream_options|include_usage/.test(lower)) {
          includeUsage = false
          continue
        }
        if (sendCap && /max_tokens|max_completion_tokens|maximum context|context length/.test(lower)) {
          sendCap = false
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
      throw new ProviderHttpError(response.status, describeErrorBody(response.status, text), retryAfterFrom(response.headers))
    }
    if (!response?.ok) throw new Error('The provider rejected the request.')
    if (!response.body) throw new Error('The provider returned an empty response body.')

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const splitter = new ThinkTagSplitter()
    let buffer = ''
    let text = ''
    let reasoning = ''
    let reasoningField: ReasoningField | null = null
    const details: ReasoningDetail[] = []
    let finishReason: string | null = null
    const usage = emptyUsage()
    // Keyed by index when the provider sends one, else by id, else by arrival order.
    const pending = new Map<string, { id: string; name: string; args: string; order: number; signature?: string }>()
    let order = 0
    let lastKey: string | null = null

    const emitText = (piece: { text: string; reasoning: string }): void => {
      if (piece.reasoning) {
        reasoning += piece.reasoning
        request.onReasoning(piece.reasoning)
      }
      if (piece.text) {
        text += piece.text
        request.onText(piece.text)
      }
    }

    const readUsage = (raw: Usage): void => {
      const cached = raw.prompt_tokens_details?.cached_tokens ?? raw.prompt_cache_hit_tokens ?? raw.cached_tokens ?? 0
      const written = raw.prompt_tokens_details?.cache_write_tokens ?? 0
      usage.input = Math.max(0, (raw.prompt_tokens ?? 0) - cached - written)
      usage.cacheRead = cached
      usage.cacheWrite = written
      usage.output = raw.completion_tokens ?? 0
    }

    const handleChunk = (chunk: StreamChunk): void => {
      if (chunk.error) {
        // OpenRouter reports upstream failures mid-stream, with the upstream's
        // own words in metadata.raw.
        const raw = chunk.error.metadata?.raw
        const message = chunk.error.message ?? `Provider error ${chunk.error.code ?? ''}`.trim()
        throw new Error(raw && !message.includes(raw) ? `${message} — ${raw.slice(0, 300)}` : message)
      }
      if (chunk.usage) readUsage(chunk.usage)
      const choice = chunk.choices?.[0]
      if (!choice) return
      // Moonshot puts the final usage on the choice instead.
      if (!chunk.usage && choice.usage) readUsage(choice.usage)
      if (choice.finish_reason) finishReason = choice.finish_reason
      const delta = choice.delta
      if (!delta) return

      // Some hosts send the same reasoning under two names; take the first.
      for (const field of ['reasoning_content', 'reasoning', 'reasoning_text'] as const) {
        const value = delta[field]
        if (typeof value === 'string' && value.length > 0) {
          reasoningField ??= field
          reasoning += value
          request.onReasoning(value)
          break
        }
      }
      if (typeof delta.thinking === 'string' && delta.thinking && !reasoningField) {
        reasoning += delta.thinking
        request.onReasoning(delta.thinking)
      }
      for (const detail of delta.reasoning_details ?? []) {
        if (detail && typeof detail.type === 'string') appendDetail(details, detail)
      }

      const content =
        typeof delta.content === 'string'
          ? delta.content
          : Array.isArray(delta.content)
            ? delta.content.map((part) => part.text ?? '').join('')
            : ''
      if (content) emitText(splitter.push(content))

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
          order: existing.order,
          signature: call.extra_content?.google?.thought_signature ?? existing.signature
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
    emitText(splitter.flush())

    if (finishReason === 'network_error' || finishReason === 'error') {
      throw new Error(`The provider stopped mid-reply (${finishReason}). Try again.`)
    }

    const calls: NeutralToolCall[] = []
    const signatures: Record<string, string> = {}
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
      const id = call.id || `call_${createHash('sha1').update(`${call.name}${call.order}${call.args}`).digest('hex').slice(0, 20)}`
      if (call.signature) signatures[id] = call.signature
      calls.push({ id, name: call.name, input })
    }

    const hasSignatures = Object.keys(signatures).length > 0
    const replay: ChatReplay | undefined =
      reasoning || details.length > 0 || hasSignatures
        ? { field: reasoningField, reasoning, ...(details.length ? { details } : {}), ...(hasSignatures ? { signatures } : {}) }
        : undefined

    return {
      text,
      calls,
      stop: finishReason === 'length' ? 'max_tokens' : calls.length > 0 ? 'tool_use' : finishReason === 'content_filter' ? 'refusal' : 'end',
      usage,
      ...(finishReason === 'content_filter' ? { refusal: 'The provider filtered this response.' } : {}),
      ...(replay ? { replay: { adapter: 'openai-chat', modelId: request.modelId, data: replay } } : {})
    }
  }
}

/** Exposed for the adapter tests. */
export const __test = { toWire, sanitizeForGemini, mistralId }
export type { NeutralMessage }
