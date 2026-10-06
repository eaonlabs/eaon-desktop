import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DOZE_AFTER_MS, HAPPY_FOR_MS, SLEEPY_AFTER_MS, workerMood, type Worker } from '@shared/workers'
import { HINT_MOODS } from '../src/main/features/workers/engine'

/**
 * The expression a worker's face shows, derived from what it is doing: the
 * reactions added for waiting on the user, a failed run and a long idle.
 */

const NOW = Date.parse('2026-10-04T12:00:00Z')

function worker(extra: Partial<Worker> = {}): Worker {
  return {
    paused: false,
    status: 'idle',
    moodHint: null,
    asks: [],
    lastOutcome: null,
    heartbeat: { nextAt: null, everyMs: null, note: '' },
    inbox: [],
    lastRunAt: NOW - 60_000,
    createdAt: NOW - 86_400_000,
    ...extra
  } as unknown as Worker
}

test('waiting on the user looks curious; working still reads as serious', () => {
  const asking = worker({ asks: [{ id: 'a1' }] as unknown as Worker['asks'] })
  assert.equal(workerMood(asking, NOW), 'curious')
  assert.equal(workerMood({ ...asking, status: 'working' }, NOW), 'serious')
})

test('a recent run that went wrong looks sad for a while, one that went well happy', () => {
  assert.equal(workerMood(worker({ lastOutcome: { at: NOW - 60_000, ok: false } }), NOW), 'sad')
  assert.equal(workerMood(worker({ lastOutcome: { at: NOW - 60_000, ok: true } }), NOW), 'happy')
  assert.equal(workerMood(worker({ lastOutcome: { at: NOW - HAPPY_FOR_MS - 1, ok: false } }), NOW), 'neutral')
})

test('idle with nothing scheduled: neutral, then sleepy, then asleep', () => {
  assert.equal(workerMood(worker({ lastRunAt: NOW - 60_000 }), NOW), 'neutral')
  assert.equal(workerMood(worker({ lastRunAt: NOW - SLEEPY_AFTER_MS - 1 }), NOW), 'sleepy')
  assert.equal(workerMood(worker({ lastRunAt: NOW - DOZE_AFTER_MS - 1 }), NOW), 'asleep')
  // Something scheduled keeps it awake.
  assert.equal(workerMood(worker({ lastRunAt: NOW - DOZE_AFTER_MS - 1, heartbeat: { nextAt: NOW + 60_000, everyMs: null, note: '' } }), NOW), 'neutral')
})

test('a worker can pick the new expressions, but not the derived states', () => {
  for (const mood of ['excited', 'curious', 'surprised', 'sad'] as const) assert.ok(HINT_MOODS.includes(mood), mood)
  for (const mood of ['sleepy', 'asleep', 'dead'] as const) assert.ok(!HINT_MOODS.includes(mood), mood)
  assert.equal(workerMood(worker({ moodHint: { mood: 'excited', until: NOW + 60_000 } }), NOW), 'excited')
})
