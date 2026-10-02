import type { EaonEvent } from '@shared/eaonCode'

/**
 * Reduces an RPC event to what the renderer reads, or null to drop it.
 *
 * `agent_end` carries every message of the run and `turn_end` the whole turn
 * again; both duplicate what `message_end` already delivered, and on a long
 * session they are megabytes per turn. The system prompt arrives as a
 * `system`-role message, which the transcript never shows. `entry_appended`
 * repeats each message as a session entry.
 */
export function slimEvent(event: EaonEvent): EaonEvent | null {
  switch (event.type) {
    case 'agent_end':
      return { type: 'agent_end', willRetry: event.willRetry === true }
    case 'turn_end':
      return { type: 'turn_end' }
    case 'entry_appended':
      return null
    case 'message_start':
    case 'message_end': {
      const message = event.message as { role?: string } | undefined
      return message?.role === 'system' ? null : event
    }
    default:
      return event
  }
}

interface Delta {
  type: string
  contentIndex?: number
  delta?: string
}

const COALESCED_DELTAS = new Set(['text_delta', 'thinking_delta', 'toolcall_delta'])

/**
 * Buffers events for one frame and sends them as a single IPC message.
 *
 * A model streams several deltas per frame; one IPC message and one renderer
 * update per token is where streaming UIs lose their frame budget (see
 * "Streaming performance: where the per-token cost lived"). Adjacent deltas
 * for the same content block are merged into one, and a tool's cumulative
 * progress replaces the previous snapshot rather than queueing behind it.
 * Nothing is ever reordered: only an event directly after its own kind merges.
 */
export function createEventBatcher(
  send: (events: EaonEvent[]) => void,
  intervalMs = 16
): { push: (event: EaonEvent) => void; flush: () => void; dispose: () => void } {
  let queue: EaonEvent[] = []
  let timer: ReturnType<typeof setTimeout> | null = null

  const flush = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (queue.length === 0) return
    const batch = queue
    queue = []
    send(batch)
  }

  const merge = (event: EaonEvent): boolean => {
    const last = queue[queue.length - 1]
    if (!last || last.type !== event.type) return false

    if (event.type === 'message_update') {
      const next = event.assistantMessageEvent as Delta | undefined
      const prev = last.assistantMessageEvent as Delta | undefined
      if (!next || !prev || !COALESCED_DELTAS.has(next.type)) return false
      if (prev.type !== next.type || prev.contentIndex !== next.contentIndex) return false
      last.assistantMessageEvent = { ...prev, delta: (prev.delta ?? '') + (next.delta ?? '') }
      if (event.usage) last.usage = event.usage
      return true
    }
    if (event.type === 'tool_execution_update') {
      // partialResult is the whole output so far, so the newest one wins.
      if (last.toolCallId !== event.toolCallId) return false
      queue[queue.length - 1] = event
      return true
    }
    if (event.type === 'bash_execution_update') {
      if (last.id !== event.id) return false
      last.delta = String(last.delta ?? '') + String(event.delta ?? '')
      return true
    }
    return false
  }

  return {
    push(raw) {
      const event = slimEvent(raw)
      if (!event) return
      if (!merge(event)) {
        // Copy anything that may be merged into later, so the caller's object
        // is never mutated.
        queue.push(
          event.type === 'message_update' && event.assistantMessageEvent
            ? { ...event, assistantMessageEvent: { ...(event.assistantMessageEvent as object) } }
            : event.type === 'bash_execution_update'
              ? { ...event }
              : event
        )
      }
      if (!timer) timer = setTimeout(flush, intervalMs)
    },
    flush,
    dispose() {
      if (timer) clearTimeout(timer)
      timer = null
      queue = []
    }
  }
}
