import type { Chat } from '@shared/types'

/**
 * About how much of the model's context the chat fills, for the meter by the
 * model in the message box. An estimate the way the agent loop makes one
 * (main/agent/context.ts): characters over 3.6, older tool output cut to what
 * the loop replays of it, and only what comes after the chat's summary once
 * older messages have been summarized. The system prompt and tool list come
 * on top; they are about the same every turn, so a fixed allowance stands in.
 */

const CHARS_PER_TOKEN = 3.6
const IMAGE_TOKENS = 1600
/** What the loop keeps of a tool's output from turns before the latest. */
const OLD_OUTPUT_LIMIT = 600
/** The system prompt and tool definitions, roughly. */
const OVERHEAD_TOKENS = 6000

const tokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN)

export function estimateContext(chat: Chat): number {
  let messages = chat.messages
  let total = OVERHEAD_TOKENS
  if (chat.summary) {
    const at = messages.findIndex((m) => m.id === chat.summary!.throughMessageId)
    if (at !== -1) {
      messages = messages.slice(at + 1)
      total += tokens(chat.summary.text)
    }
  }
  const lastTurn = messages.length - 1
  messages.forEach((message, index) => {
    total += (message.attachments?.filter((path) => /\.(png|jpe?g|gif|webp)$/i.test(path)).length ?? 0) * IMAGE_TOKENS
    for (const part of message.parts) {
      if (part.type === 'text') {
        total += tokens(part.text)
        continue
      }
      if (part.type !== 'tool') continue
      total += tokens(JSON.stringify(part.input)) + 10
      const output = part.output ?? ''
      total += tokens(index === lastTurn ? output : output.slice(0, OLD_OUTPUT_LIMIT))
    }
  })
  return total
}
