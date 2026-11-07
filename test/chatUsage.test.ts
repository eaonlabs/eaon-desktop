import { test } from 'node:test'
import assert from 'node:assert/strict'
import { allTokens, cachedPercent, chatUsage, compactCount, inputTokens, usd } from '../src/shared/chatUsage'
import { costForChat } from '../src/main/features/chatContext/cost'
import type { ToknPricing } from '../src/main/features/usage/rows'
import type { ChatMessage } from '../src/shared/types'

/** What a chat has used (shared/chatUsage.ts), and what it costs where a price is known (main/features/chatContext/cost.ts). */

const reply = (model: string | undefined, usage: ChatMessage['usage'], role: ChatMessage['role'] = 'assistant'): Pick<ChatMessage, 'role' | 'model' | 'usage'> => ({ role, model, usage })

test('replies’ tokens are added up overall and per model, most used first, and uncounted ones are left out', () => {
  const used = chatUsage([
    reply(undefined, undefined, 'user'),
    reply('gpt-5', { input: 1000, output: 200, cacheRead: 5000, cacheWrite: 300 }),
    reply('claude-sonnet-4-5', { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 }),
    reply('gpt-5', { input: 500, output: 100, cacheRead: 6000, cacheWrite: 0 }),
    reply('gpt-5', { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
    reply('gpt-5', undefined),
    reply(undefined, { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }),
    // A user message never counts, whatever it carries.
    reply('gpt-5', { input: 9999, output: 9999, cacheRead: 0, cacheWrite: 0 }, 'user')
  ])
  assert.equal(used.turns, 4)
  assert.deepEqual(used.total, { input: 1610, output: 355, cacheRead: 11_000, cacheWrite: 300 })
  assert.deepEqual(
    used.byModel.map((m) => [m.model, m.turns, allTokens(m.usage)]),
    [
      ['gpt-5', 2, 13_100],
      ['claude-sonnet-4-5', 1, 150],
      ['', 1, 15]
    ]
  )
  assert.equal(chatUsage([]).turns, 0)
})

test('input counts the cached tokens, and the cached share is of that input', () => {
  const u = { input: 1000, output: 400, cacheRead: 8000, cacheWrite: 1000 }
  assert.equal(inputTokens(u), 10_000)
  assert.equal(allTokens(u), 10_400)
  assert.equal(cachedPercent(u), 80)
  assert.equal(cachedPercent({ input: 0, output: 5, cacheRead: 0, cacheWrite: 0 }), 0)
})

test('counts and dollars are written so that a real cost never reads as nothing', () => {
  assert.equal(compactCount(950), '950')
  assert.equal(compactCount(1500), '1.5k')
  assert.equal(compactCount(54_210), '54.2k')
  assert.equal(compactCount(154_210), '154k')
  assert.equal(compactCount(1_048_576), '1.0M')
  assert.equal(usd(1.236), '$1.24')
  assert.equal(usd(0.004), 'less than $0.01')
  assert.equal(usd(0), '$0.00')
})

/* ------------------------------------------------------------------- cost */

const PRICING: ToknPricing = {
  'gpt-5': { input: 1.25, output: 10, cacheRead: 0.125 },
  'claude-sonnet-4-5': { input: 3, output: 15 }
}
const group = (model: string, usage: { input: number; output: number; cacheRead: number; cacheWrite: number }, turns = 1) => ({ model, usage, turns })

test('a model with a known price is priced at its rates, cache reads and writes included', () => {
  const cost = costForChat([group('gpt-5', { input: 1_000_000, output: 100_000, cacheRead: 2_000_000, cacheWrite: 0 })], PRICING)
  // 1M × 1.25 + 0.1M × 10 + 2M × 0.125 = 1.25 + 1 + 0.25
  assert.ok(cost.usd !== null && Math.abs(cost.usd - 2.5) < 1e-9)
  assert.deepEqual(cost.unpriced, [])
  // Cache writes with no listed rate are priced as Tokn's table does: 1.25 × input.
  const sonnet = costForChat([group('claude-sonnet-4-5', { input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000 })], PRICING)
  assert.ok(sonnet.usd !== null && Math.abs(sonnet.usd - 3.75) < 1e-9)
})

test('the model name is matched the way the Usage page matches it: a dated or prefixed id finds its price', () => {
  const cost = costForChat([group('anthropic/claude-sonnet-4-5-20250929', { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 })], PRICING)
  assert.ok(cost.usd !== null && Math.abs(cost.usd - 3) < 1e-9)
})

test('a model with no price gives tokens only, never a made-up figure; a mix is priced where it can be and says what was left out', () => {
  const none = costForChat([group('llama-3-local', { input: 5000, output: 900, cacheRead: 0, cacheWrite: 0 }), group('some-model:free', { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 })], PRICING)
  assert.equal(none.usd, null)
  assert.deepEqual(none.unpriced, [
    { model: 'llama-3-local', tokens: 5900 },
    { model: 'some-model:free', tokens: 20 }
  ])
  const mixed = costForChat([group('gpt-5', { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }), group('llama-3-local', { input: 100, output: 100, cacheRead: 0, cacheWrite: 0 })], PRICING)
  assert.ok(mixed.usd !== null && Math.abs(mixed.usd - 1.25) < 1e-9)
  assert.deepEqual(mixed.unpriced, [{ model: 'llama-3-local', tokens: 200 }])
  // A reply from before the model was recorded, or with no price table at all.
  assert.deepEqual(costForChat([group('', { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 })], PRICING), { usd: null, unpriced: [{ model: '', tokens: 20 }] })
  assert.equal(costForChat([group('gpt-5', { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 })], {}).usd, null)
})
