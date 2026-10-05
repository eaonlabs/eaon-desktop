import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { providerReadiness } from '@shared/modelSelection'
import { adapterFor, clearProviderHealth, getProvider, refreshModels, refreshProviderModels, updateProvider } from '../src/main/providers'
import { BUILT_IN, providerMeta } from '../src/main/providers/catalog'
import { ProviderIssueError } from '../src/main/providers/errors'
import { oauthFlow } from '../src/main/providers/oauth'
import { secrets } from '../src/main/secrets'
import '../src/main/providers/oauth/flows'

/*
 * The provider matrix (spec §10): every built-in provider's setup URL, auth
 * kind, endpoint, listing, model flags, error mapping, refresh and sign-out,
 * checked against fake servers. No real keys and no network.
 */

const https = (url: string | undefined): boolean => Boolean(url && /^https:\/\/[^\s/]+\.[^\s/]+/.test(url))

test('every built-in provider says how to set it up, and its auth kind matches', () => {
  for (const seed of BUILT_IN) {
    const provider = getProvider(seed.id)!
    const meta = providerMeta(seed.id)
    assert.ok(['key', 'oauth', 'none'].includes(provider.auth!), seed.id)
    if (provider.local) {
      assert.equal(provider.auth, 'none', `${seed.id}: local runtimes take no key`)
      assert.match(provider.baseUrl, /^http:\/\/127\.0\.0\.1(:\d+)?\/v1$/, `${seed.id}: local runtimes are on this computer`)
      continue
    }
    if (provider.auth === 'oauth') {
      const flow = oauthFlow(provider.oauthFlow)
      assert.ok(flow, `${seed.id}: its sign-in flow is registered`)
      assert.equal(typeof flow.signOut, 'function', `${seed.id}: can sign out`)
      assert.equal(flow.isSignedIn(), false, `${seed.id}: signed out in a fresh profile`)
      assert.ok(meta.signInLabel, `${seed.id}: has a sign-in button`)
    } else {
      assert.ok(https(provider.keyUrl), `${seed.id}: has an https page to get a key (${provider.keyUrl})`)
    }
    // A remote endpoint is https, a template the page fills in, or the user's own resource (Azure).
    const endpoint = provider.baseUrl || meta.baseUrlPlaceholder
    assert.ok(https(endpoint?.replace(/\{[a-z_]+\}/g, 'x')), `${seed.id}: endpoint ${provider.baseUrl}`)
    if (/\{[a-z_]+\}/.test(provider.baseUrl)) assert.ok(meta.fields?.length && meta.baseUrlTemplate, `${seed.id}: its URL fields are on the page`)
    if (!provider.baseUrl) assert.ok(meta.baseUrlLabel, `${seed.id}: asks for its endpoint up front`)
    assert.equal(typeof meta.listsModels, 'boolean', seed.id)
    // Every provider can run turns: there is an adapter for its wire format.
    assert.equal(typeof adapterFor(provider, { track: false }).turn, 'function', seed.id)
  }
})

test('catalog flags are explicit where known; efforts only on models that reason', () => {
  for (const seed of BUILT_IN) {
    for (const model of getProvider(seed.id)!.models) {
      const where = `${seed.id}/${model.id}`
      if (model.vision !== undefined) assert.equal(typeof model.vision, 'boolean', where)
      if (model.tools !== undefined) assert.equal(typeof model.tools, 'boolean', where)
      assert.equal(typeof model.reasoning, 'boolean', where)
      if ((model.efforts?.length ?? 0) > 0) assert.equal(model.reasoning, true, `${where}: efforts imply reasoning`)
      // A guess from the id is marked as one.
      if (model.inferred) for (const field of model.inferred) assert.ok(['reasoning', 'efforts'].includes(field), where)
      assert.ok(model.source, `${where}: says where it came from`)
    }
  }
})

/**
 * One fake server for every provider: `/models` (and Anthropic's
 * `/v1/models`) answers with a list, or with the status the test asks for.
 */
async function fakeHost(): Promise<{ url: string; mode: { status: number }; seen: string[]; close: () => void }> {
  const mode = { status: 200 }
  const seen: string[] = []
  const server = createServer((req: IncomingMessage, res) => {
    req.resume()
    seen.push(`${req.method} ${req.url}`)
    if (mode.status !== 200) {
      res.writeHead(mode.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: mode.status === 401 ? 'Invalid API key' : 'Service unavailable', type: mode.status === 401 ? 'authentication_error' : 'api_error' } }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        object: 'list',
        data: [{ id: 'matrix-model', object: 'model', type: 'model', display_name: 'Matrix model', created_at: '2026-01-01T00:00:00Z' }],
        has_more: false
      })
    )
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    mode,
    seen,
    close: () => {
      server.closeAllConnections()
      server.close()
    }
  }
}

test('every keyed provider with a listing: lists, maps a rejected key to "fix the key", and keeps its list', { timeout: 60_000 }, async () => {
  const host = await fakeHost()
  try {
    const keyed = BUILT_IN.filter((seed) => !seed.local && (seed.auth ?? 'key') === 'key' && providerMeta(seed.id).listsModels)
    assert.ok(keyed.length > 25, 'most providers are covered')
    for (const seed of keyed) {
      const original = getProvider(seed.id)!.baseUrl
      const base = seed.kind === 'anthropic' ? `${host.url}/${seed.id}` : `${host.url}/${seed.id}/v1`
      updateProvider(seed.id, { baseUrl: base })
      secrets.set(seed.id, 'sk-matrix-0123456789')
      try {
        host.mode.status = 200
        const models = await refreshModels(seed.id)
        assert.ok(models.some((m) => m.id === 'matrix-model'), `${seed.id}: the listing's model is offered`)
        assert.ok(host.seen.some((line) => line.startsWith('GET ') && line.includes(`/${seed.id}/`) && line.includes('/models')), `${seed.id}: asked its /models`)
        assert.equal(providerReadiness(getProvider(seed.id)!).state, 'ready', seed.id)

        host.mode.status = 401
        await assert.rejects(
          refreshModels(seed.id),
          (error: unknown) => error instanceof ProviderIssueError && error.issue.kind === 'key-invalid' && error.issue.action === 'fix-key',
          `${seed.id}: a rejected key is "fix the key", never "model unavailable"`
        )
        const marked = getProvider(seed.id)!
        assert.equal(providerReadiness(marked).state, 'attention', `${seed.id}: needs attention after a failed check`)
        assert.ok(marked.models.some((m) => m.id === 'matrix-model'), `${seed.id}: the last list stays`)

        host.mode.status = 503
        const refresh = await refreshProviderModels(seed.id)
        assert.equal(refresh.ok, false, seed.id)
        assert.equal(refresh.issue?.kind, 'outage', seed.id)
        assert.match(refresh.message, /^Couldn’t refresh .+ — showing the list from just now\./, seed.id)
      } finally {
        secrets.clear(seed.id)
        clearProviderHealth(seed.id)
        updateProvider(seed.id, { baseUrl: original })
      }
    }
  } finally {
    host.close()
  }
})

test('providers without a listing keep the catalog list and say what refresh can check', async () => {
  for (const seed of BUILT_IN.filter((s) => !providerMeta(s.id).listsModels && !s.local && (s.auth ?? 'key') === 'key')) {
    const before = getProvider(seed.id)!.models.map((m) => m.id)
    assert.deepEqual((await refreshModels(seed.id)).map((m) => m.id), before, seed.id)
  }
})
