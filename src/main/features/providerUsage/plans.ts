import { severityOf } from '@shared/cliAccounts'
import type { ProviderUsage, ProviderWindow, UsageProviderId } from '@shared/providerUsage'
import { secrets } from '../../secrets'

/**
 * Coding-plan subscriptions set up in Settings → Model providers with the
 * plan's own key: what is left of each, asked of the endpoint the provider's
 * own coding tool reads (none of these is a published API, so every field is
 * read defensively). Alibaba's and Xiaomi's token plans have no such
 * endpoint; their cards say where the figures are.
 */

const TIMEOUT_MS = 15_000
const HOUR = 3_600_000
const DAY = 24 * HOUR

type Json = Record<string, unknown>
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null)
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const num = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}
const clamp = (p: number): number => Math.max(0, Math.min(100, Math.round(p * 10) / 10))
const title = (s: string): string => s.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

/** A reset time from seconds, milliseconds or an ISO date. */
function when(v: unknown): number | null {
  const n = num(v)
  if (n !== null && n > 0) return n < 1e11 ? n * 1000 : n
  const s = str(v)
  if (!s) return null
  const t = Date.parse(s)
  return Number.isNaN(t) ? null : t
}

function window(id: string, label: string, span: string, percentUsed: number, resetsAt: number | null, durationMs: number | null, detail?: string): ProviderWindow {
  const percent = clamp(percentUsed)
  return { id, label, span, percent, resetsAt, severity: severityOf(percent), ...(durationMs ? { durationMs } : {}), ...(detail ? { detail } : {}) }
}

const card = (id: UsageProviderId, rest: Partial<ProviderUsage>): ProviderUsage => ({
  id,
  account: null,
  plan: null,
  status: 'ok',
  windows: [],
  lines: [],
  at: Date.now(),
  ...rest
})

/** A key saved in Eaon for the first of these providers that has one. */
function savedKey(...providerIds: string[]): { providerId: string; key: string } | null {
  for (const providerId of providerIds) {
    const key = secrets.get(providerId)?.trim()
    if (key) return { providerId, key }
  }
  return null
}

async function get(url: string, headers: Record<string, string>): Promise<{ status: number; body: Json | null }> {
  const response = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' })
  return { status: response.status, body: obj(await response.json().catch(() => null)) }
}

const rejected = (id: UsageProviderId, name: string): ProviderUsage =>
  card(id, { status: 'signed-out', note: `${name} didn’t accept the key saved in Eaon. Paste it again in Settings → Model providers.` })
const unreadable = (id: UsageProviderId, name: string, why: string): ProviderUsage => card(id, { status: 'error', note: `Couldn’t read ${name}’s usage: ${why}.` })

/* ------------------------------------------------------------ Kimi For Coding */

/** How long a Kimi window runs: `{ duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }`. */
function kimiSpan(raw: Json | null): { ms: number; text: string } | null {
  const duration = num(raw?.duration)
  const unit = { TIME_UNIT_MINUTE: 60_000, TIME_UNIT_HOUR: HOUR, TIME_UNIT_DAY: DAY, TIME_UNIT_WEEK: 7 * DAY }[str(raw?.timeUnit) ?? ''] as number | undefined
  if (!duration || !unit) return null
  const ms = duration * unit
  return { ms, text: ms % DAY === 0 ? (ms === 7 * DAY ? 'rolling 7 days' : `${ms / DAY} days`) : `${ms / HOUR} hours` }
}

