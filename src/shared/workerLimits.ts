import type { TokenUsage } from './types'

/**
 * What an owner can hold a worker to, as plain data with pure helpers (the
 * engine, the worker's browser and the editor all read these, and the tests
 * run them under plain Node):
 *
 * - a spend cap: tokens (and dollars, where the app knows a price) per day or
 *   month, checked before each run;
 * - retries: how many times, and how far apart, a run that failed for a
 *   passing reason is tried again;
 * - websites: sites the worker's browser may or may not visit;
 * - tool rules: tools the worker has to ask about, or never gets.
 */

/* ------------------------------------------------------------------ spend cap */

export type BudgetPeriod = 'day' | 'month'

export interface WorkerBudget {
  /** Input plus output tokens per period; null for no token cap. */
  tokens: number | null
  /** US dollars per period, counted only for runs billed per token on a model with a known price; null for none. */
  usd: number | null
  period: BudgetPeriod
}

/** What a worker has used since its current period began. */
export interface WorkerSpend {
  since: number
  tokens: number
  usd: number
}

export const BUDGET_PERIODS: { id: BudgetPeriod; label: string; noun: string; resets: string }[] = [
  { id: 'day', label: 'a day', noun: 'today', resets: 'at midnight' },
  { id: 'month', label: 'a month', noun: 'this month', resets: 'on the 1st' }
]

const MAX_BUDGET_TOKENS = 1_000_000_000_000
const MAX_BUDGET_USD = 1_000_000

const positiveInt = (value: unknown, max: number): number | null => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), max) : null
}

const positiveMoney = (value: unknown, max: number): number | null => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  return Number.isFinite(n) && n >= 0.01 ? Math.min(Math.round(n * 100) / 100, max) : null
}

/** A saved or typed budget, repaired; null when neither limit is set. */
export function normalizeBudget(raw: unknown): WorkerBudget | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const tokens = positiveInt(r.tokens, MAX_BUDGET_TOKENS)
  const usd = positiveMoney(r.usd, MAX_BUDGET_USD)
  if (tokens === null && usd === null) return null
  return { tokens, usd, period: r.period === 'month' ? 'month' : 'day' }
}

