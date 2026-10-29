import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../src/main/agent/sources'
import type { ToolContext } from '../src/main/agent/tools'
import { store } from '../src/main/store'
import { createWorkersService, type WorkersService } from '../src/main/features/workers/service'
import type { FeatureContext } from '../src/main/features/types'
import { connectedLines, connectorTools, createConnectors, opensTheHouse, type Connectors } from '../src/main/features/workers/connectors'
import { cashAppLink, googleMapsLink, lyftLink, uberLink, venmoLink, wazeLink } from '@shared/workerLinks'
import { CONNECTORS, type ConnectorId } from '@shared/workerConnectors'
import { WORKER_APPS } from '@shared/workerApps'
import type { StreamRequest } from '@shared/types'

/**
 * The services behind workers' apps — Home Assistant, Tessie, SimpleFIN,
 * Instacart, Google Routes — against fake servers, the tools a worker gets
 * from them, and the confirm-with-a-tap links.
 */

const g = globalThis as { __EAON_LABS__?: boolean }
let service: WorkersService | null = null
let root = ''

beforeEach(() => {
  store.setJson('workers.json', [])
  root = mkdtempSync(join(tmpdir(), 'eaon-connectors-'))
  store.patchSettings({ work: { ...store.getSettings().work, defaultFolder: root } })
  g.__EAON_LABS__ = true
})
afterEach(async () => {
  service?.stop()
  await service?.engine.whenIdle()
  service = null
  delete g.__EAON_LABS__
  await store.flushWrites()
})

function engine() {
  const ctx = { ipcMain: { handle: () => {} }, getWindow: () => null, send: () => {}, emitStream: () => {} } as unknown as FeatureContext
  service = createWorkersService(ctx, { runAgent: async () => ({ text: 'ok', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }), startDelayMs: 60_000 })
  service.start()
  return service.engine
}

const ctxFor = (workerId: string): ToolContext => ({
  request: { workerId } as StreamRequest,
  turn: { notes: [] },
  cwd: root,
  signal: new AbortController().signal,
  emit: () => {},
  toolId: 't',
  depth: 0,
  readOnly: false,
  settings: store.getSettings(),
  progress: () => {},
  confirm: async () => true
})

type Call = { url: string; method: string; headers: Record<string, string>; body: string | null }

/** One fake fetch standing in for every service; `routes` maps "METHOD url-prefix" to a reply. */
function fakeServices(routes: Record<string, (call: Call) => { status?: number; json?: unknown; text?: string; bytes?: Buffer; type?: string }>) {
  const calls: Call[] = []
  const fetch = (async (url: string, init: RequestInit = {}) => {
    const call: Call = { url, method: init.method ?? 'GET', headers: (init.headers as Record<string, string>) ?? {}, body: typeof init.body === 'string' ? init.body : null }
    calls.push(call)
    const key = Object.keys(routes).find((k) => {
      const [method, prefix] = k.split(' ')
      return method === call.method && url.startsWith(prefix)
    })
    const reply = key ? routes[key](call) : { status: 404, text: 'not here' }
    const status = reply.status ?? 200
    const body = reply.bytes ?? (reply.text !== undefined ? reply.text : JSON.stringify(reply.json ?? null))
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Map([['content-type', reply.type ?? 'application/json']]) as unknown as Headers,
      text: async () => String(body),
      json: async () => reply.json,
      arrayBuffer: async () => (reply.bytes ? reply.bytes.buffer.slice(reply.bytes.byteOffset, reply.bytes.byteOffset + reply.bytes.length) : new ArrayBuffer(0))
    } as unknown as Response
  }) as unknown as typeof fetch
  return { fetch, calls }
}

function vault() {
  const data = new Map<string, string>()
  return { load: (id: ConnectorId) => data.get(id), save: (id: ConnectorId, v: string | null) => (v ? data.set(id, v) : data.delete(id)), data }
}

/* ---------------------------------------------------------------- links */

