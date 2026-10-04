import type { ServerResponse } from 'node:http'
import type { EffortLevel, TokenUsage } from '@shared/types'
import { toolInput, type NeutralImage, type NeutralMessage, type NeutralToolCall, type ToolSpec, type TurnResult } from '../providers/adapters/types'
import { resolveGatewayModel } from './models'
import { runGatewayTurn, statusFor } from './turn'
import { argumentsJson, cap, clientToolId, dataUrlImage, errorMessage, newId, openaiEffort, sendJson, sseEvent, startSse, tidy } from './wire'

/**
 * OpenAI Responses (`POST /v1/responses`): what Codex speaks (the CLI, and
 * Codex in the ChatGPT app), statelessly (`store: false`, the whole input
 * each time). Codex's freeform tools (`custom`, e.g. apply_patch) and
 * `local_shell` are offered to the model as ordinary functions and turned
 * back into their own item types in the reply.
 */

type Item = Record<string, unknown> & { type?: string }

/** How a tool the app declared is offered to the model, and how its calls go back. */
type ToolKind = 'function' | 'custom' | 'local_shell'

interface Parsed {
  model?: string
  system: string
  messages: NeutralMessage[]
  tools: ToolSpec[]
  kinds: Map<string, ToolKind>
  effort?: EffortLevel
  outputCap?: number
  stream: boolean
  /** The app asked for a reasoning summary. */
  summary: boolean
}

const LOCAL_SHELL_SCHEMA = {
  type: 'object',
  properties: {
    command: { type: 'array', items: { type: 'string' }, description: 'The command and its arguments, e.g. ["bash", "-lc", "ls"]' },
    workdir: { type: 'string', description: 'The working directory' },
    timeout_ms: { type: 'number', description: 'Time limit in milliseconds' }
  },
  required: ['command']
}

function partsText(content: unknown): { text: string; images: NeutralImage[] } {
  if (typeof content === 'string') return { text: content, images: [] }
  if (!Array.isArray(content)) return { text: '', images: [] }
  const texts: string[] = []
  const images: NeutralImage[] = []
  for (const part of content as Item[]) {
    if (!part || typeof part !== 'object') continue
    if (typeof part.text === 'string') texts.push(part.text)
    else if (part.type === 'input_image') {
      const image = dataUrlImage(part.image_url)
      if (image) images.push(image)
    }
  }
  return { text: texts.join('\n'), images }
}

/** A function call output: a string, a list of parts, or Codex's `{ content }` payload. */
function outputContent(output: unknown): { text: string; images: NeutralImage[] } {
  if (output && typeof output === 'object' && !Array.isArray(output) && 'content' in (output as object)) {
    return partsText((output as { content: unknown }).content)
  }
  return partsText(output)
}

