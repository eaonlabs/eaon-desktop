import { randomUUID } from 'node:crypto'
import {
  dayLimitMessage,
  FREE_BASE_URL,
  FREE_DEFAULT_MODEL,
  FREE_DEVICE_HEADER,
  FREE_LIMITS,
  FREE_PROVIDER_ID,
  FREE_REDEEM_PATH,
  freeEnded,
  freeEndsAt,
  limitHit,
  looksLikeCode,
  nextMidnight,
  normalizeCode,
  usageAt,
  withRequest,
  weekOverMessage,
  withTokens,
  type FreeCode,
  type FreeCreditsStatus,
  type FreeLimits,
  type FreeUsage,
  type RedeemResult
} from '@shared/freeCredits'
import type { ProviderIssue } from '@shared/providers'
import type { Adapter } from './providers/adapters/types'
import { ProviderHttpError } from './providers/adapters/types'
import { isCertificateError, ProviderIssueError } from './providers/errors'
import { secrets } from './secrets'
import { store } from './store'
import { gatewayBaseUrl } from './eaonAddress'
import { providerFetch } from './providers/safeFetch'

/** How Eaon Free's own calls reach the gateway: signed, like every request to it (gatewaySignature.ts). */
type GatewayRequest = (url: string, init: RequestInit) => Promise<Response>

/**
 * Eaon Free's week, and its daily allowance on this computer
 * (shared/freeCredits.ts). Every request to the free gateway goes through
 * `withFreeLimits`: after the week, or past the day's requests or tokens, it
 * is refused before it is sent; past the minute's it waits its turn. The
 * gateway keeps its own limits as well.
 *
 * An event code replaces the week: redeemed, it is kept in the key store as
 * Eaon Free's key (so it goes out as the gateway key), with a random ID for
 * this install in `X-Eaon-Device`, and its limits apply until it ends. Its
 * days are UTC's, as the gateway counts them.
 */

const FILE = 'free-credits.json'
const CODE_FILE = 'free-credits-code.json'
const DEVICE_FILE = 'free-credits-device.json'
const EMPTY: FreeUsage = { day: '', requests: 0, tokens: 0, recent: [] }

/** Where the gateway is; the end-to-end tests point it at a local copy of the gateway. */
export const freeBaseUrl = gatewayBaseUrl

/** The event code in use, if any; one that has ended is forgotten here. */
export function activeCode(now = Date.now()): FreeCode | null {
  const code = store.getJson<FreeCode | null>(CODE_FILE, null)
  if (!code || typeof code.endsAt !== 'number') return null
  if (now >= code.endsAt) {
    forgetCode()
    return null
  }
  if (!secrets.has(FREE_PROVIDER_ID)) {
    // A vault that can't be read right now (a locked keyring, Safe Storage
    // access denied) has no key in it either; the code is only gone when the
    // vault could be read and doesn't hold it. Otherwise it is kept for when
    // the keychain unlocks, rather than losing an event's code for good.
    if (secrets.readable()) forgetCode()
    return null
  }
  return code
}

export function forgetCode(): void {
  store.setJson(CODE_FILE, null)
  if (secrets.has(FREE_PROVIDER_ID)) secrets.clear(FREE_PROVIDER_ID)
}

/** This install's random ID, made the first time a code is redeemed. */
export function freeDeviceId(): string {
  const saved = store.getJson<{ id?: string }>(DEVICE_FILE, {})
  if (typeof saved.id === 'string' && /^[\w-]{16,64}$/.test(saved.id)) return saved.id
  const id = `eaon-${randomUUID()}`
  store.setJson(DEVICE_FILE, { id })
  return id
}

/** How long one look at the gateway's model list holds, so the offer doesn't ask it every time. */
const SERVED_TTL_MS = 10 * 60_000
let served: { at: number; ok: boolean } | null = null

/**
 * Whether the gateway serves Eaon Free's model now. The gateway decides which
 * models it serves, and it has stopped serving this one before: offering it
 * then set people up on a model that refused every request. So the offer and
 * the claim ask first, the way Eaon Free's own model list does (with the
 * event code's key, when there is one). A gateway that can't be reached
 * counts as not serving it.
 */
