import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import type { StreamEvent, StreamRequest } from '@shared/types'
import type { Billing } from '@shared/usage'
import { runAgent } from '../src/main/agent/loop'
import { onModelUsage } from '../src/main/providers'
import { withUsageSource } from '../src/main/features/usage/attribution'
import { cleanDays, flushLedger, ledgerDays, ledgerSources, localDay, recordUsage, resetLedgerForTests } from '../src/main/features/usage/ledger'
import { summarize, summarizeSources, syncRows, type ToknPricing } from '../src/main/features/usage/rows'
import { secrets } from '../src/main/secrets'
import { store } from '../src/main/store'
import { chunk, rawServer } from './helpers'

/**
 * What Settings → Usage may call spend. A subscription's use is never shown
 * as a bill; a provider that reports no token counts is never shown as free;
 * a retried, cut-off or tool-only turn is counted once per request the
 * provider answered; days are the user's local days across daylight saving;
 * and runs say what they were for. Requests go through the real agent loop
 * against a fake OpenAI-compatible server.
 */

process.env.TZ = 'America/New_York'

const PRICING: ToknPricing = {
  'gpt-6.1-sol': { input: 2, output: 16 },
  'claude-opus-5': { input: 5, output: 25 }
}
const BILLING: Record<string, Billing> = { openai: 'api', chatgpt: 'plan', 'lm-studio': 'local', 'quiet-host': 'api' }
const billingOf = (id: string): Billing => BILLING[id] ?? 'api'
const M = 1_000_000

function fresh(): void {
  resetLedgerForTests()
  store.setJson('usage-ledger.json', {})
  resetLedgerForTests()
}

test('a subscription’s use is an API-rate equivalent, kept apart from spend', () => {
  const now = new Date(2026, 9, 5, 15)
  const today = localDay(now)
  const days = {
    [today]: {
      openai: { 'gpt-6.1-sol': { requests: 1, input: M, output: 0, cacheRead: 0, cacheWrite: 0 } },
      chatgpt: { 'gpt-6.1-sol': { requests: 3, input: 3 * M, output: 0, cacheRead: 0, cacheWrite: 0 } },
      'lm-studio': { 'gpt-6.1-sol': { requests: 9, input: 9 * M, output: 0, cacheRead: 0, cacheWrite: 0 } }
    }
  }
  const summary = summarize(days, 7, PRICING, billingOf, now)
  assert.equal(summary.totals.costUsd, 2, 'only the pay-per-token request is spend')
  assert.equal(summary.totals.planUsd, 6, 'the plan’s use, at API rates, separately')
  assert.equal(summary.today.costUsd, 2)
  assert.equal(summary.today.planUsd, 6)
  assert.deepEqual(
    summary.models.map((m) => [m.providerId, m.billing, m.costUsd]),
    [
      ['openai', 'api', 2],
      ['chatgpt', 'plan', 6],
      ['lm-studio', 'local', 0]
    ]
  )
  // Tokn values every tool's use at API rates, plans included; local use never goes up.
  assert.deepEqual(
    syncRows(days, PRICING, billingOf).map((r) => [r.model, r.requests]),
    [['gpt-6.1-sol', 4]]
  )
})