/** Kimi's `/usages`: the week's requests, and each shorter window's. */
export function kimiWindows(body: Json): ProviderWindow[] {
  const windows: ProviderWindow[] = []
  const row = (detail: Json | null): { used: number; limit: number; resetsAt: number | null } | null => {
    const used = num(detail?.used)
    const limit = num(detail?.limit)
    return used !== null && limit !== null && limit > 0 ? { used, limit, resetsAt: when(detail?.resetTime) } : null
  }
  for (const raw of Array.isArray(body.limits) ? body.limits : []) {
    const item = obj(raw)
    const r = row(obj(item?.detail))
    const span = kimiSpan(obj(item?.window))
    if (!r || !span) continue
    const session = span.ms === 5 * HOUR
    windows.push(window(session ? 'session' : `window-${span.ms}`, session ? 'Session' : (str(item?.name) ?? title(span.text)), span.text, (r.used / r.limit) * 100, r.resetsAt, span.ms, `${r.used.toLocaleString()} of ${r.limit.toLocaleString()} requests`))
  }
  const week = row(obj(body.usage))
  if (week) windows.push(window('week', 'Week', 'rolling 7 days', (week.used / week.limit) * 100, week.resetsAt, 7 * DAY, `${week.used.toLocaleString()} of ${week.limit.toLocaleString()} requests`))
  return windows
}

export async function readKimi(): Promise<ProviderUsage | null> {
  const saved = savedKey('kimi-coding')
  if (!saved) return null
  try {
    const { status, body } = await get('https://api.kimi.com/coding/v1/usages', { Authorization: `Bearer ${saved.key}` })
    if (status === 401 || status === 403) return rejected('kimi', 'Kimi')
    if (!body) return unreadable('kimi', 'Kimi', `it answered ${status}`)
    const windows = kimiWindows(body)
    return card('kimi', { plan: 'Kimi For Coding', windows, ...(windows.length === 0 ? { note: 'Kimi reported no limits for this key.' } : {}) })
  } catch (error) {
    return unreadable('kimi', 'Kimi', (error as Error).message)
  }
}

/* ------------------------------------------------------------ GLM Coding Plan */

/**
 * Z.ai's quota monitor (the one its own coding plugin reads): the five-hour
 * and weekly prompt windows (`unit` 3 is hours, 6 weeks), and the month's
 * web search and reader calls.
 */
export function glmWindows(data: Json): ProviderWindow[] {
  const windows: ProviderWindow[] = []
  for (const raw of Array.isArray(data.limits) ? data.limits : []) {
    const limit = obj(raw)
    const percent = num(limit?.percentage)
    if (!limit || percent === null) continue
    const type = str(limit.type) ?? ''
    const unit = num(limit.unit)
    const count = num(limit.number)
    const resetsAt = when(limit.nextResetTime)
    if (type === 'TIME_LIMIT') {
      const used = num(limit.currentValue)
      const total = num(limit.usage)
      windows.push(window('tools', 'Web tools', 'monthly', percent, resetsAt, 30 * DAY, used !== null && total ? `${used.toLocaleString()} of ${total.toLocaleString()} calls` : undefined))
    } else if (unit === 3 && count === 5) {
      windows.push(window('session', 'Session', '5 hours', percent, resetsAt, 5 * HOUR))
    } else if (unit === 6 && count === 1) {
      windows.push(window('week', 'Week', 'rolling 7 days', percent, resetsAt, 7 * DAY))
    } else if (/LIMIT$/.test(type)) {
      windows.push(window(type.toLowerCase(), title(type.replace(/_LIMIT$/, '')), '', percent, resetsAt, null))
    }
  }
  return windows
}

export async function readGlm(): Promise<ProviderUsage | null> {
  const saved = savedKey('zai-coding', 'zai-coding-cn')
  if (!saved) return null
  const origin = saved.providerId === 'zai-coding-cn' ? 'https://open.bigmodel.cn' : 'https://api.z.ai'
  try {
    // The monitor takes the bare key, without "Bearer".
    const { status, body } = await get(`${origin}/api/monitor/usage/quota/limit`, { Authorization: saved.key })
    if (status === 401 || status === 403) return rejected('glm', 'Z.ai')
    if (!body) return unreadable('glm', 'the GLM Coding Plan', `Z.ai answered ${status}`)
    const data = obj(body.data)
    // A key without a coding plan gets an answer with no data in it.
    if (!data) return card('glm', { status: 'unsupported', note: 'No GLM Coding Plan on this key: it is billed per use.' })
    const level = str(data.level)
    return card('glm', { plan: level ? `GLM Coding ${title(level)}` : 'GLM Coding Plan', windows: glmWindows(data) })
  } catch (error) {
    return unreadable('glm', 'the GLM Coding Plan', (error as Error).message)
  }
}

