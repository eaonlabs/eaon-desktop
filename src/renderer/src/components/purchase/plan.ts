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
  /** Never ask the user anything during a run (PurchasePlan.autopilot). */
  autopilot: boolean
}

const HOUR = 60 * 60_000
const DAY = 24 * HOUR

/**
 * The first `anchorAt + k × everyMs` after `after`, like `nextAligned`, but a
 * cadence of whole days steps by calendar days: a fixed 24 hours would move a
 * 9:00 order to 8:00 or 10:00 once daylight saving starts or ends. Main keeps
 * the same rule for the runs themselves (workers/purchases.ts).
 */
export function nextOnCadence(anchorAt: number, everyMs: number, after: number): number {
  if (everyMs % DAY !== 0) return nextAligned(anchorAt, everyMs, after)
  if (anchorAt > after) return anchorAt
  const days = everyMs / DAY
  const at = (k: number): number => {
    const d = new Date(anchorAt)
    d.setDate(d.getDate() + k * days)
    return d.getTime()
  }
  // The fixed-length guess is at most an hour out; settle on the first one past `after`.
  let k = Math.floor((after - anchorAt) / everyMs) + 1
  while (k > 1 && at(k - 1) > after) k--
  while (at(k) <= after) k++
  return at(k)
}

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
 * the picked time, a period apart.
 *
 * `editing` is the routine being edited: the draft always carries its id, so
 * saving replaces it rather than adding a second schedule that also buys.
 * Its timing is kept as it is unless `timingTouched`, so saving a changed
 * note doesn't place an order or move the next one. An edit never buys on
 * the spot: picking today moves the next order to the picked time instead.
 */
export function buildPurchasePlan(form: PurchaseForm, now: number, editing: WorkerRoutine | null = null, timingTouched = false): BuiltPlan {
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
    track: form.track,
    ...(form.autopilot ? { autopilot: true } : {})
  }

  const keep = editing && !timingTouched ? editing : null
  const today = startOfDay(now)
  const buyNow = !editing && form.startDay <= today
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
    nextAt = everyMs ? nextOnCadence(anchorAt, everyMs, now) : null
  } else {
    anchorAt = atTime(form.startDay, form.time)
    // An edited repeating schedule picked to start today, at a time already
    // gone: its next order is the next one on the new cadence.
    firstAt = editing && everyMs && anchorAt <= now ? nextOnCadence(anchorAt, everyMs, now) : anchorAt
    nextAt = firstAt
  }
  // A one-off already placed has nothing left to schedule.
  if (orders === 1 && buyNow) nextAt = null

  const draft: PurchaseRoutineDraft = { ...(editing ? { id: editing.id } : {}), plan, everyMs, firstAt, anchorAt }
  const error =
    (!storeSite(form.site) && form.site.trim() ? 'Enter the store’s website, like amazon.com.' : null) ??
    purchasePlanError(plan) ??
    (!keep && !buyNow && firstAt <= now ? 'Pick a time that hasn’t passed yet.' : null)
  return { draft, buyNow, nextAt, error }
}
