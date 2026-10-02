import { baseForWire, vendorOf, wireApiFor } from '../compat'
import { anthropicAdapter } from './anthropic'
import { openaiChatAdapter } from './openaiChat'
import { openaiResponsesAdapter } from './openaiResponses'
import type { Adapter, NeutralMessage, TurnRequest, TurnResult } from './types'

/**
 * One provider, several wire formats: GitHub Copilot and OpenCode serve Claude
 * over Anthropic Messages, GPT-5-era models over Responses and the rest over
 * chat-completions, all behind one credential. This picks the format per
 * model (see `wireApiFor`) and hands the request to that adapter; replay
 * data stays tagged with the adapter that produced it, so switching models
 * mid-chat rebuilds from the neutral transcript as usual.
 */

/**
 * Copilot bills "premium requests" per user-initiated message, and tells them
 * apart from the agent's own follow-ups by `X-Initiator`. Images need an
 * explicit opt-in header or the request is rejected.
 */
export function copilotHeaders(messages: NeutralMessage[]): Record<string, string> {
  const last = messages[messages.length - 1]
  const images = messages.some(
    (message) =>
      (message.role === 'user' && (message.images?.length ?? 0) > 0) ||
      (message.role === 'tool' && message.results.some((result) => (result.images?.length ?? 0) > 0))
  )
  return {
    'X-Initiator': last && last.role !== 'user' ? 'agent' : 'user',
    'Openai-Intent': 'conversation-edits',
    ...(images ? { 'Copilot-Vision-Request': 'true' } : {})
  }
}

export const routerAdapter: Adapter = {
  id: 'router',
  // Neither Copilot nor OpenCode clears old tool output server-side.
  managesContext: false,

  async turn(request: TurnRequest): Promise<TurnResult> {
    const { provider } = request
    const wire = wireApiFor(provider, request.modelId)
    const vendor = vendorOf(provider)
    const base = (request.credentials.baseUrl ?? provider.baseUrl).replace(/\/+$/, '')
    let credentials = { ...request.credentials, baseUrl: baseForWire(provider, base, wire) }

    if (vendor === 'opencode' && /^gemini/i.test(request.modelId)) {
      throw new Error('OpenCode serves Gemini only over Google’s own API, which Eaon does not speak yet. Pick another model.')
    }
    if (vendor === 'copilot') {
      credentials = { ...credentials, headers: { ...credentials.headers, ...copilotHeaders(request.messages) } }
    }
    // OpenCode routes a conversation to one upstream by this header, on every API.
    if (vendor === 'opencode') {
      credentials = { ...credentials, headers: { ...credentials.headers, 'x-opencode-session': request.cacheKey } }
    }

    if (wire === 'anthropic') {
      // Copilot's Messages endpoint takes the token as a bearer, not as x-api-key.
      if (vendor === 'copilot') {
        credentials = { ...credentials, apiKey: undefined, extra: { ...credentials.extra, authToken: request.credentials.apiKey ?? '' } }
      }
      return anthropicAdapter.turn({ ...request, credentials })
    }
    if (wire === 'openai-responses') return openaiResponsesAdapter.turn({ ...request, credentials })
    return openaiChatAdapter.turn({ ...request, credentials })
  }
}
