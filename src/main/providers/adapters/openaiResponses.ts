import { arch, platform, release } from 'node:os'
import { clampEffort, effortsFor, requestBase, vendorOf, wireEffort } from '../compat'
import { contextWindowFor, maxOutputFor } from '../models'
import {
  capOutput,
  clampOutputToWindow,
  describeErrorBody,
  emptyUsage,
  estimateRequestTokens,
  ProviderHttpError,
  retryAfterFrom,
  toolInput,
  type Adapter,
  type NeutralToolCall,
  type TurnRequest,
  type TurnResult
} from './types'

/**
 * OpenAI's Responses API: OpenAI itself, xAI, GitHub Copilot's GPT-5 models,
 * and — with a different URL and headers — the ChatGPT Codex backend that
 * Plus/Pro subscriptions are served from.
 *
 * Requests are stateless (`store: false`). Reasoning models return their
 * chain of thought as encrypted reasoning items; those are replayed verbatim
 * between the rounds of one turn (through `replay`), which is what lets a
 * reasoning model keep its thinking across a tool call instead of starting
 * over after every result. Across turns only text and calls are sent.
 *
 * The Codex specifics mirror Eaon Code's `openai-codex-responses` provider:
 * the system prompt goes in `instructions`, the account id travels as
 * `chatgpt-account-id`, and the conversation key doubles as the session id.
 */

type Item = Record<string, unknown>

/** What one turn hands back for replay: its output items, reasoning included. */
interface ResponsesReplay {
  items: Item[]
}

const USER_AGENT = `pi (${platform()} ${release()}; ${arch()})`

/** Call ids must be short and plain; Anthropic's `toolu_…` and others are mapped onto that. */
const callId = (id: string): string => id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)

function isCodex(request: TurnRequest, base: string): boolean {
  return vendorOf(request.provider, base) === 'codex'
}

/** `…/backend-api` → `…/backend-api/codex/responses`, however much of the path was given. */
export function codexUrl(base: string): string {
  const trimmed = (base || 'https://chatgpt.com/backend-api').replace(/\/+$/, '')
  if (trimmed.endsWith('/codex/responses')) return trimmed
  if (trimmed.endsWith('/codex')) return `${trimmed}/responses`
  return `${trimmed}/codex/responses`
}

function toInput(request: TurnRequest, codex: boolean): { instructions?: string; input: Item[] } {
  const input: Item[] = []
  const reasons = request.model?.reasoning ?? false
  let instructions: string | undefined
  if (codex) instructions = request.system || 'You are a helpful assistant.'
  else if (request.system) input.push({ role: reasons ? 'developer' : 'system', content: request.system })

  for (const message of request.messages) {
    if (message.role === 'user') {
      const content: Item[] = (message.images ?? []).map((image) => ({
        type: 'input_image',
        detail: 'auto',
        image_url: `data:${image.mime};base64,${image.data}`
      }))
      content.push({ type: 'input_text', text: message.text || 'See the attached image.' })
      input.push({ role: 'user', content })
      continue
    }

    if (message.role === 'assistant') {
      // Same adapter and model, same turn: the items exactly as returned,
      // encrypted reasoning and item ids included.
      if (message.replay?.adapter === 'openai-responses' && message.replay.modelId === request.modelId) {
        input.push(...(message.replay.data as ResponsesReplay).items)
        continue
      }
      if (message.text) input.push({ role: 'assistant', content: message.text })
      for (const call of message.calls) {
        // No item id: an `fc_…` id without its paired reasoning item is rejected.
        input.push({ type: 'function_call', call_id: callId(call.id), name: call.name, arguments: JSON.stringify(call.input ?? {}) })
      }
      continue
    }

    const images: Item[] = []
    for (const result of message.results) {
      input.push({ type: 'function_call_output', call_id: callId(result.id), output: result.output || '(no output)' })
      for (const image of result.images ?? []) {
        images.push({ type: 'input_image', detail: 'auto', image_url: `data:${image.mime};base64,${image.data}` })
      }
    }
    // Screenshots follow as a user message the model reads as the tool's output.
    if (images.length > 0) {
      input.push({ role: 'user', content: [{ type: 'input_text', text: 'Image returned by the tool call above:' }, ...images] })
    }
  }
  return { instructions, input }
}