export async function freeModelServed(request: GatewayRequest = providerFetch, now = Date.now()): Promise<boolean> {
  if (served && now - served.at < SERVED_TTL_MS) return served.ok
  let ok = false
  try {
    const key = secrets.get(FREE_PROVIDER_ID)
    const response = await request(`${freeBaseUrl()}/models`, {
      headers: { ...freeHeaders(), ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      signal: AbortSignal.timeout(8000)
    })
    if (response.ok) {
      const body = (await response.json()) as { data?: { id?: unknown }[] }
      ok = Array.isArray(body.data) && body.data.some((model) => model?.id === FREE_DEFAULT_MODEL)
    }
  } catch {
    ok = false
  }
  served = { at: now, ok }
  return ok
}

/** Forgets the last look, for after a code is redeemed (and for tests). */
export const forgetFreeModelServed = (): void => {
  served = null
}

/**
 * Asks the gateway now, whatever it said a moment ago. Claiming starts the
 * free week, so it goes by whether the model is served now, not by a look
 * from before the gateway stopped serving it.
 */
export const freeModelServedNow = (request: GatewayRequest = providerFetch, now = Date.now()): Promise<boolean> => {
  forgetFreeModelServed()
  return freeModelServed(request, now)
}

/** The headers Eaon Free's requests carry: none without a code. Their signature is added as they go (gatewaySignature.ts). */
export const freeHeaders = (): Record<string, string> => (activeCode() ? { [FREE_DEVICE_HEADER]: freeDeviceId() } : {})

const read = (now: number, utc = false): FreeUsage => usageAt(store.getJson<FreeUsage>(FILE, EMPTY), now, utc)
const write = (usage: FreeUsage): void => store.setJson(FILE, usage)

export function freeCreditsStatus(now = Date.now(), limits: FreeLimits = FREE_LIMITS): FreeCreditsStatus {
  const code = activeCode(now)
  const usage = read(now, Boolean(code))
  const { claimed, claimedAt } = store.getSettings().freeCredits
  const start = claimed ? claimedAt : null
  return {
    claimed,
    limits: code?.limits ?? limits,
    requests: usage.requests,
    tokens: usage.tokens,
    resetsAt: nextMidnight(now, Boolean(code)),
    endsAt: code ? code.endsAt : freeEndsAt(start),
    ended: code ? false : freeEnded(start, now),
    code: code ? { name: code.name, endsAt: code.endsAt } : null
  }
}

/** Once the free week is over (and no code carries on from it): what a request, the model picker and Settings say. */
export function freeWeekOver(now = Date.now()): ProviderIssue | null {
  if (activeCode(now)) return null
  const { claimed, claimedAt } = store.getSettings().freeCredits
  const endsAt = freeEndsAt(claimed ? claimedAt : null)
  if (endsAt === null || now < endsAt) return null
  return { kind: 'quota', message: weekOverMessage(endsAt), action: 'choose-model', providerId: FREE_PROVIDER_ID }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('Stopped by the user.'))
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop)
      resolve()
    }, ms)
    const stop = (): void => {
      clearTimeout(timer)
      reject(new Error('Stopped by the user.'))
    }
    signal.addEventListener('abort', stop, { once: true })
  })
}

const localTime = (at: number): string => new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

/** Takes one request from today's allowance, waiting out the minute's limit; throws when the week or the day's allowance is used up. */
export async function takeFreeRequest(signal: AbortSignal, limits: FreeLimits = FREE_LIMITS, now: () => number = Date.now): Promise<void> {
  for (;;) {
    const at = now()
    const over = freeWeekOver(at)
    if (over) throw new ProviderIssueError(over)
    const code = activeCode(at)
    const utc = Boolean(code)
    const allowance = code?.limits ?? limits
    const usage = read(at, utc)
    const hit = limitHit(usage, at, allowance, utc)
    if (!hit) {
      write(withRequest(usage, at))
      return
    }
    if (hit.kind === 'day') {
      // A rate limit, not a quota: it ends at midnight, so the provider isn't left "Needs attention".
      throw new ProviderIssueError({
        kind: 'rate-limit',
        message: dayLimitMessage(hit.reason, allowance, code ? { name: code.name, startsOver: localTime(nextMidnight(at, true)) } : undefined),
        action: 'choose-model',
        providerId: FREE_PROVIDER_ID,
        retryAfterMs: hit.retryAfterMs
      })
    }
    await sleep(Math.min(hit.retryAfterMs, 60_000), signal)
  }
}

/** Counts a reply's tokens against today. */
export function addFreeTokens(tokens: number, now = Date.now()): void {
  write(withTokens(read(now, Boolean(activeCode(now))), tokens))
}

/** The gateway turned the code off or it ended there: say so, rather than "the key was rejected". */
const codeRefused = (error: unknown): boolean =>
  error instanceof ProviderHttpError && error.status === 401 && /code_ended|The code ".*" (ended|has been turned off)/.test(error.message)

