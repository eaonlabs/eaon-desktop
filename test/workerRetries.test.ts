import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Notification } from 'electron'
import '../src/main/agent/sources'
import type { RunOptions, RunOutcome } from '../src/main/agent/loop'
import { store } from '../src/main/store'
import { createWorkersService, type WorkersOverrides, type WorkersService } from '../src/main/features/workers/service'
import type { RunAgent } from '../src/main/features/workers/runner'
import { SchedulerEngine, type RunHandle, type RunResult } from '../src/main/features/scheduler/engine'
import type { FeatureContext } from '../src/main/features/types'
import { WEEKDAYS, type ScheduledTask, type TaskDraft, type TaskRun } from '@shared/scheduler'
import type { WorkerDraft } from '@shared/workers'
import type { StreamEvent, StreamRequest } from '@shared/types'

/**
 * Automatic retries: a worker's run or an automation's that fails for a
 * passing reason is tried again after a wait that doubles, a bounded number
 * of times, with every attempt in the run history. Never a run that may
 * already have acted, and never an error waiting won't fix.
 */

const WORKERS = 'workers.json'
const MODEL = { providerId: 'ollama', modelId: 'fake-model' }
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }
const BUSY = 'Anthropic is having problems right now (503). Try again in a few minutes.'
const SIGNED_OUT = 'Your OpenAI session expired. Sign in again.'

let service: WorkersService | null = null
let engineUnderTest: SchedulerEngine | null = null

beforeEach(() => {
  store.setJson(WORKERS, [])
  const root = mkdtempSync(join(tmpdir(), 'eaon-workers-retry-'))
  const settings = store.getSettings()
  store.patchSettings({ work: { ...settings.work, defaultFolder: root } })
  Notification.supported = true
  Notification.shown.length = 0
})

afterEach(async () => {
  service?.stop()
  await service?.engine.whenIdle()
  service = null
  engineUnderTest?.stop()
  engineUnderTest = null
  await store.flushWrites()
})

