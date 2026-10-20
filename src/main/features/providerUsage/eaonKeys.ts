import { severityOf } from '@shared/cliAccounts'
import type { ProviderUsage, ProviderWindow, UsageLine } from '@shared/providerUsage'
import { secrets } from '../../secrets'
import { tokenStore } from '../../providers/oauth/shared'
import { COPILOT_HEADERS } from '../../providers/oauth/copilot'

/**
 * Usage read with what Eaon itself already holds: the GitHub sign-in behind
 * Eaon's Copilot provider, and API keys saved in Settings → Model providers.
 * Each is asked of the provider's own documented endpoint.
 */

const TIMEOUT_MS = 15_000
type Json = Record<string, unknown>
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null)
const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

async function get(url: string, headers: Record<string, string>): Promise<{ status: number; body: Json | null }> {
  const response = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  return { status: response.status, body: response.ok ? obj(await response.json()) : null }
}

const note = (id: ProviderUsage['id'], status: ProviderUsage['status'], text: string): ProviderUsage => ({
  id,
  account: null,
  plan: null,
  status,
  windows: [],
  lines: [],
  note: text,
  at: Date.now()
})

/* ------------------------------------------------------------ GitHub Copilot */

/** A quota GitHub counts: used out of its entitlement, or unlimited. */
function quotaWindow(id: string, label: string, q: Json | null, resetsAt: number | null): ProviderWindow | null {
  if (!q || q.unlimited === true) return null
  const entitlement = num(q.entitlement)
  const remaining = num(q.remaining) ?? num(q.quota_remaining)
  let percentLeft = num(q.percent_remaining)
  if (percentLeft === null && entitlement && remaining !== null) percentLeft = (remaining / entitlement) * 100
  if (percentLeft === null) return null
  const percent = Math.max(0, Math.min(100, Math.round((100 - percentLeft) * 10) / 10))
  return {
    id,
    label,
    span: 'monthly',
    percent,
    resetsAt,
    severity: severityOf(percent),
    durationMs: 30 * 24 * 3_600_000,
    ...(entitlement && remaining !== null ? { detail: `${Math.round(entitlement - remaining).toLocaleString()} of ${Math.round(entitlement).toLocaleString()}` } : {})
  }
}

export async function readCopilot(): Promise<ProviderUsage | null> {
  const tokens = tokenStore<{ github?: string; login?: string }>('github-copilot').get()
  if (!tokens?.github) return null
  const account = tokens.login ?? null
  try {
    const { status, body } = await get('https://api.github.com/copilot_internal/user', { Authorization: `token ${tokens.github}`, ...COPILOT_HEADERS })
    if (status === 401 || status === 403) return { ...note('copilot', 'signed-out', 'The GitHub sign-in has expired. Sign in again in Settings → Model providers.'), account }
    if (!body) return { ...note('copilot', 'error', `Couldn't read usage: GitHub answered ${status}.`), account }
    const resetsAt = Date.parse(str(body.quota_reset_date_utc) ?? str(body.quota_reset_date) ?? str(body.limited_user_reset_date) ?? '') || null
    const plan = str(body.copilot_plan)
    const windows: ProviderWindow[] = []
    const snapshots = obj(body.quota_snapshots)
    if (snapshots) {
      for (const [key, label] of [
        ['premium_interactions', 'Premium requests'],
        ['chat', 'Chat'],
        ['completions', 'Completions']
      ] as const) {
        const w = quotaWindow(key, label, obj(snapshots[key]), resetsAt)
        if (w) windows.push(w)
      }
    } else {
      // The free plan counts what's left against a monthly allowance.
      const left = obj(body.limited_user_quotas)
      const monthly = obj(body.monthly_quotas)
      for (const [key, label] of [
        ['chat', 'Chat'],
        ['completions', 'Completions']
      ] as const) {
        const w = quotaWindow(key, label, { remaining: left?.[key], entitlement: monthly?.[key] }, resetsAt)
        if (w) windows.push(w)
      }
    }
    return {
      id: 'copilot',
      account,
      plan: plan ? plan.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : null,
      status: 'ok',
      windows,
      lines: [],
      ...(windows.length === 0 ? { note: 'Signed in. Every Copilot quota on this plan is unlimited.' } : {}),
      at: Date.now()
    }
  } catch (error) {
    return { ...note('copilot', 'error', `Couldn't read usage: ${(error as Error).message}.`), account }
  }
}

/* ----------------------------------------------------------------- balances */

export async function readOpenRouter(): Promise<ProviderUsage | null> {
  const key = secrets.get('openrouter')?.trim()
  if (!key) return null
  try {
    const { status, body } = await get('https://openrouter.ai/api/v1/credits', { Authorization: `Bearer ${key}` })
    if (status === 401 || status === 403) return note('openrouter', 'signed-out', 'OpenRouter didn’t accept the key saved in Eaon.')
    const data = obj(body?.data)
    const total = num(data?.total_credits)
    const used = num(data?.total_usage)
    if (total === null || used === null) return note('openrouter', 'error', `Couldn't read the balance: OpenRouter answered ${status}.`)
    const lines: UsageLine[] = [{ label: 'Credits', value: `$${(total - used).toFixed(2)} left`, sub: `$${used.toFixed(2)} used of $${total.toFixed(2)} bought` }]
    return { id: 'openrouter', account: null, plan: 'Pay as you go', status: 'ok', windows: [], lines, at: Date.now() }
  } catch (error) {
    return note('openrouter', 'error', `Couldn't read the balance: ${(error as Error).message}.`)
  }
}

export async function readDeepSeek(): Promise<ProviderUsage | null> {
  const key = secrets.get('deepseek')?.trim()
  if (!key) return null
  try {
    const { status, body } = await get('https://api.deepseek.com/user/balance', { Authorization: `Bearer ${key}` })
    if (status === 401 || status === 403) return note('deepseek', 'signed-out', 'DeepSeek didn’t accept the key saved in Eaon.')
    const infos = Array.isArray(body?.balance_infos) ? (body!.balance_infos as unknown[]).map(obj).filter((b): b is Json => b !== null) : []
    if (infos.length === 0) return note('deepseek', 'error', `Couldn't read the balance: DeepSeek answered ${status}.`)
    const symbol = (c: string | null): string => (c === 'USD' ? '$' : c === 'CNY' ? '¥' : c ? `${c} ` : '')
    const lines: UsageLine[] = infos.map((b) => {
      const currency = str(b.currency)
      const granted = num(b.granted_balance) ?? 0
      return {
        label: 'Balance',
        value: `${symbol(currency)}${(num(b.total_balance) ?? 0).toFixed(2)}`,
        ...(granted > 0 ? { sub: `${symbol(currency)}${granted.toFixed(2)} of it granted` } : {})
      }
    })
    return { id: 'deepseek', account: null, plan: body?.is_available === false ? 'Out of balance' : 'Pay as you go', status: 'ok', windows: [], lines, at: Date.now() }
  } catch (error) {
    return note('deepseek', 'error', `Couldn't read the balance: ${(error as Error).message}.`)
  }
}
