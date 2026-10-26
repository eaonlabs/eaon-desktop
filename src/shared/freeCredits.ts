/**
 * Eaon Event: models on Eaon's own gateway for an event Eaon sponsors (a
 * hackathon, a workshop), opened by the event's code. Redeemed in Settings →
 * Model providers → Eaon Event, a code lists the provider until it ends, with
 * the code's daily allowance per computer, counted here and enforced in
 * main/freeCredits.ts before every request. There is nothing to claim
 * without a code: Eaon's free models for everyone are Eaon Lite.
 *
 * (It was Eaon Free, a free week anyone could claim from a card. The id stays
 * `eaon-free`, so a code redeemed before keeps working.)
 */

export const FREE_PROVIDER_ID = 'eaon-free'
/**
 * Eaon Lite: Eaon's always-free models on the same gateway (the ones Eaon
 * Code offers), for everyone, with no code and no key. The gateway decides
 * which they are and keeps its own limits.
 */
export const GATEWAY_PROVIDER_ID = 'eaon-gateway'
export const FREE_BASE_URL = 'https://gateway.eaon.dev/v1'
/** Where an event code is checked (the gateway's openai-gateway/codes.js). */
export const FREE_REDEEM_PATH = '/codes/redeem'
/** A random ID per install, sent with a code so each device gets its own allowance at a venue that shares one IP. */
export const FREE_DEVICE_HEADER = 'X-Eaon-Device'
/** The model a code sets up when nothing else is chosen, if the code's gateway list has it. */
export const FREE_DEFAULT_MODEL = 'claude-haiku-5-5'

/** A code's allowance per computer, when the gateway's answer leaves one out. */
export const FREE_LIMITS = {
  requestsPerDay: 150,
  tokensPerDay: 2_000_000,
  requestsPerMinute: 20
} as const

export type FreeLimits = { requestsPerDay: number; tokensPerDay: number; requestsPerMinute: number }

/** What has been used, kept in free-credits.json. */
export interface FreeUsage {
  /** The day the counts are for, "2026-10-12": UTC's, as the gateway counts a code's. */
  day: string
  requests: number
  tokens: number
  /** When the requests of the last minute started, oldest first. */
  recent: number[]
}

/**
 * A redeemed event code (a hackathon's, say). While it lasts, Eaon Event is
 * listed with the code's daily limits; the gateway enforces them too, by its
 * own day, which starts at 00:00 UTC.
 */
export interface FreeCode {
  name: string
  endsAt: number
  limits: FreeLimits
}

/** What redeeming a code came to. */
export type RedeemResult = { ok: true; code: FreeCode } | { ok: false; message: string }

/** "eaon-hack 7kq2" → "EAON-HACK-7KQ2", as the gateway stores it. */
export const normalizeCode = (value: string): string =>
  value.trim().toUpperCase().replace(/[\s_]+/g, '-').replace(/-+/g, '-')

export const looksLikeCode = (value: string): boolean => /^[A-Z0-9][A-Z0-9-]{6,38}[A-Z0-9]$/.test(value)

/** Settings → Model providers → Eaon Event. */
export interface FreeCreditsStatus {
  /** The event code in use; without one there is no Eaon Event. */
  code: { name: string; endsAt: number } | null
  /** The code's allowance per computer (the default when there is no code). */
  limits: FreeLimits
  /** Today's use. */
  requests: number
  tokens: number
  /** When today's allowance starts over: midnight UTC. */
  resetsAt: number
}

/** The day `now` falls in: the computer's own, or UTC's (an event code's, as the gateway counts it). */
export function dayOf(now: number, utc = false): string {
  const d = new Date(now)
  if (utc) return d.toISOString().slice(0, 10)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** The next midnight after `now`, local or UTC. */
export function nextMidnight(now: number, utc = false): number {
  const d = new Date(now)
  if (utc) return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
  d.setHours(24, 0, 0, 0)
  return d.getTime()
}

/** `usage` as of `now`: a new day starts at zero, and the minute's list drops what is older than a minute. */
export function usageAt(usage: FreeUsage | null | undefined, now: number, utc = false): FreeUsage {
  const day = dayOf(now, utc)
  const recent = (usage?.recent ?? []).filter((at) => typeof at === 'number' && at > now - 60_000 && at <= now)
  if (!usage || usage.day !== day) return { day, requests: 0, tokens: 0, recent }
  return { day, requests: Math.max(0, usage.requests | 0), tokens: Math.max(0, usage.tokens | 0), recent }
}

export type FreeLimitHit =
  /** Today's requests or tokens are used up: wait for midnight, or use another model. */
  | { kind: 'day'; reason: 'requests' | 'tokens'; retryAfterMs: number }
  /** Too many requests this minute: wait this long, then go on. */
  | { kind: 'minute'; retryAfterMs: number }

/** Whether one more request may start now, and if not, which limit stops it. */
export function limitHit(usage: FreeUsage, now: number, limits: FreeLimits = FREE_LIMITS, utc = false): FreeLimitHit | null {
  if (usage.requests >= limits.requestsPerDay) return { kind: 'day', reason: 'requests', retryAfterMs: nextMidnight(now, utc) - now }
  if (usage.tokens >= limits.tokensPerDay) return { kind: 'day', reason: 'tokens', retryAfterMs: nextMidnight(now, utc) - now }
  if (usage.recent.length >= limits.requestsPerMinute) {
    const oldest = usage.recent[usage.recent.length - limits.requestsPerMinute]
    return { kind: 'minute', retryAfterMs: Math.max(250, oldest + 60_000 - now) }
  }
  return null
}

/** A request started now. */
export function withRequest(usage: FreeUsage, now: number): FreeUsage {
  return { ...usage, requests: usage.requests + 1, recent: [...usage.recent, now] }
}

/** Tokens a reply used, added to the day it finished on. */
export function withTokens(usage: FreeUsage, tokens: number): FreeUsage {
  return { ...usage, tokens: usage.tokens + Math.max(0, Math.round(tokens) || 0) }
}

/** "October 19": the day a code ends, as Settings and the refusal write it. */
export const formatEndDay = (at: number): string => new Date(at).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })

/** "2M", "150": the allowance as Settings writes it. */
export function formatAllowance(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}K`
  return n.toLocaleString('en-US')
}

/** What a day's limit says when it is reached: `startsOver` is when, in local time, since a code's day is UTC's. */
export function dayLimitMessage(reason: 'requests' | 'tokens', limits: FreeLimits, code: { name: string; startsOver: string }): string {
  const what = reason === 'requests' ? `${limits.requestsPerDay} requests` : `${formatAllowance(limits.tokensPerDay)} tokens`
  return `You've used today's credits from the code "${code.name}" (${what} a day). They start over at ${code.startsOver}; until then, pick another model.`
}