/** The free gateway's adapter, with the allowance in front of it. */
export function withFreeLimits(adapter: Adapter): Adapter {
  return {
    ...adapter,
    async turn(request) {
      await takeFreeRequest(request.signal)
      const code = activeCode()
      let result: Awaited<ReturnType<Adapter['turn']>>
      try {
        result = await adapter.turn(request)
      } catch (error) {
        if (code && codeRefused(error)) {
          forgetCode()
          throw new ProviderIssueError({
            kind: 'auth-revoked',
            message: `The code "${code.name}" isn't active any more. Pick another model, or redeem a new code in Settings → Model providers → Eaon Free.`,
            action: 'choose-model',
            providerId: FREE_PROVIDER_ID
          })
        }
        throw error
      }
      const u = result.usage
      addFreeTokens(u.input + u.output + u.cacheRead + u.cacheWrite)
      return result
    }
  }
}

/** "Saturday, November 7 at 12:00 AM". */
const formatStart = (at: number): string =>
  `${new Date(at).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })} at ${localTime(at)}`

/**
 * Checks a code with the gateway and, when it works, keeps it: the key store
 * holds the code, `free-credits-code.json` what it gives.
 */
/** The gateway's answers about a code itself, whose words are shown as they come. */
const CODE_ERRORS = new Set(['invalid_code', 'code_ended', 'code_not_started', 'rate_limit_exceeded'])

export async function redeemFreeCode(typed: string, request: GatewayRequest = providerFetch): Promise<RedeemResult> {
  const code = normalizeCode(typed)
  if (!looksLikeCode(code)) return { ok: false, message: 'That doesn’t look like a code. Codes are 8 to 40 letters, digits and dashes.' }
  let response: Response
  try {
    response = await request(`${freeBaseUrl()}${FREE_REDEEM_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [FREE_DEVICE_HEADER]: freeDeviceId() },
      body: JSON.stringify({ code }),
      signal: AbortSignal.timeout(15_000)
    })
  } catch (error) {
    // A filtering school or company network fails here too; "check your connection" would send people round in circles.
    if (isCertificateError(error)) {
      return { ok: false, message: 'A network filter, a Wi-Fi sign-in page or the computer’s clock blocked the secure connection to Eaon. Check the date and time, sign in to the Wi-Fi if it asks, or try another network.' }
    }
    return { ok: false, message: 'Couldn’t reach Eaon to check the code. Check your connection and try again.' }
  }
  const body = (await response.json().catch(() => null)) as {
    code?: { name?: unknown; endsAt?: unknown; limits?: Partial<FreeLimits> }
    error?: { message?: unknown; code?: unknown; starts_at?: unknown }
  } | null
  if (!response.ok || !body?.code) {
    // Too early (an event's code before its first day): the start in this computer's time.
    const startsAt = body?.error?.code === 'code_not_started' ? body.error.starts_at : null
    if (typeof startsAt === 'number') return { ok: false, message: `That code isn’t active yet. It works from ${formatStart(startsAt)}.` }
    // Only the code's own errors are worded for this box. Anything else (a
    // gateway without the codes route answers "Send a model ID") is no
    // answer about the code at all.
    const said = typeof body?.error?.message === 'string' && CODE_ERRORS.has(String(body.error.code)) ? body.error.message : null
    return { ok: false, message: said ?? `Eaon couldn’t check the code right now (HTTP ${response.status}). Try again later.` }
  }
  const limits = body.code.limits ?? {}
  const whole = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback)
  const saved: FreeCode = {
    name: typeof body.code.name === 'string' && body.code.name ? body.code.name.slice(0, 48) : 'Event code',
    endsAt: whole(body.code.endsAt, Date.now()),
    limits: {
      requestsPerDay: whole(limits.requestsPerDay, FREE_LIMITS.requestsPerDay),
      tokensPerDay: whole(limits.tokensPerDay, FREE_LIMITS.tokensPerDay),
      requestsPerMinute: whole(limits.requestsPerMinute, FREE_LIMITS.requestsPerMinute)
    }
  }
  if (saved.endsAt <= Date.now()) return { ok: false, message: `The code "${saved.name}" has already ended.` }
  try {
    secrets.set(FREE_PROVIDER_ID, code)
  } catch (error) {
    // The gateway took the code; a locked or refused keychain is what failed,
    // and "Couldn't check the code" would send people retyping it.
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
  store.setJson(CODE_FILE, saved)
  return { ok: true, code: saved }
}

/** Whether the offer or its star popup came up this run: the star popup's own timer then waits for another day. */
let offeredThisRun = false
export const noteOffered = (): void => void (offeredThisRun = true)
export const wasOfferedThisRun = (): boolean => offeredThisRun
