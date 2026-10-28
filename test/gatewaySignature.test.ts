import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { gatewaySignature, setGatewayAppForTests, signsGatewayRequests } from '../src/main/gatewaySignature'
import { providerFetch } from '../src/main/providers/safeFetch'
import { forgetCode, redeemFreeCode } from '../src/main/freeCredits'

/**
 * Every request main makes to Eaon's gateway carries the app signature the
 * gateway checks in "Eaon apps only" mode (openai-gateway/app-auth.js), made
 * the way it verifies it. A stand-in gateway on this computer checks each
 * one here; nothing reaches the real gateway.
 */

const APP = { id: 'eaon-desktop-test', secret: 'test-secret-not-a-real-one' }
const b64url = (buffer: Buffer): string => buffer.toString('base64url')

/** The gateway's check, rule for rule: complete headers, within five minutes, the HMAC of the exact request, each nonce once. */
const used = new Set<string>()
function verify(method: string, path: string, headers: IncomingMessage['headers'], body: Buffer, now = Date.now()): string | null {
  const app = headers['x-eaon-app']
  const timestamp = String(headers['x-eaon-timestamp'] ?? '')
  const nonce = String(headers['x-eaon-nonce'] ?? '')
  const signature = String(headers['x-eaon-signature'] ?? '')
  if (!app && !signature) return 'unsigned'
  if (app !== APP.id || !signature || !/^\d{9,12}$/.test(timestamp) || !/^[\w-]{16,128}$/.test(nonce)) return 'incomplete'
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) return 'expired'
  const bodyHash = b64url(createHash('sha256').update(body).digest())
  const expected = b64url(createHmac('sha256', APP.secret).update(['eaon-v1', timestamp, nonce, method, path, bodyHash].join('\n')).digest())
  if (signature.replace(/^v1=/, '') !== expected) return 'mismatch'
  if (used.has(nonce)) return 'replayed'
  used.add(nonce)
  return null
}

let gatewayClockAhead = 0
const seen: string[] = []
const server = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', (chunk: Buffer) => chunks.push(chunk))
  req.on('end', () => {
    const verdict = verify(req.method ?? 'GET', req.url ?? '/', req.headers, Buffer.concat(chunks), Date.now() + gatewayClockAhead * 1000)
    seen.push(verdict ?? 'ok')
    const date = new Date(Date.now() + gatewayClockAhead * 1000).toUTCString()
    if (verdict === 'expired') {
      res.writeHead(401, { 'content-type': 'application/json', date })
      res.end(JSON.stringify({ error: { message: "This request's Eaon app signature has expired. Check the device clock." } }))
      return
    }
    res.writeHead(verdict && verdict !== 'unsigned' ? 401 : 200, { 'content-type': 'application/json', date })
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'claude-haiku-5-5' }], verdict }))
  })
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
process.env.EAON_FREE_GATEWAY_URL = base
after(() => {
  server.close()
  delete process.env.EAON_FREE_GATEWAY_URL
  setGatewayAppForTests(null)
})

test('a build without an app signs nothing', async () => {
  setGatewayAppForTests(null)
  assert.equal(signsGatewayRequests(), false)
  assert.deepEqual(gatewaySignature('GET', `${base}/models`, new Uint8Array(0)), {})
  const response = await providerFetch(`${base}/models`)
  assert.equal(((await response.json()) as { verdict: string }).verdict, 'unsigned')
})

