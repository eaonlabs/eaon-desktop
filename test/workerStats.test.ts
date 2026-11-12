import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workerStats } from '../src/shared/workerStats'
import type { WorkerExecution } from '../src/shared/workers'

const NOW = Date.UTC(2026, 10, 11, 12)
const DAY = 86_400_000

function run(over: Partial<WorkerExecution>): WorkerExecution {
  return {
    id: 'r',
    workerId: 'w',
    threadId: 't',
    trigger: { kind: 'message', label: 'Message' },
    state: 'completed',
    reason: null,
    queuedAt: NOW - 1000,
    startedAt: NOW - 1000,
    endedAt: NOW,
    messageId: null,
    engine: 'eaon',
    providerId: null,
    modelId: null,
    usage: null,
    billing: null,
    sideEffects: false,
    result: null,
    error: null,
    retryOf: null,
    ...over
  } as WorkerExecution
}

test('counts finished runs in the window, with their success rate and average time', () => {
  const stats = workerStats(
    [
      run({ id: 'a', endedAt: NOW - DAY, startedAt: NOW - DAY - 4000 }),
      run({ id: 'b', state: 'failed', endedAt: NOW - 2 * DAY, startedAt: NOW - 2 * DAY - 2000 }),
      run({ id: 'c', state: 'cancelled', endedAt: NOW - 3 * DAY, startedAt: NOW - 3 * DAY - 6000 })
    ],
    7,
    NOW
  )
  assert.equal(stats.runs, 3)
  assert.equal(stats.completed, 1)
  assert.equal(stats.failed, 1)
  assert.equal(stats.successRate, 0.5) // a stopped run is neither
  assert.equal(stats.averageMs, 4000)
})

test('leaves out runs outside the window, and ones still going or skipped', () => {
  const stats = workerStats(
    [
      run({ id: 'old', endedAt: NOW - 8 * DAY, startedAt: NOW - 8 * DAY - 1000 }),
      run({ id: 'live', state: 'running', endedAt: null }),
      run({ id: 'wait', state: 'queued', startedAt: null, endedAt: null }),
      run({ id: 'skip', state: 'missed', startedAt: null, endedAt: null })
    ],
    7,
    NOW
  )
  assert.equal(stats.runs, 0)
  assert.equal(stats.successRate, null)
  assert.equal(stats.averageMs, null)
  assert.equal(workerStats([run({ endedAt: NOW - 8 * DAY, startedAt: NOW - 8 * DAY - 1 })], 30, NOW).runs, 1)
})

test('subscription tokens are kept apart from billed ones', () => {
  const usage = { input: 600, output: 400, cacheRead: 5000, cacheWrite: 0 }
  const stats = workerStats([run({ id: 'a', usage, billing: 'api' }), run({ id: 'b', usage, billing: 'plan' }), run({ id: 'c', usage, billing: 'local' }), run({ id: 'd', usage: null })], 7, NOW)
  assert.equal(stats.tokens, 2000)
  assert.equal(stats.planTokens, 1000)
})
