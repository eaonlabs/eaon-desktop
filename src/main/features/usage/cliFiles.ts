import fs from 'node:fs/promises'
import path from 'node:path'
import type { UsageCounts } from '@shared/usage'
import { emptyCounts } from './ledger'

/**
 * The file reading the CLI usage readers share (`cliLogs.ts`, `cliSources.ts`):
 * listing a tool's files, reading big append-only logs a line at a time, and
 * adding a request into a tool's days.
 */

/** day → model → counts, for one tool. */
export type CliDays = Record<string, Record<string, UsageCounts>>

const CHUNK = 1 << 18
/** A corrupt file with no newlines must not eat the memory. */
const MAX_LINE = 1 << 26
/** Subagent and workflow runs nest deep inside a session's folder. */
const MAX_DEPTH = 12

export const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0)

/** A token count that may arrive as a number or a numeric string (a CSV, a SQLite text column). */
export const count = (v: unknown): number => num(typeof v === 'string' ? Number(v.replace(/[,$\s]/g, '')) : v)

/**
 * Every file under `dir` that `want`s, symlinks skipped (an account's links
 * would repeat the default's files).
 */
export async function listFiles(dir: string, want: (name: string) => boolean, out: string[] = [], depth = 0): Promise<string[]> {
  if (depth > MAX_DEPTH) return out
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) await listFiles(full, want, out, depth + 1)
    else if (entry.isFile() && want(entry.name)) out.push(full)
  }
  return out
}

export const listJsonl = (dir: string): Promise<string[]> => listFiles(dir, (name) => name.endsWith('.jsonl'))

export interface FileStat {
  size: number
  mtimeMs: number
}

/**
 * Size and modification time, for telling whether a file moved since it was
 * read. A SQLite database's write-ahead log is part of it: new rows sit in
 * the `-wal` file until a checkpoint, with the database itself untouched.
 */
export async function statOf(file: string): Promise<FileStat | null> {
  try {
    const s = await fs.stat(file)
    let size = s.size
    let mtimeMs = s.mtimeMs
    if (file.endsWith('.db')) {
      try {
        const wal = await fs.stat(`${file}-wal`)
        size += wal.size
        mtimeMs = Math.max(mtimeMs, wal.mtimeMs)
      } catch {
        /* no write-ahead log */
      }
    }
    return { size, mtimeMs }
  } catch {
    return null
  }
}

export async function statAll(files: string[]): Promise<Map<string, FileStat>> {
  const out = new Map<string, FileStat>()
  for (const file of files) {
    const s = await statOf(file)
    if (s) out.set(file, s)
  }
  return out
}

/**
 * Reads `file` from `from`, handing each whole line that `match`es to
 * `onLine`. Lines are tested as bytes first, so most of a transcript is never
 * turned into a string. Returns where the last whole line ended; a line still
 * being written is left for next time, unless `last` says the file is read
 * whole every time anyway (a torn line then just fails to parse).
 */
export async function readLines(file: string, from: number, match: (line: Buffer) => boolean, onLine: (line: string) => void, last = false): Promise<number> {
  const handle = await fs.open(file, 'r')
  try {
    let buf = Buffer.allocUnsafe(CHUNK)
    let held = 0
    let position = from
    let consumed = from
    for (;;) {
      if (held === buf.length) {
        if (buf.length >= MAX_LINE) {
          // One impossible line: drop what's held; the rest of it fails to parse and is skipped.
          consumed += held
          held = 0
        } else {
          const grown = Buffer.allocUnsafe(buf.length * 2)
          buf.copy(grown, 0, 0, held)
          buf = grown
        }
      }
      const { bytesRead } = await handle.read(buf, held, buf.length - held, position)
      if (bytesRead === 0) break
      position += bytesRead
      const end = held + bytesRead
      let start = 0
      for (;;) {
        const nl = buf.indexOf(0x0a, start)
        if (nl === -1 || nl >= end) break
        const stop = nl > start && buf[nl - 1] === 0x0d ? nl - 1 : nl
        if (stop > start) {
          const line = buf.subarray(start, stop)
          if (match(line)) onLine(line.toString('utf8'))
        }
        start = nl + 1
      }
      consumed += start
      held = end - start
      if (held > 0 && start > 0) buf.copy(buf, 0, start, end)
    }
    if (last && held > 0) {
      const line = buf.subarray(0, held)
      if (match(line)) onLine(line.toString('utf8'))
    }
    return consumed
  } finally {
    await handle.close()
  }
}

/** One request into `days`. */
export function addTo(days: CliDays, day: string, model: string, counts: Omit<UsageCounts, 'requests'>, requests = 1): void {
  const into = ((days[day] ??= {})[model] ??= emptyCounts())
  into.requests += requests
  into.input += counts.input
  into.output += counts.output
  into.cacheRead += counts.cacheRead
  into.cacheWrite += counts.cacheWrite
  if (counts.cacheWrite1h) into.cacheWrite1h = (into.cacheWrite1h ?? 0) + counts.cacheWrite1h
  if (counts.reportedCost) into.reportedCost = (into.reportedCost ?? 0) + counts.reportedCost
}

/** `from`'s days added into `into`. */
export function sum(into: CliDays, from: CliDays): CliDays {
  for (const [day, models] of Object.entries(from)) {
    for (const [model, c] of Object.entries(models)) addTo(into, day, model, c, c.requests)
  }
  return into
}
