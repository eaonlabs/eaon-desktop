import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { SchedulerEngine, type RunHandle, type RunResult } from '../src/main/features/scheduler/engine'
import { migrateScheduledRuns, RUNS_FILE, TASKS_FILE } from '../src/main/features/scheduler/migrate'
import { store } from '../src/main/store'
import { resetStoreHealthForTests, storeHealth } from '../src/main/storeFiles'
import { currentZone, resetZoneForTests, systemZoneFromLink } from '../src/main/timezone'
import {
  countSlots,
  overlapAction,
  planDue,
  runReason,
  WEEKDAYS,
  type ScheduledTask,
  type TaskDraft,
  type TaskRun
} from '@shared/scheduler'

/**
 * The scheduler against the clock: daylight saving both ways, a change of
 * time zone, the clock set by hand, a Mac asleep through its slots, Eaon
 * closed through several, quitting mid-run, deleting or editing a task while
 * it runs, runs longer than their interval, and every one of those leaving a
 * record that says what happened. The engine is driven with an injected wall
 * clock, monotonic clock and zone; runs are fakes that finish when told.
 */

process.env.TZ = 'America/New_York'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
/** Offsets written out, so a test reads as wall-clock times in New York. */
const ny = (iso: string): number => new Date(iso).getTime()

interface Harness {
  engine: SchedulerEngine
  clock: { wall: number; mono: number; zone: string }
  /** Advance both clocks (awake). */
  pass: (ms: number) => void
  /** Advance the wall clock only (asleep, or the clock set forward). */
  sleep: (ms: number) => void
  runs: { task: ScheduledTask; handle: RunHandle; finish: (result?: Partial<RunResult>) => void }[]
  saved: { tasks: unknown[]; runs: TaskRun[] }
  damaged: number[]
}

const engines: SchedulerEngine[] = []
afterEach(async () => {
  for (const engine of engines.splice(0)) {
    engine.stop()
    await engine.whenIdle()
  }
})

function harness(start: number, stored: { tasks?: unknown[]; runs?: unknown[] } = {}, zone = 'America/New_York'): Harness {
  const clock = { wall: start, mono: 1_000_000, zone }
  const saved = { tasks: structuredClone(stored.tasks ?? []), runs: structuredClone((stored.runs ?? []) as TaskRun[]) }
  const runs: Harness['runs'] = []
  const damaged: number[] = []
  const engine = new SchedulerEngine({
    load: () => structuredClone(saved.tasks),
    save: (tasks) => (saved.tasks = structuredClone(tasks)),
    loadRuns: () => structuredClone(saved.runs),
    saveRuns: (list) => (saved.runs = structuredClone(list)),
    onDamaged: (count) => damaged.push(count),
    now: () => clock.wall,
    monotonic: () => clock.mono,
    zone: () => clock.zone,
    machine: 'Mac',
    execute: (task, handle) =>
      new Promise<RunResult>((resolve) => {
        const finish = (result: Partial<RunResult> = {}): void => resolve({ status: 'succeeded', chatId: `chat-${handle.runId}`, ...result })
        handle.signal.addEventListener('abort', () => finish({ status: 'cancelled' }), { once: true })
        runs.push({ task, handle, finish })
      })
  })
  engines.push(engine)
  return {
    engine,
    clock,
    pass: (ms) => {
      clock.wall += ms
      clock.mono += ms
    },
    sleep: (ms) => {
      clock.wall += ms
    },
    runs,
    saved,
    damaged
  }
}

function draft(overrides: Partial<TaskDraft> = {}): TaskDraft {
  return {
    name: 'Digest',
    prompt: 'Summarise.',
    schedule: { kind: 'daily', time: '09:00', days: WEEKDAYS },
    mode: 'chat',
    model: null,
    cwd: null,
    allowChanges: false,
    enabled: true,
    ...overrides
  }
}

const only = (h: Harness): ScheduledTask => h.engine.list()[0]

/* ------------------------------------------------------- the pure rules */

