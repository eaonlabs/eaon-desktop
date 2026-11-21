import type { Chat } from '@shared/types'

/**
 * How much of the model's context the chat fills, and with what, for the
 * meter by the model in the message box. The parts are an estimate the way
 * the agent loop makes one (main/agent/context.ts): characters over 3.6,
 * older tool output cut to what the loop replays of it, and only what comes
 * after the chat's summary once older messages have been summarized. When
 * the latest reply says how big its request was (TokenUsage.context, as the
 * provider counted it), that is the total, and the parts are fitted to it:
 * what the conversation doesn't account for is the system prompt and tools.
 */

const CHARS_PER_TOKEN = 3.6
const IMAGE_TOKENS = 1600
/** What the loop keeps of a tool's output from turns before the latest. */
const OLD_OUTPUT_LIMIT = 600
/** The system prompt and tool definitions, roughly, when nothing has counted them. */
const OVERHEAD_TOKENS = 6000

const tokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN)

export interface ContextParts {
  /** What was said: your messages and the model's replies. */
  messages: number
  /** The tools' calls and what they returned. */
  tools: number
  /** Pictures sent with messages. */
  files: number
  /** The summary standing in for older messages. */
  summary: number
  /** The system prompt and the tools' definitions. */
  system: number
}

export interface ContextUse {
  parts: ContextParts
  total: number
  /** The total is the provider's own count of the latest request, not an estimate. */
  counted: boolean
}

function estimateParts(chat: Chat): ContextParts {
  const parts: ContextParts = { messages: 0, tools: 0, files: 0, summary: 0, system: OVERHEAD_TOKENS }
  let messages = chat.messages
  if (chat.summary) {
    const at = messages.findIndex((m) => m.id === chat.summary!.throughMessageId)
    if (at !== -1) {
      messages = messages.slice(at + 1)
      parts.summary = tokens(chat.summary.text)
    }
  }
  const lastTurn = messages.length - 1
  messages.forEach((message, index) => {
    parts.files += (message.attachments?.filter((path) => /\.(png|jpe?g|gif|webp)$/i.test(path)).length ?? 0) * IMAGE_TOKENS
    for (const part of message.parts) {
      if (part.type === 'text') {
        parts.messages += tokens(part.text)
        continue
      }
      if (part.type !== 'tool') continue
      const output = part.output ?? ''
      parts.tools += tokens(JSON.stringify(part.input)) + 10 + tokens(index === lastTurn ? output : output.slice(0, OLD_OUTPUT_LIMIT))
    }
  })
  return parts
}

const sum = (p: ContextParts): number => p.messages + p.tools + p.files + p.summary + p.system

/**
 * The latest reply's own count of its request, while it is the last thing in
 * the chat. A reply from before replies kept it, one that called no tool, was
 * one request: its usage is that request.
 */
function countedContext(chat: Chat): number | null {
  const last = chat.messages.at(-1)
  if (last?.role !== 'assistant' || !last.usage) return null
  if (last.usage.context) return last.usage.context
  if (last.parts.some((part) => part.type === 'tool')) return null
  const { input, cacheRead, cacheWrite, output } = last.usage
  return input + cacheRead + cacheWrite + output || null
}

export function contextUse(chat: Chat): ContextUse {
  const parts = estimateParts(chat)
  const counted = countedContext(chat)
  if (counted === null) return { parts, total: sum(parts), counted: false }
  // The conversation's share as estimated; the rest of the count is the system prompt and tools.
  // An estimate bigger than the count is scaled down to it.
  const said = parts.messages + parts.tools + parts.files + parts.summary
  if (said <= counted) return { parts: { ...parts, system: counted - said }, total: counted, counted: true }
  const scale = counted / said
  return {
    parts: { messages: parts.messages * scale, tools: parts.tools * scale, files: parts.files * scale, summary: parts.summary * scale, system: 0 },
    total: counted,
    counted: true
  }
}
