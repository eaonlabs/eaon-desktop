import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { createConnectors, opensTheHouse, unreachable } from '../src/main/features/workers/connectors'
import { createHue, stateBody, type HueBridge } from '../src/main/features/workers/hue'
import { uberLink } from '@shared/workerLinks'
import type { ConnectorId } from '@shared/workerConnectors'

/**
 * Where workers' connections met the services' own rules and came out wrong:
 * Home Assistant's data-only services, what counts as opening the house,
 * SimpleFIN's pending transactions and daily limit, why a request never got
 * an answer, Uber's universal link, a Hue bridge that moved, and a Passwords
 * wait that ends.
 */

const g = globalThis as { __EAON_LABS__?: boolean }
beforeEach(() => {
  g.__EAON_LABS__ = true
})
afterEach(() => {
  delete g.__EAON_LABS__
})

type Call = { url: string; method: string; body: string | null }
type Reply = { status?: number; json?: unknown; text?: string } | Error

function fake(route: (call: Call) => Reply) {
  const calls: Call[] = []
  const fetch = (async (url: string, init: RequestInit = {}) => {
    const call: Call = { url, method: init.method ?? 'GET', body: typeof init.body === 'string' ? init.body : null }
    calls.push(call)
    const reply = route(call)
    if (reply instanceof Error) throw reply
    const status = reply.status ?? 200
    const body = reply.text !== undefined ? reply.text : JSON.stringify(reply.json ?? null)
    return { ok: status >= 200 && status < 300, status, headers: new Map(), text: async () => body, json: async () => JSON.parse(body) } as unknown as Response
  }) as unknown as typeof fetch
  return { fetch, calls }
}

function vault() {
  const data = new Map<string, string>()
  return { load: (id: ConnectorId) => data.get(id), save: (id: ConnectorId, v: string | null) => (v ? data.set(id, v) : data.delete(id)), data }
}

/** Node's fetch failing to connect: "fetch failed", the reason in its cause. */
const failed = (code: string): Error => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(`connect ${code} 192.168.1.20:80`), { code }) })

test('Home Assistant: a service that answers with data is asked for its answer, only when it says so', async () => {
  const { fetch, calls } = fake((call) => {
    if (call.url.endsWith('/api/states')) return { json: [] }
    if (call.url.endsWith('/api/services/todo/get_items')) {
      return { status: 400, json: { message: 'Service call requires responses but caller did not ask for responses. Add ?return_response to query parameters.' } }
    }
    if (call.url.endsWith('/api/services/todo/get_items?return_response')) {
      return { json: { changed_states: [], service_response: { 'todo.shopping_list': { items: [{ summary: 'Oat milk', status: 'needs_action' }] } } } }
    }
    if (call.url.endsWith('/api/services/light/turn_on')) return { status: 400, json: { message: 'extra keys not allowed @ data[\'colour\']' } }
    return { status: 404, text: 'no' }
  })
  const v = vault()
  const connectors = createConnectors({ fetch, load: v.load, save: v.save })
  await connectors.connect('home-assistant', { url: 'http://ha.local:8123', token: 't' })
  const { changed, response } = await connectors.ha.call('todo', 'get_items', { entity_id: 'todo.shopping_list' })
  assert.deepEqual(changed, [])
  assert.deepEqual(response, { 'todo.shopping_list': { items: [{ summary: 'Oat milk', status: 'needs_action' }] } })
  assert.deepEqual(
    calls.filter((c) => c.method === 'POST').map((c) => c.url.replace('http://ha.local:8123', '')),
    ['/api/services/todo/get_items', '/api/services/todo/get_items?return_response'],
    'asked plainly first: a service with no answer refuses ?return_response'
  )
  // Any other 400 is the worker's to fix, not asked again.
  await assert.rejects(() => connectors.ha.call('light', 'turn_on', { colour: 'red' }), /answered 400.*extra keys/)
  assert.equal(calls.filter((c) => c.url.includes('light/turn_on')).length, 1)
})

