import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Provider } from '@shared/types'
import { checkKeyShape } from '@shared/providers'
import { providerReadiness } from '@shared/modelSelection'
import { clearProviderHealth, getProvider, noteProviderHealth, refreshModels, refreshProviderModels, removeProvider, updateProvider } from '../src/main/providers'
import { anthropicAdapter } from '../src/main/providers/adapters/anthropic'
import { ollamaAdapter } from '../src/main/providers/adapters/ollama'
import { openaiChatAdapter } from '../src/main/providers/adapters/openaiChat'
import { openaiResponsesAdapter } from '../src/main/providers/adapters/openaiResponses'
import { ProviderHttpError, type Adapter, type TurnRequest } from '../src/main/providers/adapters/types'
import { classifyProviderError, ProviderIssueError, redactSecrets } from '../src/main/providers/errors'
import { secrets } from '../src/main/secrets'
import { provider } from './helpers'

/*
 * Provider failures as typed, actionable issues (providers/errors.ts), the
 * "Needs attention" state they leave behind, and the last good model list
 * kept when a refresh fails. Every provider kind is driven against a fake
 * HTTP server; no real keys, no network.
 */

type Reply = { status: number; body: unknown; headers?: Record<string, string> }

/** A fake provider: `reply` decides each answer; the path and method are passed in. */
async function fakeServer(reply: (req: IncomingMessage) => Reply): Promise<{ url: string; close: () => void; hits: () => number }> {
  let hits = 0
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume()
    hits++
    const answer = reply(req)
    res.writeHead(answer.status, { 'Content-Type': 'application/json', ...answer.headers })
    res.end(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => {
      server.closeAllConnections()
      server.close()
    },
    hits: () => hits
  }
}

/** A port with nothing listening, for "connection refused". */
async function deadPort(): Promise<string> {
  const server = createServer()
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((r) => server.close(() => r()))
  return `http://127.0.0.1:${port}`
}

const like = (extra: Partial<Provider> = {}): Pick<Provider, 'id' | 'name' | 'auth' | 'local' | 'baseUrl'> => ({
  id: 'openai',
  name: 'OpenAI',
  auth: 'key',
  local: false,
  baseUrl: 'https://api.openai.com/v1',
  ...extra
})

/* --------------------------------------------------------- the classifier */

