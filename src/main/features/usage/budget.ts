import type { UsageBudget, UsageBudgetLevel, UsageBudgetState, UsageCounts } from '@shared/usage'
import type { BillingOf, ToknPricing } from './rows'
import { priceRow, tokensOf } from './rows'
import type { LedgerDays, LedgerSources } from './ledger'

/**
 * The monthly budget in Settings → Usage, with no I/O: what is saved, what a
 * month has used, which level that is, and the words for a notice or a
 * refusal. The month's use is the ledger's pay-per-token requests (a plan's
 * and a local model's are never charged per token), priced at Tokn's
 * published rates like the rest of the page, so it is an estimate: a real
 * bill can differ, and a request already running when the limit is reached
 * finishes.
 */

export const DEFAULT_BUDGET: UsageBudget = { enabled: false, unit: 'usd', limit: 50, warnAt: 80, hardCap: false }

const MAX_LIMIT = 1_000_000_000

/** The saved budget, with anything missing or out of range put back to its default. */
export function normalizeBudget(raw: unknown): UsageBudget {
  const saved = (typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}) as Partial<Record<keyof UsageBudget, unknown>>
  const unit = saved.unit === 'tokens' ? 'tokens' : 'usd'
  const limit = typeof saved.limit === 'number' && Number.isFinite(saved.limit) && saved.limit > 0 ? Math.min(saved.limit, MAX_LIMIT) : DEFAULT_BUDGET.limit
  const warnAt = typeof saved.warnAt === 'number' && Number.isFinite(saved.warnAt) ? Math.min(99, Math.max(1, Math.round(saved.warnAt))) : DEFAULT_BUDGET.warnAt
  return {
    enabled: saved.enabled === true,
    unit,
    // Dollars to the cent; tokens whole.
    limit: unit === 'usd' ? Math.round(limit * 100) / 100 : Math.round(limit),
    warnAt,
    hardCap: saved.hardCap === true
  }
}

/** The local calendar month of `at`, `YYYY-MM`. */
export const monthOf = (at: Date): string => `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}`

export interface MonthUse {
  /** Dollars or tokens, by `unit`. */
  spent: number
  /** Requests that couldn't be counted in this unit: unpriced or without token counts (dollars), without token counts (tokens). */
  uncounted: number
}

/**
 * What `month` has used in `unit`. Eaon's own days, plus other apps' requests
 * through the Local API Server and Connect apps (`sources`' gateway rows):
 * those spend the same keys, so they count here even though the totals on the
 * Usage page leave them out. `counted` says which providers are paid per
 * token with a key of the user's; it is the same test the cap applies.
 */
export function monthUse(
  days: LedgerDays,
  sources: LedgerSources,
  month: string,
  unit: UsageBudget['unit'],
  pricing: ToknPricing,
  billingOf: BillingOf,
  counted: (providerId: string) => boolean
): MonthUse {
  const use: MonthUse = { spent: 0, uncounted: 0 }
  const take = (providers: LedgerDays[string] | undefined): void => {
    for (const [providerId, models] of Object.entries(providers ?? {})) {
      if (!counted(providerId)) continue
      const billing = billingOf(providerId)
      for (const [modelId, counts] of Object.entries(models) as [string, UsageCounts][]) {
        if (unit === 'tokens') {
          use.spent += tokensOf(counts)
          use.uncounted += counts.unreported ?? 0
          continue
        }
        const { cost } = priceRow(modelId, counts, billing, pricing)
        if (cost === null) use.uncounted += counts.requests
        else {
          use.spent += cost
          use.uncounted += counts.unreported ?? 0
        }
      }
    }
  }
  for (const day of Object.keys(days)) if (day.startsWith(`${month}-`)) take(days[day])
  for (const day of Object.keys(sources)) if (day.startsWith(`${month}-`)) take(sources[day].gateway)
  return use
}

