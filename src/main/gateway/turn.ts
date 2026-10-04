import type { EffortLevel } from '@shared/types'
import { adapterFor, getProvider } from '../providers'
import { credentialAttempts, isAuthError } from '../providers/credentials'
import { ProviderHttpError, type NeutralMessage, type ToolSpec, type TurnResult } from '../providers/adapters/types'
import { store } from '../store'

/**
 * One model request on behalf of an app using the gateway. The app runs its
 * own tools, so this is a single turn: the model's text, reasoning and tool
 * calls go back to the app, and the app sends the results in its next
 * request. Each saved key is tried in turn, as in the agent loop, and a busy
 * provider is retried as long as nothing has been streamed yet.
 */

export interface GatewayTurn {
  providerId: string
  modelId: string
  system: string
  messages: NeutralMessage[]
  tools: ToolSpec[]
  /** The app's own reasoning setting, when it sent one; otherwise Eaon's default. */
  effort?: EffortLevel
  outputCap?: number
  signal: AbortSignal
  onText: (delta: string) => void
  onReasoning: (delta: string) => void
}

const RETRY_WAITS = [1500, 5000]

function retryable(error: unknown): boolean {
  if (error instanceof ProviderHttpError) return [408, 409, 425, 429, 500, 502, 503, 504, 529].includes(error.status)
  const message = error instanceof Error ? error.message : String(error)
  return /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|overloaded|stream ended before/i.test(message)
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new Error('aborted'))
      },
      { once: true }
    )
  })
}

export async function runGatewayTurn(turn: GatewayTurn): Promise<TurnResult> {
  const provider = getProvider(turn.providerId)
  if (!provider) throw new Error(`Eaon has no provider "${turn.providerId}".`)
  const adapter = adapterFor(provider, { track: false })
  const model = provider.models.find((m) => m.id === turn.modelId)
  const attempts = await credentialAttempts(provider)
  const effort = turn.effort ?? store.getSettings().effort
  // One key per conversation is plenty for prompt caching; the gateway has no conversation id.
  const cacheKey = `eaon-gateway-${provider.id}-${turn.modelId}`

  let lastError: unknown
  for (let k = 0; k < attempts.length; k++) {
    for (let retry = 0; retry <= RETRY_WAITS.length; retry++) {
      let streamed = false
      try {
        return await adapter.turn({
          provider,
          modelId: turn.modelId,
          model,
          credentials: attempts[k],
          system: turn.system,
          messages: turn.messages,
          tools: turn.tools,
          effort,
          signal: turn.signal,
          cacheKey,
          agentic: turn.tools.length > 0,
          outputCap: turn.outputCap,
          onText: (delta) => {
            streamed = true
            turn.onText(delta)
          },
          onReasoning: (delta) => {
            streamed = true
            turn.onReasoning(delta)
          }
        })
      } catch (error) {
        lastError = error
        if (turn.signal.aborted) throw error
        if (isAuthError(error) && k < attempts.length - 1) break
        if (!streamed && retry < RETRY_WAITS.length && retryable(error)) {
          const asked = error instanceof ProviderHttpError ? error.retryAfterMs : undefined
          await wait(Math.min(asked ?? RETRY_WAITS[retry], 20_000), turn.signal)
          continue
        }
        throw error
      }
    }
  }
  throw lastError
}

/**
 * An HTTP status for a failed turn. The provider's key being refused is not
 * the app's key being refused: a 401 would make Claude Code ask the user to
 * log in again, so it is reported as a bad gateway instead.
 */
export function statusFor(error: unknown): number {
  if (isAuthError(error)) return 502
  if (error instanceof ProviderHttpError) return error.status >= 400 && error.status < 600 ? error.status : 502
  return 502
}
