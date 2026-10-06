import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../src/main/agent/sources'
import '../src/main/features/computerUse'
import { paymentsEngine, paymentsFeature } from '../src/main/features/payments'
import { normalizeConfig, normalizeSite, PaymentsEngine, urlMatchesSite, type PaymentsConfig } from '../src/main/features/payments/engine'
import { purchaseCovers, redactPaymentSecrets } from '../src/main/features/payments/access'
import { runAgent } from '../src/main/agent/loop'
import { toolsFor } from '../src/main/agent/tools'
import { store, defaultSettings } from '../src/main/store'
import { secrets } from '../src/main/secrets'
import { setInputBackend } from '../src/main/features/computer/backend'
import type { InputBackend } from '../src/main/features/computer/input'
import { PAYMENTS_WAIVER, PAYMENTS_WAIVER_VERSION } from '@shared/payments'
import type { ApprovalMode, StreamEvent, StreamRequest } from '@shared/types'
import type { FeatureContext } from '../src/main/features/types'
import { chunk, sseServer } from './helpers'

/**
 * Agent payments: the waiver can't be skipped, limits decide what runs on its
 * own, approve mode always asks (Full autonomy included), and the card's
 * digits are typed but never handed back to the model.
 */

const VISA = '4242424242424242'
const ALL_TICKED = PAYMENTS_WAIVER.checks.map(() => true)

function memoryEngine(initial: unknown = null, now = () => Date.UTC(2026, 9, 3, 15)): { engine: PaymentsEngine; saved: () => PaymentsConfig | null; secret: () => string | undefined } {
  let config: PaymentsConfig | null = null
  let secret: string | undefined
  const engine = new PaymentsEngine({
    load: () => initial,
    save: (c) => (config = JSON.parse(JSON.stringify(c))),
    getSecret: () => secret,
    setSecret: (v) => (secret = v ?? undefined),
    now
  })
  return { engine, saved: () => config, secret: () => secret }
}

const card = { number: `${VISA.slice(0, 4)} ${VISA.slice(4, 8)} ${VISA.slice(8, 12)} ${VISA.slice(12)}`, expMonth: 12, expYear: 2030, cvc: '123', nameOnCard: 'Ada Lovelace', billingZip: '94107' }

/* ------------------------------------------------------------------ engine */

test('a card is validated, its digits go to the vault only, and saving it turns on approve mode', () => {
  const { engine, saved, secret } = memoryEngine()
  assert.throws(() => engine.setCard({ ...card, number: '4242424242424241' }), /isn’t valid/)
  assert.throws(() => engine.setCard({ ...card, expYear: 2025 }), /expired/)
  assert.throws(() => engine.setCard({ ...card, cvc: '12' }), /3 or 4 digits/)
  const status = engine.setCard(card)
  assert.equal(status.card?.last4, '4242')
  assert.equal(status.card?.brand, 'Visa')
  assert.equal(status.effectiveMode, 'approve')
  assert.ok(!JSON.stringify(saved()).includes(VISA), 'the config file never holds the number')
  assert.ok(!JSON.stringify(status).includes(VISA), 'the status sent to the renderer never holds the number')
  assert.ok(!JSON.stringify(saved()).includes('"123"'), 'nor the security code')
  assert.deepEqual(JSON.parse(secret()!), { number: VISA, cvc: '123' })
})

