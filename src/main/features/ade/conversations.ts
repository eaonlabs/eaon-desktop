import fs from 'node:fs'
import path from 'node:path'
import type { AdeConversation, ConversationAgent } from '@shared/adeSessions'
import { claudeDir, claudeSlug, codexDir } from '../terminals/agentSessions'

/**
 * Claude Code and Codex conversations on this computer, with the folder each
 * ran in and a title, for the ADE's sessions: Import lists them by folder, and
 * a session shows the ones filed for its folder so they can be reopened.
 *
 * Read only, and only the start and end of each file (a long transcript runs
 * to megabytes). Shapes measured against Claude Code 2.1 and Codex 0.159:
 *
 *   Claude Code  ~/.claude/projects/<slug>/<id>.jsonl
 *     every turn line carries `cwd`; `ai-title` lines carry the title Claude
 *     Code gave it (the last one wins); `user` lines what was asked.
 *   Codex        ~/.codex/sessions/YYYY/MM/DD/rollout-…-<id>.jsonl
 *     the first line is `session_meta` with `cwd` and `id`; what was asked is
 *     an `event_msg` `user_message`, or a `response_item` user message that
 *     isn't Codex's own instructions.
 */

const UUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/
const HEAD_BYTES = 128 * 1024
const TAIL_BYTES = 64 * 1024
const TITLE_MAX = 90

/** `length` bytes of a file from `start`; '' when it can't be read. */
function slice(file: string, start: number, length: number): string {
  let fd: number
  try {
    fd = fs.openSync(file, 'r')
  } catch {
    return ''
  }
  try {
    const buf = Buffer.allocUnsafe(length)
    const read = fs.readSync(fd, buf, 0, length, start)
    return buf.toString('utf8', 0, read)
  } catch {
    return ''
  } finally {
    fs.closeSync(fd)
  }
}

/** The whole JSON lines in a chunk of a file (a cut line at either end is skipped). */
function rows(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue
    try {
      const row = JSON.parse(line) as unknown
      if (row && typeof row === 'object') out.push(row as Record<string, unknown>)
    } catch {
      /* the line was cut by the chunk's edge */
    }
  }
  return out
}

/** One line of what was asked, short enough for a sidebar. */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > TITLE_MAX ? `${flat.slice(0, TITLE_MAX - 1)}…` : flat
}

/** Text the agent put in a user turn itself (commands, reminders, instructions), not something the user asked. */
const NOT_ASKED = /^(<|Caveat:|# AGENTS\.md|# CLAUDE\.md|\[Request interrupted)/

function textOf(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    for (const part of content) {
      const p = part as { type?: unknown; text?: unknown }
      // A tool's result comes back as a user turn too; it isn't a question.
      if (p?.type === 'tool_result') return null
      if (typeof p?.text === 'string' && (p.type === 'text' || p.type === 'input_text')) return p.text
    }
  }
  return null
}

interface Parsed {
  cwd: string
  title: string
  /** A turn somebody took, so the agent has something to reopen. */
  hasTurn: boolean
  id?: string
}

/* ------------------------------------------------------------------ claude */

function parseClaude(file: string, size: number): Parsed | null {
  const head = rows(slice(file, 0, HEAD_BYTES))
  const tail = size > HEAD_BYTES ? rows(slice(file, Math.max(HEAD_BYTES, size - TAIL_BYTES), TAIL_BYTES)) : []
  let cwd = ''
  let asked: string | null = null
  let hasTurn = false
  let title: string | null = null
  let summary: string | null = null
  for (const row of [...head, ...tail]) {
    const type = row.type
    if (!cwd && typeof row.cwd === 'string') cwd = row.cwd
    if (type === 'ai-title' && typeof row.aiTitle === 'string' && row.aiTitle.trim()) title = row.aiTitle
    else if (type === 'custom-title' && typeof row.customTitle === 'string' && row.customTitle.trim()) title = row.customTitle
    else if (type === 'summary' && typeof row.summary === 'string' && row.summary.trim()) summary = row.summary
    else if (type === 'user' || type === 'assistant') {
      hasTurn = true
      if (type === 'user' && !asked && row.isMeta !== true && row.isSidechain !== true) {
        const text = textOf((row.message as { content?: unknown } | undefined)?.content)
        if (text && !NOT_ASKED.test(text.trim())) asked = text
      }
    }
  }
  if (!cwd) return null
  return { cwd, hasTurn, title: oneLine(title ?? summary ?? asked ?? 'Claude Code conversation') }
}

/* ------------------------------------------------------------------ codex */

