import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../src/main/agent/sources'
import { toolsFor, type AgentTool, type ToolContext, type ToolQuery } from '../src/main/agent/tools'
import { store } from '../src/main/store'
import { createWorkersService, type WorkersService } from '../src/main/features/workers/service'
import type { RunAgent } from '../src/main/features/workers/runner'
import type { FeatureContext } from '../src/main/features/types'
import type { WorkerBrowsers } from '../src/main/features/workers/browser'
import { appsToolSource, signInApp, signedInByHand } from '../src/main/features/workers/apps'
import { createHue, stateBody, toXy, type HueBridge } from '../src/main/features/workers/hue'
import { createLists, listText } from '../src/main/features/workers/lists'
import { createHousehold } from '../src/main/features/workers/household'
import { normalizeCard, routeLinks, CARD_IMAGE_MARK } from '@shared/workerCards'
import { appLine, availableOn, findWorkerApp, onDomain, signInTarget, workerApp, WORKER_APPS, workerAppsEnabled } from '@shared/workerApps'
import { DEFAULT_SHAPE, shapeSpec, WORKER_SHAPES } from '@shared/workerLook'
import { TRADING_DESK, WORKER_SUGGESTIONS, type WorkerDraft } from '@shared/workers'
import type { StreamRequest } from '@shared/types'
import { turnItems } from '../src/renderer/src/components/agent/turnItems'

/**
 * Workers' linked apps (labs), cards, shapes and per-worker plugins: the
 * card format, the app catalog and sign-in rules, the Hue bridge client,
 * shared lists, Calendar/Reminders scripts, the tools a worker is offered
 * for the apps it has, and the sign-in sheet's path into its browser.
 */

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }
const MODEL = { providerId: 'ollama', modelId: 'fake-model' }
let service: WorkersService | null = null
let root = ''

const g = globalThis as { __EAON_LABS__?: boolean }

beforeEach(() => {
  store.setJson('workers.json', [])
  root = mkdtempSync(join(tmpdir(), 'eaon-worker-apps-'))
  const settings = store.getSettings()
  store.patchSettings({ work: { ...settings.work, defaultFolder: root } })
  g.__EAON_LABS__ = true
})

afterEach(async () => {
  service?.stop()
  await service?.engine.whenIdle()
  service = null
  delete g.__EAON_LABS__
  await store.flushWrites()
})

function start(runAgent?: RunAgent) {
  const ctx = {
    ipcMain: { handle: () => {} },
    getWindow: () => null,
    send: () => {},
    emitStream: () => {}
  } as unknown as FeatureContext
  const agent: RunAgent =
    runAgent ??
    (async (request, emit) => {
      emit({ type: 'delta', messageId: request.messageId, text: 'Ordered. **Pad thai** is on the way.\nMore detail here.' })
      emit({ type: 'done', messageId: request.messageId })
      return { text: 'Ordered. **Pad thai** is on the way.\nMore detail here.', usage }
    })
  service = createWorkersService(ctx, { runAgent: agent, startDelayMs: 60_000 })
  service.start()
  service.engine.start()
  return service.engine
}

const draft = (name: string, extra: Partial<WorkerDraft> = {}): WorkerDraft => ({ name, color: '#3E86C6', personality: '', purpose: `${name}'s job`, model: MODEL, ...extra })

function query(workerId: string, readOnly = false): ToolQuery {
  const settings = store.getSettings()
  return {
    mode: 'work',
    cwd: root,
    depth: 0,
    readOnly,
    settings,
    request: { chatId: `worker:${workerId}`, messageId: 'm1', mode: 'work', workerId, messages: [] } as unknown as StreamRequest
  }
}

function ctxFor(workerId: string): ToolContext {
  return {
    request: { workerId } as StreamRequest,
    turn: { notes: [] },
    cwd: root,
    signal: new AbortController().signal,
    emit: () => {},
    toolId: 't1',
    depth: 0,
    readOnly: false,
    settings: store.getSettings(),
    progress: () => {},
    confirm: async () => true
  }
}

