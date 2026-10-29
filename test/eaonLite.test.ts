import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { GATEWAY_PROVIDER_ID } from '@shared/freeCredits'
import { providerReadiness } from '@shared/modelSelection'
import { forgetOtherVersionsGatewayChecks, getProvider, refreshModels } from '../src/main/providers'
import { EAON_MAX_AGE_MS, MAX_AGE_MS, providersDue } from '../src/main/providers/freshness'
import { store } from '../src/main/store'

/**
 * Eaon Lite's models are set on gateway.eaon.dev (its named models: switched
 * on or off, with a name and a description). Once the gateway has listed
 * them, that list is Eaon Lite. Nothing here reaches the network: the
 * gateway's `/models` is a stub.
 */

const realFetch = globalThis.fetch
let listing: unknown = { object: 'list', data: [] }
/** The gateway set to "Eaon apps only", turning this copy away. */
let appsOnly = false
globalThis.fetch = (async (url: string | URL) => {
  if (appsOnly) {
    const error = { message: 'This API only works inside Eaon apps: the Eaon desktop app and the Eaon CLIs.', type: 'authentication_error', code: 'eaon_apps_only' }
    return new Response(JSON.stringify({ error }), { status: 401, headers: { 'content-type': 'application/json' } })
  }
  if (/\/models\/?$/.test(String(url))) return new Response(JSON.stringify(listing), { status: 200, headers: { 'content-type': 'application/json' } })
  return new Response('{}', { status: 404 })
}) as typeof fetch
after(() => {
  globalThis.fetch = realFetch
})

const row = (id: string, name: string, description: string): Record<string, unknown> => ({ id, object: 'model', created: 1, owned_by: 'eaon', name, description })
const lite = () => getProvider(GATEWAY_PROVIDER_ID)!

test('before the gateway has listed anything, Eaon Lite shows the models it shipped with', () => {
  store.saveProviderConfig({ [GATEWAY_PROVIDER_ID]: { enabled: true } })
  assert.deepEqual(
    lite().models.map((m) => m.id),
    ['mimo-v2.6-flash-free', 'muse-spark-1.3-contributor-free', 'gpt-6-luna-free']
  )
})

test('once listed, Eaon Lite is exactly what gateway.eaon.dev lists, with its names and descriptions', async () => {
  store.saveProviderConfig({ [GATEWAY_PROVIDER_ID]: { enabled: true } })
  listing = {
    object: 'list',
    data: [
      row('mimo-v2.6-flash-free', 'MiMo v2.6 Flash', 'Latest flagship flash model from Xiaomi.'),
      row('muse-spark-1.3-contributor-free', 'Muse Spark 1.3', 'From Meta.'),
      row('kimi-k3-free', 'Kimi K3', 'New on the gateway today.')
    ]
  }
  await refreshModels(GATEWAY_PROVIDER_ID)
  const models = lite().models
  // GPT-6-Luna was switched off there: gone. Kimi K3 was added there: here.
  assert.deepEqual(models.map((m) => m.id), ['mimo-v2.6-flash-free', 'muse-spark-1.3-contributor-free', 'kimi-k3-free'])
  const byId = Object.fromEntries(models.map((m) => [m.id, m]))
  assert.equal(byId['muse-spark-1.3-contributor-free'].label, 'Muse Spark 1.3', 'the gateway’s name, not the shipped one')
  assert.equal(byId['kimi-k3-free'].label, 'Kimi K3', 'a new model has the name set on the gateway, not one made from its id')
  assert.equal(byId['kimi-k3-free'].description, 'New on the gateway today.')
  // What the gateway doesn't say, the shipped entry still knows.
  assert.equal(byId['mimo-v2.6-flash-free'].contextWindow, 64_000)

  // Switched off later: it goes at the next listing.
  listing = { object: 'list', data: [row('kimi-k3-free', 'Kimi K3', 'New on the gateway today.')] }
  await refreshModels(GATEWAY_PROVIDER_ID)
  assert.deepEqual(lite().models.map((m) => m.id), ['kimi-k3-free'])
  store.saveProviderConfig({ [GATEWAY_PROVIDER_ID]: { enabled: true } })
})

test('Eaon Lite’s list is asked for again every ten minutes; other providers every few hours', () => {
  const now = 100 * MAX_AGE_MS
  store.saveProviderConfig({ [GATEWAY_PROVIDER_ID]: { enabled: true } })
  const listedAt = now - EAON_MAX_AGE_MS
  const eaon = { ...lite(), modelsListedAt: listedAt }
  const other = { ...lite(), id: 'groq', modelsListedAt: listedAt }
  assert.deepEqual(
    providersDue([eaon, other], now).map((p) => p.id),
    [GATEWAY_PROVIDER_ID]
  )
  assert.deepEqual(providersDue([{ ...eaon, modelsListedAt: now - EAON_MAX_AGE_MS + 1000 }], now), [], 'not before ten minutes')
})

test('a refusal Eaon Lite gave an older copy of Eaon is gone once Eaon is updated, without pressing Refresh', async () => {
  store.saveProviderConfig({ [GATEWAY_PROVIDER_ID]: { enabled: true } })
  listing = { object: 'list', data: [row('mimo-v2.6-flash-free', 'MiMo v2.6 Flash', 'Flash.')] }
  appsOnly = true
  await assert.rejects(refreshModels(GATEWAY_PROVIDER_ID))
  appsOnly = false
  assert.equal(providerReadiness(lite()).state, 'attention')
  assert.equal(lite().health?.version, '0.0.0-test', 'the verdict says which copy of Eaon it was about')

  // Launched again, the same copy: the verdict stands until the gateway is asked again.
  forgetOtherVersionsGatewayChecks()
  assert.equal(providerReadiness(lite()).state, 'attention')
  const asked = providersDue([lite()], Date.now()).map((p) => p.id)
  assert.deepEqual(asked, [GATEWAY_PROVIDER_ID], 'a refused Eaon Lite is asked again, not left alone')

  // Updated: what the gateway said to the older copy no longer shows.
  const config = store.getProviderConfig()
  store.saveProviderConfig({ ...config, [GATEWAY_PROVIDER_ID]: { ...config[GATEWAY_PROVIDER_ID], health: { ...config[GATEWAY_PROVIDER_ID].health!, version: '2026.7.1' } } })
  forgetOtherVersionsGatewayChecks()
  assert.equal(lite().health, undefined)
  assert.equal(providerReadiness(lite()).state, 'ready')

  // A verdict stored before verdicts named their version goes too.
  appsOnly = true
  await assert.rejects(refreshModels(GATEWAY_PROVIDER_ID))
  appsOnly = false
  const stored = store.getProviderConfig()
  const { version: _version, ...unversioned } = stored[GATEWAY_PROVIDER_ID].health!
  store.saveProviderConfig({ ...stored, [GATEWAY_PROVIDER_ID]: { ...stored[GATEWAY_PROVIDER_ID], health: unversioned } })
  forgetOtherVersionsGatewayChecks()
  assert.equal(providerReadiness(lite()).state, 'ready')

  // And when the gateway answers again, the refusal clears by itself.
  appsOnly = true
  await assert.rejects(refreshModels(GATEWAY_PROVIDER_ID))
  appsOnly = false
  await refreshModels(GATEWAY_PROVIDER_ID)
  assert.equal(providerReadiness(lite()).state, 'ready')
  store.saveProviderConfig({ [GATEWAY_PROVIDER_ID]: { enabled: true } })
})
