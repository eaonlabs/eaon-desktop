import Anthropic from '@anthropic-ai/sdk'
import type { EffortLevel } from '@shared/types'
import { anthropicCompat, clampEffort, effortsFor, missingUrlFields } from '../compat'
import { anthropicThinking, budgetThinking, contextWindowFor, maxOutputFor } from '../models'
import {
  capOutput,
  clampOutputToWindow,
  describeErrorBody,
  emptyUsage,
  estimateRequestTokens,
  ProviderHttpError,
  retryAfterFrom,
  type Adapter,
  type NeutralMessage,
  type NeutralToolCall,
  type TurnRequest,
  type TurnResult
} from './types'

/**
 * Anthropic Messages, through the official SDK.
 *
 * Three things here exist purely to spend fewer tokens, and all three depend on
 * the request prefix staying byte-stable across the rounds of one turn:
 *
 * - Prompt caching: a breakpoint after the tool list and system prompt (the
 *   part that never changes within a conversation), plus top-level automatic
 *   caching, which moves the last breakpoint to the end of each request so
 *   every round reads the previous round's transcript from cache.
 * - Server-side context editing: once a long agent loop crosses a size
 *   threshold, the API clears old tool results itself. Doing that client-side
 *   would rewrite earlier turns, which both resets the cache and invalidates
 *   the thinking signatures newer models bind to the conversation prefix.
 * - Thinking blocks are replayed verbatim within a turn (from `replay`) and
 *   never across turns, where they would only cost input tokens.
 *
 * The same adapter serves Anthropic-compatible endpoints (MiniMax, Kimi For
 * Coding, GitHub Copilot's and OpenCode's Claude models). Those get none of
 * the betas and no top-level `cache_control` — third-party validators reject
 * fields they do not know — and caching falls back to a breakpoint on the
 * last message. Non-Claude models there are asked to think the way Eaon
 * Code's catalog says they take it: Kimi adaptively, MiniMax with a budget.
 */

/** Anthropic has no "none" or "minimal" effort; the catalog never offers them for Claude, and clamping keeps it so. */
const EFFORT_TO_ANTHROPIC: Record<EffortLevel, 'low' | 'medium' | 'high' | 'xhigh' | 'max'> = {
  none: 'low',
  minimal: 'low',
  light: 'low',
  medium: 'medium',
  high: 'high',
  'extra-high': 'xhigh',
  ultra: 'max'
}

const CONTEXT_EDITING_BETA = 'context-management-2025-06-27'
const FALLBACK_BETA = 'server-side-fallback-2026-07-01'

/** Models with the server-side refusal fallback; the API rejects the field elsewhere. */
const supportsFallbacks = (id: string): boolean => /claude-(fable-5-1|opus-5)$/.test(id)

/** Context editing needs Claude 4 or later; older models reject the beta. */
const supportsContextEditing = (id: string): boolean => /claude-(opus|sonnet|haiku|fable|mythos)-[4-9]/.test(id)

/** Puts a cache breakpoint on the newest content block (thinking blocks cannot carry one). */
function markLastBlockForCache(messages: Anthropic.Beta.BetaMessageParam[]): void {
  const last = messages[messages.length - 1]
  if (!last) return
  if (typeof last.content === 'string') {
    last.content = [{ type: 'text', text: last.content, cache_control: { type: 'ephemeral' } }]
    return
  }
  // Copies: replayed blocks are shared with the transcript, which must not grow markers.
  const blocks = [...(last.content as Anthropic.Beta.BetaContentBlockParam[])]
  for (let i = blocks.length - 1; i >= 0; i--) {
    const type = blocks[i].type
    if (type === 'thinking' || type === 'redacted_thinking') continue
    blocks[i] = { ...blocks[i], cache_control: { type: 'ephemeral' } } as Anthropic.Beta.BetaContentBlockParam
    last.content = blocks
    return
  }
}

