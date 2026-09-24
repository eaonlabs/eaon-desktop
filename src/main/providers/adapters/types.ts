import type { EffortLevel, ModelInfo, Provider, TokenUsage } from '@shared/types'

/**
 * The provider-neutral transcript the agent loop works in.
 *
 * Every wire format (Anthropic Messages, OpenAI chat-completions, OpenAI
 * Responses, Ollama) is produced from this shape by its adapter, so the loop
 * itself never branches on provider. It is deliberately smaller than any one
 * provider's format: text, images, tool calls and tool results are all the
 * loop ever needs to express.
 */

export interface NeutralImage {
  mime: string
  /** Base64, no data: prefix. */
  data: string
}

export interface NeutralToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface NeutralToolResult {
  id: string
  name: string
  output: string
  images?: NeutralImage[]
  isError?: boolean
}

export type NeutralMessage =
  | { role: 'user'; text: string; images?: NeutralImage[] }
  | {
      role: 'assistant'
      text: string
      calls: NeutralToolCall[]
      /**
       * The provider's own record of this turn — Anthropic content blocks with
       * their thinking signatures, Responses reasoning items. Replayed verbatim
       * only by the adapter and model that produced it, and only within the
       * turn that produced it: it is never persisted, so a later turn or a
       * different model rebuilds from `text` and `calls` instead.
       */
      replay?: { adapter: string; modelId: string; data: unknown }
    }
  | { role: 'tool'; results: NeutralToolResult[] }

export interface ToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** What a request authenticates with, resolved per attempt (primary key, then fallbacks). */
export interface Credentials {
  apiKey?: string
  /** Used instead of `provider.baseUrl` when set — OAuth backends often live elsewhere. */
  baseUrl?: string
  headers?: Record<string, string>
  /** Provider-specific extras an adapter may need (a ChatGPT account id, an Azure API version). */
  extra?: Record<string, string>
}

export interface TurnRequest {
  provider: Provider
  modelId: string
  /** Catalog entry for the model, when the provider lists it. */
  model: ModelInfo | undefined
  credentials: Credentials
  system: string
  messages: NeutralMessage[]
  tools: ToolSpec[]
  effort: EffortLevel
  signal: AbortSignal
  /**
   * Stable per-conversation key. Providers that route requests to cache
   * shards by key (OpenAI's `prompt_cache_key`) get more cache hits when every
   * request in one conversation shares it.
   */
  cacheKey: string
  /** True for long agent loops, where server-side context clearing pays off. */
  agentic: boolean
  onText: (delta: string) => void
  onReasoning: (delta: string) => void
}

export interface TurnResult {
  text: string
  calls: NeutralToolCall[]
  stop: 'end' | 'tool_use' | 'max_tokens' | 'refusal'
  usage: TokenUsage
  refusal?: string
  replay?: { adapter: string; modelId: string; data: unknown }
}

export interface Adapter {
  id: string
  /**
   * True when the adapter lets the provider clear stale tool output
   * server-side. The loop then leaves the in-flight transcript untouched —
   * editing earlier turns client-side would invalidate thinking-block
   * signatures on models that bind them to the conversation prefix.
   */
  managesContext: boolean
  turn(request: TurnRequest): Promise<TurnResult>
}

export const emptyUsage = (): TokenUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

/** Adds `b` into `a` in place and returns it. */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  a.input += b.input
  a.output += b.output
  a.cacheRead += b.cacheRead
  a.cacheWrite += b.cacheWrite
  return a
}

/**
 * An HTTP failure with its status kept, so the loop can tell a retryable
 * overload from a request that will fail the same way every time.
 */
export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs?: number
  ) {
    super(message)
    this.name = 'ProviderHttpError'
  }
}

export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined
}

/** Pulls a readable message out of a provider's JSON error body, whatever its shape. */
export function describeErrorBody(status: number, text: string): string {
  try {
    const body = JSON.parse(text) as {
      error?: { message?: string; metadata?: { raw?: string } } | string
      message?: string
      detail?: string | { msg?: string }[]
    }
    const nested = typeof body.error === 'object' ? body.error : undefined
    const message =
      (typeof body.error === 'string' ? body.error : nested?.message) ??
      body.message ??
      (typeof body.detail === 'string' ? body.detail : body.detail?.[0]?.msg)
    // OpenRouter wraps the upstream provider's own error in metadata.raw,
    // which is usually the only part that says what actually went wrong.
    const raw = nested?.metadata?.raw
    if (message) return `${status}: ${message}${raw && !message.includes(raw) ? ` — ${raw.slice(0, 300)}` : ''}`
  } catch {
    /* not JSON; fall through to the raw body */
  }
  return `${status}: ${text.slice(0, 300) || 'Request failed'}`
}
