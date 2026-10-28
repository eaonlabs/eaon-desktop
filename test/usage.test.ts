import { test } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { Provider } from '@shared/types'
import type { Billing, UsageSummary } from '@shared/usage'
import { adapterFor, onModelUsage, registerAdapter } from '../src/main/providers'
import { emptyUsage, type Adapter, type TurnRequest } from '../src/main/providers/adapters/types'
import { usageFeature } from '../src/main/features/usage'
import { flushLedger, ledgerDays, localDay, recordUsage, resetLedgerForTests } from '../src/main/features/usage/ledger'
import { activity, calendar, costOf, dailyTotals, summarize, syncRows, toknModelName, type ToknPricing } from '../src/main/features/usage/rows'
import { signIn, signOut, toknAccount, upload } from '../src/main/features/usage/tokn'
import type { FeatureContext } from '../src/main/features/types'
import { store } from '../src/main/store'

/**
 * Settings → Usage: Eaon's own requests counted on this computer, priced at
 * Tokn's rates, and uploaded to Tokn after "Sign in with Tokn". Tokn itself is
 * faked at its endpoints; the loopback redirect is real.
 */

process.env.EAON_TOKN_HOST = 'https://tokn.test'
// tokn's own config, which Sync now and the Synced time read: never this computer's real one.
const toknConfigDir = mkdtempSync(join(tmpdir(), 'eaon-usage-tokn-'))
process.env.TOKN_CONFIG_DIR = toknConfigDir

const PRICING: ToknPricing = {
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'gpt-6.1-sol': { input: 2, output: 16 }
}
/** lm-studio runs locally; everything else here bills per token. */
const remote = (id: string): Billing => (id === 'lm-studio' ? 'local' : 'api')

test('model names follow Tokn’s table: no vendor prefix, version, date or routing variant', () => {
  assert.equal(toknModelName('anthropic/claude-opus-5'), 'claude-opus-5')
  assert.equal(toknModelName('Claude-Opus-5-20260101'), 'claude-opus-5')
  assert.equal(toknModelName('us.anthropic.claude-opus-5-v1:0'), 'claude-opus-5')
  assert.equal(toknModelName('openai/gpt-6.1-sol:nitro'), 'gpt-6.1-sol')
  assert.equal(toknModelName('claude-opus-5@20260101'), 'claude-opus-5')
  // A free variant costs nothing, so it must not borrow the paid model's price.
  assert.equal(toknModelName('meta-llama/llama-4:free'), 'llama-4:free')
})

test('cost is per million tokens, with Tokn’s default cache multiples when a rate is missing', () => {
  const counts = { requests: 1, input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 }
  assert.equal(costOf(counts, PRICING['claude-opus-5']), 5 + 25 + 0.5 + 6.25)
  assert.equal(costOf(counts, PRICING['gpt-6.1-sol']), 2 + 16 + 0.2 + 2.5)
})