/** The level a month's use is at: below the warning, past it, or at the limit. */
export function budgetLevel(budget: UsageBudget, spent: number): UsageBudgetLevel {
  if (!budget.enabled) return 'off'
  if (spent >= budget.limit) return 'over'
  return spent >= (budget.limit * budget.warnAt) / 100 ? 'warn' : 'ok'
}

export function budgetState(budget: UsageBudget, month: string, use: MonthUse, priced: boolean): UsageBudgetState {
  const level = budgetLevel(budget, use.spent)
  return {
    budget,
    month,
    spent: use.spent,
    percent: budget.enabled ? Math.round((use.spent / budget.limit) * 1000) / 10 : 0,
    level,
    blocked: level === 'over' && budget.hardCap,
    uncounted: use.uncounted,
    priced
  }
}

const money = (usd: number): string => `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const tokenCount = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)))
/** An amount in the budget's unit: "$12.40" or "3.2M tokens". */
export const budgetAmount = (budget: Pick<UsageBudget, 'unit'>, amount: number): string => (budget.unit === 'usd' ? money(amount) : `${tokenCount(amount)} tokens`)

const monthName = (month: string): string => new Date(`${month}-15T12:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })

/**
 * What a refused request says: that it was Eaon's budget (not the provider),
 * how much is used, and the ways out. It goes to the chat or the app that
 * made the request as the error.
 */
export function budgetBlockMessage(state: UsageBudgetState): string {
  const { budget } = state
  return (
    `Your Eaon budget for ${monthName(state.month)} is used up: about ${budgetAmount(budget, state.spent)} of ${budgetAmount(budget, budget.limit)} on pay-per-token models. ` +
    'Eaon is not sending this request. Pick a model on a plan or one that runs on this computer, or raise or turn off the budget in Settings → Usage.'
  )
}

/** The notification for a level just reached, or null when there is nothing to say. */
export function budgetNotice(state: UsageBudgetState): { title: string; body: string } | null {
  const { budget } = state
  if (state.level === 'warn') {
    return {
      title: `Eaon budget: ${Math.floor(state.percent)}% used`,
      body: `About ${budgetAmount(budget, state.spent)} of your ${budgetAmount(budget, budget.limit)} budget for ${monthName(state.month)}. It is an estimate.`
    }
  }
  if (state.level === 'over') {
    return {
      title: 'Eaon budget reached',
      body: budget.hardCap
        ? `About ${budgetAmount(budget, state.spent)} used. Eaon is not sending further pay-per-token requests this month. Raise or turn off the budget in Settings → Usage.`
        : `About ${budgetAmount(budget, state.spent)} of your ${budgetAmount(budget, budget.limit)} budget for ${monthName(state.month)}. Requests still go through.`
    }
  }
  return null
}

/** The alerts already shown, so each level is said once a month. */
export interface BudgetAlerts {
  month: string
  warn: boolean
  over: boolean
}

export function normalizeAlerts(raw: unknown): BudgetAlerts {
  const saved = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<BudgetAlerts>
  return { month: typeof saved.month === 'string' ? saved.month : '', warn: saved.warn === true, over: saved.over === true }
}

/**
 * Which alert to show now, if any, and the alerts as they stand after it.
 * Once for each of the two levels, until the use falls below it again (a
 * month that starts over, or a limit that was raised): then it can be said
 * again. Going straight from OK to over shows only the over alert.
 */
export function nextAlert(state: UsageBudgetState, saved: BudgetAlerts): { alert: 'warn' | 'over' | null; alerts: BudgetAlerts } {
  const alerts = saved.month === state.month ? { ...saved } : { month: state.month, warn: false, over: false }
  alerts.over = alerts.over && state.level === 'over'
  alerts.warn = alerts.warn && (state.level === 'warn' || state.level === 'over')
  if (state.level === 'over' && !alerts.over) {
    alerts.over = true
    alerts.warn = true
    return { alert: 'over', alerts }
  }
  if (state.level === 'warn' && !alerts.warn) {
    alerts.warn = true
    return { alert: 'warn', alerts }
  }
  return { alert: null, alerts }
}
