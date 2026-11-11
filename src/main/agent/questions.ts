import { randomUUID } from 'node:crypto'
import type { StreamEvent } from '@shared/types'
import { cleanAnswers, type AskAnswer, type AskQuestion } from '@shared/askQuestions'

/**
 * The question round-trip, like the approval one (approvals.ts): the tool
 * emits a `question-request` over the stream and waits on a promise the
 * window resolves over `chat:answer-question`. Stopping the turn resolves
 * every question it is parked on with no answer, so nothing waits forever.
 */

interface Pending {
  messageId: string
  questions: AskQuestion[]
  resolve: (answers: AskAnswer[] | null) => void
}

const pending = new Map<string, Pending>()

/** Asks the questions; resolves with the answers, or null when the user dismissed them or the turn stopped. */
export function requestAnswers(messageId: string, questions: AskQuestion[], emit: (event: StreamEvent) => void): Promise<AskAnswer[] | null> {
  const requestId = randomUUID()
  return new Promise((resolve) => {
    pending.set(requestId, { messageId, questions, resolve })
    emit({ type: 'question-request', messageId, requestId, questions })
  })
}

/** The window's answer; null (or nothing usable) when the questions were dismissed. */
export function resolveQuestion(requestId: string, answers: unknown): void {
  const entry = pending.get(requestId)
  if (!entry) return
  pending.delete(requestId)
  entry.resolve(answers === null ? null : cleanAnswers(answers, entry.questions))
}

export function cancelQuestions(messageId: string): void {
  for (const [requestId, entry] of pending) {
    if (entry.messageId !== messageId) continue
    pending.delete(requestId)
    entry.resolve(null)
  }
}