async function until(check: () => boolean, timeout = 5000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
const settle = (ms = 60): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function fakeContext() {
  const window = { isFocused: () => false, isDestroyed: () => false, isMinimized: () => false, show() {}, focus() {}, restore() {}, webContents: { isLoading: () => false, once() {} } }
  return { ipcMain: { handle: () => {} }, getWindow: () => window, send: () => {}, emitStream: () => {} } as unknown as FeatureContext
}

/** Each run answers with the next outcome in `script` (the last one repeats): an error text, or null for a good reply. */
function scripted(script: (string | null)[], mutate = false) {
  const requests: StreamRequest[] = []
  const runAgent: RunAgent = async (request, emit: (event: StreamEvent) => void, options: RunOptions): Promise<RunOutcome> => {
    requests.push(structuredClone(request))
    const next = script[Math.min(requests.length - 1, script.length - 1)]
    if (mutate) options.onToolRun?.('write_file', true)
    if (next === null) {
      emit({ type: 'delta', messageId: request.messageId, text: 'All done.' })
      emit({ type: 'done', messageId: request.messageId })
      return { text: 'All done.', usage }
    }
    return { text: '', error: next, usage }
  }
  return { runAgent, requests }
}

function start(runAgent: RunAgent, overrides: WorkersOverrides = {}) {
  service = createWorkersService(fakeContext(), { runAgent, startDelayMs: 60_000, ...overrides })
  service.start()
  service.engine.start()
  return service.engine
}

const draft = (name: string, extra: Partial<WorkerDraft> = {}): WorkerDraft => ({ name, color: '#3E86C6', personality: 'Calm.', purpose: `${name}'s job`, model: MODEL, ...extra })
const MIN = 60_000

test('a run that fails for a passing reason is retried after a wait that doubles, then given up on', async () => {
  let clock = Date.parse('2026-10-15T10:00:00Z')
  const agent = scripted([BUSY])
  const engine = start(agent.runAgent, { now: () => clock })
  const nova = engine.save(draft('Nova', { retry: { attempts: 2, minutes: 1 } }))
  engine.send(nova.id, 'Check the build')
  await until(() => agent.requests.length === 1)
  await engine.whenIdle()

  let runs = engine.executions(nova.id)
  assert.equal(runs.length, 1)
  assert.equal(runs[0].state, 'failed')
  assert.equal(runs[0].error, BUSY)
  assert.equal(runs[0].reason, 'Hit a passing error. Retry 1 of 2 in 1 min.')
  assert.match(engine.list()[0].activity, /trying again/)
  assert.equal(engine.list()[0].status, 'idle', 'it is waiting on a retry, not dead')
  assert.equal(Notification.shown.length, 0, 'a failure that will be retried is not news yet')

  clock += 30_000
  engine.tick()
  await settle()
  assert.equal(agent.requests.length, 1, 'not before its time')

  clock += 31_000
  engine.tick()
  await until(() => agent.requests.length === 2)
  await engine.whenIdle()
  runs = engine.executions(nova.id)
  assert.equal(runs.length, 2)
  assert.equal(runs[1].trigger.kind, 'retry')
  assert.equal(runs[1].trigger.label, 'Retry 1 of 2: Your message')
  assert.equal(runs[1].attempt, 1)
  assert.equal(runs[1].retryOf, runs[0].id)
  assert.equal(runs[1].reason, 'Hit a passing error. Retry 2 of 2 in 2 min.', 'the wait doubles')
  const told = agent.requests[1].history.at(-1)!.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')
  assert.match(told, /\[Retry\] Eaon is retrying an earlier run on its own/)
  assert.match(told, /Anthropic is having problems/)

  clock += 2 * MIN + 1000
  engine.tick()
  await until(() => agent.requests.length === 3)
  await engine.whenIdle()
  runs = engine.executions(nova.id)
  assert.equal(runs.length, 3)
  assert.equal(runs[2].trigger.label, 'Retry 2 of 2: Your message', 'a retry of a retry names the first run, not the last')
  assert.equal(runs[2].attempt, 2)
  assert.equal(runs[2].reason, 'Gave up after 2 retries.')
  assert.equal(engine.list()[0].status, 'failed')

  assert.equal(Notification.shown.length, 1, 'only the last attempt’s outcome is announced')
  assert.equal(Notification.shown[0].options.title, 'Nova hit a problem')
  clock += 3_600_000
  engine.tick()
  await settle()
  assert.equal(agent.requests.length, 3, 'bounded')
})

test('a retry that works ends the story well, and says so once', async () => {
  let clock = Date.parse('2026-10-15T10:00:00Z')
  const agent = scripted([BUSY, null])
  const engine = start(agent.runAgent, { now: () => clock })
  const nova = engine.save(draft('Nova', { retry: { attempts: 3, minutes: 2 } }))
  engine.send(nova.id, 'Check the build')
  await until(() => agent.requests.length === 1)
  await engine.whenIdle()
  clock += 2 * MIN + 1000
  engine.tick()
  await until(() => agent.requests.length === 2)
  await engine.whenIdle()
  const runs = engine.executions(nova.id)
  assert.deepEqual(runs.map((r) => r.state), ['failed', 'completed'])
  assert.equal(runs[1].attempt, 1)
  assert.equal(engine.list()[0].status, 'asleep')
  assert.equal(engine.list()[0].lastOutcome?.ok, true)
  assert.equal(Notification.shown.length, 1)
  assert.equal(Notification.shown[0].options.title, 'Nova')
})

test('a worker with no retry setting, or an error waiting won’t fix, runs once', async () => {
  let clock = Date.parse('2026-10-15T10:00:00Z')
  const plain = scripted([BUSY])
  const engine = start(plain.runAgent, { now: () => clock })
  const ada = engine.save(draft('Ada'))
  engine.send(ada.id, 'Go')
  await until(() => plain.requests.length === 1)
  await engine.whenIdle()
  clock += 3_600_000
  engine.tick()
  await settle()
  assert.equal(plain.requests.length, 1)
  assert.equal(engine.executions(ada.id)[0].reason, null)
  assert.equal(engine.list()[0].status, 'failed')

  service?.stop()
  await service?.engine.whenIdle()
  const signedOut = scripted([SIGNED_OUT])
  const again = start(signedOut.runAgent, { now: () => clock })
  const bea = again.save(draft('Bea', { retry: { attempts: 3, minutes: 1 } }))
  again.send(bea.id, 'Go')
  await until(() => signedOut.requests.length === 1)
  await again.whenIdle()
  clock += 3_600_000
  again.tick()
  await settle()
  assert.equal(signedOut.requests.length, 1, 'a sign-in that ran out is not fixed by waiting')
  assert.equal(again.executions(bea.id)[0].reason, null)
})

test('a run that may already have changed things is never retried on its own', async () => {
  let clock = Date.parse('2026-10-15T10:00:00Z')
  const agent = scripted([BUSY], true)
  const engine = start(agent.runAgent, { now: () => clock })
  const nova = engine.save(draft('Nova', { retry: { attempts: 3, minutes: 1 } }))
  engine.send(nova.id, 'Go')
  await until(() => agent.requests.length === 1)
  await engine.whenIdle()
  const run = engine.executions(nova.id)[0]
  assert.equal(run.sideEffects, true)
  assert.equal(run.reason, 'It may already have changed things, so it wasn’t retried on its own.')
  clock += 3_600_000
  engine.tick()
  await settle()
  assert.equal(agent.requests.length, 1)
  assert.equal(Notification.shown.length, 1, 'the failure is announced at once, since nothing will fix it')
})

test('pausing the worker takes the place of a retry that is waiting', async () => {
  let clock = Date.parse('2026-10-15T10:00:00Z')
  const agent = scripted([BUSY, null])
  const engine = start(agent.runAgent, { now: () => clock })
  const nova = engine.save(draft('Nova', { retry: { attempts: 2, minutes: 1 } }))
  engine.send(nova.id, 'Go')
  await until(() => agent.requests.length === 1)
  await engine.whenIdle()
  engine.setPaused(nova.id, true)
  assert.equal(engine.executions(nova.id)[0].reason, 'Not retried. Nova was paused.', 'its failed receipt says what became of the retry')
  engine.setPaused(nova.id, false)
  clock += 5 * MIN
  engine.tick()
  await settle()
  assert.equal(agent.requests.length, 1, 'a paused-and-resumed worker does not go back to an old failure')
})

test('writing to the worker takes the place of a retry that is waiting', async () => {
  let clock = Date.parse('2026-10-15T10:00:00Z')
  const agent = scripted([BUSY, null])
  const engine = start(agent.runAgent, { now: () => clock })
  const nova = engine.save(draft('Nova', { retry: { attempts: 2, minutes: 5 } }))
  engine.send(nova.id, 'Go')
  await until(() => agent.requests.length === 1)
  await engine.whenIdle()
  engine.send(nova.id, 'Try this instead')
  await until(() => agent.requests.length === 2)
  await engine.whenIdle()
  assert.equal(engine.executions(nova.id)[1].state, 'completed')
  clock += 10 * MIN
  engine.tick()
  await settle()
  assert.equal(agent.requests.length, 2, 'no stale retry runs on top of the new message')
})

test('an automation’s run that fails for a passing reason is retried, with each attempt in its history', async () => {
  let clock = Date.parse('2026-10-15T10:00:00Z')
  const results: RunResult[] = [
    { status: 'failed', chatId: null, error: BUSY },
    { status: 'failed', chatId: null, error: BUSY },
    { status: 'succeeded', chatId: null, summary: 'Digest ready.' }
  ]
  const calls: { trigger: string }[] = []
  let saved: unknown[] = []
  let savedRuns: TaskRun[] = []
  const engine = new SchedulerEngine({
    load: () => saved,
    save: (tasks) => (saved = tasks),
    loadRuns: () => savedRuns,
    saveRuns: (runs) => (savedRuns = structuredClone(runs)),
    execute: async (_task: ScheduledTask, handle: RunHandle) => {
      calls.push({ trigger: handle.trigger })
      return results[Math.min(calls.length - 1, results.length - 1)]
    },
    now: () => clock
  })
  engineUnderTest = engine
  engine.load()
  engine.start()
  const input: TaskDraft = {
    name: 'Digest',
    prompt: 'Summarise.',
    schedule: { kind: 'daily', time: '10:30', days: WEEKDAYS },
    mode: 'chat',
    model: MODEL,
    cwd: null,
    allowChanges: false,
    enabled: true,
    retries: { attempts: 2, minutes: 5 }
  }
  const task = engine.save(input)
  assert.deepEqual(task.retries, { attempts: 2, minutes: 5 })

  engine.runNow(task.id)
  await engine.whenIdle()
  let history = engine.list()[0].history
  assert.equal(history.length, 1)
  assert.equal(history[0].status, 'failed')
  assert.equal(history[0].retryAt, clock + 5 * MIN)
  assert.match(history[0].retryNote ?? '', /^Hit a passing error; retry 1 of 2 at /)

  clock += 4 * MIN
  engine.tick()
  await engine.whenIdle()
  assert.equal(calls.length, 1, 'not before its time')

  clock += 2 * MIN
  engine.tick()
  await engine.whenIdle()
  history = engine.list()[0].history
  assert.equal(calls.length, 2)
  const first = history.find((r) => r.attempt === undefined)!
  const second = history.find((r) => r.attempt === 1)!
  assert.equal(second.trigger, 'retry')
  assert.equal(second.retryOf, first.id)
  assert.equal(second.attempts, 2)
  assert.equal(first.retryAt, undefined, 'a retry made is no longer waiting')
  assert.equal(second.retryAt, clock + 10 * MIN, 'the wait doubles')

  clock += 11 * MIN
  engine.tick()
  await engine.whenIdle()
  history = engine.list()[0].history
  assert.equal(calls.length, 3)
  const third = history.find((r) => r.attempt === 2)!
  assert.equal(third.status, 'succeeded')
  assert.equal(engine.list()[0].lastStatus, 'succeeded')
  assert.deepEqual(history.map((r) => r.attempt ?? 0).sort(), [0, 1, 2])
})

test('an automation’s retry is dropped when a later run took its place, and never repeats work that acted', async () => {
  let clock = Date.parse('2026-10-15T10:00:00Z')
  let n = 0
  const engine = new SchedulerEngine({
    load: () => [],
    save: () => {},
    execute: async () => {
      n++
      return n === 1 ? { status: 'failed', chatId: null, error: BUSY } : { status: 'succeeded', chatId: null }
    },
    now: () => clock
  })
  engineUnderTest = engine
  engine.load()
  engine.start()
  const task = engine.save({ name: 'Digest', prompt: 'Go.', schedule: { kind: 'daily', time: '10:30', days: WEEKDAYS }, mode: 'chat', model: MODEL, cwd: null, allowChanges: false, enabled: true, retries: { attempts: 2, minutes: 5 } })
  engine.runNow(task.id)
  await engine.whenIdle()
  clock += MIN
  engine.runNow(task.id)
  await engine.whenIdle()
  clock += 10 * MIN
  engine.tick()
  await engine.whenIdle()
  assert.equal(n, 2, 'the manual run that came after took the retry’s place')
  const failed = engine.list()[0].history.find((r) => r.status === 'failed')!
  assert.equal(failed.retryAt, undefined)
  assert.equal(failed.retryNote, 'Not retried: a later run took its place.')

  const acted = new SchedulerEngine({
    load: () => [],
    save: () => {},
    execute: async () => ({ status: 'failed', chatId: null, error: BUSY, sideEffects: true }),
    now: () => clock
  })
  engineUnderTest?.stop()
  engineUnderTest = acted
  acted.load()
  acted.start()
  const edit = acted.save({ name: 'Edit', prompt: 'Go.', schedule: { kind: 'daily', time: '10:30', days: WEEKDAYS }, mode: 'work', model: MODEL, cwd: '/tmp', allowChanges: true, enabled: true, retries: { attempts: 2, minutes: 1 } })
  acted.runNow(edit.id)
  await acted.whenIdle()
  const run = acted.list()[0].history[0]
  assert.equal(run.retryAt, undefined)
  assert.equal(run.retryNote, 'It may have changed things before it failed, so it wasn’t retried on its own.')
})
