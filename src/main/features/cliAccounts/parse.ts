import { severityOf, type UsageWindow } from '@shared/cliAccounts'

/**
 * The CLIs' answers, as the rows the usage meter draws. Both shapes are the
 * CLIs' own and marked experimental by them, so everything here is read
 * defensively: a field that moved costs a row, never the meter.
 */

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)
const obj = (value: unknown): Record<string, unknown> | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null)
const clampPercent = (value: number): number => Math.max(0, Math.min(100, Math.round(value)))

/* --------------------------------------------------------------- Claude Code */

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
  banked?: { available: number; nextExpiry: number | null }
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
  // Banked resets, when the account has any: how many, and the soonest to expire.
  const credits = obj(r.rateLimitResetCredits)
  let banked: CodexUsage['banked']
  if (credits) {
    const list = Array.isArray(credits.credits) ? credits.credits.map(obj).filter((c): c is Record<string, unknown> => c !== null) : []
    const open = list.filter((c) => (str(c.status) ?? 'available') === 'available')
    const expiries = open.map((c) => num(c.expiresAt)).filter((t): t is number => t !== null && t > 0).map((t) => (t < 1e11 ? t * 1000 : t))
    banked = { available: num(credits.availableCount) ?? open.length, nextExpiry: expiries.length ? Math.min(...expiries) : null }
  }
  return { plan, windows, ...(banked ? { banked } : {}) }
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
