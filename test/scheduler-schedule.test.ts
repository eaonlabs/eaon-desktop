import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  describeSchedule,
  latestDue,
  mergeRunChat,
  nextRunAfter,
  scheduleError,
  WEEKDAYS,
  WORKDAYS,
  type Schedule
} from '@shared/scheduler'
import type { Chat } from '@shared/types'

/**
 * Next-run arithmetic. Pinned to New York so the daylight-saving cases are
 * real: in 2026 clocks spring forward on Sunday 8 March (02:00 → 03:00) and
 * fall back on Sunday 1 November (02:00 → 01:00). Expected instants are
 * written with explicit offsets so the test does not lean on the code's own
 * local-time handling. Node picks up a TZ change at runtime.
 */
process.env.TZ = 'America/New_York'

const at = (iso: string): number => Date.parse(iso)
const HOUR = 3_600_000
const daily = (time: string, days = WEEKDAYS): Schedule => ({ kind: 'daily', time, days })

test('the time zone is pinned', () => {
  assert.equal(new Date(at('2026-01-15T12:00:00Z')).getTimezoneOffset(), 300)
  assert.equal(new Date(at('2026-07-15T12:00:00Z')).getTimezoneOffset(), 240)
})

test('daily: later today, else tomorrow; strictly after', () => {
  // Wednesday 23 September 2026.
  assert.equal(nextRunAfter(daily('09:00'), at('2026-09-23T08:00:00-04:00')), at('2026-09-23T09:00:00-04:00'))
  assert.equal(nextRunAfter(daily('09:00'), at('2026-09-23T09:00:00-04:00')), at('2026-09-24T09:00:00-04:00'))
  assert.equal(nextRunAfter(daily('09:00'), at('2026-09-23T21:30:00-04:00')), at('2026-09-24T09:00:00-04:00'))
  // Month and year roll-over.
  assert.equal(nextRunAfter(daily('00:05'), at('2026-12-31T23:00:00-05:00')), at('2027-01-01T00:05:00-05:00'))
})

test('weekdays skip the weekend', () => {
  const weekdays = daily('09:00', WORKDAYS)
  // Friday after the slot → Monday.
  assert.equal(nextRunAfter(weekdays, at('2026-09-25T09:30:00-04:00')), at('2026-09-28T09:00:00-04:00'))
  // Saturday → Monday.
  assert.equal(nextRunAfter(weekdays, at('2026-09-26T07:00:00-04:00')), at('2026-09-28T09:00:00-04:00'))
  // Custom days: Tue and Thu only, from Thursday afternoon → next Tuesday.
  assert.equal(nextRunAfter(daily('18:15', [2, 4]), at('2026-09-24T19:00:00-04:00')), at('2026-09-29T18:15:00-04:00'))
})

test('weekly: same weekday next week once this week has passed', () => {
  const monday: Schedule = { kind: 'weekly', time: '09:00', day: 1 }
  assert.equal(nextRunAfter(monday, at('2026-09-28T09:00:00-04:00')), at('2026-10-05T09:00:00-04:00'))
  assert.equal(nextRunAfter(monday, at('2026-09-23T12:00:00-04:00')), at('2026-09-28T09:00:00-04:00'))
})

test('DST: a daily time stays on the wall clock, so the gap is 23 h in spring and 25 h in autumn', () => {
  const nine = daily('09:00')
  const saturday = at('2026-03-07T09:00:00-05:00')
  const sunday = nextRunAfter(nine, saturday)!
  assert.equal(sunday, at('2026-03-08T09:00:00-04:00'))
  assert.equal(sunday - saturday, 23 * HOUR)

  const halloween = at('2026-10-31T09:00:00-04:00')
  const november = nextRunAfter(nine, halloween)!
  assert.equal(november, at('2026-11-01T09:00:00-05:00'))
  assert.equal(november - halloween, 25 * HOUR)
})

test('DST: a time inside the skipped hour runs just after it, and is back to normal the next day', () => {
  const twoThirty = daily('02:30')
  const first = nextRunAfter(twoThirty, at('2026-03-07T03:00:00-05:00'))!
  // 02:30 does not exist on 8 March; it lands at 03:30 EDT rather than being skipped.
  assert.equal(first, at('2026-03-08T03:30:00-04:00'))
  assert.equal(nextRunAfter(twoThirty, first), at('2026-03-09T02:30:00-04:00'))
})

test('DST: a time in the repeated hour runs once, at its first occurrence', () => {
  const oneThirty = daily('01:30')
  const first = nextRunAfter(oneThirty, at('2026-10-31T02:00:00-04:00'))!
  assert.equal(first, at('2026-11-01T01:30:00-04:00'))
  // Not 01:30 EST an hour later — the next run is the following night.
  assert.equal(nextRunAfter(oneThirty, first), at('2026-11-02T01:30:00-05:00'))
  // Even when asked from inside the repeated hour, after the second 01:30.
  assert.equal(nextRunAfter(oneThirty, at('2026-11-01T01:45:00-05:00')), at('2026-11-02T01:30:00-05:00'))
})