/** Local midnight today, or midnight on the 1st of this month. */
export function periodStart(period: BudgetPeriod, now: number): number {
  const d = new Date(now)
  return period === 'month' ? new Date(d.getFullYear(), d.getMonth(), 1).getTime() : new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** When the period that holds `now` ends: the next local midnight, or the 1st of next month. */
export function periodEnd(period: BudgetPeriod, now: number): number {
  const d = new Date(now)
  return period === 'month' ? new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime() : new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
}

/** Input plus output: the count each run's receipt shows. Cached input is not counted twice. */
export function usageTokens(usage: Pick<TokenUsage, 'input' | 'output'> | null | undefined): number {
  return usage ? Math.max(0, usage.input) + Math.max(0, usage.output) : 0
}

/** The spend that counts now: what was saved if it is from this period, else a fresh zero. */
export function spendNow(spend: WorkerSpend | null | undefined, period: BudgetPeriod, now: number): WorkerSpend {
  const start = periodStart(period, now)
  if (spend && Number.isFinite(spend.since) && spend.since >= start && spend.since <= now + 1000) {
    return { since: spend.since, tokens: Math.max(0, spend.tokens || 0), usd: Math.max(0, spend.usd || 0) }
  }
  return { since: start, tokens: 0, usd: 0 }
}

/** `spend` plus a run's tokens and dollars, starting a new period when the old one is over. */
export function addSpend(spend: WorkerSpend | null | undefined, period: BudgetPeriod, now: number, add: { tokens: number; usd: number }): WorkerSpend {
  const current = spendNow(spend, period, now)
  return { since: current.since, tokens: current.tokens + Math.max(0, add.tokens), usd: Math.round((current.usd + Math.max(0, add.usd)) * 1e6) / 1e6 }
}

/** What a worker's earlier runs add up to in the current period, for a cap that was just set. */
export function seedSpend(runs: { endedAt: number | null; tokens: number; usd: number | null }[], period: BudgetPeriod, now: number): WorkerSpend {
  const start = periodStart(period, now)
  let tokens = 0
  let usd = 0
  for (const run of runs) {
    if (run.endedAt === null || run.endedAt < start) continue
    tokens += run.tokens
    usd += run.usd ?? 0
  }
  return { since: start, tokens, usd: Math.round(usd * 1e6) / 1e6 }
}

export interface BudgetHit {
  limit: 'tokens' | 'usd'
  used: number
  cap: number
}

/** The limit that has been reached, if one has (tokens are looked at first). */
export function budgetHit(budget: WorkerBudget | null | undefined, spend: WorkerSpend | null | undefined, now: number): BudgetHit | null {
  if (!budget) return null
  const current = spendNow(spend, budget.period, now)
  if (budget.tokens !== null && current.tokens >= budget.tokens) return { limit: 'tokens', used: current.tokens, cap: budget.tokens }
  if (budget.usd !== null && current.usd >= budget.usd) return { limit: 'usd', used: current.usd, cap: budget.usd }
  return null
}

const count = (n: number): string => Math.round(n).toLocaleString('en-US')
export const moneyText = (n: number): string => `$${n.toFixed(2)}`

/** Why a worker was paused, in the words the page and the notification use. */
export function budgetReason(hit: BudgetHit, period: BudgetPeriod): string {
  const p = BUDGET_PERIODS.find((x) => x.id === period) ?? BUDGET_PERIODS[0]
  const used = hit.limit === 'tokens' ? `Used ${count(hit.used)} of its ${count(hit.cap)} tokens for ${p.noun}.` : `Spent about ${moneyText(hit.used)} of its ${moneyText(hit.cap)} for ${p.noun}.`
  return `${used} It starts again ${p.resets}, or raise the cap in Edit to let it carry on.`
}

/** "12,400 of 50,000 tokens today", for the editor's usage line. */
export function budgetUsageLines(budget: WorkerBudget, spend: WorkerSpend | null | undefined, now: number): string[] {
  const p = BUDGET_PERIODS.find((x) => x.id === budget.period) ?? BUDGET_PERIODS[0]
  const current = spendNow(spend, budget.period, now)
  const lines: string[] = []
  if (budget.tokens !== null) lines.push(`${count(current.tokens)} of ${count(budget.tokens)} tokens ${p.noun}`)
  if (budget.usd !== null) lines.push(`about ${moneyText(current.usd)} of ${moneyText(budget.usd)} ${p.noun}`)
  return lines
}

/* -------------------------------------------------------------------- retries */

export interface WorkerRetry {
  /** How many more tries after the first failure. */
  attempts: number
  /** The wait before the first retry; each later one waits twice as long as the one before. */
  minutes: number
}

export const MAX_RETRY_ATTEMPTS = 5
export const MAX_RETRY_MINUTES = 120
/** No single wait runs longer than this, however far the doubling has gone. */
const MAX_RETRY_WAIT_MS = 4 * 60 * 60_000
export const DEFAULT_RETRY: WorkerRetry = { attempts: 2, minutes: 2 }

/** A saved or typed retry setting, repaired; null (no retries) when it asks for none. */
export function normalizeRetry(raw: unknown): WorkerRetry | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const attempts = typeof r.attempts === 'number' && Number.isFinite(r.attempts) ? Math.floor(r.attempts) : 0
  if (attempts < 1) return null
  const minutes = typeof r.minutes === 'number' && Number.isFinite(r.minutes) ? Math.floor(r.minutes) : DEFAULT_RETRY.minutes
  return { attempts: Math.min(attempts, MAX_RETRY_ATTEMPTS), minutes: Math.min(Math.max(minutes, 1), MAX_RETRY_MINUTES) }
}

/** The wait before retry number `attempt` (1 is the first retry). */
export function retryDelayMs(retry: WorkerRetry, attempt: number): number {
  const wait = retry.minutes * 60_000 * 2 ** Math.max(0, attempt - 1)
  return Math.min(wait, MAX_RETRY_WAIT_MS)
}

