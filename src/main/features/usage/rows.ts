import {
  TOKN_TOOL,
  type Billing,
  type UsageActivity,
  type UsageCounts,
  type UsageDay,
  type UsageModelRow,
  type UsageRange,
  type UsageSource,
  type UsageSourceRow,
  type UsageTotals
} from '@shared/usage'
import { emptyCounts, localDay, type LedgerDays, type LedgerSources } from './ledger'

/**
 * Pricing and shaping the ledger, with no I/O: model names as Tokn writes
 * them, cost at Tokn's published rates, the rows a Tokn sync uploads, and the
 * summary Settings → Usage shows. The rates and cache multiples match Tokn's
 * CLI (`cli/src/core/pricing.ts`), so Eaon and the website agree on a figure.
 */

/** USD per million tokens, as `GET /api/cli/pricing` returns it. */
export interface ToknPrice {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
  cacheWrite1h?: number
}

export type ToknPricing = Record<string, ToknPrice>

const CACHE_READ_MULTIPLIER = 0.1
const CACHE_WRITE_5M_MULTIPLIER = 1.25

/**
 * A model id as Tokn's table names it — Tokn's own `normalizeModel`: no
 * region or vendor prefix (`anthropic/claude-opus-5` → `claude-opus-5`), no
 * `@` or `-v1` version, no date suffix. OpenRouter's routing variants
 * (`:nitro`, `:floor`) cost the same as the model and lose the suffix; a
 * `:free` model costs nothing, so it keeps it and goes unpriced.
 */
