import type { ChatMessage } from '@shared/types'

/**
 * Whether the chat's latest turn ended in an error, which is when the sidebar
 * marks it. An error from an earlier turn that the chat has since moved past
 * doesn't count: the reply after it went through. System notes (compaction,
 * goal updates) aren't turns, so they're skipped.
 */
export function lastTurnFailed(messages: readonly ChatMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role === 'system') continue
    return message.role === 'assistant' && Boolean(message.error)
  }
  return false
}
