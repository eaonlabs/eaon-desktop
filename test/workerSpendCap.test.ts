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
import type { FeatureContext } from '../src/main/features/types'
import { describeWorker, type WorkerDraft } from '@shared/workers'
import type { StreamEvent, StreamRequest } from '@shared/types'

/**
 * A worker's spend cap: tokens (and dollars where a price is known) per day
 * or month, checked before each run. At the cap the worker pauses with the
 * reason on it; raising the cap, or the next period, lets it carry on.
 */

const WORKERS = 'workers.json'
const MODEL = { providerId: 'ollama', modelId: 'fake-model' }

let service: WorkersService | null = null

beforeEach(() => {
  store.setJson(WORKERS, [])
  const root = mkdtempSync(join(tmpdir(), 'eaon-workers-cap-'))
  const settings = store.getSettings()
  store.patchSettings({ work: { ...settings.work, defaultFolder: root } })
  Notification.supported = true
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
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function fakeContext() {
  const window = { isFocused: () => false, isDestroyed: () => false, isMinimized: () => false, show() {}, focus() {}, restore() {}, webContents: { isLoading: () => false, once() {} } }
  return { ipcMain: { handle: () => {} }, getWindow: () => window, send: () => {}, emitStream: () => {} } as unknown as FeatureContext
}

/** A fake agent that spends `tokens` (half in, half out) on every run. */
function spender(tokens: number) {
  const requests: StreamRequest[] = []
  const runAgent: RunAgent = async (request, emit: (event: StreamEvent) => void, _options: RunOptions): Promise<RunOutcome> => {
    requests.push(structuredClone(request))
    emit({ type: 'delta', messageId: request.messageId, text: 'Done.' })
    emit({ type: 'done', messageId: request.messageId })
    return { text: 'Done.', usage: { input: Math.floor(tokens / 2), output: tokens - Math.floor(tokens / 2), cacheRead: 0, cacheWrite: 0 } }
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

test('a worker that reaches its token cap pauses with the reason, and its next message waits', async () => {
  const agent = spender(120)
  const engine = start(agent.runAgent)
  const nova = engine.save(draft('Nova', { budget: { tokens: 100, usd: null, period: 'day' } }))
  assert.equal(nova.spend?.tokens, 0)

  engine.send(nova.id, 'First job')
  await until(() => agent.requests.length === 1)
  await engine.whenIdle()
  const paused = engine.list()[0]
  assert.equal(paused.paused, true)
  assert.equal(paused.status, 'paused')
  assert.equal(paused.spend?.tokens, 120, 'the run’s input and output tokens are counted')
  assert.match(paused.budgetHold?.reason ?? '', /^Used 120 of its 100 tokens for today\./)
  assert.equal(describeWorker(paused), 'Paused: spend cap reached')
  assert.ok(Notification.shown.some((n) => n.options.title === 'Nova paused: spend cap reached'), 'the owner is told')

  engine.send(nova.id, 'Second job')
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(agent.requests.length, 1, 'no run starts while it is over its cap')
  assert.equal(engine.list()[0].inbox.length, 1, 'the message waits in its inbox')
  assert.throws(() => engine.setPaused(nova.id, false), /reached its spend cap/)
  assert.equal(engine.list()[0].paused, true)
})

test('raising the cap lets it carry on, and what it already used today still counts', async () => {
  const agent = spender(120)
  const engine = start(agent.runAgent)
  const nova = engine.save(draft('Nova', { budget: { tokens: 100, usd: null, period: 'day' } }))
  engine.send(nova.id, 'First job')
  await until(() => engine.list()[0].paused)
  engine.send(nova.id, 'Second job')

  // Still under the new cap? 120 used of 200: it is released and reads the waiting message.
  const raised = engine.save(draft('Nova', { id: nova.id, budget: { tokens: 200, usd: null, period: 'day' } }))
  assert.equal(raised.paused, false)
  assert.equal(raised.budgetHold, null)
  assert.equal(raised.spend?.tokens, 120, 'raising the cap keeps the count')
  await until(() => agent.requests.length === 2)
  await engine.whenIdle()
  // 240 of 200 now: held again, by the run that crossed it.
  assert.equal(engine.list()[0].paused, true)
  assert.match(engine.list()[0].budgetHold?.reason ?? '', /Used 240 of its 200 tokens/)

  // No cap at all: released, and the count is dropped.
  const free = engine.save(draft('Nova', { id: nova.id, budget: null }))
  assert.equal(free.paused, false)
  assert.equal(free.spend, null)
  assert.equal(free.budget, null)
})

test('a new period starts the count again and releases a worker held for its cap', async () => {
  let clock = new Date(2026, 9, 15, 20).getTime()
  const agent = spender(500)
  const engine = start(agent.runAgent, { now: () => clock })
  const nova = engine.save(draft('Nova', { budget: { tokens: 400, usd: null, period: 'day' } }))
  engine.send(nova.id, 'Job')
  await until(() => engine.list()[0].paused)
  assert.ok(engine.list()[0].budgetHold)

  clock = new Date(2026, 9, 16, 0, 5).getTime()
  engine.tick()
  const after = engine.list()[0]
  assert.equal(after.paused, false, 'the day started over')
  assert.equal(after.budgetHold, null)
  assert.equal(after.status === 'paused', false)
})

test('a monthly cap counts across days', async () => {
  let clock = new Date(2026, 9, 3, 10).getTime()
  const agent = spender(60)
  const engine = start(agent.runAgent, { now: () => clock })
  const nova = engine.save(draft('Nova', { budget: { tokens: 100, usd: null, period: 'month' } }))
  engine.send(nova.id, 'One')
  await until(() => agent.requests.length === 1)
  await engine.whenIdle()
  assert.equal(engine.list()[0].paused, false, '60 of 100')
  clock = new Date(2026, 9, 20, 10).getTime()
  engine.send(nova.id, 'Two')
  await until(() => agent.requests.length === 2)
  await engine.whenIdle()
  assert.equal(engine.list()[0].spend?.tokens, 120)
  assert.equal(engine.list()[0].paused, true)
  assert.match(engine.list()[0].budgetHold?.reason ?? '', /for this month\. It starts again on the 1st/)
})

test('a dollar cap counts only runs the app can price', async () => {
  const agent = spender(1000)
  const prices: string[] = []
  // A price for the one model, as usage's published rates would give it: $0.75 a run.
  const costOf = (providerId: string, modelId: string): number | null => {
    prices.push(`${providerId}/${modelId}`)
    return providerId === 'ollama' ? 0.75 : null
  }
  const engine = start(agent.runAgent, { costOf })
  const nova = engine.save(draft('Nova', { budget: { tokens: null, usd: 1, period: 'day' } }))
  engine.send(nova.id, 'One')
  await until(() => agent.requests.length === 1)
  await engine.whenIdle()
  assert.equal(engine.list()[0].paused, false, '$0.75 of $1')
  assert.equal(engine.list()[0].spend?.usd, 0.75)
  engine.send(nova.id, 'Two')
  await until(() => agent.requests.length === 2)
  await engine.whenIdle()
  assert.equal(engine.list()[0].paused, true)
  assert.match(engine.list()[0].budgetHold?.reason ?? '', /^Spent about \$1\.50 of its \$1\.00 for today\./)
  assert.deepEqual([...new Set(prices)], ['ollama/fake-model'])
})

test('setting a cap counts what earlier runs used today', async () => {
  const agent = spender(80)
  const engine = start(agent.runAgent)
  const nova = engine.save(draft('Nova'))
  engine.send(nova.id, 'One')
  await until(() => agent.requests.length === 1)
  await engine.whenIdle()
  assert.equal(engine.list()[0].spend, null, 'no cap, nothing kept')

  const capped = engine.save(draft('Nova', { id: nova.id, budget: { tokens: 1000, usd: null, period: 'day' } }))
  assert.equal(capped.spend?.tokens, 80, 'the run that was already made today is counted')
})

test('a cap that is saved survives a restart, and a hold with it', async () => {
  const agent = spender(300)
  const engine = start(agent.runAgent)
  const nova = engine.save(draft('Nova', { budget: { tokens: 100, usd: null, period: 'day' } }))
  engine.send(nova.id, 'Job')
  await until(() => engine.list()[0].paused)
  const saved = JSON.parse(JSON.stringify(store.getJson<unknown[]>(WORKERS, []))) as { budget: unknown; budgetHold: { reason: string }; paused: boolean }[]
  assert.deepEqual(saved[0].budget, { tokens: 100, usd: null, period: 'day' })
  assert.equal(saved[0].paused, true)
  assert.match(saved[0].budgetHold.reason, /Used 300 of its 100 tokens/)

  service?.stop()
  await service?.engine.whenIdle()
  const again = start(agent.runAgent)
  assert.equal(again.list()[0].paused, true)
  assert.match(again.list()[0].budgetHold?.reason ?? '', /Used 300 of its 100 tokens/)
})
