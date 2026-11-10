import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Notification } from 'electron'
import { WEEKDAYS, type ScheduledTask, type TaskRun } from '@shared/scheduler'
import { buildScheduleRows, everyText } from '@shared/schedules'
import type { Worker } from '@shared/workers'
import { store } from '../src/main/store'
import { createWorkersService, type WorkersService } from '../src/main/features/workers/service'
import type { RunAgent } from '../src/main/features/workers/runner'
import type { FeatureContext } from '../src/main/features/types'

/**
 * Every schedule in one list (Scheduled → All schedules): automations, worker
 * routines and the wake-ups a worker set for itself, each with when it runs
 * next, how its last run went, and a way to pause it; and the engine side of
 * pausing a routine, which must never run while paused and must not catch up
 * on resume.
 */

const MIN = 60_000
const HOUR = 60 * MIN
const NOW = Date.UTC(2026, 10, 3, 12, 0)

function task(extra: Partial<ScheduledTask> & { id: string; name: string }): ScheduledTask {
  return {
    prompt: 'Do it',
    schedule: { kind: 'daily', time: '09:00', days: WEEKDAYS },
    mode: 'chat',
    model: null,
    cwd: null,
    allowChanges: false,
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    nextRunAt: NOW + 2 * HOUR,
    lastRunAt: null,
    lastStatus: null,
    history: [],
    zone: 'UTC',
    ...extra
  }
}

const run = (extra: Partial<TaskRun>): TaskRun => ({ id: 'r', startedAt: NOW - HOUR, finishedAt: NOW - HOUR + MIN, status: 'succeeded', chatId: null, trigger: 'schedule', ...extra })

function worker(extra: Partial<Worker> & { id: string; name: string }): Worker {
  return {
    color: '#3E86C6',
    paused: false,
    heartbeat: { nextAt: null, everyMs: null, note: '' },
    routines: [],
    threads: [],
    ...extra
  } as unknown as Worker
}

const routine = (extra: Record<string, unknown>) => ({ id: 'rt', name: 'Morning brief', task: 'Brief me', everyMs: null, daily: null, nextAt: NOW + HOUR, runs: [], ...extra })

test('automations are listed with when they run next, how the last run went, and whether they are paused', () => {
  const rows = buildScheduleRows(
    [
      task({ id: 'a', name: 'Digest', history: [run({ summary: 'Three new notifications.\nSecond line.' })] }),
      task({ id: 'b', name: 'Paused one', enabled: false, nextRunAt: null, history: [run({ status: 'failed', error: 'No model is available.', summary: undefined })] }),
      task({ id: 'c', name: 'One-off', schedule: { kind: 'once', at: NOW - HOUR }, enabled: false, nextRunAt: null, lastRunAt: NOW - HOUR, history: [run({})] }),
      task({ id: 'd', name: 'Busy', history: [run({ status: 'running', finishedAt: null, startedAt: NOW - 5 * MIN })] })
    ],
    [],
    NOW
  )
  const by = (name: string) => rows.find((r) => r.name === name)!
  assert.deepEqual(by('Digest').last, { status: 'succeeded', at: NOW - HOUR + MIN, detail: 'Three new notifications.' })
  assert.deepEqual([by('Digest').nextAt, by('Digest').paused, by('Digest').control], [NOW + 2 * HOUR, false, 'pause'])
  assert.deepEqual([by('Paused one').nextAt, by('Paused one').nextNote, by('Paused one').paused], [null, 'Paused', true])
  assert.deepEqual(by('Paused one').last, { status: 'failed', at: NOW - HOUR + MIN, detail: 'No model is available.' })
  assert.deepEqual([by('One-off').nextAt, by('One-off').nextNote, by('One-off').paused], [null, 'Done', false], 'a used-up one-off is done, not paused')
  assert.equal(by('Busy').last?.status, 'running')
  assert.equal(by('Busy').last?.at, NOW - 5 * MIN, 'a run in progress shows when it started')
  assert.equal(by('Digest').cadence, 'Every day at 9:00 AM')
  assert.equal(by('Digest').automationId, 'a')
})