const names = (tools: AgentTool[]): string[] => tools.map((t) => t.name)

/* ---------------------------------------------------------------- cards */

test('cards: every kind normalises, bad ones say why, buttons keep only what they can do', () => {
  const ride = normalizeCard({ kind: 'ride', from: 'Home', to: 'SFO', eta: '4 min', stage: 'arriving', driver: 'Ana', plate: '8ABC123' })
  assert.ok('card' in ride && ride.card.kind === 'ride' && ride.card.stage === 'arriving' && ride.card.plate === '8ABC123')
  const order = normalizeCard({ kind: 'order', restaurant: 'Thai Basil', items: ['Pad thai', { name: 'Spring rolls', qty: 2, price: 6.5 }], stage: 'nonsense' })
  assert.ok('card' in order && order.card.kind === 'order')
  if ('card' in order && order.card.kind === 'order') {
    assert.equal(order.card.store, 'Thai Basil')
    assert.equal(order.card.stage, 'placed', 'an unknown stage falls back')
    assert.deepEqual(order.card.items[1], { name: 'Spring rolls', qty: 2, price: '6.5' })
  }
  assert.match(String((normalizeCard({ kind: 'ride', from: 'Home' }) as { error: string }).error), /from and to/)
  assert.match(String((normalizeCard({ kind: 'hologram' }) as { error: string }).error), /Unknown card kind/)
  assert.ok('error' in normalizeCard(null))

  const status = normalizeCard({
    kind: 'status',
    title: 'Computer',
    badge: { label: 'Done', tone: 'done' },
    actions: [{ label: 'Open', url: 'javascript:alert(1)' }, { label: 'Yes', reply: 'Send it' }, { label: 'Look', browser: true }, { label: 'Nothing' }, { label: 'Uber', sign_in: 'uber' }]
  })
  assert.ok('card' in status && status.card.kind === 'status')
  if ('card' in status && status.card.kind === 'status') {
    assert.deepEqual(
      status.card.actions?.map((a) => a.label),
      ['Yes', 'Look', 'Uber'],
      'a non-https link and a button that does nothing are dropped'
    )
    assert.equal(status.card.actions?.[2].signIn, 'uber')
  }

  for (const kind of ['checklist', 'route', 'payment', 'device', 'camera', 'list', 'events', 'options', 'stats']) {
    const sample: Record<string, unknown> = {
      checklist: { items: [{ label: 'Salesforce', detail: 'list pulled · 52 accounts' }] },
      route: { to: 'Work', duration: '24 min', traffic: 'heavy' },
      payment: { to: 'Sam', amount: '$20', state: 'needs-approval' },
      device: { name: 'Living room', device: 'light', on: true, level: 140 },
      camera: { title: 'Front door' },
      list: { title: 'Groceries', items: ['Milk', { text: 'Eggs', done: true }] },
      events: { events: [{ title: 'Dentist', when: '3:00 PM' }] },
      options: { title: 'Dinner?', options: [{ title: 'Thai', price: '$18' }] },
      stats: { stats: [{ label: 'Balance', value: '$1,204', trend: 'up' }] }
    }[kind] as Record<string, unknown>
    const result = normalizeCard({ kind, ...sample })
    assert.ok('card' in result, `${kind}: ${'error' in result ? result.error : ''}`)
  }
  const device = normalizeCard({ kind: 'device', name: 'Lamp', device: 'light', level: 140 })
  assert.ok('card' in device && device.card.kind === 'device' && device.card.level === 100, 'level is clamped')
  const options = normalizeCard({ kind: 'options', title: 'Pick', options: [{ title: 'A' }] })
  assert.ok('card' in options && options.card.kind === 'options' && options.card.options[0].reply === 'A', 'an option replies with its title')

  const route = normalizeCard({ kind: 'route', from: 'Home', to: '1 Market St, San Francisco', mode: 'walk' })
  assert.ok('card' in route && route.card.kind === 'route')
  if ('card' in route && route.card.kind === 'route') {
    const links = routeLinks(route.card)
    assert.match(links.google, /destination=1%20Market%20St%2C%20San%20Francisco&travelmode=walking/)
    assert.match(links.google, /origin=Home/)
    assert.match(links.waze, /^https:\/\/waze\.com\/ul\?q=/)
  }
})

