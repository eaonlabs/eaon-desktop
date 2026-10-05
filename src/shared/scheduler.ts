import type { AgentMode, Chat, TokenUsage } from './types'

/**
 * Scheduled tasks: the data model and the schedule arithmetic.
 *
 * Shared because both sides need the same answers — the engine in main decides
 * when a task runs, and the page previews "Next run" while the user is still
 * editing. Everything here is pure and uses the machine's local time zone,
 * which is what "every weekday at 9" means to the person who typed it.
 */

export type IntervalUnit = 'minutes' | 'hours'

/** Weekdays use `Date.getDay()` numbering: 0 is Sunday, 6 is Saturday. */
export type Schedule =
  | {
      kind: 'interval'
      every: number
      unit: IntervalUnit
      /**
       * First run. Later runs fall on this grid (startAt + k × period) rather
       * than "period after the last run finished", so a slow run or a late
       * timer never makes the cadence drift. Filled in by the engine.
       */
      startAt?: number
    }
  | { kind: 'daily'; time: string; days: number[] }
  | { kind: 'weekly'; time: string; day: number }
  | { kind: 'once'; at: number }

/**
 * `missed`: a slot that came due while Eaon was closed or the computer
 * asleep, too long ago to be worth running. `skipped`: a slot that came due
 * while the task's previous run was still going (see TASK_OVERLAP).
 */
export type RunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'missed' | 'skipped'

/**
 * 'catch-up' is a slot that came due while Eaon was closed or the Mac was
 * asleep, run late; 'retry' is the user re-running a run that didn't succeed.
 */
export type RunTrigger = 'schedule' | 'manual' | 'catch-up' | 'retry'

/**
 * Why a slot ran late, was missed or was skipped. `closed`: Eaon wasn't
 * running when it came due. `asleep`: the computer was. `late`: Eaon was
 * running but got to it late (a busy or stalled process). `overlap`: the
 * previous run was still going.
 */
export type RunCause = 'closed' | 'asleep' | 'late' | 'overlap'

/**
 * One execution of a task: its own record, apart from the task's
 * definition, kept in `scheduled-runs.json`. Editing a task never touches
 * its runs; deleting it removes them (the chats they wrote stay).
 */
export interface TaskRun {
  id: string
  /** The task it belongs to. Missing on runs saved inside the task by 2026.6.1 and earlier. */
  taskId?: string
  startedAt: number
  finishedAt: number | null
  status: RunStatus
  /** The chat this run wrote into; null for a missed or skipped slot. */
  chatId: string | null
  trigger: RunTrigger
  error?: string
  /** First line of the reply, for the run history. */
  summary?: string
  /** Why it ran late, or didn't run. */
  cause?: RunCause
  /**
   * The slot it was for, when that differs from `startedAt` (a catch-up runs
   * after its slot). For a skipped record, the first slot skipped.
   */
  slotAt?: number
  /**
   * Slots folded into this record: a catch-up that stands for several missed
   * slots runs once, and a skipped record counts every slot skipped while
   * the same run went on. 1 when absent.
   */
  slots?: number
  /** Tokens the run used, as the provider reported them. */
  tokens?: TokenUsage
  /** The run this one retried. */
  retryOf?: string
  /** For a skipped record: the run that was still going. */
  blockedBy?: string
}

export interface TaskModel {
  providerId: string
  modelId: string
}

export interface ScheduledTask {
  id: string
  name: string
  prompt: string
  schedule: Schedule
  mode: AgentMode
  /** Null runs on whatever model the app is set to when the task fires. */
  model: TaskModel | null
  /** Work folder for Work runs; null uses the Work tab's folder. */
  cwd: string | null
  /**
   * Work runs have nobody to approve changes. Off, every mutating tool is
   * refused; on, ordinary changes run and risky ones are still refused.
   */
  allowChanges: boolean
  enabled: boolean
  createdAt: number
  updatedAt: number
  /** Null while disabled, or once a one-off task has run. */
  nextRunAt: number | null
  lastRunAt: number | null
  lastStatus: RunStatus | null
  /**
   * Newest first, at most HISTORY_LIMIT. Joined in from the runs file for
   * the page and the tool; never saved with the task.
   */
  history: TaskRun[]
  /**
   * The time zone `nextRunAt` was worked out in. A daily or weekly task
   * means the wall clock where the user is, so when the zone changes
   * (travel, or a manual change) its next run is worked out again.
   */
  zone?: string
}

