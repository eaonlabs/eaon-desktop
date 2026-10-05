import { randomUUID } from 'node:crypto'
import {
  countSlots,
  draftError,
  latestDue,
  nextRunAfter,
  overlapAction,
  parseTime,
  periodMs,
  planDue,
  runReason,
  TASK_OVERLAP,
  type RunCause,
  type RunStatus,
  type Schedule,
  type ScheduledTask,
  type TaskDraft,
  type TaskRun
} from '@shared/scheduler'
import type { TokenUsage } from '@shared/types'
import { mergeRuns, repairRuns, repairTasks, settleInterrupted, trimRuns } from './records'

/**
 * When scheduled tasks run.
 *
 * One timer is armed for the soonest due task and re-armed after every
 * change. Timers alone are not trusted: a sleeping Mac suspends them and a
 * clock change moves the wall time out from under them, so a 60-second
 * heartbeat (and a resume hook in the feature) re-checks everything. A task
 * that came due while Eaon was closed or asleep runs once on return if it is
 * less than a day late, then carries on from the next slot — never a burst of
 * every slot it missed (`planDue`). One task never runs twice at once: a slot
 * that comes due mid-run is skipped and recorded as such (`TASK_OVERLAP`).
 *
 * A task's definition and its runs are kept apart: the tasks in
 * `scheduled-tasks.json`, every run (and every slot that didn't run, with
 * why) as its own record in `scheduled-runs.json`. Editing a task leaves its
 * runs alone.
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
  tokens?: TokenUsage
}

export interface EngineDeps {
  load: () => unknown
  save: (tasks: unknown[]) => void
  /** The runs file; absent in tests that only look at tasks. */
  loadRuns?: () => unknown
  saveRuns?: (runs: TaskRun[]) => void
  execute: (task: ScheduledTask, handle: RunHandle) => Promise<RunResult>
  onChange?: (tasks: ScheduledTask[]) => void
  /** Records in the tasks file that weren't tasks at all and were left out; the service keeps a copy of the file. */
  onDamaged?: (count: number) => void
  now?: () => number
  /** A clock that stops while the computer sleeps (`performance.now`), to tell sleep from a clock change. */
  monotonic?: () => number
  /** The current IANA time zone. */
  zone?: () => string
  /** What to call the computer in a reason line: "Mac" on macOS. */
  machine?: string
}

const HEARTBEAT_MS = 60_000
/** setTimeout's ceiling; a longer delay overflows and fires at once. */
const MAX_DELAY = 2 ** 31 - 1
/**
 * Between two checks, the wall clock moving this much further than the
 * monotonic one means the process was suspended: the computer slept.
 */
const SLEEP_GAP_MS = 90_000

const clone = <T>(value: T): T => structuredClone(value)
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const systemZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone
const wallClock = (schedule: Schedule): boolean => schedule.kind === 'daily' || schedule.kind === 'weekly'

export class SchedulerEngine {
  private tasks: ScheduledTask[] = []
  /** Every task's runs, newest first. */
  private runs: TaskRun[] = []
  /** Task records from a newer Eaon, written back untouched. */
  private foreign: unknown[] = []
  private readonly running = new Map<string, { controller: AbortController; runId: string }>()
  private readonly inflight = new Set<Promise<void>>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private started = false
  private readonly now: () => number
  private readonly monotonic: () => number
  private readonly zone: () => string
  /** When the tasks were loaded: a slot before this came due while Eaon wasn't running. */
  private loadedAt = 0
  /** When the computer last woke; a slot before this (and after loading) came due while it slept. */
  private wokeAt = 0
  private lastWall = 0
  private lastMono = 0

  constructor(private readonly deps: EngineDeps) {
    this.now = deps.now ?? Date.now
    this.monotonic = deps.monotonic ?? (() => performance.now())
    this.zone = deps.zone ?? systemZone
  }

  /** Reads the saved tasks and runs. Nothing fires until `start()`. */
  load(): void {
    const now = this.now()
    this.loadedAt = now
    const loaded = repairTasks(this.deps.load(), now, this.zone())
    this.tasks = loaded.tasks
    this.foreign = loaded.foreign
    this.runs = mergeRuns(repairRuns(this.deps.loadRuns?.() ?? []).runs, repairRuns(loaded.embedded).runs)
    settleInterrupted(this.runs)
    for (const task of this.tasks) task.lastStatus = this.latestStatus(task.id) ?? task.lastStatus
    if (loaded.dropped > 0) this.deps.onDamaged?.(loaded.dropped)
    this.persist()
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.lastWall = this.now()
    this.lastMono = this.monotonic()
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
    for (const [taskId, { controller, runId }] of this.running) {
      controller.abort()
      // Recorded here because quitting may not leave time for the run to report back.
      const run = this.runs.find((r) => r.id === runId)
      const task = this.find(taskId)
      if (run && run.status === 'running') {
        Object.assign(run, { status: 'cancelled', finishedAt: now, error: 'Eaon quit during this run.' })
        if (task) task.lastStatus = this.latestStatus(taskId)
        changed = true
      }
    }
    if (changed) this.persist()
  }

