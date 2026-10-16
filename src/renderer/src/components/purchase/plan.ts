import { formatMoney } from '@shared/payments'
import { purchasePlanError, scheduleError, type PurchasePlan, type Schedule, type ScheduledTask, type TaskDraft } from '@shared/scheduler'

/**
 * The purchase schedule dialog's arithmetic, without React: turning what the
 * user picked into the scheduled task that places the orders. Kept apart so
 * it can be tested on its own.
 */

export type Cadence = 'once' | 'daily' | 'weekly' | 'biweekly' | 'monthly'

/** Hours between orders. "Monthly" is every four weeks, so orders always fall on the same weekday. */
export const CADENCE_HOURS: Record<Exclude<Cadence, 'once'>, number> = { daily: 24, weekly: 168, biweekly: 336, monthly: 672 }

export const CADENCE_LABEL: Record<Cadence, string> = {
  once: 'Once',
  daily: 'Daily',
  weekly: 'Weekly',
  biweekly: '2 weeks',
  monthly: '4 weeks'
}

export const CADENCE_PHRASE: Record<Exclude<Cadence, 'once'>, string> = {
  daily: 'Every day',
  weekly: 'Every week',
  biweekly: 'Every 2 weeks',
  monthly: 'Every 4 weeks'
}

export interface PurchaseForm {
  item: string
  site: string
  maxAmount: string
  currency: string
  notes: string
  cadence: Cadence
  /** Midnight of the first order's day, local time. */
  startDay: number
  /** "HH:MM", when scheduled orders go in. */
  time: string
  /** Stop after `orders` orders, rather than until the user stops it. */
  limited: boolean
  orders: string
  track: boolean
}

const HOUR = 60 * 60_000

export function startOfDay(at: number): number {
  const d = new Date(at)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** That day at "HH:MM", local time. */
export function atTime(day: number, time: string): number {
  const [h, m] = time.split(':').map(Number)
  const d = new Date(day)
  d.setHours(Number.isFinite(h) ? h : 9, Number.isFinite(m) ? m : 0, 0, 0)
  return d.getTime()
}

/** A bare hostname from "https://www.amazon.com/dp/…", "Amazon.com" or "amazon.com." — null when it isn't one. */
export function storeSite(raw: string): string | null {
  const value = raw.trim().toLowerCase()
  if (!value) return null
  let host: string
  try {
    host = new URL(/^[a-z][\w+.-]*:\/\//.test(value) ? value : `https://${value}`).hostname
  } catch {
    return null
  }
  host = host.replace(/\.$/, '').replace(/^www\./, '')
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) ? host : null
}

/** "amazon.com" → "Amazon", "shop.example.co.uk" → "Example". */
export function storeName(site: string): string {
  const parts = site.split('.')
  let name = parts.length > 1 ? parts[parts.length - 2] : parts[0]
  // A second-level country domain (co.uk, com.au): the name is one further in.
  if (parts.length > 2 && name.length <= 3) name = parts[parts.length - 3]
  return name.charAt(0).toUpperCase() + name.slice(1)
}

export function amountOf(raw: string): number {
  const value = Number(raw.replace(/[^0-9.]/g, ''))
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : NaN
}

export interface BuiltPlan {
  draft: TaskDraft
  /** The first order goes in as soon as it is saved. */
  buyNow: boolean
  /** When the first scheduled order goes in (after the one placed now, if any); null when there is none. */
  nextAt: number | null
  error: string | null
}

/**
 * The scheduled task for the form. Today as the start day means the first
 * order is placed right away; a repeating schedule's next order then falls
 * one period after today's chosen time. `keep` is an edited schedule's
 * current timing, used when the user didn't touch the timing fields, so
 * saving a changed note doesn't place an order.
 */
export function buildPurchasePlan(form: PurchaseForm, now: number, threadId: string, existing: ScheduledTask | null = null, keep: Schedule | null = null): BuiltPlan {
  const site = storeSite(form.site) ?? form.site.trim().toLowerCase()
  const maxAmount = amountOf(form.maxAmount)
  const orders = form.cadence === 'once' ? 1 : form.limited ? Math.round(Number(form.orders)) : null
  const plan: PurchasePlan = {
    item: form.item.trim(),
    site,
    merchant: storeName(site),
    maxAmount,
    currency: form.currency,
    notes: form.notes.trim(),
    orders,
    track: form.track
  }

  const today = startOfDay(now)
  const buyNow = !keep && form.startDay <= today
  let schedule: Schedule
  let enabled = true
  let nextAt: number | null
  if (keep) {
    schedule = keep
    nextAt = existing?.nextRunAt ?? null
  } else if (form.cadence === 'once') {
    if (buyNow) {
      // Placed by Run now; the task stays off so the schedule never places it again.
      schedule = { kind: 'once', at: now }
      enabled = false
      nextAt = null
    } else {
      schedule = { kind: 'once', at: atTime(form.startDay, form.time) }
      nextAt = schedule.at
    }
  } else {
    const period = CADENCE_HOURS[form.cadence] * HOUR
    let startAt = atTime(form.startDay, form.time)
    if (buyNow) startAt += period
    while (startAt <= now) startAt += period
    schedule = { kind: 'interval', every: CADENCE_HOURS[form.cadence], unit: 'hours', startAt }
    nextAt = startAt
  }
  // A one-off already placed has nothing left to schedule.
  if (orders === 1 && buyNow) nextAt = null

  const short = plan.item.length > 52 ? `${plan.item.slice(0, 51).trimEnd()}…` : plan.item
  const draft: TaskDraft = {
    ...(existing ? { id: existing.id } : {}),
    name: `Buy ${short || 'something'}`,
    prompt: `Buy ${plan.item} from ${plan.merchant}, up to ${Number.isFinite(maxAmount) ? formatMoney(maxAmount, plan.currency) : '?'} an order.`,
    schedule,
    mode: 'work',
    model: existing?.model ?? null,
    cwd: null,
    allowChanges: true,
    enabled: keep ? (existing?.enabled ?? true) : enabled,
    purchase: plan,
    thread: existing?.thread ?? threadId
  }

  const error =
    (!storeSite(form.site) && form.site.trim() ? 'Enter the store’s website, like amazon.com.' : null) ??
    purchasePlanError(plan) ??
    (keep ? null : scheduleError(schedule, now, enabled))
  return { draft, buyNow, nextAt, error }
}