test('planDue folds every missed slot into one run, or one missed record past a day', () => {
  const schedule = { kind: 'interval' as const, every: 15, unit: 'minutes' as const, startAt: ny('2026-10-05T08:00:00-04:00') }
  const plan = planDue(schedule, ny('2026-10-05T08:00:00-04:00'), ny('2026-10-05T11:05:00-04:00'))
  assert.deepEqual(plan, { action: 'run', slot: ny('2026-10-05T11:00:00-04:00'), slots: 13, late: true })
  assert.deepEqual(planDue(schedule, ny('2026-10-05T08:00:00-04:00'), ny('2026-10-05T07:00:00-04:00')), { action: 'wait' })
  const stale = planDue(schedule, ny('2026-10-01T08:00:00-04:00'), ny('2026-10-05T11:05:00-04:00'))
  assert.equal(stale.action, 'run', 'the latest slot is minutes old, so it runs once')
  const daily = { kind: 'daily' as const, time: '09:00', days: [1] }
  const week = planDue(daily, ny('2026-09-28T09:00:00-04:00'), ny('2026-10-04T12:00:00-04:00'))
  assert.equal(week.action, 'miss')
  assert.equal(countSlots(daily, ny('2026-09-01T00:00:00-04:00'), ny('2026-09-30T23:59:00-04:00')), 4, 'Mondays in September 2026')
})

test('overlap policies decide the same way for every caller', () => {
  assert.equal(overlapAction('skip', false), 'start')
  assert.equal(overlapAction('skip', true), 'skip')
  assert.equal(overlapAction('queue', true), 'queue')
  assert.equal(overlapAction('queue', true, true), 'skip', 'never more than one waiting')
  assert.equal(overlapAction('replace', true), 'replace')
  assert.equal(overlapAction('parallel', true), 'start')
})

test('reasons read like what happened', () => {
  const at = ny('2026-10-05T09:00:00-04:00')
  const clock = (): string => '9:00 AM'
  const base = { id: 'r', startedAt: at, finishedAt: at, chatId: null, trigger: 'schedule' as const }
  assert.equal(runReason({ ...base, status: 'missed', cause: 'asleep' }, 'Mac', clock), 'Missed while your Mac was asleep. It was more than a day late, so it didn’t run.')
  assert.equal(runReason({ ...base, status: 'skipped', cause: 'overlap', slots: 3 }, 'Mac', clock), 'Skipped (3 times): the previous run was still going.')
  assert.equal(runReason({ ...base, status: 'succeeded', trigger: 'catch-up', cause: 'closed', slotAt: at }, 'Mac', clock), 'Ran late: Eaon wasn’t running at 9:00 AM.')
  assert.equal(
    runReason({ ...base, status: 'succeeded', trigger: 'catch-up', cause: 'asleep', slotAt: at, slots: 4 }, 'Mac', clock),
    'Ran once for 4 runs missed while your Mac was asleep, not 4 times.'
  )
  assert.equal(runReason({ ...base, status: 'succeeded' }, 'Mac', clock), null)
})

/* --------------------------------------------------- daylight saving */

test('DST spring forward: a 02:30 daily task runs at 03:30 that day and 02:30 the next', async () => {
  const h = harness(ny('2026-03-07T12:00:00-05:00'))
  h.engine.load()
  h.engine.start()
  h.engine.save(draft({ schedule: { kind: 'daily', time: '02:30', days: WEEKDAYS } }))
  // Sunday 2026-03-08: 02:00 EST jumps to 03:00 EDT, so 02:30 doesn't
  // exist; the stored slot (02:30 EST) is 03:30 EDT on the wall.
  assert.equal(only(h).nextRunAt, ny('2026-03-08T03:30:00-04:00'))
  h.pass(ny('2026-03-08T03:30:00-04:00') - h.clock.wall)
  h.engine.tick()
  assert.equal(h.runs.length, 1)
  assert.equal(only(h).history[0].trigger, 'schedule', 'on time, not a catch-up')
  h.runs[0].finish()
  await h.engine.whenIdle()
  assert.equal(only(h).nextRunAt, ny('2026-03-09T02:30:00-04:00'), 'back to 02:30 the next day')
})

test('DST: wall-clock tasks keep their time across both changes; a repeated hour runs once', async () => {
  const h = harness(ny('2026-10-31T12:00:00-04:00'))
  h.engine.load()
  h.engine.start()
  h.engine.save(draft({ schedule: { kind: 'daily', time: '01:30', days: WEEKDAYS } }))
  // Sunday 2026-11-01: 01:00–02:00 happens twice.
  assert.equal(only(h).nextRunAt, ny('2026-11-01T01:30:00-04:00'))
  h.pass(ny('2026-11-01T01:30:00-04:00') - h.clock.wall)
  h.engine.tick()
  assert.equal(h.runs.length, 1)
  h.runs[0].finish()
  await h.engine.whenIdle()
  // The second 01:30 (EST) an hour later does not run it again.
  h.pass(HOUR)
  h.engine.tick()
  assert.equal(h.runs.length, 1, 'the repeated 01:30 does not run twice')
  assert.equal(only(h).nextRunAt, ny('2026-11-02T01:30:00-05:00'))
})