test('automatic purchases can only be turned on by accepting the current waiver with every box ticked', () => {
  const { engine } = memoryEngine()
  engine.setCard(card)
  assert.throws(() => engine.setMode('auto'), /waiver/)
  assert.throws(() => engine.acceptWaiver(PAYMENTS_WAIVER_VERSION - 1, ALL_TICKED), /current version/)
  assert.throws(() => engine.acceptWaiver(PAYMENTS_WAIVER_VERSION, ALL_TICKED.map((_, i) => i !== 2)), /Tick every box/)
  assert.throws(() => engine.acceptWaiver(PAYMENTS_WAIVER_VERSION, [true]), /Tick every box/)
  assert.equal(engine.status().effectiveMode, 'approve')
  const on = engine.acceptWaiver(PAYMENTS_WAIVER_VERSION, ALL_TICKED)
  assert.equal(on.effectiveMode, 'auto')
  assert.equal(on.waiverCurrent, true)
  // Once accepted, switching back and forth needs no second acceptance.
  engine.setMode('approve')
  assert.equal(engine.setMode('auto').effectiveMode, 'auto')
  const off = engine.revokeWaiver()
  assert.equal(off.effectiveMode, 'approve')
  assert.throws(() => engine.setMode('auto'), /waiver/)
})

test('a saved config that says auto without a current waiver is read as approve', () => {
  assert.equal(normalizeConfig({ mode: 'auto' }).mode, 'approve')
  assert.equal(normalizeConfig({ mode: 'auto', waiver: { version: PAYMENTS_WAIVER_VERSION - 1, acceptedAt: 1 } }).mode, 'approve')
  assert.equal(normalizeConfig({ mode: 'auto', waiver: { version: PAYMENTS_WAIVER_VERSION, acceptedAt: 1 } }).mode, 'auto')
  assert.equal(normalizeConfig({ mode: 'bogus' }).mode, 'off')
})

test('without a card, payments are off whatever the mode says', () => {
  const { engine } = memoryEngine({ mode: 'approve' })
  assert.equal(engine.effectiveMode(), 'off')
  assert.throws(() => engine.setMode('approve'), /Add a card/)
})

test('limits decide what runs on its own; anything over them, or in another currency, asks', () => {
  const { engine } = memoryEngine()
  engine.setCard(card)
  assert.equal(engine.assess(5, 'USD').needsUser, true, 'approve mode always asks')
  engine.acceptWaiver(PAYMENTS_WAIVER_VERSION, ALL_TICKED)
  engine.setLimits({ perPurchase: 20, perDay: 30, perMonth: 40 })
  assert.equal(engine.assess(12, 'USD').needsUser, false)
  assert.match(engine.assess(25, 'USD').reason, /per-purchase/)
  assert.match(engine.assess(5, 'EUR').reason, /EUR/)
  assert.equal(engine.assess(0, 'USD').needsUser, true)
  engine.authorize({ merchant: 'Starbucks', site: 'starbucks.com', description: 'latte', amount: 18, currency: 'USD', chatId: 'c' }, 'auto')
  assert.match(engine.assess(15, 'USD').reason, /daily/)
  assert.throws(() => engine.authorize({ merchant: 'X', site: null, description: '', amount: 15, currency: 'USD', chatId: 'c' }, 'auto'), /approval/)
  // A purchase the user approves isn't held to the automatic limits.
  engine.authorize({ merchant: 'X', site: null, description: '', amount: 15, currency: 'USD', chatId: 'c' }, 'approved')
  assert.equal(engine.spent().today, 33)
})

test('failed and cancelled purchases free their amount; paid ones count what was charged', () => {
  const { engine } = memoryEngine()
  engine.setCard(card)
  const a = engine.authorize({ merchant: 'A', site: null, description: '', amount: 10, currency: 'USD', chatId: 'c' }, 'approved')
  const b = engine.authorize({ merchant: 'B', site: null, description: '', amount: 20, currency: 'USD', chatId: 'c' }, 'approved')
  engine.complete(a.id, 'c', 'paid', 11.5, 'order 42')
  engine.complete(b.id, 'c', 'failed', null, 'declined')
  assert.equal(engine.spent().today, 11.5)
  assert.throws(() => engine.complete(a.id, 'c', 'paid', 1, ''), /already paid/)
})

