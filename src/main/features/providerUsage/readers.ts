import { readFile, stat, writeFile, rename } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { severityOf } from '@shared/cliAccounts'
import type { ProviderUsage, ProviderWindow, UsageLine, UsageProviderId } from '@shared/providerUsage'
import { secrets } from '../../secrets'

/**
 * One reader per tool: where it keeps its sign-in on this computer, and the
 * provider's own usage endpoint — the one its app or dashboard reads. A
 * reader returns null when the tool isn't signed in here, so it stays out of
 * the list; a provider with no quota endpoint says so in a note.
 *
 * Nothing is written except a token a provider rotated on refresh, put back
 * where the tool keeps it so the tool and Eaon stay signed in together.
 */

const TIMEOUT_MS = 15_000
const HOUR = 3_600_000

type Json = Record<string, unknown>
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null)
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}
const clamp = (p: number): number => Math.max(0, Math.min(100, Math.round(p * 10) / 10))
const title = (s: string): string => s.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`

/** A reset time from seconds, milliseconds or an ISO date. */
function when(v: unknown): number | null {
  const n = num(v)
  if (n !== null && n > 0) return n < 1e11 ? n * 1000 : n
  const s = str(v)
  if (!s) return null
  const t = Date.parse(s)
  return Number.isNaN(t) ? null : t
}

function window(id: string, label: string, percentUsed: number, resetsAt: number | null, durationMs?: number): ProviderWindow {
  const percent = clamp(percentUsed)
  return {
    id,
    label,
    span: durationMs ? `${Math.round(durationMs / HOUR)} hours` : '',
    percent,
    resetsAt,
    severity: severityOf(percent),
    ...(durationMs ? { durationMs } : {})
  }
}

const base = (id: UsageProviderId, rest: Partial<ProviderUsage>): ProviderUsage => ({
  id,
  account: null,
  plan: null,
  status: 'ok',
  windows: [],
  lines: [],
  at: Date.now(),
  ...rest
})

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`)
  }
}

async function request(url: string, init: RequestInit = {}): Promise<Json> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!response.ok) throw new HttpError(response.status)
  return (obj(await response.json()) ?? {}) as Json
}

/** What a failed read says on its card. */
function failed(id: UsageProviderId, error: unknown, signInHint: string): ProviderUsage {
  if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
    return base(id, { status: 'signed-out', note: `The sign-in has expired. ${signInHint}` })
  }
  const message = error instanceof HttpError ? `the provider answered ${error.status}` : error instanceof Error ? error.message : String(error)
  return base(id, { status: 'error', note: `Couldn't read usage: ${message}.` })
}

async function readJson(file: string): Promise<Json | null> {
  try {
    return obj(JSON.parse(await readFile(file, 'utf8')))
  } catch {
    return null
  }
}

const exists = (file: string): Promise<boolean> => stat(file).then(() => true, () => false)

/** A JWT's expiry, in ms, if it has one. */
function jwtExpiry(token: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Json
    const exp = num(payload.exp)
    return exp ? exp * 1000 : null
  } catch {
    return null
  }
}

