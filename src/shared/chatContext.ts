import type { ChatCommit } from './chatCode'
import type { Chat, ChatMessage } from './types'

/**
 * What an "@" mention in Chat's message box attaches besides a file: the
 * uncommitted changes, a branch or a commit from git, the output of a
 * terminal, an earlier conversation. Each is read when it is picked and put
 * in the message as a small text file, so the box shows what was attached and
 * the agent reads it like any other attachment. The shaping lives here, free
 * of git, the terminals and the store, so it can be tested on its own.
 */

/** A diff is cut here (400 KB): past it the agent is better off running git itself. */
export const DIFF_CAP = 400_000
/** How many recent commits the "@" menu offers. */
export const MENTION_COMMITS = 10
/** How many other branches the menu offers once something is typed. */
export const MENTION_BRANCHES = 6
/** How many lines of a terminal are attached. */
export const TERMINAL_LINES = 200
/** The most characters of an earlier conversation that are attached (60 KB, what the agent reads inline). */
export const CHAT_CAP = 60_000

/** Which part of a repository a git mention attaches. */
export type GitMention = { kind: 'uncommitted' } | { kind: 'branch'; name: string } | { kind: 'commit'; sha: string }

/** What the "@" menu offers from git for a folder. */
export interface GitRefs {
  /** The branch changes are compared with (main or master, or origin's own default); null when there is none. */
  base: string | null
  current: string | null
  commits: ChatCommit[]
  /** Local branches, most recently committed first. */
  branches: string[]
  /** False outside a git repository: nothing to offer. */
  repo: boolean
}

/** What picking a git mention leaves in the message. */
export type MentionAttachment = { ok: true; path: string; label: string; note?: string } | { ok: false; error: string }

/** A branch name git accepts as one: never something it would read as an option or a range. */
export function isBranchName(value: unknown): value is string {
  return typeof value === 'string' && /^[\w.][\w./-]{0,250}$/.test(value) && !value.includes('..') && !value.endsWith('.lock') && !value.endsWith('/')
}

/** A commit id as typed by git (4 to 64 hex digits). */
export const isCommitId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{4,64}$/i.test(value)

/** `text` cut to `cap` characters at a line end, with a line saying how much is missing. */
export function capText(text: string, cap: number, what = 'text'): { text: string; truncated: boolean } {
  if (text.length <= cap) return { text, truncated: false }
  const cut = text.lastIndexOf('\n', cap)
  const kept = text.slice(0, cut > cap * 0.5 ? cut : cap)
  const left = text.length - kept.length
  return { text: `${kept}\n\n[The ${what} is cut here: ${left.toLocaleString('en-US')} more characters are left out.]\n`, truncated: true }
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** A name for the saved file that reads well in the attachment chip: "Commit abc1234 2026-11-07 10.20.30.diff". */
export function mentionFileName(label: string, ext: string, now: Date = new Date()): string {
  const safe = label
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .trim()
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}`
  return `${safe || 'Attached'} ${stamp}.${ext.replace(/[^\w]/g, '') || 'txt'}`
}

/* ---------------------------------------------------------------- terminal */

/** The last `lines` lines of a terminal's text, without the blank ones after the last output. */
export function terminalTail(screen: string, lines = TERMINAL_LINES): { text: string; lines: number; cut: boolean } {
  const all = screen.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trimEnd())
  while (all.length > 0 && all[all.length - 1] === '') all.pop()
  const cut = all.length > lines
  const kept = cut ? all.slice(-lines) : all
  return { text: kept.join('\n'), lines: kept.length, cut }
}

/** The file a terminal's output is attached as. */
export function terminalAttachment(title: string, screen: string, folder: string, lines = TERMINAL_LINES): { label: string; text: string } | null {
  const tail = terminalTail(screen, lines)
  if (!tail.text.trim()) return null
  const head = `Output of the terminal "${title}" in ${folder}, ${tail.cut ? `the last ${tail.lines} lines` : `${tail.lines} ${tail.lines === 1 ? 'line' : 'lines'}`}:`
  return { label: `Terminal ${title}`, text: `${head}\n\n${tail.text}\n` }
}

/* ----------------------------------------------------------- conversations */

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

/** One message as text: what was said, in order, with tool use as a line saying which tools ran and files attached. */
function messageText(message: ChatMessage): string {
  const speaker = message.role === 'user' ? 'User' : 'Assistant'
  const blocks: string[] = []
  let tools: string[] = []
  const flushTools = (): void => {
    if (tools.length === 0) return
    const counts = new Map<string, number>()
    for (const name of tools) counts.set(name, (counts.get(name) ?? 0) + 1)
    blocks.push(`[used ${[...counts].map(([name, n]) => (n > 1 ? `${name} x${n}` : name)).join(', ')}]`)
    tools = []
  }
  for (const part of message.parts) {
    if (part.type === 'tool') tools.push(part.name)
    else {
      flushTools()
      if (part.text.trim()) blocks.push(part.text.trim())
    }
  }
  flushTools()
  const attached = (message.attachments ?? []).map((path) => path.split(/[\\/]/).pop() ?? path)
  if (attached.length > 0) blocks.push(`[attached: ${attached.join(', ')}]`)
  return blocks.length > 0 ? `${speaker}: ${blocks.join('\n')}` : ''
}

/**
 * An earlier chat as text for a message: its title and date, the summary if
 * it was compacted, then what was said after the summary (or all of it),
 * tool use boiled down to a line. Over `cap` characters the start (the
 * original ask) and the most recent turns stay.
 */
export function chatTranscript(
  chat: Pick<Chat, 'title' | 'updatedAt' | 'messages' | 'summary'>,
  cap = CHAT_CAP
): { text: string; messages: number; summarized: boolean; cut: boolean } {
  const summary = chat.summary?.text.trim() ? chat.summary : null
  const cutAt = summary ? chat.messages.findIndex((m) => m.id === summary.throughMessageId) : -1
  const after = summary && cutAt !== -1 ? chat.messages.slice(cutAt + 1) : chat.messages
  const said = after.filter((m) => m.role !== 'system').map(messageText).filter(Boolean)
  const parts = [`An earlier conversation, "${chat.title}" (last active ${day(chat.updatedAt)}):`]
  if (summary) parts.push(`Summary of its earlier part:\n${summary.text.trim()}`)
  if (said.length > 0) parts.push(`${summary ? 'What was said after that' : 'What was said'}:\n\n${said.join('\n\n')}`)
  const whole = parts.join('\n\n')
  if (whole.length <= cap) return { text: `${whole}\n`, messages: said.length, summarized: summary !== null, cut: false }
  const head = Math.floor(cap * 0.15)
  const tail = cap - head
  const left = whole.length - head - tail
  const text = `${whole.slice(0, head)}\n\n[${left.toLocaleString('en-US')} characters from the middle are left out.]\n\n${whole.slice(-tail)}\n`
  return { text, messages: said.length, summarized: summary !== null, cut: true }
}