export function toknModelName(raw: string): string {
  let id = raw.trim().toLowerCase()
  id = id.replace(/^(us|eu|apac|global|ca|sa|apne|usgov)\./, '')
  id = id.replace(/^anthropic\./, '')
  id = id.replace(/^[a-z0-9-]+\//, '')
  id = id.replace(/-v\d+(?::\d+)?$/, '')
  const at = id.indexOf('@')
  if (at !== -1) id = id.slice(0, at)
  id = id.replace(/-\d{8}$/, '')
  const variant = /:([a-z0-9-]+)$/.exec(id)
  if (variant && variant[1] !== 'free') id = id.slice(0, variant.index)
  return id
}

/** Tokn's name and price for a model, or null when Tokn has no price for it. */
export function priceOf(modelId: string, pricing: ToknPricing): { name: string; price: ToknPrice } | null {
  const name = toknModelName(modelId)
  const price = pricing[name] ?? pricing[modelId.toLowerCase()]
  return price ? { name: pricing[name] ? name : modelId.toLowerCase(), price } : null
}

/**
 * USD at published rates. Eaon's prompt caching is the 5-minute kind, so
 * every cache write is priced as one; reads default to a tenth of input.
 */
export function costOf(counts: UsageCounts, price: ToknPrice): number {
  const read = price.cacheRead ?? price.input * CACHE_READ_MULTIPLIER
  const write = price.cacheWrite ?? price.input * CACHE_WRITE_5M_MULTIPLIER
  return (counts.input * price.input + counts.output * price.output + counts.cacheRead * read + counts.cacheWrite * write) / 1_000_000
}

const tokensOf = (c: UsageCounts): number => c.input + c.output + c.cacheRead + c.cacheWrite

/** How each provider's requests are paid for; see `Billing`. */
export type BillingOf = (providerId: string) => Billing

function add(into: UsageCounts, from: UsageCounts): UsageCounts {
  into.requests += from.requests
  into.input += from.input
  into.output += from.output
  into.cacheRead += from.cacheRead
  into.cacheWrite += from.cacheWrite
  if (from.unreported) into.unreported = (into.unreported ?? 0) + from.unreported
  return into
}

/** One `POST /api/cli/sync` row. */
export interface ToknSyncRow {
  day: string
  tool: string
  model: string
  fast: false
  requests: number
  input: number
  output: number
  cacheWrite5m: number
  cacheWrite1h: number
  cacheRead: number
  costUsd: number
}

/**
 * The rows to upload: one per day and model, every day the ledger has. Tokn
 * replaces a (day, tool, model) row on every sync rather than adding to it,
 * so sending the whole history each time is how a sync stays right. The same
 * model through two providers is one row. Local models and models Tokn has
 * no price for are left out: Tokn would turn the second down, and the first
 * cost nothing.
 */
export function syncRows(days: LedgerDays, pricing: ToknPricing, billingOf: BillingOf): ToknSyncRow[] {
  const rows = new Map<string, { day: string; model: string; counts: UsageCounts; cost: number }>()
  for (const [day, providers] of Object.entries(days)) {
    for (const [providerId, models] of Object.entries(providers)) {
      // Plan use goes up too, at API rates: that is how Tokn values every
      // tool's use, subscriptions included (Claude Code's, Codex's).
      if (billingOf(providerId) === 'local') continue
      for (const [modelId, counts] of Object.entries(models)) {
        const priced = priceOf(modelId, pricing)
        if (!priced) continue
        const key = `${day} ${priced.name}`
        const row = rows.get(key) ?? { day, model: priced.name, counts: emptyCounts(), cost: 0 }
        add(row.counts, counts)
        row.cost += costOf(counts, priced.price)
        rows.set(key, row)
      }
    }
  }
  return [...rows.values()]
    .filter((row) => row.counts.requests > 0 || tokensOf(row.counts) > 0)
    .sort((a, b) => (a.day === b.day ? a.model.localeCompare(b.model) : a.day.localeCompare(b.day)))
    .map((row) => ({
      day: row.day,
      tool: TOKN_TOOL,
      model: row.model,
      fast: false,
      requests: row.counts.requests,
      input: row.counts.input,
      output: row.counts.output,
      cacheWrite5m: row.counts.cacheWrite,
      cacheWrite1h: 0,
      cacheRead: row.counts.cacheRead,
      costUsd: Math.round(row.cost * 1e6) / 1e6
    }))
}

export interface Summary {
  days: UsageDay[]
  models: UsageModelRow[]
  totals: UsageTotals & { unpricedRequests: number; unreportedRequests: number; planUsd: number }
  today: UsageTotals & { planUsd: number }
}

/**
 * One model's counts priced the way they are paid for: pay-per-token at
 * Tokn's rates into `costUsd`, a plan's use at the same rates into `planUsd`
 * (what it would have cost; never added to spend), local use as nothing.
 * Null cost: Tokn has no price for the model.
 */
function priceRow(modelId: string, counts: UsageCounts, billing: Billing, pricing: ToknPricing): { priced: ReturnType<typeof priceOf>; cost: number | null } {
  if (billing === 'local') return { priced: null, cost: 0 }
  const priced = priceOf(modelId, pricing)
  return { priced, cost: priced ? costOf(counts, priced.price) : null }
}

/** What Settings → Usage shows for the last `range` days, today included. */
export function summarize(days: LedgerDays, range: UsageRange, pricing: ToknPricing, billingOf: BillingOf, now: Date = new Date()): Summary {
  const today = localDay(now)
  const span: string[] = []
  for (let i = range - 1; i >= 0; i--) {
    // Built from the calendar date at noon, so no daylight-saving change can
    // repeat or skip a day.
    span.push(localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i, 12)))
  }

  const byModel = new Map<string, UsageModelRow>()
  const daily: UsageDay[] = []
  const totals = { costUsd: 0, planUsd: 0, tokens: 0, requests: 0, unpricedRequests: 0, unreportedRequests: 0 }
  let todayTotals = { costUsd: 0, planUsd: 0, tokens: 0, requests: 0 }

  for (const day of span) {
    const entry = { day, costUsd: 0, planUsd: 0, tokens: 0, requests: 0 }
    for (const [providerId, models] of Object.entries(days[day] ?? {})) {
      const billing = billingOf(providerId)
      for (const [modelId, counts] of Object.entries(models)) {
        const { priced, cost } = priceRow(modelId, counts, billing, pricing)
        if (billing === 'plan') entry.planUsd += cost ?? 0
        else entry.costUsd += cost ?? 0
        entry.tokens += tokensOf(counts)
        entry.requests += counts.requests
        if (cost === null) totals.unpricedRequests += counts.requests
        totals.unreportedRequests += counts.unreported ?? 0

        const key = `${providerId} ${modelId}`
        const row = byModel.get(key) ?? {
          providerId,
          modelId,
          toknModel: priced?.name ?? null,
          costUsd: cost === null ? null : 0,
          local: billing === 'local',
          billing,
          ...emptyCounts()
        }
        add(row, counts)
        if (cost !== null) row.costUsd = (row.costUsd ?? 0) + cost
        byModel.set(key, row)
      }
    }
    totals.costUsd += entry.costUsd
    totals.planUsd += entry.planUsd
    totals.tokens += entry.tokens
    totals.requests += entry.requests
    if (day === today) todayTotals = { costUsd: entry.costUsd, planUsd: entry.planUsd, tokens: entry.tokens, requests: entry.requests }
    daily.push(entry)
  }

  // Spend first (what was billed), then plans by what they stood for, then
  // the unpriced by requests.
  const rank = (row: UsageModelRow): number => (row.costUsd === null ? 2 : row.billing === 'api' ? 0 : 1)
  const models = [...byModel.values()].sort((a, b) => rank(a) - rank(b) || (b.costUsd ?? 0) - (a.costUsd ?? 0) || b.requests - a.requests)
  return { days: daily, models, totals, today: todayTotals }
}

/**
 * Every counted day's totals, priced (local and unpriced models count as
 * nothing spent; plan use goes in `planUsd`, not spend).
 */