/** A file rewritten whole and in one step, so the tool never reads half of it. */
async function writeAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.eaon-${process.pid}`
  await writeFile(tmp, text, { mode: 0o600 })
  await rename(tmp, file)
}

/* -------------------------------------------------------------------- Cursor */

function cursorDb(): string {
  const home = os.homedir()
  if (process.platform === 'darwin') return path.join(home, 'Library/Application Support/Cursor/User/globalStorage/state.vscdb')
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(home, 'AppData/Roaming'), 'Cursor/User/globalStorage/state.vscdb')
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'Cursor/User/globalStorage/state.vscdb')
}

interface SqliteDb {
  prepare(sql: string): { get(...params: unknown[]): unknown }
  close(): void
}

/** Values from a VS Code-style state database, read-only. */
function vscdbValues(file: string, keys: string[]): Record<string, string> {
  const sqlite = process.getBuiltinModule?.('node:sqlite') as { DatabaseSync: new (file: string, options: { readOnly: boolean }) => SqliteDb } | undefined
  if (!sqlite) return {}
  const db = new sqlite.DatabaseSync(file, { readOnly: true })
  try {
    const out: Record<string, string> = {}
    const query = db.prepare('SELECT value FROM ItemTable WHERE key = ?')
    for (const key of keys) {
      const row = query.get(key) as { value?: unknown } | undefined
      const value = row?.value
      const text = typeof value === 'string' ? value : value instanceof Uint8Array ? Buffer.from(value).toString('utf8') : null
      if (text) out[key] = text
    }
    return out
  } finally {
    db.close()
  }
}

export async function readCursor(): Promise<ProviderUsage | null> {
  const file = cursorDb()
  if (!(await exists(file))) return null
  let values: Record<string, string>
  try {
    values = vscdbValues(file, ['cursorAuth/accessToken', 'cursorAuth/stripeMembershipType', 'cursorAuth/cachedEmail'])
  } catch {
    return null
  }
  const token = values['cursorAuth/accessToken']
  if (!token) return null
  const plan = values['cursorAuth/stripeMembershipType'] ? title(values['cursorAuth/stripeMembershipType']) : null
  const account = values['cursorAuth/cachedEmail'] ?? null
  const expiry = jwtExpiry(token)
  if (expiry !== null && expiry < Date.now()) return base('cursor', { account, plan, status: 'signed-out', note: 'The sign-in has expired. Open Cursor to sign in again.' })
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json', 'Connect-Protocol-Version': '1' }
  try {
    const usage = await request('https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage', { method: 'POST', headers, body: '{}' })
    const windows: ProviderWindow[] = []
    const lines: UsageLine[] = []
    const plan_ = obj(usage.planUsage)
    const used = num(plan_?.totalPercentUsed)
    const end = when(usage.billingCycleEnd)
    const start = when(usage.billingCycleStart)
    if (used !== null) windows.push(window('current', 'Current', used, end, end && start ? end - start : undefined))
    const spend = obj(usage.spendLimitUsage)
    const limit = num(spend?.individualLimit)
    const remaining = num(spend?.individualRemaining)
    if (limit !== null && limit > 0) lines.push({ label: 'On-demand', value: `${usd(limit - (remaining ?? 0))} of ${usd(limit)}` })
    try {
      const credits = await request('https://api2.cursor.sh/aiserver.v1.DashboardService/GetCreditGrantsBalance', { method: 'POST', headers, body: '{}' })
      const total = num(credits.totalCents)
      const spent = num(credits.usedCents)
      if (credits.hasCreditGrants !== false && total !== null && total > 0) lines.push({ label: 'Credits', value: `${usd(total - (spent ?? 0))} left of ${usd(total)}` })
    } catch {
      /* Credit grants are extra; the period's usage stands without them. */
    }
    return base('cursor', { account, plan, windows, lines })
  } catch (error) {
    return { ...failed('cursor', error, 'Open Cursor to sign in again.'), account, plan }
  }
}

/* ---------------------------------------------------------------------- Grok */

/** Grok's sign-in file: entries by issuer, the x.ai account one preferred. */
export async function readGrok(): Promise<ProviderUsage | null> {
  const file = path.join(process.env.GROK_HOME ?? path.join(os.homedir(), '.grok'), 'auth.json')
  const all = await readJson(file)
  if (!all) return null
  const keys = Object.keys(all)
  const issuer = keys.find((k) => k.startsWith('https://auth.x.ai')) ?? keys.find((k) => k.startsWith('https://accounts.x.ai')) ?? keys[0]
  const entry = issuer ? obj(all[issuer]) : null
  let token = str(entry?.key)
  if (!entry || !token) return null
  const account = str(entry.email)
  const hint = 'Run `grok login` to sign in again.'

  // Refreshed with the sign-in's own client, and written back for Grok.
  const expiresAt = when(entry.expires_at) ?? jwtExpiry(token)
  const refresh = str(entry.refresh_token)
  const client = str(entry.oidc_client_id)
  if (expiresAt !== null && expiresAt - Date.now() < 5 * 60_000 && refresh && client) {
    try {
      const response = await fetch('https://auth.x.ai/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: client }),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
      if (response.ok) {
        const fresh = (await response.json()) as Json
        token = str(fresh.access_token) ?? token
        entry.key = token
        if (str(fresh.refresh_token)) entry.refresh_token = fresh.refresh_token
        const expiresIn = num(fresh.expires_in)
        if (expiresIn) entry.expires_at = new Date(Date.now() + expiresIn * 1000).toISOString()
        await writeAtomic(file, JSON.stringify(all, null, 2))
      } else if (response.status >= 400 && response.status < 500) {
        // Grok may have refreshed it itself meanwhile: read the file again next time.
        return base('grok', { account, status: 'signed-out', note: `The sign-in has expired. ${hint}` })
      }
    } catch {
      /* The old token may still work. */
    }
  }

  const headers = { Authorization: `Bearer ${token}`, 'x-xai-token-auth': 'xai-grok-cli', Accept: 'application/json' }
  try {
    const billing = await request('https://cli-chat-proxy.grok.com/v1/billing?format=credits', { headers })
    let plan: string | null = null
    try {
      const settings = await request('https://cli-chat-proxy.grok.com/v1/settings', { headers })
      const tier = str(settings.subscription_tier_display) ?? str(obj(settings.config)?.subscription_tier_display)
      if (tier) plan = tier
    } catch {
      /* The plan's name is extra. */
    }
    const c = obj(billing.config) ?? billing
    const money = (v: unknown): number | null => num(v) ?? num(obj(v)?.val)
    let percent = num(c.creditUsagePercent)
    if (percent !== null && percent <= 1) percent *= 100
    const usage = obj(c.usage)
    if (percent === null) {
      const used = money(usage?.totalUsed)
      const limit = money(c.monthlyLimit)
      if (used !== null && limit) percent = (used / limit) * 100
    }
    const period = obj(c.currentPeriod)
    const resets = when(period?.end) ?? when(c.billingPeriodEnd) ?? when(obj(c.billingCycle)?.billingPeriodEnd)
    const weekly = /weekly/i.test(str(period?.type) ?? '') || (!period && c.isUnifiedBillingUser === true)
    const windows = percent === null ? [] : [window(weekly ? 'week' : 'credits', weekly ? 'Weekly' : 'Credits', percent, resets, weekly ? 7 * 24 * HOUR : undefined)]
    const lines: UsageLine[] = []
    const onDemand = money(c.onDemandUsed)
    const cap = money(c.onDemandCap)
    if (onDemand !== null && cap) lines.push({ label: 'On-demand', value: `$${onDemand.toFixed(2)} of $${cap.toFixed(2)}` })
    return base('grok', { account, plan, windows, lines, ...(windows.length === 0 ? { note: 'Signed in. Grok reported no limit for this account.' } : {}) })
  } catch (error) {
    return { ...failed('grok', error, hint), account }
  }
}

/* ------------------------------------------------------------------ OpenCode */

function opencodeAuthFiles(): string[] {
  const home = os.homedir()
  const files = [
    process.env.OPENCODE_DATA_DIR && path.join(process.env.OPENCODE_DATA_DIR, 'auth.json'),
    process.env.XDG_DATA_HOME && path.join(process.env.XDG_DATA_HOME, 'opencode/auth.json'),
    path.join(home, '.local/share/opencode/auth.json')
  ]
  if (process.platform === 'win32') files.push(path.join(process.env.APPDATA ?? '', 'opencode/auth.json'), path.join(process.env.LOCALAPPDATA ?? '', 'opencode/auth.json'))
  return files.filter((f): f is string => Boolean(f))
}

/**
 * OpenCode Go's limits, with the key OpenCode signed in with or the one saved
 * in Eaon (Settings → Model providers → OpenCode Go); signed in to OpenCode
 * without Go, it says so.
 */
export async function readOpencode(): Promise<ProviderUsage | null> {
  let auth: Json | null = null
  for (const file of opencodeAuthFiles()) if ((auth = await readJson(file))) break
  const saved = secrets.get('opencode-go')?.trim() || null
  if ((!auth || Object.keys(auth).length === 0) && !saved) return null
  const key = str(obj(auth?.['opencode-go'])?.key) ?? str(obj(auth?.opencode)?.key) ?? saved
  if (!key) return base('opencode', { status: 'unsupported', note: 'Signed in with other providers. Limits show for an OpenCode Go subscription: `opencode auth login`.' })
  try {
    const body = await request('https://opencode.ai/zen/go/v1/usage', { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } })
    const usage = obj(body.usage) ?? body
    const windows: ProviderWindow[] = []
    for (const [field, id, label, ms] of [
      ['rolling', 'session', '5h', 5 * HOUR],
      ['weekly', 'week', 'Weekly', 7 * 24 * HOUR],
      ['monthly', 'month', 'Monthly', 30 * 24 * HOUR]
    ] as const) {
      const w = obj(usage[field])
      const percent = num(w?.percent)
      if (w && percent !== null) windows.push(window(id, label, percent <= 1 && percent > 0 && !Number.isInteger(percent) ? percent * 100 : percent, when(w.resetsAt), ms))
    }
    return base('opencode', { plan: 'Go', windows })
  } catch (error) {
    if (error instanceof HttpError && error.status === 403) return base('opencode', { status: 'unsupported', note: 'No active OpenCode Go subscription on this key.' })
    return failed('opencode', error, 'Run `opencode auth login` to sign in again.')
  }
}

/* --------------------------------------------------------------------- Devin */

async function devinCredentials(): Promise<{ key: string; server: string } | null> {
  const envKey = process.env.WINDSURF_API_KEY ?? process.env.DEVIN_API_KEY
  const envServer = process.env.WINDSURF_API_SERVER_URL ?? process.env.DEVIN_API_SERVER_URL
  if (envKey) return { key: envKey, server: envServer ?? 'https://server.codeium.com' }
  const dir = process.platform === 'win32' ? path.join(process.env.APPDATA ?? '', 'devin') : path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local/share'), 'devin')
  let text: string
  try {
    text = await readFile(path.join(dir, 'credentials.toml'), 'utf8')
  } catch {
    return null
  }
  const field = (name: string): string | null => new RegExp(`^\\s*${name}\\s*=\\s*"([^"]*)"`, 'm').exec(text)?.[1] ?? null
  const key = field('windsurf_api_key')
  if (!key) return null
  const server = field('api_server_url') ?? 'https://server.codeium.com'
  // Only to a provider over HTTPS, or a server on this machine.
  const url = new URL(server)
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '::1'].includes(url.hostname)) return null
  return { key, server: server.replace(/\/+$/, '') }
}

