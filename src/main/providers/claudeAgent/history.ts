import { createHash } from 'node:crypto'
import type { NeutralMessage } from '../adapters/types'
import { transcriptText } from '../../agent/context'

/**
 * How a conversation in Eaon lines up with Claude's session of it.
 *
 * Eaon's history is the record; Claude's session is a copy it keeps
 * continuing for as long as the two agree. Between turns Eaon rebuilds the
 * history from the saved chat (agent/context.ts `buildHistory`): older tool
 * output is shortened, an attachment read in full becomes a note, and the
 * loop's own nudges ("Go ahead and do it now…") aren't saved at all. So the
 * two are compared by what survives a rebuild: what the person typed, and the
 * id of every tool call, in order.
 */

/** What the person typed, without the attachments a rebuild may write differently. */
function typed(text: string): string {
  // buildHistory's notes: `Attached file …`, `[Attached: …]`, `[Attached image … was not sent…]`.
  const cut = text.search(/\n\n(?:Attached file |\[Attached[: ])/)
  return (cut === -1 ? text : text.slice(0, cut)).trim().slice(0, 400)
}

export function userKey(text: string): string {
  return `u:${createHash('sha256').update(typed(text)).digest('hex').slice(0, 16)}`
}

/** A conversation as the keys that survive a rebuild. */
export function fingerprint(messages: NeutralMessage[]): string[] {
  const keys: string[] = []
  for (const message of messages) {
    if (message.role === 'user') {
      // Stand-ins Eaon adds, not words anyone typed.
      if (message.text === '(continuing the conversation)') continue
      keys.push(userKey(message.text))
    } else if (message.role === 'assistant') {
      for (const call of message.calls) keys.push(`c:${call.id}`)
    }
  }
  return keys
}

export const sameKeys = (a: string[], b: string[]): boolean => a.length === b.length && a.every((key, i) => key === b[i])

/** How much of an earlier conversation is written into a new session's first message. */
const CHECKPOINT_CHARS = 120_000

/**
 * The first message of a session that joins a conversation already under
 * way: everything said and done so far (Claude can't load history it didn't
 * write), then the message to answer.
 */
export function withCheckpoint(earlier: NeutralMessage[], text: string): string {
  if (earlier.length === 0) return text
  const record = transcriptText(earlier, CHECKPOINT_CHARS)
  return [
    '<conversation-checkpoint>',
    'This conversation in Eaon began before this session. What was said and done so far, for context (the tool calls ran in Eaon):',
    '',
    record,
    '</conversation-checkpoint>',
    '',
    text
  ].join('\n')
}

/** A user message's content blocks: its text and images. */
export function userContent(message: Extract<NeutralMessage, { role: 'user' }>, text = message.text): Record<string, unknown>[] {
  const content: Record<string, unknown>[] = [{ type: 'text', text: text || '(no text)' }]
  for (const image of message.images ?? []) content.push({ type: 'image', source: { type: 'base64', media_type: image.mime, data: image.data } })
  return content
}
