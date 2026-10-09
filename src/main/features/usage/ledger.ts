import type { TokenUsage } from '@shared/types'
import type { UsageCounts, UsageSource } from '@shared/usage'
import { store } from '../../store'
import { usageSource } from './attribution'

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
/** day → source → provider → model → counts: the same requests again, split by what they were for. */
export type LedgerSources = Record<string, Partial<Record<UsageSource, Record<string, Record<string, UsageCounts>>>>>

interface Ledger {
  version: 1
  days: LedgerDays
  /** Added in 2026.6.2; older versions leave it out when they save, which only loses the split. */
  sources: LedgerSources
}

const SOURCES = new Set<UsageSource>(['chat', 'schedule', 'worker', 'trading', 'gateway'])

let ledger: Ledger | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<(source: UsageSource) => void>()

function load(): Ledger {
  if (!ledger) {
    const saved = store.getJson<Partial<Ledger>>(FILE, {})
    const sources: LedgerSources = {}
    if (isObject(saved.sources)) {
      for (const [day, bySource] of Object.entries(saved.sources)) {
        if (!isObject(bySource)) continue
        for (const [source, providers] of Object.entries(bySource)) {
          if (!SOURCES.has(source as UsageSource)) continue
          const clean = cleanDays({ [day]: providers })[day]
          if (clean) (sources[day] ??= {})[source as UsageSource] = clean
        }
      }
    }
    ledger = { version: 1, days: cleanDays(saved.days), sources }
  }
  return ledger
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0)

/**
 * The ledger as saved, with anything that isn't a day of counts left out and
 * every count a whole non-negative number. A count saved as a string would
 * otherwise be added to as text ("5" + 1 is "51").
 */
export function cleanDays(raw: unknown): LedgerDays {
  const days: LedgerDays = {}
  if (!isObject(raw)) return days
  for (const [day, providers] of Object.entries(raw)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !isObject(providers)) continue
    for (const [providerId, models] of Object.entries(providers)) {
      if (!isObject(models)) continue
      for (const [modelId, counts] of Object.entries(models)) {
        if (!isObject(counts)) continue
        const clean: UsageCounts = {
          requests: count(counts.requests),
          input: count(counts.input),
          output: count(counts.output),
          cacheRead: count(counts.cacheRead),
          cacheWrite: count(counts.cacheWrite)
        }
        const unreported = Math.min(count(counts.unreported), clean.requests)
        if (unreported > 0) clean.unreported = unreported
        ;((days[day] ??= {})[providerId] ??= {})[modelId] = clean
      }
    }
  }
  return days
}

/** The local calendar day, `YYYY-MM-DD`: Tokn buckets by the user's own days. */
export function localDay(at: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

export const emptyCounts = (): UsageCounts => ({ requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

/** Counts one model request, under the source of the run it was made in (see attribution.ts). */
export function recordUsage(providerId: string, modelId: string, usage: TokenUsage, at: Date = new Date(), source: UsageSource = usageSource()): void {
  if (!providerId || !modelId) return
  const { days, sources } = load()
  const day = localDay(at)
  // Another app's requests are kept in the split only: the totals, the
  // calendar and the Tokn upload stay Eaon's own (see UsageSource).
  if (source !== 'gateway') addRequest((((days[day] ??= {})[providerId] ??= {})[modelId] ??= emptyCounts()), usage)
  addRequest(((((sources[day] ??= {})[source] ??= {})[providerId] ??= {})[modelId] ??= emptyCounts()), usage)
  scheduleSave(at)
  for (const listener of listeners) listener(source)
}

/** One request another app made through Eaon's gateway, counted once when the provider has answered it. */
export function recordGatewayUsage(providerId: string, modelId: string, usage: TokenUsage): void {
  recordUsage(providerId, modelId, usage, new Date(), 'gateway')
}

function addRequest(counts: UsageCounts, usage: TokenUsage): void {
  const tokens = { input: count(usage.input), output: count(usage.output), cacheRead: count(usage.cacheRead), cacheWrite: count(usage.cacheWrite) }
  counts.requests += 1
  counts.input += tokens.input
  counts.output += tokens.output
  counts.cacheRead += tokens.cacheRead
  counts.cacheWrite += tokens.cacheWrite
  // Every real request reads at least a prompt, so all zeros means the
  // provider sent no counts, not that the request was free.
  if (tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite === 0) counts.unreported = (counts.unreported ?? 0) + 1
}

export function ledgerDays(): LedgerDays {
  return load().days
}

export function ledgerSources(): LedgerSources {
  return load().sources
}

/** Called after every recorded request. */
export function onLedgerChange(listener: (source: UsageSource) => void): () => void {
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
  const { days, sources } = load()
  for (const day of Object.keys(days)) if (day < oldest) delete days[day]
  for (const day of Object.keys(sources)) if (day < oldest) delete sources[day]
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
