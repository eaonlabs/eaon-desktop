import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ModelInfo, Provider } from '@shared/types'
import type { ProviderHealth } from '@shared/providers'
import { FREE_PROVIDER_ID, GATEWAY_PROVIDER_ID } from '@shared/freeCredits'
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

const refused = (message: string): ProviderHealth => ({ ok: false, issue: { kind: 'insufficient-scope', message, action: 'choose-model' }, checkedAt: 1 })

test('timer: a refusal from Eaon’s gateway at launch, the rest soon after, then every few hours; stopping stops it', async (t) => {
  // Lets the finished check's promise settle, as real time would between ticks.
  const settle = (): Promise<void> => new Promise((r) => setImmediate(r))
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  let checks = 0
  const refreshed: string[] = []
  const lite = provider(GATEWAY_PROVIDER_ID, { auth: 'none', hasKey: false, health: refused('Eaon Lite only answers up-to-date copies of Eaon.') })
  const stop = startModelFreshness(
    {
      list: () => {
        checks++
        return [provider('openai'), lite]
      },
      get: (id) => (id === GATEWAY_PROVIDER_ID ? lite : provider(id)),
      refresh: async (id) => {
        refreshed.push(id)
      }
    },
    () => {}
  )
  await settle()
  assert.equal(checks, 1, 'one look at launch')
  assert.deepEqual(refreshed, [GATEWAY_PROVIDER_ID], 'at launch, only the refused gateway is asked, once')
  t.mock.timers.tick(FIRST_CHECK_MS - 1)
  assert.equal(checks, 1)
  t.mock.timers.tick(1)
  assert.equal(checks, 2)
  await settle()
  assert.ok(refreshed.includes('openai'), 'the others wait for the first check')
  t.mock.timers.tick(EVERY_MS)
  assert.equal(checks, 3)
  await settle()
  stop()
  t.mock.timers.tick(EVERY_MS * 3)
  assert.equal(checks, 3)
})

test('launch: a healthy Eaon Lite isn’t asked at once (its listing counts against the network’s limit); a slow launch check holds off the first one', async (t) => {
  const settle = (): Promise<void> => new Promise((r) => setImmediate(r))
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const refreshed: string[] = []
  const healthy = startModelFreshness(
    {
      list: () => [provider(GATEWAY_PROVIDER_ID, { auth: 'none', hasKey: false })],
      get: (id) => provider(id),
      refresh: async (id) => {
        refreshed.push(id)
      }
    },
    () => {}
  )
  await settle()
  assert.deepEqual(refreshed, [])
  healthy()

  // A refusal whose answer takes longer than the first check's delay: not asked twice at once.
  let answer: () => void = () => {}
  const asked: string[] = []
  const lite = provider(GATEWAY_PROVIDER_ID, { auth: 'none', hasKey: false, health: refused('refused') })
  const slow = startModelFreshness(
    {
      list: () => [lite],
      get: () => lite,
      refresh: (id) => {
        asked.push(id)
        return new Promise<void>((r) => (answer = r))
      }
    },
    () => {}
  )
  await settle()
  t.mock.timers.tick(FIRST_CHECK_MS)
  await settle()
  assert.deepEqual(asked, [GATEWAY_PROVIDER_ID])
  answer()
  slow()
})

test('due: Eaon’s gateway is asked again while it refuses, however fresh its list; a refused key is still left alone', () => {
  const now = 10 * MAX_AGE_MS
  const health = refused('Eaon Lite only answers up-to-date copies of Eaon.')
  const due = providersDue(
    [
      provider(GATEWAY_PROVIDER_ID, { auth: 'none', hasKey: false, modelsListedAt: now - 1000, health }),
      provider(FREE_PROVIDER_ID, { modelsListedAt: now - 1000, health }),
      provider('openai', { modelsListedAt: now - MAX_AGE_MS, health: { ...health, issue: { kind: 'key-invalid', message: 'rejected', action: 'fix-key' } } }),
      // Switched off by the user: left off.
      provider(GATEWAY_PROVIDER_ID, { enabled: false, auth: 'none', hasKey: false, health })
    ],
    now
  )
  assert.deepEqual(
    due.map((p) => p.id),
    [GATEWAY_PROVIDER_ID, FREE_PROVIDER_ID]
  )
})

test('refresh: a provider that stops needing attention is reported, though its list is the same', async () => {
  let health: ProviderHealth | undefined = refused('Eaon Lite only answers up-to-date copies of Eaon.')
  const lite = (): Provider => provider(GATEWAY_PROVIDER_ID, { auth: 'none', hasKey: false, ...(health ? { health } : {}) })
  const deps = {
    list: () => [lite()],
    get: () => lite(),
    refresh: async () => {
      health = { ok: true, issue: null, checkedAt: 2 }
    }
  }
  assert.equal(await refreshDueProviders(deps), true, 'the pages hear that Eaon Lite works again')
  assert.equal(await refreshDueProviders({ ...deps, list: () => [{ ...lite(), modelsListedAt: Date.now() }] }), false, 'nothing new: nothing reported')
})
