import { formatMoney, ORDER_STAGE_LABEL, type PurchaseRecord } from '@shared/payments'
import { isFreePlan, type OrderWatch, type PurchasePlan } from '@shared/scheduler'
import { findPurchase, planPurchases } from './plans'

/**
 * What a purchase schedule's run is told: the one order it places and the
 * bounds it places it in, or the one order it checks on. Used by a worker's
 * purchase routine (features/workers/purchases.ts) and by the scheduled
 * tasks made before purchase schedules moved to workers.
 *
 * The bounds are enforced by payment_card as well; they are spelled out so
 * the agent stops at a price over the limit instead of trying it.
 */

export const day = (at: number): string => new Date(at).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })

function orderLine(p: PurchaseRecord): string {
  const money = p.amount === 0 && (p.charged ?? 0) === 0 ? 'free' : formatMoney(p.charged ?? p.amount, p.currency)
  const tracking = p.tracking ? `, ${ORDER_STAGE_LABEL[p.tracking.stage].toLowerCase()}` : ''
  return `- ${day(p.createdAt)}: ${p.status === 'paid' ? money : p.status}${p.orderId ? `, order ${p.orderId}` : ''}${tracking}`
}

export interface PlanRun {
  /** The schedule's id: its orders carry it as their planId. */
  id: string
  plan: PurchasePlan
  /** How often it buys, as a phrase: "Every week". */
  cadence: string
  /** When the order after this one is due; null when there is none. */
  nextAt: number | null
}

export function purchaseBrief(run: PlanRun): string {
  const { plan } = run
  const free = isFreePlan(plan)
  const past = planPurchases(run.id)
  const paid = past.filter((p) => p.status === 'paid')
  const last = paid[0]
  const lines = [
    `This run places one order of the user's purchase schedule. The user set it up and approved it in advance, for this store and up to this amount only.`,
    `Buy: ${plan.item}`,
    `Store: ${plan.merchant} (${plan.site}). Buy there and nowhere else.`,
    free
      ? 'This order must be free: the checkout total has to be exactly 0. There is no card for it. If the item costs anything, or the checkout asks for a payment method, do not buy: stop and report the price.'
      : `Most this order may cost: ${formatMoney(plan.maxAmount, plan.currency)}, everything included (tax, shipping, fees, tip). If the checkout total is higher, do not buy: stop and report the price.`,
    plan.notes.trim() ? `The user's notes: ${plan.notes.trim()}` : null,
    plan.orders ? `This is order ${paid.length + 1} of ${plan.orders}.` : `This schedule runs ${run.cadence.toLowerCase()} until the user stops it.`,
    past.length ? `Earlier orders of this schedule, newest first:\n${past.slice(0, 6).map(orderLine).join('\n')}` : "This is the schedule's first order.",
    '',
    'How:',
    `1. Open ${plan.site} in web_browser and find exactly this item. If it is unavailable, or only a different size, brand or quantity is, do not substitute unless the notes allow it: report what you found instead.`,
    '2. Add it to the cart and go to checkout. Read the final total.',
    `3. payment_card authorize {merchant: "${plan.merchant}", amount: <the total${free ? ', 0' : ''}>, currency: "${plan.currency}", site: "${plan.site}", description}. It asks nobody: this schedule is the approval. Only one order per run.`,
    free
      ? '4. No card is typed for a free order: place the order yourself, pressing the order button once.'
      : '4. payment_card fill the card fields (skip this when the total is 0), then place the order, pressing the order button once.',
    plan.autopilot
      ? `   Autopilot is on: the user asked never to be asked anything during this run, and ask_user is off. Once the order is authorized, every press on ${plan.site} goes through, the order button included. If the first press didn't take (a delivery option to pick, an error on the page), fix that and press again, but check for an order confirmation first so it is never ordered twice. Before the authorization, use the cart and the checkout steps, not "Buy now".`
      : null,
    `5. Read the confirmation page and call payment_card complete {purchase_id, status, charged, order_id}. The order number matters: Eaon uses it to track the delivery.`,
    'If the site asks you to sign in and you are not signed in, stop and report it. Never create an account or type a password.',
    plan.autopilot ? 'Anything else that would mean asking the user (a different item, a higher price, a question on the page): don’t ask, don’t buy; stop and say what happened in your report.' : null,
    '',
    `End with a short report the user will read: the order number, what was charged, the delivery estimate${last ? `, and the price against the last order (${formatMoney(last.charged ?? last.amount, last.currency)} on ${day(last.createdAt)}): up or down by how much and what percent` : ''}.`,
    run.nextAt && (!plan.orders || paid.length + 1 < plan.orders) ? `The next order is scheduled for ${day(run.nextAt)}.` : null
  ]
  return lines.filter((line) => line !== null).join('\n')
}

/** An order-tracking run: find where one placed order is, record it, say it in a line. */
export function watchBrief(watch: OrderWatch): string {
  const record = findPurchase(watch.purchaseId)
  const known = record?.tracking
  return [
    `This run checks on an order Eaon placed: order ${watch.orderId} from ${watch.merchant}${watch.site ? ` (${watch.site})` : ''} for ${watch.item}, placed ${day(watch.placedAt)}.`,
    known
      ? `Last check (${day(known.checkedAt)}): ${ORDER_STAGE_LABEL[known.stage]}${known.eta ? `, arriving ${known.eta}` : ''}${known.trackingNumber ? `, ${known.carrier ?? 'tracking'} ${known.trackingNumber}` : ''}.`
      : '',
    `Find where it is now. If you have the user's email, search it for the order number first; otherwise open ${watch.site ?? 'the store'}'s order history in web_browser and find order ${watch.orderId}. Look, do not change anything: never cancel, return or edit the order.`,
    `Then call payment_card track {purchase_id: "${watch.purchaseId}", stage, eta, carrier, tracking_number, note}.`,
    'End with one or two lines: where the order is and when it arrives. If it is late, stuck or something is wrong, say what the user can do about it.'
  ]
    .filter(Boolean)
    .join('\n')
}
