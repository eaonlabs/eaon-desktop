import { randomUUID } from 'node:crypto'
import {
  CATCH_UP_WINDOW_MS,
  draftError,
  HISTORY_LIMIT,
  latestDue,
  nextRunAfter,
  parseTime,
  periodMs,
  type RunStatus,
  type Schedule,
  type ScheduledTask,
  type TaskDraft,
  type TaskRun
} from '@shared/scheduler'

/**
 * When scheduled tasks run.
 *
 * One timer is armed for the soonest due task and re-armed after every
 * change. Timers alone are not trusted: a sleeping Mac suspends them and a
 * clock change moves the wall time out from under them, so a 60-second
 * heartbeat (and a resume hook in the feature) re-checks everything. A task
 * that came due while Eaon was closed or asleep runs once on return if it is
 * less than a day late, then carries on from the next slot — never a burst of
 * every slot it missed. One task never runs twice at once.
 *
 * What a run *does* is injected (`execute`), so the engine can be driven in
 * tests without a model, a window or Electron.
 */

export interface RunHandle {
  runId: string
  trigger: TaskRun['trigger']
  signal: AbortSignal
  /** Links the run to its chat as soon as the chat exists, so the page can open it mid-run. */
  setChatId: (chatId: string) => void
}

export interface RunResult {
  status: Extract<RunStatus, 'succeeded' | 'failed' | 'cancelled'>
  chatId: string | null
  error?: string
  summary?: string
}

export interface EngineDeps {
  load: () => unknown
  save: (tasks: ScheduledTask[]) => void
  execute: (task: ScheduledTask, handle: RunHandle) => Promise<RunResult>
  onChange?: (tasks: ScheduledTask[]) => void
  now?: () => number
}

const HEARTBEAT_MS = 60_000
/** setTimeout's ceiling; a longer delay overflows and fires at once. */
const MAX_DELAY = 2 ** 31 - 1
/** A slot started later than this is labelled a catch-up rather than on time. */
const LATE_MS = 2 * 60_000

