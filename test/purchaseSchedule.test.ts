import { after, afterEach, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../src/main/agent/sources'
import { paymentsEngine, paymentsFeature } from '../src/main/features/payments'
import { endRun, grantPurchase, watchOrder } from '../src/main/features/payments/plans'
import { runAgent, type UnattendedPolicy } from '../src/main/agent/loop'
import { createScheduler, type SchedulerService } from '../src/main/features/scheduler/service'
import type { RunAgent } from '../src/main/features/scheduler/runner'
import { purchaseBrief } from '../src/main/features/scheduler/runner'
import { store } from '../src/main/store'
import { secrets } from '../src/main/secrets'
import { buildPurchasePlan, startOfDay, storeName, storeSite, type PurchaseForm } from '../src/renderer/src/components/purchase/plan'
import { describeSchedule, type TaskDraft } from '@shared/scheduler'
import type { StreamEvent, StreamRequest } from '@shared/types'
import type { FeatureContext } from '../src/main/features/types'
import { chunk, sseServer } from './helpers'

/**
 * Purchase schedules: saving one approves exactly one order per run, on its
 * site and within its amount, even when the user otherwise approves every
 * purchase and nobody is there to ask. The order number it records starts a
 * tracking task in the same thread, which stops once the order arrives.
 */

const card = { number: '4242 4242 4242 4242', expMonth: 12, expYear: 2030, cvc: '123', nameOnCard: 'Ada Lovelace', billingZip: '94107' }
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }

const fakeCtx = {
  ipcMain: { handle: () => undefined },
  getWindow: () => null,
  getWindows: () => [],
  send: () => undefined,
  emitStream: () => undefined
} as unknown as FeatureContext

const call = (args: Record<string, unknown>): string[] => [
  chunk({ tool_calls: [{ index: 0, id: `c_${Math.random().toString(36).slice(2)}`, function: { name: 'payment_card', arguments: JSON.stringify(args) } }] }, 'tool_calls')
]
const say = (text: string): string[] => [chunk({ content: text }, 'stop')]

function request(chatId: string, messageId: string): StreamRequest {
  return {
    chatId,
    messageId,
    providerId: 'fake',
    modelId: 'fake-model',
    effort: 'medium',
    mode: 'work',
    history: [{ id: 'u1', role: 'user', createdAt: 0, parts: [{ type: 'text', text: 'buy it' }] }],
    summary: null,
    projectInstructions: '',
    cwd: mkdtempSync(join(tmpdir(), 'eaon-plan-')),
    work: { swarm: false, plan: false },
    goal: null
  }
}

/** One unattended turn, as a scheduled run makes it: nobody to ask, the model makes `calls` in order. */
async function unattendedTurn(
  calls: Record<string, unknown>[],
  chatId: string,
  messageId: string,
  unattended: UnattendedPolicy = 'safe'
): Promise<Extract<StreamEvent, { type: 'tool-result' }>[]> {
  let index = 0
  const { server, url } = await sseServer(() => (index < calls.length ? call(calls[index++]) : say('done')))
  store.saveProviderConfig({ fake: { name: 'Fake', kind: 'openai-compatible', baseUrl: url, models: [{ id: 'fake-model', label: 'Fake', providerId: 'fake' }] } })
  secrets.set('fake', 'key')
  const events: StreamEvent[] = []
  await runAgent(request(chatId, messageId), (e) => events.push(e), { unattended, approver: async () => false })
  server.close()
  return events.filter((e): e is Extract<StreamEvent, { type: 'tool-result' }> => e.type === 'tool-result')
}

const coffee = { planId: 'plan-coffee', item: '2 bags of Lavazza Super Crema', site: 'amazon.com', maxAmount: 45, currency: 'USD' }

before(async () => {
  await paymentsFeature.register(fakeCtx)
})
after(() => paymentsFeature.dispose?.())
beforeEach(() => {
  const engine = paymentsEngine()!
  engine.removeCard()
  engine.revokeWaiver()
  // Approve every purchase: the strictest mode, where only the schedule's own approval lets an order through.
  engine.setCard(card)
  store.patchSettings({ approvalMode: 'ask' })
})