function toBlocks(message: NeutralMessage, modelId: string): Anthropic.Beta.BetaMessageParam | null {
  if (message.role === 'user') {
    const content: Anthropic.Beta.BetaContentBlockParam[] = []
    for (const image of message.images ?? []) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: image.mime as 'image/png', data: image.data }
      })
    }
    if (message.text) content.push({ type: 'text', text: message.text })
    return content.length > 0 ? { role: 'user', content } : null
  }

  if (message.role === 'assistant') {
    // Same adapter and model: send back exactly what the API returned, thinking
    // signatures included. Anything else is rebuilt from the neutral fields.
    if (message.replay?.adapter === 'anthropic' && message.replay.modelId === modelId) {
      return { role: 'assistant', content: message.replay.data as Anthropic.Beta.BetaContentBlockParam[] }
    }
    const content: Anthropic.Beta.BetaContentBlockParam[] = []
    if (message.text) content.push({ type: 'text', text: message.text })
    for (const call of message.calls) {
      content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input })
    }
    return content.length > 0 ? { role: 'assistant', content } : null
  }

  return {
    role: 'user',
    content: message.results.map((result) => {
      const images = result.images ?? []
      return {
        type: 'tool_result' as const,
        tool_use_id: result.id,
        ...(result.isError ? { is_error: true } : {}),
        content:
          images.length === 0
            ? result.output
            : [
                { type: 'text' as const, text: result.output || '(image)' },
                ...images.map((image) => ({
                  type: 'image' as const,
                  source: { type: 'base64' as const, media_type: image.mime as 'image/png', data: image.data }
                }))
              ]
      }
    })
  }
}

