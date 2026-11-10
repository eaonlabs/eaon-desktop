import { randomUUID } from 'node:crypto'
import {
  BULK_FAILURES_BEFORE_STOP,
  MAX_BULK_ROWS,
  bulkRowLabel,
  parseBulk,
  type BulkRow,
  type BulkRun,
  type BulkStart
} from '@shared/bulk'
import { promptWithInput, type RunInput, type ScheduledTask, type TaskRun } from '@shared/scheduler'
import type { Worker, WorkerExecution, WorkerThreadInfo } from '@shared/workers'

/**
 * One automation, or one task for a worker, run over a list: each row is one
 * run, one at a time (never two going at once, so the cost and the load are
 * what one run is), at most MAX_BULK_ROWS of them, and it stops early when
 * runs fail one after another. The rows are data for each run, fenced and
 * labelled as such like an email or a webhook's body. The results are kept in
 * memory for the summary; a list in progress stops if Eaon quits.
 *
 * What starts a run is injected, so this is driven in tests without a model:
 * the scheduler's engine for an automation, the workers' for a worker.
 */

export interface BulkAutomations {
  list: () => ScheduledTask[]
  isRunning: (taskId: string) => boolean
  runNow: (taskId: string, input: RunInput) => TaskRun
  finished: (runId: string) => Promise<TaskRun | undefined>
  cancel: (taskId: string) => void
}

export interface BulkWorkers {
  list: () => Worker[]
  createThread: (id: string, input: { title: string; kind: WorkerThreadInfo['kind'] }) => WorkerThreadInfo
  send: (id: string, text: string, files: string[], options: { threadId: string }) => { threadId: string }
  executions: (id: string) => WorkerExecution[]
  stopTurn: (id: string, threadId: string) => void
}

export interface BulkDeps {
  automations: () => BulkAutomations | null
  /** Null when the workers run on a linked worker computer rather than here. */
  workers: () => BulkWorkers | null
  onChange?: (run: BulkRun) => void
  now?: () => number
  /** How often a worker's run is looked at to see whether it has ended. */
  pollMs?: number
  /** The longest to wait for one row's run. */
  rowTimeoutMs?: number
}

const KEEP_RUNS = 5
const ENDED = new Set<WorkerExecution['state']>(['completed', 'failed', 'cancelled', 'interrupted', 'missed'])
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const firstLine = (text: string | null | undefined): string | undefined => {
  const line = text?.split('\n').find((l) => l.trim())?.trim()
  return line ? (line.length > 160 ? `${line.slice(0, 159)}…` : line) : undefined
}

export class BulkRunner {
  private runs: BulkRun[] = []
  private readonly cancelled = new Set<string>()
  private active: { id: string; stop: () => void } | null = null
  private readonly now: () => number

  constructor(private readonly deps: BulkDeps) {
    this.now = deps.now ?? Date.now
  }

  list(): BulkRun[] {
    return structuredClone(this.runs)
  }

  /**
   * Checks the target and the rows and starts. Throws a sentence when it
   * can't: nothing to run, no such automation, another list still going.
   * Returns at once; follow it through `onChange`, or `done`.
   */
  start(request: BulkStart): BulkRun {
    if (this.active) throw new Error('A list is already running. Wait for it to finish, or stop it first.')
    const parsed = parseBulk(request.input)
    if (parsed.problem) throw new Error(parsed.problem)
    const { target } = request
    let name: string
    let workerId: string | undefined
    if (target.kind === 'automation') {
      const engine = this.deps.automations()
      if (!engine) throw new Error('Automations aren’t running.')
      const task = engine.list().find((t) => t.id === target.id)
      if (!task) throw new Error('That automation no longer exists.')
      if (task.purchase || task.watch) throw new Error(`“${task.name}” makes purchases, so it can only run on its own schedule or one run at a time from its card.`)
      name = task.name
    } else {
      const engine = this.deps.workers()
      if (!engine) throw new Error('Your workers run on a linked worker computer, so a list can’t be run from here yet.')
      const worker = engine.list().find((w) => w.id === target.id)
      if (!worker) throw new Error('That worker isn’t there any more.')
      if (worker.paused) throw new Error(`${worker.name} is paused. Resume it first.`)
      if (!target.instruction.trim()) throw new Error('Say what the worker should do with each row.')
      name = worker.name
      workerId = worker.id
    }
    const run: BulkRun = {
      id: randomUUID(),
      targetName: name,
      kind: target.kind,
      ...(workerId ? { workerId } : {}),
      startedAt: this.now(),
      finishedAt: null,
      status: 'running',
      leftOut: Math.max(0, parsed.found - MAX_BULK_ROWS),
      rows: parsed.rows.map((input, index): BulkRow => ({ index, input, status: 'waiting' }))
    }
    this.runs = [run, ...this.runs].slice(0, KEEP_RUNS)
    this.active = { id: run.id, stop: () => {} }
    this.emit(run)
    const work = this.go(run, target).catch((error) => {
      console.error('[bulk] a list failed:', error)
      this.end(run, 'stopped', errorText(error))
    })
    this.finishing.set(run.id, work)
    return structuredClone(run)
  }

  private readonly finishing = new Map<string, Promise<void>>()

