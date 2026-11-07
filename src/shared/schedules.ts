import { describeSchedule, type RunStatus, type ScheduledTask } from './scheduler'
import type { Worker } from './workers'

/**
 * Every schedule in one list: automations (Scheduled), the routines workers
 * run on a clock, and the wake-ups a worker set for itself. The page shows
 * them together, each with when it runs next, how its last run went, and a
 * way to pause it. Pure, so the same answers come from a test as from the page.
 */

export type ScheduleKind = 'automation' | 'routine' | 'wakeup'

export interface ScheduleRow {
  /** Stable across refreshes, so a row doesn't jump while it is clicked. */
  key: string
  kind: ScheduleKind
  name: string
  /** The worker it belongs to; absent for an automation. */
  worker?: { id: string; name: string; color: string }
  /** "Every weekday at 9:00 AM", "Every 30 min", "Daily at 08:30". */
  cadence: string
  /** When it runs next; null when it won't (paused, finished, or its worker is paused). */
  nextAt: number | null
  /** Why `nextAt` is empty, in a few words. */
  nextNote: string | null
  /** The user paused this one; `pause` can resume it. */
  paused: boolean
  /** The way to pause it: an automation or routine can be paused; a wake-up only cancelled; a purchase is managed elsewhere. */
  control: 'pause' | 'stop' | null
  /** What a row without a control says about where to change it. */
  controlNote?: string
  last: { status: RunStatus; at: number; detail?: string } | null
  automationId?: string
  workerId?: string
  routineId?: string
  threadId?: string
}

/** "30 min", "2 hr", "1 day". */
export function everyText(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes} min`
  if (minutes % 1440 === 0) return `${minutes / 1440} ${minutes === 1440 ? 'day' : 'days'}`
  if (minutes % 60 === 0) return `${minutes / 60} hr`
  return `${minutes} min`
}

const firstLine = (text: string | undefined): string | undefined => {
  const line = text?.split('\n').find((l) => l.trim())?.trim()
  return line ? (line.length > 140 ? `${line.slice(0, 139)}…` : line) : undefined
}

function automationRow(task: ScheduledTask, now: number): ScheduleRow {
  const last = task.history.find((r) => r.status !== 'skipped') ?? task.history[0]
  const finished = task.schedule.kind === 'once' && !task.enabled && (task.lastRunAt !== null || task.schedule.at <= now)
  const running = last?.status === 'running'
  return {
    key: `automation:${task.id}`,
    kind: 'automation',
    name: task.name,
    cadence: describeSchedule(task.schedule),
    nextAt: task.enabled ? task.nextRunAt : null,
    nextNote: task.enabled ? null : finished ? 'Done' : 'Paused',
    paused: !task.enabled && !finished,
    control: 'pause',
    last: last ? { status: last.status, at: running ? last.startedAt : (last.finishedAt ?? last.startedAt), detail: firstLine(last.status === 'failed' || last.status === 'cancelled' ? last.error : (last.summary ?? last.error)) } : null,
    automationId: task.id
  }
}

function routineRows(worker: Worker): ScheduleRow[] {
  const who = { id: worker.id, name: worker.name, color: worker.color }
  return (worker.routines ?? [])
    // Following one order a purchase placed isn't a schedule the user made.
    .filter((r) => !r.watch)
    .map((routine): ScheduleRow => {
      const when = routine.daily ? `Daily at ${routine.daily}` : routine.everyMs ? `Every ${everyText(routine.everyMs)}` : 'Once'
      const last = routine.runs[routine.runs.length - 1]
      const buys = Boolean(routine.purchase)
      const pausable = !buys && Boolean(routine.everyMs || routine.daily)
      const heldByWorker = worker.paused && !routine.paused
      return {
        key: `routine:${worker.id}:${routine.id}`,
        kind: 'routine',
        name: routine.name,
        worker: who,
        cadence: `${when}${routine.marketHours ? ' while the market is open' : ''}`,
        nextAt: routine.paused || worker.paused ? null : routine.nextAt,
        nextNote: routine.paused ? 'Paused' : heldByWorker ? `${worker.name} is paused` : null,
        paused: routine.paused === true,
        control: pausable ? 'pause' : null,
        ...(buys ? { controlNote: `A purchase schedule: change or stop it on ${worker.name}’s page` } : !pausable ? { controlNote: 'Runs once' } : {}),
        last: last ? { status: last.ok ? 'succeeded' : 'failed', at: last.at } : null,
        workerId: worker.id,
        routineId: routine.id
      }
    })
}

function wakeupRows(worker: Worker): ScheduleRow[] {
  const who = { id: worker.id, name: worker.name, color: worker.color }
  const beats = [{ threadId: undefined as string | undefined, heartbeat: worker.heartbeat, title: '' }, ...(worker.threads ?? []).map((t) => ({ threadId: t.id, heartbeat: t.heartbeat, title: t.title }))]
  return beats
    .filter((b) => b.heartbeat && b.heartbeat.nextAt !== null)
    .map((b): ScheduleRow => ({
      key: `wakeup:${worker.id}:${b.threadId ?? 'main'}`,
      kind: 'wakeup',
      name: firstLine(b.heartbeat.note) ?? (b.title ? `Check in on “${b.title}”` : 'Check in'),
      worker: who,
      cadence: b.heartbeat.everyMs ? `Wakes itself every ${everyText(b.heartbeat.everyMs)}` : 'Wakes itself once',
      nextAt: worker.paused ? null : b.heartbeat.nextAt,
      nextNote: worker.paused ? `${worker.name} is paused` : null,
      paused: false,
      control: 'stop',
      last: null,
      workerId: worker.id,
      ...(b.threadId ? { threadId: b.threadId } : {})
    }))
}

/** Soonest first; what isn't scheduled (paused, done, held) after, by name. */
export function buildScheduleRows(tasks: ScheduledTask[], workers: Worker[], now: number): ScheduleRow[] {
  const rows = [...tasks.map((t) => automationRow(t, now)), ...workers.flatMap((w) => [...routineRows(w), ...wakeupRows(w)])]
  return rows.sort((a, b) => {
    if (a.nextAt !== null && b.nextAt !== null) return a.nextAt - b.nextAt || a.name.localeCompare(b.name)
    if (a.nextAt !== null) return -1
    if (b.nextAt !== null) return 1
    return a.name.localeCompare(b.name)
  })
}