test('upload rows: one per day and model across providers, local and unpriced models left out', () => {
  const days = {
    '2026-10-01': {
      anthropic: { 'claude-opus-5': { requests: 2, input: 100, output: 50, cacheRead: 1000, cacheWrite: 200 } },
      openrouter: {
        'anthropic/claude-opus-5': { requests: 1, input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        'someone/unpriced-model': { requests: 4, input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }
      },
      'lm-studio': { 'gpt-6.1-sol': { requests: 9, input: 999, output: 999, cacheRead: 0, cacheWrite: 0 } }
    }
  }
  const rows = syncRows(days, PRICING, remote)
  assert.equal(rows.length, 1)
  const [row] = rows
  assert.deepEqual({ ...row, costUsd: undefined }, {
    day: '2026-10-01',
    tool: 'eaon',
    model: 'claude-opus-5',
    fast: false,
    requests: 3,
    input: 110,
    output: 55,
    cacheWrite5m: 200,
    cacheWrite1h: 0,
    cacheRead: 1000,
    costUsd: undefined
  })
  assert.ok(Math.abs(row.costUsd - (110 * 5 + 55 * 25 + 1000 * 0.5 + 200 * 6.25) / 1e6) < 1e-9)
})

test('the summary covers every day in the range, with local models free and unknown ones unpriced', () => {
  const now = new Date(2026, 9, 3, 15)
  const days = {
    [localDay(now)]: {
      anthropic: { 'claude-opus-5': { requests: 1, input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } },
      'lm-studio': { 'qwen3-coder': { requests: 5, input: 10, output: 10, cacheRead: 0, cacheWrite: 0 } },
      groq: { 'mystery-model': { requests: 2, input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }
    },
    '2026-09-01': { anthropic: { 'claude-opus-5': { requests: 7, input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } }
  }
  const summary = summarize(days, 7, PRICING, remote, now)
  assert.equal(summary.days.length, 7)
  assert.equal(summary.days.at(-1)!.day, localDay(now))
  assert.equal(summary.days[0].day, localDay(new Date(2026, 8, 27)))
  assert.equal(summary.today.costUsd, 5)
  assert.equal(summary.today.requests, 8)
  assert.equal(summary.totals.requests, 8, 'September is outside the week')
  assert.equal(summary.totals.unpricedRequests, 2)
  assert.deepEqual(
    summary.models.map((m) => [m.modelId, m.costUsd, m.local]),
    [
      ['claude-opus-5', 5, false],
      ['qwen3-coder', 0, true],
      ['mystery-model', null, false]
    ]
  )
})

test('the activity calendar is whole weeks from a Sunday to today, with every day in it', () => {
  const now = new Date(2026, 9, 3, 15) // a Saturday
  const byDay = dailyTotals({ '2026-10-01': { anthropic: { 'claude-opus-5': { requests: 2, input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } } } }, PRICING, remote)
  const days = calendar(byDay, now, 53)
  assert.equal(days.length, 53 * 7, 'today is a Saturday, so the last week is full')
  assert.equal(new Date(`${days[0].day}T12:00:00`).getDay(), 0, 'starts on a Sunday')
  assert.equal(days.at(-1)!.day, '2026-10-03')
  assert.deepEqual(days.find((d) => d.day === '2026-10-01'), { day: '2026-10-01', costUsd: 5, planUsd: 0, tokens: 1_000_000, requests: 2 })
  assert.equal(days.filter((d) => d.requests > 0).length, 1)
  // Midweek, the last column stops at today.
  const wednesday = calendar(byDay, new Date(2026, 9, 7, 9), 53)
  assert.equal(wednesday.at(-1)!.day, '2026-10-07')
  assert.equal(wednesday.length, 52 * 7 + 4)
})

test('active days and streaks count the way Tokn’s profile does', () => {
  const now = new Date(2026, 9, 3, 15)
  const day = (requests: number, input = 1000) => ({ x: { m: { requests, input, output: 0, cacheRead: 0, cacheWrite: 0 } } })
  const ledger = {
    '2026-09-20': day(1), '2026-09-21': day(1), '2026-09-22': day(1), '2026-09-23': day(1), // four in a row
    '2026-09-30': day(3, 50_000), '2026-10-01': day(1), '2026-10-02': day(1) // up to yesterday
  }
  const stats = activity(dailyTotals(ledger, {}, () => 'api'), 7, now)
  assert.equal(stats.activeDays, 7)
  assert.equal(stats.activeInRange, 3, 'Sep 27 to Oct 3')
  assert.equal(stats.currentStreak, 3, 'still standing at yesterday: today is not over')
  assert.equal(stats.longestStreak, 4)
  assert.equal(stats.firstDay, '2026-09-20')
  assert.equal(stats.busiest?.day, '2026-09-30', 'no prices here, so the busiest day is the one with the most tokens')
  assert.equal(stats.allTime.requests, 9)
  // A whole day with nothing ends it: on Oct 4, yesterday (Oct 3) was empty.
  assert.equal(activity(dailyTotals(ledger, {}, () => 'api'), 7, new Date(2026, 9, 4, 9)).currentStreak, 0)
})

test('Eaon’s own requests are counted; requests other apps make through the gateway are not', async () => {
  const fake: Adapter = {
    id: 'fake',
    managesContext: false,
    turn: async () => ({ text: 'hi', calls: [], stop: 'end', usage: { input: 11, output: 7, cacheRead: 3, cacheWrite: 2 } })
  }
  registerAdapter('usage-test' as Provider['kind'], fake)
  const provider = { id: 'usage-test-provider', kind: 'usage-test', auth: 'key', local: false } as unknown as Provider
  const seen: [string, string, number][] = []
  const stop = onModelUsage((providerId, modelId, usage) => seen.push([providerId, modelId, usage.input]))
  const request = { provider, modelId: 'model-x' } as unknown as TurnRequest
  try {
    await adapterFor(provider).turn(request)
    await adapterFor(provider, { track: false }).turn(request)
  } finally {
    stop()
  }
  assert.deepEqual(seen, [['usage-test-provider', 'model-x', 11]])
})

test('the ledger buckets by local day, adds up, and survives a restart', () => {
  resetLedgerForTests()
  store.setJson('usage-ledger.json', {})
  resetLedgerForTests()
  const at = new Date(2026, 9, 3, 23, 59)
  recordUsage('anthropic', 'claude-opus-5', { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, at)
  recordUsage('anthropic', 'claude-opus-5', { input: 1, output: 1, cacheRead: 4, cacheWrite: 2 }, at)
  recordUsage('anthropic', 'claude-opus-5', { ...emptyUsage(), input: Number.NaN }, new Date(2026, 9, 4, 0, 1))
  flushLedger()
  resetLedgerForTests()
  const days = ledgerDays()
  assert.deepEqual(days['2026-10-03'].anthropic['claude-opus-5'], { requests: 2, input: 11, output: 6, cacheRead: 4, cacheWrite: 2 })
  // No counts at all from the provider: a request, flagged as unreported rather than free.
  assert.deepEqual(days['2026-10-04'].anthropic['claude-opus-5'], { requests: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unreported: 1 })
})

/* ------------------------------------------------------------ Tokn */

const realFetch = globalThis.fetch
type Fake = (url: string, init: RequestInit | undefined) => Response | Promise<Response> | undefined

function withFetch(fake: Fake): () => void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    return (await fake(url, init)) ?? realFetch(input, init)
  }) as typeof fetch
  return () => {
    globalThis.fetch = realFetch
  }
}

const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })

