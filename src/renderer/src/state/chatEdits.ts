import type { Chat, ChatMessage, MessageFeedback } from '@shared/types'

/**
 * The chat edits behind a reply's action bar, kept free of the store so tests
 * can run them: the user's thumbs and emoji, retrying the last reply, and
 * forking the conversation at a reply.
 */

/** The chat with one message's feedback changed, or the same object when nothing changed. */
export function withFeedback(chat: Chat, messageId: string, patch: MessageFeedback): Chat {
  let changed = false
  const messages = chat.messages.map((message) => {
    if (message.id !== messageId) return message
    const feedback = { ...message.feedback, ...patch }
    // A cleared thumb and a cleared emoji leave no feedback at all, not an empty object.
    const empty = !feedback.vote && !feedback.reaction
    if (empty && !message.feedback) return message
    changed = true
    const next: ChatMessage = { ...message }
    if (empty) delete next.feedback
    else next.feedback = { ...(feedback.vote ? { vote: feedback.vote } : {}), ...(feedback.reaction ? { reaction: feedback.reaction } : {}) }
    return next
  })
  return changed ? { ...chat, messages } : chat
}

/** The text of a user message, as `messageText` joins it, without the store. */
function userText(message: ChatMessage): string {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => (part as { text: string }).text)
    .join('')
}

/**
 * What retrying a reply takes: the question it answered, and the chat without
 * that question and its reply, so sending the question again puts a fresh
 * reply where the old one was. Only the last reply can be retried; retrying
 * an earlier one would drop everything said since. Null when it can't be.
 */
export function retryPlan(chat: Chat, messageId: string): { text: string; attachments?: string[]; messages: ChatMessage[] } | null {
  const at = chat.messages.findIndex((message) => message.id === messageId)
  if (at === -1 || chat.messages[at].role !== 'assistant') return null
  // A reply still being written (a tool call running) isn't finished to retry.
  if (chat.messages[at].parts.some((part) => part.type === 'tool' && part.status === 'running')) return null
  if (chat.messages.slice(at + 1).some((message) => message.role !== 'system')) return null
  let question = at - 1
  while (question >= 0 && chat.messages[question].role === 'system') question--
  const asked = chat.messages[question]
  if (!asked || asked.role !== 'user' || asked.mail) return null
  const text = userText(asked)
  if (!text.trim() && !asked.attachments?.length) return null
  return {
    text,
    ...(asked.attachments?.length ? { attachments: asked.attachments } : {}),
    messages: chat.messages.slice(0, question)
  }
}

/**
 * A new chat holding the conversation up to and including `messageId`, to
 * take somewhere else without changing this one. The goal stays behind, and
 * so does a summary of messages the fork doesn't have.
 */
export function forkedChat(chat: Chat, messageId: string, id: string, now: number): Chat | null {
  const at = chat.messages.findIndex((message) => message.id === messageId)
  if (at === -1) return null
  const messages = chat.messages.slice(0, at + 1)
  const keepSummary = chat.summary && messages.some((message) => message.id === chat.summary!.throughMessageId)
  const fork: Chat = {
    ...chat,
    id,
    title: `${chat.title} (fork)`.slice(0, 80),
    messages,
    createdAt: now,
    updatedAt: now,
    pinned: false,
    archived: false,
    unread: false
  }
  delete fork.goal
  if (!keepSummary) delete fork.summary
  return fork
}