test('turnItems lifts cards and events out of a worker’s runs, but not a failed one, and not in a chat', () => {
  const tool = (id: string, name: string, status: 'done' | 'error' = 'done') => ({ type: 'tool' as const, id, name, input: {}, output: 'ok', status })
  const parts = [{ type: 'text' as const, text: 'Checking.' }, tool('a', 'web_browser'), tool('b', 'show_card'), tool('c', 'add_routine'), tool('d', 'show_card', 'error'), tool('e', 'react'), { type: 'text' as const, text: 'Done.' }]
  assert.deepEqual(
    turnItems(parts, true).map((i) => i.kind),
    ['text', 'steps', 'card', 'event', 'steps', 'text']
  )
  assert.deepEqual(
    turnItems(parts).map((i) => i.kind),
    ['text', 'steps', 'text'],
    'a chat folds every call into its run, as before'
  )
})

/* ---------------------------------------------------------------- catalog and shapes */

test('the app catalog: every user-named app is there, ids are unique, sign-in stays on the app’s own sites', () => {
  for (const name of ['DoorDash', 'Uber', 'Uber Eats', 'Google Maps', 'Waze', 'Venmo', 'Cash App', 'Amazon', 'Walmart', 'Target', 'Starbucks', 'McDonald’s', 'Chipotle', 'Ring', 'Tesla', 'Roborock', 'Philips Hue', 'Calendar', 'Reminders']) {
    assert.ok(WORKER_APPS.some((a) => a.name === name), name)
  }
  assert.equal(new Set(WORKER_APPS.map((a) => a.id)).size, WORKER_APPS.length)
  assert.equal(findWorkerApp('uber eats')?.id, 'ubereats')
  assert.equal(findWorkerApp('Uber-Eats')?.id, 'ubereats')
  assert.equal(findWorkerApp('uber')?.id, 'uber')
  for (const app of WORKER_APPS) {
    if (!app.signIn) continue
    assert.ok(onDomain(app.signIn, app.domains), `${app.name}'s sign-in page is on its own domains`)
  }
  assert.ok(onDomain('https://auth.uber.com/v2/', ['uber.com']))
  assert.ok(!onDomain('https://uber.com.evil.example/', ['uber.com']))
  assert.ok(!onDomain('http://auth.uber.com/', ['uber.com']), 'only https')
  assert.ok(!onDomain('https://notuber.com/', ['uber.com']))
  // Your bank: its own page, given by the user.
  const bank = workerApp('bank')!
  assert.equal(signInTarget(bank, {}), null)
  assert.deepEqual(signInTarget(bank, { url: 'https://www.chase.com/personal/login' }), { url: 'https://www.chase.com/personal/login', domains: ['chase.com'] })
  // Suggestions only name real apps and shapes.
  for (const s of WORKER_SUGGESTIONS) {
    for (const id of s.apps) assert.ok(workerApp(id), `${s.name}: ${id}`)
    assert.equal(shapeSpec(s.shape).id, s.shape)
  }
})

test('shapes: ten distinct bodies, each with eyes inside it; anything unknown is the pebble', () => {
  assert.equal(WORKER_SHAPES.length, 10)
  assert.equal(new Set(WORKER_SHAPES.map((s) => s.id)).size, 10)
  assert.equal(shapeSpec('nope').id, DEFAULT_SHAPE)
  for (const shape of WORKER_SHAPES) {
    assert.match(shape.path, /^M [\d.-]+ [\d.-]+/, shape.id)
    assert.ok(!/NaN|undefined/.test(shape.path), shape.id)
    for (const x of shape.eyes.x) assert.ok(x > 20 && x < 80, `${shape.id} eye x`)
    assert.ok(shape.eyes.y > 25 && shape.eyes.y < 65, `${shape.id} eye y`)
  }
})

