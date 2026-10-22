/**
 * Eaon Free: models on Eaon's own gateway, free to anyone who claims them
 * from the offer (components/FreeCreditsOffer.tsx), with no key or account.
 * Claimed, they last a week; each day of it has an allowance per computer,
 * counted here and enforced in main/freeCredits.ts before every request.
 *
 * The offer never depends on starring the repository: GitHub's Acceptable
 * Use Policies forbid rewarding stars with credits. The first time it comes
 * up, the star popup is shown just before it, and the offer follows whatever
 * the answer was.
 */

export const FREE_PROVIDER_ID = 'eaon-free'
/**
 * Eaon's always-free models on the same gateway (the ones Eaon Code offers):
 * no claim, no week and no key. The gateway decides which they are and keeps
 * its own limits.
 */
export const GATEWAY_PROVIDER_ID = 'eaon-gateway'
export const FREE_BASE_URL = 'https://gateway.eaon.dev/v1'
/** Where an event code is checked (the gateway's openai-gateway/codes.js). */
export const FREE_REDEEM_PATH = '/codes/redeem'
/** A random ID per install, sent with a code so each device gets its own allowance at a venue that shares one IP. */
export const FREE_DEVICE_HEADER = 'X-Eaon-Device'
/** The model the offer sets up when nothing else is chosen. */
export const FREE_DEFAULT_MODEL = 'claude-haiku-5-5'

/** Per computer. A day is the computer's own calendar day; it resets at local midnight. */
export const FREE_LIMITS = {
  requestsPerDay: 150,
  tokensPerDay: 2_000_000,
  requestsPerMinute: 20
} as const

/** How long the credits last from claiming them. */
export const FREE_DAYS = 7
export const FREE_PERIOD_MS = FREE_DAYS * 24 * 60 * 60 * 1000

export type FreeLimits = { requestsPerDay: number; tokensPerDay: number; requestsPerMinute: number }

/** What has been used, kept in free-credits.json. */
export interface FreeUsage {
  /** The local day the counts are for, "2026-10-12". */
  day: string
  requests: number
  tokens: number
  /** When the requests of the last minute started, oldest first. */
  recent: number[]
}

/**
 * A redeemed event code (a hackathon's, say). While it lasts, Eaon Free has
 * the code's daily limits and no 7-day end; the gateway enforces them too,
 * by its own day, which starts at 00:00 UTC.
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

/** Settings → Model providers → Eaon Free, and the offer card. */
export interface FreeCreditsStatus {
  claimed: boolean
  limits: FreeLimits
  /** Today's use. */
  requests: number
  tokens: number
  /** When today's allowance starts over. */
  resetsAt: number
  /** When the free week ends, once claimed. */
  endsAt: number | null
  /** The free week is over. */
  ended: boolean
  /** The event code in use, which replaces the week and its limits until it ends. */
  code: { name: string; endsAt: number } | null
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

/** When credits claimed at `claimedAt` stop working (null: not claimed). */
export const freeEndsAt = (claimedAt: number | null): number | null => (claimedAt === null ? null : claimedAt + FREE_PERIOD_MS)

/** Whether the free week that started at `claimedAt` is over. */
export function freeEnded(claimedAt: number | null, now: number): boolean {
  const end = freeEndsAt(claimedAt)
  return end !== null && now >= end
}

/** "October 19": the end of the free week as the card, Settings and the refusal write it. */
export const formatEndDay = (at: number): string => new Date(at).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })

/** What a request says once the free week is over. */
export const weekOverMessage = (endsAt: number): string =>
  `Your free week of Eaon credits ended on ${formatEndDay(endsAt)}. Pick another model, or add an API key in Settings → Model providers.`

/** "2M", "150": the allowance as the card and settings write it. */
export function formatAllowance(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}K`
  return n.toLocaleString('en-US')
}

/** What a day's limit says when it is reached; with a code, `startsOver` is when (a local time), since its day is UTC's. */
export function dayLimitMessage(reason: 'requests' | 'tokens', limits: FreeLimits = FREE_LIMITS, code?: { name: string; startsOver: string }): string {
  const what = reason === 'requests' ? `${limits.requestsPerDay} requests` : `${formatAllowance(limits.tokensPerDay)} tokens`
  if (code) return `You've used today's credits from the code "${code.name}" (${what} a day). They start over at ${code.startsOver}; until then, pick another model.`
  return `You've used today's free Eaon credits (${what} a day). They start over at midnight; until then, pick another model.`
}

/** The offer card: shown at most three times, three days apart, until claimed. */
export const OFFER_MAX = 3
export const OFFER_EVERY_MS = 3 * 24 * 60 * 60 * 1000
/** How long the app is used, in front, before the cards come up in a session. */
export const OFFER_AFTER_MS = 30_000

/** What the offer timer gets back: whether to offer, and whether the star popup goes first (or alone, without an offer). */
export interface OfferPlan {
  offer: boolean
  starFirst: boolean
}

export function shouldOffer(state: { claimed: boolean; offered: number; lastOfferedAt: number | null }, now: number): boolean {
  if (state.claimed || state.offered >= OFFER_MAX) return false
  return state.lastOfferedAt === null || now - state.lastOfferedAt >= OFFER_EVERY_MS
}