/** "2 min", "1 h", "90 min": a wait in words. */
export function waitText(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes < 90) return `${minutes} min`
  const hours = Math.round(minutes / 6) / 10
  return `${hours} h`
}

// What can't be fixed by trying again: a sign-in, a key, a plan's limit, a model or program that isn't there.
const LASTING = [
  /sign(ed)?[- ]?in\b|signed out|session expired|reconnect it|log ?in again/i,
  /rejected the api key|invalid api key|api key (is )?(invalid|missing)|unauthori[sz]ed|forbidden|\b40[13]\b/i,
  /out of credit|over its quota|insufficient[_ ]quota|usage limit|free requests are used up|plan.s usage|billing|payment required|\b402\b/i,
  /isn.t allowed to use|doesn.t offer|isn.t available|not available|isn.t installed|not installed|too old|region|no model|isn.t selected|follows chat.s model/i,
  /is set up to send its requests through eaon|check its base url/i,
  /certificate/i,
  // A rate limit that asks to wait hours is not a few minutes' trouble.
  /try again in \d+(\.\d+)? ?h\b|resets later|rest of the day|for the day/i
]
const PASSING = [
  /didn.t answer in time|timed out|timeout|etimedout/i,
  /couldn.t reach|could not reach|connection (to .+ )?(dropped|reset|closed|lost)|econn(reset|refused)|enotfound|eai_again|socket hang up|fetch failed|network (error|is unreachable)|epipe|offline/i,
  /is having problems|temporarily unavailable|overloaded|service unavailable|bad gateway|gateway time-?out|internal server error|\b(500|502|503|504|529)\b/i,
  /limiting how fast|rate.?limit|too many requests|\b429\b/i,
  /no progress for \d+ minutes/i,
  /stopped responding and was restarted|try again in a (moment|few minutes)|couldn.t check this copy of eaon just now/i
]

/**
 * Whether an error is the kind that goes away by itself: a dropped
 * connection, a timeout, an overloaded model, a short rate limit, a stalled
 * turn. A sign-in that ran out, a rejected key, an empty account, a model
 * that isn't there or a program that isn't installed won't be fixed by
 * waiting, so those are never retried.
 */
export function isTransientError(error: string | null | undefined): boolean {
  const text = (error ?? '').trim()
  if (!text) return false
  if (LASTING.some((pattern) => pattern.test(text))) return false
  return PASSING.some((pattern) => pattern.test(text))
}

/** "Retry 1 of 2: Daily research", the label a retry's receipt carries. */
export function retryLabel(attempt: number, of: number, original: string): string {
  return `Retry ${attempt} of ${of}: ${original.replace(/^Retry( \d+ of \d+)?: /, '')}`
}

/* ------------------------------------------------------------------- websites */

export interface SiteRules {
  /** When any are listed, the browser may only open these sites (and their subdomains). */
  allow: string[]
  /** Sites it never opens, a listed site's subdomains included. Wins over `allow`. */
  deny: string[]
}

export const MAX_SITE_RULES = 100

/** The host a typed site or address stands for ("https://www.Example.com/a" → "www.example.com"), or null when it isn't one. */
export function siteEntry(raw: string): string | null {
  let text = raw.trim().toLowerCase()
  if (!text) return null
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^\*\./, '')
  text = text.split(/[/?#]/)[0].replace(/^[^@]*@/, '').replace(/:\d+$/, '').replace(/\.$/, '')
  if (!text || text.length > 253) return null
  if (text === 'localhost') return text
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(text)) return null
  return text
}

/** A typed list (one per line, or separated by commas or spaces) as sites, and the entries that aren't one. */
export function parseSiteList(text: string): { entries: string[]; invalid: string[] } {
  const entries: string[] = []
  const invalid: string[] = []
  for (const part of text.split(/[\s,;]+/)) {
    if (!part.trim()) continue
    const entry = siteEntry(part)
    if (entry === null) invalid.push(part.trim())
    else if (!entries.includes(entry)) entries.push(entry)
  }
  return { entries, invalid }
}