export async function readDevin(): Promise<ProviderUsage | null> {
  const credentials = await devinCredentials()
  if (!credentials) return null
  try {
    const body = await request(`${credentials.server}/exa.seat_management_pb.SeatManagementService/GetUserStatus`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${credentials.key}`, 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' },
      body: JSON.stringify({ metadata: { apiKey: credentials.key, ideName: 'eaon', ideVersion: '0.0.0', extensionName: 'eaon', extensionVersion: '0.0.0', locale: 'en' } })
    })
    const status = obj(body.userStatus) ?? {}
    const planStatus = obj(status.planStatus) ?? obj(status.plan_status) ?? {}
    const pick = (camel: string, snake: string): unknown => planStatus[camel] ?? planStatus[snake]
    const info = obj(pick('planInfo', 'plan_info')) ?? {}
    const windows: ProviderWindow[] = []
    const daily = num(pick('dailyQuotaRemainingPercent', 'daily_quota_remaining_percent'))
    if (daily !== null && info.hideDailyQuota !== true) windows.push(window('day', 'Daily', 100 - daily, when(pick('dailyQuotaResetAtUnix', 'daily_quota_reset_at_unix')), 24 * HOUR))
    const weekly = num(pick('weeklyQuotaRemainingPercent', 'weekly_quota_remaining_percent'))
    if (weekly !== null) windows.push(window('week', 'Weekly', 100 - weekly, when(pick('weeklyQuotaResetAtUnix', 'weekly_quota_reset_at_unix')), 7 * 24 * HOUR))
    const lines: UsageLine[] = []
    const used = num(pick('usedPromptCredits', 'used_prompt_credits'))
    const available = num(pick('availablePromptCredits', 'available_prompt_credits'))
    if (available !== null) lines.push({ label: 'Prompt credits', value: `${Math.round(available).toLocaleString()} left of ${Math.round((used ?? 0) + available).toLocaleString()}` })
    const overage = num(pick('overageBalanceMicros', 'overage_balance_micros'))
    if (overage !== null && overage > 0) lines.push({ label: 'Extra usage balance', value: `$${(overage / 1e6).toFixed(2)}` })
    return base('devin', { plan: str(info.planName) ?? str(info.plan_name), windows, lines })
  } catch (error) {
    return failed('devin', error, 'Run `devin auth login` to sign in again.')
  }
}

/* ------------------------------------------------------------ signed in only */

/**
 * Tools whose limits aren't read: Pi keeps no quota of its own (each model
 * provider it uses has its own), Droid keeps its sign-in encrypted with a key
 * in the system keychain, and Antigravity's quota service only answers its
 * own app. Signed in, each still gets a card that says so.
 */
export async function readSignedInOnly(): Promise<ProviderUsage[]> {
  const home = os.homedir()
  const out: ProviderUsage[] = []
  const pi = await readJson(path.join(process.env.PI_CODING_AGENT_DIR ?? path.join(home, '.pi/agent'), 'auth.json'))
  if (pi && Object.keys(pi).length > 0) {
    out.push(base('pi', { status: 'unsupported', note: 'Pi is signed in. Its limits are each model provider’s own; Pi has no single quota to read.' }))
  }
  const factory = path.join(home, '.factory')
  const droidSignedIn = (await Promise.all(['auth.v2.file', 'auth.v2.keyring', 'auth.v2.loginkeychain', 'auth.json'].map((f) => exists(path.join(factory, f))))).some(Boolean)
  if (droidSignedIn || process.env.FACTORY_API_KEY) {
    out.push(base('droid', { status: 'unsupported', note: 'Droid is signed in. Its limits are kept encrypted in the system keychain, so they aren’t read here; its token totals are.' }))
  }
  const antigravityDb =
    process.platform === 'darwin'
      ? path.join(home, 'Library/Application Support/Antigravity/User/globalStorage/state.vscdb')
      : process.platform === 'win32'
        ? path.join(process.env.APPDATA ?? '', 'Antigravity/User/globalStorage/state.vscdb')
        : path.join(home, '.config/Antigravity/User/globalStorage/state.vscdb')
  if ((await exists(antigravityDb)) || (await exists(path.join(home, '.gemini/antigravity-cli')))) {
    out.push(base('antigravity', { status: 'unsupported', note: 'Antigravity is signed in. Its quota service only answers Antigravity itself, so its limits show there.' }))
  }
  return out
}