function parseCodex(file: string): Parsed | null {
  let cwd = ''
  let id: string | undefined
  let asked: string | null = null
  let hasTurn = false
  for (const row of rows(slice(file, 0, HEAD_BYTES))) {
    const payload = row.payload as Record<string, unknown> | undefined
    if (!payload || typeof payload !== 'object') continue
    if (row.type === 'session_meta') {
      if (typeof payload.cwd === 'string') cwd = payload.cwd
      if (typeof payload.id === 'string') id = payload.id
    } else if (row.type === 'event_msg' && payload.type === 'user_message' && typeof payload.message === 'string') {
      hasTurn = true
      if (!asked && !NOT_ASKED.test(payload.message.trim())) asked = payload.message
    } else if (row.type === 'response_item' && payload.type === 'message') {
      if (payload.role === 'assistant') hasTurn = true
      if (payload.role === 'user' && !asked) {
        const text = textOf(payload.content)
        if (text && !NOT_ASKED.test(text.trim())) {
          asked = text
          hasTurn = true
        }
      }
    }
  }
  if (!cwd) return null
  return { cwd, id, hasTurn, title: oneLine(asked ?? 'Codex conversation') }
}

/* ------------------------------------------------------------------ listing */

/** Parsed files, by path, kept while their size and mtime don't change. */
const cache = new Map<string, { size: number; mtime: number; parsed: Parsed | null }>()

function parsed(agent: ConversationAgent, file: string, st: fs.Stats): Parsed | null {
  const known = cache.get(file)
  if (known && known.size === st.size && known.mtime === st.mtimeMs) return known.parsed
  const result = agent === 'claude' ? parseClaude(file, st.size) : parseCodex(file)
  if (cache.size > 5000) cache.clear()
  cache.set(file, { size: st.size, mtime: st.mtimeMs, parsed: result })
  return result
}

async function stat(file: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.stat(file)
  } catch {
    return null
  }
}

async function list(dir: string): Promise<string[]> {
  try {
    return await fs.promises.readdir(dir)
  } catch {
    return []
  }
}

function conversation(agent: ConversationAgent, id: string, p: Parsed, st: fs.Stats): AdeConversation {
  return { agent, id, cwd: p.cwd, title: p.title, born: st.birthtimeMs || st.ctimeMs, touched: st.mtimeMs }
}

/** Claude Code conversations in one of its project folders (or every one). */
async function claudeIn(slugDirs: string[]): Promise<AdeConversation[]> {
  const out: AdeConversation[] = []
  const root = path.join(claudeDir(), 'projects')
  for (const slug of slugDirs) {
    const dir = path.join(root, slug)
    for (const name of await list(dir)) {
      const id = name.endsWith('.jsonl') ? name.slice(0, -6) : null
      if (!id || !UUID.test(id)) continue
      const file = path.join(dir, name)
      const st = await stat(file)
      if (!st?.isFile()) continue
      const p = parsed('claude', file, st)
      if (p?.hasTurn) out.push(conversation('claude', id, p, st))
    }
  }
  return out
}

/** Every Codex rollout file, newest day first. */
async function codexFiles(): Promise<string[]> {
  const root = path.join(codexDir(), 'sessions')
  const files: string[] = []
  const desc = (names: string[]): string[] => names.filter((n) => /^\d+$/.test(n)).sort((a, b) => Number(b) - Number(a))
  for (const year of desc(await list(root))) {
    for (const month of desc(await list(path.join(root, year)))) {
      for (const day of desc(await list(path.join(root, year, month)))) {
        const dir = path.join(root, year, month, day)
        for (const name of await list(dir)) if (/^rollout-.*\.jsonl$/.test(name)) files.push(path.join(dir, name))
      }
    }
  }
  return files
}

async function codexAll(): Promise<AdeConversation[]> {
  const out: AdeConversation[] = []
  for (const file of await codexFiles()) {
    const st = await stat(file)
    if (!st?.isFile()) continue
    const p = parsed('codex', file, st)
    const id = p?.id && UUID.test(p.id) ? p.id : UUID.exec(path.basename(file))?.[0]
    if (p?.hasTurn && id) out.push(conversation('codex', id, p, st))
  }
  return out
}

const newestFirst = (a: AdeConversation, b: AdeConversation): number => b.touched - a.touched

/** Every Claude Code and Codex conversation on this computer that has something to reopen, newest first. */
export async function allConversations(): Promise<AdeConversation[]> {
  const [claude, codex] = await Promise.all([claudeIn(await list(path.join(claudeDir(), 'projects'))), codexAll()])
  return [...claude, ...codex].sort(newestFirst)
}

/** The conversations that ran in `cwd`, newest first. */
export async function conversationsIn(cwd: string): Promise<AdeConversation[]> {
  const want = path.resolve(cwd)
  const [claude, codex] = await Promise.all([claudeIn([claudeSlug(want)]), codexAll()])
  // Claude Code's folder name stands for more than one path (every symbol becomes "-"), so check each.
  return [...claude, ...codex].filter((c) => path.resolve(c.cwd) === want).sort(newestFirst)
}
