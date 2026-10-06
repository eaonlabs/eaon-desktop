import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ConnectAppId } from '@shared/connectApps'

/**
 * What Eaon changed for each connected app, kept in Eaon's own data folder
 * (`connect-apps.json`) so disconnecting can put things back: for every key
 * Eaon owns in an app's file, whether it existed before and what it held, and
 * what Eaon wrote. A key the user has since changed again is theirs, and is
 * left alone on disconnect.
 */

export interface KeyRecord {
  path: string[]
  /** Whether the key existed before Eaon's first write, and its value then. */
  had: boolean
  before?: unknown
  /** What Eaon last wrote there. */
  wrote: unknown
}

export interface AppRecord {
  model: string
  /** Every model the app lists, default first; missing in records from before apps could list several. */
  models?: string[]
  smallModel: string | null
  connectedAt: number
  /** Owned keys, per absolute file path. */
  keys: Record<string, KeyRecord[]>
  /** Files Eaon created whole (removed on disconnect). */
  created?: string[]
  /** Connector-specific details (the base URL it wrote, say). */
  extra?: Record<string, unknown>
}

export type ConnectState = Partial<Record<ConnectAppId, AppRecord>>

export class StateFile {
  constructor(private readonly path: string) {}

  static in(dir: string): StateFile {
    return new StateFile(join(dir, 'connect-apps.json'))
  }

  read(): ConnectState {
    try {
      return existsSync(this.path) ? (JSON.parse(readFileSync(this.path, 'utf8')) as ConnectState) : {}
    } catch {
      return {}
    }
  }

  get(id: ConnectAppId): AppRecord | null {
    return this.read()[id] ?? null
  }

  set(id: ConnectAppId, record: AppRecord | null): void {
    const state = this.read()
    if (record) state[id] = record
    else delete state[id]
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    renameSync(tmp, this.path)
  }
}

export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
