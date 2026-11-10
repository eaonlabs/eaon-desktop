import type { ChatMessage, TokenUsage } from './types'

/**
 * What a chat has used: the tokens its replies recorded (the same counts the
 * line under each reply shows), added up, by the model that wrote each reply.
 * A price is put on them only for a model whose price Eaon already knows
 * (the Tokn table Settings → Usage uses, priced in main/features/chatContext/
 * cost.ts); for any other, the tokens are shown and no dollar figure is made up.
 */

export interface ModelUsage {
  /** The model's id as the reply recorded it; '' for a reply from before the model was recorded. */
  model: string
  usage: TokenUsage
  /** How many replies it wrote that reported their tokens. */
  turns: number
}

export interface ChatUsage {
  total: TokenUsage
  /** Replies that reported their tokens. */
  turns: number
  /** Most tokens first. */
  byModel: ModelUsage[]
}

/** The cost worked out for a chat's models. */
export interface ChatCost {
  /** At published per-token rates, over the models that have a price; null when none has. */
  usd: number | null
  /** Models with no known price, with the tokens they used: not in `usd`. */
  unpriced: { model: string; tokens: number }[]
}

/** Every input token the replies used, cached or not. */
export const inputTokens = (u: TokenUsage): number => u.input + u.cacheRead + u.cacheWrite

/** All the tokens in, out and cached. */
export const allTokens = (u: TokenUsage): number => inputTokens(u) + u.output

/** The share of input that came from the provider's cache, as a whole percent. */
export function cachedPercent(u: TokenUsage): number {
  const input = inputTokens(u)
  return input > 0 ? Math.round((u.cacheRead / input) * 100) : 0
}

const empty = (): TokenUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

/** The chat's recorded usage, added up overall and per model. Replies that recorded no tokens are not counted. */
export function chatUsage(messages: readonly Pick<ChatMessage, 'role' | 'model' | 'usage'>[]): ChatUsage {
  const total = empty()
  const models = new Map<string, ModelUsage>()
  let turns = 0
  for (const message of messages) {
    const u = message.usage
    if (message.role !== 'assistant' || !u || allTokens(u) === 0) continue
    turns++
    const key = message.model ?? ''
    const row = models.get(key) ?? { model: key, usage: empty(), turns: 0 }
    row.turns++
    for (const field of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
      total[field] += u[field]
      row.usage[field] += u[field]
    }
    models.set(key, row)
  }
  return { total, turns, byModel: [...models.values()].sort((a, b) => allTokens(b.usage) - allTokens(a.usage)) }
}

/** 54,210 → "54k", 1,048,576 → "1.0M"; below a thousand, as it is. */
export function compactCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1000) return `${(count / 1000).toFixed(count >= 100_000 ? 0 : 1)}k`
  return String(count)
}

/** A dollar figure: "$1.24", "$0.07", and "less than $0.01" below a cent, so a real cost is never shown as nothing. */
export function usd(amount: number): string {
  if (amount > 0 && amount < 0.01) return 'less than $0.01'
  return `$${amount.toFixed(2)}`
}