test('requests to the gateway are signed the way it checks them: a GET, a JSON body, a query', async () => {
  setGatewayAppForTests(APP)
  seen.length = 0
  await providerFetch(`${base}/models`)
  const body = JSON.stringify({ model: 'mimo-v2.6-flash-free', messages: [{ role: 'user', content: 'héllo — “quotes” 🙂' }], stream: true })
  await providerFetch(`${base}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer none' }, body })
  await providerFetch(`${base}/models?scope=open&x=1`, { headers: new Headers({ accept: 'application/json' }) })
  await providerFetch(`${base}/chat/completions`, { method: 'POST', body: new TextEncoder().encode(body) })
  assert.deepEqual(seen, ['ok', 'ok', 'ok', 'ok'])
})

test('each signature is used once: a retry is signed afresh', async () => {
  setGatewayAppForTests(APP)
  seen.length = 0
  const init = { method: 'POST', body: '{"model":"x"}' }
  await providerFetch(`${base}/chat/completions`, init)
  await providerFetch(`${base}/chat/completions`, init)
  assert.deepEqual(seen, ['ok', 'ok'])
})

test('a computer whose clock is far out signs again by the gateway’s clock', async () => {
  setGatewayAppForTests(APP)
  seen.length = 0
  gatewayClockAhead = 20 * 60
  try {
    const response = await providerFetch(`${base}/models`)
    assert.equal(response.status, 200)
    assert.deepEqual(seen, ['expired', 'ok'])
    // And knows it from then on.
    seen.length = 0
    await providerFetch(`${base}/models`)
    assert.deepEqual(seen, ['ok'])
  } finally {
    gatewayClockAhead = 0
    setGatewayAppForTests(APP)
  }
})

test('nothing else is signed: the app’s secret only ever goes to the gateway', async () => {
  setGatewayAppForTests(APP)
  const other = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ signed: Boolean(req.headers['x-eaon-signature'] || req.headers['x-eaon-app']) }))
  })
  await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve))
  try {
    const response = await providerFetch(`http://127.0.0.1:${(other.address() as AddressInfo).port}/v1/models`)
    assert.deepEqual(await response.json(), { signed: false })
  } finally {
    other.close()
  }
})

test('Eaon Event’s code check with the gateway is signed too', async () => {
  setGatewayAppForTests(APP)
  seen.length = 0
  // The stand-in answers with a model list, not a code: what matters here is that the request was signed.
  await redeemFreeCode('EAON-ABCD-EFGH-JKMN')
  assert.deepEqual(seen, ['ok'])
  forgetCode()
})

test('turned away by an "Eaon apps only" gateway, the advice is to update, never to fix a key Eaon’s models don’t have', async () => {
  const { classifyProviderError } = await import('../src/main/providers/errors')
  setGatewayAppForTests(APP)
  const { ProviderHttpError } = await import('../src/main/providers/adapters/types')
  const lite = { id: 'eaon-gateway', name: 'Eaon Lite', auth: 'none' as const, local: false, baseUrl: 'https://gateway.eaon.dev/v1' }
  const refused = (message: string): Error => new ProviderHttpError(401, JSON.stringify({ error: { message, type: 'authentication_error', code: 'eaon_apps_only' } }))
  for (const message of ['This API only works inside Eaon apps: the Eaon desktop app and the Eaon CLIs.', "This Eaon app isn't allowed to use the API.", "This request's Eaon app signature doesn't match."]) {
    const found = classifyProviderError(refused(message), lite)
    assert.match(found.message, /Update Eaon/, message)
    assert.equal(found.action, 'choose-model')
  }
  assert.equal(classifyProviderError(refused("This Eaon app can't be verified right now."), lite).action, 'retry')
  // Another provider's 401 is still about its key.
  assert.match(classifyProviderError(new ProviderHttpError(401, 'invalid_api_key'), { ...lite, id: 'openai', name: 'OpenAI', auth: 'key', baseUrl: 'https://api.openai.com/v1' }).message, /rejected the API key/)

  // A build without the app's credentials can't sign however new it is: updating isn't the answer.
  setGatewayAppForTests(null)
  const unsigned = classifyProviderError(refused('This API only works inside Eaon apps: the Eaon desktop app and the Eaon CLIs.'), lite)
  assert.doesNotMatch(unsigned.message, /Update Eaon/)
  assert.match(unsigned.message, /isn’t available in this copy of Eaon right now/)
  assert.equal(unsigned.action, 'choose-model')
})
