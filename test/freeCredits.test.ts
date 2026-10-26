import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dayOf, looksLikeCode, normalizeCode, FREE_LIMITS, FREE_PROVIDER_ID, limitHit, nextMidnight, usageAt, withRequest, withTokens, type FreeUsage } from '@shared/freeCredits'
import { activeCode, addFreeTokens, forgetCode, freeCreditsStatus, freeDeviceId, leaveFreeWeek, redeemFreeCode, takeFreeRequest, withFreeLimits } from '../src/main/freeCredits'
import { chooseEventModel } from '../src/main/features/freeCredits'
import { credentialAttempts } from '../src/main/providers/credentials'
import { secrets } from '../src/main/secrets'
import { adapterFor, getProvider, listProviders } from '../src/main/providers'
import { providerReadiness } from '@shared/modelSelection'
import { ProviderIssueError } from '../src/main/providers/errors'
import { ProviderHttpError, type Adapter, type TurnRequest } from '../src/main/providers/adapters/types'
import { store } from '../src/main/store'

/**
 * Eaon Event: an event's code, and the daily allowance in front of every
 * request it opens. Nothing here reaches the network; the store lives in a
 * throwaway folder (test/stubs/electron.ts).
 */

const NOW = Date.UTC(2026, 9, 12, 15, 30)
const fresh = (over: Partial<FreeUsage> = {}): FreeUsage => ({ day: dayOf(NOW, true), requests: 0, tokens: 0, recent: [], ...over })

const fakeGateway =
  (status: number, body: unknown, seen: { url?: string; init?: RequestInit } = {}): typeof fetch =>
  async (url, init) => {
    seen.url = String(url)
    seen.init = init
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }

const HACK = { name: 'Eaon Hack 2026', endsAt: Date.now() + 3 * 86_400_000, limits: { requestsPerDay: 150, tokensPerDay: 2_000_000, requestsPerMinute: 20 } }

/** Redeems a code against a stand-in gateway. */
async function withCode(code: typeof HACK = HACK): Promise<void> {
  forgetCode()
  const result = await redeemFreeCode('EAON-ABCD-EFGH-JKMN', fakeGateway(200, { code }))
  assert.equal(result.ok, true)
}

const stubTurn = (calls: { n: number }): Adapter => ({
  id: 'stub',
  managesContext: false,
  async turn() {
    calls.n++
    return { text: 'ok', toolCalls: [], usage: { input: 900, output: 100, cacheRead: 0, cacheWrite: 0 }, stopReason: 'end' } as never
  }
})

/* ---------------------------------------------------------- the allowance */

test('a code without limits of its own gets 150 requests and 2M tokens a day, 20 a minute', () => {
  assert.deepEqual({ ...FREE_LIMITS }, { requestsPerDay: 150, tokensPerDay: 2_000_000, requestsPerMinute: 20 })
})

test('a code’s day is UTC’s, as the gateway counts it, and a new one starts at zero', () => {
  const at = Date.UTC(2026, 9, 12, 23, 30)
  assert.equal(dayOf(at, true), '2026-10-12')
  assert.equal(nextMidnight(at, true), Date.UTC(2026, 9, 13))
  const used = fresh({ requests: 150, tokens: 2_000_000 })
  assert.equal(usageAt(used, NOW, true).requests, 150)
  const midnight = nextMidnight(NOW, true)
  assert.deepEqual(usageAt(used, midnight, true), { day: dayOf(midnight, true), requests: 0, tokens: 0, recent: [] })
  assert.equal(usageAt(null, NOW, true).requests, 0, 'no file yet is nothing used')
})

test('the day is used up by requests or by tokens, and says when it starts over', () => {
  const byRequests = limitHit(fresh({ requests: 150 }), NOW, FREE_LIMITS, true)
  assert.deepEqual(byRequests, { kind: 'day', reason: 'requests', retryAfterMs: nextMidnight(NOW, true) - NOW })
  assert.equal(limitHit(fresh({ tokens: 2_000_000 }), NOW, FREE_LIMITS, true)?.kind, 'day')
  assert.equal(limitHit(fresh({ requests: 149, tokens: 1_999_999 }), NOW, FREE_LIMITS, true), null, 'just under both is fine')
})

test('the minute limit waits for the oldest of the last 20 requests to age out', () => {
  const recent = Array.from({ length: 20 }, (_, i) => NOW - 50_000 + i * 1000)
  assert.deepEqual(limitHit(usageAt(fresh({ recent }), NOW, true), NOW, FREE_LIMITS, true), { kind: 'minute', retryAfterMs: 10_000 })
  // Older than a minute no longer counts.
  assert.equal(limitHit(usageAt(fresh({ recent }), NOW + 10_000, true), NOW + 10_000, FREE_LIMITS, true), null)
})