  /** The computer woke: anything that came due while it slept is labelled so. */
  wake(): void {
    this.wokeAt = this.now()
    this.tick()
  }

  list(): ScheduledTask[] {
    return this.tasks.map((task) => this.withHistory(task))
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
    // Edited mid-run: the run in progress carries on with what it started
    // with; the change applies from the next one. Its record is untouched.
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
      history: [],
      zone: reschedule || !existing?.zone ? this.zone() : existing.zone
    }
    if (existing) this.tasks[this.tasks.indexOf(existing)] = task
    else this.tasks.push(task)
    this.commit()
    return this.withHistory(task)
  }

  /** Deletes a task and its run records; a run in progress is stopped. The chats runs wrote stay in Recents. */
  remove(taskId: string): void {
    this.running.get(taskId)?.controller.abort()
    this.tasks = this.tasks.filter((t) => t.id !== taskId)
    this.runs = this.runs.filter((r) => r.taskId !== taskId)
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
    task.zone = this.zone()
    task.updatedAt = now
    this.commit()
    return this.withHistory(task)
  }

  /** Runs a task immediately, outside its schedule. Works on paused tasks too. */
  runNow(taskId: string): TaskRun {
    const task = this.require(taskId)
    if (this.running.has(taskId)) throw new Error(`“${task.name}” is already running.`)
    return clone(this.begin(task, 'manual'))
  }

  /** Runs a task again for a run that failed, was stopped, missed or skipped. */
  retry(taskId: string, runId: string): TaskRun {
    const task = this.require(taskId)
    const run = this.runs.find((r) => r.id === runId && r.taskId === taskId)
    if (!run) throw new Error('That run is no longer in the history.')
    if (run.status === 'running') throw new Error('That run is still going.')
    if (this.running.has(taskId)) throw new Error(`“${task.name}” is already running.`)
    return clone(this.begin(task, 'retry', { retryOf: run.id }))
  }

  cancel(taskId: string): void {
    this.running.get(taskId)?.controller.abort()
  }

  /** Starts every task that is due. Safe to call at any time and as often as you like. */
  tick(): void {
    if (!this.started) return
    const now = this.now()
    this.noticeSleep(now)
    const zone = this.zone()
    let changed = false
    for (const task of this.tasks) {
      if (!task.enabled || task.nextRunAt === null) continue

      // The time zone changed (travel, or by hand): "every day at 9" means 9
      // where the user is now, so a slot still ahead is worked out again. A
      // slot already due is handled below, and its next one comes from the
      // new zone.
      if (task.zone !== zone && wallClock(task.schedule) && task.nextRunAt > now) {
        task.nextRunAt = nextRunAfter(task.schedule, now)
        task.zone = zone
        changed = true
        continue
      }

      const active = this.running.get(task.id)
      if (active) {
        // Never two at once (TASK_OVERLAP): a slot that comes due mid-run is
        // skipped and recorded, so the history says why it didn't run. A
        // one-off's only slot is then used up, so it is switched off.
        if (task.nextRunAt <= now && overlapAction(TASK_OVERLAP, true) === 'skip') {
          this.recordSkipped(task, active.runId, now)
          this.advance(task, now)
          changed = true
        }
        continue
      }

      const expected = nextRunAfter(task.schedule, now)
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

      const plan = planDue(task.schedule, task.nextRunAt, now)
      // Why it's late is decided by the first slot it missed: the one it
      // was waiting for when Eaon closed or the computer went to sleep.
      const cause = this.causeOf(task.nextRunAt)
      if (plan.action === 'miss') {
        this.recordMissed(task, plan.slot, plan.slots, cause, now)
        changed = true
      } else if (plan.action === 'run') {
        // A run that stands in for slots it missed is a catch-up even when
        // the latest of them is only just due.
        const catchUp = plan.late || plan.slots > 1
        this.begin(task, catchUp ? 'catch-up' : 'schedule', catchUp ? { cause, slotAt: plan.slot, ...(plan.slots > 1 ? { slots: plan.slots } : {}) } : {})
      }
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

  private runsOf(taskId: string): TaskRun[] {
    return this.runs.filter((r) => r.taskId === taskId)
  }

  private withHistory(task: ScheduledTask): ScheduledTask {
    return clone({ ...task, history: this.runsOf(task.id) })
  }

  /** The newest run's status, leaving out skipped slots: "last run" means one that ran (or was missed). */
  private latestStatus(taskId: string): RunStatus | null {
    return this.runs.find((r) => r.taskId === taskId && r.status !== 'skipped')?.status ?? null
  }

  private addRun(run: TaskRun): void {
    this.runs.unshift(run)
    // Newest first by when it was for; a missed slot can be older than a run already here.
    this.runs.sort((a, b) => b.startedAt - a.startedAt)
  }

  /** Why a slot was late or missed: before Eaon started, during a sleep, or neither. */
  private causeOf(slot: number): RunCause {
    if (slot < this.loadedAt) return 'closed'
    if (slot < this.wokeAt) return 'asleep'
    return 'late'
  }

  /**
   * The monotonic clock stops while the computer sleeps and the wall clock
   * doesn't, so a gap between them since the last check is a sleep, even
   * when the resume event hasn't arrived (or never does).
   */
  private noticeSleep(now: number): void {
    const mono = this.monotonic()
    if (this.lastWall && now - this.lastWall - (mono - this.lastMono) > SLEEP_GAP_MS) this.wokeAt = now
    this.lastWall = now
    this.lastMono = mono
  }

  private persist(): void {
    const ids = new Set([...this.tasks.map((t) => t.id), ...this.foreign.map((t) => (t as { id: string }).id)])
    this.runs = trimRuns(this.runs, ids)
    // Runs first: if anything stops between the two writes, the next load
    // sees each run once (the runs file wins; see mergeRuns).
    this.deps.saveRuns?.(this.runs)
    this.deps.save([...this.tasks.map(({ history: _history, ...task }) => task), ...this.foreign])
  }

  private commit(): void {
    this.persist()
    this.deps.onChange?.(this.list())
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

  private recordMissed(task: ScheduledTask, slot: number, slots: number, cause: RunCause, now: number): void {
    const run: TaskRun = {
      id: randomUUID(),
      taskId: task.id,
      startedAt: slot,
      finishedAt: slot,
      status: 'missed',
      chatId: null,
      trigger: 'schedule',
      cause,
      ...(slots > 1 ? { slots } : {})
    }
    // Kept as text too, for the schedule tool and anything else that reads runs without the page's wording.
    run.error = runReason(run, this.deps.machine) ?? undefined
    this.addRun(run)
    task.lastStatus = 'missed'
    this.advance(task, now)
  }

  /**
   * One record per run that blocked slots: a run that goes on through
   * several slots adds to the same record ("Skipped (3 times)") rather than
   * filling the history with one line per slot.
   */
  private recordSkipped(task: ScheduledTask, blockedBy: string, now: number): void {
    const from = task.nextRunAt ?? now
    const slots = Math.max(1, countSlots(task.schedule, from, now))
    const last = latestDue(task.schedule, from, now) ?? from
    const existing = this.runs.find((r) => r.taskId === task.id && r.status === 'skipped' && r.blockedBy === blockedBy)
    if (existing) {
      existing.slots = (existing.slots ?? 1) + slots
      existing.finishedAt = last
      existing.error = runReason(existing, this.deps.machine) ?? undefined
      return
    }
    const run: TaskRun = {
      id: randomUUID(),
      taskId: task.id,
      startedAt: from,
      finishedAt: last,
      status: 'skipped',
      chatId: null,
      trigger: 'schedule',
      cause: 'overlap',
      blockedBy,
      ...(slots > 1 ? { slots } : {})
    }
    run.error = runReason(run, this.deps.machine) ?? undefined
    this.addRun(run)
  }

  /** Moves a task past a slot it has just used up (run, missed or skipped). */
  private advance(task: ScheduledTask, now: number): void {
    if (task.schedule.kind === 'once') {
      task.enabled = false
      task.nextRunAt = null
    } else {
      task.nextRunAt = nextRunAfter(task.schedule, now)
      task.zone = this.zone()
    }
  }

  private begin(task: ScheduledTask, trigger: TaskRun['trigger'], extra: Partial<TaskRun> = {}): TaskRun {
    const now = this.now()
    const controller = new AbortController()
    const run: TaskRun = { id: randomUUID(), taskId: task.id, startedAt: now, finishedAt: null, status: 'running', chatId: null, trigger, ...extra }
    this.running.set(task.id, { controller, runId: run.id })
    this.addRun(run)
    task.lastRunAt = now
    task.lastStatus = 'running'
    // A manual run or a retry is extra; it does not use up the next scheduled slot.
    if (trigger === 'schedule' || trigger === 'catch-up') this.advance(task, now)
    this.commit()

    const taskId = task.id
    const handle: RunHandle = {
      runId: run.id,
      trigger,
      signal: controller.signal,
      setChatId: (chatId) => this.patchRun(run.id, { chatId })
    }
    const work: Promise<void> = this.deps
      .execute(this.withHistory(task), handle)
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
    // Deleted mid-run: the chat it wrote stays; there is no record left to update.
    const run = this.runs.find((r) => r.id === runId)
    if (!run) return
    if (result.tokens) run.tokens = result.tokens
    if (result.chatId && !run.chatId) run.chatId = result.chatId
    // Already settled: Eaon quit during it (stop() recorded that, with the
    // reason). The run's own late report must not overwrite it.
    if (run.status !== 'running') {
      this.persist()
      return
    }
    run.status = result.status
    run.finishedAt = this.now()
    if (result.chatId) run.chatId = result.chatId
    if (result.error) run.error = result.error.slice(0, 500)
    else delete run.error
    if (result.summary) run.summary = result.summary
    const task = this.find(taskId)
    if (task) task.lastStatus = this.latestStatus(taskId) ?? result.status
    this.commit()
  }

  private patchRun(runId: string, patch: Partial<TaskRun>): void {
    const run = this.runs.find((r) => r.id === runId)
    if (!run) return
    Object.assign(run, patch)
    this.commit()
  }
}

/* ---------------------------------------------------------------- helpers */

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