export function parseResponsesRequest(body: Record<string, unknown>): Parsed | { error: string } {
  const kinds = new Map<string, ToolKind>()
  const tools: ToolSpec[] = []
  for (const tool of Array.isArray(body.tools) ? (body.tools as Item[]) : []) {
    if (tool?.type === 'function' && typeof tool.name === 'string') {
      kinds.set(tool.name, 'function')
      tools.push({
        name: tool.name,
        description: typeof tool.description === 'string' ? tool.description : '',
        inputSchema: (tool.parameters as Record<string, unknown> | undefined) ?? { type: 'object', properties: {} }
      })
    } else if (tool?.type === 'custom' && typeof tool.name === 'string') {
      kinds.set(tool.name, 'custom')
      const format = tool.format as { type?: unknown; syntax?: unknown; definition?: unknown } | undefined
      const grammar = format?.type === 'grammar' && typeof format.definition === 'string' ? `\n\nThe input must follow this ${String(format.syntax ?? '')} grammar:\n${format.definition}` : ''
      tools.push({
        name: tool.name,
        description: `${typeof tool.description === 'string' ? tool.description : ''}${grammar}`,
        inputSchema: { type: 'object', properties: { input: { type: 'string', description: 'The raw input for this tool.' } }, required: ['input'] }
      })
    } else if (tool?.type === 'local_shell') {
      kinds.set('local_shell', 'local_shell')
      tools.push({ name: 'local_shell', description: 'Runs a command on the user’s machine and returns its output.', inputSchema: LOCAL_SHELL_SCHEMA })
    }
    // Hosted tools (web_search, file_search, …) are OpenAI's own and are not offered.
  }

  const system: string[] = []
  if (typeof body.instructions === 'string' && body.instructions) system.push(body.instructions)
  const messages: NeutralMessage[] = []
  const names = new Map<string, string>()
  const input = typeof body.input === 'string' ? [{ type: 'message', role: 'user', content: body.input }] : body.input
  if (!Array.isArray(input) || input.length === 0) return { error: '`input` is required' }

  const lastAssistant = (): Extract<NeutralMessage, { role: 'assistant' }> => {
    const last = messages[messages.length - 1]
    if (last?.role === 'assistant') return last
    const fresh: Extract<NeutralMessage, { role: 'assistant' }> = { role: 'assistant', text: '', calls: [] }
    messages.push(fresh)
    return fresh
  }
  const addCall = (call: NeutralToolCall): void => {
    names.set(call.id, call.name)
    lastAssistant().calls.push(call)
  }
  const addResult = (id: string, output: unknown): void => {
    const { text, images } = outputContent(output)
    const result = { id, name: names.get(id) ?? '', output: text, ...(images.length ? { images } : {}) }
    const last = messages[messages.length - 1]
    if (last?.role === 'tool') last.results.push(result)
    else messages.push({ role: 'tool', results: [result] })
  }

  for (const item of input as Item[]) {
    if (!item || typeof item !== 'object') continue
    const type = item.type ?? (item.role ? 'message' : undefined)
    if (type === 'message') {
      const { text, images } = partsText(item.content)
      if (item.role === 'system' || item.role === 'developer') {
        if (text) system.push(text)
      } else if (item.role === 'assistant') {
        const target = lastAssistant()
        target.text = target.text ? `${target.text}\n${text}` : text
      } else {
        messages.push({ role: 'user', text, ...(images.length ? { images } : {}) })
      }
    } else if (type === 'function_call' && typeof item.name === 'string') {
      addCall({ id: String(item.call_id ?? item.id ?? newId('call_')), name: item.name, input: toolInput(item.arguments) })
    } else if (type === 'custom_tool_call' && typeof item.name === 'string') {
      addCall({ id: String(item.call_id ?? newId('call_')), name: item.name, input: { input: typeof item.input === 'string' ? item.input : '' } })
    } else if (type === 'local_shell_call') {
      const action = (item.action ?? {}) as Record<string, unknown>
      addCall({ id: String(item.call_id ?? item.id ?? newId('call_')), name: 'local_shell', input: { command: action.command ?? [], ...(action.working_directory ? { workdir: action.working_directory } : {}) } })
    } else if (type === 'function_call_output' || type === 'custom_tool_call_output' || type === 'local_shell_call_output') {
      addResult(String(item.call_id ?? ''), item.output)
    }
    // Reasoning items are another model's private record; web search calls are OpenAI's.
  }

  const reasoning = body.reasoning as { effort?: unknown; summary?: unknown } | undefined
  return {
    model: typeof body.model === 'string' ? body.model : undefined,
    system: system.join('\n\n'),
    messages: tidy(messages),
    tools,
    kinds,
    effort: openaiEffort(reasoning?.effort),
    outputCap: cap(body.max_output_tokens),
    stream: body.stream === true,
    summary: reasoning?.summary !== undefined && reasoning.summary !== null
  }
}