test('classifier: every failure the brief lists is its own kind, with the fix as its action', () => {
  const key = like()
  const chatgpt = like({ id: 'chatgpt', name: 'ChatGPT', auth: 'oauth' })
  const ollama = like({ id: 'ollama', name: 'Ollama', local: true, baseUrl: 'http://127.0.0.1:11434/v1' })
  const fetchFailed = (code: string): Error => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) })
  const cases: [string, unknown, Pick<Provider, 'id' | 'name' | 'auth' | 'local' | 'baseUrl'>, string, string | null, RegExp][] = [
    ['expired OAuth', new ProviderHttpError(401, '401: token expired'), chatgpt, 'auth-expired', 'reconnect', /Your ChatGPT session expired\. Sign in again\./],
    ['expired refresh (our own flow)', new Error('Your ChatGPT sign-in has expired. Sign in again in Settings → Model providers.'), chatgpt, 'auth-expired', 'reconnect', /session expired/],
    ['revoked OAuth', Object.assign(new Error('ChatGPT sign-in failed (400): refresh_token_reused.'), { status: 400 }), chatgpt, 'auth-revoked', 'reconnect', /signed out of ChatGPT/],
    ['malformed or rejected key', new ProviderHttpError(401, '401: Incorrect API key provided: sk-abc***'), key, 'key-invalid', 'fix-key', /rejected the API key/],
    ['insufficient scope', new ProviderHttpError(403, '403: You have insufficient permissions for this operation. Missing scopes: api.model.read'), key, 'insufficient-scope', 'fix-key', /isn’t allowed to do this/],
    ['model the key may not use', new ProviderHttpError(403, '403: Project does not have access to model gpt-9'), key, 'insufficient-scope', 'choose-model', /isn’t allowed to use this model/],
    ['network unavailable', fetchFailed('ENOTFOUND'), key, 'network', 'retry', /Check your internet connection/],
    ['local runtime not running', fetchFailed('ECONNREFUSED'), ollama, 'network', 'retry', /Couldn’t reach Ollama at http:\/\/127\.0\.0\.1:11434\. Start it/],
    ['timeout', Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }), key, 'timeout', 'retry', /didn’t answer in time/],
    ['provider outage', new ProviderHttpError(503, '503: Service Unavailable'), key, 'outage', 'retry', /having problems right now \(503\)/],
    ['overloaded (Anthropic 529)', new ProviderHttpError(529, '529: Overloaded'), key, 'outage', 'retry', /\(529\)/],
    ['region mismatch', new ProviderHttpError(403, '403: Country, region, or territory not supported'), key, 'region', 'choose-model', /isn’t available in your country or region/],
    ['Gemini location', new ProviderHttpError(400, '400: User location is not supported for the API use.'), key, 'region', 'choose-model', /country or region/],
    ['rate limit', new ProviderHttpError(429, '429: Rate limit reached for requests', 20_000), key, 'rate-limit', 'retry', /Try again in 20 s/],
    ['out of credit (a 429 that is really quota)', new ProviderHttpError(429, '429: You exceeded your current quota (insufficient_quota)'), key, 'quota', 'fix-key', /out of credit/],
    ['Anthropic credit', new ProviderHttpError(400, '400: Your credit balance is too low to access the Anthropic API.'), key, 'quota', 'fix-key', /out of credit/],
    ['plan usage limit', new ProviderHttpError(429, '429: usage_limit_reached'), chatgpt, 'quota', 'choose-model', /usage limit/],
    ['model gone', new ProviderHttpError(404, '404: The model `gpt-4-old` does not exist'), key, 'model-unavailable', 'choose-model', /doesn’t offer this model/],
    ['unknown', new Error('Something odd happened'), key, 'other', null, /Something odd happened/]
  ]
  for (const [label, error, who, kind, action, message] of cases) {
    const issue = classifyProviderError(error, who)
    assert.equal(issue.kind, kind, label)
    assert.equal(issue.action, action, label)
    assert.match(issue.message, message, label)
    assert.equal(issue.providerId, who.id, label)
  }
  // An expired sign-in is never "model unavailable" or "invalid API key".
  assert.equal(classifyProviderError(new ProviderHttpError(401, '401: model not found'), chatgpt).kind, 'auth-expired')
  // A listing 404 is a wrong address, not a missing model.
  assert.match(classifyProviderError(new ProviderHttpError(404, '404: Not Found'), key, 'listing').message, /base URL/)
  // Already classified: passed through.
  const known = { kind: 'no-models' as const, message: 'x', action: null }
  assert.equal(classifyProviderError(new ProviderIssueError(known), key), known)
})

test('classifier: the raw words are kept for "Copy details", with keys and tokens scrubbed', () => {
  const issue = classifyProviderError(new ProviderHttpError(401, '401: Incorrect API key provided: sk-proj-abcdefghijklmnop1234. Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij'), like())
  assert.ok(issue.detail)
  assert.doesNotMatch(issue.detail!, /sk-proj-abcdef|eyJhbGci/)
  assert.doesNotMatch(issue.message, /sk-|401/)
  // Token-shaped values are joined at run time so none sits in the public source.
  const google = ['AIza', 'SyA1234567890abcdefghij'].join('')
  const url = redactSecrets(`https://x.test/v1?key=${google}&x=1`)
  assert.match(url, /^https:\/\/x\.test\/v1\?key=.*redacted.*&x=1$/)
  assert.ok(!url.includes('1234567890abcdefghij'))
  const keys = redactSecrets(`${['gsk', '0123456789abcdefghijklmnop'].join('_')} and ${google}klmnopqrstu`)
  assert.ok(!keys.includes('0123456789abcdefghij') && !keys.includes('1234567890abcdefghij'), keys)
})

