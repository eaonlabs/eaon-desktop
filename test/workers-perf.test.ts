import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Notification } from 'electron'
import { store } from '../src/main/store'
import { createWorkersService, type WorkersService } from '../src/main/features/workers/service'
import type { RunAgent } from '../src/main/features/workers/runner'
import type { FeatureContext } from '../src/main/features/types'
import { MAX_THREADS, MAX_WORKERS } from '@shared/workers'

/**
 * Budgets for a busy team: 16 workers, each with a full set of threads. The
 * scheduler's tick runs every 30 s and on every change, and every change is
 * sent to the window; neither may grow with how much history there is. The
 * numbers are generous (a slow CI machine passes) but a regression that
 * makes a tick or a change quadratic in threads fails them.
 */

let service: WorkersService | null = null

beforeEach(() => {
  store.setJson('workers.json', [])
  store.setJson('worker-delegations.json', [])
  const root = mkdtempSync(join(tmpdir(), 'eaon-workers-perf-'))
  store.patchSettings({ work: { ...store.getSettings().work, defaultFolder: root } })
  Notification.supported = false
})

afterEach(async () => {
  service?.stop()
  await service?.engine.whenIdle()
  service = null
  await store.flushWrites()
})

test('16 workers with 60 threads each: a scheduler tick and a change stay cheap', async () => {
  let sent = 0
  const ctx = {
    ipcMain: { handle: () => {} },
    getWindow: () => null,
    send: () => void sent++,
    emitStream: () => {}
  } as unknown as FeatureContext
  const runAgent: RunAgent = async () => ({ text: '', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })
  // A team saved by an earlier session: loading it is how the engine meets it.
  const root = store.getSettings().work.defaultFolder
  store.setJson(
    'workers.json',
    Array.from({ length: MAX_WORKERS }, (_, i) => ({
      id: `w${i}`,
      name: `Worker ${i}`,
      color: '#3E86C6',
      purpose: 'busy',
      folder: join(root, `Worker-${i}`),
      model: { providerId: 'ollama', modelId: 'fake-model' },
      threads: Array.from({ length: MAX_THREADS }, (_, t) => ({ id: `thread-${t}`, title: `Task ${t}`, kind: 'task', createdAt: 1, updatedAt: 1 }))
    }))
  )
  service = createWorkersService(ctx, { runAgent, startDelayMs: 60_000 })
  service.start()
  const { engine } = service
  engine.start()
  const ids = engine.list().map((w) => w.id)
  assert.equal(engine.list().reduce((n, w) => n + w.threads.length, 0), MAX_WORKERS * MAX_THREADS)

  const time = (fn: () => void, runs = 50): number => {
    const start = performance.now()
    for (let i = 0; i < runs; i++) fn()
    return (performance.now() - start) / runs
  }
  // Judged against how long it takes this machine, right now, to serialise
  // the same team once: a loaded CI box slows both alike, while work that
  // grows with history (a clone per change, a scan per thread) shows up as a
  // multiple of it.
  const team = engine.list()
  const baseline = Math.max(time(() => void JSON.stringify(team), 20), 0.05)
  const tick = time(() => engine.tick())
  const change = time(() => engine.setStatus(ids[0], 'checking things'))
  assert.ok(tick < baseline * 40 + 5, `a scheduler tick took ${tick.toFixed(1)} ms (serialising the team takes ${baseline.toFixed(1)} ms) with 960 threads`)
  assert.ok(change < baseline * 120 + 20, `a change (save, and send the team) took ${change.toFixed(1)} ms (serialising the team takes ${baseline.toFixed(1)} ms) with 960 threads`)
  // And nothing is catastrophic however loaded the machine is.
  assert.ok(tick < 500 && change < 1000)
})
