import { useEffect, useState } from 'react'
import { create } from 'zustand'
import type { TurnChanges, TurnRestore } from '@shared/chatCode'
import type { ChatMessage } from '@shared/types'
import { useApp } from '../../state/store'
import { repliesAfter } from '../../state/chatEdits'
import { useChatCode } from './chatCodeStore'

/**
 * Undoing a coding reply's file changes, by the checkpoints main takes
 * around each reply (main/features/chatCheckpoints.ts). A reply's card asks
 * once whether it has them; a reply that just ended is asked again when its
 * after checkpoint lands.
 */

const asked = new Map<string, Promise<TurnChanges>>()
const key = (folder: string, replyId: string): string => `${folder}\n${replyId}`

/** Bumped per reply when its after checkpoint is written, so its card asks again. */
const useLanded = create<Record<string, number>>(() => ({}))
let listening = false
function listen(): void {
  if (listening || !window.api?.chat?.onCheckpoint) return
  listening = true
  window.api.chat.onCheckpoint((replyId) => {
    for (const k of [...asked.keys()]) if (k.endsWith(`\n${replyId}`)) asked.delete(k)
    useLanded.setState({ [replyId]: Date.now() })
  })
}

/** What the reply changed by its checkpoints; null while asking, or with no folder. */
export function useTurnChanges(folder: string | null, replyId: string): TurnChanges | null {
  listen()
  const landed = useLanded((s) => s[replyId] ?? 0)
  const [changes, setChanges] = useState<TurnChanges | null>(null)
  useEffect(() => {
    if (!folder) return
    let live = true
    const k = key(folder, replyId)
    let pending = asked.get(k)
    if (!pending) {
      pending = window.api.chatCode.turnChanges(folder, replyId).catch((): TurnChanges => ({ available: false, files: [] }))
      asked.set(k, pending)
    }
    void pending.then((c) => live && setChanges(c))
    return () => {
      live = false
    }
  }, [folder, replyId, landed])
  return folder ? changes : null
}

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