test('an authorization is usable only in its own chat, once, and for 20 minutes', () => {
  let now = Date.UTC(2026, 9, 3, 15)
  const { engine } = memoryEngine(null, () => now)
  engine.setCard(card)
  const p = engine.authorize({ merchant: 'A', site: 'a.com', description: '', amount: 10, currency: 'USD', chatId: 'mine' }, 'approved')
  assert.equal(engine.usable(p.id, 'mine').id, p.id)
  assert.throws(() => engine.usable(p.id, 'theirs'), /another conversation/)
  now += 21 * 60_000
  assert.throws(() => engine.usable(p.id, 'mine'), /expired/)
  assert.throws(() => engine.usable('pay_nope', 'mine'), /No purchase/)
})

test('sites are normalized and matched by host, subdomains included', () => {
  assert.equal(normalizeSite('https://www.Starbucks.com/menu'), 'starbucks.com')
  assert.equal(normalizeSite('starbucks.com'), 'starbucks.com')
  assert.equal(normalizeSite('not a site'), null)
  assert.equal(urlMatchesSite('https://app.starbucks.com/checkout', 'starbucks.com'), true)
  assert.equal(urlMatchesSite('https://starbucks.com.evil.io/checkout', 'starbucks.com'), false)
  assert.equal(urlMatchesSite('https://notstarbucks.com/', 'starbucks.com'), false)
})

/* --------------------------------------------------------- tool, end to end */

const typed: string[] = []
const fakeInput: InputBackend = {
  name: 'fake',
  check: async () => ({ available: true, trusted: true, locked: false }),
  move: async () => {},
  click: async () => {},
  drag: async () => {},
  scroll: async () => {},
  type: async (text) => void typed.push(text),
  key: async (combo) => void typed.push(`<${[...combo.modifiers, combo.key].join('+')}>`),
  cursor: async () => ({ x: 10, y: 10 }),
  frontmost: async () => ({ name: 'iPhone Mirroring', pid: 99999, bundleId: 'com.apple.ScreenContinuity' }),
  activate: async () => {},
  locked: async () => false,
  openApp: async () => {},
  dispose: () => {}
}

const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>()
const fakeCtx = {
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => ipcHandlers.set(channel, fn) },
  getWindow: () => null,
  getWindows: () => [],
  send: () => undefined,
  emitStream: () => undefined
} as unknown as FeatureContext

const call = (args: Record<string, unknown>): string[] => [
  chunk({ tool_calls: [{ index: 0, id: `c_${Math.random().toString(36).slice(2)}`, function: { name: 'payment_card', arguments: JSON.stringify(args) } }] }, 'tool_calls')
]
const say = (text: string): string[] => [chunk({ content: text }, 'stop')]

function request(chatId = 'pay-chat'): StreamRequest {
  return {
    chatId,
    messageId: `m${Math.random()}`,
    providerId: 'fake',
    modelId: 'fake-model',
    effort: 'medium',
    mode: 'work',
    history: [{ id: 'u1', role: 'user', createdAt: 0, parts: [{ type: 'text', text: 'buy it' }] }],
    summary: null,
    projectInstructions: '',
    cwd: mkdtempSync(join(tmpdir(), 'eaon-pay-')),
    work: { swarm: false, plan: false },
    goal: null
  }
}

/** One turn where the model makes `calls` in order, then says done. */
async function turn(calls: Record<string, unknown>[], approve: boolean, chatId?: string): Promise<{ asked: { tool: string; input: Record<string, unknown> }[]; results: Extract<StreamEvent, { type: 'tool-result' }>[] }> {
  let index = 0
  const { server, url } = await sseServer(() => (index < calls.length ? call(calls[index++]) : say('done')))
  store.saveProviderConfig({
    fake: { name: 'Fake', kind: 'openai-compatible', baseUrl: url, models: [{ id: 'fake-model', label: 'Fake', providerId: 'fake' }] }
  })
  secrets.set('fake', 'key')
  const asked: { tool: string; input: Record<string, unknown> }[] = []
  const events: StreamEvent[] = []
  await runAgent(request(chatId), (e) => events.push(e), { approver: async (tool, input) => (asked.push({ tool, input }), approve) })
  server.close()
  return { asked, results: events.filter((e): e is Extract<StreamEvent, { type: 'tool-result' }> => e.type === 'tool-result') }
}

