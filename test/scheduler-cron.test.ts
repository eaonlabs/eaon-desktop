import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cronNext, cronPrev, describeCron, parseCron, type Cron } from '@shared/cron'
import { countSlots, describeSchedule, latestDue, nextRunAfter, planDue, scheduleError, type Schedule } from '@shared/scheduler'

/**
 * Cron schedules. Local time is pinned to New York, as in
 * scheduler-schedule.test.ts: in 2026 clocks spring forward on Sunday 8 March
 * (02:00 → 03:00) and fall back on Sunday 1 November (02:00 → 01:00).
 * Expected instants carry explicit offsets.
 */
process.env.TZ = 'America/New_York'

const at = (iso: string): number => Date.parse(iso)
const cron = (expr: string, tz?: string): Schedule => ({ kind: 'cron', expr, ...(tz ? { tz } : {}) })
const parsed = (expr: string): Cron => {
  const result = parseCron(expr)
  if (typeof result === 'string') throw new Error(result)
  return result
}

test('parsing: values, ranges, lists, steps, names and shorthands', () => {
  const c = parsed('*/15 9-17/4 1,15 JAN-MAR mon-fri')
  assert.deepEqual(c.minutes, [0, 15, 30, 45])
  assert.deepEqual(c.hours, [9, 13, 17])
  assert.deepEqual([...c.days], [1, 15])
  assert.deepEqual([...c.months], [1, 2, 3])
  assert.deepEqual([...c.weekdays], [1, 2, 3, 4, 5])
  assert.equal(c.anyDay, false)
  assert.deepEqual([...parsed('0 0 * * 7').weekdays], [0], '7 is Sunday too')
  assert.deepEqual(parsed('5/20 * * * *').minutes, [5, 25, 45], 'a single start with a step runs to the end')
  assert.deepEqual(parsed('@daily').hours, [0])
  assert.deepEqual(parsed('  @Weekly ').weekdays, new Set([0]))
})

test('parsing: mistakes say what is wrong', () => {
  assert.match(parseCron('0 9 * *') as string, /five fields/)
  assert.match(parseCron('60 * * * *') as string, /minute must be between 0 and 59/)
  assert.match(parseCron('0 9-5 * * *') as string, /runs backwards/)
  assert.match(parseCron('0 9 * * funday') as string, /day of the week/)
  assert.match(parseCron('*/0 * * * *') as string, /step must be at least 1/)
  assert.match(parseCron('@sometimes') as string, /shorthand/)
})

test('next run: strictly after, rolling over hours, days, months and years', () => {
  // Wednesday 23 September 2026.
  assert.equal(nextRunAfter(cron('0 9 * * 1-5'), at('2026-09-23T08:00:00-04:00')), at('2026-09-23T09:00:00-04:00'))
  assert.equal(nextRunAfter(cron('0 9 * * 1-5'), at('2026-09-23T09:00:00-04:00')), at('2026-09-24T09:00:00-04:00'))
  assert.equal(nextRunAfter(cron('0 9 * * 1-5'), at('2026-09-25T09:00:00-04:00')), at('2026-09-28T09:00:00-04:00'), 'Friday → Monday')
  assert.equal(nextRunAfter(cron('*/15 * * * *'), at('2026-09-23T08:07:30-04:00')), at('2026-09-23T08:15:00-04:00'))
  assert.equal(nextRunAfter(cron('@monthly'), at('2026-12-15T12:00:00-05:00')), at('2027-01-01T00:00:00-05:00'))
  assert.equal(nextRunAfter(cron('0 12 29 2 *'), at('2026-03-01T00:00:00-05:00')), at('2028-02-29T12:00:00-05:00'), 'leap day')
  assert.equal(nextRunAfter(cron('0 0 31 * *'), at('2026-09-01T00:00:00-04:00')), at('2026-10-31T00:00:00-04:00'), 'months without a 31st are skipped')
})

test('both day fields restricted: either one matches, as in Vixie cron', () => {
  // The 1st of the month or any Monday. Thursday 1 October, then Monday 5 October.
  const s = cron('0 8 1 * 1')
  assert.equal(nextRunAfter(s, at('2026-09-30T12:00:00-04:00')), at('2026-10-01T08:00:00-04:00'))
  assert.equal(nextRunAfter(s, at('2026-10-01T08:00:00-04:00')), at('2026-10-05T08:00:00-04:00'))
  // A step on one field leaves it open: "every other day, Mondays" means Mondays.
  assert.equal(nextRunAfter(cron('0 8 */2 * 1'), at('2026-09-30T12:00:00-04:00')), at('2026-10-05T08:00:00-04:00'))
})

test('daylight saving: a skipped time runs just after the gap, a repeated one once', () => {
  assert.equal(nextRunAfter(cron('30 2 * * *'), at('2026-03-07T03:00:00-05:00')), at('2026-03-08T03:30:00-04:00'))
  const first = nextRunAfter(cron('30 1 * * *'), at('2026-10-31T12:00:00-04:00'))
  assert.equal(first, at('2026-11-01T01:30:00-04:00'))
  assert.equal(nextRunAfter(cron('30 1 * * *'), first!), at('2026-11-02T01:30:00-05:00'))
})

