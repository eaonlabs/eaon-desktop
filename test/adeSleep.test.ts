import { test } from 'node:test'
import assert from 'node:assert/strict'
import { autoSleepLabel, isAsleep, isAwake, shouldSleep, type PaneLife } from '@shared/adeSleep'

/* Sleeping ADE sessions (shared/adeSleep.ts): which are asleep, and which auto-sleep ends. */

const now = 10_000_000
const pane = (extra: Partial<PaneLife> = {}): PaneLife => ({ known: true, status: 'idle', lastData: now - 2 * 3600_000, serving: false, ...extra })

test('asleep: panes, none with a terminal running; a session with no panes is neither', () => {
  assert.equal(isAsleep([pane({ known: false }), pane({ known: false })]), true)
  assert.equal(isAsleep([pane({ status: 'exited' })]), true)
  assert.equal(isAsleep([pane({ known: false }), pane()]), false)
  assert.equal(isAsleep([]), false)
  assert.equal(isAwake([pane()]), true)
  assert.equal(isAwake([pane({ known: false })]), false)
})

test('auto-sleep: quiet long enough, not open, nothing working or serving', () => {
  const opts = { current: false, minutes: 30, now }
  assert.equal(shouldSleep([pane(), pane()], opts), true)
  // Off, the open session, or already asleep: never.
  assert.equal(shouldSleep([pane()], { ...opts, minutes: 0 }), false)
  assert.equal(shouldSleep([pane()], { ...opts, current: true }), false)
  assert.equal(shouldSleep([pane({ known: false })], opts), false)
  // An agent working, a shell starting, a dev server up: left alone.
  assert.equal(shouldSleep([pane(), pane({ status: 'working' })], opts), false)
  // A shell that only printed its prompt stays "starting": quiet long enough, it sleeps; just opened, it doesn't.
  assert.equal(shouldSleep([pane({ status: 'starting' })], opts), true)
  assert.equal(shouldSleep([pane({ status: 'starting', lastData: now - 5_000 })], opts), false)
  assert.equal(shouldSleep([pane({ serving: true })], opts), false)
  // One pane printed 10 minutes ago: not quiet for 30 yet.
  assert.equal(shouldSleep([pane(), pane({ lastData: now - 10 * 60_000 })], opts), false)
  // A pane that ended doesn't keep it awake.
  assert.equal(shouldSleep([pane(), pane({ status: 'exited', lastData: now })], opts), true)
})

test('labels', () => {
  assert.equal(autoSleepLabel(0), 'Never')
  assert.equal(autoSleepLabel(15), 'After 15 minutes')
  assert.equal(autoSleepLabel(60), 'After 1 hour')
  assert.equal(autoSleepLabel(120), 'After 2 hours')
})
