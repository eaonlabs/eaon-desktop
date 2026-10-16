import { after, afterEach, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Notification } from 'electron'
import '../src/main/agent/sources'
import { checkoutStepCovered, paymentsEngine, paymentsFeature } from '../src/main/features/payments'
import { endRun, grantPurchase } from '../src/main/features/payments/plans'
import { purchaseRunGate } from '../src/main/features/payments/purchaseRun'
import { createWorkersService, type WorkersService } from '../src/main/features/workers/service'
import { cadencePhrase, nextPurchaseAt, WATCH_FIRST_CHECK_MS } from '../src/main/features/workers/purchases'
import { toolsFor, type AgentTool } from '../src/main/agent/tools'
import type { StreamRequest } from '@shared/types'
import { store } from '../src/main/store'
import { secrets } from '../src/main/secrets'
import { buildPurchasePlan, cadenceText, nextOnCadence, startOfDay, type PurchaseForm } from '../src/renderer/src/components/purchase/plan'
import { nextAligned, type PurchaseRoutineDraft, type WorkerDraft, type WorkerRoutine } from '@shared/workers'
import type { PurchasePlan } from '@shared/scheduler'
import type { FeatureContext } from '../src/main/features/types'
import { chunk, sseServer } from './helpers'

/**
 * Purchase schedules on workers: a schedule is one of a worker's routines,
 * and each run of it places one order with the worker's own browser. A free
 * plan (maximum 0) buys with no card saved at all; a paid one needs a card.
 * The run may click through its store (an unattended "safe" run can't click
 * at all) but uses nothing besides its browser, the card and tools that only
 * read. An order with a number is tracked in the same thread; a one-off is
 * gone once it has run.
 */

const card = { number: '4242 4242 4242 4242', expMonth: 12, expYear: 2030, cvc: '123', nameOnCard: 'Ada Lovelace', billingZip: '94107' }
const WORKERS = 'workers.json'

let service: WorkersService | null = null
let root = ''

function context() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const ctx = {
    ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn) },
    getWindow: () => null,
    getWindows: () => [],
    send: () => undefined,
    emitStream: () => undefined
  } as unknown as FeatureContext
  return { ctx, invoke: (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args) }
}

const draft = (name: string, model: WorkerDraft['model']): WorkerDraft => ({ name, color: '#3E86C6', personality: 'Plain.', purpose: 'Buys things', model })

