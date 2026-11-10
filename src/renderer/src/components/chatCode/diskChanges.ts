import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import type { ReviewFile } from '@shared/adeReview'
import type { CheckpointDiff } from '@shared/chatCode'
import type { ChatMessage } from '@shared/types'
import { codeFolder, runIn, useApp } from '../../state/store'

/**
 * What the agent changed on disk, by the checkpoints main takes around each
 * coding reply (main/features/chatCheckpoints.ts). An agent that writes code
 * with commands (`cat > file`, `sed -i`, a script) leaves no edit call for
 * the counts to read; the checkpoints see every change, however it was made.
 * A reply without them (a folder outside git, an older chat) is counted from
 * its edit calls instead.
 */

/** Bumped per reply when its after checkpoint is written, so what it changed is asked again. */
const useLanded = create<{ epoch: number; replies: Record<string, number> }>(() => ({ epoch: 0, replies: {} }))
const landedHandlers = new Set<(replyId: string) => void>()
let listening = false
function listen(): void {
  if (listening || !window.api?.chat?.onCheckpoint) return
  listening = true
  window.api.chat.onCheckpoint((replyId) => {
    for (const handler of landedHandlers) handler(replyId)
    useLanded.setState((s) => ({ epoch: s.epoch + 1, replies: { ...s.replies, [replyId]: Date.now() } }))
  })
}

/* ------------------------------------------------------------- one reply */

const replyAsked = new Map<string, Promise<ReviewFile[] | null>>()
const replyKey = (folder: string, replyId: string): string => `${folder}\n${replyId}`
landedHandlers.add((replyId) => {
  for (const k of [...replyAsked.keys()]) if (k.endsWith(`\n${replyId}`)) replyAsked.delete(k)
})

/** The cards drawn together ask together: one call for all of a chat's replies. */
const batches = new Map<string, { ids: string[]; answer: Promise<Record<string, ReviewFile[]>> }>()
function askReply(folder: string, replyId: string): Promise<ReviewFile[] | null> {
  const k = replyKey(folder, replyId)
  const known = replyAsked.get(k)
  if (known) return known
  let batch = batches.get(folder)
  if (!batch) {
    const ids: string[] = []
    const answer = Promise.resolve().then(() => {
      batches.delete(folder)
      return window.api.chatCode.replyDiffs(folder, ids).catch((): Record<string, ReviewFile[]> => ({}))
    })
    batch = { ids, answer }
    batches.set(folder, batch)
  }
  batch.ids.push(replyId)
  const files = batch.answer.then((all) => all[replyId] ?? null)
  replyAsked.set(k, files)
  return files
}

/**
 * A finished reply's own changes by its checkpoints: undefined while asking
 * (or with no folder), null when it has none to read them from.
 */
export function useReplyDiskChanges(folder: string | null, replyId: string): ReviewFile[] | null | undefined {
  listen()
  const landed = useLanded((s) => s.replies[replyId] ?? 0)
  const [files, setFiles] = useState<{ key: string; files: ReviewFile[] | null } | null>(null)
  const key = folder ? `${replyKey(folder, replyId)}\n${landed}` : null
  useEffect(() => {
    if (!folder || !key) return
    let live = true
    void askReply(folder, replyId).then((found) => live && setFiles({ key, files: found }))
    return () => {
      live = false
    }
  }, [folder, replyId, key])
  // The last answer stands while a landed checkpoint is asked again.
  return folder && files ? files.files : undefined
}

/* ------------------------------------------------------------- the chat */

/** The chat's replies that could have changed files: ones that called a tool, and whose changes weren't undone. */
export function changingReplies(messages: ChatMessage[]): string[] {
  return messages.filter((m) => m.role === 'assistant' && !m.undone && m.parts.some((p) => p.type === 'tool')).map((m) => m.id)
}

/** Steps the running reply has finished: each one may have changed files. */
function finishedSteps(s: ReturnType<typeof useApp.getState>, replyId: string | null): number {
  if (!replyId) return 0
  const message = s.activeChat()?.messages.find((m) => m.id === replyId)
  return message ? message.parts.filter((p) => p.type === 'tool' && p.status !== 'running').length : 0
}

/** While a reply runs, the folder is compared with its before checkpoint at most this often. */
const LIVE_EVERY_MS = 4000
/**
 * A reply that just ended has its after checkpoint written next, and its
 * landing asks again at once. Until then (or this long, outside git, where
 * none comes) the counts from while it ran stand, rather than falling back
 * to its edit calls for a moment.
 */
const LANDING_WAIT_MS = 3000

/** The latest answer for each chat, shared by everything that counts its changes, and whether a reply was running for it. */
const useChatDiffs = create<Record<string, { key: string; diff: CheckpointDiff; live: boolean; epoch: number }>>(() => ({}))
const asking = new Set<string>()
let lastLive = 0

/** The request for the chat on screen: its folder, its replies, the one running, and what to ask again on. */
export function useChatDiskRequest(): { chatKey: string; key: string; folder: string; ids: string[]; live: string | null; epoch: number } | null {
  listen()
  const folder = useApp(codeFolder)
  const chatId = useApp((s) => s.activeChatId)
  const ids = useApp(useShallow((s) => changingReplies(s.activeChat()?.messages ?? [])))
  const live = useApp((s) => runIn(s, s.activeChatId))
  const steps = useApp((s) => finishedSteps(s, runIn(s, s.activeChatId)))
  const epoch = useLanded((s) => s.epoch)
  if (!folder || !chatId || ids.length === 0) return null
  const chatKey = `${folder}\n${chatId}`
  return { chatKey, key: `${chatKey}\n${ids.join(',')}\n${live ?? ''}:${steps}\n${epoch}`, folder, ids, live, epoch }
}

/**
 * What the chat on screen changed on disk, by its replies' checkpoints,
 * asked again as replies end and, while one runs, as its steps finish. Null
 * until known; the last answer stands while the next is asked.
 */
export function useChatDiskChanges(): CheckpointDiff | null {
  const request = useChatDiskRequest()
  const held = useChatDiffs((s) => (request ? (s[request.chatKey] ?? null) : null))
  const key = request?.key ?? null
  useEffect(() => {
    if (!request || held?.key === request.key) return
    const { chatKey, folder, ids, live, epoch } = request
    // A running reply's every step would mean a snapshot each; one every few seconds is enough.
    const wait = live ? Math.max(0, lastLive + LIVE_EVERY_MS - Date.now()) : held?.live && held.epoch === epoch ? LANDING_WAIT_MS : 0
    const timer = window.setTimeout(() => {
      if (asking.has(request.key)) return
      asking.add(request.key)
      if (live) lastLive = Date.now()
      void window.api.chatCode
        .checkpointDiff(folder, ids, { live })
        .then((diff) => useChatDiffs.setState({ [chatKey]: { key: request.key, diff, live: Boolean(live), epoch } }))
        .catch(() => {})
        .finally(() => asking.delete(request.key))
    }, wait)
    return () => window.clearTimeout(timer)
    // The request is compared by its key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, held?.key])
  return held?.diff ?? null
}
