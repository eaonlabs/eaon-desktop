import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Notification } from 'electron'
import type { RunOptions, RunOutcome } from '../src/main/agent/loop'
import { store } from '../src/main/store'
import { createWorkersService, type WorkersOverrides, type WorkersService } from '../src/main/features/workers/service'
import { engineApproval, type RunAgent, type RunEngineTurn } from '../src/main/features/workers/runner'
import type { FeatureContext } from '../src/main/features/types'
import type { EngineTurnInput } from '../src/main/engines/types'
import {
  MAIN_THREAD,
  MAX_DELEGATION_DEPTH,
  STALE_WAKEUPS,
  describeWorker,
  type Worker,
  type WorkerDraft,
  type WorkerExecution
} from '@shared/workers'
import type { StreamEvent, StreamRequest } from '@shared/types'

/**
 * Workers are independent agents, not one queue of turns: each worker — and
 * each thread a worker has — runs, waits, fails, stops and recovers on its
 * own. These tests pin the invariants the 2026.6.2 rebuild was for: runs at
 * the same time, stopping one leaves the rest, a provider failing for one
 * leaves the others, a crash resumes what is safe to resume and never
 * replays what may already have acted, waking from sleep runs a routine once,
 * queued work says so, and delegation is a tracked job that can't loop.
 */

const WORKERS = 'workers.json'
const MODEL = { providerId: 'ollama', modelId: 'fake-model' }
const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }

let service: WorkersService | null = null
let root = ''

beforeEach(() => {
  store.setJson(WORKERS, [])
  store.setJson('worker-delegations.json', [])
  root = mkdtempSync(join(tmpdir(), 'eaon-workers-ind-'))
  const settings = store.getSettings()
  store.patchSettings({ work: { ...settings.work, defaultFolder: root } })
  Notification.supported = false
  Notification.shown.length = 0
})

afterEach(async () => {
  service?.stop()
  await service?.engine.whenIdle()
  service = null
  await store.flushWrites()
})