/* ---------------------------------------------------- zones and clocks */

test('a change of time zone moves a daily task to the new wall clock, and leaves intervals on their grid', () => {
  const h = harness(ny('2026-10-05T06:00:00-04:00'))
  h.engine.load()
  h.engine.start()
  const daily = h.engine.save(draft({ name: 'daily' }))
  const interval = h.engine.save(draft({ name: 'interval', schedule: { kind: 'interval', every: 2, unit: 'hours' } }))
  assert.equal(daily.nextRunAt, ny('2026-10-05T09:00:00-04:00'))
  // Flown to Los Angeles: 9:00 there is 12:00 in New York. Before, the
  // stored 9:00-New-York slot fired at 6:00 local.
  process.env.TZ = 'America/Los_Angeles'
  try {
    h.clock.zone = 'America/Los_Angeles'
    h.pass(MIN)
    h.engine.tick()
    const byName = new Map(h.engine.list().map((t) => [t.name, t]))
    assert.equal(byName.get('daily')!.nextRunAt, new Date('2026-10-05T09:00:00-07:00').getTime())
    assert.equal(byName.get('daily')!.zone, 'America/Los_Angeles')
    assert.equal(byName.get('interval')!.nextRunAt, interval.nextRunAt, 'an interval is real time, not wall time')
    assert.equal(h.runs.length, 0)
  } finally {
    process.env.TZ = 'America/New_York'
  }
})

test('the system zone is read from /etc/localtime, and only a change of it counts', () => {
  assert.equal(systemZoneFromLink(() => '/var/db/timezone/zoneinfo/Europe/Paris'), process.platform === 'win32' ? null : 'Europe/Paris')
  assert.equal(systemZoneFromLink(() => '/etc/something-else'), null)
  // TZ was set by this test file, so the process keeps it (a user's or test's choice).
  resetZoneForTests()
  assert.equal(currentZone(() => '/usr/share/zoneinfo/Asia/Tokyo'), 'America/New_York')
})

test('the clock set back pulls the next run in; set forward past a day, the slot is missed and says why', async () => {
  // Monday 8:00; a Monday-only task.
  const h = harness(ny('2026-10-05T08:00:00-04:00'))
  h.engine.load()
  h.engine.start()
  h.engine.save(draft({ schedule: { kind: 'daily', time: '09:00', days: [1] } }))
  assert.equal(only(h).nextRunAt, ny('2026-10-05T09:00:00-04:00'))
  // Set back a week: the stored slot is a week off; the next is that Monday's 9:00.
  h.clock.wall -= 7 * DAY
  h.engine.tick()
  assert.equal(only(h).nextRunAt, ny('2026-09-28T09:00:00-04:00'))
  // Set forward to Wednesday: Monday's slot is two days late.
  h.clock.wall += 9 * DAY
  h.engine.tick()
  const [missed] = only(h).history
  assert.equal(missed.status, 'missed')
  assert.equal(missed.startedAt, ny('2026-10-05T09:00:00-04:00'), 'the latest slot, not the first')
  assert.equal(missed.slots, 2)
  assert.match(missed.error!, /more than a day late/)
  assert.equal(h.runs.length, 0)
  assert.equal(only(h).nextRunAt, ny('2026-10-12T09:00:00-04:00'))
})

/* ------------------------------------------------------- asleep, closed */

test('asleep through twelve quarter-hours: one run on waking, labelled, never twelve', async () => {
  const h = harness(ny('2026-10-05T08:00:00-04:00'))
  h.engine.load()
  h.engine.start()
  h.engine.save(draft({ schedule: { kind: 'interval', every: 15, unit: 'minutes' } }))
  h.pass(MIN)
  h.engine.tick()
  // The lid closes; three hours pass on the wall clock and none on the monotonic one.
  h.sleep(3 * HOUR)
  h.engine.tick()
  h.engine.tick()
  assert.equal(h.runs.length, 1, 'one run, not one per missed slot')
  const [run] = only(h).history
  assert.equal(run.trigger, 'catch-up')
  assert.equal(run.cause, 'asleep')
  assert.equal(run.slots, 12)
  assert.equal(runReason(run, 'Mac'), 'Ran once for 12 runs missed while your Mac was asleep, not 12 times.')
  h.runs[0].finish()
  await h.engine.whenIdle()
  assert.ok(only(h).nextRunAt! > h.clock.wall && only(h).nextRunAt! <= h.clock.wall + 15 * MIN)
})