test('worker routines and wake-ups sit in the same list, owned by their worker', () => {
  const rows = buildScheduleRows(
    [],
    [
      worker({
        id: 'w1',
        name: 'Nova',
        heartbeat: { nextAt: NOW + 10 * MIN, everyMs: 10 * MIN, note: 'Check the training run' },
        routines: [
          routine({ id: 'r1', name: 'Morning brief', daily: '08:30', nextAt: NOW + 20 * HOUR, runs: [{ at: NOW - 4 * HOUR, ok: true }] }),
          routine({ id: 'r2', name: 'Inbox sweep', everyMs: 30 * MIN, nextAt: NOW + 5 * MIN, runs: [{ at: NOW - HOUR, ok: true }, { at: NOW - 30 * MIN, ok: false }] }),
          routine({ id: 'r3', name: 'Trading check', everyMs: 15 * MIN, marketHours: true, nextAt: NOW + HOUR }),
          routine({ id: 'r4', name: 'Coffee', everyMs: 7 * 24 * HOUR, purchase: { item: 'Coffee', site: 'example.com' }, nextAt: NOW + 24 * HOUR }),
          routine({ id: 'r5', name: 'Track order 17', everyMs: 12 * HOUR, watch: { orderId: '17' } }),
          routine({ id: 'r6', name: 'Once only', nextAt: NOW + HOUR }),
          routine({ id: 'r7', name: 'On hold', everyMs: HOUR, paused: true, nextAt: NOW - 3 * HOUR })
        ],
        threads: [{ id: 't1', title: 'Fix the build', heartbeat: { nextAt: NOW + 2 * HOUR, everyMs: null, note: '' } }, { id: 't2', title: 'Idle', heartbeat: { nextAt: null, everyMs: null, note: '' } }]
      } as never)
    ],
    NOW
  )
  const by = (name: string) => rows.find((r) => r.name === name)!
  assert.equal(rows.some((r) => r.name === 'Track order 17'), false, 'following an order isn’t a schedule the user made')
  assert.equal(rows.length, 8)
  assert.deepEqual([by('Morning brief').cadence, by('Morning brief').worker?.name, by('Morning brief').control], ['Daily at 08:30', 'Nova', 'pause'])
  assert.deepEqual(by('Morning brief').last, { status: 'succeeded', at: NOW - 4 * HOUR })
  assert.deepEqual(by('Inbox sweep').last, { status: 'failed', at: NOW - 30 * MIN }, 'the latest run is the last result')
  assert.equal(by('Inbox sweep').cadence, 'Every 30 min')
  assert.equal(by('Trading check').cadence, 'Every 15 min while the market is open')
  assert.deepEqual([by('Coffee').control, by('Coffee').controlNote], [null, 'A purchase schedule: change or stop it on Nova’s page'])
  assert.deepEqual([by('Once only').control, by('Once only').cadence], [null, 'Once'])
  assert.deepEqual([by('On hold').paused, by('On hold').nextAt, by('On hold').nextNote], [true, null, 'Paused'])
  assert.deepEqual([by('Check the training run').kind, by('Check the training run').control, by('Check the training run').cadence], ['wakeup', 'stop', 'Wakes itself every 10 min'])
  const side = by('Check in on “Fix the build”')
  assert.deepEqual([side.threadId, side.cadence, side.nextAt], ['t1', 'Wakes itself once', NOW + 2 * HOUR])
  assert.equal(rows.filter((r) => r.kind === 'wakeup').length, 2, 'a thread with no wake-up has no row')
})

test('a paused worker holds its schedules, and they say why', () => {
  const rows = buildScheduleRows([], [worker({ id: 'w1', name: 'Nova', paused: true, heartbeat: { nextAt: NOW + MIN, everyMs: null, note: 'Look again' }, routines: [routine({ id: 'r1', name: 'Brief', everyMs: HOUR })] } as never)], NOW)
  assert.deepEqual(rows.map((r) => [r.name, r.nextAt, r.nextNote, r.paused]), [
    ['Brief', null, 'Nova is paused', false],
    ['Look again', null, 'Nova is paused', false]
  ])
})

test('soonest first, with what isn’t scheduled after it', () => {
  const rows = buildScheduleRows(
    [task({ id: 'a', name: 'Later', nextRunAt: NOW + 5 * HOUR }), task({ id: 'b', name: 'Off', enabled: false, nextRunAt: null }), task({ id: 'c', name: 'Soon', nextRunAt: NOW + MIN })],
    [worker({ id: 'w', name: 'Nova', routines: [routine({ id: 'r', name: 'Middle', everyMs: HOUR, nextAt: NOW + 2 * HOUR })] } as never)],
    NOW
  )
  assert.deepEqual(rows.map((r) => r.name), ['Soon', 'Middle', 'Later', 'Off'])
  assert.equal(everyText(90 * MIN), '90 min')
  assert.equal(everyText(2 * HOUR), '2 hr')
  assert.equal(everyText(24 * HOUR), '1 day')
  assert.equal(everyText(48 * HOUR), '2 days')
  assert.equal(everyText(30_000), '1 min')
})

/* -------------------------------------------------------- pausing a routine */

let service: WorkersService | null = null

beforeEach(() => {
  store.setJson('workers.json', [])
  store.patchSettings({ work: { ...store.getSettings().work, defaultFolder: mkdtempSync(join(tmpdir(), 'eaon-allsched-')) } })
  Notification.supported = false
})

afterEach(async () => {
  service?.stop()
  await service?.engine.whenIdle()
  service = null
  await store.flushWrites()
})

function boot() {
  let clock = new Date(2026, 9, 5, 7, 0).getTime()
  const ran: string[] = []
  const runAgent: RunAgent = async (request) => {
    ran.push(request.history[request.history.length - 1].parts.map((p) => (p.type === 'text' ? p.text : '')).join(''))
    return { text: 'ok', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }
  }
  const ctx = { ipcMain: { handle: () => {} }, getWindow: () => null, send: () => {}, emitStream: () => {} } as unknown as FeatureContext
  service = createWorkersService(ctx, { runAgent, now: () => clock, startDelayMs: 60_000 })
  service.start()
  service.engine.start()
  const { engine } = service
  const nova = engine.save({ name: 'Nova', color: '#3E86C6', personality: '', purpose: 'x', model: { providerId: 'ollama', modelId: 'fake-model' } })
  return { engine, nova, ran, advance: (ms: number) => (clock += ms), now: () => clock }
}

