import { createHash } from 'node:crypto'
import { clampEffort, effortsFor } from '../compat'
import { contextWindowFor, isOllamaCloudModel } from '../models'
import { ThinkTagSplitter } from './thinkTags'
import { describeErrorBody, emptyUsage, ProviderHttpError, retryAfterFrom, type Adapter, type NeutralToolCall, type TurnRequest, type TurnResult } from './types'

/**
 * Ollama's native `/api/chat`.
 *
 * The reason this exists instead of Ollama's OpenAI-compatible endpoint:
 * `/v1/chat/completions` cannot set the context size, so every request runs
 * at the model's default `num_ctx` (4k–8k on most builds) and Ollama silently
 * drops the start of anything longer — the system prompt and tool definitions
 * first. An agent prompt is well past that before the user has said a word;
 * the model then answers without its instructions or tools and looks broken.
 * Here `options.num_ctx` is set on every request, to the same window
 * `contextWindowFor` plans compaction against.
 *
 * The stream is NDJSON. Thinking arrives in `message.thinking` when `think`
 * is on; tool calls arrive whole, arguments as an object.
 */

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  images?: string[]
  thinking?: string
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[]
  tool_name?: string
}

interface OllamaChunk {
  message?: {
    content?: string
    thinking?: string
    tool_calls?: { id?: string; function?: { name?: string; arguments?: Record<string, unknown> | string } }[]
  }
  done?: boolean
  done_reason?: string
  prompt_eval_count?: number
  eval_count?: number
  error?: string
}

/** `http://host:11434/v1` → `http://host:11434`: the native API sits at the root. */
export function ollamaHost(baseUrl: string): string {
  return (baseUrl || 'http://127.0.0.1:11434')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/v1$/, '')
    .replace(/\/api$/, '')
}

function toMessages(request: TurnRequest): OllamaMessage[] {
  const out: OllamaMessage[] = []
  if (request.system) out.push({ role: 'system', content: request.system })
  for (const message of request.messages) {
    if (message.role === 'user') {
      const images = (message.images ?? []).map((image) => image.data)
      out.push({ role: 'user', content: message.text, ...(images.length ? { images } : {}) })
      continue
    }
    if (message.role === 'assistant') {
      // Thinking goes back only within the turn it came from; gpt-oss in
      // particular expects its reasoning to survive between tool calls.
      const replay =
        message.replay?.adapter === 'ollama' && message.replay.modelId === request.modelId
          ? (message.replay.data as { thinking?: string })
          : undefined
      if (!message.text && message.calls.length === 0) continue
      out.push({
        role: 'assistant',
        content: message.text,
        ...(replay?.thinking ? { thinking: replay.thinking } : {}),
        ...(message.calls.length
          ? { tool_calls: message.calls.map((call) => ({ function: { name: call.name, arguments: call.input ?? {} } })) }
          : {})
      })
      continue
    }
    const images: string[] = []
    for (const result of message.results) {
      out.push({ role: 'tool', content: result.output || '(no output)', tool_name: result.name })
      images.push(...(result.images ?? []).map((image) => image.data))
    }
    if (images.length) out.push({ role: 'user', content: 'Image returned by the tool call above:', images })
  }
  return out
}

/**
 * Ollama's `think`: gpt-oss takes a level and ignores booleans; every other
 * thinking model takes true.
 */
function thinkValue(request: TurnRequest): boolean | string | undefined {
  if (!request.model?.reasoning) return undefined
  if (/gpt-oss/.test(request.modelId)) {
    const level = clampEffort(request.effort, effortsFor(request.modelId, request.model)) ?? 'medium'
    return level === 'light' ? 'low' : level === 'medium' ? 'medium' : 'high'
  }
  return true
}