function configure(approvalMode: ApprovalMode): void {
  store.patchSettings({ approvalMode, computerUse: { ...defaultSettings.computerUse, enabled: true, confirmEachAction: false } })
  typed.length = 0
}

before(async () => {
  setInputBackend(fakeInput)
  await paymentsFeature.register(fakeCtx)
})
after(() => {
  setInputBackend(null)
  paymentsFeature.dispose?.()
  store.patchSettings({ computerUse: { ...defaultSettings.computerUse } })
})
beforeEach(() => {
  const engine = paymentsEngine()!
  engine.removeCard()
  engine.revokeWaiver()
  engine.setCard(card)
  engine.setLimits({ perPurchase: 20, perDay: 50, perMonth: 100 })
})

test('the tool is offered only once a card is set up, and never to trading sessions', () => {
  const query = (chatId: string): string[] =>
    toolsFor({ mode: 'work', cwd: '/tmp', depth: 0, readOnly: false, settings: store.getSettings(), request: request(chatId) }).map((t) => t.name)
  assert.ok(query('pay-chat').includes('payment_card'))
  assert.ok(!query('trading:session').includes('payment_card'))
  paymentsEngine()!.setMode('off')
  assert.ok(!query('pay-chat').includes('payment_card'))
})

test('approve mode: authorizing asks the user even in Full autonomy, and a denial records nothing', async () => {
  configure('full')
  const { asked, results } = await turn([{ action: 'authorize', merchant: 'Starbucks', amount: 6.45, description: 'Grande latte', site: 'starbucks.com' }], false)
  assert.equal(asked.length, 1)
  assert.equal(asked[0].tool, 'payment_card')
  assert.equal(results[0].status, 'denied')
  assert.equal(paymentsEngine()!.status().purchases.length, 0)
})

test('approve mode: an approved purchase is recorded as approved', async () => {
  configure('full')
  const { asked, results } = await turn([{ action: 'authorize', merchant: 'Starbucks', amount: 6.45, site: 'starbucks.com' }], true)
  assert.equal(asked.length, 1)
  assert.match(results[0].output, /Authorized pay_\w+: \$6\.45 at Starbucks \(starbucks\.com\), approved by the user/)
  assert.equal(paymentsEngine()!.status().purchases[0].how, 'approved')
})

test('auto mode: a purchase within the limits runs without asking; one over them asks', async () => {
  configure('auto')
  paymentsEngine()!.acceptWaiver(PAYMENTS_WAIVER_VERSION, ALL_TICKED)
  const small = await turn([{ action: 'authorize', merchant: 'Starbucks', amount: 6.45, site: 'starbucks.com' }], false)
  assert.equal(small.asked.length, 0)
  assert.match(small.results[0].output, /within the automatic limits/)
  const big = await turn([{ action: 'authorize', merchant: 'Apple', amount: 999, site: 'apple.com' }], false)
  assert.equal(big.asked.length, 1, 'over the limit, it falls back to asking')
  assert.equal(big.results[0].status, 'denied')
})

test('fill on screen types the card into the focused app, and the result never contains the digits', async () => {
  configure('auto')
  paymentsEngine()!.acceptWaiver(PAYMENTS_WAIVER_VERSION, ALL_TICKED)
  const auth = await turn([{ action: 'authorize', merchant: 'Starbucks', amount: 6.45 }], false)
  const id = /Authorized (pay_\w+)/.exec(auth.results[0].output)![1]
  const fill = await turn([{ action: 'fill', purchase_id: id, target: 'screen', fields: [{ field: 'number' }, { field: 'expiry' }, { field: 'cvc' }] }], false)
  assert.equal(fill.results[0].status, 'done')
  assert.deepEqual(typed, [VISA, '<tab>', '12/30', '<tab>', '123'])
  assert.ok(!fill.results[0].output.includes(VISA))
  assert.ok(!fill.results[0].output.includes('123 '))
  assert.match(fill.results[0].output, /card ending 4242.*iPhone Mirroring/)
})

