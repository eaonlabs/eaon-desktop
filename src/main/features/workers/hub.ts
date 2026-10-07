import type { ChatMessage, StreamEvent } from '@shared/types'
import type { Worker } from '@shared/workers'

/**
 * Who else wants to hear what the workers engine reports. The service sends
 * everything to the renderer over IPC as before and also puts it here, so the
 * remote server (`main/remote`) follows workers without reaching into the
 * engine, and without knowing there is a window at all.
 *
 * What arrives is what the renderer gets: the whole list on every change, the
 * stream events with consecutive text deltas already merged per frame, and
 * messages in order after the text before them. A listener that throws is
 * logged and skipped, so one subscriber can't stop the others (or the IPC).
 */
export interface WorkersListener {
  /** The whole list, on every metadata change (never per token). */
  changed?: (workers: Worker[]) => void
  /** A stream event from a running turn. Not to be modified. */
  event?: (workerId: string, event: StreamEvent) => void
  /** A message was added to, or replaced whole in, a thread. */
  message?: (workerId: string, message: ChatMessage) => void
}

export interface WorkersHub {
  /** Returns the way to stop listening. */
  subscribe: (listener: WorkersListener) => () => void
  emitChanged: (workers: Worker[]) => void
  emitEvent: (workerId: string, event: StreamEvent) => void
  emitMessage: (workerId: string, message: ChatMessage) => void
}

export function createWorkersHub(): WorkersHub {
  const listeners = new Set<WorkersListener>()
  const each = (call: (listener: WorkersListener) => void): void => {
    for (const listener of [...listeners]) {
      try {
        call(listener)
      } catch (error) {
        console.error('[workers] a listener failed:', error instanceof Error ? error.message : error)
      }
    }
  }
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emitChanged: (workers) => each((l) => l.changed?.(workers)),
    emitEvent: (workerId, event) => each((l) => l.event?.(workerId, event)),
    emitMessage: (workerId, message) => each((l) => l.message?.(workerId, message))
  }
}