async function until(check: () => boolean, timeout = 5000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const settle = (ms = 40): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function fakeContext() {
  const sent: { channel: string; payload: unknown }[] = []
  const window = {
    isFocused: () => false,
    isVisible: () => true,
    isDestroyed: () => false,
    isMinimized: () => false,
    show() {},
    focus() {},
    restore() {},
    webContents: { isLoading: () => false, once() {} }
  }
  const ctx = {
    ipcMain: { handle: () => {} },
    getWindow: () => window,
    send: (channel: string, ...args: unknown[]) => sent.push({ channel, payload: structuredClone(args[0]) }),
    emitStream: () => {}
  } as unknown as FeatureContext
  return { ctx, sent }
}

/** Who a request is from, by its persona ("You are Nova, …"). */
const nameOf = (request: StreamRequest): string => /You are ([^,]+),/.exec(request.persona ?? '')?.[1] ?? '?'
const lastUserText = (request: StreamRequest): string => {
  const last = request.history.filter((m) => m.role === 'user').at(-1)
  return last ? last.parts.map((p) => (p.type === 'text' ? p.text : '')).join('') : ''
}

interface Pending {
  request: StreamRequest
  options: RunOptions
  emit: (event: StreamEvent) => void
  name: string
  release: (text?: string) => void
  fail: (error: string) => void
}

/**
 * A fake agent loop that holds every turn until the test releases it (or
 * fails it), and ends a turn as cancelled when its signal aborts — like the
 * real loop. `pending` lists the turns in flight.
 */
function heldAgent() {
  const pending: Pending[] = []
  const requests: StreamRequest[] = []
  const runAgent: RunAgent = (request, emit, options) =>
    new Promise<RunOutcome>((resolve) => {
      requests.push(structuredClone(request))
      emit({ type: 'delta', messageId: request.messageId, text: '…' })
      const done = (outcome: RunOutcome): void => {
        const index = pending.indexOf(entry)
        if (index !== -1) pending.splice(index, 1)
        emit({ type: 'done', messageId: request.messageId })
        resolve(outcome)
      }
      const entry: Pending = {
        request,
        options,
        emit,
        name: nameOf(request),
        release: (text = 'Done.') => {
          emit({ type: 'delta', messageId: request.messageId, text })
          emit({ type: 'usage', messageId: request.messageId, usage })
          done({ text, usage })
        },
        fail: (error) => done({ text: '', usage, error })
      }
      options.signal!.addEventListener('abort', () => done({ text: '', usage, cancelled: true }), { once: true })
      pending.push(entry)
    })
  const of = (name: string): Pending | undefined => pending.find((p) => p.name === name)
  return { runAgent, pending, requests, of }
}

function start(runAgent: RunAgent, overrides: WorkersOverrides = {}) {
  const { ctx, sent } = fakeContext()
  service = createWorkersService(ctx, { runAgent, startDelayMs: 60_000, ...overrides })
  service.start()
  service.engine.start()
  return { engine: service.engine, sent }
}

/** Quits the way before-quit does and starts a fresh service on the same saved files, as a relaunch would. */
async function relaunch(runAgent: RunAgent, overrides: WorkersOverrides = {}) {
  service?.stop()
  await service?.engine.whenIdle()
  await store.flushWrites()
  service = null
  return start(runAgent, overrides)
}

function draft(name: string, extra: Partial<WorkerDraft> = {}): WorkerDraft {
  return { name, color: '#3E86C6', personality: 'Calm.', purpose: `${name}'s job`, model: MODEL, ...extra }
}

const receipts = (engine: WorkersService['engine'], id: string): WorkerExecution[] => engine.executions(id)
const worker = (engine: WorkersService['engine'], id: string): Worker => engine.list().find((w) => w.id === id)!

test('two workers reason at the same time, and stopping one leaves the other running', async () => {
  const agent = heldAgent()
  const { engine } = start(agent.runAgent)
  const nova = engine.save(draft('Nova'))
  const vega = engine.save(draft('Vega'))
  engine.send(nova.id, 'Research the market')
  engine.send(vega.id, 'Fix the build')
  await until(() => agent.pending.length === 2)
  assert.deepEqual(agent.pending.map((p) => p.name).sort(), ['Nova', 'Vega'])

  engine.stopTurn(nova.id)
  await until(() => receipts(engine, nova.id).at(-1)?.state === 'cancelled')
  assert.ok(agent.of('Vega'), 'Vega is still working')
  assert.equal(worker(engine, vega.id).status, 'working')
  assert.equal(receipts(engine, nova.id).at(-1)!.state, 'cancelled')
  assert.equal(receipts(engine, nova.id).at(-1)!.reason, 'Stopped.')

  agent.of('Vega')!.release('Fixed.')
  await until(() => receipts(engine, vega.id).at(-1)?.state === 'completed')
  const done = receipts(engine, vega.id).at(-1)!
  assert.equal(done.trigger.kind, 'message')
  assert.deepEqual(done.usage, usage)
  assert.ok(done.startedAt !== null && done.endedAt !== null && done.endedAt >= done.startedAt)
})

test('a worker waiting on the user or on a colleague holds no slot', async () => {
  const agent = heldAgent()
  const { engine } = start(agent.runAgent, { concurrency: 1 })
  const nova = engine.save(draft('Nova'))
  const vega = engine.save(draft('Vega'))
  engine.send(nova.id, 'Plan the launch')
  await until(() => !!agent.of('Nova'))
  // Nova asks the user something and delegates a job, then its turn ends.
  engine.ask(nova.id, { question: 'Which date?' })
  await engine.handOff(nova.id, 'Vega', 'Draft the announcement', [], { requiredOutput: 'A draft' })
  agent.of('Nova')!.release('Asked and delegated.')
  // With a single slot, Vega's delegated job starts once Nova's turn is over:
  // waiting on an answer and on a colleague costs Nova nothing.
  await until(() => !!agent.of('Vega'))
  assert.equal(engine.isRunning(nova.id), false)
  assert.equal(worker(engine, nova.id).asks.length, 1)
  const delegation = engine.delegations()[0]
  assert.equal(delegation.state, 'running')
  assert.equal(delegation.recipient.workerId, vega.id)
})

test('the fifth run is queued with a reason, then runs on the same receipt', async () => {
  const agent = heldAgent()
  const { engine } = start(agent.runAgent, { concurrency: 1 })
  const nova = engine.save(draft('Nova'))
  const vega = engine.save(draft('Vega'))
  engine.send(nova.id, 'One')
  await until(() => !!agent.of('Nova'))
  engine.send(vega.id, 'Two')
  await settle()
  const waiting = worker(engine, vega.id)
  assert.match(waiting.queued ?? '', /already running/)
  assert.match(describeWorker(waiting), /^Queued — /)
  const queued = receipts(engine, vega.id).at(-1)!
  assert.equal(queued.state, 'queued')
  assert.match(queued.reason ?? '', /starts when one finishes/)

  agent.of('Nova')!.release()
  await until(() => !!agent.of('Vega'))
  const running = receipts(engine, vega.id)
  assert.equal(running.length, 1, 'the queued receipt became the running one')
  assert.equal(running[0].id, queued.id)
  assert.equal(running[0].state, 'running')
  assert.equal(worker(engine, vega.id).queued, null)
})

test('one provider failing fails only the worker using it', async () => {
  const agent = heldAgent()
  const { engine } = start(agent.runAgent)
  const nova = engine.save(draft('Nova'))
  const vega = engine.save(draft('Vega', { model: { providerId: 'lm-studio', modelId: 'other' } }))
  engine.send(nova.id, 'A')
  engine.send(vega.id, 'B')
  await until(() => agent.pending.length === 2)
  agent.of('Nova')!.fail('Ollama is not running')
  agent.of('Vega')!.release('All good.')
  await until(() => !engine.isRunning(nova.id) && !engine.isRunning(vega.id))
  assert.equal(worker(engine, nova.id).status, 'failed')
  assert.equal(worker(engine, vega.id).status !== 'failed', true)
  assert.equal(receipts(engine, nova.id).at(-1)!.state, 'failed')
  assert.equal(receipts(engine, vega.id).at(-1)!.state, 'completed')
})

test('changing Chat’s model or one worker’s model leaves pinned workers alone', async () => {
  const agent = heldAgent()
  const { engine } = start(agent.runAgent)
  const nova = engine.save(draft('Nova'))
  const vega = engine.save(draft('Vega', { model: { providerId: 'lm-studio', modelId: 'pinned' } }))
  store.patchSettings({ selectedProviderId: 'openai', selectedModelId: 'gpt-x' })
  engine.save({ ...draft('Nova'), id: nova.id, model: { providerId: 'ollama', modelId: 'changed' } })
  assert.deepEqual(worker(engine, vega.id).model, { providerId: 'lm-studio', modelId: 'pinned' })
  engine.send(vega.id, 'Go')
  await until(() => !!agent.of('Vega'))
  assert.equal(agent.of('Vega')!.request.modelId, 'pinned')
  agent.of('Vega')!.release()
})

test('a worker that follows Chat’s model never runs on some other model when that one is gone', async () => {
  const agent = heldAgent()
  const { engine } = start(agent.runAgent)
  const nova = engine.save(draft('Nova', { model: null }))
  store.patchSettings({ selectedProviderId: 'ollama', selectedModelId: 'model-that-is-gone' })
  engine.send(nova.id, 'Go')
  await until(() => receipts(engine, nova.id).at(-1)?.state === 'failed')
  assert.equal(agent.requests.length, 0, 'no turn was sent to a substitute model')
  assert.match(worker(engine, nova.id).lastError ?? '', /follows Chat's model \(model-that-is-gone\)/)
})

test('a worker has several threads that run side by side and stop on their own', async () => {
  const agent = heldAgent()
  const { engine } = start(agent.runAgent)
  const nova = engine.save(draft('Nova'))
  engine.send(nova.id, 'Main conversation')
  await until(() => agent.pending.length === 1)
  const { threadId } = engine.send(nova.id, 'Side task: summarise the report', [], { threadId: 'new' })
  assert.notEqual(threadId, MAIN_THREAD)
  await until(() => agent.pending.length === 2)
  const side = agent.pending.find((p) => p.request.workerThreadId === threadId)!
  assert.match(lastUserText(side.request), /Side task/)
  assert.ok(!lastUserText(side.request).includes('Main conversation'), 'the side thread sees only its own transcript')
  assert.equal(worker(engine, nova.id).threads[0].title, 'Side task: summarise the report')

  engine.stopTurn(nova.id, threadId)
  await until(() => agent.pending.length === 1)
  assert.equal(agent.pending[0].request.workerThreadId, undefined, 'the main thread is still working')
  agent.pending[0].release('Main done.')
  await until(() => !engine.isRunning(nova.id))
  assert.equal(engine.getThread(nova.id).messages.length, 2)
  assert.equal(engine.getThread(nova.id, threadId).messages.length, 2)
})

test('a message sent while a thread is busy waits visibly and goes into the next turn', async () => {
  const agent = heldAgent()
  const { engine } = start(agent.runAgent)
  const nova = engine.save(draft('Nova'))
  engine.send(nova.id, 'First')
  await until(() => agent.pending.length === 1)
  engine.send(nova.id, 'Second, while you work')
  assert.equal(worker(engine, nova.id).inbox.length, 1)
  agent.pending[0].release()
  await until(() => agent.requests.length === 2)
  assert.match(lastUserText(agent.requests[1]), /Second, while you work/)
  agent.pending[0].release()
})

test('removing a worker leaves every other worker’s files and threads alone', async () => {
  const agent = heldAgent()
  const { engine } = start(agent.runAgent)
  const nova = engine.save(draft('Nova'))
  const vega = engine.save(draft('Vega'))
  writeFileSync(join(vega.folder, 'notes.md'), 'keep me')
  engine.send(vega.id, 'Keep going')
  engine.send(nova.id, 'Doomed')
  await until(() => agent.pending.length === 2)
  await engine.remove(nova.id)
  await until(() => !agent.of('Nova'))
  assert.ok(agent.of('Vega'), 'Vega keeps working')
  assert.ok(existsSync(join(vega.folder, 'notes.md')))
  agent.of('Vega')!.release()
  await until(() => !engine.isRunning(vega.id))
  assert.equal(engine.getThread(vega.id).messages.length, 2)
})

test('a run cut off by a quit is picked up again after relaunch when it hadn’t acted', async () => {
  const agent = heldAgent()
  let { engine } = start(agent.runAgent)
  const nova = engine.save(draft('Nova'))
  engine.send(nova.id, 'Think about the plan')
  await until(() => agent.pending.length === 1)
  ;({ engine } = await relaunch(agent.runAgent))
  const cut = receipts(engine, nova.id)[0]
  assert.equal(cut.state, 'interrupted')
  assert.equal(cut.sideEffects, false)
  await until(() => agent.pending.length === 1)
  assert.match(lastUserText(agent.pending[0].request), /\[Resumed\]/)
  assert.equal(receipts(engine, nova.id).at(-1)!.trigger.kind, 'resume')
  agent.pending[0].release()
})

test('a run that may already have acted is never replayed after a crash', async () => {
  const agent = heldAgent()
  const acting: RunAgent = (request, emit, options) => {
    options.onToolRun?.('run_command', true)
    return agent.runAgent(request, emit, options)
  }
  let { engine } = start(acting)
  const nova = engine.save(draft('Nova'))
  engine.send(nova.id, 'Deploy it')
  await until(() => agent.pending.length === 1)
  ;({ engine } = await relaunch(acting))
  await settle(80)
  assert.equal(agent.pending.length, 0, 'nothing restarted on its own')
  // No orphaned "working" state survives the relaunch.
  assert.equal(worker(engine, nova.id).runningMessageId, null)
  assert.notEqual(worker(engine, nova.id).status, 'working')
  assert.ok(engine.getThread(nova.id).messages.every((m) => m.parts.every((p) => p.type !== 'tool' || p.status !== 'running')))
  const cut = receipts(engine, nova.id)[0]
  assert.equal(cut.state, 'interrupted')
  assert.equal(cut.sideEffects, true)
  assert.match(cut.reason ?? '', /may already have acted/)
  // The user can retry it, and the retry says what happened last time.
  engine.retry(nova.id, cut.id)
  await until(() => agent.pending.length === 1)
  assert.match(lastUserText(agent.pending[0].request), /\[Retry\].*may already have changed things/s)
  assert.equal(receipts(engine, nova.id).at(-1)!.retryOf, cut.id)
  agent.pending[0].release()
})

test('waking from a long sleep runs a routine once, late, with the skipped runs counted', async () => {
  const agent = heldAgent()
  let clock = Date.parse('2026-10-04T09:00:00Z')
  const { engine } = start(agent.runAgent, { now: () => clock })
  const nova = engine.save(draft('Nova'))
  engine.addRoutine(nova.id, { name: 'Check prices', task: 'Look at prices', everyMinutes: 10 })
  clock += 5 * 60 * 60_000 // five hours asleep: thirty occurrences missed
  engine.tick()
  await until(() => agent.pending.length === 1)
  await settle()
  assert.equal(agent.pending.length, 1, 'one run, not a storm')
  const run = receipts(engine, nova.id).at(-1)!
  assert.equal(run.trigger.kind, 'routine')
  assert.match(run.reason ?? '', /late .*29 earlier runs were skipped/)
  // It runs in the routine's own thread, not the main conversation.
  assert.notEqual(run.threadId, MAIN_THREAD)
  assert.equal(worker(engine, nova.id).threads.find((t) => t.id === run.threadId)?.kind, 'routine')
  agent.pending[0].release()
})

test('a routine due while its last run is still going is skipped, not stacked', async () => {
  const agent = heldAgent()
  let clock = Date.parse('2026-10-04T09:00:00Z')
  const { engine } = start(agent.runAgent, { now: () => clock })
  const nova = engine.save(draft('Nova'))
  engine.addRoutine(nova.id, { name: 'Sweep', task: 'Sweep the inbox', everyMinutes: 10 })
  clock += 10 * 60_000
  engine.tick()
  await until(() => agent.pending.length === 1)
  clock += 10 * 60_000
  engine.tick()
  await settle()
  assert.equal(agent.pending.length, 1)
  const missed = receipts(engine, nova.id).find((e) => e.state === 'missed')
  assert.ok(missed)
  assert.match(missed.reason ?? '', /previous run was still going/)
  agent.pending[0].release()
})

test('one failing routine doesn’t stop the worker’s other routines', async () => {
  const agent = heldAgent()
  let clock = Date.parse('2026-10-04T09:00:00Z')
  const { engine } = start(agent.runAgent, { now: () => clock })
  const nova = engine.save(draft('Nova'))
  engine.addRoutine(nova.id, { name: 'Flaky', task: 'Do the flaky thing', everyMinutes: 10 })
  engine.addRoutine(nova.id, { name: 'Steady', task: 'Do the steady thing', everyMinutes: 10 })
  clock += 10 * 60_000
  engine.tick()
  await until(() => agent.pending.length === 2)
  agent.pending.find((p) => /flaky/.test(lastUserText(p.request)))!.fail('Boom')
  agent.pending.find((p) => /steady/.test(lastUserText(p.request)))!.release()
  await until(() => !engine.isRunning(nova.id))
  clock += 10 * 60_000
  engine.tick()
  await until(() => agent.pending.length === 2)
  assert.equal(worker(engine, nova.id).routines.length, 2)
  assert.notEqual(worker(engine, nova.id).status, 'failed', 'a routine failing doesn’t knock the worker out')
  for (const p of [...agent.pending]) p.release()
})

test('a delegation is tracked from assigned to done, and the result reaches the thread that asked', async () => {
  const agent = heldAgent()
  const { engine } = start(agent.runAgent)
  const nova = engine.save(draft('Nova'))
  const vega = engine.save(draft('Vega'))
  const { delegation } = await engine.handOff(nova.id, 'Vega', 'Reproduce the login failure', [], {
    context: 'It fails on Safari only.',
    requiredOutput: 'Exact steps'
  })
  // It starts straight away: Vega had a free slot.
  assert.ok(['assigned', 'running'].includes(delegation.state))
  await until(() => !!agent.of('Vega'))
  const job = agent.of('Vega')!
  assert.match(lastUserText(job.request), /Reproduce the login failure/)
  assert.match(lastUserText(job.request), /It fails on Safari only/)
  assert.match(lastUserText(job.request), /What to send back: Exact steps/)
  assert.ok(job.request.workerThreadId, 'it runs in a thread of its own')
  assert.equal(engine.delegations()[0].state, 'running')

  await engine.finishHandoff(vega.id, delegation.id, '1. Open Safari 2. Sign in', [], true, job.request.workerThreadId)
  job.release('Reported.')
  const finished = engine.delegations()[0]
  assert.equal(finished.state, 'completed')
  assert.match(finished.result ?? '', /Open Safari/)
  await until(() => !!agent.of('Nova'))
  assert.match(lastUserText(agent.of('Nova')!.request), /Vega finished task/)
  await until(() => engine.delegations()[0].deliveredAt !== null)
  agent.of('Nova')!.release()
})

test('a delegated job that ends without reporting sends its last reply back on its own', async () => {
  const agent = heldAgent()
  const { engine } = start(agent.runAgent)
  const nova = engine.save(draft('Nova'))
  engine.save(draft('Vega'))
  await engine.handOff(nova.id, 'Vega', 'Count the rows')
  await until(() => !!agent.of('Vega'))
  agent.of('Vega')!.release('There are 42 rows.')
  await until(() => engine.delegations()[0].state === 'completed')
  assert.match(engine.delegations()[0].result ?? '', /42 rows/)
  await until(() => !!agent.of('Nova'))
  assert.match(lastUserText(agent.of('Nova')!.request), /42 rows/)
  agent.of('Nova')!.release()
})

test('a delegated job that fails tells the worker that asked instead of leaving it waiting', async () => {
  const agent = heldAgent()
  const { engine } = start(agent.runAgent)
  const nova = engine.save(draft('Nova'))
  engine.save(draft('Vega'))
  await engine.handOff(nova.id, 'Vega', 'Do the impossible')
  await until(() => !!agent.of('Vega'))
  agent.of('Vega')!.fail('The model refused')
  await until(() => engine.delegations()[0].state === 'failed')
  assert.match(engine.delegations()[0].failureReason ?? '', /hit a problem: The model refused/)
  await until(() => !!agent.of('Nova'))
  assert.match(lastUserText(agent.of('Nova')!.request), /could not finish task/)
  agent.of('Nova')!.release()
})

test('a delegation past its deadline fails and stops the work on it', async () => {
  const agent = heldAgent()
  let clock = Date.parse('2026-10-04T09:00:00Z')
  const { engine } = start(agent.runAgent, { now: () => clock })
  const nova = engine.save(draft('Nova'))
  engine.save(draft('Vega'))
  await engine.handOff(nova.id, 'Vega', 'Quick check', [], { deadlineMinutes: 5 })
  await until(() => !!agent.of('Vega'))
  clock += 6 * 60_000
  engine.tick()
  await until(() => !agent.of('Vega'))
  assert.equal(engine.delegations()[0].state, 'failed')
  assert.match(engine.delegations()[0].failureReason ?? '', /didn’t finish by the deadline/)
  await until(() => !!agent.of('Nova'))
  agent.of('Nova')!.release()
})

test('delegation can’t loop back or nest without end', async () => {
  const agent = heldAgent()
  const { engine } = start(agent.runAgent)
  const names = ['A', 'B', 'C', 'D', 'E']
  const ids = names.map((n) => engine.save(draft(`Worker ${n}`)).id)
  // A → B, then B (working on it in its job thread) tries to hand it back to A.
  const first = await engine.handOff(ids[0], 'Worker B', 'Step one')
  const bThread = first.delegation.recipient.threadId!
  await assert.rejects(engine.handOff(ids[1], 'Worker A', 'Back to you', [], { fromThreadId: bThread }), /would loop/)
  // B → C → D is as deep as it goes; D can't hand down again.
  const second = await engine.handOff(ids[1], 'Worker C', 'Step two', [], { fromThreadId: bThread })
  const third = await engine.handOff(ids[2], 'Worker D', 'Step three', [], { fromThreadId: second.delegation.recipient.threadId! })
  assert.equal(third.delegation.chain.length, MAX_DELEGATION_DEPTH)
  await assert.rejects(engine.handOff(ids[3], 'Worker E', 'Step four', [], { fromThreadId: third.delegation.recipient.threadId! }), /handed down/)
  await assert.rejects(engine.handOff(ids[0], 'Nobody', 'Hello'), /no worker called "Nobody"/)
  for (const p of [...agent.pending]) p.release()
})

test('a repeating wake-up nobody follows stops after STALE_WAKEUPS and says so', async () => {
  const agent = heldAgent()
  let clock = Date.parse('2026-10-04T09:00:00Z')
  const { engine } = start(agent.runAgent, { now: () => clock, maxTurnsPerHour: 10_000 })
  const nova = engine.save(draft('Nova'))
  engine.setHeartbeat(nova.id, { everyMinutes: 1, note: 'check the build' })
  for (let i = 0; i < STALE_WAKEUPS; i++) {
    clock += 61_000
    engine.tick()
    await until(() => agent.pending.length === 1)
    agent.pending[0].release()
    await until(() => !engine.isRunning(nova.id))
  }
  clock += 61_000
  engine.tick()
  await settle()
  assert.equal(agent.pending.length, 0)
  assert.equal(worker(engine, nova.id).heartbeat.nextAt, null)
  assert.match(receipts(engine, nova.id).at(-1)!.reason ?? '', new RegExp(`after ${STALE_WAKEUPS} wake-ups`))
})

test('saved workers that are damaged still load: bad fields are repaired, duplicates dropped', async () => {
  store.setJson(WORKERS, [
    { id: 'w1', name: 'Nova', paused: true, status: 'exploded', inbox: [{ nonsense: true }, { id: 'm', from: 'user', text: 'hi', at: 1 }], threads: [{ id: 'main' }, null, { id: 't1', title: 'Job' }], heartbeat: 'soon', routines: [{ id: 'r', name: 'x', nextAt: 'later' }] },
    { id: 'w1', name: 'Nova again' },
    { name: 'no id' },
    null,
    { id: 'w2', name: 'Vega', model: { providerId: 'ollama' } }
  ])
  const agent = heldAgent()
  const { engine } = start(agent.runAgent)
  const list = engine.list()
  assert.deepEqual(list.map((w) => w.name), ['Nova', 'Vega'])
  const nova = list[0]
  assert.equal(nova.status, 'paused')
  assert.equal(nova.inbox.length, 1)
  assert.deepEqual(nova.threads.map((t) => t.id), ['t1'])
  assert.deepEqual(nova.heartbeat, { nextAt: null, everyMs: null, note: '' })
  assert.equal(nova.routines.length, 0)
  assert.equal(list[1].model, null)
  for (const p of [...agent.pending]) p.release()
})

test('open hand-offs saved by 2026.6.1 become delegations', async () => {
  store.setJson(WORKERS, [
    { id: 'a', name: 'Nova', model: MODEL },
    { id: 'b', name: 'Vega', model: MODEL, handoffs: [{ id: 'task_old', fromId: 'a', fromName: 'Nova', task: 'Old job', at: 5 }] }
  ])
  const { engine } = start(heldAgent().runAgent)
  const [delegation] = engine.delegations()
  assert.equal(delegation.id, 'task_old')
  assert.equal(delegation.state, 'running')
  assert.equal(delegation.parent.workerId, 'a')
  assert.equal(delegation.recipient.threadId, MAIN_THREAD)
  assert.equal('handoffs' in engine.list()[1], false)
})

/* ---------------------------------------------------------------- engines */

function fakeEngine() {
  const calls: EngineTurnInput[] = []
  const decisions: boolean[] = []
  let next: Partial<Awaited<ReturnType<RunEngineTurn>>> = {}
  const runEngineTurn: RunEngineTurn = async (_engine, input) => {
    calls.push({ ...input, emit: input.emit })
    input.emit({ type: 'delta', messageId: input.messageId, text: 'Codex here.' })
    decisions.push(await input.approve({ tool: 'run_command', input: { command: 'npm test' }, summary: 'npm test', mutating: true }))
    decisions.push(await input.approve({ tool: 'run_command', input: { command: 'sudo rm -rf /' }, summary: 'sudo rm', mutating: true }))
    return { sessionId: input.sessionId ?? 'thread-1', text: 'Codex here.', usage, cancelled: false, sideEffects: true, ...next }
  }
  return { runEngineTurn, calls, decisions, setNext: (value: typeof next) => (next = value) }
}

test('a worker on the Codex engine continues its own session and Eaon decides its approvals', async () => {
  const codex = fakeEngine()
  const agent = heldAgent()
  const { engine } = start(agent.runAgent, { runEngineTurn: codex.runEngineTurn })
  const nova = engine.save(draft('Nova', { engine: 'codex', model: { providerId: 'codex', modelId: 'gpt-6-luna' }, access: 'autonomous' }))
  engine.send(nova.id, 'Refactor the parser')
  await until(() => receipts(engine, nova.id).at(-1)?.state === 'completed')
  assert.equal(agent.requests.length, 0, 'Eaon’s own loop wasn’t used')
  assert.equal(codex.calls[0].sessionId, null)
  assert.equal(codex.calls[0].model, 'gpt-6-luna')
  assert.match(codex.calls[0].instructions, /You are Nova/)
  assert.match(codex.calls[0].text, /Refactor the parser/)
  assert.deepEqual(codex.decisions, [true, false], 'an autonomous worker runs tests but never sudo')
  assert.deepEqual(worker(engine, nova.id).engineSession, { engine: 'codex', sessionId: 'thread-1' })
  assert.equal(receipts(engine, nova.id).at(-1)!.sideEffects, true)

  engine.send(nova.id, 'Now add tests')
  await until(() => codex.calls.length === 2 && !engine.isRunning(nova.id))
  assert.equal(codex.calls[1].sessionId, 'thread-1')
})

test('an expired Codex sign-in says reconnect, not that the model is unavailable', async () => {
  const codex = fakeEngine()
  codex.setNext({ error: '401 Unauthorized: token expired', errorKind: 'auth-expired', text: '' })
  const { engine } = start(heldAgent().runAgent, { runEngineTurn: codex.runEngineTurn })
  const nova = engine.save(draft('Nova', { engine: 'codex', model: null }))
  engine.send(nova.id, 'Go')
  await until(() => receipts(engine, nova.id).at(-1)?.state === 'failed')
  assert.match(worker(engine, nova.id).lastError ?? '', /Codex's sign-in expired\. Reconnect it/)
})

test('engine approvals follow the worker’s access level', () => {
  const write = { tool: 'apply_patch', input: { files: ['a.ts'] }, summary: 'edit a.ts', mutating: true }
  const risky = { tool: 'run_command', input: { command: 'git push origin main' }, summary: 'push', mutating: true }
  const catastrophic = { tool: 'run_command', input: { command: 'git push --force' }, summary: 'force-push', mutating: true }
  const read = { tool: 'run_command', input: { command: 'ls' }, summary: 'ls', mutating: false }
  assert.equal(engineApproval('read-only', write), false)
  assert.equal(engineApproval('read-only', read), true)
  assert.equal(engineApproval('safe', write), true)
  assert.equal(engineApproval('safe', risky), false)
  assert.equal(engineApproval('autonomous', risky), true)
  assert.equal(engineApproval('autonomous', catastrophic), false)
})

test('open delegations and unanswered questions are restated every turn, so a summarised thread can’t forget them', async () => {
  const agent = heldAgent()
  const { engine } = start(agent.runAgent)
  const nova = engine.save(draft('Nova'))
  // Vega is paused, so the job stays open while Nova runs.
  engine.setPaused(engine.save(draft('Vega')).id, true)
  await engine.handOff(nova.id, 'Vega', 'Collect the survey results')
  engine.ask(nova.id, { question: 'Which region first?' })
  engine.send(nova.id, 'Anything new?')
  await until(() => !!agent.of('Nova'))
  const text = lastUserText(agent.of('Nova')!.request)
  assert.match(text, /\[Still open\] waiting on Vega for task_\w+ \("Collect the survey results", assigned\)/)
  assert.match(text, /your question to the user, not answered yet: "Which region first\?"/)
  agent.of('Nova')!.release()
})

test('a sleeping worker wakes when the file it waits on changes, long before its time is up', async () => {
  const agent = heldAgent()
  const { engine } = start(agent.runAgent)
  const nova = engine.save(draft('Nova'))
  const file = join(root, 'build-done.txt')
  engine.sleep(nova.id, 120, 'read the build result', MAIN_THREAD, { fileChanges: file })
  assert.match(worker(engine, nova.id).activity, /Waiting for .*build-done\.txt to change/)
  await settle(50)
  assert.equal(agent.pending.length, 0)
  writeFileSync(file, 'ok')
  await until(() => agent.pending.length === 1, 4000)
  assert.match(lastUserText(agent.pending[0].request), /read the build result — woken because .*build-done\.txt appeared/)
  agent.pending[0].release()
})

test('a sleeping worker wakes when the process it waits on exits', async () => {
  const agent = heldAgent()
  const { engine } = start(agent.runAgent)
  const nova = engine.save(draft('Nova'))
  const { spawn } = await import('node:child_process')
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300)'])
  engine.sleep(nova.id, 120, 'check the training run', MAIN_THREAD, { processExits: child.pid })
  await until(() => agent.pending.length === 1, 6000)
  assert.match(lastUserText(agent.pending[0].request), new RegExp(`woken because process ${child.pid} exited`))
  agent.pending[0].release()
})

/* ------------------------------------------------------- access and origin */

test('a look-only worker can’t get an autonomous colleague to make changes for it, in that job or any later turn of it', async () => {
  const agent = heldAgent()
  let clock = Date.parse('2026-10-04T09:00:00Z')
  const { engine } = start(agent.runAgent, { now: () => clock })
  const nova = engine.save(draft('Nova', { access: 'read-only' }))
  engine.save(draft('Vega', { access: 'autonomous' }))
  // Vega alone, asked by the user: its own access.
  engine.send(engine.list().find((w) => w.name === 'Vega')!.id, 'Hello')
  await until(() => !!agent.of('Vega'))
  assert.equal(agent.of('Vega')!.options.unattended, 'autonomous')
  agent.of('Vega')!.release()
  await until(() => !engine.isRunning(engine.list().find((w) => w.name === 'Vega')!.id))

  const { delegation } = await engine.handOff(nova.id, 'Vega', 'Clean up the build folder')
  await until(() => !!agent.of('Vega'))
  const job = agent.of('Vega')!
  assert.equal(job.options.unattended, 'read-only', 'the job runs at the delegator’s access')
  assert.equal(job.request.workerId, engine.list().find((w) => w.name === 'Vega')!.id)
  assert.match(job.request.persona ?? '', /Usually nobody is watching and nobody can approve anything/, 'and the persona says so')
  // It goes to sleep and wakes later with no mail: still capped.
  engine.sleep(job.request.workerId!, 5, 'check back', job.request.workerThreadId)
  job.release()
  clock += 6 * 60_000
  engine.tick()
  await until(() => !!agent.of('Vega'))
  assert.equal(agent.of('Vega')!.options.unattended, 'read-only', 'a later wake-up of the same job is capped too')
  assert.equal(engine.delegations().find((d) => d.id === delegation.id)!.state, 'running')
  agent.of('Vega')!.release()
})

test('each turn carries who its work came from, per thread: a user’s message in one never clears a colleague’s in another', async () => {
  const agent = heldAgent()
  const { engine } = start(agent.runAgent)
  const nova = engine.save(draft('Nova'))
  const vega = engine.save(draft('Vega'))
  await engine.handOff(nova.id, 'Vega', 'Buy the tickets')
  await until(() => !!agent.of('Vega'))
  const delegated = agent.of('Vega')!
  assert.equal(delegated.options.origin, 'delegated')
  assert.equal(engine.turnOrigin(delegated.request.messageId), 'delegated')
  // The user writes to Vega's main conversation while that job is running.
  engine.send(vega.id, 'What’s the weather?')
  await until(() => agent.pending.length === 2)
  const mine = agent.pending.find((p) => p !== delegated)!
  assert.equal(mine.options.origin, 'user')
  assert.equal(engine.turnOrigin(mine.request.messageId), null)
  assert.equal(engine.turnOrigin(delegated.request.messageId), 'delegated', 'the user’s turn did not clear the colleague’s')
  for (const p of [...agent.pending]) p.release()
})

test('an approval the user gave covers that call only: key order and a namespace don’t matter, anything else does', () => {
  const agent = heldAgent()
  const { engine } = start(agent.runAgent)
  const nova = engine.save(draft('Nova', { access: 'safe' }))
  const ask = engine.ask(nova.id, { question: 'Send it?', approve: { tool: 'functions.email_send', input: { to: 'a@b.c', subject: 'Hi', body: 'x' }, summary: 'send' } })
  engine.answer(nova.id, ask.id, { approved: true })
  assert.equal(engine.allowOnce(nova.id, 'email_send', { to: 'a@b.c', subject: 'Hi', body: 'x ' }), false, 'a different body is a different call')
  assert.equal(engine.allowOnce(nova.id, 'email_send', { to: 'a@b.c', subject: 'Hi' }), false)
  assert.equal(engine.allowOnce(nova.id, 'email_draft', { to: 'a@b.c', subject: 'Hi', body: 'x' }), false)
  assert.equal(engine.allowOnce(nova.id, 'email_send', { body: 'x', subject: 'Hi', to: 'a@b.c' }), true)
  assert.equal(engine.allowOnce(nova.id, 'email_send', { to: 'a@b.c', subject: 'Hi', body: 'x' }), false, 'spent: once means once')
})

test('a Codex turn that lost its session says so, is marked as on the user’s plan, and a gateway loop gets its own explanation', async () => {
  const codex = fakeEngine()
  const { engine } = start(heldAgent().runAgent, { runEngineTurn: codex.runEngineTurn })
  const nova = engine.save(draft('Nova', { engine: 'codex', model: null }))
  codex.setNext({ notice: 'Codex no longer had the earlier session, so this turn started a new one without the earlier history.', billing: 'plan' })
  engine.send(nova.id, 'Continue')
  await until(() => receipts(engine, nova.id).at(-1)?.state === 'completed')
  const run = receipts(engine, nova.id).at(-1)!
  assert.match(run.reason ?? '', /started a new one without the earlier history/)
  assert.equal(run.billing, 'plan')

  codex.setNext({ error: 'config points at 127.0.0.1:1337', errorKind: 'misconfigured', text: '' })
  engine.send(nova.id, 'Again')
  await until(() => receipts(engine, nova.id).at(-1)?.state === 'failed')
  assert.match(worker(engine, nova.id).lastError ?? '', /set up to send its requests through Eaon, so Eaon can't run it/)
})

test('a routine that is running doesn’t make the user wait (the 2026.6.1 behaviour: one worker, one queue)', async () => {
  const agent = heldAgent()
  let clock = Date.parse('2026-10-04T09:00:00Z')
  const { engine } = start(agent.runAgent, { now: () => clock })
  const nova = engine.save(draft('Nova'))
  engine.addRoutine(nova.id, { name: 'Sweep', task: 'Sweep the inbox', everyMinutes: 10 })
  clock += 10 * 60_000
  engine.tick()
  await until(() => agent.pending.length === 1)
  assert.match(lastUserText(agent.pending[0].request), /Routine "Sweep"/)
  engine.send(nova.id, 'Quick question: what time is it?')
  // Started at once, in the main conversation, beside the routine.
  await until(() => agent.pending.length === 2, 1500)
  assert.equal(worker(engine, nova.id).inbox.length, 0, 'nothing waits in the inbox')
  const answering = agent.pending.find((p) => /Quick question/.test(lastUserText(p.request)))!
  assert.equal(answering.request.workerThreadId, undefined, 'it is the main conversation')
  answering.release('Nearly ten past nine.')
  await until(() => receipts(engine, nova.id).some((e) => e.trigger.kind === 'message' && e.state === 'completed'))
  assert.equal(engine.isRunning(nova.id), true, 'the routine is still going')
  agent.pending[0].release('Swept.')
  await until(() => !engine.isRunning(nova.id))
  const history = receipts(engine, nova.id).map((e) => `${e.trigger.label}: ${e.state}`).sort()
  assert.deepEqual(history, ['Routine: Sweep: completed', 'Your message: completed'], 'each run has its own receipt')
})

test('a delegated job that asks the user something is waiting, not done, and the answer goes back to that job', async () => {
  const agent = heldAgent()
  const { engine } = start(agent.runAgent)
  const nova = engine.save(draft('Nova'))
  const vega = engine.save(draft('Vega'))
  await engine.handOff(nova.id, 'Vega', 'Book the venue')
  await until(() => !!agent.of('Vega'))
  const job = agent.of('Vega')!
  const threadId = job.request.workerThreadId!
  const ask = engine.ask(vega.id, { question: 'Which date works?' }, threadId)
  assert.equal(ask.threadId, threadId)
  job.release('I need to know the date before I can book.')
  await until(() => !engine.isRunning(vega.id))
  assert.equal(engine.delegations()[0].state, 'waiting', 'it asked; the job is not finished')
  assert.equal(agent.pending.length, 0, 'and nothing was reported to Nova yet')
  engine.answer(vega.id, ask.id, { text: 'Friday' })
  await until(() => !!agent.of('Vega'))
  const again = agent.of('Vega')!
  assert.equal(again.request.workerThreadId, threadId, 'the answer reached the job’s own thread')
  assert.match(lastUserText(again.request), /\[Answer to "Which date works\?"\] Friday/)
  again.release('Booked for Friday.')
  await until(() => engine.delegations()[0].state === 'completed')
  assert.match(engine.delegations()[0].result ?? '', /Booked for Friday/)
  await until(() => !!agent.of('Nova'))
  agent.of('Nova')!.release()
})