test('a paused routine never runs, and resuming carries on from the next slot instead of catching up', async () => {
  const { engine, nova, ran, advance, now } = boot()
  engine.addRoutine(nova.id, { name: 'Check', task: 'Look at the queue', everyMinutes: 10 })
  const id = engine.list()[0].routines[0].id

  engine.setRoutinePaused(nova.id, id, true)
  assert.equal(engine.list()[0].routines[0].paused, true)
  advance(3 * HOUR)
  engine.tick()
  await engine.whenIdle()
  assert.equal(ran.length, 0, 'three hours of due slots, none run while it is paused')
  assert.equal(engine.executions(nova.id).length, 0, 'and no receipts of skipped or missed runs pile up')

  const resumedAt = now()
  const resumed = engine.setRoutinePaused(nova.id, id, false)
  assert.equal(resumed.paused, undefined)
  assert.equal(resumed.nextAt, resumedAt + 10 * MIN, 'the next slot after now, not a burst of the ones missed')
  engine.tick()
  await engine.whenIdle()
  assert.equal(ran.length, 0, 'resuming does not run it at once')
  advance(11 * MIN)
  engine.tick()
  await until(() => ran.length === 1)
  await engine.whenIdle()
  assert.match(ran[0], /Look at the queue/)
  assert.equal(ran.length, 1)
})

test('pausing survives a restart, and a worker re-adding the routine can’t unpause it', () => {
  const { engine, nova, advance } = boot()
  engine.addRoutine(nova.id, { name: 'Check', task: 'v1', everyMinutes: 10 })
  const id = engine.list()[0].routines[0].id
  engine.setRoutinePaused(nova.id, id, true)
  advance(HOUR)
  engine.addRoutine(nova.id, { name: 'check', task: 'v2', everyMinutes: 20 })
  assert.equal(engine.list()[0].routines[0].paused, true, 'the user’s pause is the user’s: the worker can edit the routine, not resume it')
  assert.equal(engine.list()[0].routines[0].task, 'v2')

  engine.reload()
  assert.equal(engine.list()[0].routines[0].paused, true)
  assert.throws(() => engine.runRoutineNow(nova.id, id), /paused/)
  assert.doesNotThrow(() => engine.setRoutinePaused(nova.id, id, false))
  assert.doesNotThrow(() => engine.setRoutinePaused(nova.id, id, false), 'resuming twice is harmless')
})

test('a purchase schedule, an order’s tracking and a routine that runs once can’t be paused, only the repeating ones', () => {
  const { engine, nova, now } = boot()
  engine.putRoutine(nova.id, {
    name: 'Coffee',
    task: 'Buy coffee',
    everyMs: 7 * 24 * HOUR,
    daily: null,
    nextAt: now() + 24 * HOUR,
    purchase: { item: 'Coffee', site: 'example.com', merchant: 'Example', maxAmount: 20, currency: 'USD', notes: '', orders: null, track: false }
  })
  const buy = engine.list()[0].routines[0]
  assert.throws(() => engine.setRoutinePaused(nova.id, buy.id, true), /edit(ing)? or stopping it on the worker’s page/)
  assert.throws(() => engine.setRoutinePaused(nova.id, 'nope', true), /isn’t there any more/)
  engine.putRoutine(nova.id, { name: 'Once', task: 'Only once', everyMs: null, daily: null, nextAt: now() + HOUR })
  const once = engine.list()[0].routines.find((r) => r.name === 'Once')!
  assert.throws(() => engine.setRoutinePaused(nova.id, once.id, true), /runs once/)
})

test('cancelling a wake-up the worker set for itself clears it, in the main thread or a side thread', () => {
  const { engine, nova } = boot()
  engine.setHeartbeat(nova.id, { inMinutes: 30, note: 'Look again' })
  const thread = engine.createThread(nova.id, { title: 'Build', kind: 'task' })
  engine.setHeartbeat(nova.id, { everyMinutes: 15, note: 'Watch the build' }, thread.id)
  assert.equal(buildScheduleRows([], engine.list(), Date.now()).filter((r) => r.kind === 'wakeup').length, 2)
  engine.stopWakeup(nova.id, thread.id)
  assert.equal(engine.list()[0].threads[0].heartbeat.nextAt, null)
  assert.notEqual(engine.list()[0].heartbeat.nextAt, null, 'the other one is untouched')
  engine.stopWakeup(nova.id)
  assert.equal(engine.list()[0].heartbeat.nextAt, null)
  assert.throws(() => engine.stopWakeup(nova.id, 'gone'), /no longer exists/)
})

async function until(check: () => boolean, timeout = 5000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
