import { adapterFor, getProvider } from '../providers'
import { credentialAttempts, isAuthError } from '../providers/credentials'
import type { EffortLevel } from '@shared/types'

/**
 * One request to a model, with no tools, for a short piece of text: what the
 * app asks of the model Chat already uses when the answer is something to
 * read rather than a conversation (a commit message, a review). Written like
 * the chat title's request (agent/chatTitle.ts): each saved key tried in turn
 * as in the agent loop, little or no thinking, a time limit.
 *
 * It is a type so a caller takes one as an argument and its tests give it a
 * stand-in; nothing here is reached from a test.
 */

export interface AskRequest {
  providerId: string
  modelId: string
  system: string
  prompt: string
  /** The most the answer may run to, in tokens. */
  outputCap: number
  /** Names the request for the provider's prompt cache. */
  cacheKey: string
  /** How much the model thinks first; the least it allows unless asked. */
  effort?: EffortLevel
  timeoutMs?: number
}

/** The answer's text, or null when the provider isn't there, has no usable sign-in, or the request failed. */
export type AskModel = (request: AskRequest) => Promise<string | null>

const TIMEOUT_MS = 90_000

export const askModel: AskModel = async (request) => {
  const provider = getProvider(request.providerId)
  if (!provider || !request.prompt.trim()) return null
  const adapter = adapterFor(provider)
  const model = provider.models.find((m) => m.id === request.modelId)
  // A sign-in that has run out has nothing to try with.
  const attempts = await credentialAttempts(provider).catch(() => [])
  for (let k = 0; k < attempts.length; k++) {
    const signal = AbortSignal.timeout(request.timeoutMs ?? TIMEOUT_MS)
    try {
      const result = await adapter.turn({
        provider,
        modelId: request.modelId,
        model,
        credentials: attempts[k],
        system: request.system,
        messages: [{ role: 'user', text: request.prompt }],
        tools: [],
        effort: request.effort ?? 'none',
        signal,
        cacheKey: `${request.cacheKey}-${provider.id}-${request.modelId}`,
        agentic: false,
        outputCap: request.outputCap,
        onText: () => {},
        onReasoning: () => {}
      })
      return result.text
    } catch (error) {
      if (isAuthError(error) && k < attempts.length - 1) continue
      return null
    }
  }
  return null
}
