import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { createConnectors, opensTheHouse, unreachable } from '../src/main/features/workers/connectors'
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

test('a request that never got an answer says why, not “fetch failed”', async () => {
  assert.equal(unreachable(failed('ECONNREFUSED')), 'nothing answered at that address and port')
  assert.match(unreachable(failed('DEPTH_ZERO_SELF_SIGNED_CERT')), /certificate/)
  assert.match(unreachable(failed('ENOTFOUND')), /name isn’t found/)
  const connectors = createConnectors({ fetch: fake(() => failed('ECONNREFUSED')).fetch, ...vault() })
  await assert.rejects(() => connectors.connect('home-assistant', { url: 'http://homeassistant.local:8123', token: 't' }), /Couldn’t reach Home Assistant: nothing answered at that address and port\./)
})