test('labs: linked apps are off unless the build says otherwise', () => {
  delete g.__EAON_LABS__
  assert.equal(workerAppsEnabled(), false)
  g.__EAON_LABS__ = true
  assert.equal(workerAppsEnabled(), true)
})

/* ---------------------------------------------------------------- engine */

test('a worker keeps its shape, apps and plugins; older workers get defaults; the sidebar preview follows its last reply', async () => {
  store.setJson('workers.json', [{ id: 'old', name: 'Old', color: '#3E86C6', folder: root }])
  const engine = start()
  const old = engine.list().find((w) => w.id === 'old')!
  assert.equal(old.shape, DEFAULT_SHAPE)
  assert.deepEqual(old.apps, [])
  assert.equal(old.plugins, null)
  assert.equal(old.preview, '')

  const nova = engine.save(draft('Nova', { shape: 'ghost', apps: ['uber', 'hue', 'nonsense', 'uber'], plugins: ['github'] }))
  assert.equal(nova.shape, 'ghost')
  assert.deepEqual(
    nova.apps.map((a) => [a.id, a.signedIn]),
    [
      ['uber', 'no'],
      ['hue', 'n/a']
    ],
    'unknown apps and repeats are dropped; only website apps need signing in'
  )
  assert.equal(engine.save(draft('Vega')).shape !== 'ghost', true, 'a new worker without a shape gets one nobody has')

  // Editing keeps an app's sign-in; unticking unlinks it.
  engine.updateApp(nova.id, 'uber', { signedIn: 'yes', account: 'sam@example.com' })
  const edited = engine.save({ ...draft('Nova'), id: nova.id, apps: ['uber', 'lists'] })
  assert.deepEqual(edited.apps.find((a) => a.id === 'uber')?.account, 'sam@example.com')
  assert.deepEqual(edited.apps.map((a) => a.id), ['uber', 'lists'])
  assert.deepEqual(edited.plugins, ['github'], 'left out, plugins stay as they were')
  assert.equal(engine.save({ ...draft('Nova'), id: nova.id, plugins: null }).plugins, null)

  assert.throws(() => engine.updateApp(nova.id, 'bank', { url: 'http://insecure.example' }), /https/)
  engine.unlinkApp(nova.id, 'lists')
  assert.deepEqual(engine.appsOf(nova.id).map((a) => a.id), ['uber'])

  engine.send(nova.id, 'Order dinner')
  await engine.whenIdle()
  const after = engine.list().find((w) => w.id === nova.id)!
  assert.equal(after.preview, 'Ordered. Pad thai is on the way.', 'the first line of its reply, without markdown')
})

test('plugins per worker: its choice, plus the broker plugin it trades through', () => {
  const engine = start()
  const all = engine.save(draft('All'))
  const some = engine.save(draft('Some', { plugins: ['notion'] }))
  const trader = engine.save(draft('Trader', { plugins: [], trading: { via: 'robinhood-server', strategy: 'Buy low', everyMinutes: 15, autoPlace: false } }))
  const desk = engine.save(draft('Desk', { plugins: ['notion'], trading: { via: TRADING_DESK, strategy: 'x', everyMinutes: 15, autoPlace: false } }))
  assert.equal(engine.pluginsOf(all.id), null)
  assert.deepEqual(engine.pluginsOf(some.id), ['notion'])
  assert.deepEqual(engine.pluginsOf(trader.id), ['robinhood-server'])
  assert.deepEqual(engine.pluginsOf(desk.id), ['notion'])
})

/* ---------------------------------------------------------------- tools */

