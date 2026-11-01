import { test } from 'node:test'
import assert from 'node:assert/strict'
import { versionLabel } from '@shared/version'
import { releaseNotesUrl, releaseTagUrl, RELEASES_URL } from '../src/shared/links'
import { PaymentsEngine, type PaymentsConfig } from '../src/main/features/payments/engine'
import { autopilotCovers, paymentsEngine, paymentsFeature } from '../src/main/features/payments'
import { endRun, grantFor, grantPurchase, mayHaveBoughtSince, setPurchaseLookup } from '../src/main/features/payments/plans'
import { QUIT_ERROR, SchedulerEngine, USER_STOP_ERROR, type RunResult } from '../src/main/features/scheduler/engine'
import { createScheduler, cutOffPurchasesToRetry } from '../src/main/features/scheduler/service'
import type { RunAgent } from '../src/main/features/scheduler/runner'
import { store } from '../src/main/store'
import { secrets } from '../src/main/secrets'
import type { FeatureContext } from '../src/main/features/types'
import { PAYMENTS_WAIVER, PAYMENTS_WAIVER_VERSION, type PurchaseRecord } from '@shared/payments'
import type { ScheduledTask, TaskRun } from '@shared/scheduler'

/**
 * The version people read, and automatic purchases across a restart (a
 * computer update quitting Eaon mid-purchase): nothing left behind uses up
 * the limits, nothing that may have gone through is bought again, and a
 * scheduled order that never got going is made once when Eaon is back.
 *
 * Times are mid-month at noon UTC, so "today" and "this month" are the same
 * day and month in every time zone the tests run in.
 */

const MIN = 60_000
const HOUR = 60 * MIN
const NOON = Date.UTC(2026, 9, 15, 12)

test('2026.7.3 is called 2026.7.2.1, as on GitHub, and its release notes open on that tag', async () => {
  assert.equal(versionLabel('2026.7.3'), '2026.7.2.1')
  assert.equal(versionLabel('2026.7.4'), '2026.7.4', 'any other version is its own name')
  assert.equal(versionLabel('2026.7.3-beta.1'), '2026.7.3-beta.1', 'a prerelease keeps its own name')
  assert.equal(releaseTagUrl('2026.7.2.1'), `${RELEASES_URL}/tag/v2026.7.2.1`)
  assert.equal(releaseTagUrl('2026.7.2.1.1'), null)
  const has = (urls: string[]) => async (url: string) => urls.includes(url)
  assert.equal(await releaseNotesUrl('2026.7.3', has([`${RELEASES_URL}/tag/v2026.7.2.1`])), `${RELEASES_URL}/tag/v2026.7.2.1`)
  assert.equal(await releaseNotesUrl('2026.7.3', has([`${RELEASES_URL}/tag/v2026.7.3`])), RELEASES_URL, 'never the semver tag, which has no release')
})

function purchase(over: Partial<PurchaseRecord>): PurchaseRecord {
  return { id: 'pay_1', merchant: 'Amazon', site: 'amazon.com', description: 'coffee', amount: 40, currency: 'USD', charged: null, status: 'authorized', how: 'scheduled', chatId: 'c1', createdAt: NOON, expiresAt: NOON + 20 * MIN, ...over }
}

function engineAt(now: number, purchases: PurchaseRecord[]) {
  let saved: PaymentsConfig | null = null
  let clock = now
  const config = {
    mode: 'auto',
    currency: 'USD',
    limits: { perPurchase: 50, perDay: 60, perMonth: 300 },
    card: { brand: 'Visa', last4: '4242', expMonth: 12, expYear: 2030, nameOnCard: 'Sam', billingZip: '94110', label: 'Agent card' },
    waiver: { version: PAYMENTS_WAIVER_VERSION, acceptedAt: now - 86_400_000, checks: PAYMENTS_WAIVER.checks.map(() => true) },
    purchases
  }
  const engine = new PaymentsEngine({
    load: () => structuredClone(saved ?? config),
    save: (c) => (saved = structuredClone(c)),
    getSecret: () => JSON.stringify({ number: '4242424242424242', cvc: '123' }),
    setSecret: () => {},
    now: () => clock
  })
  return { engine, saved: () => saved, setNow: (at: number) => (clock = at) }
}

