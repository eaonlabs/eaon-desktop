import type { ChatMessage } from '@shared/types'

/**
 * Turning a worker's Markdown reply into something each chat app shows well.
 * Discord renders Markdown itself; Telegram gets its small HTML subset;
 * WhatsApp has its own *bold* _italic_ ~strike~ ```mono``` marks. Long replies
 * are split on paragraph, then line, then word boundaries so no message goes
 * over the app's limit.
 */

/** Tools that tidy up after the work (status line, schedule, memory) — text before them is still the answer. */
const BOOKKEEPING = new Set([
  'set_status',
  'set_heartbeat',
  'add_routine',
  'remove_routine',
  'set_goal',
  'update_notes',
  'update_plan',
  'notify_user',
  'send_chat_message'
])

/**
 * What to post back from a turn: the text written after the last real tool
 * call — the answer, not the "let me check" narration on the way there. A
 * worker that ends by setting its status still has its answer before that.
 */
export function replyText(message: ChatMessage): string {
  const parts = message.parts
  let last = -1
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]
    if (part.type === 'tool' && !BOOKKEEPING.has(part.name)) {
      last = i
      break
    }
  }
  const after = parts
    .slice(last + 1)
    .filter((p) => p.type === 'text')
    .map((p) => (p as { text: string }).text.trim())
    .filter(Boolean)
    .join('\n\n')
  if (after) return after
  return parts
    .filter((p) => p.type === 'text')
    .map((p) => (p as { text: string }).text.trim())
    .filter(Boolean)
    .join('\n\n')
}

/** Splits `text` into pieces of at most `max` characters, preferring paragraph, line and word breaks. */
export function chunkText(text: string, max: number): string[] {
  const chunks: string[] = []
  let rest = text.trim()
  while (rest.length > max) {
    const window = rest.slice(0, max)
    let cut = window.lastIndexOf('\n\n')
    if (cut < max * 0.4) cut = window.lastIndexOf('\n')
    if (cut < max * 0.4) cut = window.lastIndexOf(' ')
    if (cut < max * 0.4) cut = max
    chunks.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  if (rest) chunks.push(rest)
  return chunks
}

const escapeHtml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * Markdown to the HTML Telegram accepts (b, i, s, code, pre, a). Code is
 * lifted out first so nothing inside it is touched. Anything the conversion
 * gets wrong, Telegram rejects, and the sender falls back to plain text.
 */
export function toTelegramHtml(markdown: string): string {
  const stash: string[] = []
  const keep = (html: string): string => `\u0000${stash.push(html) - 1}\u0000`
  let text = markdown.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_m, code: string) => keep(`<pre>${escapeHtml(code.replace(/\n$/, ''))}</pre>`))
  text = text.replace(/`([^`\n]+)`/g, (_m, code: string) => keep(`<code>${escapeHtml(code)}</code>`))
  text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label: string, url: string) =>
    keep(`<a href="${escapeHtml(url).replace(/"/g, '&quot;')}">${escapeHtml(label)}</a>`)
  )
  // Bare links keep their underscores and asterisks.
  text = text.replace(/https?:\/\/[^\s<>]+/g, (url) => keep(escapeHtml(url)))
  text = escapeHtml(text)
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/__([^_\n]+)__/g, '<b>$1</b>')
  text = text.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<i>$2</i>').replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<i>$2</i>')
  text = text.replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
  text = text.replace(/^(\s*)[-*]\s+/gm, '$1• ')
  return text.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => stash[Number(i)])
}

/** Markdown to WhatsApp's own marks. */
export function toWhatsApp(markdown: string): string {
  const stash: string[] = []
  const keep = (text: string): string => `\u0000${stash.push(text) - 1}\u0000`
  let text = markdown.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_m, code: string) => keep(`\`\`\`${code.replace(/\n$/, '')}\`\`\``))
  text = text.replace(/`([^`\n]+)`/g, (_m, code: string) => keep(`\`${code}\``))
  text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label: string, url: string) => (label === url ? url : `${label} (${url})`))
  text = text.replace(/https?:\/\/[^\s<>()]+/g, (url) => keep(url))
  text = text.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1_$2_')
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '*$1*').replace(/__([^_\n]+)__/g, '*$1*')
  text = text.replace(/~~([^~\n]+)~~/g, '~$1~')
  text = text.replace(/^(\s*)[-*]\s+/gm, '$1• ')
  return text.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => stash[Number(i)])
}

/** Markdown with its marks taken off, for when an app refuses the formatted version. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[^\n]*\n?([\s\S]*?)```/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/~~([^~\n]+)~~/g, '$1')
}

/**
 * The part of a message after the worker's name, when it was called by name:
 * "Nova, what's up" / "@nova what's up" / "hey Nova: what's up". Null when
 * the message doesn't start with the name.
 */
export function calledByName(text: string, name: string): string | null {
  const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (!escaped) return null
  const match = new RegExp(`^\\s*(?:(?:hey|hi|ok|okay)\\s+)?@?${escaped}(?:[\\s,:;!?.-]+|$)`, 'i').exec(text)
  return match ? text.slice(match[0].length).trim() : null
}

/** "/status@NovaBot extra" → { name: 'status', args: 'extra' }. Null for anything that isn't a command. */
export function parseCommand(text: string): { name: string; args: string } | null {
  const match = /^\/([a-z]+)(?:@[\w.]+)?(?:\s+([\s\S]*))?$/i.exec(text.trim())
  return match ? { name: match[1].toLowerCase(), args: (match[2] ?? '').trim() } : null
}