/** Codex answers a spent subscription with a 429 whose body says when it resets. */
function codexLimitMessage(status: number, text: string): string | undefined {
  try {
    const error = (JSON.parse(text) as { error?: { code?: string; type?: string; plan_type?: string; resets_at?: number } }).error
    const code = error?.code ?? error?.type ?? ''
    if (!/usage_limit_reached|usage_not_included|rate_limit_exceeded/i.test(code) && status !== 429) return undefined
    const plan = error?.plan_type ? ` (${error.plan_type.toLowerCase()} plan)` : ''
    const minutes = error?.resets_at ? Math.max(0, Math.round((error.resets_at * 1000 - Date.now()) / 60000)) : undefined
    return `You have hit your ChatGPT usage limit${plan}.${minutes !== undefined ? ` Try again in ~${minutes} min.` : ''}`
  } catch {
    return undefined
  }
}

interface Pending {
  type: string
  callId: string
  name: string
  args: string
}

export const openaiResponsesAdapter: Adapter = {
  id: 'openai-responses',
  managesContext: false,

  async turn(request: TurnRequest): Promise<TurnResult> {
    const { provider, credentials, model } = request
    const base = requestBase(provider, credentials.baseUrl)
    const codex = isCodex(request, base)
    // "Sign in with ChatGPT" (official): the plain Responses API, but with the
    // plan's rules — system prompt in `instructions` (system message items are
    // refused), and no output cap or sampling parameters.
    const plan = vendorOf(provider, base) === 'chatgpt-plan'
    const url = codex ? codexUrl(base) : /\/responses$/.test(base) ? base : `${base}/responses`
    const reasons = model?.reasoning ?? false
    const level = clampEffort(request.effort, effortsFor(request.modelId, model))
    const vendor = vendorOf(provider, base)
    const effort = level ? wireEffort(level, vendor, request.modelId) : undefined
    const { instructions, input } = toInput(request, codex || plan)
    const window = contextWindowFor(provider, request.modelId, model)
    // Codex rejects an output cap; everyone else gets one that fits the window.
    const maxOutput = codex || plan ? undefined : capOutput(request.outputCap, clampOutputToWindow(maxOutputFor(provider, request.modelId, model), window, estimateRequestTokens(input)))
    const cacheKey = request.cacheKey.slice(0, 64)

    const tools = request.tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      // Responses tools are strict by default, which MCP schemas rarely satisfy.
      strict: codex ? null : false
    }))

    let sendReasoning = reasons || Boolean(effort)
    let sendCacheKey = true
    let sendCap = Boolean(maxOutput)
    let sendVerbosity = codex

    const body = (): Record<string, unknown> => ({
      model: request.modelId,
      ...(instructions ? { instructions } : {}),
      input,
      stream: true,
      store: false,
      ...(tools.length > 0 ? { tools } : {}),
      ...(sendReasoning
        ? {
            reasoning: { ...(effort ? { effort } : {}), summary: 'auto' },
            include: ['reasoning.encrypted_content']
          }
        : {}),
      ...(sendCacheKey ? { prompt_cache_key: cacheKey } : {}),
      ...(sendCap && maxOutput ? { max_output_tokens: Math.max(16, maxOutput) } : {}),
      ...(codex ? { tool_choice: 'auto', parallel_tool_calls: true } : {}),
      ...(sendVerbosity ? { text: { verbosity: 'low' } } : {})
    })

    const headers: Record<string, string> = codex
      ? {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'OpenAI-Beta': 'responses=experimental',
          originator: 'pi',
          'User-Agent': USER_AGENT,
          'session-id': cacheKey,
          'x-client-request-id': cacheKey,
          ...provider.headers,
          ...credentials.headers,
          Authorization: `Bearer ${credentials.apiKey ?? ''}`,
          ...(credentials.extra?.accountId ? { 'chatgpt-account-id': credentials.extra.accountId } : {})
        }
      : {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          ...(credentials.apiKey ? { Authorization: `Bearer ${credentials.apiKey}` } : {}),
          ...provider.headers,
          ...credentials.headers
        }

    let response: Response | null = null
    for (let attempt = 0; attempt < 5; attempt++) {
      response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body()), signal: request.signal })
      if (response.ok) break
      const text = await response.text()
      const lower = text.toLowerCase()
      if (response.status === 400) {
        if (sendReasoning && /reasoning|effort|encrypted_content/.test(lower)) {
          sendReasoning = false
          continue
        }
        if (sendCacheKey && /prompt_cache_key/.test(lower)) {
          sendCacheKey = false
          continue
        }
        if (sendCap && /max_output_tokens/.test(lower)) {
          sendCap = false
          continue
        }
        if (sendVerbosity && /verbosity/.test(lower)) {
          sendVerbosity = false
          continue
        }
      }
      if (codex) {
        const limit = codexLimitMessage(response.status, text)
        // A spent subscription will not recover in seconds; a plain Error keeps
        // the loop from retrying it as if it were a transient 429.
        if (limit && response.status === 429 && !/rate_limit_exceeded/.test(lower)) throw new Error(limit)
      }
      throw new ProviderHttpError(response.status, describeErrorBody(response.status, text), retryAfterFrom(response.headers))
    }
    if (!response?.ok) throw new Error('The provider rejected the request.')
    if (!response.body) throw new Error('The provider returned an empty response body.')

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let text = ''
    let refusal = ''
    const usage = emptyUsage()
    const pending = new Map<number, Pending>()
    const done = new Map<number, Item>()
    let terminal: { status?: string; incomplete_details?: { reason?: string } | null; output?: Item[] } | null = null

    const handle = (event: Record<string, unknown>): void => {
      const type = typeof event.type === 'string' ? event.type : ''
      const index = typeof event.output_index === 'number' ? event.output_index : -1
      switch (type) {
        case 'response.output_item.added': {
          const item = event.item as Item
          if (item?.type === 'function_call') {
            pending.set(index, { type: 'function_call', callId: String(item.call_id ?? ''), name: String(item.name ?? ''), args: String(item.arguments ?? '') })
          }
          return
        }
        case 'response.output_text.delta': {
          const delta = String(event.delta ?? '')
          text += delta
          request.onText(delta)
          return
        }
        case 'response.refusal.delta':
          refusal += String(event.delta ?? '')
          return
        case 'response.reasoning_summary_text.delta':
        case 'response.reasoning_text.delta':
          request.onReasoning(String(event.delta ?? ''))
          return
        case 'response.reasoning_summary_part.done':
          request.onReasoning('\n\n')
          return
        case 'response.function_call_arguments.delta': {
          const call = pending.get(index)
          if (call) call.args += String(event.delta ?? '')
          return
        }
        case 'response.function_call_arguments.done': {
          const call = pending.get(index)
          if (call && typeof event.arguments === 'string') call.args = event.arguments
          return
        }
        case 'response.output_item.done': {
          const item = event.item as Item
          if (!item) return
          done.set(index, item)
          if (item.type === 'function_call') {
            const call = pending.get(index) ?? { type: 'function_call', callId: '', name: '', args: '' }
            pending.set(index, {
              type: 'function_call',
              callId: String(item.call_id ?? call.callId),
              name: String(item.name ?? call.name),
              args: typeof item.arguments === 'string' && item.arguments ? item.arguments : call.args
            })
          }
          return
        }
        case 'response.completed':
        case 'response.incomplete':
        case 'response.done':
          terminal = (event.response ?? {}) as typeof terminal
          return
        case 'response.failed': {
          const failed = event.response as { error?: { code?: string; message?: string }; incomplete_details?: { reason?: string } } | undefined
          const error = failed?.error
          throw new Error(error ? `${error.code ?? 'error'}: ${error.message ?? 'no message'}` : `The response failed${failed?.incomplete_details?.reason ? ` (${failed.incomplete_details.reason})` : ''}.`)
        }
        case 'error': {
          const nested = (event.error ?? {}) as { code?: string; message?: string }
          const code = (event.code as string | undefined) ?? nested.code
          const message = (event.message as string | undefined) ?? nested.message
          throw new Error(message ? `${message}${code ? ` (${code})` : ''}` : `Provider error ${code ?? ''}`.trim())
        }
      }
    }

    const flushFrame = (frame: string): void => {
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n')
        .trim()
      if (!data || data === '[DONE]') return
      let event: Record<string, unknown>
      try {
        event = JSON.parse(data) as Record<string, unknown>
      } catch {
        return
      }
      handle(event)
    }

    while (true) {
      const { done: finished, value } = await reader.read()
      buffer += finished ? decoder.decode() : decoder.decode(value, { stream: true })
      buffer = buffer.replace(/\r\n/g, '\n')
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        flushFrame(buffer.slice(0, boundary))
        buffer = buffer.slice(boundary + 2)
        boundary = buffer.indexOf('\n\n')
      }
      if (finished) {
        if (buffer.trim()) flushFrame(buffer)
        break
      }
    }

    const final = terminal as { status?: string; incomplete_details?: { reason?: string } | null; output?: Item[]; usage?: Record<string, unknown> } | null
    if (!final) throw new Error('The response stream ended before it finished. Try again.')

    const raw = (final.usage ?? {}) as { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } }
    const cached = raw.input_tokens_details?.cached_tokens ?? 0
    const written = raw.input_tokens_details?.cache_write_tokens ?? 0
    usage.input = Math.max(0, (raw.input_tokens ?? 0) - cached - written)
    usage.output = raw.output_tokens ?? 0
    usage.cacheRead = cached
    usage.cacheWrite = written

    // Azure can leave encrypted_content off `output_item.done` and send it only
    // in the final response; fill it in so the replay stays usable.
    const items = [...done.entries()].sort((a, b) => a[0] - b[0]).map(([, item]) => item)
    for (const item of items) {
      if (item.type !== 'reasoning' || item.encrypted_content) continue
      const full = (final.output ?? []).find((out) => out.type === 'reasoning' && out.id === item.id)
      if (full?.encrypted_content) item.encrypted_content = full.encrypted_content
    }

    const calls: NeutralToolCall[] = []
    for (const [, call] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
      if (!call.name) continue
      calls.push({ id: call.callId || `call_${calls.length}`, name: call.name, input: toolInput(call.args) })
    }

    const reason = final.incomplete_details?.reason
    if (final.status === 'incomplete' && reason && reason !== 'max_output_tokens' && reason !== 'content_filter') {
      throw new Error(`The response was cut short (${reason}).`)
    }
    const filtered = reason === 'content_filter' || (refusal && !text)
    return {
      text: text || (filtered ? '' : refusal),
      calls,
      stop:
        final.status === 'incomplete' && reason === 'max_output_tokens'
          ? 'max_tokens'
          : filtered && calls.length === 0
            ? 'refusal'
            : calls.length > 0
              ? 'tool_use'
              : 'end',
      usage,
      ...(filtered ? { refusal: refusal || 'The provider filtered this response.' } : {}),
      ...(items.length > 0 ? { replay: { adapter: 'openai-responses', modelId: request.modelId, data: { items } satisfies ResponsesReplay } } : {})
    }
  }
}

/** Exposed for the adapter tests. */
export const __test = { toInput, codexLimitMessage }