test('a restart mid-purchase: an order never typed is cancelled and frees the limits; one that may have gone through is flagged, not forgotten', () => {
  const { engine, saved } = engineAt(NOON + 2 * HOUR, [
    purchase({ id: 'never-typed' }),
    purchase({ id: 'typed', typedAt: NOON + MIN, amount: 20 }),
    purchase({ id: 'pressed', submittedAt: NOON + MIN, amount: 0 }),
    purchase({ id: 'paid', status: 'paid', charged: 10, amount: 10, completedAt: NOON + 2 * MIN })
  ])
  const after = Object.fromEntries(engine.purchases().map((p) => [p.id, p]))
  assert.equal(after['never-typed'].status, 'cancelled')
  assert.match(after['never-typed'].note ?? '', /closed before this order was placed, so nothing was charged/)
  assert.equal(after.typed.status, 'authorized', 'it may have been charged: still counted')
  assert.equal(after.typed.tracking?.stage, 'problem')
  assert.match(after.typed.tracking?.note ?? '', /Check the store or your email/)
  assert.ok(after.typed.expiresAt <= NOON + 2 * HOUR, 'and the card can’t be typed for it again')
  assert.equal(after.pressed.tracking?.stage, 'problem', 'a free order whose button was pressed may have been placed too')
  assert.equal(after.paid.status, 'paid')
  assert.deepEqual(engine.spent(), { today: 30, month: 30 }, 'the cancelled one counts for nothing')
  assert.ok(saved(), 'settled once, and saved')
  assert.equal(engine.assess(25, 'USD').needsUser, false, 'so the next automatic purchase still fits the day')
  assert.throws(() => engine.usable('typed', 'c1'), /expired/, 'the flagged one can’t be typed again')
  assert.equal(engine.claimSpendingClick('c1', 'https://amazon.com/buy'), false, 'nor its order button pressed')
})

test('an engine never settles a purchase this process authorized, even one made again mid-run', () => {
  const first = engineAt(NOON, [])
  const record = first.engine.authorize({ merchant: 'Amazon', site: 'amazon.com', amount: 45, currency: 'USD', description: 'coffee', chatId: 'live' }, 'auto')
  // A second engine reading the same file in the same process (it is only ever made at launch, but if it were made again).
  const again = new PaymentsEngine({ load: () => structuredClone(first.saved()), save: () => {}, getSecret: () => JSON.stringify({ number: '4242424242424242', cvc: '123' }), setSecret: () => {}, now: () => NOON + MIN })
  assert.equal(again.purchases().find((p) => p.id === record.id)?.status, 'authorized', 'its run may still be using it')
  assert.equal(again.usable(record.id, 'live').id, record.id)
})

test('an authorization nobody used, once expired, stops counting against the limits even before a restart', () => {
  const { engine, setNow } = engineAt(NOON, [])
  const record = engine.authorize({ merchant: 'Amazon', site: 'amazon.com', amount: 45, currency: 'USD', description: 'coffee', chatId: 'c2' }, 'auto')
  assert.equal(engine.spent().today, 45, 'live: it may still be used')
  setNow(record.expiresAt + MIN)
  assert.equal(engine.spent().today, 0, 'expired and never used: it charged nothing')
  const typed = engine.authorize({ merchant: 'Amazon', site: 'amazon.com', amount: 15, currency: 'USD', description: 'tea', chatId: 'c2' }, 'auto')
  engine.markTyped(typed.id)
  const typedAt = engine.purchases().find((p) => p.id === typed.id)!.typedAt
  setNow(record.expiresAt + 2 * MIN)
  engine.markTyped(typed.id)
  assert.equal(engine.purchases().find((p) => p.id === typed.id)!.typedAt, typedAt, 'the first keystroke is the one kept')
  setNow(typed.expiresAt + MIN)
  assert.equal(engine.spent().today, 15, 'typed, it may have been charged: it keeps counting after it expires')
})

