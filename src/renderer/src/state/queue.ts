import { create } from 'zustand'
import { useApp } from './store'

/**
 * Follow-ups typed while a reply is still being written. ⏎ during a reply
 * used to do nothing, so a thought had to wait in the box until the run
 * ended; now it waits here, under the conversation, and goes as the next
 * message once the reply is done. Kept per chat, for this window's session.
 *
 * The queue holds back after a reply that failed, and after the user
 * pressed Stop: both are moments to look before anything else is sent. Each
 * queued message can still be sent at once from its row.
 */

export interface QueuedMessage {
  id: string
  text: string
  attachments: string[]
}

interface QueueState {
  byChat: Record<string, QueuedMessage[]>
  /** Chats whose queue waits for the user (after Stop or a failed reply). */
  held: Record<string, boolean>
}

export const useQueue = create<QueueState>(() => ({ byChat: {}, held: {} }))

const EMPTY: QueuedMessage[] = []

/** The chat's queued messages, oldest first. */
export function useQueued(chatId: string | null): QueuedMessage[] {
  return useQueue((s) => (chatId ? (s.byChat[chatId] ?? EMPTY) : EMPTY))
}

const nextId = (): string => `q${Math.random().toString(36).slice(2, 10)}`

function setList(chatId: string, update: (list: QueuedMessage[]) => QueuedMessage[]): void {
  useQueue.setState((s) => {
    const list = update(s.byChat[chatId] ?? EMPTY)
    const byChat = { ...s.byChat }
    if (list.length > 0) byChat[chatId] = list
    else delete byChat[chatId]
    return { byChat }
  })
}

export function enqueue(chatId: string, text: string, attachments: string[]): void {
  setList(chatId, (list) => [...list, { id: nextId(), text, attachments }])
}

/** Takes a message out of the queue (Remove, or Edit putting it back in the box). */
export function unqueue(chatId: string, id: string): QueuedMessage | undefined {
  const found = useQueue.getState().byChat[chatId]?.find((m) => m.id === id)
  setList(chatId, (list) => list.filter((m) => m.id !== id))
  return found
}

/** Stop pressed with messages waiting: they wait for the user too. */
export function holdQueue(chatId: string): void {
  if (!useQueue.getState().byChat[chatId]?.length) return
  useQueue.setState((s) => ({ held: { ...s.held, [chatId]: true } }))
}

function release(chatId: string): void {
  if (!useQueue.getState().held[chatId]) return
  useQueue.setState((s) => {
    const held = { ...s.held }
    delete held[chatId]
    return { held }
  })
}

/**
 * Sends one queued message now. During a reply it stops the reply first, as
 * the user would have had to; what it had written so far stays.
 */
export function sendQueuedNow(chatId: string, id: string): void {
  const app = useApp.getState()
  if (app.activeChatId !== chatId) return
  const message = unqueue(chatId, id)
  if (!message) return
  release(chatId)
  if (app.runs[chatId]) app.stop(chatId)
  void useApp.getState().send(message.text, { attachments: message.attachments, chatId })
}

/** A held queue's Resume: it goes on from the next message. */
export function resumeQueue(chatId: string): void {
  release(chatId)
  drain()
}

/**
 * Sends each chat's next queued message once its own reply is done and its
 * queue isn't held. Other chats running don't hold it up, and neither does
 * the chat being somewhere else on screen: it goes on in the background.
 */
function drain(): void {
  const app = useApp.getState()
  const { byChat, held } = useQueue.getState()
  for (const chatId of Object.keys(byChat)) {
    if (held[chatId] || app.runs[chatId] || !app.chats.some((c) => c.id === chatId)) continue
    const next = byChat[chatId]?.[0]
    if (!next) continue
    unqueue(chatId, next.id)
    void app.send(next.text, { attachments: next.attachments, chatId })
  }
}

let watching = false

/** Sends a chat's next message whenever its reply ends. */
export function watchQueue(): void {
  if (watching) return
  watching = true
  useApp.subscribe((state, previous) => {
    if (state.runs === previous.runs) return
    const finished = Object.keys(previous.runs).filter((chatId) => !state.runs[chatId])
    if (finished.length === 0) return
    for (const chatId of finished) {
      const chat = state.chats.find((c) => c.id === chatId)
      const last = chat?.messages[chat.messages.length - 1]
      if (last?.role === 'assistant' && last.error) holdQueue(chatId)
    }
    setTimeout(drain, 0)
  })
}
