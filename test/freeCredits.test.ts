import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  dayOf,
  looksLikeCode,
  normalizeCode,
  FREE_LIMITS,
  FREE_PERIOD_MS,
  freeEnded,
  freeEndsAt,
  FREE_PROVIDER_ID,
  limitHit,
  nextMidnight,
  OFFER_EVERY_MS,
  OFFER_MAX,
  shouldOffer,
  usageAt,
  withRequest,
  withTokens,
  type FreeUsage
} from '@shared/freeCredits'
import { activeCode, addFreeTokens, forgetCode, forgetFreeModelServed, freeCreditsStatus, freeDeviceId, freeModelServed, redeemFreeCode, takeFreeRequest, withFreeLimits } from '../src/main/freeCredits'
import { claimFreeCredits } from '../src/main/features/freeCredits'
import { credentialAttempts } from '../src/main/providers/credentials'
import { secrets } from '../src/main/secrets'
import { adapterFor, getProvider, listProviders } from '../src/main/providers'
import { providerReadiness } from '@shared/modelSelection'
import { ProviderIssueError } from '../src/main/providers/errors'
import { ProviderHttpError, type Adapter, type TurnRequest } from '../src/main/providers/adapters/types'
import { store } from '../src/main/store'

/**
 * Eaon Free: the offer, and the daily allowance in front of every request to
 * the free gateway. Nothing here reaches the network; the store lives in a
 * throwaway folder (test/stubs/electron.ts).
 */

const NOW = new Date(2026, 9, 12, 15, 30).getTime()
const fresh = (over: Partial<FreeUsage> = {}): FreeUsage => ({ day: dayOf(NOW), requests: 0, tokens: 0, recent: [], ...over })

test('the limits are the generous ones agreed: 150 requests and 2M tokens a day, 20 a minute', () => {
  assert.deepEqual({ ...FREE_LIMITS }, { requestsPerDay: 150, tokensPerDay: 2_000_000, requestsPerMinute: 20 })
})

test('a new day starts at zero, at local midnight', () => {
  const used = fresh({ requests: 150, tokens: 2_000_000 })
  assert.equal(usageAt(used, NOW).requests, 150)
  const midnight = nextMidnight(NOW)
  assert.equal(new Date(midnight).getHours(), 0)
  assert.equal(dayOf(midnight), dayOf(NOW + 24 * 3_600_000))
  assert.deepEqual(usageAt(used, midnight), { day: dayOf(midnight), requests: 0, tokens: 0, recent: [] })
  assert.equal(usageAt(null, NOW).requests, 0, 'no file yet is nothing used')
})

test('the day is used up by requests or by tokens, and says when it starts over', () => {
  const byRequests = limitHit(fresh({ requests: 150 }), NOW)
  assert.deepEqual(byRequests, { kind: 'day', reason: 'requests', retryAfterMs: nextMidnight(NOW) - NOW })
  assert.equal(limitHit(fresh({ tokens: 2_000_000 }), NOW)?.kind, 'day')
  assert.equal(limitHit(fresh({ requests: 149, tokens: 1_999_999 }), NOW), null, 'just under both is fine')
})

test('the minute limit waits for the oldest of the last 20 requests to age out', () => {
  const recent = Array.from({ length: 20 }, (_, i) => NOW - 50_000 + i * 1000)
  const hit = limitHit(usageAt(fresh({ recent }), NOW), NOW)
  assert.deepEqual(hit, { kind: 'minute', retryAfterMs: 10_000 })
  // Older than a minute no longer counts.
  assert.equal(limitHit(usageAt(fresh({ recent }), NOW + 10_000), NOW + 10_000), null)
})

test('a request counts when it starts, its tokens when it ends', () => {
  const after = withTokens(withRequest(fresh(), NOW), 1234.4)
  assert.equal(after.requests, 1)
  assert.equal(after.tokens, 1234)
  assert.deepEqual(after.recent, [NOW])
  assert.equal(withTokens(fresh(), Number.NaN).tokens, 0)
})