test('a worker is offered show_card always, and app tools only for the apps it has', () => {
  const engine = start()
  const plain = engine.save(draft('Plain'))
  const errands = engine.save(draft('Errands', { apps: ['doordash'] }))
  const home = engine.save(draft('Home', { apps: ['hue', 'lists', 'calendar'] }))
  const offered = (id: string, readOnly = false): string[] => names(toolsFor(query(id, readOnly))).filter((n) => ['show_card', 'open_app', 'request_sign_in', 'app_signed_in', 'hue', 'lists', 'household'].includes(n))
  assert.deepEqual(offered(plain.id), ['show_card'])
  assert.deepEqual(offered(errands.id), ['show_card', 'open_app', 'request_sign_in', 'app_signed_in'])
  assert.deepEqual(offered(home.id), ['show_card', 'hue', 'lists', ...(process.platform === 'darwin' ? ['household'] : [])])

  delete g.__EAON_LABS__
  assert.deepEqual(offered(errands.id), ['show_card'], 'a release build offers no app tools')
})

test('show_card refuses a malformed card, and resolves a picture in the worker’s folder', async () => {
  const engine = start()
  const nova = engine.save(draft('Nova'))
  const tool = toolsFor(query(nova.id)).find((t) => t.name === 'show_card')!
  const bad = await tool.run({ kind: 'ride', from: 'Home' }, ctxFor(nova.id))
  assert.ok(typeof bad === 'object' && bad.isError)
  const ok = await tool.run({ kind: 'ride', from: 'Home', to: 'SFO', stage: 'matched' }, ctxFor(nova.id))
  assert.equal(ok, 'Shown to the user as a ride card.')
  writeFileSync(join(nova.folder, 'door.png'), 'png')
  const pic = await tool.run({ card: { kind: 'camera', title: 'Front door', image: 'door.png' } }, ctxFor(nova.id))
  assert.equal(CARD_IMAGE_MARK.exec(String(pic))?.[1], join(nova.folder, 'door.png'))
  const missing = await tool.run({ kind: 'camera', title: 'Front door', image: 'nope.png' }, ctxFor(nova.id))
  assert.ok(typeof missing === 'object' && missing.isError)
  const shot = await tool.run({ kind: 'status', title: 'Computer', screenshot: true }, ctxFor(nova.id))
  assert.match(typeof shot === 'object' ? shot.text : '', /no page open/, 'no browser yet, so no screenshot')
})

test('request_sign_in and app_signed_in keep the link’s state; apps not linked are refused by name', async () => {
  const engine = start()
  const nova = engine.save(draft('Nova', { apps: ['uber', 'hue'] }))
  engine.updateApp(nova.id, 'uber', { signedIn: 'yes' })
  const tools = toolsFor(query(nova.id))
  const ask = tools.find((t) => t.name === 'request_sign_in')!
  const said = tools.find((t) => t.name === 'app_signed_in')!
  assert.match(String(await ask.run({ app: 'Uber' }, ctxFor(nova.id))), /Asked the user/)
  assert.equal(engine.appsOf(nova.id)[0].signedIn, 'no', 'asking again means it isn’t signed in now')
  assert.match(String(await ask.run({ app: 'Philips Hue' }, ctxFor(nova.id))), /nothing to sign in/)
  await assert.rejects(() => ask.run({ app: 'DoorDash' }, ctxFor(nova.id)), /DoorDash isn’t linked to you\. Your apps: Uber, Philips Hue/)
  await assert.rejects(() => ask.run({ app: 'Grubhub' }, ctxFor(nova.id)), /no app called "Grubhub"/)
  assert.match(String(await said.run({ app: 'uber', signed_in: true, account: 'sam@example.com' }, ctxFor(nova.id))), /signed in as sam@example.com/)
  const hue = tools.find((t) => t.name === 'hue')!
  const unpaired = await hue.run({ action: 'lights' }, ctxFor(nova.id))
  assert.ok(typeof unpaired === 'object' && unpaired.isError && /isn’t paired/.test(unpaired.text))
})