test('opening the house: the entity in the data counts, and so do covers opened by position, by area, or through homeassistant', () => {
  assert.ok(opensTheHouse('cover', 'open_cover', '', { entity_id: 'cover.garage_door' }), 'entity_id in data, none beside it')
  assert.ok(opensTheHouse('cover', 'open_cover', '', { entity_id: ['cover.blinds', 'cover.side_gate'] }), 'one of a list')
  assert.ok(opensTheHouse('cover', 'open_cover', '', { area_id: 'garage' }), 'by area: which covers can’t be told')
  assert.ok(opensTheHouse('cover', 'open_cover', 'all'))
  assert.ok(opensTheHouse('cover', 'set_cover_position', 'cover.garage_door', { position: 100 }))
  assert.ok(!opensTheHouse('cover', 'set_cover_position', 'cover.garage_door', { position: 0 }), 'position 0 closes it')
  assert.ok(opensTheHouse('homeassistant', 'turn_on', 'cover.garage_door'), 'homeassistant.turn_on opens a cover')
  assert.ok(opensTheHouse('homeassistant', 'toggle', '', { entity_id: 'lock.front_door' }))
  assert.ok(!opensTheHouse('homeassistant', 'turn_off', 'cover.garage_door'), 'turn_off closes it')
  assert.ok(!opensTheHouse('homeassistant', 'turn_on', 'light.porch'))
  assert.ok(!opensTheHouse('cover', 'open_cover', 'cover.living_room_blinds'))
  assert.ok(!opensTheHouse('cover', 'close_cover', '', { area_id: 'garage' }))
  assert.ok(opensTheHouse('lock', 'unlock', ''))
})

test('SimpleFIN: a pending transaction with no time yet is kept, as now; one problem said once; a failure isn’t asked again at once', async () => {
  const claim = 'https://bridge.example/simplefin/claim/x'
  const now = Math.floor(Date.now() / 1000)
  let answer: 'ok' | 'down' = 'ok'
  const { fetch, calls } = fake((call) => {
    if (call.url === claim) return { text: 'https://u:p@bridge.example/simplefin' }
    if (!call.url.includes('/accounts')) return { status: 404, text: '' }
    if (answer === 'down') return { status: 500, text: 'bridge trouble' }
    return {
      json: {
        errlist: [{ code: 'con.auth', msg: 'Chase needs you to sign in again' }],
        errors: ['Chase needs you to sign in again'],
        connections: [{ conn_id: 'c1', name: 'Chase' }],
        accounts: [
          {
            id: 'a1',
            name: 'Checking',
            conn_id: 'c1',
            currency: 'USD',
            balance: '50.00',
            'balance-date': now,
            transactions: [
              { id: 'p', posted: 0, amount: '-7.25', description: 'TACO TRUCK', pending: true },
              { id: 'd', posted: now - 2 * 86400, amount: '-3.00', description: 'BAKERY' }
            ]
          }
        ]
      }
    }
  })
  const v = vault()
  const connectors = createConnectors({ fetch, load: v.load, save: v.save })
  await connectors.connect('simplefin', { setupToken: Buffer.from(claim).toString('base64') })
  const { accounts, problems } = await connectors.simplefin.accounts({ days: 7 })
  const tx = accounts[0].transactions ?? []
  assert.deepEqual(tx.map((t) => t.id), ['p', 'd'], 'the pending one is in the last 7 days, not dated 1970')
  assert.ok(Math.abs((tx[0].at ?? 0) - now) < 120)
  assert.deepEqual(problems, ['Chase needs you to sign in again'], 'errlist and the older errors say the same thing once')

  // A fresh connection whose /accounts is failing: the token is spent, so the access is kept, and says so.
  answer = 'down'
  const other = vault()
  const again = createConnectors({ fetch, load: other.load, save: other.save })
  const status = await again.connect('simplefin', { setupToken: Buffer.from(claim).toString('base64') })
  assert.equal(status.connected, true)
  assert.match(status.detail ?? '', /^Connected; accounts not read yet: SimpleFIN answered 500/)
  const asked = calls.filter((c) => c.url.includes('/accounts')).length
  await assert.rejects(() => again.simplefin.accounts(), /answered 500.*asks again in a few minutes/)
  assert.equal(calls.filter((c) => c.url.includes('/accounts')).length, asked, 'not asked again within minutes (24 a day)')
})

test('SimpleFIN: a setup token used already says so in SimpleFIN’s words; a refused access isn’t kept', async () => {
  const claim = 'https://bridge.example/simplefin/claim/used'
  const used = createConnectors({ fetch: fake(() => ({ status: 403, text: 'Forbidden' })).fetch, ...vault() })
  await assert.rejects(() => used.connect('simplefin', { setupToken: Buffer.from(claim).toString('base64') }), /used already.*someone else may have/)
  const v = vault()
  const refused = createConnectors({ fetch: fake((c) => (c.url === claim ? { text: 'https://u:p@bridge.example/s' } : { status: 403, text: '' })).fetch, load: v.load, save: v.save })
  await assert.rejects(() => refused.connect('simplefin', { setupToken: Buffer.from(claim).toString('base64') }), /refused the key/)
  assert.equal(refused.connected('simplefin'), false)
})