/** Plays the browser: approves on Tokn's page by following the redirect with a code. */
function approve(code: string, overrides: Record<string, string> = {}): (url: string) => void {
  return (url) => {
    const authorize = new URL(url)
    const redirect = new URL(authorize.searchParams.get('redirect_uri')!)
    redirect.searchParams.set('code', code)
    redirect.searchParams.set('state', authorize.searchParams.get('state')!)
    for (const [key, value] of Object.entries(overrides)) redirect.searchParams.set(key, value)
    setTimeout(() => void realFetch(redirect), 10)
  }
}

test('Sign in with Tokn: PKCE against a loopback redirect, and the token is kept in the vault', async () => {
  await signOut()
  let authorize: URL | null = null
  let exchange: URLSearchParams | null = null
  const restore = withFetch((url, init) => {
    if (url !== 'https://tokn.test/api/oauth/token') return undefined
    exchange = new URLSearchParams(String(init?.body))
    return json({ access_token: 'tok_eaon', token_type: 'Bearer', user: { id: 'u_1', handle: 'ada', name: 'Ada' }, profile_url: 'https://tokn.test/profile/ada' })
  })
  try {
    const open = approve('toknac_abc')
    const account = await signIn((url) => {
      authorize = new URL(url)
      open(url)
    }, new AbortController().signal)
    assert.equal(account.handle, 'ada')
    assert.deepEqual(toknAccount(), { id: 'u_1', handle: 'ada', name: 'Ada', profileUrl: 'https://tokn.test/profile/ada' })

    const a = authorize as unknown as URL
    assert.equal(a.origin + a.pathname, 'https://tokn.test/oauth/authorize')
    assert.equal(a.searchParams.get('client_id'), 'eaon-desktop')
    assert.equal(a.searchParams.get('code_challenge_method'), 'S256')
    assert.match(a.searchParams.get('redirect_uri')!, /^http:\/\/127\.0\.0\.1:\d+\/callback$/)

    const x = exchange as unknown as URLSearchParams
    assert.equal(x.get('grant_type'), 'authorization_code')
    assert.equal(x.get('code'), 'toknac_abc')
    assert.equal(x.get('redirect_uri'), a.searchParams.get('redirect_uri'))
    const challenge = createHash('sha256').update(x.get('code_verifier')!).digest('base64url')
    assert.equal(challenge, a.searchParams.get('code_challenge'))
  } finally {
    restore()
  }
})