test('a zone of its own: the wall clock there, whatever this computer says', () => {
  // 9:00 in London on Monday 28 September (BST, +01:00) is 4:00 in New York.
  assert.equal(nextRunAfter(cron('0 9 * * 1', 'Europe/London'), at('2026-09-27T12:00:00-04:00')), at('2026-09-28T09:00:00+01:00'))
  // After the UK goes back on 25 October (GMT, +00:00), the same 9:00 is an hour later in UTC.
  assert.equal(nextRunAfter(cron('0 9 * * 1', 'Europe/London'), at('2026-10-27T00:00:00Z')), at('2026-11-02T09:00:00Z'))
  // Kolkata is +05:30 all year: half-hour offsets work.
  assert.equal(nextRunAfter(cron('0 10 * * *', 'Asia/Kolkata'), at('2026-09-23T00:00:00Z')), at('2026-09-23T10:00:00+05:30'))
  // London's spring gap: 01:30 on 29 March 2026 doesn't exist there; it runs at 02:30 BST.
  assert.equal(cronNext(parsed('30 1 * * *'), at('2026-03-29T00:00:00Z'), 'Europe/London'), at('2026-03-29T02:30:00+01:00'))
  // London's autumn repeat: 01:30 on 25 October runs at its first occurrence (BST).
  assert.equal(cronNext(parsed('30 1 * * *'), at('2026-10-24T12:00:00Z'), 'Europe/London'), at('2026-10-25T01:30:00+01:00'))
})

test('previous run, for catching up', () => {
  assert.equal(cronPrev(parsed('0 9 * * 1-5'), at('2026-09-28T08:00:00-04:00')), at('2026-09-25T09:00:00-04:00'), 'Monday morning → Friday')
  assert.equal(cronPrev(parsed('0 9 * * 1-5'), at('2026-09-28T09:00:00-04:00')), at('2026-09-28T09:00:00-04:00'), 'at or before')
  assert.equal(cronPrev(parsed('0 9 * * *'), at('2026-09-23T12:00:00Z'), 'Asia/Kolkata'), at('2026-09-23T09:00:00+05:30'))
})

test('catch-up: an every-minute task away for a day runs once, for the latest minute', () => {
  const s = cron('* * * * *')
  const from = at('2026-09-23T08:00:00-04:00')
  const now = at('2026-09-23T20:00:30-04:00')
  assert.equal(latestDue(s, from, now), at('2026-09-23T20:00:00-04:00'))
  assert.equal(countSlots(s, from, now), 12 * 60 + 1)
  const plan = planDue(s, from, now)
  assert.equal(plan.action, 'run')
  assert.equal(plan.action === 'run' && plan.slot, at('2026-09-23T20:00:00-04:00'))
  // A yearly task that came due 3 weeks ago is missed, not run.
  const yearly = cron('0 9 1 9 *')
  const due = at('2026-09-01T09:00:00-04:00')
  assert.deepEqual(planDue(yearly, due, at('2026-09-22T09:00:00-04:00')), { action: 'miss', slot: due, slots: 1 })
})

test('errors for the editor', () => {
  const now = at('2026-09-23T08:00:00-04:00')
  assert.equal(scheduleError(cron('0 9 * * 1-5'), now), null)
  assert.equal(scheduleError(cron('0 9 * * 1-5', 'America/Los_Angeles'), now), null)
  assert.match(scheduleError(cron(''), now)!, /Write a cron expression/)
  assert.match(scheduleError(cron('0 25 * * *'), now)!, /hour/)
  assert.match(scheduleError(cron('0 9 * * *', 'Mars/Olympus'), now)!, /time zone/)
  assert.match(scheduleError(cron('0 9 30 2 *'), now)!, /never runs/)
})

test('descriptions read as sentences where they can', () => {
  assert.equal(describeCron('*/15 * * * *'), 'Every 15 minutes')
  assert.equal(describeCron('* * * * *'), 'Every minute')
  assert.equal(describeCron('0 * * * *'), 'Every hour')
  assert.equal(describeCron('0 */2 * * *'), 'Every 2 hours')
  assert.equal(describeCron('0 9 * * *'), 'Every day at 9:00 AM')
  assert.equal(describeCron('30 8 * * 1-5'), 'Weekdays at 8:30 AM')
  assert.equal(describeCron('0 10 * * 6,0'), 'Weekends at 10:00 AM')
  assert.equal(describeCron('0 9 * * 1'), 'Every Monday at 9:00 AM')
  assert.equal(describeCron('0 9 * * 1,3,5'), 'Mon, Wed, Fri at 9:00 AM')
  assert.equal(describeCron('0 0 1 * *'), 'On the 1st of every month at 12:00 AM')
  assert.equal(describeCron('0 12 25 12 *'), 'Every December 25 at 12:00 PM')
  assert.equal(describeCron('0 9,13,17 * * *'), 'Every day at 9:00 AM, 1:00 PM, 5:00 PM')
  assert.equal(describeCron('0 9-17/2 * * 1-5'), 'Cron 0 9-17/2 * * 1-5')
  assert.equal(describeSchedule(cron('0 9 * * 1-5', 'Europe/London')), 'Weekdays at 9:00 AM (Europe/London)')
})
