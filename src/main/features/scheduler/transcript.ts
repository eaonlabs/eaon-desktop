import type { Chat, ChatMessage, ChatToolPart, StreamEvent } from '@shared/types'

/**
 * Anything with a transcript: a run's chat, or a worker's thread (which has
 * no title, goal or timestamp of its own).
 */
export interface TranscriptTarget {
  messages: ChatMessage[]
  updatedAt?: number
  goal?: Chat['goal']
  summary?: Chat['summary']
}

/**
 * Applies agent stream events to a chat in the main process.
 *
 * Interactive chats are assembled by the renderer's store, but a scheduled run
 * may have no renderer to do it — the window can be closed, or close halfway
 * through. The scheduler therefore keeps its own copy of every run's chat and
 * treats it as the authoritative one; this is the same reduction the
 * renderer's `chat:event` listener performs, on a copy the runner owns, so it
 * mutates in place instead of preserving identities for React.
 */
export function applyStreamEvent(chat: TranscriptTarget, event: StreamEvent): void {
  const message = chat.messages.find((m) => m.id === event.messageId)
  if (!message) return
  const touch = (): void => {
    if ('updatedAt' in chat) chat.updatedAt = Date.now()
  }
  switch (event.type) {
    case 'delta':
      appendText(message, 'text', event.text)
      break
    case 'reasoning':
      appendText(message, 'reasoning', event.text)
      break
    case 'error':
      message.error = event.error
      touch()
      break
    case 'done':
      touch()
      break
    case 'usage':
      message.usage = event.usage
      break
    case 'plan':
      message.plan = event.plan
      break
    case 'todos':
      message.todos = event.todos
      break
    case 'goal':
      chat.goal = event.goal
      break
    case 'compacted':
      chat.summary = { text: event.summary, throughMessageId: event.throughMessageId }
      break
    case 'tool-call':
      message.parts.push({ type: 'tool', id: event.toolId, name: event.name, input: event.input, output: null, status: 'running' })
      break
    case 'tool-progress': {
      const part = toolPart(message, event.toolId)
      if (part) part.progress = event.output
      break
    }
    case 'subagent': {
      const part = toolPart(message, event.toolId)
      if (part) {
        const agents = part.agents ?? []
        agents[event.run.index] = event.run
        part.agents = agents
      }
      break
    }
    case 'tool-result': {
      const part = toolPart(message, event.toolId)
      if (part) {
        part.output = event.output
        part.status = event.status
        delete part.progress
        if (event.images) part.images = event.images
      }
      break
    }
    case 'approval-request':
      // Unattended runs answer approvals themselves; nothing lands in the transcript.
      break
  }
}

function toolPart(message: ChatMessage, toolId: string): ChatToolPart | undefined {
  return message.parts.find((p): p is ChatToolPart => p.type === 'tool' && p.id === toolId)
}

function appendText(message: ChatMessage, type: 'text' | 'reasoning', text: string): void {
  const last = message.parts[message.parts.length - 1]
  // Same coalescing rule as the renderer: a tool call separates the text either side of it.
  if (last && last.type !== 'tool' && last.type === type) last.text += text
  else message.parts.push({ type, text })
}

/**
 * One line for the run history: the first real sentence of the reply, with
 * markdown and code stripped so a heading or a fenced block does not become
 * the "summary".
 */
export function summariseReply(text: string, limit = 140): string {
  const withoutCode = text.replace(/```[\s\S]*?(```|$)/g, '\n')
  for (const raw of withoutCode.split('\n')) {
    const line = raw
      .replace(/^\s*(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      // Emphasis markers, but not the underscores inside snake_case names.
      .replace(/\*+|`|(^|\W)_+|_+(?=\W|$)/g, (_match, lead) => lead ?? '')
      .replace(/\s+/g, ' ')
      .trim()
    if (line.length < 2 || /^[-=_*|:\s]+$/.test(line)) continue
    return line.length > limit ? `${line.slice(0, limit - 1).trimEnd()}…` : line
  }
  return ''
}