test('the sign-in sheet: fills only the app’s own site, records the sign-in and tells the worker; the password goes nowhere else', async () => {
  const engine = start()
  const nova = engine.save(draft('Nova', { apps: ['uber'] }))
  engine.setPaused(nova.id, true)
  const calls: { opened: string[]; filled: { username: string; password: string; domains: string[] }[] } = { opened: [], filled: [] }
  let result: Awaited<ReturnType<WorkerBrowsers['fillLogin']>> = { url: 'https://m.uber.com/', filled: ['username', 'password'], stillOnSignIn: false }
  const browsers = {
    open: async (_id: string, url: string) => {
      calls.opened.push(url)
      return 'arrived' as const
    },
    fillLogin: async (_id: string, login: { username: string; password: string; domains: string[] }) => {
      calls.filled.push(login)
      return result
    }
  } as unknown as WorkerBrowsers

  const ok = await signInApp({ engine, browsers }, nova.id, 'uber', { username: ' sam@example.com ', password: 'hunter2' })
  assert.equal(ok.ok, true)
  assert.deepEqual(calls.opened, ['https://auth.uber.com/v2/'])
  assert.deepEqual(calls.filled[0], { username: 'sam@example.com', password: 'hunter2', domains: ['uber.com'] })
  const link = engine.appsOf(nova.id)[0]
  assert.equal(link.signedIn, 'yes')
  assert.equal(link.account, 'sam@example.com')
  const worker = engine.list().find((w) => w.id === nova.id)!
  const mail = worker.inbox.at(-1)!
  assert.equal(mail.event?.kind, 'app')
  assert.match(mail.text, /signed you in to Uber as sam@example\.com/)
  assert.ok(!JSON.stringify(engine.list()).includes('hunter2'), 'the password is in no worker, link or mail')

  result = { refused: 'https://evil.example/login' }
  const refused = await signInApp({ engine, browsers }, nova.id, 'uber', { username: 'sam', password: 'x' })
  assert.equal(refused.ok, false)
  assert.match(refused.message, /evil\.example, not Uber, so nothing was typed/)

  result = { url: 'https://auth.uber.com/v2/', filled: ['username', 'password'], stillOnSignIn: true }
  const more = await signInApp({ engine, browsers }, nova.id, 'uber', { username: 'sam', password: 'x' })
  assert.equal(more.ok, false)
  assert.equal(engine.appsOf(nova.id)[0].signedIn, 'no')
  assert.match(engine.list().find((w) => w.id === nova.id)!.inbox.at(-1)!.text, /still shows a sign-in form/)

  signedInByHand(engine, nova.id, 'uber')
  assert.equal(engine.appsOf(nova.id)[0].signedIn, 'yes')
  await assert.rejects(() => signInApp({ engine, browsers }, nova.id, 'doordash', { username: 'a', password: 'b' }), /isn’t linked/)
})

test('the persona lists a worker’s apps and how to use them; colleagues see who has which', async () => {
  const requests: StreamRequest[] = []
  const engine = start(async (request, emit) => {
    requests.push(structuredClone(request))
    emit({ type: 'done', messageId: request.messageId })
    return { text: 'ok', usage }
  })
  const nova = engine.save(draft('Nova', { apps: ['doordash', 'lists'] }))
  engine.save(draft('Vega', { apps: ['uber'] }))
  engine.send(nova.id, 'hi')
  await engine.whenIdle()
  const persona = requests[0].persona ?? ''
  assert.match(persona, /Your apps \(the user linked these to you\):/)
  assert.match(persona, /- DoorDash: .*not signed in yet — request_sign_in/)
  assert.match(persona, /ask_user with approve_tool\/approve_input for the one final click/)
  const listWorkers = toolsFor(query(nova.id)).find((t) => t.name === 'list_workers')!
  assert.match(String(await listWorkers.run({}, ctxFor(nova.id))), /Vega:[\s\S]*Apps: Uber/)
})

/* ---------------------------------------------------------------- Hue */