test('the resume event alone also labels a late run as asleep', async () => {
  const h = harness(ny('2026-10-05T08:00:00-04:00'))
  h.engine.load()
  h.engine.start()
  h.engine.save(draft({ schedule: { kind: 'interval', every: 30, unit: 'minutes' } }))
  h.pass(40 * MIN)
  // No gap between the clocks (some sleeps keep the monotonic clock going), but macOS said it woke.
  h.engine.wake()
  assert.equal(only(h).history[0].cause, 'asleep')
})

test('closed through several slots: one catch-up at launch, labelled as Eaon not running', async () => {
  const start = ny('2026-10-05T08:00:00-04:00')
  const first = harness(start)
  first.engine.load()
  first.engine.start()
  first.engine.save(draft({ schedule: { kind: 'interval', every: 1, unit: 'hours' } }))
  first.engine.stop()
  // Relaunched (or started at login) five hours later.
  const later = harness(start + 5 * HOUR + 10 * MIN, first.saved)
  later.engine.load()
  later.engine.start()
  assert.equal(later.runs.length, 1)
  const [run] = only(later).history
  assert.equal(run.cause, 'closed')
  assert.equal(run.slots, 5)
  assert.equal(run.slotAt, start + 5 * HOUR)
})

/* ------------------------------------------------ quitting and restarts */

test('quitting mid-run records it as stopped by the quit; the restart neither re-runs it nor loses the grid', async () => {
  const start = ny('2026-10-05T08:00:00-04:00')
  const h = harness(start)
  h.engine.load()
  h.engine.start()
  const task = h.engine.save(draft({ schedule: { kind: 'interval', every: 1, unit: 'hours' } }))
  h.pass(HOUR)
  h.engine.tick()
  assert.equal(h.runs.length, 1)
  h.engine.stop()
  await h.engine.whenIdle()
  assert.equal(h.saved.runs[0].status, 'cancelled')
  assert.match(h.saved.runs[0].error!, /quit during this run/)

  const next = harness(start + HOUR + 5 * MIN, h.saved)
  next.engine.load()
  next.engine.start()
  assert.equal(next.runs.length, 0, 'the slot it was running is not run again')
  assert.equal(only(next).nextRunAt, start + 2 * HOUR)
  assert.equal(only(next).history[0].id, h.saved.runs[0].id)
  assert.equal(only(next).id, task.id)
})

test('a crash mid-run (no stop) loads as failed, never as running forever', () => {
  const start = ny('2026-10-05T08:00:00-04:00')
  const task = { id: 't', name: 'T', prompt: 'p', schedule: { kind: 'daily', time: '09:00', days: WEEKDAYS }, mode: 'chat', model: null, cwd: null, allowChanges: false, enabled: true, createdAt: start, updatedAt: start, nextRunAt: start + 25 * HOUR, lastRunAt: start, lastStatus: 'running' }
  const h = harness(start + HOUR, { tasks: [task], runs: [{ id: 'r', taskId: 't', startedAt: start, finishedAt: null, status: 'running', chatId: 'c', trigger: 'schedule' }] })
  h.engine.load()
  assert.equal(only(h).history[0].status, 'failed')
  assert.equal(only(h).lastStatus, 'failed')
})

/* -------------------------------------------------- deleting and editing */

test('a task deleted while its timer is armed never fires; deleted mid-run, its record goes and nothing breaks', async () => {
  const h = harness(ny('2026-10-05T08:00:00-04:00'))
  h.engine.load()
  h.engine.start()
  const queued = h.engine.save(draft({ name: 'queued', schedule: { kind: 'interval', every: 5, unit: 'minutes' } }))
  h.engine.remove(queued.id)
  h.pass(10 * MIN)
  h.engine.tick()
  assert.equal(h.runs.length, 0)

  const busy = h.engine.save(draft({ name: 'busy' }))
  h.engine.runNow(busy.id)
  assert.equal(h.runs.length, 1)
  h.engine.remove(busy.id)
  await h.engine.whenIdle()
  assert.deepEqual(h.engine.list(), [])
  assert.deepEqual(h.saved.runs, [])
})