test('links: Venmo, Cash App, Uber, Lyft, Maps and Waze, filled in and checked', () => {
  assert.equal(venmoLink({ to: '@sam-lee', amount: 24, note: 'Thai food' }), 'https://venmo.com/sam-lee?txn=pay&amount=24.00&note=Thai+food')
  assert.equal(venmoLink({ to: 'sam', amount: 12.345, request: true }), 'https://venmo.com/sam?txn=charge&amount=12.35')
  assert.throws(() => venmoLink({ to: 'sam lee', amount: 5 }), /username/)
  assert.throws(() => venmoLink({ to: 'sam', amount: 0 }), /amount/)
  assert.equal(cashAppLink({ to: '$samlee', amount: 10 }), 'https://cash.app/$samlee/10.00')
  assert.equal(cashAppLink({ to: 'samlee' }), 'https://cash.app/$samlee')
  assert.throws(() => cashAppLink({ to: '$1sam' }), /Cashtag/)
  const uber = uberLink({ to: 'SFO Terminal 2', toAt: { latitude: 37.6, longitude: -122.38 } })
  assert.match(uber, /^https:\/\/m\.uber\.com\/ul\/\?action=setPickup&pickup=my_location&dropoff%5Bformatted_address%5D=SFO%20Terminal%202&dropoff%5Blatitude%5D=37\.6/)
  assert.equal(lyftLink({}), 'https://ride.lyft.com/')
  assert.match(lyftLink({ toAt: { latitude: 1, longitude: 2 } }), /destination\[latitude\]=1&destination\[longitude\]=2/)
  assert.match(googleMapsLink({ to: 'Work', mode: 'transit' }), /destination=Work&travelmode=transit$/)
  assert.equal(wazeLink({ to: 'x', toAt: { latitude: 1, longitude: 2 } }), 'https://waze.com/ul?ll=1,2&navigate=yes')
})

test('every connector an app names exists, and hub apps name at least one', () => {
  const ids = new Set(CONNECTORS.map((c) => c.id))
  for (const app of WORKER_APPS) {
    for (const c of app.connectors ?? []) assert.ok(ids.has(c), `${app.name}: ${c}`)
    if (app.via === 'hub') assert.ok((app.connectors ?? []).length > 0, app.name)
  }
})

/* ---------------------------------------------------------------- Home Assistant */