export function responsesUsage(usage: TokenUsage): Record<string, unknown> {
  const input = usage.input + usage.cacheRead + usage.cacheWrite
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: usage.cacheRead },
    output_tokens: usage.output,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: input + usage.output
  }
}

/** A tool call as the item type its tool was declared as. */
function callItem(call: NeutralToolCall, kind: ToolKind | undefined): Item {
  const callId = clientToolId(call.id, 'call_')
  if (kind === 'custom') {
    const input = typeof call.input.input === 'string' ? call.input.input : JSON.stringify(call.input)
    return { type: 'custom_tool_call', id: newId('ctc_'), call_id: callId, name: call.name, input, status: 'completed' }
  }
  if (kind === 'local_shell') {
    const command = Array.isArray(call.input.command) ? call.input.command.map(String) : typeof call.input.command === 'string' ? ['bash', '-lc', call.input.command] : []
    return {
      type: 'local_shell_call',
      id: newId('lsh_'),
      call_id: callId,
      status: 'completed',
      action: {
        type: 'exec',
        command,
        ...(typeof call.input.workdir === 'string' ? { working_directory: call.input.workdir } : {}),
        ...(typeof call.input.timeout_ms === 'number' ? { timeout_ms: call.input.timeout_ms } : {})
      }
    }
  }
  return { type: 'function_call', id: newId('fc_'), call_id: callId, name: call.name, arguments: argumentsJson(call), status: 'completed' }
}