test('an autopilot press on the order’s store records the order as placed, so a cut-off free order isn’t taken for one never made', () => {
  const { engine } = engineAt(NOON, [])
  const record = engine.authorize({ merchant: 'Shop', site: 'shop.example', amount: 0, currency: 'USD', description: 'free sample', chatId: 'auto-chat', planId: 'plan-free' }, 'scheduled')
  grantPurchase('m-auto', { planId: 'plan-free', item: 'free sample', site: 'shop.example', maxAmount: 0, currency: 'USD', autopilot: true })
  try {
    assert.equal(autopilotCovers('auto-chat', 'https://shop.example/checkout', { messageId: 'm-auto', name: 'Place order' }, engine), false, 'not before the order is authorized')
    // payment_card's authorize uses the grant up; the order was authorized above.
    grantFor('m-auto')!.used = true
    assert.equal(autopilotCovers('auto-chat', 'https://shop.example/checkout', { messageId: 'm-auto', name: 'Place order' }, engine), true)
    const pressedAt = engine.purchases().find((p) => p.id === record.id)!.submittedAt
    assert.ok(pressedAt, 'the press is recorded')
    assert.equal(autopilotCovers('auto-chat', 'https://shop.example/checkout', { messageId: 'm-auto', name: 'Place order' }, engine), true, 'autopilot presses on again')
    assert.equal(engine.purchases().find((p) => p.id === record.id)!.submittedAt, pressedAt, 'the first press is the one kept')
    assert.equal(autopilotCovers('auto-chat', 'https://elsewhere.example/pay', { messageId: 'm-auto', name: 'Pay' }, engine), false)
  } finally {
    endRun('m-auto')
  }
})

const task = (over: Partial<ScheduledTask> = {}): ScheduledTask =>
  ({
    id: 't',
    name: 'Coffee',
    prompt: 'buy',
    schedule: { kind: 'interval', every: 24, unit: 'hours' },
    mode: 'work',
    model: null,
    cwd: null,
    allowChanges: false,
    enabled: true,
    createdAt: NOON - 72 * HOUR,
    updatedAt: NOON - 72 * HOUR,
    nextRunAt: NOON + 24 * HOUR,
    lastRunAt: NOON,
    lastStatus: 'cancelled',
    history: [],
    ...over
  }) as ScheduledTask

function engineWith(runs: Partial<TaskRun>[], execute: () => Promise<RunResult> = () => new Promise<RunResult>(() => {})): SchedulerEngine {
  let savedRuns: TaskRun[] = structuredClone(runs) as TaskRun[]
  return new SchedulerEngine({
    load: () => [task()],
    save: () => {},
    loadRuns: () => structuredClone(savedRuns),
    saveRuns: (r) => (savedRuns = structuredClone(r)),
    now: () => NOON + HOUR,
    monotonic: () => 1,
    zone: () => 'UTC',
    machine: 'Mac',
    execute
  })
}

test('the scheduler knows which runs a quit cut off, stopped cleanly or by a crash, and not ones run again or that were retries', () => {
  const engine = engineWith([
    { id: 'quit', taskId: 't', startedAt: NOON, finishedAt: NOON + MIN, status: 'cancelled', error: QUIT_ERROR, chatId: 'c1', trigger: 'schedule' },
    { id: 'crash', taskId: 't', startedAt: NOON - 24 * HOUR, finishedAt: null, status: 'running', chatId: 'c0', trigger: 'schedule' },
    { id: 'stopped', taskId: 't', startedAt: NOON - 48 * HOUR, finishedAt: NOON - 47 * HOUR, status: 'cancelled', error: USER_STOP_ERROR, chatId: 'c9', trigger: 'schedule' },
    { id: 'old-quit', taskId: 't', startedAt: NOON - 72 * HOUR, finishedAt: NOON - 71 * HOUR, status: 'cancelled', error: QUIT_ERROR, chatId: 'c8', trigger: 'schedule' },
    { id: 'retried', taskId: 't', startedAt: NOON - 70 * HOUR, finishedAt: NOON - 69 * HOUR, status: 'cancelled', error: QUIT_ERROR, chatId: 'c8', trigger: 'retry', retryOf: 'old-quit' }
  ])
  engine.load()
  assert.deepEqual(engine.interruptedAtLoad().map((r) => r.id).sort(), ['crash', 'quit'], 'a retry cut off in turn is never made a third time')
  engine.retry('t', 'quit')
  assert.deepEqual(engine.interruptedAtLoad().map((r) => r.id), ['crash'], 'run again from here: no longer waiting')
})

test('a run the user stopped is never passed off as cut off by a quit that came before it reported back', () => {
  const engine = engineWith([])
  engine.load()
  engine.start()
  const run = engine.runNow('t')
  engine.cancel('t')
  engine.stop()
  const after = engine.list()[0].history.find((r) => r.id === run.id)!
  assert.equal(after.status, 'cancelled')
  assert.equal(after.error, USER_STOP_ERROR)
  const relaunched = engineWith(engine.list()[0].history)
  relaunched.load()
  assert.deepEqual(relaunched.interruptedAtLoad(), [])
})

