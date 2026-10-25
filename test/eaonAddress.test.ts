import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Provider } from '@shared/types'
import { FREE_BASE_URL, GATEWAY_PROVIDER_ID } from '@shared/freeCredits'
import { forScreen, forScreens, hideEaonAddress, isEaonGateway, shownProviderId } from '../src/main/eaonAddress'
import { getProvider, listProviders, removeProvider, updateProvider } from '../src/main/providers'
import { classifyProviderError } from '../src/main/providers/errors'
import { summarize } from '../src/main/features/usage/rows'
import { errorMessage } from '../src/main/gateway/wire'

/**
 * The app never shows the address of Eaon's gateway (main/eaonAddress.ts):
 * not in what the pages or the CLI get about a provider, an error, or the
 * usage table, and no other provider can be pointed at it.
 */

const SHOWN = /gateway\.eaon\.dev|gateway-eaon-dev/i

test('the gateway is recognised however its address is written, and nothing else is', () => {
  for (const url of [FREE_BASE_URL, 'gateway.eaon.dev', 'gateway.eaon.dev/v1', 'HTTPS://Gateway.Eaon.Dev./v1/', 'http://gateway.eaon.dev:443/v1', ' https://gateway.eaon.dev ']) {
    assert.equal(isEaonGateway(url), true, url)
  }
  for (const url of ['', 'https://eaon.dev', 'https://rc.eaon.dev', 'https://gateway.eaon.dev.example.com/v1', 'https://notgateway.eaon.dev', 'https://api.openai.com/v1', 'not a url']) {
    assert.equal(isEaonGateway(url), false, url)
  }
})

test('every mention of the address in text becomes "Eaon"', () => {
  const raw = 'request to https://gateway.eaon.dev/v1/chat/completions failed, reason: getaddrinfo ENOTFOUND gateway.eaon.dev (https-gateway-eaon-dev-v1)'
  const shown = hideEaonAddress(raw)
  assert.doesNotMatch(shown, SHOWN)
  assert.equal(shown, 'request to Eaon failed, reason: getaddrinfo ENOTFOUND Eaon (Eaon)')
  assert.equal(hideEaonAddress('Visit https://eaon.dev for help.'), 'Visit https://eaon.dev for help.', 'the website is not the gateway')
})

const provider = (extra: Partial<Provider>): Provider =>
  ({ id: 'x', name: 'X', kind: 'openai-compatible', baseUrl: '', hasKey: false, enabled: true, builtIn: false, local: false, auth: 'key', fallbackCount: 0, models: [], modelsListedAt: null, ...extra }) as Provider