test('key shape: tidies what can be tidied, refuses what would only come back as a 401', () => {
  assert.deepEqual(checkKeyShape('openai', 'OpenAI', '  "sk-proj-abcdefgh1234"\n'), { key: 'sk-proj-abcdefgh1234', problem: null })
  assert.equal(checkKeyShape('openai', 'OpenAI', 'Bearer sk-proj-abcdefgh1234').key, 'sk-proj-abcdefgh1234')
  assert.match(checkKeyShape('openai', 'OpenAI', 'sk-proj-abc\ndefgh1234').problem!, /line break/)
  assert.match(checkKeyShape('openai', 'OpenAI', 'sk-12').problem!, /cut short/)
  assert.match(checkKeyShape('openai', 'OpenAI', 'sk-ant-api03-abcdefghijkl').problem!, /key for Anthropic, not OpenAI/)
  assert.match(checkKeyShape('anthropic', 'Anthropic', 'sk-or-v1-abcdefghijkl').problem!, /OpenRouter/)
  // Gateways take other labs' keys as they are.
  assert.equal(checkKeyShape('my-gateway', 'My gateway', 'sk-ant-api03-abcdefghijkl').problem, null)
  assert.equal(checkKeyShape('anthropic', 'Anthropic', 'sk-ant-api03-abcdefghijkl').problem, null)
})

/* --------------------------------------------- listings against fake servers */

/** A custom provider of `kind` pointed at `url`, with a key. */
function customAt(id: string, kind: Provider['kind'], url: string): void {
  updateProvider(id, { name: id, kind, baseUrl: kind === 'anthropic' ? url : `${url}/v1`, enabled: true })
  secrets.set(id, 'sk-test-0123456789')
}

const listings: Record<string, (ids: string[]) => unknown> = {
  'openai-compatible': (ids) => ({ object: 'list', data: ids.map((id) => ({ id, object: 'model' })) }),
  'openai-responses': (ids) => ({ object: 'list', data: ids.map((id) => ({ id, object: 'model' })) }),
  anthropic: (ids) => ({ data: ids.map((id) => ({ id, type: 'model', display_name: id, created_at: '2026-01-01T00:00:00Z' })), has_more: false, first_id: ids[0] ?? null, last_id: ids.at(-1) ?? null })
}

