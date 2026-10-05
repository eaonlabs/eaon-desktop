import { randomUUID } from 'node:crypto'
import { HISTORY_LIMIT, nextRunAfter, scheduleError, type RunStatus, type ScheduledTask, type TaskRun } from '@shared/scheduler'

/**
 * Reading `scheduled-tasks.json` and `scheduled-runs.json` back safely. Pure,
 * so the engine, the migration and the tests share it.
 *
 * A task the file can't vouch for is repaired where it can be (a missing
 * name, a next run that isn't a time) and switched off where it can't be (a
 * schedule that makes no sense), never silently dropped. A task with a kind
 * of schedule this version doesn't know — written by a newer Eaon — is kept
 * exactly as it is and written back with the others, so going back a version
 * doesn't delete it.
 */

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

const KINDS = new Set(['interval', 'daily', 'weekly', 'once'])
const STATUSES = new Set<RunStatus>(['running', 'succeeded', 'failed', 'cancelled', 'missed', 'skipped'])
const TRIGGERS = new Set(['schedule', 'manual', 'catch-up', 'retry'])

export interface LoadedTasks {
  tasks: ScheduledTask[]
  /** Records from a newer Eaon (an unknown kind of schedule), kept untouched. */
  foreign: unknown[]
  /** Runs found saved inside tasks (2026.6.1 and earlier), with their task's id. */
  embedded: TaskRun[]
  /** Records that weren't tasks at all (no id, not an object). */
  dropped: number
}

export function repairTasks(raw: unknown, now: number, zone: string): LoadedTasks {
  const out: LoadedTasks = { tasks: [], foreign: [], embedded: [], dropped: 0 }
  if (!Array.isArray(raw)) return out
  const seen = new Set<string>()
  for (const entry of raw) {
    if (!isObject(entry) || !isId(entry.id)) {
      out.dropped++
      continue
    }
    if (!isObject(entry.schedule) || !KINDS.has(entry.schedule.kind as string)) {
      out.foreign.push(entry)
      continue
    }
    const task = { ...entry } as unknown as ScheduledTask & Record<string, unknown>
    // Two tasks with one id would make every edit, run and delete ambiguous.
    // The second is kept under an id of its own rather than dropped.
    if (seen.has(task.id)) task.id = randomUUID()
    seen.add(task.id)

    if (Array.isArray(entry.history)) {
      for (const run of entry.history) if (isObject(run)) out.embedded.push({ ...(run as unknown as TaskRun), taskId: task.id })
    }
    task.history = []

    if (typeof task.name !== 'string' || !task.name.trim()) task.name = 'Untitled task'
    if (typeof task.prompt !== 'string') task.prompt = ''
    if (task.mode !== 'chat' && task.mode !== 'work') task.mode = 'chat'
    const model = task.model as unknown
    if (!isObject(model) || !isId(model.providerId) || !isId(model.modelId)) task.model = null
    if (typeof task.cwd !== 'string') task.cwd = null
    task.allowChanges = task.mode === 'work' && task.allowChanges === true
    if (!finite(task.createdAt)) task.createdAt = now
    if (!finite(task.updatedAt)) task.updatedAt = task.createdAt
    if (!finite(task.lastRunAt)) task.lastRunAt = null
    if (!STATUSES.has(task.lastStatus as RunStatus)) task.lastStatus = null
    if (typeof task.zone !== 'string' || !task.zone) task.zone = zone
    task.enabled = task.enabled === true

    // A schedule that can't produce a time (an interval of zero, a time of
    // day that isn't one) can't run. Off, with the task kept to be edited.
    if (scheduleError(task.schedule, now, false) !== null) {
      task.enabled = false
      task.nextRunAt = null
    } else if (!finite(task.nextRunAt)) {
      task.nextRunAt = task.enabled ? nextRunAfter(task.schedule, now) : null
      if (task.nextRunAt === null) task.enabled = false
    } else if (!task.enabled) {
      task.nextRunAt = null
    }
    if (!task.prompt.trim()) {
      // Nothing to send the model.
      task.enabled = false
      task.nextRunAt = null
    }
    out.tasks.push(task)
  }
  return out
}

/** The runs file: records with an id and a task, newest first, no repeats. Unknown values are put right. */
export function repairRuns(raw: unknown): { runs: TaskRun[]; dropped: number } {
  const runs: TaskRun[] = []
  let dropped = 0
  const seen = new Set<string>()
  for (const entry of Array.isArray(raw) ? raw : []) {
    const run = normalizeRun(entry)
    if (!run || seen.has(run.id)) {
      dropped++
      continue
    }
    seen.add(run.id)
    runs.push(run)
  }
  runs.sort((a, b) => b.startedAt - a.startedAt)
  return { runs, dropped }
}

function normalizeRun(entry: unknown): TaskRun | null {
  if (!isObject(entry) || !isId(entry.id) || !isId(entry.taskId) || !finite(entry.startedAt)) return null
  const run = { ...entry } as unknown as TaskRun
  if (!STATUSES.has(run.status)) run.status = 'failed'
  if (!TRIGGERS.has(run.trigger)) run.trigger = 'schedule'
  if (!finite(run.finishedAt)) run.finishedAt = null
  if (typeof run.chatId !== 'string') run.chatId = null
  return run
}

/**
 * Runs saved inside tasks (the shape before the runs file) merged into the
 * runs file's list. Safe to repeat: a run already there by id is not added
 * twice, so going back to 2026.6.1 and forward again only adds what that
 * version recorded meanwhile.
 */
export function mergeRuns(runs: TaskRun[], embedded: TaskRun[]): TaskRun[] {
  if (embedded.length === 0) return runs
  return repairRuns([...runs, ...embedded]).runs
}

/**
 * A run still marked running when the tasks are loaded was cut off by a quit
 * or a crash. It is reported as failed rather than left spinning forever.
 */
export function settleInterrupted(runs: TaskRun[]): boolean {
  let changed = false
  for (const run of runs) {
    if (run.status !== 'running') continue
    run.status = 'failed'
    run.finishedAt = run.finishedAt ?? run.startedAt
    run.error = 'Eaon quit before this run finished.'
    changed = true
  }
  return changed
}

/** At most HISTORY_LIMIT runs per task, newest first, and none for tasks that are gone. */
export function trimRuns(runs: TaskRun[], taskIds: Set<string>): TaskRun[] {
  const counts = new Map<string, number>()
  return runs.filter((run) => {
    if (!run.taskId || !taskIds.has(run.taskId)) return false
    const n = (counts.get(run.taskId) ?? 0) + 1
    counts.set(run.taskId, n)
    return n <= HISTORY_LIMIT
  })
}
