import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Another app's SQLite database, read from a copy. The app may be running
 * and holding the file, and most of these are in WAL mode, where the newest
 * rows are still in the `-wal` file beside it: the copy takes all three
 * files, and opening it (not read-only) folds the WAL in. The app's own files
 * are never opened.
 */

interface Statement {
  all(...params: unknown[]): unknown[]
}
interface Database {
  prepare(sql: string): Statement
  close(): void
}

export type Row = Record<string, unknown>

export interface Snapshot {
  /** The rows of a query; none when the table or a column isn't there (another version of the app). */
  rows(sql: string, ...params: unknown[]): Row[]
  /** The columns a table has, or none when it isn't there. */
  columns(table: string): Set<string>
}

/** Opens a copy of `file`, hands it to `use`, and removes the copy. Null when the file isn't there or this runtime has no SQLite. */
export function withSnapshot<T>(file: string, use: (db: Snapshot) => T): T | null {
  if (!existsSync(file)) return null
  const sqlite = process.getBuiltinModule?.('node:sqlite') as { DatabaseSync: new (file: string) => Database } | undefined
  if (!sqlite) return null
  const dir = mkdtempSync(path.join(os.tmpdir(), 'eaon-import-'))
  let db: Database | null = null
  try {
    const copy = path.join(dir, 'data.db')
    copyFileSync(file, copy)
    for (const suffix of ['-wal', '-shm']) if (existsSync(file + suffix)) copyFileSync(file + suffix, copy + suffix)
    const open = new sqlite.DatabaseSync(copy)
    db = open
    return use({
      rows: (sql, ...params) => {
        try {
          return open.prepare(sql).all(...params) as Row[]
        } catch {
          return []
        }
      },
      columns: (table) => {
        try {
          return new Set((open.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as Row[]).map((r) => String(r.name)))
        } catch {
          return new Set()
        }
      }
    })
  } finally {
    try {
      db?.close()
    } catch {
      // Closed or never opened: the copy goes either way.
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

/** A JSON column's value, or null. */
export function json(value: unknown): unknown {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}