test('a cut-off purchase run is made again only when nothing can have been bought, the schedule is still the user’s to run, and within a day', () => {
  const now = NOON + 2 * HOUR
  const plan = task({ purchase: { item: 'coffee', site: 'amazon.com', merchant: 'Amazon', maxAmount: 45, currency: 'USD', notes: '', orders: null, track: false } })
  const run = (id: string, startedAt: number, chatId: string | null, over: Partial<TaskRun> = {}): TaskRun =>
    ({ id, taskId: plan.id, startedAt, finishedAt: startedAt + MIN, status: 'cancelled', error: QUIT_ERROR, chatId, trigger: 'schedule', ...over }) as TaskRun
  const nothing = (): boolean => false
  const pick = (runs: TaskRun[], t: ScheduledTask = plan, bought: (run: TaskRun) => boolean | null = nothing, paid = 0) =>
    cutOffPurchasesToRetry(runs, [t], now, bought, () => paid).map((r) => r.id)

  assert.deepEqual(pick([run('fresh', now - HOUR, 'thread')]), ['fresh'])
  assert.deepEqual(pick([run('before-chat', now - HOUR, null)]), ['before-chat'])
  assert.deepEqual(pick([run('bought', now - HOUR, 'thread')], plan, () => true), [], 'it may have bought something')
  assert.deepEqual(pick([run('unknown', now - HOUR, 'thread')], plan, () => null), [], 'payments isn’t running to tell')
  assert.deepEqual(pick([run('too-late', now - 25 * HOUR, 'thread')]), [])
  assert.deepEqual(pick([run('a-retry', now - HOUR, 'thread', { trigger: 'retry', retryOf: 'x' })]), [], 'once at most')
  assert.deepEqual(pick([run('r', now - HOUR, 'x')], task()), [], 'not a purchase schedule')
  assert.deepEqual(pick([run('r', now - HOUR, 'x')], { ...plan, enabled: false, nextRunAt: null, updatedAt: now - 30 * MIN }), [], 'the user turned it off')
  assert.deepEqual(
    pick([run('one-off', now - HOUR, 'x')], { ...plan, schedule: { kind: 'once', at: now - HOUR }, enabled: false, nextRunAt: null }),
    ['one-off'],
    'a one-off is switched off by its own run starting: that isn’t the user'
  )
  assert.deepEqual(
    pick([run('one-off', now - HOUR, 'x')], { ...plan, schedule: { kind: 'once', at: now - HOUR }, enabled: false, nextRunAt: null, updatedAt: now - 10 * MIN }),
    [],
    'one the user changed after it started is theirs'
  )
  const cut = run('cut', now - 3 * HOUR, 'x')
  assert.deepEqual(pick([cut], { ...plan, history: [cut, run('catch-up', now - MIN, 'x', { status: 'running', trigger: 'catch-up' })] }), [], 'a later run is already making the order')
  assert.deepEqual(pick([cut], { ...plan, history: [cut, run('missed', now - MIN, null, { status: 'missed' })] }), ['cut'], 'a missed slot made no order')
  assert.deepEqual(pick([cut], { ...plan, purchase: { ...plan.purchase!, orders: 2 } }, nothing, 2), [], 'all its orders are placed')
  assert.deepEqual(pick([cut], { ...plan, purchase: { ...plan.purchase!, orders: 2 } }, nothing, 1), ['cut'])
})

test('whether a run may have bought: its own purchases, not the earlier orders its schedule’s thread holds', () => {
  setPurchaseLookup({
    all: () => [
      purchase({ id: 'last-week', chatId: 'thread', planId: 'plan', status: 'paid', charged: 39, createdAt: NOON - 7 * 24 * HOUR }),
      purchase({ id: 'untyped', chatId: 'thread', planId: 'plan', createdAt: NOON + 5 * MIN }),
      purchase({ id: 'typed', chatId: 'thread-b', planId: 'plan-b', typedAt: NOON + 6 * MIN, createdAt: NOON + 5 * MIN }),
      purchase({ id: 'pressed', chatId: null as unknown as string, planId: 'plan-c', submittedAt: NOON + 6 * MIN, createdAt: NOON - 10 * MIN })
    ]
  })
  try {
    assert.equal(mayHaveBoughtSince('thread', 'plan', NOON), false, 'last week’s order is another run’s; this one never typed the card')
    assert.equal(mayHaveBoughtSince('thread-b', 'plan-b', NOON), true)
    assert.equal(mayHaveBoughtSince(null, 'plan-c', NOON), true, 'found by its schedule, and a clock set back a little doesn’t hide it')
    assert.equal(mayHaveBoughtSince('other', 'plan-d', NOON), false)
  } finally {
    setPurchaseLookup(null)
  }
  assert.equal(mayHaveBoughtSince('thread', 'plan', NOON), null, 'payments not running: can’t tell')
})

