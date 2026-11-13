import type { WorkerExecution } from './workers'

/** How a worker has done over a stretch of days, worked out from its run receipts. */
export interface WorkerStats {
  /** Runs that ended in the window: completed, failed, stopped or cut off. */
  runs: number
  completed: number
  failed: number
  /** Share of finished runs that completed, 0 to 1; null when none finished. */
  successRate: number | null
  /** Average time of runs that have both a start and an end, in ms; null when none do. */
  averageMs: number | null
  /** Tokens (input and output) of runs billed to an API key or a local model. */
  tokens: number
  /** Tokens of runs on a subscription: they count against its limits, not a bill. */
  planTokens: number
}

const DAY = 86_400_000

/** A run belongs to the window by when it ended, or when it started or was queued if it hasn't. */
const stamp = (run: WorkerExecution): number => run.endedAt ?? run.startedAt ?? run.queuedAt

/**
 * The numbers for the last `days` days. Runs still waiting or running, and
 * skipped ones (`missed`), say nothing about how the worker does, so they are
 * not counted as runs.
 */
export function workerStats(executions: readonly WorkerExecution[], days: number, now: number): WorkerStats {
  const since = now - days * DAY
  let completed = 0
  let failed = 0
  let other = 0
  let timed = 0
  let timedMs = 0
  let tokens = 0
  let planTokens = 0
  for (const run of executions) {
    if (run.state === 'queued' || run.state === 'running' || run.state === 'missed') continue
    if (stamp(run) < since) continue
    if (run.state === 'completed') completed++
    else if (run.state === 'failed' || run.state === 'interrupted') failed++
    else other++
    if (run.startedAt !== null && run.endedAt !== null && run.endedAt >= run.startedAt) {
      timed++
      timedMs += run.endedAt - run.startedAt
    }
    const total = run.usage ? run.usage.input + run.usage.output : 0
    if (run.billing === 'plan') planTokens += total
    else tokens += total
  }
  const finished = completed + failed
  return {
    runs: completed + failed + other,
    completed,
    failed,
    successRate: finished > 0 ? completed / finished : null,
    averageMs: timed > 0 ? Math.round(timedMs / timed) : null,
    tokens,
    planTokens
  }
}
