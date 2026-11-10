import type { TurnRestore } from '@shared/chatCode'
import type { ChatMessage } from '@shared/types'
import { useApp } from '../../state/store'
import { repliesAfter } from '../../state/chatEdits'
import { useChatCode } from './chatCodeStore'

/**
 * Undoing a coding reply's file changes, by the checkpoints main takes
 * around each reply (main/features/chatCheckpoints.ts). Whether a reply has
 * them, and what they hold, its card asks through diskChanges.ts.
 */

/** Undo or redo a reply's changes; on success the reply is marked and git's status read again. */
export async function restoreReply(folder: string, replyId: string, direction: 'undo' | 'redo', force = false): Promise<TurnRestore> {
  const result = await window.api.chatCode.restoreTurn(folder, replyId, direction, force).catch(
    (error: unknown): TurnRestore => ({ ok: false, error: error instanceof Error ? error.message : String(error) })
  )
  if (result.ok) {
    useApp.getState().setMessageUndone(replyId, direction === 'undo')
    void useChatCode.getState().refresh()
  }
  return result
}

/**
 * Edit from here, files too: the files the replies after the message changed
 * go back to before the first of them. Replies already undone are left out,
 * their files are back already.
 */
export async function rewindFiles(folder: string, messages: ChatMessage[], userMessageId: string): Promise<TurnRestore> {
  const undone = new Set(messages.filter((m) => m.undone).map((m) => m.id))
  const replies = repliesAfter(messages, userMessageId)
  const first = replies[0]
  const ids = replies.filter((id) => id === first || !undone.has(id))
  if (ids.length === 0) return { ok: true, files: [] }
  const result = await window.api.chatCode.rewind(folder, ids).catch(
    (error: unknown): TurnRestore => ({ ok: false, error: error instanceof Error ? error.message : String(error) })
  )
  if (result.ok) void useChatCode.getState().refresh()
  return result
}