/* ------------------------------------------------- the whole launch, end to end */

const fakeCtx = {
  ipcMain: { handle: () => undefined },
  getWindow: () => null,
  getWindows: () => [],
  send: () => undefined,
  emitStream: () => undefined
} as unknown as FeatureContext
const page = { once: () => undefined, isDestroyed: () => false, send: () => undefined } as never
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }

test('relaunched after a quit mid-purchase: the untyped order is cancelled and the run made once, however often windows say they are ready', async () => {
  const now = Date.now()
  const plan = {
    ...task({ id: 'plan-launch', thread: 'thread-launch', createdAt: now - 10 * 24 * HOUR, updatedAt: now - 10 * 24 * HOUR, nextRunAt: now + 20 * HOUR, model: { providerId: 'fake', modelId: 'fake-model' } }),
    purchase: { item: 'coffee', site: 'amazon.com', merchant: 'Amazon', maxAmount: 45, currency: 'USD', notes: '', orders: null, track: false }
  }
  const { history: _h, ...saved } = plan
  store.setJson('scheduled-tasks.json', [saved])
  store.setJson('scheduled-runs.json', [
    { id: 'cut-off', taskId: plan.id, startedAt: now - HOUR, finishedAt: now - HOUR + 5 * MIN, status: 'cancelled', error: QUIT_ERROR, chatId: 'thread-launch', trigger: 'schedule' },
    { id: 'last-week', taskId: plan.id, startedAt: now - 7 * 24 * HOUR, finishedAt: now - 7 * 24 * HOUR + 5 * MIN, status: 'succeeded', chatId: 'thread-launch', trigger: 'schedule' }
  ])
  store.setJson('payments.json', {
    mode: 'approve',
    currency: 'USD',
    limits: { perPurchase: 50, perDay: 60, perMonth: 300 },
    card: null,
    waiver: null,
    purchases: [
      purchase({ id: 'cut-off-order', chatId: 'thread-launch', planId: plan.id, createdAt: now - HOUR + MIN, expiresAt: now - 40 * MIN }),
      purchase({ id: 'last-week-order', chatId: 'thread-launch', planId: plan.id, status: 'paid', charged: 39, createdAt: now - 7 * 24 * HOUR })
    ]
  })
  store.saveProviderConfig({ fake: { name: 'Fake', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', models: [{ id: 'fake-model', label: 'Fake', providerId: 'fake' }] } })
  secrets.set('fake', 'key')

  let runs = 0
  const runAgent: RunAgent = async () => {
    runs++
    return { text: 'Ordered.', usage }
  }
  // Launch order: the scheduler starts before payments, as in features/index.ts.
  const service = createScheduler(fakeCtx, { runAgent })
  service.start()
  service.rendererReady(page)
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(runs, 0, 'nothing is made again before payments can say what was bought')
  await paymentsFeature.register(fakeCtx)
  try {
    assert.equal(paymentsEngine()!.purchases().find((p) => p.id === 'cut-off-order')?.status, 'cancelled', 'the order the quit cut off charged nothing')
    await new Promise((resolve) => setTimeout(resolve, 2_200))
    await service.engine.whenIdle()
    assert.equal(runs, 1, 'made again once payments is up')
    // Another window, a reload: ready again, after the retry has finished.
    service.rendererReady(page)
    service.rendererReady(page)
    await new Promise((resolve) => setTimeout(resolve, 50))
    await service.engine.whenIdle()
    assert.equal(runs, 1, 'and only once')
    const history = service.engine.list().find((t) => t.id === plan.id)!.history
    assert.equal(history.filter((r) => r.retryOf === 'cut-off').length, 1)
    service.stop()

    // The next launch: the cut-off run has been made again, so nothing is.
    const next = createScheduler(fakeCtx, { runAgent })
    next.start()
    next.rendererReady(page)
    await new Promise((resolve) => setTimeout(resolve, 50))
    await next.engine.whenIdle()
    assert.equal(runs, 1)
    next.stop()
  } finally {
    paymentsFeature.dispose?.()
    await store.flushWrites()
  }
})
