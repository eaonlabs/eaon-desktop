import type { ServerResponse } from 'node:http'
import type { EffortLevel, TokenUsage } from '@shared/types'
import { estimateRequestTokens, type NeutralImage, type NeutralMessage, type NeutralToolResult, type ToolSpec, type TurnResult } from '../providers/adapters/types'
import type { GatewayScope } from '@shared/gateway'
import { gatewayModels, noModelMessage, resolveGatewayModel } from './models'
import { runGatewayTurn, statusFor } from './turn'
import { anthropicEffort, cap, clientToolId, errorMessage, newId, sendJson, sseEvent, startSse, tidy } from './wire'

/**
 * Anthropic Messages (`POST /v1/messages`, `/v1/messages/count_tokens`), with
 * tools and thinking: what Claude Code speaks. Claude Code appends
 * `?beta=true` and sends `anthropic-beta` flags, `cache_control` marks and
 * `metadata`; none of them matter to another provider and all are ignored.
 */

interface Parsed {
  model?: string
  system: string
  messages: NeutralMessage[]
  tools: ToolSpec[]
  effort?: EffortLevel
  outputCap?: number
  stream: boolean
  /** The app asked for thinking, so it can show thinking blocks. */
  thinking: boolean
}

type Block = Record<string, unknown> & { type?: string }

function blockImage(block: Block): NeutralImage | null {
  const source = block.source as { type?: unknown; media_type?: unknown; data?: unknown } | undefined
  return source?.type === 'base64' && typeof source.data === 'string' && typeof source.media_type === 'string'
    ? { mime: source.media_type, data: source.data }
    : null
}

/** A tool result's content: a string, or text and image blocks. */
function resultContent(content: unknown): { text: string; images: NeutralImage[] } {
  if (typeof content === 'string') return { text: content, images: [] }
  if (!Array.isArray(content)) return { text: '', images: [] }
  const texts: string[] = []
  const images: NeutralImage[] = []
  for (const block of content as Block[]) {
    if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text)
    else if (block?.type === 'image') {
      const image = blockImage(block)
      if (image) images.push(image)
    }
  }
  return { text: texts.join('\n'), images }
}

function systemText(system: unknown): string {
  if (typeof system === 'string') return system
  if (!Array.isArray(system)) return ''
  return (system as Block[])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n\n')
}

export function parseMessagesRequest(body: Record<string, unknown>): Parsed | { error: string } {
  const raw = body.messages
  if (!Array.isArray(raw) || raw.length === 0) return { error: 'messages: field required' }

  const messages: NeutralMessage[] = []
  const names = new Map<string, string>()
  for (const m of raw as Record<string, unknown>[]) {
    if (!m || typeof m !== 'object') continue
    const blocks: Block[] = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? (m.content as Block[]) : []
    if (m.role === 'assistant') {
      const text = blocks
        .filter((b) => b?.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text as string)
        .join('')
      // Thinking blocks are Anthropic's own record of a turn; another provider can't take them back.
      const calls = blocks
        .filter((b) => b?.type === 'tool_use' && typeof b.name === 'string')
        .map((b) => ({
          id: typeof b.id === 'string' ? b.id : newId('toolu_'),
          name: b.name as string,
          input: b.input && typeof b.input === 'object' && !Array.isArray(b.input) ? (b.input as Record<string, unknown>) : {}
        }))
      for (const call of calls) names.set(call.id, call.name)
      messages.push({ role: 'assistant', text, calls })
      continue
    }
    // A user turn: tool results first (they answer the turn before), then what the user wrote.
    const results: NeutralToolResult[] = []
    const texts: string[] = []
    const images: NeutralImage[] = []
    for (const block of blocks) {
      if (block?.type === 'tool_result') {
        const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : ''
        const content = resultContent(block.content)
        results.push({
          id,
          name: names.get(id) ?? '',
          output: content.text,
          ...(content.images.length ? { images: content.images } : {}),
          ...(block.is_error === true ? { isError: true } : {})
        })
      } else if (block?.type === 'text' && typeof block.text === 'string') {
        texts.push(block.text)
      } else if (block?.type === 'image') {
        const image = blockImage(block)
        if (image) images.push(image)
      } else if (block?.type === 'document') {
        const source = block.source as { type?: unknown; data?: unknown } | undefined
        if (source?.type === 'text' && typeof source.data === 'string') texts.push(source.data)
      }
    }
    if (results.length) messages.push({ role: 'tool', results })
    if (texts.length || images.length) messages.push({ role: 'user', text: texts.join('\n\n'), ...(images.length ? { images } : {}) })
  }

  // Server tools (web search, code execution) are Anthropic's own; only client tools carry a schema.
  const tools: ToolSpec[] = (Array.isArray(body.tools) ? (body.tools as Block[]) : [])
    .filter((tool) => typeof tool?.name === 'string' && tool.input_schema && typeof tool.input_schema === 'object')
    .map((tool) => ({
      name: tool.name as string,
      description: typeof tool.description === 'string' ? tool.description : '',
      inputSchema: tool.input_schema as Record<string, unknown>
    }))

  const thinking = body.thinking as { type?: unknown } | undefined
  return {
    model: typeof body.model === 'string' ? body.model : undefined,
    system: systemText(body.system),
    messages: tidy(messages),
    tools,
    effort: anthropicEffort(body.thinking, body.output_config),
    outputCap: cap(body.max_tokens),
    stream: body.stream === true,
    thinking: thinking?.type === 'enabled' || thinking?.type === 'adaptive'
  }
}

function stopReason(stop: TurnResult['stop']): string {
  return stop === 'tool_use' ? 'tool_use' : stop === 'max_tokens' ? 'max_tokens' : stop === 'refusal' ? 'refusal' : 'end_turn'
}

