import type { Chat, ChatMessage } from './types'

/**
 * Side questions: "/btw what does that flag do?" in Chat's message box is
 * answered in a small card over the box, by the chat's own model, from the
 * conversation so far, and joins nothing: it isn't sent into the chat, isn't
 * saved, and works while the chat's own reply is still being written. The
 * model has no tools for it, so it can't change anything. Main answers it
 * (main/agent/sideQuestion.ts); what is asked, and the words of the request,
 * are here.
 */

/** What the renderer asks main. `history` is the chat as stored, without the reply still being written. */
export interface SideQuestionRequest {
  id: string
  providerId: string
  modelId: string
  question: string
  history: ChatMessage[]
  /** The compaction summary standing in for the messages before `history`, if the chat has one. */
  summary: string | null
}

export type SideQuestionResult = { ok: true; text: string } | { ok: false; error: string }

/** A streamed piece of the answer. */
export interface SideQuestionText {
  id: string
  text: string
}

/** The most characters of the conversation that go along (80 KB, about 20,000 tokens). */
export const SIDE_CONTEXT_CHARS = 80_000
/** The longest side question taken. */
export const SIDE_QUESTION_MAX = 4000

export const SIDE_SYSTEM = [
  'You are Eaon. The user asks a quick side question about a conversation they are having with an assistant, which may still be working.',
  'The conversation so far is below the question marker, as text.',
  'Answer the side question directly and briefly, from the conversation and what you know. If the conversation does not say, say that rather than guess.',
  'You have no tools and cannot change anything, run anything or look anything up. This question and your answer are not added to the conversation.',
  'Format with markdown when it helps.'
].join(' ')

/** The one message the model gets: the conversation as text, then the question. */
export function sideQuestionPrompt(transcript: string, question: string): string {
  const said = transcript.trim() ? transcript.trim() : '(Nothing has been said in the conversation yet.)'
  return `The conversation so far:\n\n${said}\n\n---\nThe side question:\n${question.trim()}`
}

/**
 * What a message box's text asks as a side question: "/btw what is x" gives
 * "what is x"; "/btw" alone gives '' (nothing asked yet); anything else, null.
 */
export function parseSideQuestion(text: string): string | null {
  const m = /^\s*\/btw(?:\s+([\s\S]*))?$/i.exec(text)
  return m ? (m[1] ?? '').trim() : null
}

/** The answer as a quote for the chat, for "Add to chat": the question, then the answer, set off from what the user types. */
export function answerAsQuote(question: string, answer: string): string {
  const quote = (text: string): string =>
    text
      .trim()
      .split('\n')
      .map((line) => (line ? `> ${line}` : '>'))
      .join('\n')
  return `${quote(`Side question: ${question}`)}\n>\n${quote(answer)}\n\n`
}

/**
 * What of a chat goes with a side question: its messages as they stand, the
 * reply still being written included (so "what is it doing?" has something
 * to answer from), without system notes and empty messages, and without what
 * a compaction summary already covers.
 */
export function sideContext(chat: Pick<Chat, 'messages' | 'summary'> | null): { history: ChatMessage[]; summary: string | null } {
  if (!chat) return { history: [], summary: null }
  let history = chat.messages.filter((m) => m.role !== 'system' && m.parts.length > 0)
  const summary = chat.summary?.text.trim() ? chat.summary : null
  if (summary) {
    const cut = history.findIndex((m) => m.id === summary.throughMessageId)
    if (cut !== -1) history = history.slice(cut + 1)
  }
  return { history, summary: summary?.text ?? null }
}
