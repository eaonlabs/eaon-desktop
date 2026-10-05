import { test } from 'node:test'
import assert from 'node:assert/strict'
import '../src/main/agent/sources'
import type { Provider, Settings, StreamEvent, StreamRequest } from '@shared/types'
import { runAgent } from '../src/main/agent/loop'
import { getProvider } from '../src/main/providers'
import { resolveModel } from '../src/main/features/scheduler/runner'
import { secrets } from '../src/main/secrets'
import { store } from '../src/main/store'
import { chunk, sseServer } from './helpers'

/*
 * Main's side of model selection: a scheduled task (or anything following
 * the app's choice) never runs on a model the user didn't pick, and a turn
 * that fails at the provider reports what to do, marking the provider.
 */

const provider = (id: string, extra: Partial<Provider> = {}): Provider => ({
  id,
  name: id[0].toUpperCase() + id.slice(1),
  kind: 'openai-compatible',
  baseUrl: 'https://x.test/v1',
  hasKey: true,
  enabled: true,
  builtIn: true,
  local: false,
  fallbackCount: 0,
  auth: 'key',
  models: [{ id: `${id}-a`, label: `${id} A`, providerId: id }],
  ...extra
})

const settings = (selected: { providerId: string | null; modelId: string | null }): Settings =>
  ({ ...store.getSettings(), selectedProviderId: selected.providerId, selectedModelId: selected.modelId }) as Settings

test('a task following the app’s model fails with why when that model is gone; it never runs on the first one listed', () => {
  const providers = [provider('openai'), provider('anthropic')]
  const gone = resolveModel({ model: null }, settings({ providerId: 'anthropic', modelId: 'claude-retired' }), providers)
  assert.equal(gone.ok, false)
  assert.match((gone as { error: string }).error, /Your chosen model \(claude-retired\) is unavailable: Anthropic doesn’t offer it any more/)
  const chosen = resolveModel({ model: null }, settings({ providerId: 'anthropic', modelId: 'anthropic-a' }), providers)
  assert.deepEqual(chosen.ok && [chosen.providerId, chosen.modelId], ['anthropic', 'anthropic-a'])
  // Nothing chosen: the same default the composer shows.
  const fallback = resolveModel({ model: null }, settings({ providerId: null, modelId: null }), providers)
  assert.deepEqual(fallback.ok && [fallback.providerId, fallback.modelId], ['openai', 'openai-a'])
  // A pinned model on a provider that's off says so.
  const off = resolveModel({ model: { providerId: 'openai', modelId: 'openai-a' } }, settings({ providerId: null, modelId: null }), [provider('openai', { enabled: false })])
  assert.match((off as { error: string }).error, /turned off or has no key/)
})

test('a turn rejected by the provider says what to do, carries the fix, and marks the provider until a turn works', { timeout: 15_000 }, async () => {
  let reject = true
  const server = await sseServer(() =>
    reject ? { status: 401, body: JSON.stringify({ error: { message: 'Incorrect API key provided: sk-proj-abcdefghijklmnop', code: 'invalid_api_key' } }) } : [chunk({ content: 'Hi.' }, 'stop')]
  )
  store.saveProviderConfig({ fake: { name: 'Fake', kind: 'openai-compatible', baseUrl: server.url, models: [{ id: 'fake-model', label: 'Fake', providerId: 'fake' }] } })
  secrets.set('fake', 'sk-test-0123456789')
  const request = (): StreamRequest => ({
    chatId: 'c1',
    messageId: `m${Math.random()}`,
    providerId: 'fake',
    modelId: 'fake-model',
    effort: 'medium',
    mode: 'chat',
    history: [{ id: 'u1', role: 'user', createdAt: 0, parts: [{ type: 'text', text: 'hi' }] }],
    summary: null,
    projectInstructions: '',
    cwd: null,
    work: { swarm: false, plan: false },
    goal: null
  })
  try {
    const events: StreamEvent[] = []
    const outcome = await runAgent(request(), (e) => events.push(e))
    const error = events.find((e): e is Extract<StreamEvent, { type: 'error' }> => e.type === 'error')
    assert.ok(error)
    assert.equal(error.error, 'Fake rejected the API key. Check it, or paste a new one.')
    assert.equal(outcome.error, error.error)
    assert.equal(error.issue?.kind, 'key-invalid')
    assert.equal(error.issue?.action, 'fix-key')
    assert.doesNotMatch(error.issue?.detail ?? '', /sk-proj-abcdef/)
    assert.equal(getProvider('fake')?.health?.ok, false)

    reject = false
    const ok: StreamEvent[] = []
    await runAgent(request(), (e) => ok.push(e))
    assert.ok(ok.some((e) => e.type === 'done'))
    assert.equal(getProvider('fake')?.health?.ok, true)
  } finally {
    server.server.close()
    store.saveProviderConfig({})
  }
})