test('a redirect for another sign-in attempt is refused', async () => {
  await signOut()
  const restore = withFetch((url) => (url === 'https://tokn.test/api/oauth/token' ? json({ access_token: 'x', user: { handle: 'x' } }) : undefined))
  try {
    const controller = new AbortController()
    const attempt = signIn(approve('code', { state: 'someone-elses' }), controller.signal)
    // The loopback server answers the bad state with an error page and keeps waiting.
    setTimeout(() => controller.abort(), 300)
    await assert.rejects(attempt, /cancelled/)
    assert.equal(toknAccount(), null)
  } finally {
    restore()
  }
})

test('uploads carry the token; a token revoked on Tokn signs Eaon out', async () => {
  await signOut()
  const restore = withFetch((url, init) => {
    if (url === 'https://tokn.test/api/oauth/token') return json({ access_token: 'tok_live', user: { id: 'u_2', handle: 'ada' } })
    if (url === 'https://tokn.test/api/cli/sync') {
      const auth = new Headers(init?.headers).get('authorization')
      if (auth !== 'Bearer tok_live') return json({ error: 'run tokn link' }, 401)
      const body = JSON.parse(String(init?.body))
      assert.equal(body.cliVersion.split('/')[0], 'eaon-desktop')
      assert.ok(body.timezone)
      return json({ accepted: body.rows.length, rank: 4, profileUrl: 'https://tokn.test/profile/ada' })
    }
    return undefined
  })
  try {
    await signIn(approve('c1'), new AbortController().signal)
    const rows = syncRows({ '2026-10-02': { anthropic: { 'claude-opus-5': { requests: 1, input: 5, output: 5, cacheRead: 0, cacheWrite: 0 } } } }, PRICING, remote)
    assert.deepEqual(await upload(rows, 'UTC'), { accepted: 1, rejected: 0, rank: 4, profileUrl: 'https://tokn.test/profile/ada' })

    // Revoked on the Tokn account page.
    restore()
    const again = withFetch((url) => (url === 'https://tokn.test/api/cli/sync' ? json({ error: 'unknown device token' }, 401) : undefined))
    try {
      await assert.rejects(upload(rows, 'UTC'), /signed Eaon out/)
      assert.equal(toknAccount(), null)
    } finally {
      again()
    }
  } finally {
    restore()
  }
})

test('Settings → Usage: signing in uploads what was counted, and the summary shows the account', async () => {
  await signOut()
  resetLedgerForTests()
  store.setJson('usage-ledger.json', {})
  store.setJson('tokn-pricing.json', { fetchedAt: Date.now(), models: PRICING })
  resetLedgerForTests()
  recordUsage('anthropic', 'claude-opus-5', { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 })

  const uploads: { rows: { model: string; requests: number; tool: string }[] }[] = []
  const restore = withFetch((url, init) => {
    if (url === 'https://tokn.test/api/oauth/token') return json({ access_token: 'tok_feature', user: { id: 'u_3', handle: 'grace' } })
    if (url === 'https://tokn.test/api/cli/sync') {
      uploads.push(JSON.parse(String(init?.body)))
      return json({ accepted: 1 })
    }
    if (url === 'https://tokn.test/api/cli/pricing') return json({ models: PRICING })
    if (url === 'https://tokn.test/api/cli/me') return json({ user: { id: 'u_3', handle: 'grace' } })
    if (url === 'https://tokn.test/api/cli/profile') return json({ stats: { byDay: [] } })
    return undefined
  })
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const hooks = globalThis as { __eaonOpenExternal?: (url: string) => void }
  hooks.__eaonOpenExternal = approve('c-feature')
  usageFeature.register({
    ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) },
    getWindow: () => null,
    getWindows: () => [],
    send: () => {},
    emitStream: () => {}
  } as unknown as FeatureContext)
  try {
    const before = (await handlers.get('usage:summary')!(null, 7)) as UsageSummary
    assert.equal(before.account, null)
    assert.equal(before.today.requests, 1)

    const account = await handlers.get('usage:sign-in')!()
    assert.equal((account as { handle: string }).handle, 'grace')
    await handlers.get('usage:sync')!()
    assert.ok(uploads.length >= 1)
    assert.deepEqual(
      uploads.at(-1)!.rows.map((r) => [r.tool, r.model, r.requests]),
      [['eaon', 'claude-opus-5', 1]]
    )

    const after = (await handlers.get('usage:summary')!(null, 30)) as UsageSummary
    assert.equal(after.account?.handle, 'grace')
    assert.equal(after.sync.state, 'idle')
    assert.equal(after.sync.accepted, 1)
    assert.ok(after.sync.at)
    assert.ok(Math.abs(after.today.costUsd - (1000 * 5 + 100 * 25) / 1e6) < 1e-9)

    await handlers.get('usage:sign-out')!()
    assert.equal(((await handlers.get('usage:summary')!(null, 7)) as UsageSummary).account, null)
  } finally {
    restore()
    delete hooks.__eaonOpenExternal
    usageFeature.dispose?.()
  }
})