/** What the editor (or the `schedule` tool) sends to create or update a task. */
export interface TaskDraft {
  id?: string
  name: string
  prompt: string
  schedule: Schedule
  mode: AgentMode
  model: TaskModel | null
  cwd: string | null
  allowChanges: boolean
  enabled: boolean
}

/** Runs kept per task, newest first. */
export const HISTORY_LIMIT = 50

/**
 * A slot missed while the app was closed or the machine asleep runs once when
 * Eaon is back, if it was missed by less than this. Older than that, the
 * result would be stale (yesterday's news digest) and running it would only
 * surprise the user, so it is recorded as missed instead.
 */
export const CATCH_UP_WINDOW_MS = 24 * 60 * 60 * 1000

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

export const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6]
export const WORKDAYS = [1, 2, 3, 4, 5]
export const WEEKEND = [0, 6]
export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
export const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function periodMs(schedule: Extract<Schedule, { kind: 'interval' }>): number {
  return Math.max(1, schedule.every) * (schedule.unit === 'hours' ? 60 : 1) * MINUTE
}

/** "09:30" → [9, 30]; null for anything that is not a valid 24-hour time. */
export function parseTime(time: string): [number, number] | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim())
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return [hours, minutes]
}

function daysOf(schedule: Extract<Schedule, { kind: 'daily' | 'weekly' }>): number[] {
  return schedule.kind === 'weekly' ? [schedule.day] : schedule.days
}

/**
 * The first time the schedule fires strictly after `after`, or null when it
 * never will again (a one-off whose time has passed).
 *
 * Daily and weekly times are built with the local-time Date constructor, day
 * by day, rather than by adding 24 hours: across a daylight-saving change a
 * day is 23 or 25 hours long and "9:00 tomorrow" is not 24 hours away. On the
 * spring-forward day a time inside the skipped hour (02:30) lands just after
 * it (03:30); on the fall-back day a repeated time runs at its first
 * occurrence only, because the next candidate must be later than that one.
 */
export function nextRunAfter(schedule: Schedule, after: number): number | null {
  switch (schedule.kind) {
    case 'once':
      return schedule.at > after ? schedule.at : null
    case 'interval': {
      const period = periodMs(schedule)
      const start = schedule.startAt ?? after + period
      if (start > after) return start
      return start + (Math.floor((after - start) / period) + 1) * period
    }
    case 'daily':
    case 'weekly': {
      const time = parseTime(schedule.time)
      const days = daysOf(schedule)
      if (!time || days.length === 0) return null
      const base = new Date(after)
      // Eight days always reaches the next matching weekday, even when today's
      // slot has already passed.
      for (let offset = 0; offset <= 8; offset++) {
        const year = base.getFullYear()
        const month = base.getMonth()
        const date = base.getDate() + offset
        const candidate = new Date(year, month, date, time[0], time[1], 0, 0).getTime()
        if (candidate <= after) continue
        // Weekday of the calendar day, read at noon so no DST shift can move it.
        if (days.includes(new Date(year, month, date, 12).getDay())) return candidate
      }
      return null
    }
  }
}

/**
 * The most recent slot in [from, now], where `from` is the slot the task was
 * waiting for. Null when that slot is still in the future. Used to decide
 * whether a late task is worth catching up: a daily task after a week away
 * catches up on this morning's slot, not the one from seven days ago.
 */
export function latestDue(schedule: Schedule, from: number, now: number): number | null {
  if (from > now) return null
  if (schedule.kind === 'once') return from
  if (schedule.kind === 'interval') {
    const period = periodMs(schedule)
    return from + Math.floor((now - from) / period) * period
  }
  let slot = from
  // Every daily or weekly schedule fires at least once a week, so the latest
  // slot is within the last eight days — no need to walk months of them.
  if (now - slot > 8 * DAY) {
    const recent = nextRunAfter(schedule, now - 8 * DAY)
    if (recent !== null && recent <= now) slot = recent
  }
  for (let guard = 0; guard < 64; guard++) {
    const next = nextRunAfter(schedule, slot)
    if (next === null || next > now) break
    slot = next
  }
  return slot
}