const clone = <T>(value: T): T => structuredClone(value)
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export class SchedulerEngine {
  private tasks: ScheduledTask[] = []
  private readonly running = new Map<string, AbortController>()
  private readonly inflight = new Set<Promise<void>>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private started = false
  private readonly now: () => number

  constructor(private readonly deps: EngineDeps) {
    this.now = deps.now ?? Date.now
  }

  /** Reads the saved tasks. Nothing fires until `start()`. */
  load(): void {
    const now = this.now()
    const raw = this.deps.load()
    this.tasks = (Array.isArray(raw) ? raw : []).filter(isTask).map((task) => recover(task, now))
    this.deps.save(this.tasks)
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.heartbeat = setInterval(() => this.tick(), HEARTBEAT_MS)
    // Electron keeps the main process alive on its own; unref only matters to
    // tests, which would otherwise never exit.
    this.heartbeat.unref?.()
    this.tick()
  }

  /** Stops firing and aborts runs in progress. Synchronous: it runs from before-quit. */
  stop(): void {
    this.started = false
    if (this.timer) clearTimeout(this.timer)
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.timer = null
    this.heartbeat = null
    const now = this.now()
    let changed = false
    for (const [taskId, controller] of this.running) {
      controller.abort()
      // Recorded here because quitting may not leave time for the run to report back.
      const task = this.find(taskId)
      const run = task?.history.find((r) => r.status === 'running')
      if (task && run) {
        Object.assign(run, { status: 'cancelled', finishedAt: now, error: 'Eaon quit during this run.' })
        task.lastStatus = task.history[0]?.status ?? null
        changed = true
      }
    }
    if (changed) this.deps.save(this.tasks)
  }

  list(): ScheduledTask[] {
    return clone(this.tasks)
  }

  isRunning(taskId: string): boolean {
    return this.running.has(taskId)
  }

  /** Resolves once every run in progress has finished and been recorded. */
  async whenIdle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.all([...this.inflight])
  }

  /** Creates a task, or updates the one `draft.id` names. Throws a user-facing message when the draft is invalid. */
  save(draft: TaskDraft): ScheduledTask {
    const now = this.now()
    const error = draftError(draft, now)
    if (error) throw new Error(error)
    const existing = draft.id ? this.find(draft.id) : undefined
    if (draft.id && !existing) throw new Error('That scheduled task no longer exists.')

    let schedule = normalizeSchedule(draft.schedule)
    const scheduleChanged = !existing || scheduleKey(existing.schedule) !== scheduleKey(schedule)
    if (schedule.kind === 'interval') {
      // An unchanged interval keeps its grid, so editing the prompt does not
      // push the next run a whole period away.
      const kept = !scheduleChanged && existing?.schedule.kind === 'interval' ? existing.schedule.startAt : undefined
      schedule = { ...schedule, startAt: kept ?? now + periodMs(schedule) }
    }
    const reschedule = scheduleChanged || !existing?.enabled || existing.nextRunAt === null
    const mode = draft.mode === 'work' ? 'work' : 'chat'
    const task: ScheduledTask = {
      id: existing?.id ?? randomUUID(),
      name: draft.name.trim().slice(0, 120),
      prompt: draft.prompt.trim(),
      schedule,
      mode,
      model: draft.model?.providerId && draft.model.modelId ? { providerId: draft.model.providerId, modelId: draft.model.modelId } : null,
      cwd: mode === 'work' && draft.cwd?.trim() ? draft.cwd.trim() : null,
      allowChanges: mode === 'work' && draft.allowChanges === true,
      enabled: draft.enabled,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      nextRunAt: !draft.enabled ? null : reschedule ? nextRunAfter(schedule, now) : existing!.nextRunAt,
      lastRunAt: existing?.lastRunAt ?? null,
      lastStatus: existing?.lastStatus ?? null,
      history: existing?.history ?? []
    }
    if (existing) this.tasks[this.tasks.indexOf(existing)] = task
    else this.tasks.push(task)
    this.commit()
    return clone(task)
  }

  remove(taskId: string): void {
    this.running.get(taskId)?.abort()
    this.tasks = this.tasks.filter((t) => t.id !== taskId)
    this.commit()
  }

  setEnabled(taskId: string, enabled: boolean): ScheduledTask {
    const task = this.require(taskId)
    const now = this.now()
    if (enabled && task.schedule.kind === 'once' && task.schedule.at <= now) {
      throw new Error('This one-off time has passed. Edit the task to pick a new time.')
    }
    task.enabled = enabled
    task.nextRunAt = enabled ? nextRunAfter(task.schedule, now) : null
    task.updatedAt = now
    this.commit()
    return clone(task)
  }

  /** Runs a task immediately, outside its schedule. Works on paused tasks too. */
  runNow(taskId: string): TaskRun {
    const task = this.require(taskId)
    if (this.running.has(taskId)) throw new Error(`“${task.name}” is already running.`)
    return clone(this.begin(task, 'manual'))
  }

  cancel(taskId: string): void {
    this.running.get(taskId)?.abort()
  }

  /** Starts every task that is due. Safe to call at any time and as often as you like. */
  tick(): void {
    if (!this.started) return
    const now = this.now()
    let changed = false
    for (const task of this.tasks) {
      if (!task.enabled || task.nextRunAt === null) continue
      const expected = nextRunAfter(task.schedule, now)

      if (this.running.has(task.id)) {
        // Never two at once: a slot that comes due mid-run is skipped.
        if (task.nextRunAt <= now) {
          task.nextRunAt = expected
          changed = true
        }
        continue
      }

      if (task.nextRunAt > now) {
        // The stored slot is always the first one after some moment already
        // past, so a sooner slot from *now* means the clock went backwards.
        // Pull the run in rather than wait out the difference.
        if (expected !== null && expected < task.nextRunAt) {
          task.nextRunAt = expected
          changed = true
        }
        continue
      }

      const due = latestDue(task.schedule, task.nextRunAt, now) ?? task.nextRunAt
      if (now - due > CATCH_UP_WINDOW_MS) {
        this.recordMissed(task, due, now)
        changed = true
        continue
      }
      this.begin(task, now - due > LATE_MS ? 'catch-up' : 'schedule')
    }
    if (changed) this.commit()
    else this.arm()
  }

  /* ------------------------------------------------------------ internals */

  private find(taskId: string): ScheduledTask | undefined {
    return this.tasks.find((t) => t.id === taskId)
  }

  private require(taskId: string): ScheduledTask {
    const task = this.find(taskId)
    if (!task) throw new Error('That scheduled task no longer exists.')
    return task
  }

  private commit(): void {
    this.deps.save(this.tasks)
    this.deps.onChange?.(clone(this.tasks))
    this.arm()
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.started) return
    let soonest = Infinity
    for (const task of this.tasks) {
      if (task.enabled && task.nextRunAt !== null && !this.running.has(task.id)) soonest = Math.min(soonest, task.nextRunAt)
    }
    if (soonest === Infinity) return
    const delay = Math.min(Math.max(soonest - this.now(), 0), MAX_DELAY)
    this.timer = setTimeout(() => {
      this.timer = null
      this.tick()
    }, delay)
    this.timer.unref?.()
  }

  private recordMissed(task: ScheduledTask, due: number, now: number): void {
    const run: TaskRun = {
      id: randomUUID(),
      startedAt: due,
      finishedAt: due,
      status: 'missed',
      chatId: null,
      trigger: 'schedule',
      error: 'Eaon was closed or the computer was asleep, and it was more than a day late — skipped.'
    }
    task.history = [run, ...task.history].slice(0, HISTORY_LIMIT)
    task.lastStatus = 'missed'
    this.advance(task, now)
  }

  /** Moves a task past a slot it has just used up (run or missed). */
  private advance(task: ScheduledTask, now: number): void {
    if (task.schedule.kind === 'once') {
      task.enabled = false
      task.nextRunAt = null
    } else {
      task.nextRunAt = nextRunAfter(task.schedule, now)
    }
  }

  private begin(task: ScheduledTask, trigger: TaskRun['trigger']): TaskRun {
    const now = this.now()
    const controller = new AbortController()
    this.running.set(task.id, controller)
    const run: TaskRun = { id: randomUUID(), startedAt: now, finishedAt: null, status: 'running', chatId: null, trigger }
    task.history = [run, ...task.history].slice(0, HISTORY_LIMIT)
    task.lastRunAt = now
    task.lastStatus = 'running'
    // A manual run is extra; it does not use up the next scheduled slot.
    if (trigger !== 'manual') this.advance(task, now)
    this.commit()

    const taskId = task.id
    const handle: RunHandle = {
      runId: run.id,
      trigger,
      signal: controller.signal,
      setChatId: (chatId) => this.patchRun(taskId, run.id, { chatId })
    }
    const work: Promise<void> = this.deps
      .execute(clone(task), handle)
      .catch((error): RunResult => ({ status: 'failed', chatId: null, error: errorText(error) }))
      .then((result) => {
        this.running.delete(taskId)
        this.finish(taskId, run.id, result)
      })
      .finally(() => {
        this.running.delete(taskId)
        this.inflight.delete(work)
        this.arm()
      })
    this.inflight.add(work)
    return run
  }

  private finish(taskId: string, runId: string, result: RunResult): void {
    const task = this.find(taskId)
    // Deleted mid-run: the chat it wrote stays; there is no task left to update.
    const run = task?.history.find((r) => r.id === runId)
    if (!task || !run) return
    run.status = result.status
    run.finishedAt = this.now()
    if (result.chatId) run.chatId = result.chatId
    if (result.error) run.error = result.error.slice(0, 500)
    else delete run.error
    if (result.summary) run.summary = result.summary
    task.lastStatus = task.history[0]?.status ?? result.status
    this.commit()
  }

  private patchRun(taskId: string, runId: string, patch: Partial<TaskRun>): void {
    const run = this.find(taskId)?.history.find((r) => r.id === runId)
    if (!run) return
    Object.assign(run, patch)
    this.commit()
  }
}