test('requests with no token counts are flagged, not shown as free', () => {
  fresh()
  const at = new Date(2026, 9, 5, 12)
  recordUsage('quiet-host', 'gpt-6.1-sol', { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, at)
  recordUsage('quiet-host', 'gpt-6.1-sol', { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, at)
  recordUsage('openai', 'gpt-6.1-sol', { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 }, at)
  const summary = summarize(ledgerDays(), 7, PRICING, billingOf, at)
  assert.equal(summary.totals.unreportedRequests, 2)
  const quiet = summary.models.find((m) => m.providerId === 'quiet-host')!
  assert.equal(quiet.unreported, 2)
  assert.equal(quiet.requests, 2)
})

test('a damaged ledger is cleaned on load: counts saved as text don’t turn into text', () => {
  const clean = cleanDays({
    '2026-10-05': { openai: { 'gpt-6.1-sol': { requests: '5', input: 10, output: -3, cacheRead: Number.NaN, cacheWrite: 1.6, unreported: 9 } } },
    'not-a-day': { openai: {} },
    '2026-10-06': 'garbage'
  })
  assert.deepEqual(clean, { '2026-10-05': { openai: { 'gpt-6.1-sol': { requests: 0, input: 10, output: 0, cacheRead: 0, cacheWrite: 2 } } } })
  store.setJson('usage-ledger.json', { version: 1, days: { '2026-10-05': { openai: { m: { requests: '5', input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } } } })
  resetLedgerForTests()
  recordUsage('openai', 'm', { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, new Date(2026, 9, 5, 12))
  assert.equal(ledgerDays()['2026-10-05'].openai.m.requests, 1, 'not "51"')
})

test('days are local calendar days, across daylight saving and midnight', () => {
  fresh()
  // New York, 2026-11-01: 01:00–02:00 happens twice; the day is still one day.
  recordUsage('openai', 'gpt-6.1-sol', { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, new Date('2026-11-01T01:30:00-04:00'))
  recordUsage('openai', 'gpt-6.1-sol', { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, new Date('2026-11-01T01:30:00-05:00'))
  recordUsage('openai', 'gpt-6.1-sol', { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, new Date('2026-11-01T23:59:00-05:00'))
  recordUsage('openai', 'gpt-6.1-sol', { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, new Date('2026-11-02T00:01:00-05:00'))
  assert.equal(ledgerDays()['2026-11-01'].openai['gpt-6.1-sol'].requests, 3)
  assert.equal(ledgerDays()['2026-11-02'].openai['gpt-6.1-sol'].requests, 1)
  // A week that spans the change has seven different days, in order; so does one across spring forward.
  for (const now of [new Date('2026-11-04T00:30:00-05:00'), new Date('2026-03-10T02:30:00-04:00')]) {
    const days = summarize(ledgerDays(), 7, PRICING, billingOf, now).days.map((d) => d.day)
    assert.equal(new Set(days).size, 7)
    assert.deepEqual([...days].sort(), days)
    assert.equal(days.at(-1), localDay(now))
  }
})

test('runs are attributed to what they were for, through every await inside them', async () => {
  fresh()
  const stop = onModelUsage((providerId, modelId, usage) => recordUsage(providerId, modelId, usage, new Date(2026, 9, 5, 12)))
  try {
    recordUsage('openai', 'gpt-6.1-sol', { input: M, output: 0, cacheRead: 0, cacheWrite: 0 }, new Date(2026, 9, 5, 12))
    await withUsageSource('schedule', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      recordUsage('openai', 'gpt-6.1-sol', { input: 2 * M, output: 0, cacheRead: 0, cacheWrite: 0 }, new Date(2026, 9, 5, 12))
    })
    await withUsageSource('worker', async () => {
      await Promise.resolve()
      recordUsage('chatgpt', 'gpt-6.1-sol', { input: M, output: 0, cacheRead: 0, cacheWrite: 0 }, new Date(2026, 9, 5, 12))
    })
  } finally {
    stop()
  }
  const rows = summarizeSources(ledgerSources(), 7, PRICING, billingOf, new Date(2026, 9, 5, 15))
  assert.deepEqual(
    rows.map((r) => [r.source, r.requests, r.costUsd, r.planUsd]),
    [
      ['schedule', 1, 4, 0],
      ['chat', 1, 2, 0],
      ['worker', 1, 0, 2]
    ]
  )
  flushLedger()
  resetLedgerForTests()
  assert.ok(ledgerSources()['2026-10-05'].schedule, 'the split survives a restart')
})

/* -------------------------------------- the real loop: counted once each */

function request(text: string): StreamRequest {
  return {
    chatId: `chat-${text}`,
    messageId: `msg-${text}`,
    providerId: 'fake',
    modelId: 'fake-1',
    effort: 'medium',
    mode: 'chat',
    history: [{ id: `u-${text}`, role: 'user', parts: [{ type: 'text', text }], createdAt: Date.now() }],
    summary: null,
    projectInstructions: '',
    cwd: null,
    work: { swarm: false, plan: false },
    goal: null
  } as unknown as StreamRequest
}

const usageChunk = (input: number, output: number): string =>
  JSON.stringify({ choices: [], usage: { prompt_tokens: input, completion_tokens: output } })

async function fakeProvider(answer: (body: Record<string, unknown>, n: number) => { status?: number; body: string; headers?: Record<string, string> }): Promise<{ server: Server; calls: () => number }> {
  let n = 0
  const { url, server } = await rawServer((body) => answer(body, ++n))
  store.saveProviderConfig({ fake: { name: 'Fake', kind: 'openai-compatible', baseUrl: `${url}/v1`, enabled: true, models: [{ id: 'fake-1', label: 'Fake 1', providerId: 'fake' }] } })
  secrets.set('fake', 'test-key')
  return { server, calls: () => n }
}

const stream = (...lines: string[]): string => lines.map((line) => `data: ${line}\n\n`).join('')

async function counted(run: () => Promise<unknown>): Promise<{ requests: number; input: number; output: number }> {
  const seen = { requests: 0, input: 0, output: 0 }
  const stop = onModelUsage((providerId, _model, usage) => {
    if (providerId !== 'fake') return
    seen.requests++
    seen.input += usage.input
    seen.output += usage.output
  })
  try {
    await run()
  } finally {
    stop()
  }
  return seen
}

test('a request the provider turned away and Eaon retried counts once', { timeout: 20_000 }, async () => {
  const fake = await fakeProvider((_body, n) =>
    n === 1
      ? { status: 429, type: 'application/json', headers: { 'retry-after': '0' }, body: '{"error":{"message":"slow down"}}' }
      : { body: stream(chunk({ content: 'Hello.' }), chunk({}, 'stop'), usageChunk(100, 5), '[DONE]') }
  )
  try {
    const events: StreamEvent[] = []
    const seen = await counted(() => runAgent(request('retry'), (e) => events.push(e)))
    assert.equal(fake.calls(), 2)
    assert.deepEqual(seen, { requests: 1, input: 100, output: 5 })
  } finally {
    fake.server.close()
  }
})

test('a stream cut off before any text is retried, and only the answered request counts', { timeout: 30_000 }, async () => {
  const fake = await fakeProvider((_body, n) =>
    n === 1
      ? { body: stream(chunk({ role: 'assistant' })) }
      : { body: stream(chunk({ content: 'Whole answer.' }), chunk({}, 'stop'), usageChunk(80, 4), '[DONE]') }
  )
  try {
    const seen = await counted(() => runAgent(request('cut'), () => {}))
    assert.equal(fake.calls(), 2)
    assert.deepEqual(seen, { requests: 1, input: 80, output: 4 })
  } finally {
    fake.server.close()
  }
})

test('a tool-only turn and the answer after it are two requests, each counted once', { timeout: 20_000 }, async () => {
  const fake = await fakeProvider((body, n) => {
    if (n === 1) {
      const call = { index: 0, id: 't1', function: { name: 'no_such_tool', arguments: '{}' } }
      return { body: stream(chunk({ tool_calls: [call] }), chunk({}, 'tool_calls'), usageChunk(50, 10), '[DONE]') }
    }
    assert.ok((body.messages as { role: string }[]).some((m) => m.role === 'tool'))
    return { body: stream(chunk({ content: 'Done.' }), chunk({}, 'stop'), usageChunk(70, 3), '[DONE]') }
  })
  try {
    const seen = await counted(() => runAgent(request('tools'), () => {}))
    assert.equal(fake.calls(), 2)
    assert.deepEqual(seen, { requests: 2, input: 120, output: 13 })
  } finally {
    fake.server.close()
  }
})

/* ------------------------------------------------ the gateway, counted once */

test('another app’s requests through the gateway are counted once, listed apart, and never in the totals or the upload', { timeout: 30_000 }, async () => {
  fresh()
  const answered = stream(chunk({ content: 'Hi.' }), chunk({}, 'stop'), usageChunk(300, 20), '[DONE]')
  const fake = await fakeProvider((_body, n) =>
    n === 1 ? { status: 503, type: 'application/json', headers: { 'retry-after': '0' }, body: '{"error":{"message":"busy"}}' } : { body: answered }
  )
  const eaonOwn: number[] = []
  const stop = onModelUsage((providerId, _model, usage) => providerId === 'fake' && eaonOwn.push(usage.input))
  try {
    const { runGatewayTurn } = await import('../src/main/gateway/turn')
    const result = await runGatewayTurn({
      providerId: 'fake',
      modelId: 'fake-1',
      system: '',
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }] as never,
      tools: [],
      signal: new AbortController().signal,
      onText: () => {},
      onReasoning: () => {}
    })
    assert.equal(result.text, 'Hi.')
    assert.equal(fake.calls(), 2, 'the busy answer was retried')
  } finally {
    stop()
    fake.server.close()
  }
  assert.deepEqual(eaonOwn, [], 'not counted as Eaon’s own request (that would put it in the totals and the upload)')
  const day = localDay(new Date())
  assert.deepEqual(ledgerDays()[day] ?? {}, {}, 'not in the ledger’s own days')
  assert.deepEqual(ledgerSources()[day].gateway!.fake['fake-1'], { requests: 1, input: 300, output: 20, cacheRead: 0, cacheWrite: 0 })

  const pricing: ToknPricing = { 'fake-1': { input: 2, output: 16 } }
  const rows = summarizeSources(ledgerSources(), 7, pricing, billingOf)
  assert.deepEqual(rows.map((r) => [r.source, r.requests, r.tokens]), [['gateway', 1, 320]])
  const summary = summarize(ledgerDays(), 7, pricing, billingOf)
  assert.equal(summary.totals.requests, 0)
  assert.equal(summary.totals.costUsd, 0)
  assert.deepEqual(syncRows(ledgerDays(), pricing, billingOf), [])
  flushLedger()
  resetLedgerForTests()
  assert.equal(ledgerSources()[day].gateway!.fake['fake-1'].requests, 1, 'survives a restart')
})
