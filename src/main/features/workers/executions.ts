import { randomUUID } from 'node:crypto'
import type { EngineId } from '@shared/engines'
import type { TokenUsage } from '@shared/types'
import { MAX_EXECUTIONS, type ExecutionState, type ExecutionTrigger, type WorkerExecution } from '@shared/workers'

/**
 * Run receipts: one record per run of a worker, from queued to how it ended,
 * kept apart from the transcript (`worker-<id>-runs.json`, the latest
 * MAX_EXECUTIONS). Every transition is saved as it happens, so a crash leaves
 * a run marked `running` on disk and the next launch knows it was cut off —
 * and whether it may already have acted (`sideEffects`).
 */

export interface ExecutionLogDeps {
  load: (workerId: string) => unknown
  save: (workerId: string, executions: WorkerExecution[]) => void
  remove?: (workerId: string) => void | Promise<void>
  onChange?: (execution: WorkerExecution) => void
  now: () => number
}

const ENDED: ExecutionState[] = ['completed', 'failed', 'cancelled', 'interrupted', 'missed']
const STATES: ExecutionState[] = ['queued', 'running', ...ENDED]

export const isEnded = (state: ExecutionState): boolean => ENDED.includes(state)

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)

/** A saved receipt, repaired; null for anything that isn't one. */
function normalizeExecution(raw: unknown, workerId: string): WorkerExecution | null {
  const v = raw as Partial<WorkerExecution> | null
  if (!v || typeof v !== 'object' || typeof v.id !== 'string' || typeof v.threadId !== 'string') return null
  const trigger = v.trigger && typeof v.trigger === 'object' && typeof v.trigger.kind === 'string' ? v.trigger : { kind: 'message' as const, label: 'Run' }
  const usage = v.usage && typeof v.usage === 'object' ? v.usage : null
  return {
    id: v.id,
    workerId,
    threadId: v.threadId,
    trigger: { ...trigger, label: typeof trigger.label === 'string' ? trigger.label : 'Run' },
    state: STATES.includes(v.state as ExecutionState) ? (v.state as ExecutionState) : 'interrupted',
    reason: text(v.reason),
    queuedAt: num(v.queuedAt) ?? 0,
    startedAt: num(v.startedAt),
    endedAt: num(v.endedAt),
    messageId: text(v.messageId),
    engine: v.engine === 'codex' ? 'codex' : 'native',
    providerId: text(v.providerId),
    modelId: text(v.modelId),
    usage,
    billing: v.billing === 'plan' || v.billing === 'api' || v.billing === 'local' ? v.billing : null,
    sideEffects: v.sideEffects === true,
    result: text(v.result),
    error: text(v.error),
    retryOf: text(v.retryOf)
  }
}

export class ExecutionLog {
  private readonly byWorker = new Map<string, WorkerExecution[]>()

  constructor(private readonly deps: ExecutionLogDeps) {}

  /** A worker's receipts, oldest first. Loaded on first use. */
  list(workerId: string): WorkerExecution[] {
    let list = this.byWorker.get(workerId)
    if (!list) {
      const raw = this.deps.load(workerId)
      const seen = new Set<string>()
      list = (Array.isArray(raw) ? raw : [])
        .map((r) => normalizeExecution(r, workerId))
        .filter((e): e is WorkerExecution => {
          if (!e || seen.has(e.id)) return false
          seen.add(e.id)
          return true
        })
      this.byWorker.set(workerId, list)
    }
    return list
  }

  get(workerId: string, id: string): WorkerExecution | undefined {
    return this.list(workerId).find((e) => e.id === id)
  }

  /** The newest receipt for a thread, if any. */
  latest(workerId: string, threadId: string): WorkerExecution | undefined {
    const list = this.list(workerId)
    for (let i = list.length - 1; i >= 0; i--) if (list[i].threadId === threadId) return list[i]
    return undefined
  }

  /** A new receipt, queued (or straight to another state, for a missed run). */
  create(input: {
    workerId: string
    threadId: string
    trigger: ExecutionTrigger
    engine: EngineId
    state?: ExecutionState
    reason?: string | null
    retryOf?: string | null
  }): WorkerExecution {
    const now = this.deps.now()
    const state = input.state ?? 'queued'
    const execution: WorkerExecution = {
      id: randomUUID(),
      workerId: input.workerId,
      threadId: input.threadId,
      trigger: input.trigger,
      state,
      reason: input.reason ?? null,
      queuedAt: now,
      startedAt: null,
      endedAt: isEnded(state) ? now : null,
      messageId: null,
      engine: input.engine,
      providerId: null,
      modelId: null,
      usage: null,
      billing: null,
      sideEffects: false,
      result: null,
      error: null,
      retryOf: input.retryOf ?? null
    }
    const list = this.list(input.workerId)
    list.push(execution)
    if (list.length > MAX_EXECUTIONS) list.splice(0, list.length - MAX_EXECUTIONS)
    this.commit(execution)
    return execution
  }

  /** Changes a receipt and saves it. Ending stamps `endedAt` once. */
  update(execution: WorkerExecution, fields: Partial<Omit<WorkerExecution, 'id' | 'workerId'>>): WorkerExecution {
    Object.assign(execution, fields)
    if (fields.state === 'running' && execution.startedAt === null) execution.startedAt = this.deps.now()
    if (fields.state && isEnded(fields.state) && execution.endedAt === null) execution.endedAt = this.deps.now()
    this.commit(execution)
    return execution
  }

  /** Adds usage from a stream event to a running receipt (not saved per token; the end saves it). */
  addUsage(execution: WorkerExecution, usage: TokenUsage): void {
    execution.usage = { ...usage }
  }

  /**
   * After a crash or quit: every run still marked running was cut off, and a
   * queued one never started (it is queued again from its inbox if it is
   * still due). Returns the interrupted ones.
   */
  recover(workerId: string): WorkerExecution[] {
    const interrupted: WorkerExecution[] = []
    for (const execution of this.list(workerId)) {
      if (execution.state === 'running') {
        this.update(execution, {
          state: 'interrupted',
          reason: execution.sideEffects
            ? 'Eaon quit before it finished. It may already have acted, so it wasn’t restarted on its own.'
            : 'Eaon quit before it finished.'
        })
        interrupted.push(execution)
      } else if (execution.state === 'queued') {
        this.update(execution, { state: 'cancelled', reason: 'Eaon quit before it started.' })
      }
    }
    return interrupted
  }

  async forget(workerId: string): Promise<void> {
    this.byWorker.delete(workerId)
    await this.deps.remove?.(workerId)
  }

  private commit(execution: WorkerExecution): void {
    this.deps.save(execution.workerId, this.list(execution.workerId))
    this.deps.onChange?.(structuredClone(execution))
  }
}
