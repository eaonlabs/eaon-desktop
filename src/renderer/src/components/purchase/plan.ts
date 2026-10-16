import { purchasePlanError, type PurchasePlan } from '@shared/scheduler'
import { nextAligned, type PurchaseRoutineDraft, type WorkerRoutine } from '@shared/workers'

/**
 * The purchase schedule dialog's arithmetic, without React: turning what the
 * user picked into the worker routine that places the orders. Kept apart so
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

/** How often a routine runs, as its row says it: "every week", "every 2 weeks", "every 90 min". */
export function cadenceText(everyMs: number | null): string {
  if (!everyMs) return 'once'
  const days = everyMs / (24 * HOUR)
  if (days === 1) return 'every day'
  if (days === 7) return 'every week'
  if (Number.isInteger(days) && days % 7 === 0) return `every ${days / 7} weeks`
  if (Number.isInteger(days)) return `every ${days} days`
  return everyMs >= HOUR && everyMs % HOUR === 0 ? `every ${everyMs / HOUR} h` : `every ${Math.round(everyMs / 60_000)} min`
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
  // Nothing typed is no amount, not 0: 0 means free orders.
  const digits = raw.replace(/[^0-9.]/g, '')
  if (!/\d/.test(digits)) return NaN
  const value = Number(digits)
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : NaN
}

export interface BuiltPlan {
  draft: PurchaseRoutineDraft
  /** The first order goes in as soon as it is saved. */
  buyNow: boolean
  /** When the first scheduled order goes in (after the one placed now, if any); null when there is none. */
  nextAt: number | null
  error: string | null
}

/**
 * The worker routine for the form. Today as the start day means the first
 * order is placed right away; a repeating schedule's later orders keep to
 * the picked time, a period apart. `keep` is an edited schedule's routine
 * when the user didn't touch the timing fields, so saving a changed note
 * doesn't place an order or move the next one.
 */
export function buildPurchasePlan(form: PurchaseForm, now: number, keep: WorkerRoutine | null = null): BuiltPlan {
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
  let everyMs: number | null = form.cadence === 'once' ? null : CADENCE_HOURS[form.cadence] * HOUR
  let firstAt: number
  let anchorAt: number
  let nextAt: number | null
  if (keep) {
    everyMs = keep.everyMs
    firstAt = keep.nextAt
    anchorAt = keep.anchorAt ?? keep.nextAt
    nextAt = keep.nextAt
  } else if (buyNow) {
    firstAt = now
    anchorAt = atTime(form.startDay, form.time)
    nextAt = everyMs ? nextAligned(anchorAt, everyMs, now) : null
  } else {
    firstAt = atTime(form.startDay, form.time)
    anchorAt = firstAt
    nextAt = firstAt
  }
  // A one-off already placed has nothing left to schedule.
  if (orders === 1 && buyNow) nextAt = null

  const draft: PurchaseRoutineDraft = { ...(keep ? { id: keep.id } : {}), plan, everyMs, firstAt, anchorAt }
  const error =
    (!storeSite(form.site) && form.site.trim() ? 'Enter the store’s website, like amazon.com.' : null) ??
    purchasePlanError(plan) ??
    (!keep && !buyNow && firstAt <= now ? 'Pick a time that hasn’t passed yet.' : null)
  return { draft, buyNow, nextAt, error }
}