/**
 * How many slots fall in [from, to], counting `from` itself when it is a
 * slot. Capped: past the cap the exact number stops mattering to anyone
 * reading "caught up once for N missed runs".
 */
export function countSlots(schedule: Schedule, from: number, to: number, cap = 10_000): number {
  if (from > to) return 0
  if (schedule.kind === 'once') return schedule.at >= from && schedule.at <= to ? 1 : 0
  if (schedule.kind === 'interval') {
    const period = periodMs(schedule)
    const first = nextRunAfter(schedule, from - 1)
    if (first === null || first > to) return 0
    return Math.min(cap, Math.floor((to - first) / period) + 1)
  }
  let count = 0
  for (let at = nextRunAfter(schedule, from - 1); at !== null && at <= to && count < cap; at = nextRunAfter(schedule, at)) count++
  return count
}

/**
 * What happens when a slot comes due while the task's previous run is still
 * going.
 *
 * - `skip`: the slot doesn't run, and that is recorded ("Skipped: the
 *   previous run was still going"). Scheduled tasks use this: a digest that
 *   took longer than its interval should not pile up copies of itself.
 * - `queue`: it runs once the previous run ends, at most one waiting.
 * - `replace`: the previous run is stopped and the new one starts.
 * - `parallel`: it starts alongside.
 *
 * Shared so Workers' routines can make the same decision the same way.
 */
export type OverlapPolicy = 'skip' | 'queue' | 'replace' | 'parallel'

export const TASK_OVERLAP: OverlapPolicy = 'skip'

export type OverlapAction = 'start' | 'skip' | 'queue' | 'replace'

export function overlapAction(policy: OverlapPolicy, running: boolean, queued = false): OverlapAction {
  if (!running || policy === 'parallel') return 'start'
  if (policy === 'replace') return 'replace'
  // A slot already waiting covers this one: never more than one queued.
  if (policy === 'queue') return queued ? 'skip' : 'queue'
  return 'skip'
}

/** What to do about a task whose stored next slot is `nextRunAt`, at `now`. */
export type DuePlan =
  | { action: 'wait' }
  /** Run once, for `slot` (the latest one due). `slots` counts every due slot folded into this run, `slot` included. */
  | { action: 'run'; slot: number; slots: number; late: boolean }
  /** Too late to be worth running: record it as missed, once, standing for `slots` slots. */
  | { action: 'miss'; slot: number; slots: number }

/** A slot run more than this after it came due counts as late (a catch-up) rather than on time. */
export const LATE_MS = 2 * 60_000

/**
 * The catch-up rule, in one place: however many slots came due while Eaon
 * was closed or the computer asleep, the task runs at most once, for the
 * latest of them — and only if that one is less than a day old. Waking
 * after twelve missed quarter-hours runs one, never twelve.
 */
export function planDue(schedule: Schedule, nextRunAt: number, now: number, catchUpWindowMs = CATCH_UP_WINDOW_MS): DuePlan {
  if (nextRunAt > now) return { action: 'wait' }
  const slot = latestDue(schedule, nextRunAt, now) ?? nextRunAt
  const slots = Math.max(1, countSlots(schedule, nextRunAt, now))
  if (now - slot > catchUpWindowMs) return { action: 'miss', slot, slots }
  return { action: 'run', slot, slots, late: now - slot > LATE_MS }
}

/** Formats a time of day for a reason line; injectable so main and the page agree. */
type Clock = (at: number) => string
const defaultClock: Clock = (at) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

/**
 * The line under a run that says why it ran late, or didn't run.
 * `machine` is what to call the computer: "Mac" on macOS.
 */
export function runReason(run: TaskRun, machine = 'computer', clock: Clock = defaultClock): string | null {
  const slot = run.slotAt ?? run.startedAt
  const slots = run.slots ?? 1
  if (run.status === 'skipped') {
    const times = slots > 1 ? ` (${slots} times)` : ''
    return `Skipped${times}: the previous run was still going.`
  }
  if (run.status === 'missed') {
    const why =
      run.cause === 'asleep'
        ? `Missed while your ${machine} was asleep`
        : run.cause === 'late'
          ? 'Missed: Eaon got to it too late'
          : 'Missed while Eaon wasn’t running'
    const more = slots > 1 ? ` (${slots} times)` : ''
    return `${why}${more}. It was more than a day late, so it didn’t run.`
  }
  if (run.trigger === 'catch-up') {
    const why = run.cause === 'asleep' ? `your ${machine} was asleep` : run.cause === 'closed' ? 'Eaon wasn’t running' : 'Eaon was busy'
    if (slots > 1) return `Ran once for ${slots} runs missed while ${why}, not ${slots} times.`
    return `Ran late: ${why} at ${clock(slot)}.`
  }
  return null
}

