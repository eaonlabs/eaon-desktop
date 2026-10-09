import type { ServerResponse } from 'node:http'
import type { EffortLevel, TokenUsage } from '@shared/types'
import { toolInput, type NeutralImage, type NeutralMessage, type NeutralToolResult, type ToolSpec, type TurnResult } from '../providers/adapters/types'
import type { GatewayScope } from '@shared/gateway'
import { noModelMessage, resolveGatewayModel } from './models'
import { runGatewayTurn, statusFor } from './turn'
import { argumentsJson, cap, clientToolId, dataUrlImage, errorMessage, newId, openaiEffort, sendJson, sseData, startSse, tidy } from './wire'

/**
 * OpenAI chat completions (`POST /v1/chat/completions`), with tools: what
 * OpenCode, Qwen Code, Droid, Hermes, OpenClaw, Pi, Cline and most other
 * OpenAI-compatible apps speak.
 */

interface Parsed {
  model?: string
  system: string
  messages: NeutralMessage[]
  tools: ToolSpec[]
  effort?: EffortLevel
  outputCap?: number
  stream: boolean
  includeUsage: boolean
}

type Part = { type?: string; text?: unknown; image_url?: unknown }

/** A message's text and images. Content is a string or a list of parts. */
function readContent(content: unknown): { text: string; images: NeutralImage[] } {
  if (typeof content === 'string') return { text: content, images: [] }
  if (!Array.isArray(content)) return { text: content == null ? '' : JSON.stringify(content), images: [] }
  const texts: string[] = []
  const images: NeutralImage[] = []
  for (const part of content as Part[]) {
    if (!part || typeof part !== 'object') continue
    if (typeof part.text === 'string') texts.push(part.text)
    else if (part.type === 'image_url') {
      const url = typeof part.image_url === 'string' ? part.image_url : (part.image_url as { url?: unknown } | undefined)?.url
      const image = dataUrlImage(url)
      if (image) images.push(image)
    }
  }
  return { text: texts.join('\n'), images }
}

export function parseChatRequest(body: Record<string, unknown>): Parsed | { error: string } {
  // One reply per request is all the providers behind the gateway give; an
  // app asking for several would otherwise get one and think it got them all.
  if (body.n !== undefined && body.n !== null && Number(body.n) !== 1) return { error: '`n` other than 1 is not supported: the gateway returns one choice.' }
  const raw = body.messages
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every((m) => m && typeof m === 'object')) return { error: '`messages` is required' }

  const system: string[] = []
  const messages: NeutralMessage[] = []
  const names = new Map<string, string>()
  for (const m of raw as Record<string, unknown>[]) {
    const role = m.role
    // Newer OpenAI clients send the system prompt as `developer`.
    if (role === 'system' || role === 'developer') {
      const { text } = readContent(m.content)
      if (text) system.push(text)
    } else if (role === 'assistant') {
      const { text } = readContent(m.content)
      const calls = (Array.isArray(m.tool_calls) ? (m.tool_calls as Record<string, unknown>[]) : [])
        .map((call) => {
          const fn = (call.function ?? {}) as { name?: unknown; arguments?: unknown }
          return { id: typeof call.id === 'string' && call.id ? call.id : newId('call_'), name: String(fn.name ?? ''), input: toolInput(fn.arguments) }
        })
        .filter((call) => call.name)
      // The pre-tools `function_call` form.
      const legacy = m.function_call as { name?: unknown; arguments?: unknown } | undefined
      if (legacy?.name) calls.push({ id: newId('call_'), name: String(legacy.name), input: toolInput(legacy.arguments) })
      for (const call of calls) names.set(call.id, call.name)
      messages.push({ role: 'assistant', text, calls })
    } else if (role === 'tool' || role === 'function') {
      const { text, images } = readContent(m.content)
      const id = typeof m.tool_call_id === 'string' ? m.tool_call_id : ''
      // A legacy function result answers the last call of that name.
      const legacyId = role === 'function' ? [...names].reverse().find(([, name]) => name === m.name)?.[0] : undefined
      const result: NeutralToolResult = {
        id: id || legacyId || '',
        name: names.get(id || legacyId || '') ?? String(m.name ?? ''),
        output: text,
        ...(images.length ? { images } : {})
      }
      const last = messages[messages.length - 1]
      if (last?.role === 'tool') last.results.push(result)
      else messages.push({ role: 'tool', results: [result] })
    } else {
      const { text, images } = readContent(m.content)
      messages.push({ role: 'user', text, ...(images.length ? { images } : {}) })
    }
  }

  const toolList = Array.isArray(body.tools) ? (body.tools as Record<string, unknown>[]) : []
  const legacyFunctions = Array.isArray(body.functions) ? (body.functions as Record<string, unknown>[]) : []
  const tools: ToolSpec[] = [
    ...toolList.filter((t) => t?.type === 'function' && t.function).map((t) => t.function as Record<string, unknown>),
    ...legacyFunctions
  ]
    .filter((fn) => typeof fn?.name === 'string' && fn.name)
    .map((fn) => ({
      name: fn.name as string,
      description: typeof fn.description === 'string' ? fn.description : '',
      inputSchema: (fn.parameters as Record<string, unknown> | undefined) ?? { type: 'object', properties: {} }
    }))

  const reasoning = body.reasoning as { effort?: unknown } | undefined
  return {
    model: typeof body.model === 'string' ? body.model : undefined,
    system: system.join('\n\n'),
    messages: tidy(messages),
    tools,
    effort: openaiEffort(body.reasoning_effort ?? reasoning?.effort),
    outputCap: cap(body.max_completion_tokens ?? body.max_tokens),
    stream: body.stream === true,
    includeUsage: (body.stream_options as { include_usage?: unknown } | undefined)?.include_usage === true
  }
}

