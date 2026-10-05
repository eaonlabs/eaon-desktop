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
import { nextRoutineAt } from '@shared/workers'

/**
 * A worker's daily routine is "at 9:00" where the user is: across a clock
 * change (DST) it still runs once a day at that time, and after a change of
 * time zone it is worked out again in the new one.
 */

const ORIGINAL_TZ = process.env.TZ
afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ
  else process.env.TZ = ORIGINAL_TZ
})

const hhmm = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

test('daily at 02:30 across the spring clock change runs an hour later that day, then at 02:30 again', () => {
  process.env.TZ = 'America/Los_Angeles'
  const routine = { daily: '02:30', everyMs: null }
  const before = new Date(2026, 2, 7, 12, 0).getTime()
  const day = nextRoutineAt(routine, before)
  assert.equal(hhmm(day), '3/8 03:30', '02:30 does not exist on 8 March; it runs at 03:30')
  assert.equal(hhmm(nextRoutineAt(routine, day)), '3/9 02:30')
})

test('daily at 01:30 across the autumn clock change runs once that day, not twice', () => {
  process.env.TZ = 'America/Los_Angeles'
  const routine = { daily: '01:30', everyMs: null }
  const first = nextRoutineAt(routine, new Date(2026, 10, 1, 0, 0).getTime())
  assert.equal(hhmm(first), '11/1 01:30')
  assert.equal(hhmm(nextRoutineAt(routine, first)), '11/2 01:30', 'the repeated 01:30 does not run a second time')
})

let service: WorkersService | null = null
afterEach(async () => {
  service?.stop()
  await service?.engine.whenIdle()
  service = null
  await store.flushWrites()
})
beforeEach(() => {
  store.setJson('workers.json', [])
  store.patchSettings({ work: { ...store.getSettings().work, defaultFolder: mkdtempSync(join(tmpdir(), 'eaon-wsched-')) } })
  Notification.supported = false
})

test('after the time zone changes, a daily routine is worked out again in the new zone', async () => {
  process.env.TZ = 'America/New_York'
  let zone = 'America/New_York'
  let clock = new Date(2026, 9, 5, 7, 0).getTime() // 07:00 in New York
  const runAgent: RunAgent = async () => ({ text: '', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })
  const ctx = { ipcMain: { handle: () => {} }, getWindow: () => null, send: () => {}, emitStream: () => {} } as unknown as FeatureContext
  service = createWorkersService(ctx, { runAgent, now: () => clock, zone: () => zone, startDelayMs: 60_000 })
  service.start()
  service.engine.start()
  const { engine } = service
  const nova = engine.save({ name: 'Nova', color: '#3E86C6', personality: '', purpose: 'x', model: { providerId: 'ollama', modelId: 'fake-model' } })
  engine.addRoutine(nova.id, { name: 'Morning brief', task: 'Brief me', daily: '09:00' })
  engine.tick()
  const routine = (): { nextAt: number; zone?: string } => engine.list()[0].routines[0]
  assert.equal(routine().zone, 'America/New_York')
  assert.equal(hhmm(routine().nextAt), '10/5 09:00')
  const inNewYork = routine().nextAt

  // The user flies to Tokyo: the same instant, a different wall clock.
  process.env.TZ = 'Asia/Tokyo'
  zone = 'Asia/Tokyo'
  engine.tick()
  assert.equal(routine().zone, 'Asia/Tokyo')
  // 07:00 in New York is already 20:00 in Tokyo, so the next 9:00 there is tomorrow's —
  // not the old instant, which would have fired at 22:00 Tokyo time tonight.
  assert.equal(hhmm(routine().nextAt), '10/6 09:00', '"9:00" now means 9:00 in Tokyo')
  assert.notEqual(routine().nextAt, inNewYork)
  assert.equal(hhmm(inNewYork), '10/5 22:00', 'the old instant, seen from Tokyo, was 22:00 tonight')
})