for (const kind of ['openai-compatible', 'openai-responses', 'anthropic'] as const) {
  test(`${kind}: a rejected key marks the provider, keeps its last list, and a good refresh clears it`, { timeout: 15_000 }, async () => {
    let mode: 'ok' | '401' | '503' | '429' | '403-region' = 'ok'
    let ids = ['alpha', 'beta']
    const fake = await fakeServer(() => {
      if (mode === '401') return { status: 401, body: { error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } } }
      if (mode === '503') return { status: 503, body: { error: { message: 'Service Unavailable' } } }
      if (mode === '429') return { status: 429, body: { error: { message: 'Rate limit reached' } }, headers: { 'retry-after': '7' } }
      if (mode === '403-region') return { status: 403, body: { error: { message: 'Country, region, or territory not supported', code: 'unsupported_country_region_territory' } } }
      return { status: 200, body: listings[kind](ids) }
    })
    const id = `fake-${kind}`
    try {
      customAt(id, kind, fake.url)
      const listed = await refreshModels(id)
      assert.deepEqual(listed.map((m) => m.id).sort(), ['alpha', 'beta'])
      const fresh = getProvider(id)!
      assert.equal(fresh.models[0].source?.kind, 'provider-live')
      assert.ok(fresh.modelsListedAt)
      assert.equal(providerReadiness(fresh).state, 'ready')

      // 401: typed, marks the provider "Needs attention", keeps the last list as the kept copy.
      mode = '401'
      await assert.rejects(refreshModels(id), (error: unknown) => error instanceof ProviderIssueError && error.issue.kind === 'key-invalid' && error.issue.action === 'fix-key')
      const marked = getProvider(id)!
      assert.deepEqual(marked.models.map((m) => m.id).sort(), ['alpha', 'beta'])
      assert.equal(marked.models[0].source?.kind, 'cache')
      assert.equal(marked.modelsListedAt, fresh.modelsListedAt)
      const readiness = providerReadiness(marked)
      assert.equal(readiness.state, 'attention', 'stored credentials alone do not look connected after a failed check')
      assert.match(readiness.reason!, /rejected the API key/)
      // The Refresh button says which list is shown, never "Done".
      const refresh = await refreshProviderModels(id)
      assert.equal(refresh.ok, false)
      assert.equal(refresh.issue?.kind, 'key-invalid')
      assert.match(refresh.message, new RegExp(`^Couldn’t refresh ${id} — showing the list from just now\\. ${id} rejected the API key`))

      // Passing failures don't change the verdict either way.
      mode = '503'
      await assert.rejects(refreshModels(id), (error: unknown) => error instanceof ProviderIssueError && error.issue.kind === 'outage')
      mode = '429'
      await assert.rejects(refreshModels(id), (error: unknown) => error instanceof ProviderIssueError && error.issue.kind === 'rate-limit' && error.issue.retryAfterMs === 7000)
      assert.equal(providerReadiness(getProvider(id)!).state, 'attention')

      mode = '403-region'
      await assert.rejects(refreshModels(id), (error: unknown) => error instanceof ProviderIssueError && error.issue.kind === 'region')

      // Fixed: a listing that works clears it, and the button reports what changed.
      mode = 'ok'
      ids = ['alpha', 'beta', 'gamma']
      const fixed = await refreshProviderModels(id)
      assert.equal(fixed.ok, true)
      assert.deepEqual(fixed.added, ['gamma'])
      assert.equal(fixed.message, 'Updated just now · 1 new model: gamma.')
      assert.equal(providerReadiness(getProvider(id)!).state, 'ready')
      const again = await refreshProviderModels(id)
      assert.equal(again.message, 'No changes · checked just now.')
      ids = ['alpha', 'gamma']
      const gone = await refreshProviderModels(id)
      assert.deepEqual(gone.removed, ['beta'])
      assert.match(gone.message, /1 model no longer offered: beta/)
    } finally {
      fake.close()
      removeProvider(id)
    }
  })
}

test('ollama: not running is "start it", never a generic failure; its last list stays', { timeout: 15_000 }, async () => {
  const fake = await fakeServer((req) =>
    req.url === '/api/tags'
      ? { status: 200, body: { models: [{ name: 'qwen3:8b' }] } }
      : { status: 200, body: { capabilities: ['completion', 'tools'], model_info: { 'qwen3.context_length': 40960 } } }
  )
  const before = getProvider('ollama')!.baseUrl
  try {
    updateProvider('ollama', { baseUrl: `${fake.url}/v1` })
    const models = await refreshModels('ollama')
    assert.equal(models[0].id, 'qwen3:8b')
    // Evidence from /api/show: tools yes, images no (not just "unknown").
    assert.equal(models[0].tools, true)
    assert.equal(models[0].vision, false)
    fake.close()
    updateProvider('ollama', { baseUrl: `${await deadPort()}/v1` })
    await assert.rejects(refreshModels('ollama'), (error: unknown) => error instanceof ProviderIssueError && error.issue.kind === 'network' && /Start it and try again/.test(error.issue.message))
    assert.equal(getProvider('ollama')!.models[0]?.id, 'qwen3:8b')
    // Not running is a passing state for a local runtime, not "Needs attention".
    assert.equal(providerReadiness(getProvider('ollama')!).state, 'ready')
  } finally {
    fake.close()
    updateProvider('ollama', { baseUrl: before })
  }
})