test('signed in, the activity calendar and streaks are the Tokn profile’s, and Synced counts the tokn command’s sync', async () => {
  await signOut()
  resetLedgerForTests()
  store.setJson('usage-ledger.json', {})
  store.setJson('tokn-profile.json', {})
  store.setJson('tokn-pricing.json', { fetchedAt: Date.now(), models: PRICING })
  resetLedgerForTests()
  const day = (back: number): string => localDay(new Date(Date.now() - back * 86_400_000))
  // What toknhq.com has: Claude Code days from the tokn command, which this computer's Eaon never saw.
  const byDay = [3, 2, 1].map((back) => ({ day: day(back), cost: 10 * back, tokens: 1_000_000 * back, requests: 100 * back }))
  let profileReads = 0
  const restore = withFetch((url) => {
    if (url === 'https://tokn.test/api/oauth/token') return json({ access_token: 'tok_profile', user: { id: 'u_4', handle: 'ada' } })
    if (url === 'https://tokn.test/api/cli/profile') {
      profileReads++
      return json({ user: { handle: 'ada' }, stats: { byDay, totals: {} } })
    }
    if (url === 'https://tokn.test/api/cli/sync') return json({ accepted: 0 })
    if (url === 'https://tokn.test/api/cli/pricing') return json({ models: PRICING })
    if (url === 'https://tokn.test/api/cli/me') return json({ user: { id: 'u_4', handle: 'ada' } })
    return undefined
  })
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const hooks = globalThis as { __eaonOpenExternal?: (url: string) => void }
  hooks.__eaonOpenExternal = approve('c-profile')
  usageFeature.register({
    ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) },
    getWindow: () => null,
    getWindows: () => [],
    send: () => {},
    emitStream: () => {}
  } as unknown as FeatureContext)
  const summary = async (): Promise<UsageSummary> => (await handlers.get('usage:summary')!(null, 7)) as UsageSummary
  try {
    await handlers.get('usage:sign-in')!()
    // Signing in syncs, and a sync reads the profile again.
    let shown = await summary()
    for (let i = 0; i < 50 && shown.activityFrom.source !== 'tokn'; i++) {
      await new Promise((r) => setTimeout(r, 20))
      shown = await summary()
    }
    assert.equal(shown.activityFrom.source, 'tokn')
    assert.equal(shown.activity.activeDays, 3)
    assert.equal(shown.activity.currentStreak, 3, 'through yesterday: today isn’t over')
    assert.equal(shown.activity.allTime.costUsd, 60)
    assert.equal(shown.activity.busiest?.day, day(3))
    assert.equal(shown.calendar.find((d) => d.day === day(2))?.tokens, 2_000_000)
    assert.equal(shown.today.requests, 0, 'the tiles for the range stay this computer’s')

    // A fresh copy isn't read again for every summary.
    const reads = profileReads
    await summary()
    await summary()
    assert.equal(profileReads, reads)

    // The tokn command synced after Eaon did: that's when the profile last took this computer's use.
    const eaonAt = shown.sync.at!
    const later = new Date(Date.parse(eaonAt) + 60_000).toISOString()
    writeFileSync(join(toknConfigDir, 'config.json'), JSON.stringify({ token: 'tokn_device', user: { handle: 'ada' }, lastSyncAt: later }))
    assert.equal((await summary()).sync.at, later)
    // Linked to someone else: not this profile's sync.
    writeFileSync(join(toknConfigDir, 'config.json'), JSON.stringify({ token: 'tokn_device', user: { handle: 'someone-else' }, lastSyncAt: later }))
    assert.equal((await summary()).sync.at, eaonAt)

    // Signed out: this computer's own counts again.
    await handlers.get('usage:sign-out')!()
    assert.equal((await summary()).activityFrom.source, 'local')
  } finally {
    restore()
    rmSync(join(toknConfigDir, 'config.json'), { force: true })
    delete hooks.__eaonOpenExternal
    usageFeature.dispose?.()
  }
})