test('interval: fixed grid from its start, absolute time across DST', () => {
  const start = at('2026-09-23T10:00:00-04:00')
  const every15: Schedule = { kind: 'interval', every: 15, unit: 'minutes', startAt: start }
  assert.equal(nextRunAfter(every15, start - 1), start)
  assert.equal(nextRunAfter(every15, start), start + 15 * 60_000)
  // A late check lands on the grid, not "15 minutes after whenever we looked".
  assert.equal(nextRunAfter(every15, start + 20 * 60_000), start + 30 * 60_000)

  const hourly: Schedule = { kind: 'interval', every: 1, unit: 'hours', startAt: at('2026-11-01T01:00:00-04:00') }
  // The wall clock shows 01:00 twice; the interval is still one real hour.
  assert.equal(nextRunAfter(hourly, at('2026-11-01T01:00:00-04:00')), at('2026-11-01T01:00:00-05:00'))
})

test('once: fires at its time, then never again', () => {
  const once: Schedule = { kind: 'once', at: at('2026-09-24T09:00:00-04:00') }
  assert.equal(nextRunAfter(once, at('2026-09-23T12:00:00-04:00')), once.at)
  assert.equal(nextRunAfter(once, once.at), null)
})

test('latestDue picks the most recent missed slot, not the first one', () => {
  // A daily 9:00 task last waiting for Monday, checked on Thursday at 10:00 → Thursday's slot.
  const due = latestDue(daily('09:00'), at('2026-09-21T09:00:00-04:00'), at('2026-09-24T10:00:00-04:00'))
  assert.equal(due, at('2026-09-24T09:00:00-04:00'))
  // Before today's slot → yesterday's.
  assert.equal(latestDue(daily('09:00'), at('2026-09-21T09:00:00-04:00'), at('2026-09-24T08:00:00-04:00')), at('2026-09-23T09:00:00-04:00'))
  // Months away (the slow path): still the latest weekly slot.
  const monday: Schedule = { kind: 'weekly', time: '09:00', day: 1 }
  assert.equal(latestDue(monday, at('2026-01-05T09:00:00-05:00'), at('2026-09-24T10:00:00-04:00')), at('2026-09-21T09:00:00-04:00'))
  // Interval: on the grid.
  const start = at('2026-09-23T10:00:00-04:00')
  const every15: Schedule = { kind: 'interval', every: 15, unit: 'minutes', startAt: start }
  assert.equal(latestDue(every15, start, start + 47 * 60_000), start + 45 * 60_000)
  // Not due yet.
  assert.equal(latestDue(daily('09:00'), at('2026-09-24T09:00:00-04:00'), at('2026-09-24T08:00:00-04:00')), null)
})

test('scheduleError explains what is wrong', () => {
  const now = at('2026-09-23T12:00:00-04:00')
  assert.equal(scheduleError(daily('09:00'), now), null)
  assert.match(scheduleError(daily('25:00'), now)!, /time/)
  assert.match(scheduleError(daily('09:00', []), now)!, /day/)
  assert.match(scheduleError({ kind: 'interval', every: 0, unit: 'minutes' }, now)!, /at least 1/)
  assert.match(scheduleError({ kind: 'interval', every: 1.5, unit: 'hours' }, now)!, /whole number/)
  assert.match(scheduleError({ kind: 'once', at: now - 1 }, now)!, /passed/)
  // A disabled one-off in the past is fine: it is just a record of what ran.
  assert.equal(scheduleError({ kind: 'once', at: now - 1 }, now, false), null)
})

test('describeSchedule reads naturally', () => {
  assert.match(describeSchedule(daily('09:00', WORKDAYS)), /^Weekdays at 9:00/)
  assert.match(describeSchedule(daily('09:00')), /^Every day at 9:00/)
  assert.match(describeSchedule(daily('09:00', [1, 3, 5])), /^Mon, Wed, Fri at/)
  assert.match(describeSchedule(daily('09:00', [0, 1])), /^Mon, Sun at/)
  assert.equal(describeSchedule({ kind: 'interval', every: 1, unit: 'hours' }), 'Every hour')
  assert.equal(describeSchedule({ kind: 'interval', every: 15, unit: 'minutes' }), 'Every 15 minutes')
  assert.match(describeSchedule({ kind: 'weekly', time: '17:30', day: 5 }), /^Every Friday at 5:30/)
})

test('mergeRunChat keeps the user’s edits and follow-ups', () => {
  const base: Chat = {
    id: 'c',
    workspaceId: 'work',
    projectId: null,
    title: 'Digest',
    messages: [
      { id: 'u', role: 'user', parts: [{ type: 'text', text: 'go' }], createdAt: 1 },
      { id: 'a', role: 'assistant', parts: [], createdAt: 2 }
    ],
    createdAt: 1,
    updatedAt: 2,
    archived: false,
    pinned: false,
    unread: true,
    modelId: 'm',
    effort: 'medium'
  }
  const renderer: Chat = {
    ...base,
    title: 'Renamed',
    pinned: true,
    unread: false,
    messages: [...base.messages, { id: 'f', role: 'user', parts: [{ type: 'text', text: 'follow-up' }], createdAt: 5 }]
  }
  const final: Chat = { ...base, updatedAt: 9, messages: [base.messages[0], { ...base.messages[1], parts: [{ type: 'text', text: 'done' }] }] }
  const merged = mergeRunChat(renderer, final)
  assert.equal(merged.title, 'Renamed')
  assert.equal(merged.pinned, true)
  assert.equal(merged.unread, false)
  assert.deepEqual(merged.messages.map((m) => m.id), ['u', 'a', 'f'])
  assert.deepEqual(merged.messages[1].parts, [{ type: 'text', text: 'done' }])
  assert.equal(merged.updatedAt, 9)
  assert.equal(mergeRunChat(undefined, final), final)
})