test('Home Assistant: connect checks the token first; devices, a service call and a camera snapshot', async () => {
  const states = [
    { entity_id: 'vacuum.roborock_s8', state: 'docked', attributes: { friendly_name: 'Roborock S8', battery_level: 64 } },
    { entity_id: 'lock.front_door', state: 'locked', attributes: { friendly_name: 'Front door' } },
    { entity_id: 'sun.sun', state: 'above_horizon', attributes: {} },
    { entity_id: 'camera.front_door', state: 'idle', attributes: { friendly_name: 'Front door camera' } }
  ]
  let token = 'good'
  const { fetch, calls } = fakeServices({
    'GET http://ha.local:8123/api/states': (call) => (call.headers.Authorization === `Bearer ${token}` ? { json: states } : { status: 401 }),
    'POST http://ha.local:8123/api/services/vacuum/start': () => ({ json: [{ ...states[0], state: 'cleaning' }] }),
    'GET http://ha.local:8123/api/camera_proxy/camera.front_door': () => ({ bytes: Buffer.from('JPEGDATA'), type: 'image/jpeg' })
  })
  const v = vault()
  const connectors = createConnectors({ fetch, load: v.load, save: v.save })
  token = 'other'
  await assert.rejects(() => connectors.connect('home-assistant', { url: 'http://ha.local:8123/lovelace', token: 'good' }), /refused the key/)
  assert.equal(connectors.connected('home-assistant'), false, 'a token that fails isn’t kept')
  token = 'good'
  await assert.rejects(() => connectors.connect('home-assistant', { url: 'ftp://x', token: 'good' }), /address/)
  const status = await connectors.connect('home-assistant', { url: 'http://ha.local:8123/lovelace', token: 'good' })
  assert.deepEqual(status, { connected: true, detail: 'ha.local:8123 · 4 entities' })
  assert.ok(!JSON.stringify(status).includes('good'))

  const e = engine()
  const home = e.save({ name: 'Home', color: '#3E86C6', personality: '', purpose: 'x', apps: ['roborock'] })
  const tools = connectorTools(e, connectors, e.appsOf(home.id))
  const tool = tools.find((t) => t.name === 'home')!
  const devices = String(await tool.run({ action: 'devices' }, ctxFor(home.id)))
  assert.match(devices, /vacuum\.roborock_s8 \(Roborock S8\): docked · battery 64%/)
  assert.ok(!devices.includes('sun.sun'), 'only device-like entities')
  assert.match(String(await tool.run({ action: 'do', domain: 'vacuum', service: 'start', entity: 'vacuum.roborock_s8' }, ctxFor(home.id))), /cleaning/)
  assert.equal(JSON.parse(calls.find((c) => c.url.endsWith('/vacuum/start'))!.body!).entity_id, 'vacuum.roborock_s8')
  const snap = String(await tool.run({ action: 'snapshot', entity: 'camera.front_door' }, ctxFor(home.id)))
  const file = /Saved the snapshot to (\S+)\./.exec(snap)![1]
  assert.ok(existsSync(file) && readFileSync(file, 'utf8') === 'JPEGDATA')
  await assert.rejects(() => tool.run({ action: 'do', domain: 'Vacuum; rm', service: 'start' }, ctxFor(home.id)), /lower-case/)

  // Letting someone in is always the user's call.
  assert.equal(await tool.catastrophic!({ action: 'do', domain: 'lock', service: 'unlock', entity: 'lock.front_door' }, ctxFor(home.id)), true)
  assert.equal(await tool.catastrophic!({ action: 'do', domain: 'lock', service: 'lock', entity: 'lock.front_door' }, ctxFor(home.id)), false)
  assert.ok(opensTheHouse('cover', 'open_cover', 'cover.garage_door'))
  assert.ok(!opensTheHouse('cover', 'open_cover', 'cover.living_room_blinds'))
  assert.ok(opensTheHouse('alarm_control_panel', 'alarm_disarm', 'alarm_control_panel.home'))

  connectors.disconnect('home-assistant')
  assert.equal(connectorTools(e, connectors, e.appsOf(home.id)).some((t) => t.name === 'home'), false)
  assert.match(connectedLines(connectors, e.appsOf(home.id)).join('\n'), /Roborock needs Home Assistant/)
})

/* ---------------------------------------------------------------- Tessie */

test('Tessie: status of the car, a command, a charge limit, and unlocking waits for the user', async () => {
  const VIN = '5YJ3E1EA7KF000001'
  const { fetch, calls } = fakeServices({
    'GET https://api.tessie.com/vehicles': () => ({
      json: { results: [{ vin: VIN, is_active: true, last_state: { display_name: 'Blue', charge_state: { battery_level: 72, battery_range: 211.4, charging_state: 'Disconnected', charge_limit_soc: 80 }, climate_state: { inside_temp: 19, is_climate_on: false }, vehicle_state: { locked: true } } }] }
    }),
    'POST https://api.tessie.com/': () => ({ json: { result: true } })
  })
  const v = vault()
  const connectors = createConnectors({ fetch, load: v.load, save: v.save })
  assert.equal((await connectors.connect('tessie', { token: 'tok' })).detail, 'Blue')
  const e = engine()
  const w = e.save({ name: 'Car', color: '#3E86C6', personality: '', purpose: 'x', apps: ['tesla'] })
  const tool = connectorTools(e, connectors, e.appsOf(w.id)).find((t) => t.name === 'tesla')!
  assert.match(String(await tool.run({ action: 'status' }, ctxFor(w.id))), /Blue \(VIN 5YJ3E1EA7KF000001\): · battery 72%, 211 mi range · charging: Disconnected · limit 80% · inside 19°C · locked/)
  assert.match(String(await tool.run({ action: 'command', command: 'start_climate' }, ctxFor(w.id))), /Done: start climate/)
  await tool.run({ action: 'command', command: 'set_charge_limit', percent: 120 }, ctxFor(w.id))
  assert.ok(calls.some((c) => c.url === `https://api.tessie.com/${VIN}/command/set_charge_limit?percent=100`), 'clamped to 100')
  assert.ok(calls.every((c) => c.headers.Authorization === 'Bearer tok'))
  assert.equal(await tool.catastrophic!({ action: 'command', command: 'unlock' }, ctxFor(w.id)), true)
  assert.equal(await tool.catastrophic!({ action: 'command', command: 'lock' }, ctxFor(w.id)), false)
})

