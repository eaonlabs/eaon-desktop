import type { TokenUsage } from '@shared/types'
import type { UsageCounts } from '@shared/usage'
import { store } from '../../store'

/**
 * Eaon's own usage, counted on this computer: requests and tokens per local
 * day, provider and model, from every model request Eaon makes for itself
 * (chats, workers, scheduled tasks, trading). Requests other apps make through
 * the gateway are not counted — see `adapterFor`'s `track`.
 *
 * Only counts are kept, never what was asked or answered. Nothing here leaves
 * the computer; `sync.ts` uploads daily totals once the user signs in to Tokn.
 */

const FILE = 'usage-ledger.json'
/** A little over a year, like Tokn's own history views. */
const KEEP_DAYS = 400
const SAVE_DELAY_MS = 1500

/** day → provider → model → counts. */
export type LedgerDays = Record<string, Record<string, Record<string, UsageCounts>>>

interface Ledger {
  version: 1
  days: LedgerDays
}

let ledger: Ledger | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()

function load(): Ledger {
  if (!ledger) {
    const saved = store.getJson<Partial<Ledger>>(FILE, {})
    ledger = { version: 1, days: saved.days && typeof saved.days === 'object' ? saved.days : {} }
  }
  return ledger
}

/** The local calendar day, `YYYY-MM-DD`: Tokn buckets by the user's own days. */
export function localDay(at: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

export const emptyCounts = (): UsageCounts => ({ requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

/** Counts one model request. */
export function recordUsage(providerId: string, modelId: string, usage: TokenUsage, at: Date = new Date()): void {
  if (!providerId || !modelId) return
  const days = load().days
  const day = localDay(at)
  const counts = (((days[day] ??= {})[providerId] ??= {})[modelId] ??= emptyCounts())
  const n = (value: number): number => (Number.isFinite(value) && value > 0 ? Math.round(value) : 0)
  counts.requests += 1
  counts.input += n(usage.input)
  counts.output += n(usage.output)
  counts.cacheRead += n(usage.cacheRead)
  counts.cacheWrite += n(usage.cacheWrite)
  scheduleSave(at)
  for (const listener of listeners) listener()
}

export function ledgerDays(): LedgerDays {
  return load().days
}

/** Called after every recorded request. */
export function onLedgerChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function scheduleSave(now: Date): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    prune(now)
    store.setJsonAsync(FILE, load())
  }, SAVE_DELAY_MS)
}

function prune(now: Date): void {
  const oldest = localDay(new Date(now.getTime() - KEEP_DAYS * 86_400_000))
  const days = load().days
  for (const day of Object.keys(days)) if (day < oldest) delete days[day]
}

/** Writes anything still waiting, at quit. */
export function flushLedger(): void {
  if (!saveTimer) return
  clearTimeout(saveTimer)
  saveTimer = null
  store.setJson(FILE, load())
}

/** Tests: forget the in-memory copy so the next read comes from disk. */
export function resetLedgerForTests(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  ledger = null
}
