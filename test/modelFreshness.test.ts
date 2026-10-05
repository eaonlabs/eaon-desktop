import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ModelInfo, Provider } from '@shared/types'
import { EVERY_MS, FIRST_CHECK_MS, MAX_AGE_MS, providersDue, refreshDueProviders, startModelFreshness } from '../src/main/providers/freshness'

/*
 * Background refresh of connected providers' model lists
 * (providers/freshness.ts): who is due, a failure keeping the last list, and
 * listeners hearing only about real changes.
 */

const model = (providerId: string, id: string): ModelInfo => ({ id, label: id, providerId })
const provider = (id: string, extra: Partial<Provider> = {}): Provider => ({
  id,
  name: id,
  kind: 'openai-compatible',
  baseUrl: 'https://x.test/v1',
  hasKey: true,
  enabled: true,
  builtIn: true,
  local: false,
  fallbackCount: 0,
  auth: 'key',
  models: [model(id, 'a')],
  modelsListedAt: null,
  ...extra
})

test('due: connected providers with a listing whose list is old; never local, broken, keyless, off or listing-less ones', () => {
  const now = 10 * MAX_AGE_MS
  const due = providersDue(
    [
      provider('openai'),
      provider('anthropic', { modelsListedAt: now - 1000 }),
      provider('groq', { modelsListedAt: now - MAX_AGE_MS }),
      provider('ollama', { local: true, hasKey: false }),
      provider('eaon-local', { local: true, hasKey: false }),
      provider('mistral', { hasKey: false }),
      provider('xai', { enabled: false }),
      // Perplexity has no listing endpoint.
      provider('perplexity'),
      provider('deepseek', { health: { ok: false, issue: { kind: 'key-invalid', message: 'rejected', action: 'fix-key' }, checkedAt: 1 } }),
      provider('github-copilot', { auth: 'oauth', hasKey: true, signedIn: true }),
      provider('chatgpt', { auth: 'oauth', hasKey: false, signedIn: false })
    ],
    now
  )
  assert.deepEqual(
    due.map((p) => p.id),
    ['openai', 'groq', 'github-copilot']
  )
})

test('refresh: a failure keeps the list; only a real change is reported', async () => {
  const lists: Record<string, ModelInfo[]> = { openai: [model('openai', 'a')], groq: [model('groq', 'a')] }
  const calls: string[] = []
  const deps = {
    list: () => Object.keys(lists).map((id) => provider(id, { models: lists[id] })),
    get: (id: string) => provider(id, { models: lists[id] }),
    refresh: async (id: string) => {
      calls.push(id)
      if (id === 'groq') throw new Error('503')
    }
  }
  assert.equal(await refreshDueProviders(deps), false, 'nothing changed: no broadcast, no flicker')
  assert.deepEqual(calls.sort(), ['groq', 'openai'])
  assert.deepEqual(lists.groq.map((m) => m.id), ['a'], 'the last good list stays')
  deps.refresh = async (id: string) => {
    if (id === 'openai') lists.openai = [model('openai', 'a'), model('openai', 'b')]
  }
  assert.equal(await refreshDueProviders(deps), true)
})

test('timer: first check soon after launch, then every few hours; stopping stops it', async (t) => {
  // Lets the finished check's promise settle, as real time would between ticks.
  const settle = (): Promise<void> => new Promise((r) => setImmediate(r))
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  let checks = 0
  const stop = startModelFreshness(
    {
      list: () => {
        checks++
        return []
      },
      get: () => undefined,
      refresh: async () => {}
    },
    () => {}
  )
  t.mock.timers.tick(FIRST_CHECK_MS - 1)
  assert.equal(checks, 0)
  t.mock.timers.tick(1)
  assert.equal(checks, 1)
  await settle()
  t.mock.timers.tick(EVERY_MS)
  assert.equal(checks, 2)
  await settle()
  stop()
  t.mock.timers.tick(EVERY_MS * 3)
  assert.equal(checks, 2)
})