test('the offer shows three times at most, days apart, and never once claimed', () => {
  const base = { claimed: false, offered: 0, lastOfferedAt: null }
  assert.equal(shouldOffer(base, NOW), true)
  assert.equal(shouldOffer({ ...base, claimed: true }, NOW), false)
  assert.equal(shouldOffer({ ...base, offered: 1, lastOfferedAt: NOW - OFFER_EVERY_MS + 1 }, NOW), false)
  assert.equal(shouldOffer({ ...base, offered: 1, lastOfferedAt: NOW - OFFER_EVERY_MS }, NOW), true)
  assert.equal(shouldOffer({ ...base, offered: OFFER_MAX, lastOfferedAt: 0 }, NOW), false)
})

test('Eaon Free is not listed, or usable, until it is claimed', () => {
  store.patchSettings({ freeCredits: { claimed: false, claimedAt: null, offered: 0, lastOfferedAt: null } })
  assert.equal(listProviders().some((p) => p.id === FREE_PROVIDER_ID), false)
  assert.equal(getProvider(FREE_PROVIDER_ID), undefined)

  store.patchSettings({ freeCredits: { claimed: true, claimedAt: NOW, offered: 1, lastOfferedAt: NOW } })
  const free = getProvider(FREE_PROVIDER_ID)!
  assert.ok(free)
  assert.equal(free.baseUrl, 'https://gateway.eaon.dev/v1')
  assert.equal(free.auth, 'none')
  assert.equal(free.hasKey, true, 'ready without a key')
  assert.ok(free.models.some((m) => m.id === 'claude-haiku-5-5'))
  assert.ok(listProviders().some((p) => p.id === FREE_PROVIDER_ID))
})

const stubTurn = (calls: { n: number }): Adapter => ({
  id: 'stub',
  managesContext: false,
  async turn() {
    calls.n++
    return { text: 'ok', toolCalls: [], usage: { input: 900, output: 100, cacheRead: 0, cacheWrite: 0 }, stopReason: 'end' } as never
  }
})