async function until(check: () => boolean, timeout = 10_000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const freeSample: PurchasePlan = { item: 'Free sample pack', site: 'sample.com', merchant: 'Sample', maxAmount: 0, currency: 'USD', notes: '', orders: 1, track: true }

before(async () => {
  await paymentsFeature.register(context().ctx)
})
after(() => paymentsFeature.dispose?.())
beforeEach(() => {
  store.setJson(WORKERS, [])
  root = mkdtempSync(join(tmpdir(), 'eaon-worker-buy-'))
  const settings = store.getSettings()
  store.patchSettings({ work: { ...settings.work, defaultFolder: root } })
  // No card at all: payments are off.
  paymentsEngine()!.removeCard()
  Notification.supported = true
  Notification.shown.length = 0
})
afterEach(async () => {
  service?.stop()
  await service?.engine.whenIdle()
  service = null
  Notification.supported = false
  await store.flushWrites()
})

test('a worker places a free order with no card saved, tracks it in the same thread, and the one-off is gone', async () => {
  // The model: authorize the $0 total, complete with the order number, report.
  const { url, server, requests } = await sseServer((body) => {
    const messages = body.messages as { role: string; content?: unknown }[]
    const results = messages.filter((m) => m.role === 'tool').map((m) => String(m.content))
    const call = (args: Record<string, unknown>) => [
      chunk({ tool_calls: [{ index: 0, id: `c${results.length}`, function: { name: 'payment_card', arguments: JSON.stringify(args) } }] }),
      chunk({}, 'tool_calls'),
      '[DONE]'
    ]
    if (results.length === 0) return call({ action: 'authorize', merchant: 'Sample', amount: 0, currency: 'USD', site: 'sample.com', description: 'Free sample pack' })
    if (results.length === 1) {
      const id = /pay_[a-z0-9]+/.exec(results[0])?.[0] ?? 'missing'
      return call({ action: 'complete', purchase_id: id, status: 'paid', charged: 0, order_id: 'S-100' })
    }
    return [chunk({ content: 'Ordered the free sample pack, order S-100.' }), chunk({}, 'stop'), '[DONE]']
  })
  try {
    store.saveProviderConfig({ fake: { name: 'Fake', kind: 'openai-compatible', baseUrl: url, enabled: true, models: [{ id: 'fake-1', label: 'Fake 1', providerId: 'fake' }] } })
    secrets.set('fake', 'test-key')
    const { ctx, invoke } = context()
    service = createWorkersService(ctx, { startDelayMs: 60_000 })
    service.registerIpc()
    service.start()
    const engine = service.engine
    const ada = engine.save(draft('Ada', { providerId: 'fake', modelId: 'fake-1' }))

    // A paid plan needs a card; a free one doesn't.
    const paid: PurchaseRoutineDraft = { plan: { ...freeSample, maxAmount: 20 }, everyMs: null, firstAt: Date.now(), anchorAt: Date.now() }
    assert.throws(() => invoke('workers:save-purchase', ada.id, paid), /Add a card/)
    const saved = invoke('workers:save-purchase', ada.id, { plan: freeSample, everyMs: null, firstAt: Date.now(), anchorAt: Date.now() }) as WorkerRoutine
    assert.equal(saved.purchase?.maxAmount, 0)
    engine.start()
    await until(() => requests.length >= 3 && !engine.list()[0].runningMessageId && !engine.list()[0].threads.some((t) => t.runningMessageId))
    await engine.whenIdle()

    // The tool was offered with no card, and the run was let click but held to its browser and the card.
    const offered = ((requests[0].tools as { function: { name: string } }[]) ?? []).map((t) => t.function.name)
    assert.ok(offered.includes('payment_card'), 'payment_card in a purchase run, card or not')
    assert.ok(offered.includes('web_browser'))
    const brief = JSON.stringify(requests[0].messages)
    assert.match(brief, /This order must be free/)

    const order = paymentsEngine()!.purchases().find((p) => p.planId === saved.id)
    assert.ok(order, 'the order is recorded under its plan')
    assert.deepEqual([order.amount, order.status, order.charged, order.orderId, order.how], [0, 'paid', 0, 'S-100', 'scheduled'])

    const after = engine.list()[0]
    assert.equal(after.routines.some((r) => r.id === saved.id), false, 'a one-off is gone once it has run')
    const watch = after.routines.find((r) => r.watch)
    assert.ok(watch, 'its order is tracked')
    assert.equal(watch.watch!.orderId, 'S-100')
    assert.ok(watch.nextAt - Date.now() > WATCH_FIRST_CHECK_MS - 60_000, 'the first check is a few hours later')
    const thread = after.threads.find((t) => t.routineId === saved.id)
    assert.ok(thread && watch.threadId === thread.id, 'tracking runs in the schedule’s thread')
    assert.equal(thread.closedAt ?? null, null, 'the thread stays open while the order is tracked')
    assert.ok(Notification.shown.some((n) => /Ada ordered Free sample pack/.test(n.options.title)))
  } finally {
    server.close()
  }
})

/** The tools a worker's top-level turn is offered, for one run. */
function offered(chatId: string, messageId: string): AgentTool[] {
  const request = { chatId, messageId, work: { swarm: false, plan: false }, goal: null, history: [] } as unknown as StreamRequest
  return toolsFor({ mode: 'work', cwd: root, depth: 0, readOnly: false, settings: store.getSettings(), request })
}

test('a free-only plan refuses an order that costs something, and a paid run without a card is told so', async () => {
  const tool = offered('worker:x', 'm-free').find((t) => t.name === 'payment_card')
  assert.equal(tool, undefined, 'no card and no schedule: no payment tool')
  grantPurchase('m-free', { planId: 'p', item: 'Sample', site: 'sample.com', maxAmount: 0, currency: 'USD' })
  try {
    const pay = offered('worker:x', 'm-free').find((t) => t.name === 'payment_card')!
    assert.ok(pay, 'a purchase run gets it without a card')
    const ctx = { request: { chatId: 'worker:x', messageId: 'm-free' }, signal: new AbortController().signal } as never
    const costs = await pay.run({ action: 'authorize', merchant: 'Sample', amount: 4.99, currency: 'USD', site: 'sample.com' }, ctx)
    assert.match(typeof costs === 'string' ? costs : costs.text, /free orders only/)
  } finally {
    endRun('m-free')
  }
  grantPurchase('m-paid', { planId: 'p2', item: 'Coffee', site: 'amazon.com', maxAmount: 40, currency: 'USD' })
  try {
    const pay = offered('worker:y', 'm-paid').find((t) => t.name === 'payment_card')!
    const ctx = { request: { chatId: 'worker:y', messageId: 'm-paid' }, signal: new AbortController().signal } as never
    await assert.rejects(Promise.resolve(pay.run({ action: 'authorize', merchant: 'Amazon', amount: 25, currency: 'USD', site: 'amazon.com' }, ctx)), /Payments are off/)
  } finally {
    endRun('m-paid')
  }
})

test('a purchase run uses its browser, the card and what only reads; nothing else', () => {
  const tool = (name: string, mutating: AgentTool['mutating']): AgentTool => ({ name, mutating, description: '', inputSchema: {}, run: async () => '' }) as unknown as AgentTool
  assert.equal(purchaseRunGate(tool('web_browser', () => true), {}), null)
  assert.equal(purchaseRunGate(tool('payment_card', () => true), {}), null)
  assert.equal(purchaseRunGate(tool('email_search', false), {}), null)
  assert.match(purchaseRunGate(tool('run_command', true), {}) ?? '', /only uses its browser/)
  assert.match(purchaseRunGate(tool('write_file', () => true), {}) ?? '', /only uses its browser/)
  assert.match(purchaseRunGate(tool('computer', () => true), {}) ?? '', /only uses its browser/)
})

test('on its own store a purchase run may go to checkout, but placing the order still needs its authorization', () => {
  grantPurchase('m-cart', { planId: 'p', item: 'Coffee', site: 'amazon.com', maxAmount: 40, currency: 'USD' })
  try {
    const at = 'https://www.amazon.com/gp/cart/view.html'
    assert.equal(checkoutStepCovered(at, { messageId: 'm-cart', name: 'Proceed to checkout' }), true)
    assert.equal(checkoutStepCovered(at, { messageId: 'm-cart', name: 'Continue to payment' }), true)
    assert.equal(checkoutStepCovered(at, { messageId: 'm-cart', name: 'Place your order' }), false)
    assert.equal(checkoutStepCovered(at, { messageId: 'm-cart', name: 'Buy Now' }), false)
    assert.equal(checkoutStepCovered('https://evil.example/checkout', { messageId: 'm-cart', name: 'Proceed to checkout' }), false)
    assert.equal(checkoutStepCovered(at, { messageId: 'another-run', name: 'Proceed to checkout' }), false)
  } finally {
    endRun('m-cart')
  }
})

test('free orders need no card on the engine; a paid one still does', () => {
  const engine = paymentsEngine()!
  const free = engine.authorize({ merchant: 'Sample', site: 'sample.com', description: '', amount: 0, currency: 'USD', chatId: 'c-free', planId: 'p' }, 'scheduled')
  assert.equal(free.amount, 0)
  // Its one press of the order button, with payments off.
  assert.equal(engine.claimSpendingClick('c-free', 'https://sample.com/checkout'), true)
  assert.equal(engine.claimSpendingClick('c-free', 'https://sample.com/checkout'), false, 'one press only')
  assert.throws(() => engine.authorize({ merchant: 'Sample', site: 'sample.com', description: '', amount: 0, currency: 'USD', chatId: 'c2' }, 'approved'), /Payments are off/)
  assert.throws(() => engine.authorize({ merchant: 'Shop', site: 'shop.com', description: '', amount: 5, currency: 'USD', chatId: 'c3', planId: 'p' }, 'scheduled'), /Payments are off/)
  engine.setCard(card)
  assert.ok(engine.authorize({ merchant: 'Shop', site: 'shop.com', description: '', amount: 5, currency: 'USD', chatId: 'c3', planId: 'p' }, 'scheduled'))
})

/* ------------------------------------------------------------ the dialog */

const form = (overrides: Partial<PurchaseForm> = {}): PurchaseForm => ({
  item: '2 bags of Lavazza Super Crema',
  site: 'https://www.amazon.com/dp/B000',
  maxAmount: '45',
  currency: 'USD',
  notes: '',
  cadence: 'weekly',
  startDay: startOfDay(Date.now()),
  time: '09:00',
  limited: false,
  orders: '4',
  track: true,
  ...overrides
})

test('the dialog: today buys now and later orders keep to the picked time; 0 is free; nothing typed is no amount', () => {
  const now = new Date(2026, 9, 15, 15, 30).getTime()
  const today = buildPurchasePlan(form({ startDay: startOfDay(now) }), now)
  assert.equal(today.error, null)
  assert.equal(today.buyNow, true)
  assert.equal(today.draft.firstAt, now)
  assert.equal(today.draft.everyMs, 7 * 24 * 60 * 60_000)
  assert.equal(today.draft.anchorAt, new Date(2026, 9, 15, 9, 0).getTime())
  assert.equal(today.nextAt, new Date(2026, 9, 22, 9, 0).getTime())
  assert.equal(today.draft.plan.merchant, 'Amazon')
  assert.equal(today.draft.plan.site, 'amazon.com')

  const later = buildPurchasePlan(form({ startDay: startOfDay(new Date(2026, 9, 20).getTime()), time: '08:15', cadence: 'biweekly' }), now)
  assert.equal(later.buyNow, false)
  assert.equal(later.draft.firstAt, new Date(2026, 9, 20, 8, 15).getTime())
  const once = buildPurchasePlan(form({ cadence: 'once', startDay: startOfDay(now) }), now)
  assert.deepEqual([once.buyNow, once.draft.everyMs, once.draft.plan.orders, once.nextAt], [true, null, 1, null])

  assert.equal(buildPurchasePlan(form({ maxAmount: '0' }), now).error, null, '0 is free orders')
  assert.equal(buildPurchasePlan(form({ maxAmount: '0' }), now).draft.plan.maxAmount, 0)
  assert.match(buildPurchasePlan(form({ maxAmount: '' }), now).error ?? '', /most an order may cost/)

  // Editing without touching the timing keeps the routine's.
  const routine = { id: 'r1', name: 'Buy', task: '', everyMs: 14 * 24 * 60 * 60_000, daily: null, nextAt: now + 3 * 60 * 60_000, anchorAt: now - 11 * 24 * 60 * 60_000, runs: [] } as WorkerRoutine
  const kept = buildPurchasePlan(form({ notes: 'No substitutions' }), now, routine)
  assert.deepEqual([kept.buyNow, kept.draft.id, kept.draft.firstAt, kept.draft.everyMs, kept.draft.anchorAt], [false, 'r1', routine.nextAt, routine.everyMs, routine.anchorAt])
})

test('runs keep to the picked time however late one ran, and read as a cadence', () => {
  const week = 7 * 24 * 60 * 60_000
  const anchor = new Date(2026, 9, 15, 9, 0).getTime()
  assert.equal(nextAligned(anchor, week, anchor - 1), anchor)
  assert.equal(nextAligned(anchor, week, anchor + 5 * 60 * 60_000), anchor + week)
  assert.equal(nextAligned(anchor, week, anchor + week + 1), anchor + 2 * week)
  assert.equal(cadencePhrase(null), 'Once')
  assert.equal(cadencePhrase(week), 'Every week')
  assert.equal(cadencePhrase(2 * week), 'Every 2 weeks')
  assert.equal(cadenceText(24 * 60 * 60_000), 'every day')
  assert.equal(cadenceText(4 * week), 'every 4 weeks')
})

test('editing a schedule’s timing replaces it: never a second schedule, never an order on the spot', () => {
  const now = new Date(2026, 9, 15, 15, 30).getTime()
  const routine = { id: 'r1', name: 'Buy', task: '', everyMs: 14 * 24 * 60 * 60_000, daily: null, nextAt: now + 3 * 60 * 60_000, anchorAt: now - 11 * 24 * 60 * 60_000, runs: [] } as WorkerRoutine

  // Today, at a time already gone: the next weekly order, not one now.
  const today = buildPurchasePlan(form({ startDay: startOfDay(now), time: '09:00', cadence: 'weekly' }), now, routine, true)
  assert.equal(today.error, null)
  assert.equal(today.draft.id, 'r1', 'the edit names the routine it replaces')
  assert.equal(today.buyNow, false)
  assert.equal(today.draft.firstAt, new Date(2026, 9, 22, 9, 0).getTime())
  assert.equal(today.draft.everyMs, 7 * 24 * 60 * 60_000)

  const later = buildPurchasePlan(form({ startDay: startOfDay(new Date(2026, 9, 20).getTime()), time: '08:15', cadence: 'daily' }), now, routine, true)
  assert.deepEqual([later.draft.id, later.buyNow, later.draft.firstAt], ['r1', false, new Date(2026, 9, 20, 8, 15).getTime()])

  // A one-off moved to a time that has passed asks for another.
  const once = buildPurchasePlan(form({ startDay: startOfDay(now), time: '09:00', cadence: 'once' }), now, routine, true)
  assert.deepEqual([once.draft.id, once.buyNow], ['r1', false])
  assert.match(once.error ?? '', /hasn’t passed/)
})

test('saving an edited schedule over IPC keeps one routine, not two', async () => {
  const { ctx, invoke } = context()
  service = createWorkersService(ctx, { startDelayMs: 60_000 })
  service.registerIpc()
  service.start()
  // Never started: nothing runs, so nothing is bought. A free plan needs no card.
  const ada = service.engine.save(draft('Ada', { providerId: 'fake', modelId: 'fake-1' }))
  const now = Date.now()
  const startDay = startOfDay(now + 3 * 24 * 60 * 60_000)
  const first = buildPurchasePlan(form({ maxAmount: '0', site: 'sample.com', startDay, cadence: 'weekly' }), now)
  assert.equal(first.error, null)
  const saved = invoke('workers:save-purchase', ada.id, first.draft) as WorkerRoutine
  const edited = buildPurchasePlan(form({ maxAmount: '0', site: 'sample.com', startDay: startOfDay(now + 4 * 24 * 60 * 60_000), cadence: 'daily' }), now, saved, true)
  assert.equal(edited.error, null)
  invoke('workers:save-purchase', ada.id, edited.draft)
  const routines = service.engine.list().find((w) => w.id === ada.id)!.routines.filter((r) => r.purchase)
  assert.equal(routines.length, 1, 'the edit replaced the schedule')
  assert.equal(routines[0].id, saved.id)
  assert.equal(routines[0].everyMs, 24 * 60 * 60_000)
  assert.equal(routines[0].nextAt, edited.draft.firstAt)
})

test('daily and weekly orders keep their clock time across a daylight-saving change', () => {
  const zone = process.env.TZ
  process.env.TZ = 'America/New_York'
  try {
    const DAY = 24 * 60 * 60_000
    // US clocks go forward on Sunday 8 March 2026.
    const weekly = new Date(2026, 2, 2, 9, 0).getTime()
    for (const next of [nextPurchaseAt(weekly, 7 * DAY, new Date(2026, 2, 9, 12, 0).getTime()), nextOnCadence(weekly, 7 * DAY, new Date(2026, 2, 9, 12, 0).getTime())]) {
      assert.equal(next, new Date(2026, 2, 16, 9, 0).getTime())
      assert.equal(new Date(next).getHours(), 9)
    }
    const daily = new Date(2026, 2, 7, 9, 0).getTime()
    assert.equal(nextPurchaseAt(daily, DAY, new Date(2026, 2, 8, 10, 0).getTime()), new Date(2026, 2, 9, 9, 0).getTime())
    assert.equal(nextPurchaseAt(daily, DAY, new Date(2026, 2, 8, 8, 0).getTime()), new Date(2026, 2, 8, 9, 0).getTime())
    // Before the anchor it is the anchor; a cadence that isn't whole days keeps fixed steps.
    assert.equal(nextPurchaseAt(daily, DAY, daily - 1), daily)
    assert.equal(nextPurchaseAt(daily, 90 * 60_000, daily + 1), nextAligned(daily, 90 * 60_000, daily + 1))
  } finally {
    if (zone === undefined) delete process.env.TZ
    else process.env.TZ = zone
  }
})
