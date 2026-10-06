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
  /**
   * The most output tokens the caller wants, as an app using Eaon's local
   * server asks (`max_tokens`). Lowers the adapter's own cap; never raises it.
   */
  outputCap?: number
}

/** An adapter's output cap, lowered to the caller's `outputCap` when there is one. */
export function capOutput(cap: number | undefined, computed: number | undefined): number | undefined {
  if (!cap || cap <= 0) return computed
  return computed ? Math.min(computed, cap) : cap
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

/**
 * Node's fetch gives up when no response has started within 5 minutes. A
 * local model on a CPU can spend that long reading a long prompt before its
 * first byte, and the failure is the same "fetch failed" as a server that is
 * not running — so it is told apart by its cause.
 */
export function isHeadersTimeout(error: unknown): boolean {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause
  return cause?.code === 'UND_ERR_HEADERS_TIMEOUT'
}

export const HEADERS_TIMEOUT_MESSAGE =
  'The model took more than 5 minutes to start answering, so the request was abandoned. The conversation may be too long for this machine — start a new chat, or use a smaller or faster model.'

/**
 * A tool call's arguments as the object the loop expects. Empty or `null`
 * means no arguments; a JSON string holding an object (double-encoded, as
 * some served models send) is unwrapped. Anything else is handed back as
 * `__invalid_json`, which the loop reports to the model — a non-object input
 * would otherwise throw inside the loop and end the turn.
 */
export function toolInput(raw: unknown): Record<string, unknown> {
  let value = raw
  if (typeof raw === 'string') {
    if (!raw.trim()) return {}
    try {
      value = JSON.parse(raw)
    } catch {
      return { __invalid_json: raw }
    }
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value)
      } catch {
        /* a bare string: invalid below */
      }
    }
  }
  if (value === null || value === undefined) return {}
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  return { __invalid_json: typeof raw === 'string' ? raw : JSON.stringify(raw) }
}

/** An image's cost, as the loop estimates it in `agent/context.ts`. */
const IMAGE_TOKENS = 1600

/**
 * Rough token count of a request body, for fitting the output cap into the
 * window. Inline images count at a flat rate: counted as text, the base64 of
 * a few screenshots "filled" the window and pinned the cap at its floor.
 */
export function estimateRequestTokens(value: unknown): number {
  let images = 0
  const text = JSON.stringify(value, function (this: unknown, key: string, item: unknown) {
    if (typeof item !== 'string' || item.length < 256) return item
    // Anthropic's base64 sources; `data:` URLs on the OpenAI formats.
    if ((key === 'data' && (this as { type?: unknown }).type === 'base64') || /^data:[^,]{1,100};base64,/.test(item.slice(0, 128))) {
      images++
      return ''
    }
    return item
  })
  return Math.ceil((text?.length ?? 0) / 3.6) + images * IMAGE_TOKENS
}

/**
 * An output cap that still fits the window. Hosts that serve from vLLM (most
 * of the open-model inference providers) reject a request outright when
 * prompt + `max_tokens` exceeds the context length, and catalogs often list a
 * model's output limit as its whole window.
 */
export function clampOutputToWindow(maxOutput: number | undefined, window: number, inputTokens: number): number | undefined {
  if (!maxOutput) return undefined
  // Never above the model's own cap; never squeezed below a usable reply.
  return Math.min(maxOutput, Math.max(1024, window - inputTokens - 4096))
}

/** Delay a 429/503 asks for: `retry-after-ms` (OpenAI, Codex) wins over `retry-after`. */
export function retryAfterFrom(headers: Headers): number | undefined {
  const ms = Number(headers.get('retry-after-ms'))
  if (headers.get('retry-after-ms') !== null && Number.isFinite(ms)) return Math.max(0, ms)
  return parseRetryAfter(headers.get('retry-after'))
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