test('every request is counted, tokens included, and the day ends with a clear refusal', async () => {
  store.patchSettings({ freeCredits: { claimed: true, claimedAt: Date.now(), offered: 1, lastOfferedAt: Date.now() } })
  store.setJson('free-credits.json', { day: '', requests: 0, tokens: 0, recent: [] })
  const calls = { n: 0 }
  const limited = withFreeLimits(stubTurn(calls))
  const request = { signal: new AbortController().signal } as TurnRequest
  await limited.turn(request)
  let status = freeCreditsStatus()
  assert.equal(status.requests, 1)
  assert.equal(status.tokens, 1000)

  // The rest of today's allowance gone: refused before anything is sent.
  store.setJson('free-credits.json', { day: dayOf(Date.now()), requests: 150, tokens: 5000, recent: [] })
  await assert.rejects(limited.turn(request), (error: unknown) => {
    assert.ok(error instanceof ProviderIssueError)
    assert.equal(error.issue.kind, 'rate-limit', 'it ends at midnight, so Eaon Free is not left needing attention')
    assert.equal(error.issue.action, 'choose-model')
    assert.match(error.issue.message, /used today's free Eaon credits \(150 requests a day\)/)
    return true
  })
  assert.equal(calls.n, 1, 'the refused request never reached the gateway')

  store.setJson('free-credits.json', { day: dayOf(Date.now()), requests: 3, tokens: 2_000_000, recent: [] })
  await assert.rejects(takeFreeRequest(new AbortController().signal), /2M tokens a day/)
  addFreeTokens(10)
  status = freeCreditsStatus()
  assert.equal(status.tokens, 2_000_010)
})

test('past 20 a minute the request waits its turn, and Stop ends the wait', async () => {
  const now = Date.now()
  store.patchSettings({ freeCredits: { claimed: true, claimedAt: now, offered: 1, lastOfferedAt: now } })
  const recent = Array.from({ length: 20 }, (_, i) => now - 59_900 + i)
  store.setJson('free-credits.json', { day: dayOf(now), requests: 20, tokens: 0, recent })
  const started = Date.now()
  await takeFreeRequest(new AbortController().signal)
  assert.ok(Date.now() - started >= 50, 'it waited for the oldest to age out')
  assert.equal(freeCreditsStatus().requests, 21)

  const full = Array.from({ length: 20 }, (_, i) => Date.now() - 1000 + i)
  store.setJson('free-credits.json', { day: dayOf(Date.now()), requests: 40, tokens: 0, recent: full })
  const stop = new AbortController()
  const waiting = takeFreeRequest(stop.signal)
  setTimeout(() => stop.abort(), 30)
  await assert.rejects(waiting, /Stopped by the user/)
})

test('the free provider’s adapter has the allowance in front of it; others do not', async () => {
  store.patchSettings({ freeCredits: { claimed: true, claimedAt: Date.now(), offered: 1, lastOfferedAt: Date.now() } })
  store.setJson('free-credits.json', { day: dayOf(Date.now()), requests: 150, tokens: 0, recent: [] })
  const free = getProvider(FREE_PROVIDER_ID)!
  const request = { provider: free, modelId: 'claude-haiku-5-5', signal: new AbortController().signal } as TurnRequest
  await assert.rejects(adapterFor(free).turn(request), ProviderIssueError)
  await assert.rejects(adapterFor(free, { track: false }).turn(request), ProviderIssueError, 'apps using Eaon’s local server are limited too')
})

test('requests carry no X-Eaon-App header, which makes the gateway ask for a signature', () => {
  store.patchSettings({ freeCredits: { claimed: true, claimedAt: NOW, offered: 1, lastOfferedAt: NOW } })
  const headers = Object.keys(getProvider(FREE_PROVIDER_ID)!.headers ?? {}).map((h) => h.toLowerCase())
  assert.ok(!headers.some((h) => h.startsWith('x-eaon-app') || h.startsWith('x-eaon-sig')), headers.join(', '))
})

test('the times the offer and the star popup keep survive saving settings', () => {
  // Their defaults are null; the settings check once dropped any number there,
  // so the week never ended and "days apart" never held.
  const saved = store.patchSettings({
    freeCredits: { claimed: true, claimedAt: NOW, offered: 1, lastOfferedAt: NOW },
    starPrompt: { ...store.getSettings().starPrompt, lastAskedAt: NOW }
  })
  assert.equal(saved.freeCredits.claimedAt, NOW)
  assert.equal(saved.freeCredits.lastOfferedAt, NOW)
  assert.equal(store.getSettings().starPrompt.lastAskedAt, NOW)
  // A number where an id belongs is still turned away.
  assert.equal(store.patchSettings({ selectedModelId: 5 as never }).selectedModelId, null)
})

test('the credits last a week from claiming them', () => {
  assert.equal(FREE_PERIOD_MS, 7 * 24 * 3_600_000)
  assert.equal(freeEndsAt(null), null)
  assert.equal(freeEndsAt(NOW), NOW + FREE_PERIOD_MS)
  assert.equal(freeEnded(null, NOW), false, 'not claimed is not ended')
  assert.equal(freeEnded(NOW, NOW + FREE_PERIOD_MS - 1), false)
  assert.equal(freeEnded(NOW, NOW + FREE_PERIOD_MS), true)
})

test('after the week, requests are refused before sending, and the picker and Settings say why', async () => {
  const claimedAt = Date.now() - FREE_PERIOD_MS - 60_000
  store.patchSettings({ freeCredits: { claimed: true, claimedAt, offered: 1, lastOfferedAt: claimedAt } })
  store.setJson('free-credits.json', { day: '', requests: 0, tokens: 0, recent: [] })

  const status = freeCreditsStatus()
  assert.equal(status.ended, true)
  assert.equal(status.endsAt, claimedAt + FREE_PERIOD_MS)

  const free = getProvider(FREE_PROVIDER_ID)!
  assert.ok(free, 'still listed, to say why it stopped')
  const readiness = providerReadiness(free)
  assert.equal(readiness.state, 'attention')
  assert.match(readiness.reason ?? '', /Your free week of Eaon credits ended on/)

  const calls = { n: 0 }
  await assert.rejects(withFreeLimits(stubTurn(calls)).turn({ signal: new AbortController().signal } as TurnRequest), (error: unknown) => {
    assert.ok(error instanceof ProviderIssueError)
    assert.equal(error.issue.kind, 'quota')
    assert.match(error.issue.message, /free week of Eaon credits ended on .*Pick another model/)
    return true
  })
  assert.equal(calls.n, 0, 'nothing reached the gateway')
  assert.equal(freeCreditsStatus().requests, 0, 'and nothing was counted')

  // Still in the week: ready.
  store.patchSettings({ freeCredits: { claimed: true, claimedAt: Date.now() - FREE_PERIOD_MS + 60_000, offered: 1, lastOfferedAt: 0 } })
  assert.equal(providerReadiness(getProvider(FREE_PROVIDER_ID)!).state, 'ready')
})

/* ------------------------------------------------------------ event codes */

const fakeGateway =
  (status: number, body: unknown, seen: { url?: string; init?: RequestInit } = {}): typeof fetch =>
  async (url, init) => {
    seen.url = String(url)
    seen.init = init
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }

const HACK = { name: 'Eaon Hack 2026', endsAt: Date.now() + 3 * 86_400_000, limits: { requestsPerDay: 150, tokensPerDay: 2_000_000, requestsPerMinute: 20 } }

test('a code is read however it is typed, and junk is never sent', async () => {
  assert.equal(normalizeCode('  eaon hack_7kq2 '), 'EAON-HACK-7KQ2')
  assert.equal(looksLikeCode('EAON-HACK-7KQ2'), true)
  assert.equal(looksLikeCode('HI'), false)
  const seen: { url?: string } = {}
  const result = await redeemFreeCode('hi', fakeGateway(200, { code: HACK }, seen))
  assert.equal(result.ok, false)
  assert.equal(seen.url, undefined, 'nothing went to the gateway')
})

test('a code day is UTC’s, as the gateway counts it', () => {
  const at = Date.UTC(2026, 9, 12, 23, 30)
  assert.equal(dayOf(at, true), '2026-10-12')
  assert.equal(nextMidnight(at, true), Date.UTC(2026, 9, 13))
})

test('redeeming checks the code with the gateway and keeps it in the key store', async () => {
  forgetCode()
  const seen: { url?: string; init?: RequestInit } = {}
  const result = await redeemFreeCode(' eaon-abcd-efgh-jkmn ', fakeGateway(200, { code: HACK, today: { requests: 0, tokens: 0 } }, seen))
  assert.equal(result.ok, true)
  assert.equal(seen.url, 'https://gateway.eaon.dev/v1/codes/redeem')
  assert.deepEqual(JSON.parse(String(seen.init?.body)), { code: 'EAON-ABCD-EFGH-JKMN' })
  const device = (seen.init?.headers as Record<string, string>)['X-Eaon-Device']
  assert.match(device, /^eaon-[\w-]{20,}$/, 'a random ID for this install')
  assert.equal(secrets.get(FREE_PROVIDER_ID), 'EAON-ABCD-EFGH-JKMN', 'kept encrypted, as Eaon Free’s key')
  assert.deepEqual(activeCode(), HACK)

  // Requests carry the code as the gateway key, and the device ID.
  store.patchSettings({ freeCredits: { claimed: true, claimedAt: Date.now(), offered: 1, lastOfferedAt: Date.now() } })
  const free = getProvider(FREE_PROVIDER_ID)!
  assert.equal(free.headers?.['X-Eaon-Device'], device)
  assert.deepEqual(await credentialAttempts(free), [{ apiKey: 'EAON-ABCD-EFGH-JKMN' }])
  assert.equal(freeDeviceId(), device, 'the same ID every time')
  forgetCode()
  assert.equal(secrets.has(FREE_PROVIDER_ID), false)
  assert.equal(getProvider(FREE_PROVIDER_ID)!.headers?.['X-Eaon-Device'], undefined, 'no device ID without a code')
  assert.deepEqual(await credentialAttempts(getProvider(FREE_PROVIDER_ID)!), [{}])
})

test('the gateway’s own words come back when a code doesn’t work', async () => {
  forgetCode()
  const bad = await redeemFreeCode('EAON-AAAA-BBBB-CCCC', fakeGateway(404, { error: { message: "That code isn't valid. Check it and try again." } }))
  assert.deepEqual(bad, { ok: false, message: "That code isn't valid. Check it and try again." })
  const offline = await redeemFreeCode('EAON-AAAA-BBBB-CCCC', async () => {
    throw new TypeError('fetch failed')
  })
  assert.equal(offline.ok, false)
  assert.match((offline as { message: string }).message, /Couldn’t reach Eaon/)
  assert.equal(secrets.has(FREE_PROVIDER_ID), false, 'nothing kept')
})

test('a code redeemed before its event starts says when it will work, in local time', async () => {
  forgetCode()
  const startsAt = new Date(2026, 10, 7, 0, 0).getTime()
  const early = await redeemFreeCode(
    'EAON-HACK-2026',
    fakeGateway(403, { error: { message: 'The code "Eaon Hack" isn\'t active yet. It works from 2026-11-07 08:00 UTC.', code: 'code_not_started', starts_at: startsAt } })
  )
  assert.deepEqual(early, { ok: false, message: 'That code isn’t active yet. It works from Saturday, November 7 at 12:00 AM.' })
  assert.equal(secrets.has(FREE_PROVIDER_ID), false)
})

test('with a code, the free week’s end no longer applies, and the code’s limits do', async () => {
  const weekAgo = Date.now() - FREE_PERIOD_MS - 60_000
  store.patchSettings({ freeCredits: { claimed: true, claimedAt: weekAgo, offered: 1, lastOfferedAt: weekAgo } })
  forgetCode()
  assert.equal(freeCreditsStatus().ended, true)
  await redeemFreeCode('EAON-ABCD-EFGH-JKMN', fakeGateway(200, { code: { ...HACK, limits: { requestsPerDay: 3, tokensPerDay: 50_000, requestsPerMinute: 20 } } }))
  const status = freeCreditsStatus()
  assert.equal(status.ended, false)
  assert.deepEqual(status.code, { name: 'Eaon Hack 2026', endsAt: HACK.endsAt })
  assert.equal(status.endsAt, HACK.endsAt)
  assert.equal(status.limits.requestsPerDay, 3)
  assert.equal(status.resetsAt, nextMidnight(Date.now(), true), 'starts over at midnight UTC')
  assert.equal(providerReadiness(getProvider(FREE_PROVIDER_ID)!).state, 'ready')

  store.setJson('free-credits.json', { day: dayOf(Date.now(), true), requests: 3, tokens: 0, recent: [] })
  await assert.rejects(takeFreeRequest(new AbortController().signal), (error: unknown) => {
    assert.ok(error instanceof ProviderIssueError)
    assert.match(error.issue.message, /today's credits from the code "Eaon Hack 2026" \(3 requests a day\)\. They start over at \d+:\d\d [AP]M/)
    return true
  })
  forgetCode()
})

test('a code that has ended is forgotten, and the week’s end applies again', async () => {
  const weekAgo = Date.now() - FREE_PERIOD_MS - 60_000
  store.patchSettings({ freeCredits: { claimed: true, claimedAt: weekAgo, offered: 1, lastOfferedAt: weekAgo } })
  await redeemFreeCode('EAON-ABCD-EFGH-JKMN', fakeGateway(200, { code: HACK }))
  assert.ok(activeCode())
  assert.equal(activeCode(HACK.endsAt), null)
  assert.equal(secrets.has(FREE_PROVIDER_ID), false)
  assert.equal(freeCreditsStatus().ended, true)
  const expired = await redeemFreeCode('EAON-ABCD-EFGH-JKMN', fakeGateway(200, { code: { ...HACK, endsAt: Date.now() - 1 } }))
  assert.equal(expired.ok, false, 'an ended code is not kept')
})

test('a code the gateway turned off says so, and is dropped', async () => {
  store.patchSettings({ freeCredits: { claimed: true, claimedAt: Date.now(), offered: 1, lastOfferedAt: Date.now() } })
  store.setJson('free-credits.json', { day: '', requests: 0, tokens: 0, recent: [] })
  await redeemFreeCode('EAON-ABCD-EFGH-JKMN', fakeGateway(200, { code: HACK }))
  const refusing: Adapter = {
    id: 'stub',
    managesContext: false,
    async turn() {
      throw new ProviderHttpError(401, 'The code "Eaon Hack 2026" has been turned off.')
    }
  }
  await assert.rejects(withFreeLimits(refusing).turn({ signal: new AbortController().signal } as TurnRequest), (error: unknown) => {
    assert.ok(error instanceof ProviderIssueError)
    assert.match(error.issue.message, /The code "Eaon Hack 2026" isn't active any more/)
    return true
  })
  assert.equal(activeCode(), null)
  assert.equal(secrets.has(FREE_PROVIDER_ID), false)
})

test('Eaon Free counts as served only when the gateway lists its model', async () => {
  const listing = (ids: string[]): typeof fetch => (async () => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 })) as unknown as typeof fetch
  forgetFreeModelServed()
  assert.equal(await freeModelServed(listing(['mimo-v2.6-flash-free', 'muse-spark-1.3-contributor-free']), NOW), false, 'the gateway as it is today: only the always-free models')
  forgetFreeModelServed()
  assert.equal(await freeModelServed(listing(['claude-haiku-5-5', 'mimo-v2.6-flash-free']), NOW), true)
  // One look holds for a while, then the gateway is asked again.
  assert.equal(await freeModelServed(listing([]), NOW + 60_000), true)
  assert.equal(await freeModelServed(listing([]), NOW + 11 * 60_000), false)
  forgetFreeModelServed()
  const offline = (async () => {
    throw new Error('offline')
  }) as unknown as typeof fetch
  assert.equal(await freeModelServed(offline, NOW), false, 'a gateway that can’t be reached doesn’t serve it')
  forgetFreeModelServed()
})

test('claiming keeps the model in use, the default included, and starts someone on Eaon Free only when nothing works and it is served', () => {
  const unclaimed = { claimed: false, claimedAt: null, offered: 1, lastOfferedAt: NOW }
  const choice = (s: ReturnType<typeof store.getSettings>): [string | null, string | null] => [s.selectedProviderId, s.selectedModelId]

  // No choice saved, running on Eaon Lite's default: it stays, saved as the choice, though Eaon Free sorts first once listed.
  store.saveProviderConfig({ 'eaon-gateway': { enabled: true } })
  store.patchSettings({ freeCredits: unclaimed, selectedProviderId: null, selectedModelId: null, favoriteModels: [], recentModels: [] })
  const kept = claimFreeCredits(true)
  assert.equal(kept.freeCredits.claimed, true)
  assert.deepEqual(choice(kept), ['eaon-gateway', 'mimo-v2.6-flash-free'])

  // A choice that works is left alone.
  store.patchSettings({ freeCredits: unclaimed, selectedProviderId: 'eaon-gateway', selectedModelId: 'muse-spark-1.3-contributor-free' })
  assert.deepEqual(choice(claimFreeCredits(true)), ['eaon-gateway', 'muse-spark-1.3-contributor-free'])

  // Nothing works (a model whose provider has no key): Eaon Free's model only if the gateway serves it.
  store.saveProviderConfig({ 'eaon-gateway': { enabled: false } })
  store.patchSettings({ freeCredits: unclaimed, selectedProviderId: 'anthropic', selectedModelId: 'claude-opus-5-5' })
  assert.deepEqual(choice(claimFreeCredits(false)), ['anthropic', 'claude-opus-5-5'], 'not moved onto a model that would refuse every request')
  store.patchSettings({ freeCredits: unclaimed })
  assert.deepEqual(choice(claimFreeCredits(true)), [FREE_PROVIDER_ID, 'claude-haiku-5-5'])

  store.saveProviderConfig({ 'eaon-gateway': { enabled: true } })
  store.patchSettings({ freeCredits: { claimed: false, claimedAt: null, offered: 0, lastOfferedAt: null }, selectedProviderId: null, selectedModelId: null })
})
