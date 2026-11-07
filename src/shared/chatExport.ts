import type { Chat, ChatMessage, ChatMessagePart } from './types'

/**
 * A chat as a file: Markdown to read, JSON to keep everything. Pure, so the
 * formats are tested under plain Node; the save dialog and the write are in
 * main/features/chatExport.ts.
 *
 * Both take a chat as the renderer holds it, so each tolerates a missing
 * field rather than throwing: an old chat, or one still being written.
 */

export type ExportFormat = 'markdown' | 'json'

export const EXPORT_FORMATS: Record<ExportFormat, { label: string; extension: string }> = {
  markdown: { label: 'Markdown', extension: 'md' },
  json: { label: 'JSON', extension: 'json' }
}

export const isExportFormat = (value: unknown): value is ExportFormat => value === 'markdown' || value === 'json'

/** A file name from the chat's title: lowercase words joined by dashes, with the format's extension. */
export function exportFileName(title: unknown, format: ExportFormat): string {
  const slug = String(typeof title === 'string' ? title : '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '')
  return `${slug || 'chat'}.${EXPORT_FORMATS[format].extension}`
}

const parts = (message: ChatMessage): ChatMessagePart[] => (Array.isArray(message.parts) ? message.parts : [])

/** What was said in a message: its text parts joined, without the model's reasoning or tool calls. */
function textOf(message: ChatMessage): string {
  return parts(message)
    .filter((part) => part.type === 'text')
    .map((part) => (part as { text: string }).text)
    .join('')
    .trim()
}

const baseName = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path

const day = (time: unknown): string => (typeof time === 'number' && Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : '')

/**
 * The conversation as Markdown: what you and the assistant said, in order.
 * Tool calls appear as one line each (their input and output are in the JSON
 * export), the model's reasoning is left out, and an attachment is named by
 * its file name, not its path on this computer.
 */
export function chatToMarkdown(chat: Pick<Chat, 'title' | 'createdAt' | 'messages'>, now = Date.now()): string {
  const title = (typeof chat.title === 'string' && chat.title.trim()) || 'Chat'
  const started = day(chat.createdAt)
  const out: string[] = [`# ${title.replace(/\s+/g, ' ')}`, '', `Exported from Eaon on ${day(now)}${started ? `. Chat started ${started}.` : '.'}`]
  for (const message of Array.isArray(chat.messages) ? chat.messages : []) {
    if (message.role === 'system') continue
    const text = textOf(message)
    const calls = parts(message).filter((part) => part.type === 'tool') as Extract<ChatMessagePart, { type: 'tool' }>[]
    const files = (message.attachments ?? []).filter((path) => typeof path === 'string' && path)
    // A reply that is only an empty placeholder (still starting) adds nothing.
    if (!text && calls.length === 0 && files.length === 0 && !message.error) continue
    out.push('', '---', '', message.role === 'user' ? '## You' : message.model ? `## Assistant (${message.model})` : '## Assistant')
    if (files.length) out.push('', `Attached: ${files.map(baseName).join(', ')}`)
    if (text) out.push('', text)
    if (calls.length) out.push('', ...calls.map((call) => `- Used ${call.name}${call.status === 'denied' ? ' (not allowed)' : call.status === 'error' ? ' (failed)' : ''}`))
    if (message.error) out.push('', `> Error: ${message.error.replace(/\s+/g, ' ')}`)
    else if (message.stopped) out.push('', '> Stopped before it finished.')
  }
  return `${out.join('\n')}\n`
}

/** A message with what only the screen needs left out (live progress, a write's old file text, flags for the UI). */
function messageForJson(message: ChatMessage): Record<string, unknown> {
  return {
    id: message.id,
    role: message.role,
    createdAt: message.createdAt,
    ...(message.finishedAt ? { finishedAt: message.finishedAt } : {}),
    ...(message.model ? { model: message.model } : {}),
    parts: parts(message).map((part) => {
      if (part.type !== 'tool') return part
      const { progress: _progress, before: _before, ...rest } = part
      void _progress
      void _before
      return rest
    }),
    ...(message.attachments?.length ? { attachments: message.attachments } : {}),
    ...(message.error ? { error: message.error } : {}),
    ...(message.stopped ? { stopped: true } : {}),
    ...(message.usage ? { usage: message.usage } : {}),
    ...(message.plan ? { plan: message.plan } : {}),
    ...(message.todos ? { todos: message.todos } : {}),
    ...(message.feedback ? { feedback: message.feedback } : {})
  }
}

/**
 * Everything in the chat as JSON: every message with its tool calls and
 * their output, the compaction summary if there is one, and token counts.
 * Attachments and screenshots are file paths on this computer; the files
 * themselves aren't in it.
 */
export function chatToJson(chat: Chat, now = Date.now()): string {
  return `${JSON.stringify(
    {
      format: 'eaon-chat',
      version: 1,
      exportedAt: new Date(now).toISOString(),
      chat: {
        id: chat.id,
        title: chat.title,
        createdAt: chat.createdAt,
        updatedAt: chat.updatedAt,
        modelId: chat.modelId ?? null,
        ...(chat.summary ? { summary: chat.summary } : {}),
        messages: (Array.isArray(chat.messages) ? chat.messages : []).map(messageForJson)
      }
    },
    null,
    2
  )}\n`
}

/** The file's text for a format. */
export const chatExportText = (chat: Chat, format: ExportFormat, now = Date.now()): string =>
  format === 'json' ? chatToJson(chat, now) : chatToMarkdown(chat, now)