export const ollamaAdapter: Adapter = {
  id: 'ollama',
  managesContext: false,

  async turn(request: TurnRequest): Promise<TurnResult> {
    const { provider, model } = request
    const host = ollamaHost(request.credentials.baseUrl ?? provider.baseUrl)
    const numCtx = contextWindowFor(provider, request.modelId, model)
    // Cloud models run on Ollama's servers at their full window; num_ctx is a local setting.
    const cloud = isOllamaCloudModel(request.modelId)

    let tools = request.tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.inputSchema }
    }))
    let think = thinkValue(request)
    const messages = toMessages(request)

    const body = (): Record<string, unknown> => ({
      model: request.modelId,
      messages,
      stream: true,
      ...(tools.length ? { tools } : {}),
      ...(think !== undefined ? { think } : {}),
      ...(cloud ? {} : { options: { num_ctx: numCtx } })
    })

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(request.credentials.apiKey ? { Authorization: `Bearer ${request.credentials.apiKey}` } : {}),
      ...provider.headers,
      ...request.credentials.headers
    }

    let response: Response | null = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await fetch(`${host}/api/chat`, { method: 'POST', headers, body: JSON.stringify(body()), signal: request.signal })
      } catch (error) {
        if (request.signal.aborted) throw error
        throw new Error(`Could not reach Ollama at ${host} — make sure it is installed and running.`)
      }
      if (response.ok) break
      const text = await response.text()
      const lower = text.toLowerCase()
      if (response.status === 400 || response.status === 500) {
        if (think !== undefined && /thinking/.test(lower)) {
          think = undefined
          continue
        }
        if (tools.length && /does not support tools|tools? (are|is) not supported/.test(lower)) {
          tools = []
          request.onReasoning('\n(This model does not support tools here — answering without them.)\n')
          continue
        }
      }
      if (response.status === 404) {
        throw new ProviderHttpError(404, `${describeErrorBody(404, text)} — pull it first with \`ollama pull ${request.modelId}\`, or refresh the model list.`)
      }
      throw new ProviderHttpError(response.status, describeErrorBody(response.status, text), retryAfterFrom(response.headers))
    }
    if (!response?.ok) throw new Error('Ollama rejected the request.')
    if (!response.body) throw new Error('Ollama returned an empty response body.')

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    // Models without a thinking parser in their Ollama template still emit <think> inline.
    const splitter = new ThinkTagSplitter()
    let buffer = ''
    let text = ''
    let thinking = ''
    let doneReason: string | undefined
    const usage = emptyUsage()
    const calls: NeutralToolCall[] = []

    const emit = (piece: { text: string; reasoning: string }): void => {
      if (piece.reasoning) {
        thinking += piece.reasoning
        request.onReasoning(piece.reasoning)
      }
      if (piece.text) {
        text += piece.text
        request.onText(piece.text)
      }
    }

    const handle = (chunk: OllamaChunk): void => {
      if (chunk.error) throw new Error(chunk.error)
      const message = chunk.message
      if (message?.thinking) {
        thinking += message.thinking
        request.onReasoning(message.thinking)
      }
      if (message?.content) emit(splitter.push(message.content))
      for (const call of message?.tool_calls ?? []) {
        const name = call.function?.name
        if (!name) continue
        const raw = call.function?.arguments
        let input: Record<string, unknown>
        if (typeof raw === 'string') {
          try {
            input = JSON.parse(raw) as Record<string, unknown>
          } catch {
            input = { __invalid_json: raw }
          }
        } else input = raw ?? {}
        calls.push({
          id: call.id || `call_${createHash('sha1').update(`${name}${calls.length}${JSON.stringify(input)}`).digest('hex').slice(0, 20)}`,
          name,
          input
        })
      }
      if (chunk.done) {
        doneReason = chunk.done_reason
        usage.input = chunk.prompt_eval_count ?? 0
        usage.output = chunk.eval_count ?? 0
      }
    }

    while (true) {
      const { done, value } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (line) handle(JSON.parse(line) as OllamaChunk)
      }
      if (done) {
        if (buffer.trim()) handle(JSON.parse(buffer) as OllamaChunk)
        break
      }
    }
    emit(splitter.flush())

    return {
      text,
      calls,
      stop: doneReason === 'length' ? 'max_tokens' : calls.length > 0 ? 'tool_use' : 'end',
      usage,
      ...(thinking ? { replay: { adapter: 'ollama', modelId: request.modelId, data: { thinking } } } : {})
    }
  }
}

/** Exposed for the adapter tests. */
export const __test = { toMessages, thinkValue }