export async function serveResponses(res: ServerResponse, body: Record<string, unknown>): Promise<void> {
  const parsed = parseResponsesRequest(body)
  if ('error' in parsed) {
    sendJson(res, 400, { error: { message: parsed.error, type: 'invalid_request_error', code: null } })
    return
  }
  const resolved = resolveGatewayModel(parsed.model)
  if (!resolved) {
    sendJson(res, 400, { error: { message: 'No model available. Add an API key in Eaon → Settings → Model providers.', type: 'invalid_request_error', code: null } })
    return
  }

  const id = newId('resp_')
  const createdAt = Math.floor(Date.now() / 1000)
  const model = parsed.model ?? resolved.id
  const shell = (status: string, output: Item[] = []): Record<string, unknown> => ({
    id,
    object: 'response',
    created_at: createdAt,
    status,
    model,
    output,
    parallel_tool_calls: true,
    tool_choice: 'auto',
    tools: []
  })

  const controller = new AbortController()
  res.on('close', () => {
    if (!res.writableFinished) controller.abort()
  })

  let seq = 0
  const emit = (type: string, data: Record<string, unknown>): void => sseEvent(res, type, { type, sequence_number: seq++, ...data })

  const output: Item[] = []
  let started = false
  const begin = (): void => {
    if (started || !parsed.stream) return
    started = true
    startSse(res)
    emit('response.created', { response: shell('in_progress') })
    emit('response.in_progress', { response: shell('in_progress') })
  }

  // The open reasoning and message items, as the reply streams.
  let reasoning: { id: string; index: number; text: string } | null = null
  let message: { id: string; index: number; text: string } | null = null
  const closeReasoning = (): void => {
    if (!reasoning) return
    const item = { type: 'reasoning', id: reasoning.id, summary: [{ type: 'summary_text', text: reasoning.text }] }
    if (parsed.stream) {
      emit('response.reasoning_summary_text.done', { item_id: reasoning.id, output_index: reasoning.index, summary_index: 0, text: reasoning.text })
      emit('response.reasoning_summary_part.done', { item_id: reasoning.id, output_index: reasoning.index, summary_index: 0, part: { type: 'summary_text', text: reasoning.text } })
      emit('response.output_item.done', { output_index: reasoning.index, item })
    }
    output[reasoning.index] = item
    reasoning = null
  }
  const closeMessage = (): void => {
    if (!message) return
    const part = { type: 'output_text', text: message.text, annotations: [] }
    const item = { type: 'message', id: message.id, status: 'completed', role: 'assistant', content: [part] }
    if (parsed.stream) {
      emit('response.output_text.done', { item_id: message.id, output_index: message.index, content_index: 0, text: message.text })
      emit('response.content_part.done', { item_id: message.id, output_index: message.index, content_index: 0, part })
      emit('response.output_item.done', { output_index: message.index, item })
    }
    output[message.index] = item
    message = null
  }

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
      onReasoning: (delta) => {
        if (message) return
        begin()
        if (!reasoning) {
          reasoning = { id: newId('rs_'), index: output.length, text: '' }
          output.push({ type: 'reasoning', id: reasoning.id, summary: [] })
          if (parsed.stream) {
            emit('response.output_item.added', { output_index: reasoning.index, item: { type: 'reasoning', id: reasoning.id, summary: [] } })
            emit('response.reasoning_summary_part.added', { item_id: reasoning.id, output_index: reasoning.index, summary_index: 0, part: { type: 'summary_text', text: '' } })
          }
        }
        reasoning.text += delta
        if (parsed.stream) emit('response.reasoning_summary_text.delta', { item_id: reasoning.id, output_index: reasoning.index, summary_index: 0, delta })
      },
      onText: (delta) => {
        begin()
        closeReasoning()
        if (!message) {
          message = { id: newId('msg_'), index: output.length, text: '' }
          output.push({ type: 'message', id: message.id, status: 'in_progress', role: 'assistant', content: [] })
          if (parsed.stream) {
            emit('response.output_item.added', { output_index: message.index, item: { type: 'message', id: message.id, status: 'in_progress', role: 'assistant', content: [] } })
            emit('response.content_part.added', { item_id: message.id, output_index: message.index, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
          }
        }
        message.text += delta
        if (parsed.stream) emit('response.output_text.delta', { item_id: message.id, output_index: message.index, content_index: 0, delta })
      }
    })
  } catch (error) {
    if (controller.signal.aborted) return
    const message = errorMessage(error)
    if (started) {
      emit('response.failed', { response: { ...shell('failed'), error: { code: 'server_error', message } } })
      res.end()
    } else {
      sendJson(res, statusFor(error), { error: { message, type: 'api_error', code: null } })
    }
    return
  }
  if (controller.signal.aborted) return

  begin()
  closeReasoning()
  // A reply some adapters hand over only at the end (no deltas) still gets its message.
  if (!message && result.text && !output.some((item) => item.type === 'message')) {
    message = { id: newId('msg_'), index: output.length, text: result.text }
    output.push({})
    if (parsed.stream) emit('response.output_item.added', { output_index: message.index, item: { type: 'message', id: message.id, status: 'in_progress', role: 'assistant', content: [] } })
  }
  closeMessage()
  for (const call of result.calls) {
    const item = callItem(call, parsed.kinds.get(call.name))
    const index = output.length
    output.push(item)
    if (parsed.stream) {
      emit('response.output_item.added', { output_index: index, item: { ...item, ...(item.type === 'function_call' ? { arguments: '' } : {}), status: 'in_progress' } })
      if (item.type === 'function_call') {
        emit('response.function_call_arguments.delta', { item_id: item.id, output_index: index, delta: item.arguments })
        emit('response.function_call_arguments.done', { item_id: item.id, output_index: index, arguments: item.arguments })
      }
      emit('response.output_item.done', { output_index: index, item })
    }
  }

  const incomplete = result.stop === 'max_tokens'
  const final = {
    ...shell(incomplete ? 'incomplete' : 'completed', output),
    ...(incomplete ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
    usage: responsesUsage(result.usage)
  }
  if (parsed.stream) {
    emit(incomplete ? 'response.incomplete' : 'response.completed', { response: final })
    res.end()
    return
  }
  sendJson(res, 200, { ...final, output_text: output.filter((i) => i.type === 'message').map((i) => ((i.content as { text: string }[])[0]?.text ?? '')).join('') })
}