test('the pages and the CLI get Eaon’s providers, and any pointed at the gateway, without the address', () => {
  const lite = forScreen(provider({ id: GATEWAY_PROVIDER_ID, name: 'Eaon Lite', baseUrl: FREE_BASE_URL, builtIn: true }))
  assert.equal(lite.baseUrl, '')
  assert.equal(lite.name, 'Eaon Lite')
  const custom = forScreen(
    provider({
      id: 'https-gateway-eaon-dev-v1',
      name: 'https://gateway.eaon.dev/v1',
      baseUrl: 'https://gateway.eaon.dev/v1',
      health: { ok: false, checkedAt: 1, issue: { kind: 'network', message: 'Couldn’t reach gateway.eaon.dev.', action: 'retry', providerId: 'x', detail: 'ENOTFOUND gateway.eaon.dev' } }
    })
  )
  assert.doesNotMatch(JSON.stringify({ ...custom, id: undefined }), SHOWN)
  assert.equal(custom.name, 'Eaon')
  const openai = provider({ id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' })
  assert.equal(forScreen(openai), openai, 'anything else is untouched')
  assert.equal(forScreens([openai]).length, 1)
})

test('no provider but Eaon’s own can be pointed at the gateway', () => {
  assert.throws(() => updateProvider('my-gateway', { name: 'Mine', kind: 'openai-compatible', baseUrl: 'https://gateway.eaon.dev/v1', enabled: true }), /Eaon Lite already uses it/)
  assert.throws(() => updateProvider('openai', { baseUrl: 'gateway.eaon.dev/v1' }), /Eaon Lite already uses it/)
  assert.equal(getProvider('my-gateway'), undefined, 'nothing was saved')
  updateProvider('my-endpoint', { name: 'Mine', kind: 'openai-compatible', baseUrl: 'https://llm.example.com/v1', enabled: true })
  assert.equal(getProvider('my-endpoint')?.baseUrl, 'https://llm.example.com/v1')
  removeProvider('my-endpoint')
})

test('a custom provider added before this, named after the address, is called Eaon everywhere', async () => {
  const { store } = await import('../src/main/store')
  const config = store.getProviderConfig()
  store.saveProviderConfig({ ...config, 'https-gateway-eaon-dev-v1': { name: 'https://gateway.eaon.dev/v1', baseUrl: 'https://gateway.eaon.dev/v1', kind: 'openai-compatible', enabled: true } })
  assert.equal(listProviders().find((p) => p.id === 'https-gateway-eaon-dev-v1')?.name, 'Eaon')
  removeProvider('https-gateway-eaon-dev-v1')
})

test('an error from the gateway never shows its address, in the message or the details', () => {
  const error = Object.assign(new TypeError('request to https://gateway.eaon.dev/v1/chat/completions failed'), {
    cause: Object.assign(new Error('getaddrinfo ENOTFOUND gateway.eaon.dev'), { code: 'ENOTFOUND' })
  })
  const lite = { id: GATEWAY_PROVIDER_ID, name: 'Eaon Lite', auth: 'none' as const, local: false, baseUrl: FREE_BASE_URL }
  assert.doesNotMatch(JSON.stringify(classifyProviderError(error, lite)), SHOWN)
  const certificate = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('self-signed certificate'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' }) })
  assert.doesNotMatch(classifyProviderError(certificate, lite).message, SHOWN)
  assert.doesNotMatch(classifyProviderError(new Error('500: upstream https://gateway.eaon.dev/v1 failed'), lite).detail ?? '', SHOWN)
  // What the Local API Server tells an app that asked through it.
  assert.doesNotMatch(errorMessage(error), SHOWN)
})

test('the usage table counts a provider made from the address as Eaon Lite', () => {
  assert.equal(shownProviderId('https-gateway-eaon-dev-v1'), GATEWAY_PROVIDER_ID)
  assert.equal(shownProviderId('openai'), 'openai')
  const now = new Date(2026, 9, 15, 12)
  const day = '2026-10-15'
  const counts = { requests: 1, input: 10, output: 1, cacheRead: 0, cacheWrite: 0 }
  const summary = summarize({ [day]: { 'https-gateway-eaon-dev-v1': { 'nemotron-3-ultra': counts } } }, 7, {}, () => 'api', now)
  assert.deepEqual(
    summary.models.map((m) => m.providerId),
    [GATEWAY_PROVIDER_ID]
  )
})

test('a provider pointed at the gateway gets no logo looked up there, and an old look-up is never shown', async () => {
  const { store } = await import('../src/main/store')
  const { readLogos } = await import('../src/main/providers/logos')
  const png = 'data:image/png;base64,iVBORw0KGgo='
  store.setJson('provider-logos.json', {
    'https-gateway-eaon-dev-v1': {
      user: { src: png, setAt: 1 },
      site: { src: png, from: 'https://gateway.eaon.dev/favicon.ico', baseUrl: 'https://gateway.eaon.dev/v1', foundAt: 1 },
      lookup: { baseUrl: 'https://gateway.eaon.dev/v1', at: 1, found: true, steps: [{ url: 'https://gateway.eaon.dev/', result: 'Found' }] }
    }
  })
  const logos = readLogos()
  assert.doesNotMatch(JSON.stringify(Object.values(logos)), SHOWN)
  assert.equal(logos['https-gateway-eaon-dev-v1']?.user?.src, png, 'a logo the person chose stays')
  store.setJson('provider-logos.json', {})
})