test('a request counts when it starts, its tokens when it ends', () => {
  const after = withTokens(withRequest(fresh(), NOW), 1234.4)
  assert.equal(after.requests, 1)
  assert.equal(after.tokens, 1234)
  assert.deepEqual(after.recent, [NOW])
  assert.equal(withTokens(fresh(), Number.NaN).tokens, 0)
})

/* ------------------------------------------------------ listed by its code */

test('Eaon Event is listed only while an event code lasts: there is nothing to claim without one', async () => {
  forgetCode()
  // A free week claimed before (Eaon Free) lists nothing now.
  store.patchSettings({ freeCredits: { claimed: true, claimedAt: Date.now(), offered: 1, lastOfferedAt: Date.now() } })
  assert.equal(listProviders().some((p) => p.id === FREE_PROVIDER_ID), false)
  assert.equal(getProvider(FREE_PROVIDER_ID), undefined)

  await withCode()
  const event = getProvider(FREE_PROVIDER_ID)!
  assert.ok(event)
  assert.equal(event.name, 'Eaon Event')
  assert.equal(event.baseUrl, 'https://gateway.eaon.dev/v1')
  assert.equal(event.auth, 'none')
  assert.equal(event.hasKey, true, 'ready on its code')
  assert.equal(providerReadiness(event).state, 'ready')
  assert.ok(listProviders().some((p) => p.id === FREE_PROVIDER_ID))

  forgetCode()
  assert.equal(getProvider(FREE_PROVIDER_ID), undefined, 'gone again with the code')
})

