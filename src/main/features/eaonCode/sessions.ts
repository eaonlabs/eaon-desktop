import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { EaonSessionInfo } from '@shared/eaonCode'
import { agentDirFor, type EaonPackageInfo } from './locate'

/**
 * Reads Eaon Code's saved sessions for a folder straight from disk.
 *
 * RPC mode has no "list sessions" command, and spawning a process just to ask
 * would cost a second of startup per folder switch. The storage layout is
 * stable and documented (docs/session-format.md): one JSONL file per session,
 * a `session` header line first, under `<agentDir>/sessions/--<cwd>--/`.
 */

/** Resolves symlinks the way the child's own process.cwd() will (/tmp → /private/tmp on macOS). */
export function canonicalCwd(cwd: string): string {
  try {
    return realpathSync.native(cwd)
  } catch {
    return resolve(cwd)
  }
}

/** Mirrors getDefaultSessionDirPath() in Eaon Code's session-manager.ts. */
export function defaultSessionDir(agentDir: string, cwd: string): string {
  const safe = `--${canonicalCwd(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
  return join(resolve(agentDir), 'sessions', safe)
}

/**
 * A custom session folder, when one is configured, holds every project's
 * sessions together; entries are then filtered by the cwd in their header.
 * Precedence matches Eaon Code's main.ts: environment, then settings.json.
 */
function customSessionDir(info: EaonPackageInfo, agentDir: string, env: NodeJS.ProcessEnv): string | null {
  const prefix = info.appName.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
  const fromEnv = env[`${prefix}_CODING_AGENT_SESSION_DIR`]
  if (fromEnv) return fromEnv
  try {
    const settings = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8')) as { sessionDir?: unknown }
    return typeof settings.sessionDir === 'string' && settings.sessionDir ? settings.sessionDir : null
  } catch {
    return null
  }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part): part is { type: 'text'; text: string } => (part as { type?: string })?.type === 'text')
    .map((part) => part.text)
    .join(' ')
}

/** One file's summary, or null when it is not a session (no header). Mirrors buildSessionInfo(). */
export function summariseSession(path: string, raw: string, mtimeMs: number): EaonSessionInfo | null {
  type Header = { id?: string; cwd?: string; timestamp?: string }
  let header: Header | null = null
  let name: string | undefined
  let messageCount = 0
  let firstMessage = ''
  let lastActivity = 0

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (!header) {
      if (entry.type !== 'session') return null
      header = entry as Header
      continue
    }
    if (entry.type === 'session_info') {
      name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : undefined
      continue
    }
    if (entry.type !== 'message') continue
    messageCount++
    const message = entry.message as { role?: string; content?: unknown; timestamp?: number } | undefined
    if (message?.role !== 'user' && message?.role !== 'assistant') continue
    const at = typeof message.timestamp === 'number' ? message.timestamp : Date.parse(String(entry.timestamp ?? ''))
    if (Number.isFinite(at)) lastActivity = Math.max(lastActivity, at)
    if (!firstMessage && message.role === 'user') firstMessage = textOf(message.content).trim()
  }
  if (!header || typeof header.id !== 'string') return null

  const created = Date.parse(String(header.timestamp ?? ''))
  return {
    path,
    id: header.id,
    cwd: typeof header.cwd === 'string' ? header.cwd : '',
    ...(name ? { name } : {}),
    created: Number.isFinite(created) ? created : mtimeMs,
    modified: lastActivity || (Number.isFinite(created) ? created : mtimeMs),
    messageCount,
    firstMessage: firstMessage.replace(/\s+/g, ' ').slice(0, 200)
  }
}

/**
 * Sessions saved for `cwd`, newest first. `extraDirs` adds folders to scan —
 * the directory of the running session's own file, which is authoritative
 * even when a project-level setting moved it somewhere we could not predict.
 */
export async function listSessions(
  cwd: string,
  info: EaonPackageInfo,
  options: { extraDirs?: string[]; limit?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<EaonSessionInfo[]> {
  const env = options.env ?? process.env
  const agentDir = agentDirFor(info, env)
  const target = canonicalCwd(cwd)
  const custom = customSessionDir(info, agentDir, env)
  const dirs = [...new Set([custom ?? defaultSessionDir(agentDir, cwd), ...(options.extraDirs ?? [])])]

  const files: { path: string; mtimeMs: number }[] = []
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      const path = join(dir, name)
      try {
        files.push({ path, mtimeMs: (await stat(path)).mtimeMs })
      } catch {
        /* removed while listing */
      }
    }
  }
  // Parse only the most recently touched files; a busy project can hold hundreds.
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const limit = options.limit ?? 60
  const sessions: EaonSessionInfo[] = []
  for (const file of files.slice(0, limit * 2)) {
    let raw: string
    try {
      raw = await readFile(file.path, 'utf8')
    } catch {
      continue
    }
    const summary = summariseSession(file.path, raw, file.mtimeMs)
    if (!summary) continue
    // A shared folder mixes projects; the default one is per-project already.
    if (summary.cwd && canonicalCwd(summary.cwd) !== target && resolve(summary.cwd) !== resolve(cwd)) continue
    // A session with no messages is a file Eaon Code created but never used.
    if (summary.messageCount === 0) continue
    sessions.push(summary)
  }
  sessions.sort((a, b) => b.modified - a.modified)
  return sessions.slice(0, limit)
}
