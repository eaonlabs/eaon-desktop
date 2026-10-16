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
  /**
   * Requests whose provider reported no token counts at all (some
   * OpenAI-compatible servers don't). Counted as requests, but their cost
   * can't be known, so it is never shown as $0.
   */
  unreported?: number
  /** One-hour cache writes, priced higher. Only Claude's transcripts tell the two apart. */
  cacheWrite1h?: number
  /**
   * USD the tool worked out itself (Cursor's export, opencode). Used only
   * for a model Tokn has no price for: Tokn's rate wins when there is one.
   */
  reportedCost?: number
}

/**
 * How a provider's requests are paid for, which decides what a dollar figure
 * next to them means. `api`: pay per token, so Tokn's rates are an estimate
 * of the bill. `plan`: a subscription (ChatGPT, Copilot, a coding plan) — the
 * same rates are only what it would have cost by the token, never a charge.
 * `local`: runs on this computer, free.
 */
export type Billing = 'api' | 'plan' | 'local'

/**
 * What a request was made for: a chat (and anything else in a window), a
 * scheduled task, a worker, the trading desk, or another app using Eaon's
 * models through the Local API Server or Connect apps. That last kind is
 * shown beside the rest but never added to the totals or uploaded: Tokn's own
 * CLI counts those requests from the other app's logs, so uploading them as
 * Eaon's would count them twice on the Tokn profile.
 */
export type UsageSource = 'chat' | 'schedule' | 'worker' | 'trading' | 'gateway'

/** One source's share of the range, priced like the totals. */
export interface UsageSourceRow {
  source: UsageSource
  requests: number
  tokens: number
  costUsd: number
  planUsd: number
}

/**
 * What an agent run was: a Work task (or a Chat turn on an agent engine such
 * as Codex), a worker's turn, or a scheduled task. Trading sessions and other
 * apps' requests through Eaon aren't counted as agents.
 */
export type AgentRunSource = 'chat' | 'work' | 'worker' | 'scheduled'

/** Eaon's agent runs, over everything counted (up to about 400 days). */
export interface UsageAgents {
  runs: number
  runsInRange: number
  /** Working time of every run, added up. */
  totalMs: number
  /** The longest single run, and the day it started; 0 and null before the first. */
  longestMs: number
  longestDay: string | null
}

/** The signed-in account's page on Tokn, for the link that opens it. */
export type ToknPage = 'profile'

/** The account entry's state (sidebar and Settings), without the usage numbers. */
export interface UsageAccountState {
  account: ToknAccount | null
  signIn: UsageSignIn
  sync: UsageSync
}

export interface ToknAccount {
  id: string
  handle: string
  name?: string
  profileUrl: string
}

export type UsageRange = 7 | 30 | 90

/**
 * Where use happened: Eaon itself, or Claude Code and Codex in a terminal
 * (read from their own logs on this computer, shown here and never uploaded;
 * see main/features/usage/cliLogs.ts).
 */
export type UsageTool =
  | 'eaon'
  | 'claude-code'
  | 'claude-desktop'
  | 'codex'
  | 'cursor'
  | 'gemini-cli'
  | 'grok'
  | 'qwen-code'
  | 'copilot-cli'
  | 'opencode'
  | 'amp'
  | 'droid'
  | 'kimi-cli'

/** The coding CLIs whose own usage Settings → Usage reads, as Tokn names them. */
export type CliUsageTool = Exclude<UsageTool, 'eaon'>

/** What importing Cursor's usage export did. */
export interface CursorImport {
  /** Requests new to Eaon; ones an earlier export already brought in aren't counted twice. */
  added: number
  /** Every Cursor request imported so far. */
  total: number
  /** The file wasn't Cursor's usage export. */
  error?: string
}

export interface UsageToolCounts {
  /** Spend plus plan use at API rates: what the day's use stands for in dollars. */
  usd: number
  tokens: number
  requests: number
}

/** One tool's share of the range, priced like the totals. */
export interface UsageToolRow extends UsageToolCounts {
  tool: UsageTool
  costUsd: number
  planUsd: number
}

export interface UsageDay {
  day: string
  /** Estimated pay-per-token spend. */
  costUsd: number
  /** Use covered by subscription plans, at API rates: what it would have cost, not a charge. */
  planUsd?: number
  tokens: number
  requests: number
  /** The day split by tool, for the views that show Claude Code and Codex next to Eaon. */
  tools?: Partial<Record<UsageTool, UsageToolCounts>>
}

export interface UsageModelRow extends UsageCounts {
  providerId: string
  modelId: string
  /** The model's name in Tokn's price table, or null when Tokn has no price for it (local models, brand-new ones). */
  toknModel: string | null
  /** At Tokn's published rates; null when unpriced. For a plan, the API-rate equivalent, not a charge. */
  costUsd: number | null
  /** Runs on this computer: free, and never uploaded. */
  local: boolean
  billing: Billing
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
  /** The day with the most spend and plan use, or the most tokens when nothing was priced. */
  busiest: UsageDay | null
  /** The first day Eaon counted anything. */
  firstDay: string | null
  /** `planUsd`: plan use at API rates, never spend. */
  allTime: UsageTotals & { planUsd: number }
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
  /**
   * `costUsd` is the estimated pay-per-token spend only. `planUsd` is the
   * subscription use at API rates. Unpriced requests are to models Tokn has
   * no price for; unreported ones had no token counts from the provider.
   */
  totals: UsageTotals & { unpricedRequests: number; unreportedRequests: number; planUsd: number }
  today: UsageTotals & { planUsd: number }
  /** The range by what the requests were for, busiest first; only sources with any use. */
  sources: UsageSourceRow[]
  /** False until Tokn's price table has loaded once; costs read as unpriced until then. */
  priced: boolean
  /**
   * The range's days with Claude Code and Codex added, split by tool, for
   * the daily chart. `days`, the tiles and the models stay Eaon's alone.
   */
  chart: UsageDay[]
  /** The range by tool, busiest first; only tools with any use. */
  tools: UsageToolRow[]
  /** Reading the CLIs' own logs: still on the first read, which have any, and Cursor requests imported. */
  cliLogs: { reading: boolean; found: CliUsageTool[]; cursorImported: number }
  /** A year of days for the activity calendar, Claude Code and Codex included: whole weeks, Sunday first, ending today. */
  calendar: UsageDay[]
  /** Active days and streaks count Claude Code and Codex days too. */
  activity: UsageActivity
  agents: UsageAgents
}
