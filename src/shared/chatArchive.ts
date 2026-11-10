import type { Chat, ChatMessage } from './types'

/**
 * What Settings → Archived chats works from: which chats "Archive all" takes,
 * which are archived, and a search through their titles and what was said.
 * Pure, so it is tested under plain Node.
 */

/** "1 chat", "12 chats". */
export const chatCount = (n: number): string => `${n} chat${n === 1 ? '' : 's'}`

/**
 * The chats "Archive all" moves: those the sidebar lists (in a chat
 * workspace, not archived). A temporary chat isn't in the sidebar, and a chat
 * with a reply still being written stays, since archiving it would stop the
 * reply.
 */
export function archivable(chats: readonly Chat[], workspaceIds: ReadonlySet<string>, running: Readonly<Record<string, unknown>>): Chat[] {
  return chats.filter((c) => !c.archived && !c.temporary && workspaceIds.has(c.workspaceId) && !(c.id in running))
}

/** The chats `archivable` leaves because a reply is still being written in them. */
export function replying(chats: readonly Chat[], workspaceIds: ReadonlySet<string>, running: Readonly<Record<string, unknown>>): Chat[] {
  return chats.filter((c) => !c.archived && !c.temporary && workspaceIds.has(c.workspaceId) && c.id in running)
}

/** The archived chats, most recently active first. */
export const archivedOf = (chats: readonly Chat[]): Chat[] => chats.filter((c) => c.archived).sort((a, b) => b.updatedAt - a.updatedAt)

/** What was said in a message, without reasoning or tool output. */
function said(message: ChatMessage): string {
  if (message.role === 'system') return ''
  return (Array.isArray(message.parts) ? message.parts : [])
    .filter((part) => part.type === 'text')
    .map((part) => (part as { text: string }).text)
    .join('')
}

const texts = new WeakMap<Chat, string[]>()

/** The text of each message in a chat, kept per chat object (a chat is replaced whenever it changes), so searching again doesn't rebuild it. */
function messageTexts(chat: Chat): string[] {
  let found = texts.get(chat)
  if (!found) {
    found = (Array.isArray(chat.messages) ? chat.messages : []).map(said).filter(Boolean)
    texts.set(chat, found)
  }
  return found
}

export interface ChatHit {
  chat: Chat
  /** A line of what was said around the first match, when the match isn't in the title. */
  snippet?: string
}

/** A short run of `text` around the first place `word` appears, on one line. */
export function snippetAround(text: string, word: string, radius = 48): string {
  const at = text.toLowerCase().indexOf(word.toLowerCase())
  if (at < 0) return ''
  const from = Math.max(0, at - radius)
  const to = Math.min(text.length, at + word.length + radius)
  const line = text.slice(from, to).replace(/\s+/g, ' ').trim()
  return `${from > 0 ? '…' : ''}${line}${to < text.length ? '…' : ''}`
}

/**
 * The chats whose title, or something said in them, holds every word of
 * `query` (in any order, anywhere in a word, ignoring case). Title matches
 * come first; each result from its messages carries a line around the first
 * word found. The order of `chats` is kept within each group. No words
 * asked for: every chat.
 */
export function searchChats(chats: readonly Chat[], query: string): ChatHit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return chats.map((chat) => ({ chat }))
  const titled: ChatHit[] = []
  const inMessages: ChatHit[] = []
  for (const chat of chats) {
    const title = (chat.title ?? '').toLowerCase()
    if (words.every((w) => title.includes(w))) {
      titled.push({ chat })
      continue
    }
    const lines = messageTexts(chat)
    const body = lines.join('\n').toLowerCase()
    const all = `${title}\n${body}`
    if (!words.every((w) => all.includes(w))) continue
    // The line to show: the first message with every word, else the first with any of them (the rest are in the title).
    const best = lines.find((line) => words.every((w) => line.toLowerCase().includes(w))) ?? lines.find((line) => words.some((w) => line.toLowerCase().includes(w))) ?? ''
    inMessages.push({ chat, snippet: snippetAround(best, words.find((w) => best.toLowerCase().includes(w)) ?? words[0]) })
  }
  return [...titled, ...inMessages]
}