/** Null when the schedule is usable; otherwise what is wrong with it, for the user. */
export function scheduleError(schedule: Schedule, now: number, enabled = true): string | null {
  switch (schedule.kind) {
    case 'interval':
      if (!Number.isFinite(schedule.every) || schedule.every < 1 || Math.floor(schedule.every) !== schedule.every) {
        return 'The interval must be a whole number of at least 1.'
      }
      if (periodMs(schedule) > 31 * DAY) return 'The interval can be at most 31 days — use a weekly schedule instead.'
      return null
    case 'daily':
    case 'weekly':
      if (!parseTime(schedule.time)) return 'Pick a time of day.'
      if (daysOf(schedule).length === 0) return 'Pick at least one day.'
      if (daysOf(schedule).some((d) => !WEEKDAYS.includes(d))) return 'Days must be between Sunday (0) and Saturday (6).'
      return null
    case 'once':
      if (!Number.isFinite(schedule.at)) return 'Pick a date and time.'
      if (enabled && schedule.at <= now) return 'That time has already passed.'
      return null
  }
}

export function draftError(draft: TaskDraft, now: number): string | null {
  if (!draft.name.trim()) return 'Give the task a name.'
  if (!draft.prompt.trim()) return 'Write the prompt the task should run.'
  return scheduleError(draft.schedule, now, draft.enabled)
}

function formatClock(time: string): string {
  const parsed = parseTime(time)
  if (!parsed) return time
  return new Date(2000, 0, 1, parsed[0], parsed[1]).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function sameDays(a: number[], b: number[]): boolean {
  return a.length === b.length && b.every((d) => a.includes(d))
}

/** "Weekdays at 9:00 AM", "Every 15 minutes", "Once on Thu, Sep 24 at 9:00 AM". */
export function describeSchedule(schedule: Schedule): string {
  switch (schedule.kind) {
    case 'interval': {
      const unit = schedule.unit === 'hours' ? 'hour' : 'minute'
      return schedule.every === 1 ? `Every ${unit}` : `Every ${schedule.every} ${unit}s`
    }
    case 'weekly':
      return `Every ${DAY_NAMES[schedule.day] ?? '?'} at ${formatClock(schedule.time)}`
    case 'daily': {
      const at = formatClock(schedule.time)
      const days = [...new Set(schedule.days)].sort()
      if (sameDays(days, WEEKDAYS)) return `Every day at ${at}`
      if (sameDays(days, WORKDAYS)) return `Weekdays at ${at}`
      if (sameDays(days, WEEKEND)) return `Weekends at ${at}`
      if (days.length === 1) return `Every ${DAY_NAMES[days[0]]} at ${at}`
      // Monday-first reads the way a week is usually written.
      const ordered = [...days.filter((d) => d !== 0), ...days.filter((d) => d === 0)]
      return `${ordered.map((d) => DAY_SHORT[d]).join(', ')} at ${at}`
    }
    case 'once':
      return `Once on ${new Date(schedule.at).toLocaleString([], {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      })}`
  }
}

/**
 * Folds a run's chat into the copy the renderer (or chats.json) already has.
 *
 * The scheduler owns the messages it created and nothing else: it replaces
 * those by id and appends any the target lacks, but keeps the chat's own
 * fields — a rename, a pin, the unread flag cleared by opening it — and any
 * follow-up the user typed into the chat while the run was still going.
 */
export function mergeRunChat(existing: Chat | undefined, incoming: Chat): Chat {
  if (!existing) return incoming
  const messages = existing.messages.slice()
  for (const message of incoming.messages) {
    const index = messages.findIndex((m) => m.id === message.id)
    if (index === -1) messages.push(message)
    else messages[index] = message
  }
  return { ...existing, messages, updatedAt: Math.max(existing.updatedAt, incoming.updatedAt) }
}