test('fill refuses another chat\'s purchase, and the browser without a site', async () => {
  configure('auto')
  paymentsEngine()!.acceptWaiver(PAYMENTS_WAIVER_VERSION, ALL_TICKED)
  const auth = await turn([{ action: 'authorize', merchant: 'Starbucks', amount: 6.45 }], false, 'chat-a')
  const id = /Authorized (pay_\w+)/.exec(auth.results[0].output)![1]
  const other = await turn([{ action: 'fill', purchase_id: id, target: 'screen', fields: ['number'] }], false, 'chat-b')
  assert.match(other.results[0].output, /another conversation/)
  const browser = await turn([{ action: 'fill', purchase_id: id, target: 'browser', fields: [{ field: 'number', ref: 'e3' }] }], false, 'chat-a')
  assert.match(browser.results[0].output, /no site/)
  assert.deepEqual(typed, [])
})

test('complete records the charge; a live purchase covers its own site\'s checkout click only', async () => {
  configure('auto')
  paymentsEngine()!.acceptWaiver(PAYMENTS_WAIVER_VERSION, ALL_TICKED)
  const before = paymentsEngine()!.spent().today
  const auth = await turn([{ action: 'authorize', merchant: 'Starbucks', amount: 6.45, site: 'starbucks.com' }], false, 'chat-c')
  const id = /Authorized (pay_\w+)/.exec(auth.results[0].output)![1]
  assert.equal(purchaseCovers('chat-c', 'https://www.starbucks.com/checkout'), true)
  assert.equal(purchaseCovers('chat-c', 'https://evil.example/checkout'), false)
  assert.equal(purchaseCovers('chat-d', 'https://www.starbucks.com/checkout'), false)
  const done = await turn([{ action: 'complete', purchase_id: id, status: 'paid', charged: 7.02, note: 'order 1182' }], false, 'chat-c')
  assert.match(done.results[0].output, /\$7\.02 at Starbucks/)
  assert.equal(purchaseCovers('chat-c', 'https://www.starbucks.com/checkout'), false, 'a completed purchase covers nothing')
  assert.equal(Math.round((paymentsEngine()!.spent().today - before) * 100) / 100, 7.02, 'what was charged replaces what was authorized')
})

test('snapshot text has the saved card number and security code blanked', () => {
  const snapshot = [
    '- textbox "Card number" [ref=e3]: 4242 4242 4242 4242',
    '- textbox "Card number, plain" [ref=e4]: 4242424242424242',
    '- textbox "Security code (CVC)" [ref=e5]: 123',
    '- text "Order 123 confirmed"'
  ].join('\n')
  const out = redactPaymentSecrets(snapshot)
  assert.ok(!out.includes('4242 4242 4242 4242'))
  assert.ok(!out.includes(VISA))
  assert.match(out, /•••• 4242/)
  assert.match(out, /CVC\)" \[ref=e5\]: •••/)
  assert.match(out, /Order 123 confirmed/, 'the code is only blanked in a security-code field')
})

test('the waiver can\'t be accepted over IPC with a box unticked', async () => {
  const accept = ipcHandlers.get('payments:accept-waiver')!
  assert.throws(() => accept({}, PAYMENTS_WAIVER_VERSION, ALL_TICKED.map((_, i) => i !== 0)), /Tick every box/)
  const setMode = ipcHandlers.get('payments:set-mode')!
  assert.throws(() => setMode({}, 'auto'), /waiver/)
})