test('editing a task while it runs keeps the run going and its record; the new schedule applies next', async () => {
  const h = harness(ny('2026-10-05T08:00:00-04:00'))
  h.engine.load()
  h.engine.start()
  const task = h.engine.save(draft())
  const run = h.engine.runNow(task.id)
  h.engine.save({ ...draft({ name: 'Renamed', prompt: 'New prompt', schedule: { kind: 'daily', time: '17:00', days: WEEKDAYS } }), id: task.id })
  assert.equal(h.runs[0].task.prompt, 'Summarise.', 'the run in progress keeps what it started with')
  assert.equal(only(h).nextRunAt, ny('2026-10-05T17:00:00-04:00'))
  assert.equal(only(h).history[0].id, run.id)
  h.runs[0].finish({ tokens: { input: 120, output: 30, cacheRead: 0, cacheWrite: 0 } })
  await h.engine.whenIdle()
  const [done] = only(h).history
  assert.equal(done.status, 'succeeded')
  assert.deepEqual(done.tokens, { input: 120, output: 30, cacheRead: 0, cacheWrite: 0 })
  assert.equal(only(h).name, 'Renamed')
})

/* --------------------------------------------- overlapping and retrying */

test('a run longer than several intervals: one skipped record counting each slot, and no second copy', async () => {
  const h = harness(ny('2026-10-05T08:00:00-04:00'))
  h.engine.load()
  h.engine.start()
  h.engine.save(draft({ schedule: { kind: 'interval', every: 10, unit: 'minutes' } }))
  h.pass(10 * MIN)
  h.engine.tick()
  assert.equal(h.runs.length, 1)
  for (let i = 0; i < 4; i++) {
    h.pass(10 * MIN)
    h.engine.tick()
  }
  assert.equal(h.runs.length, 1, 'never two at once')
  const history = only(h).history
  assert.deepEqual(
    history.map((r) => r.status),
    ['skipped', 'running']
  )
  assert.equal(history[0].slots, 4)
  assert.equal(history[0].blockedBy, history[1].id)
  assert.equal(only(h).lastStatus, 'running')
  h.runs[0].finish()
  await h.engine.whenIdle()
  assert.equal(only(h).lastStatus, 'succeeded')
  h.pass(10 * MIN)
  h.engine.tick()
  assert.equal(h.runs.length, 2, 'the next slot after it finished runs')
})

test('Retry re-runs a failed run as a new record that points back at it', async () => {
  const h = harness(ny('2026-10-05T08:00:00-04:00'))
  h.engine.load()
  h.engine.start()
  const task = h.engine.save(draft())
  const failed = h.engine.runNow(task.id)
  h.runs[0].finish({ status: 'failed', error: 'The provider is down.' })
  await h.engine.whenIdle()
  const retry = h.engine.retry(task.id, failed.id)
  assert.throws(() => h.engine.retry(task.id, failed.id), /already running/)
  assert.equal(retry.trigger, 'retry')
  assert.equal(retry.retryOf, failed.id)
  h.runs[1].finish()
  await h.engine.whenIdle()
  assert.deepEqual(
    only(h).history.map((r) => [r.trigger, r.status]),
    [
      ['retry', 'succeeded'],
      ['manual', 'failed']
    ]
  )
  assert.throws(() => h.engine.retry(task.id, 'nope'), /no longer in the history/)
})

/* ----------------------------------------------------- what's on disk */