test('a plan listing that allows nothing is "no models", not the whole catalog', { timeout: 15_000 }, async () => {
  const fake = await fakeServer(() => ({ status: 200, body: { data: [] } }))
  const id = 'fake-empty'
  try {
    customAt(id, 'openai-compatible', fake.url)
    await refreshModels(id)
    const empty = getProvider(id)!
    assert.equal(empty.models.length, 0)
    assert.equal(empty.health?.issue?.kind, 'no-models')
    assert.equal(providerReadiness(empty).state, 'attention')
  } finally {
    fake.close()
    removeProvider(id)
  }
})

test('health: lasting failures stick until a success, a new key or a sign-out clears them', () => {
  const id = 'health-probe'
  updateProvider(id, { name: 'Probe', kind: 'openai-compatible', baseUrl: 'https://probe.test/v1' })
  try {
    assert.equal(noteProviderHealth(id, { kind: 'network', message: 'offline', action: 'retry' }), false, 'passing failures are not recorded')
    assert.equal(noteProviderHealth(id, { kind: 'quota', message: 'Out of credit.', action: 'fix-key' }), true)
    assert.equal(noteProviderHealth(id, { kind: 'quota', message: 'Out of credit.', action: 'fix-key' }), false, 'the same verdict is not rewritten')
    assert.equal(getProvider(id)?.health?.ok, false)
    assert.equal(noteProviderHealth(id, null), true)
    assert.equal(getProvider(id)?.health?.ok, true)
    noteProviderHealth(id, { kind: 'key-invalid', message: 'Rejected.', action: 'fix-key' })
    clearProviderHealth(id)
    assert.equal(getProvider(id)?.health, undefined)
  } finally {
    removeProvider(id)
  }
})

/* ------------------------------------------- model requests, per adapter */

const request = (p: Provider): TurnRequest => ({
  provider: p,
  modelId: 'some-model',
  model: undefined,
  credentials: { apiKey: 'sk-test-0123456789' },
  system: 'sys',
  messages: [{ role: 'user', text: 'hi' }],
  tools: [],
  effort: 'medium',
  signal: new AbortController().signal,
  cacheKey: 'c',
  agentic: false,
  onText: () => {},
  onReasoning: () => {}
})

const adapters: [string, Adapter, (url: string) => Provider][] = [
  ['openai-chat', openaiChatAdapter, (url) => provider({ id: 'fake', name: 'Fake', baseUrl: `${url}/v1` })],
  ['openai-responses', openaiResponsesAdapter, (url) => provider({ id: 'fake', name: 'Fake', kind: 'openai-responses', baseUrl: `${url}/v1` })],
  ['anthropic', anthropicAdapter, (url) => provider({ id: 'fake', name: 'Fake', kind: 'anthropic', baseUrl: url })],
  ['ollama', ollamaAdapter, (url) => provider({ id: 'ollama', name: 'Ollama', kind: 'ollama', local: true, baseUrl: `${url}/v1` })]
]

for (const [name, adapter, make] of adapters) {
  test(`${name}: request failures classify the same way on every wire format`, { timeout: 20_000 }, async () => {
    let status = 401
    let body: unknown = { error: { message: 'Invalid API key', type: 'authentication_error' } }
    const fake = await fakeServer(() => ({ status, body }))
    try {
      const check = async (kind: string): Promise<void> => {
        const error = await adapter.turn(request(make(fake.url))).then(
          () => null,
          (e: unknown) => e
        )
        assert.ok(error, `${name} ${status} fails`)
        assert.equal(classifyProviderError(error, make(fake.url)).kind, kind, `${name} ${status} → ${kind}`)
      }
      // Local runtimes take no key; a 401 from them still isn't "model unavailable".
      if (name !== 'ollama') await check('key-invalid')
      status = 404
      body = { error: { message: 'model "some-model" not found', type: 'not_found_error' } }
      await check('model-unavailable')
      status = 500
      body = { error: { message: 'internal error' } }
      await check('outage')
    } finally {
      fake.close()
    }
  })
}
