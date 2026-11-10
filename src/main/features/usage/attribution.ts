import { AsyncLocalStorage } from 'node:async_hooks'
import type { UsageSource } from '@shared/usage'

/**
 * Which part of Eaon a model request was made for, so Settings → Usage can
 * say what the scheduled tasks or the workers cost. Whoever starts a run
 * wraps it in `withUsageSource`; every request made anywhere inside that run
 * — the agent loop, its sub-agents, compaction — carries the source through
 * its async calls, and the usage ledger reads it when the request is counted.
 * Anything unwrapped (a chat in a window, a title) counts as `chat`.
 */

interface Attribution {
  source?: UsageSource
  /** The project folder the run is for; `''` when it has none. Unset: nobody said, so the request can't be placed. */
  project?: string
}

const current = new AsyncLocalStorage<Attribution>()

export function withUsageSource<T>(source: UsageSource, run: () => T): T {
  return current.run({ ...current.getStore(), source }, run)
}

/**
 * The project folder a run is for, so Settings → Usage can say which project
 * the requests were for. `runAgent` wraps every chat, task, worker and
 * scheduled run in it with the run's folder (`''` when it has none); a
 * request made outside any run (a chat's title) carries none and is counted
 * as unattributed.
 */
export function withUsageProject<T>(project: string, run: () => T): T {
  return current.run({ ...current.getStore(), project }, run)
}

export function usageSource(): UsageSource {
  return current.getStore()?.source ?? 'chat'
}

export function usageProject(): string | undefined {
  return current.getStore()?.project
}