test('stored tasks are repaired, not dropped: bad times recomputed, bad schedules paused, newer kinds kept', () => {
  const now = ny('2026-10-05T08:00:00-04:00')
  const good = { id: 'a', name: 'A', prompt: 'p', schedule: { kind: 'daily', time: '09:00', days: WEEKDAYS }, mode: 'chat', model: null, cwd: null, allowChanges: false, enabled: true, createdAt: 1, updatedAt: 1, nextRunAt: 'tomorrow', lastRunAt: null, lastStatus: null }
  const h = harness(now, {
    tasks: [
      good,
      { ...good, name: 'Duplicate id' },
      { ...good, id: 'b', schedule: { kind: 'interval', every: 0, unit: 'minutes' } },
      { ...good, id: 'c', schedule: { kind: 'cron', expr: '0 9 * * 1' } },
      'not a task',
      { name: 'no id' }
    ]
  })
  h.engine.load()
  const tasks = h.engine.list()
  assert.equal(tasks.length, 3)
  assert.equal(tasks[0].nextRunAt, ny('2026-10-05T09:00:00-04:00'), 'a next run that was not a time is worked out again')
  assert.notEqual(tasks[1].id, 'a', 'the second task with one id keeps its place under a new id')
  assert.equal(tasks[1].name, 'Duplicate id')
  assert.equal(tasks[2].enabled, false, 'an interval of 0 cannot run; paused, not deleted')
  assert.deepEqual(h.damaged, [2])
  const kinds = (h.saved.tasks as { schedule: { kind: string } }[]).map((t) => t.schedule.kind)
  assert.deepEqual(kinds, ['daily', 'daily', 'interval', 'cron'], 'a newer Eaon’s task is written back as it was')
})

test('upgrading from 2026.6.x: runs saved inside tasks move to their own file, backed up first, and come back after a downgrade', () => {
  rmSync(join(app.getPath('userData'), 'store'), { recursive: true, force: true })
  resetStoreHealthForTests()
  const start = ny('2026-10-01T09:00:00-04:00')
  const oldShape = {
    id: 'legacy',
    name: 'Morning digest',
    prompt: 'Summarise my GitHub notifications.',
    schedule: { kind: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] },
    mode: 'chat',
    model: { providerId: 'openai', modelId: 'gpt-5' },
    cwd: null,
    allowChanges: false,
    enabled: true,
    createdAt: start - 10 * DAY,
    updatedAt: start - 10 * DAY,
    nextRunAt: start + DAY,
    lastRunAt: start,
    lastStatus: 'succeeded',
    history: [
      { id: 'r2', startedAt: start, finishedAt: start + MIN, status: 'succeeded', chatId: 'c2', trigger: 'schedule', summary: 'All quiet.' },
      { id: 'r1', startedAt: start - DAY, finishedAt: start - DAY, status: 'missed', chatId: null, trigger: 'schedule', error: 'Eaon was closed…' }
    ]
  }
  store.setJson(TASKS_FILE, [oldShape])
  migrateScheduledRuns()
  const tasks = store.getJson<Record<string, unknown>[]>(TASKS_FILE, [])
  assert.equal('history' in tasks[0], false)
  assert.deepEqual(
    store.getJson<TaskRun[]>(RUNS_FILE, []).map((r) => [r.id, r.taskId]),
    [
      ['r2', 'legacy'],
      ['r1', 'legacy']
    ]
  )
  // 2026.6.1 again adds a run inside the task; the next load folds it in once.
  store.setJson(TASKS_FILE, [{ ...tasks[0], history: [{ id: 'r3', startedAt: start + DAY, finishedAt: start + DAY, status: 'succeeded', chatId: 'c3', trigger: 'schedule' }, oldShape.history[0]] }])
  const h = harness(start + DAY + HOUR, { tasks: store.getJson(TASKS_FILE, []), runs: store.getJson(RUNS_FILE, []) })
  h.engine.load()
  assert.deepEqual(
    only(h).history.map((r) => r.id),
    ['r3', 'r2', 'r1']
  )
  assert.equal(storeHealth().problems.length, 0)
})

test('the migration runner backs the scheduler files up before moving runs', async () => {
  const { runMigrations, MIGRATIONS } = await import('../src/main/migrations')
  rmSync(join(app.getPath('userData'), 'store'), { recursive: true, force: true })
  store.setJson(TASKS_FILE, [{ id: 'x', name: 'X', prompt: 'p', schedule: { kind: 'daily', time: '09:00', days: [1] }, enabled: false, history: [{ id: 'r', startedAt: 1, finishedAt: 1, status: 'succeeded', chatId: null, trigger: 'manual' }] }])
  runMigrations(MIGRATIONS, 'test')
  const backups = readdirSync(join(app.getPath('userData'), 'store', 'backups'))
  const folder = backups.find((b) => b.startsWith('before-scheduled-runs-'))
  assert.ok(folder)
  assert.ok(existsSync(join(app.getPath('userData'), 'store', 'backups', folder!, TASKS_FILE)))
  assert.equal(store.getJson<TaskRun[]>(RUNS_FILE, []).length, 1)
})