/* ----------------------------------------------------------- MiniMax Token Plan */

/**
 * MiniMax's `token_plan/remains`, for its text models' row. Its counts were
 * once what is left and are now what is used; the percentage, when sent,
 * settles which (as MiniMax's own CLI does), and without one they are read
 * the old way.
 */
export function minimaxWindows(body: Json): ProviderWindow[] {
  const rows = (Array.isArray(body.model_remains) ? body.model_remains : []).map(obj).filter((r): r is Json => r !== null)
  const text = rows.find((r) => /^minimax-m/i.test(str(r.model_name) ?? '')) ?? rows[0]
  if (!text) return []
  const used = (count: unknown, total: unknown, remainingPercent: unknown): { percent: number; detail?: string } | null => {
    const t = num(total)
    const c = num(count)
    const left = num(remainingPercent)
    if (left !== null) return { percent: 100 - left }
    if (!t || c === null || c < 0 || c > t) return null
    return { percent: ((t - c) / t) * 100, detail: `${(t - c).toLocaleString()} of ${t.toLocaleString()} prompts` }
  }
  const windows: ProviderWindow[] = []
  const interval = used(text.current_interval_usage_count, text.current_interval_total_count, text.current_interval_remaining_percent)
  const start = num(text.start_time)
  const end = num(text.end_time)
  if (interval) {
    const ms = start && end && end > start ? end - start : 5 * HOUR
    windows.push(window('session', 'Session', `${Math.round(ms / HOUR)} hours`, interval.percent, when(end), ms, interval.detail))
  }
  // Status 3 is an unlimited week.
  if (num(text.current_weekly_status) !== 3 && (num(text.current_weekly_total_count) ?? 0) > 0) {
    const week = used(text.current_weekly_usage_count, text.current_weekly_total_count, text.current_weekly_remaining_percent)
    if (week) windows.push(window('week', 'Week', 'rolling 7 days', week.percent, when(text.weekly_end_time), 7 * DAY, week.detail))
  }
  return windows
}

export async function readMinimax(): Promise<ProviderUsage | null> {
  const saved = savedKey('minimax', 'minimax-cn')
  // A pay-as-you-go key (`sk-api-…`) has a balance, not a plan.
  if (!saved || saved.key.startsWith('sk-api-')) return null
  const origin = saved.providerId === 'minimax-cn' ? 'https://api.minimaxi.com' : 'https://api.minimax.io'
  try {
    const { status, body } = await get(`${origin}/v1/token_plan/remains`, { Authorization: `Bearer ${saved.key}` })
    if (status === 401 || status === 403) return rejected('minimax', 'MiniMax')
    const code = num(obj(body?.base_resp)?.status_code)
    if (!body || (code !== null && code !== 0)) {
      const message = str(obj(body?.base_resp)?.status_msg)
      return card('minimax', { status: 'unsupported', note: message ? `MiniMax said: ${message}.` : 'No MiniMax Token Plan on this key.' })
    }
    return card('minimax', { plan: 'Token Plan', windows: minimaxWindows(body) })
  } catch (error) {
    return unreadable('minimax', 'MiniMax', (error as Error).message)
  }
}

/* ------------------------------------------------- plans with no usage endpoint */

/** Alibaba's and Xiaomi's token plans show their credits only in their consoles; with a key saved, a card says where. */
export function readConsoleOnly(): ProviderUsage[] {
  const out: ProviderUsage[] = []
  if (savedKey('qwen-token-plan', 'qwen-token-plan-cn')) {
    out.push(card('qwen', { status: 'unsupported', plan: 'Token Plan', note: 'Alibaba shows Token Plan credits only in Model Studio: Token Plan → My Subscriptions.' }))
  }
  if (savedKey('xiaomi-token-plan', 'xiaomi-token-plan-cn')) {
    out.push(card('mimo', { status: 'unsupported', plan: 'Token Plan', note: 'Xiaomi shows Token Plan credits only on the MiMo platform, under your subscription.' }))
  }
  return out
}
