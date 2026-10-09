import path from 'node:path'
import type { ConversationAgent } from '@shared/adeSessions'

/**
 * The Claude Code and Codex conversations that ran in the ADE's own
 * terminals. Neither CLI records which terminal it ran in, and a pane's
 * record (terminals/paneRecords.ts) goes when the pane is closed, so this
 * keeps them: Import brings back the sessions that were active in the ADE,
 * not every folder either CLI was ever used in.
 */

export interface AdeHistoryEntry {
  agent: ConversationAgent
  id: string
  cwd: string
  /** When it was last seen running in a pane. */
  at: number
}

/** The newest this many are kept; Import only needs the recent past. */
const MAX_ENTRIES = 2000

export interface AdeHistoryDeps {
  load: () => unknown
  save: (value: { conversations: AdeHistoryEntry[] }) => void
  now: () => number
}

const key = (agent: string, id: string): string => `${agent}:${id}`

export class AdeHistory {
  private entries = new Map<string, AdeHistoryEntry>()

  constructor(private readonly deps: AdeHistoryDeps) {
    const raw = deps.load() as { conversations?: unknown } | null
    for (const e of Array.isArray(raw?.conversations) ? (raw.conversations as Partial<AdeHistoryEntry>[]) : []) {
      if ((e?.agent === 'claude' || e?.agent === 'codex') && typeof e.id === 'string' && typeof e.cwd === 'string' && typeof e.at === 'number') {
        this.entries.set(key(e.agent, e.id), { agent: e.agent, id: e.id, cwd: e.cwd, at: e.at })
      }
    }
  }

  /** A conversation seen running in a pane. Saved only when it is new, or moved folder. */
  note(agent: string, id: string, cwd: string): void {
    if (agent !== 'claude' && agent !== 'codex') return
    const k = key(agent, id)
    const prev = this.entries.get(k)
    const dir = path.resolve(cwd)
    const now = this.deps.now()
    if (prev && prev.cwd === dir) {
      prev.at = now
      return
    }
    this.entries.set(k, { agent, id, cwd: dir, at: now })
    if (this.entries.size > MAX_ENTRIES) {
      const oldest = [...this.entries.values()].sort((a, b) => a.at - b.at).slice(0, this.entries.size - MAX_ENTRIES)
      for (const e of oldest) this.entries.delete(key(e.agent, e.id))
    }
    this.deps.save({ conversations: [...this.entries.values()] })
  }

  has(agent: string, id: string): boolean {
    return this.entries.has(key(agent, id))
  }

  get size(): number {
    return this.entries.size
  }
}

let shared: AdeHistory | null = null

/** The app's one history, in the store's `ade-history.json`. */
export async function adeHistory(): Promise<AdeHistory> {
  if (!shared) {
    const { store } = await import('../../store')
    shared = new AdeHistory({
      load: () => store.getJson<unknown>(HISTORY_FILE, null),
      save: (value) => store.setJsonAsync(HISTORY_FILE, value),
      now: Date.now
    })
  }
  return shared
}

const HISTORY_FILE = 'ade-history.json'