/** Saved or typed rules, repaired; null when both lists are empty. */
export function normalizeSites(raw: unknown): SiteRules | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const list = (value: unknown): string[] =>
    parseSiteList(Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string').join(' ') : '').entries.slice(0, MAX_SITE_RULES)
  const allow = list(r.allow)
  const deny = list(r.deny)
  return allow.length === 0 && deny.length === 0 ? null : { allow, deny }
}

/** Whether a listed site covers a host: the host itself, or any subdomain of it. */
export function siteCovers(entry: string, host: string): boolean {
  return host === entry || host.endsWith(`.${entry}`)
}

export type SiteVerdict = { allowed: true } | { allowed: false; reason: string }

function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return null
    return parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  } catch {
    return null
  }
}

/** What the model is told when a site is refused: what, why, and not to look for a way round. */
export const siteRefusal = (host: string, why: 'blocked' | 'not-allowed'): string =>
  why === 'blocked'
    ? `${host} is one of the sites the user blocked for you, so you can't open it. Don't look for another way to reach it; if you need it, say so in your report.`
    : `${host} isn't one of the sites the user allowed for you (they limited you to certain sites), so you can't open it. Don't look for another way to reach it; if you need it, say so in your report.`

/**
 * Whether a worker may open `url`. A blocked site is refused for every
 * request, a page's images and scripts included; the allowed list limits where
 * the worker goes (navigations), not what a page it is allowed on pulls in.
 * Anything that isn't a web address (about:blank, data:) is the browser's own
 * policy's to judge.
 */
export function siteVerdict(rules: SiteRules | null | undefined, url: string, options: { navigation?: boolean } = {}): SiteVerdict {
  if (!rules) return { allowed: true }
  const host = hostOf(url)
  if (host === null) return { allowed: true }
  if (rules.deny.some((entry) => siteCovers(entry, host))) return { allowed: false, reason: siteRefusal(host, 'blocked') }
  if (options.navigation !== false && rules.allow.length > 0 && !rules.allow.some((entry) => siteCovers(entry, host))) {
    return { allowed: false, reason: siteRefusal(host, 'not-allowed') }
  }
  return { allowed: true }
}

/**
 * The hook BetterWright asks about every request its browser makes
 * (`NetworkPolicy`'s `custom`), over rules read fresh each time, so editing a
 * worker's sites applies to a browser that is already open. A connect target
 * the guard resolved from a name (`resolvedFrom`) was judged by that name
 * already; the hook has no opinion on its address.
 */
export function siteGuard(rulesOf: () => SiteRules | null | undefined): (url: string, details: Record<string, unknown>) => { allowed: false; reason: string } | null {
  return (url, details) => {
    if (details && typeof details === 'object' && 'resolvedFrom' in details && details.resolvedFrom) return null
    const navigation = details?.isNavigation === true || details?.resourceType === 'document'
    const verdict = siteVerdict(rulesOf(), url, { navigation })
    return verdict.allowed ? null : { allowed: false, reason: verdict.reason }
  }
}

/* ----------------------------------------------------------------- tool rules */

/** `ask`: each call waits for the owner's approval. `block`: the tool isn't offered, and a call is refused. Absent: the worker's freedom level decides. */
export type ToolRule = 'ask' | 'block'
export type ToolRules = Record<string, ToolRule>

export const MAX_TOOL_RULES = 200

/** Saved or typed tool rules, repaired; null when there are none. */
export function normalizeToolRules(raw: unknown): ToolRules | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out: ToolRules = {}
  for (const [name, rule] of Object.entries(raw as Record<string, unknown>)) {
    if ((rule === 'ask' || rule === 'block') && name.trim() && name.length <= 120 && Object.keys(out).length < MAX_TOOL_RULES) out[name.trim()] = rule
  }
  return Object.keys(out).length > 0 ? out : null
}