/* ------------------------------------------------------ the plan's approval */

test('a purchase schedule run buys its one order without asking, on its site and within its amount', async () => {
  grantPurchase('m-plan-1', coffee)
  const results = await unattendedTurn(
    [
      { action: 'authorize', merchant: 'Amazon', amount: 38.9, site: 'www.amazon.com', description: 'Lavazza x2' },
      { action: 'authorize', merchant: 'Amazon', amount: 5, site: 'amazon.com', description: 'one more thing' }
    ],
    'thread-1',
    'm-plan-1'
  )
  endRun('m-plan-1')
  assert.equal(results[0].status, 'done', results[0].output)
  assert.match(results[0].output, /approved by the user's purchase schedule/)
  assert.match(results[1].output, /already placed its one order/, 'a second order in the same run is refused')
  const mine = paymentsEngine()!.purchases().filter((p) => p.chatId === 'thread-1')
  assert.equal(mine.length, 1, 'one order, not two')
  assert.equal(mine[0].how, 'scheduled')
  assert.equal(mine[0].planId, 'plan-coffee')
})

test('a purchase schedule run refuses another store, a price over its maximum, and another currency', async () => {
  grantPurchase('m-plan-2', coffee)
  const before = paymentsEngine()!.purchases().length
  const results = await unattendedTurn(
    [
      { action: 'authorize', merchant: 'Evil', amount: 10, site: 'amazon.com.evil.io' },
      { action: 'authorize', merchant: 'Amazon', amount: 52.5, site: 'amazon.com' },
      { action: 'authorize', merchant: 'Amazon', amount: 30, currency: 'EUR', site: 'amazon.com' }
    ],
    'thread-2',
    'm-plan-2'
  )
  endRun('m-plan-2')
  assert.match(results[0].output, /approved for amazon\.com only/)
  assert.match(results[1].output, /over this purchase schedule's \$45\.00 limit/)
  assert.match(results[2].output, /in USD, not EUR/)
  assert.equal(paymentsEngine()!.purchases().length, before, 'nothing was authorized')
})

test('without a purchase schedule, an unattended run still cannot buy anything in approve mode', async () => {
  const before = paymentsEngine()!.purchases().length
  const results = await unattendedTurn([{ action: 'authorize', merchant: 'Amazon', amount: 10, site: 'amazon.com' }], 'thread-3', 'm-nogrant')
  assert.equal(results[0].status, 'denied')
  assert.equal(paymentsEngine()!.purchases().length, before)
})

test('a tracking run in the same thread does not inherit the purchase run’s approval', async () => {
  grantPurchase('m-plan-4', coffee)
  watchOrder('m-watch-4', 'pay_x')
  const results = await unattendedTurn([{ action: 'authorize', merchant: 'Amazon', amount: 10, site: 'amazon.com' }], 'thread-4', 'm-watch-4')
  endRun('m-plan-4')
  endRun('m-watch-4')
  assert.equal(results[0].status, 'denied')
})

/* ----------------------------------------------- order number and tracking */

test('complete keeps the order number, and a tracking run records where the order is', async () => {
  grantPurchase('m-plan-5', coffee)
  const auth = await unattendedTurn([{ action: 'authorize', merchant: 'Amazon', amount: 38.9, site: 'amazon.com' }], 'thread-5', 'm-plan-5')
  const id = /Authorized (pay_\w+)/.exec(auth[0].output)![1]
  const done = await unattendedTurn([{ action: 'complete', purchase_id: id, status: 'paid', charged: 39.12, order_id: '112-4471923-0046611' }], 'thread-5', 'm-plan-5')
  endRun('m-plan-5')
  assert.match(done[0].output, /order 112-4471923-0046611, ordered/)

  // A run that isn't watching this order, in another chat, may not touch it.
  const stranger = await unattendedTurn([{ action: 'track', purchase_id: id, stage: 'delivered' }], 'elsewhere', 'm-stranger')
  assert.match(stranger[0].output, /another conversation/)

  // The tracking run (read-only: looking is all it does) records the news.
  watchOrder('m-watch-5', id)
  const tracked = await unattendedTurn(
    [{ action: 'track', purchase_id: id, stage: 'shipped', eta: 'Thu, Oct 22', carrier: 'UPS', tracking_number: '1Z999AA10123456784' }],
    'elsewhere',
    'm-watch-5',
    'read-only'
  )
  endRun('m-watch-5')
  assert.equal(tracked[0].status, 'done', tracked[0].output)
  const record = paymentsEngine()!.status().purchases.find((p) => p.id === id)!
  assert.equal(record.orderId, '112-4471923-0046611')
  assert.equal(record.tracking?.stage, 'shipped')
  assert.equal(record.tracking?.eta, 'Thu, Oct 22')
  assert.equal(record.tracking?.carrier, 'UPS')
})

/* ------------------------------------------------- the scheduler follow-ups */

const TASKS = 'scheduled-tasks.json'
let service: SchedulerService | null = null
afterEach(async () => {
  service?.stop()
  await service?.engine.whenIdle()
  service = null
  await store.flushWrites()
})

function planDraft(overrides: Partial<TaskDraft> = {}): TaskDraft {
  return {
    name: 'Buy coffee',
    prompt: 'Buy 2 bags of Lavazza Super Crema from Amazon, up to $45.00 an order.',
    schedule: { kind: 'interval', every: 168, unit: 'hours' },
    mode: 'work',
    model: { providerId: 'fake', modelId: 'fake-model' },
    cwd: null,
    allowChanges: true,
    enabled: true,
    purchase: { item: '2 bags of Lavazza Super Crema', site: 'amazon.com', merchant: 'Amazon', maxAmount: 45, currency: 'USD', notes: '', orders: 1, track: true },
    thread: 'thread-plan',
    ...overrides
  }
}

test('an order with a number starts tracking in the plan’s thread; a plan with all its orders placed switches off', async () => {
  store.setJson(TASKS, [])
  store.saveChats([])
  let brief = ''
  // Stands in for the agent: places the order the way payment_card would.
  const placeOrder: RunAgent = async (req) => {
    brief = req.projectInstructions ?? ''
    const engine = paymentsEngine()!
    const record = engine.authorize({ merchant: 'Amazon', site: 'amazon.com', description: 'coffee', amount: 39, currency: 'USD', chatId: req.chatId, planId: plan.id }, 'scheduled')
    engine.complete(record.id, req.chatId, 'paid', 39.12, '', 'ORDER-777')
    return { text: 'Ordered: ORDER-777', usage }
  }
  service = createScheduler(fakeCtx, { runAgent: placeOrder })
  service.start()
  service.engine.start()
  const plan = service.engine.save(planDraft())
  service.engine.runNow(plan.id)
  await service.engine.whenIdle()

  assert.match(brief, /Buy: 2 bags of Lavazza Super Crema/)
  assert.match(brief, /Most this order may cost: \$45\.00/)
  const tasks = service.engine.list()
  const watch = tasks.find((t) => t.watch)
  assert.ok(watch, 'a tracking task was created')
  assert.equal(watch.watch?.orderId, 'ORDER-777')
  assert.equal(watch.thread, 'thread-plan', 'tracking writes into the plan’s thread')
  assert.equal(describeSchedule(watch.schedule), 'Every 12 hours')
  assert.equal(tasks.find((t) => t.id === plan.id)?.enabled, false, 'its one order is placed, so the plan is done')
  await store.flushWrites()
  assert.ok(store.getChats().some((c) => c.id === 'thread-plan'), 'the run wrote into the thread')

  // The tracking run finds it delivered: tracking stops.
  service.stop()
  const deliver: RunAgent = async (req) => {
    paymentsEngine()!.track(watch.watch!.purchaseId, () => true, { stage: 'delivered' })
    void req
    return { text: 'Delivered today.', usage }
  }
  service = createScheduler(fakeCtx, { runAgent: deliver })
  service.start()
  service.engine.start()
  service.engine.runNow(watch.id)
  await service.engine.whenIdle()
  assert.equal(service.engine.list().some((t) => t.id === watch.id), false, 'a delivered order is no longer tracked')
})

test('a saved purchase schedule keeps its plan when edited without one, and starts on the day picked', () => {
  store.setJson(TASKS, [])
  service = createScheduler(fakeCtx, { runAgent: async () => ({ text: '', usage }) })
  service.start()
  const startAt = Date.now() + 3 * 24 * 60 * 60_000
  const saved = service.engine.save(planDraft({ schedule: { kind: 'interval', every: 336, unit: 'hours', startAt } }))
  assert.equal(saved.nextRunAt, startAt)
  const { purchase: _p, thread: _t, ...withoutPlan } = planDraft()
  const edited = service.engine.save({ ...withoutPlan, id: saved.id, name: 'Coffee', schedule: saved.schedule })
  assert.equal(edited.purchase?.site, 'amazon.com')
  assert.equal(edited.thread, 'thread-plan')
  assert.equal(edited.nextRunAt, startAt)
  assert.equal(describeSchedule(edited.schedule), 'Every 2 weeks')
})

test('the brief compares this order with the last one and stops at a price over the maximum', () => {
  const brief = purchaseBrief({
    ...planDraft(),
    id: 'plan-coffee',
    createdAt: 0,
    updatedAt: 0,
    nextRunAt: null,
    lastRunAt: null,
    lastStatus: null,
    history: []
  } as never)
  assert.match(brief, /If the checkout total is higher, do not buy/)
  assert.match(brief, /order 112-4471923-0046611/, 'earlier orders are listed with their numbers')
  assert.match(brief, /price against the last order/)
})

/* ------------------------------------------------------- the dialog's maths */

const form = (overrides: Partial<PurchaseForm> = {}): PurchaseForm => ({
  item: '2 bags of Lavazza Super Crema',
  site: 'https://www.Amazon.com/dp/B000',
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

test('today buys now, and the next order falls a period after today’s time', () => {
  const now = new Date(2026, 9, 15, 15, 30).getTime()
  const built = buildPurchasePlan(form({ startDay: startOfDay(now) }), now, 'thread-x')
  assert.equal(built.error, null)
  assert.equal(built.buyNow, true)
  assert.equal(built.draft.purchase?.site, 'amazon.com')
  assert.equal(built.draft.purchase?.merchant, 'Amazon')
  assert.equal(built.draft.purchase?.orders, null)
  assert.deepEqual(built.draft.schedule, { kind: 'interval', every: 168, unit: 'hours', startAt: new Date(2026, 9, 22, 9, 0).getTime() })
  assert.equal(built.draft.thread, 'thread-x')
})

test('a later day waits for it; once today is placed right away and never again', () => {
  const now = new Date(2026, 9, 15, 15, 30).getTime()
  const later = buildPurchasePlan(form({ startDay: startOfDay(new Date(2026, 9, 20).getTime()), time: '08:15', cadence: 'biweekly' }), now, 't')
  assert.equal(later.buyNow, false)
  assert.equal(later.nextAt, new Date(2026, 9, 20, 8, 15).getTime())
  const once = buildPurchasePlan(form({ cadence: 'once', startDay: startOfDay(now) }), now, 't')
  assert.equal(once.buyNow, true)
  assert.equal(once.draft.enabled, false)
  assert.equal(once.draft.purchase?.orders, 1)
  assert.equal(once.nextAt, null)
  assert.equal(once.error, null)
})

test('the dialog says what is missing, and reads store names off their sites', () => {
  const now = Date.now()
  assert.match(buildPurchasePlan(form({ site: 'not a site' }), now, 't').error ?? '', /website/)
  assert.match(buildPurchasePlan(form({ maxAmount: '' }), now, 't').error ?? '', /most an order may cost/)
  assert.match(buildPurchasePlan(form({ item: ' ' }), now, 't').error ?? '', /what to buy/)
  assert.equal(storeSite('Target.com.'), 'target.com')
  assert.equal(storeName('shop.example.co.uk'), 'Example')
  assert.equal(storeName('store.apple.com'), 'Apple')
})