test('every request is counted, tokens included, and the day ends with a clear refusal', async () => {
  await withCode()
  store.setJson('free-credits.json', { day: '', requests: 0, tokens: 0, recent: [] })
  const calls = { n: 0 }
  const limited = withFreeLimits(stubTurn(calls))
  const request = { signal: new AbortController().signal } as TurnRequest
  await limited.turn(request)
  let status = freeCreditsStatus()
  assert.equal(status.requests, 1)
  assert.equal(status.tokens, 1000)

  // The rest of today's allowance gone: refused before anything is sent.
  store.setJson('free-credits.json', { day: dayOf(Date.now(), true), requests: 150, tokens: 5000, recent: [] })
  await assert.rejects(limited.turn(request), (error: unknown) => {
    assert.ok(error instanceof ProviderIssueError)
    assert.equal(error.issue.kind, 'rate-limit', 'it ends at midnight UTC, so Eaon Event is not left needing attention')
    assert.equal(error.issue.action, 'choose-model')
    assert.match(error.issue.message, /used today's credits from the code "Eaon Hack 2026" \(150 requests a day\)\. They start over at \d+:\d\d [AP]M/)
    return true
  })
  assert.equal(calls.n, 1, 'the refused request never reached the gateway')

  store.setJson('free-credits.json', { day: dayOf(Date.now(), true), requests: 3, tokens: 2_000_000, recent: [] })
  await assert.rejects(takeFreeRequest(new AbortController().signal), /2M tokens a day/)
  addFreeTokens(10)
  status = freeCreditsStatus()
  assert.equal(status.tokens, 2_000_010)
  forgetCode()
})

test('without a code, a request is refused before it is sent', async () => {
  forgetCode()
  const calls = { n: 0 }
  await assert.rejects(withFreeLimits(stubTurn(calls)).turn({ signal: new AbortController().signal } as TurnRequest), (error: unknown) => {
    assert.ok(error instanceof ProviderIssueError)
    assert.match(error.issue.message, /Eaon Event needs an event code/)
    return true
  })
  assert.equal(calls.n, 0)
})

test('past 20 a minute the request waits its turn, and Stop ends the wait', async () => {
  await withCode()
  const now = Date.now()
  const recent = Array.from({ length: 20 }, (_, i) => now - 59_900 + i)
  store.setJson('free-credits.json', { day: dayOf(now, true), requests: 20, tokens: 0, recent })
  const started = Date.now()
  await takeFreeRequest(new AbortController().signal)
  assert.ok(Date.now() - started >= 50, 'it waited for the oldest to age out')
  assert.equal(freeCreditsStatus().requests, 21)

  const full = Array.from({ length: 20 }, (_, i) => Date.now() - 1000 + i)
  store.setJson('free-credits.json', { day: dayOf(Date.now(), true), requests: 40, tokens: 0, recent: full })
  const stop = new AbortController()
  const waiting = takeFreeRequest(stop.signal)
  setTimeout(() => stop.abort(), 30)
  await assert.rejects(waiting, /Stopped by the user/)
  forgetCode()
})

test('Eaon Event’s adapter has the allowance in front of it, for other apps through the local server too', async () => {
  await withCode()
  store.setJson('free-credits.json', { day: dayOf(Date.now(), true), requests: 150, tokens: 0, recent: [] })
  const event = getProvider(FREE_PROVIDER_ID)!
  const request = { provider: event, modelId: 'claude-haiku-5-5', signal: new AbortController().signal } as TurnRequest
  await assert.rejects(adapterFor(event).turn(request), ProviderIssueError)
  await assert.rejects(adapterFor(event, { track: false }).turn(request), ProviderIssueError, 'apps using Eaon’s local server are limited too')
  forgetCode()
})

test('requests carry no X-Eaon-App header, which makes the gateway ask for a signature', async () => {
  await withCode()
  const headers = Object.keys(getProvider(FREE_PROVIDER_ID)!.headers ?? {}).map((h) => h.toLowerCase())
  assert.ok(!headers.some((h) => h.startsWith('x-eaon-app') || h.startsWith('x-eaon-sig')), headers.join(', '))
  forgetCode()
})

/* ---------------------------------------------------------------- the code */

test('a code is read however it is typed, and junk is never sent', async () => {
  assert.equal(normalizeCode('  eaon hack_7kq2 '), 'EAON-HACK-7KQ2')
  assert.equal(looksLikeCode('EAON-HACK-7KQ2'), true)
  assert.equal(looksLikeCode('HI'), false)
  const seen: { url?: string } = {}
  const result = await redeemFreeCode('hi', fakeGateway(200, { code: HACK }, seen))
  assert.equal(result.ok, false)
  assert.equal(seen.url, undefined, 'nothing went to the gateway')
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
  assert.equal(secrets.get(FREE_PROVIDER_ID), 'EAON-ABCD-EFGH-JKMN', 'kept encrypted, as Eaon Event’s key')
  assert.deepEqual(activeCode(), HACK)

  // Requests carry the code as the gateway key, and the device ID.
  const event = getProvider(FREE_PROVIDER_ID)!
  assert.equal(event.headers?.['X-Eaon-Device'], device)
  assert.deepEqual(await credentialAttempts(event), [{ apiKey: 'EAON-ABCD-EFGH-JKMN' }])
  assert.equal(freeDeviceId(), device, 'the same ID every time')
  forgetCode()
  assert.equal(secrets.has(FREE_PROVIDER_ID), false)
})

test('the gateway’s own words come back when a code doesn’t work', async () => {
  forgetCode()
  const bad = await redeemFreeCode('EAON-AAAA-BBBB-CCCC', fakeGateway(404, { error: { message: "That code isn't valid. Check it and try again.", code: 'invalid_code' } }))
  assert.deepEqual(bad, { ok: false, message: "That code isn't valid. Check it and try again." })
  // A gateway without the codes route answers as if it were a model call: none of that is about the code.
  const unrouted = await redeemFreeCode(
    'EAON-AAAA-BBBB-CCCC',
    fakeGateway(400, { error: { message: 'Send a model ID. Call GET /v1/models to see the models you can use.', code: 'model_not_found' } })
  )
  assert.deepEqual(unrouted, { ok: false, message: 'Eaon couldn’t check the code right now (HTTP 400). Try again later.' })
  const offline = await redeemFreeCode('EAON-AAAA-BBBB-CCCC', async () => {
    throw new TypeError('fetch failed')
  })
  assert.equal(offline.ok, false)
  assert.match((offline as { message: string }).message, /Couldn’t reach Eaon/)
  assert.equal(secrets.has(FREE_PROVIDER_ID), false, 'nothing kept')
  assert.equal(getProvider(FREE_PROVIDER_ID), undefined, 'and nothing listed')
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

test('the status is the code’s: its name, end, limits and today’s use, starting over at midnight UTC', async () => {
  forgetCode()
  assert.equal(freeCreditsStatus().code, null)
  await withCode({ ...HACK, limits: { requestsPerDay: 3, tokensPerDay: 50_000, requestsPerMinute: 20 } })
  const status = freeCreditsStatus()
  assert.deepEqual(status.code, { name: 'Eaon Hack 2026', endsAt: HACK.endsAt })
  assert.equal(status.limits.requestsPerDay, 3)
  assert.equal(status.resetsAt, nextMidnight(Date.now(), true))
  forgetCode()
})

test('a code that has ended is forgotten, and Eaon Event with it', async () => {
  await withCode()
  assert.ok(activeCode())
  assert.equal(activeCode(HACK.endsAt), null)
  assert.equal(secrets.has(FREE_PROVIDER_ID), false)
  assert.equal(getProvider(FREE_PROVIDER_ID), undefined)
  const expired = await redeemFreeCode('EAON-ABCD-EFGH-JKMN', fakeGateway(200, { code: { ...HACK, endsAt: Date.now() - 1 } }))
  assert.equal(expired.ok, false, 'an ended code is not kept')
})

test('a code the gateway turned off says so, and is dropped', async () => {
  await withCode()
  store.setJson('free-credits.json', { day: '', requests: 0, tokens: 0, recent: [] })
  const refusing: Adapter = {
    id: 'stub',
    managesContext: false,
    async turn() {
      throw new ProviderHttpError(401, 'The code "Eaon Hack 2026" has been turned off.')
    }
  }
  await assert.rejects(withFreeLimits(refusing).turn({ signal: new AbortController().signal } as TurnRequest), (error: unknown) => {
    assert.ok(error instanceof ProviderIssueError)
    assert.match(error.issue.message, /The code "Eaon Hack 2026" isn't active any more\. .*Eaon Event/)
    return true
  })
  assert.equal(activeCode(), null)
  assert.equal(secrets.has(FREE_PROVIDER_ID), false)
})

/* ------------------------------------------------------ the model in use */

test('a code keeps the model in use, the default included, and starts someone on Eaon Event only when nothing works', async () => {
  const choice = (s: ReturnType<typeof store.getSettings>): [string | null, string | null] => [s.selectedProviderId, s.selectedModelId]
  await withCode()

  // No choice saved, running on Eaon Lite's default: it stays, saved as the choice, though Eaon Event sorts first once listed.
  store.saveProviderConfig({ 'eaon-gateway': { enabled: true } })
  store.patchSettings({ selectedProviderId: null, selectedModelId: null, favoriteModels: [], recentModels: [] })
  assert.deepEqual(choice(chooseEventModel()), ['eaon-gateway', 'mimo-v2.6-flash-free'])

  // A choice that works is left alone.
  store.patchSettings({ selectedProviderId: 'eaon-gateway', selectedModelId: 'muse-spark-1.3-contributor-free' })
  assert.deepEqual(choice(chooseEventModel()), ['eaon-gateway', 'muse-spark-1.3-contributor-free'])

  // Nothing works (a model whose provider has no key): Eaon Event's Claude Haiku.
  store.saveProviderConfig({ 'eaon-gateway': { enabled: false } })
  store.patchSettings({ selectedProviderId: 'anthropic', selectedModelId: 'claude-opus-5-5' })
  assert.deepEqual(choice(chooseEventModel()), [FREE_PROVIDER_ID, 'claude-haiku-5-5'])

  store.saveProviderConfig({ 'eaon-gateway': { enabled: true } })
  store.patchSettings({ selectedProviderId: null, selectedModelId: null })
  forgetCode()
})

test('updating from Eaon Free: what was set to it goes back to the default, unless a code still lasts', async () => {
  forgetCode()
  const worker = { id: 'w1', name: 'Scout', model: { providerId: FREE_PROVIDER_ID, modelId: 'claude-haiku-5-5' } }
  const other = { id: 'w2', name: 'Nova', model: { providerId: 'eaon-gateway', modelId: 'mimo-v2.6-flash-free' } }
  const task = { id: 't1', name: 'Morning', model: { providerId: FREE_PROVIDER_ID, modelId: 'eaon-free' } }
  store.setJson('workers.json', [worker, other])
  store.setJson('scheduled-tasks.json', [task])
  store.patchSettings({ selectedProviderId: FREE_PROVIDER_ID, selectedModelId: 'claude-haiku-5-5' })

  leaveFreeWeek()
  assert.equal(store.getSettings().selectedProviderId, null)
  assert.equal(store.getSettings().selectedModelId, null)
  assert.deepEqual(store.getJson('workers.json', []), [{ ...worker, model: null }, other])
  assert.deepEqual(store.getJson('scheduled-tasks.json', []), [{ ...task, model: null }])

  // With a code that still lasts, Eaon Event is there: nothing moves.
  await withCode()
  store.setJson('workers.json', [worker])
  store.patchSettings({ selectedProviderId: FREE_PROVIDER_ID, selectedModelId: 'claude-haiku-5-5' })
  leaveFreeWeek()
  assert.equal(store.getSettings().selectedProviderId, FREE_PROVIDER_ID)
  assert.deepEqual(store.getJson('workers.json', []), [worker])

  forgetCode()
  store.setJson('workers.json', [])
  store.setJson('scheduled-tasks.json', [])
  store.patchSettings({ selectedProviderId: null, selectedModelId: null })
})
