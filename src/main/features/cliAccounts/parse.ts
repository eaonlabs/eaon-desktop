import { severityOf, type UsageSeverity, type UsageWindow } from '@shared/cliAccounts'

/**
 * The CLIs' answers, as the rows the usage meter draws. Both shapes are the
 * CLIs' own and marked experimental by them, so everything here is read
 * defensively: a field that moved costs a row, never the meter.
 */

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)
const obj = (value: unknown): Record<string, unknown> | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null)
const clampPercent = (value: number): number => Math.max(0, Math.min(100, Math.round(value)))

function isoTime(value: unknown): number | null {
  const text = str(value)
  if (!text) return null
  const at = Date.parse(text)
  return Number.isFinite(at) ? at : null
}

function severity(value: unknown, percent: number): UsageSeverity {
  const named = str(value)
  if (named === 'warning') return percent >= 90 ? 'critical' : 'warning'
  if (named === 'critical' || named === 'error' || named === 'exceeded' || named === 'limited') return 'critical'
  return named === 'normal' ? (percent >= 90 ? 'critical' : 'normal') : severityOf(percent)
}

/* --------------------------------------------------------------- Claude Code */

export interface ClaudeUsage {
  /** False for an API key or a third-party provider: no plan limits to show. */
  available: boolean
  plan: string | null
  windows: UsageWindow[]
}

/**
 * Claude Code's `get_usage` answer. Its `limits` list is the server's own
 * rows — classified on `kind`, as its schema says to — and is what /usage
 * draws; the older named windows (`five_hour`, `seven_day`) fill in when an
 * answer has no list.
 */
export function claudeUsage(response: unknown): ClaudeUsage {
  const r = obj(response) ?? {}
  const plan = str(r.subscription_type)
  const limits = obj(r.rate_limits)
  if (r.rate_limits_available === false || !limits) return { available: false, plan, windows: [] }

  const windows: UsageWindow[] = []
  const list = Array.isArray(limits.limits) ? limits.limits : []
  for (const raw of list) {
    const row = obj(raw)
    const percent = num(row?.percent)
    if (!row || percent === null) continue
    const kind = str(row.kind) ?? ''
    const resetsAt = isoTime(row.resets_at)
    const scope = obj(obj(row.scope)?.model)
    const model = str(scope?.display_name)
    if (kind === 'session') {
      windows.push({ id: 'session', label: 'Session', span: '5 hours', percent: clampPercent(percent), resetsAt, severity: severity(row.severity, percent) })
    } else if (kind === 'weekly_all') {
      windows.push({ id: 'week', label: 'Week', span: 'rolling 7 days', percent: clampPercent(percent), resetsAt, severity: severity(row.severity, percent) })
    } else if (kind === 'weekly_scoped' && model) {
      // A model's own weekly limit: only worth a row once some of it is used.
      if (percent < 1) continue
      windows.push({ id: `week:${model}`, label: `${model} week`, span: 'rolling 7 days', percent: clampPercent(percent), resetsAt, severity: severity(row.severity, percent) })
    } else if (kind && kind !== 'weekly_scoped') {
      // A meter Eaon doesn't know (Team and Enterprise plans have their own):
      // the server's rows are meant to be shown as sent, so it gets a row of
      // its own, named after what it is for or its kind.
      const surface = str(obj(obj(row.scope)?.surface)?.display_name)
      const group = str(row.group)
      windows.push({
        id: `${kind}:${model ?? surface ?? ''}`,
        label: model ?? surface ?? sentence(kind),
        span: group === 'session' ? '5 hours' : group === 'weekly' ? 'rolling 7 days' : group === 'monthly' ? 'this month' : '',
        percent: clampPercent(percent),
        resetsAt,
        severity: severity(row.severity, percent)
      })
    }
  }
  if (windows.length === 0) {
    const named: [string, string, string, string][] = [
      ['five_hour', 'session', 'Session', '5 hours'],
      ['seven_day', 'week', 'Week', 'rolling 7 days'],
      ['seven_day_opus', 'week:Opus', 'Opus week', 'rolling 7 days'],
      ['seven_day_sonnet', 'week:Sonnet', 'Sonnet week', 'rolling 7 days']
    ]
    for (const [key, id, label, span] of named) {
      const w = obj(limits[key])
      const percent = num(w?.utilization)
      if (percent === null || (id.startsWith('week:') && percent < 1)) continue
      windows.push({ id, label, span, percent: clampPercent(percent), resetsAt: isoTime(w?.resets_at), severity: severityOf(percent) })
    }
  }
  const spend = spendWindow(obj(limits.extra_usage))
  if (spend && !windows.some((w) => w.id === spend.id)) windows.push(spend)
  return { available: true, plan, windows }
}