/* ---------------------------------------------------------------- helpers */

function isTask(value: unknown): value is ScheduledTask {
  const task = value as ScheduledTask
  return Boolean(task && typeof task.id === 'string' && task.schedule && typeof task.schedule.kind === 'string')
}

/**
 * A run still marked running when the tasks are loaded was cut off by a quit
 * or a crash. It is reported as failed rather than left spinning forever.
 */
function recover(task: ScheduledTask, now: number): ScheduledTask {
  const history = (Array.isArray(task.history) ? task.history : []).map((run) =>
    run.status === 'running'
      ? { ...run, status: 'failed' as const, finishedAt: run.finishedAt ?? run.startedAt, error: 'Eaon quit before this run finished.' }
      : run
  )
  const next = { ...task, history, lastStatus: history[0]?.status ?? task.lastStatus ?? null }
  if (next.enabled && next.nextRunAt == null) {
    next.nextRunAt = nextRunAfter(next.schedule, now)
    if (next.nextRunAt === null) next.enabled = false
  }
  return next
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function normalizeTime(time: string): string {
  const parsed = parseTime(time)
  return parsed ? `${pad(parsed[0])}:${pad(parsed[1])}` : time
}

function normalizeSchedule(schedule: Schedule): Schedule {
  switch (schedule.kind) {
    case 'interval':
      return { kind: 'interval', every: Math.floor(schedule.every), unit: schedule.unit === 'hours' ? 'hours' : 'minutes', ...(schedule.startAt ? { startAt: schedule.startAt } : {}) }
    case 'daily':
      return { kind: 'daily', time: normalizeTime(schedule.time), days: [...new Set(schedule.days)].sort((a, b) => a - b) }
    case 'weekly':
      return { kind: 'weekly', time: normalizeTime(schedule.time), day: schedule.day }
    case 'once':
      return { kind: 'once', at: schedule.at }
  }
}

/** Identity of a schedule for change detection; an interval's grid anchor is bookkeeping, not part of it. */
function scheduleKey(schedule: Schedule): string {
  const { startAt: _anchor, ...rest } = schedule as Schedule & { startAt?: number }
  return JSON.stringify(rest)
}