  /** Resolves with the run once it has ended; for tests and orderly shutdown. */
  async done(runId: string): Promise<BulkRun | undefined> {
    await this.finishing.get(runId)
    return this.runs.find((r) => r.id === runId) && structuredClone(this.runs.find((r) => r.id === runId)!)
  }

  /** Stops the run after the row now going (which is stopped too); the rows after it are left. */
  cancel(runId: string): void {
    if (this.active?.id !== runId) return
    this.cancelled.add(runId)
    this.active.stop()
  }

  /** Stops whatever is going, for quitting. */
  stop(): void {
    if (this.active) this.cancel(this.active.id)
  }

  private emit(run: BulkRun): void {
    try {
      this.deps.onChange?.(structuredClone(run))
    } catch (error) {
      console.error('[bulk] a listener failed:', error)
    }
  }

  private end(run: BulkRun, status: BulkRun['status'], reason?: string): void {
    for (const row of run.rows) if (row.status === 'waiting') row.status = 'skipped'
    run.status = status
    if (reason) run.stopReason = reason
    run.finishedAt = this.now()
    this.cancelled.delete(run.id)
    if (this.active?.id === run.id) this.active = null
    this.emit(run)
  }

  private async go(run: BulkRun, target: BulkStart['target']): Promise<void> {
    let failures = 0
    for (const row of run.rows) {
      if (this.cancelled.has(run.id)) return this.end(run, 'cancelled')
      row.status = 'running'
      this.emit(run)
      const label = bulkRowLabel(row.index, run.rows.length, row.input)
      try {
        if (target.kind === 'automation') await this.automationRow(run, row, target.id, label)
        else await this.workerRow(run, row, target.id, target.instruction, label)
      } catch (error) {
        row.status = 'failed'
        row.error = errorText(error)
      }
      this.emit(run)
      // Stopped while this row ran: it is cancelled, and nothing after it starts.
      if (this.cancelled.has(run.id)) {
        if (row.status === 'running') row.status = 'cancelled'
        return this.end(run, 'cancelled')
      }
      failures = row.status === 'failed' ? failures + 1 : 0
      if (failures >= BULK_FAILURES_BEFORE_STOP) {
        return this.end(run, 'stopped', `${failures} rows in a row failed, so the rest were left alone. The last said: ${row.error ?? 'it failed'}`)
      }
    }
    this.end(run, 'finished')
  }

  private async automationRow(run: BulkRun, row: BulkRow, taskId: string, label: string): Promise<void> {
    const engine = this.deps.automations()
    if (!engine) throw new Error('Automations aren’t running.')
    // Never two at once: a scheduled slot may be using it right now.
    while (engine.isRunning(taskId)) {
      if (this.cancelled.has(run.id)) return
      await sleep(this.deps.pollMs ?? 500)
    }
    if (this.cancelled.has(run.id)) return
    const started = engine.runNow(taskId, { source: 'list', label, text: row.input })
    this.active = { id: run.id, stop: () => engine.cancel(taskId) }
    if (this.cancelled.has(run.id)) engine.cancel(taskId)
    const record = await engine.finished(started.id)
    if (record?.chatId) row.chatId = record.chatId
    if (!record || record.status === 'succeeded') {
      row.status = 'succeeded'
      const summary = firstLine(record?.summary)
      if (summary) row.summary = summary
    } else if (record.status === 'cancelled') {
      row.status = 'cancelled'
    } else {
      row.status = 'failed'
      row.error = firstLine(record.error) ?? 'It failed.'
    }
  }

  private async workerRow(run: BulkRun, row: BulkRow, workerId: string, instruction: string, label: string): Promise<void> {
    const engine = this.deps.workers()
    if (!engine) throw new Error('Your workers run on a linked worker computer, so a list can’t be run from here yet.')
    const worker = engine.list().find((w) => w.id === workerId)
    if (!worker) throw new Error('That worker isn’t there any more.')
    if (worker.paused) throw new Error(`${worker.name} is paused.`)
    // Each row is a task thread of its own, so rows don't share a conversation and the results can be opened one by one.
    const thread = engine.createThread(workerId, { title: label, kind: 'task' })
    row.threadId = thread.id
    this.active = { id: run.id, stop: () => engine.stopTurn(workerId, thread.id) }
    engine.send(workerId, promptWithInput(instruction.trim(), { source: 'list', label, text: row.input }), [], { threadId: thread.id })
    const started = this.now()
    const limit = this.deps.rowTimeoutMs ?? 30 * 60_000
    for (;;) {
      const receipt = engine
        .executions(workerId)
        .filter((e) => e.threadId === thread.id)
        .at(-1)
      if (receipt && ENDED.has(receipt.state)) {
        if (receipt.state === 'completed') {
          row.status = 'succeeded'
          const summary = firstLine(receipt.result)
          if (summary) row.summary = summary
        } else if (receipt.state === 'cancelled') row.status = 'cancelled'
        else {
          row.status = 'failed'
          row.error = firstLine(receipt.error ?? receipt.reason) ?? 'It didn’t finish.'
        }
        return
      }
      if (this.cancelled.has(run.id)) {
        row.status = 'cancelled'
        return
      }
      if (this.now() - started > limit) {
        engine.stopTurn(workerId, thread.id)
        throw new Error('The worker took too long on this row.')
      }
      await sleep(this.deps.pollMs ?? 400)
    }
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