test('a request that never got an answer says why, not “fetch failed”', async () => {
  assert.equal(unreachable(failed('ECONNREFUSED')), 'nothing answered at that address and port')
  assert.match(unreachable(failed('DEPTH_ZERO_SELF_SIGNED_CERT')), /certificate/)
  assert.match(unreachable(failed('ENOTFOUND')), /name isn’t found/)
  const connectors = createConnectors({ fetch: fake(() => failed('ECONNREFUSED')).fetch, ...vault() })
  await assert.rejects(() => connectors.connect('home-assistant', { url: 'http://homeassistant.local:8123', token: 't' }), /Couldn’t reach Home Assistant: nothing answered at that address and port\./)
})

test('Uber: the universal link Uber documents, places as JSON, so a computer’s browser keeps the destination', () => {
  const link = uberLink({ to: 'SFO Terminal 2', toAt: { latitude: 37.6168, longitude: -122.3839 } })
  const url = new URL(link)
  assert.equal(`${url.origin}${url.pathname}`, 'https://m.uber.com/looking')
  assert.deepEqual(JSON.parse(url.searchParams.get('drop[0]')!), { latitude: 37.6168, longitude: -122.3839, addressLine1: 'SFO Terminal 2' })
  assert.equal(url.searchParams.get('pickup'), null, 'pickup left to Uber: where the user is')
  const from = new URL(uberLink({ to: 'SFO', from: '1 Market St', fromAt: { latitude: 37.79, longitude: -122.39 } }))
  assert.deepEqual(JSON.parse(from.searchParams.get('pickup')!), { latitude: 37.79, longitude: -122.39, addressLine1: '1 Market St' })
  assert.deepEqual(JSON.parse(from.searchParams.get('drop[0]')!), { addressLine1: 'SFO' }, 'no coordinates: the address alone')
})

/** A Hue bridge that can move: `at` is where it answers now. */
function movingBridge() {
  let at = '192.168.1.20'
  let finder: 'ok' | 'limited' = 'ok'
  const asked: string[] = []
  const fetch = (async (url: string, init?: RequestInit) => {
    asked.push(`${init?.method ?? 'GET'} ${url}`)
    const json = (value: unknown) => ({ ok: true, status: 200, json: async () => value })
    if (url === 'https://discovery.meethue.com/') return finder === 'ok' ? json([{ id: '001788fffe1234ab', internalipaddress: at }]) : { ok: false, status: 429, json: async () => ({}) }
    const host = new URL(url).hostname
    if (host !== at) throw failed('EHOSTUNREACH')
    if (url.endsWith('/api') && init?.method === 'POST') return json([{ success: { username: 'KEY' } }])
    if (url.endsWith('/api/config')) return json({ name: 'Hue Bridge', bridgeid: '001788FFFE1234AB' })
    if (url.endsWith('/lights')) return json({ '1': { name: 'Desk lamp', state: { on: false, bri: 254, reachable: true } } })
    if (url.endsWith('/groups')) return json({})
    if (init?.method === 'PUT') return json([{ success: {} }])
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
  let saved: HueBridge | null = null
  const hue = createHue({ fetch, load: () => saved, save: (b) => (saved = b) })
  return { hue, asked, saved: () => saved, move: (ip: string) => (at = ip), limit: () => (finder = 'limited') }
}

test('Hue: a bridge paired by its address keeps its id, and is followed to a new address; whites by name are whites', async () => {
  const bridge = movingBridge()
  bridge.limit()
  await assert.rejects(() => bridge.hue.pair(), /bridge finder answered 429\. Type the bridge’s IP address instead/)
  assert.deepEqual(await bridge.hue.pair('http://192.168.1.20/'), { ip: '192.168.1.20', id: '001788fffe1234ab', username: 'KEY' }, 'typed with http:// and a slash, and its id read')

  bridge.move('192.168.1.31')
  await assert.rejects(() => bridge.hue.lights(), /Couldn’t reach the Hue bridge at 192\.168\.1\.20: that address isn’t reachable/, 'the finder is limited: nothing to follow')
  const finderOk = movingBridge()
  await finderOk.hue.pair('192.168.1.20')
  finderOk.move('192.168.1.31')
  assert.equal((await finderOk.hue.lights())[0].name, 'Desk lamp', 'found again where it went')
  assert.equal(finderOk.saved()?.ip, '192.168.1.31', 'and kept there')
  assert.equal(await finderOk.hue.set('desk', { color: 'warm white' }), 'Desk lamp: on, warm white')
  assert.deepEqual(stateBody({ color: 'Warm white', brightness: 40 }), { bri: 102, on: true, ct: 370 })
  assert.deepEqual(stateBody({ color: 'daylight' }), { ct: 153, on: true })
  assert.deepEqual(stateBody({ color: 'white' }).xy !== undefined, true, 'plain white is still the colour')
})