/* ---------------------------------------------------------------- SimpleFIN */

test('SimpleFIN: the setup token is claimed once, credentials go in a header, balances and transactions read', async () => {
  const claim = 'https://bridge.example/simplefin/claim/abc'
  const token = Buffer.from(claim).toString('base64')
  const now = Math.floor(Date.now() / 1000)
  const { fetch, calls } = fakeServices({
    [`POST ${claim}`]: () => ({ text: 'https://user:p%40ss@bridge.example/simplefin' }),
    'GET https://bridge.example/simplefin/accounts': (call) =>
      call.headers.Authorization === `Basic ${Buffer.from('user:p@ss').toString('base64')}`
        ? {
            json: {
              errlist: [],
              connections: [{ conn_id: 'c1', name: 'Chase' }],
              accounts: [
                { id: 'a1', name: 'Checking', conn_id: 'c1', currency: 'USD', balance: '1204.55', 'available-balance': '1100.00', 'balance-date': now, transactions: [{ id: 't1', posted: now - 86400, amount: '-18.40', description: 'THAI BASIL' }, { id: 't2', posted: now, amount: '2500.00', description: 'PAYROLL' }] }
              ]
            }
          }
        : { status: 403 }
  })
  const v = vault()
  const connectors = createConnectors({ fetch, load: v.load, save: v.save })
  await assert.rejects(() => connectors.connect('simplefin', { setupToken: 'not base64 at all!!' }), /isn’t a SimpleFIN setup token/)
  const status = await connectors.connect('simplefin', { setupToken: token })
  assert.equal(status.detail, '1 account at Chase')
  assert.ok(!calls.some((c) => c.url.includes('user:')), 'credentials never in a URL')
  assert.match(v.data.get('simplefin')!, /accessUrl/, 'the access address is kept, not the setup token')
  const e = engine()
  const w = e.save({ name: 'Money', color: '#3E86C6', personality: '', purpose: 'x', apps: ['bank'] })
  const tool = connectorTools(e, connectors, e.appsOf(w.id)).find((t) => t.name === 'bank')!
  assert.equal(tool.mutating, false)
  assert.match(String(await tool.run({ action: 'balances' }, ctxFor(w.id))), /Chase · Checking: \$1,204\.55 \(available \$1,100\.00\)/)
  const tx = String(await tool.run({ action: 'transactions', days: 7 }, ctxFor(w.id)))
  assert.ok(tx.indexOf('PAYROLL') < tx.indexOf('THAI BASIL'), 'newest first')
  assert.match(tx, /-\$18\.40 THAI BASIL — Checking/)
})

/* ---------------------------------------------------------------- Instacart, Google Routes, links tool */