export function finishReason(stop: TurnResult['stop']): string {
  return stop === 'tool_use' ? 'tool_calls' : stop === 'max_tokens' ? 'length' : stop === 'refusal' ? 'content_filter' : 'stop'
}

export function openaiUsage(usage: TokenUsage): Record<string, unknown> {
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite
  return {
    prompt_tokens: prompt,
    completion_tokens: usage.output,
    total_tokens: prompt + usage.output,
    prompt_tokens_details: { cached_tokens: usage.cacheRead }
  }
}

export async function serveChatCompletions(res: ServerResponse, body: Record<string, unknown>, scope: GatewayScope = 'all'): Promise<void> {
  const parsed = parseChatRequest(body)
  if ('error' in parsed) {
    sendJson(res, 400, { error: { message: parsed.error, type: 'invalid_request_error' } })
    return
  }
  const resolved = resolveGatewayModel(parsed.model, scope)
  if (!resolved) {
    sendJson(res, 400, { error: { message: noModelMessage(scope, parsed.model), type: 'invalid_request_error' } })
    return
  }

  const id = newId('chatcmpl-')
  const created = Math.floor(Date.now() / 1000)
  const model = parsed.model ?? resolved.id
  const chunk = (delta: Record<string, unknown>, finish: string | null = null): Record<string, unknown> => ({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }]
  })

  // A client that hangs up (Ctrl-C in a CLI, Stop Server) stops the upstream
  // call; otherwise the model keeps generating, and billing, for nobody.
  const controller = new AbortController()
  res.on('close', () => {
    if (!res.writableFinished) controller.abort()
  })

  // The stream starts with the first token, so a request that fails outright
  // still gets a proper HTTP error the client's SDK understands.
  let started = false
  const begin = (): void => {
    if (started || !parsed.stream) return
    started = true
    startSse(res)
    sseData(res, chunk({ role: 'assistant', content: '' }))
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
        begin()
        if (parsed.stream) sseData(res, chunk({ content: delta }))
      },
      onReasoning: (delta) => {
        reasoning += delta
        begin()
        if (parsed.stream) sseData(res, chunk({ reasoning_content: delta }))
      }
    })
  } catch (error) {
    if (controller.signal.aborted) return
    const message = errorMessage(error)
    if (started) {
      sseData(res, { error: { message, type: 'api_error' } })
      sseData(res, '[DONE]')
      res.end()
    } else {
      sendJson(res, statusFor(error), { error: { message, type: 'api_error' } })
    }
    return
  }
  if (controller.signal.aborted) return

  const calls = result.calls.map((call) => ({ ...call, id: clientToolId(call.id, 'call_') }))
  const finish = finishReason(result.stop)

  if (parsed.stream) {
    begin()
    calls.forEach((call, index) =>
      sseData(res, chunk({ tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.name, arguments: argumentsJson(call) } }] }))
    )
    sseData(res, chunk({}, finish))
    if (parsed.includeUsage) sseData(res, { id, object: 'chat.completion.chunk', created, model, choices: [], usage: openaiUsage(result.usage) })
    sseData(res, '[DONE]')
    res.end()
    return
  }

  sendJson(res, 200, {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: result.text || (calls.length ? null : ''),
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(calls.length
            ? { tool_calls: calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: argumentsJson(call) } })) }
            : {})
        },
        finish_reason: finish
      }
    ],
    usage: openaiUsage(result.usage)
  })
}