export const anthropicAdapter: Adapter = {
  id: 'anthropic',
  managesContext: true,

  async turn(request: TurnRequest): Promise<TurnResult> {
    const { credentials, provider, modelId } = request
    const baseURL = (credentials.baseUrl ?? provider.baseUrl).replace(/\/+$/, '')
    if (missingUrlFields(baseURL).length > 0) {
      throw new Error(`Fill in the missing parts of ${provider.name}'s base URL in Settings → Model providers.`)
    }
    const compat = anthropicCompat(provider, baseURL, modelId, request.model)
    const firstParty = compat.firstParty
    const client = new Anthropic({
      apiKey: credentials.apiKey ?? null,
      // OAuth-backed providers hand over a bearer token rather than an API key.
      ...(credentials.extra?.authToken ? { authToken: credentials.extra.authToken } : {}),
      baseURL: baseURL || undefined,
      defaultHeaders: { ...provider.headers, ...credentials.headers },
      // The loop does its own retrying with visible status; SDK retries would
      // stack under it and make a dead provider look like a hang.
      maxRetries: 0
    })

    const messages: Anthropic.Beta.BetaMessageParam[] = []
    for (const message of request.messages) {
      const block = toBlocks(message, modelId)
      if (block) messages.push(block)
    }

    const window = contextWindowFor(provider, modelId, request.model)
    const estimate = estimateRequestTokens(messages) + Math.ceil(request.system.length / 3.6)
    const maxTokens = capOutput(request.outputCap, clampOutputToWindow(maxOutputFor(provider, modelId, request.model) ?? 32_000, window, estimate)) ?? 32_000
    const effort = clampEffort(request.effort, effortsFor(modelId, request.model))
    const thinking =
      compat.thinking === 'claude'
        ? anthropicThinking(modelId, effort ?? request.effort, maxTokens)
        : compat.thinking === 'adaptive'
          ? ({ type: 'adaptive', display: 'summarized' } as const)
          : compat.thinking === 'budget'
            ? budgetThinking(request.effort, maxTokens)
            : undefined
    // Effort only goes where thinking is adaptive: Claude's newer families and Kimi.
    const sendEffort = effort && (compat.thinking === 'claude' || compat.thinking === 'adaptive')

    // Off Anthropic's own API there is no automatic caching; one breakpoint on
    // the newest content block still caches the transcript between rounds.
    if (!firstParty) markLastBlockForCache(messages)

    const tools: Anthropic.Beta.BetaTool[] = request.tools.map((tool, index) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as Anthropic.Beta.BetaTool['input_schema'],
      // One breakpoint after the last tool caches the whole tool list, which is
      // usually the single largest stable chunk of the prompt.
      ...(index === request.tools.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {})
    }))

    const betas: string[] = []
    const contextEditing = firstParty && request.agentic && tools.length > 0 && supportsContextEditing(modelId)
    if (contextEditing) betas.push(CONTEXT_EDITING_BETA)
    const fallbacks = firstParty && supportsFallbacks(modelId)
    if (fallbacks) betas.push(FALLBACK_BETA)

    const params: Anthropic.Beta.MessageCreateParamsStreaming = {
      model: modelId,
      max_tokens: maxTokens,
      stream: true,
      messages,
      ...(request.system
        ? { system: [{ type: 'text' as const, text: request.system, cache_control: { type: 'ephemeral' as const } }] }
        : {}),
      // Moves the final breakpoint to the end of each request, so round N+1
      // reads everything round N sent from cache.
      ...(firstParty ? { cache_control: { type: 'ephemeral' as const } } : {}),
      ...(thinking ? { thinking } : {}),
      ...(sendEffort && effort ? { output_config: { effort: EFFORT_TO_ANTHROPIC[effort] } } : {}),
      ...(tools.length > 0 ? { tools } : {}),
      ...(contextEditing
        ? {
            context_management: {
              edits: [
                {
                  type: 'clear_tool_uses_20250919' as const,
                  // Clear in large batches so the cache is rebuilt rarely: a
                  // clearing event invalidates the prefix from the first
                  // cleared result onward.
                  // Screenshots pile up fast in computer-use turns, so
                  // those clear sooner.
                  trigger: { type: 'input_tokens' as const, value: request.tools.some((t) => t.name === 'computer') ? 50_000 : 90_000 },
                  keep: { type: 'tool_uses' as const, value: 6 },
                  clear_at_least: { type: 'input_tokens' as const, value: 25_000 }
                }
              ]
            }
          }
        : {}),
      ...(fallbacks ? { fallbacks: 'default' as never } : {}),
      ...(betas.length > 0 ? { betas: betas as Anthropic.Beta.AnthropicBeta[] } : {})
    }

    let stream: ReturnType<typeof client.beta.messages.stream>
    let final: Anthropic.Beta.BetaMessage
    try {
      stream = client.beta.messages.stream(params, { signal: request.signal })
      stream.on('text', (text: string) => request.onText(text))
      stream.on('thinking', (delta: string) => request.onReasoning(delta))
      final = await stream.finalMessage()
    } catch (error) {
      if (error instanceof Anthropic.APIError && typeof error.status === 'number') {
        // `error.error` is the parsed body; the SDK's own message is the status
        // plus that body as raw JSON. A missing retry-after must stay
        // undefined (not 0) so the loop backs off instead of retrying at once.
        const body = error.error !== undefined ? JSON.stringify(error.error) : error.message.replace(/^\d{3}\s+/, '')
        throw new ProviderHttpError(
          error.status,
          describeErrorBody(error.status, body),
          error.headers instanceof Headers ? retryAfterFrom(error.headers) : undefined
        )
      }
      // The SDK's own words for a connection that closed before message_stop.
      if (error instanceof Error && /stream ended without producing a Message|request ended without sending any chunks/.test(error.message)) {
        throw new Error('The response stream ended before it finished. Try again.')
      }
      throw error
    }
    // message_stop without the message_delta that carries stop_reason: the
    // SDK still returns the message, with any cut-off tool input filled in
    // from its partial JSON, so a call can look whole when it is not.
    if (!final.stop_reason) throw new Error('The response stream ended before it finished. Try again.')

    const usage = emptyUsage()
    usage.input = final.usage.input_tokens ?? 0
    usage.output = final.usage.output_tokens ?? 0
    usage.cacheRead = final.usage.cache_read_input_tokens ?? 0
    usage.cacheWrite = final.usage.cache_creation_input_tokens ?? 0

    const text = final.content
      .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')

    if (final.stop_reason === 'refusal') {
      const detail = final.stop_details as { explanation?: string } | null
      return {
        text,
        calls: [],
        stop: 'refusal',
        usage,
        refusal: detail?.explanation ?? 'The model declined this request.'
      }
    }

    const calls: NeutralToolCall[] = final.content
      .filter((block): block is Anthropic.Beta.BetaToolUseBlock => block.type === 'tool_use')
      .map((block) => ({ id: block.id, name: block.name, input: (block.input ?? {}) as Record<string, unknown> }))

    // A turn cut off by max_tokens (or by the context window filling up) may
    // carry a half-written tool call whose input was truncated; the loop must
    // not execute it.
    const cutOff = final.stop_reason === 'max_tokens' || final.stop_reason === 'model_context_window_exceeded'
    return {
      text,
      calls,
      stop: cutOff ? 'max_tokens' : calls.length > 0 ? 'tool_use' : 'end',
      usage,
      replay: { adapter: 'anthropic', modelId, data: final.content }
    }
  }
}