/** "monthly_spend" → "Monthly spend". */
function sentence(kind: string): string {
  const words = kind.replace(/[_-]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * The plan's monthly spend: an Enterprise or Team member's own cap, or the
 * usage credits a Pro or Max plan buys. The amounts are in minor units of
 * the currency (cents for USD). Nothing when there is no cap to measure
 * against.
 */
function spendWindow(extra: Record<string, unknown> | null): UsageWindow | null {
  const cap = num(extra?.monthly_limit)
  if (!extra || cap === null || cap <= 0) return null
  const used = Math.max(0, num(extra.used_credits) ?? 0)
  const percent = clampPercent((used / cap) * 100)
  const currency = (str(extra.currency) ?? 'USD').toUpperCase()
  const money = (minor: number): string => {
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(minor / 100)
    } catch {
      return `${(minor / 100).toFixed(2)} ${currency}`
    }
  }
  return {
    id: 'spend',
    label: 'Monthly spend',
    span: 'this billing period',
    percent,
    resetsAt: null,
    severity: severityOf(percent),
    detail: `${money(used)} of ${money(cap)}`
  }
}

/** `claude auth status --json`. */
export interface ClaudeStatus {
  loggedIn: boolean
  email: string | null
  plan: string | null
  /** 'claude.ai' for a subscription; anything else has no plan limits. */
  method: string | null
}

export function claudeStatus(json: unknown): ClaudeStatus {
  const s = obj(json) ?? {}
  return { loggedIn: s.loggedIn === true, email: str(s.email), plan: str(s.subscriptionType), method: str(s.authMethod) }
}

/* --------------------------------------------------------------------- Codex */

/** What a Codex window is called, from how long it is. */
function codexWindowName(minutes: number | null): { id: string; label: string; span: string } {
  if (minutes === null) return { id: 'window', label: 'Limit', span: '' }
  if (minutes <= 6 * 60) return { id: 'session', label: 'Session', span: `${Math.round(minutes / 60)} hours` }
  if (minutes <= 8 * 24 * 60) return { id: 'week', label: 'Week', span: 'rolling 7 days' }
  if (minutes <= 32 * 24 * 60) return { id: 'month', label: 'Month', span: 'rolling 30 days' }
  return { id: `window-${minutes}`, label: 'Limit', span: `${Math.round(minutes / 1440)} days` }
}

export interface CodexUsage {
  plan: string | null
  windows: UsageWindow[]
}

/**
 * Codex's `account/rateLimits/read` answer: a snapshot per metered limit
 * (`codex` is the main one), each with up to two windows. Other limits — a
 * model's own — are named after it.
 */
export function codexUsage(response: unknown): CodexUsage {
  const r = obj(response) ?? {}
  const byId = obj(r.rateLimitsByLimitId)
  const snapshots: Record<string, unknown>[] = []
  if (byId) for (const value of Object.values(byId)) if (obj(value)) snapshots.push(value as Record<string, unknown>)
  if (snapshots.length === 0 && obj(r.rateLimits)) snapshots.push(r.rateLimits as Record<string, unknown>)
  // The main limit first.
  snapshots.sort((a, b) => Number(str(b.limitId) === 'codex') - Number(str(a.limitId) === 'codex'))

  let plan: string | null = null
  const windows: UsageWindow[] = []
  for (const snapshot of snapshots) {
    plan ??= str(snapshot.planType)
    const limitId = str(snapshot.limitId) ?? 'codex'
    const main = limitId === 'codex'
    const name = str(snapshot.limitName) ?? str(snapshot.normalModelSlug) ?? limitId
    const reached = str(snapshot.rateLimitReachedType)
    for (const key of ['primary', 'secondary'] as const) {
      const w = obj(snapshot[key])
      const percent = num(w?.usedPercent)
      if (!w || percent === null) continue
      if (!main && percent < 1) continue
      const minutes = num(w.windowDurationMins)
      const named = codexWindowName(minutes)
      const resets = num(w.resetsAt)
      // Codex names the window it stopped on ("primary", "secondary"); any other word means the limit as a whole.
      const hit = reached !== null && (percent >= 100 || reached.toLowerCase().includes(key) || !/primary|secondary/i.test(reached))
      windows.push({
        id: main ? named.id : `${limitId}:${named.id}`,
        label: main ? named.label : `${name} ${named.label.toLowerCase()}`,
        span: named.span,
        percent: clampPercent(percent),
        resetsAt: resets === null ? null : resets * 1000,
        severity: hit ? 'critical' : severityOf(percent),
        ...(hit ? { reached: true } : {})
      })
    }
  }
  return { plan, windows }
}

/** Codex's `account/read`: who is signed in, if anyone. */
export interface CodexAccount {
  signedIn: boolean
  /** A ChatGPT sign-in has plan limits; an API key doesn't. */
  chatgpt: boolean
  email: string | null
  plan: string | null
}

export function codexAccount(response: unknown): CodexAccount {
  const account = obj(obj(response)?.account)
  if (!account) return { signedIn: false, chatgpt: false, email: null, plan: null }
  return { signedIn: true, chatgpt: account.type === 'chatgpt', email: str(account.email), plan: str(account.planType) }
}

/** "max" → "Max", "pro" → "Pro", "free" → "Free". */
export function planName(plan: string | null): string | null {
  if (!plan) return null
  return plan
    .split(/[_\s-]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}
