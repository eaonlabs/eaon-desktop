/**
 * Settings → Usage: what Eaon's own model requests use and cost, tracked with
 * Tokn (toknhq.com). Eaon counts requests and tokens on this computer;
 * signing in with Tokn shows them here, priced at Tokn's published rates, and
 * uploads the daily totals to the Tokn profile.
 */

export const TOKN_HOST = 'https://toknhq.com'

/** The `tool` Eaon's rows carry on Tokn, next to `claude-code`, `codex` and the rest. */
export const TOKN_TOOL = 'eaon'

export interface UsageCounts {
  requests: number
  /** Uncached input tokens. */
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface ToknAccount {
  id: string
  handle: string
  name?: string
  profileUrl: string
}

export type UsageRange = 7 | 30 | 90

export interface UsageDay {
  day: string
  costUsd: number
  tokens: number
  requests: number
}

export interface UsageModelRow extends UsageCounts {
  providerId: string
  modelId: string
  /** The model's name in Tokn's price table, or null when Tokn has no price for it (local models, brand-new ones). */
  toknModel: string | null
  /** At Tokn's published rates; null when unpriced. */
  costUsd: number | null
  /** Runs on this computer: free, and never uploaded. */
  local: boolean
}

export interface UsageSync {
  state: 'idle' | 'syncing' | 'error'
  /** When the last upload Tokn accepted finished. */
  at: string | null
  accepted?: number
  /** Rows Tokn turned down (a model it has no price for yet). */
  rejected?: number
  rank?: number | null
  error?: string
}

export interface UsageSignIn {
  state: 'idle' | 'pending' | 'error'
  /** The Tokn page to approve, while a sign-in waits. */
  url?: string
  error?: string
}

export interface UsageTotals {
  costUsd: number
  tokens: number
  requests: number
}

/** The activity calendar's numbers, over everything Eaon has counted (up to about 400 days). */
export interface UsageActivity {
  /** Days with at least one request. */
  activeDays: number
  /** Days with at least one request in the selected range. */
  activeInRange: number
  /** Consecutive active days up to today, or yesterday: a day isn't over yet. */
  currentStreak: number
  longestStreak: number
  /** The day with the most spend, or the most tokens when nothing was priced. */
  busiest: UsageDay | null
  /** The first day Eaon counted anything. */
  firstDay: string | null
  allTime: UsageTotals
}

export interface UsageSummary {
  account: ToknAccount | null
  signIn: UsageSignIn
  sync: UsageSync
  range: UsageRange
  /** Every day in the range, oldest first, including empty ones. */
  days: UsageDay[]
  /** The range's models, most expensive first; unpriced ones last by requests. */
  models: UsageModelRow[]
  totals: UsageTotals & { unpricedRequests: number }
  today: UsageTotals
  /** False until Tokn's price table has loaded once; costs read as unpriced until then. */
  priced: boolean
  /** A year of days for the activity calendar: whole weeks, Sunday first, ending today. */
  calendar: UsageDay[]
  activity: UsageActivity
}