function anthropicUsage(usage: TokenUsage): Record<string, number> {
  return {
    input_tokens: usage.input,
    output_tokens: usage.output,
    cache_read_input_tokens: usage.cacheRead,
    cache_creation_input_tokens: usage.cacheWrite
  }
}

/** Anthropic's error body. */
export function anthropicError(message: string, type = 'api_error'): Record<string, unknown> {
  return { type: 'error', error: { type, message } }
}

function errorType(status: number): string {
  if (status === 400) return 'invalid_request_error'
  if (status === 401) return 'authentication_error'
  if (status === 404) return 'not_found_error'
  if (status === 429) return 'rate_limit_error'
  if (status === 529 || status === 503) return 'overloaded_error'
  return 'api_error'
}

export async function serveMessages(res: ServerResponse, body: Record<string, unknown>, scope: GatewayScope = 'all'): Promise<void> {
  const parsed = parseMessagesRequest(body)
  if ('error' in parsed) {
    sendJson(res, 400, anthropicError(parsed.error, 'invalid_request_error'))
    return
  }
  const resolved = resolveGatewayModel(parsed.model, scope)
  if (!resolved) {
    sendJson(res, 400, anthropicError(noModelMessage(scope, parsed.model), 'invalid_request_error'))
    return
  }

  const id = newId('msg_')
  const model = parsed.model ?? resolved.id
  const controller = new AbortController()
  res.on('close', () => {
    if (!res.writableFinished) controller.abort()
  })

  // Blocks are opened as the reply goes: thinking, then text. Tool calls come
  // whole at the end of the turn (the adapters hand them over complete).
  let started = false
  let index = -1
  let open: 'thinking' | 'text' | null = null
  const begin = (): void => {
    if (started || !parsed.stream) return
    started = true
    startSse(res)
    sseEvent(res, 'message_start', {
      type: 'message_start',
      message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }
    })
  }
  const close = (): void => {
    if (!open) return
    // A thinking block ends with its signature; there is no real one to give, and none is checked on the way back in.
    if (open === 'thinking') sseEvent(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'eaon' } })
    sseEvent(res, 'content_block_stop', { type: 'content_block_stop', index })
    open = null
  }
  const openBlock = (kind: 'thinking' | 'text'): void => {
    if (open === kind) return
    close()
    index++
    open = kind
    sseEvent(res, 'content_block_start', {
      type: 'content_block_start',
      index,
      content_block: kind === 'thinking' ? { type: 'thinking', thinking: '', signature: '' } : { type: 'text', text: '' }
    })
  }

  let reasoning = ''
  let result: TurnResult
  try {
    result = await runGatewayTurn({
      providerId: resolved.providerId,
      modelId: resolved.modelId,
      system: parsed.system,
      messages: parsed.messages,
      tools: parsed.tools,
      effort: parsed.effort,
      outputCap: parsed.outputCap,
      signal: controller.signal,
      onText: (delta) => {
        if (!parsed.stream) return
        begin()
        openBlock('text')
        sseEvent(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: delta } })
      },
      onReasoning: (delta) => {
        reasoning += delta
        // Shown only to an app that asked for thinking; others would not expect the block.
        if (!parsed.stream || !parsed.thinking) return
        begin()
        openBlock('thinking')
        sseEvent(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: delta } })
      }
    })
  } catch (error) {
    if (controller.signal.aborted) return
    const status = statusFor(error)
    const message = errorMessage(error)
    if (started) {
      sseEvent(res, 'error', anthropicError(message, errorType(status)))
      res.end()
    } else {
      sendJson(res, status, anthropicError(message, errorType(status)))
    }
    return
  }
  if (controller.signal.aborted) return

  const calls = result.calls.map((call) => ({ ...call, id: clientToolId(call.id, 'toolu_') }))
  const usage = anthropicUsage(result.usage)

  if (parsed.stream) {
    begin()
    close()
    for (const call of calls) {
      index++
      sseEvent(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } })
      sseEvent(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) } })
      sseEvent(res, 'content_block_stop', { type: 'content_block_stop', index })
    }
    // An empty reply still has one (empty) text block, as Anthropic's does.
    if (index < 0) {
      openBlock('text')
      close()
    }
    sseEvent(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: stopReason(result.stop), stop_sequence: null }, usage })
    sseEvent(res, 'message_stop', { type: 'message_stop' })
    res.end()
    return
  }

  const content: Record<string, unknown>[] = []
  if (parsed.thinking && reasoning) content.push({ type: 'thinking', thinking: reasoning, signature: 'eaon' })
  if (result.text || calls.length === 0) content.push({ type: 'text', text: result.text })
  for (const call of calls) content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input })
  sendJson(res, 200, { id, type: 'message', role: 'assistant', model, content, stop_reason: stopReason(result.stop), stop_sequence: null, usage })
}

/** `/v1/messages/count_tokens`: an estimate, from the same count the adapters use to fit the window. */
export function serveCountTokens(res: ServerResponse, body: Record<string, unknown>): void {
  const estimate = estimateRequestTokens({ system: body.system, messages: body.messages, tools: body.tools })
  sendJson(res, 200, { input_tokens: estimate })
}

/** `/v1/models` in Anthropic's shape, for a client that sends `anthropic-version`. */
export function anthropicModelList(scope: GatewayScope = 'all'): Record<string, unknown> {
  const data = gatewayModels(scope).map((model) => ({ type: 'model', id: model.id, display_name: model.label, created_at: '2026-01-01T00:00:00Z' }))
  return { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data[data.length - 1]?.id ?? null }
}
