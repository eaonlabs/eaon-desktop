import type { Adapter, TurnRequest, TurnResult } from './adapters/types'

/**
 * Limits on how long a model reply may take, so a provider that keeps a
 * connection open can't hold a turn (and its Stop button, and a worker's
 * slot) forever.
 *
 * - Idle: once the reply has started, no data for this long ends it. Before
 *   the first byte the connection's own 5-minute headers timeout applies
 *   (a local model reading a long prompt is slow, not stuck).
 * - Total: a reply still going after this long ends too, however often it
 *   sends data (keep-alive comments included). Generous: a long reasoning
 *   answer or a slow local model legitimately takes a while.
 *
 * Exported mutable so tests can shrink them.
 */
export const STREAM_LIMITS = {
  idleMs: 3 * 60_000,
  localIdleMs: 10 * 60_000,
  totalMs: 45 * 60_000,
  localTotalMs: 3 * 60 * 60_000
}

/** Named like the platform's own, so the failure classifies as a timeout. */
export class StreamTimeoutError extends Error {
  constructor(
    readonly kind: 'idle' | 'total',
    message: string
  ) {
    super(message)
    this.name = 'TimeoutError'
  }
}

export interface StreamGuard {
  /** Aborts when the caller's does, or when a limit is reached. Give this to the request. */
  signal: AbortSignal
  /** Data arrived: the reply is alive. The first call starts the idle clock. */
  touch(): void
  /** The timeout error when a limit ended the request, else the error as it came. */
  translate(error: unknown): unknown
  stop(): void
}

const minutes = (ms: number): string => (ms >= 90 * 60_000 ? `${Math.round(ms / 3_600_000)} hours` : ms >= 90_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.round(ms / 1000)} seconds`)

export function streamGuard(parent: AbortSignal, who: { name: string; local: boolean }): StreamGuard {
  const idleMs = who.local ? STREAM_LIMITS.localIdleMs : STREAM_LIMITS.idleMs
  const totalMs = who.local ? STREAM_LIMITS.localTotalMs : STREAM_LIMITS.totalMs
  const controller = new AbortController()
  let idle: ReturnType<typeof setTimeout> | null = null
  let reason: StreamTimeoutError | null = null
  const end = (error: StreamTimeoutError): void => {
    reason ??= error
    controller.abort(error)
  }
  const total = setTimeout(
    () => end(new StreamTimeoutError('total', `${who.name} was still replying after ${minutes(totalMs)}, so the request was stopped. Try a shorter task, or another model.`)),
    totalMs
  )
  total.unref?.()
  const stop = (): void => {
    clearTimeout(total)
    if (idle) clearTimeout(idle)
    idle = null
  }
  return {
    signal: AbortSignal.any([parent, controller.signal]),
    touch() {
      if (reason) return
      if (idle) clearTimeout(idle)
      idle = setTimeout(() => end(new StreamTimeoutError('idle', `${who.name} stopped sending data for ${minutes(idleMs)}, so the request was abandoned.`)), idleMs)
      idle.unref?.()
    },
    translate(error) {
      // The caller's Stop wins: that is a cancellation, not a timeout.
      return reason && !parent.aborted ? reason : error
    },
    stop
  }
}

/** An adapter whose `turn` also receives the guard, so it can report data as it arrives. */
export type GuardedAdapter = Omit<Adapter, 'turn'> & { turn(request: TurnRequest, guard: StreamGuard): Promise<TurnResult> }

/** Wraps `turn` so every request runs under the stream limits and a limit's timeout reads as one. */
export function guardedAdapter(adapter: GuardedAdapter): Adapter {
  return {
    ...adapter,
    async turn(request) {
      const guard = streamGuard(request.signal, { name: request.provider.name, local: request.provider.local })
      try {
        return await adapter.turn({ ...request, signal: guard.signal }, guard)
      } catch (error) {
        throw guard.translate(error)
      } finally {
        guard.stop()
      }
    }
  }
}