test('Instacart list pages, live traffic routes with Uber and Waze links, and app_link for payments', async () => {
  const { fetch, calls } = fakeServices({
    'POST https://connect.instacart.com/idp/v1/products/products_link': (call) => (call.headers.Authorization === 'Bearer ik' ? { json: { products_link_url: 'http://www.instacart.com/store/list/123' } } : { status: 401 }),
    'POST https://routes.googleapis.com/directions/v2:computeRoutes': (call) =>
      call.headers['X-Goog-Api-Key'] === 'gk'
        ? { json: { routes: [{ duration: '1800s', staticDuration: '1320s', distanceMeters: 22530, description: 'US-101 S', legs: [{ startLocation: { latLng: { latitude: 37.79, longitude: -122.4 } }, endLocation: { latLng: { latitude: 37.62, longitude: -122.38 } } }] }] } }
        : { status: 403 }
  })
  const v = vault()
  const connectors = createConnectors({ fetch, load: v.load, save: v.save })
  await connectors.connect('instacart', { key: 'ik' })
  await connectors.connect('google-routes', { key: 'gk' })
  const e = engine()
  const w = e.save({ name: 'Errands', color: '#3E86C6', personality: '', purpose: 'x', apps: ['instacart', 'google-maps', 'uber', 'venmo'] })
  const tools = connectorTools(e, connectors, e.appsOf(w.id))
  assert.deepEqual(tools.map((t) => t.name), ['instacart', 'route', 'app_link'])

  const list = String(await tools[0].run({ title: 'Groceries', items: ['milk', 'eggs'] }, ctxFor(w.id)))
  assert.match(list, /https:\/\/www\.instacart\.com\/store\/list\/123/)
  const body = JSON.parse(calls.filter((c) => c.url.includes('instacart')).at(-1)!.body!)
  assert.deepEqual(body.line_items.map((i: { name: string }) => i.name), ['milk', 'eggs'])

  const route = String(await tools[1].run({ from: '1 Market St', to: 'SFO', mode: 'drive' }, ctxFor(w.id)))
  assert.match(route, /^30 min \(usually 22\) · 14 mi · via US-101 S · moderate traffic/)
  assert.match(route, /Waze: https:\/\/waze\.com\/ul\?ll=37\.62,-122\.38/)
  assert.match(route, /Uber: https:\/\/m\.uber\.com\/ul\/.*dropoff%5Blatitude%5D=37\.62/)
  const sent = JSON.parse(calls.filter((c) => c.url.includes('routes')).at(-1)!.body!)
  assert.equal(sent.routingPreference, 'TRAFFIC_AWARE')

  assert.match(String(await tools[2].run({ app: 'venmo', to: '@sam', amount: 24, note: 'dinner' }, ctxFor(w.id))), /^https:\/\/venmo\.com\/sam\?txn=pay&amount=24\.00&note=dinner\nNothing happens until/)
  const cash = await tools[2].run({ app: 'cashapp', to: '$sam', amount: 5 }, ctxFor(w.id))
  assert.ok(typeof cash === 'object' && cash.isError, 'Cash App isn’t linked to this worker')
})

test('without connections, a worker still gets route links and app_link, and is told what is missing', () => {
  const v = vault()
  const connectors: Connectors = createConnectors({ fetch: (async () => ({ ok: false, status: 500, text: async () => '' })) as unknown as typeof fetch, load: v.load, save: v.save })
  const e = engine()
  const w = e.save({ name: 'Plain', color: '#3E86C6', personality: '', purpose: 'x', apps: ['waze', 'cashapp', 'tesla', 'bank'] })
  assert.deepEqual(connectorTools(e, connectors, e.appsOf(w.id)).map((t) => t.name), ['route', 'app_link'])
  const lines = connectedLines(connectors, e.appsOf(w.id)).join('\n')
  assert.match(lines, /Tesla isn’t connected/)
  assert.match(lines, /no SimpleFIN connection/)
  assert.match(lines, /no live times/)
  delete g.__EAON_LABS__
  assert.deepEqual(connectorTools(e, connectors, e.appsOf(w.id)), [], 'a release build has none')
})

test('every logo an app or connection names is a bundled 128px app icon', async () => {
  const { readFileSync: read, existsSync: exists } = await import('node:fs')
  const dir = join(process.cwd(), 'src/renderer/src/assets/app-logos')
  const logos = [...WORKER_APPS.map((a) => a.logo), ...CONNECTORS.map((c) => c.logo)].filter((l): l is string => Boolean(l))
  assert.ok(logos.length >= 25)
  // Only the two that aren't one brand go without.
  assert.deepEqual(WORKER_APPS.filter((a) => !a.logo).map((a) => a.id), ['bank', 'lists'])
  assert.ok(CONNECTORS.every((c) => c.logo))
  for (const logo of new Set(logos)) {
    const file = join(dir, logo)
    assert.ok(exists(file), logo)
    const png = read(file)
    assert.equal(png.toString('latin1', 1, 4), 'PNG', `${logo} is a PNG`)
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [128, 128], `${logo} is 128px square`)
  }
})