function fakeBridge() {
  let pressed = false
  const puts: { url: string; body: unknown }[] = []
  const fetch = (async (url: string, init?: RequestInit) => {
    const json = (value: unknown) => ({ ok: true, status: 200, json: async () => value })
    if (url === 'https://discovery.meethue.com/') return json([{ id: 'abc', internalipaddress: '192.168.1.20' }])
    if (url === 'http://192.168.1.20/api' && init?.method === 'POST') {
      return json(pressed ? [{ success: { username: 'KEY' } }] : [{ error: { type: 101, description: 'link button not pressed' } }])
    }
    if (url.endsWith('/lights') && !init?.method) {
      return json({ '1': { name: 'Desk lamp', state: { on: true, bri: 127, reachable: true } }, '2': { name: 'Ceiling', state: { on: false, bri: 254, reachable: false } } })
    }
    if (url.endsWith('/groups') && !init?.method) return json({ '5': { name: 'Living room', type: 'Room', lights: ['2'] } })
    if (init?.method === 'PUT') {
      puts.push({ url, body: JSON.parse(String(init.body)) })
      return json([{ success: {} }])
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
  let saved: HueBridge | null = null
  const hue = createHue({ fetch, load: () => saved, save: (b) => (saved = b) })
  return { hue, puts, press: () => (pressed = true), saved: () => saved }
}

test('Hue: pairing waits for the button, then lights and rooms are set by name', async () => {
  const bridge = fakeBridge()
  await assert.rejects(() => bridge.hue.lights(), /No Hue bridge is paired/)
  await assert.rejects(() => bridge.hue.pair(), /Press the round button/)
  bridge.press()
  assert.deepEqual(await bridge.hue.pair(), { ip: '192.168.1.20', id: 'abc', username: 'KEY' })
  assert.equal(bridge.saved()?.username, 'KEY')

  const lights = await bridge.hue.lights()
  assert.deepEqual(lights[0], { id: '1', name: 'Desk lamp', on: true, brightness: 50, reachable: true, room: null })
  assert.equal(lights[1].room, 'Living room')

  assert.equal(await bridge.hue.set('living room', { brightness: 30 }), 'Living room: on, 30%')
  assert.match(bridge.puts[0].url, /\/groups\/5\/action$/)
  assert.deepEqual(bridge.puts[0].body, { on: true, bri: 76 })
  assert.equal(await bridge.hue.set('desk', { on: false }), 'Desk lamp: off')
  assert.match(bridge.puts[1].url, /\/lights\/1\/state$/)
  assert.equal(await bridge.hue.set('all', { color: 'blue' }), 'every light: on, blue')
  assert.match(bridge.puts[2].url, /\/groups\/0\/action$/)
  await assert.rejects(() => bridge.hue.set('garage', { on: true }), /No light or room called "garage"/)
  await assert.rejects(() => bridge.hue.set('desk', {}), /Say what to change/)
})

test('Hue colours: names and hex become xy; 0% brightness is off; whites are colour temperatures', () => {
  assert.deepEqual(toXy('#000000'), [0.3227, 0.329])
  const red = toXy('red')!
  assert.ok(red[0] > 0.6 && red[1] < 0.35)
  assert.equal(toXy('plaid'), null)
  assert.deepEqual(stateBody({ brightness: 0 }), { on: false })
  assert.deepEqual(stateBody({ temperature: 'warm' }), { ct: 370, on: true })
  assert.throws(() => stateBody({ color: 'plaid' }), /isn't a colour/)
})

/* ---------------------------------------------------------------- lists and household */

test('shared lists: add once, tick, untick, remove, clear what’s done; who added what', () => {
  let saved: unknown = []
  const changes: number[] = []
  const lists = createLists({ load: () => saved, save: (l) => (saved = l), onChange: (l) => changes.push(l.length), now: () => 1000 })
  const groceries = lists.ensure('Groceries')
  assert.equal(lists.ensure('groceries').id, groceries.id, 'by name, ignoring case')
  assert.match(lists.edit('Groceries', { action: 'add', items: ['Milk', 'Eggs', 'milk'] }, 'Nova').changed, /^added Milk; added Eggs$/)
  assert.match(lists.edit(groceries.id, { action: 'check', items: ['egg'] }, 'You').changed, /ticked Eggs/)
  assert.match(listText(lists.get('Groceries')!), /- \[ \] Milk\n- \[x\] Eggs/)
  assert.match(lists.edit('Groceries', { action: 'add', items: ['Eggs'] }, 'Nova').changed, /put Eggs back/)
  assert.match(lists.edit('Groceries', { action: 'remove', items: ['Bread'] }, 'Nova').changed, /no "Bread" on it/)
  lists.toggle(groceries.id, lists.get('Groceries')!.items[0].id, true)
  assert.match(lists.edit('Groceries', { action: 'clear_done' }, 'You').changed, /cleared 1 ticked item$/)
  assert.deepEqual(lists.get('Groceries')!.items.map((i) => [i.text, i.by]), [['Eggs', 'Nova']])
  assert.throws(() => lists.edit('Chores', { action: 'add', items: ['x'] }, 'Nova'), /no list called "Chores"/)
  assert.ok(changes.length > 0)
  // Saved and read back.
  assert.equal(createLists({ load: () => saved, save: () => {} }).get('Groceries')!.items.length, 1)
})

test('Calendar and Reminders: values reach the script only as JSON, and answers are parsed', async () => {
  const scripts: string[] = []
  const answers = [
    JSON.stringify([
      { title: 'B', start: '2026-10-22T18:00:00.000Z', end: '2026-10-22T19:00:00.000Z', location: '', calendar: 'Home', allDay: false },
      { title: 'A', start: '2026-10-22T09:00:00.000Z', end: '2026-10-22T10:00:00.000Z', location: 'Office', calendar: 'Work', allDay: false }
    ]),
    'Added to Home',
    '2'
  ]
  const household = createHousehold(async (script) => {
    scripts.push(script)
    return answers.shift() ?? ''
  })
  const events = await household.events(new Date('2026-10-22T12:00:00'), 1)
  assert.deepEqual(events.map((e) => e.title), ['A', 'B'], 'soonest first')
  const sneaky = `Dinner'); doShellScript("rm -rf ~"); ('`
  assert.equal(await household.addEvent({ title: sneaky, start: new Date('2026-10-23T19:00:00Z'), end: new Date('2026-10-23T20:00:00Z') }), 'Added to Home')
  assert.ok(scripts[1].includes(JSON.stringify(sneaky)), 'the title is a JSON string literal in the script')
  assert.equal(await household.completeReminder('Take out bins'), 2)
  await assert.rejects(() => household.addEvent({ title: 'x', start: new Date(2), end: new Date(1) }), /end after it starts/)
})

test('Calendar and Reminders are a Mac’s: a worker moved to a Linux worker computer is told it can’t reach them', () => {
  const calendar = workerApp('calendar')!
  const uber = workerApp('uber')!
  assert.equal(availableOn(calendar, 'darwin'), true)
  assert.equal(availableOn(calendar, 'linux'), false)
  assert.equal(availableOn(workerApp('reminders')!, 'linux'), false)
  assert.equal(availableOn(uber, 'linux'), true, 'website apps go anywhere the worker’s browser does')
  const link = { id: 'calendar', signedIn: 'n/a' as const, linkedAt: 1 }
  assert.match(appLine(calendar, link, 'darwin'), /on this Mac \(household tool\)/)
  const away = appLine(calendar, link, 'linux')
  assert.match(away, /not reachable from the computer you run on now/)
  assert.doesNotMatch(away, /household tool/)
})

test('appsToolSource offers nothing outside a worker’s own top-level turn', () => {
  const engine = start()
  const source = appsToolSource({ engine, browsers: {} as WorkerBrowsers, hue: fakeBridge().hue, lists: createLists({ load: () => [], save: () => {} }), household: createHousehold(async () => '') })
  const q = query('nobody')
  assert.deepEqual(source.tools({ ...q, request: { ...q.request, workerId: undefined } as StreamRequest }), [])
  assert.deepEqual(source.tools({ ...q, depth: 1 }), [])
  assert.deepEqual(names(source.tools(q)), ['show_card'], 'an unknown worker gets the card tool only')
})
