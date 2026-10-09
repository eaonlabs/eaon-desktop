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

const current = new AsyncLocalStorage<UsageSource>()

export function withUsageSource<T>(source: UsageSource, run: () => T): T {
  return current.run(source, run)
}

export function usageSource(): UsageSource {
  return current.getStore() ?? 'chat'
}