export function dailyTotals(days: LedgerDays, pricing: ToknPricing, billingOf: BillingOf): Map<string, UsageDay> {
  const byDay = new Map<string, UsageDay>()
  for (const [day, providers] of Object.entries(days)) {
    const entry = { day, costUsd: 0, planUsd: 0, tokens: 0, requests: 0 }
    for (const [providerId, models] of Object.entries(providers)) {
      const billing = billingOf(providerId)
      for (const [modelId, counts] of Object.entries(models)) {
        const { cost } = priceRow(modelId, counts, billing, pricing)
        if (billing === 'plan') entry.planUsd += cost ?? 0
        else entry.costUsd += cost ?? 0
        entry.tokens += tokensOf(counts)
        entry.requests += counts.requests
      }
    }
    if (entry.requests > 0 || entry.tokens > 0) byDay.set(day, entry)
  }
  return byDay
}

/** The range's use by what it was for (chats, scheduled tasks, workers, trading), priced like the totals. */
export function summarizeSources(sources: LedgerSources, range: UsageRange, pricing: ToknPricing, billingOf: BillingOf, now: Date = new Date()): UsageSourceRow[] {
  const rows = new Map<UsageSource, UsageSourceRow>()
  for (let i = range - 1; i >= 0; i--) {
    const day = localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i, 12))
    for (const [source, providers] of Object.entries(sources[day] ?? {}) as [UsageSource, LedgerDays[string]][]) {
      const row = rows.get(source) ?? { source, requests: 0, tokens: 0, costUsd: 0, planUsd: 0 }
      for (const [providerId, models] of Object.entries(providers)) {
        const billing = billingOf(providerId)
        for (const [modelId, counts] of Object.entries(models)) {
          const { cost } = priceRow(modelId, counts, billing, pricing)
          if (billing === 'plan') row.planUsd += cost ?? 0
          else row.costUsd += cost ?? 0
          row.requests += counts.requests
          row.tokens += tokensOf(counts)
        }
      }
      rows.set(source, row)
    }
  }
  return [...rows.values()].filter((row) => row.requests > 0).sort((a, b) => b.costUsd + b.planUsd - (a.costUsd + a.planUsd) || b.requests - a.requests)
}

/** The day `n` days after (or before) `day`, as a local calendar day. */
function shiftDay(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number)
  return localDay(new Date(y, m - 1, d + n, 12))
}

/**
 * A year for the activity calendar: `weeks` whole weeks, each starting on a
 * Sunday, ending with today's week. Days after today are left off, so the
 * last column is as long as the week so far.
 */
export function calendar(byDay: Map<string, UsageDay>, now: Date = new Date(), weeks = 53): UsageDay[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12)
  const start = new Date(today)
  start.setDate(today.getDate() - (weeks - 1) * 7 - today.getDay())
  const out: UsageDay[] = []
  for (const at = new Date(start); at <= today; at.setDate(at.getDate() + 1)) {
    const day = localDay(at)
    out.push(byDay.get(day) ?? { day, costUsd: 0, tokens: 0, requests: 0 })
  }
  return out
}

/**
 * Active days, streaks and the busiest day, the way Tokn's profile counts
 * them: a streak is consecutive days with any request, and the current one
 * still stands if it reached yesterday, since today isn't over.
 */
export function activity(byDay: Map<string, UsageDay>, range: UsageRange, now: Date = new Date()): UsageActivity {
  const active = [...byDay.values()].filter((d) => d.requests > 0).sort((a, b) => a.day.localeCompare(b.day))
  const today = localDay(now)
  const rangeStart = shiftDay(today, -(range - 1))

  let longest = 0
  let run = 0
  for (let i = 0; i < active.length; i++) {
    run = i > 0 && active[i].day === shiftDay(active[i - 1].day, 1) ? run + 1 : 1
    longest = Math.max(longest, run)
  }
  const last = active.at(-1)?.day
  const current = last && (last === today || last === shiftDay(today, -1)) ? run : 0

  const anySpend = active.some((d) => d.costUsd > 0)
  const busiest = active.reduce<UsageDay | null>(
    (best, d) => (!best || (anySpend ? d.costUsd > best.costUsd : d.tokens > best.tokens) ? d : best),
    null
  )
  const allTime = active.reduce<UsageTotals>(
    (sum, d) => ({ costUsd: sum.costUsd + d.costUsd, tokens: sum.tokens + d.tokens, requests: sum.requests + d.requests }),
    { costUsd: 0, tokens: 0, requests: 0 }
  )
  return {
    activeDays: active.length,
    activeInRange: active.filter((d) => d.day >= rangeStart && d.day <= today).length,
    currentStreak: current,
    longestStreak: longest,
    busiest,
    firstDay: active[0]?.day ?? null,
    allTime
  }
}
